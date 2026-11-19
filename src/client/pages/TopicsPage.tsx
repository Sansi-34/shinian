// 主题列表：直接链接可刷新；新建、归档筛选、加载更多与删除预览。
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api, { ApiError } from '../api';
import type { Topic, TopicDeletePreview } from '../types';
import { formatTime, newOperationId, topicErrorText } from '../types';

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.body?.message || topicErrorText(e.body?.error, fallback);
  if (e instanceof TypeError) return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

type ArchiveFilter = 'active' | 'archived';

export default function TopicsPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<ArchiveFilter>('active');
  const [topics, setTopics] = useState<Topic[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [question, setQuestion] = useState('');
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const operationRef = useRef(newOperationId());
  const nameRef = useRef<HTMLInputElement>(null);

  const [deleteTarget, setDeleteTarget] = useState<Topic | null>(null);
  const [deletePreview, setDeletePreview] = useState<TopicDeletePreview | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function load(reset: boolean) {
    if (reset) {
      setLoading(true);
      setOffset(0);
    } else {
      setLoadingMore(true);
    }
    setError(null);
    try {
      const res = await api.listTopics({
        archived: filter === 'archived' ? 'only' : 'exclude',
        limit: 20,
        offset: reset ? 0 : offset,
      });
      setTopics((prev) => (reset ? res.topics : [...prev, ...res.topics]));
      setTotal(res.total);
      setHasMore(res.hasMore);
      setOffset((reset ? 0 : offset) + res.topics.length);
    } catch (e) {
      setError(errorText(e, '主题列表加载失败'));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  async function createTopic(e: React.FormEvent) {
    e.preventDefault();
    const title = name.trim();
    if (!title || creating) {
      if (!title) nameRef.current?.focus();
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await api.createTopic({
        name: title,
        exploringQuestion: question.trim() || null,
        continueNote: note.trim() || null,
        operationId: operationRef.current,
      });
      operationRef.current = newOperationId();
      setName('');
      setQuestion('');
      setNote('');
      setCreateOpen(false);
      navigate(`/topics/${res.topic.id}`);
    } catch (err) {
      setCreateError(errorText(err, '新建主题失败，请重试'));
    } finally {
      setCreating(false);
    }
  }

  async function openDelete(topic: Topic) {
    setDeleteTarget(topic);
    setDeletePreview(null);
    setDeleteError(null);
    setDeleteLoading(true);
    try {
      setDeletePreview(await api.getTopicDeletePreview(topic.id));
    } catch (e) {
      setDeleteError(errorText(e, '读取删除影响失败'));
    } finally {
      setDeleteLoading(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteTopic(deleteTarget.id);
      setTopics((prev) => prev.filter((topic) => topic.id !== deleteTarget.id));
      setDeleteTarget(null);
      setDeletePreview(null);
      if (topics.length === 1 && hasMore) void load(false);
    } catch (e) {
      setDeleteError(errorText(e, '删除主题失败'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="page topics-page" data-testid="topics-page">
      {/* 入场编排：标题带 → 筛选 → 列表（.gz-enter 实现见 ui-motion.css） */}
      <header
        className="topics-head gz-enter"
        style={{ ['--gz-enter-step' as string]: 0 } as React.CSSProperties}
      >
        <div>
          <p className="page-kicker">主题</p>
          <h1 className="page-title">把散落的记录收在一个问题下</h1>
          <p className="page-subtitle">
            主题只集合已有的念头、经验与尝试，不复制正文；归档或删除主题都不会删除原记录。
          </p>
        </div>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            setCreateOpen((value) => !value);
            setCreateError(null);
            requestAnimationFrame(() => nameRef.current?.focus());
          }}
          aria-expanded={createOpen}
          data-testid="topic-create-toggle"
        >
          {createOpen ? '收起新建表单' : '新建主题'}
        </button>
      </header>

      {createOpen && (
        <section className="section topic-create-section" aria-labelledby="topic-create-title">
          <div className="section-head">
            <h2 id="topic-create-title">新建主题</h2>
            <span className="hint">只有名称必填；探索问题和继续备注都可以以后补。</span>
          </div>
          <form className="topic-create-form" onSubmit={createTopic}>
            <label className="field">
              <span>主题名称（必填）</span>
              <input
                ref={nameRef}
                type="text"
                value={name}
                maxLength={120}
                required
                onChange={(e) => setName(e.target.value)}
                placeholder="例如「PWM 调光实验」"
                data-testid="topic-create-name"
              />
            </label>
            <label className="field">
              <span>正在探索的问题（选填）</span>
              <textarea
                rows={2}
                value={question}
                maxLength={1000}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="这个主题想弄清楚什么？例如「不同频率下 LED 是否可见闪烁？」"
                data-testid="topic-create-question"
              />
            </label>
            <label className="field">
              <span>继续备注（选填）</span>
              <textarea
                rows={2}
                value={note}
                maxLength={1000}
                onChange={(e) => setNote(e.target.value)}
                placeholder="下次继续时先看什么、注意什么…"
                data-testid="topic-create-note"
              />
            </label>
            {createError && (
              <p className="error-msg" role="alert">
                {createError}
              </p>
            )}
            <div className="row-actions">
              <button
                type="submit"
                className="btn primary"
                disabled={!name.trim() || creating}
                data-testid="topic-create-submit"
              >
                {creating ? '创建中…' : '创建并打开'}
              </button>
              <button type="button" className="btn" onClick={() => setCreateOpen(false)} disabled={creating}>
                取消
              </button>
            </div>
          </form>
        </section>
      )}

      <nav
        className="list-tabs gz-enter"
        style={{ ['--gz-enter-step' as string]: 1 } as React.CSSProperties}
        aria-label="主题归档筛选"
      >
        <button
          type="button"
          className={filter === 'active' ? 'tab active' : 'tab'}
          aria-pressed={filter === 'active'}
          onClick={() => setFilter('active')}
          data-testid="topic-filter-active"
        >
          进行中
        </button>
        <button
          type="button"
          className={filter === 'archived' ? 'tab active' : 'tab'}
          aria-pressed={filter === 'archived'}
          onClick={() => setFilter('archived')}
          data-testid="topic-filter-archived"
        >
          已归档
        </button>
        <span className="topic-count-note">
          {total != null ? `共 ${total} 个主题` : ''}
        </span>
      </nav>

      {loading ? (
        <p className="muted loading-line" role="status">
          <span className="spinner" aria-hidden="true" /> 正在读取主题…
        </p>
      ) : error ? (
        <div role="alert">
          <p className="error-msg">{error}</p>
          <button type="button" className="btn small" onClick={() => void load(true)}>
            重试
          </button>
        </div>
      ) : topics.length === 0 ? (
        <div className="empty-state topic-empty">
          <p>{filter === 'archived' ? '还没有归档的主题。' : '还没有主题。把正在探索的问题收在一起吧。'}</p>
          {filter === 'active' && (
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                setCreateOpen(true);
                requestAnimationFrame(() => nameRef.current?.focus());
              }}
            >
              新建第一个主题
            </button>
          )}
        </div>
      ) : (
        <>
          {/* 列表会「加载更多」追加子项，所以只在容器上做单块入场，不给子元素错峰 */}
          <ul
            className="topic-list gz-enter"
            style={{ ['--gz-enter-step' as string]: 2 } as React.CSSProperties}
            data-testid="topic-list"
          >
            {topics.map((topic) => (
              <li className={`topic-card${topic.archived ? ' is-archived' : ''}`} key={topic.id} data-testid="topic-card">
                <div className="topic-card-main">
                  <div className="topic-card-title-row">
                    <Link to={`/topics/${topic.id}`} className="topic-card-title" data-testid="topic-card-open">
                      {topic.name}
                    </Link>
                    {topic.archived && <span className="badge">已归档</span>}
                  </div>
                  <p className="topic-card-question">
                    {topic.exploringQuestion?.trim()
                      ? topic.exploringQuestion
                      : '还没有写下正在探索的问题。'}
                  </p>
                  <div className="topic-card-meta">
                    <span>{topic.memberCount} 个成员</span>
                    <span>
                      最近尝试：
                      {topic.lastAttemptAt ? formatTime(topic.lastAttemptAt) : '还没有尝试'}
                    </span>
                  </div>
                  <p className="topic-card-next">
                    <span className="topic-card-next-label">下次继续</span>
                    {topic.nextAttempt ? (
                      <span>
                        {topic.nextAttempt.step}
                        {topic.nextAttempt.captureText ? ` · ${topic.nextAttempt.captureText}` : ''}
                      </span>
                    ) : (
                      <span className="muted">
                        {topic.nextAttemptClearedReason ? '原固定尝试已失效，待重选' : '还没有固定'}
                      </span>
                    )}
                  </p>
                </div>
                <div className="topic-card-actions">
                  <Link className="btn small" to={`/topics/${topic.id}`}>
                    打开主题
                  </Link>
                  <button
                    type="button"
                    className="btn small danger-outline"
                    onClick={() => void openDelete(topic)}
                    data-testid="topic-delete-open"
                  >
                    删除…
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {hasMore && (
            <div className="topic-load-more">
              <button
                type="button"
                className="btn"
                onClick={() => void load(false)}
                disabled={loadingMore}
                data-testid="topic-load-more"
              >
                {loadingMore ? '加载中…' : '加载更多主题'}
              </button>
            </div>
          )}
        </>
      )}

      {deleteTarget && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-label="删除主题">
            <div className="modal-head">
              <h3>删除主题「{deleteTarget.name}」？</h3>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                aria-label="取消删除"
              >
                ×
              </button>
            </div>
            <p className="topic-delete-emphasis">
              只删除主题和它的成员关系；<strong>不会删除任何念头、经验、尝试或日程</strong>。
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
                  onClick={() => deleteTarget && void openDelete(deleteTarget)}
                  disabled={deleting}
                >
                  重试读取影响
                </button>
              </div>
            ) : deletePreview ? (
              <ul className="delete-preview-list">
                <li>主题成员 {deletePreview.memberCount} 条：只解除与主题的集合关系，原记录全部保留。</li>
                <li>普通念头 {deletePreview.thoughtCount} 条、经验 {deletePreview.experienceCount} 条：都不会被删除。</li>
                <li>这些念头下的尝试 {deletePreview.attemptCount} 次：尝试、结果和日程都保留。</li>
                {deletePreview.nextAttemptStep && (
                  <li>固定的下一步「{deletePreview.nextAttemptStep}」也保留为普通尝试。</li>
                )}
                <li>归档不会随删除级联；删除后无法恢复这个主题本身。</li>
              </ul>
            ) : null}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setDeleteTarget(null)} disabled={deleting}>
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
