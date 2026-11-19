// 拾念 V2 · 首页（暗色优先 + 纸张重映射）
// 目标：一屏看完「要做什么 / 最近记了什么 / 有什么关联」，不用卡片墙。
// 数据全部来自现有接口，不造演示数据；三种状态（加载 / 失败可重试 / 空态）齐备。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import type { Capture, ExperienceListItem, RecentAttempt, ScheduleBlock, Topic } from '../types';
import { formatTime } from '../types';
import {
  addDaysToDateKey,
  formatScheduleTimeRange,
  sortSchedules,
  todayDateKey,
  useDisplayTimezone,
} from '../scheduleTime';
import Rail from './ui/Rail';
import Row from './ui/Row';
import Module from './ui/Module';
import Pill, { type StatusKind } from './ui/Pill';
import Button from './ui/Button';
import StatusBar from './ui/StatusBar';
import GhostChip from './ui/GhostChip';
import './tokens.css';
import styles from './HomeV2Page.module.css';

const THEME_KEY = 'shinian.v2-theme';
type V2Theme = 'dark' | 'paper';

function errText(e: unknown, fallback: string) {
  const anyErr = e as { status?: number; body?: { message?: string }; message?: string };
  if (anyErr?.body?.message) return anyErr.body.message;
  if (anyErr?.status === 401) return '登录状态已失效，请重新登录。';
  if (anyErr?.status === 0 || anyErr?.message === 'Failed to fetch') {
    return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  }
  return fallback;
}

function attemptStatus(a: RecentAttempt): { kind: StatusKind; label: string } {
  if (a.state === 'done') {
    if (a.outcome === 'success') return { kind: 'done', label: '已记录结果' };
    if (a.outcome === 'failure') return { kind: 'fail', label: '未达成' };
    return { kind: 'partial', label: '结果待判断' };
  }
  if (a.state === 'in_progress') return { kind: 'active', label: '进行中' };
  if (a.state === 'cancelled') return { kind: 'idle', label: '已取消' };
  return { kind: 'idle', label: '未开始' };
}

