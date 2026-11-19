// V2 外壳：图标栏 + 三栏骨架 + 底部状态栏 + 主题切换
// 页面只提供三个插槽（左 / 中 / 右）与状态栏内容，其余都由这里负责。
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Rail from './ui/Rail';
import StatusBar from './ui/StatusBar';
import './tokens.css';
import styles from './V2Shell.module.css';

export type V2Theme = 'dark' | 'paper';
const THEME_KEY = 'shinian.v2-theme';

export function useV2Theme(): [V2Theme, (t: V2Theme) => void] {
  const [theme, setTheme] = useState<V2Theme>('dark');
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch {
      /* localStorage 不可用时忽略 */
    }
    setTheme(saved === 'paper' ? 'paper' : 'dark');
  }, []);
  function change(next: V2Theme) {
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
  }
  return [theme, change];
}

// 「更多」只放图标栏里没有的入口。设置已在图标栏底部，这里重复一次会让用户
// 以为有两个不同的设置页。
const MORE = [
  ['/experiences', '经验'],
  ['/schedule', '日程'],
  ['/activity', '操作动态'],
  ['/research', '深度研究'],
];

export default function V2Shell({
  left,
  leftTitle,
  leftCount,
  right,
  rightTitle,
  children,
  statusLeft,
  statusRight,
}: {
  left?: ReactNode;
  leftTitle?: string;
  leftCount?: number;
  right?: ReactNode;
  rightTitle?: string;
  children: ReactNode;
  statusLeft: ReactNode;
  statusRight?: ReactNode;
}) {
  const [theme, changeTheme] = useV2Theme();
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <div className="v2-root" data-v2-theme={theme}>
      <Rail onMore={() => setMoreOpen((v) => !v)} />

      {moreOpen && (
        <>
          {/* 点空白处关掉，避免用户被困在浮层里 */}
          <button
            type="button"
            className={styles.moreScrim}
            aria-label="关闭更多入口"
            onClick={() => setMoreOpen(false)}
          />
          <div className={styles.morePanel} role="menu" aria-label="更多入口">
            {MORE.map(([to, label]) => (
              <Link
                key={to}
                to={to}
                className={styles.moreItem}
                role="menuitem"
                onClick={() => setMoreOpen(false)}
              >
                {label}
              </Link>
            ))}
          </div>
        </>
      )}

      <div className={styles.shell}>
        {left !== undefined && (
          <nav className={styles.left} aria-label={leftTitle ?? '列表'}>
            <div className={styles.colHead}>
              <h1>{leftTitle}</h1>
              {leftCount !== undefined && <span className={styles.headCount}>{leftCount}</span>}
            </div>
            <div className={styles.leftBody}>{left}</div>
          </nav>
        )}

        <main className={styles.center}>{children}</main>

        {right !== undefined && (
          <aside className={styles.right} aria-label={rightTitle ?? '侧栏'}>
            <div className={styles.colHead}>
              <h1>{rightTitle}</h1>
            </div>
            <div className={styles.rightBody}>{right}</div>
          </aside>
        )}
      </div>

      <StatusBar
        left={statusLeft}
        right={
          <>
            <button
              type="button"
              className={styles.themeBtn}
              onClick={() => changeTheme(theme === 'dark' ? 'paper' : 'dark')}
            >
              {theme === 'dark' ? '纸张主题' : '暗色主题'}
            </button>
            {statusRight}
          </>
        }
      />
    </div>
  );
}
