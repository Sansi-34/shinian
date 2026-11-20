// 拾念 V2 · 念头工作台与全局搜索（第二个入口：三个横线图标）
// 无搜索词时展示记录工作台（快速记录框 + 现在要做 + 最近记录 + 快捷入口 + 右侧关系概览）；
// 输入关键词并检索后展示念头/尝试/经验分段命中结果；左栏始终展示全部念头。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import type {
  Capture,
  ExperienceListItem,
  RecentAttempt,
  ScheduleBlock,
  SearchAttemptHit,
  SearchCaptureHit,
  SearchExperienceHit,
  Topic,
} from '../types';
import { OUTCOME_LABEL, STATE_LABEL } from '../types';
import {
  addDaysToDateKey,
  formatScheduleTimeRange,
  sortSchedules,
  todayDateKey,
  useDisplayTimezone,
} from '../scheduleTime';
import { dayLabel } from './format';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Row from './ui/Row';
import Pill, { type StatusKind } from './ui/Pill';
import Button from './ui/Button';
import GhostChip from './ui/GhostChip';
import Spinner from './ui/Spinner';
import Segment from './ui/Segment';
import './shared.css';

type Filter = 'all' | 'capture' | 'attempt' | 'experience';

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

function searchAttemptState(a: SearchAttemptHit): { kind: StatusKind; label: string } {
  if (a.state === 'done') {
    if (a.outcome === 'success') return { kind: 'done', label: OUTCOME_LABEL.success ?? '成功' };
    if (a.outcome === 'failure') return { kind: 'fail', label: OUTCOME_LABEL.failure ?? '未达成' };
    return { kind: 'partial', label: '结果待判断' };
  }
  if (a.state === 'in_progress') return { kind: 'active', label: STATE_LABEL.in_progress ?? '进行中' };
  if (a.state === 'cancelled') return { kind: 'idle', label: '已取消' };
  return { kind: 'idle', label: STATE_LABEL.todo ?? '未开始' };
}

function mark(text: string, term: string) {
  if (!term) return text;
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + term.length)}</mark>
      {text.slice(idx + term.length)}
    </>
  );
}

