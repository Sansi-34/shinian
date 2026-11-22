// 拾念 V2 · 尝试详情（记结果、整理成经验、查看采用经验版本、手动引用旧结果与排日程）
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../api';
import type {
  Attempt,
  AttemptDeletePreview,
  Capture,
  ExperienceAttemptRef,
  ExperienceDraft,
  ExperiencePublic,
  ReferenceFrom,
  ReferenceTo,
  ScheduleBlock,
  SearchAttemptHit,
} from '../types';
import { readTopicNav, safeTopicReturnTo, topicAwareHref } from '../components/topicNav';
import ExperienceEditor from '../components/ExperienceEditor';
import { formatScheduleTimeRange, sortSchedules, timeInTimezone, todayDateKey, useDisplayTimezone } from '../scheduleTime';
import { dayTimeLabel, fromLocalInputValue, toLocalInputValue } from './format';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Row from './ui/Row';
import Pill, { type StatusKind } from './ui/Pill';
import Button from './ui/Button';
import DateField from './ui/DateField';
import Modal from './ui/Modal';
import Spinner from './ui/Spinner';
import HoldConfirm from './ui/HoldConfirm';
import Segment from './ui/Segment';
import CopyButton from './ui/CopyButton';
import './shared.css';

function errText(e: unknown, fallback: string) {
  const anyErr = e as { status?: number; body?: { error?: string; message?: string }; message?: string };
  if (anyErr?.status === 409 && anyErr?.body?.error === 'future_schedules') return '这个尝试还有未来安排，需要先决定保留还是取消。';
  if (anyErr?.status === 409) return '内容已被改动（版本冲突），已为你载入最新版本，请再保存一次。';
  if (anyErr?.body?.message) return anyErr.body.message;
  if (anyErr?.status === 401) return '登录状态已失效，请重新登录。';
  if (anyErr?.status === 0 || anyErr?.message === 'Failed to fetch') return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  return fallback;
}

