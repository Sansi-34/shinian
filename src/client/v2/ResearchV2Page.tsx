// 拾念 V2 · 深度研究列表（只读视图；发起与生成仍在旧版）
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import type { ResearchListItem } from '../types';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Row from './ui/Row';
import Pill, { type StatusKind } from './ui/Pill';
import { dayLabel } from './format';
import { todayDateKey, useDisplayTimezone } from '../scheduleTime';
import './shared.css';

function errText(e: unknown, fallback: string) {
  const anyErr = e as { status?: number; body?: { message?: string }; message?: string };
  if (anyErr?.body?.message) return anyErr.body.message;
  if (anyErr?.status === 0 || anyErr?.message === 'Failed to fetch') return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  return fallback;
}

const STATUS: Record<string, { kind: StatusKind; label: string }> = {
  searching: { kind: 'active', label: '检索中' },
  candidates: { kind: 'active', label: '待选仓库' },
  fetching: { kind: 'active', label: '读取资料' },
  generating: { kind: 'active', label: '生成对比' },
  succeeded: { kind: 'done', label: '已完成' },
  failed: { kind: 'fail', label: '失败' },
  cancelled: { kind: 'idle', label: '已取消' },
  interrupted: { kind: 'partial', label: '已中断' },
};

export default function ResearchV2Page() {
  const [timezone] = useDisplayTimezone();
  const [items, setItems] = useState<ResearchListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listSavedResearch(20);
      setItems(res.research ?? []);
    } catch (e) {
      setError(errText(e, '研究列表加载失败，请重试。'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const done = items.filter((r) => r.status === 'succeeded').length;
  const failed = items.filter((r) => r.status === 'failed' || r.status === 'interrupted').length;

  return (
    <V2Shell
      rightTitle="概览"
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">研究</h3>
            <div className="v2-groupItem">
              已完成
              <span>{done}</span>
            </div>
            <div className="v2-groupItem">
              失败 / 中断
              <span>{failed}</span>
            </div>
            <div className="v2-groupItem">
              共保存
              <span>{items.length}</span>
            </div>
          </div>
          <div>
            <h3 className="v2-groupTitle">说明</h3>
            <p className="v2-groupNote">研究只读取 GitHub 公开资料，模型引用必须指向本次实际取回的来源；结论不足时会直接说不足。</p>
            <Link className="v2-groupItem" to="/research">
              旧版研究页（发起 / 继续）
              <span>→</span>
            </Link>
          </div>
        </>
      }
      statusLeft={`研究 ${items.length} · 已完成 ${done}`}
      statusRight={<span>只读视图</span>}
    >
      <Module title="已保存的研究" count={items.length} action={<Link to="/research">旧版管理</Link>}>
        {loading && <p className="v2-state">加载中…</p>}
        {!loading && error && (
          <p className="v2-state">
            {error}
            <button type="button" className="v2-linkBtn" onClick={() => void load()}>
              重试
            </button>
          </p>
        )}
        {!loading && !error && items.length === 0 && (
          <p className="v2-state">还没有保存的研究。从一条念头的「研究一下」发起，或去旧版研究页检索公开仓库。</p>
        )}
        {items.map((r, i) => {
          const st = STATUS[r.status] ?? { kind: 'idle' as StatusKind, label: r.status };
          return (
            <Row
              key={r.id}
              index={i}
              time={dayLabel(r.createdAt, timezone, todayDateKey(timezone))}
              to={'/research/' + r.id}
              title={r.question}
              sub={r.summary || (r.errorCode ? '错误：' + r.errorCode : '未生成结论')}
              side={<Pill kind={st.kind}>{st.label}</Pill>}
            />
          );
        })}
      </Module>
    </V2Shell>
  );
}
