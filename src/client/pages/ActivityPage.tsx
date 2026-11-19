// 拾念 SHINIAN - 事件展示栏：把念头、尝试、结果、引用和 AI 动态排成时间线
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import type {
  ActivityEvent,
  ActivityEventType,
  ActivityResponse,
  ActivityStats,
} from '../types';
import { ACTIVITY_TYPE_LABEL, OUTCOME_LABEL } from '../types';

const FILTER_TYPES: Array<'all' | ActivityEventType> = [
  'all',
  'capture',
  'attempt',
  'result',
  'reference',
  'ai',
];

const KIND_LABEL: Record<string, string> = {
  executable: '可执行',
  defer: '先记着',
  clarify: '需要补充',
};

const EMPTY_STATS: ActivityStats = {
  totalEvents: 0,
  last7Days: 0,
  captures: 0,
  attempts: 0,
  results: 0,
  references: 0,
  aiRequests: 0,
  aiAdopted: 0,
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

/** 数字变化时做一次短促的 count-up；减少动态效果时直接显示。 */
function AnimatedNumber({ value, reduced }: { value: number; reduced: boolean }) {
  const [display, setDisplay] = useState(0);
  const previous = useRef(0);

  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      previous.current = value;
      return;
    }
    const from = previous.current;
    const to = value;
    if (from === to) {
      setDisplay(to);
      return;
    }
    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / 480);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
      else previous.current = to;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, reduced]);

  return <>{display}</>;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function dateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayLabel(key: string): string {
  const today = dateKey(Date.now());
  const yesterday = dateKey(Date.now() - 24 * 60 * 60 * 1000);
  if (key === today) return '今天';
  if (key === yesterday) return '昨天';
  const [y, m, d] = key.split('-').map(Number);
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][
    new Date(y, (m ?? 1) - 1, d ?? 1).getDay()
  ];
  return `${m} 月 ${d} 日 · ${weekday}`;
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fullTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(ts)}`;
}

function groupByDay(events: ActivityEvent[]): Array<{ key: string; events: ActivityEvent[] }> {
  const groups: Array<{ key: string; events: ActivityEvent[] }> = [];
  for (const event of events) {
    const key = dateKey(event.at);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.events.push(event);
    else groups.push({ key, events: [event] });
  }
  return groups;
}

export default function ActivityPage() {
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [filter, setFilter] = useState<'all' | ActivityEventType>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [showBackTop, setShowBackTop] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listActivity({ limit: 200 });
      setData(res);
    } catch (e: any) {
      setError(e?.message || '加载动态失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const update = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      setScrollProgress(max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0);
      setShowBackTop(window.scrollY > 420);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [data]);

  const stats = data?.stats ?? EMPTY_STATS;
  const events = useMemo(() => {
    if (!data) return [];
    return filter === 'all' ? data.events : data.events.filter((event) => event.type === filter);
  }, [data, filter]);
  const grouped = useMemo(() => groupByDay(events), [events]);
  const eventIndexById = useMemo(
    () => new Map(events.map((event, index) => [event.id, index])),
    [events]
  );
  const timelineKey = `${filter}-${data?.generatedAt ?? 0}`;

  const filterCount = (type: 'all' | ActivityEventType): number =>
    data?.filters.find((item) => item.type === type)?.count ?? 0;

  return (
    <div className="page activity-page">
      <div className="activity-progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${scrollProgress})` }} />
      </div>

      <div className="crumb">
        <Link to="/">← 返回列表</Link>
      </div>

      <header className="activity-head">
        <div>
          <p className="page-kicker">展示栏</p>
          <h1 className="page-title">最近动态</h1>
          <p className="page-subtitle">
            念头、尝试、结果、引用和 AI 建议，按发生时间排在一起。
          </p>
        </div>
        <button type="button" className="btn small activity-refresh" onClick={load} disabled={loading}>
          <span className={loading ? 'refresh-icon spinning' : 'refresh-icon'} aria-hidden="true">↻</span>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </header>

      <section className="activity-stats" aria-label="动态统计">
        <div className="stat-card">
          <span className="stat-label">全部动态</span>
          <strong><AnimatedNumber value={stats.totalEvents} reduced={reducedMotion} /></strong>
          <span className="stat-hint">条事件</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">最近 7 天</span>
          <strong><AnimatedNumber value={stats.last7Days} reduced={reducedMotion} /></strong>
          <span className="stat-hint">条事件</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">尝试</span>
          <strong><AnimatedNumber value={stats.attempts} reduced={reducedMotion} /></strong>
          <span className="stat-hint">{stats.results} 条结果</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">AI 采用</span>
          <strong><AnimatedNumber value={stats.aiAdopted} reduced={reducedMotion} /></strong>
          <span className="stat-hint">{stats.aiRequests} 条 AI 动态</span>
        </div>
      </section>

      <nav className="activity-filters" aria-label="动态筛选">
        {FILTER_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            className={filter === type ? 'filter-chip active' : 'filter-chip'}
            aria-pressed={filter === type}
            onClick={() => setFilter(type)}
          >
            {type === 'all' ? '全部' : ACTIVITY_TYPE_LABEL[type]}
            <span className="filter-count">{filterCount(type)}</span>
          </button>
        ))}
      </nav>

      {loading && !data ? (
        <div className="activity-skeleton" role="status" aria-label="正在整理动态">
          {[0, 1, 2].map((item) => (
            <div className="skeleton-card" key={item}>
              <span className="skeleton-line skeleton-line-short" />
              <span className="skeleton-line skeleton-line-title" />
              <span className="skeleton-line" />
            </div>
          ))}
          <span className="sr-only">正在整理动态…</span>
        </div>
      ) : error ? (
        <div className="empty-state activity-error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn small" onClick={load}>重试</button>
        </div>
      ) : events.length === 0 ? (
        <div className="empty-state">
          {filter === 'all' ? (
            <>
              <p>还没有动态。先记下一个念头，之后发生的事会出现在这里。</p>
              <p className="muted">念头、尝试、结果和引用都会按发生时间自动排进这条时间线。</p>
              <div className="row-actions">
                <Link className="btn small" to="/">
                  去首页记下一个念头
                </Link>
              </div>
            </>
          ) : (
            <>
              <p>还没有「{ACTIVITY_TYPE_LABEL[filter]}」这类动态。</p>
              <p className="muted">
                当前只显示这一种事件；其他事件可能已经发生。
              </p>
              <div className="row-actions">
                <button type="button" className="btn small" onClick={() => setFilter('all')}>
                  查看全部动态
                </button>
                <Link className="btn small" to="/">
                  去首页记下一个念头
                </Link>
              </div>
            </>
          )}
        </div>
      ) : (
        <ol className="activity-timeline" aria-label="动态时间线" key={timelineKey}>
          {grouped.map((group) => (
            <li className="activity-day" key={group.key}>
              <h2 className="activity-day-title">{dayLabel(group.key)}</h2>
              <ol className="activity-day-list">
                {group.events.map((event) => {
                  const index = eventIndexById.get(event.id) ?? 0;
                  const isLatest = index === 0 && Date.now() - event.at < 10 * 60 * 1000;
                  return (
                    <li
                      className={isLatest ? 'activity-event-item is-latest' : 'activity-event-item'}
                      key={event.id}
                      style={{ '--event-index': index } as CSSProperties}
                    >
                      <article className={`activity-event type-${event.type}`}>
                        <span className={`activity-dot type-${event.type}`} aria-hidden="true" />
                        <div className="activity-event-body">
                          <div className="activity-event-top">
                            <span className={`activity-badge type-${event.type}`}>
                              {ACTIVITY_TYPE_LABEL[event.type]}
                            </span>
                            <span className="activity-time-wrap">
                              {isLatest && (
                                <span className="activity-live" title="十分钟内发生">
                                  <span className="live-dot" aria-hidden="true" />
                                  刚刚
                                </span>
                              )}
                              <time dateTime={new Date(event.at).toISOString()} title={fullTime(event.at)}>
                                {clock(event.at)}
                              </time>
                            </span>
                          </div>
                          <h3>{event.title}</h3>
                          <p className="activity-text">{event.text}</p>
                          {(event.detail || event.outcome || event.kind) && (
                            <div className="activity-meta">
                              {/* 有 outcome 徽章时不再重复 detail（原来「结果：成功」后面又跟一枚「成功」徽章） */}
                              {event.detail && !event.outcome && <span className="activity-detail">{event.detail}</span>}
                              {event.outcome && (
                                <span className={`badge outcome-${event.outcome}`}>
                                  {OUTCOME_LABEL[event.outcome]}
                                </span>
                              )}
                              {event.kind && (
                                <span className="badge ai-kind">{KIND_LABEL[event.kind] ?? event.kind}</span>
                              )}
                            </div>
                          )}
                          <div className="activity-links">
                            {event.attemptId ? (
                              <Link to={`/attempt/${event.attemptId}`}>打开尝试 →</Link>
                            ) : (
                              <Link to={`/capture/${event.captureId}`}>打开念头 →</Link>
                            )}
                            {event.attemptId && event.captureId && (
                              <Link to={`/capture/${event.captureId}`} className="muted activity-capture-link">
                                所属念头
                              </Link>
                            )}
                          </div>
                        </div>
                      </article>
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ol>
      )}

      {data && data.total > data.events.length && (
        <p className="hint activity-limit-hint">
          显示最近 {data.events.length} 条；更早的记录仍保留在念头与尝试中。
        </p>
      )}

      {showBackTop && (
        <button
          type="button"
          className="activity-back-top"
          aria-label="回到顶部"
          title="回到顶部"
          onClick={() => window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' })}
        >
          ↑
        </button>
      )}
    </div>
  );
}
