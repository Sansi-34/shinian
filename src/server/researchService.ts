import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/db';
import {
  attempts,
  researchRuns,
  type ResearchRun,
  type ResearchSourceRow,
} from '../db/schema';
import {
  classifyError,
  decryptApiKey,
  errorMessageForCode,
  getSettingsRow,
  type AiErrorCode,
} from './aiSettings';
import { callModel } from './aiProvider';
import {
  GithubApiError,
  cleanRepoDescription,
  createGithubMeter,
  getRepository,
  parseRepoReference,
  readRepositoryDetail,
  repoMetaExcerpt,
  searchRepositories,
  type GithubMeter,
  type RepoCandidate,
  type RepoCandidateFailure,
  type RepoDetail,
} from './githubClient';
import { readGithubToken } from './githubSettings';
import {
  RESEARCH_SYSTEM_PROMPT,
  buildResearchUserPrompt,
  parseResearchOutput,
  type ResearchConstraints,
  type ResearchSourceForPrompt,
} from './researchPrompt';

export const RESEARCH_LIMITS = {
  maxCandidates: 10,
  maxSelected: 3,
  maxRepoInputs: 10,
  maxQuestionChars: 1000,
  maxConstraintChars: 200,
  maxReadmeChars: 4000,
  maxReleaseChars: 1000,
  maxPromptChars: 40_000,
  concurrency: 2,
  githubTimeoutMs: Number.parseInt(process.env.SHINIAN_RESEARCH_GITHUB_TIMEOUT_MS ?? '', 10) || 15_000,
  githubRetries: 1,
  modelTimeoutMs: Number.parseInt(process.env.SHINIAN_RESEARCH_MODEL_TIMEOUT_MS ?? '', 10) || 60_000,
  modelMaxOutputTokens: 1600,
  maxActiveRuns: 2,
} as const;

export const RESEARCH_ERROR_LABEL: Record<string, string> = {
  rate_limited: 'GitHub 请求额度已用完',
  timeout: '请求超时',
  not_found: 'GitHub 资源不存在（404）',
  auth: 'GitHub Token 认证失败',
  forbidden: 'GitHub 拒绝了请求',
  unreachable: 'GitHub 地址不可达',
  invalid_response: 'GitHub 响应格式不支持',
  invalid_repo: '仓库地址不合法',
  cancelled: '已取消',
  interrupted: '服务重启中断',
  no_candidates: '没有找到可用仓库',
  all_repos_failed: '所选仓库均读取失败',
  ai_not_configured: '未配置 AI 模型',
  ai_disabled: 'AI 模型已停用',
  ai_failed: '模型生成失败',
  sources_changed: '研究资料已变化',
  version_conflict: '研究版本已变化',
  operation_key_conflict: '操作冲突，请重试',
  research_not_found: '研究不存在',
  experiment_not_found: '小实验建议不存在',
  not_adoptable: '这次研究暂时不能采用',
};

export type ResearchStatus =
  | 'searching'
  | 'candidates'
  | 'fetching'
  | 'generating'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type ResearchSearchInput =
  | { mode: 'keyword'; query: string; repos: [] }
  | { mode: 'repositories'; query: null; repos: string[] };

export type ResearchConstraintsInput = ResearchConstraints;

const ACTIVE_STATUSES: ResearchStatus[] = ['searching', 'fetching', 'generating'];

const runningRuns = new Map<string, AbortController>();

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function fingerprint(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

/** better-sqlite3 直查返回 snake_case，统一转成 drizzle 的 camelCase 形状。 */
function camelizeRow<T>(row: Record<string, unknown> | undefined): T | undefined {
  if (!row) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
  }
  return out as T;
}

function camelizeRows<T>(rows: Array<Record<string, unknown>>): T[] {
  return rows.map((row) => camelizeRow<T>(row)!).filter(Boolean);
}

function now(): number {
  return Date.now();
}

function normalizeConstraint(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, RESEARCH_LIMITS.maxConstraintChars);
}

export function normalizeConstraints(raw: unknown): ResearchConstraints {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    goal: normalizeConstraint(source.goal),
    environment: normalizeConstraint(source.environment),
    language: normalizeConstraint(source.language),
    timeBudget: normalizeConstraint(source.timeBudget),
    requirements: normalizeConstraint(source.requirements),
  };
}

export type NormalizeSearchResult =
  | { ok: true; search: ResearchSearchInput; display: string }
  | { ok: false; field: string; message: string };

export function normalizeSearchInput(raw: unknown): NormalizeSearchResult {
  const value = (raw ?? {}) as Record<string, unknown>;
  const mode = value.mode === 'repositories' ? 'repositories' : 'keyword';
  if (mode === 'keyword') {
    const query = typeof value.query === 'string' ? value.query.trim() : '';
    if (query.length < 1) {
      return { ok: false, field: 'query', message: '请填写 GitHub 检索词。' };
    }
    if (query.length > 256) {
      return { ok: false, field: 'query', message: '检索词不能超过 256 个字符。' };
    }
    if (/\n/.test(query)) {
      return { ok: false, field: 'query', message: '检索词不能包含换行。' };
    }
    return {
      ok: true,
      search: { mode: 'keyword', query, repos: [] },
      display: `GitHub 搜索：${query}`,
    };
  }
  if (!Array.isArray(value.repos)) {
    return { ok: false, field: 'repos', message: '仓库地址必须是列表。' };
  }
  if (value.repos.length === 0) {
    return { ok: false, field: 'repos', message: '请至少填写一个仓库地址。' };
  }
  if (value.repos.length > RESEARCH_LIMITS.maxRepoInputs) {
    return {
      ok: false,
      field: 'repos',
      message: `最多填写 ${RESEARCH_LIMITS.maxRepoInputs} 个仓库地址。`,
    };
  }
  const repos: string[] = [];
  for (const item of value.repos) {
    if (typeof item !== 'string') {
      return { ok: false, field: 'repos', message: '仓库地址格式不正确。' };
    }
    if (!item.trim()) continue;
    const parsed = parseRepoReference(item);
    if (!parsed.ok) {
      return { ok: false, field: 'repos', message: `${item.trim()}：${parsed.message}` };
    }
    if (!repos.includes(parsed.fullName)) repos.push(parsed.fullName);
  }
  if (repos.length === 0) {
    return { ok: false, field: 'repos', message: '请至少填写一个有效的仓库地址。' };
  }
  return {
    ok: true,
    search: { mode: 'repositories', query: null, repos },
    display: `直接读取：${repos.join('、')}`,
  };
}

export function normalizeQuestion(raw: unknown, captureText: string): { ok: true; value: string } | { ok: false; message: string } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const value = text || captureText.trim();
  if (!value) return { ok: false, message: '请填写研究问题。' };
  if (value.length > RESEARCH_LIMITS.maxQuestionChars) {
    return { ok: false, message: `研究问题不能超过 ${RESEARCH_LIMITS.maxQuestionChars} 个字符。` };
  }
  return { ok: true, value };
}

export function researchContextToken(input: {
  captureId: string;
  captureRevision: number;
  question: string;
  constraints: ResearchConstraints;
  search: ResearchSearchInput;
  configVersion: number | null;
}): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        captureId: input.captureId,
        captureRevision: input.captureRevision,
        question: input.question,
        constraints: input.constraints,
        mode: input.search.mode,
        query: input.search.query,
        repos: input.search.repos,
        configVersion: input.configVersion,
      }),
      'utf8'
    )
    .digest('hex');
}

export function limitsPublic() {
  return {
    maxCandidates: RESEARCH_LIMITS.maxCandidates,
    maxSelected: RESEARCH_LIMITS.maxSelected,
    maxRepoInputs: RESEARCH_LIMITS.maxRepoInputs,
    maxQuestionChars: RESEARCH_LIMITS.maxQuestionChars,
    maxConstraintChars: RESEARCH_LIMITS.maxConstraintChars,
    maxReadmeChars: RESEARCH_LIMITS.maxReadmeChars,
    maxPromptChars: RESEARCH_LIMITS.maxPromptChars,
    concurrency: RESEARCH_LIMITS.concurrency,
    githubTimeoutMs: RESEARCH_LIMITS.githubTimeoutMs,
    githubRetries: RESEARCH_LIMITS.githubRetries,
    modelTimeoutMs: RESEARCH_LIMITS.modelTimeoutMs,
    modelMaxOutputTokens: RESEARCH_LIMITS.modelMaxOutputTokens,
  };
}

