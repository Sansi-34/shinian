// 拾念 SHINIAN · 阶段回顾详情：保存时的范围、统计、内容与来源
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api, { ApiError } from '../api';
import type { NextAction, ReviewPublic } from '../types';
import {
  aiErrorText,
  formatTime,
  newOperationId,
  OUTCOME_LABEL,
  REVIEW_PRESET_LABEL,
  REVIEW_RECORD_TYPE_LABEL,
  REVIEW_STATUS_LABEL,
  STATE_LABEL,
} from '../types';
import { ReviewContentBlocks, ReviewStatsPanel } from './ReviewPage';

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    return e.body?.message || aiErrorText(e.body?.error, fallback);
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

function sourceLink(source: ReviewPublic['sources'][number]): string | null {
  if (source.type === 'attempt') {
    const id = source.openAttemptId || source.attemptId || source.sourceId;
    return id ? `/attempt/${id}` : null;
  }
  if (source.type === 'capture') {
    const id = source.openCaptureId || source.captureId || source.sourceId;
    return id ? `/capture/${id}` : null;
  }
  const attemptId = source.openAttemptId || source.attemptId || source.relatedAttemptId;
  if (attemptId) return `/attempt/${attemptId}`;
  const captureId = source.openCaptureId || source.captureId;
  return captureId ? `/capture/${captureId}` : null;
}

