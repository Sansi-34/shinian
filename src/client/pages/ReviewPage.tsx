// 拾念 SHINIAN · 阶段回顾：范围、实际记录、AI 确认发送与保存
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type {
  Capture,
  NextAction,
  ReviewContent,
  ReviewDailyResponse,
  ReviewItem,
  ReviewListItem,
  ReviewPreset,
  ReviewPreviewResponse,
  ReviewPublic,
  ReviewRangeInput,
  ReviewRangeResponse,
  ReviewRecord,
  ReviewSource,
  ReviewStatDefinition,
  ReviewStats,
} from '../types';
import {
  aiErrorText,
  formatTime,
  newOperationId,
  OUTCOME_LABEL,
  REVIEW_BASIS_LABEL,
  REVIEW_PRESET_LABEL,
  REVIEW_RECORD_TYPE_LABEL,
  REVIEW_REASON_LABEL,
  REVIEW_STATUS_LABEL,
  STATE_LABEL,
} from '../types';
import api, { ApiError } from '../api';
import NextActionEditor from '../components/NextActionEditor';
import ReviewInsightsPanel from './ReviewInsightsPanel';

// ===== 通用工具 =====

const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function dateInputValue(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDateInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d.getTime();
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 按本地日历加天数（走 Date.setDate，跨夏令时也落在当天 00:00） */
function addLocalDays(ts: number, days: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function resolvedTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

function presetRangeInput(preset: '7d' | '30d'): ReviewRangeInput {
  const today = startOfLocalDay(Date.now());
  const days = preset === '7d' ? 7 : 30;
  return {
    from: addLocalDays(today, -(days - 1)),
    to: addLocalDays(today, 1),
    timezone: resolvedTimezone(),
    preset,
  };
}

/** 固定近 12 个月（从 52 周前的周一起到今天，共 53 列完整热力图范围） */
function annualDailyRangeInput(): ReviewRangeInput {
  const today = startOfLocalDay(Date.now());
  const d = new Date(today);
  const mondayOffset = (d.getDay() + 6) % 7;
  const startMonday = addLocalDays(today, -(mondayOffset + 52 * 7));
  return {
    from: startMonday,
    to: addLocalDays(today, 1),
    timezone: resolvedTimezone(),
    preset: 'custom',
  };
}

function customRangeInput(
  startValue: string,
  endValue: string
): { range: ReviewRangeInput } | { error: string } {
  const start = parseDateInput(startValue);
  const end = parseDateInput(endValue);
  if (start === null || end === null) return { error: '请选择完整的起始日和结束日。' };
  if (end < start) return { error: '结束日不能早于起始日。' };
  const dayCount = Math.round((end - start) / DAY_MS) + 1;
  if (dayCount > 366) return { error: '一次最多回顾 366 天，请缩小范围。' };
  return {
    range: {
      from: start,
      // 结束日次日 00:00，右边界不含
      to: addLocalDays(end, 1),
      timezone: resolvedTimezone(),
      preset: 'custom',
    },
  };
}

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    return e.body?.message || aiErrorText(e.body?.error, fallback);
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ===== 统计卡（供列表页与详情页共用） =====

const STAT_ORDER = [
  'capturesCreated',
  'capturesModified',
  'attemptsStarted',
  'attemptsModified',
  'attemptsCurrentlyEnded',
  'resultsRecorded',
  'resultsMissingObservedAt',
  'referencesCreated',
  'totalRecords',
] as const;

type StatKey = (typeof STAT_ORDER)[number];

/** 服务端未提供 definition 时的兜底口径（与契约 §2.2 一致） */
const STAT_FALLBACK: Record<StatKey, { label: string; definition: string }> = {
  capturesCreated: { label: '记录的念头', definition: '念头创建时间落在范围内（含已归档）' },
  capturesModified: {
    label: '修改的旧念头',
    definition: '创建于范围之前、最后修改时间落在范围内的念头；仅表示修改，不算新记录',
  },
  attemptsStarted: {
    label: '开始尝试',
    definition: '尝试创建时间落在范围内；只表示开始，不代表已结束',
  },
  attemptsModified: {
    label: '修改的旧尝试',
    definition: '创建于范围之前、最后修改时间落在范围内的尝试；不计入新开始',
  },
  attemptsCurrentlyEnded: {
    label: '当前已结束的尝试',
    definition:
      '当前状态为已结束或已放弃、且最后修改时间落在范围内的尝试；只表示当前状态与最后修改时间，不代表实际结束时间',
  },
  resultsRecorded: {
    label: '写下结果',
    definition: '发生时间落在范围内、且结果文字或评价非空的尝试；编辑旧结果不会改变这个时间',
  },
  resultsMissingObservedAt: {
    label: '结果缺少发生时间',
    definition: '有结果但发生时间为空、且创建或最后修改时间落在范围内的尝试；不计入结果数',
  },
  referencesCreated: { label: '新建引用', definition: '引用创建时间落在范围内' },
  totalRecords: { label: '范围内记录', definition: '范围内不重复的记录条数（念头 / 尝试 / 引用）' },
};

export function ReviewStatsPanel({
  stats,
  definitions,
}: {
  stats: ReviewStats | null;
  definitions?: ReviewStatDefinition[];
}) {
  const [open, setOpen] = useState(false);
  if (!stats) {
    return <p className="hint">这次回顾没有保存统计快照。</p>;
  }
  const defFor = (key: StatKey): ReviewStatDefinition | null =>
    definitions?.find((item) => item.key === key) ?? null;
  const valueFor = (key: StatKey): number => defFor(key)?.value ?? stats[key];
  const labelFor = (key: StatKey): string => defFor(key)?.label ?? STAT_FALLBACK[key].label;

  const cards: StatKey[] = ['capturesCreated', 'attemptsStarted', 'resultsRecorded', 'referencesCreated'];

  return (
    <div className="review-stats-wrap">
      <div className="review-stats" aria-label="阶段统计">
        {cards.map((key) => (
          <div className="stat-card review-stat" key={key}>
            <span className="stat-label">{labelFor(key)}</span>
            <strong>{valueFor(key)}</strong>
            <span className="stat-hint">条</span>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn small review-stats-toggle"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        {open ? '收起统计口径' : '统计口径'}
      </button>
      {open && (
        <ul className="review-stat-defs">
          {STAT_ORDER.map((key) => {
            const serverDef = defFor(key);
            return (
              <li key={key}>
                <div className="review-stat-def-head">
                  <span>{labelFor(key)}</span>
                  <strong>{valueFor(key)}</strong>
                </div>
                <p>{serverDef?.definition ?? STAT_FALLBACK[key].definition}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ===== 来源 chip / 内容区块（列表页与详情页共用） =====

function sourceLink(source: ReviewSource): string | null {
  if (source.type === 'attempt') {
    const id = source.attemptId || source.sourceId;
    return id ? `/attempt/${id}` : null;
  }
  if (source.type === 'capture') {
    const id = source.captureId || source.sourceId;
    return id ? `/capture/${id}` : null;
  }
  const attemptId = source.attemptId || source.relatedAttemptId;
  if (attemptId) return `/attempt/${attemptId}`;
  return source.captureId ? `/capture/${source.captureId}` : null;
}

function SourceChip({ sourceKey, sources }: { sourceKey: string; sources: ReviewSource[] }) {
  const source = sources.find((item) => item.key === sourceKey);
  if (!source) return <span className="review-source missing">来源不可用</span>;
  if (source.deleted || source.exists === false) {
    return <span className="review-source deleted">来源已删除</span>;
  }
  const label = `${REVIEW_RECORD_TYPE_LABEL[source.type] || '记录'} · ${truncate(
    source.title || source.text || source.sourceId,
    18
  )}`;
  const to = sourceLink(source);
  if (!to) return <span className="review-source">{label}</span>;
  return (
    <Link className="review-source" to={to} title={source.title || source.text || source.key}>
      {label}
    </Link>
  );
}

function existingAttemptId(item: ReviewItem, sources: ReviewSource[]): string | null {
  for (const key of item.sourceIds) {
    const source = sources.find((entry) => entry.key === key);
    if (source && source.type === 'attempt' && !source.deleted && source.exists !== false) {
      return source.attemptId || source.sourceId || null;
    }
  }
  return null;
}

/** 从回顾经验跳到一条当前念头，交给念头详情现有的预览确认流程 */
export function ReviewExperienceAction({ attemptId }: { attemptId: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [captures, setCaptures] = useState<Capture[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadCaptures() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listCaptures(false);
      setCaptures((res.captures ?? []).filter((item) => !item.archivedAt));
    } catch (e) {
      setError(errorMessage(e, '无法读取念头列表'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="review-experience-action">
      <button
        type="button"
        className="btn small"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && captures === null) void loadCaptures();
        }}
      >
        参考这条经验，再试一步
      </button>
      {open && (
        <div className="review-experience-picker">
          <p className="hint">
            选择一条当前念头，会打开念头详情并带入这条经验的预览；你仍需在详情里确认后才会生成，不会自动创建尝试。
          </p>
          {loading && (
            <p className="muted loading-line" role="status">
              <span className="spinner" aria-hidden="true" /> 正在读取念头…
            </p>
          )}
          {error && (
            <div role="alert">
              <p className="error-msg">{error}</p>
              <button type="button" className="btn small" onClick={loadCaptures}>
                重试
              </button>
            </div>
          )}
          {!loading && !error && captures && captures.length === 0 && (
            <div className="review-experience-empty">
              <p>还没有可用的念头。先记下一个新念头，再回来参考这条经验。</p>
              <Link to="/">去首页记下新念头 →</Link>
            </div>
          )}
          {!loading && !error && captures && captures.length > 0 && (
            <ul className="review-experience-list">
              {captures.map((capture) => (
                <li key={capture.id}>
                  <button
                    type="button"
                    className="review-experience-capture"
                    onClick={() =>
                      navigate(
                        `/capture/${capture.id}?experience=${encodeURIComponent(attemptId)}&from=review`
                      )
                    }
                  >
                    {truncate(capture.rawText, 80)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="link" onClick={() => setOpen(false)}>
            取消
          </button>
        </div>
      )}
    </div>
  );
}

function ReviewItemList({
  items,
  sources,
  showExperience,
  onNextAction,
}: {
  items: ReviewItem[];
  sources: ReviewSource[];
  showExperience?: boolean;
  onNextAction?: (experienceIndex: number) => void;
}) {
  if (items.length === 0) return <p className="hint">这一类没有条目。</p>;
  return (
    <ul className="review-item-list">
      {items.map((item, index) => {
        const attemptId = showExperience ? existingAttemptId(item, sources) : null;
        return (
          <li className="review-item" key={`${item.text.slice(0, 12)}-${index}`}>
            <div className="review-item-head">
              <span className={`review-basis ${item.basis}`}>{REVIEW_BASIS_LABEL[item.basis]}</span>
              <span className="review-sources">
                {item.sourceIds.map((sourceId) => (
                  <SourceChip key={sourceId} sourceKey={sourceId} sources={sources} />
                ))}
              </span>
            </div>
            <p className="review-item-text">{item.text}</p>
            <div className="review-experience-actions">
              {attemptId && <ReviewExperienceAction attemptId={attemptId} />}
              {showExperience && onNextAction && (
                <button
                  type="button"
                  className="btn small next-action-start"
                  data-testid="next-action-start"
                  onClick={() => onNextAction(index)}
                >
                  把这条经验变成下一步
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ReviewContentBlocks({
  content,
  sources,
  reviewId,
  saved,
  onNextActionCreated,
}: {
  content: ReviewContent;
  sources: ReviewSource[];
  /** 只有已保存回顾的详情页才传入，用来创建下一步行动 */
  reviewId?: string;
  saved?: boolean;
  onNextActionCreated?: (action: NextAction) => void;
}) {
  const [nextActionIndex, setNextActionIndex] = useState<number | null>(null);
  const canCreateNextAction = Boolean(reviewId && saved);

  return (
    <div className="review-content">
      <p className="review-overview">{content.overview}</p>
      {content.insufficientData && (
        <div className="review-banner warn" role="status">
          <strong>这次数据不足</strong>
          <p>模型没有给出足够具体的回顾，下面的条目仅供参考。</p>
        </div>
      )}
      <section className="review-block">
        <h4>做过的尝试</h4>
        <ReviewItemList items={content.attempts} sources={sources} />
      </section>
      <section className="review-block">
        <h4>记录的观察</h4>
        <ReviewItemList items={content.observations} sources={sources} />
      </section>
      <section className="review-block">
        <h4>关联与矛盾</h4>
        <ReviewItemList items={content.connections} sources={sources} />
      </section>
      <section className="review-block">
        <h4>下次可参考</h4>
        <ReviewItemList
          items={content.experiences}
          sources={sources}
          showExperience
          onNextAction={canCreateNextAction ? setNextActionIndex : undefined}
        />
      </section>
      {content.uncertainties.length > 0 && (
        <section className="review-block">
          <h4>不确定之处</h4>
          <ul className="review-notes">
            {content.uncertainties.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </section>
      )}
      {content.dataNotes && (
        <section className="review-block">
          <h4>数据说明</h4>
          <p className="review-data-notes">{content.dataNotes}</p>
        </section>
      )}
      {canCreateNextAction && reviewId && nextActionIndex != null && (
        <NextActionEditor
          reviewId={reviewId}
          experienceIndex={nextActionIndex}
          onClose={() => setNextActionIndex(null)}
          onCreated={(action) => onNextActionCreated?.(action)}
        />
      )}
    </div>
  );
}

// ===== 页面 =====

type ReviewFilterKey = 'all' | 'capture' | 'attempt' | 'result' | 'reference' | 'modification';

const FILTER_LABEL: Record<ReviewFilterKey, string> = {
  all: '全部',
  capture: '念头',
  attempt: '尝试',
  result: '结果',
  reference: '引用',
  modification: '修改',
};

export default function ReviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // 范围
  const [preset, setPreset] = useState<ReviewPreset>('7d');
  const [customStart, setCustomStart] = useState(() => dateInputValue(addLocalDays(Date.now(), -6)));
  const [customEnd, setCustomEnd] = useState(() => dateInputValue(Date.now()));
  const [customError, setCustomError] = useState<string | null>(null);
  const [range, setRange] = useState<ReviewRangeInput>(() => presetRangeInput('7d'));
  const [data, setData] = useState<ReviewRangeResponse | null>(null);
  const [rangeLoading, setRangeLoading] = useState(true);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [daily, setDaily] = useState<ReviewDailyResponse | null>(null);
  const [dailyLoading, setDailyLoading] = useState(true);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // 记录筛选
  const [filter, setFilter] = useState<ReviewFilterKey>('all');

  // 确认区 / 预览
  const [composerOpen, setComposerOpen] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<ReviewPreviewResponse | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const previewSeqRef = useRef(0);

  // 生成
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createErrorCode, setCreateErrorCode] = useState<string | null>(null);
  const operationIdRef = useRef(newOperationId());

  // 回顾状态
  const [review, setReview] = useState<ReviewPublic | null>(null);
  const [restoring, setRestoring] = useState(() => Boolean(searchParams.get('review')));
  const [pollError, setPollError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 保存
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  // 已保存列表
  const [saved, setSaved] = useState<ReviewListItem[] | null>(null);
  const [savedLoading, setSavedLoading] = useState(true);
  const [savedError, setSavedError] = useState<string | null>(null);

  const rangeSeqRef = useRef(0);

  // ----- 范围加载 -----
  useEffect(() => {
    const seq = ++rangeSeqRef.current;
    setRangeLoading(true);
    setRangeError(null);
    setDailyLoading(true);
    setDailyError(null);
    api
      .getReviewRange(range)
      .then((res) => {
        if (rangeSeqRef.current !== seq) return;
        setData(res);
        setSelectedKeys(new Set(res.records.map((record) => record.key)));
        setPreview(null);
        setPreviewKey(null);
        setPreviewError(null);
        setPreviewStale(false);
        setCreateError(null);
        setCreateErrorCode(null);
        setFilter('all');
      })
      .catch((e) => {
        if (rangeSeqRef.current !== seq) return;
        setRangeError(errorMessage(e, '无法读取这段时间的记录'));
      })
      .finally(() => {
        if (rangeSeqRef.current === seq) setRangeLoading(false);
      });

    api
      .getReviewDaily(annualDailyRangeInput())
      .then((res) => {
        if (rangeSeqRef.current !== seq) return;
        setDaily(res);
      })
      .catch((e) => {
        if (rangeSeqRef.current !== seq) return;
        setDailyError(errorMessage(e, '无法读取近 12 个月每日额度与日程统计'));
      })
      .finally(() => {
        if (rangeSeqRef.current === seq) setDailyLoading(false);
      });
  }, [range]);

  // ----- 刷新后从 URL 恢复回顾 -----
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const reviewId = searchParams.get('review');
    if (!reviewId) {
      setRestoring(false);
      return;
    }
    (async () => {
      try {
        const res = await api.getReview(reviewId);
        const restored = res.review;
        setReview(restored);
        setPreset(restored.range.preset);
        setCustomStart(dateInputValue(restored.range.from));
        setCustomEnd(dateInputValue(restored.range.to - 1));
        setRange({
          from: restored.range.from,
          to: restored.range.to,
          timezone: restored.range.timezone,
          preset: restored.range.preset,
        });
      } catch (e) {
        setRestoreError(errorMessage(e, '无法恢复上次的回顾'));
        const next = new URLSearchParams(searchParams);
        next.delete('review');
        setSearchParams(next, { replace: true });
      } finally {
        setRestoring(false);
      }
    })();
    // 只在首次挂载读取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- 轮询 pending（每 1 秒） -----
  useEffect(() => {
    if (!review || review.status !== 'pending') return;
    let disposed = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const res = await api.getReview(review.id);
        if (disposed) return;
        setReview(res.review);
        setPollError(null);
        if (res.review.status === 'pending') {
          timer = window.setTimeout(tick, 1000);
        }
      } catch (e) {
        if (disposed) return;
        setPollError(errorMessage(e, '暂时无法获取回顾进度，正在自动重试…'));
        timer = window.setTimeout(tick, 2000);
      }
    };
    timer = window.setTimeout(tick, 1000);
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [review?.id, review?.status]);

  // ----- 已保存列表 -----
  useEffect(() => {
    void loadSaved();
  }, []);

  async function loadSaved() {
    setSavedLoading(true);
    setSavedError(null);
    try {
      const res = await api.listSavedReviews(50);
      setSaved(res.reviews ?? []);
    } catch (e) {
      setSavedError(errorMessage(e, '无法读取已保存的回顾'));
    } finally {
      setSavedLoading(false);
    }
  }

  const currentSelectionKey = useMemo(() => {
    if (!data) return '';
    return data.records
      .filter((record) => selectedKeys.has(record.key))
      .map((record) => record.key)
      .sort()
      .join('|');
  }, [data, selectedKeys]);

  const selectedCount = useMemo(() => {
    if (!data) return 0;
    return data.records.filter((record) => selectedKeys.has(record.key)).length;
  }, [data, selectedKeys]);

  const previewIsCurrent = Boolean(preview && previewKey === currentSelectionKey);

  async function runPreview(keys: Set<string>) {
    if (!data) return;
    const includeKeys = data.records.filter((record) => keys.has(record.key)).map((record) => record.key);
    if (includeKeys.length === 0) {
      setPreview(null);
      setPreviewKey(null);
      setPreviewError('请至少勾选 1 条记录后再生成回顾。');
      return;
    }
    if (includeKeys.length > 300) {
      setPreview(null);
      setPreviewKey(null);
      setPreviewError(`勾选了 ${includeKeys.length} 条记录，一次最多 300 条。请缩小范围或取消勾选。`);
      return;
    }
    const seq = ++previewSeqRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewStale(false);
    try {
      const res = await api.previewReview({
        from: data.range.from,
        to: data.range.to,
        timezone: data.range.timezone,
        preset: data.range.preset,
        includeKeys,
      });
      if (previewSeqRef.current !== seq) return;
      setPreview(res);
      setPreviewKey([...includeKeys].sort().join('|'));
    } catch (e) {
      if (previewSeqRef.current !== seq) return;
      setPreview(null);
      setPreviewKey(null);
      const code = e instanceof ApiError ? e.body?.error : null;
      if (code === 'records_changed' || code === 'invalid_keys') {
        setPreviewError('记录已变化，请刷新记录后重新确认要发送的内容。');
        setPreviewStale(true);
      } else if (code === 'invalid_range' || code === 'invalid_timezone' || code === 'invalid_preset') {
        setPreviewError(errorMessage(e, '时间范围无效，请重新选择。'));
      } else {
        setPreviewError(errorMessage(e, '预览失败，请重试'));
      }
    } finally {
      if (previewSeqRef.current === seq) setPreviewLoading(false);
    }
  }

  // 勾选变化后自动重算服务端预览（字符数 / contextToken）
  useEffect(() => {
    if (!composerOpen || !data) return;
    const timer = window.setTimeout(() => {
      void runPreview(selectedKeys);
    }, 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerOpen, selectedKeys, data]);

  function resetReviewState() {
    setReview(null);
    setPollError(null);
    setActionError(null);
    setCreateError(null);
    setCreateErrorCode(null);
    setNotice(null);
    setSaveError(null);
    setSavedNotice(null);
    setComposerOpen(false);
    setPreview(null);
    setPreviewKey(null);
    setPreviewError(null);
    setPreviewStale(false);
    operationIdRef.current = newOperationId();
    setReviewParam(null);
  }

  function setReviewParam(id: string | null) {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('review', id);
    else next.delete('review');
    setSearchParams(next, { replace: true });
  }

  function choosePreset(next: ReviewPreset) {
    setPreset(next);
    setCustomError(null);
    if (next === 'custom') return;
    resetReviewState();
    setRange(presetRangeInput(next));
  }

  function applyCustom() {
    const result = customRangeInput(customStart, customEnd);
    if ('error' in result) {
      setCustomError(result.error);
      return;
    }
    setCustomError(null);
    resetReviewState();
    setRange(result.range);
  }

  function reloadRange() {
    setRange((prev) => ({ ...prev }));
  }

  function toggleKey(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAll() {
    if (!data) return;
    setSelectedKeys(new Set(data.records.map((record) => record.key)));
  }

  function clearAll() {
    setSelectedKeys(new Set());
  }

  async function generate() {
    if (!data || !preview || !previewIsCurrent || creating) return;
    if (!data.ai.configured || !data.ai.enabled) {
      setCreateErrorCode(data.ai.configured ? 'ai_disabled' : 'ai_not_configured');
      setCreateError(
        data.ai.configured
          ? 'AI 模型当前已停用，无法生成回顾；可以先预览记录，去设置中启用后再生成。'
          : '还没有配置 AI 模型，无法生成回顾；可以先预览记录，去设置中配置后再生成。'
      );
      return;
    }
    if (!preview.coverage.withinLimit) return;
    setCreating(true);
    setCreateError(null);
    setCreateErrorCode(null);
    setActionError(null);
    try {
      const res = await api.createReview({
        from: data.range.from,
        to: data.range.to,
        timezone: data.range.timezone,
        preset: data.range.preset,
        includeKeys: preview.records.map((record) => record.key),
        contextToken: preview.contextToken,
        operationId: operationIdRef.current,
      });
      operationIdRef.current = newOperationId();
      setReview(res.review);
      setComposerOpen(false);
      setPreview(null);
      setPreviewKey(null);
      setNotice(res.replayed ? '已恢复这次回顾。' : null);
      setReviewParam(res.review.id);
    } catch (e) {
      const code = e instanceof ApiError ? e.body?.error : null;
      setCreateErrorCode(code ?? null);
      if (code === 'context_changed' || code === 'records_changed') {
        setPreviewStale(true);
        setCreateError(
          e instanceof ApiError && e.body?.message
            ? e.body.message
            : '预览后记录或配置有变化，请刷新内容并重新确认。'
        );
      } else if (code === 'review_too_large') {
        const body = e instanceof ApiError ? e.body ?? {} : {};
        setCreateError(
          `内容超过上限：${body.recordCount ?? selectedCount} 条 / ${body.charCount ?? '—'} 字，最多 ${
            body.maxRecords ?? 80
          } 条 / ${body.maxChars ?? 16000} 字。请缩小范围或取消勾选。`
        );
      } else if (code === 'operation_key_conflict') {
        operationIdRef.current = newOperationId();
        setCreateError('操作状态冲突，已准备好重新提交，请再试一次。');
      } else if (code === 'too_many_reviews') {
        setCreateError('同时进行的回顾过多，请等待其中一个完成或取消后再试。');
      } else if (code === 'ai_not_configured' || code === 'ai_disabled') {
        setCreateError(errorMessage(e, 'AI 模型当前不可用，请先去设置。'));
      } else if (code === 'no_records') {
        setCreateError('没有可发送的记录，请重新勾选。');
      } else {
        setCreateError(
          errorMessage(
            e,
            '网络异常，未确认是否已开始生成。可重试（同一操作会自动去重）或刷新页面查看。'
          )
        );
      }
    } finally {
      setCreating(false);
    }
  }

  async function cancelReview() {
    if (!review || cancelling) return;
    setCancelling(true);
    setActionError(null);
    try {
      const res = await api.cancelReview(review.id);
      setReview(res.review);
      setPollError(null);
    } catch (e) {
      const code = e instanceof ApiError ? e.body?.error : null;
      if (code === 'not_cancellable') {
        try {
          const res = await api.getReview(review.id);
          setReview(res.review);
          setActionError('这次回顾已经结束，无法取消，已刷新最新状态。');
        } catch {
          setActionError('这次回顾已经结束，无法取消。');
        }
      } else {
        setActionError(errorMessage(e, '取消失败，请重试'));
      }
    } finally {
      setCancelling(false);
    }
  }

  function retryReview() {
    setReview(null);
    setReviewParam(null);
    setPollError(null);
    setActionError(null);
    setNotice(null);
    setCreateError(null);
    setCreateErrorCode(null);
    setSaveError(null);
    setSavedNotice(null);
    setComposerOpen(true);
  }

  async function saveReview() {
    if (!review || saving) return;
    if (review.savedAt != null) {
      setSavedNotice('这条回顾已保存，没有重复写入。');
      return;
    }
    if (!review.canSave || review.status !== 'succeeded' || !review.content) {
      setSaveError('这次回顾还不能保存。只有生成成功且未保存的回顾可以保存。');
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSavedNotice(null);
    try {
      const res = await api.saveReview(review.id, { operationId: newOperationId() });
      setReview(res.review);
      setSavedNotice(res.replayed ? '这条回顾此前已保存，没有重复写入。' : '已保存。');
      void loadSaved();
    } catch (e) {
      const code = e instanceof ApiError ? e.body?.error : null;
      if (code === 'not_savable') {
        try {
          const fresh = await api.getReview(review.id);
          setReview(fresh.review);
          if (fresh.review.savedAt != null) {
            setSavedNotice('这条回顾已保存，没有重复写入。');
            void loadSaved();
          } else {
            setSaveError('这次回顾还不能保存。请确认生成已成功。');
          }
        } catch {
          setSaveError('这次回顾还不能保存。');
        }
      } else {
        setSaveError(errorMessage(e, '保存失败，请重试'));
      }
    } finally {
      setSaving(false);
    }
  }

  function openComposer() {
    setComposerOpen(true);
    setCreateError(null);
    setCreateErrorCode(null);
    setPreviewStale(false);
    if (data) setSelectedKeys(new Set(data.records.map((record) => record.key)));
  }

  // ----- 过滤统计 -----
  const filters = useMemo(() => {
    if (!data) return [];
    const sections = data.sections;
    return [
      { key: 'all' as const, count: data.records.length },
      { key: 'capture' as const, count: sections.captures.length },
      { key: 'attempt' as const, count: sections.attempts.length },
      { key: 'result' as const, count: sections.results.length },
      { key: 'reference' as const, count: sections.references.length },
      { key: 'modification' as const, count: sections.modifications.length },
    ];
  }, [data]);

  const filteredRecords = useMemo(() => {
    if (!data) return [];
    if (filter === 'all') return data.records;
    const sections = data.sections;
    const keys =
      filter === 'capture'
        ? sections.captures
        : filter === 'attempt'
          ? sections.attempts
          : filter === 'result'
            ? sections.results
            : filter === 'reference'
              ? sections.references
              : sections.modifications;
    const set = new Set(keys);
    return data.records.filter((record) => set.has(record.key));
  }, [data, filter]);

  // ----- 渲染 -----
  function renderRecord(record: ReviewRecord) {
    const isEnded = record.type === 'attempt' && (record.state === 'done' || record.state === 'cancelled');
    const resultTimeUnknown = record.reasons.includes('result_time_unknown');
    const reasonLabels = Array.from(
      new Set(record.reasons.map((reason) => REVIEW_REASON_LABEL[reason]))
    ).filter(Boolean);
    return (
      <li className="review-record" key={record.key}>
        <div className="review-record-head">
          <div className="review-record-badges">
            <span className={`badge review-type-${record.type}`}>
              {REVIEW_RECORD_TYPE_LABEL[record.type]}
            </span>
            {reasonLabels.map((label) => (
              <span className="badge" key={label}>
                {label}
              </span>
            ))}
            {record.archived && <span className="badge">已归档</span>}
            {record.type === 'attempt' && record.state && (
              <span className={`badge state-${record.state}`}>{STATE_LABEL[record.state]}</span>
            )}
            {record.outcome && (
              <span className={`badge outcome-${record.outcome}`}>{OUTCOME_LABEL[record.outcome]}</span>
            )}
          </div>
        </div>
        {record.type !== 'capture' && record.title && (
          <h3 className="review-record-title">{record.title}</h3>
        )}
        {record.type === 'capture' ? (
          <p className="review-record-text">{record.text}</p>
        ) : record.type === 'attempt' ? (
          <>
            {record.text && record.text !== record.title && (
              <p className="review-record-text">{record.text}</p>
            )}
            {record.resultText ? (
              <p className="review-record-result">
                <span className="review-result-label">结果：</span>
                {record.resultText}
              </p>
            ) : (
              <p className="hint">这条尝试还没有记录结果。</p>
            )}
          </>
        ) : (
          <>
            {record.text && <p className="review-record-text">{record.text}</p>}
            {record.note && <p className="review-record-note">说明：{record.note}</p>}
          </>
        )}
        <div className="review-record-times">
          <span>创建于 {formatTime(record.createdAt)}</span>
          {record.observedAt != null && <span>结果记录于 {formatTime(record.observedAt)}</span>}
          {(record.updatedAt != null || resultTimeUnknown) && (
            <span>最后修改于 {formatTime(record.updatedAt ?? record.createdAt)}</span>
          )}
        </div>
        {resultTimeUnknown && (
          <p className="review-record-note">结果时间未记录，显示最后修改时间</p>
        )}
        {isEnded && record.state && (
          <p className="review-record-state">
            当前状态：{STATE_LABEL[record.state]}（结束时间未保存）
          </p>
        )}
        <div className="review-record-links">
          {record.type === 'attempt' && record.attemptId && (
            <Link to={`/attempt/${record.attemptId}`}>打开尝试 →</Link>
          )}
          {record.type === 'reference' && record.fromAttemptId && (
            <Link to={`/attempt/${record.fromAttemptId}`}>打开引用来源尝试 →</Link>
          )}
          {record.type === 'reference' && record.toAttemptId && (
            <Link to={`/attempt/${record.toAttemptId}`}>打开被引用尝试 →</Link>
          )}
          {record.captureId && <Link to={`/capture/${record.captureId}`}>打开念头 →</Link>}
        </div>
      </li>
    );
  }

  function renderAiSummary() {
    if (!data) return null;
    const ai = data.ai;
    const recordCount = data.stats.totalRecords;
    return (
      <section className="review-ai-card" aria-label="AI 阶段回顾">
        <div className="review-ai-head">
          <div>
            <h2>AI 回顾</h2>
            <p className="hint">
              先生成预览，确认要发送哪些记录；不生成也可以浏览上面的记录与统计。
            </p>
          </div>
          <span
            className={`ai-status-badge small status-${
              !ai.configured ? 'unconfigured' : ai.enabled ? 'success' : 'disabled'
            }`}
          >
            {!ai.configured ? '未配置' : ai.enabled ? '可用' : '已停用'}
          </span>
        </div>
        {!ai.configured ? (
          <div className="review-ai-guide">
            <p>
              <strong>先配置 AI 模型</strong>
            </p>
            <p>配置后可以基于这段时间的实际记录生成回顾；不配置也能浏览记录与统计。</p>
            <p className="hint">
              也可以先看看「会发送哪些记录、大约多少字」，确认口径后再决定要不要配置模型。
            </p>
            <div className="row-actions">
              <Link className="btn small" to="/settings/ai">
                去配置 AI 模型
              </Link>
              <button
                type="button"
                className="btn small"
                data-testid="review-preview-only"
                aria-expanded={composerOpen}
                onClick={() => (composerOpen ? setComposerOpen(false) : openComposer())}
                disabled={recordCount === 0}
              >
                {composerOpen ? '收起要发送的记录' : '预览将发送的记录'}
              </button>
            </div>
            {recordCount === 0 && (
              <p className="hint">这段时间没有记录，没有可预览的内容。</p>
            )}
          </div>
        ) : (
          <>
            <dl className="review-ai-meta">
              <div>
                <dt>目标模型</dt>
                <dd>
                  {ai.config ? `${ai.config.name} · ${ai.config.modelId}` : '未返回模型信息'}
                </dd>
              </div>
              <div>
                <dt>范围</dt>
                <dd>
                  {data.range.fromLocal} 起（含）至 {data.range.toLocal}（不含）
                </dd>
              </div>
              <div>
                <dt>记录数</dt>
                <dd>{recordCount} 条</dd>
              </div>
            </dl>
            {!ai.enabled && (
              <p className="inline-warn">
                AI 模型已停用：可以预览要发送的记录，但生成前请先在设置中启用；实际记录与统计仍然可用。
              </p>
            )}
            <div className="row-actions">
              <button
                type="button"
                className="btn primary"
                onClick={() => (composerOpen ? setComposerOpen(false) : openComposer())}
                aria-expanded={composerOpen}
                disabled={recordCount === 0}
              >
                {composerOpen ? '收起确认区' : '帮我回顾'}
              </button>
              {!ai.enabled && (
                <Link className="btn small" to="/settings/ai">
                  去设置中启用
                </Link>
              )}
              {recordCount === 0 && <span className="hint">这段时间没有记录，无法生成回顾。</span>}
            </div>
          </>
        )}
        {composerOpen && data && renderComposer()}
      </section>
    );
  }

  function renderComposer() {
    const aiReady = Boolean(data?.ai.configured && data?.ai.enabled);
    return (
      <div className="review-composer" aria-label="确认要发送的内容">
        <div className="review-composer-head">
          <h3>确认要发送的内容</h3>
          <button type="button" className="link" onClick={() => setComposerOpen(false)}>
            收起
          </button>
        </div>
        <dl className="review-composer-meta">
          <div>
            <dt>目标模型</dt>
            <dd>{data?.ai.config ? `${data.ai.config.name} · ${data.ai.config.modelId}` : '未配置'}</dd>
          </div>
          <div>
            <dt>范围</dt>
            <dd>
              {data?.range.fromLocal} 起（含）至 {data?.range.toLocal}（不含）
            </dd>
          </div>
          <div>
            <dt>统计</dt>
            <dd>
              念头 {data?.stats.capturesCreated ?? 0} · 尝试 {data?.stats.attemptsStarted ?? 0} · 结果{' '}
              {data?.stats.resultsRecorded ?? 0} · 引用 {data?.stats.referencesCreated ?? 0}
            </dd>
          </div>
        </dl>
        <div className="review-composer-list-head">
          <strong>将发送的记录（默认全选）</strong>
          <span className="review-composer-list-actions">
            <button type="button" className="link" onClick={selectAll}>
              全选
            </button>
            <button type="button" className="link" onClick={clearAll}>
              全不选
            </button>
          </span>
        </div>
        <ul className="review-composer-list">
          {(data?.records ?? []).map((record) => (
            <li key={record.key}>
              <label className="review-composer-item">
                <input
                  type="checkbox"
                  checked={selectedKeys.has(record.key)}
                  onChange={() => toggleKey(record.key)}
                />
                <span className={`review-type-${record.type}`}>
                  {REVIEW_RECORD_TYPE_LABEL[record.type]}
                </span>
                <span className="review-composer-title">
                  {truncate(record.title || record.text || record.key, 60)}
                </span>
                <span className="review-composer-time">
                  {formatTime(record.observedAt ?? record.createdAt)}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="review-composer-summary" role="status">
          <p>
            {previewIsCurrent && preview ? (
              <>
                将发送 {preview.coverage.selectedRecords} 条，共约 {preview.coverage.selectedChars} 字；未选{' '}
                {preview.coverage.excludedRecords} 条
              </>
            ) : (
              <>将发送 {selectedCount} 条，正在计算字符数与未选数量…</>
            )}
          </p>
          {previewLoading && (
            <p className="hint loading-line">
              <span className="spinner" aria-hidden="true" /> 正在计算字符数与可发送上限…
            </p>
          )}
          {preview && !preview.coverage.withinLimit && (
            <p className="error-msg">
              超过上限（最多 {preview.coverage.maxRecords} 条 / {preview.coverage.maxChars} 字），
              请缩小范围或取消勾选后再生成。
            </p>
          )}
          {selectedCount === 0 && <p className="error-msg">请至少勾选 1 条记录。</p>}
        </div>
        {previewError && (
          <div role="alert">
            <p className="error-msg">{previewError}</p>
            {previewStale && (
              <button type="button" className="btn small" onClick={reloadRange}>
                刷新记录
              </button>
            )}
          </div>
        )}
        {createError && (
          <div role="alert">
            <p className="error-msg">{createError}</p>
            {createErrorCode === 'context_changed' || createErrorCode === 'records_changed' ? (
              <button
                type="button"
                className="btn small"
                onClick={() => void runPreview(selectedKeys)}
                disabled={previewLoading}
              >
                刷新预览
              </button>
            ) : null}
            {(createErrorCode === 'ai_not_configured' || createErrorCode === 'ai_disabled') && (
              <Link className="btn small" to="/settings/ai">
                去设置
              </Link>
            )}
          </div>
        )}
        {!aiReady && (
          <div className="inline-warn" role="status">
            <p>
              这里可以先确认「会发送哪些记录、大约多少字」；但
              {data?.ai.configured ? 'AI 模型当前已停用' : '还没有配置 AI 模型'}
              ，所以暂时不能生成回顾。
            </p>
            <Link className="btn small" to="/settings/ai">
              {data?.ai.configured ? '去设置中启用' : '去配置 AI 模型'}
            </Link>
          </div>
        )}
        <div className="row-actions">
          <button
            type="button"
            className="btn primary"
            onClick={generate}
            disabled={
              creating ||
              previewLoading ||
              !previewIsCurrent ||
              !preview ||
              !preview.coverage.withinLimit ||
              selectedCount === 0 ||
              !aiReady
            }
            title={aiReady ? undefined : 'AI 模型未配置或已停用，无法生成回顾'}
          >
            {creating ? '提交中…' : '生成回顾'}
          </button>
          <button type="button" className="btn" onClick={() => setComposerOpen(false)} disabled={creating}>
            取消
          </button>
          {previewStale && (
            <button
              type="button"
              className="btn"
              onClick={() => void runPreview(selectedKeys)}
              disabled={previewLoading}
            >
              刷新预览
            </button>
          )}
        </div>
        <p className="hint">只会发送上面勾选的记录；未勾选的记录不会出现在提示词里。</p>
      </div>
    );
  }

  function renderReviewCard() {
    if (!review) return null;
    const selectedRecords =
      review.coverage?.selectedRecords ?? review.sources.length ?? 0;
    const excludedRecords = review.coverage?.excludedRecords ?? 0;
    return (
      <div className={`review-status-card ${review.status}`} aria-live="polite">
        {notice && <p className="save-ok" role="status">{notice}</p>}
        {review.status === 'pending' && (
          <>
            <div className="review-status-head">
              <h3 className="review-status-title">
                <span className="spinner" aria-hidden="true" /> 正在生成回顾…
              </h3>
              <span className="badge">{REVIEW_STATUS_LABEL.pending}</span>
            </div>
            <p>
              目标模型：{review.config ? `${review.config.name} · ${review.config.modelId}` : '未记录'}
            </p>
            <p>
              范围：{review.range.fromLocal} 起（含）至 {review.range.toLocal}（不含）
            </p>
            <p>记录：{selectedRecords} 条 · 状态每秒自动刷新</p>
            {pollError && <p className="error-msg">{pollError}</p>}
            {actionError && <p className="error-msg">{actionError}</p>}
            <div className="row-actions">
              <button type="button" className="btn" onClick={cancelReview} disabled={cancelling}>
                {cancelling ? '取消中…' : '取消'}
              </button>
            </div>
          </>
        )}

        {review.status === 'succeeded' && review.content && (
          <>
            <div className="review-status-head">
              <h3 className="review-status-title">阶段回顾</h3>
              <span className="badge">{REVIEW_STATUS_LABEL.succeeded}</span>
            </div>
            {review.contentInvalidated && (
              <div className="review-banner danger" role="alert">
                <strong>部分来源已删除，内容已按删除策略处理</strong>
                <p>{review.contentInvalidReason || '来源记录已删除'}</p>
              </div>
            )}
            {review.sourcesChanged && !review.contentInvalidated && (
              <div className="review-banner warn" role="status">
                <strong>来源有更新</strong>
                <p>部分来源在生成后被修改，来源 chip 仍可打开当前记录。</p>
              </div>
            )}
            <ReviewContentBlocks content={review.content} sources={review.sources} />
            <p className="review-cover-footer">
              本次覆盖 {selectedRecords} 条记录（另有 {excludedRecords} 条未选）
            </p>
            {savedNotice && (
              <p className="save-ok" role="status">
                {savedNotice}
              </p>
            )}
            {saveError && <p className="error-msg">{saveError}</p>}
            <div className="row-actions">
              <button
                type="button"
                className="btn primary review-save"
                onClick={saveReview}
                disabled={saving || review.savedAt != null || !review.canSave}
              >
                {review.savedAt != null ? '已保存' : saving ? '保存中…' : '保存回顾'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setComposerOpen(true);
                  setCreateError(null);
                  setCreateErrorCode(null);
                  setSavedNotice(null);
                  setSaveError(null);
                }}
              >
                重新生成
              </button>
              {review.savedAt != null && (
                <Link className="feedback-link" to={`/review/${review.id}`}>
                  查看详情 →
                </Link>
              )}
            </div>
          </>
        )}

        {(review.status === 'failed' ||
          review.status === 'cancelled' ||
          review.status === 'interrupted' ||
          (review.status === 'succeeded' && !review.content)) && (
          <>
            <div className="review-status-head">
              <h3 className="review-status-title">
                {review.status === 'cancelled' ? '这次回顾已取消' : '这次回顾没有生成'}
              </h3>
              <span className="badge">{REVIEW_STATUS_LABEL[review.status]}</span>
            </div>
            {review.status === 'cancelled' ? (
              <p>
                已停止生成，模型返回的内容不会写进来，也不会自动复活；已保存的回顾和实际记录都不受影响。
              </p>
            ) : (
              <>
                <p>
                  <strong className="gen-error-label">
                    {aiErrorText(review.errorCode, '生成失败')}
                  </strong>
                </p>
                {review.errorMessage && <p className="gen-error-detail">{review.errorMessage}</p>}
              </>
            )}
            {actionError && <p className="error-msg">{actionError}</p>}
            <p className="hint">
              实际记录与统计仍保留在下方，可以调整勾选或范围后重试。
            </p>
            <div className="row-actions">
              <button type="button" className="btn primary" onClick={retryReview}>
                重试
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setReview(null);
                  setReviewParam(null);
                  setNotice(null);
                }}
              >
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="page review-page">
      <div className="crumb">
        <Link to="/">← 返回列表</Link>
      </div>

      <header className="review-head">
        <div>
          <p className="page-kicker">回顾</p>
          <h1 className="page-title">阶段回顾</h1>
          <p className="page-subtitle">
            按本地时区查看这段时间实际记录的念头、尝试、结果与引用；需要时再让 AI 回顾。
          </p>
        </div>
      </header>

      <section className="review-range" aria-label="回顾范围">
        <div className="review-range-presets" role="group" aria-label="选择回顾范围">
          {(['7d', '30d', 'custom'] as ReviewPreset[]).map((item) => (
            <button
              key={item}
              type="button"
              className={`filter-chip review-range-preset${preset === item ? ' active' : ''}`}
              aria-pressed={preset === item}
              onClick={() => choosePreset(item)}
            >
              {REVIEW_PRESET_LABEL[item]}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="review-range-custom">
            <label className="field review-range-field">
              <span>起始日</span>
              <input
                type="date"
                value={customStart}
                max={customEnd || undefined}
                onChange={(e) => setCustomStart(e.target.value)}
              />
            </label>
            <label className="field review-range-field">
              <span>结束日</span>
              <input
                type="date"
                value={customEnd}
                min={customStart || undefined}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </label>
            <button type="button" className="btn primary review-range-apply" onClick={applyCustom}>
              应用
            </button>
          </div>
        )}
        {customError && (
          <p className="error-msg" role="alert">
            {customError}
          </p>
        )}
        {preset === 'custom' && data && data.range.preset !== 'custom' && (
          <p className="hint review-range-apply-hint">修改起止日后点「应用」才会更新范围。</p>
        )}
        {data && (
          <div className="review-range-boundary">
            <p>
              边界：{data.range.fromLocal}（含）→ {data.range.toLocal}（不含）
            </p>
            <p className="hint">
              共 {data.range.days} 天 · 时区 {data.range.timezone} ·
              结束日包含全天，结束边界不含（到结束日次日 00:00 为止）。
            </p>
          </div>
        )}
        {!data && !rangeError && (
          <p className="hint">正在计算本地日界…</p>
        )}
        {rangeError && (
          <div role="alert" className="review-range-error">
            <p className="error-msg">{rangeError}</p>
            <button type="button" className="btn small" onClick={reloadRange}>
              重试
            </button>
          </div>
        )}
      </section>

      {restoring && (
        <p className="muted loading-line" role="status">
          <span className="spinner" aria-hidden="true" /> 正在恢复上次的回顾…
        </p>
      )}
      {restoreError && (
        <p className="error-msg" role="alert">
          {restoreError}；已回到当前范围。
        </p>
      )}

      {data && <ReviewStatsPanel stats={data.stats} definitions={data.statDefinitions} />}

      <ReviewInsightsPanel
        daily={daily}
        loading={dailyLoading}
        error={dailyError}
        onRetry={() => setRange((prev) => ({ ...prev }))}
      />

      {data?.coverage.truncated && (
        <div className="review-banner warn" role="status">
          <strong>范围内记录较多</strong>
          <p>
            只显示最近 {data.records.length} 条（上限 {data.coverage.maxRangeRecords} 条），请缩小范围查看更早的记录。
          </p>
        </div>
      )}

      {renderAiSummary()}

      {review && renderReviewCard()}

      {data && (
        <>
          <nav className="review-filter" aria-label="记录筛选">
            {filters.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`filter-chip review-filter-chip${filter === item.key ? ' active' : ''}`}
                aria-pressed={filter === item.key}
                onClick={() => setFilter(item.key)}
              >
                {FILTER_LABEL[item.key]}
                <span className="filter-count">{item.count}</span>
              </button>
            ))}
          </nav>

          <section className="review-records" aria-label="这段时间的实际记录">
            <div className="section-head review-records-head">
              <h2>实际记录</h2>
              <span className="hint">{filteredRecords.length} 条</span>
            </div>
            {filteredRecords.length === 0 ? (
              <div className="empty-state">
                {data.records.length === 0 ? (
                  <>
                    <p>这段时间还没有记录。</p>
                    <p className="muted">
                      换个范围（比如最近 30 天），或者先记下一个念头、试一步，再看回顾。
                    </p>
                    <div className="row-actions">
                      <Link className="btn small" to="/">
                        去首页记一个念头
                      </Link>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => choosePreset('30d')}
                      >
                        看最近 30 天
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p>这个筛选下还没有记录（共 {data.records.length} 条）。</p>
                    <div className="row-actions">
                      <button type="button" className="btn small" onClick={() => setFilter('all')}>
                        查看全部 {data.records.length} 条
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <ol className="review-record-list">{filteredRecords.map(renderRecord)}</ol>
            )}
          </section>
        </>
      )}

      {rangeLoading && data && (
        <p className="hint loading-line" role="status">
          <span className="spinner" aria-hidden="true" /> 正在更新范围…
        </p>
      )}

      <section className="review-saved-list" aria-label="已保存的回顾">
        <div className="section-head review-saved-head">
          <h2>已保存的回顾</h2>
          <span className="hint">{saved?.length ?? 0} 条</span>
        </div>
        {savedLoading && !saved ? (
          <p className="muted loading-line" role="status">
            <span className="spinner" aria-hidden="true" /> 正在读取已保存的回顾…
          </p>
        ) : savedError ? (
          <div role="alert" className="review-saved-error">
            <p className="error-msg">{savedError}</p>
            <button type="button" className="btn small" onClick={loadSaved}>
              重试
            </button>
          </div>
        ) : saved && saved.length === 0 ? (
          <div className="empty-state">
            <p>还没有保存过回顾。生成一次回顾后点「保存回顾」，之后会出现在这里。</p>
            {data && data.records.length > 0 && (
              <div className="row-actions">
                <button type="button" className="btn small" onClick={openComposer}>
                  现在生成一次回顾
                </button>
              </div>
            )}
          </div>
        ) : (
          <ul className="review-saved-items">
            {(saved ?? []).map((item) => (
              <li key={item.id}>
                <Link className="review-saved-item" to={`/review/${item.id}`}>
                  <div className="review-saved-top">
                    <span className="review-saved-range">
                      {item.range.fromLocal} — {item.range.toLocal}（不含）
                    </span>
                    <span className="review-saved-time">保存于 {formatTime(item.savedAt)}</span>
                  </div>
                  <p className="review-saved-overview">{item.overview}</p>
                  <div className="review-saved-badges">
                    {item.contentInvalidated && (
                      <span className="badge warn">来源已删除（内容已失效）</span>
                    )}
                    {item.changedSourceCount > 0 && (
                      <span className="badge warn">来源有更新 ×{item.changedSourceCount}</span>
                    )}
                    <span className="badge">来源 {item.sourceCount} 条</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
