// 拾念 V2 · 主题详情
// 主题是一组稳定 ID 的集合：成员可以是念头或经验，成员之间不代表相似或支持。
// 这里能做的事：改标题与探索问题、收/移记录、固定下次继续、归档/恢复、删除。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../api';
import type { Topic, TopicAttempt, TopicCandidate, TopicDeletePreview, TopicMember } from '../types';
import { topicAwareHref, topicUrl, type TopicNavContext } from '../components/topicNav';
import TopicExportPanel from '../components/TopicExportPanel';
import { todayDateKey, useDisplayTimezone } from '../scheduleTime';
import { dayLabel } from './format';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Row from './ui/Row';
import Pill, { type StatusKind } from './ui/Pill';
import Button from './ui/Button';
import Spinner from './ui/Spinner';
import Modal from './ui/Modal';
import HoldConfirm from './ui/HoldConfirm';
import './shared.css';

const newOpId = () => 'v2top-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

function errText(e: unknown, fallback: string) {
  const anyErr = e as { status?: number; body?: { message?: string }; message?: string };
  if (anyErr?.body?.message) return anyErr.body.message;
  if (anyErr?.status === 401) return '登录状态已失效，请重新登录。';
  if (anyErr?.status === 409) return '这个主题刚被改过（版本冲突），请刷新后再试。';
  if (anyErr?.status === 0 || anyErr?.message === 'Failed to fetch') return '网络连接失败，请检查服务是否在运行。';
  return fallback;
}

function attemptStatus(a: TopicAttempt): { kind: StatusKind; label: string } {
  if (a.state === 'done') {
    if (a.outcome === 'success') return { kind: 'done', label: '已记录结果' };
    if (a.outcome === 'failure') return { kind: 'fail', label: '未达成' };
    return { kind: 'partial', label: '结果待判断' };
  }
  if (a.state === 'cancelled') return { kind: 'idle', label: '已取消' };
  if (a.state === 'in_progress') return { kind: 'active', label: '进行中' };
  return { kind: 'idle', label: '未开始' };
}

type ModalKind = 'members' | 'next' | 'delete' | null;

