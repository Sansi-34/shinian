// 拾念 V2 · 尝试详情（记结果是这个产品最高频的动作）
// 内联：改状态、记录结果（结果文本 / 评价 / 发生时间）；引用与日程只读展示；
// 删除、经验采用、AI 相关仍在旧页。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api';
import type { Attempt, AttemptDeletePreview, Capture, ScheduleBlock } from '../types';
import { formatScheduleTimeRange, sortSchedules, useDisplayTimezone } from '../scheduleTime';
import { dayTimeLabel, fromLocalInputValue, toLocalInputValue } from './format';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Row from './ui/Row';
import Pill, { type StatusKind } from './ui/Pill';
import Button from './ui/Button';
import DateField from './ui/DateField';
import Modal from './ui/Modal';
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
    if (a.outcome === 'success') return { kind: 'done', label: '已记录结果' };
    if (a.outcome === 'failure') return { kind: 'fail', label: '未达成' };
    return { kind: 'partial', label: '结果待判断' };
  }
  if (a.state === 'in_progress') return { kind: 'active', label: '进行中' };
  if (a.state === 'cancelled') return { kind: 'idle', label: '已取消' };
  return { kind: 'idle', label: '未开始' };
}

export default function AttemptV2Page() {
  const { attemptId = '' } = useParams();
  const navigate = useNavigate();
  const [timezone] = useDisplayTimezone();

  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [schedules, setSchedules] = useState<ScheduleBlock[]>([]);
  const [refCounts, setRefCounts] = useState({ from: 0, to: 0 });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [result, setResult] = useState('');
  const [outcome, setOutcome] = useState<'success' | 'failure' | 'undetermined'>('undetermined');
  const [state, setState] = useState<Attempt['state']>('todo');
  const [observedAt, setObservedAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [scheduleConflict, setScheduleConflict] = useState<ScheduleBlock[] | null>(null);
  const [scheduleModal, setScheduleModal] = useState(false);
  const [schedStart, setSchedStart] = useState('');
  const [schedEnd, setSchedEnd] = useState('09:30');
  const [schedNote, setSchedNote] = useState('');
  const [schedOverlap, setSchedOverlap] = useState<{ token: string; ids: string[] } | null>(null);
  const [deleteModal, setDeleteModal] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  // 同一弹窗会话复用同一个 operationId：服务端冲突 token 把它算进签名，换 id 会永远对不上
  const [schedOpId, setSchedOpId] = useState('');
  const [delPreview, setDelPreview] = useState<AttemptDeletePreview | null>(null);

  const load = useCallback(async () => {
    if (!attemptId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getAttempt(attemptId);
      setAttempt(res.attempt);
      setCapture(res.capture ?? null);
      setResult(res.attempt.resultText ?? '');
      setOutcome((res.attempt.outcome as 'success' | 'failure' | 'undetermined') ?? 'undetermined');
      setState(res.attempt.state);
      setObservedAt(toLocalInputValue(res.attempt.observedAt, timezone));
      const [sch, refs] = await Promise.all([
        api.listAttemptSchedules(attemptId).catch(() => ({ schedules: [] as ScheduleBlock[], serverNow: Date.now() })),
        api.listReferences(attemptId).catch(() => ({ fromRefs: [], toRefs: [] })),
      ]);
      setSchedules(sortSchedules(sch.schedules ?? []));
      setRefCounts({ from: refs.fromRefs?.length ?? 0, to: refs.toRefs?.length ?? 0 });
    } catch (e) {
      setError(errText(e, '尝试加载失败，请重试。'));
    } finally {
      setLoading(false);
    }
  }, [attemptId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(futureScheduleAction?: 'keep' | 'cancel') {
    if (!attempt || busy) return;
    if (state === 'done' && !result.trim()) {
      setActionError('标记完成时需要写下结果。结果只能由你填。');
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
      setAttempt(res.attempt);
      setResult(res.attempt.resultText ?? '');
      setScheduleConflict(null);
      setSavedAt(Date.now());
      // 取消过未来日程就刷新右栏
      if (futureScheduleAction === 'cancel') await load();
    } catch (e) {
      const anyErr = e as { status?: number; body?: { error?: string; futureSchedules?: ScheduleBlock[] } };
      if (anyErr?.status === 409 && anyErr?.body?.error === 'future_schedules') {
        // 服务端要求先决定：保留还是取消未来安排。不重载页面，保住用户已输入的结果。
        setScheduleConflict(anyErr.body.futureSchedules ?? []);
        setActionError(null);
      } else {
        setActionError(errText(e, '保存失败，请重试。'));
        if (anyErr?.status === 409) await load();
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
      setActionError(errText(e, '删除预览加载失败。'));
    }
  }

  async function confirmDelete() {
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteAttempt(attemptId);
      setDeleteModal(false);
      navigate(capture ? '/capture/' + capture.id : '/');
    } catch (e) {
      setActionError(errText(e, '删除失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  const st = useMemo(() => (attempt ? statusOf(attempt) : { kind: 'idle' as StatusKind, label: '—' }), [attempt]);

  return (
    <V2Shell
      rightTitle="关联"
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">所属念头</h3>
            {capture ? (
              <Link to={'/capture/' + capture.id} className="v2-groupItem">
                {capture.rawText.slice(0, 20)}
                <span>→</span>
              </Link>
            ) : (
              <p className="v2-groupNote">没有关联念头。</p>
            )}
          </div>
          <div>
            <h3 className="v2-groupTitle">引用关系</h3>
            <div className="v2-groupItem">
              引用了记录
              <span>{refCounts.to}</span>
            </div>
            <div className="v2-groupItem">
              被引用
              <span>{refCounts.from}</span>
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
            <button
              type="button"
              className="v2-linkBtn"
              onClick={() => {
                setScheduleModal(true);
                setSchedOverlap(null);
                setModalError(null);
                setSchedOpId('v2sch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
              }}
            >
              排日程
            </button>
          </div>
          <div>
            <h3 className="v2-groupTitle">旧版入口</h3>
            <p className="v2-groupNote">经验采用、AI 复盘仍走旧版页面。</p>
            <Link className="v2-groupItem" to={'/legacy/attempt/' + attemptId}>
              打开旧版尝试页
              <span>→</span>
            </Link>
          </div>
        </>
      }
      statusLeft={attempt ? `${st.label} · 版本 ${attempt.revision}` : '加载中'}
      statusRight={<span>{savedAt ? '已保存 ' + new Date(savedAt).toTimeString().slice(0, 5) : '修改未保存'}</span>}
    >
      {loading && <p className="v2-state">加载中…</p>}
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
          <div className="v2-captureHead">
            <p className="v2-captureText">{attempt.step}</p>
            <div className="v2-captureActions">
              <Pill kind={st.kind}>{st.label}</Pill>
              <Button onClick={() => void openDeleteModal()} disabled={busy}>
                删除…
              </Button>
              {attempt.actionDescription && <span className="v2-hint">{attempt.actionDescription}</span>}
              {attempt.estimatedMinutes ? <span className="v2-hint">预计 {attempt.estimatedMinutes} 分钟</span> : null}
            </div>
            {actionError && <p className="v2-state" style={{ color: 'var(--st-fail)' }}>{actionError}</p>}
            {scheduleConflict && (
              <div className="v2-conflict" role="status">
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
          </div>

          <Module title="记录结果" count={attempt.resultText ? 1 : 0}>
            <div className="v2-form">
              <label className="v2-field">
                <span className="v2-fieldLabel">状态</span>
                <div className="v2-segment" role="group" aria-label="尝试状态">
                  {STATES.map((s) => (
                    <button key={s.value} type="button" aria-pressed={state === s.value} onClick={() => setState(s.value)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </label>

              <label className="v2-field">
                <span className="v2-fieldLabel">结果（只由你填写）</span>
                <textarea
                  className="v2-editor"
                  value={result}
                  onChange={(e) => setResult(e.target.value)}
                  placeholder="实际发生了什么？条件是什么？有没有对照？"
                  aria-label="结果文本"
                />
              </label>

              {state === 'done' && (
                <label className="v2-field">
                  <span className="v2-fieldLabel">评价</span>
                  <div className="v2-segment" role="group" aria-label="结果评价">
                    {OUTCOMES.map((o) => (
                      <button key={o.value} type="button" aria-pressed={outcome === o.value} onClick={() => setOutcome(o.value)}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                </label>
              )}

              <div className="v2-field">
                <span className="v2-fieldLabel">发生时间（可留空 · 按 {timezone} 记录）</span>
                <DateField value={observedAt} onChange={setObservedAt} timezone={timezone} label="发生时间" />
                {observedAt && (
                  <span className="v2-hint">将记录为 {dayTimeLabel(fromLocalInputValue(observedAt, timezone) ?? 0, timezone)}</span>
                )}
              </div>

              <div className="v2-captureActions">
                <Button variant="primary" onClick={() => void save()} disabled={busy}>
                  {busy ? '保存中…' : '保存'}
                </Button>
                <Button
                  onClick={() => {
                    setResult(attempt.resultText ?? '');
                    setState(attempt.state);
                    setOutcome((attempt.outcome as 'success' | 'failure' | 'undetermined') ?? 'undetermined');
                    setObservedAt(toLocalInputValue(attempt.observedAt, timezone));
                    setActionError(null);
                  }}
                >
                  还原
                </Button>
                <span className="v2-hint">保存后用于阶段回顾统计，不会被自动改写</span>
              </div>
            </div>
          </Module>

          {capture && (
            <Module title="所属念头的其他尝试" count={0} defaultOpen={false}>
              <Row
                index={0}
                time="念头"
                to={'/capture/' + capture.id}
                title={capture.rawText}
                sub="打开念头详情，看全部尝试"
                side={<Pill kind="idle">来源</Pill>}
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
              <Button variant="primary" onClick={() => void addSchedule(true)} disabled={busy}>
                仍然保存
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void addSchedule(false)} disabled={busy}>
                {busy ? '保存中…' : '保存'}
              </Button>
            )}
          </>
        }
      >
        <div className="v2-field">
          <span className="v2-fieldLabel">开始（按 {timezone}）</span>
          <DateField value={schedStart} onChange={setSchedStart} timezone={timezone} label="开始时间" />
        </div>
        <div className="v2-field">
          <span className="v2-fieldLabel">结束时间 HH:mm</span>
          <input
            className="v2-input"
            value={schedEnd}
            onChange={(e) => setSchedEnd(e.target.value)}
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
            onChange={(e) => setSchedNote(e.target.value)}
            placeholder="晚上做一次对比"
            aria-label="备注"
          />
        </div>
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
            <Button variant="primary" onClick={() => void confirmDelete()} disabled={busy}>
              {busy ? '删除中…' : '确认删除'}
            </Button>
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
    </V2Shell>
  );
}
