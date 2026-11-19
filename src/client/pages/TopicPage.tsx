// 主题详情：下次继续、成员分组、聚合尝试、经验依据与主题提问入口。
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api, { ApiError } from '../api';
import type {
  AddTopicMembersResponse,
  Topic,
  TopicAttempt,
  TopicDeletePreview,
  TopicMember,
} from '../types';
import {
  OUTCOME_LABEL,
  TOPIC_ATTEMPT_STATUS_LABEL,
  TOPIC_MEMBER_TYPE_LABEL,
  formatTime,
  newOperationId,
  topicAttemptDisplayState,
  topicErrorText,
} from '../types';
import TopicMemberPicker from '../components/TopicMemberPicker';
import TopicNextStep from '../components/TopicNextStep';
import TopicEvidencePanel from '../components/TopicEvidencePanel';
import TopicExportPanel from '../components/TopicExportPanel';
import { topicAwareHref, topicUrl, type TopicNavContext } from '../components/topicNav';

type MemberTab = 'thought' | 'experience';
type AttemptFilter = 'all' | 'pending' | 'recorded' | 'cancelled';

type TopicWorkspace = {
  tab: MemberTab;
  attemptState: AttemptFilter;
  scrollY: number;
};

const WORKSPACE_PREFIX = 'shinian.topic.workspace.';
const ATTEMPT_FILTER_LABEL: Record<AttemptFilter, string> = {
  all: '全部尝试',
  pending: '等待记录结果',
  recorded: '已记录结果',
  cancelled: '已取消',
};

function workspaceKey(id: string) {
  return `${WORKSPACE_PREFIX}${id}`;
}

function readWorkspace(id: string): TopicWorkspace | null {
  try {
    const raw = sessionStorage.getItem(workspaceKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TopicWorkspace> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      tab: parsed.tab === 'experience' ? 'experience' : 'thought',
      attemptState:
        parsed.attemptState === 'pending' ||
        parsed.attemptState === 'recorded' ||
        parsed.attemptState === 'cancelled'
          ? parsed.attemptState
          : 'all',
      scrollY: typeof parsed.scrollY === 'number' ? parsed.scrollY : 0,
    };
  } catch {
    return null;
  }
}

function saveWorkspace(id: string, value: TopicWorkspace) {
  try {
    sessionStorage.setItem(workspaceKey(id), JSON.stringify(value));
  } catch {
    // sessionStorage 不可用时只保留内存状态。
  }
}

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.body?.message || topicErrorText(e.body?.error, fallback);
  // fetch 直接失败（断网、后端没起来）拿到的是 TypeError，不能把 "Failed to fetch" 原样给用户。
  if (e instanceof TypeError) return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

