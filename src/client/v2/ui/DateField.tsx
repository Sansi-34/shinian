// V2 日期时间控件：不用浏览器原生 datetime-local（样式不可控、暗色下发黑）
// 结构：日期按钮（打开自绘月历）+ HH:mm 文本输入 + 现在/清空
import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './DateField.module.css';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function splitValue(value: string): { date: string; time: string } {
  if (!value) return { date: '', time: '' };
  return { date: value.slice(0, 10), time: value.slice(11, 16) };
}

function todayKeyOf(tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

function nowTimeOf(tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${g('hour')}:${g('minute')}`;
}

export default function DateField({
  value,
  onChange,
  timezone,
  label = '发生时间',
}: {
  value: string;
  onChange: (next: string) => void;
  timezone: string;
  label?: string;
}) {
  const { date, time } = splitValue(value);
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => (date || todayKeyOf(timezone)).slice(0, 7));
  const [timeDraft, setTimeDraft] = useState(time);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTimeDraft(time);
  }, [time]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const grid = useMemo(() => {
    const [y, m] = viewMonth.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const startWeekday = first.getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells: Array<{ key: string; day: number } | null> = [];
    for (let i = 0; i < startWeekday; i += 1) cells.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) cells.push({ key: `${y}-${pad(m)}-${pad(d)}`, day: d });
    return cells;
  }, [viewMonth]);

  const today = todayKeyOf(timezone);

  function pickDate(dk: string) {
    onChange(`${dk}T${timeDraft || nowTimeOf(timezone)}`);
    setOpen(false);
  }

  function commitTime(next: string) {
    setTimeDraft(next);
    if (/^\d{2}:\d{2}$/.test(next)) {
      const base = date || today;
      onChange(`${base}T${next}`);
    }
  }

  return (
    <div className={styles.field} ref={wrapRef}>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.dateBtn}
          onClick={() => {
            setViewMonth((date || today).slice(0, 7));
            setOpen((v) => !v);
          }}
          aria-expanded={open}
          aria-label={label + '：选择日期'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M8 3v4M16 3v4M3 10h18" />
          </svg>
          <span className={date ? styles.dateValue : styles.dateEmpty}>{date || '未设置日期'}</span>
        </button>

        <input
          className={styles.timeInput}
          value={timeDraft}
          onChange={(e) => setTimeDraft(e.target.value)}
          onBlur={() => commitTime(timeDraft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitTime(timeDraft);
          }}
          placeholder="HH:mm"
          inputMode="numeric"
          aria-label={label + '：时间'}
        />

        <button type="button" className={styles.quick} onClick={() => onChange(`${today}T${nowTimeOf(timezone)}`)}>
          现在
        </button>
        {value && (
          <button type="button" className={styles.quick} onClick={() => onChange('')}>
            清空
          </button>
        )}
      </div>

      {open && (
        <div className={styles.pop} role="dialog" aria-label="选择日期">
          <div className={styles.popHead}>
            <button type="button" className={styles.navBtn} onClick={() => setViewMonth((v) => shiftMonth(v, -1))} aria-label="上个月">
              ‹
            </button>
            <span className={styles.popTitle}>{viewMonth.replace('-', ' 年 ') + ' 月'}</span>
            <button type="button" className={styles.navBtn} onClick={() => setViewMonth((v) => shiftMonth(v, 1))} aria-label="下个月">
              ›
            </button>
          </div>
          <div className={styles.week}>
            {WEEK.map((w) => (
              <span key={w} className={styles.weekCell}>
                {w}
              </span>
            ))}
          </div>
          <div className={styles.grid}>
            {grid.map((cell, i) =>
              cell ? (
                <button
                  key={cell.key}
                  type="button"
                  className={`${styles.day}${cell.key === date ? ' ' + styles.dayActive : ''}${cell.key === today ? ' ' + styles.dayToday : ''}`}
                  onClick={() => pickDate(cell.key)}
                >
                  {cell.day}
                </button>
              ) : (
                <span key={'e' + i} />
              )
            )}
          </div>
          <div className={styles.popFoot}>
            <button type="button" className={styles.quick} onClick={() => pickDate(today)}>
              今天
            </button>
            <button type="button" className={styles.quick} onClick={() => setOpen(false)}>
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}
