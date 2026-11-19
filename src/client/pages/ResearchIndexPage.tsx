// 研究一下：已保存研究列表
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import type { ResearchListItem } from '../types';
import { formatTime, RESEARCH_STATUS_LABEL } from '../types';

export default function ResearchIndexPage() {
  const [items, setItems] = useState<ResearchListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listSavedResearch(50);
      setItems(res.research);
    } catch {
      setError('暂时无法读取研究列表。');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <div className="app-loading">正在读取研究…</div>;

  return (
    <div className="research-index">
      <header className="page-head">
        <div>
          <h2>研究</h2>
          <p className="hint">从念头发起 GitHub 公开项目调研；这里只显示已保存的研究。</p>
        </div>
      </header>
      {error ? (
        <div role="alert" data-testid="research-index-error">
          <p className="error-msg">{error}</p>
          <div className="row-actions">
            <button type="button" className="btn small" onClick={() => void load()}>
              重试
            </button>
            <Link className="btn small" to="/">
              去看念头
            </Link>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <h3>还没有保存的研究</h3>
          <p>打开一条念头，在「开始一步」里选择「研究一下」，检索并比较公开仓库后保存。</p>
          <Link className="btn" to="/">去看念头</Link>
        </div>
      ) : (
        <div className="research-index-list">
          {items.map((item) => (
            <Link className="research-index-card" key={item.id} to={`/research/${item.id}`}>
              <div className="research-index-top">
                <span className="badge subtle">{RESEARCH_STATUS_LABEL[item.status]}</span>
                <span className="hint">{item.savedAt ? `保存于 ${formatTime(item.savedAt)}` : '未保存'}</span>
              </div>
              <h3>{item.question}</h3>
              {item.summary && <p className="hint clamp">{item.summary}</p>}
              <div className="research-index-foot">
                {item.captureId && <span className="hint">来源念头</span>}
                <span className="hint">{item.attemptCount ?? 0} 个尝试</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
