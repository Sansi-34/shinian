// 拾念 V2 · 单次问答详情（/ask/:queryId）
// 只读视图：问题、状态、答案、依据记录；生成中的自动轮询并可取消；左栏保留历史列表便于切换。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import api from '../api';
import type { AskListItem, AskPublic } from '../types';
import { readTopicNav, safeTopicReturnTo, topicAwareHref } from '../components/topicNav';
import { todayDateKey, useDisplayTimezone } from '../scheduleTime';
import { dayLabel, dayTimeLabel } from './format';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Pill, { type StatusKind } from './ui/Pill';
import Button from './ui/Button';
import Spinner from './ui/Spinner';
import AskAnswerView from './ui/AskAnswerView';
import './shared.css';

const STATUS: Record<string, { kind: StatusKind; label: string }> = {
  pending: { kind: 'active', label: '生成中' },
  succeeded: { kind: 'done', label: '已生成' },
  failed: { kind: 'fail', label: '生成失败' },
  cancelled: { kind: 'idle', label: '已取消' },
  interrupted: { kind: 'partial', label: '已中断' },
};

export default function AskV2DetailPage() {
  const { queryId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const topicNav = useMemo(() => readTopicNav(searchParams), [searchParams]);
  const returnTo = useMemo(
    () => safeTopicReturnTo(searchParams.get('returnTo')) ?? topicNav.returnTo,
    [searchParams, topicNav.returnTo]
  );
  const [tz] = useDisplayTimezone();
  const [query, setQuery] = useState<AskPublic | null>(null);
  const [recent, setRecent] = useState<AskListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<number | null>(null);

  const loadRecent = useCallback(async () => {
    try {
      const res = await api.listAskQueries(12);
      setRecent(res.queries ?? []);
    } catch {
      setRecent([]);
    }
  }, []);

  const load = useCallback(async () => {
    if (!queryId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getAskQuery(queryId);
      setQuery(res.query);
    } catch (e) {
      const anyErr = e as { status?: number };
      setError(anyErr?.status === 404 ? '这次问答不存在，可能已被删除。' : '加载失败，请重试。');
    } finally {
      setLoading(false);
    }
  }, [queryId]);

  useEffect(() => {
    void load();
    void loadRecent();
  }, [load, loadRecent]);

  // 生成中自动轮询刷新
  useEffect(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (!query || query.status !== 'pending') return;
    pollRef.current = window.setInterval(async () => {
      try {
        const res = await api.getAskQuery(query.id);
        setQuery(res.query);
        if (res.query.status !== 'pending') void loadRecent();
      } catch {
        /* 轮询失败不打断页面，下一次继续 */
      }
    }, 1500);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [query, loadRecent]);

  async function cancel() {
    if (!query) return;
    try {
      const res = await api.cancelAskQuery(query.id);
      setQuery(res.query);
      void loadRecent();
    } catch {
      setError('取消失败，请重试。');
    }
  }

  const st = query ? STATUS[query.status] ?? { kind: 'idle' as StatusKind, label: query.status } : null;

  return (
    <V2Shell
      leftTitle="问答记录"
      leftCount={recent?.length ?? 0}
      left={
        <>
          {recent === null && (
            <p className="v2-state">
              <Spinner />
            </p>
          )}
          {recent?.length === 0 && <p className="v2-state">还没有问答记录。</p>}
          {(recent ?? []).map((r, i) => (
            <Link
              key={r.id}
              to={topicAwareHref('/ask/' + r.id, topicNav)}
              className="v2-leftItem"
              aria-current={r.id === queryId ? 'page' : undefined}
              style={{ '--i': i } as React.CSSProperties}
            >
              <span className="v2-leftTitle">{r.question}</span>
              <span className="v2-leftMeta">
                {dayLabel(r.createdAt, tz, todayDateKey(tz))} · {STATUS[r.status]?.label ?? r.status}
                {r.insufficientEvidence ? ' · 证据不足' : ''}
              </span>
            </Link>
          ))}
        </>
      }
      rightTitle="这次问答"
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">来源</h3>
            <p className="v2-groupNote">答案只能引用提问时勾选的记录。来源被删或改动后，这里会标出来。</p>
          </div>
          <div>
            <h3 className="v2-groupTitle">操作</h3>
            <div className="v2-sideActions">
              <Link className="v2-sideAction" to="/ask">
                <span>← 回到问记录 / 新提问</span>
              </Link>
            </div>
          </div>
        </>
      }
      statusLeft={query ? dayTimeLabel(query.createdAt, tz) + ' · 依据 ' + query.sources.length + ' 条' : '加载中'}
      statusRight={st ? <span>{st.label}</span> : null}
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

      {query && (
        <>
          {returnTo && (
            <div className="v2-returnBar">
              <Link to={returnTo} className="v2-returnLink">
                ← {topicNav.fromTopic ? '返回主题' : '返回刚才阅读的位置'}
              </Link>
            </div>
          )}

          <div className="v2-captureHead">
            <p className="v2-captureText">{query.question}</p>
            <div className="v2-captureActions">
              <Pill kind={st?.kind ?? 'idle'}>{st?.label}</Pill>
              {query.durationMs ? <span className="v2-hint">用时 {(query.durationMs / 1000).toFixed(1)}s</span> : null}
              {query.usage ? <span className="v2-hint">token {query.usage.totalTokens}</span> : null}
              {query.status === 'pending' && query.canCancel && <Button onClick={() => void cancel()}>取消生成</Button>}
            </div>
          </div>

          <Module title="答案" count={query.answer?.points.length ?? 0}>
            {query.status === 'pending' && (
              <p className="v2-state">
                <Spinner label="模型正在读你选的记录…" />
              </p>
            )}
            {query.status === 'failed' && (
              <p className="v2-state" style={{ color: 'var(--st-fail)' }}>
                生成失败：{query.errorMessage ?? query.errorCode ?? '未知原因'}
              </p>
            )}
            {query.status === 'cancelled' && <p className="v2-state">这次生成已取消，没有保存答案。</p>}
            {query.status === 'interrupted' && <p className="v2-state">生成被中断（可能是服务重启）。可以回问记录页重新问一次。</p>}
            {query.answer && <AskAnswerView query={query} topicNav={topicNav} />}
          </Module>
        </>
      )}
    </V2Shell>
  );
}
