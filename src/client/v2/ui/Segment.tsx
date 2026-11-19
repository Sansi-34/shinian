// 分段控件（选中块滑动）
// 灵感来自 UI Moments 的「对齐拨片」(alignment-switch) 与「蠕动分页点」(worm-dots)，MIT；
// 这里用 transform 移动一块指示底，切换时从当前位置接续滑过去，不跳变。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import styles from './Segment.module.css';

export type SegmentItem<T extends string> = { value: T; label: ReactNode };

export default function Segment<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: Array<SegmentItem<T>>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ left: 0, width: 0 });

  const measure = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const idx = Math.max(0, items.findIndex((i) => i.value === value));
    const el = wrap.querySelectorAll('button')[idx] as HTMLElement | undefined;
    if (!el) return;
    setBox({ left: el.offsetLeft, width: el.offsetWidth });
  };

  useLayoutEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, items.length]);

  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, items.length]);

  return (
    <div className={styles.seg} role="group" aria-label={ariaLabel} ref={wrapRef}>
      <span className={styles.indicator} style={{ transform: `translateX(${box.left}px)`, width: box.width }} aria-hidden="true" />
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          className={styles.item}
          aria-pressed={item.value === value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
