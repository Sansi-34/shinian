// 拾念 SHINIAN · 问我的记录：检索候选 → 核对发送内容 → 生成 → 轮询回答
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api, { ApiError } from '../api';
import type {
  AskCandidate,
  AskListItem,
  AskPreviewResponse,
  AskPublic,
  AskRecord,
  AskSearchResponse,
  Topic,
  TopicAskScope,
  TopicAskSource,
} from '../types';
import {
  ASK_MAX_QUESTION_CHARS,
  ASK_MAX_RECORDS,
  ASK_MAX_SUGGESTION_TERMS,
  ASK_STATUS_LABEL,
  ASK_TYPE_LABEL,
  OUTCOME_LABEL,
  STATE_LABEL,
  askErrorText,
  formatTime,
  newOperationId,
} from '../types';
import AskAnswerView, { AskSourcesView, askFailureNeedsConfig, askFailureText } from '../components/AskAnswer';
import KeywordExpansionPanel from '../components/KeywordExpansionPanel';
import TopicEvidencePanel from '../components/TopicEvidencePanel';

const EXAMPLE_QUESTIONS = [
  '我以前试过哪些办法？',
  '哪次结果失败了，当时条件是什么？',
  '两次尝试得出的结论有什么不同？',
  '这条经验后来在哪次尝试中用过？',
];

const WORKSPACE_KEY = 'shinian.ask.workspace.v1';

/** 轮询连续失败到上限就停下，交给用户决定是否继续，避免无限「正在自动重试」。 */
const ASK_POLL_MAX_ERRORS = 6;

type CandidateGroup = 'direct' | 'relation' | 'expanded';

type AskWorkspace = {
  v: 1;
  question: string;
  keywords: string;
  keywordsEdited: boolean;
  fromDate: string;
  toDate: string;
  data: AskSearchResponse | null;
  selected: string[];
  preview: AskPreviewResponse | null;
  previewRequested: boolean;
  query: AskPublic | null;
  /** 主题提问范围；null 表示全库。旧工作区没有该字段时按全库恢复。 */
  topicId: string | null;
  /** 当前检索使用的扩展词；旧工作区没有该字段时按空恢复。 */
  expandedKeywords?: string[];
  savedAt: number;
};

