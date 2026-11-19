// 拾念 SHINIAN · 下一步行动详情：来源、编辑、日程与进入尝试
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api, { ApiError } from '../api';
import type { NextAction, NextActionSource, ScheduleBlock } from '../types';
import {
  formatTime,
  nextActionErrorText,
  newOperationId,
  OUTCOME_LABEL,
  STATE_LABEL,
} from '../types';
import {
  formatScheduleFullRange,
  isCrossDaySchedule,
  isSchedulePast,
  sortSchedules,
  useDisplayTimezone,
  useNow,
} from '../scheduleTime';
import ScheduleEditor from '../components/ScheduleEditor';
import ScheduleDetailModal from '../components/ScheduleDetailModal';

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return nextActionErrorText(error.body?.error, error.body?.message || fallback);
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function normalizedAction(action: NextAction): NextAction {
  return {
    ...action,
    sources: action.sources ?? [],
    schedules: action.schedules ?? [],
    sourceReview: action.sourceReview ?? null,
    experience: action.experience ?? null,
  };
}

function attemptSourceOf(action: NextAction): NextActionSource | null {
  if (!action.sourceAttemptId) return null;
  return (
    (action.sources ?? []).find(
      (source) =>
        source.type === 'attempt' &&
        (source.attemptId === action.sourceAttemptId || source.sourceId === action.sourceAttemptId)
    ) ?? null
  );
}

