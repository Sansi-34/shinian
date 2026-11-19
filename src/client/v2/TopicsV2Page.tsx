// 拾念 V2 · 主题列表（只读视图；新建与详情还没搬进新版）
import { useCallback, useEffect, useState } from 'react';
import api from '../api';
import type { Topic } from '../types';
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

export default function TopicsV2Page() {
  const [timezone] = useDisplayTimezone();
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listTopics({ limit: 50, archived: 'exclude' });
      setTopics(res.topics ?? []);
    } catch (e) {
      setError(errText(e, '主题加载失败，请重试。'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const members = topics.reduce((n, t) => n + (t.memberCount ?? 0), 0);
  const withQuestion = topics.filter((t) => (t.exploringQuestion ?? '').trim()).length;

  return (
    <V2Shell
      rightTitle="概览"
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">主题</h3>
            <div className="v2-groupItem">
              进行中
              <span>{topics.length}</span>
            </div>
            <div className="v2-groupItem">
              记录总数
              <span>{members}</span>
            </div>
            <div className="v2-groupItem">
              写了探索问题
              <span>{withQuestion}</span>
            </div>
          </div>
          <div>
            <h3 className="v2-groupTitle">说明</h3>
            <p className="v2-groupNote">主题是一组稳定 ID 的集合，不复制正文；成员不代表相互支持或相似，也不会增加图谱边。</p>
            <span className="v2-hint">新建主题还没搬进新版（下一步）</span>
          </div>
        </>
      }
      statusLeft={`主题 ${topics.length} · 记录 ${members}`}
      statusRight={<span>只读视图</span>}
    >
      <Module title="我的主题" count={topics.length} action={<span className="v2-hint">新建主题还没搬进新版</span>}>
        {loading && <p className="v2-state"><Spinner /></p>}
        {!loading && error && (
          <p className="v2-state">
            {error}
            <button type="button" className="v2-linkBtn" onClick={() => void load()}>
              重试
            </button>
          </p>
        )}
        {!loading && !error && topics.length === 0 && (
          <p className="v2-state">
            还没有主题。主题用来把围绕同一个问题的一组记录收在一起——新建主题还没搬进新版。
          </p>
        )}
        {topics.map((t, i) => (
          <Row
            key={t.id}
            index={i}
            time={t.updatedAt ? dayLabel(t.updatedAt, timezone, todayDateKey(timezone)) : '—'}
            to={'/topics/' + t.id}
            title={t.name}
            sub={t.exploringQuestion || t.continueNote || '未写探索问题'}
            side={<Pill kind="idle">{t.memberCount} 条</Pill>}
          />
        ))}
      </Module>
    </V2Shell>
  );
}