function dayKey(ts: number) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function HomeV2Page() {
  const [theme, setTheme] = useState<V2Theme>('dark');
  const [moreOpen, setMoreOpen] = useState(false);
  const [timezone] = useDisplayTimezone();

  const [captures, setCaptures] = useState<Capture[]>([]);
  const [attempts, setAttempts] = useState<RecentAttempt[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [experiences, setExperiences] = useState<ExperienceListItem[]>([]);
  const [schedules, setSchedules] = useState<ScheduleBlock[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch {
      /* localStorage 不可用时忽略 */
    }
    setTheme(saved === 'paper' ? 'paper' : 'dark');
  }, []);

  function changeTheme(next: V2Theme) {
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [capRes, attRes, topicRes, expRes, schRes] = await Promise.all([
        api.listCaptures(false),
        api.listRecentAttempts(8),
        api.listTopics({ limit: 20, archived: 'exclude' }),
        api.listExperiences({ archived: 'exclude', limit: 5 }),
        api.listSchedules({
          from: todayDateKey(timezone),
          to: addDaysToDateKey(todayDateKey(timezone), 1),
          timezone,
        }),
      ]);
      setCaptures(capRes.captures ?? []);
      setAttempts(attRes.attempts ?? []);
      setTopics(topicRes.topics ?? []);
      setExperiences(expRes.experiences ?? []);
      setSchedules(sortSchedules(schRes.schedules ?? []));
    } catch (e) {
      setError(errText(e, '首页数据加载失败，请重试。'));
    } finally {
      setLoading(false);
    }
  }, [timezone]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitDraft() {
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.createCapture(text);
      setDraft('');
      await load();
    } catch (e) {
      setSaveError(errText(e, '保存失败，请重试。'));
    } finally {
      setSaving(false);
    }
  }

  /** 现在要做：未完成尝试 + 今天已排日程 */
  const todoAttempts = useMemo(
    () => attempts.filter((a) => a.state === 'todo' || a.state === 'in_progress').slice(0, 3),
    [attempts]
  );

  /** 最近记录：念头与已记录结果的尝试按时间合并 */
  const recent = useMemo(() => {
    const items: Array<{
      key: string;
      at: number;
      to: string;
      title: string;
      sub: string;
      side: React.ReactNode;
    }> = [];
    for (const c of captures) {
      items.push({
        key: 'cap-' + c.id,
        at: c.updatedAt || c.createdAt,
        to: '/capture/' + c.id,
        title: c.rawText,
        sub: '念头' + (c.archivedAt ? ' · 已归档' : ''),
        side: <Pill kind="idle">{c.archivedAt ? '已归档' : '想法'}</Pill>,
      });
    }
    for (const a of attempts) {
      if (!a.resultText) continue;
      const st = attemptStatus(a);
      items.push({
        key: 'att-' + a.id,
        at: a.observedAt ?? a.updatedAt,
        to: '/attempt/' + a.id,
        title: a.resultText,
        sub: '尝试结果 · ' + a.captureText,
        side: <Pill kind={st.kind}>{st.label}</Pill>,
      });
    }
    return items.sort((x, y) => y.at - x.at).slice(0, 6);
  }, [captures, attempts]);

  const counts = `${captures.length} 念头 · ${topics.length} 主题 · ${experiences.length} 经验`;

  return (
    <div className="v2-root" data-v2-theme={theme}>
      <Rail onMore={() => setMoreOpen((v) => !v)} />

      {moreOpen && (
        <div className={styles.morePanel} role="menu" aria-label="更多入口">
          {[
            ['/experiences', '经验'],
            ['/schedule', '日程'],
            ['/activity', '操作动态'],
            ['/research', '深度研究'],
            ['/settings/ai', '设置'],
          ].map(([to, label]) => (
            <Link key={to} to={to} className={styles.moreItem} role="menuitem">
              {label}
            </Link>
          ))}
        </div>
      )}

      <div className={styles.shell}>
        <nav className={styles.left} aria-label="最近记录列表">
          <div className={styles.leftHead}>
            <h1>记录</h1>
            <span className={styles.headCount}>{captures.length}</span>
          </div>
          <div className={styles.leftList}>
            {loading && <p className={styles.state}>加载中…</p>}
            {!loading && error && (
              <p className={styles.state}>
                {error}
                <button type="button" className={styles.linkBtn} onClick={() => void load()}>
                  重试
                </button>
              </p>
            )}
            {!loading && !error && captures.length === 0 && (
              <p className={styles.state}>还没有念头。在中间输入框写一句开始。</p>
            )}
            {captures.slice(0, 12).map((c, i) => (
              <Link key={c.id} to={'/capture/' + c.id} className={styles.leftItem} style={{ '--i': i } as React.CSSProperties}>
                <span className={styles.leftTitle}>{c.rawText}</span>
                <span className={styles.leftMeta}>{dayKey(c.createdAt)}</span>
              </Link>
            ))}
          </div>
        </nav>

        <main className={styles.center}>
          <div className={styles.compose}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitDraft();
              }}
              placeholder="记一句：刚才试了什么，结果如何"
              aria-label="记录一句"
              maxLength={4000}
            />
            <Button variant="primary" onClick={() => void submitDraft()} disabled={saving || !draft.trim()}>
              {saving ? '保存中…' : '记下'}
            </Button>
          </div>
          {saveError && <p className={styles.saveError}>{saveError}</p>}

          <Module
            title="现在要做"
            count={todoAttempts.length + schedules.length}
            action={<Link to="/schedule">日程</Link>}
          >
            {loading && <p className={styles.state}>加载中…</p>}
            {!loading && todoAttempts.length === 0 && schedules.length === 0 && (
              <p className={styles.state}>没有进行中的尝试，也没有今天的安排。</p>
            )}
            {todoAttempts.map((a, i) => {
              const st = attemptStatus(a);
              return (
                <Row
                  key={a.id}
                  index={i}
                  time={st.label}
                  to={'/attempt/' + a.id}
                  title={a.step}
                  sub={'来自「' + a.captureText + '」'}
                  side={<Pill kind={st.kind}>{st.label}</Pill>}
                />
              );
            })}
            {schedules.map((s, i) => (
              <Row
                key={s.id}
                index={todoAttempts.length + i}
                time={formatScheduleTimeRange(s, timezone)}
                to={s.attemptId ? '/attempt/' + s.attemptId : '/schedule'}
                title={s.attempt?.step ?? s.note ?? '日程安排'}
                sub={s.capture ? '来自「' + s.capture.rawText + '」' : '今天'}
                side={<Pill kind="idle">已排日程</Pill>}
              />
            ))}
          </Module>

          <Module title="最近记录" count={recent.length} action={<Link to="/search">全部</Link>}>
            {loading && <p className={styles.state}>加载中…</p>}
            {!loading && error && (
              <p className={styles.state}>
                {error}
                <button type="button" className={styles.linkBtn} onClick={() => void load()}>
                  重试
                </button>
              </p>
            )}
            {!loading && !error && recent.length === 0 && (
              <p className={styles.state}>还没有内容。写下第一条念头，或记录一次尝试的结果。</p>
            )}
            {recent.map((item, i) => (
              <Row key={item.key} index={i} time={dayKey(item.at)} to={item.to} title={item.title} sub={item.sub} side={item.side} />
            ))}
          </Module>

          <div className={styles.ghosts}>
            <GhostChip count={experiences.length} onClick={() => undefined}>
              我整理的经验
            </GhostChip>
            <GhostChip count={topics.length} onClick={() => undefined}>
              我的主题
            </GhostChip>
            <GhostChip count={schedules.length} onClick={() => undefined}>
              今日日程
            </GhostChip>
          </div>
        </main>

        <aside className={styles.right} aria-label="关系">
          <div className={styles.rightHead}>
            <h1>关系</h1>
          </div>
          <div className={styles.panel}>
            <div style={{ '--i': 0 } as React.CSSProperties}>
              <h3>主题</h3>
              {topics.length === 0 && <p className={styles.panelNote}>还没有主题。主题是围绕一个问题收起来的一组记录。</p>}
              {topics.slice(0, 4).map((t) => (
                <Link key={t.id} to={'/topics/' + t.id} className={styles.panelItem}>
                  {t.name}
                  <span>{t.memberCount}</span>
                </Link>
              ))}
            </div>
            <div style={{ '--i': 1 } as React.CSSProperties}>
              <h3>经验</h3>
              {experiences.length === 0 && <p className={styles.panelNote}>还没有沉淀的经验。从有结果的尝试里整理。</p>}
              {experiences.slice(0, 3).map((e) => (
                <Link key={e.id} to={'/experience/' + e.id} className={styles.panelItem}>
                  {e.title}
                  <span>{e.sourceCount}</span>
                </Link>
              ))}
            </div>
          </div>
        </aside>
      </div>

      <StatusBar
        left={`本地库 · ${counts}`}
        right={
          <>
            <button type="button" className={styles.themeBtn} onClick={() => changeTheme(theme === 'dark' ? 'paper' : 'dark')}>
              {theme === 'dark' ? '纸张主题' : '暗色主题'}
            </button>
            <span>最后更新 {formatTime(Date.now())}</span>
          </>
        }
      />
    </div>
  );
}