type StoredCandidates = {
  items: RepoCandidate[];
  failures: RepoCandidateFailure[];
  fetchedAt: number;
  total: number | null;
  incomplete: boolean;
  rate: { limit: number | null; remaining: number | null; resetAt: number | null } | null;
};

type StoredStats = {
  github: GithubMeter | null;
  candidates: number;
  selected: number;
  sourceCount: number;
  sourcesSent: number;
  failedRepos: number;
  missingSources: number;
  promptChars: number;
};

type StoredFailed = Omit<RepoCandidateFailure, 'code'> & { code: string; kind?: 'repo' | 'generation' };

export type ResearchSourcePublic = {
  sourceKey: string;
  repoFullName: string;
  repoId: string;
  kind: string;
  url: string;
  filePath: string | null;
  refName: string | null;
  commitSha: string | null;
  excerpt: string;
  fetchedAt: number;
  status: string;
  errorCode: string | null;
  errorDetail: string | null;
};

export type ResearchAttemptLink = {
  attemptId: string;
  experimentIndex: number;
  title: string;
  state: string;
  createdAt: number;
};

export type ResearchPublic = {
  id: string;
  captureId: string;
  captureRevision: number;
  captureText: string;
  question: string;
  constraints: ResearchConstraints | null;
  search: { mode: string; query: string | null; repos: string[]; display: string };
  status: ResearchStatus;
  revision: number;
  savedAt: number | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  limits: ReturnType<typeof limitsPublic>;
  candidates: RepoCandidate[];
  candidateFailures: RepoCandidateFailure[];
  candidatesFetchedAt: number | null;
  candidatesTotal: number | null;
  candidatesRate: { limit: number | null; remaining: number | null; resetAt: number | null } | null;
  selectedCandidateIds: string[];
  sources: ResearchSourcePublic[];
  result: ReturnType<typeof parseJson>;
  config: {
    id: string | null;
    name: string | null;
    modelId: string | null;
    version: number | null;
  };
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  durationMs: number | null;
  stats: StoredStats | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorDetail: string | null;
  failed: StoredFailed[];
  attempts: ResearchAttemptLink[];
  sentSourceIds: string[];
  canCancel: boolean;
  canSave: boolean;
  canSelect: boolean;
  canRetrySearch: boolean;
  canRetryFetch: boolean;
  canRetryGenerate: boolean;
  saved: boolean;
};

function sourcePublic(row: ResearchSourceRow): ResearchSourcePublic {
  return {
    sourceKey: row.sourceKey,
    repoFullName: row.repoFullName,
    repoId: row.repoId,
    kind: row.kind,
    url: row.url,
    filePath: row.filePath,
    refName: row.refName,
    commitSha: row.commitSha,
    excerpt: row.excerpt,
    fetchedAt: row.fetchedAt,
    status: row.status,
    errorCode: row.errorCode,
    errorDetail: row.errorDetail,
  };
}

function attemptLinksFor(researchId: string): ResearchAttemptLink[] {
  const rows = sqlite
    .prepare(
      `SELECT id, step, state, created_at AS createdAt, source_research_experiment_index AS idx
         FROM attempts
        WHERE source_research_id = ?
        ORDER BY created_at ASC`
    )
    .all(researchId) as Array<{ id: string; step: string; state: string; createdAt: number; idx: number | null }>;
  return rows
    .filter((row) => row.idx !== null)
    .map((row) => ({
      attemptId: row.id,
      experimentIndex: row.idx as number,
      title: row.step,
      state: row.state,
      createdAt: row.createdAt,
    }));
}

export function publicResearchOf(row: ResearchRun): ResearchPublic {
  const stored = parseJson<StoredCandidates>(row.candidatesJson);
  const constraints = parseJson<ResearchConstraints>(row.constraintsJson);
  const result = parseJson<unknown>(row.resultJson);
  const stats = parseJson<StoredStats>(row.statsJson);
  const failed = parseJson<StoredFailed[]>(row.failedJson) ?? [];
  const selected = parseJson<string[]>(row.selectedCandidateIdsJson) ?? [];
  const sent = parseJson<string[]>(row.sentSourceIdsJson) ?? [];
  const sources = camelizeRows<ResearchSourceRow>(
    sqlite
      .prepare('SELECT * FROM research_sources WHERE research_id = ? ORDER BY rowid ASC')
      .all(row.id) as Array<Record<string, unknown>>
  ).map((raw) => sourcePublic(raw));
  const mode = row.searchMode;
  const repos = parseJson<string[]>(row.repoInputsJson) ?? [];
  const display =
    mode === 'repositories'
      ? `直接读取：${repos.join('、')}`
      : `GitHub 搜索：${row.searchQuery ?? ''}`;
  const status = row.status as ResearchStatus;
  const hasSources = sources.length > 0;
  return {
    id: row.id,
    captureId: row.captureId,
    captureRevision: row.captureRevision,
    captureText: row.captureText,
    question: row.question,
    constraints,
    search: { mode, query: row.searchQuery, repos, display },
    status,
    revision: row.revision,
    savedAt: row.savedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    limits: limitsPublic(),
    candidates: (stored?.items ?? []).map((item) => ({
      ...item,
      description: cleanRepoDescription(item.description),
    })),
    candidateFailures: stored?.failures ?? [],
    candidatesFetchedAt: stored?.fetchedAt ?? null,
    candidatesTotal: stored?.total ?? null,
    candidatesRate: stored?.rate ?? null,
    selectedCandidateIds: selected,
    sources,
    result,
    config: {
      id: row.configId,
      name: row.configName,
      modelId: row.modelId,
      version: row.configVersion,
    },
    usage: parseJson(row.usageJson),
    durationMs: row.durationMs,
    stats,
    errorCode: row.errorCode,
    errorMessage: row.errorCode
      ? RESEARCH_ERROR_LABEL[row.errorCode] ??
        errorMessageForCode(row.errorCode as AiErrorCode)
      : null,
    errorDetail: row.errorDetail,
    failed,
    attempts: attemptLinksFor(row.id),
    sentSourceIds: sent,
    canCancel: ACTIVE_STATUSES.includes(status),
    canSave: status === 'succeeded' && Boolean(row.resultJson),
    canSelect: status === 'candidates' && (stored?.items.length ?? 0) > 0,
    canRetrySearch:
      (status === 'failed' && (stored?.items.length ?? 0) === 0) ||
      status === 'cancelled' ||
      status === 'interrupted',
    canRetryFetch:
      (status === 'failed' && selected.length > 0 && !result) ||
      (status === 'succeeded' &&
        row.savedAt === null &&
        selected.length > 0 &&
        sources.some((source) => source.status !== 'ok')),
    canRetryGenerate:
      status === 'failed' &&
      hasSources &&
      Boolean(row.errorCode) &&
      ['ai_not_configured', 'ai_disabled', 'ai_failed', 'invalid_response'].includes(row.errorCode ?? ''),
    saved: row.savedAt !== null,
  };
}

export async function getResearchRow(id: string): Promise<ResearchRun | undefined> {
  const rows = await db.select().from(researchRuns).where(eq(researchRuns.id, id)).limit(1);
  return rows[0];
}

/** 服务启动：未完成的研究任务 → interrupted。 */
export function markInterruptedResearch(): number {
  const t = now();
  const result = sqlite
    .prepare(
      `UPDATE research_runs
          SET status = 'interrupted', error_code = 'interrupted',
              error_detail = '服务重启，本次研究已中断，可重新检索或重试。',
              finished_at = ?, updated_at = ?
        WHERE status IN ('searching','fetching','generating')`
    )
    .run(t, t);
  return result.changes;
}

