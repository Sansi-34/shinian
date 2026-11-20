import { useId, useState, type ReactNode } from 'react';
import styles from './Module.module.css';

/**
 * 可折叠模块：高度用 grid-template-rows 0fr→1fr 过渡（不用 max-height），
 * 折叠后内容 inert，不参与 Tab 焦点。
 * action 与折叠箭头按钮均为折叠主按钮的兄弟节点，绝不嵌套交互元素。
 */
export default function Module({
  title,
  count,
  action,
  defaultOpen = true,
  children,
}: {
  title: ReactNode;
  count?: number | string;
  action?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <section className={styles.module}>
      <div className={styles.head}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
        >
          <h2 className={styles.title}>{title}</h2>
          {count !== undefined && <span className={styles.count}>{count}</span>}
        </button>
        {action && <div className={styles.action}>{action}</div>}
        <button
          type="button"
          className={styles.chevBtn}
          aria-hidden="true"
          tabIndex={-1}
          data-open={open ? 'true' : 'false'}
          onClick={() => setOpen((v) => !v)}
        >
          <svg
            className={styles.chev}
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
      </div>
      <div
        id={id}
        className={styles.collapse}
        data-collapsed={open ? undefined : ''}
        aria-hidden={!open}
      >
        <div inert={!open}>{children}</div>
      </div>
    </section>
  );
}
