// 拾念 SHINIAN · 「问我的记录」回答展示（列表页与详情页复用）
import { useState } from 'react';
import { Link } from 'react-router-dom';
import api, { ApiError } from '../api';
import type { ExperienceDraft, AskPoint, AskPublic, AskSourcePublic } from '../types';
import {
  ASK_BASIS_LABEL,
  ASK_STATUS_LABEL,
  ASK_TYPE_LABEL,
  OUTCOME_LABEL,
  STATE_LABEL,
  askErrorText,
  experienceErrorText,
  formatTime,
} from '../types';
import ExperienceEditor from './ExperienceEditor';

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '未记录';
  if (ms < 1000) return `${ms} 毫秒`;
  const seconds = ms / 1000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)} 秒`;
}

function formatRange(from: number | null, to: number | null): string {
  if (from == null && to == null) return '不限日期';
  const start = from == null ? '不限' : formatTime(from);
  const end = to == null ? '不限' : formatTime(to);
  return `${start} 起（含）至 ${end}（不含）`;
}

/**
 * 服务端目前仍可能返回 /graph?focus=...；GraphPage 实际读取 /graph?node=。
 * 这里只在展示层转换参数，不修改 GraphPage，也不自行拼接节点 ID。
 */
function localGraphHref(href: string | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, 'http://shinian.local');
    if (url.pathname === '/graph' && url.searchParams.has('focus')) {
      const focused = url.searchParams.get('focus') ?? '';
      url.searchParams.delete('focus');
      url.searchParams.set('node', focused);
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return href;
  }
}

function sourceLabel(source: AskSourcePublic): string {
  const title = source.title || source.id;
  return `${ASK_TYPE_LABEL[source.type]} · ${truncate(title, 20)}`;
}

/**
 * 服务端把已删除来源的标题清洗成「来源已删除」，前端无法还原原标题；
 * 因此用「发送时的第 N 条」把被删的那一条定位到具体位置。
 */
function sourcePosition(sources: AskSourcePublic[], sourceKey: string): number {
  return sources.findIndex((item) => item.sourceKey === sourceKey) + 1;
}

/** 已删除来源在「发送时来源列表」里的位置（从 1 开始），用于把失效定位到具体一条。 */
function deletedSourcePositions(sources: AskSourcePublic[]): number[] {
  return sources
    .map((source, index) => ({ source, position: index + 1 }))
    .filter((item) => item.source.deleted || !item.source.exists)
    .map((item) => item.position);
}

/** 生成失败的上游错误码（types.ts 的 ASK_ERROR_LABEL 未覆盖）补一层可读中文与下一步。 */
const ASK_FAILURE_EXTRA: Record<string, string> = {
  model_unavailable: '目标模型不存在，或这个 API Key 无权使用该模型',
  auth: 'API Key 无效或没有权限',
  rate_limited: '模型服务限流或额度用尽',
  unreachable: '连不上模型服务（地址或网络有问题）',
  redirect_blocked: '模型服务返回了重定向，已被拦截',
  invalid_response: '模型返回的内容不是合法的回答格式',
};

/** 这些失败多半是配置问题：界面上应给出「去设置」直达入口。 */
const ASK_FAILURE_CONFIG_HINT = new Set(['model_unavailable', 'auth', 'unreachable', 'redirect_blocked']);

export function askFailureText(code?: string | null, fallback?: string | null): string {
  if (code && ASK_FAILURE_EXTRA[code]) {
    return `${askErrorText(code, fallback)}（${ASK_FAILURE_EXTRA[code]}）`;
  }
  return askErrorText(code, fallback);
}

export function askFailureNeedsConfig(code?: string | null): boolean {
  return Boolean(code && ASK_FAILURE_CONFIG_HINT.has(code));
}

/** 来源 chip 只由应用按 source.sourceKey 在 sources 里查找生成，不使用模型给出的任何链接。 */
function SourceChip({
  sourceId,
  sources,
}: {
  sourceId: string;
  sources: AskSourcePublic[];
}) {
  const source = sources.find((item) => item.sourceKey === sourceId);
  if (!source) {
    return <span className="ask-source-chip missing">来源不可用</span>;
  }
  const position = sourcePosition(sources, sourceId);
  if (source.deleted || !source.exists) {
    return (
      <span
        className="ask-source-chip deleted"
        title={`这次回答发送时的第 ${position} 条来源已被删除`}
      >
        来源#{position} 已删除
      </span>
    );
  }
  const label = sourceLabel(source);
  const withIndex = position > 0 ? `#${position} ${label}` : label;
  if (!source.openHref) {
    return <span className="ask-source-chip">{withIndex}</span>;
  }
  return (
    <Link className="ask-source-chip" to={source.openHref} title={source.title || source.id}>
      {withIndex}
    </Link>
  );
}

