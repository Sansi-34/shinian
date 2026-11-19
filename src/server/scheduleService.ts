// 日程安排数据层：校验、重叠检测、revision CAS、幂等回执与关联读取。
// 所有写路径都由路由层包在 sqlite.transaction 中；这里只做同步读写，不 await。

import { createHash } from 'node:crypto';
import { sqlite } from '../db/db';
import {
  MAX_SCHEDULE_SPAN_DAYS,
  daysBetween,
  isValidDisambiguation,
  normalizeTimezone,
  parseLocalDate,
  parseLocalTime,
  resolveLocalDateTime,
  type Disambiguation,
  type LocalDate,
  type LocalTime,
} from './timezone';

export type ScheduleStatus = 'active' | 'cancelled';

export type ScheduleAttemptRef = {
  id: string;
  step: string;
  state: string;
  captureId: string;
};

export type ScheduleCaptureRef = {
  id: string;
  rawText: string;
};

/** 对外返回的 camelCase 日程对象（docs/schedule-api-contract.md §4）。 */
export type ScheduleBlock = {
  id: string;
  attemptId: string;
  startsAt: number;
  endsAt: number;
  timezone: string;
  note: string | null;
  status: ScheduleStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  cancelledAt: number | null;
  attempt: ScheduleAttemptRef | null;
  capture: ScheduleCaptureRef | null;
};

export class ScheduleHttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.message === 'string' ? body.message : String(body.error ?? 'schedule error'));
    this.name = 'ScheduleHttpError';
    this.status = status;
    this.body = body;
  }
}

type ScheduleJoinRow = {
  id: string;
  attempt_id: string;
  starts_at: number;
  ends_at: number;
  timezone: string;
  note: string | null;
  status: string;
  revision: number;
  created_at: number;
  updated_at: number;
  cancelled_at: number | null;
  a_id: string | null;
  a_step: string | null;
  a_state: string | null;
  a_capture_id: string | null;
  c_id: string | null;
  c_raw_text: string | null;
};

type ReceiptRow = {
  operation_key: string;
  target_type: string;
  request_fingerprint: string;
  response_json: string;
};

const SCHEDULE_SELECT = `
  SELECT s.id, s.attempt_id, s.starts_at, s.ends_at, s.timezone, s.note, s.status,
         s.revision, s.created_at, s.updated_at, s.cancelled_at,
         a.id AS a_id, a.step AS a_step, a.state AS a_state, a.capture_id AS a_capture_id,
         c.id AS c_id, c.raw_text AS c_raw_text
    FROM schedule_blocks s
    LEFT JOIN attempts a ON a.id = s.attempt_id
    LEFT JOIN captures c ON c.id = a.capture_id
`;

function toBlock(row: ScheduleJoinRow): ScheduleBlock {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    note: row.note,
    status: row.status === 'cancelled' ? 'cancelled' : 'active',
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at,
    attempt: row.a_id
      ? {
          id: row.a_id,
          step: row.a_step ?? '',
          state: row.a_state ?? 'todo',
          captureId: row.a_capture_id ?? '',
        }
      : null,
    capture: row.c_id ? { id: row.c_id, rawText: row.c_raw_text ?? '' } : null,
  };
}

export function getScheduleById(id: string): ScheduleBlock | null {
  const row = sqlite.prepare(`${SCHEDULE_SELECT} WHERE s.id = ?`).get(id) as
    | ScheduleJoinRow
    | undefined;
  return row ? toBlock(row) : null;
}

export function listSchedulesInRange(fromAt: number, toAt: number): ScheduleBlock[] {
  const rows = sqlite
    .prepare(
      `${SCHEDULE_SELECT}
        WHERE s.status = 'active' AND s.starts_at < ? AND s.ends_at > ?
        ORDER BY s.starts_at ASC, s.id ASC`
    )
    .all(toAt, fromAt) as ScheduleJoinRow[];
  return rows.map(toBlock);
}

export function listSchedulesForAttempt(attemptId: string): ScheduleBlock[] {
  const rows = sqlite
    .prepare(
      `${SCHEDULE_SELECT}
        WHERE s.attempt_id = ?
        ORDER BY s.starts_at ASC, s.id ASC`
    )
    .all(attemptId) as ScheduleJoinRow[];
  return rows.map(toBlock);
}

