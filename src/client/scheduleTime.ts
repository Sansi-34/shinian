// 拾念 SHINIAN v0.2 - 日程时区与日期工具（不引入第三方依赖）
import { useCallback, useEffect, useState } from 'react';

export const DEFAULT_DISPLAY_TIMEZONE = 'Asia/Shanghai';
export const DISPLAY_TIMEZONE_STORAGE_KEY = 'shinian.displayTimezone';

export type TimezoneOption = {
  value: string;
  label: string;
};

/**
 * 显示时区固定列表。每个安排自己的 timezone 由服务端保存，不随这里切换而改变。
 * 顺序大致按常用程度排列，默认第一项为 Asia/Shanghai。
 */
export const DISPLAY_TIMEZONES: TimezoneOption[] = [
  { value: 'Asia/Shanghai', label: '上海 / 中国标准时间' },
  { value: 'Asia/Hong_Kong', label: '香港' },
  { value: 'Asia/Macau', label: '澳门' },
  { value: 'Asia/Taipei', label: '台北' },
  { value: 'Asia/Tokyo', label: '东京' },
  { value: 'Asia/Seoul', label: '首尔' },
  { value: 'Asia/Singapore', label: '新加坡' },
  { value: 'Asia/Bangkok', label: '曼谷' },
  { value: 'Asia/Kolkata', label: '印度标准时间' },
  { value: 'Asia/Dubai', label: '迪拜' },
  { value: 'Europe/London', label: '伦敦' },
  { value: 'Europe/Paris', label: '巴黎' },
  { value: 'Europe/Berlin', label: '柏林' },
  { value: 'Europe/Madrid', label: '马德里' },
  { value: 'Europe/Moscow', label: '莫斯科' },
  { value: 'America/New_York', label: '纽约' },
  { value: 'America/Chicago', label: '芝加哥' },
  { value: 'America/Denver', label: '丹佛' },
  { value: 'America/Los_Angeles', label: '洛杉矶' },
  { value: 'America/Vancouver', label: '温哥华' },
  { value: 'America/Sao_Paulo', label: '圣保罗' },
  { value: 'Australia/Sydney', label: '悉尼' },
  { value: 'Australia/Perth', label: '珀斯' },
  { value: 'Pacific/Auckland', label: '奥克兰' },
  { value: 'UTC', label: '世界标准时间（UTC）' },
];

const validTimezoneCache = new Map<string, boolean>();
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimezone(timezone: string | null | undefined): boolean {
  if (!timezone) return false;
  const cached = validTimezoneCache.get(timezone);
  if (cached !== undefined) return cached;
  let valid = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    valid = true;
  } catch {
    valid = false;
  }
  validTimezoneCache.set(timezone, valid);
  return valid;
}

/** 只接受可用 IANA 时区；非法或空值回落到默认时区。 */
export function normalizeTimezone(timezone: string | null | undefined): string {
  const value = (timezone ?? '').trim();
  if (value && isValidTimezone(value)) return value;
  return DEFAULT_DISPLAY_TIMEZONE;
}

export function getStoredDisplayTimezone(): string {
  if (typeof window === 'undefined') return DEFAULT_DISPLAY_TIMEZONE;
  try {
    return normalizeTimezone(window.localStorage.getItem(DISPLAY_TIMEZONE_STORAGE_KEY));
  } catch {
    return DEFAULT_DISPLAY_TIMEZONE;
  }
}

/**
 * 读取显示时区，同时把「存的是非法时区、已回退默认」这件事一并返回，
 * 让页面能给用户一句人话提示（normalizeTimezone 本身仍然静默，签名不变）。
 */
export function readStoredDisplayTimezoneWithNotice(): {
  timezone: string;
  rejectedTimezone: string | null;
} {
  if (typeof window === 'undefined') {
    return { timezone: DEFAULT_DISPLAY_TIMEZONE, rejectedTimezone: null };
  }
  try {
    const raw = (window.localStorage.getItem(DISPLAY_TIMEZONE_STORAGE_KEY) ?? '').trim();
    if (!raw || isValidTimezone(raw)) {
      return { timezone: normalizeTimezone(raw), rejectedTimezone: null };
    }
    return { timezone: DEFAULT_DISPLAY_TIMEZONE, rejectedTimezone: raw };
  } catch {
    return { timezone: DEFAULT_DISPLAY_TIMEZONE, rejectedTimezone: null };
  }
}

