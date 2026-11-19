// 研究一下：研究详情（问题与限制 → 候选 → 资料与对比 → 小实验）
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api, { ApiError } from '../api';
import type {
  ResearchExperiment,
  ResearchProject,
  ResearchPublic,
  ResearchResult,
  ResearchSource,
} from '../types';
import {
  RESEARCH_SOURCE_KIND_LABEL,
  RESEARCH_STATUS_LABEL,
  formatTime,
  newOperationId,
  researchErrorText,
} from '../types';

const ACTIVE: Array<ResearchPublic['status']> = ['searching', 'fetching', 'generating'];

function githubDate(value: string | null | undefined): string {
  if (!value) return '未知';
  const time = Date.parse(value);
  return Number.isFinite(time) ? formatTime(time) : '时间格式无法识别';
}

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    return e.body?.message || researchErrorText(e.body?.error, fallback);
  }
  return fallback;
}

function sourceStatusText(source: ResearchSource): string {
  if (source.status === 'missing') return '资料缺失';
  if (source.status === 'failed') return '读取失败';
  return '已获取';
}

function sourceKindLabel(kind: string): string {
  return RESEARCH_SOURCE_KIND_LABEL[kind] ?? kind;
}

function SourceCard({
  source,
  expanded,
  onToggle,
  cited,
}: {
  source: ResearchSource;
  expanded: boolean;
  onToggle: () => void;
  cited: boolean;
}) {
  return (
    <article
      id={`source-${source.sourceKey}`}
      className={`source-card${cited ? ' cited' : ''}${source.status !== 'ok' ? ' incomplete' : ''}`}
    >
      <button type="button" className="source-card-head" onClick={onToggle} aria-expanded={expanded}>
        <span className="source-key">{source.sourceKey}</span>
        <span className="source-kind">{sourceKindLabel(source.kind)}</span>
        <span className={`badge ${source.status === 'ok' ? 'ok' : 'warn'}`}>{sourceStatusText(source)}</span>
        <span className="source-toggle">{expanded ? '收起' : '展开'}</span>
      </button>
      <div className="source-meta mono">
        <a href={source.url} target="_blank" rel="noreferrer noopener">
          {source.url}
        </a>
        <span>获取于 {formatTime(source.fetchedAt)}</span>
        {source.filePath && <span>文件 {source.filePath}</span>}
        {source.refName && <span>分支 {source.refName}</span>}
        {source.commitSha && <span>版本/文件 sha {source.commitSha.slice(0, 12)}</span>}
      </div>
      {source.errorDetail && source.status !== 'ok' && <p className="hint warn">{source.errorDetail}</p>}
      {expanded && <pre className="source-excerpt">{source.excerpt || '（无正文）'}</pre>}
    </article>
  );
}