const STATES: Array<{ value: Attempt['state']; label: string }> = [
  { value: 'todo', label: '未开始' },
  { value: 'in_progress', label: '进行中' },
  { value: 'done', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
];

const OUTCOMES: Array<{ value: 'success' | 'failure' | 'undetermined'; label: string }> = [
  { value: 'success', label: '达成' },
  { value: 'failure', label: '未达成' },
  { value: 'undetermined', label: '说不清' },
];

function statusOf(a: Attempt): { kind: StatusKind; label: string } {
  if (a.state === 'done') {
    if (!a.resultText?.trim()) return { kind: 'partial', label: '结果待记录' };
    if (a.outcome === 'success') return { kind: 'done', label: '已记录结果' };
    if (a.outcome === 'failure') return { kind: 'fail', label: '未达成' };
    return { kind: 'partial', label: '结果待判断' };
  }
  if (a.state === 'in_progress') return { kind: 'active', label: '进行中' };
  if (a.state === 'cancelled') return { kind: 'idle', label: '已取消' };
  return { kind: 'idle', label: '未开始' };
}

/** 会随「保存」一起提交的四个字段，用来做脏检查 */
type Draft = {
  state: Attempt['state'];
  result: string;
  outcome: 'success' | 'failure' | 'undetermined';
  observedAt: string;
};

/** 载入时的快照：result 取 trim 后的值，与保存时实际发送的值保持一致 */
function draftOf(a: Attempt, timezone: string): Draft {
  return {
    state: a.state,
    result: (a.resultText ?? '').trim(),
    outcome: (a.outcome as Draft['outcome']) ?? 'undetermined',
    observedAt: toLocalInputValue(a.observedAt, timezone),
  };
}

export default function AttemptV2Page() {
  const { attemptId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const topicNav = useMemo(() => readTopicNav(searchParams), [searchParams]);
  const returnTo = useMemo(
    () => safeTopicReturnTo(searchParams.get('returnTo')) ?? topicNav.returnTo,
    [searchParams, topicNav.returnTo]
  );
  const [timezone] = useDisplayTimezone();

  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [experienceRef, setExperienceRef] = useState<ExperienceAttemptRef | null>(null);
  const [schedules, setSchedules] = useState<ScheduleBlock[]>([]);
  const [fromRefs, setFromRefs] = useState<ReferenceFrom[]>([]);
  const [toRefs, setToRefs] = useState<ReferenceTo[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [result, setResult] = useState('');
  const [outcome, setOutcome] = useState<'success' | 'failure' | 'undetermined'>('undetermined');
  const [state, setState] = useState<Attempt['state']>('todo');
  const [observedAt, setObservedAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [scheduleConflict, setScheduleConflict] = useState<ScheduleBlock[] | null>(null);
  const [scheduleModal, setScheduleModal] = useState(false);
  const [schedStart, setSchedStart] = useState('');
  const [schedEnd, setSchedEnd] = useState('09:30');
  /** hh:mm 加分钟，用于默认结束时间与自动纠正 */
  function plusMinutes(hhmm: string, minutes: number): string {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
    if (!m) return hhmm;
    const total = Math.min(23 * 60 + 59, Number(m[1]) * 60 + Number(m[2]) + minutes);
    return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
  }
  const [schedNote, setSchedNote] = useState('');
  const [schedOverlap, setSchedOverlap] = useState<{ token: string; ids: string[] } | null>(null);
  const [deleteModal, setDeleteModal] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  // 整理成经验（无 AI 也可直接走通）
  const [expDraftLoading, setExpDraftLoading] = useState(false);
  const [expDraft, setExpDraft] = useState<ExperienceDraft | null>(null);
  const [createdExperience, setCreatedExperience] = useState<ExperiencePublic | null>(null);
  // 手动引用旧尝试结果
  const [refModal, setRefModal] = useState(false);
  const [refQuery, setRefQuery] = useState('');
  const [refNote, setRefNote] = useState('');
  const [refCandidates, setRefCandidates] = useState<SearchAttemptHit[]>([]);
  const [refSearching, setRefSearching] = useState(false);
  // 产品模型允许「已完成但未填结果」（导出里会明确标注），所以这里只是二次确认，不是硬拦
  const [doneWithoutResult, setDoneWithoutResult] = useState(false);
  // 同一弹窗会话复用同一个 operationId：服务端冲突 token 把它算进签名，换 id 会永远对不上
  const [schedOpId, setSchedOpId] = useState('');
  const [delPreview, setDelPreview] = useState<AttemptDeletePreview | null>(null);
  // 脏检查基准：载入（或保存成功）时的草稿快照。为 null 表示还没有可信基准，
  // 此时一律当作「没有改动」，避免刚进页面就报「修改未保存」。
  const [snapshot, setSnapshot] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    if (!attemptId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getAttempt(attemptId);
      setAttempt(res.attempt);
      setCapture(res.capture ?? null);
      setExperienceRef(res.experienceRef ?? null);
      setResult(res.attempt.resultText ?? '');
      setOutcome((res.attempt.outcome as 'success' | 'failure' | 'undetermined') ?? 'undetermined');
      setState(res.attempt.state);
      setObservedAt(toLocalInputValue(res.attempt.observedAt, timezone));
      setVersionConflict(false);
      // 表单值和快照同时从同一个响应写入，保证「刚载入」必然是不脏的
      setSnapshot(draftOf(res.attempt, timezone));
      const [sch, refs] = await Promise.all([
        api.listAttemptSchedules(attemptId).catch(() => ({ schedules: [] as ScheduleBlock[], serverNow: Date.now() })),
        api.listReferences(attemptId).catch(() => ({ fromRefs: [] as ReferenceFrom[], toRefs: [] as ReferenceTo[] })),
      ]);
      setSchedules(sortSchedules(sch.schedules ?? []));
      setFromRefs(refs.fromRefs ?? []);
      setToRefs(refs.toRefs ?? []);
    } catch (e) {
      setError(errText(e, '尝试加载失败，请重试。'));
    } finally {
      setLoading(false);
    }
  }, [attemptId, timezone]);

  useEffect(() => {
    setBusy(false);
    setActionError(null);
    setVersionConflict(false);
    setSavedAt(null);
    setScheduleConflict(null);
    setScheduleModal(false);
    setSchedStart('');
    setSchedNote('');
    setSchedOverlap(null);
    setDeleteModal(false);
    setRefModal(false);
    setExpDraft(null);
    setCreatedExperience(null);
    setModalError(null);
    setDoneWithoutResult(false);
    setSnapshot(null);
    void load();
  }, [load]);

  // 锚点跳转（例如从下一步行动页点「去记录结果」跳到 #result-section）
  useEffect(() => {
    if (!loading && location.hash === '#result-section') {
      document.getElementById('result-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [loading, location.hash]);

  async function openExperienceDraft() {
    if (!attempt || expDraftLoading) return;
    setExpDraftLoading(true);
    setActionError(null);
    try {
      const res = await api.getAttemptExperienceDraft(attempt.id);
      setExpDraft(res.draft);
    } catch (e) {
      setActionError(errText(e, '暂时不能整理成经验，请确认已保存结果。'));
    } finally {
      setExpDraftLoading(false);
    }
  }

  async function searchRefCandidates(q: string) {
    setRefQuery(q);
    setModalError(null);
    const term = q.trim();
    if (!term) {
      setRefCandidates([]);
      return;
    }
    setRefSearching(true);
    try {
      const res = await api.search(term);
      setRefCandidates(
        (res.attempts ?? []).filter((a) => a.id !== attemptId && Boolean(a.resultText?.trim()))
      );
    } catch (e) {
      setModalError(errText(e, '检索旧结果失败，请重试。'));
    } finally {
      setRefSearching(false);
    }
  }

  async function addReference(toId: string) {
    if (!attempt || busy) return;
    setBusy(true);
    setModalError(null);
    try {
      await api.createReference(attempt.id, {
        toId,
        note: refNote.trim() || undefined,
        operationId: 'v2ref-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      });
      setRefModal(false);
      setRefQuery('');
      setRefNote('');
      setRefCandidates([]);
      await load();
    } catch (e) {
      setModalError(errText(e, '添加引用失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function removeReference(refId: string) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteReference(refId);
      await load();
    } catch (e) {
      setActionError(errText(e, '解除引用失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function save(futureScheduleAction?: 'keep' | 'cancel') {
    if (!attempt || busy) return;
    if (state === 'done' && !result.trim() && !doneWithoutResult) {
      setDoneWithoutResult(true);
      setActionError('还没写结果。仍然可以完成，但阶段回顾与导出会记为「已完成但未填结果」。再点一次「仍然标记完成」即可保存。');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const patch: Parameters<typeof api.updateAttempt>[1] = {
        state,
        resultText: result.trim() || null,
        outcome: state === 'done' ? outcome : null,
        observedAt: fromLocalInputValue(observedAt, timezone),
        revision: attempt.revision,
      };
      if (futureScheduleAction) patch.futureScheduleAction = futureScheduleAction;
      const res = await api.updateAttempt(attempt.id, patch);
      // 服务端回写的就是新的基准：表单与快照从同一份数据更新，保存完立刻不脏
      const saved = draftOf(res.attempt, timezone);
      setAttempt(res.attempt);
      setResult(res.attempt.resultText ?? '');
      setState(saved.state);
      setOutcome(saved.outcome);
      setObservedAt(saved.observedAt);
      setSnapshot(saved);
      setScheduleConflict(null);
      setDoneWithoutResult(false);
      setSavedAt(Date.now());
      // 取消过未来日程就刷新右栏
      if (futureScheduleAction === 'cancel') await load();
    } catch (e) {
      const anyErr = e as { status?: number; body?: { error?: string; futureSchedules?: ScheduleBlock[] } };
      if (anyErr?.status === 409 && anyErr?.body?.error === 'future_schedules') {
        // 服务端要求先决定：保留还是取消未来安排。不重载页面，保住用户已输入的结果。
        setScheduleConflict(anyErr.body.futureSchedules ?? []);
        setActionError(null);
      } else if (anyErr?.status === 409) {
        // 版本冲突时绝不覆盖用户草稿：保留输入并提示手动载入最新版
        setVersionConflict(true);
        setActionError('内容已在其他地方被修改，你刚刚输入的内容仍保留在输入框中。请先复制或点「载入最新版本」后再保存。');
      } else {
        setActionError(errText(e, '保存失败，你输入的内容仍然保留，请重试。'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function addSchedule(confirmOverlap = false) {
    if (!attempt) return;
    if (!schedStart) {
      setModalError('先选日期和开始时间。');
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(schedEnd)) {
      setModalError('结束时间要写成 HH:mm，例如 09:30。');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api.createSchedule(attempt.id, {
        date: schedStart.slice(0, 10),
        startTime: schedStart.slice(11, 16),
        endTime: schedEnd,
        timezone,
        note: schedNote.trim() || null,
        operationId: schedOpId,
        ...(confirmOverlap && schedOverlap
          ? { confirmOverlap: true, conflictToken: schedOverlap.token, expectedConflictIds: schedOverlap.ids }
          : {}),
      });
      setScheduleModal(false);
      setSchedNote('');
      setSchedOverlap(null);
      setSchedOpId('');
      await load();
    } catch (e) {
      const anyErr = e as { status?: number; body?: { error?: string; conflictToken?: string; conflicts?: Array<{ id: string }> } };
      if (anyErr?.status === 409 && (anyErr.body?.error ?? '').startsWith('schedule_conflict')) {
        setSchedOverlap({ token: anyErr.body?.conflictToken ?? '', ids: (anyErr.body?.conflicts ?? []).map((c) => c.id) });
      } else {
        setModalError(errText(e, '排日程失败，请重试。'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancelScheduleById(id: string, revision: number) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.cancelSchedule(id, revision);
      await load();
    } catch (e) {
      setActionError(errText(e, '取消日程失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function openDeleteModal() {
    setScheduleModal(false);
    setDeleteModal(true);
    setModalError(null);
    setDelPreview(null);
    try {
      setDelPreview(await api.getAttemptDeletePreview(attemptId));
    } catch (e) {
      setModalError(errText(e, '删除预览加载失败。'));
    }
  }

  async function confirmDelete() {
    setBusy(true);
    setModalError(null);
    try {
      await api.deleteAttempt(attemptId);
      setDeleteModal(false);
      navigate(capture ? '/capture/' + capture.id : '/');
    } catch (e) {
      setModalError(errText(e, '删除失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  const st = useMemo(() => (attempt ? statusOf(attempt) : { kind: 'idle' as StatusKind, label: '—' }), [attempt]);

  // 脏检查：当前表单值 vs 载入/上次保存时的快照
  const isDirty = useMemo(() => {
    if (!snapshot) return false;
    return (
      state !== snapshot.state ||
      result.trim() !== snapshot.result ||
      outcome !== snapshot.outcome ||
      observedAt !== snapshot.observedAt
    );
  }, [snapshot, state, result, outcome, observedAt]);

  // 没有改动时不允许保存：空点一次会把 revision 顶上去，产生无意义版本
  const canSave = isDirty || doneWithoutResult;

  const saveLabel = isDirty
    ? '修改未保存'
    : savedAt
      ? '已保存 ' + timeInTimezone(savedAt, timezone)
      : '无改动';

  /** 还原：回到快照（没有快照时退回服务端最近一次的值） */
  function revertDraft() {
    if (snapshot) {
      setState(snapshot.state);
      setOutcome(snapshot.outcome);
      setResult(snapshot.result);
      setObservedAt(snapshot.observedAt);
    } else if (attempt) {
      const base = draftOf(attempt, timezone);
      setState(base.state);
      setOutcome(base.outcome);
      setResult(base.result);
      setObservedAt(base.observedAt);
    }
    // 回到干净状态时把「仍然标记完成」的二次确认也一并撤掉
    setDoneWithoutResult(false);
    setActionError(null);
  }

  return (
    <V2Shell
      rightTitle="关联"
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">所属念头</h3>
            {capture ? (
              <Link to={topicAwareHref('/capture/' + capture.id, topicNav)} className="v2-groupItem">
                {capture.rawText.slice(0, 22)}
                <span>→</span>
              </Link>
            ) : (
              <p className="v2-groupNote">没有关联念头。</p>
            )}
          </div>

          {experienceRef && (
            <div data-testid="attempt-experience-ref">
              <h3 className="v2-groupTitle">采用的经验</h3>
              {experienceRef.deleted || !experienceRef.exists ? (
                <p className="v2-groupNote">
                  采用自「{experienceRef.adoptedTitle}」（第 {experienceRef.adoptedVersion} 版，原经验已删除）。
                </p>
              ) : (
                <>
                  <Link
                    to={topicAwareHref('/experience/' + experienceRef.experienceId, topicNav)}
                    className="v2-groupItem"
                    title={experienceRef.adoptedTitle}
                  >
                    {experienceRef.adoptedTitle}
                    <span>→</span>
                  </Link>
                  <p className="v2-groupNote">
                    本次采用第 {experienceRef.adoptedVersion} 版
                    {experienceRef.changed && experienceRef.currentVersion != null
                      ? `（该经验已修订至第 ${experienceRef.currentVersion} 版）`
                      : '（与当前版本一致）'}
                    {experienceRef.archived ? ' · 已归档' : ''}
                  </p>
                </>
              )}
            </div>
          )}

          <div>
            <h3 className="v2-groupTitle">引用关系</h3>
            <div className="v2-groupItem">
              引用了旧结果
              <span>{fromRefs.length}</span>
            </div>
            {fromRefs.map((ref) => (
              <div key={ref.id} className="v2-groupItem" style={{ alignItems: 'flex-start' }}>
                {ref.source ? (
                  <Link to={topicAwareHref('/attempt/' + ref.source.id, topicNav)} title={ref.source.step}>
                    {ref.source.step}
                    {ref.source.updatedSinceSnapshot ? ' · 来源已更新' : ''}
                  </Link>
                ) : (
                  <span className="v2-groupNote">（来源已删除）</span>
                )}
                <button
                  type="button"
                  className="v2-miniBtn"
                  onClick={() => void removeReference(ref.id)}
                  disabled={busy}
                >
                  解除
                </button>
              </div>
            ))}
            <div className="v2-groupItem">
              被后续尝试引用
              <span>{toRefs.length}</span>
            </div>
            {toRefs.map((ref) => (
              <div key={ref.id} className="v2-groupItem">
                {ref.referencing ? (
                  <Link to={topicAwareHref('/attempt/' + ref.referencing.id, topicNav)} title={ref.referencing.step}>
                    {ref.referencing.step}
                  </Link>
                ) : (
                  <span className="v2-groupNote">（引用方已不在）</span>
                )}
                <span>→</span>
              </div>
            ))}
            <div className="v2-sideActions">
              <button
                type="button"
                className="v2-sideAction"
                onClick={() => {
                  setRefModal(true);
                  setModalError(null);
                  setRefQuery('');
                  setRefNote('');
                  setRefCandidates([]);
                }}
              >
                <span>+ 引用一条旧结果</span>
              </button>
            </div>
          </div>
          <div>
            <h3 className="v2-groupTitle">日程</h3>
            {schedules.length === 0 && <p className="v2-groupNote">没有排过时间。</p>}
            {schedules.map((s) => (
              <div key={s.id} className="v2-groupItem">
                <span className="v2-date">{formatScheduleTimeRange(s, timezone)}</span>
                {s.status === 'cancelled' ? (
                  <span>已取消</span>
                ) : (
                  <button
                    type="button"
                    className="v2-miniBtn"
                    onClick={() => void cancelScheduleById(s.id, s.revision)}
                    disabled={busy}
                  >
                    取消
                  </button>
                )}
              </div>
            ))}
            <div className="v2-sideActions">
              <button
                type="button"
                className="v2-sideAction"
                onClick={() => {
                  setScheduleModal(true);
                  setSchedOverlap(null);
                  setModalError(null);
                  setSchedOpId('v2sch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
                  // 使用显示时区的今天与当前时刻，不用 UTC toISOString()，避免跨时区错一天
                  const now = Date.now();
                  const start = schedStart || `${todayDateKey(timezone, now)}T${timeInTimezone(now, timezone)}`;
                  if (!schedStart) setSchedStart(start);
                  setSchedEnd(plusMinutes(start.slice(11, 16), 30));
                }}
              >
                <span>+ 排日程</span>
              </button>
            </div>
          </div>
        </>
      }
      statusLeft={attempt ? `${st.label} · 版本 ${attempt.revision}` : '加载中'}
      statusRight={
        <span
          style={{
            fontSize: 'var(--fs-meta)',
            color: isDirty ? 'var(--ink)' : 'var(--ink-3)',
          }}
        >
          {saveLabel}
        </span>
      }
    >
      {loading && <p className="v2-state"><Spinner /></p>}
      {!loading && error && (
        <p className="v2-state">
          {error}
          <button type="button" className="v2-linkBtn" onClick={() => void load()}>
            重试
          </button>
        </p>
      )}

      {attempt && (
        <>
          {returnTo && (
            <div className="v2-returnBar">
              <Link to={returnTo} className="v2-returnLink">
                ← {topicNav.fromTopic ? '返回主题' : '返回刚才阅读的位置'}
              </Link>
            </div>
          )}

          <div className="v2-captureHead">
            <p className="v2-captureText">{attempt.step}</p>
            <div className="v2-captureActions">
              <Pill kind={st.kind}>{st.label}</Pill>
              {attempt.resultText?.trim() && (
                <Button
                  variant="primary"
                  onClick={() => void openExperienceDraft()}
                  disabled={expDraftLoading || busy}
                  data-testid="attempt-to-experience"
                >
                  {expDraftLoading ? '准备中…' : '整理成经验'}
                </Button>
              )}
              {attempt.resultText && <CopyButton text={attempt.resultText} label="复制结果" />}
              {attempt.actionDescription && <span className="v2-hint">{attempt.actionDescription}</span>}
              {attempt.estimatedMinutes ? <span className="v2-hint">预计 {attempt.estimatedMinutes} 分钟</span> : null}
              {/* 破坏性操作：单独推到最右，用危险色描边，避免和普通动作混成一排误点 */}
              <Button
                onClick={() => void openDeleteModal()}
                disabled={busy}
                title="删除这个尝试（不可恢复）"
                style={{
                  marginLeft: 'auto',
                  color: 'var(--st-fail)',
                  borderColor: 'var(--st-fail)',
                }}
              >
                删除…
              </Button>
            </div>
            {experienceRef && (
              <div className="v2-expRefBanner" data-testid="attempt-experience-version">
                <span>
                  采用经验：
                  {experienceRef.exists && !experienceRef.deleted ? (
                    <Link
                      to={topicAwareHref('/experience/' + experienceRef.experienceId, topicNav)}
                      style={{ color: 'var(--accent)', fontWeight: 500, textDecoration: 'none' }}
                    >
                      {experienceRef.adoptedTitle}
                    </Link>
                  ) : (
                    <strong>{experienceRef.adoptedTitle}</strong>
                  )}
                  {' · '}
                  <strong>采用时为第 {experienceRef.adoptedVersion} 版</strong>
                  {experienceRef.changed && experienceRef.currentVersion != null
                    ? `（现已修订至第 ${experienceRef.currentVersion} 版）`
                    : ''}
                  {experienceRef.deleted ? '（原经验已删除）' : ''}
                </span>
                {experienceRef.adoptedUnderstanding && (
                  <p className="v2-groupNote" style={{ marginTop: 4 }}>
                    当时采用的理解快照：{experienceRef.adoptedUnderstanding}
                  </p>
                )}
              </div>
            )}
            {createdExperience && (
              <p className="v2-state" style={{ paddingLeft: 0, color: 'var(--st-done)' }} role="status">
                已整理为经验「{createdExperience.title}」
                <Link
                  to={topicAwareHref('/experience/' + createdExperience.id, topicNav)}
                  className="v2-linkBtn"
                >
                  打开经验详情 →
                </Link>
              </p>
            )}
            {actionError && !scheduleConflict && (
              <p className="v2-state" style={{ color: 'var(--st-fail)', paddingLeft: 0 }}>
                {actionError}
                {versionConflict && (
                  <button type="button" className="v2-linkBtn" onClick={() => void load()}>
                    载入最新版本
                  </button>
                )}
              </p>
            )}
          </div>

          <div id="result-section">
          <Module title="记录结果" count={attempt.resultText ? 1 : 0}>
            <div className="v2-form">
              <label className="v2-field">
                <span className="v2-fieldLabel">状态</span>
                <Segment
                  ariaLabel="尝试状态"
                  items={STATES}
                  value={state}
                  onChange={(next) => {
                    setState(next);
                    if (next !== 'done' && doneWithoutResult) {
                      setDoneWithoutResult(false);
                      setActionError(null);
                    }
                  }}
                />
              </label>

              <label className="v2-field">
                <span className="v2-fieldLabel">结果（只由你填写）</span>
                <textarea
                  className="v2-editor"
                  maxLength={4000}
                  value={result}
                  onChange={(e) => {
                    const next = e.target.value;
                    setResult(next);
                    if (next.trim() && doneWithoutResult) {
                      setDoneWithoutResult(false);
                      setActionError(null);
                    }
                  }}
                  placeholder="实际发生了什么？条件是什么？有没有对照？"
                  aria-label="结果文本"
                />
              </label>

              {state === 'done' && (
                <label className="v2-field">
                  <span className="v2-fieldLabel">评价</span>
                  <Segment ariaLabel="结果评价" items={OUTCOMES} value={outcome} onChange={setOutcome} />
                </label>
              )}

              <div className="v2-field">
                <span className="v2-fieldLabel">发生时间（可留空 · 按 {timezone} 记录）</span>
                <DateField value={observedAt} onChange={setObservedAt} timezone={timezone} label="发生时间" />
                {observedAt && (
                  <span className="v2-hint">将记录为 {dayTimeLabel(fromLocalInputValue(observedAt, timezone) ?? 0, timezone)}</span>
                )}
              </div>

              {scheduleConflict && (
                <div className="v2-conflict" role="alert" data-testid="attempt-future-schedules">
                  <p className="v2-conflictTitle">
                    这个尝试还有 {scheduleConflict.length} 条未来安排，要先决定它们的去留才能标记完成：
                  </p>
                  <ul className="v2-conflictList">
                    {scheduleConflict.map((s) => (
                      <li key={s.id}>{formatScheduleTimeRange(s, timezone)}</li>
                    ))}
                  </ul>
                  <div className="v2-captureActions">
                    <Button variant="primary" onClick={() => void save('cancel')} disabled={busy}>
                      取消这些安排并保存
                    </Button>
                    <Button onClick={() => void save('keep')} disabled={busy}>
                      保留安排并保存
                    </Button>
                    <Button onClick={() => setScheduleConflict(null)} disabled={busy}>
                      先不保存
                    </Button>
                  </div>
                </div>
              )}

              <div className="v2-field">
                <div className="v2-captureActions">
                  <Button
                    variant="primary"
                    onClick={() => void save()}
                    disabled={busy || !canSave}
                    title={canSave ? undefined : '没有改动，无需保存'}
                  >
                    {busy ? '保存中…' : doneWithoutResult ? '仍然标记完成' : '保存'}
                  </Button>
                  <Button onClick={revertDraft} disabled={busy || !isDirty}>
                    还原
                  </Button>
                </div>
                <p className="v2-hint" style={{ margin: 0 }}>
                  保存后用于阶段回顾统计，不会被自动改写
                </p>
              </div>
            </div>
          </Module>
          </div>

          {fromRefs.length > 0 && (
            <Module title="引用的旧结果" count={fromRefs.length}>
              {fromRefs.map((ref, i) => (
                <Row
                  key={ref.id}
                  index={i}
                  time={ref.source?.updatedSinceSnapshot ? '已更新' : '引用'}
                  to={ref.source ? topicAwareHref('/attempt/' + ref.source.id, topicNav) : '#'}
                  title={ref.source?.step ?? '（原尝试已删除）'}
                  sub={
                    [
                      ref.snapshotResultText ? `引用时结果：${ref.snapshotResultText.slice(0, 70)}` : null,
                      ref.note ? `复用说明：${ref.note}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '打开查看原文'
                  }
                  side={<span className="v2-hint" aria-hidden="true">→</span>}
                />
              ))}
            </Module>
          )}

          {/* 这个模块里只有「它属于哪个念头」这一条链接，不列其它尝试：
              标题不能写成「其他尝试 N」，也不给 count（硬编码 0 会让人以为一条都没有） */}
          {capture && (
            <Module title="来源念头" defaultOpen={false}>
              <Row
                index={0}
                time="念头"
                to={topicAwareHref('/capture/' + capture.id, topicNav)}
                title={capture.rawText}
                sub="打开念头详情，看这个念头下的全部尝试"
                side={
                  <span className="v2-hint" aria-hidden="true">
                    →
                  </span>
                }
              />
            </Module>
          )}
        </>
      )}

      <Modal
        open={scheduleModal}
        title="给这个尝试排一段时间"
        onClose={() => setScheduleModal(false)}
        footer={
          <>
            <Button onClick={() => setScheduleModal(false)}>取消</Button>
            {schedOverlap ? (
              <Button variant="primary" onClick={() => void addSchedule(true)} disabled={busy || (!!schedStart && schedEnd <= schedStart.slice(11, 16))}>
                仍然保存
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void addSchedule(false)}
                disabled={busy || (!!schedStart && schedEnd <= schedStart.slice(11, 16))}
              >
                {busy ? '保存中…' : '保存'}
              </Button>
            )}
          </>
        }
      >
        <div className="v2-field">
          <span className="v2-fieldLabel">开始（按 {timezone}）</span>
          <DateField
            value={schedStart}
            onChange={(next) => {
              setSchedStart(next);
              setSchedOverlap(null);
              setModalError(null);
              // 结束早于开始就顺手往后推半小时，不让人先撞一次 400
              if (next && schedEnd <= next.slice(11, 16)) setSchedEnd(plusMinutes(next.slice(11, 16), 30));
            }}
            timezone={timezone}
            label="开始时间"
          />
        </div>
        <div className="v2-field">
          <span className="v2-fieldLabel">结束时间 HH:mm</span>
          <input
            className="v2-input"
            value={schedEnd}
            onChange={(e) => {
              setSchedEnd(e.target.value);
              setSchedOverlap(null);
              setModalError(null);
            }}
            placeholder="09:30"
            aria-label="结束时间"
          />
        </div>
        <div className="v2-field">
          <span className="v2-fieldLabel">备注（可留空）</span>
          <input
            className="v2-input"
            style={{ maxWidth: 'none', width: '100%' }}
            value={schedNote}
            onChange={(e) => {
              setSchedNote(e.target.value);
              setSchedOverlap(null);
              setModalError(null);
            }}
            placeholder="晚上做一次对比"
            aria-label="备注"
            maxLength={300}
          />
        </div>
        {!!schedStart && schedEnd <= schedStart.slice(11, 16) && (
          <p className="v2-groupNote" style={{ color: 'var(--st-fail)' }}>
            结束时间要晚于开始时间（现在填的是 {schedStart.slice(11, 16)} → {schedEnd}）。
          </p>
        )}
        {modalError && (
          <p className="v2-groupNote" style={{ color: 'var(--st-fail)' }}>
            {modalError}
          </p>
        )}
        {schedOverlap && (
          <p className="v2-groupNote" style={{ color: 'var(--st-partial)' }}>
            这段时间和已有 {schedOverlap.ids.length} 条安排重叠。可以改时间，也可以点「仍然保存」。
          </p>
        )}
      </Modal>

      <Modal
        open={deleteModal}
        title="删除这个尝试？"
        onClose={() => setDeleteModal(false)}
        footer={
          <>
            <Button onClick={() => setDeleteModal(false)}>取消</Button>
            <HoldConfirm label={busy ? '删除中…' : '按住确认删除'} onConfirm={() => void confirmDelete()} disabled={busy} />
          </>
        }
      >
        {modalError && (
          <p className="v2-groupNote" style={{ color: 'var(--st-fail)' }}>
            {modalError}
          </p>
        )}
        <p>删除后不可恢复。以下内容会一起处理：</p>
        <ul className="v2-conflictList">
          <li>日程 {delPreview?.scheduleCount ?? '…'} 条（其中有效 {delPreview?.activeScheduleCount ?? '…'} 条）</li>
          <li>引用关系 {delPreview ? delPreview.referencesFromAttempts + delPreview.referencesToAttempts : '…'} 条</li>
        </ul>
        {(delPreview?.affectedExperiences?.length ?? 0) > 0 && (
          <p className="v2-groupNote">
            有 {delPreview?.affectedExperiences?.length} 份经验把它当依据：会清除依据正文快照并标记待修订，经验本身保留。
          </p>
        )}
      </Modal>

      <Modal
        open={refModal}
        title="引用一条旧尝试的结果"
        onClose={() => setRefModal(false)}
        width={560}
      >
        <input
          className="v2-input"
          style={{ maxWidth: 'none', width: '100%' }}
          value={refQuery}
          onChange={(e) => void searchRefCandidates(e.target.value)}
          placeholder="输入关键词搜之前有结果的尝试（如：快门、调光）"
          aria-label="搜索旧结果"
        />
        <input
          className="v2-input"
          style={{ maxWidth: 'none', width: '100%' }}
          value={refNote}
          onChange={(e) => setRefNote(e.target.value)}
          placeholder="复用说明（可选，例如：换成自然光复测）"
          aria-label="复用说明"
          maxLength={300}
        />
        {modalError && (
          <p className="v2-groupNote" style={{ color: 'var(--st-fail)' }}>
            {modalError}
          </p>
        )}
        {refSearching && <Spinner label="搜索中…" />}
        {!refSearching && refQuery.trim() && refCandidates.length === 0 && (
          <p className="v2-groupNote">没有找到带结果的匹配尝试，换个关键词试试。</p>
        )}
        {refCandidates.map((cand) => {
          const already = fromRefs.some((r) => r.toAttemptId === cand.id);
          return (
            <div key={cand.id} className="v2-candRow">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="v2-candText">{cand.step}</div>
                {cand.resultText && (
                  <p className="v2-groupNote" style={{ marginTop: 2 }}>
                    结果：{cand.resultText.slice(0, 80)}
                  </p>
                )}
              </div>
              <Button onClick={() => void addReference(cand.id)} disabled={busy || already}>
                {already ? '已引用' : '引用'}
              </Button>
            </div>
          );
        })}
      </Modal>

      {expDraft && (
        <ExperienceEditor
          mode="create"
          draft={expDraft}
          onCancel={() => setExpDraft(null)}
          onSaved={(savedExp) => {
            setExpDraft(null);
            setCreatedExperience(savedExp);
          }}
        />
      )}
    </V2Shell>
  );
}
