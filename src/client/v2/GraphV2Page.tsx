// 拾念 V2 · 知识图谱
// 渲染交给 Cytoscape.js（MIT，11k+ star）：布局、拖拽、缩放、选中全部用它的成熟实现，
// 我们只负责数据映射、类型配色与交互意图。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import api from '../api';
import type { GraphLink, GraphNode, GraphNodeType, GraphResponse, GraphSearchHit } from '../types';
import { todayDateKey, useDisplayTimezone } from '../scheduleTime';
import { dayLabel } from './format';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Pill from './ui/Pill';
import Button from './ui/Button';
import Spinner from './ui/Spinner';
import Segment from './ui/Segment';
import './shared.css';

cytoscape.use(fcose);

const TYPE_LABEL: Record<GraphNodeType, string> = {
  capture: '念头',
  attempt: '尝试',
  experience: '经验',
  research: '研究',
  review: '回顾',
  schedule: '日程',
};

const LINK_LABEL: Record<GraphLink['type'], string> = {
  contains: '包含',
  references: '引用',
  related: '关联',
  researches: '研究',
  adopted: '采用',
  scheduled: '排期',
  reviews: '回顾',
  evidence: '依据',
  used: '使用',
  context: '上下文',
};

type LayoutName = 'fcose' | 'cose' | 'concentric' | 'grid' | 'circle';

/** fcose 的扩展参数不在核心类型里，用宽类型构造后再交给 cytoscape */
function buildLayoutOptions(name: LayoutName, edgeLength: number): cytoscape.LayoutOptions {
  const base = { name, animate: true, animationDuration: 400, padding: 40 };
  if (name !== 'fcose') {
    return base as unknown as cytoscape.LayoutOptions;
  }
  return {
    ...base,
    quality: 'default',
    idealEdgeLength: edgeLength,
    nodeRepulsion: 6000,
    gravity: 0.28,
    numIter: 1800,
    randomize: true,
  } as unknown as cytoscape.LayoutOptions;
}