/** 非法时区被回退时给用户的一句可读提示。 */
export function timezoneFallbackNotice(rejectedTimezone: string): string {
  return `「${rejectedTimezone}」不是有效的 IANA 时区，已改用 ${DEFAULT_DISPLAY_TIMEZONE} 显示与计算日界。`;
}

export function storeDisplayTimezone(timezone: string): string {
  const value = normalizeTimezone(timezone);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(DISPLAY_TIMEZONE_STORAGE_KEY, value);
    } catch {
      // localStorage 不可用时仅保留内存状态
    }
  }
  return value;
}

const DISPLAY_TIMEZONE_EVENT = 'shinian:display-timezone-change';

/** 显示时区 hook：跨标签页与同页多个组件同步。 */
export function useDisplayTimezone(): [string, (timezone: string) => void] {
  const [timezone, setTimezoneState] = useState<string>(() => getStoredDisplayTimezone());

  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        if (!window.localStorage.getItem(DISPLAY_TIMEZONE_STORAGE_KEY)) {
          window.localStorage.setItem(DISPLAY_TIMEZONE_STORAGE_KEY, timezone);
        }
      } catch {
        // localStorage 不可用时只保留内存状态
      }
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== DISPLAY_TIMEZONE_STORAGE_KEY) return;
      setTimezoneState(normalizeTimezone(event.newValue));
    };
    const onCustom = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setTimezoneState(normalizeTimezone(detail));
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(DISPLAY_TIMEZONE_EVENT, onCustom);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(DISPLAY_TIMEZONE_EVENT, onCustom);
    };
  }, [timezone]);

  const setTimezone = useCallback((next: string) => {
    const value = storeDisplayTimezone(next);
    setTimezoneState(value);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent<string>(DISPLAY_TIMEZONE_EVENT, { detail: value }));
    }
  }, []);

  return [timezone, setTimezone];
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 用 Intl 取某时刻在指定时区的墙上时间，不依赖本地时区或固定偏移。 */
export function getZonedParts(timestamp: number, timezone: string): ZonedParts {
  const parts = formatterFor(normalizeTimezone(timezone)).formatToParts(new Date(timestamp));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
}