export default function ReviewDetailPage() {
  const { reviewId = '' } = useParams<{ reviewId: string }>();
  const [review, setReview] = useState<ReviewPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [nextActions, setNextActions] = useState<NextAction[] | null>(null);
  const [nextActionsError, setNextActionsError] = useState<string | null>(null);

  useEffect(() => {
    if (reviewId) void load();
  }, [reviewId]);

  function loadNextActions(id: string) {
    setNextActions(null);
    setNextActionsError(null);
    api
      .listReviewNextActions(id)
      .then((actions) => setNextActions(actions.actions ?? []))
      .catch((e) => {
        // 读取失败要和「确实没有创建过」区分开，否则会误报成 0 条。
        setNextActionsError(errorMessage(e, '无法读取已创建的下一步行动'));
        setNextActions([]);
      });
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getReview(reviewId);
      setReview(res.review);
      // 回顾正文先渲染；下一步列表单独加载，避免它拖慢详情首屏。
      setLoading(false);
      if (res.review.savedAt != null) {
        loadNextActions(res.review.id);
      } else {
        setNextActions(null);
        setNextActionsError(null);
      }
    } catch (e) {
      setError(errorMessage(e, '无法读取这条回顾'));
      setLoading(false);
    }
  }

  function handleNextActionCreated(action: NextAction) {
    setNextActions((prev) => [action, ...(prev ?? []).filter((item) => item.id !== action.id)]);
  }

  async function saveReview() {
    if (!review || saving || review.savedAt != null) return;
    setSaving(true);
    setSaveError(null);
    setSaveNotice(null);
    try {
      const res = await api.saveReview(review.id, { operationId: newOperationId() });
      setReview(res.review);
      setSaveNotice(res.replayed ? '这条回顾此前已保存，没有重复写入。' : '已保存。');
    } catch (e) {
      setSaveError(errorMessage(e, '保存失败，请重试'));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="page review-detail">
        <p className="muted loading-line" role="status">
          <span className="spinner" aria-hidden="true" /> 正在读取回顾…
        </p>
      </div>
    );
  }

  if (!review) {
    return (
      <div className="page review-detail">
        <div className="crumb">
          <Link to="/review">← 返回阶段回顾</Link>
        </div>
        <h1 className="page-title">回顾详情</h1>
        <div className="empty-state" role="alert">
          {error || '回顾不存在或已被删除。'}
        </div>
        <div className="row-actions">
          <button type="button" className="btn" onClick={load}>
            重试
          </button>
        </div>
      </div>
    );
  }

  const deletedCount = review.sources.filter((source) => source.deleted || source.exists === false).length;
  const changedCount = review.sources.filter(
    (source) => source.changed && !source.deleted && source.exists !== false
  ).length;

  return (
    <div className="page review-detail">
      <div className="crumb">
        <Link to="/review">← 返回阶段回顾</Link>
      </div>

      <header className="review-detail-head">
        <div>
          <p className="page-kicker">已保存的回顾</p>
          <h1 className="page-title">阶段回顾</h1>
          <p className="page-subtitle">
            {review.savedAt != null
              ? `保存于 ${formatTime(review.savedAt)} · 生成于 ${formatTime(review.createdAt)}`
              : `尚未保存 · 生成于 ${formatTime(review.createdAt)}`}
          </p>
        </div>
        <span className="badge">{REVIEW_STATUS_LABEL[review.status]}</span>
      </header>

      {review.contentInvalidated && (
        <div className="review-banner danger" role="alert">
          <strong>内容已失效</strong>
          <p>
            {review.contentInvalidReason || '来源记录已删除'}
            。无法可靠拆分受影响的生成段落，模型回顾正文已整段撤下；来源正文已按删除策略清除，独立记录仍保留。
          </p>
        </div>
      )}

      {review.sourcesChanged && !review.contentInvalidated && (
        <div className="review-banner warn" role="status">
          <strong>来源有变化</strong>
          <p>
            部分来源在保存后被修改{deletedCount > 0 ? '或删除' : ''}，下方来源列表标出了当前状态。
          </p>
        </div>
      )}

      <section className="section review-detail-range" aria-label="保存时的范围">
        <h3>范围</h3>
        <p className="review-detail-range-text">
          {review.range.fromLocal}（含）→ {review.range.toLocal}（不含）
        </p>
        <p className="hint">
          共 {review.range.days} 天 · {REVIEW_PRESET_LABEL[review.range.preset]} · 时区{' '}
          {review.range.timezone} · 结束日包含全天，结束边界不含
        </p>
        {review.config && (
          <p className="hint">
            生成模型：{review.config.name} · {review.config.modelId}
          </p>
        )}
      </section>

      <section className="section review-detail-stats" aria-label="保存时的统计">
        <div className="section-head">
          <h3>统计</h3>
          <span className="hint">生成时快照</span>
        </div>
        <ReviewStatsPanel stats={review.stats} />
      </section>

      {review.status === 'succeeded' && review.content ? (
        <section className="section review-detail-content" aria-label="回顾内容">
          <div className="section-head">
            <h3>回顾内容</h3>
            <span className="hint">
              覆盖 {review.coverage?.selectedRecords ?? review.sources.length} 条
              {(review.coverage?.excludedRecords ?? 0) > 0
                ? `（另有 ${review.coverage?.excludedRecords} 条未选）`
                : ''}
            </span>
          </div>
          <ReviewContentBlocks
            content={review.content}
            sources={review.sources}
            reviewId={review.id}
            saved={review.savedAt != null}
            onNextActionCreated={handleNextActionCreated}
          />
        </section>
      ) : (
        <section className="section" aria-label="回顾内容">
          <h3>回顾内容</h3>
          <div className="empty-state">
            {review.status === 'succeeded'
              ? '这条回顾没有可显示的内容。'
              : `${REVIEW_STATUS_LABEL[review.status]}：${
                  aiErrorText(review.errorCode, '没有生成内容')
                }`}
          </div>
          {review.errorMessage && <p className="gen-error-detail">{review.errorMessage}</p>}
        </section>
      )}

      {review.savedAt != null && (
        <section className="section review-next-actions" aria-label="已创建的下一步行动">
          <div className="section-head">
            <h3>下一步行动</h3>
            <span className="hint">
              {nextActionsError
                ? '读取失败'
                : nextActions === null
                  ? '正在读取…'
                  : `${nextActions.length} 条`}
            </span>
          </div>
          {nextActions === null ? (
            <p className="muted loading-line" role="status">
              <span className="spinner" aria-hidden="true" /> 正在读取已创建的下一步…
            </p>
          ) : nextActionsError ? (
            <div role="alert">
              <p className="error-msg">{nextActionsError}</p>
              <button
                type="button"
                className="btn small"
                onClick={() => loadNextActions(review.id)}
              >
                重试
              </button>
            </div>
          ) : nextActions.length === 0 ? (
            <>
              <p className="hint">
                还没有从这条回顾创建下一步。可以从上方的「下次可参考」经验开始；创建后会列在这里。
              </p>
              {review.content && (
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn small"
                    onClick={() =>
                      document
                        .querySelector('.review-detail-content')
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }
                  >
                    去看「下次可参考」
                  </button>
                </div>
              )}
            </>
          ) : (
            <ul className="next-action-list">
              {nextActions.map((item) => (
                <li className="next-action-list-item" key={item.id}>
                  <Link className="next-action-list-link" to={`/next-action/${item.id}`}>
                    <span className="next-action-list-title">{item.title}</span>
                    <span className="next-action-list-meta">
                      <span className={`badge state-${item.state}`}>{STATE_LABEL[item.state]}</span>
                      {item.estimatedMinutes != null && (
                        <span className="badge">预计 {item.estimatedMinutes} 分钟</span>
                      )}
                      <span className="muted">创建于 {formatTime(item.createdAt)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="section review-detail-sources" aria-label="来源记录">
        <div className="section-head">
          <h3>来源记录</h3>
          <span className="hint">
            {review.sources.length} 条
            {changedCount > 0 ? ` · ${changedCount} 条有更新` : ''}
            {deletedCount > 0 ? ` · ${deletedCount} 条已删除` : ''}
          </span>
        </div>
        {review.sources.length === 0 ? (
          <p className="empty-state">这条回顾没有可列出的来源。</p>
        ) : (
          <ul className="review-source-list">
            {review.sources.map((source) => {
              const deleted = source.deleted || source.exists === false;
              const to = deleted ? null : sourceLink(source);
              return (
                <li
                  className={`review-source-item${deleted ? ' deleted' : ''}${
                    source.changed ? ' changed' : ''
                  }`}
                  key={source.key}
                >
                  <div className="review-source-item-head">
                    <span className={`badge review-type-${source.type}`}>
                      {REVIEW_RECORD_TYPE_LABEL[source.type]}
                    </span>
                    {to ? (
                      <Link className="review-source-title" to={to}>
                        {source.title || source.sourceId}
                      </Link>
                    ) : (
                      <span className="review-source-title muted">
                        {source.title || (deleted ? '已删除的来源' : source.sourceId)}
                      </span>
                    )}
                    {source.changed && !deleted && <span className="badge warn">来源有更新</span>}
                    {deleted && (
                      <span className="badge warn">来源已删除（正文已按删除策略清除）</span>
                    )}
                  </div>
                  {!deleted && (
                    <>
                      {source.text && <p className="review-source-text">{source.text}</p>}
                      {source.resultText && (
                        <p className="review-source-result">
                          <span className="review-result-label">结果：</span>
                          {source.resultText}
                        </p>
                      )}
                      {source.type === 'reference' && source.relatedAttemptId && (
                        <p className="hint">被引用尝试：{source.relatedAttemptId}</p>
                      )}
                    </>
                  )}
                  {deleted && (
                    <p className="hint">
                      来源已删除，接口不会返回已删除来源的正文。
                    </p>
                  )}
                  {!deleted && (
                    <div className="review-source-meta">
                      <span>创建于 {formatTime(source.createdAt)}</span>
                      {source.observedAt != null && (
                        <span>结果记录于 {formatTime(source.observedAt)}</span>
                      )}
                      {source.type === 'attempt' && source.state && (
                        <span className={`badge state-${source.state}`}>{STATE_LABEL[source.state]}</span>
                      )}
                      {source.outcome && (
                        <span className={`badge outcome-${source.outcome}`}>
                          {OUTCOME_LABEL[source.outcome]}
                        </span>
                      )}
                      <span>版本 {source.revision}</span>
                      {source.changed && source.currentRevision != null && (
                        <span>当前版本 {source.currentRevision}</span>
                      )}
                    </div>
                  )}
                  {!deleted && (
                    <div className="review-source-links">
                      {source.openCaptureId && (
                        <Link to={`/capture/${source.openCaptureId}`}>打开念头 →</Link>
                      )}
                      {(source.openAttemptId || source.attemptId) && (
                        <Link to={`/attempt/${source.openAttemptId || source.attemptId}`}>
                          打开尝试 →
                        </Link>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="row-actions review-detail-actions">
        {review.canSave && review.savedAt == null && (
          <button
            type="button"
            className="btn primary review-save"
            onClick={saveReview}
            disabled={saving}
          >
            {saving ? '保存中…' : '保存回顾'}
          </button>
        )}
        {review.savedAt != null && (
          <span className="badge">已保存</span>
        )}
        <Link className="btn" to="/review">
          返回阶段回顾
        </Link>
      </div>
      {saveNotice && <p className="save-ok" role="status">{saveNotice}</p>}
      {saveError && <p className="error-msg" role="alert">{saveError}</p>}
    </div>
  );
}
