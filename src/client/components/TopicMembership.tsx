// 记录详情里的「所属主题」：显示主题 chips、移出、加入已有主题或新建主题后加入。
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { ApiError } from '../api';
import type { CaptureTopic, Topic } from '../types';
import { newOperationId, topicErrorText } from '../types';

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.body?.message || topicErrorText(e.body?.error, fallback);
  if (e instanceof TypeError) return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

type Props = {
  captureId: string;
  /** 可选：从主题打开时用于给主题链接带上返回路径 */
  returnTo?: string | null;
};

export default function TopicMembership({ captureId, returnTo }: Props) {
  const [topics, setTopics] = useState<CaptureTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [available, setAvailable] = useState<Topic[]>([]);
  const [availableLoading, setAvailableLoading] = useState(false);
  const [availableError, setAvailableError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newQuestion, setNewQuestion] = useState('');
  const [creating, setCreating] = useState(false);
  const operationRef = useRef(newOperationId());
  const createOperationRef = useRef(newOperationId());

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getCaptureTopics(captureId);
      setTopics(res.topics);
    } catch (e) {
      setError(errorText(e, '暂时无法读取所属主题'));
    } finally {
      setLoading(false);
    }
  }

  async function openPanel() {
    setPanelOpen(true);
    setNotice(null);
    setAvailableError(null);
    setAvailableLoading(true);
    try {
      const res = await api.listTopics({ limit: 100 });
      setAvailable(res.topics.filter((topic) => !topic.archived));
    } catch (e) {
      setAvailableError(errorText(e, '读取主题列表失败'));
    } finally {
      setAvailableLoading(false);
    }
  }

  async function removeFromTopic(topic: CaptureTopic) {
    if (busy) return;
    setBusy(true);
    setRemoving(topic.id);
    setError(null);
    setNotice(null);
    try {
      await api.removeTopicMember(topic.id, captureId);
      setTopics((prev) => prev.filter((item) => item.id !== topic.id));
      setConfirmingId(null);
      setNotice(`已从主题「${topic.name}」移出；原记录没有被删除。`);
    } catch (e) {
      setError(errorText(e, '移出主题失败'));
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  }

  async function addToTopics() {
    if (picked.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.addCaptureTopics(captureId, {
        topicIds: [...picked],
        operationId: operationRef.current,
      });
      operationRef.current = newOperationId();
      setNotice(
        `已加入 ${res.added} 个主题${res.skipped > 0 ? `，${res.skipped} 个已存在` : ''}。`
      );
      setPicked(new Set());
      setPanelOpen(false);
      await load();
    } catch (e) {
      setError(errorText(e, '加入主题失败'));
    } finally {
      setBusy(false);
    }
  }

  async function createAndJoin() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.createTopic({
        name,
        exploringQuestion: newQuestion.trim() || null,
        operationId: createOperationRef.current,
      });
      createOperationRef.current = newOperationId();
      await api.addCaptureTopics(captureId, {
        topicIds: [created.topic.id],
        operationId: newOperationId(),
      });
      setNewName('');
      setNewQuestion('');
      setNotice(`已新建主题「${created.topic.name}」并把这条记录加入。`);
      setPanelOpen(false);
      await load();
    } catch (e) {
      setError(errorText(e, '新建主题失败'));
    } finally {
      setCreating(false);
    }
  }

  const existingIds = new Set(topics.map((topic) => topic.id));
  const candidates = available.filter((topic) => !existingIds.has(topic.id));

  return (
    <section className="section record-topics" aria-label="所属主题">
      <div className="section-head">
        <h3>所属主题</h3>
        <button
          type="button"
          className="btn small"
          onClick={() => (panelOpen ? setPanelOpen(false) : void openPanel())}
          aria-expanded={panelOpen}
        >
          {panelOpen ? '收起' : '加入主题'}
        </button>
      </div>
      <p className="hint">
        主题只是把记录放在一起探索；加入或移出都不复制正文，也不删除念头、经验、尝试或日程。
      </p>
      {loading ? (
        <p className="muted loading-line" role="status">
          <span className="spinner" aria-hidden="true" /> 读取所属主题…
        </p>
      ) : topics.length === 0 ? (
        <p className="muted">还没有加入任何主题。</p>
      ) : (
        <ul className="topic-chip-list" aria-label="所属主题列表">
          {topics.map((topic) => (
            <li key={topic.id} className="topic-chip">
              <Link
                to={`/topics/${topic.id}${
                  returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''
                }`}
              >
                {topic.name}
              </Link>
              {topic.archived && <span className="badge">已归档</span>}
              {confirmingId === topic.id ? (
                <>
                  <span className="hint">移出后原记录保留</span>
                  <button
                    type="button"
                    className="topic-chip-remove"
                    onClick={() => void removeFromTopic(topic)}
                    disabled={busy}
                    data-testid="topic-chip-remove-confirm-ok"
                  >
                    {removing === topic.id ? '移出中…' : '确定移出'}
                  </button>
                  <button
                    type="button"
                    className="topic-chip-remove"
                    onClick={() => setConfirmingId(null)}
                    disabled={busy}
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="topic-chip-remove"
                  onClick={() => setConfirmingId(topic.id)}
                  disabled={busy}
                  aria-label={`从主题「${topic.name}」移出`}
                >
                  移出
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <p className="save-ok" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-msg" role="alert">
          {error}
        </p>
      )}

      {panelOpen && (
        <div className="record-topics-panel" role="region" aria-label="加入主题">
          <h4>加入已有主题</h4>
          {availableLoading ? (
            <p className="muted loading-line" role="status">
              <span className="spinner" aria-hidden="true" /> 读取主题…
            </p>
          ) : availableError ? (
            <p className="error-msg" role="alert">
              {availableError}
            </p>
          ) : candidates.length === 0 ? (
            <p className="muted">还没有可加入的主题，可以在下面新建一个。</p>
          ) : (
            <>
              <ul className="record-topic-options">
                {candidates.map((topic) => (
                  <li key={topic.id}>
                    <label className="topic-check-row">
                      <input
                        type="checkbox"
                        checked={picked.has(topic.id)}
                        onChange={() => {
                          const next = new Set(picked);
                          if (next.has(topic.id)) next.delete(topic.id);
                          else next.add(topic.id);
                          setPicked(next);
                        }}
                      />
                      <span className="topic-check-main">
                        <strong>{topic.name}</strong>
                        <span className="topic-check-meta">
                          {topic.memberCount} 个成员
                          {topic.exploringQuestion ? ` · ${topic.exploringQuestion}` : ''}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn primary small"
                  onClick={() => void addToTopics()}
                  disabled={picked.size === 0 || busy}
                >
                  {busy ? '正在加入…' : `加入选中的 ${picked.size} 个主题`}
                </button>
              </div>
            </>
          )}

          <div className="record-topic-create">
            <h4>新建主题并加入</h4>
            <label className="field">
              <span>主题名称（必填）</span>
              <input
                type="text"
                value={newName}
                maxLength={80}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="例如「LED 低占空比闪烁」"
              />
            </label>
            <label className="field">
              <span>正在探索的问题（选填）</span>
              <textarea
                rows={2}
                value={newQuestion}
                maxLength={500}
                onChange={(e) => setNewQuestion(e.target.value)}
                placeholder="这个主题想弄清楚什么？"
              />
            </label>
            <div className="row-actions">
              <button
                type="button"
                className="btn primary small"
                onClick={() => void createAndJoin()}
                disabled={!newName.trim() || creating}
              >
                {creating ? '正在创建…' : '新建主题并加入'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
