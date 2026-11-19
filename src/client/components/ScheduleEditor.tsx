// 拾念 SHINIAN v0.2 - 日程时间编辑表单（尝试详情 / 日程详情共用）
import { useRef, useState } from 'react';
import api, { ApiError } from '../api';
import type {
  CreateScheduleInput,
  LocalTimeDisambiguation,
  ScheduleBlock,
  ScheduleFormInput,
  UpdateScheduleInput,
} from '../types';
import { newOperationId } from '../types';
import {
  dateKeyDiffDays,
  dateKeyInTimezone,
  formatScheduleFullRange,
  isValidDateKey,
  isValidTimeString,
  minutesOfTime,
  scheduleTimezoneLabel,
  timeInTimezone,
  todayDateKey,
} from '../scheduleTime';

type FieldName = 'date' | 'endDate' | 'startTime' | 'endTime' | 'note';
type FieldErrors = Partial<Record<FieldName, string>>;

type AmbiguousState = {
  zone: string;
  local: string;
  choices: LocalTimeDisambiguation[];
  field?: 'start' | 'end';
};

type Props = {
  mode: 'create' | 'edit';
  attemptId?: string;
  schedule?: ScheduleBlock;
  displayTimezone: string;
  onSaved: (schedule: ScheduleBlock) => void;
  onCancel: () => void;
};

type InitialValues = {
  date: string;
  endDate: string;
  crossDay: boolean;
  startTime: string;
  endTime: string;
  note: string;
};

function buildInitialValues(
  mode: 'create' | 'edit',
  schedule: ScheduleBlock | undefined,
  displayTimezone: string
): InitialValues {
  if (mode === 'edit' && schedule) {
    const timezone = schedule.timezone;
    const startDate = dateKeyInTimezone(schedule.startsAt, timezone);
    // 表单的结束日期是 endsAt 的墙上日期；结束刚好 00:00 时它属于次日。
    // 周/今日列表的「覆盖日期」仍按 endsAt - 1 计算，避免把零长度的次日算进去。
    const endDate = dateKeyInTimezone(schedule.endsAt, timezone);
    return {
      date: startDate,
      endDate,
      crossDay: startDate !== endDate,
      startTime: timeInTimezone(schedule.startsAt, timezone),
      endTime: timeInTimezone(schedule.endsAt, timezone),
      note: schedule.note ?? '',
    };
  }
  const today = todayDateKey(displayTimezone);
  return {
    date: today,
    endDate: today,
    crossDay: false,
    startTime: '09:00',
    endTime: '10:00',
    note: '',
  };
}

