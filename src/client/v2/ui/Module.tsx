import { useId, useRef, useState, type ReactNode } from 'react';
import styles from './Module.module.css';

/**
 * 可折叠模块：高度用 grid-template-rows 0fr→1fr 过渡（不用 max-height），
 * 折叠后内容 inert，不参与 Tab 焦点。
 */
export default function Module({
  title,
  count,
  action,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number | string;
  action?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const innerRef = useRef<HTMLDivElement>(null);

  return (
    <section className={styles.module}>
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (innerRef.current) innerRef.current.inert = !next;
        }}
      >
        <h2 className={styles.title}>{title}</h2>
        {count !== undefined && <span className={styles.count}>{count}</span>}
        {action && <span className={styles.action}>{action}</span>}
        <svg
          className={styles.chev}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>
      <div
        id={id}
        className={styles.collapse}
        data-collapsed={open ? undefined : ''}
        aria-hidden={!open}
      >
        <div ref={innerRef} inert={!open}>
          {children}
        </div>
      </div>
    </section>
  );
}
