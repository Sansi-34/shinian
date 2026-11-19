// 拾念 SHINIAN · 首页 V2.0
// 定位：回到自己思考与成长过程的入口，而非管理仪表盘。
// 信息优先级：① 快速捕捉 ② 继续探索(2–3) ③ 最近念头 ④ 知识联系 ⑤ AI 帮助(按需)。
// 所有内容来自真实数据；无数据时给出明确下一步，不制造静态演示内容。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api';
import type {
  Capture,
  ExperienceListItem,
  RecentAttempt,
  ScheduleBlock,
  Topic,
} from '../types';
import { formatTime, STATE_LABEL } from '../types';
import {
  addDaysToDateKey,
  dateKeyInTimezone,
  formatDateKeyLabel,
  formatScheduleTimeRange,
  isCrossDaySchedule,
  isSchedulePast,
  sortSchedules,
  useDisplayTimezone,
  useNow,
} from '../scheduleTime';
import CommandSearch from '../components/CommandSearch';
import KnowledgePreview from '../components/KnowledgePreview';

/** 请求失败原因：network = 无法连到服务（断网/超时/跨域），server = 服务端已返回错误 */
type HomeErrorKind = 'network' | 'server';

function homeErrorKind(e: any): HomeErrorKind {
  // api.request 抛出 ApiError(status, body)；status=0 或非 JSON 解析失败归入网络层。
  const status = e?.status;
  if (typeof status === 'number' && status >= 400) return 'server';
  return 'network';
}

/** 错误转成可读中文：服务端错误优先展示其 message，网络错误给明确说明，不冒充空数据 */
function homeErrorText(e: any, fallback: string): string {
  const raw = e?.body?.message || e?.message;
  if (homeErrorKind(e) === 'network') {
    return `${fallback}：无法连接到本地服务，请检查应用是否正在运行后重试。`;
  }
  if (typeof raw === 'string' && raw.trim()) return raw;
  return fallback;
}

type ContinueItemData = {
  key: string;
  kind: 'topic' | 'attempt';
  title: string;
  context: string;
  result: string | null;
  href: string;
  /** 兼容旧入口：固定下一步时给出真正的尝试链接 */
  attemptHref?: string;
  badge: string;
  updatedAt: number;
};

