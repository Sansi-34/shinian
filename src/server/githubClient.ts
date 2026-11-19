import { GITHUB_API_BASE } from './githubSettings';

export type GithubErrorCode =
  | 'rate_limited'
  | 'timeout'
  | 'not_found'
  | 'auth'
  | 'forbidden'
  | 'unreachable'
  | 'invalid_response'
  | 'cancelled'
  | 'invalid_repo';

export class GithubApiError extends Error {
  readonly code: GithubErrorCode;
  readonly detail: string;
  readonly status: number | null;
  readonly resetAt: number | null;

  constructor(
    code: GithubErrorCode,
    message: string,
    options: { status?: number | null; detail?: string; resetAt?: number | null } = {}
  ) {
    super(message);
    this.name = 'GithubApiError';
    this.code = code;
    this.detail = options.detail ?? message;
    this.status = options.status ?? null;
    this.resetAt = options.resetAt ?? null;
  }
}

export type GithubMeter = {
  requests: number;
  searchRequests: number;
  detailRequests: number;
  byRepo: Record<string, number>;
};

export function createGithubMeter(): GithubMeter {
  return { requests: 0, searchRequests: 0, detailRequests: 0, byRepo: {} };
}

export type GithubRateInfo = {
  limit: number | null;
  remaining: number | null;
  resetAt: number | null;
};

export type RepoLicense = {
  spdxId: string | null;
  name: string | null;
  url: string | null;
};

export type RepoCandidate = {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  htmlUrl: string;
  language: string | null;
  archived: boolean;
  fork: boolean;
  defaultBranch: string | null;
  stars: number | null;
  openIssues: number | null;
  pushedAt: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  license: RepoLicense | null;
  fetchedAt: number;
  via: 'search' | 'direct';
  apiUrl: string;
};

export type RepoCandidateFailure = {
  id: string;
  fullName: string | null;
  input: string;
  code: GithubErrorCode;
  detail: string;
  status: number | null;
  resetAt: number | null;
  fetchedAt: number;
};

export type RepoDetail = {
  candidate: RepoCandidate;
  readme: {
    status: 'ok' | 'missing';
    url: string;
    path: string | null;
    sha: string | null;
    text: string;
    note: string | null;
  };
  license: {
    status: 'ok' | 'missing';
    url: string;
    path: string | null;
    sha: string | null;
    spdxId: string | null;
    name: string | null;
    text: string;
    note: string | null;
  };
  releases: {
    status: 'ok' | 'missing';
    url: string;
    text: string;
    note: string | null;
  };
};