function Citations({
  items,
  onJump,
}: {
  items: Array<{ text: string; sourceIds: string[] }>;
  onJump: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="citation-list">
      {items.map((item, index) => (
        <li key={`${item.text}-${index}`}>
          <span>{item.text}</span>
          <span className="citation-chips">
            {item.sourceIds.map((id) => (
              <button key={id} type="button" className="source-chip" onClick={() => onJump(id)} title="跳到来源">
                {id}
              </button>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ProjectCard({ project, onJump }: { project: ResearchProject; onJump: (id: string) => void }) {
  return (
    <article className="research-project">
      <header>
        <h4>{project.repo}</h4>
        <span className="badge subtle">模型推断</span>
      </header>
      <p className="research-project-summary">{project.summary}</p>
      {project.matches.length > 0 && (
        <>
          <h5>明确匹配</h5>
          <Citations items={project.matches} onJump={onJump} />
        </>
      )}
      {project.gaps.length > 0 && (
        <>
          <h5>缺口或适用条件</h5>
          <Citations items={project.gaps} onJump={onJump} />
        </>
      )}
      {project.unknowns.length > 0 && (
        <>
          <h5>仍未核实</h5>
          <ul className="plain-list">
            {project.unknowns.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {project.licenseNote && (
        <p className="hint">
          <strong>许可证提示：</strong>
          {project.licenseNote}
        </p>
      )}
    </article>
  );
}

export default function ResearchPage() {
  const { researchId = '' } = useParams<{ researchId: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<ResearchPublic | null>(null);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [hasGithubToken, setHasGithubToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [adopt, setAdopt] = useState<{
    index: number;
    title: string;
    description: string;
    minutes: string;
    operationId: string;
  } | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const pollRef = useRef<number | null>(null);

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const res = await api.getResearch(researchId);
      if (!mountedRef.current) return;
      setRun(res.research);
      setAiEnabled(res.ai.enabled);
      setHasGithubToken(res.github.hasToken);
      setSelected((current) => {
        if (res.research.status === 'candidates') {
          return current.filter((id) => res.research.candidates.some((item) => item.id === id));
        }
        return res.research.selectedCandidateIds;
      });
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      if (e instanceof ApiError && e.status === 404) {
        setError('这次研究不存在，可能已被删除。');
      } else {
        setError(errText(e, '无法读取这次研究。'));
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchId]);

  useEffect(() => {
    if (!run) return;
    if (pollRef.current) window.clearTimeout(pollRef.current);
    if (!ACTIVE.includes(run.status)) return;
    pollRef.current = window.setTimeout(() => {
      void load(true);
    }, 1300);
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.status, run?.updatedAt, researchId]);

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(errText(e, '操作失败，请稍后再试。'));
    } finally {
      setBusy(null);
    }
  }

  function toggleSelect(id: string) {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 3) return current;
      return [...current, id];
    });
  }

  async function confirmSelection() {
    if (!run || selected.length === 0) return;
    await withBusy('select', async () => {
      const res = await api.selectResearchCandidates(run.id, selected);
      setRun(res.research);
      setNotice('已开始读取所选仓库；每份资料会标出来源与获取时间。');
    });
  }

  async function cancelRun() {
    if (!run) return;
    await withBusy('cancel', async () => {
      const res = await api.cancelResearch(run.id);
      setRun(res.research);
      setNotice('已取消。迟到的响应不会再激活这次研究。');
    });
  }

  async function retry(action: 'search' | 'fetch' | 'generate', repoIds: string[] = []) {
    if (!run) return;
    await withBusy(`retry-${action}`, async () => {
      const res = await api.retryResearch(run.id, action, repoIds);
      setRun(res.research);
      setNotice('已重新开始，保留已经取得的有效资料。');
    });
  }

  async function save() {
    if (!run) return;
    await withBusy('save', async () => {
      const res = await api.saveResearch(run.id);
      setRun(res.research);
      setNotice('研究已保存，可以稍后从「研究」列表重新打开。');
    });
  }

  async function remove() {
    if (!run) return;
    await withBusy('delete', async () => {
      await api.deleteResearch(run.id);
      navigate(`/capture/${run.captureId}`);
    });
  }

  function openAdopt(index: number, experiment: ResearchExperiment) {
    setAdopt({
      index,
      title: experiment.title,
      description: experiment.description,
      minutes: experiment.estimatedMinutes === null ? '' : String(experiment.estimatedMinutes),
      operationId: newOperationId(),
    });
    setAdoptError(null);
  }

  async function submitAdopt() {
    if (!run || !adopt || adopting) return;
    setAdopting(true);
    setAdoptError(null);
    try {
      const minutes = adopt.minutes.trim() === '' ? null : Number.parseInt(adopt.minutes, 10);
      if (minutes !== null && (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440)) {
        setAdoptError('预计用时请填写 1–1440 分钟，或留空。');
        setAdopting(false);
        return;
      }
      if (!adopt.title.trim()) {
        setAdoptError('请填写行动标题。');
        setAdopting(false);
        return;
      }
      const res = await api.acceptResearchExperiment(run.id, adopt.index, {
        title: adopt.title,
        description: adopt.description,
        estimatedMinutes: minutes,
        expectedRevision: run.revision,
        operationId: adopt.operationId,
      });
      navigate(`/attempt/${res.attempt.id}`);
    } catch (e) {
      setAdoptError(errText(e, '采用失败，请刷新后重试。'));
      setAdopting(false);
    }
  }

  function jumpToSource(sourceId: string) {
    setExpandedSources((current) => ({ ...current, [sourceId]: true }));
    window.setTimeout(() => {
      document.getElementById(`source-${sourceId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  }

  if (loading) return <div className="app-loading">正在读取研究…</div>;
  if (error || !run) {
    return (
      <div className="empty-state">
        <h3>研究不存在</h3>
        <p>{error ?? '无法读取这次研究。'}</p>
        <Link className="btn" to="/research">返回研究列表</Link>
      </div>
    );
  }

  const result: ResearchResult | null = run.result;
  const sourcesByRepo = new Map<string, ResearchSource[]>();
  for (const source of run.sources) {
    const list = sourcesByRepo.get(source.repoFullName) ?? [];
    list.push(source);
    sourcesByRepo.set(source.repoFullName, list);
  }
  const citedIds = new Set<string>();
  for (const project of result?.projects ?? []) {
    for (const citation of [...project.matches, ...project.gaps]) {
      citation.sourceIds.forEach((id) => citedIds.add(id));
    }
  }
  for (const experiment of result?.experiments ?? []) {
    experiment.sourceIds.forEach((id) => citedIds.add(id));
  }
  const failedRepos = run.selectedCandidateIds.filter((repo) =>
    run.sources.some((source) => source.repoFullName === repo && source.status === 'failed')
  );
  const problemRepos = run.selectedCandidateIds.filter((repo) =>
    run.sources.some((source) => source.repoFullName === repo && source.status !== 'ok')
  );
  const active = ACTIVE.includes(run.status);
  const stage2Tone = run.status === 'searching' ? 'active' : run.candidates.length > 0 ? 'done' : 'idle';
  const stage3Tone =
    run.status === 'fetching' || run.status === 'generating'
      ? 'active'
      : run.sources.length > 0
        ? 'done'
        : 'idle';
  const stage4Tone = result ? 'done' : 'idle';
  const constraintsText = Object.entries(run.constraints ?? {}).filter(([, value]) => Boolean(value));

  return (
    <div className="research-page">
      <header className="detail-header research-header">
        <div className="research-breadcrumb">
          <Link to={`/capture/${run.captureId}`}>← 回到念头</Link>
          <Link to="/research">全部研究</Link>
        </div>
        <div className="research-title-row">
          <h2>{run.question}</h2>
          <span className={`badge research-status ${run.status}`}>{RESEARCH_STATUS_LABEL[run.status]}</span>
        </div>
        <p className="card-meta">
          来源念头 revision {run.captureRevision} · 研究版本 {run.revision} · 创建于 {formatTime(run.createdAt)}
          {run.savedAt ? ` · 已保存于 ${formatTime(run.savedAt)}` : ' · 未保存'}
        </p>
        <div className="row-actions">
          {active && (
            <button className="btn small danger" onClick={cancelRun} disabled={busy === 'cancel'}>
              {busy === 'cancel' ? '取消中…' : '取消研究'}
            </button>
          )}
          {run.canSave && (
            <button className="btn small primary" onClick={save} disabled={busy === 'save'}>
              {run.saved ? '已保存' : busy === 'save' ? '保存中…' : '保存研究'}
            </button>
          )}
          {!active && (
            <>
              <button className="btn small" onClick={() => setDeleteConfirm(true)}>删除研究…</button>
              <Link className="btn small ghost" to={`/capture/${run.captureId}?research=1`}>
                修改问题，重新研究
              </Link>
            </>
          )}
        </div>
        {notice && <p className="save-ok" role="status">{notice}</p>}
        {actionError && <p className="error-msg" role="alert">{actionError}</p>}
        {(run.errorCode || run.errorDetail) && (
          <div className="research-error" role="alert">
            <strong>{run.errorMessage ?? researchErrorText(run.errorCode)}</strong>
            {run.errorDetail && <p>{run.errorDetail}</p>}
            {run.errorCode === 'rate_limited' && (
              <p className="hint">
                {run.candidatesRate?.resetAt
                  ? `额度重置时间：${formatTime(run.candidatesRate.resetAt)}。`
                  : 'GitHub 公开读取额度有限。'}
                {!hasGithubToken && (
                  <>
                    {' '}可在 <Link to="/settings/ai">设置页</Link> 配置 GitHub Token；Token 只发送给 GitHub API。
                  </>
                )}
              </p>
            )}
            {!aiEnabled && run.sources.length > 0 && (
              <p className="hint">资料已经获取，可以先查看来源；配置并启用模型后，可重试生成对比。</p>
            )}
            <div className="row-actions">
              {run.canRetrySearch && (
                <button className="btn small" onClick={() => retry('search')} disabled={Boolean(busy)}>
                  重新检索
                </button>
              )}
              {run.canRetryFetch && (
                <button
                  className="btn small"
                  onClick={() => retry('fetch', problemRepos)}
                  disabled={Boolean(busy)}
                >
                  重试读取（保留已获取资料）
                </button>
              )}
              {run.canRetryGenerate && aiEnabled && (
                <button className="btn small" onClick={() => retry('generate')} disabled={Boolean(busy)}>
                  重新生成对比
                </button>
              )}
            </div>
          </div>
        )}
      </header>

      <nav className="research-steps" aria-label="研究阶段">
        <span className="research-step done">1 问题与限制</span>
        <span className={`research-step ${stage2Tone}`}>2 候选仓库</span>
        <span className={`research-step ${stage3Tone}`}>3 资料与对比</span>
        <span className={`research-step ${stage4Tone}`}>4 小实验</span>
      </nav>

      <div className="research-layout">
        <main className="research-main">
          {run.status === 'searching' && (
            <section className="section research-stage">
              <div className="loading-row">
                <span className="spinner" aria-hidden="true" />
                <div>
                  <h4>正在向 GitHub 检索</h4>
                  <p className="hint">
                    {run.search.display} · 最多返回 {run.limits.maxCandidates} 个候选
                  </p>
                </div>
              </div>
            </section>
          )}

          {active && run.status !== 'searching' && (
            <section className="section research-stage">
              <div className="loading-row">
                <span className="spinner" aria-hidden="true" />
                <div>
                  <h4>
                    {run.status === 'fetching'
                      ? '正在读取所选仓库的 README、许可证与发布信息'
                      : '正在用已获取的资料生成对比'}
                  </h4>
                  <p className="hint">
                    已获取 {run.sources.length} 份资料；失败项会保留，并可在结束后重试。
                  </p>
                </div>
              </div>
            </section>
          )}

          {(run.status === 'candidates' || (run.status === 'failed' && run.candidates.length > 0)) && (
            <section className="section research-stage" id="candidates">
              <div className="section-head">
                <h3>候选仓库</h3>
                <span className="hint">
                  已找到 {run.candidates.length} 个候选
                  {run.candidatesTotal !== null && run.candidatesTotal > run.candidates.length
                    ? `（GitHub 共 ${run.candidatesTotal} 个，只取前 ${run.candidates.length}）`
                    : ''}
                  ，选择 1–3 个深入读取
                </span>
              </div>
              {run.candidates.length === 0 ? (
                <div className="empty-state">
                  <p>没有可用候选。</p>
                  {run.canRetrySearch && (
                    <button className="btn" onClick={() => retry('search')}>重新检索</button>
                  )}
                </div>
              ) : (
                <>
                  <div className="candidate-list">
                    {run.candidates.map((candidate) => {
                      const checked = selected.includes(candidate.id);
                      const disabled = !checked && selected.length >= run.limits.maxSelected;
                      return (
                        <article
                          key={candidate.id}
                          className={`candidate-card${checked ? ' selected' : ''}${disabled ? ' disabled' : ''}`}
                        >
                          <button
                            type="button"
                            className="candidate-select"
                            onClick={() => toggleSelect(candidate.id)}
                            disabled={disabled}
                            aria-pressed={checked}
                          >
                            <span className="candidate-check">{checked ? '✓' : '+'}</span>
                            <span>
                              {checked ? '已选择' : '选择比较'}
                            </span>
                          </button>
                          <h4>
                            <a href={candidate.htmlUrl} target="_blank" rel="noreferrer noopener">
                              {candidate.fullName}
                            </a>
                            {candidate.archived && <span className="badge warn">已归档</span>}
                            {candidate.fork && <span className="badge subtle">Fork</span>}
                          </h4>
                          <p className="candidate-desc">{candidate.description || '（没有仓库描述）'}</p>
                          <dl className="candidate-facts">
                            <div>
                              <dt>主要语言</dt>
                              <dd>{candidate.language ?? '未标注'}</dd>
                            </div>
                            <div>
                              <dt>许可证</dt>
                              <dd>{candidate.license?.spdxId ?? 'GitHub 未检测到'}</dd>
                            </div>
                            <div>
                              <dt>Star（背景）</dt>
                              <dd>{candidate.stars ?? '未知'}</dd>
                            </div>
                            <div>
                              <dt>最近推送</dt>
                              <dd>{githubDate(candidate.pushedAt)}</dd>
                            </div>
                            <div>
                              <dt>元数据更新时间</dt>
                              <dd className="hint">
                                {githubDate(candidate.updatedAt)}
                                （非代码提交时间）
                              </dd>
                            </div>
                          </dl>
                        </article>
                      );
                    })}
                  </div>
                  {run.candidates.length < 5 && (
                    <p className="hint">候选较少时，可回到念头修改检索词或直接填写仓库地址再研究。</p>
                  )}
                  <div className="select-bar">
                    <span>
                      已选 {selected.length}/{run.limits.maxSelected} 个
                      {selected.length > 0 ? `：${selected.join('、')}` : ''}
                    </span>
                    <button
                      className="btn primary"
                      type="button"
                      onClick={confirmSelection}
                      disabled={selected.length === 0 || busy === 'select'}
                    >
                      {busy === 'select' ? '正在开始…' : `深入比较这 ${selected.length} 个`}
                    </button>
                  </div>
                </>
              )}
              {run.candidateFailures.length > 0 && (
                <div className="failure-list">
                  {run.candidateFailures.map((failure) => (
                    <p key={`${failure.id}-${failure.fetchedAt}`} className="hint warn">
                      读取 {failure.fullName ?? failure.input} 失败：
                      {researchErrorText(failure.code)} — {failure.detail}
                    </p>
                  ))}
                </div>
              )}
            </section>
          )}

          {run.sources.length > 0 && (
            <section className="section research-stage" id="sources">
              <div className="section-head">
                <h3>已获取的资料</h3>
                <span className="hint">
                  {run.sources.filter((source) => source.status === 'ok').length} 份可用 ·{' '}
                  {run.sources.filter((source) => source.status === 'missing').length} 份缺失 ·{' '}
                  {failedRepos.length} 个仓库读取失败
                </span>
              </div>
              <div className="evidence-legend">
                <span><i className="dot claim" /> 仓库作者的声明（README）</span>
                <span><i className="dot fact" /> 本次实际查到的元数据/文件</span>
                <span><i className="dot infer" /> 模型根据资料推断</span>
                <span><i className="dot test" /> 待实际测试（小实验）</span>
              </div>
              {Array.from(sourcesByRepo.entries()).map(([repo, repoSources]) => (
                <div className="repo-sources" key={repo}>
                  <div className="repo-source-head">
                    <h4>{repo}</h4>
                    {repoSources.some((source) => source.status === 'failed') && (
                      <button
                        className="btn small"
                        onClick={() => retry('fetch', [repo])}
                        disabled={Boolean(busy)}
                      >
                        {busy === 'retry-fetch' ? '重试中…' : '重试这个仓库'}
                      </button>
                    )}
                  </div>
                  {repoSources.map((source) => (
                    <SourceCard
                      key={source.sourceKey}
                      source={source}
                      cited={citedIds.has(source.sourceKey)}
                      expanded={Boolean(expandedSources[source.sourceKey])}
                      onToggle={() =>
                        setExpandedSources((current) => ({
                          ...current,
                          [source.sourceKey]: !current[source.sourceKey],
                        }))
                      }
                    />
                  ))}
                </div>
              ))}
              <p className="hint">
                许可证行只代表 GitHub 检测结果与仓库文件，不覆盖依赖许可证或你的具体使用方式；未检测到许可证不等于可以直接商用。
                README 等外部内容按不可信资料处理，不会改变模型权限或发送范围。
              </p>
            </section>
          )}

          {result && (
            <section className="section research-stage" id="comparison">
              <div className="section-head">
                <h3>对比结果</h3>
                <span className="badge subtle">模型推断 · 引用本次资料</span>
              </div>
              {result.insufficient && (
                <div className="insufficient">
                  <strong>暂时无法判断</strong>
                  <p>{result.summary}</p>
                </div>
              )}
              {!result.insufficient && <p className="research-summary">{result.summary}</p>}
              {result.projects.map((project) => (
                <ProjectCard key={project.repo} project={project} onJump={jumpToSource} />
              ))}
              {result.limitations.length > 0 && (
                <div className="research-limitations">
                  <h5>限制与未覆盖</h5>
                  <ul className="plain-list">
                    {result.limitations.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="hint">
                硬件兼容、运行效果和实现难度只有在来源中有明确依据时才成立；没有依据的部分会列在「仍未核实」。
              </p>
            </section>
          )}

          {result && (
            <section className="section research-stage" id="experiments">
              <div className="section-head">
                <h3>可以先做的小实验</h3>
                <span className="badge test">待实际测试</span>
              </div>
              {result.experiments.length === 0 ? (
                <p className="hint">这次对比没有给出可执行的小实验；可以保存研究，或调整问题后重新研究。</p>
              ) : (
                <div className="experiment-list">
                  {result.experiments.map((experiment, index) => {
                    const adopted = run.attempts.find((item) => item.experimentIndex === index);
                    const editing = adopt?.index === index;
                    return (
                      <article className="experiment-card" key={`${experiment.title}-${index}`}>
                        <header>
                          <span className="experiment-index">实验 {index + 1}</span>
                          {experiment.estimatedMinutes !== null && (
                            <span className="badge subtle">约 {experiment.estimatedMinutes} 分钟</span>
                          )}
                          {adopted && (
                            <Link className="badge ok link-badge" to={`/attempt/${adopted.attemptId}`}>
                              已采用为尝试
                            </Link>
                          )}
                        </header>
                        <h4>{experiment.title}</h4>
                        <p>{experiment.description}</p>
                        <p className="hint">
                          <strong>验证：</strong>{experiment.verifies} · 仓库 {experiment.repo}
                        </p>
                        <div className="citation-chips">
                          {experiment.sourceIds.map((id) => (
                            <button key={id} type="button" className="source-chip" onClick={() => jumpToSource(id)}>
                              {id}
                            </button>
                          ))}
                        </div>
                        {!editing ? (
                          <div className="row-actions">
                            <button
                              className="btn small primary"
                              type="button"
                              onClick={() => openAdopt(index, experiment)}
                            >
                              编辑并试一步
                            </button>
                            {adopted && (
                              <Link className="btn small ghost" to={`/attempt/${adopted.attemptId}`}>
                                打开尝试
                              </Link>
                            )}
                          </div>
                        ) : (
                          <form
                            className="attempt-form adopt-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void submitAdopt();
                            }}
                          >
                            <p className="hint">
                              原始建议会保留在研究中；你编辑后的内容会成为实际采用的尝试。
                            </p>
                            <label className="field">
                              <span>行动标题</span>
                              <input
                                value={adopt.title}
                                onChange={(e) => setAdopt({ ...adopt, title: e.target.value })}
                                maxLength={500}
                                required
                                autoFocus
                              />
                            </label>
                            <label className="field">
                              <span>具体怎么做</span>
                              <textarea
                                value={adopt.description}
                                onChange={(e) => setAdopt({ ...adopt, description: e.target.value })}
                                rows={4}
                                maxLength={2000}
                              />
                            </label>
                            <label className="field">
                              <span>预计用时（分钟，可留空）</span>
                              <input
                                value={adopt.minutes}
                                onChange={(e) => setAdopt({ ...adopt, minutes: e.target.value })}
                                inputMode="numeric"
                                maxLength={4}
                              />
                            </label>
                            {adoptError && <p className="error-msg" role="alert">{adoptError}</p>}
                            <div className="row-actions">
                              <button className="btn primary" type="submit" disabled={adopting}>
                                {adopting ? '正在创建尝试…' : '采用并创建尝试'}
                              </button>
                              <button
                                className="btn ghost"
                                type="button"
                                onClick={() => {
                                  setAdopt(null);
                                  setAdoptError(null);
                                }}
                                disabled={adopting}
                              >
                                取消
                              </button>
                            </div>
                          </form>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
              {run.attempts.length > 0 && (
                <div className="research-attempts">
                  <h5>这次研究创建的尝试</h5>
                  <ul className="plain-list">
                    {run.attempts.map((item) => (
                      <li key={item.attemptId}>
                        <Link to={`/attempt/${item.attemptId}`}>{item.title}</Link>
                        <span className="hint"> · {formatTime(item.createdAt)} · {item.state}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {!active && !result && run.sources.length === 0 && (
            <section className="section research-stage">
              <div className="empty-state">
                <h3>这次研究还没有结果</h3>
                <p>{run.errorDetail ?? '可以重新检索，或回到念头修改问题。'}</p>
                {run.canRetrySearch && (
                  <button className="btn" onClick={() => retry('search')}>重新检索</button>
                )}
              </div>
            </section>
          )}
        </main>

        <aside className="research-aside">
          <section className="section research-side-card">
            <div className="section-head compact">
              <h4>问题与限制</h4>
              <Link className="hint" to={`/capture/${run.captureId}?research=1`}>修改</Link>
            </div>
            <p className="research-question">{run.question}</p>
            {constraintsText.length > 0 ? (
              <ul className="fact-list">
                {constraintsText.map(([key, value]) => (
                  <li key={key}>
                    <span>{key === 'goal' ? '想实现' : key === 'environment' ? '环境' : key === 'language' ? '语言' : key === 'timeBudget' ? '时间' : '条件'}</span>
                    <strong>{value}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">没有填写限制。</p>
            )}
            <p className="hint mono">检索：{run.search.display}</p>
            <p className="hint">
              上限：候选 {run.limits.maxCandidates} · 深入 {run.limits.maxSelected} · 单份 README{' '}
              {run.limits.maxReadmeChars} 字符 · 并发 {run.limits.concurrency}
            </p>
          </section>

          <section className="section research-side-card">
            <div className="section-head compact"><h4>本次用量</h4></div>
            <ul className="fact-list">
              <li><span>候选</span><strong>{run.stats?.candidates ?? run.candidates.length} 个</strong></li>
              <li><span>深入仓库</span><strong>{run.selectedCandidateIds.length} 个</strong></li>
              <li><span>资料</span><strong>{run.sources.length} 份</strong></li>
              <li><span>失败仓库</span><strong>{failedRepos.length} 个</strong></li>
              <li><span>GitHub 请求</span><strong>{run.stats?.github?.requests ?? '—'} 次</strong></li>
              <li><span>发送字符</span><strong>{run.stats?.promptChars ?? '—'}</strong></li>
              <li><span>模型</span><strong>{run.config.name ?? (aiEnabled ? '已配置' : '未配置')}</strong></li>
              <li>
                <span>Token 用量</span>
                <strong>
                  {run.usage
                    ? `${run.usage.totalTokens}（输入 ${run.usage.inputTokens} / 输出 ${run.usage.outputTokens}）`
                    : '—'}
                </strong>
              </li>
              {run.durationMs !== null && (
                <li><span>耗时</span><strong>{(run.durationMs / 1000).toFixed(1)} 秒</strong></li>
              )}
              <li><span>保存</span><strong>{run.savedAt ? formatTime(run.savedAt) : '未保存'}</strong></li>
            </ul>
            {!aiEnabled && (
              <p className="hint">
                模型未启用：资料仍可查看。<Link to="/settings/ai">去设置模型 →</Link>
              </p>
            )}
          </section>

          <section className="section research-side-card">
            <div className="section-head compact"><h4>来源念头</h4></div>
            <p className="hint clamp">{run.captureText}</p>
            <Link className="btn small ghost" to={`/capture/${run.captureId}`}>回到念头</Link>
          </section>
        </aside>
      </div>

      {deleteConfirm && (
        <div className="modal-backdrop" role="presentation" onClick={() => setDeleteConfirm(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3>删除这次研究？</h3>
            <p>
              将删除 {run.sources.length} 份已获取资料和对比结果。由这次研究创建的尝试会保留，
              但尝试里的「来源研究」会显示已删除。
            </p>
            <div className="row-actions">
              <button className="btn danger" onClick={remove} disabled={busy === 'delete'}>
                {busy === 'delete' ? '删除中…' : '确认删除'}
              </button>
              <button className="btn" onClick={() => setDeleteConfirm(false)} disabled={busy === 'delete'}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
