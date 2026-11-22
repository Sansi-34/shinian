// 周期回顾 · 近 12 个月全年格子热力图：念头日程表
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ReviewDailyDay, ReviewDailyResponse } from '../types';
import { useCalendarColor } from '../v2/preferences';
import styles from './ReviewInsights.module.css';

type CellSlot =
  | { kind: 'day'; day: ReviewDailyDay }
  | { kind: 'future'; date: string }
  | null;

type WeekColumn = {
  colIndex: number;
  cells: CellSlot[];
  monthLabel: string | null;
};

type CellTone =
  | { kind: 'idle' }
  | { kind: 'blue' }
  | { kind: 'red' }
  | { kind: 'custom'; color: string };

type LegendItem = {
  label: string;
  tone: CellTone;
};

function weekdayMondayFirst(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (utcDay + 6) % 7; // 0 = 周一 .. 6 = 周日
}

function addDateKeyDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** 按自然周（周一为行首，周日为行尾）切分为 53 列完整矩形网格，并在首周含 1 号的列标出月份 */
function buildYearWeeks(days: ReviewDailyDay[]): WeekColumn[] {
  if (days.length === 0) return [];
  const lead = weekdayMondayFirst(days[0].date);
  const flat: CellSlot[] = [
    ...Array.from({ length: lead }, () => null),
    ...days.map((day): CellSlot => ({ kind: 'day', day })),
  ];
  let extra = 1;
  const lastDate = days[days.length - 1].date;
  while (flat.length % 7 !== 0) {
    flat.push({ kind: 'future', date: addDateKeyDays(lastDate, extra++) });
  }

  const slotDate = (s: CellSlot) => (s ? (s.kind === 'day' ? s.day.date : s.date) : null);

  const columns: WeekColumn[] = [];
  let lastLabeledCol = -10;
  for (let i = 0; i < flat.length; i += 7) {
    const colIndex = i / 7;
    const cells = flat.slice(i, i + 7);
    const firstOfMonth = cells.find((c) => slotDate(c)?.endsWith('-01'));
    let monthLabel: string | null = null;
    const matchedDate = slotDate(firstOfMonth ?? null);
    if (matchedDate && colIndex - lastLabeledCol >= 3) {
      // 最左若第 0 列是旧月残余且紧邻 12 月，跳过第 0 列避免两个月份标签贴太近
      const nextHasFirst =
        colIndex === 0 && flat.slice(7, 21).some((c) => slotDate(c)?.endsWith('-01'));
      if (!nextHasFirst) {
        monthLabel = `${Number(matchedDate.slice(5, 7))}月`;
        lastLabeledCol = colIndex;
      }
    }
    columns.push({ colIndex, cells, monthLabel });
  }
  return columns;
}

function sampleClassForTone(tone: CellTone): string {
  if (tone.kind === 'blue') return styles.cellBlue;
  if (tone.kind === 'red') return styles.cellRed;
  if (tone.kind === 'custom') return styles.cellLit;
  return styles.cellIdle;
}

function customStyleForTone(tone: CellTone): CSSProperties | undefined {
  if (tone.kind !== 'custom') return undefined;
  return {
    backgroundColor: tone.color,
    borderColor: tone.color,
    boxShadow: `0 0 8px ${tone.color}55`,
  };
}

