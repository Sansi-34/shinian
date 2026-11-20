// V2 主题（暗色 / 纸张）：所有页面共用一份状态。
// - 同步读 localStorage 作为初始值：原来先渲染 dark 再在 effect 里改成 paper，
//   纸张用户每次切页都会闪一下黑屏。
// - 多个组件同时挂着（外壳状态栏 + 更多菜单）时用自定义事件互相同步。
import { useEffect, useState } from 'react';

export type V2Theme = 'dark' | 'paper';
const THEME_KEY = 'shinian.v2-theme';
const EVENT = 'shinian:v2-theme';

export function readV2Theme(): V2Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'paper' ? 'paper' : 'dark';
  } catch {
    return 'dark';
  }
}

export function useV2Theme(): [V2Theme, (t: V2Theme) => void] {
  const [theme, setTheme] = useState<V2Theme>(readV2Theme);

  useEffect(() => {
    const sync = () => setTheme(readV2Theme());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  function change(next: V2Theme) {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* localStorage 不可用时只改本组件 */
    }
    setTheme(next);
    window.dispatchEvent(new Event(EVENT));
  }

  return [theme, change];
}
