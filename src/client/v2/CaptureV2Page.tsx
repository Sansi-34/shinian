// 拾念 V2 · 念头详情
// 完整闭环：编辑正文、归档/恢复、自己写一步（含复用旧结果引用）、加入/移出主题、关联记录、外部研究（GitHub）、删除念头。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../api';
import type { Attempt, Capture, CaptureLinkCandidate, CaptureLinkItem, CaptureTopic, DeletePreview, Topic } from '../types';
import { readTopicNav, safeTopicReturnTo, topicAwareHref } from '../components/topicNav';
import ResearchStarter from '../components/ResearchStarter';
import { todayDateKey, useDisplayTimezone } from '../scheduleTime';
import { dayLabel } from './format';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Row from './ui/Row';
import Pill, { type StatusKind } from './ui/Pill';
import Button from './ui/Button';
import GhostChip from './ui/GhostChip';
import Modal from './ui/Modal';
import Spinner from './ui/Spinner';
import HoldConfirm from './ui/HoldConfirm';
import CopyButton from './ui/CopyButton';
import './shared.css';

function errText(e: unknown, fallback: string) {
  const anyErr = e as { status?: number; body?: { message?: string }; message?: string };
  if (anyErr?.body?.message) return anyErr.body.message;
  if (anyErr?.status === 401) return '登录状态已失效，请重新登录。';
  if (anyErr?.status === 409) return '内容已被改动（版本冲突），请刷新后再改。';
  if (anyErr?.status === 0 || anyErr?.message === 'Failed to fetch') return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  return fallback;
}