export default function GraphV2Page() {
  const navigate = useNavigate();
  const [tz] = useDisplayTimezone();

  const wrapRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  const [data, setData] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [hiddenTypes, setHiddenTypes] = useState<Set<GraphNodeType>>(new Set());
  const [includeArchived, setIncludeArchived] = useState(false);
  const [layout, setLayout] = useState<LayoutName>('fcose');
  const [spacing] = useState(80);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<GraphSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getGraph(includeArchived);
      setData(res);
    } catch (e) {
      const anyErr = e as { status?: number; message?: string };
      setError(anyErr?.message === 'Failed to fetch' ? '网络连接失败，请检查服务是否在运行。' : '图谱加载失败，请重试。');
    } finally {
      setLoading(false);
    }
  }, [includeArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 从当前主题读取颜色，主题切换时重新取一次 */
  const palette = useCallback(() => {
    const el = wrapRef.current;
    const cs = getComputedStyle(el ?? document.body);
    const v = (name: string, fallback: string) => (cs.getPropertyValue(name) || fallback).trim();
    return {
      bg: v('--bg', '#0e1013'),
      panel: v('--raise', '#1b1f26'),
      ink: v('--ink', '#e9ecf1'),
      ink2: v('--ink-2', '#a9b0bd'),
      line: v('--line-2', 'rgba(233,236,241,0.2)'),
      accent: v('--accent', '#9db8ff'),
      done: v('--st-done', '#a8c977'),
      active: v('--st-active', '#7fd7c4'),
      partial: v('--st-partial', '#e0b06a'),
      fail: v('--st-fail', '#e08d8d'),
      idle: v('--ink-3', '#8b929e'),
    };
  }, []);

  const nodeColor = (type: GraphNodeType, p: ReturnType<typeof palette>) =>
    type === 'capture' ? p.ink : type === 'attempt' ? p.active : type === 'experience' ? p.done : type === 'research' ? p.partial : type === 'review' ? p.accent : p.idle;

  // 建图
  useEffect(() => {
    if (!wrapRef.current || !data) return;
    const p = palette();
    const visibleNodes = data.nodes.filter((n) => !hiddenTypes.has(n.type));
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const elements = [
      ...visibleNodes.map((n) => ({
        data: {
          id: n.id,
          label: n.label.length > 18 ? n.label.slice(0, 18) + '…' : n.label,
          color: nodeColor(n.type, p),
          type: n.type,
          degree: n.degree,
        },
      })),
      ...data.links
        .filter((l) => visibleIds.has(l.source) && visibleIds.has(l.target))
        .map((l) => ({ data: { id: l.id, source: l.source, target: l.target, kind: l.type } })),
    ];

    const cy = cytoscape({
      container: wrapRef.current,
      elements,
      wheelSensitivity: 0.25,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            width: 'mapData(degree, 0, 8, 12, 26)',
            height: 'mapData(degree, 0, 8, 12, 26)',
            label: 'data(label)',
            'font-size': 10,
            color: p.ink2,
            'text-valign': 'bottom',
            'text-margin-y': 5,
            'text-max-width': '110px',
            'text-wrap': 'ellipsis',
            'border-width': 1,
            'border-color': p.bg,
            'min-zoomed-font-size': 7,
          },
        },
        { selector: 'node[type = "capture"]', style: { shape: 'ellipse' } },
        { selector: 'node[type = "attempt"]', style: { shape: 'round-rectangle' } },
        { selector: 'node[type = "experience"]', style: { shape: 'diamond' } },
        { selector: 'node[type = "research"]', style: { shape: 'hexagon' } },
        { selector: 'node[type = "review"]', style: { shape: 'triangle' } },
        { selector: 'node[type = "schedule"]', style: { shape: 'rectangle' } },
        {
          selector: 'edge',
          style: {
            width: 1,
            'line-color': p.line,
            'target-arrow-color': p.line,
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.7,
            'curve-style': 'bezier',
            opacity: 0.75,
          },
        },
        { selector: 'edge[kind = "references"]', style: { 'line-style': 'dashed' } },
        { selector: 'edge[kind = "related"]', style: { 'line-color': p.accent, 'target-arrow-color': p.accent } },
        { selector: 'edge[kind = "evidence"]', style: { 'line-color': p.done, 'target-arrow-color': p.done } },
        {
          selector: 'node:selected',
          style: {
            'border-width': 2,
            'border-color': p.accent,
            color: p.ink,
            'font-size': 11,
          },
        },
        { selector: '.dim', style: { opacity: 0.18 } },
        { selector: 'node.focus', style: { 'border-width': 2, 'border-color': p.partial } },
      ],
      layout: { name: 'preset' },
    });

    cy.on('tap', 'node', (evt) => {
      const id = evt.target.id();
      const node = data.nodes.find((n) => n.id === id) ?? null;
      setSelected(node);
    });
    cy.on('tap', (evt) => {
      if (evt.target === cy) setSelected(null);
    });
    cy.on('dbltap', 'node', (evt) => {
      const id = evt.target.id();
      const node = data.nodes.find((n) => n.id === id);
      if (node?.href) navigate(node.href);
    });

    cyRef.current = cy;
    // 自检/调试用：页面卸载时清掉
    (window as unknown as { __cy?: cytoscape.Core }).__cy = cy;
    const run = (name: LayoutName) => {
      cy.layout(buildLayoutOptions(name, spacing)).run();
    };
    run(layout);

    const ro = new ResizeObserver(() => {
      cy.resize();
      cy.fit(undefined, 40);
    });
    ro.observe(wrapRef.current);

    return () => {
      ro.disconnect();
      cy.destroy();
      cyRef.current = null;
      delete (window as unknown as { __cy?: cytoscape.Core }).__cy;
    };
    // 只在数据或过滤变化时重建；布局与色调由下面的 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, hiddenTypes, includeArchived]);

  // 换布局
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.layout(buildLayoutOptions(layout, spacing)).run();
  }, [layout, spacing]);

  // 主题切换：重取颜色（body / .v2-root 上的 data-v2-theme 变化）
  useEffect(() => {
    const apply = () => {
      const cy = cyRef.current;
      if (!cy) return;
      const p = palette();
      cy.nodes().forEach((n) => {
        n.style({
          'background-color': nodeColor(n.data('type') as GraphNodeType, p),
          'border-color': p.bg,
          color: p.ink2,
        });
      });
      cy.edges().forEach((e) => {
        const kind = e.data('kind') as GraphLink['type'];
        const color = kind === 'related' ? p.accent : kind === 'evidence' ? p.done : p.line;
        e.style({ 'line-color': color, 'target-arrow-color': color });
      });
    };
    const mo = new MutationObserver(apply);
    const target = document.querySelector('.v2-root') ?? document.body;
    mo.observe(target, { attributes: true, attributeFilter: ['data-v2-theme', 'class'] });
    return () => mo.disconnect();
  }, [palette]);

  const toggleType = (t: GraphNodeType) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
    setSelected(null);
  };

  async function runSearch() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      const res = await api.searchGraph(q, { archived: includeArchived, limit: 50 });
      setHits(res.results ?? []);
      const cy = cyRef.current;
      if (cy) {
        const ids = new Set((res.results ?? []).map((h) => h.node.id));
        cy.nodes().forEach((n) => {
          if (ids.has(n.id())) n.addClass('focus');
          else n.removeClass('focus');
        });
        if (ids.size > 0) cy.fit(cy.nodes('.focus'), 80);
      }
    } catch {
      setHits([]);
    } finally {
      setSearching(false);
    }
  }

  const stats = data?.stats;
  const visibleCount = useMemo(
    () => (data?.nodes ?? []).filter((n) => !hiddenTypes.has(n.type)).length,
    [data, hiddenTypes]
  );

  return (
    <V2Shell
      leftTitle="筛选"
      leftCount={visibleCount}
      left={
        <>
          <div className="v2-form" style={{ padding: '0 var(--sp-3)' }}>
            <div className="v2-field">
              <span className="v2-fieldLabel">搜索节点</span>
              <input
                className="v2-input"
                style={{ maxWidth: 'none', width: '100%' }}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  const composing = e.nativeEvent.isComposing || e.keyCode === 229;
                  if (e.key === 'Enter' && !composing) void runSearch();
                }}
                placeholder="标题或正文"
                aria-label="搜索节点"
              />
            </div>
            <div className="v2-captureActions">
              <Button onClick={() => void runSearch()} disabled={searching}>
                {searching ? '搜索中…' : '搜索'}
              </Button>
              {hits && (
                <Button
                  onClick={() => {
                    setHits(null);
                    setQuery('');
                    cyRef.current?.nodes().removeClass('focus');
                    cyRef.current?.fit(undefined, 40);
                  }}
                >
                  清除
                </Button>
              )}
            </div>
          </div>
          {hits && (
            <div style={{ padding: '0 var(--sp-3) var(--sp-2)' }}>
              <h3 className="v2-groupTitle">命中 {hits.length}</h3>
              {hits.length === 0 && <p className="v2-groupNote">没有命中。</p>}
              {hits.slice(0, 12).map((h) => (
                <button
                  key={h.node.id}
                  type="button"
                  className="v2-leftItem v2-leftBtn"
                  onClick={() => {
                    const cy = cyRef.current;
                    const node = cy?.getElementById(h.node.id);
                    if (node && node.length > 0) {
                      cy?.animate({ center: { eles: node }, duration: 300 });
                      node.select();
                      setSelected(h.node);
                    } else {
                      setSelected(h.node);
                    }
                  }}
                >
                  <span className="v2-leftTitle">{h.node.label.slice(0, 22)}</span>
                  <span className="v2-leftMeta">{TYPE_LABEL[h.node.type]}</span>
                </button>
              ))}
            </div>
          )}
          <div style={{ padding: '0 var(--sp-3)' }}>
            <h3 className="v2-groupTitle">显示哪些</h3>
            {(Object.keys(TYPE_LABEL) as GraphNodeType[]).map((t) => (
              <label key={t} className="v2-check">
                <input type="checkbox" checked={!hiddenTypes.has(t)} onChange={() => toggleType(t)} />
                <span>{TYPE_LABEL[t]}</span>
                <span className="v2-hint">{(data?.nodes ?? []).filter((n) => n.type === t).length}</span>
              </label>
            ))}
            <label className="v2-check">
              <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
              <span>包含已归档</span>
            </label>
          </div>
        </>
      }
      rightTitle={selected ? TYPE_LABEL[selected.type] : '图例'}
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">布局</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', alignItems: 'flex-start' }}>
              <Segment
                ariaLabel="布局"
                items={[
                  { value: 'fcose' as LayoutName, label: '力导向' },
                  { value: 'concentric' as LayoutName, label: '同心' },
                  { value: 'grid' as LayoutName, label: '网格' },
                  { value: 'circle' as LayoutName, label: '环形' },
                ]}
                value={layout}
                onChange={setLayout}
              />
              <Button onClick={() => cyRef.current?.fit(undefined, 40)}>适应窗口</Button>
            </div>
          </div>
        {selected ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
              <h3 className="v2-groupTitle" style={{ marginBottom: 0 }}>{TYPE_LABEL[selected.type]}</h3>
              <p style={{ margin: 0, fontWeight: 500, color: 'var(--ink)', lineHeight: 1.5 }}>{selected.label}</p>
              {selected.detail && selected.detail !== selected.label && (
                <p className="v2-groupNote">{selected.detail}</p>
              )}
              <div>
                <div className="v2-groupItem">
                  <span>连线</span>
                  <span className="v2-hint">{selected.degree}</span>
                </div>
                <div className="v2-groupItem">
                  <span>创建</span>
                  <span className="v2-date">{dayLabel(selected.createdAt, tz, todayDateKey(tz))}</span>
                </div>
                {selected.archived && (
                  <div className="v2-groupItem">
                    <span>状态</span>
                    <Pill kind="idle">已归档</Pill>
                  </div>
                )}
              </div>
              <Button variant="primary" onClick={() => navigate(selected.href)}>
                打开这条记录
              </Button>
              <p className="v2-groupNote">双击节点也能直接打开。</p>
            </div>
          </>
        ) : (
          <>
            <div>
              <h3 className="v2-groupTitle">节点</h3>
              {(Object.keys(TYPE_LABEL) as GraphNodeType[]).map((t) => (
                <div key={t} className="v2-groupItem">
                  <span>{TYPE_LABEL[t]}</span>
                  <span className="v2-hint">{stats ? (stats as Record<string, number>)[t === 'capture' ? 'captures' : t === 'attempt' ? 'attempts' : t === 'research' ? 'research' : t === 'review' ? 'reviews' : t === 'schedule' ? 'schedules' : 'experiences'] ?? 0 : '—'}</span>
                </div>
              ))}
            </div>
            <div>
              <h3 className="v2-groupTitle">连线</h3>
              <p className="v2-groupNote">
                共 {stats?.links ?? 0} 条，其中手动关联 {stats?.manualLinks ?? 0} 条。连线只表示记录里写下的关系，不做相似度推断。
              </p>
              {(Object.keys(LINK_LABEL) as Array<GraphLink['type']>).map((k) => (
                <div key={k} className="v2-groupItem">
                  <span>{LINK_LABEL[k]}</span>
                  <span className="v2-hint">{(data?.links ?? []).filter((l) => l.type === k).length}</span>
                </div>
              ))}
            </div>
            <div>
              <h3 className="v2-groupTitle">提示</h3>
              <p className="v2-groupNote">滚轮缩放、拖动节点、点节点看详情、双击打开。图的渲染由 Cytoscape.js 负责。</p>
            </div>
          </>
        )}
        </>
      }
      statusLeft={stats ? `${visibleCount} 个节点 · ${stats.links} 条连线` : '加载中'}
      statusRight={
        <span>
          {layout === 'fcose' ? '力导向' : layout === 'concentric' ? '同心' : layout === 'grid' ? '网格' : '环形'}
        </span>
      }
    >
      {loading && (
        <p className="v2-state">
          <Spinner />
        </p>
      )}
      {!loading && error && (
        <p className="v2-state">
          {error}
          <button type="button" className="v2-linkBtn" onClick={() => void load()}>
            重试
          </button>
        </p>
      )}
      {!loading && !error && (data?.nodes.length ?? 0) === 0 && (
        <p className="v2-state">还没有可以上图的记录。记录一条念头，它就会出现在这里。</p>
      )}
      <div className="v2-graphWrap">
        <div ref={wrapRef} className="v2-graphCanvas" aria-label="知识图谱画布" />
      </div>
      {!loading && !error && (data?.nodes.length ?? 0) > 0 && (
        <Module title="图的读法" defaultOpen={false}>
          <p className="v2-state">节点大小表示连线多少；形状表示类型（念头圆、尝试方、经验菱形、研究六边形、回顾三角、日程方块）。</p>
        </Module>
      )}
    </V2Shell>
  );
}
