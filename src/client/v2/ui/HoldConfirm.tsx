// 长按确认按钮（危险操作）
// 灵感来自 UI Moments 原创作品「长按确认」(hold-confirm, MIT)：按住填满才执行，中途松手快速退回。
// 键盘同样支持：按住空格/回车触发，松开取消。轻点会提示「按住不放」。
import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './HoldConfirm.module.css';

const HOLD_MS = 650;
const TICK = 30;

export default function HoldConfirm({
  label,
  holdingLabel = '继续按住…',
  onConfirm,
  disabled,
}: {
  label: string;
  holdingLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [progress, setProgress] = useState(0);
  const [hint, setHint] = useState(false);
  const timer = useRef<number | null>(null);
  const done = useRef(false);

  const stop = useCallback((reset = true) => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
    if (reset) setProgress(0);
  }, []);

  const start = useCallback(() => {
    if (disabled || timer.current !== null) return;
    done.current = false;
    setHint(false);
    const begun = performance.now();
    timer.current = window.setInterval(() => {
      const k = Math.min(1, (performance.now() - begun) / HOLD_MS);
      setProgress(k);
      if (k >= 1) {
        stop(false);
        if (!done.current) {
          done.current = true;
          onConfirm();
        }
      }
    }, TICK);
  }, [disabled, onConfirm, stop]);

  useEffect(() => () => stop(false), [stop]);

  const holding = progress > 0;

  return (
    <button
      type="button"
      className={`${styles.btn}${holding ? ' ' + styles.holding : ''}`}
      style={{ ['--p' as string]: String(progress) }}
      disabled={disabled}
      onPointerDown={(e) => {
        e.preventDefault();
        start();
      }}
      onPointerUp={() => {
        if (!done.current) {
          stop();
          if (progress < 0.2) setHint(true);
        }
      }}
      onPointerLeave={() => {
        if (!done.current) stop();
      }}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') stop();
      }}
      onBlur={() => stop()}
      aria-label={label}
    >
      <span className={styles.fill} aria-hidden="true" />
      <span className={styles.text}>{holding ? holdingLabel : label}</span>
      {hint && <span className={styles.hint}>按住不放才会执行</span>}
    </button>
  );
}
