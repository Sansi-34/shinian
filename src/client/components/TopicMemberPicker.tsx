// 主题成员选择器：按关键词搜索念头/经验，多选加入且重复不产生重复。
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { ApiError } from '../api';
import type {
  AddTopicMembersResponse,
  TopicCandidate,
  TopicMemberCandidatesResponse,
  TopicMemberType,
} from '../types';
import { TOPIC_MEMBER_TYPE_LABEL, formatTime, newOperationId, topicErrorText } from '../types';

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.body?.message || topicErrorText(e.body?.error, fallback);
  if (e instanceof TypeError) return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

type Props = {
  topicId: string;
  open: boolean;
  existingIds?: string[];
  onClose: () => void;
  onAdded: (result: AddTopicMembersResponse) => void;
};

export default function TopicMemberPicker({ topicId, open, existingIds = [], onClose, onAdded }: Props) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'all' | TopicMemberType>('all');
  const [data, setData] = useState<TopicMemberCandidatesResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const operationRef = useRef(newOperationId());
  const searchRef = useRef<HTMLInputElement>(null);
  const existing = new Set(existingIds);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setType('all');
    setSelected(new Set());
    setError(null);
    setNotice(null);
    void load('', 'all', null);
    requestAnimationFrame(() => searchRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, topicId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !adding) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, adding, onClose]);

  async function load(q: string, nextType: 'all' | TopicMemberType, cursor: string | null) {
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await api.listTopicMemberCandidates(topicId, {
        q,
        type: nextType,
        cursor,
        limit: 20,
      });
      setData((prev) =>
        cursor && prev
          ? { ...res, candidates: [...prev.candidates, ...res.candidates] }
          : res
      );
    } catch (e) {
      setError(errorText(e, '读取可加入的记录失败'));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    void load(query, type, null);
  }

  function changeType(nextType: 'all' | TopicMemberType) {
    setType(nextType);
    setSelected(new Set());
    void load(query, nextType, null);
  }

  function toggle(candidate: TopicCandidate) {
    if (candidate.alreadyMember || existing.has(candidate.captureId)) return;
    const next = new Set(selected);
    if (next.has(candidate.captureId)) next.delete(candidate.captureId);
    else next.add(candidate.captureId);
    setSelected(next);
    setNotice(null);
  }

  async function submit() {
    if (selected.size === 0 || adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await api.addTopicMembers(topicId, {
        captureIds: [...selected],
        operationId: operationRef.current,
      });
      operationRef.current = newOperationId();
      onAdded(res);
      onClose();
    } catch (e) {
      const code = e instanceof ApiError ? e.body?.error : null;
      if (code === 'duplicate_topic_member') {
        setNotice('选中的记录已经在主题里了，没有产生重复。');
        void load(query, type, null);
      } else {
        setError(errorText(e, '加入主题失败，请重试'));
      }
    } finally {
      setAdding(false);
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop topic-picker-backdrop" role="presentation">
      <section
        className="modal wide topic-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="topic-picker-title"
      >
        <div className="modal-head">
          <div>
            <h3 id="topic-picker-title">加入记录</h3>
            <p className="modal-sub">
              搜索已有的念头或经验，多选后加入主题。不会复制正文，也不会改动原记录。
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} disabled={adding} aria-label="关闭">
            ×
          </button>
        </div>

        <form className="topic-picker-search" role="search" onSubmit={submitSearch}>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按关键词搜索念头或经验…"
            aria-label="搜索要加入主题的记录"
          />
          <button type="submit" className="btn" disabled={loading}>
            {loading ? '搜索中…' : '搜索'}
          </button>
        </form>

        <div className="topic-picker-tabs" role="group" aria-label="记录类型">
          {(
            [
              ['all', '全部'],
              ['thought', '念头'],
              ['experience', '经验'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={type === value ? 'tab active' : 'tab'}
              aria-pressed={type === value}
              onClick={() => changeType(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <p className="hint" role="status" aria-live="polite">
          已选 {selected.size} 条{data ? ` · 共找到 ${data.total} 条` : ''}
        </p>
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

        {loading ? (
          <p className="muted loading-line" role="status">
            <span className="spinner" aria-hidden="true" /> 正在读取可加入的记录…
          </p>
        ) : !data || data.candidates.length === 0 ? (
          <div className="empty-state">
            {query.trim() ? (
              <p>没有找到匹配的记录。可以换个关键词，或把类型切到「全部」再查。</p>
            ) : (
              <>
                <p>还没有可以加入的记录。主题只集合已有的念头和经验，先有一条自己的记录。</p>
                <Link to="/" className="btn small" onClick={onClose}>
                  去写一条念头
                </Link>
              </>
            )}
          </div>
        ) : (
          <ul className="topic-picker-list">
            {data.candidates.map((candidate) => {
              const already = candidate.alreadyMember || existing.has(candidate.captureId);
              const picked = selected.has(candidate.captureId);
              return (
                <li key={`${candidate.type}:${candidate.captureId}`}>
                  <label
                    className={`topic-check-row${already ? ' is-existing' : ''}`}
                    title={already ? '已在主题中' : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={already || picked}
                      disabled={already}
                      onChange={() => toggle(candidate)}
                      aria-label={`${already ? '已在主题中：' : '选择'}${candidate.title}`}
                    />
                    <span className="topic-check-main">
                      <span className="topic-check-head">
                        <span className={`badge topic-type-${candidate.type}`}>
                          {TOPIC_MEMBER_TYPE_LABEL[candidate.type]}
                        </span>
                        {candidate.archived && <span className="badge">已归档</span>}
                        {candidate.needsRevision && <span className="badge warn">待核对</span>}
                        {already && <span className="badge">已在主题中</span>}
                      </span>
                      <strong>{candidate.title}</strong>
                      <span className="topic-check-summary">{candidate.summary || '（无摘要）'}</span>
                      <span className="topic-check-meta">
                        {formatTime(candidate.createdAt)}
                        {candidate.type === 'experience' && candidate.sourceCount != null
                          ? ` · ${candidate.sourceCount} 条依据`
                          : ''}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        {data?.nextCursor && (
          <div className="topic-load-more">
            <button
              type="button"
              className="btn small"
              disabled={loadingMore}
              onClick={() => void load(query, type, data.nextCursor)}
            >
              {loadingMore ? '加载中…' : '加载更多'}
            </button>
          </div>
        )}

        <div className="modal-actions topic-picker-actions">
          <button type="button" className="btn" onClick={onClose} disabled={adding}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void submit()}
            disabled={selected.size === 0 || adding}
          >
            {adding ? '正在加入…' : `加入 ${selected.size} 条记录`}
          </button>
        </div>
      </section>
    </div>
  );
}