export default function TopicPage() {
  const { topicId = '' } = useParams<{ topicId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const restoredRef = useRef(false);
  const restoredWorkspace = useRef<TopicWorkspace | null>(readWorkspace(topicId));
  // 记住用户最后一次滚动位置；卸载时浏览器可能先把 scrollY 归零，不能直接用它覆盖。
  const lastScrollYRef = useRef(restoredWorkspace.current?.scrollY ?? 0);

  const initialTab: MemberTab =
    searchParams.get('tab') === 'experience'
      ? 'experience'
      : searchParams.get('tab') === 'thought'
        ? 'thought'
        : restoredWorkspace.current?.tab ?? 'thought';
  const rawAttemptFilter = searchParams.get('attemptState');
  const initialAttemptFilter: AttemptFilter =
    rawAttemptFilter === 'pending' ||
    rawAttemptFilter === 'recorded' ||
    rawAttemptFilter === 'cancelled'
      ? rawAttemptFilter
      : rawAttemptFilter === 'all'
        ? 'all'
        : restoredWorkspace.current?.attemptState ?? 'all';

  const [topic, setTopic] = useState<Topic | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [tab, setTab] = useState<MemberTab>(initialTab);
  const [attemptFilter, setAttemptFilter] = useState<AttemptFilter>(initialAttemptFilter);

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftQuestion, setDraftQuestion] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    currentRevision: number;
    currentTitle: string | null;
    currentQuestion: string | null;
    currentNote: string | null;
  } | null>(null);
  const saveOperationRef = useRef(newOperationId());

  const [archiveBusy, setArchiveBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePreview, setDeletePreview] = useState<TopicDeletePreview | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [graphMemberId, setGraphMemberId] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  /** 移出成员前的确认：先显示后果，再真正执行。 */
  const [removeTarget, setRemoveTarget] = useState<TopicMember | null>(null);

  const [attempts, setAttempts] = useState<TopicAttempt[]>([]);
  const [attemptTotal, setAttemptTotal] = useState<number | null>(null);
  const [attemptHasMore, setAttemptHasMore] = useState(false);
  const [attemptOffset, setAttemptOffset] = useState(0);
  const [attemptsLoading, setAttemptsLoading] = useState(true);
  const [attemptsLoadingMore, setAttemptsLoadingMore] = useState(false);
  const [attemptsError, setAttemptsError] = useState<string | null>(null);
  const [removingMember, setRemovingMember] = useState<string | null>(null);

  const filterRef = useRef({ tab, attemptFilter });
  const scrollRafRef = useRef<number | null>(null);

  const currentTopicUrl = topic
    ? topicUrl(topic.id, searchParams.toString())
    : topicUrl(topicId, searchParams.toString());
  const navContext: TopicNavContext = {
    fromTopic: Boolean(topicId),
    topicId: topicId || null,
    returnTo: currentTopicUrl,
  };

  useEffect(() => {
    filterRef.current = { tab, attemptFilter };
  }, [tab, attemptFilter]);

  useEffect(() => {
    restoredWorkspace.current = readWorkspace(topicId);
    restoredRef.current = false;
    setTopic(null);
    setLoading(true);
    setLoadError(null);
    setNotice(null);
    setActionError(null);
    setEditing(false);
    setExportOpen(false);
    void loadTopic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId]);

  useEffect(() => {
    void loadAttempts(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, attemptFilter]);

  // 保存筛选与滚动位置；返回/刷新后恢复。
  useEffect(() => {
    saveWorkspace(topicId, {
      tab,
      attemptState: attemptFilter,
      scrollY: lastScrollYRef.current,
    });
    const params = new URLSearchParams(searchParams);
    if (tab === 'thought') params.delete('tab');
    else params.set('tab', tab);
    if (attemptFilter === 'all') params.delete('attemptState');
    else params.set('attemptState', attemptFilter);
    if (params.toString() !== searchParams.toString()) {
      setSearchParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, attemptFilter, topicId]);

  useEffect(() => {
    const onScroll = () => {
      if (scrollRafRef.current != null) return;
      scrollRafRef.current = window.requestAnimationFrame(() => {
        scrollRafRef.current = null;
        lastScrollYRef.current = window.scrollY;
        saveWorkspace(topicId, {
          tab: filterRef.current.tab,
          attemptState: filterRef.current.attemptFilter,
          scrollY: lastScrollYRef.current,
        });
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (scrollRafRef.current != null) window.cancelAnimationFrame(scrollRafRef.current);
      saveWorkspace(topicId, {
        tab: filterRef.current.tab,
        attemptState: filterRef.current.attemptFilter,
        scrollY: lastScrollYRef.current,
      });
    };
  }, [topicId]);

  // 等主题与尝试列表都渲染后再恢复滚动位置，避免内容高度不足被浏览器夹到 0。
  useEffect(() => {
    if (loading || attemptsLoading || !topic || restoredRef.current) return;
    restoredRef.current = true;
    const y = restoredWorkspace.current?.scrollY ?? 0;
    if (y <= 0) return;
    let cancelled = false;
    let attempts = 0;
    let timer: number | undefined;
    const applyScroll = () => {
      if (cancelled) return;
      window.scrollTo({ top: y, behavior: 'auto' });
      attempts += 1;
      // 成员/尝试异步渲染可能分两批提交；内容高度还在增长时再校正一次。
      if (attempts < 8) timer = window.setTimeout(applyScroll, 140);
    };
    timer = window.setTimeout(applyScroll, 120);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [loading, attemptsLoading, topic]);

  async function loadTopic() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.getTopic(topicId);
      setTopic(res.topic);
      if (!graphMemberId && res.topic.members.length > 0) {
        setGraphMemberId(res.topic.members[0].captureId);
      }
    } catch (e) {
      setLoadError(errorText(e, '主题不存在或无法读取'));
    } finally {
      setLoading(false);
    }
  }

  async function reloadTopic() {
    const res = await api.getTopic(topicId);
    setTopic(res.topic);
    return res.topic;
  }

  /** 写接口只返回 TopicSummary，详情页要保留已加载的 members。 */
  function applyTopicSummary(summary: Topic) {
    setTopic((prev) =>
      prev
        ? {
            ...prev,
            ...summary,
            members: summary.members.length > 0 ? summary.members : prev.members,
          }
        : summary
    );
  }

  async function loadAttempts(reset: boolean) {
    if (reset) {
      setAttemptsLoading(true);
      setAttempts([]);
      setAttemptOffset(0);
    } else {
      setAttemptsLoadingMore(true);
    }
    setAttemptsError(null);
    try {
      const res = await api.listTopicAttempts(topicId, {
        limit: 20,
        offset: reset ? 0 : attemptOffset,
        state: attemptFilter,
      });
      setAttempts((prev) => (reset ? res.attempts : [...prev, ...res.attempts]));
      setAttemptTotal(res.total);
      setAttemptHasMore(res.hasMore);
      setAttemptOffset((reset ? 0 : attemptOffset) + res.attempts.length);
    } catch (e) {
      setAttemptsError(errorText(e, '聚合尝试加载失败'));
    } finally {
      setAttemptsLoading(false);
      setAttemptsLoadingMore(false);
    }
  }

  function startEdit() {
    if (!topic) return;
    setDraftName(topic.name);
    setDraftQuestion(topic.exploringQuestion ?? '');
    setDraftNote(topic.continueNote ?? '');
    setConflict(null);
    setEditError(null);
    setEditing(true);
  }

  async function saveEdit(revisionOverride?: number) {
    if (!topic || saving) return;
    const name = draftName.trim();
    if (!name) {
      setEditError('主题名称不能为空。');
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      const res = await api.updateTopic(topic.id, {
        name,
        exploringQuestion: draftQuestion.trim() || null,
        continueNote: draftNote.trim() || null,
        revision: revisionOverride ?? topic.revision,
        expectedRevision: revisionOverride ?? topic.revision,
        operationId: saveOperationRef.current,
      });
      saveOperationRef.current = newOperationId();
      applyTopicSummary(res.topic);
      setEditing(false);
      setConflict(null);
      setNotice('主题已保存。');
    } catch (e) {
      if (e instanceof ApiError && e.body?.error === 'revision_conflict') {
        const current = e.body?.currentTopic ?? {};
        const currentRevision =
          typeof e.body?.currentRevision === 'number'
            ? e.body.currentRevision
            : topic.revision + 1;
        setConflict({
          currentRevision,
          currentTitle: typeof current.title === 'string' ? current.title : null,
          currentQuestion:
            typeof current.exploringQuestion === 'string' ? current.exploringQuestion : null,
          currentNote: typeof current.continueNote === 'string' ? current.continueNote : null,
        });
        setEditError('主题刚被其他窗口修改；你的输入仍保留在表单里。');
      } else {
        setEditError(errorText(e, '保存主题失败'));
      }
    } finally {
      setSaving(false);
    }
  }

  function adoptLatest() {
    if (!conflict) return;
    if (conflict.currentTitle != null) setDraftName(conflict.currentTitle);
    setDraftQuestion(conflict.currentQuestion ?? '');
    setDraftNote(conflict.currentNote ?? '');
    setTopic((prev) =>
      prev
        ? {
            ...prev,
            revision: conflict.currentRevision,
            name: conflict.currentTitle ?? prev.name,
            exploringQuestion: conflict.currentQuestion,
            continueNote: conflict.currentNote,
          }
        : prev
    );
    setConflict(null);
    setEditError(null);
  }

  async function toggleArchive() {
    if (!topic || archiveBusy) return;
    setArchiveBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = topic.archived
        ? await api.restoreTopic(topic.id, topic.revision, newOperationId())
        : await api.archiveTopic(topic.id, topic.revision, newOperationId());
      applyTopicSummary(res.topic);
      setNotice(
        topic.archived
          ? '主题已恢复。'
          : '主题已归档。成员、尝试、日程与固定下一步都保留。'
      );
    } catch (e) {
      setActionError(errorText(e, '归档操作失败'));
      if (e instanceof ApiError && e.body?.error === 'revision_conflict') {
        void reloadTopic();
      }
    } finally {
      setArchiveBusy(false);
    }
  }

  async function openDelete() {
    if (!topic) return;
    setDeleteOpen(true);
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      setDeletePreview(await api.getTopicDeletePreview(topic.id));
    } catch (e) {
      setDeleteError(errorText(e, '读取删除影响失败'));
    } finally {
      setDeleteLoading(false);
    }
  }

  async function confirmDelete() {
    if (!topic || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteTopic(topic.id);
      navigate('/topics');
    } catch (e) {
      setDeleteError(errorText(e, '删除主题失败'));
    } finally {
      setDeleting(false);
    }
  }

  async function removeMember(member: TopicMember) {
    if (!topic || removingMember) return;
    setRemovingMember(member.captureId);
    setActionError(null);
    setNotice(null);
    try {
      const res = await api.removeTopicMember(topic.id, member.captureId);
      setTopic((prev) => {
        if (!prev) return prev;
        const members = prev.members.filter((item) => item.captureId !== member.captureId);
        const base = res.topic ? { ...prev, ...res.topic } : prev;
        return {
          ...base,
          members,
          memberCount: members.length,
          thoughtCount: members.filter((item) => item.type === 'thought').length,
          experienceCount: members.filter((item) => item.type === 'experience').length,
        };
      });
      setRemoveTarget(null);
      // 成员变化会影响聚合尝试与固定下一步，必须重新拉取，否则列表停留在加入/移出前的状态。
      void loadAttempts(true);
      setNotice(
        res.clearedNext
          ? `已从主题移出「${member.title}」；原记录保留，固定的下一步也已清除。`
          : `已从主题移出「${member.title}」；原记录和尝试都保留。`
      );
    } catch (e) {
      setActionError(errorText(e, '移出成员失败'));
    } finally {
      setRemovingMember(null);
    }
  }

  function handleAdded(result: AddTopicMembersResponse) {
    const parts = [`加入 ${result.added} 条记录`];
    if (result.skipped > 0) parts.push(`${result.skipped} 条已在主题中，未重复`);
    setNotice(`${parts.join('，')}。原记录没有被复制或修改。`);
    void reloadTopic();
    // 新成员带着自己的尝试进来，聚合尝试必须一起刷新。
    void loadAttempts(true);
  }

  const graphMember =
    topic?.members.find((member) => member.captureId === graphMemberId) ?? topic?.members[0] ?? null;
  const graphNode = graphMember
    ? `${
        graphMember.type === 'experience' ? 'experience' : 'capture'
      }:${graphMember.type === 'experience' ? graphMember.experienceId ?? graphMember.captureId : graphMember.captureId}`
    : '';
  const graphHref = graphNode
    ? `/graph?node=${encodeURIComponent(graphNode)}&depth=1&from=topic&topicId=${encodeURIComponent(
        topicId
      )}&returnTo=${encodeURIComponent(currentTopicUrl)}`
    : '';

  const askParams = new URLSearchParams({ topicId });
  if (topic?.exploringQuestion?.trim()) askParams.set('q', topic.exploringQuestion.trim());
  askParams.set('returnTo', currentTopicUrl);
  const askHref = `/ask?${askParams.toString()}`;

  const thoughtMembers = topic?.members.filter((member) => member.type === 'thought') ?? [];
  const experienceMembers = topic?.members.filter((member) => member.type === 'experience') ?? [];
  const shownMembers = tab === 'thought' ? thoughtMembers : experienceMembers;

  if (loading) {
    return (
      <div className="page topic-page">
        <p className="muted loading-line" role="status">
          <span className="spinner" aria-hidden="true" /> 读取主题…
        </p>
      </div>
    );
  }

  if (!topic) {
    return (
      <div className="page topic-page">
        <div className="crumb">
          <Link to="/topics">← 所有主题</Link>
        </div>
        <p className="error-msg" role="alert">
          {loadError || '主题不存在。'}
        </p>
        <div className="row-actions">
          <button type="button" className="btn small" onClick={() => void loadTopic()} data-testid="topic-load-retry">
            重试
          </button>
          <Link className="btn small" to="/topics">
            返回主题列表
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page topic-page" data-testid="topic-page">
      <div className="crumb">
        <Link to="/topics">← 所有主题</Link>
      </div>

      <header className="topic-hero" aria-labelledby="topic-title">
        {editing ? (
          <div className="topic-edit" aria-label="编辑主题">
            <label className="field">
              <span>主题名称</span>
              <input
                type="text"
                value={draftName}
                maxLength={120}
                onChange={(e) => setDraftName(e.target.value)}
                data-testid="topic-edit-name"
              />
            </label>
            <label className="field">
              <span>正在探索的问题</span>
              <textarea
                rows={2}
                value={draftQuestion}
                maxLength={1000}
                onChange={(e) => setDraftQuestion(e.target.value)}
                data-testid="topic-edit-question"
              />
            </label>
            <label className="field">
              <span>继续备注</span>
              <textarea
                rows={2}
                value={draftNote}
                maxLength={1000}
                onChange={(e) => setDraftNote(e.target.value)}
                data-testid="topic-edit-note"
              />
            </label>
            {conflict && (
              <div className="conflict-banner" role="alert" data-testid="topic-edit-conflict">
                <p>版本冲突：主题已在别处修改。你的输入仍保留在这里，不会被覆盖。</p>
                <p className="muted">
                  最新名称：{conflict.currentTitle ?? '（未返回）'} · 最新版本 {conflict.currentRevision}
                </p>
                <div className="row-actions">
                  <button type="button" className="btn small" onClick={adoptLatest}>
                    采用最新内容
                  </button>
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={() => void saveEdit(conflict.currentRevision)}
                    disabled={saving}
                  >
                    保留我的草稿并重试
                  </button>
                </div>
              </div>
            )}
            {editError && !conflict && (
              <p className="error-msg" role="alert">
                {editError}
              </p>
            )}
            <div className="row-actions">
              <button
                type="button"
                className="btn primary"
                onClick={() => void saveEdit()}
                disabled={saving}
                data-testid="topic-edit-save"
              >
                {saving ? '保存中…' : '保存'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setEditing(false);
                  setConflict(null);
                  setEditError(null);
                }}
                disabled={saving}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="topic-hero-main">
              <div className="topic-title-row">
                <h1 className="detail-title" id="topic-title" data-testid="topic-title">
                  {topic.name}
                </h1>
                {topic.archived && <span className="badge">已归档</span>}
              </div>
              <p className="topic-hero-question">
                {topic.exploringQuestion?.trim()
                  ? topic.exploringQuestion
                  : '还没有写下正在探索的问题。'}
              </p>
              {topic.continueNote?.trim() && (
                <p className="topic-hero-note">
                  <span className="topic-hero-note-label">继续备注</span>
                  {topic.continueNote}
                </p>
              )}
              <p className="card-meta">
                {topic.memberCount} 个成员 · 创建于 {formatTime(topic.createdAt)} · 更新于{' '}
                {formatTime(topic.updatedAt)}
              </p>
            </div>
            <div className="topic-hero-actions">
              <button type="button" className="btn small" onClick={startEdit} data-testid="topic-edit">
                编辑主题
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => setExportOpen(true)}
                data-testid="topic-export-open"
              >
                导出 Markdown
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => void toggleArchive()}
                disabled={archiveBusy}
                data-testid={topic.archived ? 'topic-restore' : 'topic-archive'}
              >
                {archiveBusy ? '处理中…' : topic.archived ? '恢复主题' : '归档主题'}
              </button>
              <button
                type="button"
                className="btn small danger-outline"
                onClick={() => void openDelete()}
                data-testid="topic-delete-open"
              >
                删除主题…
              </button>
            </div>
          </>
        )}
      </header>

      {notice && (
        <p className="save-ok" role="status">
          {notice}
        </p>
      )}
      {actionError && (
        <p className="error-msg" role="alert">
          {actionError}
        </p>
      )}

      {topic.members.length > 0 && (
        <section className="section topic-graph-section" aria-label="局部图">
          <div className="section-head">
            <div>
              <h3>从主题成员打开局部图</h3>
              <p className="hint">只查看一条记录的一跳关系；返回时会回到这个主题。</p>
            </div>
            <div className="topic-graph-controls">
              <label className="field-inline">
                <span>成员</span>
                <select
                  value={graphMember?.captureId ?? ''}
                  onChange={(e) => setGraphMemberId(e.target.value)}
                  data-testid="topic-local-graph-select"
                >
                  {topic.members.map((member) => (
                    <option key={`${member.type}:${member.captureId}`} value={member.captureId}>
                      {TOPIC_MEMBER_TYPE_LABEL[member.type]} · {member.title}
                    </option>
                  ))}
                </select>
              </label>
              <Link
                className="btn small"
                to={graphHref}
                data-testid="topic-local-graph-open"
              >
                查看局部图
              </Link>
            </div>
          </div>
        </section>
      )}

      <TopicNextStep
        topic={topic}
        returnTo={currentTopicUrl}
        onTopicChange={(summary) => applyTopicSummary(summary)}
        onAttemptsChanged={() => void loadAttempts(true)}
      />

      <section className="section topic-members" aria-labelledby="topic-members-title">
        <div className="section-head topic-members-head">
          <div>
            <h2 id="topic-members-title">相关念头与经验</h2>
            <p className="hint">
              普通念头会聚合它下面的尝试；经验只作为经验成员，展示依据数与实践结果，不复制正文。
            </p>
          </div>
          <button
            type="button"
            className="btn small primary"
            onClick={() => setPickerOpen(true)}
            data-testid="topic-add-members"
          >
            加入记录
          </button>
        </div>

        <div className="topic-member-tabs" role="group" aria-label="成员类型">
          <button
            type="button"
            className={tab === 'thought' ? 'tab active' : 'tab'}
            aria-pressed={tab === 'thought'}
            onClick={() => setTab('thought')}
            data-testid="topic-members-tab-thought"
          >
            念头 {thoughtMembers.length}
          </button>
          <button
            type="button"
            className={tab === 'experience' ? 'tab active' : 'tab'}
            aria-pressed={tab === 'experience'}
            onClick={() => setTab('experience')}
            data-testid="topic-members-tab-experience"
          >
            经验 {experienceMembers.length}
          </button>
        </div>

        {shownMembers.length === 0 ? (
          <div className="empty-state">
            {tab === 'thought'
              ? '还没有普通念头成员。点「加入记录」把正在思考的念头放进来。'
              : '还没有经验成员。经验可以在经验详情里加入主题。'}
          </div>
        ) : (
          <ul className="topic-member-list" data-testid="topic-member-list">
            {shownMembers.map((member) => (
              <li
                className={`topic-member-card${member.archived ? ' is-archived' : ''}`}
                key={`${member.type}:${member.captureId}`}
                data-testid="topic-member-card"
              >
                <div className="topic-member-main">
                  <div className="topic-member-head">
                    <span className={`badge topic-type-${member.type}`}>
                      {TOPIC_MEMBER_TYPE_LABEL[member.type]}
                    </span>
                    {member.archived && <span className="badge">已归档</span>}
                    {member.type === 'experience' && (
                      <>
                        <span className="badge">
                          {member.sourceCount != null ? `${member.sourceCount} 条依据` : '依据数未知'}
                        </span>
                        <span className={`badge ${member.hasPracticeResult ? 'outcome-success' : 'warn'}`}>
                          {member.hasPracticeResult ? '已有实践结果' : '尚无实践结果'}
                        </span>
                        {member.needsRevision && <span className="badge warn">待核对</span>}
                      </>
                    )}
                  </div>
                  <h3 className="topic-member-title">{member.title}</h3>
                  {member.summary && member.summary !== member.title && (
                    <p className="topic-member-summary">{member.summary}</p>
                  )}
                  <p className="card-meta">
                    加入于 {formatTime(member.addedAt ?? member.createdAt)}
                    {member.updatedAt ? ` · 记录更新于 ${formatTime(member.updatedAt)}` : ''}
                  </p>
                </div>
                <div className="topic-member-actions">
                  <Link
                    className="btn small"
                    to={topicAwareHref(member.openHref ?? (member.type === 'experience' ? `/experience/${member.captureId}` : `/capture/${member.captureId}`), navContext)}
                    data-testid={member.type === 'experience' ? 'topic-member-experience-open' : 'topic-member-open'}
                  >
                    {member.type === 'experience' ? '查看经验' : '打开念头'}
                  </Link>
                  {member.type === 'experience' && (
                    <TopicEvidencePanel
                      topicId={topic.id}
                      experienceId={member.experienceId ?? member.captureId}
                      onAdd={(keys) => {
                        const params = new URLSearchParams({ topicId: topic.id, include: keys.join(',') });
                        if (topic.exploringQuestion?.trim()) params.set('q', topic.exploringQuestion.trim());
                        params.set('returnTo', currentTopicUrl);
                        navigate(`/ask?${params.toString()}`);
                      }}
                    />
                  )}
                  <button
                    type="button"
                    className="topic-member-remove"
                    onClick={() => setRemoveTarget(member)}
                    disabled={removingMember === member.captureId}
                    title="移出只解除集合关系，不删除原记录；如果固定下一步属于它，会一并清除"
                    data-testid="topic-member-remove"
                  >
                    {removingMember === member.captureId ? '移出中…' : '从主题移出'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section topic-attempts" aria-labelledby="topic-attempts-title">
        <div className="section-head">
          <div>
            <h2 id="topic-attempts-title">最近尝试</h2>
            <p className="hint">
              只聚合普通念头成员的尝试，按观察/创建时间由服务端排序；不在前端合并成员列表，避免重复。
            </p>
          </div>
          <label className="field-inline topic-attempt-filter">
            <span>状态</span>
            <select
              value={attemptFilter}
              onChange={(e) => setAttemptFilter(e.target.value as AttemptFilter)}
              data-testid="topic-attempt-filter"
            >
              {(Object.keys(ATTEMPT_FILTER_LABEL) as AttemptFilter[]).map((value) => (
                <option key={value} value={value}>
                  {ATTEMPT_FILTER_LABEL[value]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {attemptsLoading ? (
          <p className="muted loading-line" role="status">
            <span className="spinner" aria-hidden="true" /> 读取聚合尝试…
          </p>
        ) : attemptsError ? (
          <div role="alert">
            <p className="error-msg">{attemptsError}</p>
            <button type="button" className="btn small" onClick={() => void loadAttempts(true)}>
              重试
            </button>
          </div>
        ) : attempts.length === 0 ? (
          <div className="empty-state" data-testid="topic-attempts-empty">
            <p>
              {attemptFilter === 'all' && thoughtMembers.length === 0
                ? '还没有普通念头成员，因此没有可聚合的尝试。先加入一条念头，它下面的尝试会自动出现在这里。'
                : '这个筛选下没有尝试。无结果的尝试只会显示「等待记录结果」，不会被当作失败。'}
            </p>
            <div className="row-actions">
              {attemptFilter !== 'all' && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() => setAttemptFilter('all')}
                  data-testid="topic-attempts-clear-filter"
                >
                  查看全部尝试
                </button>
              )}
              {attemptFilter === 'all' && thoughtMembers.length === 0 && (
                <button
                  type="button"
                  className="btn small primary"
                  onClick={() => setPickerOpen(true)}
                  data-testid="topic-attempts-add-members"
                >
                  加入一条念头
                </button>
              )}
            </div>
          </div>
        ) : (
          <ul className="topic-attempt-list" data-testid="topic-attempts">
            {attempts.map((attempt) => {
              const display = topicAttemptDisplayState(attempt);
              return (
                <li className={`topic-attempt-card topic-attempt-${display}`} key={attempt.id} data-testid="topic-attempt-card">
                  <div className="topic-attempt-head">
                    <span
                      className={`badge topic-attempt-${display}`}
                      data-testid="topic-attempt-state"
                    >
                      {TOPIC_ATTEMPT_STATUS_LABEL[display]}
                    </span>
                    {attempt.outcome && (
                      <span className={`badge outcome-${attempt.outcome}`}>
                        {OUTCOME_LABEL[attempt.outcome]}
                      </span>
                    )}
                    {attempt.captureArchived && <span className="badge">念头已归档</span>}
                    <span className="topic-attempt-time">
                      {attempt.observedAt
                        ? `观察时间 ${formatTime(attempt.observedAt)}`
                        : `创建于 ${formatTime(attempt.createdAt)}`}
                    </span>
                  </div>
                  <p className="topic-attempt-step">{attempt.step}</p>
                  <p className="topic-attempt-capture">
                    所属念头：{attempt.captureText || '（不可用）'}
                  </p>
                  {attempt.resultText?.trim() ? (
                    <p className="topic-attempt-result">结果：{attempt.resultText}</p>
                  ) : (
                    <p className="topic-attempt-result muted">还没有记录结果</p>
                  )}
                  <div className="topic-attempt-actions">
                    <Link
                      className="btn small"
                      to={topicAwareHref(attempt.href ?? `/attempt/${attempt.id}`, navContext)}
                      data-testid="topic-attempt-open"
                    >
                      打开尝试
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {attemptHasMore && (
          <div className="topic-load-more">
            <button
              type="button"
              className="btn small"
              onClick={() => void loadAttempts(false)}
              disabled={attemptsLoadingMore}
              data-testid="topic-attempt-load-more"
            >
              {attemptsLoadingMore ? '加载中…' : '加载更多尝试'}
            </button>
            {attemptTotal != null && <span className="hint">共 {attemptTotal} 条</span>}
          </div>
        )}
        {!attemptHasMore && attemptTotal != null && attempts.length > 0 && (
          <p className="hint">已显示全部 {attemptTotal} 条尝试。</p>
        )}
      </section>

      <section className="topic-ask-entry" aria-labelledby="topic-ask-title">
        <div className="topic-ask-main">
          <p className="page-kicker">围绕这个主题提问</p>
          <h2 id="topic-ask-title">只在这个主题的范围里检索</h2>
          <p className="hint">
            默认只含成员普通念头及直接尝试；主题说明和继续备注不会自动发给模型。经验依据需要在提问页手动加入。
          </p>
        </div>
        <Link className="btn primary" to={askHref} data-testid="topic-ask-entry">
          围绕这个主题提问
        </Link>
      </section>

      {pickerOpen && (
        <TopicMemberPicker
          topicId={topic.id}
          open={pickerOpen}
          existingIds={topic.members.map((member) => member.captureId)}
          onClose={() => setPickerOpen(false)}
          onAdded={handleAdded}
        />
      )}

      {exportOpen && (
        <TopicExportPanel
          topicId={topic.id}
          topicName={topic.name}
          onClose={() => setExportOpen(false)}
          onDownloaded={(message) => setNotice(message)}
        />
      )}

      {removeTarget && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="移出成员"
            data-testid="topic-member-remove-confirm"
          >
            <div className="modal-head">
              <h3>把「{removeTarget.title}」从主题移出？</h3>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setRemoveTarget(null)}
                disabled={removingMember === removeTarget.captureId}
                aria-label="取消移出"
              >
                ×
              </button>
            </div>
            <p className="topic-delete-emphasis">
              只解除这条记录与主题的集合关系；<strong>不删除念头、经验、尝试或日程</strong>。
            </p>
            <ul className="delete-preview-list">
              <li>记录本身和它的正文、尝试、结果都保留，可以随时再加回来。</li>
              <li>
                {removeTarget.type === 'experience'
                  ? '这条经验的依据记录不会被改动，也不会从经验里移除。'
                  : '这条念头下的尝试不再出现在本主题的尝试列表里。'}
              </li>
              {topic.nextAttempt &&
                (topic.nextAttempt.captureId === removeTarget.captureId ||
                  removeTarget.type === 'thought') && (
                  <li>
                    若固定的下一步属于这条记录，移出后会一并清除固定（尝试本身保留）。
                  </li>
                )}
            </ul>
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setRemoveTarget(null)}
                disabled={removingMember === removeTarget.captureId}
              >
                取消
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => void removeMember(removeTarget)}
                disabled={removingMember === removeTarget.captureId}
                data-testid="topic-member-remove-confirm-ok"
              >
                {removingMember === removeTarget.captureId ? '移出中…' : '移出主题'}
              </button>
            </div>
          </section>
        </div>
      )}

      {deleteOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-label="删除主题">
            <div className="modal-head">
              <h3>删除主题「{topic.name}」？</h3>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setDeleteOpen(false)}
                disabled={deleting}
                aria-label="取消删除"
              >
                ×
              </button>
            </div>
            <p className="topic-delete-emphasis">
              只删除主题和成员关系；<strong>不会删除念头、经验、尝试或日程</strong>。归档也不会级联删除。
            </p>
            {deleteLoading ? (
              <p className="muted loading-line" role="status">
                <span className="spinner" aria-hidden="true" /> 读取删除影响…
              </p>
            ) : deleteError ? (
              <div role="alert">
                <p className="error-msg">{deleteError}</p>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => void openDelete()}
                  disabled={deleting}
                >
                  重试读取影响
                </button>
              </div>
            ) : deletePreview ? (
              <ul className="delete-preview-list">
                <li>成员关系 {deletePreview.memberCount} 条：只解除集合关系。</li>
                <li>念头 {deletePreview.thoughtCount} 条、经验 {deletePreview.experienceCount} 条：全部保留。</li>
                <li>这些念头下的尝试 {deletePreview.attemptCount} 次及日程：全部保留。</li>
                {deletePreview.nextAttemptStep && (
                  <li>固定的下一步「{deletePreview.nextAttemptStep}」继续保留为普通尝试。</li>
                )}
              </ul>
            ) : null}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setDeleteOpen(false)} disabled={deleting}>
                取消
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => void confirmDelete()}
                disabled={deleting || deleteLoading || !deletePreview}
                title={!deletePreview ? '先读取删除影响再确认删除' : undefined}
                data-testid="topic-delete-confirm"
              >
                {deleting ? '正在删除…' : '只删除主题'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
