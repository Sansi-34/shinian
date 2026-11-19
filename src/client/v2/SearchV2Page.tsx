// 拾念 V2 · 念头与全局搜索（列表页第一批）
// 结构：左栏=全部念头，中栏=搜索框+分段筛选+命中列表，右栏=数量概览
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import type { Capture, SearchAttemptHit, SearchCaptureHit, SearchExperienceHit } from '../types';
import { OUTCOME_LABEL, STATE_LABEL } from '../types';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Row from './ui/Row';
import Pill, { type StatusKind } from './ui/Pill';
import './shared.css';

type Filter = 'all' | 'capture' | 'attempt' | 'experience';

function errText(e: unknown, fallback: string) {
  const anyErr = e as { status?: number; body?: { message?: string }; message?: string };
  if (anyErr?.body?.message) return anyErr.body.message;
  if (anyErr?.status === 401) return '登录状态已失效，请重新登录。';
  if (anyErr?.status === 0 || anyErr?.message === 'Failed to fetch') return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  return fallback;
}

function attemptState(a: SearchAttemptHit): { kind: StatusKind; label: string } {
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
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [input, setInput] = useState(params.get('q') ?? '');
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [filter, setFilter] = useState<Filter>('all');

  const [captures, setCaptures] = useState<SearchCaptureHit[]>([]);
  const [attempts, setAttempts] = useState<SearchAttemptHit[]>([]);
  const [experiences, setExperiences] = useState<SearchExperienceHit[]>([]);
  const [allCaptures, setAllCaptures] = useState<Capture[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const runSearch = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    const term = q.trim();
    try {
      // 空关键词不发检索请求（服务端会拒绝），只拉左栏用的全部念头
      if (!term) {
        const caps = await api.listCaptures(false);
        setAllCaptures(caps.captures ?? []);
        setCaptures([]);
        setAttempts([]);
        setExperiences([]);
        return;
      }
      const [res, caps] = await Promise.all([api.search(term), api.listCaptures(false)]);
      setCaptures(res.captures ?? []);
      setAttempts(res.attempts ?? []);
      setExperiences(res.experiences ?? []);
      setAllCaptures(caps.captures ?? []);
    } catch (e) {
      setError(errText(e, '搜索失败，请重试。'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runSearch(query);
  }, [query, runSearch]);

  useEffect(() => {
    const next = params.get('q') ?? '';
    setInput(next);
    setQuery(next);
  }, [params]);

  function submit() {
    const q = input.trim();
    setQuery(q);
    navigate(q ? `/v2/search?q=${encodeURIComponent(q)}` : '/v2/search', { replace: true });
  }

  const counts = useMemo(
    () => ({ capture: captures.length, attempt: attempts.length, experience: experiences.length }),
    [captures, attempts, experiences]
  );

  const showCapture = filter === 'all' || filter === 'capture';
  const showAttempt = filter === 'all' || filter === 'attempt';
  const showExperience = filter === 'all' || filter === 'experience';
  const total = counts.capture + counts.attempt + counts.experience;

  return (
    <V2Shell
      leftTitle="全部念头"
      leftCount={allCaptures.length}
      left={
        <>
          {allCaptures.length === 0 && <p className="v2-state">还没有念头。</p>}
          {allCaptures.slice(0, 14).map((c, i) => (
            <Link key={c.id} to={'/v2/capture/' + c.id} className="v2-leftItem" style={{ '--i': i } as React.CSSProperties}>
              <span className="v2-leftTitle">{c.rawText}</span>
              <span className="v2-leftMeta">念头</span>
            </Link>
          ))}
        </>
      }
      rightTitle="本次命中"
      right={
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
        </>
      }
      statusLeft={`检索「${query || '全部'}」 · 命中 ${total} 条`}
      statusRight={<span>{loading ? '检索中…' : '本地库'}</span>}
    >
      <div className="v2-toolbar">
        <div className="v2-searchBox">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="搜念头原文、尝试标题或结果"
            aria-label="搜索"
          />
        </div>
        <div className="v2-segment" role="group" aria-label="结果类型">
          {(
            [
              ['all', `全部 ${total}`],
              ['capture', `念头 ${counts.capture}`],
              ['attempt', `尝试 ${counts.attempt}`],
              ['experience', `经验 ${counts.experience}`],
            ] as Array<[Filter, string]>
          ).map(([key, label]) => (
            <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="v2-linkBtn" onClick={submit}>
          搜索
        </button>
      </div>

      {loading && <p className="v2-state">检索中…</p>}
      {!loading && error && (
        <p className="v2-state">
          {error}
          <button type="button" className="v2-linkBtn" onClick={() => void runSearch(query)}>
            重试
          </button>
        </p>
      )}
      {!loading && !error && !query.trim() && (
        <p className="v2-state">
          输入关键词开始检索：覆盖念头原文、尝试标题与结果、已保存经验。左栏是全部念头，也可以从那里直接打开。
        </p>
      )}
      {!loading && !error && query.trim() && total === 0 && (
        <p className="v2-state">
          没有命中「{query}」。换个词试试。
          <button type="button" className="v2-linkBtn" onClick={() => navigate('/v2/search')}>
            清空关键词
          </button>
        </p>
      )}

      {showCapture && captures.length > 0 && (
        <Module title="念头" count={captures.length}>
          {captures.map((c, i) => (
            <Row
              key={c.id}
              index={i}
              time={c.matchField || '原文'}
              to={'/v2/capture/' + c.id}
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
            const st = attemptState(a);
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
    </V2Shell>
  );
}
