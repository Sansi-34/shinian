import type { CSSProperties } from 'react';
import styles from './Pill.module.css';

/** 状态语义：只有这 5 种，颜色全部来自 tokens.css */
export type StatusKind = 'active' | 'done' | 'partial' | 'fail' | 'idle';

const CLASS: Record<StatusKind, string> = {
  active: styles.active,
  done: styles.done,
  partial: styles.partial,
  fail: styles.fail,
  idle: styles.idle,
};

export default function Pill({
  kind,
  children,
  style,
}: {
  kind: StatusKind;
  children: React.ReactNode;
  style?: CSSProperties;
}) {
  return (
    <span className={`${styles.pill} ${CLASS[kind]}`} style={style}>
      {children}
    </span>
  );
}
