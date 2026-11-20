// 拾念 · 个人界面偏好（持久化在 localStorage，供设置页与周期回顾日程表共用）
import { useEffect, useState } from 'react';

export const DEFAULT_CALENDAR_COLOR = '#0a84ff';

export const CALENDAR_COLOR_PRESETS = [
  { name: '系统蓝（默认）', value: '#0a84ff' },
  { name: '冰晶青', value: '#5ac8fa' },
  { name: '翡翠绿', value: '#30d158' },
  { name: '琥珀金', value: '#ff9f0a' },
  { name: '星云紫', value: '#bf5af2' },
  { name: '珊瑚红', value: '#ff375f' },
] as const;

const COLOR_KEY = 'shinian.calendar-color';
const MODELS_KEY = 'shinian.recent-models';
const PREF_EVENT = 'shinian:prefs-changed';

export function readRecentModelIds(): string[] {
  try {
    const raw = localStorage.getItem(MODELS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 20);
  } catch {
    return [];
  }
}

export function rememberRecentModelId(modelId: string): string[] {
  const id = modelId.trim();
  if (!id) return readRecentModelIds();
  const next = [id, ...readRecentModelIds().filter((m) => m !== id)].slice(0, 20);
  try {
    localStorage.setItem(MODELS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

export function normalizeHexColor(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_CALENDAR_COLOR;
  const trimmed = raw.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : DEFAULT_CALENDAR_COLOR;
}

export function readCalendarColor(): string {
  try {
    return normalizeHexColor(localStorage.getItem(COLOR_KEY));
  } catch {
    return DEFAULT_CALENDAR_COLOR;
  }
}

export function useCalendarColor(): [string, (hex: string) => void] {
  const [color, setColor] = useState<string>(readCalendarColor);

  useEffect(() => {
    const sync = () => setColor(readCalendarColor());
    window.addEventListener(PREF_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PREF_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  function update(next: string) {
    const safe = normalizeHexColor(next);
    try {
      localStorage.setItem(COLOR_KEY, safe);
    } catch {
      /* ignore */
    }
    setColor(safe);
    window.dispatchEvent(new Event(PREF_EVENT));
  }

  return [color, update];
}
