// 拾念 V2 · 念头详情
// 只做「读 + 三个内联动作」：编辑正文、归档/恢复、自己写一步。
// 复杂流程（AI 帮我试一步 / 参考旧经验 / 研究一下 / 关联编辑 / 删除预览）暂时回旧页，
// 旧页一行未改，V2 只是并行外壳。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../api';
import type { Attempt, Capture, CaptureLinkItem, CaptureTopic } from '../types';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Row from './ui/Row';
import Pill, { type StatusKind } from './ui/Pill';
import Button from './ui/Button';
import GhostChip from './ui/GhostChip';
import { dayLabel } from './format';
import { todayDateKey, useDisplayTimezone } from '../scheduleTime';
import './shared.css';

function errText(e: unknown, fallback: string) {
  const anyErr = e as { status?: number; body?: { message?: string }; message?: string };
  if (anyErr?.body?.message) return anyErr.body.message;
  if (anyErr?.status === 401) return '登录状态已失效，请重新登录。';
  if (anyErr?.status === 409) return '内容已被改动（版本冲突），请刷新后再改。';
  if (anyErr?.status === 0 || anyErr?.message === 'Failed to fetch') return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  return fallback;
}

function status(a: Attempt): { kind: StatusKind; label: string } {
  if (a.state === 'done') {
    if (a.outcome === 'success') return { kind: 'done', label: '已记录结果' };
    if (a.outcome === 'failure') return { kind: 'fail', label: '未达成' };
    return { kind: 'partial', label: '结果待判断' };
  }
  if (a.state === 'in_progress') return { kind: 'active', label: '进行中' };
  if (a.state === 'cancelled') return { kind: 'idle', label: '已取消' };
  return { kind: 'idle', label: '未开始' };
}

const newOpId = () => 'v2-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