/** YYYY-MM-DD（指定时区）。不要用 Date#toISOString，避免时区漂移。 */
export function dateKeyInTimezone(timestamp: number, timezone: string): string {
  const p = getZonedParts(timestamp, timezone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** HH:mm（指定时区）。 */
export function timeInTimezone(timestamp: number, timezone: string): string {
  const p = getZonedParts(timestamp, timezone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function todayDateKey(timezone: string, now = Date.now()): string {
  return dateKeyInTimezone(now, timezone);
}

export function parseDateKey(dateKey: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function isValidDateKey(dateKey: string): boolean {
  return parseDateKey(dateKey) !== null;
}

/** 日期键整数运算；不含时刻，因此不受时区与 DST 影响。 */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return dateKey;
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function dateKeyDiffDays(from: string, to: string): number {
  const a = parseDateKey(from);
  const b = parseDateKey(to);
  if (!a || !b) return 0;
  const aTime = Date.UTC(a.year, a.month - 1, a.day);
  const bTime = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((bTime - aTime) / 86400000);
}

/** ISO 周：周一为一周第一天。 */
export function weekdayIndexMondayFirst(dateKey: string): number {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return 0;
  const day = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  return (day + 6) % 7;
}

export function startOfWeekDateKey(dateKey: string): string {
  return addDaysToDateKey(dateKey, -weekdayIndexMondayFirst(dateKey));
}

export function weekDateKeys(dateKey: string): string[] {
  const start = startOfWeekDateKey(dateKey);
  return Array.from({ length: 7 }, (_, index) => addDaysToDateKey(start, index));
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function weekdayLabel(dateKey: string): string {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return '';
  const day = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  return WEEKDAY_LABELS[day];
}

export function formatMonthDay(dateKey: string): string {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return dateKey;
  return `${parsed.month}月${parsed.day}日`;
}

export function formatDateKeyLabel(dateKey: string, withWeekday = true): string {
  return withWeekday ? `${formatMonthDay(dateKey)} ${weekdayLabel(dateKey)}` : formatMonthDay(dateKey);
}

export function formatWeekRangeLabel(weekStartDateKey: string): string {
  return `${formatMonthDay(weekStartDateKey)} – ${formatMonthDay(addDaysToDateKey(weekStartDateKey, 6))}`;
}

export function formatFullDate(dateKey: string): string {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return dateKey;
  return `${parsed.year}年${parsed.month}月${parsed.day}日`;
}

export function isValidTimeString(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function minutesOfTime(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour || 0) * 60 + (minute || 0);
}

export type ScheduleTimeLike = {
  startsAt: number;
  endsAt: number;
};

export function isCrossDaySchedule(schedule: ScheduleTimeLike, timezone: string): boolean {
  // 展示上的「跨日」按结束时刻的墙上日期判断；结束刚好 00:00 时也应提示跨日。
  return dateKeyInTimezone(schedule.startsAt, timezone) !== dateKeyInTimezone(schedule.endsAt, timezone);
}

/** 安排覆盖的本地日期（含起止两天，用于跨日展示）。 */
export function scheduleDateKeys(schedule: ScheduleTimeLike, timezone: string): { start: string; end: string } {
  return {
    start: dateKeyInTimezone(schedule.startsAt, timezone),
    end: dateKeyInTimezone(schedule.endsAt - 1, timezone),
  };
}

export function scheduleCoversDate(schedule: ScheduleTimeLike, dateKey: string, timezone: string): boolean {
  const { start, end } = scheduleDateKeys(schedule, timezone);
  return start <= dateKey && dateKey <= end;
}

export function scheduleOverlapsRange(
  schedule: ScheduleTimeLike,
  fromDateKey: string,
  toDateKeyExclusive: string,
  timezone: string
): boolean {
  const { start, end } = scheduleDateKeys(schedule, timezone);
  return start < toDateKeyExclusive && end >= fromDateKey;
}

/**
 * 时间范围文案。同一天显示 10:00–11:00；
 * 跨日显示 11月14日 22:00 – 11月15日 01:00，避免误读。
 */
export function formatScheduleTimeRange(schedule: ScheduleTimeLike, timezone: string): string {
  const startKey = dateKeyInTimezone(schedule.startsAt, timezone);
  const endKey = dateKeyInTimezone(schedule.endsAt, timezone);
  const startTime = timeInTimezone(schedule.startsAt, timezone);
  const endTime = timeInTimezone(schedule.endsAt, timezone);
  if (startKey === endKey) return `${startTime}–${endTime}`;
  return `${formatMonthDay(startKey)} ${startTime} – ${formatMonthDay(endKey)} ${endTime}`;
}

export function formatScheduleFullRange(schedule: ScheduleTimeLike, timezone: string): string {
  const startKey = dateKeyInTimezone(schedule.startsAt, timezone);
  const endKey = dateKeyInTimezone(schedule.endsAt, timezone);
  const startTime = timeInTimezone(schedule.startsAt, timezone);
  const endTime = timeInTimezone(schedule.endsAt, timezone);
  if (startKey === endKey) {
    return `${formatDateKeyLabel(startKey)} ${startTime}–${endTime}`;
  }
  return `${formatDateKeyLabel(startKey)} ${startTime} – ${formatDateKeyLabel(endKey)} ${endTime}`;
}

/** 单个时刻：2026-11-14 10:00（指定时区）。 */
export function formatDateTimeInTimezone(timestamp: number, timezone: string): string {
  return `${dateKeyInTimezone(timestamp, timezone)} ${timeInTimezone(timestamp, timezone)}`;
}

export function isSchedulePast(schedule: ScheduleTimeLike, now = Date.now()): boolean {
  return schedule.endsAt < now;
}

export function scheduleTimezoneLabel(timezone: string): string {
  const found = DISPLAY_TIMEZONES.find((item) => item.value === timezone);
  return found ? `${found.label}（${timezone}）` : timezone;
}

export function sortSchedules<T extends ScheduleTimeLike & { id: string }>(schedules: T[]): T[] {
  return [...schedules].sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
}

/** 每分钟刷新一次「已过安排时间」等相对当前时间的展示。 */
export function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
