// 拾念 SHINIAN · 「问我的记录」数据层
// 只读检索 + 发送记录快照 + 公开来源状态 + 删除清洗。
import crypto from 'node:crypto';
import { sqlite } from '../db/db';
import { errorMessageForCode, type AiErrorCode } from './aiSettings';
import {
  ASK_DEFAULT_CANDIDATES,
  ASK_MAX_CANDIDATES,
  ASK_MAX_RANGE_DAYS,
  type AskAnswer,
  type AskCandidate,
  type AskListItem,
  type AskPublic,
  type AskRange,
  type AskRecord,
  type AskSourcePublic,
  type AskSourceSnapshot,
} from './askTypes';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const INTERRUPTED_DETAIL = '服务重启，本次问答已中断，可重新提问。';
const DEFAULT_DISPLAY_TIMEZONE = 'Asia/Shanghai';

// 只放多字口语停用词；单字（我/的/了/在/时…）作为分词后的边界字符处理，
// 避免把「有效」「过程」「时间」这类内容词从中间切断。
const STOP_PHRASES = [
  '请帮我找',
  '请帮我',
  '帮我找',
  '帮我',
  '告诉我',
  '我想知道',
  '我想问',
  '想问问',
  '想问一下',
  '问一下',
  '请问',
  '找一下',
  '找找',
  '我在',
  '我以前',
  '我之前',
  '我过去',
  '我以前',
  '以前',
  '之前',
  '过去',
  '当时',
  '后来',
  '最后',
  '现在',
  '最近',
  '然后',
  '上次',
  '下次',
  '这次',
  '那次',
  '哪次',
  '哪一次',
  '哪几次',
  '哪一回',
  '哪一条',
  '哪几条',
  '哪一种',
  '哪些办法',
  '什么办法',
  '什么方法',
  '哪些',
  '哪个',
  '什么时候',
  '什么时间',
  '什么条件',
  '哪些条件',
  '什么结果',
  '结果如何',
  '效果如何',
  '是怎么回事',
  '是怎么回事',
  '怎么回事',
  '是怎么',
  '怎么样',
  '怎么处理',
  '如何处理',
  '怎么办',
  '为什么',
  '怎么',
  '如何',
  '是否',
  '有没有',
  '是不是',
  '能不能',
  '可不可以',
  '哪种',
  '哪样',
  '没用过',
  '没有用',
  '没用',
  '有效吗',
  '管用吗',
  '处理过',
  '处理',
  '比较过',
  '比较',
  '对比过',
  '对比',
  '试过',
  '尝试过',
  '尝试',
  '用过',
  '用到了',
  '用到',
  '用的是',
  '用的',
  '做过',
  '做了',
  '观察过',
  '观察',
  '发现过',
  '发现',
  '记录过',
  '记录',
  '里比较过',
  '里面',
  '这里',
  '那里',
  '的时候',
  '时候',
  '以后',
  '之后',
  '之前',
  '一次',
  '两次',
  '几次',
  '有一次',
  '办法',
  '方法',
  '结论',
  '有什么不同',
  '有什么',
  '是什么',
  '什么样',
  '什么',
  '不同',
  '区别',
  '差异',
  '原因',
  '经验',
  '过程',
  '失败',
  '成功',
  '结果',
  '条件',
  '我的',
  '你的',
  '他的',
  '她的',
  '它的',
  '我们',
  '你们',
  '他们',
  '这条',
  '那条',
  '还有',
  '以及',
  '关于',
  '可以',
  '需要',
  '一个',
  '一下',
];

const ASCII_STOP = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'is',
  'are',
  'was',
  'were',
  'what',
  'which',
  'how',
  'why',
  'did',
  'do',
  'does',
  'i',
  'my',
  'me',
]);

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function trimPhrases(text: string): string {
  let value = text;
  // 长短语优先，避免「哪些办法」先被「办法」切碎。
  for (const phrase of [...STOP_PHRASES].sort((a, b) => b.length - a.length)) {
    value = value.split(phrase).join(' ');
  }
  return value;
}

const MIXED_TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9._+-]*|[\p{Script=Han}]+/gu;
const LEADING_PARTICLES = /^[的了在我你他她它和与或把被给让向对从就都也还又而但]+/u;
const TRAILING_PARTICLES = /[的了是我你他她它和与或吗呢吧啊呀么]+$/u;
const LONG_HAN_SPLIT_RE =
  /(?:比较|对比|观察|发现|感觉|觉得|测试|尝试|使用|设置|调整|记录|出现|变成|还是|已经|可能|需要|想要|打算|准备|开始|结束|的时候|以后|之前|之后|里面|这里|那里)/u;

function cleanHanToken(value: string): string {
  return value.replace(LEADING_PARTICLES, '').replace(TRAILING_PARTICLES, '');
}

/** 长中文片段不能整段当成唯一检索词：先按常见动词/连接词切，仍过长再切成 4 字片段。 */
function splitLongHan(value: string): string[] {
  if (value.length <= 10) return [value];
  const parts = value
    .split(LONG_HAN_SPLIT_RE)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
  if (parts.length > 1) return parts;
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += 4) {
    const chunk = value.slice(i, i + 4);
    if (chunk.length >= 2) chunks.push(chunk);
  }
  return chunks;
}

