// 拾念 SHINIAN v0.1 - 搜索页：覆盖念头原文、尝试内容、结果
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import type { SearchAttemptHit, SearchCaptureHit, SearchExperienceHit } from '../types';
import { OUTCOME_LABEL, STATE_LABEL } from '../types';

type SearchFilter = 'all' | 'capture' | 'attempt' | 'experience';

function Highlight({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  const lower = text.toLowerCase();
  const t = term.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const idx = lower.indexOf(t, i);
    if (idx < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(<mark key={key++}>{text.slice(idx, idx + term.length)}</mark>);
    i = idx + term.length;
  }
  return <>{parts}</>;
}

// 同一会话内的滚动位置先记在内存里：重新挂载时 sessionStorage 可能已经被
// 初始渲染的 0 覆盖，内存表只在「真正离开页面」时写入，恢复时优先读它。
const scrollMemory = new Map<string, number>();

function readScrollY(key: string): number {
  const memory = scrollMemory.get(key);
  if (typeof memory === 'number' && memory > 0) return memory;
  try {
    return Number(sessionStorage.getItem(key) ?? '0') || 0;
  } catch {
    return 0;
  }
}

function writeScrollY(key: string, value: number) {
  scrollMemory.set(key, value);
  try {
    sessionStorage.setItem(key, String(value));
  } catch {
    // 忽略存储不可用
  }
}

export default function SearchPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const initial = params.get('q') ?? '';
  const [input, setInput] = useState(initial);
  const [query, setQuery] = useState(initial);
  const [loadedQuery, setLoadedQuery] = useState('');
  const [searchNonce, setSearchNonce] = useState(0);
  const [captures, setCaptures] = useState<SearchCaptureHit[]>([]);
  const [attempts, setAttempts] = useState<SearchAttemptHit[]>([]);
  const [experiences, setExperiences] = useState<SearchExperienceHit[]>([]);
  const [filter, setFilter] = useState<SearchFilter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 地址栏的 q 是唯一来源；返回/前进时同步输入框与查询。
  useEffect(() => {
    const next = params.get('q') ?? '';
    setInput(next);
    setQuery(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.toString()]);

  useEffect(() => {
    if (!query) return;
    setLoading(true);
    setError(null);
    setLoadedQuery('');
    api
      .search(query)
      .then((res) => {
        setCaptures(res.captures ?? []);
        setAttempts(res.attempts ?? []);
        setExperiences(res.experiences ?? []);
        setLoadedQuery(query);
      })
      .catch((e: any) => setError(e?.message || '搜索失败'))
      .finally(() => setLoading(false));
  }, [query, searchNonce]);

  // 按 q 保存滚动位置；从详情返回同一查询时恢复。
  // 三个坑：
  // 1) 离开页面时不能再读 window.scrollY——那时旧内容已被卸载，读到的是目标页面的位置；
  // 2) 返回时浏览器会先自己恢复一次滚动并触发 scroll 事件，如果在页面存活期间就写存储，
  //    这次滚动会把要恢复的目标位置覆盖掉；
  // 3) 所以：全程只把位置记在 ref 里（scroll + 点击瞬间），只在真正卸载时落盘一次，
  //    恢复时读到的就一定是「上次离开时」的位置。
  const scrollYRef = useRef(0);
  const leavingRef = useRef(false);
  const restoredForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!query) return;
    const key = `shinian.search.scroll:${query}`;
    leavingRef.current = false;
    const remember = () => {
      // 一旦开始离开，后续的 scroll 事件都来自新页面，不能再记。
      if (leavingRef.current) return;
      scrollYRef.current = window.scrollY;
    };
    const freeze = () => {
      scrollYRef.current = window.scrollY;
      leavingRef.current = true;
    };
    scrollYRef.current = window.scrollY;
    window.addEventListener('scroll', remember, { passive: true });
    window.addEventListener('popstate', freeze);
    // 点在结果上准备跳走时，先同步记下当前位置并冻结。
    document.addEventListener('pointerdown', freeze, true);
    document.addEventListener('click', freeze, true);
    return () => {
      window.removeEventListener('scroll', remember);
      window.removeEventListener('popstate', freeze);
      document.removeEventListener('pointerdown', freeze, true);
      document.removeEventListener('click', freeze, true);
      writeScrollY(key, scrollYRef.current);
    };
  }, [query]);

  useEffect(() => {
    if (!query || loading || loadedQuery !== query) return;
    if (restoredForRef.current === query) return;
    restoredForRef.current = query;
    const y = readScrollY(`shinian.search.scroll:${query}`);
    if (!Number.isFinite(y) || y <= 0) return;
    // 浏览器/React 可能在这一帧之后才把高度算完，补一次校正。
    const apply = () => {
      window.scrollTo(0, y);
      scrollYRef.current = y;
    };
    const raf = requestAnimationFrame(() => {
      apply();
      window.setTimeout(() => {
        if (Math.abs(window.scrollY - y) > 4) apply();
      }, 120);
    });
    return () => cancelAnimationFrame(raf);
  }, [query, loading, loadedQuery]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (q) {
      setQuery(q);
      setLoadedQuery('');
      setSearchNonce((value) => value + 1);
      navigate(`/search?q=${encodeURIComponent(q)}`, { replace: true });
      // 新查询从结果顶部看起；返回旧查询时才恢复旧位置。
      window.scrollTo(0, 0);
    }
  }

  function searchTag(tag: string) {
    setInput(tag);
    setQuery(tag);
    setLoadedQuery('');
    setSearchNonce((value) => value + 1);
    navigate(`/search?q=${encodeURIComponent(tag)}`, { replace: true });
    window.scrollTo(0, 0);
  }

  const totalHits = captures.length + attempts.length + experiences.length;
  const showResultLists = !loading && Boolean(query) && !error && totalHits > 0;
  const showNoResultEmpty = !loading && Boolean(query) && !error && totalHits === 0;

  return (
    <div className="page search-page">
      <div className="crumb">
        <Link to="/">← 返回列表</Link>
      </div>
      <form className="search-bar" onSubmit={submit} role="search">
        <input
          type="search"
          placeholder="搜索念头、尝试或结果…（下次遇到同款难题，直接召唤存档）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
          aria-label="搜索"
        />
        <button className="btn primary" type="submit">搜索</button>
      </form>

      {!query && (
        <div className="search-landing-prompt">
          <div className="search-landing-tag">下次遇到同款难题，直接召唤存档</div>
          <p className="search-landing-tip">
            支持同时扫描「记下的想法」、「准备怎么试的动作」、「实际发生的结果」和「沉淀的经验」。
          </p>
          <div className="search-quick-tags">
            <span className="hint">试着搜索：</span>
            {['PWM', 'LED', '闪烁', '尝试', '经验'].map((tag) => (
              <button
                key={tag}
                type="button"
                className="btn small"
                onClick={() => searchTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && <p className="muted">搜索中…</p>}
      {error && (
        <div className="search-error" role="alert">
          <p className="error-msg">{error}</p>
          <button
            type="button"
            className="btn small"
            onClick={() => setSearchNonce((value) => value + 1)}
          >
            重试
          </button>
        </div>
      )}

      {!loading && query && !error && (
        <div className="segmented search-filter" role="group" aria-label="搜索范围">
          <button
            type="button"
            className={filter === 'all' ? 'active' : ''}
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            全部
          </button>
          <button
            type="button"
            className={filter === 'capture' ? 'active' : ''}
            aria-pressed={filter === 'capture'}
            onClick={() => setFilter('capture')}
          >
            念头 {captures.length}
          </button>
          <button
            type="button"
            className={filter === 'attempt' ? 'active' : ''}
            aria-pressed={filter === 'attempt'}
            onClick={() => setFilter('attempt')}
          >
            尝试 {attempts.length}
          </button>
          <button
            type="button"
            className={filter === 'experience' ? 'active' : ''}
            aria-pressed={filter === 'experience'}
            onClick={() => setFilter('experience')}
            data-testid="search-filter-experience"
          >
            经验 {experiences.length}
          </button>
        </div>
      )}

      {showNoResultEmpty && (
        <div className="empty-state" role="status">
          <p>没有找到和「{query}」有关的念头、尝试或经验。</p>
          <p className="muted">
            换个词试试（例如 PWM、LED、闪烁）；也可以先把这个想法记下来，之后再来搜索。
          </p>
          <div className="row-actions">
            {['PWM', 'LED', '闪烁', '尝试', '经验']
              .filter((tag) => tag !== query)
              .slice(0, 3)
              .map((tag) => (
                <button key={tag} type="button" className="btn small" onClick={() => searchTag(tag)}>
                  搜「{tag}」
                </button>
              ))}
            <Link className="btn small" to="/">
              去记一个新念头
            </Link>
          </div>
        </div>
      )}

      {showResultLists && (
        <>
          {(filter === 'capture' || (filter === 'all' && captures.length > 0)) && (
            <section className="section">
              <h3>念头 <span className="muted">({captures.length})</span></h3>
              {captures.length === 0 ? (
                <div className="empty-state">
                  <p>没有匹配的念头。</p>
                  <div className="row-actions">
                    <Link className="btn small" to="/">
                      记一个新念头
                    </Link>
                  </div>
                </div>
              ) : (
                <ul className="card-list gz-stagger">
                  {captures.map((c) => (
                    <li key={c.id} className="card">
                      <Link to={`/capture/${c.id}`} className="card-main">
                        <p className="card-text">
                          <Highlight text={c.snippet} term={query} />
                        </p>
                        <p className="card-meta">
                          匹配：念头原文{c.archived ? ' · 已归档' : ''} · 打开念头 →
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {(filter === 'attempt' || (filter === 'all' && attempts.length > 0)) && (
            <section className="section">
              <h3>尝试与结果 <span className="muted">({attempts.length})</span></h3>
              {attempts.length === 0 ? (
                <div className="empty-state">
                  <p>没有匹配的尝试或结果。</p>
                  <div className="row-actions">
                    <Link className="btn small" to="/">
                      去尝试一步
                    </Link>
                  </div>
                </div>
              ) : (
                <ul className="card-list gz-stagger">
                  {attempts.map((a) => (
                    <li key={a.id} className="card">
                      <Link to={`/attempt/${a.id}`} className="card-main">
                        <p className="card-text">
                          <strong>{a.step}</strong>
                        </p>
                        <p className="card-text">
                          <Highlight text={a.snippet} term={query} />
                        </p>
                        <p className="card-meta">
                          匹配：{a.matchField === 'attempt.resultText' ? '结果' : '尝试内容'}
                          {' · '}<span className={`badge state-${a.state}`}>{STATE_LABEL[a.state]}</span>
                          {a.outcome && <span className={`badge outcome-${a.outcome}`}>{OUTCOME_LABEL[a.outcome]}</span>}
                          {' · 打开尝试 →'}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {(filter === 'experience' || (filter === 'all' && experiences.length > 0)) && (
            <section className="section">
              <h3>经验 <span className="muted">({experiences.length})</span></h3>
              {experiences.length === 0 ? (
                <div className="empty-state">
                  <p>没有匹配的经验笔记。</p>
                  <div className="row-actions">
                    <Link className="btn small" to="/experiences">
                      看全部经验
                    </Link>
                  </div>
                </div>
              ) : (
                <ul className="card-list gz-stagger">
                  {experiences.map((item) => (
                    <li key={item.id} className="card">
                      <Link to={`/experience/${item.id}`} className="card-main">
                        <p className="card-text">
                          <strong>{item.title}</strong>
                          {item.needsRevision && <span className="badge warn">待核对</span>}
                          {!item.hasPracticeResult && (
                            <span className="badge warn">尚无实践结果支持</span>
                          )}
                        </p>
                        <p className="card-text">
                          <Highlight text={item.snippet} term={query} />
                        </p>
                        <p className="card-meta">
                          匹配：{item.matchReason} · {item.sourceCount} 条依据 · 打开经验 →
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