function readWorkspace(): AskWorkspace | null {
  try {
    const raw = sessionStorage.getItem(WORKSPACE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AskWorkspace> | null;
    if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return null;
    return {
      v: 1,
      question: typeof parsed.question === 'string' ? parsed.question : '',
      keywords: typeof parsed.keywords === 'string' ? parsed.keywords : '',
      keywordsEdited: Boolean(parsed.keywordsEdited),
      fromDate: typeof parsed.fromDate === 'string' ? parsed.fromDate : '',
      toDate: typeof parsed.toDate === 'string' ? parsed.toDate : '',
      data: parsed.data ?? null,
      selected: Array.isArray(parsed.selected)
        ? parsed.selected.filter((key): key is string => typeof key === 'string')
        : [],
      preview: parsed.preview ?? null,
      previewRequested: Boolean(parsed.previewRequested),
      query: parsed.query ?? null,
      topicId: typeof parsed.topicId === 'string' && parsed.topicId ? parsed.topicId : null,
      expandedKeywords: Array.isArray(parsed.expandedKeywords)
        ? parsed.expandedKeywords.filter(
            (term): term is string => typeof term === 'string' && Boolean(term.trim())
          )
        : [],
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function clearStoredWorkspace() {
  try {
    sessionStorage.removeItem(WORKSPACE_KEY);
  } catch {
    // sessionStorage 不可用时只保留内存状态。
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 日期输入按本地日历解析为当天 00:00。 */
function parseDateInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date.getTime();
}

/** 按本地日历加天数（跨夏令时也落在当天 00:00）。 */
function addLocalDays(ts: number, days: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function dateInputValue(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 详情接口的 to 是「结束日次日 00:00」，回填成用户选择的结束日期。 */
function inclusiveEndInputValue(to: number | null): string {
  return to == null ? '' : dateInputValue(addLocalDays(to, -1));
}

function buildRange(
  fromValue: string,
  toValue: string
): { from: number | null; to: number | null } | { error: string } {
  const from = fromValue.trim() ? parseDateInput(fromValue) : null;
  const end = toValue.trim() ? parseDateInput(toValue) : null;
  if (fromValue.trim() && from === null) return { error: '起始日期格式不正确。' };
  if (toValue.trim() && end === null) return { error: '结束日期格式不正确。' };
  if (from !== null && end !== null && end < from) {
    return { error: '结束日期不能早于起始日期。' };
  }
  return {
    from,
    // 结束日期含当天：传结束日次日 00:00，后端右边界不包含。
    to: end === null ? null : addLocalDays(end, 1),
  };
}

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    return e.body?.message || askErrorText(e.body?.error, fallback);
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const clean = terms.map((term) => term.trim()).filter(Boolean);
  if (clean.length === 0 || !text) return <>{text}</>;
  const pattern = clean
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const regex = new RegExp(`(${pattern})`, 'gi');
  const lowered = new Set(clean.map((term) => term.toLowerCase()));
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, index) =>
        lowered.has(part.toLowerCase()) ? <mark key={index}>{part}</mark> : part
      )}
    </>
  );
}

function candidateGroup(candidate: AskCandidate): CandidateGroup {
  if (candidate.matchKind === 'expanded') return 'expanded';
  if (candidate.matchKind === 'relation') return 'relation';
  if (candidate.matchKind === 'direct') return 'direct';
  // 兼容尚无 matchKind 的后端：只有引用关系原因时归入「沿关系找到」。
  const reasons = candidate.matchReasons ?? [];
  return reasons.length > 0 && reasons.every((reason) => reason.startsWith('引用关系'))
    ? 'relation'
    : 'direct';
}

function recordDateLabel(date: number | null, dateKind: 'observed' | 'created'): string {
  return `${dateKind === 'observed' ? '结果时间' : '记录时间'}：${formatTime(date)}`;
}

function previewRangeText(preview: AskPreviewResponse): string {
  const from =
    preview.range.fromLocal ??
    (preview.range.from != null ? formatTime(preview.range.from) : '不限');
  const to =
    preview.range.toLocal ?? (preview.range.to != null ? formatTime(preview.range.to) : '不限');
  return `${from} 起（含）至 ${to}（不含）`;
}

function previewField(label: string, value: string | null | undefined) {
  return (
    <p className="ask-preview-field">
      <strong>{label}</strong>
      <span>{value && value.trim() ? value : '（空）'}</span>
    </p>
  );
}

export default function AskPage() {
  const [restored] = useState<AskWorkspace | null>(() => readWorkspace());
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTopicId = searchParams.get('topicId');
  const urlQuestion = searchParams.get('q') ?? '';
  const explicitAllScope = searchParams.get('scope') === 'all';
  const initialTopicId = urlTopicId ?? (explicitAllScope ? null : restored?.topicId ?? null);
  const restoredMatchesScope = (restored?.topicId ?? null) === initialTopicId;

  const questionRef = useRef<HTMLTextAreaElement>(null);
  const keywordsRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const queryRef = useRef<HTMLElement>(null);
  const operationIdRef = useRef(newOperationId());
  const previewSeqRef = useRef(0);
  const includeHandledRef = useRef(false);
  const includeKeysRef = useRef<string[]>([]);
  const autoSearchRef = useRef(false);
  const searchSeqRef = useRef(0);

  const [topicId, setTopicId] = useState<string | null>(initialTopicId);
  const [topic, setTopic] = useState<Topic | null>(null);
  const [topicLoading, setTopicLoading] = useState(Boolean(initialTopicId));
  const [topicError, setTopicError] = useState<string | null>(null);
  const [topicScope, setTopicScope] = useState<TopicAskScope | null>(null);
  const [scopeNotice, setScopeNotice] = useState<string | null>(null);
  const [scopeConfirmOpen, setScopeConfirmOpen] = useState(false);
  const [evidenceCandidates, setEvidenceCandidates] = useState<AskCandidate[]>([]);
  const [includeNotice, setIncludeNotice] = useState<string | null>(null);
  const [switchingScope, setSwitchingScope] = useState(false);

  const [question, setQuestion] = useState(
    urlQuestion || (restoredMatchesScope ? restored?.question ?? '' : '')
  );
  const [keywords, setKeywords] = useState(restoredMatchesScope ? restored?.keywords ?? '' : '');
  const [keywordsEdited, setKeywordsEdited] = useState(
    restoredMatchesScope ? Boolean(restored?.keywordsEdited) : false
  );
  const [expandedKeywords, setExpandedKeywords] = useState<string[]>(
    restoredMatchesScope ? restored?.expandedKeywords ?? [] : []
  );
  const [fromDate, setFromDate] = useState(restoredMatchesScope ? restored?.fromDate ?? '' : '');
  const [toDate, setToDate] = useState(restoredMatchesScope ? restored?.toDate ?? '' : '');

  const [data, setData] = useState<AskSearchResponse | null>(
    restoredMatchesScope ? restored?.data ?? null : null
  );
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(restoredMatchesScope ? restored?.selected ?? [] : [])
  );
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [expandedRecord, setExpandedRecord] = useState<AskRecord | null>(null);
  const [expandLoading, setExpandLoading] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);

  const [preview, setPreview] = useState<AskPreviewResponse | null>(
    restoredMatchesScope ? restored?.preview ?? null : null
  );
  const [previewRequested, setPreviewRequested] = useState(
    restoredMatchesScope ? Boolean(restored?.preview && restored?.previewRequested) : false
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [sendConfirm, setSendConfirm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createErrorCode, setCreateErrorCode] = useState<string | null>(null);

  const [query, setQuery] = useState<AskPublic | null>(
    restoredMatchesScope ? restored?.query ?? null : null
  );
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollPaused, setPollPaused] = useState(false);
  const [pollResumeTick, setPollResumeTick] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    restoredMatchesScope && restored && (restored.query || restored.data || restored.preview)
      ? '已恢复上次的问答现场，可直接继续。'
      : null
  );

  const [recent, setRecent] = useState<AskListItem[] | null>(null);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [historyOpening, setHistoryOpening] = useState<string | null>(null);

  /** 模型是否已配置：入口就要能看出来，不能等到检索完成才知道。 */
  const [aiStatus, setAiStatus] = useState<{ configured: boolean; enabled: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getAiSettings()
      .then((res) => {
        if (cancelled) return;
        setAiStatus({ configured: res.configured, enabled: Boolean(res.config?.enabled) });
      })
      .catch(() => {
        // 读不到设置时不臆测状态：退回「检索结果里带的状态」。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 加载主题范围信息（标题、记录数）；范围只用于展示，来源仍由服务端校验。
  useEffect(() => {
    if (!topicId) {
      setTopic(null);
      setTopicLoading(false);
      setTopicError(null);
      return;
    }
    let cancelled = false;
    setTopicLoading(true);
    setTopicError(null);
    api
      .getTopic(topicId)
      .then((res) => {
        if (!cancelled) setTopic(res.topic);
      })
      .catch((e) => {
        if (!cancelled) setTopicError(errorMessage(e, '无法读取主题信息'));
      })
      .finally(() => {
        if (!cancelled) setTopicLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [topicId]);

  // URL 带入的 include=sourceKey,...：来自经验依据面板或主题页，自动加入选择。
  useEffect(() => {
    if (!topicId || includeHandledRef.current) return;
    const include = searchParams.get('include');
    if (!include) return;
    includeHandledRef.current = true;
    const keys = include
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
    if (keys.length === 0) return;
    includeKeysRef.current = keys;
    void (async () => {
      try {
        const res = await api.listTopicAskExperiences(topicId);
        const byKey = new Map<string, TopicAskSource>();
        for (const experience of res.experiences) {
          for (const source of experience.sources) {
            if (source.deleted) continue;
            byKey.set(source.sourceKey, source);
          }
        }
        const picked = keys
          .map((key) => byKey.get(key))
          .filter((source): source is TopicAskSource => Boolean(source));
        if (picked.length > 0) {
          ingestEvidenceSources(picked, true);
          setIncludeNotice(`已从经验依据加入 ${picked.length} 条记录，请核对后再发送。`);
        } else {
          setIncludeNotice('没有找到可加入的经验依据；可以手动打开「经验依据」面板选择。');
        }
      } catch (e) {
        setIncludeNotice(errorMessage(e, '读取经验依据失败，可以在下方面板手动选择。'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId]);

  // 入口带 q=探索问题时自动检索一次候选；不会自动发送给模型。
  useEffect(() => {
    if (!topicId || !urlQuestion.trim() || autoSearchRef.current || data) return;
    autoSearchRef.current = true;
    setQuestion(urlQuestion);
    void performSearch({
      question: urlQuestion,
      keywords: undefined,
      from: null,
      to: null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, urlQuestion]);

  // 当前问答现场写入 sessionStorage，从来源页返回 /ask 时不丢问题、证据与回答。
  useEffect(() => {
    const snapshot: AskWorkspace = {
      v: 1,
      question,
      keywords,
      keywordsEdited,
      fromDate,
      toDate,
      data,
      selected: [...selected],
      preview,
      previewRequested,
      query,
      topicId,
      expandedKeywords,
      savedAt: Date.now(),
    };
    try {
      sessionStorage.setItem(WORKSPACE_KEY, JSON.stringify(snapshot));
    } catch {
      // 超出 sessionStorage 配额时不阻断页面操作。
    }
  }, [question, keywords, keywordsEdited, fromDate, toDate, data, selected, preview, previewRequested, query, topicId, expandedKeywords]);

  // 无匹配时把焦点放回检索词输入，方便直接修改。
  useEffect(() => {
    if (data && data.total === 0 && !searching) {
      keywordsRef.current?.focus();
    }
  }, [data, searching]);

  function resetPreview() {
    previewSeqRef.current += 1;
    setPreview(null);
    setPreviewRequested(false);
    setPreviewLoading(false);
    setPreviewError(null);
    setPreviewStale(false);
    setSendConfirm(false);
    setCreateError(null);
    setCreateErrorCode(null);
  }

  function resetExpanded() {
    setExpandedKey(null);
    setExpandedRecord(null);
    setExpandError(null);
    setExpandLoading(false);
  }

  function changeQuestion(value: string) {
    setQuestion(value);
    setExpandedKeywords([]);
    resetPreview();
  }

  function changeKeywords(value: string) {
    setKeywords(value);
    setKeywordsEdited(true);
    setExpandedKeywords([]);
    resetPreview();
  }

  function startNewQuestion() {
    clearStoredWorkspace();
    setQuestion('');
    setKeywords('');
    setKeywordsEdited(false);
    setExpandedKeywords([]);
    setFromDate('');
    setToDate('');
    setData(null);
    setSelected(new Set());
    setSearchError(null);
    setSelectionNotice(null);
    setQuery(null);
    setPollError(null);
    setActionError(null);
    setNotice(null);
    setEvidenceCandidates([]);
    setIncludeNotice(null);
    setScopeNotice(null);
    includeKeysRef.current = [];
    resetExpanded();
    resetPreview();
    requestAnimationFrame(() => questionRef.current?.focus());
  }

  async function loadRecent() {
    setRecentLoading(true);
    setRecentError(null);
    try {
      const res = await api.listAskQueries(10);
      setRecent(res.queries ?? []);
    } catch (e) {
      setRecentError(errorMessage(e, '无法读取最近提问'));
    } finally {
      setRecentLoading(false);
    }
  }

  useEffect(() => {
    void loadRecent();
  }, []);

  // pending 每 1 秒轮询；连续失败达上限即停下（可手动继续），卸载/状态结束也会清理定时器。
  useEffect(() => {
    if (!query || query.status !== 'pending') return;
    let disposed = false;
    let timer: number | undefined;
    let failures = 0;
    setPollPaused(false);
    const tick = async () => {
      try {
        const res = await api.getAskQuery(query.id);
        if (disposed) return;
        setQuery(res.query);
        setPollError(null);
        failures = 0;
        if (res.query.status === 'pending') {
          timer = window.setTimeout(tick, 1000);
        } else {
          void loadRecent();
          requestAnimationFrame(() => {
            queryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
        }
      } catch (e) {
        if (disposed) return;
        if (e instanceof ApiError && e.status === 404) {
          setPollError('这次提问已不存在，无法继续获取回答。');
          setPollPaused(true);
          return;
        }
        failures += 1;
        if (failures >= ASK_POLL_MAX_ERRORS) {
          setPollError(
            `已连续 ${failures} 次无法获取回答进度，自动刷新已暂停。可以点「继续刷新」重试，或稍后打开详情页查看。`
          );
          setPollPaused(true);
          return;
        }
        setPollError(
          `${errorMessage(e, '暂时无法获取回答进度')}（第 ${failures}/${ASK_POLL_MAX_ERRORS} 次重试，正在自动重试…）`
        );
        timer = window.setTimeout(tick, 2000);
      }
    };
    timer = window.setTimeout(tick, 1000);
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query?.id, query?.status, pollResumeTick]);

  async function performSearch(
    input: {
      question: string;
      keywords?: string;
      from: number | null;
      to: number | null;
      expandedKeywords?: string[];
    },
    scopeOverride?: string | null
  ) {
    const activeTopicId = scopeOverride === undefined ? topicId : scopeOverride;
    const hadData = data !== null;
    const previousSelected = new Set(selected);
    const previousEvidenceKeys = new Set(evidenceCandidates.map((item) => item.sourceKey));
    const includeKeys = [...includeKeysRef.current];
    const searchSeq = ++searchSeqRef.current;
    setSearching(true);
    setSearchError(null);
    setSelectionNotice(null);
    setData(null);
    setQuery(null);
    setPollError(null);
    setActionError(null);
    setNotice(null);
    if (!searchParams.get('include')) {
      setEvidenceCandidates([]);
      setIncludeNotice(null);
    }
    resetExpanded();
    resetPreview();
    try {
      const expanded = input.expandedKeywords ?? [];
      let res: AskSearchResponse;
      if (activeTopicId) {
        const topicRes = await api.listTopicAskCandidates(activeTopicId, {
          question: input.question,
          keywords: input.keywords,
          from: input.from,
          to: input.to,
          limit: 20,
          expandedKeywords: expanded,
        });
        setTopicScope(topicRes.scope);
        res = { ...topicRes, question: topicRes.question || input.question };
      } else {
        res = await api.searchAskCandidates({
          question: input.question,
          keywords: input.keywords,
          from: input.from,
          to: input.to,
          limit: 20,
          expandedKeywords: expanded,
        });
        setTopicScope(null);
      }

      if (searchSeq !== searchSeqRef.current) {
        // 问题/关键词/主题切换后，迟到的搜索响应不能覆盖当前页面。
        return false;
      }

      setData(res);
      setKeywords(res.suggestedKeywords);
      // 显式传过检索词（包括空字符串=浏览全部）时保持用户选择；未传时才采用服务端建议。
      setKeywordsEdited(input.keywords !== undefined);
      const nextExpanded = (res.expandedKeywords ?? input.expandedKeywords ?? []).filter(
        (term) => typeof term === 'string' && Boolean(term.trim())
      );
      setExpandedKeywords(nextExpanded);

      if (!hadData) {
        const defaults = res.candidates.slice(0, 3).map((item) => item.sourceKey);
        const seeds = activeTopicId ? [...includeKeys, ...defaults] : defaults;
        setSelected(new Set([...new Set(seeds)].slice(0, ASK_MAX_RECORDS)));
        setSelectionNotice(
          res.candidates.length > 3 ? '已默认勾选最前面的 3 条，请核对后再发送。' : null
        );
      } else {
        // 重新检索保留仍在新结果（或仍可见的经验依据）中的已选来源，明确提示被移除的条目。
        const availableKeys = new Set([
          ...res.candidates.map((item) => item.sourceKey),
          ...previousEvidenceKeys,
          ...includeKeys,
        ]);
        const kept = [...previousSelected].filter((key) => availableKeys.has(key));
        const removed = previousSelected.size - kept.length;
        setSelected(new Set(kept));
        setSelectionNotice(
          removed > 0 ? `重新检索后，${removed} 条已选记录不在新结果中，已移除。` : null
        );
      }

      if (searchSeq !== searchSeqRef.current) {
        return false;
      }

      setSearching(false);
      requestAnimationFrame(() => {
        document.querySelector('.ask-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return true;
    } catch (e) {
      if (searchSeq === searchSeqRef.current) {
        setSearchError(errorMessage(e, '检索失败，请重试'));
      }
      if (searchSeq === searchSeqRef.current) setSearching(false);
      return false;
    }
  }

  /** 把经验依据的直接来源转成 AskCandidate，加入当前选择（不递归）。 */
  function ingestEvidenceSources(sources: TopicAskSource[], select = true) {
    const existingKeys = new Set((data?.candidates ?? []).map((item) => item.sourceKey));
    const extras: AskCandidate[] = [];
    const nextSelected = new Set(select ? selected : []);
    for (const source of sources) {
      if (source.deleted) continue;
      if (!existingKeys.has(source.sourceKey)) {
        extras.push({
          sourceKey: source.sourceKey,
          type: source.type,
          id: source.id,
          captureId: source.captureId,
          title: source.title || source.sourceKey,
          snippet: source.resultText || source.text || '',
          date: source.observedAt,
          dateKind: source.observedAt ? 'observed' : 'created',
          state: source.state,
          outcome: source.outcome,
          archived: source.archived,
          matchReasons: [source.originLabel || '经验依据'],
          matchKind: 'direct',
          referenceCount: 0,
          openHref: source.openHref || (source.type === 'capture' ? `/capture/${source.captureId}` : `/attempt/${source.id}`),
        });
      }
      if (select) {
        if (nextSelected.size >= ASK_MAX_RECORDS) {
          setSelectionNotice(`一次最多选择 ${ASK_MAX_RECORDS} 条记录，部分经验依据未加入。`);
          break;
        }
        nextSelected.add(source.sourceKey);
      }
    }
    if (extras.length > 0) {
      setEvidenceCandidates((prev) => {
        const seen = new Set(prev.map((item) => item.sourceKey));
        return [...prev, ...extras.filter((item) => !seen.has(item.sourceKey))];
      });
    }
    if (select) setSelected(nextSelected);
    resetPreview();
    return extras.length;
  }

  async function submitSearch(e: FormEvent) {
    e.preventDefault();
    const value = question.trim();
    if (!value) {
      setSearchError('请先写下想问的问题。');
      questionRef.current?.focus();
      return;
    }
    const range = buildRange(fromDate, toDate);
    if ('error' in range) {
      setSearchError(range.error);
      return;
    }
    await performSearch({
      question: value,
      keywords: keywordsEdited ? keywords : undefined,
      from: range.from,
      to: range.to,
      expandedKeywords: expandedKeywords.length > 0 ? expandedKeywords : undefined,
    });
  }

  async function browseAll() {
    const value = question.trim();
    if (!value) {
      setSearchError('请先写下想问的问题，再浏览全部记录。');
      questionRef.current?.focus();
      return;
    }
    setKeywords('');
    setKeywordsEdited(true);
    setExpandedKeywords([]);
    setFromDate('');
    setToDate('');
    await performSearch({ question: value, keywords: '', from: null, to: null });
  }

  /** 用用户勾选的替代词重新检索；原问题与检索词保持不变。 */
  async function applyExpandedKeywords(terms: string[]) {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const raw of terms) {
      const term = raw.trim();
      if (!term) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(term);
      if (unique.length >= ASK_MAX_SUGGESTION_TERMS) break;
    }
    if (unique.length === 0) return;
    const value = question.trim();
    if (!value) {
      setSearchError('请先写下想问的问题，再用替代词查找。');
      questionRef.current?.focus();
      return;
    }
    const range = buildRange(fromDate, toDate);
    if ('error' in range) {
      setSearchError(range.error);
      return;
    }
    setExpandedKeywords(unique);
    await performSearch({
      question: value,
      keywords: keywordsEdited ? keywords : undefined,
      from: range.from,
      to: range.to,
      expandedKeywords: unique,
    });
  }

  /** 清除扩展词，按原问题与原检索词重新检索。 */
  async function clearExpandedKeywords() {
    if (expandedKeywords.length === 0) return;
    setExpandedKeywords([]);
    const value = question.trim();
    if (!value) return;
    const range = buildRange(fromDate, toDate);
    if ('error' in range) {
      setSearchError(range.error);
      return;
    }
    await performSearch({
      question: value,
      keywords: keywordsEdited ? keywords : undefined,
      from: range.from,
      to: range.to,
    });
  }

  function toggleCandidate(sourceKey: string) {
    const next = new Set(selected);
    if (next.has(sourceKey)) {
      next.delete(sourceKey);
      setSelectionNotice(null);
    } else {
      if (next.size >= ASK_MAX_RECORDS) {
        setSelectionNotice(`一次最多选择 ${ASK_MAX_RECORDS} 条记录，请先移除一条。`);
        return;
      }
      next.add(sourceKey);
      setSelectionNotice(null);
    }
    setSelected(next);
    resetPreview();
  }

  function removeSelected(sourceKey: string) {
    const next = new Set(selected);
    next.delete(sourceKey);
    setSelected(next);
    setSelectionNotice(null);
    resetPreview();
  }

  function selectAll() {
    if (!data) return;
    const keys = data.candidates.slice(0, ASK_MAX_RECORDS).map((item) => item.sourceKey);
    setSelected(new Set(keys));
    setSelectionNotice(
      data.candidates.length > ASK_MAX_RECORDS
        ? `一次最多选择 ${ASK_MAX_RECORDS} 条，已选中前 ${ASK_MAX_RECORDS} 条。`
        : null
    );
    resetPreview();
  }

  function clearAll() {
    setSelected(new Set());
    setSelectionNotice(null);
    resetPreview();
  }

  async function toggleCandidatePreview(candidate: AskCandidate) {
    if (expandedKey === candidate.sourceKey) {
      resetExpanded();
      return;
    }
    if (!data) return;
    setExpandedKey(candidate.sourceKey);
    setExpandedRecord(null);
    setExpandError(null);
    setExpandLoading(true);
    try {
      const res = await api.previewAsk({
        question: data.question,
        keywords: data.keywords.join(' '),
        from: data.range.from,
        to: data.range.to,
        sourceKeys: [candidate.sourceKey],
        topicId: topicId ?? undefined,
      });
      const record = res.records.find((item) => item.sourceKey === candidate.sourceKey) ?? null;
      if (!record) {
        setExpandError('无法读取这条记录的完整内容，请直接打开原文。');
      } else {
        setExpandedRecord(record);
      }
    } catch (e) {
      setExpandError(errorMessage(e, '无法读取原文，请直接打开原记录。'));
    } finally {
      setExpandLoading(false);
    }
  }

  async function loadPreview(sourceKeys: string[]) {
    if (!data) return;
    const seq = ++previewSeqRef.current;
    setPreviewRequested(true);
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewStale(false);
    setSendConfirm(false);
    setCreateError(null);
    setCreateErrorCode(null);
    try {
      const res = await api.previewAsk({
        question: data.question,
        keywords: data.keywords.join(' '),
        from: data.range.from,
        to: data.range.to,
        sourceKeys,
        topicId: topicId ?? undefined,
      });
      if (res.scope) setTopicScope(res.scope);
      if (seq !== previewSeqRef.current) return;
      setPreview(res);
      operationIdRef.current = newOperationId();
      requestAnimationFrame(() => {
        previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } catch (e) {
      if (seq !== previewSeqRef.current) return;
      const code = e instanceof ApiError ? e.body?.error : null;
      if (code === 'sources_unavailable') {
        const unavailable: string[] =
          e instanceof ApiError && Array.isArray(e.body?.sourceKeys) ? e.body.sourceKeys : [];
        if (unavailable.length > 0) {
          setSelected((prev) => {
            const next = new Set(prev);
            unavailable.forEach((key) => next.delete(key));
            return next;
          });
        }
        setPreviewStale(true);
        setPreviewError(
          `${errorMessage(e, '有记录已被删除或不可访问。')} 已移除不可用记录，请重新核对。`
        );
      } else if (code === 'source_out_of_scope') {
        const outside: string[] =
          e instanceof ApiError && Array.isArray(e.body?.sourceKeys) ? e.body.sourceKeys : [];
        if (outside.length > 0) {
          setSelected((prev) => {
            const next = new Set(prev);
            outside.forEach((key) => next.delete(key));
            return next;
          });
          setEvidenceCandidates((prev) => prev.filter((item) => !outside.includes(item.sourceKey)));
        }
        setPreviewStale(true);
        setPreviewError(
          `${errorMessage(e, '所选记录不在这个主题的范围内。')} 已移除越界记录，请重新核对。`
        );
      } else if (code === 'context_changed') {
        setPreviewStale(true);
        setPreviewError(errorMessage(e, '主题成员、记录或配置发生了变化，请重新核对。'));
      } else {
        setPreviewError(errorMessage(e, '核对失败，请重试'));
      }
    } finally {
      if (seq === previewSeqRef.current) setPreviewLoading(false);
    }
  }

  function openPreview() {
    if (!data) return;
    const keys = allCandidateList
      .filter((item) => selected.has(item.sourceKey))
      .map((item) => item.sourceKey);
    if (keys.length === 0) {
      setPreviewRequested(true);
      setPreviewError('请至少选择 1 条记录后再核对。');
      return;
    }
    void loadPreview(keys);
  }

  async function removePreviewRecord(sourceKey: string) {
    if (!preview || previewLoading) return;
    const remaining = preview.records
      .map((record) => record.sourceKey)
      .filter((key) => key !== sourceKey);
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(sourceKey);
      return next;
    });
    if (remaining.length === 0) {
      resetPreview();
      setSelectionNotice('已移除全部记录，请重新选择要发送的来源。');
      return;
    }
    await loadPreview(remaining);
  }

  function closePreview() {
    resetPreview();
  }

  async function generateAnswer() {
    if (!preview || creating || previewStale || !preview.coverage.withinLimit) return;
    if (!preview.config) {
      setCreateError('尚未配置 AI 模型，不能生成回答。');
      setCreateErrorCode('ai_not_configured');
      return;
    }
    if (!preview.ai.enabled) {
      setCreateError('AI 模型已停用，不能生成回答。');
      setCreateErrorCode('ai_disabled');
      return;
    }
    setCreating(true);
    setCreateError(null);
    setCreateErrorCode(null);
    setActionError(null);
    try {
      const res = await api.createAskQuery({
        question: preview.question,
        keywords: preview.keywords.join(' '),
        from: preview.range.from,
        to: preview.range.to,
        sourceKeys: preview.records.map((record) => record.sourceKey),
        contextToken: preview.contextToken,
        operationId: operationIdRef.current,
        topicId: topicId ?? undefined,
      });
      operationIdRef.current = newOperationId();
      setQuery(res.query);
      setPreview(null);
      setPreviewRequested(false);
      setSendConfirm(false);
      setPreviewError(null);
      setPreviewStale(false);
      setNotice(res.replayed ? '已恢复这次提问。' : null);
      setHistoryOpening(null);
      void loadRecent();
      requestAnimationFrame(() => {
        queryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } catch (e) {
      const code = e instanceof ApiError ? e.body?.error : null;
      setCreateErrorCode(code ?? null);
      if (code === 'context_changed') {
        setPreviewStale(true);
        setSendConfirm(false);
        setCreateError(
          e instanceof ApiError && e.body?.message
            ? e.body.message
            : '核对后记录或配置有变化，请刷新预览并重新确认。'
        );
      } else if (code === 'sources_unavailable') {
        setPreviewStale(true);
        setSendConfirm(false);
        setCreateError(
          e instanceof ApiError && e.body?.message
            ? e.body.message
            : '有记录已被删除或不可访问，请重新检索。'
        );
      } else if (code === 'source_out_of_scope') {
        setPreviewStale(true);
        setSendConfirm(false);
        const outside: string[] =
          e instanceof ApiError && Array.isArray(e.body?.sourceKeys) ? e.body.sourceKeys : [];
        if (outside.length > 0) {
          setSelected((prev) => {
            const next = new Set(prev);
            outside.forEach((key) => next.delete(key));
            return next;
          });
          setEvidenceCandidates((prev) => prev.filter((item) => !outside.includes(item.sourceKey)));
        }
        setCreateError(
          e instanceof ApiError && e.body?.message
            ? e.body.message
            : '所选记录已不在这个主题的范围内，请重新核对。'
        );
      } else if (code === 'topic_not_found') {
        setCreateError('主题不存在或已删除，请返回主题页确认。');
      } else if (code === 'query_too_large') {
        const body = e instanceof ApiError ? e.body ?? {} : {};
        setCreateError(
          `内容超过上限：${body.recordCount ?? preview.records.length} 条 / ${
            body.charCount ?? preview.coverage.selectedChars
          } 字，最多 ${body.maxRecords ?? preview.coverage.maxRecords} 条 / ${
            body.maxChars ?? preview.coverage.maxChars
          } 字。请减少勾选。`
        );
      } else if (code === 'operation_key_conflict') {
        operationIdRef.current = newOperationId();
        setCreateError('操作状态冲突，已准备好重新提交，请再试一次。');
      } else if (code === 'too_many_queries') {
        setCreateError('同时进行的提问过多，请稍后再试。');
      } else if (code === 'ai_not_configured' || code === 'ai_disabled') {
        setCreateError(errorMessage(e, 'AI 模型当前不可用，请先去设置。'));
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

  async function cancelQuery() {
    if (!query || cancelling) return;
    setCancelling(true);
    setActionError(null);
    try {
      const res = await api.cancelAskQuery(query.id);
      setQuery(res.query);
      setPollError(null);
      setNotice('已取消本次提问。');
      void loadRecent();
    } catch (e) {
      const code = e instanceof ApiError ? e.body?.error : null;
      if (code === 'not_cancellable') {
        try {
          const res = await api.getAskQuery(query.id);
          setQuery(res.query);
          setActionError('这次提问已经结束，无法取消，已刷新最新状态。');
        } catch {
          setActionError('这次提问已经结束，无法取消。');
        }
      } else {
        setActionError(errorMessage(e, '取消失败，请重试'));
      }
    } finally {
      setCancelling(false);
    }
  }

  async function openHistory(id: string) {
    if (historyOpening) return;
    setHistoryOpening(id);
    setActionError(null);
    setPollError(null);
    setNotice(null);
    resetPreview();
    resetExpanded();
    try {
      const res = await api.getAskQuery(id);
      setQuery(res.query);
      setQuestion(res.query.question);
      setKeywords(res.query.keywords.join(' '));
      setKeywordsEdited(true);
      setExpandedKeywords([]);
      setFromDate(res.query.range.from == null ? '' : dateInputValue(res.query.range.from));
      setToDate(inclusiveEndInputValue(res.query.range.to));
      setData(null);
      setSelected(new Set());
      setSearchError(null);
      requestAnimationFrame(() => {
        queryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } catch (e) {
      setActionError(errorMessage(e, '无法读取这次问答，请稍后重试'));
    } finally {
      setHistoryOpening(null);
    }
  }

  function retryQuery() {
    setQuery(null);
    setPollError(null);
    setActionError(null);
    setNotice(null);
    resetPreview();
    resetExpanded();
    requestAnimationFrame(() => questionRef.current?.focus());
  }

  /** 明确改为全库搜索：清除 topicId，范围随之变化；若已有问题则按旧逻辑重新检索。 */
  async function switchToAllScope() {
    if (switchingScope) return;
    setSwitchingScope(true);
    setScopeConfirmOpen(false);
    setTopicId(null);
    setTopic(null);
    setTopicScope(null);
    setExpandedKeywords([]);
    setEvidenceCandidates([]);
    setIncludeNotice(null);
    includeKeysRef.current = [];
    setData(null);
    setSelected(new Set());
    setQuery(null);
    resetPreview();
    setScopeNotice('已改为全库搜索：不再受主题范围限制，候选来自全部记录。');
    const params = new URLSearchParams(searchParams);
    params.delete('topicId');
    params.delete('include');
    params.set('scope', 'all');
    setSearchParams(params, { replace: true });
    const value = question.trim();
    if (value) {
      const range = buildRange(fromDate, toDate);
      if (!('error' in range)) {
        await performSearch(
          {
            question: value,
            keywords: keywordsEdited ? keywords : undefined,
            from: range.from,
            to: range.to,
          },
          null
        );
      }
    }
    setSwitchingScope(false);
  }

  // 同一 sourceKey 在 direct/expanded 中同时命中时只保留一条，并合并两种命中说明。
  const displayCandidates = useMemo(() => {
    const byKey = new Map<string, AskCandidate>();
    for (const candidate of data?.candidates ?? []) {
      const previous = byKey.get(candidate.sourceKey);
      if (!previous) {
        byKey.set(candidate.sourceKey, {
          ...candidate,
          matchedKeywords: [...(candidate.matchedKeywords ?? [])],
        });
        continue;
      }
      const kinds = [previous.matchKind, candidate.matchKind];
      const matchKind: AskCandidate['matchKind'] = kinds.includes('direct')
        ? 'direct'
        : kinds.includes('relation')
          ? 'relation'
          : 'expanded';
      byKey.set(candidate.sourceKey, {
        ...previous,
        matchKind,
        matchReasons: [...new Set([...previous.matchReasons, ...candidate.matchReasons])],
        matchedKeywords: [
          ...new Set([...(previous.matchedKeywords ?? []), ...(candidate.matchedKeywords ?? [])]),
        ],
      });
    }
    return [...byKey.values()];
  }, [data]);
  const allCandidateList = useMemo(() => {
    const seen = new Set<string>();
    const merged: AskCandidate[] = [];
    for (const candidate of [...displayCandidates, ...evidenceCandidates]) {
      if (seen.has(candidate.sourceKey)) continue;
      seen.add(candidate.sourceKey);
      merged.push(candidate);
    }
    return merged;
  }, [displayCandidates, evidenceCandidates]);
  const selectedCandidates = useMemo(
    () => allCandidateList.filter((candidate) => selected.has(candidate.sourceKey)),
    [allCandidateList, selected]
  );
  const selectedCount = selectedCandidates.length;
  const directCandidates = useMemo(
    () => displayCandidates.filter((candidate) => candidateGroup(candidate) === 'direct'),
    [displayCandidates]
  );
  const relationCandidates = useMemo(
    () => displayCandidates.filter((candidate) => candidateGroup(candidate) === 'relation'),
    [displayCandidates]
  );
  const expandedCandidates = useMemo(
    () => displayCandidates.filter((candidate) => candidateGroup(candidate) === 'expanded'),
    [displayCandidates]
  );
  // 入口就使用刚读到的模型状态；检索结果里的状态只在读不到设置时兜底。
  const ai = aiStatus ?? data?.ai ?? null;
  const previewCharRatio = preview
    ? Math.min(100, Math.round((preview.coverage.selectedChars / preview.coverage.maxChars) * 100))
    : 0;
  const topicScopeName = topic?.name || topicScope?.topicName || '这个主题';
  const topicScopeCount =
    topicScope?.allowedSourceCount ?? topicScope?.recordCount ?? topic?.recordCount ?? 0;

  function renderCandidate(candidate: AskCandidate) {
    const picked = selected.has(candidate.sourceKey);
    const expanded = expandedKey === candidate.sourceKey;
    const panelId = `ask-candidate-${candidate.sourceKey.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    return (
      <li
        className={`ask-candidate${picked ? ' picked' : ''}`}
        key={candidate.sourceKey}
        data-testid="ask-candidate"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a, button, input, label, summary')) return;
          toggleCandidate(candidate.sourceKey);
        }}
      >
        <label className="ask-candidate-check">
          <input
            type="checkbox"
            checked={picked}
            data-testid="ask-candidate-pick"
            aria-label={`选择${candidate.title || candidate.sourceKey}`}
            onChange={() => toggleCandidate(candidate.sourceKey)}
          />
        </label>
        <div className="ask-candidate-main">
          <div className="ask-candidate-head">
            <span className={`badge ask-type-${candidate.type}`}>
              {ASK_TYPE_LABEL[candidate.type]}
            </span>
            <span className="ask-candidate-date">
              {recordDateLabel(candidate.date, candidate.dateKind)}
            </span>
            {candidate.archived && <span className="badge">已归档</span>}
            {candidate.type === 'attempt' && candidate.state && (
              <span className={`badge state-${candidate.state}`}>{STATE_LABEL[candidate.state]}</span>
            )}
            {candidate.outcome && (
              <span className={`badge outcome-${candidate.outcome}`}>
                {OUTCOME_LABEL[candidate.outcome]}
              </span>
            )}
          </div>
          <h3 className="ask-candidate-title">
            <Link to={candidate.openHref}>{candidate.title || candidate.sourceKey}</Link>
          </h3>
          <p className="ask-candidate-snippet">
            <Highlight text={candidate.snippet} terms={data?.keywords ?? []} />
          </p>
          <div className="ask-candidate-meta">
            <span className="ask-reasons">
              命中原因：
              {(candidate.matchReasons.length > 0 ? candidate.matchReasons : ['最近记录']).map(
                (reason) => (
                  <span className="ask-reason" key={reason}>
                    {reason}
                  </span>
                )
              )}
            </span>
            {(candidate.matchedKeywords?.length ?? 0) > 0 && (
              <span className="ask-matched-keywords">
                命中词：
                {candidate.matchedKeywords!.map((term) => (
                  <span className="ask-reason expanded" key={term}>
                    {term}
                  </span>
                ))}
              </span>
            )}
            <span>引用 {candidate.referenceCount} 条</span>
            <Link className="ask-candidate-open" to={candidate.openHref}>
              打开原{candidate.type === 'attempt' ? '尝试' : '念头'} →
            </Link>
          </div>
          <div className="ask-candidate-actions">
            <button
              type="button"
              className="btn small"
              data-testid="ask-candidate-preview"
              aria-expanded={expanded}
              aria-controls={expanded ? panelId : undefined}
              onClick={() => void toggleCandidatePreview(candidate)}
            >
              {expanded ? '收起预览' : '预览原文'}
            </button>
            <Link className="btn small" to={candidate.openHref} data-testid="ask-candidate-open">
              查看原文
            </Link>
          </div>
          {expanded && (
            <div className="ask-candidate-expanded" id={panelId} data-testid="ask-candidate-expanded">
              {expandLoading ? (
                <p className="muted loading-line" role="status">
                  <span className="spinner" aria-hidden="true" /> 正在读取完整原文…
                </p>
              ) : expandError ? (
                <p className="error-msg" role="alert">
                  {expandError}
                </p>
              ) : expandedRecord ? (
                <>
                  <div className="ask-expanded-head">
                    <span className={`badge ask-type-${expandedRecord.type}`}>
                      {ASK_TYPE_LABEL[expandedRecord.type]}
                    </span>
                    {expandedRecord.archived && <span className="badge">已归档</span>}
                    {expandedRecord.state && (
                      <span className={`badge state-${expandedRecord.state}`}>
                        {STATE_LABEL[expandedRecord.state]}
                      </span>
                    )}
                    {expandedRecord.outcome && (
                      <span className={`badge outcome-${expandedRecord.outcome}`}>
                        {OUTCOME_LABEL[expandedRecord.outcome]}
                      </span>
                    )}
                    <span className="hint">
                      {expandedRecord.observedAt != null ? '结果时间' : '记录时间'}：
                      {formatTime(expandedRecord.observedAt ?? expandedRecord.createdAt)}
                    </span>
                  </div>
                  {expandedRecord.type === 'attempt' ? (
                    <>
                      {previewField('尝试步骤', expandedRecord.text)}
                      {previewField('结果', expandedRecord.resultText)}
                      {previewField('所属念头', expandedRecord.captureText)}
                    </>
                  ) : (
                    previewField('念头正文', expandedRecord.text)
                  )}
                </>
              ) : null}
            </div>
          )}
        </div>
      </li>
    );
  }

  function renderGroup(
    group: CandidateGroup,
    candidates: AskCandidate[],
    title: string,
    description: string
  ) {
    const testId =
      group === 'direct'
        ? 'ask-group-direct'
        : group === 'relation'
          ? 'ask-group-relation'
          : 'ask-group-expanded';
    return (
      <section
        className={`ask-candidate-group ${group}`}
        data-testid={testId}
        aria-label={title}
      >
        <div className="ask-group-head">
          <div>
            <h3>
              {title} <span className="ask-group-count">{candidates.length} 条</span>
            </h3>
            <p className="ask-group-hint">{description}</p>
          </div>
        </div>
        {candidates.length === 0 ? (
          <p className="ask-group-empty">
            {group === 'relation'
              ? '这次没有沿真实引用关系找到其他记录。'
              : group === 'expanded'
                ? '换词后没有找到新的记录；下面仍保留原始检索结果。'
                : '没有直接命中的记录。'}
          </p>
        ) : (
          <ul className="ask-candidate-list">{candidates.map(renderCandidate)}</ul>
        )}
      </section>
    );
  }

  return (
    <div className="page ask-page" data-testid="ask-page">
      <header className="ask-head">
        <div>
          <p className="page-kicker">知识回响 · 问我的记录</p>
          <h1 className="page-title">向过去的自己提问</h1>
          <p className="page-subtitle">
            灵感来了丢进拾念，遇到难题直接召唤存档。选依据 → 核对发送内容 → 确认生成，把规矩立住，绝不偷偷调用。
          </p>
        </div>
        <div className="ask-head-actions">
          <button type="button" className="btn small" onClick={startNewQuestion} data-testid="ask-new">
            新问题
          </button>
          <Link className="btn small" to="/settings/ai">
            AI 设置
          </Link>
        </div>
      </header>

      {topicId && (
        <section className="ask-topic-scope" aria-labelledby="ask-topic-scope-title" data-testid="ask-topic-scope">
          <div className="ask-topic-scope-main">
            <p className="page-kicker">主题范围</p>
            <h2 id="ask-topic-scope-title">
              {topicLoading ? '正在读取主题…' : topicScopeName}
            </h2>
            <p className="ask-topic-scope-text" data-testid="ask-topic-scope-text">
              范围：主题「{topicScopeName}」的 {topicScopeCount} 条记录；默认只含成员普通念头及直接尝试；
              经验依据需手动加入。
            </p>
            {topic?.exploringQuestion?.trim() && (
              <p className="hint">探索问题：{topic.exploringQuestion}</p>
            )}
            {topicError && (
              <p className="error-msg" role="alert">
                {topicError}
              </p>
            )}
          </div>
          <div className="ask-topic-scope-actions">
            {topic && (
              <Link className="btn small" to={`/topics/${topic.id}`}>
                打开主题
              </Link>
            )}
            {!scopeConfirmOpen ? (
              <button
                type="button"
                className="btn small"
                onClick={() => setScopeConfirmOpen(true)}
                data-testid="ask-scope-switch"
              >
                改为全库搜索
              </button>
            ) : (
              <div className="ask-scope-confirm" role="alertdialog" aria-label="改为全库搜索">
                <p>改为全库搜索后，候选将来自全部记录，不再受主题范围限制。确定吗？</p>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={() => void switchToAllScope()}
                    disabled={switchingScope}
                    data-testid="ask-scope-confirm"
                  >
                    {switchingScope ? '切换中…' : '确认全库搜索'}
                  </button>
                  <button type="button" className="btn small" onClick={() => setScopeConfirmOpen(false)}>
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {!topicId && scopeNotice && (
        <div className="ask-scope-all" role="status" data-testid="ask-scope-all-notice">
          {scopeNotice}
        </div>
      )}

      {includeNotice && (
        <p className="save-ok" role="status" data-testid="ask-include-notice">
          {includeNotice}
        </p>
      )}

      {ai && (!ai.configured || !ai.enabled) && (
        <div className="ask-banner warn" role="status" data-testid="ask-ai-warning">
          <strong>{!ai.configured ? 'AI 未配置' : 'AI 已停用'}</strong>
          <p>仍可检索候选、展开原文并核对预览，但不能生成回答；来源与记录浏览不受影响。</p>
          <Link className="btn small" to="/settings/ai">
            去设置 AI →
          </Link>
        </div>
      )}

      <section className="ask-form" aria-label="提问">
        <form onSubmit={submitSearch}>
          <label className="field ask-question-field" htmlFor="ask-question">
            <span>问题</span>
            <textarea
              id="ask-question"
              ref={questionRef}
              rows={3}
              maxLength={ASK_MAX_QUESTION_CHARS}
              value={question}
              placeholder="例如：我以前试过哪些办法？"
              data-testid="ask-question-input"
              aria-describedby="ask-question-count ask-range-hint"
              onChange={(e) => changeQuestion(e.target.value)}
            />
            <span className="char-count" id="ask-question-count">
              {question.length} / {ASK_MAX_QUESTION_CHARS}
            </span>
          </label>

          <div className="ask-examples" role="group" aria-label="示例问题">
            {EXAMPLE_QUESTIONS.map((item) => (
              <button
                key={item}
                type="button"
                className="ask-example"
                onClick={() => {
                  changeQuestion(item);
                  questionRef.current?.focus();
                }}
              >
                {item}
              </button>
            ))}
          </div>

          <div className="ask-fields">
            <label className="field ask-keywords-field" htmlFor="ask-keywords">
              <span>检索词（可编辑，留空表示浏览全部）</span>
              <input
                id="ask-keywords"
                ref={keywordsRef}
                type="text"
                value={keywords}
                placeholder="搜索后自动填入，也可以自己修改或清空"
                data-testid="ask-keywords-input"
                onChange={(e) => changeKeywords(e.target.value)}
              />
            </label>
            <KeywordExpansionPanel
              question={question}
              keywords={keywords}
              topicId={topicId}
              scopeHash={topicScope?.scopeHash ?? null}
              expandedKeywords={expandedKeywords}
              onApply={(terms) => void applyExpandedKeywords(terms)}
              onClear={() => void clearExpandedKeywords()}
            />
            <label className="field ask-date-field" htmlFor="ask-from-date">
              <span>起始日期（含）</span>
              <input
                id="ask-from-date"
                type="date"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => {
                  setFromDate(e.target.value);
                  resetPreview();
                }}
              />
            </label>
            <label className="field ask-date-field" htmlFor="ask-to-date">
              <span>结束日期（含当天）</span>
              <input
                id="ask-to-date"
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => {
                  setToDate(e.target.value);
                  resetPreview();
                }}
              />
            </label>
          </div>

          <div className="ask-form-actions">
            <p className="hint" id="ask-range-hint">
              日期范围可选。结束日期含当天，实际边界取结束日次日 00:00（不含次日）；日期按本机日历，
              服务端日期标签按 Asia/Shanghai。
            </p>
            <button
              type="submit"
              className="btn primary ask-search-btn"
              data-testid="ask-search-btn"
              disabled={!question.trim() || searching}
            >
              {searching ? '查找中…' : '查找记录'}
            </button>
          </div>
        </form>
        {searchError && (
          <p className="error-msg" role="alert">
            {searchError}
          </p>
        )}
      </section>

      {data && (
        <section className="ask-results" aria-labelledby="ask-results-title" aria-live="polite">
          <div className="section-head ask-results-head">
            <div>
              <h2 id="ask-results-title">候选记录</h2>
              <p className="hint">
                共命中 {data.total} 条，展示 {displayCandidates.length} 条
                {data.keywords.length > 0 ? ` · 检索词：${data.keywords.join(' ')}` : ' · 浏览全部'}
                {expandedKeywords.length > 0
                  ? ` · 扩展词：${expandedKeywords.join('、')}`
                  : ''}
              </p>
            </div>
            <span className="ask-selected-count" role="status" aria-live="polite">
              已选 {selectedCount} 条 / 最多 {ASK_MAX_RECORDS} 条
            </span>
          </div>

          {data.total === 0 ? (
            <div className="ask-empty" data-testid="ask-empty" role="status">
              <p>
                {expandedKeywords.length > 0
                  ? '换词后仍没有找到匹配的记录。'
                  : '没有找到匹配的记录。'}
              </p>
              <p className="hint">
                可以调整检索词或放宽日期范围；结束日期含当天。也可以清空筛选，浏览全部记录。
              </p>
              <div className="ask-empty-actions">
                <button type="button" className="btn" onClick={() => void browseAll()}>
                  清空筛选，浏览全部记录
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    keywordsRef.current?.focus();
                    keywordsRef.current?.select();
                  }}
                >
                  修改检索词
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="ask-selection-bar">
                <div className="ask-selection-actions">
                  <button type="button" className="link" onClick={selectAll}>
                    全选前 {ASK_MAX_RECORDS} 条
                  </button>
                  <button type="button" className="link" onClick={clearAll} disabled={selectedCount === 0}>
                    清空选择
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    data-testid="ask-preview"
                    onClick={openPreview}
                    disabled={selectedCount === 0 || previewLoading}
                  >
                    {previewLoading ? '核对中…' : '核对并准备回答'}
                  </button>
                </div>
              </div>
              {selectionNotice && <p className="hint ask-selection-notice">{selectionNotice}</p>}

              {selectedCount > 0 && (
                <ul className="ask-selected-chips" aria-label="已选择的记录">
                  {selectedCandidates.map((candidate) => (
                    <li className="ask-selected-chip" key={candidate.sourceKey}>
                      <span title={candidate.title}>{candidate.title || candidate.sourceKey}</span>
                      <button
                        type="button"
                        className="ask-chip-remove"
                        aria-label={`移除 ${candidate.title || candidate.sourceKey}`}
                        onClick={() => removeSelected(candidate.sourceKey)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {renderGroup(
                'direct',
                directCandidates,
                '直接命中',
                '标题、正文、结果或所属念头直接命中的记录。'
              )}
              {renderGroup(
                'relation',
                relationCandidates,
                '沿关系找到',
                '没有直接命中，但通过真实引用关系带出的一跳记录；模型只会在你勾选后看到它们。'
              )}
              {expandedKeywords.length > 0 &&
                renderGroup(
                  'expanded',
                  expandedCandidates,
                  '换词后找到',
                  '使用你勾选的替代词检索到的记录；每条标出实际命中的扩展词。'
                )}
              {evidenceCandidates.length > 0 && (
                <section className="ask-candidate-group evidence" aria-label="经验依据">
                  <div className="ask-group-head">
                    <div>
                      <h3>
                        经验依据 <span className="ask-group-count">{evidenceCandidates.length} 条</span>
                      </h3>
                      <p className="ask-group-hint">
                        从主题经验成员的直接原始依据手动加入；不会再展开依据里的经验或关系。
                      </p>
                    </div>
                  </div>
                  <ul className="ask-candidate-list">{evidenceCandidates.map(renderCandidate)}</ul>
                </section>
              )}
            </>
          )}
        </section>
      )}

      {topicId && (
        <section className="ask-topic-evidence" aria-labelledby="ask-topic-evidence-title" data-testid="ask-topic-evidence">
          <div className="section-head">
            <div>
              <h2 id="ask-topic-evidence-title">经验依据（需手动加入）</h2>
              <p className="hint">
                主题里的经验成员默认不发送。可以查看它们的直接原始依据并勾选加入；经验正文本身不会成为来源。
              </p>
            </div>
            <TopicEvidencePanel
              topicId={topicId}
              triggerLabel="查看经验依据"
              onAdd={(keys, sources) => {
                const added = ingestEvidenceSources(sources, true);
                setIncludeNotice(
                  `已加入 ${keys.length} 条经验依据${added > 0 ? `（新增 ${added} 条候选）` : ''}，请核对后再发送。`
                );
              }}
            />
          </div>
          {evidenceCandidates.length > 0 && (
            <p className="hint">
              已加入 {evidenceCandidates.length} 条经验依据候选；可在上方候选中取消，或点「清空选择」。
            </p>
          )}
        </section>
      )}

      {previewRequested && (
        <section
          className="ask-preview"
          data-testid="ask-preview-panel"
          aria-label="核对发送内容"
          aria-live="polite"
          ref={previewRef}
        >
          <div className="ask-preview-head">
            <div>
              <h2>核对发送内容</h2>
              <p className="hint">确认以下记录后才会发送给模型；未勾选的记录不会出现在提示词里。</p>
            </div>
            <button type="button" className="link" onClick={closePreview} disabled={creating}>
              收起核对
            </button>
          </div>

          {previewLoading && !preview && (
            <p className="muted loading-line" role="status">
              <span className="spinner" aria-hidden="true" /> 正在读取真实记录并生成预览…
            </p>
          )}

          {previewError && (
            <div className="ask-preview-error" role="alert">
              <p className="error-msg">{previewError}</p>
              {previewStale && (
                <button type="button" className="btn small" onClick={openPreview}>
                  重新核对
                </button>
              )}
            </div>
          )}

          {preview && (
            <>
              {previewLoading && (
                <p className="hint loading-line" role="status">
                  <span className="spinner" aria-hidden="true" /> 正在按新的选择重新核对…
                </p>
              )}
              <dl className="ask-preview-meta">
                <div>
                  <dt>问题</dt>
                  <dd>{preview.question}</dd>
                </div>
                <div>
                  <dt>目标模型</dt>
                  <dd>
                    {preview.config ? `${preview.config.name} · ${preview.config.modelId}` : '未配置'}
                    {!preview.ai.configured && <span className="badge warn">未配置 API Key</span>}
                    {preview.ai.configured && !preview.ai.enabled && (
                      <span className="badge warn">已停用</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>检索词</dt>
                  <dd>{preview.keywords.length > 0 ? preview.keywords.join(' ') : '浏览全部'}</dd>
                </div>
                <div>
                  <dt>日期范围</dt>
                  <dd>{previewRangeText(preview)}</dd>
                </div>
                <div>
                  <dt>将发送</dt>
                  <dd>
                    {preview.coverage.selectedRecords} 条记录 · {preview.coverage.selectedChars} 字
                  </dd>
                </div>
                <div>
                  <dt>字符上限</dt>
                  <dd>
                    {preview.coverage.selectedChars} / {preview.coverage.maxChars} 字
                  </dd>
                </div>
              </dl>

              <div className="ask-coverage" aria-hidden="true">
                <span style={{ width: `${previewCharRatio}%` }} />
              </div>
              {!preview.coverage.withinLimit && (
                <p className="error-msg" role="alert">
                  超过上限（最多 {preview.coverage.maxRecords} 条 / {preview.coverage.maxChars} 字），
                  请移除部分记录后再生成。
                </p>
              )}
              {previewStale && (
                <p className="ask-stale-hint" role="status">
                  核对后记录或配置可能有变化，请重新核对后再发送。
                </p>
              )}
              {!preview.ai.configured && (
                <p className="ask-preview-note">
                  尚未配置模型 API Key：可以继续浏览这些来源，但生成回答前需要先到
                  <Link to="/settings/ai">设置 → AI 模型</Link> 完成配置。
                </p>
              )}
              {preview.ai.configured && !preview.ai.enabled && (
                <p className="ask-preview-note">
                  AI 模型已停用：仍可浏览来源；生成前需要先到
                  <Link to="/settings/ai">设置 → AI 模型</Link> 启用。
                </p>
              )}

              <ul className="ask-preview-records">
                {preview.records.map((record) => (
                  <li className="ask-preview-record" key={record.sourceKey} data-testid="ask-preview-record">
                    <div className="ask-preview-record-head">
                      <span className={`badge ask-type-${record.type}`}>
                        {ASK_TYPE_LABEL[record.type]}
                      </span>
                      {record.archived && <span className="badge">已归档</span>}
                      {record.state && (
                        <span className={`badge state-${record.state}`}>{STATE_LABEL[record.state]}</span>
                      )}
                      {record.outcome && (
                        <span className={`badge outcome-${record.outcome}`}>
                          {OUTCOME_LABEL[record.outcome]}
                        </span>
                      )}
                      <span className="hint">
                        {record.observedAt != null ? '结果时间' : '记录时间'}：
                        {formatTime(record.observedAt ?? record.createdAt)}
                      </span>
                    </div>
                    {record.type === 'attempt' ? (
                      <>
                        {previewField('尝试步骤', record.text)}
                        {previewField('结果', record.resultText)}
                        {previewField('所属念头', record.captureText)}
                      </>
                    ) : (
                      previewField('念头正文', record.text)
                    )}
                    <div className="ask-preview-record-actions">
                      <button
                        type="button"
                        className="btn small"
                        data-testid="ask-preview-remove"
                        onClick={() => void removePreviewRecord(record.sourceKey)}
                        disabled={previewLoading || creating}
                      >
                        移除这条并重新核对
                      </button>
                    </div>
                  </li>
                ))}
              </ul>

              {createError && (
                <div className="ask-create-error" role="alert">
                  <p className="error-msg">{createError}</p>
                  {!(
                    createErrorCode === 'ai_not_configured' ||
                    createErrorCode === 'ai_disabled' ||
                    createErrorCode === 'context_changed' ||
                    createErrorCode === 'sources_unavailable'
                  ) && (
                    <p className="hint">
                      可以直接再点一次「重试发送」：同一操作会复用同一 operationId，
                      服务端只会有一条记录，不会重复调用模型生成第二份。
                    </p>
                  )}
                  {(createErrorCode === 'context_changed' ||
                    createErrorCode === 'sources_unavailable') && (
                    <button type="button" className="btn small" onClick={openPreview}>
                      重新核对
                    </button>
                  )}
                  {(createErrorCode === 'ai_not_configured' ||
                    createErrorCode === 'ai_disabled') && (
                    <Link className="btn small" to="/settings/ai">
                      去设置
                    </Link>
                  )}
                </div>
              )}

              {!sendConfirm ? (
                <div className="ask-preview-actions">
                  <button
                    type="button"
                    className="btn primary"
                    data-testid="ask-generate-btn"
                    onClick={() => setSendConfirm(true)}
                    disabled={
                      previewLoading ||
                      creating ||
                      previewStale ||
                      !preview.coverage.withinLimit ||
                      !preview.config ||
                      !preview.ai.configured ||
                      !preview.ai.enabled
                    }
                  >
                    核对无误，准备发送
                  </button>
                  <span className="hint">下一步会再次确认发送对象与记录数，不会立即调用模型。</span>
                </div>
              ) : (
                <div className="ask-confirm" role="alertdialog" aria-labelledby="ask-confirm-title">
                  <h3 id="ask-confirm-title">确认发送给模型</h3>
                  <p>
                    即将把 <strong>{preview.coverage.selectedRecords} 条记录</strong> 的完整正文发送给
                    <strong>
                      {preview.config
                        ? `「${preview.config.name}」(${preview.config.modelId})`
                        : '未配置模型'}
                    </strong>
                    ，用于生成回答，可能产生模型费用。
                  </p>
                  <p className="hint">
                    发送后可以取消等待，但已发送给模型服务的内容无法撤回；未勾选的记录不会发送。
                  </p>
                  <div className="ask-confirm-actions">
                    <button
                      type="button"
                      className="btn primary"
                      data-testid="ask-confirm-send"
                      onClick={() => void generateAnswer()}
                      disabled={creating}
                    >
                      {creating
                        ? '提交中…'
                        : createError
                          ? '重试发送（同一操作不会重复生成）'
                          : '确认发送并生成'}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setSendConfirm(false)}
                      disabled={creating}
                    >
                      返回核对
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {query && (
        <section className="ask-query" aria-label="这次提问" ref={queryRef} aria-live="polite">
          {notice && (
            <p className="save-ok" role="status">
              {notice}
            </p>
          )}

          {query.status === 'pending' && (
            <div className="ask-status-card pending" aria-live="polite">
              <div className="ask-status-head">
                <h3>
                  <span className="spinner" aria-hidden="true" /> 正在回答…
                </h3>
                <span className="badge">{ASK_STATUS_LABEL.pending}</span>
              </div>
              <p className="ask-status-question">{query.question}</p>
              <p>
                目标模型：{query.config ? `${query.config.name} · ${query.config.modelId}` : '未记录'}
              </p>
              <p>已发送 {query.sources.length} 条记录 · 状态每秒自动刷新</p>
              {pollError && <p className="error-msg">{pollError}</p>}
              {actionError && <p className="error-msg">{actionError}</p>}
              <div className="row-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void cancelQuery()}
                  disabled={cancelling || !query.canCancel}
                >
                  {cancelling ? '取消中…' : '取消等待'}
                </button>
                {pollPaused && (
                  <button
                    type="button"
                    className="btn"
                    data-testid="ask-poll-resume"
                    onClick={() => {
                      setPollPaused(false);
                      setPollError(null);
                      setPollResumeTick((tick) => tick + 1);
                    }}
                  >
                    继续刷新
                  </button>
                )}
                <Link className="btn" to={`/ask/${query.id}`}>
                  打开这次问答详情
                </Link>
              </div>
              {query.sources.length > 0 && (
                <details className="ask-pending-sources">
                  <summary>查看本次已发送的来源（{query.sources.length} 条）</summary>
                  <AskSourcesView query={query} />
                </details>
              )}
            </div>
          )}

          {query.status === 'succeeded' && query.answer && (
            <>
              <AskAnswerView key={query.id} query={query} />
              <div className="ask-query-links">
                <Link className="btn" to={`/ask/${query.id}`}>
                  查看这次问答详情 →
                </Link>
                <button type="button" className="btn" onClick={retryQuery}>
                  再问一个问题
                </button>
              </div>
            </>
          )}

          {query.status === 'succeeded' && !query.answer && (
            <div className="ask-status-card failed" role="alert">
              <h3>这次提问没有可显示的回答</h3>
              <p className="error-msg">回答内容为空或已不可用；下面仍可浏览发送时的来源记录。</p>
              <AskSourcesView query={query} />
              <div className="row-actions">
                <button type="button" className="btn" onClick={retryQuery}>
                  返回修改
                </button>
                <Link className="btn" to={`/ask/${query.id}`}>
                  查看这次问答详情
                </Link>
              </div>
            </div>
          )}

          {(query.status === 'failed' ||
            query.status === 'cancelled' ||
            query.status === 'interrupted') && (
            <div className={`ask-status-card ${query.status}`} role="alert">
              <div className="ask-status-head">
                <h3>这次提问没有完成</h3>
                <span className="badge">{ASK_STATUS_LABEL[query.status]}</span>
              </div>
              <p className="ask-status-question">{query.question}</p>
              <p>
                <strong>{askFailureText(query.errorCode, '生成失败')}</strong>
              </p>
              {query.errorMessage && <p className="gen-error-detail">{query.errorMessage}</p>}
              <p className="hint">
                问题、目标模型与发送时的来源快照仍可查看；来源正文按发送时记录展示。
              </p>
              {pollError && <p className="error-msg">{pollError}</p>}
              {actionError && <p className="error-msg">{actionError}</p>}
              <AskSourcesView query={query} />
              <div className="row-actions">
                <button type="button" className="btn primary" onClick={retryQuery}>
                  修改后重试
                </button>
                {askFailureNeedsConfig(query.errorCode) && (
                  <Link className="btn" to="/settings/ai">
                    去设置模型
                  </Link>
                )}
                <Link className="btn" to={`/ask/${query.id}`}>
                  查看这次问答详情
                </Link>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="ask-recent" aria-label="最近提问">
        <div className="section-head ask-recent-head">
          <div>
            <h2>最近提问</h2>
            <p className="hint">点问题可重新读取并回看当时的来源与回答；不会重新调用模型。</p>
          </div>
          <span className="hint">{recent?.length ?? 0} 条</span>
        </div>
        {recentLoading && !recent ? (
          <p className="muted loading-line" role="status">
            <span className="spinner" aria-hidden="true" /> 正在读取最近提问…
          </p>
        ) : recentError ? (
          <div role="alert">
            <p className="error-msg">{recentError}</p>
            <button type="button" className="btn small" onClick={() => void loadRecent()}>
              重试
            </button>
          </div>
        ) : recent && recent.length === 0 ? (
          <div className="empty-state">还没有提问记录。写下问题，检索后生成第一次问答。</div>
        ) : (
          <ul className="ask-recent-list">
            {(recent ?? []).map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="ask-recent-main"
                  data-testid="ask-recent-item"
                  onClick={() => void openHistory(item.id)}
                  disabled={historyOpening !== null}
                  aria-label={`回看：${item.question}`}
                >
                  <span className="ask-recent-top">
                    <span className="ask-recent-question">{item.question}</span>
                    <span className={`badge ask-status-${item.status}`}>
                      {ASK_STATUS_LABEL[item.status]}
                    </span>
                  </span>
                  <span className="ask-recent-summary">
                    {item.summary || (item.status === 'pending' ? '正在生成回答…' : '没有摘要')}
                  </span>
                  <span className="ask-recent-meta">
                    <span>{formatTime(item.createdAt)}</span>
                    <span>来源 {item.sourceCount} 条</span>
                    {item.deletedSourceCount > 0 && (
                      <span className="badge warn">已删除 {item.deletedSourceCount} 条</span>
                    )}
                    {item.insufficientEvidence && <span className="badge warn">证据不足</span>}
                    {historyOpening === item.id && <span className="muted">读取中…</span>}
                  </span>
                </button>
                <Link className="btn small ask-recent-open" to={`/ask/${item.id}`}>
                  详情
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