function conditionalStatus(
  runId: string,
  fromStatuses: ResearchStatus[],
  status: ResearchStatus,
  fields: Record<string, unknown> = {}
): boolean {
  const sets: string[] = ['status = ?', 'updated_at = ?'];
  const values: unknown[] = [status, now()];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(value);
  }
  const placeholders = fromStatuses.map(() => '?').join(',');
  const result = sqlite
    .prepare(`UPDATE research_runs SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders})`)
    .run(...values, runId, ...fromStatuses);
  if (result.changes !== 1) return false;
  sqlite
    .prepare('UPDATE research_runs SET revision = revision + 1 WHERE id = ?')
    .run(runId);
  return true;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await fn(items[current]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function githubDetailFromError(error: unknown): { code: string; detail: string; status: number | null; resetAt: number | null } {
  if (error instanceof GithubApiError) {
    return {
      code: error.code,
      detail: error.detail,
      status: error.status,
      resetAt: error.resetAt,
    };
  }
  return {
    code: 'unreachable',
    detail: error instanceof Error ? error.message.slice(0, 300) : '未知错误',
    status: null,
    resetAt: null,
  };
}

function nextSourceKey(existing: ResearchSourceRow[]): number {
  let max = 0;
  for (const row of existing) {
    const match = /^src-(\d+)$/.exec(row.sourceKey);
    if (match) max = Math.max(max, Number.parseInt(match[1]!, 10));
  }
  return max + 1;
}

const MAX_RUNNING = RESEARCH_LIMITS.maxActiveRuns;

async function ensureConcurrency(): Promise<boolean> {
  const count = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM research_runs WHERE status IN ('searching','fetching','generating')`
      )
      .get() as { c: number }
  ).c;
  return count < MAX_RUNNING;
}

async function runSearch(fastify: FastifyInstance, runId: string): Promise<void> {
  const run = await getResearchRow(runId);
  if (!run || run.status !== 'searching') return;
  const controller = new AbortController();
  runningRuns.set(runId, controller);
  const meter = createGithubMeter();
  let token = '';
  try {
    token = await readGithubToken();
    const mode = run.searchMode;
    const failures: RepoCandidateFailure[] = [];
    let candidates: RepoCandidate[] = [];
    let total: number | null = null;
    let incomplete = false;
    let rate: StoredCandidates['rate'] = null;

    if (mode === 'repositories') {
      const repos = parseJson<string[]>(run.repoInputsJson) ?? [];
      const results = await mapLimit(repos, RESEARCH_LIMITS.concurrency, async (repo) => {
        if (controller.signal.aborted) return null;
        try {
          const parsed = parseRepoReference(repo);
          if (!parsed.ok) throw new GithubApiError('invalid_repo', parsed.message);
          const { candidate, rate: repoRate } = await getRepository(parsed.owner, parsed.name, {
            token,
            signal: controller.signal,
            timeoutMs: RESEARCH_LIMITS.githubTimeoutMs,
            retries: RESEARCH_LIMITS.githubRetries,
            meter,
            category: 'search',
          });
          return { candidate, rate: repoRate };
        } catch (error) {
          const detail = githubDetailFromError(error);
          failures.push({
            id: repo,
            fullName: repo,
            input: repo,
            code: detail.code as RepoCandidateFailure['code'],
            detail: detail.detail,
            status: detail.status,
            resetAt: detail.resetAt,
            fetchedAt: now(),
          });
          return null;
        }
      });
      for (const result of results) {
        if (!result) continue;
        candidates.push(result.candidate);
        rate = result.rate;
      }
      total = candidates.length + failures.length;
    } else {
      try {
        const search = await searchRepositories(run.searchQuery ?? '', {
          token,
          signal: controller.signal,
          timeoutMs: RESEARCH_LIMITS.githubTimeoutMs,
          retries: RESEARCH_LIMITS.githubRetries,
          meter,
          perPage: RESEARCH_LIMITS.maxCandidates,
        });
        candidates = search.candidates.slice(0, RESEARCH_LIMITS.maxCandidates);
        total = search.total;
        incomplete = search.incomplete;
        rate = search.rate;
      } catch (error) {
        const detail = githubDetailFromError(error);
        failures.push({
          id: 'search',
          fullName: null,
          input: run.searchQuery ?? '',
          code: detail.code as RepoCandidateFailure['code'],
          detail: detail.detail,
          status: detail.status,
          resetAt: detail.resetAt,
          fetchedAt: now(),
        });
      }
    }

    if (controller.signal.aborted) return;

    const stored: StoredCandidates = {
      items: candidates,
      failures,
      fetchedAt: now(),
      total,
      incomplete,
      rate,
    };
    const firstFailure = failures.find((item) => item.fullName !== null) ?? failures[0];
    const noCandidates = candidates.length === 0;
    const status: ResearchStatus = noCandidates ? 'failed' : 'candidates';
    const fields: Record<string, unknown> = {
      candidates_json: JSON.stringify(stored),
      failed_json: JSON.stringify(failures.map((item) => ({ ...item, kind: 'repo' }))),
      stats_json: JSON.stringify({
        github: meter,
        candidates: candidates.length,
        selected: 0,
        sourceCount: 0,
        sourcesSent: 0,
        failedRepos: failures.length,
        missingSources: 0,
        promptChars: 0,
      } satisfies StoredStats),
      finished_at: noCandidates ? now() : null,
      error_code: noCandidates ? firstFailure?.code ?? 'no_candidates' : null,
      error_detail: noCandidates ? firstFailure?.detail ?? '没有找到可用仓库。' : null,
    };
    conditionalStatus(runId, ['searching'], status, fields);
  } catch (error) {
    if (controller.signal.aborted) return;
    const detail = githubDetailFromError(error);
    conditionalStatus(runId, ['searching'], 'failed', {
      error_code: detail.code,
      error_detail: detail.detail,
      finished_at: now(),
      failed_json: JSON.stringify([
        {
          id: 'search',
          fullName: null,
          input: run.searchQuery ?? '',
          code: detail.code,
          detail: detail.detail,
          status: detail.status,
          resetAt: detail.resetAt,
          fetchedAt: now(),
          kind: 'repo',
        },
      ]),
    });
    fastify.log.info({ researchId: runId, errorCode: detail.code }, '研究检索未成功');
  } finally {
    runningRuns.delete(runId);
  }
}

type RepoBundle = {
  repo: string;
  detail: RepoDetail | null;
  failure: (Omit<RepoCandidateFailure, 'code'> & { code: string }) | null;
};

async function readRepoBundle(
  repo: string,
  token: string,
  signal: AbortSignal,
  meter: GithubMeter
): Promise<RepoBundle> {
  const parsed = parseRepoReference(repo);
  if (!parsed.ok) {
    return {
      repo,
      detail: null,
      failure: {
        id: repo,
        fullName: repo,
        input: repo,
        code: 'invalid_repo',
        detail: parsed.message,
        status: null,
        resetAt: null,
        fetchedAt: now(),
      },
    };
  }
  try {
    const detail = await readRepositoryDetail(parsed.owner, parsed.name, {
      token,
      signal,
      timeoutMs: RESEARCH_LIMITS.githubTimeoutMs,
      retries: RESEARCH_LIMITS.githubRetries,
      meter,
      maxReadmeChars: RESEARCH_LIMITS.maxReadmeChars,
      maxReleaseChars: RESEARCH_LIMITS.maxReleaseChars,
    });
    return { repo, detail, failure: null };
  } catch (error) {
    const info = githubDetailFromError(error);
    return {
      repo,
      detail: null,
      failure: {
        id: repo,
        fullName: repo,
        input: repo,
        code: info.code,
        detail: info.detail,
        status: info.status,
        resetAt: info.resetAt,
        fetchedAt: now(),
      },
    };
  }
}

function insertSourceRows(
  researchId: string,
  bundle: RepoBundle,
  startKey: number,
  fetchedAt: number
): { rows: ResearchSourceRow[]; nextKey: number } {
  const rows: ResearchSourceRow[] = [];
  const repoFullName = bundle.repo;
  if (!bundle.detail) {
    rows.push({
      id: `rsrc-${now()}-${Math.random().toString(36).slice(2, 8)}`,
      researchId,
      sourceKey: `src-${startKey}`,
      repoId: repoFullName,
      repoFullName,
      kind: 'repo_meta',
      url: `https://github.com/${repoFullName}`,
      filePath: null,
      refName: null,
      commitSha: null,
      excerpt: '',
      fetchedAt,
      status: 'failed',
      errorCode: bundle.failure?.code ?? 'unreachable',
      errorDetail: bundle.failure?.detail ?? '仓库读取失败。',
    });
    return { rows, nextKey: startKey + 1 };
  }
  const detail = bundle.detail;
  const candidate = detail.candidate;
  let key = startKey;
  const push = (row: Omit<ResearchSourceRow, 'id' | 'researchId' | 'sourceKey'>) => {
    rows.push({
      id: `rsrc-${now()}-${Math.random().toString(36).slice(2, 8)}`,
      researchId,
      sourceKey: `src-${key}`,
      ...row,
    });
    key += 1;
  };
  push({
    repoId: candidate.fullName,
    repoFullName: candidate.fullName,
    kind: 'repo_meta',
    url: candidate.htmlUrl,
    filePath: null,
    refName: candidate.defaultBranch,
    commitSha: null,
    excerpt: repoMetaExcerpt(candidate),
    fetchedAt,
    status: 'ok',
    errorCode: null,
    errorDetail: null,
  });
  push({
    repoId: candidate.fullName,
    repoFullName: candidate.fullName,
    kind: 'readme',
    url: detail.readme.url,
    filePath: detail.readme.path,
    refName: candidate.defaultBranch,
    commitSha: detail.readme.sha,
    excerpt: detail.readme.text || detail.readme.note || '（README 为空）',
    fetchedAt,
    status: detail.readme.status,
    errorCode: detail.readme.status === 'missing' ? 'not_found' : null,
    errorDetail: detail.readme.note,
  });
  push({
    repoId: candidate.fullName,
    repoFullName: candidate.fullName,
    kind: 'license',
    url: detail.license.url,
    filePath: detail.license.path,
    refName: candidate.defaultBranch,
    commitSha: detail.license.sha,
    excerpt: detail.license.text,
    fetchedAt,
    status: detail.license.status,
    errorCode: detail.license.status === 'missing' ? 'not_found' : null,
    errorDetail: detail.license.note,
  });
  push({
    repoId: candidate.fullName,
    repoFullName: candidate.fullName,
    kind: 'releases',
    url: detail.releases.url,
    filePath: null,
    refName: null,
    commitSha: null,
    excerpt: detail.releases.text,
    fetchedAt,
    status: detail.releases.status,
    errorCode: detail.releases.status === 'missing' ? 'not_found' : null,
    errorDetail: detail.releases.note,
  });
  return { rows, nextKey: key };
}

