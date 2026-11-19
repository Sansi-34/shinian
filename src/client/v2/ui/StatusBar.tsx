import type { ReactNode } from 'react';
import styles from './StatusBar.module.css';

/** 底部状态栏：承载登录态与库容量这类低频信息，不占内容区 */
export default function StatusBar({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <footer className={styles.bar}>
      <span className={styles.left}>{left}</span>
      {right && <span className={styles.right}>{right}</span>}
    </footer>
  );
}