function status(a: Attempt): { kind: StatusKind; label: string } {
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

const newOpId = () => 'v2-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

type ModalKind = 'topic' | 'link' | 'delete' | 'research' | null;

export default function CaptureV2Page() {
  const { captureId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const topicNav = useMemo(() => readTopicNav(searchParams), [searchParams]);
  const returnTo = useMemo(
    () => safeTopicReturnTo(searchParams.get('returnTo')) ?? topicNav.returnTo,
    [searchParams, topicNav.returnTo]
  );
  const reuseAttemptId = (searchParams.get('experience') ?? '').trim();
  const autoOpenResearch = searchParams.get('research') === '1';
  const [tz] = useDisplayTimezone();

  const [capture, setCapture] = useState<Capture | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [topics, setTopics] = useState<CaptureTopic[]>([]);
  const [links, setLinks] = useState<{ out: CaptureLinkItem[]; in: CaptureLinkItem[] }>({ out: [], in: [] });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [stepDraft, setStepDraft] = useState('');

  const [modal, setModal] = useState<ModalKind>(null);
  const [allTopics, setAllTopics] = useState<Topic[]>([]);
  const [pickedTopics, setPickedTopics] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<CaptureLinkCandidate[]>([]);
  const [candQuery, setCandQuery] = useState('');
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!captureId) return;
    setLoading(true);
    setError(null);
    try {
      const [capRes, attRes, topicRes, linkRes] = await Promise.all([
        api.getCapture(captureId),
        api.listAttempts(captureId),
        api.getCaptureTopics(captureId).catch(() => ({ captureId, topics: [] as CaptureTopic[] })),
        api.listCaptureLinks(captureId).catch(() => ({ captureId, out: [], in: [], counts: { out: 0, in: 0 } })),
      ]);
      setCapture(capRes.capture);
      setDraft(capRes.capture.rawText);
      setAttempts(attRes.attempts ?? []);
      setTopics(topicRes.topics ?? []);
      setLinks({ out: linkRes.out ?? [], in: linkRes.in ?? [] });
    } catch (e) {
      setError(errText(e, '念头加载失败，请重试。'));
    } finally {
      setLoading(false);
    }
  }, [captureId]);

  useEffect(() => {
    setEditing(false);
    setWriting(Boolean(reuseAttemptId));
    setStepDraft('');
    setModal(autoOpenResearch ? 'research' : null);
    setActionError(null);
    setModalError(null);
    setDeletePreview(null);
    void load();
  }, [load, reuseAttemptId, autoOpenResearch]);

  const openItems = useMemo(() => attempts.filter((a) => a.state === 'todo' || a.state === 'in_progress'), [attempts]);
  const done = useMemo(() => attempts.filter((a) => Boolean(a.resultText?.trim()) || a.state === 'done'), [attempts]);

  async function saveText() {
    if (!capture || busy) return;
    const text = draft.trim();
    if (!text) {
      setActionError('正文不能为空。');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.updateCapture(capture.id, text, capture.revision);
      setCapture(res.capture);
      setEditing(false);
    } catch (e) {
      setActionError(errText(e, '保存失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    if (!capture || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = capture.archivedAt ? await api.restoreCapture(capture.id) : await api.archiveCapture(capture.id);
      setCapture(res.capture);
    } catch (e) {
      setActionError(errText(e, '归档操作失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function createStep() {
    if (!capture || busy) return;
    const step = stepDraft.trim();
    if (!step) return;
    setBusy(true);
    setActionError(null);
    try {
      const created = await api.createAttempt(capture.id, { step, state: 'todo', operationId: newOpId() });
      if (reuseAttemptId && reuseAttemptId !== created.attempt.id) {
        await api
          .createReference(created.attempt.id, {
            toId: reuseAttemptId,
            note: '复用旧尝试结果再试一步',
            operationId: newOpId(),
          })
          .catch(() => {});
      }
      setStepDraft('');
      setWriting(false);
      await load();
    } catch (e) {
      setActionError(errText(e, '创建尝试失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function openTopicModal() {
    setActionError(null);
    setModalError(null);
    setModal('topic');
    setPickedTopics([]);
    try {
      const res = await api.listTopics({ limit: 50, archived: 'exclude' });
      setAllTopics(res.topics ?? []);
    } catch (e) {
      setModalError(errText(e, '主题列表加载失败。'));
    }
  }

  async function confirmAddTopics() {
    if (!capture || pickedTopics.length === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.addCaptureTopics(capture.id, { topicIds: pickedTopics, operationId: newOpId() });
      setModal(null);
      await load();
    } catch (e) {
      setModalError(errText(e, '加入主题失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function removeFromTopic(topicId: string) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.removeTopicMember(topicId, captureId);
      await load();
    } catch (e) {
      setActionError(errText(e, '移出主题失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function openLinkModal() {
    setModalError(null);
    setModal('link');
    setCandQuery('');
    setCandidates([]);
    try {
      const res = await api.searchCaptureLinkCandidates(captureId, '', 12);
      setCandidates(res.captures ?? []);
    } catch (e) {
      setModalError(errText(e, '候选加载失败。'));
    }
  }

  async function searchCandidates(q: string) {
    setCandQuery(q);
    setModalError(null);
    try {
      const res = await api.searchCaptureLinkCandidates(captureId, q, 12);
      setCandidates(res.captures ?? []);
    } catch (e) {
      setModalError(errText(e, '候选加载失败。'));
    }
  }

  async function confirmLink(toCaptureId: string) {
    setBusy(true);
    setActionError(null);
    try {
      await api.createCaptureLink(captureId, { toCaptureId, operationId: newOpId() });
      setModal(null);
      await load();
    } catch (e) {
      setModalError(errText(e, '关联失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function unlink(linkId: string) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteCaptureLink(linkId);
      await load();
    } catch (e) {
      setActionError(errText(e, '解除关联失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function openDeleteModal() {
    setModalError(null);
    setModal('delete');
    setDeletePreview(null);
    try {
      const preview = await api.deletePreview(captureId);
      setDeletePreview(preview);
    } catch (e) {
      setModalError(errText(e, '删除预览加载失败。'));
    }
  }

  async function confirmDelete() {
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteCapture(captureId);
      setModal(null);
      navigate('/');
    } catch (e) {
      setModalError(errText(e, '删除失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  const linkRows: Array<{ key: string; label: string; item: CaptureLinkItem }> = [
    ...links.out.map((l) => ({ key: 'out-' + l.id, label: '关联到', item: l })),
    ...links.in.map((l) => ({ key: 'in-' + l.id, label: '被引用', item: l })),
  ];

  const linkableTopics = allTopics.filter((t) => !topics.some((x) => x.id === t.id));

  return (
    <V2Shell
      rightTitle="关系"
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">所属主题</h3>
            {topics.length === 0 && <p className="v2-groupNote">还没有加入主题。</p>}
            {topics.map((t) => (
              <div key={t.id} className="v2-groupItem">
                <Link to={'/topics/' + t.id} title={t.name}>{t.name}</Link>
                <button type="button" className="v2-miniBtn" onClick={() => void removeFromTopic(t.id)} disabled={busy}>
                  移出
                </button>
              </div>
            ))}
            <div className="v2-sideActions">
              <button type="button" className="v2-sideAction" onClick={() => void openTopicModal()}>
                <span>+ 加入主题</span>
              </button>
            </div>
          </div>

          <div>
            <h3 className="v2-groupTitle">关联记录</h3>
            {linkRows.length === 0 && <p className="v2-groupNote">没有手动关联。关联只记录你写下的关系，不做相似度推断。</p>}
            {linkRows.map((r) => (
              <div key={r.key} className="v2-groupItem">
                <Link to={'/capture/' + r.item.capture.id} title={r.item.capture.rawText}>
                  {r.label}：{r.item.capture.rawText}
                </Link>
                <button type="button" className="v2-miniBtn" onClick={() => void unlink(r.item.id)} disabled={busy}>
                  解除
                </button>
              </div>
            ))}
            <div className="v2-sideActions">
              <button type="button" className="v2-sideAction" onClick={() => void openLinkModal()}>
                <span>+ 关联一条念头</span>
              </button>
              <button
                type="button"
                className="v2-sideAction"
                onClick={() => setModal('research')}
                disabled={!capture}
                data-testid="capture-start-research"
              >
                <span>研究一下（GitHub）→</span>
              </button>
              {capture && (
                <Link
                  className="v2-sideAction"
                  to={topicAwareHref(
                    `/graph?node=capture:${capture.id}&depth=1&returnTo=${encodeURIComponent(
                      `/capture/${capture.id}`
                    )}`,
                    topicNav
                  )}
                >
                  <span>在知识网络中查看 →</span>
                </Link>
              )}
            </div>
          </div>
        </>
      }
      statusLeft={capture ? `${dayLabel(capture.createdAt, tz, todayDateKey(tz))} · 版本 ${capture.revision} · ${attempts.length} 次尝试` : '加载中'}
      statusRight={<span>{capture?.archivedAt ? '已归档' : '进行中'}</span>}
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

      {capture && (
        <>
          {returnTo && (
            <div className="v2-returnBar">
              <Link to={returnTo} className="v2-returnLink">
                ← {topicNav.fromTopic ? '返回主题' : '返回刚才阅读的位置'}
              </Link>
            </div>
          )}

          <div className="v2-captureHead">
            {!editing ? (
              <>
                <p className="v2-captureText">{capture.rawText}</p>
                <div className="v2-captureActions">
                  <Button onClick={() => setEditing(true)}>编辑</Button>
                  <CopyButton text={capture.rawText} label="复制正文" />
                  <Button onClick={() => void toggleArchive()} disabled={busy}>
                    {capture.archivedAt ? '恢复' : '归档'}
                  </Button>
                  {/* 破坏性操作拉开距离并给危险色，别和「编辑」长成一模一样 */}
                  <Button
                    onClick={() => void openDeleteModal()}
                    disabled={busy}
                    style={{ marginLeft: 'auto', color: 'var(--st-fail)', borderColor: 'var(--st-fail)' }}
                  >
                    删除…
                  </Button>
                </div>
              </>
            ) : (
              <>
                <textarea
                  className="v2-editor"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={4000}
                  aria-label="编辑念头正文"
                />
                <div className="v2-captureActions">
                  <Button variant="primary" onClick={() => void saveText()} disabled={busy}>
                    {busy ? '保存中…' : '保存'}
                  </Button>
                  <Button
                    onClick={() => {
                      setEditing(false);
                      setDraft(capture.rawText);
                      setActionError(null);
                    }}
                  >
                    取消
                  </Button>
                  <span className="v2-hint">{draft.length} / 4000</span>
                </div>
              </>
            )}
            {actionError && (
              <p className="v2-state" style={{ color: 'var(--st-fail)' }}>
                {actionError}
              </p>
            )}
          </div>

          <Module title="开始一步" count={openItems.length}>
            {!writing && (
              <div className="v2-ghosts" style={{ borderBottom: 0 }}>
                <GhostChip onClick={() => setWriting(true)}>自己写一步</GhostChip>
                <GhostChip onClick={() => setModal('research')}>研究一下（GitHub）</GhostChip>
              </div>
            )}
            {writing && (
              <div className="v2-writer">
                {reuseAttemptId && (
                  <p className="v2-groupNote">
                    将自动关联所选的旧尝试结果，创建后可在尝试详情里核对引用来源。
                  </p>
                )}
                <textarea
                  className="v2-editor"
                  maxLength={500}
                  value={stepDraft}
                  onChange={(e) => setStepDraft(e.target.value)}
                  placeholder="写下一个具体、能立刻开始的小尝试"
                  aria-label="新尝试步骤"
                />
                <div className="v2-captureActions">
                  <Button variant="primary" onClick={() => void createStep()} disabled={busy || !stepDraft.trim()}>
                    {busy ? '创建中…' : '创建尝试'}
                  </Button>
                  <Button
                    onClick={() => {
                      setWriting(false);
                      setStepDraft('');
                    }}
                  >
                    取消
                  </Button>
                </div>
              </div>
            )}
          </Module>

          <Module title="尝试记录" count={attempts.length}>
            {attempts.length === 0 && <p className="v2-state">还没有尝试。先用上面的「自己写一步」记下第一个小尝试。</p>}
            {attempts.map((a, i) => {
              const st = status(a);
              return (
                <Row
                  key={a.id}
                  index={i}
                  time={dayLabel(a.updatedAt, tz, todayDateKey(tz))}
                  to={topicAwareHref('/attempt/' + a.id, topicNav)}
                  title={a.step}
                  sub={a.resultText ? a.resultText.slice(0, 60) : a.actionDescription || '结果待记录'}
                  side={<Pill kind={st.kind}>{st.label}</Pill>}
                />
              );
            })}
          </Module>

          <Module title="有结果的尝试" count={done.length} defaultOpen={done.length > 0}>
            {done.length === 0 && <p className="v2-state">还没有记录结果的尝试。结果只能手动填，不会因为时间过去自动变成失败。</p>}
            {done.map((a, i) => (
              <Row
                key={a.id}
                index={i}
                time={a.observedAt ? dayLabel(a.observedAt, tz, todayDateKey(tz)) : '—'}
                to={topicAwareHref('/attempt/' + a.id, topicNav)}
                title={a.resultText || a.step}
                sub={'尝试：' + a.step.slice(0, 40)}
                side={<Pill kind={status(a).kind}>{status(a).label}</Pill>}
              />
            ))}
          </Module>
        </>
      )}

      <Modal
        open={modal === 'topic'}
        title="加入主题"
        onClose={() => setModal(null)}
        footer={
          <>
            <Button onClick={() => setModal(null)}>取消</Button>
            <Button variant="primary" onClick={() => void confirmAddTopics()} disabled={busy || pickedTopics.length === 0}>
              加入{pickedTopics.length > 0 ? ' ' + pickedTopics.length + ' 个' : ''}
            </Button>
          </>
        }
      >
        {modalError && (
          <p className="v2-groupNote" style={{ color: 'var(--st-fail)' }}>
            {modalError}
          </p>
        )}
        {linkableTopics.length === 0 && <p className="v2-groupNote">没有可加入的主题。主题要先去主题页新建。</p>}
        {linkableTopics.map((t) => (
          <label key={t.id} className="v2-check">
            <input
              type="checkbox"
              checked={pickedTopics.includes(t.id)}
              onChange={(e) => setPickedTopics((prev) => (e.target.checked ? [...prev, t.id] : prev.filter((x) => x !== t.id)))}
            />
            <span>{t.name}</span>
            <span className="v2-hint">{t.memberCount} 条</span>
          </label>
        ))}
      </Modal>

      <Modal open={modal === 'link'} title="关联一条念头" onClose={() => setModal(null)}>
        <input
          className="v2-input"
          style={{ maxWidth: 'none', width: '100%' }}
          value={candQuery}
          onChange={(e) => void searchCandidates(e.target.value)}
          placeholder="搜标题或正文"
          aria-label="搜索候选"
        />
        {modalError && (
          <p className="v2-groupNote" style={{ color: 'var(--st-fail)' }}>
            {modalError}
          </p>
        )}
        {candidates.length === 0 && <p className="v2-groupNote">没有候选。换个词试试。</p>}
        {candidates.map((c) => (
          <div key={c.id} className="v2-candRow">
            <span className="v2-candText">{c.rawText.slice(0, 60)}</span>
            <Button onClick={() => void confirmLink(c.id)} disabled={busy || c.alreadyLinked}>
              {c.alreadyLinked ? '已关联' : '关联'}
            </Button>
          </div>
        ))}
      </Modal>

      <Modal
        open={modal === 'delete'}
        title="删除这条念头？"
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
        <p>删除后不可恢复。以下内容会一起处理：</p>
        <ul className="v2-conflictList">
          <li>尝试 {deletePreview?.attemptCount ?? '…'} 次</li>
          <li>尝试引用 {deletePreview ? deletePreview.referencesFromAttempts + deletePreview.referencesToAttempts : '…'} 条</li>
          <li>手动关联 {deletePreview?.captureLinkCount ?? 0} 条</li>
          <li>关联日程 {deletePreview?.scheduleCount ?? 0} 条</li>
          <li>研究任务 {deletePreview?.researchCount ?? 0} 个</li>
        </ul>
        {(deletePreview?.affectedExperiences?.length ?? 0) > 0 && (
          <p className="v2-groupNote">
            有 {deletePreview?.affectedExperiences?.length} 份经验把它当作依据：会解除依据关系，经验正文保留但标记待核对。
          </p>
        )}
      </Modal>

      {modal === 'research' && capture && (
        <Modal open title="研究一下（GitHub 公开资料）" onClose={() => setModal(null)} width={680}>
          <ResearchStarter
            capture={capture}
            onClose={() => setModal(null)}
            onStarted={(researchId) => {
              setModal(null);
              navigate('/research/' + researchId);
            }}
          />
        </Modal>
      )}
    </V2Shell>
  );
}
