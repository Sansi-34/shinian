// 拾念 SHINIAN v0.1 - 尝试详情：状态、结果、引用（双向）
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api, { ApiError } from '../api';
import type {
  Attempt,
  AttemptDeletePreview,
  AttemptOutcome,
  AttemptState,
  Capture,
  FutureScheduleAction,
  ReferenceFrom,
  ReferenceTo,
  ScheduleBlock,
  SearchAttemptHit,
  ResearchAttemptDetail,
  ExperienceDraft,
  ExperienceAttemptRef,
} from '../types';
import {
  experienceErrorText,
  formatTime,
  newOperationId,
  OUTCOME_LABEL,
  RESEARCH_SOURCE_KIND_LABEL,
  STATE_LABEL,
} from '../types';
import ExperienceEditor from '../components/ExperienceEditor';
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
import { readTopicNav, topicAwareHref } from '../components/topicNav';

const STATE_OPTIONS: AttemptState[] = ['todo', 'in_progress', 'done', 'cancelled'];

function toDatetimeLocal(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function AttemptDetailPage() {
  const { attemptId = '' } = useParams<{ attemptId: string }>();
  const [searchParams] = useSearchParams();
  const fromAi = searchParams.get('from') === 'ai';
  const topicNav = readTopicNav(searchParams);
  const location = useLocation();
  const resultSectionRef = useRef<HTMLElement>(null);
  const resultTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [fromRefs, setFromRefs] = useState<ReferenceFrom[]>([]);
  const [toRefs, setToRefs] = useState<ReferenceTo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 致命加载失败（尝试不存在 / 服务不可用）：单独保存，用于渲染可重试的错误页
  const [loadFailure, setLoadFailure] = useState<{ status: number; message: string } | null>(null);
  const navigate = useNavigate();

  // 日程
  const [timezone] = useDisplayTimezone();
  const [schedules, setSchedules] = useState<ScheduleBlock[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(true);
  const [schedulesError, setSchedulesError] = useState<string | null>(null);
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false);
  const [scheduleDetail, setScheduleDetail] = useState<ScheduleBlock | null>(null);
  const [scheduleNotice, setScheduleNotice] = useState<string | null>(null);
  const now = useNow();

  // 状态改为 done/cancelled 时服务端返回的未来安排
  const [futurePrompt, setFuturePrompt] = useState<{
    nextState: AttemptState;
    futureSchedules: ScheduleBlock[];
    currentRevision: number;
    action: FutureScheduleAction | null;
    saving: boolean;
    error: string | null;
  } | null>(null);

  // 删除预览
  const [deletePreview, setDeletePreview] = useState<AttemptDeletePreview | null>(null);
  const [deletePreviewLoading, setDeletePreviewLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 状态保存
  const [stateSaving, setStateSaving] = useState(false);
  // 状态保存自己的反馈，避免和「结果保存」的错误互相盖住（原来都塞进页尾的 error）
  const [stateError, setStateError] = useState<string | null>(null);
  const [stateNotice, setStateNotice] = useState<string | null>(null);

  // 结果表单
  const [resultText, setResultText] = useState('');
  const [outcome, setOutcome] = useState<AttemptOutcome | ''>('');
  const [observedAt, setObservedAt] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [resultSaving, setResultSaving] = useState(false);
  const [resultNotice, setResultNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ current: Attempt } | null>(null);

  // 引用选择器
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickQuery, setPickQuery] = useState('');
  const [pickResults, setPickResults] = useState<SearchAttemptHit[]>([]);
  const [pickLoading, setPickLoading] = useState(false);
  const [picked, setPicked] = useState<SearchAttemptHit | null>(null);
  const [refNote, setRefNote] = useState('');
  const [refSaving, setRefSaving] = useState(false);
  const [refError, setRefError] = useState<string | null>(null);
  const [refNotice, setRefNotice] = useState<string | null>(null);
  const refOperationIdRef = useRef(newOperationId());

  const [researchLink, setResearchLink] = useState<ResearchAttemptDetail | null>(null);
  const [experienceRef, setExperienceRef] = useState<ExperienceAttemptRef | null>(null);
  const [experienceDraft, setExperienceDraft] = useState<ExperienceDraft | null>(null);
  const [experienceDraftBusy, setExperienceDraftBusy] = useState(false);
  const [experienceDraftError, setExperienceDraftError] = useState<string | null>(null);
  const [experienceSaved, setExperienceSaved] = useState<{ id: string; title: string } | null>(
    null
  );

  useEffect(() => {
    load();
  }, [attemptId]);

  useEffect(() => {
    if (!attempt) return;
    if (window.location.hash === '#result-section') {
      const timer = window.setTimeout(() => scrollToResult(), 80);
      return () => window.clearTimeout(timer);
    }
  }, [attempt?.id]);

  async function load() {
    if (!attemptId) return;
    setLoading(true);
    setError(null);
    setLoadFailure(null);
    try {
      const res = await api.getAttempt(attemptId);
      setAttempt(res.attempt);
      setCapture(res.capture);
      setExperienceRef(res.experienceRef ?? null);
      setResultText(res.attempt.resultText ?? '');
      setOutcome(res.attempt.outcome ?? '');
      setObservedAt(toDatetimeLocal(res.attempt.observedAt));
      setSourceUrl(res.attempt.sourceUrl ?? '');
      try {
        const research = await api.getAttemptResearch(attemptId);
        setResearchLink(research.research);
      } catch {
        setResearchLink(null);
      }
      const refs = await api.listReferences(attemptId);
      setFromRefs(refs.fromRefs ?? []);
      setToRefs(refs.toRefs ?? []);
      await refreshSchedules();
    } catch (e: any) {
      const status = e instanceof ApiError ? e.status ?? 0 : 0;
      const message =
        status === 404
          ? '这条尝试不存在，可能已被删除。'
          : status >= 400
            ? e.body?.message || '无法读取这条尝试，请稍后重试。'
            : '无法连接到本地服务，请确认服务正在运行后重试。';
      setLoadFailure({ status, message });
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshSchedules() {
    if (!attemptId) return;
    setSchedulesLoading(true);
    setSchedulesError(null);
    try {
      const res = await api.listAttemptSchedules(attemptId);
      setSchedules(sortSchedules(res.schedules ?? []));
    } catch (e: any) {
      setSchedulesError(e?.body?.message || e?.message || '日程加载失败');
    } finally {
      setSchedulesLoading(false);
    }
  }

  function scrollToResult() {
    resultSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => {
      resultTextareaRef.current?.focus({ preventScroll: true });
    }, 260);
  }

  async function startExperienceNote() {
    if (!attempt || experienceDraftBusy) return;
    setExperienceDraftBusy(true);
    setExperienceDraftError(null);
    try {
      const res = await api.getAttemptExperienceDraft(attempt.id);
      setExperienceDraft(res.draft);
    } catch (e) {
      const message =
        e instanceof ApiError
          ? e.body?.message || experienceErrorText(e.body?.error, '暂时不能整理成经验。')
          : '暂时不能整理成经验。';
      setExperienceDraftError(message);
    } finally {
      setExperienceDraftBusy(false);
    }
  }

  async function saveState(next: AttemptState) {
    if (!attempt || stateSaving || next === attempt.state) return;
    setStateSaving(true);
    setStateError(null);
    setStateNotice(null);
    try {
      const res = await api.updateAttempt(attempt.id, { state: next, revision: attempt.revision });
      setAttempt(res.attempt);
      setStateNotice(`状态已更新为「${STATE_LABEL[res.attempt.state]}」。`);
      if (res.cancelledScheduleCount && res.cancelledScheduleCount > 0) {
        setScheduleNotice(`已同时取消 ${res.cancelledScheduleCount} 个未来安排。`);
      }
      await refreshSchedules();
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409 && e.body?.error === 'future_schedules') {
        setFuturePrompt({
          nextState: next,
          futureSchedules: Array.isArray(e.body.futureSchedules) ? e.body.futureSchedules : [],
          currentRevision:
            typeof e.body.currentRevision === 'number' ? e.body.currentRevision : attempt.revision,
          action: null,
          saving: false,
          error: null,
        });
      } else if (e instanceof ApiError && e.status === 409) {
        // 同步最新版本，用户再点一次就能保存成功，不会一直撞同一个 409
        const current = e.body?.current as Attempt | undefined;
        if (current) setAttempt(current);
        setStateError(
          current
            ? `版本冲突：这条尝试已被其他窗口修改，当前状态是「${STATE_LABEL[current.state]}」。已同步最新版本，请重新选择状态。`
            : '版本冲突：状态已被其他窗口修改。已同步最新版本，请重新选择状态。',
        );
      } else {
        setStateError(e?.body?.message || e?.message || '状态保存失败，请重试。');
      }
    } finally {
      setStateSaving(false);
    }
  }

  async function resolveFutureSchedules(action: FutureScheduleAction) {
    if (!attempt || !futurePrompt || futurePrompt.saving) return;
    const prompt = futurePrompt;
    setFuturePrompt({ ...prompt, action, saving: true, error: null });
    try {
      const res = await api.updateAttempt(attempt.id, {
        state: prompt.nextState,
        revision: prompt.currentRevision,
        futureScheduleAction: action,
      });
      setAttempt(res.attempt);
      setFuturePrompt(null);
      if (action === 'cancel') {
        setScheduleNotice(
          res.cancelledScheduleCount
            ? `已取消 ${res.cancelledScheduleCount} 个未来安排。`
            : '已取消未来安排。'
        );
      } else {
        setScheduleNotice('已保留未来安排。');
      }
      await refreshSchedules();
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409 && e.body?.error === 'future_schedules') {
        setFuturePrompt({
          ...prompt,
          action,
          saving: false,
          futureSchedules: Array.isArray(e.body.futureSchedules)
            ? e.body.futureSchedules
            : prompt.futureSchedules,
          currentRevision:
            typeof e.body.currentRevision === 'number'
              ? e.body.currentRevision
              : prompt.currentRevision,
          error: '未来安排又发生变化，请重新确认保留还是取消。',
        });
      } else if (e instanceof ApiError && e.status === 409 && e.body?.current) {
        const current = e.body.current as Attempt;
        setFuturePrompt({
          ...prompt,
          action,
          saving: false,
          currentRevision: current.revision,
          error: '尝试刚被其他窗口修改，已同步到最新版本。请再次选择保留还是取消这些安排。',
        });
      } else if (e instanceof ApiError) {
        const message =
          e.body?.message || (e.body?.error ? `保存失败（${e.body.error}）` : '保存失败');
        setFuturePrompt({ ...prompt, action, saving: false, error: message });
      } else {
        setFuturePrompt({ ...prompt, action, saving: false, error: '保存失败，请重试。' });
      }
    }
  }

  async function openDeletePreview() {
    if (!attempt || deletePreviewLoading) return;
    setDeletePreviewLoading(true);
    setDeleteError(null);
    try {
      const preview = await api.getAttemptDeletePreview(attempt.id);
      setDeletePreview(preview);
    } catch (e: any) {
      setDeleteError(e?.body?.message || e?.message || '无法获取删除影响范围');
    } finally {
      setDeletePreviewLoading(false);
    }
  }

  async function confirmDeleteAttempt() {
    if (!attempt || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteAttempt(attempt.id);
      navigate(capture ? `/capture/${capture.id}` : '/');
    } catch (e: any) {
      setDeleteError(e?.body?.message || e?.message || '删除失败，请重试');
      setDeleting(false);
    }
  }

  async function saveResult(e?: React.FormEvent) {
    e?.preventDefault();
    if (!attempt || resultSaving) return;
    // 冲突后点「重试保存（覆盖最新版）」时用服务端返回的最新版本号，
    // 否则一直拿旧 revision 重试，只会反复 409，永远存不进去。
    const baseRevision = conflict?.current?.revision ?? attempt.revision;
    setResultSaving(true);
    setResultNotice(null);
    setError(null);
    try {
      // 「发生时间」留空时不显式提交 observedAt:null：省略该字段，
      // 让服务端在新结果首次写入时记录时间；已有 observedAt 保持不变。
      const res = await api.updateAttempt(attempt.id, {
        resultText: resultText.trim() ? resultText : null,
        outcome: outcome || null,
        sourceUrl: sourceUrl.trim() ? sourceUrl.trim() : null,
        revision: baseRevision,
        ...(observedAt ? { observedAt: new Date(observedAt).getTime() } : {}),
      });
      setAttempt(res.attempt);
      setConflict(null);
      setResultNotice('结果已保存 ✓');
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409) {
        const current = (e.body?.current as Attempt | undefined) ?? null;
        setConflict(current ? { current } : null);
        if (!current) setError('版本冲突：这条尝试已被其他窗口修改，请刷新后再试。');
      } else {
        setError(e?.body?.message || e?.message || '保存失败，请重试。');
      }
    } finally {
      setResultSaving(false);
    }
  }

  async function searchPick() {
    const q = pickQuery.trim();
    if (!q) return;
    setPickLoading(true);
    setRefError(null);
    try {
      const res = await api.search(q);
      setPickResults(res.attempts.filter((a) => a.id !== attemptId));
    } catch (e: any) {
      setRefError(e?.message || '搜索失败');
    } finally {
      setPickLoading(false);
    }
  }

  async function submitReference() {
    if (!attempt || !picked || refSaving) return;
    setRefSaving(true);
    setRefError(null);
    setRefNotice(null);
    try {
      const pickedStep = picked.step;
      await api.createReference(attempt.id, {
        toId: picked.id,
        note: refNote.trim() || undefined,
        operationId: refOperationIdRef.current,
      });
      refOperationIdRef.current = newOperationId();
      setPickerOpen(false);
      setPicked(null);
      setRefNote('');
      setPickQuery('');
      setPickResults([]);
      const refs = await api.listReferences(attempt.id);
      setFromRefs(refs.fromRefs ?? []);
      setToRefs(refs.toRefs ?? []);
      setRefNotice(`已引用「${pickedStep}」的结果，可在下方「我参考了什么」查看。`);
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409) {
        if (e.body?.existingId) {
          setPickerOpen(false);
          const refs = await api.listReferences(attempt.id);
          setFromRefs(refs.fromRefs ?? []);
          setToRefs(refs.toRefs ?? []);
          setRefError(null);
          setRefNotice('这条引用之前已经建立过，下面直接显示已有记录。');
        } else {
          setRefError('操作冲突，请重试');
        }
      } else {
        setRefError(e?.body?.message || e?.message || '引用失败，请重试。');
      }
    } finally {
      setRefSaving(false);
    }
  }

  if (loading) return <div className="page"><p className="muted">加载中…</p></div>;
  if (!attempt) {
    return (
      <div className="page attempt-page">
        <div className="crumb">
          <Link to="/">← 返回首页</Link>
          {location.key !== 'default' && (
            <>
              {' · '}
              <button
                type="button"
                className="link topic-back-link"
                onClick={() => navigate(-1)}
                data-testid="attempt-back-previous"
              >
                ← 返回上一页
              </button>
            </>
          )}
        </div>
        <div className="home-load-error" role="alert" data-testid="attempt-load-error">
          <p className="error-msg">{loadFailure?.message || error || '尝试不存在'}</p>
          <p className="hint">
            {loadFailure && loadFailure.status === 404
              ? '链接里的尝试可能已被删除；所属念头和其他尝试不受影响。'
              : '记录没有被删除，只是这次没读到：检查本地服务是否在运行，然后重试。'}
          </p>
          <div className="row-actions">
            <button
              type="button"
              className="btn small primary"
              onClick={() => void load()}
              data-testid="attempt-load-retry"
            >
              重试
            </button>
            <button type="button" className="btn small" onClick={() => navigate(-1)}>
              返回上一页
            </button>
            <Link className="btn small" to="/">返回首页</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page attempt-page">
      <div className="crumb">
        {capture ? <Link to={`/capture/${capture.id}`}>← {capture.rawText.slice(0, 40)}</Link> : <Link to="/">← 返回</Link>}
        {location.key !== 'default' && (
          <>
            {' · '}
            <button
              type="button"
              className="link topic-back-link"
              onClick={() => navigate(-1)}
              data-testid="attempt-back-previous"
            >
              ← 返回上一页
            </button>
          </>
        )}
        {topicNav.fromTopic && topicNav.returnTo && (
          <>
            {' · '}
            <Link to={topicNav.returnTo} className="topic-back-link" data-testid="attempt-back-topic">
              ← 返回主题
            </Link>
          </>
        )}
      </div>

      {fromAi && (
        <div className="ai-adopted-banner" role="status">
          <div>
            <strong>已采用 AI 建议，记得记录实际结果</strong>
            <p>这一步来自 AI。试完后回来写下实际观察和评价。</p>
          </div>
          <button type="button" className="btn small" onClick={scrollToResult}>去记录结果</button>
        </div>
      )}

      <header className="detail-head">
        <div className="detail-head-row">
          <div>
            <span className="page-kicker">尝试实践 · 闭环复盘</span>
            <h2 className="detail-title">{attempt.step}</h2>
          </div>
          <div className="detail-head-actions">
            <Link
              className="btn small"
              to={topicAwareHref(`/graph?node=attempt:${attempt.id}&depth=1`, topicNav)}
              data-testid="attempt-open-local-graph"
            >
              查看局部图
            </Link>
            <button type="button" className="btn primary small" onClick={scrollToResult}>
              记录实际结果
            </button>
            {attempt.resultText && attempt.resultText.trim() && (
              <>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => void startExperienceNote()}
                  disabled={experienceDraftBusy}
                  data-testid="experience-note-from-attempt"
                >
                  {experienceDraftBusy ? '读取中…' : '整理成经验'}
                </button>
                <Link
                  className="btn small"
                  to={`/capture/${attempt.captureId}?experience=${attempt.id}`}
                  data-testid="experience-from-attempt"
                >
                  用这条经验试一步
                </Link>
              </>
            )}
            <button
              type="button"
              className="btn small danger-outline"
              onClick={() => void openDeletePreview()}
              disabled={deletePreviewLoading}
              aria-label="删除记录"
              title="删除这条尝试记录（会显示影响范围）"
            >
              {deletePreviewLoading ? '读取删除影响…' : '删除记录…'}
            </button>
          </div>
        </div>
        <p className="card-meta">创建于 {formatTime(attempt.createdAt)} · 当前版本 {attempt.revision}</p>
      </header>

      {/* 核心三部曲视觉卡片：原来的想法 → 准备怎么试 → 实际发生了什么 */}
      <section className="attempt-triad-card" aria-label="实践三部曲">
        <div className="triad-step">
          <div className="triad-badge">1. 原来的想法</div>
          <div className="triad-content">
            {capture ? (
              <Link to={`/capture/${capture.id}`} className="triad-link">
                {capture.rawText}
              </Link>
            ) : (
              <span className="muted">（独立记录）</span>
            )}
          </div>
        </div>

        <div className="triad-arrow" aria-hidden="true">→</div>

        <div className="triad-step">
          <div className="triad-badge">2. 准备怎么试</div>
          <div className="triad-content">
            <strong className="triad-step-title">{attempt.step}</strong>
            <span className={`badge state-${attempt.state} triad-state-badge`}>
              {STATE_LABEL[attempt.state]}
            </span>
          </div>
        </div>

        <div className="triad-arrow" aria-hidden="true">→</div>

        <div className="triad-step triad-result-step">
          <div className="triad-badge">3. 实际发生了什么</div>
          <div className="triad-content">
            {attempt.resultText?.trim() ? (
              <div className="triad-result-box">
                <span className="triad-result-text">{attempt.resultText}</span>
                {attempt.outcome && (
                  <span className={`badge outcome-${attempt.outcome}`}>
                    {OUTCOME_LABEL[attempt.outcome]}
                  </span>
                )}
              </div>
            ) : (
              <div className="triad-empty-result">
                <span className="muted">尚未记录结果（未记录不代表失败）</span>
                <button type="button" className="link triad-quick-btn" onClick={scrollToResult}>
                  去记录实际结果 →
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      {experienceDraftError && (
        <p className="error-msg" role="alert">
          {experienceDraftError}
        </p>
      )}

      {experienceSaved && (
        <p className="save-ok" role="status">
          已保存为经验《{experienceSaved.title}》。
          <Link className="inline-link" to={`/experience/${experienceSaved.id}`}>
            打开经验 →
          </Link>
        </p>
      )}

      {experienceRef && (
        <section className="section attempt-experience-ref" aria-label="来源经验">
          <div className="section-head">
            <h3>这次尝试参考的经验</h3>
            {experienceRef.deleted && <span className="badge warn">来源经验已删除</span>}
            {!experienceRef.deleted && experienceRef.archived && (
              <span className="badge">已归档</span>
            )}
          </div>
          {experienceRef.deleted ? (
            <p className="hint">
              当时采用「{experienceRef.adoptedTitle || '来源经验'}」第 {experienceRef.adoptedVersion} 版；
              经验已删除，但这次尝试和它的结果仍然独立保留。
            </p>
          ) : (
            <>
              <p>
                <Link to={`/experience/${experienceRef.experienceId}`}>
                  {experienceRef.adoptedTitle}
                </Link>
                <span className="muted"> · 采用时第 {experienceRef.adoptedVersion} 版</span>
                {experienceRef.currentVersion != null &&
                  experienceRef.currentVersion !== experienceRef.adoptedVersion && (
                    <span className="badge warn">经验已更新至第 {experienceRef.currentVersion} 版</span>
                  )}
              </p>
              {experienceRef.adoptedUnderstanding && (
                <details className="experience-adopted">
                  <summary>当时采用的理解</summary>
                  <p className="experience-body">{experienceRef.adoptedUnderstanding}</p>
                </details>
              )}
              {experienceRef.changed && (
                <p className="hint warn">
                  经验正文已有更新；这次尝试仍保留采用时的版本，历史上下文不会被覆盖。
                </p>
              )}
            </>
          )}
        </section>
      )}

      {attempt.origin === 'review_next_action' && (
        <section className="section next-action-attempt-context" aria-label="下一步行动上下文">
          <div className="section-head">
            <h3>下一步行动</h3>
            <span className="badge ai-kind">来自回顾</span>
          </div>
          <p className="next-action-context-desc">
            {attempt.actionDescription || (
              <span className="muted">这条行动没有填写说明。</span>
            )}
          </p>
          <dl className="next-action-detail-grid">
            <div>
              <dt>预计耗时</dt>
              <dd>
                {attempt.estimatedMinutes != null
                  ? `${attempt.estimatedMinutes} 分钟`
                  : '未填写'}
              </dd>
            </div>
            <div>
              <dt>来源回顾</dt>
              <dd>
                {attempt.sourceReviewId ? (
                  <Link to={`/review/${attempt.sourceReviewId}`}>打开来源回顾 →</Link>
                ) : (
                  <span className="muted">来源回顾已删除或不可用。</span>
                )}
              </dd>
            </div>
            <div>
              <dt>来源尝试</dt>
              <dd>
                {attempt.sourceAttemptId ? (
                  <Link to={`/attempt/${attempt.sourceAttemptId}`}>
                    打开来源尝试
                    {attempt.sourceAttemptRevision != null
                      ? `（保存时版本 ${attempt.sourceAttemptRevision}）`
                      : ''}
                    →
                  </Link>
                ) : (
                  <span className="muted">来源尝试已删除。</span>
                )}
              </dd>
            </div>
          </dl>
          <div className="row-actions">
            <Link
              className="btn small"
              to={`/next-action/${attempt.id}`}
              data-testid="next-action-open"
            >
              打开下一步行动
            </Link>
          </div>
          <p className="hint">
            说明与预计耗时来自你在回顾后保存的行动；状态和结果以本页的实际尝试记录为准。
          </p>
        </section>
      )}

      {attempt.origin === 'research_experiment' && (
        <section className="section research-attempt-context" aria-label="研究实验上下文">
          <div className="section-head">
            <h3>来源研究</h3>
            <span className="badge test">待实际测试</span>
          </div>
          {researchLink?.deleted ? (
            <p className="hint warn">
              来源研究已删除；采用时的建议仍保留在下方。尝试记录和实际结果不受影响。
            </p>
          ) : researchLink ? (
            <p className="hint">
              <Link to={`/research/${researchLink.id}`}>打开这次研究 →</Link>
              {researchLink.question ? ` · ${researchLink.question}` : ''}
            </p>
          ) : (
            <p className="hint">来源研究不可用。</p>
          )}
          <p className="next-action-context-desc">
            {attempt.actionDescription || researchLink?.suggestion?.description || (
              <span className="muted">这条尝试没有填写说明。</span>
            )}
          </p>
          <dl className="next-action-detail-grid">
            <div>
              <dt>预计耗时</dt>
              <dd>{attempt.estimatedMinutes != null ? `${attempt.estimatedMinutes} 分钟` : '未填写'}</dd>
            </div>
            <div>
              <dt>验证什么</dt>
              <dd>{researchLink?.suggestion?.verifies || '未记录'}</dd>
            </div>
            <div>
              <dt>来源仓库</dt>
              <dd>{researchLink?.suggestion?.repo || '未记录'}</dd>
            </div>
            <div>
              <dt>研究建议序号</dt>
              <dd>实验 {(researchLink?.experimentIndex ?? 0) + 1}</dd>
            </div>
          </dl>
          {researchLink?.suggestion?.description &&
            attempt.actionDescription &&
            researchLink.suggestion.description !== attempt.actionDescription && (
              <details className="research-original-suggestion">
                <summary>查看研究中的原始建议</summary>
                <p>{researchLink.suggestion.description}</p>
              </details>
            )}
          {(researchLink?.sources?.length ?? 0) > 0 && (
            <div className="research-attempt-sources">
              <h5>采用的资料</h5>
              <ul className="plain-list">
                {researchLink!.sources.map((source) => (
                  <li key={source.sourceKey}>
                    <a href={source.url} target="_blank" rel="noreferrer noopener">
                      {source.sourceKey} · {source.repoFullName}
                    </a>
                    <span className="hint">
                      {' '}
                      · {RESEARCH_SOURCE_KIND_LABEL[source.kind] ?? source.kind} ·{' '}
                      {source.status === 'ok' ? '已获取' : source.status === 'missing' ? '资料缺失' : '读取失败'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="hint">
            研究建议是模型根据公开资料作出的推断；这里的实际观察、评价和结果与建议分开保存。
          </p>
        </section>
      )}

      <section className="section">
        <h3>状态</h3>
        <div className="state-switch" role="group" aria-label="尝试状态">
          {STATE_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`btn small ${attempt.state === s ? 'primary' : ''}`}
              onClick={() => saveState(s)}
              disabled={stateSaving}
              aria-label={
                s === 'cancelled'
                  ? '放弃尝试'
                  : s === 'done'
                    ? '把尝试标记为已结束'
                    : `把尝试标记为${STATE_LABEL[s]}`
              }
              title={
                s === 'cancelled'
                  ? '放弃尝试：不会取消日程或删除记录'
                  : s === 'done'
                    ? '改变状态不会删除记录'
                    : undefined
              }
            >
              {STATE_LABEL[s]}
            </button>
          ))}
        </div>
        <p className="hint">
          「已放弃」表示放弃尝试但不删除记录；「取消安排」只影响某一段时间；「删除记录」会永久删除这条尝试。
        </p>
        {stateNotice && (
          <p className="save-ok" role="status" data-testid="attempt-state-notice">
            {stateNotice}
          </p>
        )}
        {stateError && (
          <p className="error-msg" role="alert" data-testid="attempt-state-error">
            {stateError}
          </p>
        )}
      </section>

      <section className="section schedule-attempt-section">
        <div className="section-head">
          <h3>
            日程安排{' '}
            <span className="muted">
              ({schedules.filter((item) => item.status === 'active').length} 个有效)
            </span>
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
        <p className="hint">安排只是「打算什么时候做」，不会改变尝试状态。</p>
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
              attemptId={attempt.id}
              displayTimezone={timezone}
              onCancel={() => setScheduleEditorOpen(false)}
              onSaved={(saved) => {
                setScheduleEditorOpen(false);
                setScheduleNotice('安排已保存。');
                setSchedules((prev) =>
                  sortSchedules([...prev.filter((item) => item.id !== saved.id), saved])
                );
                void refreshSchedules();
              }}
            />
          </div>
        )}
        {schedulesLoading ? (
          <p className="muted loading-line" role="status">
            <span className="spinner" aria-hidden="true" /> 加载日程…
          </p>
        ) : schedulesError ? (
          <div className="schedule-error">
            <p className="error-msg" role="alert">
              {schedulesError}
            </p>
            <button type="button" className="btn small" onClick={() => void refreshSchedules()}>
              重试
            </button>
          </div>
        ) : schedules.length === 0 ? (
          <p className="empty-state">这条尝试还没有安排时间。</p>
        ) : (
          <ul className="schedule-list attempt-schedule-list">
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
                      {schedule.note || schedule.attempt?.step || '（无备注）'}
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

      <section className="section result-section" id="result-section" ref={resultSectionRef}>
        <div className="section-head">
          <div>
            <h3>实际结果记录</h3>
            <p className="hint">成功了存经验，翻车了存避坑指南。未记录结果的尝试绝不判定为失败。</p>
          </div>
        </div>
        <form className="result-form" onSubmit={saveResult}>
          <label className="field">
            <span>实际观察</span>
            <textarea
              ref={resultTextareaRef}
              rows={3}
              value={resultText}
              data-testid="attempt-result-text"
              onChange={(e) => setResultText(e.target.value)}
              placeholder="例如「500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁」"
            />
          </label>
          <div className="grid-2">
            <label className="field">
              <span>结果评价</span>
              <select value={outcome} data-testid="attempt-result-outcome" onChange={(e) => setOutcome(e.target.value as AttemptOutcome | '')}>
                <option value="">未填写</option>
                <option value="success">成功</option>
                <option value="failure">失败</option>
                <option value="undetermined">未判定</option>
              </select>
            </label>
            <label className="field">
              <span>发生时间（选填）</span>
              <input
                type="datetime-local"
                value={observedAt}
                onChange={(e) => setObservedAt(e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span>来源链接（选填）</span>
            <input
              type="url"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://…"
            />
          </label>
          {sourceUrl && (
            <p className="muted">
              安全链接：
              <a href={sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
                {sourceUrl}
              </a>
              （仅打开，不自动抓取）
            </p>
          )}
          <div className="row-actions">
            <button className="btn primary" type="submit" disabled={resultSaving} data-testid="attempt-save-result">
              {resultSaving ? '保存中…' : '保存结果'}
            </button>
            {resultNotice && <span className="save-ok" role="status">{resultNotice}</span>}
          </div>
          {conflict && (
            <div className="conflict-banner" role="alert">
              <p>版本冲突：其他窗口已更新这条尝试，你的输入仍保留。</p>
              <p className="muted">
                最新结果：{conflict.current.resultText || '（空）'} · 评价：
                {conflict.current.outcome ? OUTCOME_LABEL[conflict.current.outcome] : '（空）'}
              </p>
              <div className="row-actions">
                <button
                  className="btn small"
                  type="button"
                  onClick={() => {
                    setAttempt(conflict.current);
                    setResultText(conflict.current.resultText ?? '');
                    setOutcome(conflict.current.outcome ?? '');
                    setObservedAt(toDatetimeLocal(conflict.current.observedAt));
                    setSourceUrl(conflict.current.sourceUrl ?? '');
                    setConflict(null);
                  }}
                >
                  查看最新内容并采用
                </button>
                <button className="btn small" type="button" onClick={saveResult}>
                  重试保存（覆盖最新版）
                </button>
              </div>
            </div>
          )}
        </form>
        {error && <p className="error-msg" role="alert">{error}</p>}
      </section>

      <section className="section attempt-refs-out" aria-label="我参考了什么">
        <div className="section-head">
          <h3>我参考了什么 <span className="muted">({fromRefs.length})</span></h3>
          <button className="btn small" onClick={() => setPickerOpen(true)}>＋ 引用旧结果</button>
        </div>
        <p className="hint">这里列出这条尝试引用过的旧结果；下方文本是引用当时的快照，来源后来修改会单独提示。</p>
        {refNotice && (
          <p className="save-ok" role="status" data-testid="attempt-ref-notice">{refNotice}</p>
        )}
        {fromRefs.length === 0 ? (
          <p className="empty-state">这条尝试还没有引用旧结果。</p>
        ) : (
          <ul className="ref-list">
            {fromRefs.map((r) => (
              <li key={r.id} className="ref-card" data-testid="attempt-reference-out">
                <p className="ref-title">
                  参考了：
                  {r.source ? (
                    <Link to={`/attempt/${r.source.id}`}>{r.source.step}</Link>
                  ) : (
                    <span className="muted">（来源已删除）</span>
                  )}
                  {r.source?.updatedSinceSnapshot && (
                    <span className="badge warn">来源有更新</span>
                  )}
                </p>
                <p className="ref-snapshot">引用时的结果：{r.snapshotResultText || '（当时无结果）'}</p>
                {r.note && <p className="ref-note">这次准备怎么用：{r.note}</p>}
                {r.source && r.source.resultText !== r.snapshotResultText && (
                  <p className="muted">来源当前结果：{r.source.resultText || '（空）'}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section attempt-refs-in" aria-label="后来哪里用过这条结果">
        <h3>后来哪里用过这条结果 <span className="muted">({toRefs.length})</span></h3>
        <p className="hint">其他尝试后来引用了这条结果；可沿链接打开那些尝试，查看它们实际做了什么。</p>
        {toRefs.length === 0 ? (
          <p className="empty-state">还没有其他尝试引用这条结果。</p>
        ) : (
          <ul className="ref-list">
            {toRefs.map((r) => (
              <li key={r.id} className="ref-card" data-testid="attempt-reference-in">
                <p className="ref-title">
                  被
                  {r.referencing ? (
                    <Link to={`/attempt/${r.referencing.id}`}>{r.referencing.step}</Link>
                  ) : (
                    <span className="muted">（记录已删除）</span>
                  )}
                  引用
                </p>
                <p className="ref-snapshot">引用时的结果：{r.snapshotResultText || '（当时无结果）'}</p>
                {r.note && <p className="ref-note">用途：{r.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {pickerOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="引用已有结果">
          <div className="modal wide">
            <h3>引用已有结果</h3>
            {!picked ? (
              <>
                <form
                  className="search-bar"
                  onSubmit={(e) => {
                    e.preventDefault();
                    searchPick();
                  }}
                >
                  <input
                    type="search"
                    placeholder="搜索旧尝试或结果，如「闪烁」"
                    value={pickQuery}
                    onChange={(e) => setPickQuery(e.target.value)}
                    autoFocus
                  />
                  <button className="btn" type="submit" disabled={pickLoading}>
                    {pickLoading ? '搜索中…' : '搜索'}
                  </button>
                </form>
                <ul className="pick-list">
                  {pickResults.length === 0 && !pickQuery && !pickLoading && (
                    <li className="muted">
                      输入关键词（例如「闪烁」「频率」）搜索过去的尝试，选中一条后再确认引用。
                    </li>
                  )}
                  {pickResults.map((a) => (
                    <li key={a.id}>
                      <button className="pick-item" onClick={() => setPicked(a)}>
                        <span className="pick-step">{a.step}</span>
                        <span className="muted">{a.snippet || a.resultText || ''}</span>
                        <span className="badge">{STATE_LABEL[a.state]}</span>
                      </button>
                    </li>
                  ))}
                  {pickResults.length === 0 && pickQuery && !pickLoading && (
                    <li className="muted">没有找到可引用的尝试。</li>
                  )}
                </ul>
              </>
            ) : (
              <>
                <p>
                  将引用：<strong>{picked.step}</strong>
                </p>
                <p className="muted">结果：{picked.resultText || '（该尝试暂无结果）'}</p>
                <label className="field">
                  <span>这次准备怎么用（选填）</span>
                  <input
                    type="text"
                    value={refNote}
                    onChange={(e) => setRefNote(e.target.value)}
                    placeholder="例如「先按 2 kHz 继续验证」"
                  />
                </label>
                <div className="row-actions">
                  <button className="btn primary" onClick={submitReference} disabled={refSaving}>
                    {refSaving ? '引用中…' : '确认引用'}
                  </button>
                  <button className="btn" onClick={() => setPicked(null)}>返回搜索</button>
                </div>
              </>
            )}
            {refError && <p className="error-msg" role="alert">{refError}</p>}
            <div className="row-actions">
              <button className="btn" onClick={() => setPickerOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

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

      {futurePrompt && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="未来安排处理"
        >
          <div className="modal">
            <h3>这个尝试还有未来安排</h3>
            <p>
              把状态改为「{STATE_LABEL[futurePrompt.nextState]}」前，请选择如何处理下面这些未来安排。
              这个选择会随状态一起保存。
            </p>
            <ul className="future-schedule-list">
              {futurePrompt.futureSchedules.map((schedule) => (
                <li key={schedule.id}>
                  <span>{formatScheduleFullRange(schedule, timezone)}</span>
                  <span className="muted">{schedule.note || schedule.attempt?.step || ''}</span>
                </li>
              ))}
            </ul>
            <p className="hint">
              「保留安排」会保留日程，但尝试已经是结束/放弃状态；「取消这些安排」只取消日程，
              不会删除尝试或念头。
            </p>
            {futurePrompt.error && (
              <p className="error-msg" role="alert">
                {futurePrompt.error}
              </p>
            )}
            <div className="row-actions">
              <button
                type="button"
                className={`btn primary${futurePrompt.action === 'keep' ? ' is-chosen' : ''}`}
                data-testid="future-schedule-keep"
                disabled={futurePrompt.saving}
                aria-pressed={futurePrompt.action === 'keep'}
                onClick={() => void resolveFutureSchedules('keep')}
              >
                {futurePrompt.saving && futurePrompt.action === 'keep' ? '保存中…' : '保留安排'}
              </button>
              <button
                type="button"
                className={`btn danger${futurePrompt.action === 'cancel' ? ' is-chosen' : ''}`}
                data-testid="future-schedule-cancel"
                disabled={futurePrompt.saving}
                aria-pressed={futurePrompt.action === 'cancel'}
                onClick={() => void resolveFutureSchedules('cancel')}
              >
                {futurePrompt.saving && futurePrompt.action === 'cancel'
                  ? '取消中…'
                  : '取消这些安排'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={futurePrompt.saving}
                onClick={() => setFuturePrompt(null)}
              >
                先不改状态
              </button>
            </div>
          </div>
        </div>
      )}

      {deletePreview && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="删除尝试确认">
          <div className="modal">
            <h3>永久删除这条尝试记录？</h3>
            <p>此操作不可撤销。将同时删除：</p>
            <ul className="impact-list">
              <li>{deletePreview.scheduleCount ?? 0} 条日程安排（含已取消）</li>
              <li>{deletePreview.activeScheduleCount ?? 0} 条有效日程</li>
              <li>{deletePreview.referencesFromAttempts ?? 0} 条「这条尝试引用其他结果」的引用</li>
              <li>{deletePreview.referencesToAttempts ?? 0} 条「其他尝试引用这条结果」的引用</li>
            </ul>
            <p className="muted">所属念头和其他尝试会保留。</p>
            {deletePreview.affectedExperiences && deletePreview.affectedExperiences.length > 0 && (
              <div className="delete-affected">
                <h4>会受影响的经验</h4>
                <ul className="impact-list">
                  {deletePreview.affectedExperiences.map((impact) => (
                    <li key={impact.id}>
                      《{impact.title}》：{impact.deletedSourceCount} 条依据引用这次结果；
                      {impact.willClearUnderstanding
                        ? '模型整理的正文会保守清空并标记待修订。'
                        : '正文保留，标记为建议重新核对。'}
                    </li>
                  ))}
                </ul>
                <p className="hint">原始结果删除后，不会继续在界面、搜索或导出中展示它的正文。</p>
              </div>
            )}
            {deleteError && (
              <p className="error-msg" role="alert">
                {deleteError}
              </p>
            )}
            <div className="row-actions">
              <button
                type="button"
                className="btn danger"
                disabled={deleting}
                onClick={() => void confirmDeleteAttempt()}
              >
                {deleting ? '删除中…' : '确认删除记录'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={deleting}
                onClick={() => setDeletePreview(null)}
              >
                保留记录
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteError && !deletePreview && (
        <p className="error-msg" role="alert">
          {deleteError}
        </p>
      )}

      {experienceDraft && (
        <ExperienceEditor
          mode="create"
          draft={experienceDraft}
          onCancel={() => setExperienceDraft(null)}
          onSaved={(experience) => {
            setExperienceDraft(null);
            setExperienceSaved({ id: experience.id, title: experience.title });
          }}
        />
      )}
    </div>
  );
}