// 拾念 V2 · 经验列表（只读视图；详情页仍是旧版）
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import type { ExperienceListItem } from '../types';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Row from './ui/Row';
import Pill from './ui/Pill';
import Spinner from './ui/Spinner';
import { dayLabel } from './format';
import { todayDateKey, useDisplayTimezone } from '../scheduleTime';
import './shared.css';

function errText(e: unknown, fallback: string) {
  const anyErr = e as { status?: number; body?: { message?: string }; message?: string };
  if (anyErr?.body?.message) return anyErr.body.message;
  if (anyErr?.status === 0 || anyErr?.message === 'Failed to fetch') return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  return fallback;
}

export default function ExperiencesV2Page() {
  const [timezone] = useDisplayTimezone();
  const [items, setItems] = useState<ExperienceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listExperiences({ archived: 'exclude', limit: 50 });
      setItems(res.experiences ?? []);
    } catch (e) {
      setError(errText(e, '经验加载失败，请重试。'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const needRevision = items.filter((e) => e.needsRevision).length;
  const withPractice = items.filter((e) => e.hasPracticeResult).length;
  const fromModel = items.filter((e) => e.derivationBy === 'model').length;

  return (
    <V2Shell
      rightTitle="概览"
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">经验</h3>
            <div className="v2-groupItem">
              共
              <span>{items.length}</span>
            </div>
            <div className="v2-groupItem">
              待修订
              <span>{needRevision}</span>
            </div>
            <div className="v2-groupItem">
              有实践结果
              <span>{withPractice}</span>
            </div>
            <div className="v2-groupItem">
              模型整理
              <span>{fromModel}</span>
            </div>
          </div>
          <div>
            <h3 className="v2-groupTitle">说明</h3>
            <p className="v2-groupNote">经验必须挂在仍可访问的来源上；模型整理的正文会标注「由模型推断整理」，保存只代表你愿意留下它，不代表已证实。</p>
            <Link className="v2-groupItem" to="/legacy/experiences">
              旧版经验页
              <span>→</span>
            </Link>
          </div>
        </>
      }
      statusLeft={`经验 ${items.length} · 待修订 ${needRevision}`}
      statusRight={<span>只读视图</span>}
    >
      <Module title="我整理的经验" count={items.length} action={<Link to="/legacy/experiences">旧版管理</Link>}>
        {loading && <p className="v2-state"><Spinner /></p>}
        {!loading && error && (
          <p className="v2-state">
            {error}
            <button type="button" className="v2-linkBtn" onClick={() => void load()}>
              重试
            </button>
          </p>
        )}
        {!loading && !error && items.length === 0 && (
          <p className="v2-state">还没有经验。先从有真实结果的尝试里整理一条，或在「问记录」里把某条观点记成经验。</p>
        )}
        {items.map((e, i) => (
          <Row
            key={e.id}
            index={i}
            time={e.updatedAt ? dayLabel(e.updatedAt, timezone, todayDateKey(timezone)) : '—'}
            to={'/experience/' + e.id}
            title={e.title}
            sub={e.summary || e.conditions || '未写摘要'}
            side={
              e.needsRevision ? <Pill kind="partial">待修订</Pill> : <Pill kind="done">经验</Pill>
            }
          />
        ))}
      </Module>
    </V2Shell>
  );
}