export default function HomePage() {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [newText, setNewText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capturesError, setCapturesError] = useState<string | null>(null);
  const [capturesErrorKind, setCapturesErrorKind] = useState<HomeErrorKind | null>(null);
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [commandOpenSignal, setCommandOpenSignal] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [timezone] = useDisplayTimezone();
  const [todaySchedules, setTodaySchedules] = useState<ScheduleBlock[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [experiences, setExperiences] = useState<ExperienceListItem[]>([]);
  const [experiencesLoading, setExperiencesLoading] = useState(true);
  const [experiencesError, setExperiencesError] = useState<string | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicsLoading, setTopicsLoading] = useState(true);
  const [topicsError, setTopicsError] = useState<string | null>(null);
  const [recentAttempts, setRecentAttempts] = useState<RecentAttempt[]>([]);
  const [recentAttemptsLoading, setRecentAttemptsLoading] = useState(true);
  const [recentAttemptsError, setRecentAttemptsError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [contextPanel, setContextPanel] = useState(false);
  const [captureActive, setCaptureActive] = useState(false);
  // 次要模块默认收起；测试通过点击展开（保留稳定标识与真实内容）。
  const [secondaryOpen, setSecondaryOpen] = useState(false);
  const now = useNow();
  const todayKey = dateKeyInTimezone(now, timezone);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();

  // ---- 离线状态：监听浏览器网络状态；离线时仍展示本地数据与记录入口 ----
  useEffect(() => {
    const sync = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  useEffect(() => { void loadCaptures(); }, [showArchived]);

  useEffect(() => {
    void loadExperiences();
    void loadRecentAttempts();
    void loadTopics();
    // 三个轻量区块独立加载；失败时各自显示错误与重试，不冒充空数据。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    setScheduleLoading(true);
    setScheduleError(null);
    api
      .listSchedules({ from: todayKey, to: addDaysToDateKey(todayKey, 1), timezone })
      .then((res) => { if (!cancelled) setTodaySchedules(sortSchedules(res.schedules ?? [])); })
      .catch((e: any) => { if (!cancelled) setScheduleError(homeErrorText(e, '今日安排加载失败')); })
      .finally(() => { if (!cancelled) setScheduleLoading(false); });
    return () => { cancelled = true; };
  }, [todayKey, timezone]);

  async function loadTopics() {
    setTopicsLoading(true);
    setTopicsError(null);
    try {
      const res = await api.listTopics({ limit: 20, archived: 'exclude' });
      setTopics(res.topics ?? []);
    } catch (e: any) {
      setTopicsError(homeErrorText(e, '主题加载失败'));
    } finally {
      setTopicsLoading(false);
    }
  }

  async function loadExperiences() {
    setExperiencesLoading(true);
    setExperiencesError(null);
    try {
      const res = await api.listExperiences({ archived: 'exclude', limit: 5 });
      setExperiences(res.experiences ?? []);
    } catch (e: any) {
      setExperiencesError(homeErrorText(e, '经验加载失败'));
    } finally {
      setExperiencesLoading(false);
    }
  }

  async function loadRecentAttempts() {
    setRecentAttemptsLoading(true);
    setRecentAttemptsError(null);
    try {
      const res = await api.listRecentAttempts(6);
      setRecentAttempts(res.attempts ?? []);
    } catch (e: any) {
      setRecentAttemptsError(homeErrorText(e, '最近尝试加载失败'));
    } finally {
      setRecentAttemptsLoading(false);
    }
  }

  async function loadCaptures() {
    setLoading(true);
    setCapturesError(null);
    setCapturesErrorKind(null);
    try {
      const data = await api.listCaptures(showArchived);
      setCaptures(data.captures ?? []);
    } catch (e: any) {
      setCaptures([]);
      setCapturesError(homeErrorText(e, '念头加载失败'));
      setCapturesErrorKind(homeErrorKind(e));
    } finally {
      setLoading(false);
    }
  }

  async function saveCapture() {
    const text = newText.trim();
    if (!text || saving) return;
    setSaving(true);
    setError(null);
    try {
      const data = await api.createCapture(text);
      setNewText('');
      setJustSaved(data.capture.id);
      if (showArchived) setShowArchived(false);
      else await loadCaptures();
      textareaRef.current?.focus();
    } catch (e: any) {
      setError(homeErrorText(e, '保存失败，请重试'));
    } finally {
      setSaving(false);
    }
  }

  async function exportData() {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const { blob, filename } = await api.exportData();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setExportError('导出失败，请重试');
    } finally {
      setExporting(false);
    }
  }

  const exportCb = useCallback(() => { void exportData(); }, [exporting]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 继续探索：优先用户固定的下一步（主题），再按近期活动补未完成尝试；最多 3 条 ----
  const continueItems = useMemo<ContinueItemData[]>(() => {
    const items: ContinueItemData[] = [];
    for (const topic of topics) {
      if (items.length >= 3) break;
      if (!topic.nextAttempt) continue;
      const a = topic.nextAttempt;
      items.push({
        key: `pinned:${topic.id}`,
        kind: 'topic',
        title: topic.name,
        context: a.step || topic.exploringQuestion || topic.continueNote || '',
        result: a.resultText || (a.resultState === 'recorded' ? '已记录结果' : null),
        href: `/topics/${topic.id}`,
        attemptHref: `/attempt/${a.id}`,
        badge: '固定下一步',
        updatedAt: topic.updatedAt,
      });
    }
    const recentTodo = recentAttempts.filter((a) => a.state === 'todo' || a.state === 'in_progress');
    for (const a of recentTodo) {
      if (items.length >= 3) break;
      items.push({
        key: `attempt:${a.id}`,
        kind: 'attempt',
        title: a.step,
        context: a.captureText || '',
        result: a.resultText || null,
        href: `/attempt/${a.id}`,
        badge: a.state === 'in_progress' ? '进行中' : '待尝试',
        updatedAt: a.updatedAt,
      });
    }
    return items;
  }, [topics, recentAttempts]);

  const hasAnyData = captures.length > 0 || topics.length > 0 || experiences.length > 0 || recentAttempts.length > 0;
  const contentLoading = loading || topicsLoading || recentAttemptsLoading || experiencesLoading;

  return (
    <div className={`page home-page v2${!contentLoading && !hasAnyData && !capturesError ? ' is-first-use' : ''}`}>
      {/* 离线提示：只陈述真实能力，不承诺不存在的同步 */}
      {offline && (
        <div className="offline-banner" role="status">
          <strong>当前无法连接网络</strong>
          <span>可以继续查看已经打开的内容；保存念头、搜索和 AI 功能需要连接本地服务后再试。</span>
        </div>
      )}

      {/* 页面顶部：精简有梗的标语 + 搜索入口，让实际记录操作第一时间映入眼帘 */}
      {/* 入场编排第 1 段：标题带（.gz-enter 实现见 ui-motion.css） */}
      <header
        className="home-page-head gz-enter"
        style={{ ['--gz-enter-step' as string]: 0 } as React.CSSProperties}
      >
        <div className="home-hero-badge-wrap">
          <span className="home-hero-badge">✦ 本地个人知识与实践闭环</span>
          <h1 className="home-page-title">拾念 · 思考与实践</h1>
          <p className="home-page-sub">
            灵感来了？先丢进拾念，别让它像“我刚才要干啥来着”一样人间蒸发。
          </p>
        </div>
        <button
          type="button"
          className="home-top-search"
          onClick={() => setCommandOpenSignal((n) => n + 1)}
          aria-label="打开搜索与快捷操作"
        >
          <span className="search-glyph" aria-hidden="true">⌕</span>
          <span>搜索与快捷操作</span>
          <kbd className="search-shortcut">⌘K</kbd>
        </button>
      </header>

      {/* ① 快速捕捉：首屏核心操作，打开即可输入，无需先选分类/项目/时间 */}
      {/* 入场编排第 2 段：主卡 */}
      <section
        className={`capture-box gz-enter${captureActive ? ' is-active' : ''}`}
        style={{ ['--gz-enter-step' as string]: 1 } as React.CSSProperties}
        aria-label="记下念头"
      >
        <div className="compose-head">
          <div className="compose-title-group">
            <span className="compose-icon">✎</span>
            <h2 className="compose-title">记下此刻的念头</h2>
          </div>
          <span className="hint">无需分类或时间 · 纯本地私密保存</span>
        </div>
        <form
          className="compose-form"
          onSubmit={(e) => { e.preventDefault(); saveCapture(); }}
        >
          <textarea
            ref={textareaRef}
            className="capture-input"
            placeholder="闪现的灵感、踩坑的问题、待办的想法…直接敲下来（支持按 Ctrl/⌘ + Enter 极速保存）"
            value={newText}
            rows={3}
            disabled={saving}
            aria-label="念头原文"
            onChange={(e) => setNewText(e.target.value)}
            onFocus={() => setCaptureActive(true)}
            onBlur={() => { if (!newText.trim()) setCaptureActive(false); }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveCapture(); }
            }}
          />
          <div className="capture-actions">
            <span className="hint">
              Ctrl/⌘ + Enter 保存{newText.length > 0 ? ` · 已输入 ${newText.length} 字` : ' · 随手记，不纠结'}
            </span>
            <button
              type="submit"
              className="btn primary capture-submit-btn"
              data-testid="home-capture-submit"
              disabled={!newText.trim() || saving}
            >
              {saving ? '保存中…' : '立刻记下'}
            </button>
          </div>
        </form>
        {justSaved && (
          <p className="save-ok" role="status">
            <span>✨ 念头已入库！成功了存经验，翻车了存避坑指南。</span>
            <Link to={`/capture/${justSaved}`} className="feedback-link">去试一步 →</Link>
            <button type="button" className="link" onClick={() => setJustSaved(null)}>关闭</button>
          </p>
        )}
        {error && <p className="error-msg" role="alert">{error}</p>}
      </section>

      {/* 首次使用：没有记录时，以快速捕捉和简短引导为主（不制造虚假内容） */}
      {!contentLoading && !hasAnyData && !capturesError && (
        <section className="home-section first-use" aria-label="开始使用">
          <h2>从一条念头开始</h2>
          <p className="hint">
            在上面写下第一个念头即可。之后可以在这里继续探索、找回记录，并在需要时让 AI 帮你试一步。
          </p>
          <div className="first-use-actions">
            <button type="button" className="btn small" onClick={() => textareaRef.current?.focus()}>写一条念头</button>
            <Link className="btn small" to="/search">找回记录</Link>
            <Link className="btn small" to="/ask">问我的记录</Link>
          </div>
        </section>
      )}

      {/* ② 继续探索：最近活跃且可继续的 2–3 项，打开后恢复上下文 */}
      {/* 入场编排第 3 段：列表区（子元素错峰见 .gz-stagger） */}
      <section
        className="home-section home-continue gz-enter"
        style={{ ['--gz-enter-step' as string]: 2 } as React.CSSProperties}
        aria-labelledby="home-continue-title"
        data-testid="home-continue-attempts"
      >
        <div className="section-head">
          <div>
            <h2 id="home-continue-title">继续探索</h2>
            <p className="hint">继续已有尝试：最近活跃且可继续的主题与尝试，最多 3 项；打开后回到上次的上下文，不会自动创建安排。</p>
          </div>
          <Link to="/search" className="btn small">查找尝试</Link>
        </div>
        {topicsLoading || recentAttemptsLoading ? (
          <p className="muted loading-line" role="status"><span className="spinner" aria-hidden="true" /> 正在读取最近尝试…</p>
        ) : topicsError || recentAttemptsError ? (
          <div className="home-load-error" role="alert">
            <p className="error-msg">{recentAttemptsError || topicsError}</p>
            <button type="button" className="btn small" onClick={() => { void loadTopics(); void loadRecentAttempts(); }}>重试</button>
          </div>
        ) : continueItems.length === 0 ? (
          /* 兼容历史文案与新增 V2 文案，融入品牌规矩金句 */
          <div className="home-continue-empty">
            <div className="empty-motto">“把规矩先立住，这样做起来才不烧心。”</div>
            <p>现在没有进行中的尝试，也没有固定的下一步。</p>
            <p className="hint">没有固定下一步，也没有进行中的尝试。打开一条念头记下一次尝试，或为主题固定下一步；这里不会自动创建安排。</p>
            {/* 空态必须给出可点的下一步入口，而不是只留说明文字 */}
            <div className="first-use-actions">
              <button
                type="button"
                className="btn small"
                data-testid="home-continue-empty-start"
                onClick={() => textareaRef.current?.focus()}
              >
                写一条念头
              </button>
              <Link className="btn small" to="/search" data-testid="home-continue-empty-search">
                打开一条念头去试一步
              </Link>
            </div>
          </div>
        ) : (
          <ul className="continue-list gz-stagger">
            {continueItems.map((item) => (
              <li key={item.key} className="home-continue-item" data-testid="home-continue-item">
                <div className="home-continue-card" data-testid="home-continue-card">
                  {item.attemptHref && item.attemptHref !== item.href && (
                    <Link className="sr-only" to={item.attemptHref} data-testid="home-continue-direct">打开固定尝试</Link>
                  )}
                  <Link className="continue-main" to={item.href}>
                    <div className="continue-card-top">
                      <span className={`badge ${item.badge === '进行中' ? 'badge-primary' : 'badge-neutral'}`}>
                        {item.badge}
                      </span>
                      <span className="continue-time">{formatTime(item.updatedAt)}</span>
                    </div>
                    <span className="continue-card-step">{item.title}</span>
                    {item.context && (
                      <span className="continue-context">
                        <strong className="continue-context-label">上下文：</strong>{item.context}
                      </span>
                    )}
                    {item.result && (
                      <span className="continue-result">
                        <strong className="continue-result-label">已有结果：</strong>{item.result}
                      </span>
                    )}
                  </Link>
                  <Link className="btn small primary-outline continue-btn" to={item.href} data-testid="home-continue-open-btn">
                    继续 →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ③ 最近念头：简洁文字列表，真实数据，支持继续编辑与关联 */}
      <section
        className="home-section recent-thoughts gz-enter"
        style={{ ['--gz-enter-step' as string]: 3 } as React.CSSProperties}
        aria-labelledby="home-thoughts-title"
      >
        <div className="section-head">
          <div>
            <h2 id="home-thoughts-title">最近念头</h2>
            <p className="hint">按最近活动排序，直接查看与继续编辑。</p>
          </div>
          <nav className="list-tabs" aria-label="列表筛选">
            <button type="button" className={!showArchived ? 'tab active' : 'tab'} aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>念头</button>
            <button type="button" className={showArchived ? 'tab active' : 'tab'} aria-pressed={showArchived} onClick={() => setShowArchived(true)}>已归档</button>
          </nav>
        </div>
        {loading ? (
          <p className="muted loading-line" role="status"><span className="spinner" aria-hidden="true" /> 加载中…</p>
        ) : capturesError ? (
          <div className="home-load-error" role="alert" data-testid="home-captures-error">
            <p className="error-msg">{capturesError}</p>
            <p className="hint">
              {capturesErrorKind === 'network'
                ? '这通常是网络或服务连接问题，不是没有记录。'
                : '服务返回了错误，请稍后重试。'}
            </p>
            <button type="button" className="btn small" onClick={() => void loadCaptures()}>重试</button>
          </div>
        ) : captures.length === 0 ? (
          <div className="empty-state">
            {showArchived ? '没有已归档的念头。' : '还没有念头。记下第一个，比如「PWM 低占空比时 LED 会闪」。'}
          </div>
        ) : (
          <ul className="thought-list gz-stagger">
            {captures.slice(0, 8).map((cap) => (
              <li key={cap.id}>
                <Link to={`/capture/${cap.id}`} className="thought-item card-main">
                  <span className="thought-text">{cap.rawText}</span>
                  <span className="thought-meta">{formatTime(cap.createdAt)}{cap.archivedAt ? ' · 已归档' : ''}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {captures.length > 8 && <Link className="link more-link" to="/search">查看全部念头 →</Link>}
      </section>

      {/* ④ 知识联系：轻量、真实、可点击；没有真实关系不展示网络 */}
      <KnowledgePreview onOpenGraph={() => navigate('/graph')} />

      {/* 次要模块：主题 / 日程 / 经验，默认收起为轻量入口；展开后保留全部真实内容 */}
      <button
        type="button"
        className="home-secondary-toggle"
        onClick={() => setSecondaryOpen((v) => !v)}
        aria-expanded={secondaryOpen}
        aria-controls="home-secondary-panel"
      >
        <span>更多内容 · 主题 / 日程 / 经验</span>
        <span className="chev" aria-hidden="true">▾</span>
      </button>
      <div
        id="home-secondary-panel"
        className={`home-secondary-panel${secondaryOpen ? ' open' : ''}`}
        aria-hidden={!secondaryOpen}
        inert={!secondaryOpen}
      >
      {/* 裁剪层：折叠时由这一层收到 0 高度，间距都在它内部，收起后不留空白 */}
      <div className="home-secondary-clip">
      <div className="home-dashboard">
        <section className="home-topics compact-entry" aria-labelledby="home-topics-title" data-testid="home-topics">
          <div className="section-head">
            <div>
              <h2 id="home-topics-title">我的主题</h2>
              <p className="hint">围绕一个问题持续探索；主题不会复制正文。</p>
            </div>
            <Link to="/topics" className="btn small" data-testid="home-topics-all">查看全部</Link>
          </div>
          {topicsLoading ? (
            <p className="muted loading-line" role="status"><span className="spinner" aria-hidden="true" /> 正在读取主题…</p>
          ) : topicsError ? (
            <div className="home-load-error" role="alert">
              <p className="error-msg">{topicsError}</p>
              <button type="button" className="btn small" onClick={() => void loadTopics()}>重试</button>
            </div>
          ) : topics.length === 0 ? (
            <div className="home-topic-empty">
              <p>还没有主题。可以把正在反复琢磨的问题收成一个主题。</p>
              <Link to="/topics" className="btn small">新建主题</Link>
            </div>
          ) : (
            <ul className="home-topic-list">
              {topics.slice(0, 3).map((topic) => (
                <li key={topic.id} className="home-topic-item" data-testid="home-topic-item">
                  <Link className="home-topic-main" to={`/topics/${topic.id}`}>
                    <span className="home-topic-title">{topic.name}{topic.archived && <span className="badge">已归档</span>}</span>
                    <span className="home-topic-question">{topic.exploringQuestion?.trim() || '还没有写下正在探索的问题。'}</span>
                    <span className="home-topic-meta">
                      {topic.memberCount} 个成员
                      {topic.nextAttempt ? ` · 下次继续：${topic.nextAttempt.step}` : ' · 还没有固定下一步'}
                    </span>
                  </Link>
                  <Link className="btn small home-topic-open" to={`/topics/${topic.id}`}>打开</Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="today-schedules compact-entry" aria-labelledby="today-schedule-title">
          <div className="section-head">
            <div>
              <h2 id="today-schedule-title">今天的安排</h2>
              <p className="hint">{formatDateKeyLabel(todayKey)} · {timezone}</p>
            </div>
            <Link to="/schedule" className="btn small">查看日程</Link>
          </div>
          {scheduleLoading ? (
            <p className="muted loading-line" role="status"><span className="spinner" aria-hidden="true" /> 加载今日安排…</p>
          ) : scheduleError ? (
            <p className="error-msg" role="alert">{scheduleError}</p>
          ) : todaySchedules.length === 0 ? (
            <div className="today-empty"><p>今天还没有安排。</p><Link to="/schedule">安排一个时间</Link></div>
          ) : (
            <ul className="today-list">
              {todaySchedules.map((schedule) => {
                const crossDay = isCrossDaySchedule(schedule, timezone);
                const past = isSchedulePast(schedule, now);
                return (
                  <li key={schedule.id} className="today-item">
                    <Link className="today-item-main" data-testid="today-schedule-item" to={`/attempt/${schedule.attempt?.id ?? schedule.attemptId}`}>
                      <span className="today-time">{formatScheduleTimeRange(schedule, timezone)}</span>
                      <span className="today-title">{schedule.attempt?.step ?? '（尝试已删除）'}</span>
                      <span className="today-meta">
                        {crossDay && <span className="badge">跨日</span>}
                        {past && <span className="badge warn">已过安排时间</span>}
                        {schedule.attempt && <span className={`badge state-${schedule.attempt.state}`}>{STATE_LABEL[schedule.attempt.state]}</span>}
                        <span className="today-open">打开尝试</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="home-experiences compact-entry" aria-labelledby="home-experiences-title">
          <div className="section-head">
            <div>
              <h2 id="home-experiences-title">我整理的经验</h2>
              <p className="hint">成功了存经验，翻车了存避坑指南。下次遇到同款难题，直接召唤存档。</p>
            </div>
            <Link to="/experiences" className="btn small">全部经验</Link>
          </div>
          {experiencesLoading ? (
            <p className="muted loading-line" role="status"><span className="spinner" aria-hidden="true" /> 正在读取经验…</p>
          ) : experiencesError ? (
            <div className="home-load-error" role="alert" data-testid="home-experiences-error">
              <p className="error-msg">{experiencesError}</p>
              <button type="button" className="btn small" onClick={() => void loadExperiences()}>重试</button>
            </div>
          ) : experiences.length === 0 ? (
            <div className="home-experience-empty">
              <div className="empty-motto">“成功了存经验，翻车了存避坑指南。”</div>
              <p>还没有经验。可以从两处开始，保存为经验后都能再修订：</p>
              <div className="home-experience-entry-grid">
                <Link className="home-experience-entry" to="/search"><strong>从已有结果的尝试整理</strong><span>搜索并打开有结果的尝试，在尝试详情点「整理成经验」。</span></Link>
                <Link className="home-experience-entry" to="/ask"><strong>从问答观点整理</strong><span>打开「问我的记录」，对一条观点点「记成经验」（保存为经验）。</span></Link>
              </div>
            </div>
          ) : (
            <ul className="home-experience-list">
              {experiences.map((item) => (
                <li key={item.id}>
                  <Link to={`/experience/${item.id}`}>
                    <strong>{item.title}</strong>
                    {item.needsRevision && <span className="badge warn">待核对</span>}
                    {!item.hasPracticeResult && <span className="badge warn">尚无实践结果支持</span>}
                    <span className="card-meta">{item.sourceCount} 条依据 · {item.attemptCount} 次后续实践</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      </div>{/* /home-secondary-clip */}
      </div>{/* /home-secondary-panel */}

      {/* ⑤ AI 帮助：统一搜索与快捷入口，ContextPanel 按需展开，不占大量空间 */}
      <section className="home-toolbar" aria-label="搜索与快捷操作">
        <CommandSearch onExport={exportCb} exporting={exporting} openSignal={commandOpenSignal} />
        <button type="button" className="btn export-btn" onClick={exportData} disabled={exporting} aria-label="导出全部数据为 JSON 文件" title="导出全部数据为 JSON 文件">
          {exporting ? '导出中…' : '导出数据'}
        </button>
      </section>
      {exportError && <p className="error-msg" role="alert">{exportError}</p>}

      <section className="ai-help ask-entry" aria-labelledby="ai-help-title" data-testid="ask-entry">
        <button
          type="button"
          className="ai-help-toggle"
          onClick={() => setContextPanel((v) => !v)}
          aria-expanded={contextPanel}
          aria-controls="home-context-panel"
        >
          <span id="ai-help-title">AI 成长伙伴</span>
          <span className="hint">{contextPanel ? '收起' : '按需展开'}</span>
        </button>
        {contextPanel && (
          <div id="home-context-panel" className="context-panel">
            <p className="hint">AI 只在你需要时调用；不会自动创建任务或改变记录。</p>
            <div className="context-actions">
              <Link className="btn small" to="/ask">问我的记录</Link>
              <button type="button" className="btn small" onClick={() => setCommandOpenSignal((n) => n + 1)}>快捷操作</button>
              <Link className="btn small" to="/topics">在主题内提问</Link>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