function fitSourcesForPrompt(rows: ResearchSourceRow[]): {
  rows: ResearchSourceRow[];
  promptChars: number;
  sentIds: string[];
} {
  let total = 0;
  const max = RESEARCH_LIMITS.maxPromptChars;
  const next = rows.map((row) => ({ ...row }));
  // 优先保留元数据与许可证；README/发布信息按需截短，保证「保存的摘录 = 实际发送的摘录」。
  const order = next
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const weight = (kind: string) =>
        kind === 'repo_meta' ? 0 : kind === 'license' ? 1 : kind === 'readme' ? 2 : 3;
      return weight(a.row.kind) - weight(b.row.kind) || a.index - b.index;
    });
  for (const item of order) {
    if (item.row.status === 'failed') continue;
    const text = item.row.excerpt ?? '';
    if (total + text.length <= max) {
      total += text.length;
    } else {
      const remaining = Math.max(0, max - total);
      if (remaining > 400 && text.length > remaining) {
        item.row.excerpt = `${text.slice(0, remaining - 120)}\n[已截断：为控制发送长度仅保留前 ${remaining - 120} 个字符]`;
        total += item.row.excerpt.length;
      } else if (remaining <= 400) {
        item.row.excerpt = '（为控制发送长度，本条资料未发送正文）';
        total += item.row.excerpt.length;
      }
    }
  }
  const sentIds = next.filter((row) => row.status !== 'failed').map((row) => row.sourceKey);
  return { rows: next, promptChars: total, sentIds };
}

