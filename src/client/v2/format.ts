// V2 统一的日期/时间显示
// 规则：
//   - 一律按「显示时区」计算，不用 toISOString()（那是 UTC，会跨时区错一天）
//   - 最近三天用「今天 / 昨天 / 前天」，其余用完整年月日 2026-11-19
//   - 需要精确到分钟时用 2026-11-19 14:59
import { dateKeyInTimezone, timeInTimezone } from '../scheduleTime';

const DAY_MS = 86_400_000;

/** 与今天的日历日差（按给定时区），不是毫秒差 */
function dayDiff(ts: number, todayKey: string, tz: string): number {
  const key = dateKeyInTimezone(ts, tz);
  const a = Date.parse(todayKey + 'T00:00:00Z');
  const b = Date.parse(key + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return 99;
  return Math.round((a - b) / DAY_MS);
}

/** 列表里用的日期标签：今天 / 昨天 / 前天 / 2026-11-19 */
export function dayLabel(ts: number, tz: string, todayKey: string): string {
  const diff = dayDiff(ts, todayKey, tz);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  return dateKeyInTimezone(ts, tz);
}

/** 精确到分钟：2026-11-19 14:59 */
export function dayTimeLabel(ts: number, tz: string): string {
  return `${dateKeyInTimezone(ts, tz)} ${timeInTimezone(ts, tz)}`;
}

/** 表单里的本地墙钟值（datetime-local 需要 YYYY-MM-DDTHH:mm） */
export function toLocalInputValue(ts: number | null, tz: string): string {
  if (!ts) return '';
  return `${dateKeyInTimezone(ts, tz)}T${timeInTimezone(ts, tz)}`;
}

/** 把 datetime-local 的墙钟值按给定时区换算成时间戳（无效返回 null） */
export function fromLocalInputValue(value: string, tz: string): number | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  // 该时区在这一刻的偏移：用 Intl 反解，避免依赖本机时区
  const utcGuess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcGuess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offset = asIfUtc - utcGuess;
  const ts = utcGuess - offset;
  return Number.isFinite(ts) ? ts : null;
}
