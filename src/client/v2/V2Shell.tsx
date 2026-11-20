// V2 外壳：图标栏 + 三栏骨架 + 底部状态栏 + 主题切换
// 页面只提供三个插槽（左 / 中 / 右）与状态栏内容，其余都由这里负责。
import type { ReactNode } from 'react';
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

  return (
    <div className="v2-root" data-v2-theme={theme}>
      <CosmosBackdrop active={theme === 'dark'} />
      <Rail />

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
