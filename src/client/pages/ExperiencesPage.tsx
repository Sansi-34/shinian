// 拾念 SHINIAN · 我的经验（列表）
// 只展示用户明确保存的经验；不填充假经验，空状态说明两个入口。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { ApiError } from '../api';
import type { ExperienceListItem } from '../types';
import { experienceErrorText, formatTime } from '../types';

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.body?.message || experienceErrorText(error.body?.error, fallback);
  }
  if (error instanceof TypeError) return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export default function ExperiencesPage() {
  const [items, setItems] = useState<ExperienceListItem[]>([]);
  const [archived, setArchived] = useState<'exclude' | 'only'>('exclude');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(nextArchived = archived, nextQuery = search) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listExperiences({ archived: nextArchived, limit: 100, q: nextQuery });
      setItems(res.experiences);
    } catch (e) {
      setError(errorText(e, '读取经验列表失败。'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archived]);

  return (
    <div className="page experiences-page">
      <header className="detail-head">
        <div className="detail-head-row">
          <div>
            <span className="page-kicker">经验存档 · 经验库</span>
            <h2 className="detail-title">我的经验</h2>
            <p className="card-meta">
              成功了存经验，翻车了存避坑指南。下次遇到同款难题，直接召唤存档。
            </p>
          </div>
          <Link className="btn small" to="/">
            返回首页
          </Link>
        </div>
      </header>

      <div className="experience-list-tools">
        <div className="segmented" role="group" aria-label="经验范围">
          <button
            type="button"
            className={archived === 'exclude' ? 'active' : ''}
            aria-pressed={archived === 'exclude'}
            onClick={() => setArchived('exclude')}
          >
            使用中
          </button>
          <button
            type="button"
            className={archived === 'only' ? 'active' : ''}
            aria-pressed={archived === 'only'}
            onClick={() => setArchived('only')}
          >
            已归档
          </button>
        </div>
        <form
          className="search-bar"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(query.trim());
            void load(archived, query.trim());
          }}
        >
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按标题、理解、条件筛选…"
            aria-label="筛选经验"
          />
          <button type="submit" className="btn small">
            筛选
          </button>
        </form>
      </div>

      {loading && (
        <p className="muted loading-line" role="status">
          <span className="spinner" aria-hidden="true" /> 正在读取经验…
        </p>
      )}
      {!loading && error && (
        <div role="alert">
          <p className="error-msg">{error}</p>
          <button
            type="button"
            className="btn small"
            onClick={() => void load()}
            data-testid="experiences-retry"
          >
            重试
          </button>
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <section className="section empty-state">
          <div className="empty-motto">“把规矩先立住，这样做起来才不烧心。”</div>
          <h3>{search ? '没有匹配的经验' : '还没有保存经验'}</h3>
          {search ? (
            <p className="muted">换个词试试，或清空筛选。</p>
          ) : (
            <>
              <p className="muted">
                成功了存经验，翻车了存避坑指南。经验表达的是「根据这些记录，我目前这样理解；在这些条件下值得再试」。
              </p>
              <p className="muted">
                入口有两个：在「问我的记录」里对某一条观点点「记成经验」；或打开一次有真实结果的尝试，点「整理成经验」。
              </p>
              <div className="row-actions">
                <Link className="btn small primary" to="/ask">
                  去问我的记录
                </Link>
                <Link className="btn small" to="/search">
                  去找一条有结果的尝试
                </Link>
              </div>
            </>
          )}
        </section>
      )}

      {items.length > 0 && (
        <ul className="experience-list gz-stagger">
          {items.map((item) => (
            <li key={item.id} className="experience-list-item">
              <div className="experience-list-main">
                <div className="experience-list-title">
                  <Link to={`/experience/${item.id}`}>{item.title}</Link>
                  {item.derivationBy === 'model' ? (
                    <span className="badge ai-kind">由模型整理</span>
                  ) : (
                    <span className="badge">由你自己整理</span>
                  )}
                  {item.needsRevision && <span className="badge warn">待核对</span>}
                </div>
                <p className="experience-list-summary">
                  {item.summary || '正文已清空，等待重新整理。'}
                </p>
                {item.conditions && (
                  <p className="muted experience-list-conditions">适用条件：{item.conditions}</p>
                )}
                <div className="experience-list-meta">
                  <span>{item.sourceCount} 条依据</span>
                  <span>{item.attemptCount} 次后续实践</span>
                  {!item.hasPracticeResult && <span className="warn-text">尚无实践结果支持</span>}
                  <span>更新于 {formatTime(item.updatedAt)}</span>
                </div>
              </div>
              <Link className="btn small" to={`/experience/${item.id}`}>
                打开
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="hint">
        经验正文是你或模型整理的理解；核对事实时请打开每条依据的原始记录。搜索、链接和局部图都使用同一份稳定记录。
      </p>
    </div>
  );
}
