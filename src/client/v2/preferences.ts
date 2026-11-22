// 拾念 · 个人界面偏好（持久化在 localStorage，供设置页与周期回顾日程表共用）
import { useEffect, useState } from 'react';

export const DEFAULT_CALENDAR_COLOR = '#2c5282';

export const CALENDAR_COLOR_PRESETS = [
  { name: '石板蓝（默认）', value: '#2c5282' },
  { name: '松烟青', value: '#2f6f5e' },
  { name: '墨灰', value: '#3f3f46' },
  { name: '赭石金', value: '#b45309' },
  { name: '靛紫', value: '#5b3a8a' },
  { name: '绛红', value: '#992b24' },
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
