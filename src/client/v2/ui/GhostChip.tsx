import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import styles from './GhostChip.module.css';

/**
 * 隐藏模块或低打扰入口：
 * 传 `to` 渲染成真正的导航链接（前缀用 `→`，不再误导成「新建 +」），
 * 传 `onClick` 渲染成动作按钮（默认前缀 `+`）。
 */
export default function GhostChip({
  children,
  count,
  onClick,
  to,
  glyph,
}: {
  children: ReactNode;
  count?: number | string;
  onClick?: () => void;
  to?: string;
  glyph?: string;
}) {
  const lead = glyph ?? (to ? '→' : '+');
  const inner = (
    <>
      {lead && (
        <span className={styles.plus} aria-hidden="true">
          {lead}
        </span>
      )}
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
