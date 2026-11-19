// 归藏设计系统 · 瑞士风主题切换器
// 四套主题共享纸色与灰阶，只换锚点色：ikb / lemon / lemon-green / safety-orange
import { useEffect, useState } from 'react';

export type SwissTheme = 'ikb' | 'lemon' | 'lemon-green' | 'safety-orange';

const THEMES: Array<{ id: SwissTheme; label: string }> = [
  { id: 'ikb', label: '克莱因蓝' },
  { id: 'lemon', label: '柠檬黄' },
  { id: 'lemon-green', label: '柠檬绿' },
  { id: 'safety-orange', label: '安全橙' },
];

const KEY = 'shinian.gz-theme';

export function applyTheme(theme: SwissTheme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export default function ThemeSwitcher() {
  const [theme, setTheme] = useState<SwissTheme>('ikb');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      /* ignore */
    }
    const next = THEMES.some((t) => t.id === saved) ? (saved as SwissTheme) : 'ikb';
    setTheme(next);
    applyTheme(next);
  }, []);

  function select(next: SwissTheme) {
    setTheme(next);
    applyTheme(next);
    setOpen(false);
  }

  return (
    <div className="gz-theme-switcher">
      <button
        type="button"
        className="gz-theme-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-label="切换配色主题"
        aria-expanded={open}
        title="配色主题"
      >
        <span className="gz-theme-swatch" aria-hidden="true" />
        <span className="gz-theme-name">{THEMES.find((t) => t.id === theme)?.label}</span>
      </button>
      {open && (
        <div className="gz-theme-menu" role="menu">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitemradio"
              aria-checked={t.id === theme}
              className={`gz-theme-item${t.id === theme ? ' active' : ''}`}
              onClick={() => select(t.id)}
            >
              <span className={`gz-theme-swatch swatch-${t.id}`} aria-hidden="true" />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
