import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import styles from './GhostChip.module.css';

/**
 * 隐藏模块降级成一颗可发现的入口：功能不消失，默认视野干净。
 * 传 `to` 渲染成真正的链接（原来的 onClick={() => undefined} 造出了点不动的假按钮），
 * 传 `onClick` 渲染成按钮。
 */
export default function GhostChip({
  children,
  count,
  onClick,
  to,
}: {
  children: ReactNode;
  count?: number | string;
  onClick?: () => void;
  to?: string;
}) {
  const inner = (
    <>
      <span className={styles.plus} aria-hidden="true">
        +
      </span>
      {children}
      {count !== undefined && <span className={styles.count}>{count}</span>}
    </>
  );

  if (to) {
    return (
      <Link to={to} className={styles.chip}>
        {inner}
      </Link>
    );
  }

  return (
    <button type="button" className={styles.chip} onClick={onClick}>
      {inner}
    </button>
  );
}