export default function SearchV2Page() {
  const [timezone] = useDisplayTimezone();
  const [params] = useSearchParams();
  const qParam = params.get('q') ?? '';
  const navigate = useNavigate();

  // 搜索与筛选
  const [input, setInput] = useState(qParam);
  const [query, setQuery] = useState(qParam);
  const [filter, setFilter] = useState<Filter>('all');
  const [showAllLeft, setShowAllLeft] = useState(false);

  // 搜索结果
  const [captures, setCaptures] = useState<SearchCaptureHit[]>([]);
  const [attempts, setAttempts] = useState<SearchAttemptHit[]>([]);
  const [experiences, setExperiences] = useState<SearchExperienceHit[]>([]);

  // 念头工作台总览数据（来自原首页）
  const [allCaptures, setAllCaptures] = useState<Capture[]>([]);
  const [recentAttempts, setRecentAttempts] = useState<RecentAttempt[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicsTotal, setTopicsTotal] = useState(0);
  const [allExperiences, setAllExperiences] = useState<ExperienceListItem[]>([]);
  const [schedules, setSchedules] = useState<ScheduleBlock[]>([]);

  // 快速记一句
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(
    async (q: string) => {
      setLoading(true);
      setError(null);
      const term = q.trim();
      try {
        const baseReqs = Promise.all([
          api.listCaptures(false),
          api.listRecentAttempts(8),
          api.listTopics({ limit: 50, archived: 'exclude' }),
          api.listExperiences({ archived: 'exclude', limit: 50 }),
          api.listSchedules({
            from: todayDateKey(timezone),
            to: addDaysToDateKey(todayDateKey(timezone), 1),
            timezone,
          }),
        ]);

        if (!term) {
          const [caps, attRes, topicRes, expRes, schRes] = await baseReqs;
          setAllCaptures(caps.captures ?? []);
          setRecentAttempts(attRes.attempts ?? []);
          setTopics(topicRes.topics ?? []);
          setTopicsTotal(topicRes.total ?? (topicRes.topics ?? []).length);
          setAllExperiences(expRes.experiences ?? []);
          setSchedules(sortSchedules(schRes.schedules ?? []));
          setCaptures([]);
          setAttempts([]);
          setExperiences([]);
          return;
        }

        const [res, [caps, attRes, topicRes, expRes, schRes]] = await Promise.all([api.search(term), baseReqs]);
        setCaptures(res.captures ?? []);
        setAttempts(res.attempts ?? []);
        setExperiences(res.experiences ?? []);
        setAllCaptures(caps.captures ?? []);
        setRecentAttempts(attRes.attempts ?? []);
        setTopics(topicRes.topics ?? []);
        setTopicsTotal(topicRes.total ?? (topicRes.topics ?? []).length);
        setAllExperiences(expRes.experiences ?? []);
        setSchedules(sortSchedules(schRes.schedules ?? []));
      } catch (e) {
        setError(errText(e, '加载失败，请重试。'));
      } finally {
        setLoading(false);
      }
    },
    [timezone]
  );

  useEffect(() => {
    void loadData(query);
  }, [query, loadData]);

  useEffect(() => {
    setInput(qParam);
    setQuery(qParam);
  }, [qParam]);

  function submitSearch() {
    const q = input.trim();
    setQuery(q);
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search', { replace: true });
  }

  function clearSearch() {
    setInput('');
    setQuery('');
    navigate('/search', { replace: true });
  }

  async function submitDraft() {
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.createCapture(text);
      setDraft('');
      await loadData(query);
    } catch (e) {
      setSaveError(errText(e, '保存失败，请重试。'));
    } finally {
      setSaving(false);
    }
  }

  const scheduledAttemptIds = useMemo(
    () => new Set(schedules.map((s) => s.attemptId).filter(Boolean)),
    [schedules]
  );

  const todoAttempts = useMemo(
    () =>
      recentAttempts
        .filter((a) => (a.state === 'todo' || a.state === 'in_progress') && !scheduledAttemptIds.has(a.id))
        .slice(0, 3),
    [recentAttempts, scheduledAttemptIds]
  );

  const recent = useMemo(() => {
    const items: Array<{ key: string; at: number; to: string; title: string; sub: string; side: ReactNode }> = [];
    for (const c of allCaptures) {
      items.push({
        key: 'cap-' + c.id,
        at: c.updatedAt || c.createdAt,
        to: '/capture/' + c.id,
        title: c.rawText,
        sub: '念头' + (c.archivedAt ? ' · 已归档' : ''),
        side: <Pill kind="idle">{c.archivedAt ? '已归档' : '想法'}</Pill>,
      });
    }
    for (const a of recentAttempts) {
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
  }, [allCaptures, recentAttempts]);

  const counts = useMemo(
    () => ({ capture: captures.length, attempt: attempts.length, experience: experiences.length }),
    [captures, attempts, experiences]
  );

  const isSearching = Boolean(query.trim());
  const showCapture = filter === 'all' || filter === 'capture';
  const showAttempt = filter === 'all' || filter === 'attempt';
  const showExperience = filter === 'all' || filter === 'experience';
  const total = counts.capture + counts.attempt + counts.experience;

  return (
    <V2Shell
      leftTitle="记录"
      leftCount={allCaptures.length}
      left={
        <>
          {loading && allCaptures.length === 0 && (
            <p className="v2-state">
              <Spinner />
            </p>
          )}
          {!loading && allCaptures.length === 0 && <p className="v2-state">还没有念头。在中间输入框写一句开始。</p>}
          {(showAllLeft ? allCaptures : allCaptures.slice(0, 20)).map((c, i) => (
            <Link
              key={c.id}
              to={'/capture/' + c.id}
              className="v2-leftItem"
              style={{ '--i': Math.min(i, 12) } as React.CSSProperties}
            >
              <span className="v2-leftTitle">{c.rawText}</span>
              <span className="v2-leftMeta">{dayLabel(c.createdAt, timezone, todayDateKey(timezone))}</span>
            </Link>
          ))}
          {allCaptures.length > 20 && !showAllLeft && (
            <button
              type="button"
              className="v2-leftItem v2-leftBtn"
              style={{ color: 'var(--accent)' }}
              onClick={() => setShowAllLeft(true)}
            >
              展开全部 {allCaptures.length} 条 →
            </button>
          )}
        </>
      }
      rightTitle={isSearching ? '本次命中' : '关系'}
      right={
        isSearching ? (
          <>
            <div>
              <h3 className="v2-groupTitle">按类型</h3>
              <div className="v2-groupItem">
                念头
                <span>{counts.capture}</span>
              </div>
              <div className="v2-groupItem">
                尝试
                <span>{counts.attempt}</span>
              </div>
              <div className="v2-groupItem">
                经验
                <span>{counts.experience}</span>
              </div>
            </div>
            <div>
              <h3 className="v2-groupTitle">检索范围</h3>
              <p className="v2-groupNote">
                念头原文、尝试标题与结果、已保存经验；本地子串匹配，不做语义检索，也不按相似度排序。
              </p>
            </div>
            <div>
              <Button onClick={clearSearch}>返回记录概览</Button>
            </div>
          </>
        ) : (
          <>
            <div>
              <h3 className="v2-groupTitle">主题</h3>
              {topics.length === 0 && <p className="v2-groupNote">还没有主题。主题是围绕一个问题收起来的一组记录。</p>}
              {topics.slice(0, 4).map((t) => (
                <Link key={t.id} to={'/topics/' + t.id} className="v2-groupItem">
                  {t.name}
                  <span>{t.memberCount}</span>
                </Link>
              ))}
            </div>
            <div>
              <h3 className="v2-groupTitle">经验</h3>
              {allExperiences.length === 0 && <p className="v2-groupNote">还没有沉淀的经验。从有结果的尝试里整理。</p>}
              {allExperiences.slice(0, 3).map((e) => (
                <Link key={e.id} to={'/experience/' + e.id} className="v2-groupItem">
                  {e.title}
                  <span>{e.sourceCount}</span>
                </Link>
              ))}
            </div>
          </>
        )
      }
      statusLeft={
        isSearching
          ? `检索「${query}」 · 命中 ${total} 条`
          : `本地库 · ${allCaptures.length} 念头 · ${topicsTotal} 主题 · ${allExperiences.length} 经验`
      }
      statusRight={
        isSearching ? (
          <span>{loading ? '检索中…' : '本地库'}</span>
        ) : (
          <span>{schedules.length > 0 ? `今天 ${schedules.length} 项安排` : '今天没有安排'}</span>
        )
      }
    >
      {/* 保留原首页的快速记录框 */}
      <div className="v2-compose">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            const composing = e.nativeEvent.isComposing || e.keyCode === 229;
            if (e.key === 'Enter' && !composing) void submitDraft();
          }}
          placeholder="记一句：刚才试了什么，结果如何"
          aria-label="记录一句"
          maxLength={4000}
        />
        <Button variant="primary" onClick={() => void submitDraft()} disabled={saving || !draft.trim()}>
          {saving ? '保存中…' : '记下'}
        </Button>
      </div>
      {saveError && <p className="v2-state" style={{ color: 'var(--st-fail)' }}>{saveError}</p>}

      {/* 念头关键词检索条 */}
      <div className="v2-toolbar">
        <div className="v2-searchBox">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              const composing = e.nativeEvent.isComposing || e.keyCode === 229;
              if (e.key === 'Enter' && !composing) submitSearch();
            }}
            placeholder="搜念头原文、尝试标题或结果"
            aria-label="搜索"
          />
          {input && (
            <button type="button" className="v2-miniBtn" onClick={clearSearch} aria-label="清空搜索">
              ×
            </button>
          )}
        </div>
        {isSearching && (
          <Segment
            ariaLabel="结果类型"
            items={[
              { value: 'all' as Filter, label: `全部 ${total}` },
              { value: 'capture' as Filter, label: `念头 ${counts.capture}` },
              { value: 'attempt' as Filter, label: `尝试 ${counts.attempt}` },
              { value: 'experience' as Filter, label: `经验 ${counts.experience}` },
            ]}
            value={filter}
            onChange={setFilter}
          />
        )}
        <Button onClick={submitSearch}>搜索</Button>
      </div>

      {!isSearching ? (
        <>
          <Module title="现在要做" count={todoAttempts.length + schedules.length} action={<Link to="/schedule">日程</Link>}>
            {loading && (
              <p className="v2-state">
                <Spinner />
              </p>
            )}
            {!loading && todoAttempts.length === 0 && schedules.length === 0 && (
              <p className="v2-state">没有进行中的尝试，也没有今天的安排。</p>
            )}
            {todoAttempts.map((a, i) => {
              const st = attemptStatus(a);
              return (
                <Row
                  key={a.id}
                  index={i}
                  time={dayLabel(a.updatedAt, timezone, todayDateKey(timezone))}
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

          <Module title="最近记录" count={recent.length} action={<Link to="/activity">动态</Link>}>
            {loading && (
              <p className="v2-state">
                <Spinner />
              </p>
            )}
            {!loading && error && (
              <p className="v2-state">
                {error}
                <button type="button" className="v2-linkBtn" onClick={() => void loadData(query)}>
                  重试
                </button>
              </p>
            )}
            {!loading && !error && recent.length === 0 && (
              <p className="v2-state">还没有内容。写下第一条念头，或记录一次尝试的结果。</p>
            )}
            {recent.map((item, i) => (
              <Row
                key={item.key}
                index={i}
                time={dayLabel(item.at, timezone, todayDateKey(timezone))}
                to={item.to}
                title={item.title}
                sub={item.sub}
                side={item.side}
              />
            ))}
          </Module>

          <div className="v2-ghosts">
            <GhostChip count={allExperiences.length} to="/experiences">
              我整理的经验
            </GhostChip>
            <GhostChip count={topicsTotal} to="/topics">
              我的主题
            </GhostChip>
            <GhostChip count={schedules.length} to="/schedule">
              今日日程
            </GhostChip>
          </div>
        </>
      ) : (
        <>
          {loading && (
            <p className="v2-state">
              <Spinner label="检索中" />
            </p>
          )}
          {!loading && error && (
            <p className="v2-state">
              {error}
              <button type="button" className="v2-linkBtn" onClick={() => void loadData(query)}>
                重试
              </button>
            </p>
          )}
          {!loading && !error && total === 0 && (
            <p className="v2-state">
              没有命中「{query}」。换个词试试，或
              <button type="button" className="v2-linkBtn" onClick={clearSearch}>
                返回记录概览
              </button>
              。
            </p>
          )}

          {showCapture && captures.length > 0 && (
            <Module title="念头" count={captures.length}>
              {captures.map((c, i) => (
                <Row
                  key={c.id}
                  index={i}
                  time={c.matchField || '原文'}
                  to={'/capture/' + c.id}
                  title={mark(c.rawText, query)}
                  sub={c.snippet && c.snippet !== c.rawText ? mark(c.snippet, query) : undefined}
                  side={<Pill kind="idle">{c.archived ? '已归档' : '念头'}</Pill>}
                />
              ))}
            </Module>
          )}

          {showAttempt && attempts.length > 0 && (
            <Module title="尝试" count={attempts.length}>
              {attempts.map((a, i) => {
                const st = searchAttemptState(a);
                return (
                  <Row
                    key={a.id}
                    index={i}
                    time={st.label}
                    to={'/attempt/' + a.id}
                    title={mark(a.step, query)}
                    sub={a.resultText ? mark(a.resultText, query) : undefined}
                    side={<Pill kind={st.kind}>{st.label}</Pill>}
                  />
                );
              })}
            </Module>
          )}

          {showExperience && experiences.length > 0 && (
            <Module title="经验" count={experiences.length}>
              {experiences.map((e, i) => (
                <Row
                  key={e.id}
                  index={i}
                  time={e.matchReason || '经验'}
                  to={'/experience/' + e.id}
                  title={mark(e.title, query)}
                  sub={e.snippet ? mark(e.snippet, query) : e.summary}
                  side={<Pill kind="done">经验</Pill>}
                />
              ))}
            </Module>
          )}
        </>
      )}
    </V2Shell>
  );
}
