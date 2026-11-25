// V2 外壳：图标栏 + 三栏骨架 + 底部状态栏 + 主题切换
// 页面只提供三个插槽（左 / 中 / 右）与状态栏内容，其余都由这里负责。
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import Rail from './ui/Rail';
import StatusBar from './ui/StatusBar';
import CosmosBackdrop from './ui/CosmosBackdrop';
import { useV2Theme, type V2Theme } from './theme';
import './tokens.css';
import styles from './V2Shell.module.css';

export { type V2Theme, useV2Theme };

export default function V2Shell({
  left,
  leftTitle,
  leftCount,
  mobileLeftLabel,
  mobileTopRight,
  right,
  rightTitle,
  children,
  statusLeft,
  statusRight,
}: {
  left?: ReactNode;
  leftTitle?: string;
  leftCount?: number;
  mobileLeftLabel?: string;
  mobileTopRight?: ReactNode;
  right?: ReactNode;
  rightTitle?: string;
  children: ReactNode;
  statusLeft: ReactNode;
  statusRight?: ReactNode;
}) {
  const [theme, changeTheme] = useV2Theme();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 路由变化自动收起移动端抽屉
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname, location.search]);

  // Esc 关闭移动端抽屉
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  function handleLeftBodyClick(e: MouseEvent<HTMLDivElement>) {
    if (!drawerOpen) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const actionable = target.closest(
      'a[href], .v2-leftItem:not([data-keep-drawer="true"]), [data-close-drawer="true"]'
    );
    if (actionable) {
      setDrawerOpen(false);
    }
  }

  return (
    <div className="v2-root" data-v2-theme={theme}>
      <CosmosBackdrop active={theme === 'dark'} />
      <Rail />

      <div className={styles.shell}>
        {left !== undefined && (
          <div className={styles.mobileBar}>
            <button
              type="button"
              className={styles.drawerTrigger}
              onClick={() => setDrawerOpen(true)}
              aria-expanded={drawerOpen}
              aria-controls="v2-left-drawer"
              data-testid="v2-mobile-drawer-btn"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M9 4v16" />
              </svg>
              <span className={styles.mobileBarTitle}>{mobileLeftLabel ?? leftTitle ?? '列表'}</span>
              {leftCount !== undefined && <span className={styles.mobileCount}>{leftCount}</span>}
            </button>
            {mobileTopRight && <div className={styles.mobileBarRight}>{mobileTopRight}</div>}
          </div>
        )}

        {left !== undefined && drawerOpen && (
          <button
            type="button"
            className={styles.drawerScrim}
            aria-label="关闭抽屉"
            onClick={() => setDrawerOpen(false)}
          />
        )}

        {left !== undefined && (
          <nav
            id="v2-left-drawer"
            className={`${styles.left}${drawerOpen ? ' ' + styles.leftOpen : ''}`}
            aria-label={leftTitle ?? '列表'}
          >
            <div className={styles.colHead}>
              <h1>{leftTitle}</h1>
              {leftCount !== undefined && <span className={styles.headCount}>{leftCount}</span>}
              <button
                type="button"
                className={styles.drawerClose}
                onClick={() => setDrawerOpen(false)}
                aria-label="关闭抽屉"
              >
                ✕
              </button>
            </div>
            <div className={styles.leftBody} onClick={handleLeftBodyClick}>
              {left}
            </div>
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