function YearLatticeCard({
  title,
  subtitle,
  ariaLabel,
  badge,
  badgeWarn = false,
  legend,
  actionLink,
  weeks,
  today,
  selectedDate,
  onSelectDate,
  getCellTone,
  getCellTitle,
  getCellAriaLabel,
  detailNode,
  footLeft,
  footRight,
}: {
  title: string;
  subtitle: string;
  ariaLabel: string;
  badge: string;
  badgeWarn?: boolean;
  legend: LegendItem[];
  actionLink: { to: string; label: string };
  weeks: WeekColumn[];
  today: string;
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
  getCellTone: (day: ReviewDailyDay) => CellTone;
  getCellTitle: (day: ReviewDailyDay) => string;
  getCellAriaLabel: (day: ReviewDailyDay) => string;
  detailNode: ReactNode | null;
  footLeft: string;
  footRight: string;
}) {
  const colCount = Math.max(weeks.length, 1);
  const gridTemplate = { '--cols': colCount } as CSSProperties;

  return (
    <div className={styles.card} aria-label={ariaLabel}>
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>{title}</h2>
          <span className={styles.subtitle}>{subtitle}</span>
        </div>

        <div className={styles.headRight}>
          <div className={styles.legend}>
            {legend.map((item) => (
              <span key={item.label} className={styles.legendItem}>
                <span
                  className={`${styles.legendSwatch} ${sampleClassForTone(item.tone)}`}
                  style={customStyleForTone(item.tone)}
                  aria-hidden="true"
                />
                {item.label}
              </span>
            ))}
          </div>
          <span className={`${styles.statPill}${badgeWarn ? ' ' + styles.statPillWarn : ''}`}>
            {badge}
          </span>
          <Link to={actionLink.to} className={styles.settingLink}>
            {actionLink.label}
          </Link>
        </div>
      </div>

      <div className={styles.latticeScroll}>
        <div className={styles.latticeInner} style={gridTemplate}>
          <div className={styles.weeksGrid} role="grid" aria-label={`${title}近12个月网格`}>
            {weeks.map((week) => (
              <div
                key={week.colIndex}
                className={styles.weekCol}
                style={{ '--col': week.colIndex } as CSSProperties}
                role="row"
              >
                {week.cells.map((slot, rowIdx) => {
                  if (!slot) {
                    return (
                      <span
                        key={`blank-${week.colIndex}-${rowIdx}`}
                        className={styles.cellBlank}
                        aria-hidden="true"
                      />
                    );
                  }
                  if (slot.kind === 'future') {
                    return (
                      <span
                        key={slot.date}
                        className={`${styles.cell} ${styles.cellIdle} ${styles.cellFuture}`}
                        title={`${slot.date}（尚未到来）`}
                        aria-hidden="true"
                      />
                    );
                  }
                  const day = slot.day;
                  const tone = getCellTone(day);
                  const isToday = day.date === today;
                  const isSelected = selectedDate === day.date;
                  return (
                    <button
                      key={day.date}
                      type="button"
                      className={[
                        styles.cell,
                        sampleClassForTone(tone),
                        isToday ? styles.cellToday : '',
                        isSelected ? styles.cellSelected : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={customStyleForTone(tone)}
                      title={getCellTitle(day)}
                      aria-label={getCellAriaLabel(day)}
                      aria-pressed={isSelected}
                      onClick={() => onSelectDate(isSelected ? null : day.date)}
                    />
                  );
                })}
              </div>
            ))}
          </div>

          <div className={styles.monthsRow} aria-hidden="true">
            {weeks.map(
              (week) =>
                week.monthLabel && (
                  <span
                    key={`m-${week.colIndex}`}
                    className={styles.monthLabel}
                    style={{ gridColumn: week.colIndex + 1 }}
                  >
                    {week.monthLabel}
                  </span>
                )
            )}
          </div>
        </div>
      </div>

      {detailNode ?? (
        <div className={styles.footBar}>
          <span>{footLeft}</span>
          <span>{footRight}</span>
        </div>
      )}
    </div>
  );
}

export default function ReviewInsightsPanel({
  daily,
  loading,
  error,
  onRetry,
}: {
  daily: ReviewDailyResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const [calendarColor] = useCalendarColor();
  const [selectedCalDay, setSelectedCalDay] = useState<string | null>(null);

  const weeks = useMemo(() => buildYearWeeks(daily?.days ?? []), [daily]);

  const dayMap = useMemo(() => {
    const map = new Map<string, ReviewDailyDay>();
    for (const d of daily?.days ?? []) map.set(d.date, d);
    return map;
  }, [daily]);

  const totals = useMemo(() => {
    const list = daily?.days ?? [];
    let captureDays = 0;
    let totalCaptures = 0;
    for (const d of list) {
      if (d.capturesCount > 0) {
        captureDays += 1;
        totalCaptures += d.capturesCount;
      }
    }
    return { captureDays, totalCaptures, totalDays: list.length };
  }, [daily]);

  if (loading && !daily) {
    return (
      <section className={styles.stack} aria-label="近 12 个月念头日程">
        <div className={styles.card}>
          <p className={styles.subtitle}>正在汇总近 12 个月念头日程…</p>
        </div>
      </section>
    );
  }

  if (error && !daily) {
    return (
      <section className={styles.stack} aria-label="近 12 个月念头日程">
        <div className={styles.card} role="alert">
          <p className="error-msg">{error}</p>
          <button type="button" className="btn small" onClick={onRetry}>
            重试
          </button>
        </div>
      </section>
    );
  }

  if (!daily) return null;

  const activeCalDetail = selectedCalDay ? dayMap.get(selectedCalDay) ?? null : null;

  return (
    <section className={styles.stack} aria-label="念头日程表">
      <YearLatticeCard
        title="念头日程表"
        subtitle="近 12 个月"
        ariaLabel="念头日程表"
        badge={`有念头 ${totals.captureDays} / ${totals.totalDays} 天`}
        legend={[
          { label: '没念头', tone: { kind: 'idle' } },
          { label: '有念头', tone: { kind: 'custom', color: calendarColor } },
        ]}
        actionLink={{ to: '/settings/ai#calendar-color', label: '自定义颜色 →' }}
        weeks={weeks}
        today={daily.today}
        selectedDate={selectedCalDay}
        onSelectDate={setSelectedCalDay}
        getCellTone={(day) =>
          day.capturesCount > 0 ? { kind: 'custom', color: calendarColor } : { kind: 'idle' }
        }
        getCellTitle={(day) => {
          const todayTag = day.date === daily.today ? '（今天）' : '';
          return `${day.date}${todayTag} · ${
            day.capturesCount > 0 ? `记下 ${day.capturesCount} 条念头` : '无念头'
          }${day.attemptsCount > 0 ? ` · ${day.attemptsCount} 次尝试` : ''}`;
        }}
        getCellAriaLabel={(day) =>
          `${day.date} ${day.capturesCount > 0 ? `记下 ${day.capturesCount} 条念头` : '没有念头'}`
        }
        detailNode={
          activeCalDetail && (
            <div className={styles.daySummary}>
              <span>
                <strong>
                  {activeCalDetail.date}
                  {activeCalDetail.date === daily.today ? '（今天）' : ''}
                </strong>
                ：
                {activeCalDetail.capturesCount > 0
                  ? `记下 ${activeCalDetail.capturesCount} 条念头`
                  : '这天没有记录新念头'}
                {activeCalDetail.attemptsCount > 0
                  ? ` · ${activeCalDetail.attemptsCount} 次尝试`
                  : ''}
                {activeCalDetail.aiCount > 0 ? ` · ${activeCalDetail.aiCount} 次 AI 调用` : ''}
              </span>
              <button
                type="button"
                className={styles.textBtn}
                onClick={() => setSelectedCalDay(null)}
              >
                收起
              </button>
            </div>
          )
        }
        footLeft={`当前点亮色：${calendarColor.toUpperCase()} · 近一年共记下 ${totals.totalCaptures} 条念头`}
        footRight="点击任意方块查看单日记录"
      />
    </section>
  );
}