export function getFutureActiveSchedules(attemptId: string, at = Date.now()): ScheduleBlock[] {
  const rows = sqlite
    .prepare(
      `${SCHEDULE_SELECT}
        WHERE s.attempt_id = ? AND s.status = 'active' AND s.starts_at > ?
        ORDER BY s.starts_at ASC, s.id ASC`
    )
    .all(attemptId, at) as ScheduleJoinRow[];
  return rows.map(toBlock);
}

export function cancelFutureActiveSchedules(attemptId: string, at = Date.now()): number {
  return sqlite
    .prepare(
      `UPDATE schedule_blocks
          SET status = 'cancelled', revision = revision + 1,
              cancelled_at = ?, updated_at = ?
        WHERE attempt_id = ? AND status = 'active' AND starts_at > ?`
    )
    .run(at, at, attemptId, at).changes;
}

/** 查询与给定时间重叠的 active 安排；nextAction 创建复用同一套重叠判定（不改变既有行为）。 */
export function listConflictingActive(
  startsAt: number,
  endsAt: number,
  excludeId: string | null
): ScheduleBlock[] {
  const rows = sqlite
    .prepare(
      `${SCHEDULE_SELECT}
        WHERE s.status = 'active'
          AND s.starts_at < ? AND s.ends_at > ?
          AND s.id <> ?
        ORDER BY s.starts_at ASC, s.id ASC`
    )
    .all(endsAt, startsAt, excludeId ?? '') as ScheduleJoinRow[];
  return rows.map(toBlock);
}

export function attemptExists(attemptId: string): boolean {
  return Boolean(sqlite.prepare('SELECT 1 AS ok FROM attempts WHERE id = ?').get(attemptId));
}

// ---------- 参数校验 ----------

export type ParsedScheduleInput = {
  date: string;
  endDate: string;
  startTime: string;
  endTime: string;
  startsAt: number;
  endsAt: number;
  timezone: string;
  note: string | null;
  startDisambiguation: Disambiguation | null;
  endDisambiguation: Disambiguation | null;
};

function invalidTime(message: string, field?: string): ScheduleHttpError {
  return new ScheduleHttpError(400, {
    error: 'invalid_schedule_time',
    message,
    ...(field ? { field } : {}),
  });
}

function parseNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ScheduleHttpError(400, { error: 'invalid_note', message: '备注必须是字符串。' });
  }
  const note = value.trim();
  if (!note) return null;
  if (note.length > 300) {
    throw new ScheduleHttpError(400, {
      error: 'note_too_long',
      message: '备注不能超过 300 字。',
      field: 'note',
    });
  }
  return note;
}

function parseDisambiguation(value: unknown, field: string): Disambiguation | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isValidDisambiguation(value)) {
    throw invalidTime('startDisambiguation / endDisambiguation 只能是 earlier 或 later。', field);
  }
  return value;
}

function resolveOrThrow(
  date: LocalDate,
  time: LocalTime,
  timezone: string,
  disambiguation: Disambiguation | null,
  field: 'start' | 'end'
): number {
  const result = resolveLocalDateTime(date, time, timezone, disambiguation ?? undefined);
  if (result.kind === 'nonexistent') {
    throw new ScheduleHttpError(400, {
      error: 'nonexistent_local_time',
      zone: timezone,
      local: result.local,
      message: `${result.local} 在时区 ${timezone} 不存在（夏令时跳过）。`,
      field,
    });
  }
  if (result.kind === 'ambiguous') {
    throw new ScheduleHttpError(400, {
      error: 'ambiguous_local_time',
      zone: timezone,
      local: result.local,
      choices: result.choices,
      message: `${result.local} 在时区 ${timezone} 出现两次（夏令时重复），请选择 earlier 或 later。`,
      field,
    });
  }
  return result.utc;
}

/**
 * 解析创建/修改共用的时间表单：date / endDate / startTime / endTime / timezone /
 * startDisambiguation / endDisambiguation / note。
 */