export default function TopicV2Page() {
  const { topicId = '' } = useParams();
  const navigate = useNavigate();
  const [tz] = useDisplayTimezone();

  const [topic, setTopic] = useState<Topic | null>(null);
  const [attempts, setAttempts] = useState<TopicAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const currentTopicNav: TopicNavContext = useMemo(
    () => ({ fromTopic: true, topicId, returnTo: topicUrl(topicId) }),
    [topicId]
  );

  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [questionDraft, setQuestionDraft] = useState('');

  const [modal, setModal] = useState<ModalKind>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<TopicCandidate[]>([]);
  const [candQuery, setCandQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [deletePreview, setDeletePreview] = useState<TopicDeletePreview | null>(null);

  const load = useCallback(async () => {
    if (!topicId) return;
    setLoading(true);
    setError(null);
    try {
      const [topicRes, attemptRes] = await Promise.all([
        api.getTopic(topicId),
        api.listTopicAttempts(topicId, { limit: 30 }).catch(() => ({ attempts: [] as TopicAttempt[] })),
      ]);
      setTopic(topicRes.topic);
      setNameDraft(topicRes.topic.name);
      setQuestionDraft(topicRes.topic.exploringQuestion ?? '');
      setAttempts(attemptRes.attempts ?? []);
    } catch (e) {
      const anyErr = e as { status?: number };
      setError(anyErr?.status === 404 ? '这个主题不存在，可能已被删除。' : errText(e, '主题加载失败，请重试。'));
    } finally {
      setLoading(false);
    }
  }, [topicId]);

  useEffect(() => {
    setEditing(false);
    setModal(null);
    setModalError(null);
    setActionError(null);
    setPicked([]);
    setCandQuery('');
    setDeletePreview(null);
    void load();
  }, [load]);

  const members: TopicMember[] = topic?.members ?? [];
  const openAttempts = useMemo(() => attempts.filter((a) => a.state === 'todo' || a.state === 'in_progress'), [attempts]);
  const doneAttempts = useMemo(() => attempts.filter((a) => Boolean(a.resultText?.trim()) || a.state === 'done'), [attempts]);
  // 契约规定：「下次继续」只能固定已有的未完成尝试（todo / in_progress）
  const selectableAttempts = useMemo(
    () => attempts.filter((a) => a.state === 'todo' || a.state === 'in_progress'),
    [attempts]
  );

  async function saveMeta() {
    if (!topic || busy) return;
    const name = nameDraft.trim();
    if (!name) {
      setActionError('主题标题不能为空。');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.updateTopic(topic.id, {
        name,
        exploringQuestion: questionDraft.trim() || null,
        continueNote: topic.continueNote,
        revision: topic.revision,
        operationId: newOpId(),
      });
      if (res.topic) setTopic(res.topic);
      setEditing(false);
      await load();
    } catch (e) {
      setActionError(errText(e, '保存失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    if (!topic || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = topic.archivedAt
        ? await api.restoreTopic(topic.id, topic.revision, newOpId())
        : await api.archiveTopic(topic.id, topic.revision, newOpId());
      if (res.topic) setTopic(res.topic);
      await load();
    } catch (e) {
      setActionError(errText(e, '归档操作失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function openMembers() {
    setModal('members');
    setModalError(null);
    setPicked([]);
    setCandQuery('');
    try {
      const res = await api.listTopicMemberCandidates(topicId, { limit: 30 });
      setCandidates(res.candidates ?? []);
    } catch (e) {
      setModalError(errText(e, '候选记录加载失败。'));
    }
  }

  async function searchCandidates(q: string) {
    setCandQuery(q);
    try {
      const res = await api.listTopicMemberCandidates(topicId, { q, limit: 30 });
      setCandidates(res.candidates ?? []);
    } catch (e) {
      setModalError(errText(e, '候选记录加载失败。'));
    }
  }

  async function confirmMembers() {
    if (picked.length === 0) return;
    setBusy(true);
    setModalError(null);
    try {
      await api.addTopicMembers(topicId, { captureIds: picked, operationId: newOpId() });
      setModal(null);
      await load();
    } catch (e) {
      setModalError(errText(e, '加入成员失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(captureId: string) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.removeTopicMember(topicId, captureId);
      await load();
    } catch (e) {
      setActionError(errText(e, '移出成员失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function setNext(attemptId: string | null) {
    if (!topic) return;
    setBusy(true);
    setModalError(null);
    try {
      await api.setTopicNextAttempt(topic.id, {
        attemptId,
        expectedRevision: topic.revision,
        operationId: newOpId(),
      });
      setModal(null);
      await load();
    } catch (e) {
      setModalError(errText(e, '设置失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function openDelete() {
    setModal('delete');
    setDeletePreview(null);
    setModalError(null);
    try {
      const preview = await api.getTopicDeletePreview(topicId);
      setDeletePreview(preview);
    } catch (e) {
      setModalError(errText(e, '删除预览加载失败。'));
    }
  }

  async function confirmDelete() {
    setBusy(true);
    setModalError(null);
    try {
      await api.deleteTopic(topicId);
      setModal(null);
      navigate('/topics');
    } catch (e) {
      setModalError(errText(e, '删除失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  const next = topic?.nextAttempt ?? null;

  return (
    <V2Shell
      leftTitle="主题里的记录"
      leftCount={members.length}
      left={
        <>
          {loading && (
            <p className="v2-state">
              <Spinner />
            </p>
          )}
          {!loading && members.length === 0 && <p className="v2-state">还没有记录。用右栏「收一条记录」把围绕这个问题的记录放进来。</p>}
          {members.map((m, i) => (
            <div key={m.captureId} className="v2-leftRow" style={{ '--i': i } as React.CSSProperties}>
              <Link
                className="v2-leftItem"
                to={topicAwareHref(
                  m.type === 'experience' && m.experienceId
                    ? '/experience/' + m.experienceId
                    : '/capture/' + m.captureId,
                  currentTopicNav
                )}
              >
                <span className="v2-leftTitle">{m.title}</span>
                <span className="v2-leftMeta">
                  {m.type === 'experience' ? '经验' : '念头'}
                  {m.archived ? ' · 已归档' : ''}
                  {m.needsRevision ? ' · 待核对' : ''}
                </span>
              </Link>
              <button type="button" className="v2-miniBtn" onClick={() => void removeMember(m.captureId)} disabled={busy}>
                移出
              </button>
            </div>
          ))}
        </>
      }
      rightTitle="这个主题"
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">操作</h3>
            <div className="v2-sideActions">
              <button type="button" className="v2-sideAction" onClick={() => void openMembers()}>
                <span>+ 收一条记录</span>
              </button>
              <button
                type="button"
                className="v2-sideAction"
                onClick={() => {
                  setModal('next');
                  setModalError(null);
                }}
              >
                <span>固定下次继续</span>
              </button>
              <button
                type="button"
                className="v2-sideAction"
                onClick={() => {
                  setExportNotice(null);
                  setExportOpen(true);
                }}
                disabled={!topic}
                data-testid="topic-export-open"
              >
                <span>导出 Markdown（ZIP）</span>
              </button>
              <button type="button" className="v2-sideAction" onClick={() => void toggleArchive()} disabled={busy}>
                <span>{topic?.archivedAt ? '恢复主题' : '归档主题'}</span>
              </button>
              <button type="button" className="v2-sideAction danger" onClick={() => void openDelete()} disabled={busy}>
                <span>删除主题…</span>
              </button>
            </div>
          </div>
          <div>
            <h3 className="v2-groupTitle">说明</h3>
            <p className="v2-groupNote">成员只是「属于这个主题」，不代表它们互相支持或相似，也不会增加图谱连线。</p>
          </div>
        </>
      }
      statusLeft={
        topic
          ? `${members.length} 条记录 · ${attempts.length} 次尝试${topic.lastAttemptAt ? ' · 上次 ' + dayLabel(topic.lastAttemptAt, tz, todayDateKey(tz)) : ''}`
          : '加载中'
      }
      statusRight={<span>{topic?.archivedAt ? '已归档' : '进行中'}</span>}
    >
      {loading && (
        <p className="v2-state">
          <Spinner />
        </p>
      )}
      {!loading && error && (
        <p className="v2-state">
          {error}
          <button type="button" className="v2-linkBtn" onClick={() => void load()}>
            重试
          </button>
        </p>
      )}

      {topic && (
        <>
          <div className="v2-captureHead">
            {!editing ? (
              <>
                <p className="v2-captureText">{topic.name}</p>
                {topic.exploringQuestion && <p className="v2-captureSub">在探索：{topic.exploringQuestion}</p>}
                <div className="v2-captureActions">
                  <Button onClick={() => setEditing(true)}>改标题 / 问题</Button>
                  <Link
                    className="v2-ghostLink"
                    data-testid="topic-ask-link"
                    to={topicAwareHref(
                      `/ask?topic=${encodeURIComponent(topic.id)}&q=${encodeURIComponent(
                        topic.exploringQuestion || topic.name
                      )}`,
                      currentTopicNav
                    )}
                  >
                    就这个主题提问 →
                  </Link>
                </div>
                {exportNotice && (
                  <p className="v2-state" style={{ paddingLeft: 0, color: 'var(--st-done)' }} role="status">
                    {exportNotice}
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="v2-form" style={{ width: '100%', padding: 0, marginBottom: 'var(--sp-3)' }}>
                  <div className="v2-field">
                    <span className="v2-fieldLabel">标题</span>
                    <input
                      className="v2-input"
                      style={{ maxWidth: 'none', width: '100%' }}
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      maxLength={120}
                      aria-label="主题标题"
                    />
                  </div>
                  <div className="v2-field">
                    <span className="v2-fieldLabel">在探索的问题（可留空）</span>
                    <input
                      className="v2-input"
                      style={{ maxWidth: 'none', width: '100%' }}
                      value={questionDraft}
                      onChange={(e) => setQuestionDraft(e.target.value)}
                      maxLength={200}
                      aria-label="探索问题"
                    />
                  </div>
                </div>
                <div className="v2-captureActions">
                  <Button variant="primary" onClick={() => void saveMeta()} disabled={busy}>
                    {busy ? '保存中…' : '保存'}
                  </Button>
                  <Button
                    onClick={() => {
                      setEditing(false);
                      setNameDraft(topic.name);
                      setQuestionDraft(topic.exploringQuestion ?? '');
                      setActionError(null);
                    }}
                  >
                    取消
                  </Button>
                </div>
              </>
            )}
            {actionError && (
              <p className="v2-state" style={{ color: 'var(--st-fail)', paddingLeft: 0, paddingBottom: 0 }}>
                {actionError}
              </p>
            )}
          </div>

          <Module title="下一步" count={next ? 1 : 0}>
            {!next && (
              <p className="v2-state">
                还没有固定下一步。{topic.nextAttemptClearedReason ? `上一次被自动清除了（${topic.nextAttemptClearedReason}）。` : ''}
              </p>
            )}
            {next && (
              <Row
                index={0}
                time="固定"
                to={topicAwareHref('/attempt/' + next.id, currentTopicNav)}
                title={next.step}
                sub={next.resultText ? next.resultText.slice(0, 56) : '结果待记录'}
                side={<Pill kind={attemptStatus(next).kind}>{attemptStatus(next).label}</Pill>}
              />
            )}
            <div className="v2-captureActions" style={{ padding: 'var(--sp-2) var(--sp-4) var(--sp-3)' }}>
              <Button
                onClick={() => {
                  setModal('next');
                  setModalError(null);
                }}
              >
                换一个 / 取消固定
              </Button>
            </div>
          </Module>

          <Module title="进行中的尝试" count={openAttempts.length}>
            {openAttempts.length === 0 && <p className="v2-state">主题成员下没有进行中的尝试。</p>}
            {openAttempts.map((a, i) => (
              <Row
                key={a.id}
                index={i}
                time={dayLabel(a.updatedAt, tz, todayDateKey(tz))}
                to={topicAwareHref('/attempt/' + a.id, currentTopicNav)}
                title={a.step}
                sub={a.captureText ? '来自「' + a.captureText.slice(0, 18) + '」' : undefined}
                side={<Pill kind={attemptStatus(a).kind}>{attemptStatus(a).label}</Pill>}
              />
            ))}
          </Module>

          <Module title="有结果的尝试" count={doneAttempts.length} defaultOpen={doneAttempts.length > 0}>
            {doneAttempts.length === 0 && <p className="v2-state">还没有记录结果的尝试。</p>}
            {doneAttempts.map((a, i) => (
              <Row
                key={a.id}
                index={i}
                time={a.observedAt ? dayLabel(a.observedAt, tz, todayDateKey(tz)) : '—'}
                to={topicAwareHref('/attempt/' + a.id, currentTopicNav)}
                title={a.resultText || a.step}
                sub={'尝试：' + a.step.slice(0, 36)}
                side={<Pill kind={attemptStatus(a).kind}>{attemptStatus(a).label}</Pill>}
              />
            ))}
          </Module>
        </>
      )}

      {/* 收一条记录 */}
      <Modal
        open={modal === 'members'}
        title="收一条记录到这个主题"
        onClose={() => setModal(null)}
        width={560}
        footer={
          <>
            <Button onClick={() => setModal(null)}>取消</Button>
            <Button variant="primary" onClick={() => void confirmMembers()} disabled={busy || picked.length === 0}>
              加入{picked.length > 0 ? ` ${picked.length} 条` : ''}
            </Button>
          </>
        }
      >
        <input
          className="v2-input"
          style={{ maxWidth: 'none', width: '100%' }}
          value={candQuery}
          onChange={(e) => void searchCandidates(e.target.value)}
          placeholder="搜记录标题或正文"
          aria-label="搜索候选记录"
        />
        {modalError && (
          <p className="v2-groupNote" style={{ color: 'var(--st-fail)' }}>
            {modalError}
          </p>
        )}
        {candidates.length === 0 && <p className="v2-groupNote">没有可加入的记录（可能都已经在这个主题里）。</p>}
        {candidates.map((c) => (
          <label key={c.captureId} className="v2-check">
            <input
              type="checkbox"
              checked={picked.includes(c.captureId)}
              onChange={(e) =>
                setPicked((prev) => (e.target.checked ? [...prev, c.captureId] : prev.filter((x) => x !== c.captureId)))
              }
            />
            <span>{c.title}</span>
            <span className="v2-hint">{c.type === 'experience' ? '经验' : '念头'}</span>
          </label>
        ))}
      </Modal>

      {/* 固定下次继续 */}
      <Modal
        open={modal === 'next'}
        title="固定下次继续的尝试"
        onClose={() => setModal(null)}
        width={560}
      >
        {modalError && (
          <p className="v2-groupNote" style={{ color: 'var(--st-fail)' }}>
            {modalError}
          </p>
        )}
        <p className="v2-groupNote">固定的尝试会显示在主题顶部和首页；它被取消或删除时会自动清空。</p>
        <Button onClick={() => void setNext(null)} disabled={busy || !next}>
          取消固定
        </Button>
        {selectableAttempts.length === 0 && <p className="v2-groupNote">这个主题下还没有可选的尝试。</p>}
        {selectableAttempts.map((a) => (
          <div key={a.id} className="v2-candRow">
            <span className="v2-candText">
              {a.step}
              <span className="v2-hint"> · {attemptStatus(a).label}</span>
            </span>
            <Button onClick={() => void setNext(a.id)} disabled={busy || next?.id === a.id}>
              {next?.id === a.id ? '已固定' : '固定'}
            </Button>
          </div>
        ))}
      </Modal>

      {/* 删除主题 */}
      <Modal
        open={modal === 'delete'}
        title="删除这个主题？"
        onClose={() => setModal(null)}
        footer={
          <>
            <Button onClick={() => setModal(null)}>取消</Button>
            <HoldConfirm label={busy ? '删除中…' : '按住确认删除'} onConfirm={() => void confirmDelete()} disabled={busy} />
          </>
        }
      >
        {modalError && (
          <p className="v2-groupNote" style={{ color: 'var(--st-fail)' }}>
            {modalError}
          </p>
        )}
        <p>删除主题只删除这层归类，里面的记录和尝试都会保留。</p>
        <ul className="v2-conflictList">
          <li>成员记录 {deletePreview?.memberCount ?? '…'} 条</li>
          <li>念头 {deletePreview?.thoughtCount ?? '…'} 条</li>
          <li>经验 {deletePreview?.experienceCount ?? '…'} 份</li>
          <li>这些成员的尝试 {deletePreview?.attemptCount ?? '…'} 次</li>
        </ul>
      </Modal>

      {exportOpen && topic && (
        <TopicExportPanel
          topicId={topic.id}
          topicName={topic.name}
          onClose={() => setExportOpen(false)}
          onDownloaded={(msg) => setExportNotice(msg)}
        />
      )}
    </V2Shell>
  );
}
