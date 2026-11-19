import type { ReactNode } from 'react';
import styles from './GhostChip.module.css';

/** 隐藏模块降级成一颗可发现的按钮：功能不消失，默认视野干净 */
export default function GhostChip({
  children,
  count,
  onClick,
}: {
  children: ReactNode;
  count?: number | string;
  onClick?: () => void;
}) {
  return (
    <button type="button" className={styles.chip} onClick={onClick}>
      <span className={styles.plus} aria-hidden="true">
        +
      </span>
      {children}
      {count !== undefined && <span className={styles.count}>{count}</span>}
    </button>
  );
}
