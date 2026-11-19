// 拾念 SHINIAN · 「问我的记录」详情：保存的提问、回答与来源
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api, { ApiError } from '../api';
import type { AskPublic } from '../types';
import { ASK_STATUS_LABEL, askErrorText, formatTime } from '../types';
import AskAnswerView, {
  AskSourcesView,
  askFailureNeedsConfig,
  askFailureText,
} from '../components/AskAnswer';

/** 与问答首页一致：轮询连续失败到上限就停下，交给用户决定是否继续。 */
const ASK_POLL_MAX_ERRORS = 6;

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    return e.body?.message || askErrorText(e.body?.error, fallback);
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

export default function AskDetailPage() {
  const { queryId = '' } = useParams<{ queryId: string }>();
  const [query, setQuery] = useState<AskPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollPaused, setPollPaused] = useState(false);
  const [pollResumeTick, setPollResumeTick] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!queryId) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getAskQuery(queryId);
      setQuery(res.query);
    } catch (e) {
      setError(errorMessage(e, '无法读取这次问答'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!query || query.status !== 'pending') return;
    let disposed = false;
    let timer: number | undefined;
    let failures = 0;
    setPollPaused(false);
    const tick = async () => {
      try {
        const res = await api.getAskQuery(query.id);
        if (disposed) return;
        setQuery(res.query);
        setPollError(null);
        failures = 0;
        if (res.query.status === 'pending') {
          timer = window.setTimeout(tick, 1000);
        }
      } catch (e) {
        if (disposed) return;
        if (e instanceof ApiError && e.status === 404) {
          setPollError('这次提问已不存在，无法继续获取回答。');
          setPollPaused(true);
          return;
        }
        failures += 1;
        if (failures >= ASK_POLL_MAX_ERRORS) {
          setPollError(
            `已连续 ${failures} 次无法获取回答进度，自动刷新已暂停。可以点「继续刷新」重试，或稍后重新打开这个页面。`
          );
          setPollPaused(true);
          return;
        }
        setPollError(
          `${errorMessage(e, '暂时无法获取回答进度')}（第 ${failures}/${ASK_POLL_MAX_ERRORS} 次重试，正在自动重试…）`
        );
        timer = window.setTimeout(tick, 2000);
      }
    };
    timer = window.setTimeout(tick, 1000);
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query?.id, query?.status, pollResumeTick]);

  async function cancelQuery() {
    if (!query || cancelling) return;
    setCancelling(true);
    setActionError(null);
    try {
      const res = await api.cancelAskQuery(query.id);
      setQuery(res.query);
      setPollError(null);
    } catch (e) {
      const code = e instanceof ApiError ? e.body?.error : null;
      if (code === 'not_cancellable') {
        try {
          const res = await api.getAskQuery(query.id);
          setQuery(res.query);
          setActionError('这次提问已经结束，无法取消，已刷新最新状态。');
        } catch {
          setActionError('这次提问已经结束，无法取消。');
        }
      } else {
        setActionError(errorMessage(e, '取消失败，请重试'));
      }
    } finally {
      setCancelling(false);
    }
  }

  if (loading) {
    return (
      <div className="page ask-detail">
        <p className="muted loading-line" role="status">
          <span className="spinner" aria-hidden="true" /> 正在读取问答…
        </p>
      </div>
    );
  }

  if (!query) {
    return (
      <div className="page ask-detail">
        <div className="crumb">
          <Link to="/ask">← 返回问我的记录</Link>
        </div>
        <h1 className="page-title">这次问答</h1>
        <div className="empty-state" role="alert">
          {error || '这次提问不存在或已被删除。'}
        </div>
        <div className="row-actions">
          <button type="button" className="btn" onClick={() => void load()}>
            重试
          </button>
          <Link className="btn" to="/ask">
            去提问
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page ask-detail">
      <div className="crumb">
        <Link to="/ask">← 返回问我的记录</Link>
      </div>

      <header className="ask-detail-head">
        <div>
          <p className="page-kicker">问我的记录</p>
          <h1 className="page-title">这次问答</h1>
          <p className="page-subtitle">
            创建于 {formatTime(query.createdAt)} · {ASK_STATUS_LABEL[query.status]}
            {query.finishedAt != null ? ` · 完成于 ${formatTime(query.finishedAt)}` : ''}
          </p>
        </div>
        <span className={`badge ask-status-${query.status}`}>{ASK_STATUS_LABEL[query.status]}</span>
      </header>

      {query.status === 'pending' && (
        <div className="ask-status-card pending" aria-live="polite">
          <div className="ask-status-head">
            <h3>
              <span className="spinner" aria-hidden="true" /> 正在回答…
            </h3>
            <span className="badge">{ASK_STATUS_LABEL.pending}</span>
          </div>
          <p className="ask-detail-question">{query.question}</p>
          <p>
            目标模型：
            {query.config ? `${query.config.name} · ${query.config.modelId}` : '未记录'}
          </p>
          <p>来源 {query.sources.length} 条 · 状态每秒自动刷新</p>
          {pollError && <p className="error-msg">{pollError}</p>}
          {actionError && <p className="error-msg">{actionError}</p>}
          <div className="row-actions">
            <button
              type="button"
              className="btn"
              onClick={() => void cancelQuery()}
              disabled={cancelling || !query.canCancel}
            >
              {cancelling ? '取消中…' : '取消'}
            </button>
            {pollPaused && (
              <button
                type="button"
                className="btn"
                data-testid="ask-poll-resume"
                onClick={() => {
                  setPollPaused(false);
                  setPollError(null);
                  setPollResumeTick((tick) => tick + 1);
                }}
              >
                继续刷新
              </button>
            )}
          </div>
        </div>
      )}

      {query.status === 'succeeded' && query.answer && <AskAnswerView key={query.id} query={query} />}

      {query.status === 'succeeded' && !query.answer && (
        <div className="ask-status-card failed" role="alert">
          <h3>这次提问没有可显示的回答</h3>
          <p className="error-msg">回答内容为空或已不可用；下面仍可浏览发送时的来源记录。</p>
          <AskSourcesView query={query} />
        </div>
      )}

      {(query.status === 'failed' ||
        query.status === 'cancelled' ||
        query.status === 'interrupted') && (
        <div className={`ask-status-card ${query.status}`} role="alert">
          <div className="ask-status-head">
            <h3>这次提问没有完成</h3>
            <span className="badge">{ASK_STATUS_LABEL[query.status]}</span>
          </div>
          <p className="ask-detail-question">{query.question}</p>
          <p>
            <strong>{askFailureText(query.errorCode, '生成失败')}</strong>
          </p>
          {query.errorMessage && <p className="gen-error-detail">{query.errorMessage}</p>}
          <p className="hint">
            问题、目标模型与发送时的来源快照仍可查看；来源正文按发送时记录展示。
          </p>
          {pollError && <p className="error-msg">{pollError}</p>}
          {actionError && <p className="error-msg">{actionError}</p>}
          <AskSourcesView query={query} />
          <div className="row-actions">
            <Link className="btn primary" to="/ask">
              修改后重试
            </Link>
            {askFailureNeedsConfig(query.errorCode) && (
              <Link className="btn" to="/settings/ai">
                去设置模型
              </Link>
            )}
          </div>
        </div>
      )}

      <div className="row-actions ask-detail-actions">
        <Link className="btn" to="/ask">
          返回问我的记录
        </Link>
        <Link className="btn" to="/settings/ai">
          AI 设置
        </Link>
      </div>
    </div>
  );
}
