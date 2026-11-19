// 拾念 SHINIAN · 首页 V2.0 - KnowledgePreview
// 轻量、真实、可点击的关系预览。只读 /api/graph 的 related/evidence/used 关系，
// 只展示两端都存在且非归档的真实节点；没有真实关系时显示空态，绝不造装饰节点。
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import type { GraphLink, GraphNode } from '../types';

type Props = { onOpenGraph?: () => void };

type Relation = {
  key: string;
  link: GraphLink;
  source: GraphNode;
  target: GraphNode;
  label: string;
};

function nodeHref(node: GraphNode): string {
  if (node.href) return node.href;
  if (node.captureId) return `/capture/${node.captureId}`;
  return '/graph';
}

const REL_LABEL: Record<string, string> = {
  related: '手动关联',
  evidence: '依据',
  used: '参考后再试',
  context: '所属念头',
  contains: '包含尝试',
  references: '引用了',
  adopted: '从研究采用',
};

export default function KnowledgePreview({ onOpenGraph }: Props) {
  const [nodes, setNodes] = useState<GraphNode[] | null>(null);
  const [links, setLinks] = useState<GraphLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getGraph(false);
      setNodes(res.nodes ?? []);
      setLinks(res.links ?? []);
    } catch (e: any) {
      setError(e?.body?.message || e?.message || '知识关系加载失败');
      setNodes(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  // 关系按服务端存在的真实节点过滤；优先展示用户手动关联，再展示经验依据与采用。
  const relations = useMemo<Relation[]>(() => {
    if (!nodes) return [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const rank: Record<string, number> = { related: 0, evidence: 1, used: 2, context: 3 };
    const out: Relation[] = [];
    for (const link of links) {
      const source = byId.get(link.source);
      const target = byId.get(link.target);
      if (!source || !target) continue;
      if (source.archived || target.archived) continue;
      out.push({
        key: link.id || `${link.source}->${link.target}:${link.type}`,
        link,
        source,
        target,
        label: link.label || REL_LABEL[link.type] || '关联',
      });
    }
    out.sort((a, b) => (rank[a.link.type] ?? 9) - (rank[b.link.type] ?? 9));
    return out.slice(0, 5);
  }, [nodes, links]);

  return (
    <section className="home-section knowledge-preview" aria-labelledby="home-knowledge-title" data-testid="home-knowledge">
      <div className="section-head">
        <div>
          <h2 id="home-knowledge-title">知识联系</h2>
          <p className="hint">只展示已建立的真实关系；没有关联时这里保持安静。</p>
        </div>
        {onOpenGraph && (
          <button type="button" className="btn small" onClick={onOpenGraph}>打开网络</button>
        )}
      </div>
      {loading ? (
        <p className="muted loading-line" role="status"><span className="spinner" aria-hidden="true" /> 正在读取关系…</p>
      ) : error ? (
        <div className="home-load-error" role="alert">
          <p className="error-msg">{error}</p>
          <button type="button" className="btn small" onClick={() => void load()}>重试</button>
        </div>
      ) : relations.length === 0 ? (
        <p className="hint empty-inline">还没有已建立的知识关系。打开一条念头，手动关联另一条念头即可在这里看到。</p>
      ) : (
        <ul className="knowledge-list">
          {relations.map((r) => (
            <li key={r.key} className="knowledge-item">
              <Link to={nodeHref(r.source)}>{r.source.label || r.source.detail || '记录'}</Link>
              <span className="knowledge-rel" title={r.label}>{r.label}</span>
              <Link to={nodeHref(r.target)}>{r.target.label || r.target.detail || '记录'}</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