export type RequestOptions = {
  token?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  meter?: GithubMeter;
  category?: 'search' | 'detail';
  repoKey?: string;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 1;
const MAX_DETAIL_TIMEOUT_MS = 20_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GithubApiError('cancelled', '已取消本次研究。'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GithubApiError('cancelled', '已取消本次研究。'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function rateInfoOf(headers: Headers): GithubRateInfo {
  const remainingRaw = headers.get('x-ratelimit-remaining');
  const limitRaw = headers.get('x-ratelimit-limit');
  const resetRaw = headers.get('x-ratelimit-reset');
  const remaining = remainingRaw !== null ? Number.parseInt(remainingRaw, 10) : null;
  const limit = limitRaw !== null ? Number.parseInt(limitRaw, 10) : null;
  const resetAt =
    resetRaw !== null && Number.isFinite(Number.parseInt(resetRaw, 10))
      ? Number.parseInt(resetRaw, 10) * 1000
      : null;
  return {
    remaining: Number.isFinite(remaining as number) ? (remaining as number) : null,
    limit: Number.isFinite(limit as number) ? (limit as number) : null,
    resetAt,
  };
}

function resetText(resetAt: number | null): string {
  if (!resetAt) return '';
  const d = new Date(resetAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/**
 * 固定 GitHub REST API 请求。只接受服务端拼出的固定路径，不代理任意地址。
 * redirect 一律拒绝，Token 只随本次请求发送到 GitHub API。
 */
async function githubRequest<T>(
  path: string,
  options: RequestOptions & { accept?: string } = {}
): Promise<{ data: T; rate: GithubRateInfo; headers: Headers }> {
  const token = (options.token ?? '').trim();
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_DETAIL_TIMEOUT_MS);
  const retries = Math.max(0, Math.min(2, options.retries ?? DEFAULT_RETRIES));
  const url = `${GITHUB_API_BASE}${path}`;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    options.meter && (options.meter.requests += 1);
    if (options.category === 'search') options.meter && (options.meter.searchRequests += 1);
    if (options.category === 'detail') options.meter && (options.meter.detailRequests += 1);
    if (options.repoKey && options.meter) {
      options.meter.byRepo[options.repoKey] = (options.meter.byRepo[options.repoKey] ?? 0) + 1;
    }

    try {
      const headers: Record<string, string> = {
        Accept: options.accept ?? 'application/vnd.github+json',
        'User-Agent': 'shinian-local-research/0.1',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'manual',
      });
      const rate = rateInfoOf(response.headers);

      if (response.status >= 300 && response.status < 400) {
        throw new GithubApiError('forbidden', 'GitHub 返回重定向，已拒绝跟随。', {
          status: response.status,
          detail: `HTTP ${response.status} 重定向`,
        });
      }
      if (response.status === 401) {
        throw new GithubApiError('auth', 'GitHub Token 认证失败。', {
          status: 401,
          detail: 'HTTP 401：Token 无效、已过期或权限不足。',
        });
      }
      if (response.status === 404) {
        throw new GithubApiError('not_found', 'GitHub 资源不存在。', {
          status: 404,
          detail: 'HTTP 404：仓库、文件或接口不存在。',
        });
      }
      if (response.status === 403 || response.status === 429) {
        const exhausted = rate.remaining === 0 || response.status === 429;
        if (exhausted) {
          throw new GithubApiError(
            'rate_limited',
            'GitHub 请求额度已用完。',
            {
              status: response.status,
              resetAt: rate.resetAt,
              detail:
                rate.remaining === 0
                  ? `GitHub API 额度已用完${resetText(rate.resetAt) ? `，将在 ${resetText(rate.resetAt)} 重置` : ''}。${
                      token ? '' : '未配置 Token 时公开读取额度较低，可在设置页配置 Token。'
                    }`
                  : 'GitHub 限流：HTTP 429。',
            }
          );
        }
        throw new GithubApiError('forbidden', 'GitHub 拒绝了本次请求。', {
          status: response.status,
          detail: 'HTTP 403：权限不足或请求被拒绝。',
        });
      }
      if (response.status >= 500) {
        if (attempt < retries) {
          await sleep(350 * (attempt + 1), options.signal);
          continue;
        }
        throw new GithubApiError('unreachable', 'GitHub 服务暂时不可用。', {
          status: response.status,
          detail: `HTTP ${response.status}：GitHub 服务端错误。`,
        });
      }
      if (!response.ok) {
        throw new GithubApiError('invalid_response', 'GitHub 响应状态不支持。', {
          status: response.status,
          detail: `HTTP ${response.status}`,
        });
      }

      const text = await response.text();
      if (!text.trim()) {
        throw new GithubApiError('invalid_response', 'GitHub 返回了空响应。');
      }
      try {
        return { data: JSON.parse(text) as T, rate, headers: response.headers };
      } catch {
        throw new GithubApiError('invalid_response', 'GitHub 响应不是合法 JSON。');
      }
    } catch (error) {
      if (error instanceof GithubApiError) throw error;
      if (timedOut) {
        throw new GithubApiError('timeout', 'GitHub 请求超时。', {
          detail: `请求超过 ${timeoutMs}ms 未完成。`,
        });
      }
      if (controller.signal.aborted || options.signal?.aborted) {
        throw new GithubApiError('cancelled', '已取消本次研究。');
      }
      if (attempt < retries) {
        await sleep(350 * (attempt + 1), options.signal);
        continue;
      }
      throw new GithubApiError('unreachable', 'GitHub 地址不可达。', {
        detail: error instanceof Error ? error.message : '网络请求失败。',
      });
    } finally {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }
  throw new GithubApiError('unreachable', 'GitHub 请求失败。');
}

const REPO_PART_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export function parseRepoReference(
  raw: string
): { ok: true; owner: string; name: string; fullName: string } | { ok: false; message: string } {
  let value = raw.trim();
  if (!value) return { ok: false, message: '仓库地址不能为空。' };
  if (value.length > 200) return { ok: false, message: '仓库地址过长。' };
  if (value.startsWith('git@github.com:')) {
    value = value.slice('git@github.com:'.length);
  } else if (/^(https?:\/\/)?(www\.)?github\.com\//i.test(value)) {
    value = value.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '');
  } else if (value.includes('://') || value.includes('?')) {
    return { ok: false, message: '只支持 github.com 仓库地址，或 owner/repo 形式。' };
  }
  value = value.replace(/\/+$/g, '').replace(/\.git$/i, '');
  const parts = value.split('/');
  if (parts.length !== 2) {
    return { ok: false, message: '请填写 owner/repo 或 https://github.com/owner/repo。' };
  }
  const owner = parts[0]!.trim();
  const name = parts[1]!.trim();
  if (!REPO_PART_RE.test(owner) || !REPO_PART_RE.test(name)) {
    return { ok: false, message: '仓库名只能包含字母、数字、下划线、点和短横线。' };
  }
  if (owner === '.' || owner === '..' || name === '.' || name === '..') {
    return { ok: false, message: '仓库名不合法。' };
  }
  return { ok: true, owner, name, fullName: `${owner}/${name}` };
}

type RawRepo = {
  id?: number;
  full_name?: string;
  name?: string;
  owner?: { login?: string };
  description?: string | null;
  html_url?: string;
  language?: string | null;
  archived?: boolean;
  fork?: boolean;
  default_branch?: string;
  stargazers_count?: number;
  open_issues_count?: number;
  pushed_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  license?: { spdx_id?: string | null; name?: string | null; url?: string | null } | null;
};

function mapRepo(raw: RawRepo, via: 'search' | 'direct', fetchedAt: number, apiUrl: string): RepoCandidate | null {
  const fullName = String(raw.full_name ?? '').trim();
  if (!fullName || !fullName.includes('/')) return null;
  const [owner = '', name = ''] = fullName.split('/');
  return {
    id: fullName,
    fullName,
    owner,
    name,
    description: typeof raw.description === 'string' ? raw.description : null,
    htmlUrl: String(raw.html_url ?? `https://github.com/${fullName}`),
    language: typeof raw.language === 'string' ? raw.language : null,
    archived: Boolean(raw.archived),
    fork: Boolean(raw.fork),
    defaultBranch: typeof raw.default_branch === 'string' ? raw.default_branch : null,
    stars: typeof raw.stargazers_count === 'number' ? raw.stargazers_count : null,
    openIssues: typeof raw.open_issues_count === 'number' ? raw.open_issues_count : null,
    pushedAt: raw.pushed_at ?? null,
    updatedAt: raw.updated_at ?? null,
    createdAt: raw.created_at ?? null,
    license: raw.license
      ? {
          spdxId: raw.license.spdx_id ?? null,
          name: raw.license.name ?? null,
          url: raw.license.url ?? null,
        }
      : null,
    fetchedAt,
    via,
    apiUrl,
  };
}

export async function searchRepositories(
  query: string,
  options: RequestOptions & { perPage?: number } = {}
): Promise<{ candidates: RepoCandidate[]; total: number; incomplete: boolean; rate: GithubRateInfo; fetchedAt: number }> {
  const perPage = Math.max(1, Math.min(10, options.perPage ?? 10));
  const q = query.trim();
  if (!q) throw new GithubApiError('invalid_repo', '检索词不能为空。');
  const path = `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`;
  const { data, rate } = await githubRequest<{ items?: RawRepo[]; total_count?: number; incomplete_results?: boolean }>(
    path,
    { ...options, category: 'search' }
  );
  const fetchedAt = Date.now();
  const candidates = (data.items ?? [])
    .map((item) => mapRepo(item, 'search', fetchedAt, `https://api.github.com/repos/${item.full_name ?? ''}`))
    .filter((item): item is RepoCandidate => item !== null);
  return {
    candidates,
    total: typeof data.total_count === 'number' ? data.total_count : candidates.length,
    incomplete: Boolean(data.incomplete_results),
    rate,
    fetchedAt,
  };
}

export async function getRepository(
  owner: string,
  name: string,
  options: RequestOptions = {}
): Promise<{ candidate: RepoCandidate; rate: GithubRateInfo }> {
  const fullName = `${owner}/${name}`;
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const { data, rate } = await githubRequest<RawRepo>(path, {
    ...options,
    category: 'detail',
    repoKey: fullName,
  });
  const candidate = mapRepo(data, 'direct', Date.now(), `${GITHUB_API_BASE}${path}`);
  if (!candidate) throw new GithubApiError('invalid_response', 'GitHub 返回的仓库信息不完整。');
  return { candidate, rate };
}

/** 用于设置页验证 Token：只读取当前登录用户名与额度，不读取任何用户内容。 */
export async function getGithubUser(token: string): Promise<{
  login: string;
  scopes: string | null;
  rate: GithubRateInfo;
}> {
  const { data, rate, headers } = await githubRequest<{ login?: string }>('/user', {
    token,
    timeoutMs: 10_000,
    retries: 0,
  });
  return {
    login: typeof data.login === 'string' ? data.login : '（未知用户）',
    scopes: headers.get('x-oauth-scopes'),
    rate,
  };
}

export function repoMetaExcerpt(candidate: RepoCandidate): string {  const license = candidate.license
    ? `${candidate.license.spdxId ?? '未知 SPDX'}（${candidate.license.name ?? '未命名'}）`
    : 'GitHub 未检测到许可证';
  return [
    `仓库：${candidate.fullName}`,
    `描述：${candidate.description?.trim() || '（无描述）'}`,
    `主要语言：${candidate.language ?? '未标注'}`,
    `归档状态：${candidate.archived ? '已归档（作者不再维护）' : '未归档'}`,
    `Fork：${candidate.fork ? '是（可能是二次开发）' : '否'}`,
    `Star（背景信息）：${candidate.stars ?? '未知'}`,
    `默认分支：${candidate.defaultBranch ?? '未知'}`,
    `最近推送（pushed_at）：${candidate.pushedAt ?? '未知'}`,
    `元数据最近更新（updated_at，非代码提交时间）：${candidate.updatedAt ?? '未知'}`,
    `GitHub 许可证检测：${license}`,
  ].join('\n');
}

type ReadmeResponse = {
  name?: string;
  path?: string;
  sha?: string;
  html_url?: string;
  download_url?: string | null;
  encoding?: string;
  content?: string;
  size?: number;
};

export async function getReadme(
  candidate: RepoCandidate,
  options: RequestOptions & { maxChars: number }
): Promise<RepoDetail['readme']> {
  const path = `/repos/${encodeURIComponent(candidate.owner)}/${encodeURIComponent(candidate.name)}/readme`;
  try {
    const { data } = await githubRequest<ReadmeResponse>(path, {
      ...options,
      category: 'detail',
      repoKey: candidate.fullName,
    });
    const htmlUrl = String(data.html_url ?? candidate.htmlUrl);
    if (!data.content || data.encoding === 'none' || (data.size ?? 0) > 1_000_000) {
      return {
        status: 'missing',
        url: htmlUrl,
        path: data.path ?? 'README',
        sha: data.sha ?? null,
        text: '',
        note: 'README 过大或 GitHub 未返回正文，未读取内容。',
      };
    }
    const raw = Buffer.from(String(data.content).replace(/\n/g, ''), 'base64').toString('utf8');
    const max = Math.max(500, options.maxChars);
    const truncated = raw.length > max;
    const text = truncated ? `${raw.slice(0, max)}\n[已截断：仅保留前 ${max} 个字符]` : raw;
    return {
      status: 'ok',
      url: htmlUrl,
      path: data.path ?? 'README',
      sha: data.sha ?? null,
      text,
      note: truncated ? `README 原文超过 ${max} 字符，已截断。` : null,
    };
  } catch (error) {
    if (error instanceof GithubApiError && error.code === 'not_found') {
      return {
        status: 'missing',
        url: `${candidate.htmlUrl}#readme`,
        path: 'README',
        sha: null,
        text: '',
        note: 'GitHub 未找到 README（HTTP 404）。',
      };
    }
    throw error;
  }
}

type LicenseResponse = {
  name?: string;
  path?: string;
  sha?: string;
  html_url?: string;
  license?: { spdx_id?: string | null; name?: string | null } | null;
};

export async function getLicense(
  candidate: RepoCandidate,
  options: RequestOptions = {}
): Promise<RepoDetail['license']> {
  const path = `/repos/${encodeURIComponent(candidate.owner)}/${encodeURIComponent(candidate.name)}/license`;
  try {
    const { data } = await githubRequest<LicenseResponse>(path, {
      ...options,
      category: 'detail',
      repoKey: candidate.fullName,
    });
    const spdxId = data.license?.spdx_id ?? candidate.license?.spdxId ?? null;
    const name = data.license?.name ?? data.name ?? candidate.license?.name ?? null;
    return {
      status: 'ok',
      url: String(data.html_url ?? candidate.htmlUrl),
      path: data.path ?? 'LICENSE',
      sha: data.sha ?? null,
      spdxId,
      name,
      text: `GitHub 检测到的许可证：${spdxId ?? '未知 SPDX'}（${name ?? '未命名'}）。文件：${
        data.path ?? 'LICENSE'
      }。这只描述仓库自身的许可证声明，不覆盖依赖许可证或你的具体使用方式。`,
      note: null,
    };
  } catch (error) {
    if (error instanceof GithubApiError && error.code === 'not_found') {
      return {
        status: 'missing',
        url: `${candidate.htmlUrl}#license`,
        path: null,
        sha: null,
        spdxId: candidate.license?.spdxId ?? null,
        name: candidate.license?.name ?? null,
        text: candidate.license
          ? `仓库元数据检测到许可证：${candidate.license.spdxId ?? '未知'}，但许可证文件接口返回 404。需以仓库文件为准。`
          : 'GitHub 未检测到许可证文件（HTTP 404）。未声明许可证不等于可以直接商用。',
        note: candidate.license ? '许可证文件缺失，元数据与文件不一致。' : '未检测到许可证。',
      };
    }
    throw error;
  }
}

type ReleaseResponse = {
  tag_name?: string;
  name?: string | null;
  published_at?: string | null;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  body?: string | null;
};

export async function getReleases(
  candidate: RepoCandidate,
  options: RequestOptions & { maxChars: number }
): Promise<RepoDetail['releases']> {
  const path = `/repos/${encodeURIComponent(candidate.owner)}/${encodeURIComponent(candidate.name)}/releases?per_page=3`;
  try {
    const { data } = await githubRequest<ReleaseResponse[]>(path, {
      ...options,
      category: 'detail',
      repoKey: candidate.fullName,
    });
    if (!Array.isArray(data) || data.length === 0) {
      return {
        status: 'missing',
        url: `${candidate.htmlUrl}/releases`,
        text: '该仓库没有公开 Release。',
        note: '没有发布信息可核对。',
      };
    }
    const max = Math.max(300, Math.min(options.maxChars, 1500));
    const lines: string[] = [];
    for (const release of data.slice(0, 3)) {
      const body = (release.body ?? '').replace(/\r/g, '').trim();
      const snippet = body.length > 300 ? `${body.slice(0, 300)}…` : body;
      lines.push(
        [
          `版本：${release.tag_name ?? '未命名'}`,
          `名称：${release.name ?? '（无）'}`,
          `发布时间：${release.published_at ?? '未知'}`,
          `预发布：${release.prerelease ? '是' : '否'} · 草稿：${release.draft ? '是' : '否'}`,
          `链接：${release.html_url ?? '未知'}`,
          snippet ? `说明摘录：${snippet}` : '说明摘录：（无）',
        ].join('\n')
      );
    }
    let text = lines.join('\n\n');
    if (text.length > max) text = `${text.slice(0, max)}\n[已截断]`;
    return {
      status: 'ok',
      url: `${candidate.htmlUrl}/releases`,
      text,
      note: null,
    };
  } catch (error) {
    if (error instanceof GithubApiError && error.code === 'not_found') {
      return {
        status: 'missing',
        url: `${candidate.htmlUrl}/releases`,
        text: 'Release 接口返回 404。',
        note: '没有可核对的发布信息。',
      };
    }
    throw error;
  }
}

/** 读取单个仓库的全部资料。README/许可证/发布失败不抛出，由调用方记录为部分失败。 */
export async function readRepositoryDetail(
  owner: string,
  name: string,
  options: RequestOptions & { maxReadmeChars: number; maxReleaseChars: number }
): Promise<RepoDetail> {
  const { candidate } = await getRepository(owner, name, options);
  let readme: RepoDetail['readme'];
  try {
    readme = await getReadme(candidate, {
      ...options,
      maxChars: options.maxReadmeChars,
    });
  } catch (error) {
    const detail = error instanceof GithubApiError ? `${error.code}：${error.detail}` : '读取 README 失败';
    readme = {
      status: 'missing',
      url: `${candidate.htmlUrl}#readme`,
      path: 'README',
      sha: null,
      text: '',
      note: `README 读取失败：${detail}`,
    };
  }
  let license: RepoDetail['license'];
  try {
    license = await getLicense(candidate, options);
  } catch (error) {
    const detail = error instanceof GithubApiError ? `${error.code}：${error.detail}` : '读取许可证失败';
    license = {
      status: 'missing',
      url: `${candidate.htmlUrl}#license`,
      path: null,
      sha: null,
      spdxId: candidate.license?.spdxId ?? null,
      name: candidate.license?.name ?? null,
      text: `许可证读取失败：${detail}`,
      note: '许可证信息未能核实。',
    };
  }
  let releases: RepoDetail['releases'];
  try {
    releases = await getReleases(candidate, {
      ...options,
      maxChars: options.maxReleaseChars,
    });
  } catch (error) {
    const detail = error instanceof GithubApiError ? `${error.code}：${error.detail}` : '读取发布信息失败';
    releases = {
      status: 'missing',
      url: `${candidate.htmlUrl}/releases`,
      text: `发布信息读取失败：${detail}`,
      note: '发布信息未能核实。',
    };
  }
  return { candidate, readme, license, releases };
}