/** 来源列表独立导出：成功回答、失败/取消/中断，以及详情页都可只读浏览。 */
export function AskSourcesView({ query }: { query: AskPublic }) {
  const deletedCount = query.sources.filter((source) => source.deleted || !source.exists).length;
  const changedCount = query.sources.filter(
    (source) => source.changed && !source.deleted && source.exists
  ).length;
  const deletedPositions = deletedSourcePositions(query.sources);
  return (
    <section className="ask-sources" data-testid="ask-group-sources" aria-label="来源记录">
      <div className="section-head ask-sources-head">
        <h4>来源记录</h4>
        <span className="hint">
          {query.sources.length} 条
          {changedCount > 0 ? ` · ${changedCount} 条有更新` : ''}
          {deletedCount > 0 ? ` · 第 ${deletedPositions.join('、')} 条已删除` : ''}
          {query.hiddenPointCount > 0 ? ` · 隐藏 ${query.hiddenPointCount} 条内容` : ''}
        </span>
      </div>
      {query.sources.length === 0 ? (
        <p className="empty-state">这次回答没有可列出的来源。</p>
      ) : (
        <ul className="ask-source-list">
          {query.sources.map((source, index) => {
            const deleted = source.deleted || !source.exists;
            const dateValue = source.observedAt ?? source.createdAt;
            const graphHref = localGraphHref(source.graphHref);
            return (
              <li
                className={`ask-source-card${deleted ? ' deleted' : ''}${
                  source.changed && !deleted ? ' changed' : ''
                }`}
                key={source.sourceKey}
                data-testid="ask-source-card"
                data-source-position={index + 1}
              >
                <div className="ask-source-head">
                  <span className="badge">第 {index + 1} 条</span>
                  <span className={`badge ask-type-${source.type}`}>
                    {ASK_TYPE_LABEL[source.type]}
                  </span>
                  {!deleted && <span className="ask-source-title">{source.title || source.id}</span>}
                  {deleted && <span className="badge warn">来源已删除</span>}
                  {!deleted && source.changed && <span className="badge warn">来源有更新</span>}
                  {!deleted && source.archived && <span className="badge">已归档</span>}
                  {!deleted && source.type === 'attempt' && source.state && (
                    <span className={`badge state-${source.state}`}>{STATE_LABEL[source.state]}</span>
                  )}
                  {!deleted && source.outcome && (
                    <span className={`badge outcome-${source.outcome}`}>
                      {OUTCOME_LABEL[source.outcome]}
                    </span>
                  )}
                </div>

                {deleted ? (
                  <p className="hint">
                    发送时的第 {index + 1} 条来源（{ASK_TYPE_LABEL[source.type]}）已被删除，
                    正文和链接不再展示。
                  </p>
                ) : (
                  <>
                    <p className="ask-source-date">
                      {source.observedAt != null ? '结果时间' : '记录时间'}：
                      {dateValue != null ? formatTime(dateValue) : '未记录'}
                    </p>
                    {source.text && <p className="ask-source-text">{source.text}</p>}
                    {source.resultText ? (
                      <p className="ask-source-result">
                        <span className="ask-result-label">结果：</span>
                        {source.resultText}
                      </p>
                    ) : (
                      source.type === 'attempt' && <p className="hint">这条尝试没有记录结果。</p>
                    )}
                    {source.changed && (
                      <p className="ask-source-changed-note">
                        来源有更新：这里显示的是发送时的快照，打开原记录可查看当前内容。
                      </p>
                    )}
                    <div className="ask-source-links">
                      {source.openHref && (
                        <Link className="btn small" to={source.openHref} data-testid="ask-open-source">
                          打开原记录
                        </Link>
                      )}
                      {graphHref && (
                        <Link className="btn small" to={graphHref} data-testid="ask-graph-link">
                          在网络中查看
                        </Link>
                      )}
                      {source.type === 'attempt' && source.canReuse && (
                        <Link
                          className="btn small"
                          to={`/capture/${source.captureId}?experience=${encodeURIComponent(source.id)}`}
                          data-testid="ask-reuse-link"
                        >
                          用这条经验试一步
                        </Link>
                      )}
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PointItem({
  point,
  sources,
  pointIndex,
  onSaveExperience,
  canSave,
}: {
  point: AskPoint;
  sources: AskSourcePublic[];
  pointIndex: number;
  onSaveExperience: (pointIndex: number) => void;
  canSave: boolean;
}) {
  const observation = point.basis === 'observation';
  return (
    <li
      className={`ask-point ${point.basis}`}
      data-testid={observation ? 'ask-point-observation' : 'ask-point-inference'}
      data-basis={point.basis}
    >
      <div className="ask-point-head">
        <span className={`ask-basis ${point.basis}`}>{ASK_BASIS_LABEL[point.basis]}</span>
        <span className="ask-point-sources">
          {point.sourceIds.map((sourceId) => (
            <SourceChip key={sourceId} sourceId={sourceId} sources={sources} />
          ))}
        </span>
      </div>
      <p className="ask-point-text">{point.text}</p>
      {point.condition && point.condition.trim() ? (
        <p className="ask-point-condition">条件：{point.condition.trim()}</p>
      ) : observation ? (
        <p className="ask-point-condition empty">条件：记录没有写下条件</p>
      ) : null}
      {!observation && (
        <p className="ask-point-note">这是模型基于记录的推断，不是记录中的事实。</p>
      )}
      <div className="ask-point-actions">
        <button
          type="button"
          className="btn small"
          onClick={() => onSaveExperience(pointIndex)}
          disabled={!canSave}
          data-testid="ask-point-save-experience"
        >
          记成经验
        </button>
        <span className="hint">保存为经验 · 只会关联这条观点实际引用的来源</span>
      </div>
    </li>
  );
}

export default function AskAnswerView({ query }: { query: AskPublic }) {
  const [draft, setDraft] = useState<ExperienceDraft | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [savedExperience, setSavedExperience] = useState<{ id: string; title: string } | null>(
    null
  );
  const answer = query.answer;
  if (!answer) return <AskSourcesView query={query} />;

  async function startSaveExperience(pointIndex: number) {
    if (draftBusy) return;
    setDraftBusy(true);
    setDraftError(null);
    try {
      const res = await api.getAskExperienceDraft(query.id, pointIndex);
      setDraft(res.draft);
    } catch (e) {
      const message =
        e instanceof ApiError
          ? e.body?.message || experienceErrorText(e.body?.error, '这条观点暂时不能整理成经验。')
          : '这条观点暂时不能整理成经验。';
      setDraftError(message);
    } finally {
      setDraftBusy(false);
    }
  }

  const observations = answer.points
    .map((point, index) => ({ point, index }))
    .filter((item) => item.point.basis === 'observation');
  const inferences = answer.points
    .map((point, index) => ({ point, index }))
    .filter((item) => item.point.basis === 'inference');
  const usage = query.usage;
  const canSaveExperience = query.status === 'succeeded' && !draftBusy;
  const hiddenPositions =
    query.hiddenPointCount > 0 ? deletedSourcePositions(query.sources) : [];

  return (
    <section className="ask-answer" data-testid="ask-answer" aria-label="回答">
      {savedExperience && (
        <div className="save-ok experience-saved-banner" role="status">
          已保存为经验《{savedExperience.title}》。
          <Link className="inline-link" to={`/experience/${savedExperience.id}`}>
            打开并继续修订 →
          </Link>
        </div>
      )}
      {draftError && <p className="error-msg" role="alert">{draftError}</p>}
      <dl className="ask-answer-meta">
        <div>
          <dt>问题</dt>
          <dd>{query.question}</dd>
        </div>
        <div>
          <dt>目标模型</dt>
          <dd>{query.config ? `${query.config.name} · ${query.config.modelId}` : '未配置'}</dd>
        </div>
        <div>
          <dt>耗时</dt>
          <dd>{formatDuration(query.durationMs)}</dd>
        </div>
        <div>
          <dt>Token 用量</dt>
          <dd>
            {usage
              ? `输入 ${usage.inputTokens} · 输出 ${usage.outputTokens} · 合计 ${usage.totalTokens}`
              : '未返回'}
          </dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{formatTime(query.createdAt)}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{ASK_STATUS_LABEL[query.status]}</dd>
        </div>
        <div className="ask-answer-meta-range">
          <dt>日期范围</dt>
          <dd>{formatRange(query.range.from, query.range.to)}</dd>
        </div>
      </dl>

      {query.answerInvalidated && (
        <div className="ask-banner danger" role="alert">
          <strong>部分来源已删除</strong>
          <p>{query.answerInvalidReason || '依赖已删除来源的回答内容已隐藏。'}</p>
          {hiddenPositions.length > 0 && (
            <p>
              受影响的是发送时的第 {hiddenPositions.join('、')} 条来源，可对照下方「来源记录」逐条查看。
            </p>
          )}
          {query.hiddenPointCount > 0 && (
            <p>已隐藏 {query.hiddenPointCount} 条依赖已删除来源的内容。</p>
          )}
        </div>
      )}

      <p className="ask-answer-summary">{answer.summary}</p>
      <p className="ask-answer-caveat">
        模型可能把推断写成观察，请对照来源核对；「记录中的观察」与「模型推断」只是模型自报的分类。
      </p>

      {answer.insufficientEvidence && (
        <div className="ask-banner warn ask-insufficient" role="status" data-testid="ask-group-missing">
          <strong>证据不足</strong>
          {answer.missing.length > 0 ? (
            <ul>
              {answer.missing.map((item, index) => (
                <li key={`${item}-${index}`}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>这次记录里没有足够的信息回答这个问题。</p>
          )}
        </div>
      )}

      {observations.length > 0 && (
        <section className="ask-point-group" data-testid="ask-group-observations" aria-label="记录中的观察">
          <h4>记录中的观察</h4>
          <ul className="ask-point-list">
            {observations.map(({ point, index }) => (
              <PointItem
                key={`observation-${index}`}
                point={point}
                sources={query.sources}
                pointIndex={index}
                onSaveExperience={(pointIndex) => void startSaveExperience(pointIndex)}
                canSave={canSaveExperience}
              />
            ))}
          </ul>
        </section>
      )}

      {inferences.length > 0 && (
        <section className="ask-point-group" data-testid="ask-group-inferences" aria-label="模型推断">
          <h4>模型推断</h4>
          <ul className="ask-point-list">
            {inferences.map(({ point, index }) => (
              <PointItem
                key={`inference-${index}`}
                point={point}
                sources={query.sources}
                pointIndex={index}
                onSaveExperience={(pointIndex) => void startSaveExperience(pointIndex)}
                canSave={canSaveExperience}
              />
            ))}
          </ul>
        </section>
      )}

      {answer.contradictions.length > 0 && (
        <section
          className="ask-contradictions"
          data-testid="ask-group-contradictions"
          aria-label="两次记录并不一致"
        >
          <h4>两次记录并不一致</h4>
          <ul className="ask-contradiction-list">
            {answer.contradictions.map((item, index) => (
              <li className="ask-contradiction" key={`contradiction-${index}`}>
                <p className="ask-contradiction-text">{item.text}</p>
                <ul className="ask-contradiction-sides">
                  {item.sides.map((side) => (
                    <li key={side.sourceId}>
                      <span className="ask-side-condition">{side.condition}</span>
                      <SourceChip sourceId={side.sourceId} sources={query.sources} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!answer.insufficientEvidence && answer.missing.length > 0 && (
        <section className="ask-missing-notes" data-testid="ask-group-missing" aria-label="还缺什么">
          <h4>还缺什么</h4>
          <ul>
            {answer.missing.map((item, index) => (
              <li key={`${item}-${index}`}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      <AskSourcesView query={query} />

      {draft && (
        <ExperienceEditor
          mode="create"
          draft={draft}
          onCancel={() => setDraft(null)}
          onSaved={(experience) => {
            setDraft(null);
            setSavedExperience({ id: experience.id, title: experience.title });
          }}
        />
      )}
    </section>
  );
}