async function generateComparison(
  run: ResearchRun,
  rows: ResearchSourceRow[],
  token: string,
  controller: AbortController,
  fastify: FastifyInstance,
  meter: GithubMeter,
  statsBase: StoredStats,
  fromStatus: 'fetching' | 'failed'
): Promise<void> {
  const settings = await getSettingsRow();
  if (!settings || !settings.apiKeyCiphertext) {
    conditionalStatus(run.id, [fromStatus], 'failed', {
      error_code: 'ai_not_configured',
      error_detail: '尚未配置 AI 模型；已获取的资料仍可查看，配置后可重试生成。',
      finished_at: now(),
      stats_json: JSON.stringify({ ...statsBase, github: meter }),
    });
    return;
  }
  if (settings.enabled !== 1) {
    conditionalStatus(run.id, [fromStatus], 'failed', {
      error_code: 'ai_disabled',
      error_detail: 'AI 模型已停用；已获取的资料仍可查看，启用后可重试生成。',
      finished_at: now(),
      stats_json: JSON.stringify({ ...statsBase, github: meter }),
    });
    return;
  }

  const fitted = fitSourcesForPrompt(rows);
  // 持久化截断后的摘录，保证保存的「实际提供给模型的摘录」与发送内容一致。
  for (const row of fitted.rows) {
    const original = rows.find((item) => item.sourceKey === row.sourceKey);
    if (original && original.excerpt !== row.excerpt) {
      sqlite.prepare('UPDATE research_sources SET excerpt = ? WHERE research_id = ? AND source_key = ?').run(
        row.excerpt,
        run.id,
        row.sourceKey
      );
    }
  }

  const repos = parseJson<string[]>(run.selectedCandidateIdsJson) ?? [];
  const repoSourceKeys = new Map<string, Set<string>>();
  for (const repo of repos) repoSourceKeys.set(repo, new Set());
  for (const row of fitted.rows) {
    if (row.status === 'failed') continue;
    if (!repoSourceKeys.has(row.repoFullName)) repoSourceKeys.set(row.repoFullName, new Set());
    repoSourceKeys.get(row.repoFullName)!.add(row.sourceKey);
  }
  const promptSources: ResearchSourceForPrompt[] = fitted.rows
    .filter((row) => row.status !== 'failed')
    .map((row) => ({
      sourceKey: row.sourceKey,
      repoFullName: row.repoFullName,
      kind: row.kind as ResearchSourceForPrompt['kind'],
      status: row.status as ResearchSourceForPrompt['status'],
      url: row.url,
      filePath: row.filePath,
      refName: row.refName,
      commitSha: row.commitSha,
      excerpt: row.excerpt,
      note: row.errorDetail,
    }));
  const constraints = parseJson<ResearchConstraints>(run.constraintsJson) ?? {
    goal: null,
    environment: null,
    language: null,
    timeBudget: null,
    requirements: null,
  };
  const promptText = buildResearchUserPrompt({
    captureText: run.captureText,
    question: run.question,
    constraints,
    sources: promptSources,
    repos,
  });
  const promptChars = promptText.length + RESEARCH_SYSTEM_PROMPT.length;
  if (promptChars > RESEARCH_LIMITS.maxPromptChars + 1000) {
    conditionalStatus(run.id, [fromStatus], 'failed', {
      error_code: 'invalid_response',
      error_detail: '资料总长度超过发送上限，请减少选择或缩小 README 长度后重试。',
      finished_at: now(),
      stats_json: JSON.stringify({ ...statsBase, github: meter, promptChars }),
    });
    return;
  }

  if (!conditionalStatus(run.id, [fromStatus], 'generating', {
    sent_source_ids_json: JSON.stringify(fitted.sentIds),
    config_id: settings.id,
    config_version: settings.configVersion,
    config_name: settings.name,
    model_id: settings.modelId,
    stats_json: JSON.stringify({
      ...statsBase,
      github: meter,
      sourceCount: fitted.rows.length,
      sourcesSent: fitted.sentIds.length,
      missingSources: fitted.rows.filter((row) => row.status === 'missing').length,
      promptChars,
    }),
  })) {
    return;
  }

  const startedAt = now();
  try {
    const apiKey = decryptApiKey(settings.apiKeyCiphertext);
    const result = await callModel(
      {
        baseUrl: settings.baseUrl,
        modelId: settings.modelId,
        apiKey,
        allowLocal: settings.allowLocal === 1,
      },
      {
        system: RESEARCH_SYSTEM_PROMPT,
        prompt: promptText,
        maxOutputTokens: RESEARCH_LIMITS.modelMaxOutputTokens,
        temperature: 0.2,
        timeoutMs: RESEARCH_LIMITS.modelTimeoutMs,
        signal: controller.signal,
      }
    );
    const parsed = parseResearchOutput(result.text, {
      repoSourceKeys,
      sentSourceIds: fitted.sentIds,
    });
    const finishedAt = now();
    conditionalStatus(run.id, ['generating'], 'succeeded', {
      result_json: JSON.stringify(parsed),
      usage_json: result.usage ? JSON.stringify(result.usage) : null,
      duration_ms: result.durationMs,
      error_code: null,
      error_detail: null,
      finished_at: finishedAt,
      failed_json: JSON.stringify(
        (parseJson<StoredFailed[]>(run.failedJson) ?? []).filter((item) => item.kind !== 'generation')
      ),
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    const classified = classifyError(error, []);
    const failed = (parseJson<StoredFailed[]>(run.failedJson) ?? []).filter(
      (item) => item.kind !== 'generation'
    );
    failed.push({
      id: 'generation',
      fullName: null,
      input: run.question,
      code: classified.code,
      detail: classified.detail,
      status: null,
      resetAt: null,
      fetchedAt: now(),
      kind: 'generation',
    });
    conditionalStatus(run.id, ['generating'], 'failed', {
      error_code: 'ai_failed',
      error_detail: `${RESEARCH_ERROR_LABEL[classified.code] ?? '模型调用失败'}：${classified.detail}`,
      duration_ms: now() - startedAt,
      finished_at: now(),
      failed_json: JSON.stringify(failed),
    });
    fastify.log.info({ researchId: run.id, errorCode: classified.code }, '研究模型生成未成功');
  }
}

async function runDeepRead(
  fastify: FastifyInstance,
  runId: string,
  candidateIds: string[],
  options: { onlyRepos?: string[]; regenerateOnly?: boolean } = {}
): Promise<void> {
  const controller = new AbortController();
  runningRuns.set(runId, controller);
  const meter = createGithubMeter();
  let token = '';
  try {
    token = await readGithubToken();
    const run = await getResearchRow(runId);
    if (!run) return;
    const priorStats = parseJson<StoredStats>(run.statsJson);
    if (priorStats?.github) {
      // 累计候选阶段的请求，右侧「GitHub 请求」才是整次研究的实际用量。
      meter.requests += priorStats.github.requests ?? 0;
      meter.searchRequests += priorStats.github.searchRequests ?? 0;
      meter.detailRequests += priorStats.github.detailRequests ?? 0;
      for (const [repo, count] of Object.entries(priorStats.github.byRepo ?? {})) {
        meter.byRepo[repo] = (meter.byRepo[repo] ?? 0) + count;
      }
    }
    const existingRows = camelizeRows<ResearchSourceRow>(
      sqlite
        .prepare('SELECT * FROM research_sources WHERE research_id = ? ORDER BY rowid ASC')
        .all(runId) as Array<Record<string, unknown>>
    );

    const targets = options.onlyRepos?.length ? options.onlyRepos : candidateIds;
    const fetchedAt = now();
    const bundles = await mapLimit(targets, RESEARCH_LIMITS.concurrency, async (repo) => {
      if (controller.signal.aborted) return null;
      return readRepoBundle(repo, token, controller.signal, meter);
    });
    if (controller.signal.aborted) return;

    let nextKey = nextSourceKey(existingRows);
    let allRows = options.onlyRepos?.length
      ? existingRows.filter((row) => !options.onlyRepos!.includes(row.repoFullName))
      : [];
    const newFailures: Array<Omit<RepoCandidateFailure, 'code'> & { code: string }> = [];
    if (!options.onlyRepos?.length) {
      sqlite.prepare('DELETE FROM research_sources WHERE research_id = ?').run(runId);
    } else {
      // 只替换重试仓库的旧资料
      sqlite
        .prepare(
          `DELETE FROM research_sources WHERE research_id = ? AND repo_full_name IN (${options.onlyRepos!
            .map(() => '?')
            .join(',')})`
        )
        .run(runId, ...options.onlyRepos);
    }
    for (const bundle of bundles) {
      if (!bundle) continue;
      const inserted = insertSourceRows(runId, bundle, nextKey, fetchedAt);
      nextKey = inserted.nextKey;
      const stmt = sqlite.prepare(
        `INSERT INTO research_sources
           (id, research_id, source_key, repo_id, repo_full_name, kind, url, file_path, ref_name,
            commit_sha, excerpt, fetched_at, status, error_code, error_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const row of inserted.rows) {
        stmt.run(
          row.id,
          runId,
          row.sourceKey,
          row.repoId,
          row.repoFullName,
          row.kind,
          row.url,
          row.filePath,
          row.refName,
          row.commitSha,
          row.excerpt,
          row.fetchedAt,
          row.status,
          row.errorCode,
          row.errorDetail
        );
      }
      allRows.push(...inserted.rows);
      if (bundle.failure) newFailures.push(bundle.failure);
    }
    allRows = allRows.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey, 'en', { numeric: true }));

    const successfulRepos = new Set(
      allRows.filter((row) => row.status !== 'failed').map((row) => row.repoFullName)
    );
    const failures = newFailures.map((item) => ({ ...item, kind: 'repo' as const }));
    if (successfulRepos.size === 0) {
      conditionalStatus(runId, ['fetching'], 'failed', {
        error_code: 'all_repos_failed',
        error_detail: newFailures[0]?.detail ?? '所选仓库均读取失败。',
        failed_json: JSON.stringify(failures),
        finished_at: now(),
      });
      return;
    }

    const statsBase: StoredStats = {
      github: meter,
      candidates: candidateIds.length,
      selected: candidateIds.length,
      sourceCount: allRows.length,
      sourcesSent: 0,
      failedRepos: newFailures.length,
      missingSources: allRows.filter((row) => row.status === 'missing').length,
      promptChars: 0,
    };
    await generateComparison(run, allRows, token, controller, fastify, meter, statsBase, 'fetching');
  } catch (error) {
    if (controller.signal.aborted) return;
    const detail = githubDetailFromError(error);
    conditionalStatus(runId, ['fetching'], 'failed', {
      error_code: detail.code,
      error_detail: detail.detail,
      finished_at: now(),
      failed_json: JSON.stringify([
        {
          id: 'fetch',
          fullName: null,
          input: '',
          code: detail.code,
          detail: detail.detail,
          status: detail.status,
          resetAt: detail.resetAt,
          fetchedAt: now(),
          kind: 'repo',
        },
      ]),
    });
    fastify.log.info({ researchId: runId, errorCode: detail.code }, '研究资料读取未成功');
  } finally {
    runningRuns.delete(runId);
  }
}

async function runRegenerate(fastify: FastifyInstance, runId: string): Promise<void> {
  const controller = new AbortController();
  runningRuns.set(runId, controller);
  try {
    const run = await getResearchRow(runId);
    if (!run) return;
    const controllerAlive = !controller.signal.aborted;
    if (!controllerAlive) return;
    const rows = camelizeRows<ResearchSourceRow>(
      sqlite
        .prepare('SELECT * FROM research_sources WHERE research_id = ? ORDER BY rowid ASC')
        .all(runId) as Array<Record<string, unknown>>
    );
    const selected = parseJson<string[]>(run.selectedCandidateIdsJson) ?? [];
    const priorStats = parseJson<StoredStats>(run.statsJson);
    const meter = createGithubMeter();
    if (priorStats?.github) {
      meter.requests += priorStats.github.requests ?? 0;
      meter.searchRequests += priorStats.github.searchRequests ?? 0;
      meter.detailRequests += priorStats.github.detailRequests ?? 0;
      for (const [repo, count] of Object.entries(priorStats.github.byRepo ?? {})) {
        meter.byRepo[repo] = (meter.byRepo[repo] ?? 0) + count;
      }
    }
    const priorFailed = parseJson<StoredFailed[]>(run.failedJson) ?? [];
    await generateComparison(
      run,
      rows,
      '',
      controller,
      fastify,
      meter,
      {
        github: meter,
        candidates: selected.length,
        selected: selected.length,
        sourceCount: rows.length,
        sourcesSent: 0,
        failedRepos: priorFailed.filter((item) => item.kind === 'repo' && item.fullName).length,
        missingSources: rows.filter((row) => row.status === 'missing').length,
        promptChars: 0,
      },
      'failed'
    );
  } finally {
    runningRuns.delete(runId);
  }
}

export async function createResearchRun(input: {
  captureId: string;
  captureRevision: number;
  question: string;
  constraints: ResearchConstraints;
  search: ResearchSearchInput;
  contextToken: string;
  operationId: string;
  fastify: FastifyInstance;
}): Promise<
  | { ok: true; run: ResearchRun; replayed: boolean }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const operationId = input.operationId.trim();
  if (!operationId) {
    return { ok: false, status: 400, body: { error: 'invalid_request', message: 'operationId 不能为空。' } };
  }
  const requestFingerprint = fingerprint({
    op: 'research-create',
    captureId: input.captureId,
    captureRevision: input.captureRevision,
    question: input.question,
    constraints: input.constraints,
    mode: input.search.mode,
    query: input.search.query,
    repos: input.search.repos,
  });

  const existing = camelizeRow<ResearchRun>(
    sqlite
      .prepare('SELECT * FROM research_runs WHERE operation_id = ?')
      .get(operationId) as Record<string, unknown> | undefined
  );
  if (existing) {
    if (existing.operationFingerprint !== requestFingerprint) {
      return {
        ok: false,
        status: 409,
        body: { error: 'operation_key_conflict', message: 'operationId 已被另一个请求使用。' },
      };
    }
    return { ok: true, run: existing, replayed: true };
  }

  if (!(await ensureConcurrency())) {
    return {
      ok: false,
      status: 429,
      body: { error: 'too_many_research', message: '同时进行的研究过多，请稍后再试。' },
    };
  }

  const settings = await getSettingsRow();
  const token = researchContextToken({
    captureId: input.captureId,
    captureRevision: input.captureRevision,
    question: input.question,
    constraints: input.constraints,
    search: input.search,
    configVersion: settings?.configVersion ?? null,
  });
  if (input.contextToken !== token) {
    return {
      ok: false,
      status: 409,
      body: { error: 'context_changed', message: '预览后内容或配置有变化，请刷新后重新确认。' },
    };
  }

  const id = `res-${now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = now();
  let created: ResearchRun | undefined;
  try {
    created = sqlite.transaction(() => {
      const cap = sqlite
        .prepare('SELECT id, raw_text AS rawText, revision FROM captures WHERE id = ?')
        .get(input.captureId) as { id: string; rawText: string; revision: number } | undefined;
      if (!cap) throw new Object({ status: 404, body: { error: 'capture_not_found' } });
      if (cap.revision !== input.captureRevision) {
        throw new Object({
          status: 409,
          body: {
            error: 'version_conflict',
            currentRevision: cap.revision,
            currentRawText: cap.rawText,
          },
        });
      }
      const [row] = db
        .insert(researchRuns)
        .values({
          id,
          captureId: input.captureId,
          captureRevision: cap.revision,
          captureText: cap.rawText,
          question: input.question,
          constraintsJson: JSON.stringify(input.constraints),
          searchMode: input.search.mode,
          searchQuery: input.search.query,
          repoInputsJson: JSON.stringify(input.search.repos),
          status: 'searching',
          limitsJson: JSON.stringify(limitsPublic()),
          operationId,
          operationFingerprint: requestFingerprint,
          contextToken: token,
          revision: 1,
          createdAt,
          updatedAt: createdAt,
        })
        .returning()
        .all();
      return row!;
    })();
  } catch (error: any) {
    if (error && typeof error === 'object' && 'status' in error && 'body' in error) {
      return { ok: false, status: error.status, body: error.body };
    }
    const replay = camelizeRow<ResearchRun>(
      sqlite
        .prepare('SELECT * FROM research_runs WHERE operation_id = ?')
        .get(operationId) as Record<string, unknown> | undefined
    );
    if (replay && replay.operationFingerprint === requestFingerprint) {
      return { ok: true, run: replay, replayed: true };
    }
    throw error;
  }

  setImmediate(() => {
    void runSearch(input.fastify, id);
  });
  return { ok: true, run: created, replayed: false };
}

export async function startSelection(
  fastify: FastifyInstance,
  runId: string,
  candidateIds: string[]
): Promise<boolean> {
  const run = await getResearchRow(runId);
  if (!run) return false;
  const stored = parseJson<StoredCandidates>(run.candidatesJson);
  if (!stored) return false;
  const available = new Set(stored.items.map((item) => item.id));
  const selected = [...new Set(candidateIds.map((id) => id.trim()).filter(Boolean))];
  if (selected.length < 1 || selected.length > RESEARCH_LIMITS.maxSelected) return false;
  if (selected.some((id) => !available.has(id))) return false;

  if (
    !conditionalStatus(runId, ['candidates'], 'fetching', {
      selected_candidate_ids_json: JSON.stringify(selected),
      error_code: null,
      error_detail: null,
      result_json: null,
    })
  ) {
    return false;
  }
  setImmediate(() => {
    void runDeepRead(fastify, runId, selected);
  });
  return true;
}

export async function retryResearch(
  fastify: FastifyInstance,
  runId: string,
  action: 'search' | 'fetch' | 'generate',
  repoIds: string[]
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const run = await getResearchRow(runId);
  if (!run) return { ok: false, status: 404, body: { error: 'research_not_found' } };
  if (ACTIVE_STATUSES.includes(run.status as ResearchStatus)) {
    return { ok: false, status: 409, body: { error: 'research_running', message: '研究正在进行，请先取消。' } };
  }
  if (run.savedAt !== null && (action === 'fetch' || action === 'generate')) {
    return {
      ok: false,
      status: 409,
      body: { error: 'not_retryable', message: '研究已保存，请重新研究生成新版本。' },
    };
  }
  if (action === 'search') {
    if (!conditionalStatus(runId, ['failed', 'cancelled', 'interrupted'], 'searching', {
      candidates_json: null,
      selected_candidate_ids_json: null,
      sent_source_ids_json: null,
      result_json: null,
      error_code: null,
      error_detail: null,
      failed_json: null,
      finished_at: null,
    })) {
      return { ok: false, status: 409, body: { error: 'not_retryable', message: '当前状态不能重新检索。' } };
    }
    setImmediate(() => void runSearch(fastify, runId));
    return { ok: true, status: 202, body: { ok: true } };
  }
  if (action === 'fetch') {
    const selected = parseJson<string[]>(run.selectedCandidateIdsJson) ?? [];
    if (selected.length === 0) {
      return { ok: false, status: 409, body: { error: 'no_selection', message: '请先选择候选仓库。' } };
    }
    const targets = repoIds.length > 0 ? repoIds.filter((id) => selected.includes(id)) : selected;
    if (targets.length === 0) {
      return { ok: false, status: 400, body: { error: 'invalid_repos', message: '没有可重试的仓库。' } };
    }
    if (!conditionalStatus(runId, ['failed', 'cancelled', 'interrupted', 'succeeded'], 'fetching', {
      result_json: null,
      error_code: null,
      error_detail: null,
      failed_json: null,
      finished_at: null,
    })) {
      return { ok: false, status: 409, body: { error: 'not_retryable', message: '当前状态不能重试读取。' } };
    }
    setImmediate(() => void runDeepRead(fastify, runId, selected, { onlyRepos: targets }));
    return { ok: true, status: 202, body: { ok: true } };
  }
  // generate
  const rows = sqlite.prepare('SELECT COUNT(*) AS c FROM research_sources WHERE research_id = ?').get(runId) as {
    c: number;
  };
  if (rows.c === 0) {
    return { ok: false, status: 409, body: { error: 'no_sources', message: '还没有可用的资料。' } };
  }
  const settings = await getSettingsRow();
  if (!settings || !settings.apiKeyCiphertext || settings.enabled !== 1) {
    return {
      ok: false,
      status: 409,
      body: { error: 'ai_not_configured', message: '请先在设置页配置并启用 AI 模型。' },
    };
  }
  if (run.status !== 'failed') {
    return { ok: false, status: 409, body: { error: 'not_retryable', message: '当前状态不能重新生成。' } };
  }
  // 状态由 runRegenerate 内部的 failed → generating 条件更新完成，避免提前写入 generating
  // 后又被旧状态条件挡住，留下永远停在 generating 的任务。
  setImmediate(() => void runRegenerate(fastify, runId));  return { ok: true, status: 202, body: { ok: true } };
}

export function cancelResearch(runId: string): { ok: boolean; status: number; body: Record<string, unknown> } {
  const run = camelizeRow<ResearchRun>(
    sqlite.prepare('SELECT * FROM research_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined
  );
  if (!run) return { ok: false, status: 404, body: { error: 'research_not_found' } };
  if (!ACTIVE_STATUSES.includes(run.status as ResearchStatus)) {
    return { ok: false, status: 409, body: { error: 'not_cancellable', message: '这次研究已结束，无需取消。' } };
  }
  const t = now();
  const result = sqlite
    .prepare(
      `UPDATE research_runs
          SET status = 'cancelled', error_code = 'cancelled', error_detail = '已取消本次研究。',
              finished_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('searching','fetching','generating')`
    )
    .run(t, t, runId);
  if (result.changes !== 1) {
    return { ok: false, status: 409, body: { error: 'not_cancellable' } };
  }
  runningRuns.get(runId)?.abort();
  return { ok: true, status: 200, body: { ok: true } };
}

export function saveResearch(runId: string): {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
} {
  const run = camelizeRow<ResearchRun>(
    sqlite.prepare('SELECT * FROM research_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined
  );
  if (!run) return { ok: false, status: 404, body: { error: 'research_not_found' } };
  if (run.status !== 'succeeded' || !run.resultJson) {
    return {
      ok: false,
      status: 409,
      body: { error: 'not_savable', message: '研究结果尚未生成，暂时不能保存。' },
    };
  }
  if (run.savedAt !== null) {
    return { ok: true, status: 200, body: { savedAt: run.savedAt, replayed: true } };
  }
  const t = now();
  sqlite
    .prepare('UPDATE research_runs SET saved_at = ?, updated_at = ? WHERE id = ? AND status = ?')
    .run(t, t, runId, 'succeeded');
  const updated = sqlite.prepare('SELECT saved_at AS savedAt FROM research_runs WHERE id = ?').get(runId) as {
    savedAt: number;
  };
  return { ok: true, status: 200, body: { savedAt: updated.savedAt, replayed: false } };
}

export function deleteResearch(runId: string): {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
} {
  const run = camelizeRow<ResearchRun>(
    sqlite.prepare('SELECT * FROM research_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined
  );
  if (!run) return { ok: false, status: 404, body: { error: 'research_not_found' } };
  if (ACTIVE_STATUSES.includes(run.status as ResearchStatus)) {
    return {
      ok: false,
      status: 409,
      body: { error: 'research_running', message: '研究正在进行，请先取消再删除。' },
    };
  }
  const sourceCount = (
    sqlite.prepare('SELECT COUNT(*) AS c FROM research_sources WHERE research_id = ?').get(runId) as { c: number }
  ).c;
  const linkedAttempts = (
    sqlite.prepare('SELECT COUNT(*) AS c FROM attempts WHERE source_research_id = ?').get(runId) as { c: number }
  ).c;
  sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM research_sources WHERE research_id = ?').run(runId);
    sqlite.prepare('DELETE FROM research_runs WHERE id = ?').run(runId);
  })();
  return {
    ok: true,
    status: 200,
    body: { ok: true, deletedResearchId: runId, deletedSources: sourceCount, keptAttempts: linkedAttempts },
  };
}

export function getCaptureResearchCount(captureId: string): { total: number; active: number } {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status IN ('searching','fetching','generating') THEN 1 ELSE 0 END), 0) AS active
         FROM research_runs WHERE capture_id = ?`
    )
    .get(captureId) as { total: number; active: number };
  return { total: row.total, active: row.active };
}

/** JSON 导出：研究任务、已获取资料与来源证据。不导出 Token 或内部回执。 */
export function getResearchExportRows(): {
  researchRuns: Array<Record<string, unknown>>;
  researchSources: Array<Record<string, unknown>>;
} {
  const runs = sqlite
    .prepare('SELECT * FROM research_runs ORDER BY created_at ASC, id ASC')
    .all() as Array<Record<string, any>>;
  const sources = sqlite
    .prepare('SELECT * FROM research_sources ORDER BY fetched_at ASC, id ASC')
    .all() as Array<Record<string, any>>;
  return {
    researchRuns: runs.map((row) => ({
      id: row.id,
      captureId: row.capture_id,
      captureRevision: row.capture_revision,
      captureText: row.capture_text,
      question: row.question,
      constraints: parseJson(row.constraints_json),
      search: {
        mode: row.search_mode,
        query: row.search_query,
        repos: parseJson(row.repo_inputs_json) ?? [],
      },
      status: row.status,
      limits: parseJson(row.limits_json),
      candidates: parseJson(row.candidates_json),
      selectedCandidateIds: parseJson(row.selected_candidate_ids_json) ?? [],
      result: parseJson(row.result_json),
      config: {
        id: row.config_id,
        version: row.config_version,
        name: row.config_name,
        modelId: row.model_id,
      },
      usage: parseJson(row.usage_json),
      durationMs: row.duration_ms,
      stats: parseJson(row.stats_json),
      error: row.error_code
        ? { code: row.error_code, detail: row.error_detail }
        : null,
      failed: parseJson(row.failed_json) ?? [],
      revision: row.revision,
      savedAt: row.saved_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
    })),
    researchSources: sources.map((row) => ({
      id: row.id,
      researchId: row.research_id,
      sourceKey: row.source_key,
      repoId: row.repo_id,
      repoFullName: row.repo_full_name,
      kind: row.kind,
      url: row.url,
      filePath: row.file_path,
      refName: row.ref_name,
      commitSha: row.commit_sha,
      excerpt: row.excerpt,
      fetchedAt: row.fetched_at,
      status: row.status,
      errorCode: row.error_code,
      errorDetail: row.error_detail,
    })),
  };
}

export type AttemptResearchPublic = {  exists: boolean;
  id: string;
  question: string | null;
  status: string | null;
  savedAt: number | null;
  experimentIndex: number;
  suggestion: {
    title?: string;
    description?: string;
    estimatedMinutes?: number | null;
    repo?: string;
    verifies?: string;
    sourceIds?: string[];
  } | null;
  sources: ResearchSourcePublic[];
  deleted: boolean;
};

export function attemptResearchLink(attemptId: string): AttemptResearchPublic | null {
  const row = sqlite
    .prepare(
      `SELECT source_research_id AS researchId,
              source_research_experiment_index AS idx,
              research_suggested_json AS suggestionJson,
              research_source_ids_json AS sourceIdsJson
         FROM attempts WHERE id = ?`
    )
    .get(attemptId) as
    | {
        researchId: string | null;
        idx: number | null;
        suggestionJson: string | null;
        sourceIdsJson: string | null;
      }
    | undefined;
  if (!row || !row.researchId) return null;
  const suggestion = parseJson<AttemptResearchPublic['suggestion']>(row.suggestionJson);
  const sourceIds = parseJson<string[]>(row.sourceIdsJson) ?? [];
  const run = camelizeRow<ResearchRun>(
    sqlite.prepare('SELECT * FROM research_runs WHERE id = ?').get(row.researchId) as Record<string, unknown> | undefined
  );
  if (!run) {
    return {
      exists: false,
      id: row.researchId,
      question: null,
      status: null,
      savedAt: null,
      experimentIndex: row.idx ?? 0,
      suggestion,
      sources: [],
      deleted: true,
    };
  }
  const sources = camelizeRows<ResearchSourceRow>(
    sqlite
      .prepare('SELECT * FROM research_sources WHERE research_id = ? ORDER BY rowid ASC')
      .all(row.researchId) as Array<Record<string, unknown>>
  )
    .map((raw) => sourcePublic(raw))
    .filter((source) => sourceIds.length === 0 || sourceIds.includes(source.sourceKey));
  return {
    exists: true,
    id: run.id,
    question: run.question,
    status: run.status,
    savedAt: run.savedAt,
    experimentIndex: row.idx ?? 0,
    suggestion,
    sources,
    deleted: false,
  };
}

type ReceiptRow = {
  operation_key: string;
  target_type: string;
  request_fingerprint: string;
  response_json: string;
};

function getReceipt(operationKey: string): ReceiptRow | undefined {
  return sqlite
    .prepare('SELECT * FROM mutation_receipts WHERE operation_key = ?')
    .get(operationKey) as ReceiptRow | undefined;
}

export type AdoptExperimentInput = {
  researchId: string;
  experimentIndex: number;
  title: string;
  description: string | null;
  estimatedMinutes: number | null;
  expectedRevision: number;
  operationId: string;
};

export async function adoptResearchExperiment(input: AdoptExperimentInput): Promise<
  | { ok: true; attempt: typeof attempts.$inferSelect; replayed: boolean }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const operationId = input.operationId.trim();
  if (!operationId) {
    return { ok: false, status: 400, body: { error: 'invalid_request', message: 'operationId 不能为空。' } };
  }
  const title = input.title.trim();
  if (!title || title.length > 500) {
    return { ok: false, status: 400, body: { error: 'invalid_title', message: '标题需为 1–500 个字符。' } };
  }
  const description =
    typeof input.description === 'string' ? input.description.trim().slice(0, 2000) : null;
  const estimatedMinutes =
    input.estimatedMinutes === null
      ? null
      : Math.max(1, Math.min(1440, Math.round(input.estimatedMinutes)));
  if (input.estimatedMinutes !== null && !Number.isFinite(input.estimatedMinutes)) {
    return { ok: false, status: 400, body: { error: 'invalid_estimated_minutes' } };
  }
  if (!Number.isInteger(input.experimentIndex) || input.experimentIndex < 0) {
    return { ok: false, status: 400, body: { error: 'experiment_not_found' } };
  }

  const requestFingerprint = fingerprint({
    op: 'research-accept',
    researchId: input.researchId,
    experimentIndex: input.experimentIndex,
    title,
    description,
    estimatedMinutes,
  });
  const receipt = getReceipt(operationId);
  if (receipt) {
    if (receipt.target_type !== 'research_accept' || receipt.request_fingerprint !== requestFingerprint) {
      return { ok: false, status: 409, body: { error: 'operation_key_conflict' } };
    }
    const stored = parseJson<{ attemptId?: string }>(receipt.response_json);
    if (stored?.attemptId) {
      const row = camelizeRow<typeof attempts.$inferSelect>(
        sqlite.prepare('SELECT * FROM attempts WHERE id = ?').get(stored.attemptId) as
          | Record<string, unknown>
          | undefined
      );
      if (row) return { ok: true, attempt: row, replayed: true };
    }
  }

  const existingByKey = camelizeRow<typeof attempts.$inferSelect>(
    sqlite
      .prepare(
        'SELECT * FROM attempts WHERE source_research_id = ? AND source_research_experiment_index = ?'
      )
      .get(input.researchId, input.experimentIndex) as Record<string, unknown> | undefined
  );
  if (existingByKey) return { ok: true, attempt: existingByKey, replayed: true };

  const run = camelizeRow<ResearchRun>(
    sqlite.prepare('SELECT * FROM research_runs WHERE id = ?').get(input.researchId) as Record<string, unknown> | undefined
  );
  if (!run) return { ok: false, status: 404, body: { error: 'research_not_found' } };
  if (run.revision !== input.expectedRevision) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'version_conflict',
        message: '研究刚被更新，请刷新后重新采用。',
        currentRevision: run.revision,
      },
    };
  }
  const result = parseJson<{ experiments?: Array<{ title?: string; description?: string; estimatedMinutes?: number | null; repo?: string; verifies?: string; sourceIds?: string[] }> }>(
    run.resultJson
  );
  const experiment = result?.experiments?.[input.experimentIndex];
  if (!experiment) {
    return { ok: false, status: 404, body: { error: 'experiment_not_found' } };
  }

  const sourceKeys = Array.isArray(experiment.sourceIds) ? experiment.sourceIds : [];
  const availableSources = sqlite
    .prepare('SELECT source_key AS sourceKey, status FROM research_sources WHERE research_id = ?')
    .all(input.researchId) as Array<{ sourceKey: string; status: string }>;
  const availableSet = new Set(
    availableSources.filter((row) => row.status !== 'failed').map((row) => row.sourceKey)
  );
  if (sourceKeys.some((key) => !availableSet.has(key))) {
    return {
      ok: false,
      status: 409,
      body: { error: 'sources_changed', message: '小实验引用的资料已变化，请重新研究。' },
    };
  }

  const attemptId = `att-${now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = now();
  const suggestedJson = JSON.stringify({
    title: experiment.title ?? title,
    description: experiment.description ?? description,
    estimatedMinutes:
      experiment.estimatedMinutes !== undefined ? experiment.estimatedMinutes : estimatedMinutes,
    repo: experiment.repo ?? null,
    verifies: experiment.verifies ?? null,
    sourceIds: sourceKeys,
    adopted: { title, description, estimatedMinutes },
  });

  try {
    const inserted = sqlite.transaction(() => {
      const freshRun = camelizeRow<ResearchRun>(
        sqlite.prepare('SELECT * FROM research_runs WHERE id = ?').get(input.researchId) as Record<string, unknown> | undefined
      );
      if (!freshRun) throw Object.assign(new Error('research_not_found'), { httpStatus: 404 });
      if (freshRun.revision !== input.expectedRevision) {
        throw Object.assign(new Error('version_conflict'), {
          httpStatus: 409,
          body: { error: 'version_conflict', currentRevision: freshRun.revision },
        });
      }
      const again = camelizeRow<typeof attempts.$inferSelect>(
        sqlite
          .prepare(
            'SELECT * FROM attempts WHERE source_research_id = ? AND source_research_experiment_index = ?'
          )
          .get(input.researchId, input.experimentIndex) as Record<string, unknown> | undefined
      );
      if (again) return { row: again, replayed: true };
      const [row] = db
        .insert(attempts)
        .values({
          id: attemptId,
          captureId: freshRun.captureId,
          step: title,
          state: 'todo',
          resultText: null,
          outcome: null,
          sourceUrl: null,
          observedAt: null,
          revision: 1,
          createdAt,
          updatedAt: createdAt,
          origin: 'research_experiment',
          actionDescription: description,
          estimatedMinutes,
          sourceResearchId: input.researchId,
          sourceResearchExperimentIndex: input.experimentIndex,
          researchSuggestedJson: suggestedJson,
          researchSourceIdsJson: JSON.stringify(sourceKeys),
        })
        .returning()
        .all();
      sqlite
        .prepare(
          `INSERT INTO mutation_receipts
             (operation_key, target_type, request_fingerprint, response_json, created_at)
           VALUES (?, 'research_accept', ?, ?, ?)`
        )
        .run(
          operationId,
          requestFingerprint,
          JSON.stringify({ attemptId: row!.id, researchId: input.researchId }),
          now()
        );
      return { row: row!, replayed: false };
    })();
    return { ok: true, attempt: inserted.row, replayed: inserted.replayed };
  } catch (error: any) {
    if (error?.httpStatus) {
      return { ok: false, status: error.httpStatus, body: error.body ?? { error: error.message } };
    }
    const raced = sqlite
      .prepare(
        'SELECT * FROM attempts WHERE source_research_id = ? AND source_research_experiment_index = ?'
      )
      .get(input.researchId, input.experimentIndex) as typeof attempts.$inferSelect | undefined;
    if (raced) return { ok: true, attempt: raced, replayed: true };
    throw error;
  }
}
