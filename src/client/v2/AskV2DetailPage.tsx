// 拾念 V2 · 单次问答详情（/ask/:queryId）
// 只读视图：问题、状态、答案、依据记录；生成中的可以取消。
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api';
import type { AskPublic } from '../types';
import { useDisplayTimezone } from '../scheduleTime';
import { dayTimeLabel } from './format';
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
  const [tz] = useDisplayTimezone();
  const [query, setQuery] = useState<AskPublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
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
  }, [load]);

  async function cancel() {
    if (!query) return;
    try {
      const res = await api.cancelAskQuery(query.id);
      setQuery(res.query);
    } catch {
      setError('取消失败，请重试。');
    }
  }

  const st = query ? STATUS[query.status] ?? { kind: 'idle' as StatusKind, label: query.status } : null;

  return (
    <V2Shell
      rightTitle="这次问答"
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">来源</h3>
            <p className="v2-groupNote">答案只能引用提问时勾选的记录。来源被删或改动后，这里会标出来。</p>
          </div>
          <div>
            <h3 className="v2-groupTitle">返回</h3>
            <Link className="v2-groupItem" to="/ask">
              回到问记录
            </Link>
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
            {query.answer && <AskAnswerView query={query} />}
          </Module>
        </>
      )}
    </V2Shell>
  );
}