export function parseScheduleInput(raw: Record<string, unknown>): ParsedScheduleInput {
  const date = parseLocalDate(raw.date);
  if (!date) throw invalidTime('date 必须是有效的 YYYY-MM-DD 日期。', 'date');

  const endRaw = raw.endDate === undefined || raw.endDate === null || raw.endDate === ''
    ? date.text
    : raw.endDate;
  const endDate = parseLocalDate(endRaw);
  if (!endDate) throw invalidTime('endDate 必须是有效的 YYYY-MM-DD 日期。', 'endDate');
  if (endDate.text < date.text) {
    throw invalidTime('结束日期不能早于开始日期。', 'endDate');
  }
  if (daysBetween(date, endDate) > MAX_SCHEDULE_SPAN_DAYS) {
    throw invalidTime(`单次安排最长 ${MAX_SCHEDULE_SPAN_DAYS} 天。`, 'endDate');
  }

  const startTime = parseLocalTime(raw.startTime);
  if (!startTime) throw invalidTime('startTime 必须是 HH:mm 格式。', 'startTime');
  const endTime = parseLocalTime(raw.endTime);
  if (!endTime) throw invalidTime('endTime 必须是 HH:mm 格式。', 'endTime');

  const timezone = normalizeTimezone(raw.timezone);
  if (!timezone) {
    throw new ScheduleHttpError(400, {
      error: 'invalid_timezone',
      message: 'timezone 必须是有效的 IANA 时区名称（例如 Asia/Shanghai）。',
      field: 'timezone',
    });
  }

  const startDisambiguation = parseDisambiguation(raw.startDisambiguation, 'startDisambiguation');
  const endDisambiguation = parseDisambiguation(raw.endDisambiguation, 'endDisambiguation');
  const startsAt = resolveOrThrow(date, startTime, timezone, startDisambiguation, 'start');
  const endsAt = resolveOrThrow(endDate, endTime, timezone, endDisambiguation, 'end');

  if (endsAt <= startsAt) {
    throw invalidTime('结束时间必须晚于开始时间。', 'endTime');
  }
  // 日期跨度已限制在 7 天内；再容忍 2 小时夏令时偏移，避免合法跨夏令时安排被误判。
  if (endsAt - startsAt > MAX_SCHEDULE_SPAN_DAYS * 86_400_000 + 2 * 3_600_000) {
    throw invalidTime(`单次安排最长 ${MAX_SCHEDULE_SPAN_DAYS} 天。`, 'endDate');
  }

  return {
    date: date.text,
    endDate: endDate.text,
    startTime: startTime.text,
    endTime: endTime.text,
    startsAt,
    endsAt,
    timezone,
    note: parseNote(raw.note),
    startDisambiguation,
    endDisambiguation,
  };
}

function requireOperationId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ScheduleHttpError(400, {
      error: 'invalid_request',
      message: 'operationId 必填。',
      field: 'operationId',
    });
  }
  const value = raw.trim();
  if (value.length > 200) {
    throw new ScheduleHttpError(400, {
      error: 'invalid_request',
      message: 'operationId 不能超过 200 个字符。',
      field: 'operationId',
    });
  }
  return value;
}

function requireRevision(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new ScheduleHttpError(428, {
      error: 'revision_required',
      message: 'revision 必填且必须是正整数。',
      field: 'revision',
    });
  }
  return raw;
}

// ---------- 冲突令牌 ----------

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

type ConflictParams = Record<string, string | number | null>;

