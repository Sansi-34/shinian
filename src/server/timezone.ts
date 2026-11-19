// IANA 时区与本地日期/时间解析。
// 约定：所有持久化时间都是 UTC epoch 毫秒；本地日期/时间只存在于请求与展示层。
// 这里不依赖第三方时区库，全部基于 Intl.DateTimeFormat 的 IANA 支持。

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
export const MAX_RANGE_DAYS = 62;
export const MAX_SCHEDULE_SPAN_DAYS = 7;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export type Disambiguation = 'earlier' | 'later';

export type LocalDate = {
  year: number;
  month: number;
  day: number;
  /** 规范化后的 YYYY-MM-DD */
  text: string;
};

export type LocalTime = {
  hour: number;
  minute: number;
  /** 规范化后的 HH:mm */
  text: string;
};

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type LocalTimeResolution =
  | { kind: 'ok'; utc: number }
  | { kind: 'nonexistent'; local: string }
  | { kind: 'ambiguous'; local: string; choices: Disambiguation[]; earlier: number; later: number };

export type ScheduleRange = {
  from: string;
  to: string;
  timezone: string;
  fromAt: number;
  toAt: number;
  fromIso: string;
  toIso: string;
};

export type ParseScheduleRangeResult =
  | { ok: true; value: ScheduleRange }
  | { ok: false; status: 400; error: string; message: string; field?: string };

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const dayStartCache = new Map<string, number>();
const DAY_START_CACHE_LIMIT = 4096;

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timezone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timezone, cached);
  }
  return cached;
}

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timezone = value.trim();
  if (!timezone || timezone.length > 100) return false;
  // 拒绝明显不是 IANA 名称的输入（Intl 在新规范里也接受 "+08:00" 这类偏移）
  if (!/^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*$/.test(timezone)) return false;
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions();
    return Boolean(resolved.timeZone);
  } catch {
    return false;
  }
}

/** 请求未带 timezone 时使用默认 Asia/Shanghai；带了但无效则返回 null。 */
export function normalizeTimezone(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEZONE;
  if (!isValidTimezone(value)) return null;
  return (value as string).trim();
}