export default function CaptureV2Page() {
  const { captureId = '' } = useParams();
  const [tz] = useDisplayTimezone();

  const [capture, setCapture] = useState<Capture | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [topics, setTopics] = useState<CaptureTopic[]>([]);
  const [links, setLinks] = useState<{ out: CaptureLinkItem[]; in: CaptureLinkItem[] }>({ out: [], in: [] });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [stepDraft, setStepDraft] = useState('');

  const load = useCallback(async () => {
    if (!captureId) return;
    setLoading(true);
    setError(null);
    try {
      const [capRes, attRes, topicRes, linkRes] = await Promise.all([
        api.getCapture(captureId),
        api.listAttempts(captureId),
        api.getCaptureTopics(captureId).catch(() => ({ captureId, topics: [] as CaptureTopic[] })),
        api.listCaptureLinks(captureId).catch(() => ({ captureId, out: [], in: [], counts: { out: 0, in: 0 } })),
      ]);
      setCapture(capRes.capture);
      setDraft(capRes.capture.rawText);
      setAttempts(attRes.attempts ?? []);
      setTopics(topicRes.topics ?? []);
      setLinks({ out: linkRes.out ?? [], in: linkRes.in ?? [] });
    } catch (e) {
      setError(errText(e, '念头加载失败，请重试。'));
    } finally {
      setLoading(false);
    }
  }, [captureId]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = useMemo(() => attempts.filter((a) => a.state === 'todo' || a.state === 'in_progress'), [attempts]);
  const done = useMemo(() => attempts.filter((a) => a.state === 'done'), [attempts]);

  async function saveText() {
    if (!capture || busy) return;
    const text = draft.trim();
    if (!text) {
      setActionError('正文不能为空。');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.updateCapture(capture.id, text, capture.revision);
      setCapture(res.capture);
      setEditing(false);
    } catch (e) {
      setActionError(errText(e, '保存失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    if (!capture || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = capture.archivedAt ? await api.restoreCapture(capture.id) : await api.archiveCapture(capture.id);
      setCapture(res.capture);
    } catch (e) {
      setActionError(errText(e, '归档操作失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function createStep() {
    if (!capture || busy) return;
    const step = stepDraft.trim();
    if (!step) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.createAttempt(capture.id, { step, state: 'todo', operationId: newOpId() });
      setStepDraft('');
      setWriting(false);
      await load();
    } catch (e) {
      setActionError(errText(e, '创建尝试失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  const linkRows: Array<{ key: string; label: string; item: CaptureLinkItem }> = [
    ...links.out.map((l) => ({ key: 'out-' + l.id, label: '关联到', item: l })),
    ...links.in.map((l) => ({ key: 'in-' + l.id, label: '被引用', item: l })),
  ];

  return (
    <V2Shell
      rightTitle="关系"
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">所属主题</h3>
            {topics.length === 0 && <p className="v2-groupNote">还没有加入主题。</p>}
            {topics.map((t) => (
              <Link key={t.id} to={'/topics/' + t.id} className="v2-groupItem">
                {t.name}
                <span>{t.archived ? '已归档' : '主题'}</span>
              </Link>
            ))}
          </div>
          <div>
            <h3 className="v2-groupTitle">关联记录</h3>
            {linkRows.length === 0 && <p className="v2-groupNote">没有手动关联。关联只记录你写下的关系，不做相似度推断。</p>}
            {linkRows.map((r) => (
              <Link key={r.key} to={'/capture/' + r.item.capture.id} className="v2-groupItem">
                {r.label}：{r.item.capture.rawText.slice(0, 18)}
                <span>→</span>
              </Link>
            ))}
          </div>
          <div>
            <h3 className="v2-groupTitle">旧版入口</h3>
            <p className="v2-groupNote">AI 帮我试一步、参考旧经验、研究一下、编辑关联与删除预览仍在旧版页面。</p>
            <Link className="v2-groupItem" to={'/capture/' + captureId}>
              打开旧版详情
              <span>→</span>
            </Link>
          </div>
        </>
      }
      statusLeft={capture ? `${dayLabel(capture.createdAt, tz, todayDateKey(tz))} · 版本 ${capture.revision} · ${attempts.length} 次尝试` : '加载中'}
      statusRight={<span>{capture?.archivedAt ? '已归档' : '进行中'}</span>}
    >
      {loading && <p className="v2-state">加载中…</p>}
      {!loading && error && (
        <p className="v2-state">
          {error}
          <button type="button" className="v2-linkBtn" onClick={() => void load()}>
            重试
          </button>
        </p>
      )}

      {capture && (
        <>
          <div className="v2-captureHead">
            {!editing ? (
              <>
                <p className="v2-captureText">{capture.rawText}</p>
                <div className="v2-captureActions">
                  <Button onClick={() => setEditing(true)}>编辑</Button>
                  <Button onClick={() => void toggleArchive()} disabled={busy}>
                    {capture.archivedAt ? '恢复' : '归档'}
                  </Button>
                  <Link className="v2-oldLink" to={'/capture/' + captureId}>
                    删除 / 更多操作 →
                  </Link>
                </div>
              </>
            ) : (
              <>
                <textarea
                  className="v2-editor"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={4000}
                  aria-label="编辑念头正文"
                />
                <div className="v2-captureActions">
                  <Button variant="primary" onClick={() => void saveText()} disabled={busy}>
                    {busy ? '保存中…' : '保存'}
                  </Button>
                  <Button
                    onClick={() => {
                      setEditing(false);
                      setDraft(capture.rawText);
                      setActionError(null);
                    }}
                  >
                    取消
                  </Button>
                  <span className="v2-hint">{draft.length} / 4000</span>
                </div>
              </>
            )}
            {actionError && <p className="v2-state" style={{ color: 'var(--st-fail)' }}>{actionError}</p>}
          </div>

          <Module title="开始一步" count={open.length}>
            {!writing && (
              <div className="v2-ghosts" style={{ borderBottom: 0 }}>
                <GhostChip onClick={() => setWriting(true)}>自己写一步</GhostChip>
                <Link to={'/capture/' + captureId} className="v2-ghostLink">
                  AI 帮我试一步 / 参考旧经验 / 研究一下（旧版）
                </Link>
              </div>
            )}
            {writing && (
              <div className="v2-writer">
                <textarea
                  className="v2-editor"
                  value={stepDraft}
                  onChange={(e) => setStepDraft(e.target.value)}
                  placeholder="写下一个具体、能立刻开始的小尝试"
                  aria-label="新尝试步骤"
                />
                <div className="v2-captureActions">
                  <Button variant="primary" onClick={() => void createStep()} disabled={busy || !stepDraft.trim()}>
                    {busy ? '创建中…' : '创建尝试'}
                  </Button>
                  <Button
                    onClick={() => {
                      setWriting(false);
                      setStepDraft('');
                    }}
                  >
                    取消
                  </Button>
                </div>
              </div>
            )}
          </Module>

          <Module title="尝试记录" count={attempts.length}>
            {attempts.length === 0 && <p className="v2-state">还没有尝试。先用上面的「自己写一步」记下第一个小尝试。</p>}
            {attempts.map((a, i) => {
              const st = status(a);
              return (
                <Row
                  key={a.id}
                  index={i}
                  time={st.label}
                  to={'/v2/attempt/' + a.id}
                  title={a.step}
                  sub={a.resultText ? a.resultText.slice(0, 60) : a.actionDescription || '还没有记录结果'}
                  side={<Pill kind={st.kind}>{st.label}</Pill>}
                />
              );
            })}
          </Module>

          <Module title="有结果的尝试" count={done.length} defaultOpen={false}>
            {done.length === 0 && <p className="v2-state">还没有记录结果的尝试。结果只能手动填，不会因为时间过去自动变成失败。</p>}
            {done.map((a, i) => (
              <Row
                key={a.id}
                index={i}
                time={a.observedAt ? dayLabel(a.observedAt, tz, todayDateKey(tz)) : '—'}
                to={'/v2/attempt/' + a.id}
                title={a.resultText || a.step}
                sub={'尝试：' + a.step.slice(0, 40)}
                side={<Pill kind={status(a).kind}>{status(a).label}</Pill>}
              />
            ))}
          </Module>
        </>
      )}
    </V2Shell>
  );
}
