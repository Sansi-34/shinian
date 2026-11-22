// 拾念 SHINIAN · 经验详情
// 先显示「我的理解」，再显示条件、依据与后续实践；来源状态和未确认事项始终可见。
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api, { ApiError } from '../api';
import type {
  Attempt,
  Capture,
  ExperienceDeletePreview,
  ExperienceAttempt,
  ExperiencePublic,
} from '../types';
import {
  OUTCOME_LABEL,
  STATE_LABEL,
  experienceErrorText,
  formatTime,
  newOperationId,
} from '../types';
import ExperienceEditor from '../components/ExperienceEditor';
import CaptureLinksPanel from '../components/CaptureLinksPanel';
import TopicMembership from '../components/TopicMembership';
import { readTopicNav, topicAwareHref } from '../components/topicNav';

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.body?.message || experienceErrorText(error.body?.error, fallback);
  }
  if (error instanceof TypeError) return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export default function ExperienceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const topicNav = readTopicNav(searchParams);
  const [experience, setExperience] = useState<ExperiencePublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [reviseAttempt, setReviseAttempt] = useState<ExperienceAttempt | null>(null);
  const [attemptOpen, setAttemptOpen] = useState(false);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [targetCaptureId, setTargetCaptureId] = useState('');
  const [attemptTitle, setAttemptTitle] = useState('');
  const [attemptDescription, setAttemptDescription] = useState('');
  const [basisKeys, setBasisKeys] = useState<Set<string>>(new Set());
  const [attemptBusy, setAttemptBusy] = useState(false);
  const [attemptError, setAttemptError] = useState<string | null>(null);
  const [createdAttempt, setCreatedAttempt] = useState<Attempt | null>(null);
  const [deletePreview, setDeletePreview] = useState<ExperienceDeletePreview | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const attemptOperationRef = useRef(newOperationId());

  async function load() {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getExperience(id);
      setExperience(res.experience);
    } catch (e) {
      setError(errorText(e, '这份经验已不存在或不可访问。'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function openAttempt() {
    if (!experience) return;
    setAttemptOpen(true);
    setAttemptError(null);
    setCreatedAttempt(null);
    setAttemptTitle(`按经验「${experience.title}」试一步`);
    setAttemptDescription('');
    setBasisKeys(
      new Set(
        experience.sources
          .filter((source) => source.type === 'attempt' && source.exists && source.canReference)
          .map((source) => source.sourceKey)
      )
    );
    try {
      const res = await api.listCaptures();
      setCaptures(res.captures.filter((capture) => capture.kind !== 'experience'));
      const preferred = experience.derivation.contextCaptureId;
      const exists = res.captures.find((capture) => capture.id === preferred);
      setTargetCaptureId(exists?.id ?? res.captures[0]?.id ?? '');
    } catch (e) {
      setAttemptError(errorText(e, '读取念头列表失败。'));
    }
  }

  async function submitAttempt() {
    if (!experience || attemptBusy) return;
    if (!targetCaptureId) {
      setAttemptError('先选择一个所属念头。');
      return;
    }
    if (!attemptTitle.trim()) {
      setAttemptError('给这一步写一个标题。');
      return;
    }
    setAttemptBusy(true);
    setAttemptError(null);
    try {
      const res = await api.createAttemptFromExperience(experience.id, {
        captureId: targetCaptureId,
        title: attemptTitle.trim(),
        description: attemptDescription.trim(),
        basisSourceKeys: Array.from(basisKeys),
        experienceRevision: experience.revision,
        operationId: attemptOperationRef.current,
      });
      attemptOperationRef.current = newOperationId();
      setCreatedAttempt(res.attempt);
      setNotice('已创建这次尝试。记录实际结果后，回到这里就能看到它并修订经验。');
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.body?.error === 'experience_version_conflict') {
        setAttemptError('这份经验刚刚被修改，页面已刷新，请重新确认后再试一步。');
        void load();
      } else if (e instanceof ApiError && e.status === 409 && e.body?.error === 'capture_unavailable') {
        setAttemptError('所属念头已不可用，请重新选择。');
      } else {
        setAttemptError(errorText(e, '创建尝试失败，请稍后重试。'));
      }
    } finally {
      setAttemptBusy(false);
    }
  }

  async function toggleArchive() {
    if (!experience || archiving) return;
    setArchiving(true);
    setError(null);
    try {
      if (experience.archived) {
        await api.restoreCapture(experience.id);
        setNotice('已恢复这份经验。');
      } else {
        await api.archiveCapture(experience.id);
        setNotice('已归档。归档不会删除经验，也不会删除来源。');
      }
      await load();
    } catch (e) {
      setError(errorText(e, '归档操作失败。'));
    } finally {
      setArchiving(false);
    }
  }

  async function openDeletePreview() {
    if (!experience) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      setDeletePreview(await api.getExperienceDeletePreview(experience.id));
    } catch (e) {
      setDeleteError(errorText(e, '读取删除影响失败。'));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function confirmDelete() {
    if (!experience || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteCapture(experience.id);
      navigate('/experiences');
    } catch (e) {
      setDeleteError(errorText(e, '删除失败，请稍后重试。'));
    } finally {
      setDeleteBusy(false);
    }
  }

  function openRevise(attempt: ExperienceAttempt | null) {
    setReviseAttempt(attempt);
    setEditorOpen(true);
  }

  if (loading) {
    return (
      <div className="page">
        <p className="muted">读取经验…</p>
      </div>
    );
  }

  if (!experience) {
    return (
      <div className="page">
        <div className="crumb">
          <Link to="/experiences">← 我的经验</Link>
        </div>
        <p className="error-msg">{error || '这份经验已不存在。'}</p>
      </div>
    );
  }

  const availableBasis = experience.sources.filter(
    (source) => source.type === 'attempt' && source.exists && source.canReference
  );

  return (
    <div className="page experience-page">
      <div className="crumb">
        <Link to="/experiences">← 我的经验</Link>
        {topicNav.fromTopic && topicNav.returnTo && (
          <>
            {' · '}
            <Link to={topicNav.returnTo} className="topic-back-link" data-testid="experience-back-topic">
              ← 返回主题
            </Link>
          </>
        )}
      </div>

      {experience.needsRevision && (
        <div className="conflict-banner" role="status">
          <strong>建议重新核对</strong>
          <p>{experience.revisionReason || '来源记录有变化，正文仍是你保存的内容。'}</p>
          <button type="button" className="btn small" onClick={() => openRevise(null)}>
            现在修订
          </button>
        </div>
      )}

      <header className="detail-head">
        <div className="detail-head-row">
          <div>
            <h2 className="detail-title">{experience.title}</h2>
            <div className="experience-badges">
              <span className="badge experience-kind">经验笔记</span>
              {experience.derivation.by === 'model' ? (
                <span className="badge ai-kind">
                  {experience.derivation.modelBasis === 'inference' ? '由模型推断整理' : '由模型整理'}
                </span>
              ) : (
                <span className="badge">由你自己整理</span>
              )}
              {!experience.hasPracticeResult && (
                <span className="badge warn">尚无实践结果支持</span>
              )}
              {experience.archived && <span className="badge">已归档</span>}
            </div>
          </div>
          <div className="detail-head-actions">
            <button
              type="button"
              className="btn primary small"
              onClick={() => openAttempt()}
              data-testid="experience-try"
            >
              参考它，试一步
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => openRevise(null)}
              data-testid="experience-edit"
            >
              编辑经验
            </button>
            <Link
              className="btn small"
              to={topicAwareHref(
                `/graph?node=experience:${experience.id}&depth=1&returnTo=${encodeURIComponent(
                  `/experience/${experience.id}`
                )}`,
                topicNav
              )}
            >
              局部图
            </Link>
          </div>
        </div>
        <p className="card-meta">
          第 {experience.revision} 版 · 更新于 {formatTime(experience.updatedAt)} ·
          {experience.derivation.confirmNote}
        </p>
      </header>

      <TopicMembership captureId={experience.id} returnTo={topicNav.returnTo} />

      {notice && <p className="save-ok" role="status">{notice}</p>}
      {error && <p className="error-msg" role="alert">{error}</p>}

      <section className="section experience-understanding" aria-label="我的理解">
        <div className="section-head">
          <h3>我的理解</h3>
          <span className="muted">用户总结，不是原始观察</span>
        </div>
        {experience.understanding ? (
          <p className="experience-body">{experience.understanding}</p>
        ) : (
          <p className="error-msg">
            正文已清空，等待重新整理。依据记录仍然保留，可打开下方来源核对。
          </p>
        )}
      </section>

      {(experience.conditions || experience.limitations) && (
        <section className="section experience-conditions" aria-label="条件与限制">
          {experience.conditions && (
            <div>
              <h4>适用条件</h4>
              <p className="experience-body">{experience.conditions}</p>
            </div>
          )}
          {experience.limitations && (
            <div>
              <h4>限制或还不确定的地方</h4>
              <p className="experience-body">{experience.limitations}</p>
            </div>
          )}
        </section>
      )}

      <section className="section experience-sources" aria-label="依据记录">
        <div className="section-head">
          <h3>依据记录</h3>
          <span className="muted">
            {experience.sourceCount} 条可用
            {experience.changedSourceCount > 0
              ? ` · ${experience.changedSourceCount} 条有更新`
              : ''}
            {experience.deletedSourceCount > 0
              ? ` · ${experience.deletedSourceCount} 条已删除`
              : ''}
          </span>
          <button
            type="button"
            className="btn small"
            onClick={() => openRevise(null)}
            data-testid="experience-edit-sources"
          >
            增删依据
          </button>
        </div>
        <p className="hint">
          依据可以随时增删：移除只解除这条依据关系，原始念头/尝试与结果都会保留；删除来源记录也不会删掉这份经验。
        </p>
        {(experience.changedSourceCount > 0 || experience.deletedSourceCount > 0) && (
          <p className="hint warn">
            来源有更新或已删除，建议重新核对。经验正文不会被自动覆盖。
          </p>
        )}
        {experience.sources.length === 0 && (
          <div className="empty-state">
            <p>还没有依据记录；这份经验需要补一条来源才能成立。</p>
            <button type="button" className="btn small primary" onClick={() => openRevise(null)}>
              补一条依据
            </button>
          </div>
        )}
        <ul className="experience-source-list">
          {experience.sources.map((source) => (
            <li key={source.sourceKey} className={source.deleted ? 'is-deleted' : ''}>
              <div className="experience-source-head">
                {source.openHref ? (
                  <Link to={source.openHref}>{source.title}</Link>
                ) : (
                  <span>{source.title}</span>
                )}
                <span className="badge subtle">依据</span>
                {source.kind === 'experience' && (
                  <span className="badge">经验整理 · 非原始观察</span>
                )}
                {source.deleted && <span className="badge warn">来源已删除</span>}
                {!source.deleted && source.changed && (
                  <span className="badge warn">来源有更新</span>
                )}
              </div>
              {source.resultText ? (
                <p className="experience-source-result">{source.resultText}</p>
              ) : source.text ? (
                <p className="muted experience-source-text">{source.text}</p>
              ) : (
                <p className="muted">来源正文已清理，只保留不可读的关联。</p>
              )}
              <div className="experience-source-meta">
                {source.observedAt && <span>结果时间：{formatTime(source.observedAt)}</span>}
                {!source.deleted && (
                  <Link
                    className="inline-link"
                    to={topicAwareHref(
                      `/graph?focus=${source.type}:${source.id}&returnTo=${encodeURIComponent(
                        `/experience/${experience.id}`
                      )}`,
                      topicNav
                    )}
                  >
                    在局部图中查看 →
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="section experience-attempts" aria-label="后续实践">
        <div className="section-head">
          <h3>参考这条经验的尝试</h3>
          <span className="muted">{experience.attempts.length} 次</span>
        </div>
        {experience.attempts.length === 0 ? (
          <p className="muted">
            还没有人参考它试过。可以点「参考它，试一步」，用现有尝试流程记录一次真实结果。
          </p>
        ) : (
          <ul className="experience-attempt-list">
            {experience.attempts.map((attempt) => (
              <li key={attempt.id}>
                <div className="experience-attempt-head">
                  <Link to={`/attempt/${attempt.id}`}>{attempt.title}</Link>
                  <span className="badge">{STATE_LABEL[attempt.state] ?? attempt.state}</span>
                  {attempt.outcome && (
                    <span className="badge">
                      {OUTCOME_LABEL[attempt.outcome] ?? attempt.outcome}
                    </span>
                  )}
                  {attempt.deleted && <span className="badge warn">尝试已删除</span>}
                </div>
                {attempt.resultText && (
                  <p className="experience-source-result">{attempt.resultText}</p>
                )}
                <p className="card-meta">
                  采用时第 {attempt.adoptedVersion} 版
                  {attempt.observedAt ? ` · 结果时间 ${formatTime(attempt.observedAt)}` : ''}
                </p>
                {attempt.adoptedUnderstanding &&
                  attempt.adoptedUnderstanding !== experience.understanding && (
                    <details className="experience-adopted">
                      <summary>当时采用的理解（与当前不同）</summary>
                      <p className="experience-body">{attempt.adoptedUnderstanding}</p>
                    </details>
                  )}
                {attempt.resultText ? (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => openRevise(attempt)}
                    data-testid="experience-revise-from-attempt"
                  >
                    根据这次结果修订经验
                  </button>
                ) : (
                  <Link className="btn small" to={`/attempt/${attempt.id}`}>
                    先记录结果
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {attemptOpen && (
        <section className="section experience-try" aria-label="参考经验试一步">
          <div className="section-head">
            <h3>参考它，试一步</h3>
            <button type="button" className="btn small" onClick={() => setAttemptOpen(false)}>
              收起
            </button>
          </div>
          <p className="hint">
            会沿用现有尝试和结果表单；不自动创建日程，也不自动填写结果。
          </p>
          {createdAttempt ? (
            <div className="experience-created" role="status">
              <p>已创建这次尝试。完成后记录实际结果，再回这里修订经验。</p>
              <Link className="btn small primary" to={`/attempt/${createdAttempt.id}`}>
                去记录结果
              </Link>
            </div>
          ) : (
            <div className="attempt-form experience-try-form">
              <label className="field">
                <span>所属念头</span>
                <select
                  value={targetCaptureId}
                  onChange={(event) => setTargetCaptureId(event.target.value)}
                >
                  {captures.length === 0 && <option value="">没有可用念头</option>}
                  {captures.map((capture) => (
                    <option key={capture.id} value={capture.id}>
                      {capture.rawText.slice(0, 50)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>这一步做什么</span>
                <input
                  type="text"
                  value={attemptTitle}
                  maxLength={120}
                  onChange={(event) => setAttemptTitle(event.target.value)}
                />
              </label>
              <label className="field">
                <span>说明（可选）</span>
                <textarea
                  rows={3}
                  value={attemptDescription}
                  maxLength={2000}
                  onChange={(event) => setAttemptDescription(event.target.value)}
                  placeholder="这次准备怎么做、想观察什么…"
                />
              </label>
              {availableBasis.length > 0 && (
                <fieldset className="experience-basis">
                  <legend>这次实际选用哪些原始结果</legend>
                  {availableBasis.map((source) => (
                    <label key={source.sourceKey} className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={basisKeys.has(source.sourceKey)}
                        onChange={(event) => {
                          const next = new Set(basisKeys);
                          if (event.target.checked) next.add(source.sourceKey);
                          else next.delete(source.sourceKey);
                          setBasisKeys(next);
                        }}
                      />
                      <span>{source.title}</span>
                    </label>
                  ))}
                  <p className="hint">只有勾选的原始尝试会进入既有引用关系。</p>
                </fieldset>
              )}
              {attemptError && <p className="error-msg" role="alert">{attemptError}</p>}
              <div className="row-actions">
                <button type="button" className="btn" onClick={() => setAttemptOpen(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => void submitAttempt()}
                  disabled={attemptBusy || !targetCaptureId}
                  data-testid="experience-create-attempt"
                >
                  {attemptBusy ? '保存中…' : '保存这一步'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      <CaptureLinksPanel captureId={experience.id} />

      <section className="section experience-management" aria-label="经验管理">
        <div className="section-head">
          <h3>管理</h3>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn small"
            onClick={() => void toggleArchive()}
            disabled={archiving}
          >
            {experience.archived ? '恢复' : '归档'}
          </button>
          <button
            type="button"
            className="btn small danger-outline"
            onClick={() => void openDeletePreview()}
            disabled={deleteBusy}
          >
            删除经验…
          </button>
        </div>
        <p className="hint">
          删除经验不会删除它的来源记录，也不会删除后续尝试已经产生的结果。归档只是移出默认列表。
        </p>
      </section>

      {deletePreview && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-label="删除经验">
            <div className="modal-head">
              <h3>删除「{deletePreview.title}」？</h3>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setDeletePreview(null)}
                aria-label="取消删除"
              >
                ×
              </button>
            </div>
            <p>会删除这份经验正文和它的手动关联。</p>
            <ul className="delete-preview-list">
              <li>
                来源记录 {deletePreview.sourceCount} 条：只解除依据关系，原记录保留。
              </li>
              <li>
                参考它产生的尝试 {deletePreview.attemptCount} 次：尝试与结果保留，只清掉经验正文快照。
              </li>
              <li>手动关联 {deletePreview.linkCount} 条：随经验一起解除。</li>
            </ul>
            {deletePreview.sources.length > 0 && (
              <div>
                <h4>会被保留的来源</h4>
                <ul className="delete-preview-list">
                  {deletePreview.sources.map((source, index) => (
                    <li key={`${source.title}-${index}`}>
                      {source.title}
                      {!source.exists ? '（已删除）' : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {deleteError && <p className="error-msg">{deleteError}</p>}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setDeletePreview(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn danger-outline"
                onClick={() => void confirmDelete()}
                disabled={deleteBusy}
              >
                {deleteBusy ? '删除中…' : '确认删除'}
              </button>
            </div>
          </section>
        </div>
      )}

      {editorOpen && (
        <ExperienceEditor
          mode="revise"
          experience={experience}
          reviseAttempt={
            reviseAttempt
              ? {
                  id: reviseAttempt.id,
                  title: reviseAttempt.title,
                  resultText: reviseAttempt.resultText,
                  outcome: reviseAttempt.outcome,
                }
              : null
          }
          onCancel={() => {
            setEditorOpen(false);
            setReviseAttempt(null);
          }}
          onSaved={(updated) => {
            setExperience(updated);
            setEditorOpen(false);
            setReviseAttempt(null);
            setNotice('经验已更新。后续尝试仍保留各自采用时的版本。');
          }}
        />
      )}
    </div>
  );
}
