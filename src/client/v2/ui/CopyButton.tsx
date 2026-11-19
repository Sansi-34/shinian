// 复制按钮（图标描成对勾、文字换成「已复制」）
// 灵感来自 UI Moments 原创作品「复制按钮」(copy-morph, MIT)。
import { useEffect, useRef, useState } from 'react';
import styles from './CopyButton.module.css';

export default function CopyButton({
  text,
  label = '复制',
  doneLabel = '已复制',
}: {
  text: string;
  label?: string;
  doneLabel?: string;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板不可用（非 https / 无权限）时退回到选中文本
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setDone(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1600);
  }

  return (
    <button type="button" className={`${styles.btn}${done ? ' ' + styles.done : ''}`} onClick={() => void copy()}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        {done ? (
          <path d="m5 13 4.5 4.5L19 7" />
        ) : (
          <>
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M15 5H6a2 2 0 0 0-2 2v9" />
          </>
        )}
      </svg>
      <span className={styles.label}>{done ? doneLabel : label}</span>
    </button>
  );
}
