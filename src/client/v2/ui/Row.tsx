import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import styles from './Row.module.css';

/**
 * 行式记录：一条一行，靠发丝线分组。不用卡片。
 * 有 to 时整行是链接（键盘可聚焦），否则是普通行。
 */
export default function Row({
  time,
  title,
  sub,
  side,
  to,
  index = 0,
}: {
  time: string;
  title: ReactNode;
  sub?: ReactNode;
  side?: ReactNode;
  to?: string;
  index?: number;
}) {
  const content = (
    <>
      <span className={styles.time}>{time}</span>
      <span className={styles.main}>
        {/* 标题单独包一层再裁行数：直接裁 .main 会把同一格里的 sub 一起裁掉 */}
        <span className={styles.titleText}>{title}</span>
        {sub && <span className={styles.sub}>{sub}</span>}
      </span>
      {side !== undefined && <span className={styles.side}>{side}</span>}
    </>
  );

  const style = { '--i': index } as React.CSSProperties;

  return to ? (
    <Link className={styles.row} to={to} style={style}>
      {content}
    </Link>
  ) : (
    <div className={styles.row} style={style}>
      {content}
    </div>
  );
}