export default function ScheduleEditor({
  mode,
  attemptId,
  schedule,
  displayTimezone,
  onSaved,
  onCancel,
}: Props) {
  const initial = useRef<InitialValues>(
    buildInitialValues(mode, schedule, displayTimezone)
  ).current;

  // 编辑时沿用安排自己的时区，避免只改备注却把时间平移；新建时使用当前显示时区。
  const [formTimezone] = useState(() =>
    mode === 'edit' && schedule ? schedule.timezone : displayTimezone
  );

  const [date, setDate] = useState(initial.date);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [crossDay, setCrossDay] = useState(initial.crossDay);
  const [startTime, setStartTime] = useState(initial.startTime);
  const [endTime, setEndTime] = useState(initial.endTime);
  const [note, setNote] = useState(initial.note);

  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [conflicts, setConflicts] = useState<ScheduleBlock[] | null>(null);
  const [conflictToken, setConflictToken] = useState<string | null>(null);
  const [conflictChanged, setConflictChanged] = useState(false);
  const [newConflictIds, setNewConflictIds] = useState<string[]>([]);
  const [confirmSignature, setConfirmSignature] = useState<string | null>(null);

  const [revisionCurrent, setRevisionCurrent] = useState<ScheduleBlock | null>(null);
  const [baseRevision, setBaseRevision] = useState(schedule?.revision ?? 0);

  const [ambiguous, setAmbiguous] = useState<AmbiguousState | null>(null);
  const [startDisambiguation, setStartDisambiguation] = useState<'' | LocalTimeDisambiguation>('');
  const [endDisambiguation, setEndDisambiguation] = useState<'' | LocalTimeDisambiguation>('');

  const operationIdRef = useRef<string | null>(null);
  const lastSignatureRef = useRef<string | null>(null);

  function signature(): string {
    return JSON.stringify({
      date,
      endDate: crossDay ? endDate : date,
      startTime,
      endTime,
      timezone: formTimezone,
      note: note.trim(),
      startDisambiguation,
      endDisambiguation,
    });
  }

  /** 用户改了任何字段，之前拿到的冲突 token 就不再对应当前表单值。 */
  function clearConflictConfirmation() {
    setConflicts(null);
    setConflictToken(null);
    setConfirmSignature(null);
    setConflictChanged(false);
    setNewConflictIds([]);
    setAmbiguous(null);
  }

  function onDateChange(value: string) {
    setDate(value);
    if (!crossDay) setEndDate(value);
    setErrors((prev) => ({ ...prev, date: undefined, endDate: undefined }));
    clearConflictConfirmation();
  }

  function onEndDateChange(value: string) {
    setEndDate(value);
    setErrors((prev) => ({ ...prev, endDate: undefined }));
    clearConflictConfirmation();
  }

  function onStartTimeChange(value: string) {
    setStartTime(value);
    setErrors((prev) => ({ ...prev, startTime: undefined }));
    clearConflictConfirmation();
  }

  function onEndTimeChange(value: string) {
    setEndTime(value);
    setErrors((prev) => ({ ...prev, endTime: undefined }));
    clearConflictConfirmation();
  }

  function onNoteChange(value: string) {
    setNote(value);
    setErrors((prev) => ({ ...prev, note: undefined }));
    clearConflictConfirmation();
  }

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (!isValidDateKey(date)) next.date = '请选择有效日期';
    if (crossDay && !isValidDateKey(endDate)) next.endDate = '请选择有效结束日期';
    if (crossDay && isValidDateKey(date) && isValidDateKey(endDate) && endDate < date) {
      next.endDate = '结束日期不能早于开始日期';
    }
    if (!isValidTimeString(startTime)) next.startTime = '请选择开始时间';
    if (!isValidTimeString(endTime)) next.endTime = '请选择结束时间';
    if (note.trim().length > 300) next.note = '备注最多 300 字';

    if (
      isValidDateKey(date) &&
      isValidTimeString(startTime) &&
      isValidTimeString(endTime)
    ) {
      const effectiveEndDate = crossDay ? endDate : date;
      if (isValidDateKey(effectiveEndDate)) {
        if (effectiveEndDate < date) {
          next.endDate = '结束日期不能早于开始日期';
        } else {
          const dayDiff = dateKeyDiffDays(date, effectiveEndDate);
          const durationMinutes =
            dayDiff * 1440 + minutesOfTime(endTime) - minutesOfTime(startTime);
          if (durationMinutes <= 0) {
            const endsBeforeStart = minutesOfTime(endTime) < minutesOfTime(startTime);
            next.endTime =
              !crossDay && endsBeforeStart
                ? '结束时间早于开始时间：跨午夜请勾选下面的「跨日」并设置结束日期。'
                : '结束时间必须晚于开始时间。';
          } else if (durationMinutes > 7 * 1440) {
            next.endTime = '单次安排最长 7 天';
          }
        }
      }
    }
    return next;
  }

  function buildPayload(confirmOverlap: boolean): ScheduleFormInput {
    const effectiveEndDate = crossDay ? endDate : date;
    const payload: ScheduleFormInput = {
      date,
      endDate: effectiveEndDate,
      startTime,
      endTime,
      timezone: formTimezone,
      note: note.trim() ? note.trim() : null,
    };
    if (startDisambiguation) payload.startDisambiguation = startDisambiguation;
    if (endDisambiguation) payload.endDisambiguation = endDisambiguation;
    if (confirmOverlap && conflictToken && conflicts) {
      payload.confirmOverlap = true;
      payload.conflictToken = conflictToken;
      payload.expectedConflictIds = conflicts.map((item) => item.id).sort();
    } else {
      payload.confirmOverlap = false;
      payload.conflictToken = null;
      payload.expectedConflictIds = [];
    }
    return payload;
  }

  function handleApiError(error: unknown, submittedSignature: string) {
    if (!(error instanceof ApiError)) {
      setFormError('保存失败，请重试');
      return;
    }
    const body: any = error.body ?? {};
    const code: string | undefined = body.error;

    if (
      error.status === 409 &&
      (code === 'schedule_conflict' || code === 'schedule_conflict_changed')
    ) {
      const list: ScheduleBlock[] = Array.isArray(body.conflicts) ? body.conflicts : [];
      const previousIds = new Set((conflicts ?? []).map((item) => item.id));
      setNewConflictIds(
        code === 'schedule_conflict_changed'
          ? list.filter((item) => !previousIds.has(item.id)).map((item) => item.id)
          : []
      );
      setConflicts(list);
      setConflictToken(typeof body.conflictToken === 'string' ? body.conflictToken : null);
      setConfirmSignature(submittedSignature);
      setConflictChanged(code === 'schedule_conflict_changed');
      setFormError(null);
      return;
    }

    if (error.status === 409 && code === 'revision_conflict') {
      const current = body.current as ScheduleBlock | undefined;
      if (current) setRevisionCurrent(current);
      setFormError('版本冲突：这条安排刚被其他窗口修改，你的草稿仍然保留。');
      return;
    }

    if (error.status === 409 && code === 'operation_key_conflict') {
      // 同一个 operationId 携带了不同参数：换一个操作 ID，用户草稿不变。
      operationIdRef.current = null;
      lastSignatureRef.current = null;
      setFormError('这次提交与上一次不一致，请再点一次保存。');
      return;
    }

    if (error.status === 400 && code === 'ambiguous_local_time') {
      setAmbiguous({
        zone: body.zone ?? formTimezone,
        local: body.local ?? '',
        choices: Array.isArray(body.choices) && body.choices.length > 0
          ? body.choices
          : ['earlier', 'later'],
        field: body.field === 'start' || body.field === 'end' ? body.field : undefined,
      });
      setFormError('这个本地时间在夏令时切换中出现了两次，请选择使用哪一次。');
      return;
    }

    if (error.status === 400 && code === 'nonexistent_local_time') {
      const message = body.message || '这个本地时间在夏令时切换中不存在，请换一个时间。';
      if (body.field === 'start') setErrors((prev) => ({ ...prev, startTime: message }));
      else if (body.field === 'end') setErrors((prev) => ({ ...prev, endTime: message }));
      setFormError(message);
      return;
    }

    if (error.status === 400 && typeof body.field === 'string') {
      const knownFields: FieldName[] = ['date', 'endDate', 'startTime', 'endTime', 'note'];
      if (knownFields.includes(body.field as FieldName)) {
        setErrors((prev) => ({ ...prev, [body.field]: body.message || '请检查这个字段' }));
        setFormError(null);
        return;
      }
    }

    setFormError(
      body.message ||
        (code ? `保存失败（${code}）` : `保存失败（${error.status}）`)
    );
  }

  async function submit(confirmOverlap: boolean, revisionOverride?: number) {
    if (saving) return;
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const submittedSignature = signature();
    const canConfirm =
      confirmOverlap &&
      Boolean(conflicts && conflicts.length >= 0 && conflictToken) &&
      confirmSignature === submittedSignature;
    if (confirmOverlap && !canConfirm) {
      setFormError('安排内容已经变化，请重新保存并处理最新冲突。');
      return;
    }

    setSaving(true);
    setFormError(null);

    try {
      if (mode === 'create') {
        if (!attemptId) throw new Error('缺少尝试 ID');
        let operationId = operationIdRef.current;
        if (!operationId || lastSignatureRef.current !== submittedSignature) {
          operationId = newOperationId();
          operationIdRef.current = operationId;
          lastSignatureRef.current = submittedSignature;
        }
        const payload: CreateScheduleInput = {
          ...buildPayload(canConfirm),
          operationId,
        };
        const res = await api.createSchedule(attemptId, payload);
        operationIdRef.current = null;
        lastSignatureRef.current = null;
        onSaved(res.schedule);
      } else {
        if (!schedule) throw new Error('缺少安排');
        const payload: UpdateScheduleInput = {
          ...buildPayload(canConfirm),
          revision: revisionOverride ?? baseRevision,
        };
        const res = await api.updateSchedule(schedule.id, payload);
        setBaseRevision(res.schedule.revision);
        onSaved(res.schedule);
      }
    } catch (error) {
      handleApiError(error, submittedSignature);
    } finally {
      setSaving(false);
    }
  }

  function adoptLatest() {
    if (!revisionCurrent) return;
    const values = buildInitialValues('edit', revisionCurrent, revisionCurrent.timezone);
    setDate(values.date);
    setEndDate(values.endDate);
    setCrossDay(values.crossDay);
    setStartTime(values.startTime);
    setEndTime(values.endTime);
    setNote(values.note);
    setBaseRevision(revisionCurrent.revision);
    setRevisionCurrent(null);
    setConflicts(null);
    setConflictToken(null);
    setConfirmSignature(null);
    setFormError(null);
    setErrors({});
  }

  const effectiveEndDate = crossDay ? endDate : date;
  const ambiguousField = ambiguous?.field;

  return (
    <form
      className="schedule-editor"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
    >
      <div className="schedule-form-context">
        <span>
          当前时区：<strong>{scheduleTimezoneLabel(formTimezone)}</strong>
        </span>
        {mode === 'edit' && formTimezone !== displayTimezone && (
          <span className="muted">
            当前显示时区为 {displayTimezone}；保存仍按这条安排原本的时区。
          </span>
        )}
        {mode === 'create' && (
          <span className="muted">新建安排会按当前表单时区保存。</span>
        )}
      </div>

      <div className="schedule-form-row">
        <label className="field">
          <span>日期</span>
          <input
            data-testid="schedule-date"
            type="date"
            value={date}
            required
            onChange={(event) => onDateChange(event.target.value)}
          />
          {errors.date && <span className="field-error">{errors.date}</span>}
        </label>
        <label className="field">
          <span>开始</span>
          <input
            data-testid="schedule-start"
            type="time"
            value={startTime}
            required
            onChange={(event) => onStartTimeChange(event.target.value)}
          />
          {errors.startTime && <span className="field-error">{errors.startTime}</span>}
        </label>
        <label className="field">
          <span>结束</span>
          <input
            data-testid="schedule-end"
            type="time"
            value={endTime}
            required
            onChange={(event) => onEndTimeChange(event.target.value)}
          />
          {errors.endTime && <span className="field-error">{errors.endTime}</span>}
        </label>
      </div>

      <label className="schedule-check">
        <input
          type="checkbox"
          checked={crossDay}
          onChange={(event) => {
            const checked = event.target.checked;
            setCrossDay(checked);
            if (!checked) {
              setEndDate(date);
            } else if (
              isValidDateKey(date) &&
              isValidTimeString(startTime) &&
              isValidTimeString(endTime) &&
              minutesOfTime(endTime) <= minutesOfTime(startTime)
            ) {
              // 勾选跨日却不早于开始时间时，多半是跨午夜：把结束日期顺延一天，
              // 免得用户看到「必须晚于开始时间」还要自己猜。
              const nextDay = new Date(`${date}T00:00:00`);
              nextDay.setDate(nextDay.getDate() + 1);
              setEndDate(
                `${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(2, '0')}-${String(
                  nextDay.getDate()
                ).padStart(2, '0')}`
              );
            }
            setErrors((prev) => ({ ...prev, endTime: undefined, endDate: undefined }));
            clearConflictConfirmation();
          }}
        />
        <span>跨日（结束日期与开始日期不同）</span>
      </label>

      {crossDay && (
        <label className="field schedule-end-date">
          <span>结束日期</span>
          <input
            data-testid="schedule-end-date"
            type="date"
            value={endDate}
            min={date}
            required
            onChange={(event) => onEndDateChange(event.target.value)}
          />
          {errors.endDate && <span className="field-error">{errors.endDate}</span>}
        </label>
      )}

      <label className="field">
        <span>备注（选填，最多 300 字）</span>
        <textarea
          data-testid="schedule-note"
          rows={2}
          value={note}
          placeholder="例如「先跑一次实验」"
          onChange={(event) => onNoteChange(event.target.value)}
        />
        <span className="char-count">{note.trim().length}/300</span>
        {errors.note && <span className="field-error">{errors.note}</span>}
      </label>

      {ambiguous && (
        <div className="conflict-banner" role="alert">
          <p>
            {ambiguous.zone} 在 {ambiguous.local || '所选本地时间'} 有两次重复时间（夏令时）。
            请选择使用哪一次，系统不会自动猜测。
          </p>
          {ambiguousField !== 'end' && (
            <label className="field">
              <span>开始时间使用</span>
              <select
                value={startDisambiguation}
                onChange={(event) =>
                  setStartDisambiguation(event.target.value as '' | LocalTimeDisambiguation)
                }
              >
                <option value="">请选择</option>
                {ambiguous.choices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice === 'earlier' ? '较早的一次（earlier）' : '较晚的一次（later）'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {ambiguousField !== 'start' && (
            <label className="field">
              <span>结束时间使用</span>
              <select
                value={endDisambiguation}
                onChange={(event) =>
                  setEndDisambiguation(event.target.value as '' | LocalTimeDisambiguation)
                }
              >
                <option value="">请选择</option>
                {ambiguous.choices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice === 'earlier' ? '较早的一次（earlier）' : '较晚的一次（later）'}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {conflicts && (
        <div className="conflict-banner schedule-conflict-panel" role="alert">
          <p>
            <strong>
              {conflictChanged
                ? '冲突已变化：确认期间安排发生了变化，出现了新的冲突。'
                : '与现有安排重叠。'}
            </strong>
          </p>
          {conflicts.length > 0 ? (
            <ul className="schedule-conflict-list">
              {conflicts.map((item) => (
                <li key={item.id}>
                  <span>
                    {formatScheduleFullRange(item, displayTimezone)}
                    {newConflictIds.includes(item.id) && (
                      <span className="badge warn">新增冲突</span>
                    )}
                  </span>
                  <span className="muted">
                    {item.attempt?.step ?? '（尝试已删除）'} · {item.timezone}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">服务端未返回具体冲突对象，请再次确认后保存。</p>
          )}
          <p>如果仍然保存，这些安排会同时存在；相邻时段不算重叠。</p>
          <div className="row-actions">
            <button
              type="button"
              className="btn primary"
              data-testid="schedule-confirm-overlap"
              disabled={saving}
              onClick={() => void submit(true)}
            >
              {saving ? '保存中…' : '仍然保存'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={saving}
              onClick={() => {
                setConflicts(null);
                setConflictToken(null);
                setConfirmSignature(null);
              }}
            >
              返回修改
            </button>
          </div>
        </div>
      )}

      {revisionCurrent && (
        <div className="conflict-banner" role="alert">
          <p>版本冲突：这条安排刚被其他窗口修改，你的草稿仍然保留。</p>
          <p className="muted">
            最新时间：
            {formatScheduleFullRange(revisionCurrent, displayTimezone)} · 版本{' '}
            {revisionCurrent.revision}
          </p>
          <div className="row-actions">
            <button type="button" className="btn small" onClick={adoptLatest}>
              查看最新内容并采用
            </button>
            <button
              type="button"
              className="btn small"
              disabled={saving}
              onClick={() => {
                const revision = revisionCurrent.revision;
                setBaseRevision(revision);
                setRevisionCurrent(null);
                void submit(false, revision);
              }}
            >
              重试保存（按最新版本）
            </button>
          </div>
        </div>
      )}

      {formError && (
        <p className="error-msg" role="alert">
          {formError}
        </p>
      )}

      <div className="row-actions schedule-editor-actions">
        <button
          type="submit"
          className="btn primary"
          data-testid="schedule-save"
          disabled={saving}
        >
          {saving ? '保存中…' : mode === 'create' ? '保存安排' : '保存修改'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          {mode === 'create' ? '收起' : '取消编辑'}
        </button>
        <span className="muted schedule-form-preview">
          {isValidDateKey(date) && isValidTimeString(startTime) && isValidTimeString(endTime)
            ? `${date} ${startTime} – ${effectiveEndDate} ${endTime}（${formTimezone}）`
            : '填写日期与时间后保存'}
        </span>
      </div>
    </form>
  );
}
