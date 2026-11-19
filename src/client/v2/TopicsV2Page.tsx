// 拾念 V2 · 主题列表（可在本页新建；详情仍是旧页）
import { useCallback, useEffect, useState } from 'react';
import api from '../api';
import type { Topic } from '../types';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Row from './ui/Row';
import Pill from './ui/Pill';
import Spinner from './ui/Spinner';
import Button from './ui/Button';
import GhostChip from './ui/GhostChip';
import { dayLabel } from './format';
import { todayDateKey, useDisplayTimezone } from '../scheduleTime';
import './shared.css';

function errText(e: unknown, fallback: string) {
  const anyErr = e as { status?: number; body?: { message?: string }; message?: string };
  if (anyErr?.body?.message) return anyErr.body.message;
  if (anyErr?.status === 0 || anyErr?.message === 'Failed to fetch') return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  return fallback;
}

const newOpId = () => 'v2-topic-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

export default function TopicsV2Page() {
  const [timezone] = useDisplayTimezone();
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 新建主题（之前在 V2 里完全没有入口，空态还把用户指向一个不存在的地方）
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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

  async function submitCreate() {
    const title = name.trim();
    if (!title || busy) return;
    setBusy(true);
    setCreateError(null);
    try {
      await api.createTopic({ name: title, exploringQuestion: null, operationId: newOpId() });
      setName('');
      setCreating(false);
      await load();
    } catch (e) {
      setCreateError(errText(e, '新建主题失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

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
          </div>
        </>
      }
      statusLeft={`主题 ${topics.length} · 记录 ${members}`}
      statusRight={<span>本地库</span>}
    >
      <Module
        title="我的主题"
        count={topics.length}
        action={!creating && <GhostChip onClick={() => setCreating(true)}>新建主题</GhostChip>}
      >
        {creating && (
          <div className="v2-writer">
            <input
              className="v2-input"
              style={{ maxWidth: 'none', width: '100%' }}
              value={name}
              placeholder="主题名，例如：桌面常驻面板怎么做"
              aria-label="新主题名称"
              maxLength={120}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                // 中文输入法候选态回车不能当提交（e.isComposing 在合成事件上不存在，取 nativeEvent）
                const composing = e.nativeEvent.isComposing || e.keyCode === 229;
                if (e.key === 'Enter' && !composing) void submitCreate();
              }}
            />
            {createError && (
              <p className="v2-state" style={{ color: 'var(--st-fail)' }}>
                {createError}
              </p>
            )}
            <div className="v2-captureActions" style={{ marginTop: 'var(--sp-3)' }}>
              <Button variant="primary" onClick={() => void submitCreate()} disabled={busy || !name.trim()}>
                {busy ? '创建中…' : '创建主题'}
              </Button>
              <Button
                onClick={() => {
                  setCreating(false);
                  setName('');
                  setCreateError(null);
                }}
              >
                取消
              </Button>
            </div>
          </div>
        )}

        {loading && <p className="v2-state"><Spinner /></p>}
        {!loading && error && (
          <p className="v2-state">
            {error}
            <button type="button" className="v2-linkBtn" onClick={() => void load()}>
              重试
            </button>
          </p>
        )}
        {!loading && !error && topics.length === 0 && !creating && (
          <p className="v2-state">还没有主题。主题用来把围绕同一个问题的一组记录收在一起——点右上角「新建主题」开始。</p>
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