export function getZonedParts(ms: number, timezone: string): ZonedParts {
  const parts = formatterFor(timezone).formatToParts(new Date(ms));
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

/** 某个 UTC 瞬时在指定时区的 UTC 偏移（毫秒）。 */
function offsetMsAt(ms: number, timezone: string): number {
  const parts = getZonedParts(ms, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  // 去掉瞬时自身的毫秒，避免把毫秒误差带进偏移
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatZonedDate(ms: number, timezone: string): string {
  const parts = getZonedParts(ms, timezone);
  return `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export function formatZonedDateTime(ms: number, timezone: string): string {
  const parts = getZonedParts(ms, timezone);
  return `${formatZonedDate(ms, timezone)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

export function parseLocalDate(value: unknown): LocalDate | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day, text: `${match[1]}-${match[2]}-${match[3]}` };
}

export function parseLocalTime(value: unknown): LocalTime | null {
  if (typeof value !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return { hour, minute, text: `${match[1]}:${match[2]}` };
}

export function isValidDisambiguation(value: unknown): value is Disambiguation {
  return value === 'earlier' || value === 'later';
}

/**
 * 把「本地日期 + 本地时间 + IANA 时区」解析成 UTC 毫秒。
 * - 夏令时不存在的时间返回 nonexistent；
 * - 夏令时重复的时间返回 ambiguous（附 earlier/later 两个候选），不静默猜测。
 */
export function resolveLocalDateTime(
  date: LocalDate,
  time: LocalTime,
  timezone: string,
  disambiguation?: Disambiguation
): LocalTimeResolution {
  const guess = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, 0);
  const local = `${date.text} ${time.text}`;

  const offsets = new Set<number>();
  for (const dayDelta of [-2, -1, 0, 1, 2]) {
    offsets.add(offsetMsAt(guess + dayDelta * MS_PER_DAY, timezone));
  }

  const matches: number[] = [];
  for (const offset of offsets) {
    const candidate = guess - offset;
    const parts = getZonedParts(candidate, timezone);
    if (
      parts.year === date.year &&
      parts.month === date.month &&
      parts.day === date.day &&
      parts.hour === time.hour &&
      parts.minute === time.minute
    ) {
      if (!matches.includes(candidate)) matches.push(candidate);
    }
  }
  matches.sort((a, b) => a - b);

  if (matches.length === 0) return { kind: 'nonexistent', local };
  if (matches.length === 1) return { kind: 'ok', utc: matches[0] };

  const earlier = matches[0];
  const later = matches[matches.length - 1];
  if (disambiguation === 'earlier') return { kind: 'ok', utc: earlier };
  if (disambiguation === 'later') return { kind: 'ok', utc: later };
  return { kind: 'ambiguous', local, choices: ['earlier', 'later'], earlier, later };
}

/**
 * 指定时区中某本地日期的起始 UTC 毫秒（左闭）。
 * 用二分查找定位「本地日期 >= target」的第一个瞬时，可正确处理
 * 午夜不存在（如部分地区夏令时 00:00 跳到 01:00）与整日被跳过的情况。
 */
export function zonedDayStart(date: LocalDate, timezone: string): number {
  const cacheKey = `${timezone}|${date.text}`;
  const cached = dayStartCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const base = Date.UTC(date.year, date.month - 1, date.day);
  let lo = base - 36 * 60 * MS_PER_MINUTE;
  let hi = base + 36 * 60 * MS_PER_MINUTE;
  // 极端时区偏移（最大约 ±14 小时）下 36 小时足够；留一点防御性扩展。
  let guard = 0;
  while (formatZonedDate(hi, timezone) < date.text && guard < 16) {
    hi += 6 * 60 * MS_PER_MINUTE;
    guard += 1;
  }
  guard = 0;
  while (formatZonedDate(lo, timezone) >= date.text && guard < 16) {
    lo -= 6 * 60 * MS_PER_MINUTE;
    guard += 1;
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (formatZonedDate(mid, timezone) >= date.text) hi = mid;
    else lo = mid + 1;
  }

  if (dayStartCache.size >= DAY_START_CACHE_LIMIT) dayStartCache.clear();
  dayStartCache.set(cacheKey, lo);
  return lo;
}

/** 本地日期加减天数（用 UTC 日历运算，不受时区/夏令时影响）。 */
export function addLocalDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return {
    year,
    month,
    day,
    text: `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`,
  };
}

export function localDateDayNumber(date: LocalDate): number {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / MS_PER_DAY);
}

export function daysBetween(from: LocalDate, to: LocalDate): number {
  return localDateDayNumber(to) - localDateDayNumber(from);
}

/**
 * GET /api/schedules 的范围参数：
 * - from / to 必填，YYYY-MM-DD，左闭右开，to > from；
 * - 跨度 ≤ 62 天（按日历日计算，不受夏令时影响）；
 * - timezone 省略时默认 Asia/Shanghai。
 */
export function parseScheduleRange(raw: {
  from?: unknown;
  to?: unknown;
  timezone?: unknown;
}): ParseScheduleRangeResult {
  const from = parseLocalDate(raw.from);
  if (!from) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_range',
      message: 'from 必须是有效的 YYYY-MM-DD 日期。',
      field: 'from',
    };
  }
  const to = parseLocalDate(raw.to);
  if (!to) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_range',
      message: 'to 必须是有效的 YYYY-MM-DD 日期。',
      field: 'to',
    };
  }
  if (to.text <= from.text) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_range',
      message: 'to 必须晚于 from（to 为不包含的结束日期）。',
      field: 'to',
    };
  }
  if (daysBetween(from, to) > MAX_RANGE_DAYS) {
    return {
      ok: false,
      status: 400,
      error: 'range_too_large',
      message: `单次查询最多 ${MAX_RANGE_DAYS} 天。`,
      field: 'to',
    };
  }
  const timezone = normalizeTimezone(raw.timezone);
  if (!timezone) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_timezone',
      message: 'timezone 必须是有效的 IANA 时区名称（例如 Asia/Shanghai）。',
      field: 'timezone',
    };
  }

  const fromAt = zonedDayStart(from, timezone);
  const toAt = zonedDayStart(to, timezone);
  return {
    ok: true,
    value: {
      from: from.text,
      to: to.text,
      timezone,
      fromAt,
      toAt,
      fromIso: new Date(fromAt).toISOString(),
      toIso: new Date(toAt).toISOString(),
    },
  };
}