function compactForCompare(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 从自然语言问题里提取 1–6 个简短、可修改的检索词。提取不到时返回空（浏览全部）。 */
export function suggestKeywordsForQuestion(question: string): string {
  const text = normalizeSpace(question);
  if (!text) return '';
  const chunks = text
    .split(/[\s，。！？、；：,.!?;:()[\]{}"“”'‘’/\\|+=~`@#$%^&*<>_-]+/u)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (term: string) => {
    const value = term.trim();
    if (value.length < 2) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(value);
  };
  const add = (term: string) => {
    const value = term.trim();
    if (!value) return;
    if (/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) {
      if (ASCII_STOP.has(value.toLowerCase())) return;
      push(value);
      return;
    }
    const cleaned = cleanHanToken(value);
    if (cleaned.length < 2) return;
    for (const part of splitLongHan(cleaned)) push(part);
  };
  for (const chunk of chunks) {
    const cleaned = trimPhrases(chunk);
    if (!cleaned.trim()) continue;
    // 中英文混写（如「PWM频率」）拆成独立检索词，避免整段成为唯一关键词。
    for (const match of cleaned.matchAll(MIXED_TOKEN_RE)) add(match[0]);
    if (terms.length >= 6) break;
  }
  let result = terms.slice(0, 6);
  // 兜底：如果仍只有一个接近整句的长中文词，拆成双字片段，绝不让整句成为唯一检索词。
  if (result.length === 1) {
    const only = result[0]!;
    const compactQuestion = compactForCompare(text);
    const compactOnly = compactForCompare(only);
    if (
      /^[\p{Script=Han}]+$/u.test(only) &&
      compactOnly.length >= 8 &&
      (compactOnly === compactQuestion || compactOnly.length >= compactQuestion.length - 2)
    ) {
      const chars = Array.from(only);
      const grams: string[] = [];
      for (let i = 0; i + 1 < chars.length; i += 2) {
        grams.push(`${chars[i]}${chars[i + 1]}`);
      }
      const deduped = [...new Set(grams)].slice(0, 6);
      if (deduped.length > 1) result = deduped;
    }
  }
  return result.join(' ');
}

export function normalizeKeywords(raw: unknown, question: string): { ok: true; value: string[] } | { ok: false } {
  if (raw !== undefined && raw !== null && typeof raw !== 'string' && !Array.isArray(raw)) {
    return { ok: false };
  }
  let text = '';
  if (Array.isArray(raw)) {
    if (raw.some((item) => typeof item !== 'string')) return { ok: false };
    text = raw.map((item) => String(item)).join(' ');
  } else if (typeof raw === 'string') {
    text = raw;
  } else {
    text = suggestKeywordsForQuestion(question);
  }
  const keywords = [...new Set(normalizeSpace(text).split(/\s+/u).map((item) => item.trim()).filter(Boolean))];
  if (keywords.join(' ').length > 200) return { ok: false };
  return { ok: true, value: keywords };
}

/**
 * 校验前端采用的扩展检索词。扩展词只作为子串检索文本，不进入 SQL 或指令。
 * 允许空数组；最多 5 项、单项 40 字、合计 120 字；去重并过滤原检索词。
 */
export function normalizeExpandedTerms(
  raw: unknown,
  currentKeywords: string[] = []
): { ok: true; value: string[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  let items: unknown[];
  if (Array.isArray(raw)) items = raw;
  else if (typeof raw === 'string') items = [raw];
  else return { ok: false, message: 'expanded 必须是字符串或字符串数组。' };
  if (items.length > 5) return { ok: false, message: '扩展检索词最多 5 项。' };
  const current = new Set(currentKeywords.map((item) => item.trim().toLowerCase()));
  const seen = new Set<string>();
  const terms: string[] = [];
  let total = 0;
  for (const item of items) {
    if (typeof item !== 'string') return { ok: false, message: '每个扩展检索词必须是字符串。' };
    const term = item.trim();
    if (!term || /[\u0000-\u001f\u007f]/u.test(term)) {
      return { ok: false, message: '扩展检索词不能为空或包含控制字符。' };
    }
    if (Array.from(term).length > 40) {
      return { ok: false, message: '每个扩展检索词不能超过 40 个字符。' };
    }
    const key = term.toLowerCase().replace(/\s+/gu, ' ');
    if (current.has(key) || seen.has(key)) continue;
    total += Array.from(term).length;
    if (total > 120) return { ok: false, message: '扩展检索词合计不能超过 120 个字符。' };
    seen.add(key);
    terms.push(term);
  }
  return { ok: true, value: terms };
}

function parseOptionalTimestamp(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

export type AskRangeParse =
  | { ok: true; range: AskRange }
  | { ok: false; error: string; message: string; field?: string };

export function parseAskRange(rawFrom: unknown, rawTo: unknown): AskRangeParse {
  const from = parseOptionalTimestamp(rawFrom);
  const to = parseOptionalTimestamp(rawTo);
  if (from === undefined) {
    return { ok: false, error: 'invalid_range', message: 'from 必须是整数毫秒时间戳。', field: 'from' };
  }
  if (to === undefined) {
    return { ok: false, error: 'invalid_range', message: 'to 必须是整数毫秒时间戳。', field: 'to' };
  }
  if ((from !== null && from <= 0) || (to !== null && to <= 0)) {
    return { ok: false, error: 'invalid_range', message: '日期范围必须大于 0。', field: 'from' };
  }
  if (from !== null && to !== null && to <= from) {
    return { ok: false, error: 'invalid_range', message: '结束日期必须晚于开始日期。', field: 'to' };
  }
  if (from !== null && from > MAX_DATE_MS) {
    return { ok: false, error: 'invalid_range', message: '开始日期超出可表示范围。', field: 'from' };
  }
  if (to !== null && to > MAX_DATE_MS) {
    return { ok: false, error: 'invalid_range', message: '结束日期超出可表示范围。', field: 'to' };
  }
  if (from !== null && to !== null && to - from > ASK_MAX_RANGE_DAYS * DAY_MS) {
    return {
      ok: false,
      error: 'invalid_range',
      message: `日期范围不能超过 ${ASK_MAX_RANGE_DAYS} 天。`,
      field: 'to',
    };
  }
  const format = (ms: number | null) => {
    if (ms === null) return null;
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: DEFAULT_DISPLAY_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  };
  return {
    ok: true,
    range: {
      from,
      to,
      fromLocal: format(from),
      toLocal: format(to),
    },
  };
}

function inRange(value: number | null, range: AskRange): boolean {
  if (value === null) return range.from === null && range.to === null;
  if (range.from !== null && value < range.from) return false;
  if (range.to !== null && value >= range.to) return false;
  return true;
}

function firstLine(text: string, max: number): string {
  const line = normalizeSpace(text.split(/\r?\n/u)[0] ?? '');
  const value = line || normalizeSpace(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function snippetAround(text: string | null, keywords: string[], max = 150): string {
  const value = normalizeSpace(text ?? '');
  if (!value) return '';
  if (keywords.length === 0) return value.length > max ? `${value.slice(0, max)}…` : value;
  const lower = value.toLowerCase();
  let best = -1;
  for (const keyword of keywords) {
    const idx = lower.indexOf(keyword.toLowerCase());
    if (idx >= 0 && (best < 0 || idx < best)) {
      best = idx;
    }
  }
  if (best < 0) return value.length > max ? `${value.slice(0, max)}…` : value;
  const before = Math.min(36, best);
  const start = Math.max(0, best - before);
  const end = Math.min(value.length, start + max);
  return `${start > 0 ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`;
}

function countHits(text: string | null, keywords: string[]): number {
  if (!text || keywords.length === 0) return 0;
  const haystack = text.toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    if (!needle) continue;
    let from = 0;
    while (from <= haystack.length) {
      const idx = haystack.indexOf(needle, from);
      if (idx < 0) break;
      hits += 1;
      from = idx + needle.length;
    }
  }
  return hits;
}

type AttemptRow = {
  id: string;
  captureId: string;
  step: string;
  state: string;
  resultText: string | null;
  outcome: string | null;
  observedAt: number | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
  captureText: string;
  captureRevision: number;
  archivedAt: number | null;
};

type CaptureRow = {
  id: string;
  rawText: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  archivedAt: number | null;
};

type ReferenceRow = {
  id: string;
  fromAttemptId: string;
  toAttemptId: string;
};

type CaptureLinkRow = {
  id: string;
  fromCaptureId: string;
  toCaptureId: string;
};

export type AskSearchScope = {
  /** 只允许这些 capture 作为念头候选，且只允许其下 attempt 作为尝试候选。 */
  captureIds: string[];
  /** 给出时进一步限制 attempt ID；空数组表示不返回任何 attempt。 */
  attemptIds?: string[];
  /** 主题范围下强制 direct，不做引用/链接一跳扩展。 */
  directOnly?: boolean;
};

export function searchAskCandidates(input: {
  question: string;
  keywords: string[];
  /** 用户明确采用后的替代检索词；为空时完全保持旧检索行为。 */
  expandedTerms?: string[];
  range: AskRange;
  limit?: number;
  scope?: AskSearchScope;
}): { total: number; candidates: AskCandidate[] } {
  const limit = Math.max(1, Math.min(ASK_MAX_CANDIDATES, input.limit ?? ASK_DEFAULT_CANDIDATES));
  const keywords = input.keywords;
  const expandedTerms = (input.expandedTerms ?? []).filter(
    (term) => !keywords.some((keyword) => keyword.toLowerCase() === term.toLowerCase())
  );
  const scope = input.scope;
  const allowedCaptures = scope ? new Set(scope.captureIds) : null;
  const allowedAttempts =
    scope && scope.attemptIds !== undefined ? new Set(scope.attemptIds) : null;
  const attempts = (
    sqlite
      .prepare(
        `SELECT a.id, a.capture_id AS captureId, a.step, a.state,
                a.result_text AS resultText, a.outcome, a.observed_at AS observedAt,
                a.created_at AS createdAt, a.updated_at AS updatedAt, a.revision,
                c.raw_text AS captureText, c.revision AS captureRevision, c.archived_at AS archivedAt
           FROM attempts a JOIN captures c ON c.id = a.capture_id
          WHERE c.kind = 'thought'
          ORDER BY a.created_at DESC`
      )
      .all() as AttemptRow[]
  ).filter(
    (row) =>
      (!allowedCaptures || allowedCaptures.has(row.captureId)) &&
      (!allowedAttempts || allowedAttempts.has(row.id))
  );
  const captures = (
    sqlite
      .prepare(
        `SELECT id, raw_text AS rawText, created_at AS createdAt, updated_at AS updatedAt,
                revision, archived_at AS archivedAt
           FROM captures WHERE kind = 'thought' ORDER BY created_at DESC`
      )
      .all() as CaptureRow[]
  ).filter((row) => !allowedCaptures || allowedCaptures.has(row.id));
  const references = scope
    ? []
    : (sqlite
        .prepare(
          'SELECT id, from_attempt_id AS fromAttemptId, to_attempt_id AS toAttemptId FROM attempt_references'
        )
        .all() as ReferenceRow[]);
  const captureLinks = scope
    ? []
    : (sqlite
        .prepare(
          'SELECT id, from_capture_id AS fromCaptureId, to_capture_id AS toCaptureId FROM capture_links'
        )
        .all() as CaptureLinkRow[]);

  // 尝试引用：保留方向，用于解释「被这次尝试引用」还是「引用了这次尝试」。
  const attemptPartners = new Map<string, Array<{ id: string; direction: 'out' | 'in' }>>();
  const referenceCount = new Map<string, number>();
  for (const ref of references) {
    if (!attemptPartners.has(ref.fromAttemptId)) attemptPartners.set(ref.fromAttemptId, []);
    if (!attemptPartners.has(ref.toAttemptId)) attemptPartners.set(ref.toAttemptId, []);
    attemptPartners.get(ref.fromAttemptId)!.push({ id: ref.toAttemptId, direction: 'out' });
    attemptPartners.get(ref.toAttemptId)!.push({ id: ref.fromAttemptId, direction: 'in' });
    referenceCount.set(ref.fromAttemptId, (referenceCount.get(ref.fromAttemptId) ?? 0) + 1);
    referenceCount.set(ref.toAttemptId, (referenceCount.get(ref.toAttemptId) ?? 0) + 1);
  }
  // 念头手动关联：有方向；读取时正链与反链都算一跳。
  const capturePartners = new Map<string, string[]>();
  for (const link of captureLinks) {
    if (!capturePartners.has(link.fromCaptureId)) capturePartners.set(link.fromCaptureId, []);
    if (!capturePartners.has(link.toCaptureId)) capturePartners.set(link.toCaptureId, []);
    capturePartners.get(link.fromCaptureId)!.push(link.toCaptureId);
    capturePartners.get(link.toCaptureId)!.push(link.fromCaptureId);
  }

  type Scored = {
    candidate: AskCandidate;
    score: number;
    date: number;
    matched: boolean;
  };
  const attemptScored = new Map<string, Scored>();
  const captureScored = new Map<string, Scored>();
  const attemptById = new Map(attempts.map((row) => [row.id, row] as const));

  const termsInText = (text: string | null, terms: string[]): string[] => {
    if (!text || terms.length === 0) return [];
    const haystack = text.toLowerCase();
    return terms.filter((term) => haystack.includes(term.toLowerCase()));
  };
  const uniqueTerms = (terms: string[]): string[] => {
    const seen = new Set<string>();
    return terms.filter((term) => {
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  for (const row of attempts) {
    const date = row.observedAt ?? row.createdAt;
    if (!inRange(date, input.range)) continue;
    const resultHits = countHits(row.resultText, keywords);
    const titleHits = countHits(row.step, keywords);
    const captureHits = countHits(row.captureText, keywords);
    const originalResultTerms = termsInText(row.resultText, keywords);
    const originalTitleTerms = termsInText(row.step, keywords);
    const originalCaptureTerms = termsInText(row.captureText, keywords);
    const expandedResultTerms = termsInText(row.resultText, expandedTerms);
    const expandedTitleTerms = termsInText(row.step, expandedTerms);
    const expandedCaptureTerms = termsInText(row.captureText, expandedTerms);
    const reasons: string[] = [];
    if (resultHits > 0) reasons.push('结果命中');
    if (titleHits > 0) reasons.push('标题命中');
    if (captureHits > 0) reasons.push('所属念头命中');
    const refCount = referenceCount.get(row.id) ?? 0;
    if (refCount > 0) reasons.push(`引用关系 ${refCount}`);
    const matchedExpanded = uniqueTerms([
      ...expandedResultTerms,
      ...expandedTitleTerms,
      ...expandedCaptureTerms,
    ]);
    for (const term of matchedExpanded) reasons.push(`扩展词命中：${term}`);
    const originalScore = resultHits * 100 + titleHits * 20 + captureHits * 5;
    const expandedScore =
      expandedResultTerms.length * 100 + expandedTitleTerms.length * 20 + expandedCaptureTerms.length * 5;
    const broad = keywords.length === 0 && expandedTerms.length === 0;
    const direct = originalScore > 0;
    const expanded = expandedScore > 0;
    if (!broad && !direct && !expanded) continue;
    if (broad && reasons.length === 0) reasons.push('最近记录');
    const snippetSource = resultHits > 0
      ? row.resultText
      : titleHits > 0
        ? row.step
        : captureHits > 0
          ? row.captureText
          : expandedResultTerms.length > 0
            ? row.resultText
            : expandedTitleTerms.length > 0
              ? row.step
              : row.captureText;
    attemptScored.set(row.id, {
      score: originalScore + expandedScore,
      date,
      matched: broad || direct || expanded,
      candidate: {
        sourceKey: `attempt:${row.id}`,
        type: 'attempt',
        id: row.id,
        captureId: row.captureId,
        title: firstLine(row.step, 100),
        snippet: snippetAround(snippetSource, [...keywords, ...expandedTerms]),
        date,
        dateKind: row.observedAt !== null ? 'observed' : 'created',
        state: row.state,
        outcome: row.outcome,
        archived: row.archivedAt !== null,
        matchReasons: reasons,
        matchKind: direct ? 'direct' : expanded ? 'expanded' : 'direct',
        matchedKeywords: uniqueTerms([
          ...originalResultTerms,
          ...originalTitleTerms,
          ...originalCaptureTerms,
          ...matchedExpanded,
        ]),
        referenceCount: refCount,
        openHref: `/attempt/${row.id}`,
      },
    });
  }

  for (const row of captures) {
    if (!inRange(row.createdAt, input.range)) continue;
    const hits = countHits(row.rawText, keywords);
    const expandedMatches = termsInText(row.rawText, expandedTerms);
    const expandedHits = expandedTerms.reduce((sum, term) => sum + countHits(row.rawText, [term]), 0);
    const broad = keywords.length === 0 && expandedTerms.length === 0;
    if (!broad && hits === 0 && expandedHits === 0) continue;
    const reasons = broad ? ['最近记录'] : [];
    if (hits > 0) reasons.push('念头命中');
    for (const term of expandedMatches) reasons.push(`扩展词命中：${term}`);
    captureScored.set(row.id, {
      score: hits * 5 + expandedHits * 5,
      date: row.createdAt,
      matched: broad || hits > 0 || expandedHits > 0,
      candidate: {
        sourceKey: `capture:${row.id}`,
        type: 'capture',
        id: row.id,
        captureId: row.id,
        title: firstLine(row.rawText, 100),
        snippet: snippetAround(row.rawText, [...keywords, ...expandedTerms]),
        date: row.createdAt,
        dateKind: 'created',
        state: null,
        outcome: null,
        archived: row.archivedAt !== null,
        matchReasons: reasons,
        matchKind: hits > 0 ? 'direct' : expandedHits > 0 ? 'expanded' : 'direct',
        matchedKeywords: uniqueTerms(termsInText(row.rawText, [...keywords, ...expandedTerms])),
        referenceCount: 0,
        openHref: `/capture/${row.id}`,
      },
    });
  }

  // 一跳扩展：只从「关键词直接命中」的锚点出发，不递归；伙伴自身命中时保持 direct。
  // 主题范围请求不加载引用/链接数据，因此不做任何主题外扩展。
  if (keywords.length > 0 && !scope) {
    const directAttemptIds = Array.from(attemptScored.values())
      .filter((item) => item.matched && item.candidate.matchKind === 'direct')
      .map((item) => item.candidate.id);
    for (const anchorId of directAttemptIds) {
      for (const partner of attemptPartners.get(anchorId) ?? []) {
        if (attemptScored.has(partner.id)) continue;
        const row = attemptById.get(partner.id);
        if (!row) continue;
        const date = row.observedAt ?? row.createdAt;
        if (!inRange(date, input.range)) continue;
        attemptScored.set(row.id, {
          score: 10,
          date,
          matched: false,
          candidate: {
            sourceKey: `attempt:${row.id}`,
            type: 'attempt',
            id: row.id,
            captureId: row.captureId,
            title: firstLine(row.step, 100),
            snippet: snippetAround(row.resultText || row.step, []),
            date,
            dateKind: row.observedAt !== null ? 'observed' : 'created',
            state: row.state,
            outcome: row.outcome,
            archived: row.archivedAt !== null,
            matchReasons:
              partner.direction === 'out'
                ? ['被这次尝试引用', '引用关系']
                : ['引用了这次尝试', '引用关系'],
            matchKind: 'relation',
            matchedKeywords: [],
            referenceCount: referenceCount.get(row.id) ?? 0,
            openHref: `/attempt/${row.id}`,
          },
        });
      }
    }

    const directCaptureIds = Array.from(captureScored.values())
      .filter((item) => item.matched && item.candidate.matchKind === 'direct')
      .map((item) => item.candidate.id);
    for (const anchorId of directCaptureIds) {
      for (const partnerId of capturePartners.get(anchorId) ?? []) {
        if (captureScored.has(partnerId)) continue;
        const row = captures.find((item) => item.id === partnerId);
        if (!row) continue;
        if (!inRange(row.createdAt, input.range)) continue;
        captureScored.set(row.id, {
          score: 10,
          date: row.createdAt,
          matched: false,
          candidate: {
            sourceKey: `capture:${row.id}`,
            type: 'capture',
            id: row.id,
            captureId: row.id,
            title: firstLine(row.rawText, 100),
            snippet: snippetAround(row.rawText, []),
            date: row.createdAt,
            dateKind: 'created',
            state: null,
            outcome: null,
            archived: row.archivedAt !== null,
            matchReasons: ['通过链接找到'],
            matchKind: 'relation',
            matchedKeywords: [],
            referenceCount: 0,
            openHref: `/capture/${row.id}`,
          },
        });
      }
    }
  }

  const all = [...attemptScored.values(), ...captureScored.values()];
  all.sort((a, b) => {
    // 原始直接命中优先；扩展词命中单独排在后面；关系扩展最后。
    const rank = (kind: AskCandidate['matchKind']) =>
      kind === 'direct' ? 0 : kind === 'expanded' ? 1 : 2;
    if (a.candidate.matchKind !== b.candidate.matchKind) {
      return rank(a.candidate.matchKind) - rank(b.candidate.matchKind);
    }
    if (b.score !== a.score) return b.score - a.score;
    if (b.date !== a.date) return b.date - a.date;
    return a.candidate.sourceKey.localeCompare(b.candidate.sourceKey);
  });
  return { total: all.length, candidates: all.slice(0, limit).map((item) => item.candidate) };
}

function parseSourceKey(key: string): { type: 'attempt' | 'capture'; id: string } | null {
  const match = /^(attempt|capture):([A-Za-z0-9._:-]+)$/u.exec(key.trim());
  if (!match) return null;
  return { type: match[1] as 'attempt' | 'capture', id: match[2]! };
}

export function normalizeSourceKeys(raw: unknown): { ok: true; keys: string[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: '请至少选择 1 条记录。' };
  }
  if (raw.length > 8) return { ok: false, message: '一次最多选择 8 条记录。' };
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, message: '来源 ID 不正确。' };
    const key = item.trim();
    if (!parseSourceKey(key)) return { ok: false, message: '来源 ID 格式不正确。' };
    if (seen.has(key)) return { ok: false, message: '来源不能重复。' };
    seen.add(key);
    keys.push(key);
  }
  return { ok: true, keys };
}

export function readAskRecords(sourceKeys: string[]): {
  records: AskRecord[];
  unavailableKeys: string[];
} {
  const records: AskRecord[] = [];
  const unavailableKeys: string[] = [];
  for (const key of sourceKeys) {
    const parsed = parseSourceKey(key);
    if (!parsed) {
      unavailableKeys.push(key);
      continue;
    }
    if (parsed.type === 'attempt') {
      const row = sqlite
        .prepare(
          `SELECT a.id, a.capture_id AS captureId, a.step, a.state,
                  a.result_text AS resultText, a.outcome, a.observed_at AS observedAt,
                  a.created_at AS createdAt, a.revision,
                  c.raw_text AS captureText, c.revision AS captureRevision,
                  c.archived_at AS archivedAt, c.kind AS captureKind
             FROM attempts a JOIN captures c ON c.id = a.capture_id
            WHERE a.id = ?`
        )
        .get(parsed.id) as
        | {
            id: string;
            captureId: string;
            step: string;
            state: string;
            resultText: string | null;
            outcome: string | null;
            observedAt: number | null;
            createdAt: number;
            revision: number;
            captureText: string;
            captureRevision: number;
            archivedAt: number | null;
            captureKind: string;
          }
        | undefined;
      if (!row || row.captureKind === 'experience') {
        unavailableKeys.push(key);
        continue;
      }
      records.push({
        sourceKey: key,
        type: 'attempt',
        id: row.id,
        captureId: row.captureId,
        title: row.step,
        text: row.step,
        resultText: row.resultText,
        outcome: row.outcome,
        state: row.state,
        observedAt: row.observedAt,
        createdAt: row.createdAt,
        revision: row.revision,
        captureRevision: row.captureRevision,
        captureText: row.captureText,
        archived: row.archivedAt !== null,
      });
      continue;
    }
    const row = sqlite
      .prepare(
        `SELECT id, raw_text AS rawText, created_at AS createdAt, revision,
                archived_at AS archivedAt, kind
           FROM captures WHERE id = ?`
      )
      .get(parsed.id) as
      | {
          id: string;
          rawText: string;
          createdAt: number;
          revision: number;
          archivedAt: number | null;
          kind: string;
        }
      | undefined;
    // 经验正文是用户/模型整理的理解，不能当作问答的事实证据。
    if (!row || row.kind === 'experience') {
      unavailableKeys.push(key);
      continue;
    }
    records.push({
      sourceKey: key,
      type: 'capture',
      id: row.id,
      captureId: row.id,
      title: row.rawText,
      text: row.rawText,
      resultText: null,
      outcome: null,
      state: null,
      observedAt: null,
      createdAt: row.createdAt,
      revision: row.revision,
      captureRevision: row.revision,
      captureText: row.rawText,
      archived: row.archivedAt !== null,
    });
  }
  records.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
  return { records, unavailableKeys };
}

export function askContextToken(input: {
  question: string;
  keywords: string[];
  range: AskRange;
  configVersion: number | null;
  records: AskRecord[];
  /** 提供时额外绑定主题 ID、主题 revision 与 scopeHash；不提供时保持旧 token 公式。 */
  topic?: { topicId: string; topicRevision: number; scopeHash: string } | null;
}): string {
  const items = [...input.records]
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))
    .map((record) => ({
      sourceKey: record.sourceKey,
      revision: record.revision,
      captureRevision: record.captureRevision,
    }));
  const payload: Record<string, unknown> = {
    question: input.question,
    keywords: input.keywords.join(' '),
    from: input.range.from,
    to: input.range.to,
    configVersion: input.configVersion,
    items,
  };
  if (input.topic) {
    payload.topicId = input.topic.topicId;
    payload.topicRevision = input.topic.topicRevision;
    payload.scopeHash = input.topic.scopeHash;
  }
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

export function sourcesSnapshotOf(records: AskRecord[]): AskSourceSnapshot[] {
  return records.map((record) => ({
    sourceKey: record.sourceKey,
    type: record.type,
    id: record.id,
    captureId: record.captureId,
    title: record.title,
    text: record.text,
    resultText: record.resultText,
    outcome: record.outcome,
    state: record.state,
    observedAt: record.observedAt,
    createdAt: record.createdAt,
    revision: record.revision,
    captureRevision: record.captureRevision,
    captureText: record.captureText,
    archived: record.archived,
  }));
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function sourceKeyCurrent(snapshot: AskSourceSnapshot): { exists: boolean; changed: boolean } {
  if (snapshot.type === 'attempt') {
    const row = sqlite
      .prepare(
        `SELECT a.revision AS attemptRevision, c.revision AS captureRevision
           FROM attempts a JOIN captures c ON c.id = a.capture_id
          WHERE a.id = ?`
      )
      .get(snapshot.id) as { attemptRevision: number; captureRevision: number } | undefined;
    if (!row) return { exists: false, changed: true };
    return {
      exists: true,
      changed:
        row.attemptRevision !== snapshot.revision ||
        row.captureRevision !== snapshot.captureRevision,
    };
  }
  const row = sqlite
    .prepare('SELECT revision FROM captures WHERE id = ?')
    .get(snapshot.id) as { revision: number } | undefined;
  if (!row) return { exists: false, changed: true };
  return { exists: true, changed: row.revision !== snapshot.revision };
}

export function publicAskSourcesOf(snapshots: AskSourceSnapshot[]): AskSourcePublic[] {
  return snapshots.map((snapshot) => {
    // 已清洗过的快照永远按已删除处理，即使理论上存在同 ID 新记录也不回显旧正文。
    const current = snapshot.deleted ? { exists: false, changed: true } : sourceKeyCurrent(snapshot);
    if (!current.exists) {
      return {
        sourceKey: snapshot.sourceKey,
        type: snapshot.type,
        id: snapshot.id,
        captureId: snapshot.captureId,
        title: '来源已删除',
        text: null,
        resultText: null,
        outcome: null,
        state: null,
        observedAt: null,
        createdAt: null,
        archived: false,
        exists: false,
        changed: true,
        deleted: true,
        openHref: null,
        graphHref: null,
        canReuse: false,
      };
    }
    return {
      sourceKey: snapshot.sourceKey,
      type: snapshot.type,
      id: snapshot.id,
      captureId: snapshot.captureId,
      title: snapshot.title,
      text: snapshot.text,
      resultText: snapshot.resultText,
      outcome: snapshot.outcome,
      state: snapshot.state,
      observedAt: snapshot.observedAt,
      createdAt: snapshot.createdAt,
      archived: snapshot.archived,
      exists: true,
      changed: current.changed,
      deleted: false,
      openHref:
        snapshot.type === 'attempt'
          ? `/attempt/${encodeURIComponent(snapshot.id)}`
          : `/capture/${encodeURIComponent(snapshot.id)}`,
      graphHref: `/graph?node=${encodeURIComponent(snapshot.sourceKey)}`,
      canReuse: snapshot.type === 'attempt' && Boolean(snapshot.resultText?.trim()),
    };
  });
}

/** 公开问答：来源正文以发送时快照展示；被删除的来源不回显任何正文。 */
export function publicAskOf(row: {
  id: string;
  question: string;
  keywords: string;
  rangeFrom: number | null;
  rangeTo: number | null;
  status: string;
  answerJson: string | null;
  sourcesJson: string | null;
  configId: string | null;
  configVersion: number | null;
  configName: string | null;
  modelId: string | null;
  usageJson: string | null;
  durationMs: number | null;
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}): AskPublic {
  const snapshots = parseJson<AskSourceSnapshot[]>(row.sourcesJson) ?? [];
  const sources = publicAskSourcesOf(snapshots);
  const storedAnswer = parseJson<AskAnswer>(row.answerJson);
  const accessible = new Set(sources.filter((source) => source.exists).map((source) => source.sourceKey));
  let hiddenPointCount = 0;
  let answer: AskAnswer | null = null;
  if (storedAnswer) {
    const points = storedAnswer.points.filter((point) => {
      const visible = point.sourceIds.some((id) => accessible.has(id));
      if (!visible) hiddenPointCount += 1;
      return visible;
    });
    const contradictions = storedAnswer.contradictions.filter((item) => {
      const visible = item.sides.some((side) => accessible.has(side.sourceId));
      if (!visible) hiddenPointCount += 1;
      return visible;
    });
    answer = { ...storedAnswer, points, contradictions };
  }
  const deletedCount = sources.filter((source) => source.deleted).length;
  const range: AskRange = {
    from: row.rangeFrom,
    to: row.rangeTo,
    fromLocal: null,
    toLocal: null,
  };
  return {
    id: row.id,
    question: row.question,
    keywords: row.keywords ? row.keywords.split(/\s+/u).filter(Boolean) : [],
    range,
    status: row.status as AskPublic['status'],
    answer,
    sources,
    config:
      row.configId && row.configVersion !== null && row.configName && row.modelId
        ? {
            id: row.configId,
            name: row.configName,
            modelId: row.modelId,
            configVersion: row.configVersion,
          }
        : null,
    usage: parseJson<{ inputTokens: number; outputTokens: number; totalTokens: number }>(
      row.usageJson
    ),
    durationMs: row.durationMs,
    errorCode: row.errorCode,
    errorMessage: row.errorCode
      ? (row.errorDetail ?? errorMessageForCode(row.errorCode as AiErrorCode))
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    answerInvalidated: deletedCount > 0,
    answerInvalidReason:
      deletedCount > 0 ? '部分来源记录已删除，相关来源正文不再展示。' : null,
    hiddenPointCount,
    canCancel: row.status === 'pending',
  };
}

export function askListItemOf(row: Parameters<typeof publicAskOf>[0]): AskListItem {
  const pub = publicAskOf(row);
  return {
    id: pub.id,
    question: pub.question,
    status: pub.status,
    createdAt: pub.createdAt,
    finishedAt: pub.finishedAt,
    summary: pub.answer?.summary ?? null,
    sourceCount: pub.sources.length,
    deletedSourceCount: pub.sources.filter((source) => source.deleted).length,
    insufficientEvidence: pub.answer?.insufficientEvidence ?? false,
  };
}

export function markInterruptedAskQueries(): number {
  const t = Date.now();
  const result = sqlite
    .prepare(
      `UPDATE record_queries
          SET status = 'interrupted', error_code = 'interrupted', error_detail = ?,
              finished_at = ?, updated_at = ?
        WHERE status = 'pending'`
    )
    .run(INTERRUPTED_DETAIL, t, t);
  return result.changes;
}

/** 删除 Attempt 前清洗问答来源快照，只保留不可读的 ID。 */
export function invalidateAskSourcesForDeletedAttempts(attemptIds: string[]): number {
  const targets = new Set(attemptIds.filter(Boolean));
  if (targets.size === 0) return 0;
  return invalidateAskSources((snapshot) =>
    snapshot.type === 'attempt' ? targets.has(snapshot.id) : targets.has(snapshot.captureId)
  );
}

/** 删除念头前清洗问答来源快照（含其尝试来源）。 */
export function invalidateAskSourcesForDeletedCapture(captureId: string): number {
  if (!captureId) return 0;
  return invalidateAskSources(
    (snapshot) => snapshot.captureId === captureId || (snapshot.type === 'capture' && snapshot.id === captureId)
  );
}

function invalidateAskSources(predicate: (snapshot: AskSourceSnapshot) => boolean): number {
  const rows = sqlite
    .prepare('SELECT id, sources_json AS sourcesJson FROM record_queries WHERE sources_json IS NOT NULL')
    .all() as Array<{ id: string; sourcesJson: string }>;
  const update = sqlite.prepare(
    'UPDATE record_queries SET sources_json = ?, updated_at = ? WHERE id = ?'
  );
  let changed = 0;
  const now = Date.now();
  for (const row of rows) {
    const snapshots = parseJson<AskSourceSnapshot[]>(row.sourcesJson);
    if (!Array.isArray(snapshots)) continue;
    let touched = false;
    const next = snapshots.map((snapshot) => {
      if (!snapshot || !predicate(snapshot)) return snapshot;
      touched = true;
      return {
        sourceKey: snapshot.sourceKey,
        type: snapshot.type,
        id: snapshot.id,
        captureId: snapshot.captureId,
        title: '来源已删除',
        text: '',
        resultText: null,
        outcome: null,
        state: null,
        observedAt: null,
        createdAt: null,
        revision: snapshot.revision,
        captureRevision: snapshot.captureRevision,
        captureText: '',
        archived: false,
        deleted: true,
      } satisfies AskSourceSnapshot;
    });
    if (!touched) continue;
    update.run(JSON.stringify(next), now, row.id);
    changed += 1;
  }
  return changed;
}