export default function NextActionPage() {
  const { nextActionId = '' } = useParams<{ nextActionId: string }>();
  const [action, setAction] = useState<NextAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [schedules, setSchedules] = useState<ScheduleBlock[]>([]);
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false);
  const [scheduleDetail, setScheduleDetail] = useState<ScheduleBlock | null>(null);
  const [scheduleNotice, setScheduleNotice] = useState<string | null>(null);
  const [timezone] = useDisplayTimezone();
  const now = useNow();

  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftMinutes, setDraftMinutes] = useState('');
  const [editBaseRevision, setEditBaseRevision] = useState(0);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editFieldError, setEditFieldError] = useState<string | null>(null);
  const [revisionConflict, setRevisionConflict] = useState<NextAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const editOperationIdRef = useRef(newOperationId());

  useEffect(() => {
    if (nextActionId) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextActionId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getNextAction(nextActionId);
      const loaded = normalizedAction(res.action);
      setAction(loaded);
      setSchedules(sortSchedules(loaded.schedules));
    } catch (e) {
      setError(apiErrorMessage(e, '无法读取这条下一步行动'));
    } finally {
      setLoading(false);
    }
  }

  function startEdit() {
    if (!action) return;
    setDraftTitle(action.title);
    setDraftDescription(action.description ?? '');
    setDraftMinutes(
      typeof action.estimatedMinutes === 'number' ? String(action.estimatedMinutes) : ''
    );
    setEditBaseRevision(action.revision);
    setEditing(true);
    setEditError(null);
    setEditFieldError(null);
    setRevisionConflict(null);
    setNotice(null);
    editOperationIdRef.current = newOperationId();
  }

  async function saveEdit(revisionOverride?: number) {
    if (!action || savingEdit) return;
    const title = draftTitle.trim();
    if (!title) {
      setEditFieldError('请填写行动标题。');
      return;
    }
    if (title.length > 120) {
      setEditFieldError('标题最多 120 字。');
      return;
    }
    if (draftDescription.length > 2000) {
      setEditFieldError('行动说明最多 2000 字。');
      return;
    }
    const minutesText = draftMinutes.trim();
    const minutes = minutesText ? Number(minutesText) : null;
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
      setEditFieldError('预计耗时需为 1–1440 的整数分钟。');
      return;
    }

    setSavingEdit(true);
    setEditError(null);
    setEditFieldError(null);
    try {
      const res = await api.updateNextAction(action.id, {
        title,
        description: draftDescription.trim() ? draftDescription.trim() : null,
        estimatedMinutes: minutes,
        revision: revisionOverride ?? editBaseRevision,
        operationId: editOperationIdRef.current,
      });
      const returned = res.action ?? res.nextAction;
      if (!returned) throw new Error('服务端没有返回更新后的行动。');
      const updated = normalizedAction(returned);
      setAction(updated);
      setSchedules(sortSchedules(updated.schedules));
      setEditing(false);
      setRevisionConflict(null);
      setNotice('行动已更新。');
      editOperationIdRef.current = newOperationId();
    } catch (e) {
      if (e instanceof ApiError) {
        const body: any = e.body ?? {};
        if (body.error === 'revision_conflict') {
          setRevisionConflict((body.current as NextAction | undefined) ?? null);
          setEditError('版本冲突：这条行动刚被其他窗口修改，你的草稿仍然保留。');
        } else if (body.error === 'operation_key_conflict') {
          editOperationIdRef.current = newOperationId();
          setEditError('这次提交与上一次不一致，请再点一次保存。');
        } else {
          setEditError(apiErrorMessage(e, '保存修改失败，请重试。'));
        }
      } else {
        setEditError('网络异常，草稿已保留，请重试。');
      }
    } finally {
      setSavingEdit(false);
    }
  }

  function adoptLatestRevision() {
    if (!revisionConflict) return;
    const latest = revisionConflict;
    setAction(latest);
    setDraftTitle(latest.title);
    setDraftDescription(latest.description ?? '');
    setDraftMinutes(
      typeof latest.estimatedMinutes === 'number' ? String(latest.estimatedMinutes) : ''
    );
    setEditBaseRevision(latest.revision);
    setRevisionConflict(null);
    setEditError('已载入最新内容，请确认后再次保存。');
  }

  if (loading) {
    return (
      <div className="page next-action-page">
        <p className="muted loading-line" role="status">
          <span className="spinner" aria-hidden="true" /> 正在读取下一步行动…
        </p>
      </div>
    );
  }

  if (!action) {
    return (
      <div className="page next-action-page">
        <div className="crumb">
          <Link to="/review">← 返回阶段回顾</Link>
        </div>
        <h1 className="page-title">下一步行动</h1>
        <div className="empty-state" role="alert">
          {error || '这条下一步行动不存在或已被删除。'}
        </div>
        <div className="row-actions">
          <button type="button" className="btn" onClick={() => void load()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  const source = attemptSourceOf(action);
  const sourceDeleted = !action.sourceAttemptId || Boolean(source?.deleted);
  const sourceChanged = Boolean(
    action.sourceReview?.sourcesChanged ||
      action.sources.some((item) => item.changed && !item.deleted) ||
      source?.changed
  );
  const reviewMissing = action.sourceReview === null;
  const experience = action.experience;
  const activeScheduleCount = schedules.filter((item) => item.status === 'active').length;

  return (
    <div className="page next-action-page">
      <div className="crumb">
        {action.sourceReview ? (
          <Link to={`/review/${action.sourceReview.id}`}>← 返回来源回顾</Link>
        ) : action.capture ? (
          <Link to={`/capture/${action.capture.id}`}>← 返回所属念头</Link>
        ) : (
          <Link to="/review">← 返回阶段回顾</Link>
        )}
      </div>

      <header className="detail-head next-action-head">
        <div className="next-action-head-main">
          <p className="page-kicker">下一步行动</p>
          <h1 className="detail-title next-action-title">{action.title}</h1>
          <p className="card-meta">
            创建于 {formatTime(action.createdAt)} · 更新于 {formatTime(action.updatedAt)} · 版本{' '}
            {action.revision}
          </p>
          <div className="next-action-badges">
            <span className={`badge state-${action.state}`}>{STATE_LABEL[action.state]}</span>
            <span className="badge">来自回顾</span>
            {action.estimatedMinutes != null && (
              <span className="badge">预计 {action.estimatedMinutes} 分钟</span>
            )}
            {action.outcome && (
              <span className={`badge outcome-${action.outcome}`}>{OUTCOME_LABEL[action.outcome]}</span>
            )}
          </div>
        </div>
        <div className="detail-head-actions next-action-head-actions">
          <Link
            className="btn primary small"
            to={`/attempt/${action.id}`}
            data-testid="next-action-attempt"
          >
            打开尝试
          </Link>
          <Link className="btn small" to={`/attempt/${action.id}#result-section`}>
            去记录结果
          </Link>
          {action.canEdit && (
            <button type="button" className="btn small" onClick={startEdit}>
              编辑行动
            </button>
          )}
        </div>
      </header>

      {reviewMissing && (
        <div
          className="review-banner warn"
          role="status"
          data-testid={sourceDeleted ? undefined : 'next-action-source-deleted'}
        >
          <strong>来源已删除</strong>
          <p>来源回顾已删除或当前不可读取；这里不会显示已删除的正文。</p>
        </div>
      )}

      {action.sourceReview?.contentInvalidated && (
        <div className="review-banner danger" role="alert">
          <strong>来源回顾内容已失效</strong>
          <p>来源记录在回顾保存后被删除或清洗；模型建议仍保留，但不代表当前事实。</p>
        </div>
      )}

      {sourceChanged && (
        <div className="review-banner warn" role="status" data-testid="next-action-source-changed">
          <strong>来源记录有变化</strong>
          <p>来源回顾或来源尝试在保存后有更新，打开来源可查看当前版本。</p>
        </div>
      )}

      {action.deleted && !sourceDeleted && (
        <div className="review-banner warn" role="status" data-testid="next-action-source-deleted">
          <strong>部分来源已删除</strong>
          <p>这条行动引用的部分来源记录已删除；已删除来源的正文不会显示。</p>
        </div>
      )}

      <section className="section next-action-detail-section" aria-label="行动内容">
        <div className="section-head">
          <h3>行动</h3>
          <span className="hint">你确认后的行动，不是 AI 自动执行的事实</span>
        </div>

        {editing ? (
          <form
            className="next-action-edit-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void saveEdit();
            }}
          >
            <label className="field">
              <span>行动标题</span>
              <input
                data-testid="next-action-title"
                type="text"
                value={draftTitle}
                maxLength={120}
                onChange={(event) => setDraftTitle(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>行动说明（选填）</span>
              <textarea
                data-testid="next-action-description"
                rows={4}
                value={draftDescription}
                maxLength={2000}
                onChange={(event) => setDraftDescription(event.target.value)}
              />
              <span className="char-count">{draftDescription.length}/2000</span>
            </label>
            <label className="field">
              <span>预计耗时（分钟，选填）</span>
              <input
                data-testid="next-action-minutes"
                type="number"
                inputMode="numeric"
                min={1}
                max={1440}
                value={draftMinutes}
                onChange={(event) => setDraftMinutes(event.target.value)}
              />
            </label>
            {editFieldError && <p className="field-error">{editFieldError}</p>}
            {editError && (
              <p className="error-msg" role="alert">
                {editError}
              </p>
            )}
            {revisionConflict && (
              <div className="conflict-banner" role="alert">
                <p>版本冲突：其他窗口已更新这条行动，你的草稿仍然保留。</p>
                <p className="muted">
                  最新标题：{revisionConflict.title} · 版本 {revisionConflict.revision}
                </p>
                <div className="row-actions">
                  <button type="button" className="btn small" onClick={adoptLatestRevision}>
                    查看最新内容并采用
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={savingEdit}
                    onClick={() => void saveEdit(revisionConflict.revision)}
                  >
                    按最新版本重试
                  </button>
                </div>
              </div>
            )}
            <div className="row-actions next-action-form-actions">
              <button
                type="submit"
                className="btn primary"
                data-testid="next-action-save"
                disabled={savingEdit}
              >
                {savingEdit ? '保存中…' : '保存修改'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={savingEdit}
                onClick={() => {
                  setEditing(false);
                  setEditError(null);
                  setEditFieldError(null);
                  setRevisionConflict(null);
                }}
              >
                取消编辑
              </button>
            </div>
          </form>
        ) : (
          <dl className="next-action-detail-grid">
            <div>
              <dt>说明</dt>
              <dd className="next-action-description">
                {action.description || <span className="muted">没有填写行动说明。</span>}
              </dd>
            </div>
            <div>
              <dt>预计耗时</dt>
              <dd>
                {action.estimatedMinutes != null ? `${action.estimatedMinutes} 分钟` : '未填写'}
              </dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>
                <span className={`badge state-${action.state}`}>{STATE_LABEL[action.state]}</span>
                <span className="hint next-action-inline-hint">来自实际尝试记录</span>
              </dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd>
                当前版本 {action.revision}
                {action.canEdit ? ' · 可编辑' : ' · 当前不可编辑'}
              </dd>
            </div>
          </dl>
        )}
        {notice && (
          <p className="save-ok" role="status">
            {notice}
          </p>
        )}
        {!editing && editError && (
          <p className="error-msg" role="alert">
            {editError}
          </p>
        )}
      </section>

      <section className="section next-action-source-section" aria-label="来源与依据">
        <div className="section-head">
          <h3>来源</h3>
          <span className="hint">AI 建议、你的行动与真实结果分开显示</span>
        </div>

        <dl className="next-action-detail-grid">
          <div>
            <dt>来源回顾</dt>
            <dd>
              {action.sourceReview ? (
                <Link to={`/review/${action.sourceReview.id}`}>打开保存的阶段回顾 →</Link>
              ) : (
                <span className="muted">来源回顾已删除或不可用。</span>
              )}
            </dd>
          </div>
          <div>
            <dt>当前念头</dt>
            <dd>
              {action.capture ? (
                <Link to={`/capture/${action.capture.id}`}>
                  {action.capture.rawText.length > 80
                    ? `${action.capture.rawText.slice(0, 80)}…`
                    : action.capture.rawText}
                </Link>
              ) : (
                <span className="muted">念头已删除。</span>
              )}
            </dd>
          </div>
          <div>
            <dt>来源尝试</dt>
            <dd>
              {sourceDeleted ? (
                <span className="next-action-deleted-source" data-testid="next-action-source-deleted">
                  来源已删除，不显示已删除正文。
                </span>
              ) : source ? (
                <span className="next-action-source-line">
                  <Link to={`/attempt/${source.attemptId ?? action.sourceAttemptId}`}>
                    {source.title || '来源尝试'}
                  </Link>
                  {source.state && (
                    <span className={`badge state-${source.state}`}>{STATE_LABEL[source.state]}</span>
                  )}
                  <span className="muted">保存时版本 {source.revision ?? action.sourceAttemptRevision ?? '—'}</span>
                  {source.changed && source.currentRevision != null && (
                    <span className="muted">当前版本 {source.currentRevision}</span>
                  )}
                  {source.changed && <span className="badge warn">已修改</span>}
                </span>
              ) : (
                <span className="muted">来源状态不可用，未显示正文。</span>
              )}
            </dd>
          </div>
        </dl>

        {experience ? (
          <div className="next-action-experience">
            <div className="next-action-experience-head">
              <span className="next-action-experience-label">来源经验</span>
              <span className="badge ai-kind">模型推断/建议</span>
            </div>
            <p className="next-action-experience-text">{experience.text}</p>
            <p className="hint">
              这是模型给出的建议，不是事实。你保存后的标题与说明才是确认的下一步；实际结果只来自尝试记录。
            </p>
          </div>
        ) : (
          <p className="hint">来源经验不可用或已删除。</p>
        )}
      </section>

      {action.resultText || action.outcome || action.observedAt != null ? (
        <section className="section next-action-result-section" aria-label="实际记录的结果">
          <div className="section-head">
            <h3>实际记录的结果</h3>
            <span className="hint">来自现有尝试记录</span>
          </div>
          <p className="next-action-description">{action.resultText || '没有结果文字。'}</p>
          <p className="card-meta">
            {action.outcome ? `评价：${OUTCOME_LABEL[action.outcome]}` : '评价：未填写'}
            {action.observedAt != null ? ` · 记录于 ${formatTime(action.observedAt)}` : ''}
          </p>
        </section>
      ) : null}

      <section className="section next-action-schedule-section" aria-label="日程安排">
        <div className="section-head">
          <h3>
            日程安排 <span className="muted">({activeScheduleCount} 个有效)</span>
          </h3>
          <button
            type="button"
            className="btn small"
            data-testid="schedule-add"
            onClick={() => {
              setScheduleEditorOpen(true);
              setScheduleNotice(null);
            }}
          >
            安排时间
          </button>
        </div>
        <p className="hint">安排只是「打算什么时候做」，不会改变行动状态，也不会自动完成行动。</p>
        {scheduleNotice && (
          <p className="save-ok" role="status">
            {scheduleNotice}
          </p>
        )}

        {scheduleEditorOpen && (
          <div className="schedule-editor-wrap">
            <h4>安排一个时间</h4>
            <ScheduleEditor
              mode="create"
              attemptId={action.id}
              displayTimezone={timezone}
              onCancel={() => setScheduleEditorOpen(false)}
              onSaved={(saved) => {
                setScheduleEditorOpen(false);
                setScheduleNotice('安排已保存。');
                setSchedules((prev) =>
                  sortSchedules([...prev.filter((item) => item.id !== saved.id), saved])
                );
              }}
            />
          </div>
        )}

        {schedules.length === 0 ? (
          <p className="empty-state">这条下一步行动还没有安排时间。</p>
        ) : (
          <ul className="schedule-list next-action-schedule-list">
            {schedules.map((schedule) => {
              const past = schedule.status === 'active' && isSchedulePast(schedule, now);
              const crossDay = isCrossDaySchedule(schedule, timezone);
              return (
                <li
                  key={schedule.id}
                  className={`schedule-item${schedule.status === 'cancelled' ? ' is-cancelled' : ''}`}
                >
                  <button
                    type="button"
                    className="schedule-item-main"
                    data-testid="schedule-detail"
                    onClick={() => setScheduleDetail(schedule)}
                    aria-label={`查看安排详情：${formatScheduleFullRange(schedule, timezone)}`}
                  >
                    <span className="schedule-item-time">
                      {formatScheduleFullRange(schedule, timezone)}
                    </span>
                    <span className="schedule-item-title">
                      {schedule.note || schedule.attempt?.step || action.title}
                    </span>
                    <span className="schedule-item-meta">
                      {crossDay && <span className="badge">跨日</span>}
                      {schedule.status === 'cancelled' ? (
                        <span className="badge">已取消</span>
                      ) : past ? (
                        <span className="badge warn">已过安排时间</span>
                      ) : (
                        <span className="badge state-in_progress">有效</span>
                      )}
                      <span className="schedule-open-hint">查看详情</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {scheduleDetail && (
        <ScheduleDetailModal
          schedule={scheduleDetail}
          displayTimezone={timezone}
          onClose={() => setScheduleDetail(null)}
          onChanged={(updated) => {
            setSchedules((prev) => {
              if (updated.status === 'cancelled') {
                return prev.map((item) => (item.id === updated.id ? updated : item));
              }
              return sortSchedules(prev.map((item) => (item.id === updated.id ? updated : item)));
            });
            setScheduleDetail(updated);
          }}
        />
      )}
    </div>
  );
}