function conflictToken(
  action: 'create' | 'update',
  params: ConflictParams,
  conflicts: ScheduleBlock[]
): string {
  const payload = {
    v: 1,
    action,
    params,
    conflicts: conflicts
      .map((item) => ({ id: item.id, revision: item.revision, updatedAt: item.updatedAt }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  return sha256(JSON.stringify(payload));
}

function assertOverlapConfirmed(
  action: 'create' | 'update',
  params: ConflictParams,
  conflicts: ScheduleBlock[],
  raw: Record<string, unknown>
): void {
  const token = conflictToken(action, params, conflicts);
  if (raw.confirmOverlap !== true) {
    throw new ScheduleHttpError(409, {
      error: 'schedule_conflict',
      message: '与现有安排重叠',
      conflicts,
      conflictToken: token,
      requiresConfirmation: true,
    });
  }

  const providedToken = typeof raw.conflictToken === 'string' ? raw.conflictToken : null;
  let idsMatch = true;
  if (raw.expectedConflictIds !== undefined && raw.expectedConflictIds !== null) {
    if (!Array.isArray(raw.expectedConflictIds)) {
      idsMatch = false;
    } else {
      const providedIds = raw.expectedConflictIds
        .filter((item): item is string => typeof item === 'string')
        .sort();
      const currentIds = conflicts.map((item) => item.id).sort();
      idsMatch =
        providedIds.length === currentIds.length &&
        providedIds.every((item, index) => item === currentIds[index]);
    }
  }

  if (providedToken !== token || !idsMatch) {
    throw new ScheduleHttpError(409, {
      error: 'schedule_conflict_changed',
      message: '冲突已变化，请重新确认。',
      conflicts,
      conflictToken: token,
      requiresConfirmation: true,
    });
  }
}

// ---------- 回执 ----------

function getReceipt(operationKey: string): ReceiptRow | undefined {
  return sqlite.prepare('SELECT * FROM mutation_receipts WHERE operation_key = ?').get(operationKey) as
    | ReceiptRow
    | undefined;
}

// ---------- 创建 ----------

export type CreateScheduleOutcome = {
  status: number;
  body: { schedule: ScheduleBlock; replayed?: boolean };
};

export function createSchedule(
  attemptId: string,
  raw: Record<string, unknown>
): CreateScheduleOutcome {
  const input = parseScheduleInput(raw);
  const operationId = requireOperationId(raw.operationId);
  if (!attemptExists(attemptId)) {
    throw new ScheduleHttpError(404, { error: 'attempt_not_found', message: '尝试不存在。' });
  }

  const params: ConflictParams = {
    attemptId,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    timezone: input.timezone,
    note: input.note,
    operationId,
  };
  const fingerprint = sha256(JSON.stringify({ op: 'create-schedule', ...params }));

  const replay = (): CreateScheduleOutcome => {
    const receipt = getReceipt(operationId);
    if (!receipt) {
      throw new ScheduleHttpError(500, {
        error: 'internal_error',
        message: 'operationId 回执缺失。',
      });
    }
    if (receipt.target_type !== 'schedule' || receipt.request_fingerprint !== fingerprint) {
      throw new ScheduleHttpError(409, {
        error: 'operation_key_conflict',
        message: 'operationId 已被另一个请求使用。',
      });
    }
    return {
      status: 200,
      body: { schedule: JSON.parse(receipt.response_json) as ScheduleBlock, replayed: true },
    };
  };

  if (getReceipt(operationId)) return replay();

  const tx = sqlite.transaction((): CreateScheduleOutcome => {
    // 进入事务后再次确认回执，避免两个窗口同时提交相同 operationId。
    if (getReceipt(operationId)) return replay();

    const conflicts = listConflictingActive(input.startsAt, input.endsAt, null);
    if (conflicts.length > 0) assertOverlapConfirmed('create', params, conflicts, raw);

    const id = `sch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const t = Date.now();
    sqlite
      .prepare(
        `INSERT INTO schedule_blocks
           (id, attempt_id, starts_at, ends_at, timezone, note, status, revision,
            created_at, updated_at, cancelled_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, NULL)`
      )
      .run(id, attemptId, input.startsAt, input.endsAt, input.timezone, input.note, t, t);

    const schedule = getScheduleById(id);
    if (!schedule) throw new Error('schedule insert failed');
    sqlite
      .prepare(
        `INSERT INTO mutation_receipts
           (operation_key, target_type, request_fingerprint, response_json, created_at)
         VALUES (?, 'schedule', ?, ?, ?)`
      )
      .run(operationId, fingerprint, JSON.stringify(schedule), t);
    return { status: 201, body: { schedule, replayed: false } };
  });

  try {
    return tx();
  } catch (error) {
    if (error instanceof ScheduleHttpError) throw error;
    // 并发下另一个请求已写入同一 operationId：按回执回放。
    const receipt = getReceipt(operationId);
    if (receipt && receipt.target_type === 'schedule' && receipt.request_fingerprint === fingerprint) {
      return replay();
    }
    throw error;
  }
}

// ---------- 修改 ----------

export function updateSchedule(id: string, raw: Record<string, unknown>): ScheduleBlock {
  const input = parseScheduleInput(raw);
  const revision = requireRevision(raw.revision);

  const tx = sqlite.transaction((): ScheduleBlock => {
    const current = getScheduleById(id);
    if (!current) {
      throw new ScheduleHttpError(404, { error: 'schedule_not_found', message: '安排不存在。' });
    }
    if (current.status === 'cancelled') {
      throw new ScheduleHttpError(409, {
        error: 'schedule_not_active',
        message: '已取消的安排不能修改。',
        current,
        currentRevision: current.revision,
      });
    }
    if (current.revision !== revision) {
      throw new ScheduleHttpError(409, {
        error: 'revision_conflict',
        message: '安排已被其他窗口修改。',
        current,
        currentRevision: current.revision,
      });
    }

    const params: ConflictParams = {
      scheduleId: id,
      revision,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone,
      note: input.note,
    };
    const conflicts = listConflictingActive(input.startsAt, input.endsAt, id);
    if (conflicts.length > 0) assertOverlapConfirmed('update', params, conflicts, raw);

    const t = Date.now();
    const result = sqlite
      .prepare(
        `UPDATE schedule_blocks
            SET starts_at = ?, ends_at = ?, timezone = ?, note = ?,
                revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'active'`
      )
      .run(input.startsAt, input.endsAt, input.timezone, input.note, t, id, revision);

    if (result.changes !== 1) {
      const raced = getScheduleById(id);
      throw new ScheduleHttpError(409, {
        error: 'revision_conflict',
        message: '安排已被其他窗口修改。',
        current: raced,
        currentRevision: raced?.revision ?? null,
      });
    }

    const updated = getScheduleById(id);
    if (!updated) throw new Error('schedule update vanished');
    return updated;
  });

  return tx();
}

// ---------- 取消 ----------

export function cancelSchedule(id: string, raw: Record<string, unknown>): ScheduleBlock {
  const revision = requireRevision(raw.revision);

  const tx = sqlite.transaction((): ScheduleBlock => {
    const current = getScheduleById(id);
    if (!current) {
      throw new ScheduleHttpError(404, { error: 'schedule_not_found', message: '安排不存在。' });
    }
    if (current.status === 'cancelled') {
      throw new ScheduleHttpError(409, {
        error: 'already_cancelled',
        message: '这个安排已经取消。',
        current,
        currentRevision: current.revision,
      });
    }
    if (current.revision !== revision) {
      throw new ScheduleHttpError(409, {
        error: 'revision_conflict',
        message: '安排已被其他窗口修改。',
        current,
        currentRevision: current.revision,
      });
    }

    const t = Date.now();
    const result = sqlite
      .prepare(
        `UPDATE schedule_blocks
            SET status = 'cancelled', revision = revision + 1,
                cancelled_at = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'active'`
      )
      .run(t, t, id, revision);
    if (result.changes !== 1) {
      const raced = getScheduleById(id);
      if (raced?.status === 'cancelled') {
        throw new ScheduleHttpError(409, {
          error: 'already_cancelled',
          message: '这个安排已经取消。',
          current: raced,
          currentRevision: raced.revision,
        });
      }
      throw new ScheduleHttpError(409, {
        error: 'revision_conflict',
        message: '安排已被其他窗口修改。',
        current: raced,
        currentRevision: raced?.revision ?? null,
      });
    }

    const updated = getScheduleById(id);
    if (!updated) throw new Error('schedule cancel vanished');
    return updated;
  });

  return tx();
}

// ---------- 删除与计数 ----------

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

export function countSchedulesForAttemptIds(ids: string[]): { total: number; active: number } {
  if (ids.length === 0) return { total: 0, active: 0 };
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active
         FROM schedule_blocks
        WHERE attempt_id IN (${placeholders(ids.length)})`
    )
    .get(...ids) as { total: number; active: number };
  return { total: row.total, active: row.active };
}

export function countSchedulesForAttempt(attemptId: string): { total: number; active: number } {
  return countSchedulesForAttemptIds([attemptId]);
}

/** 删除多个尝试的日程，返回删除行数（含 cancelled）。 */
export function deleteSchedulesForAttemptIds(ids: string[]): number {
  if (ids.length === 0) return 0;
  return sqlite
    .prepare(`DELETE FROM schedule_blocks WHERE attempt_id IN (${placeholders(ids.length)})`)
    .run(...ids).changes;
}

export function deleteSchedulesForAttempt(attemptId: string): number {
  return sqlite.prepare('DELETE FROM schedule_blocks WHERE attempt_id = ?').run(attemptId).changes;
}
