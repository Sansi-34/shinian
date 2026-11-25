// 拾念 V2 · 知识图谱
// 渲染交给 Cytoscape.js（MIT，11k+ star）：布局、拖拽、缩放、选中全部用它的成熟实现，
// 我们只负责数据映射、类型配色与交互意图。
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import api, { ApiError } from '../api';
import type { GraphLink, GraphNode, GraphNodeType, GraphResponse, GraphSearchHit } from '../types';
import { readTopicNav, safeTopicReturnTo, topicAwareHref } from '../components/topicNav';
import { todayDateKey, useDisplayTimezone } from '../scheduleTime';
import { dayLabel } from './format';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Pill from './ui/Pill';
import Button from './ui/Button';
import Spinner from './ui/Spinner';
import Segment from './ui/Segment';
import './shared.css';
import styles from './GraphV2Page.module.css';

cytoscape.use(fcose);

const TYPE_LABEL: Record<GraphNodeType, string> = {
  capture: '念头',
  attempt: '尝试',
  experience: '经验',
  research: '研究',
  review: '回顾',
  schedule: '日程',
};

const TYPE_CSS_COLOR: Record<GraphNodeType, string> = {
  capture: 'var(--accent)',
  attempt: 'var(--st-active)',
  experience: 'var(--st-done)',
  research: 'var(--st-partial)',
  review: 'var(--st-review)',
  schedule: '#8e8e93',
};

function NodeShapeIcon({ type }: { type: GraphNodeType }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" fillOpacity="0.28" stroke="currentColor" strokeWidth="1.35" aria-hidden="true">
      {type === 'capture' && <circle cx="6" cy="6" r="4.2" />}
      {type === 'attempt' && <rect x="2" y="2" width="8" height="8" rx="2.2" />}
      {type === 'experience' && <polygon points="6,1.4 10.6,6 6,10.6 1.4,6" />}
      {type === 'research' && <polygon points="6,1.4 10,3.7 10,8.3 6,10.6 2,8.3 2,3.7" />}
      {type === 'review' && <polygon points="6,1.8 10.4,9.8 1.6,9.8" />}
      {type === 'schedule' && <rect x="2.2" y="2.2" width="7.6" height="7.6" rx="0.6" />}
    </svg>
  );
}

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
  const base = { name, animate: true, animationDuration: 420, padding: 52 };
  if (name !== 'fcose') {
    return base as unknown as cytoscape.LayoutOptions;
  }
  return {
    ...base,
    quality: 'default',
    idealEdgeLength: edgeLength + 68,
    nodeRepulsion: 24000,
    nodeSeparation: 130,
    gravity: 0.2,
    numIter: 2400,
    randomize: true,
  } as unknown as cytoscape.LayoutOptions;
}

interface RippleWave {
  nodeId: string;
  color: string;
  bornAt: number;
  duration: number;
}

export default function GraphV2Page() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tz] = useDisplayTimezone();

  // 同时兼容 /graph?node=... 与 /graph?focus=...（问答/经验/研究来源都会生成这两种链接）
  const focusNodeId = (searchParams.get('node') || searchParams.get('focus') || '').trim();
  const focusDepth: 1 | 2 = searchParams.get('depth') === '2' ? 2 : 1;
  const topicNav = useMemo(() => readTopicNav(searchParams), [searchParams]);
  const returnTo = useMemo(
    () => safeTopicReturnTo(searchParams.get('returnTo')) ?? topicNav.returnTo,
    [searchParams, topicNav.returnTo]
  );

  const wrapRef = useRef<HTMLDivElement>(null);
  const fxCanvasRef = useRef<HTMLCanvasElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const physicsEnabledRef = useRef<boolean>(true);
  const ripplesRef = useRef<RippleWave[]>([]);
  const nudgeImpulseRef = useRef<number>(0);

  const [data, setData] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusNotice, setFocusNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [cursorMode, setCursorMode] = useState<'default' | 'pointer' | 'grabbing'>('default');
  const [physicsEnabled, setPhysicsEnabled] = useState(true);
  const [zoomPct, setZoomPct] = useState(100);
  const [hiddenTypes, setHiddenTypes] = useState<Set<GraphNodeType>>(new Set());
  const [includeArchived, setIncludeArchived] = useState(
    () => searchParams.get('archived') === '1' || searchParams.get('archived') === 'true'
  );
  const [layout, setLayout] = useState<LayoutName>('fcose');
  const [spacing] = useState(76);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<GraphSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
  }, [selected]);

  useEffect(() => {
    physicsEnabledRef.current = physicsEnabled;
  }, [physicsEnabled]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setFocusNotice(null);
    try {
      if (focusNodeId) {
        let res: GraphResponse;
        try {
          res = await api.focusGraph(focusNodeId, includeArchived, focusDepth);
        } catch (err) {
          // 目标可能是已归档记录：当默认未勾选「包含已归档」时自动重试一次，不让用户扑空
          if (!includeArchived && err instanceof ApiError && err.status === 404) {
            res = await api.focusGraph(focusNodeId, true, focusDepth);
            setIncludeArchived(true);
            setFocusNotice('目标记录已归档，已自动包含已归档节点并定位到局部图。');
          } else {
            throw err;
          }
        }
        setData(res);
        const target = res.nodes.find((n) => n.id === focusNodeId) ?? null;
        if (target) {
          setHiddenTypes((prev) => {
            if (!prev.has(target.type)) return prev;
            const next = new Set(prev);
            next.delete(target.type);
            return next;
          });
          setSelected(target);
        } else {
          setSelected(null);
        }
      } else {
        const res = await api.getGraph(includeArchived);
        setData(res);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && focusNodeId) {
        setData(null);
        setSelected(null);
        setError('目标节点不存在或已被删除，无法定位局部图。');
      } else {
        const anyErr = e as { status?: number; message?: string };
        setError(anyErr?.message === 'Failed to fetch' ? '网络连接失败，请检查服务是否在运行。' : '图谱加载失败，请重试。');
      }
    } finally {
      setLoading(false);
    }
  }, [focusNodeId, focusDepth, includeArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateFocusParams = useCallback(
    (nextNodeId: string | null, nextDepth: 1 | 2 = focusDepth) => {
      const next = new URLSearchParams(searchParams);
      next.delete('focus');
      if (nextNodeId) {
        next.set('node', nextNodeId);
        next.set('depth', String(nextDepth));
      } else {
        next.delete('node');
        next.delete('depth');
      }
      setSearchParams(next, { replace: false });
    },
    [focusDepth, searchParams, setSearchParams]
  );

  const openNodeRecord = useCallback(
    (node: GraphNode) => {
      if (!node.href) return;
      const currentGraphUrl = `${location.pathname}${location.search}`;
      const baseHref = topicAwareHref(node.href, topicNav);
      // 没有主题返回路径时，带上当前图谱地址便于查看原文后回到刚才的图谱位置
      if (!topicNav.fromTopic) {
        const [path, qs = ''] = baseHref.split('?');
        const p = new URLSearchParams(qs);
        if (!p.has('returnTo')) p.set('returnTo', currentGraphUrl);
        navigate(`${path}?${p.toString()}`);
        return;
      }
      navigate(baseHref);
    },
    [location.pathname, location.search, navigate, topicNav]
  );

  /** 从当前主题读取颜色，主题切换时重新取一次 */
  const palette = useCallback(() => {
    const el = wrapRef.current;
    const cs = getComputedStyle(el ?? document.body);
    const v = (name: string, fallback: string) => (cs.getPropertyValue(name) || fallback).trim();
    return {
      bg: v('--bg', '#080a0f'),
      panel: v('--raise', '#222631'),
      ink: v('--ink', '#f5f5f7'),
      ink2: v('--ink-2', '#a9b0bd'),
      line: v('--ink-3', 'rgba(140,148,162,0.5)'),
      accent: v('--accent', '#0a84ff'),
      done: v('--st-done', '#30d158'),
      active: v('--st-active', '#64d2ff'),
      partial: v('--st-partial', '#ff9f0a'),
      fail: v('--st-fail', '#ff6961'),
      review: v('--st-review', '#bf5af2'),
      idle: v('--ink-3', '#8b929e'),
    };
  }, []);

  /** 把 hex / rgb(a) 加上透明度，用于「软填充 + 实边框」的节点 */
  const withAlpha = (color: string, alpha: number) => {
    const hex = color.trim();
    if (hex.startsWith('#')) {
      const h = hex.length === 4 ? '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3] : hex;
      const r = parseInt(h.slice(1, 3), 16);
      const g = parseInt(h.slice(3, 5), 16);
      const b = parseInt(h.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    const m = hex.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const [r, g, b] = m[1].split(',').map((v) => v.trim());
      return `rgba(${r},${g},${b},${alpha})`;
    }
    return hex;
  };

  /** 每种节点一个色：念头蓝、尝试青、经验绿、研究橙、回顾紫调、日程中性 */
  const typeColor = (type: GraphNodeType, p: ReturnType<typeof palette>) =>
    type === 'capture'
      ? p.accent
      : type === 'attempt'
        ? p.active
        : type === 'experience'
          ? p.done
          : type === 'research'
            ? p.partial
            : type === 'review'
              ? p.review
              : p.idle;

  // 建图 + 60fps 弹簧物理牵引引擎 + 视口同步流光粒子 Canvas
  useEffect(() => {
    if (!wrapRef.current || !data) return;
    const p = palette();
    const visibleNodes = data.nodes.filter((n) => !hiddenTypes.has(n.type));
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const nodeColorMap = new Map<string, string>();
    visibleNodes.forEach((n) => {
      nodeColorMap.set(n.id, typeColor(n.type, p));
    });

    const GRAPH_FONT =
      '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", sans-serif';

    const elements = [
      ...visibleNodes.map((n) => {
        const solid = typeColor(n.type, p);
        return {
          data: {
            id: n.id,
            label: n.label.length > 10 ? n.label.slice(0, 10) + '…' : n.label,
            hoverLabel: n.label.length > 14 ? n.label.slice(0, 14) + '…' : n.label,
            fill: withAlpha(solid, 0.28),
            activeFill: withAlpha(solid, 0.44),
            stroke: solid,
            strong: solid,
            lineColor: withAlpha(p.ink, 0.26),
            strongColor: withAlpha(solid, 0.88),
            mutedLabelColor: withAlpha(p.ink, 0.76),
            labelColor: p.ink,
            halo: p.bg,
            tagBg: withAlpha(p.bg, 0.82),
            tagBorder: withAlpha(p.ink, 0.12),
            activeTagBorder: withAlpha(solid, 0.45),
            type: n.type,
            degree: n.degree,
          },
        };
      }),
      ...data.links
        .filter((l) => visibleIds.has(l.source) && visibleIds.has(l.target))
        .map((l) => {
          const srcColor = nodeColorMap.get(l.source) ?? p.accent;
          return {
            data: {
              id: l.id,
              source: l.source,
              target: l.target,
              kind: l.type,
              edgeLabel: LINK_LABEL[l.type] ?? '',
              lineColor: withAlpha(p.ink, 0.26),
              strongColor: withAlpha(l.type === 'evidence' ? p.done : srcColor, 0.88),
              activeColor: withAlpha(srcColor, 0.92),
              labelColor: withAlpha(p.ink, 0.86),
              halo: p.bg,
              edgeTagBg: withAlpha(p.bg, 0.9),
              edgeTagBorder: withAlpha(srcColor, 0.42),
            },
          };
        }),
    ];

    const cy = cytoscape({
      container: wrapRef.current,
      elements,
      wheelSensitivity: 0.25,
      minZoom: 0.22,
      maxZoom: 3.2,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(fill)',
            'background-opacity': 1,
            'border-width': 1.6,
            'border-color': 'data(stroke)',
            'border-opacity': 0.92,
            'underlay-color': 'data(stroke)',
            'underlay-shape': 'ellipse',
            'underlay-opacity': 0,
            'underlay-padding': 0,
            width: 'mapData(degree, 0, 10, 20, 40)',
            height: 'mapData(degree, 0, 10, 20, 40)',
            label: 'data(label)',
            'font-family': GRAPH_FONT,
            'font-size': 10.5,
            'font-weight': 400,
            color: 'data(mutedLabelColor)',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 7,
            'text-max-width': '136px',
            'text-wrap': 'none',
            'text-outline-width': 0,
            'text-background-color': 'data(tagBg)',
            'text-background-opacity': 0.78,
            'text-background-shape': 'roundrectangle',
            'text-background-padding': '3px',
            'text-border-width': 0.8,
            'text-border-color': 'data(tagBorder)',
            'text-border-opacity': 0.65,
            'min-zoomed-font-size': 7.5,
            'overlay-opacity': 0,
            'transition-property':
              'background-color, border-color, border-width, width, height, opacity, text-opacity, underlay-opacity, underlay-padding',
            'transition-duration': 180,
            'transition-timing-function': 'ease-out',
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
            width: 1.3,
            'line-color': 'data(lineColor)',
            'target-arrow-color': 'data(lineColor)',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.56,
            'curve-style': 'bezier',
            'control-point-step-size': 28,
            opacity: 0.88,
            'overlay-opacity': 0,
            'font-family': GRAPH_FONT,
            'font-size': 9.5,
            'font-weight': 400,
            color: 'data(labelColor)',
            'text-outline-width': 0,
            'text-rotation': 'none',
            'text-margin-y': 0,
            'text-background-color': 'data(edgeTagBg)',
            'text-background-opacity': 0.88,
            'text-background-shape': 'roundrectangle',
            'text-background-padding': '2.5px',
            'text-border-width': 0.8,
            'text-border-color': 'data(edgeTagBorder)',
            'text-border-opacity': 0.75,
            'transition-property': 'line-color, target-arrow-color, width, opacity, text-opacity',
            'transition-duration': 180,
            'transition-timing-function': 'ease-out',
          },
        },
        { selector: 'edge[kind = "references"]', style: { 'line-style': 'dashed' } },
        {
          selector: 'edge[kind = "related"]',
          style: { 'line-color': 'data(strongColor)', 'target-arrow-color': 'data(strongColor)', width: 1.85 },
        },
        {
          selector: 'edge[kind = "evidence"]',
          style: { 'line-color': 'data(strongColor)', 'target-arrow-color': 'data(strongColor)', width: 1.75 },
        },
        {
          selector: 'edge.activeEdge',
          style: {
            width: 2.15,
            'line-color': 'data(activeColor)',
            'target-arrow-color': 'data(activeColor)',
            'arrow-scale': 0.66,
            label: 'data(edgeLabel)',
            opacity: 1,
          },
        },
        {
          selector: 'node.hover',
          style: {
            'background-color': 'data(activeFill)',
            'border-width': 2.4,
            'border-color': 'data(stroke)',
            'underlay-color': 'data(stroke)',
            'underlay-shape': 'ellipse',
            'underlay-padding': 8,
            'underlay-opacity': 0.2,
            label: 'data(hoverLabel)',
            color: 'data(labelColor)',
            'font-size': 11,
            'font-weight': 500,
            'text-background-opacity': 0.92,
            'text-border-color': 'data(activeTagBorder)',
            'text-border-opacity': 0.95,
          },
        },
        {
          selector: 'node:selected',
          style: {
            'background-color': 'data(activeFill)',
            'border-width': 2.8,
            'border-color': 'data(stroke)',
            'underlay-color': 'data(stroke)',
            'underlay-shape': 'ellipse',
            'underlay-padding': 10,
            'underlay-opacity': 0.28,
            label: 'data(hoverLabel)',
            color: 'data(labelColor)',
            'font-size': 11,
            'font-weight': 500,
            'text-background-opacity': 0.94,
            'text-border-color': 'data(activeTagBorder)',
            'text-border-opacity': 1,
          },
        },
        { selector: '.dim', style: { opacity: 0.16, 'text-opacity': 0.14, 'underlay-opacity': 0 } },
        { selector: 'edge.dim', style: { opacity: 0.07 } },
        {
          selector: 'node.focus',
          style: {
            'background-color': 'data(activeFill)',
            'border-width': 2.8,
            'underlay-color': 'data(stroke)',
            'underlay-shape': 'ellipse',
            'underlay-padding': 10,
            'underlay-opacity': 0.28,
            label: 'data(hoverLabel)',
            color: 'data(labelColor)',
            'font-size': 11,
            'font-weight': 500,
            'text-background-opacity': 0.94,
            'text-border-color': 'data(activeTagBorder)',
            'text-border-opacity': 1,
          },
        },
        { selector: '.hideLabel', style: { 'text-opacity': 0 } },
      ],
      layout: { name: 'preset' },
    });

    // 统一管理悬停 + 选中 + 搜索聚焦的高亮状态，修复 mouseout 误清已选中邻域的问题
    const syncHighlight = () => {
      cy.batch(() => {
        cy.nodes().removeClass('hover');
        cy.edges().removeClass('activeEdge');

        const hId = hoveredIdRef.current;
        const sId = selectedIdRef.current;
        const focusNodes = cy.nodes('.focus');

        if (hId) {
          const hEl = cy.getElementById(hId);
          if (hEl.length > 0) {
            hEl.addClass('hover');
            let keep = hEl.closedNeighborhood();
            hEl.connectedEdges().addClass('activeEdge');
            if (sId && sId !== hId) {
              const sEl = cy.getElementById(sId);
              if (sEl.length > 0) {
                keep = keep.union(sEl.closedNeighborhood());
                sEl.connectedEdges().addClass('activeEdge');
              }
            }
            cy.elements().addClass('dim');
            keep.removeClass('dim');
            keep.edges().removeClass('dim');
            return;
          }
        }

        if (sId) {
          const sEl = cy.getElementById(sId);
          if (sEl.length > 0) {
            const keep = sEl.closedNeighborhood();
            sEl.connectedEdges().addClass('activeEdge');
            cy.elements().addClass('dim');
            keep.removeClass('dim');
            keep.edges().removeClass('dim');
            return;
          }
        }

        if (focusNodes.length > 0) {
          cy.elements().addClass('dim');
          focusNodes.removeClass('dim');
          focusNodes.connectedEdges().removeClass('dim').addClass('activeEdge');
          focusNodes.neighborhood('node').removeClass('dim');
          return;
        }

        cy.elements().removeClass('dim');
      });
    };

    const spawnRipple = (nodeId: string, duration = 680) => {
      const color = nodeColorMap.get(nodeId) ?? p.accent;
      ripplesRef.current.push({
        nodeId,
        color,
        bornAt: performance.now(),
        duration,
      });
    };

    cy.on('tap', 'node', (evt) => {
      const id = evt.target.id();
      const node = data.nodes.find((n) => n.id === id) ?? null;
      selectedIdRef.current = id;
      setSelected(node);
      spawnRipple(id, 760);
      syncHighlight();
    });

    cy.on('tap', (evt) => {
      if (evt.target === cy) {
        selectedIdRef.current = null;
        setSelected(null);
        syncHighlight();
      }
    });

    cy.on('mouseover', 'node', (evt) => {
      const id = evt.target.id();
      hoveredIdRef.current = id;
      const node = data.nodes.find((n) => n.id === id) ?? null;
      setHoveredNode(node);
      setCursorMode((prev) => (prev === 'grabbing' ? 'grabbing' : 'pointer'));
      syncHighlight();
    });

    cy.on('mouseout', 'node', () => {
      hoveredIdRef.current = null;
      setHoveredNode(null);
      setCursorMode((prev) => (prev === 'grabbing' ? 'grabbing' : 'default'));
      syncHighlight();
    });

    cy.on('dbltap', 'node', (evt) => {
      const id = evt.target.id();
      const node = data.nodes.find((n) => n.id === id);
      if (node?.href) openNodeRecord(node);
    });

    cy.on('zoom', () => {
      setZoomPct(Math.round(cy.zoom() * 100));
    });

    // =========================================================================
    // 弹簧物理牵引引擎（Spring Physics Tether）+ 视口同步流光粒子 Canvas
    // =========================================================================
    let grabbedId: string | null = null;
    let settleUntil = 0;
    const velMap = new Map<string, { vx: number; vy: number }>();

    cy.on('grab', 'node', (evt) => {
      const id = evt.target.id();
      grabbedId = id;
      setCursorMode('grabbing');
      spawnRipple(id, 620);
    });

    cy.on('drag', 'node', () => {
      settleUntil = performance.now() + 520;
    });

    cy.on('free', 'node', () => {
      grabbedId = null;
      setCursorMode(hoveredIdRef.current ? 'pointer' : 'default');
      settleUntil = performance.now() + 560;
    });

    const stepSpringPhysics = (now: number) => {
      const hasImpulse = now < nudgeImpulseRef.current;
      const isDraggingOrSettling = Boolean(grabbedId) || now < settleUntil || hasImpulse;
      if (!physicsEnabledRef.current || !isDraggingOrSettling) return;

      const nodes = cy.nodes();
      const count = nodes.length;
      if (count <= 1) return;

      const positions = new Map<string, { x: number; y: number }>();
      const forces = new Map<string, { fx: number; fy: number }>();
      const activeNeighbors = new Set<string>();

      if (grabbedId) {
        const gNode = cy.getElementById(grabbedId);
        gNode.neighborhood('node').forEach((nb) => {
          activeNeighbors.add(nb.id());
        });
      }

      nodes.forEach((n) => {
        const pos = n.position();
        positions.set(n.id(), { x: pos.x, y: pos.y });
        forces.set(n.id(), { fx: 0, fy: 0 });
      });

      // 1) 相连边胡克弹簧牵引力（拖动节点时一跳邻居平滑弹性跟随）
      const idealLen = 142;
      cy.edges().forEach((e) => {
        const sId = e.source().id();
        const tId = e.target().id();
        const pS = positions.get(sId);
        const pT = positions.get(tId);
        if (!pS || !pT) return;

        const touchesGrabbed = sId === grabbedId || tId === grabbedId;
        const touchesNeighbor = activeNeighbors.has(sId) || activeNeighbors.has(tId);
        if (!hasImpulse && !touchesGrabbed && !touchesNeighbor) return;

        const dx = pT.x - pS.x;
        const dy = pT.y - pS.y;
        const dist = Math.hypot(dx, dy) || 1;
        const diff = dist - idealLen;
        const k = touchesGrabbed ? 0.055 : 0.022;
        const f = diff * k;
        const ux = (dx / dist) * f;
        const uy = (dy / dist) * f;

        if (sId !== grabbedId) {
          const fs = forces.get(sId)!;
          fs.fx += ux;
          fs.fy += uy;
        }
        if (tId !== grabbedId) {
          const ft = forces.get(tId)!;
          ft.fx -= ux;
          ft.fy -= uy;
        }
      });

      // 2) 短程防重叠柔性排斥力（避免拖拽或聚集时节点挤压在一起）
      const nodeArr = nodes.toArray();
      const minSep = hasImpulse ? 148 : 126;
      for (let i = 0; i < nodeArr.length; i += 1) {
        const idA = nodeArr[i].id();
        const pA = positions.get(idA)!;
        for (let j = i + 1; j < nodeArr.length; j += 1) {
          const idB = nodeArr[j].id();
          const pB = positions.get(idB)!;
          const dx = pB.x - pA.x;
          const dy = pB.y - pA.y;
          const distSq = dx * dx + dy * dy;
          if (distSq > minSep * minSep || distSq < 0.01) continue;
          const dist = Math.sqrt(distSq);
          const push = ((minSep - dist) / minSep) * (hasImpulse ? 2.6 : 1.65);
          const ux = (dx / dist) * push;
          const uy = (dy / dist) * push;
          if (idA !== grabbedId) {
            const fA = forces.get(idA)!;
            fA.fx -= ux;
            fA.fy -= uy;
          }
          if (idB !== grabbedId) {
            const fB = forces.get(idB)!;
            fB.fx += ux;
            fB.fy += uy;
          }
        }
      }

      // 3) 速度积分与阻尼更新位置
      const damping = 0.78;
      const maxStep = 8.5;
      cy.batch(() => {
        nodes.forEach((n) => {
          const id = n.id();
          if (id === grabbedId || n.grabbed()) return;
          const f = forces.get(id)!;
          const v = velMap.get(id) ?? { vx: 0, vy: 0 };
          v.vx = (v.vx + f.fx) * damping;
          v.vy = (v.vy + f.fy) * damping;
          const speed = Math.hypot(v.vx, v.vy);
          if (speed > maxStep) {
            v.vx = (v.vx / speed) * maxStep;
            v.vy = (v.vy / speed) * maxStep;
          }
          velMap.set(id, v);
          if (speed > 0.08) {
            const pos = positions.get(id)!;
            n.position({ x: pos.x + v.vx, y: pos.y + v.vy });
          }
        });
      });
    };

    // 绘制背景视差微光点阵 + 连线流光脉冲粒子 + 节点同心呼吸光环与水波纹
    let rafId = 0;
    const renderFxOverlay = (now: number) => {
      stepSpringPhysics(now);

      const canvas = fxCanvasRef.current;
      const wrap = wrapRef.current;
      if (canvas && wrap) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = wrap.clientWidth;
        const h = wrap.clientHeight;
        if (w > 0 && h > 0) {
          if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
          }
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.save();
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, w, h);

            const pan = cy.pan();
            const zoom = cy.zoom();
            const activeNodeId = hoveredIdRef.current ?? selectedIdRef.current ?? (focusNodeId || null);
            const activeEl = activeNodeId ? cy.getElementById(activeNodeId) : null;
            let activeScreenPos: { x: number; y: number; color: string } | null = null;
            if (activeEl && activeEl.length > 0) {
              const mp = activeEl.position();
              activeScreenPos = {
                x: mp.x * zoom + pan.x,
                y: mp.y * zoom + pan.y,
                color: nodeColorMap.get(activeNodeId!) ?? p.accent,
              };
            }

            // 1) 随视口平移缩放联动的视差点阵网格 + 活跃节点引力场聚光
            const step = Math.max(22, Math.min(54, 34 * zoom));
            const offsetX = ((pan.x % step) + step) % step;
            const offsetY = ((pan.y % step) + step) % step;
            for (let gx = offsetX; gx < w; gx += step) {
              for (let gy = offsetY; gy < h; gy += step) {
                let alpha = 0.09;
                let dotRadius = 1;
                if (activeScreenPos) {
                  const d = Math.hypot(gx - activeScreenPos.x, gy - activeScreenPos.y);
                  if (d < 210) {
                    const boost = 1 - d / 210;
                    alpha = 0.09 + boost * 0.24;
                    dotRadius = 1 + boost * 0.85;
                  }
                }
                ctx.fillStyle = withAlpha(activeScreenPos && alpha > 0.14 ? activeScreenPos.color : p.ink, alpha);
                ctx.beginPath();
                ctx.arc(gx, gy, dotRadius, 0, Math.PI * 2);
                ctx.fill();
              }
            }

            // 2) 活跃节点柔和径向环境光晕 & 同心呼吸声呐环
            const drawNodeSonar = (nodeId: string, isPrimary: boolean) => {
              const el = cy.getElementById(nodeId);
              if (!el || el.length === 0) return;
              const mp = el.position();
              const sx = mp.x * zoom + pan.x;
              const sy = mp.y * zoom + pan.y;
              const color = nodeColorMap.get(nodeId) ?? p.accent;
              const baseR = ((el.width() || 26) * zoom) / 2;

              // 柔和径向光晕
              const grad = ctx.createRadialGradient(sx, sy, baseR * 0.3, sx, sy, baseR * (isPrimary ? 3.4 : 2.5));
              grad.addColorStop(0, withAlpha(color, isPrimary ? 0.24 : 0.16));
              grad.addColorStop(0.55, withAlpha(color, isPrimary ? 0.08 : 0.04));
              grad.addColorStop(1, withAlpha(color, 0));
              ctx.fillStyle = grad;
              ctx.beginPath();
              ctx.arc(sx, sy, baseR * (isPrimary ? 3.4 : 2.5), 0, Math.PI * 2);
              ctx.fill();

              // 呼吸脉冲外环
              const phase = ((now * 0.00095) % 1);
              const ringR = baseR + 4 + phase * (baseR * 1.35 + 12);
              ctx.strokeStyle = withAlpha(color, (1 - phase) * (isPrimary ? 0.48 : 0.3));
              ctx.lineWidth = isPrimary ? 1.5 : 1.1;
              ctx.beginPath();
              ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
              ctx.stroke();
            };

            if (selectedIdRef.current) drawNodeSonar(selectedIdRef.current, true);
            if (hoveredIdRef.current && hoveredIdRef.current !== selectedIdRef.current) {
              drawNodeSonar(hoveredIdRef.current, false);
            }

            // 3) 点击/抓起节点时扩散的水波纹冲击波
            ripplesRef.current = ripplesRef.current.filter((rp) => {
              const age = now - rp.bornAt;
              if (age >= rp.duration) return false;
              const el = cy.getElementById(rp.nodeId);
              if (!el || el.length === 0) return false;
              const t = age / rp.duration;
              const ease = 1 - Math.pow(1 - t, 3);
              const mp = el.position();
              const sx = mp.x * zoom + pan.x;
              const sy = mp.y * zoom + pan.y;
              const baseR = ((el.width() || 24) * zoom) / 2;
              const r = baseR + ease * Math.max(44, baseR * 2.6);
              ctx.strokeStyle = withAlpha(rp.color, (1 - ease) * 0.65);
              ctx.lineWidth = 1.8 * (1 - ease * 0.5);
              ctx.beginPath();
              ctx.arc(sx, sy, r, 0, Math.PI * 2);
              ctx.stroke();
              return true;
            });

            // 4) 连线动态流光脉冲粒子（Edge Data Flow Pulses）
            const edges = cy.edges();
            edges.forEach((e, idx) => {
              const isDim = e.hasClass('dim');
              if (isDim) return;
              const isActive = e.hasClass('activeEdge');
              // 常态下只为前 24 条边发射轻柔巡航微光，悬停或选中时为所有活跃关联边发射高亮双脉冲
              if (!isActive && idx > 24) return;

              const src = e.source().position();
              const tgt = e.target().position();
              const sx = src.x * zoom + pan.x;
              const sy = src.y * zoom + pan.y;
              const tx = tgt.x * zoom + pan.x;
              const ty = tgt.y * zoom + pan.y;
              const len = Math.hypot(tx - sx, ty - sy);
              if (len < 18) return;

              const color = nodeColorMap.get(e.source().id()) ?? p.accent;
              const speed = isActive ? 0.00058 : 0.00026;
              const pulseCount = isActive ? 2 : 1;

              for (let k = 0; k < pulseCount; k += 1) {
                const t = ((now * speed + idx * 0.19 + k * 0.5) % 1);
                const px = sx + (tx - sx) * t;
                const py = sy + (ty - sy) * t;
                const tailT = Math.max(0, t - (isActive ? 0.14 : 0.09));
                const tailX = sx + (tx - sx) * tailT;
                const tailY = sy + (ty - sy) * tailT;

                // 流光彗星尾迹
                const tailGrad = ctx.createLinearGradient(tailX, tailY, px, py);
                tailGrad.addColorStop(0, withAlpha(color, 0));
                tailGrad.addColorStop(1, withAlpha(color, isActive ? 0.78 : 0.34));
                ctx.strokeStyle = tailGrad;
                ctx.lineWidth = isActive ? 2.4 : 1.4;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(tailX, tailY);
                ctx.lineTo(px, py);
                ctx.stroke();

                // 脉冲头部亮核
                ctx.fillStyle = isActive ? '#ffffff' : withAlpha(color, 0.72);
                ctx.beginPath();
                ctx.arc(px, py, isActive ? 2.3 : 1.5, 0, Math.PI * 2);
                ctx.fill();
              }
            });

            ctx.restore();
          }
        }
      }

      rafId = window.requestAnimationFrame(renderFxOverlay);
    };

    rafId = window.requestAnimationFrame(renderFxOverlay);

    cyRef.current = cy;
    // 自检/调试用：页面卸载时清掉
    (window as unknown as { __cy?: cytoscape.Core }).__cy = cy;
    const run = (name: LayoutName) => {
      const l = cy.layout(buildLayoutOptions(name, spacing));
      l.one('layoutstop', () => {
        nudgeImpulseRef.current = performance.now() + 520;
        setZoomPct(Math.round(cy.zoom() * 100));
        if (focusNodeId) {
          const targetEl = cy.getElementById(focusNodeId);
          if (targetEl.length > 0) {
            targetEl.select();
            targetEl.addClass('focus');
            selectedIdRef.current = focusNodeId;
            syncHighlight();
            cy.fit(undefined, 48);
            spawnRipple(focusNodeId, 900);
          }
        }
      });
      l.run();
    };
    run(layout);

    if (focusNodeId) {
      const targetEl = cy.getElementById(focusNodeId);
      if (targetEl.length > 0) {
        targetEl.select();
        targetEl.addClass('focus');
        selectedIdRef.current = focusNodeId;
        syncHighlight();
      }
    }

    const ro = new ResizeObserver(() => {
      cy.resize();
      cy.fit(undefined, 44);
      setZoomPct(Math.round(cy.zoom() * 100));
    });
    ro.observe(wrapRef.current);

    return () => {
      window.cancelAnimationFrame(rafId);
      ro.disconnect();
      cy.destroy();
      cyRef.current = null;
      delete (window as unknown as { __cy?: cytoscape.Core }).__cy;
    };
    // 只在数据或过滤变化时重建；布局与色调由下面的 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, hiddenTypes, includeArchived, focusNodeId]);

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
        const solid = typeColor(n.data('type') as GraphNodeType, p);
        n.data('fill', withAlpha(solid, 0.28));
        n.data('activeFill', withAlpha(solid, 0.44));
        n.data('stroke', solid);
        n.data('mutedLabelColor', withAlpha(p.ink, 0.76));
        n.data('labelColor', p.ink);
        n.data('halo', p.bg);
        n.data('tagBg', withAlpha(p.bg, 0.82));
        n.data('tagBorder', withAlpha(p.ink, 0.12));
        n.data('activeTagBorder', withAlpha(solid, 0.45));
      });
      cy.edges().forEach((e) => {
        const kind = e.data('kind') as GraphLink['type'];
        const srcType = e.source().data('type') as GraphNodeType | undefined;
        const srcSolid = srcType ? typeColor(srcType, p) : p.accent;
        e.data('lineColor', withAlpha(p.ink, 0.26));
        e.data('strongColor', withAlpha(kind === 'evidence' ? p.done : srcSolid, 0.88));
        e.data('activeColor', withAlpha(srcSolid, 0.92));
        e.data('labelColor', withAlpha(p.ink, 0.86));
        e.data('halo', p.bg);
        e.data('edgeTagBg', withAlpha(p.bg, 0.9));
        e.data('edgeTagBorder', withAlpha(srcSolid, 0.42));
      });
      cy.style().update();
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
        cy.elements().removeClass('dim');
        cy.edges().removeClass('activeEdge');
        cy.nodes().forEach((n) => {
          if (ids.has(n.id())) n.addClass('focus');
          else n.removeClass('focus');
        });
        const keep = cy.nodes('.focus');
        if (keep.length > 0) {
          cy.elements().addClass('dim');
          keep.removeClass('dim');
          keep.connectedEdges().removeClass('dim').addClass('activeEdge');
          keep.neighborhood('node').removeClass('dim');
        }
        if (ids.size > 0) cy.animate({ fit: { eles: cy.nodes('.focus'), padding: 80 }, duration: 280 });
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
      mobileLeftLabel="筛选与搜索"
      mobileTopRight={
        <Button onClick={() => cyRef.current?.fit(undefined, 40)}>适应窗口</Button>
      }
      left={
        <>
          <div className={styles.filterBlock}>
            <div className={styles.sectionHeader}>
              <h3 className={styles.sectionTitle}>搜索节点</h3>
            </div>
            <div className={styles.searchRow}>
              <div className={styles.searchShell}>
                <svg className={styles.searchIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <input
                  className={styles.searchInput}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
                    if (e.key === 'Enter' && !composing) void runSearch();
                  }}
                  placeholder="标题或正文"
                  aria-label="搜索节点"
                />
                {(query || hits) && (
                  <button
                    type="button"
                    className={styles.clearIconBtn}
                    aria-label="清除搜索"
                    title="清除"
                    onClick={() => {
                      setHits(null);
                      setQuery('');
                      cyRef.current?.nodes().removeClass('focus');
                      cyRef.current?.elements().removeClass('dim');
                      cyRef.current?.fit(undefined, 40);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
              <button
                type="button"
                className={styles.searchSubmit}
                onClick={() => void runSearch()}
                disabled={searching}
              >
                {searching ? '…' : '搜索'}
              </button>
            </div>
          </div>

          {hits && (
            <div className={styles.hitsBlock}>
              <div className={styles.hitsHead}>
                <h3 className={styles.sectionTitle}>命中 {hits.length}</h3>
              </div>
              {hits.length === 0 && <p className="v2-groupNote" style={{ padding: '0 6px' }}>没有命中。</p>}
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
                      // 命中节点超出当前画布（例如超出全局 240 上限）：直接切入该节点的局部图
                      updateFocusParams(h.node.id, 1);
                    }
                  }}
                >
                  <span className="v2-leftTitle">{h.node.label.slice(0, 22)}</span>
                  <span className="v2-leftMeta">{TYPE_LABEL[h.node.type]}</span>
                </button>
              ))}
            </div>
          )}

          <div className={styles.filterBlock}>
            <div className={styles.sectionHeader}>
              <h3 className={styles.sectionTitle}>显示哪些</h3>
              {hiddenTypes.size > 0 && (
                <button
                  type="button"
                  className={styles.resetLink}
                  onClick={() => {
                    setHiddenTypes(new Set());
                    setSelected(null);
                  }}
                >
                  全部显示
                </button>
              )}
            </div>
            <div className={styles.filterList}>
              {(Object.keys(TYPE_LABEL) as GraphNodeType[]).map((t) => {
                const active = !hiddenTypes.has(t);
                const count = (data?.nodes ?? []).filter((n) => n.type === t).length;
                return (
                  <label
                    key={t}
                    className={styles.filterRow}
                    data-active={active}
                  >
                    <input
                      type="checkbox"
                      className={styles.srInput}
                      checked={active}
                      onChange={() => toggleType(t)}
                    />
                    <span
                      className={styles.typeDot}
                      style={{ backgroundColor: TYPE_CSS_COLOR[t] }}
                      aria-hidden="true"
                    />
                    <span className={styles.filterName}>{TYPE_LABEL[t]}</span>
                    <span className={`${styles.filterCount}${count === 0 ? ' ' + styles.filterCountZero : ''}`}>
                      {count}
                    </span>
                    <span className={styles.switchTrack} aria-hidden="true">
                      <span className={styles.switchThumb} />
                    </span>
                  </label>
                );
              })}

              <div className={styles.divider} aria-hidden="true" />

              <label
                className={styles.filterRow}
                data-active={includeArchived}
              >
                <input
                  type="checkbox"
                  className={styles.srInput}
                  checked={includeArchived}
                  onChange={(e) => setIncludeArchived(e.target.checked)}
                />
                <span className={styles.filterName}>
                  包含已归档
                </span>
                <span className={styles.switchTrack} aria-hidden="true">
                  <span className={styles.switchThumb} />
                </span>
              </label>
            </div>
          </div>
        </>
      }
      rightTitle={selected ? TYPE_LABEL[selected.type] : '图例'}
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">布局</h3>
            <div className={styles.layoutWrap}>
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
              <div className={styles.fitRow}>
                <Button onClick={() => cyRef.current?.fit(undefined, 40)}>适应窗口</Button>
              </div>
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
              <Button variant="primary" onClick={() => openNodeRecord(selected)} data-testid="graph-open-record">
                打开这条记录
              </Button>
              {focusNodeId !== selected.id && (
                <Button onClick={() => updateFocusParams(selected.id, 1)}>
                  以此节点看局部图
                </Button>
              )}
              <p className="v2-groupNote">双击节点也能直接打开。</p>
            </div>
          </>
        ) : (
          <>
            <div>
              <h3 className="v2-groupTitle">节点</h3>
              {(Object.keys(TYPE_LABEL) as GraphNodeType[]).map((t) => (
                <div key={t} className="v2-groupItem">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--ink)' }}>
                    <span className={styles.shapeBadge} style={{ '--node-color': TYPE_CSS_COLOR[t] } as CSSProperties}>
                      <NodeShapeIcon type={t} />
                    </span>
                    {TYPE_LABEL[t]}
                  </span>
                  <span className="v2-hint">{stats ? (stats as Record<string, number>)[t === 'capture' ? 'captures' : t === 'attempt' ? 'attempts' : t === 'research' ? 'research' : t === 'review' ? 'reviews' : t === 'schedule' ? 'schedules' : 'experiences'] ?? 0 : '—'}</span>
                </div>
              ))}
            </div>
            <div>
              <h3 className="v2-groupTitle">连线</h3>
              <p className="v2-groupNote">
                共 {stats?.links ?? 0} 条，其中手动关联 {stats?.manualLinks ?? 0} 条。连线只表示记录里写下的关系，不做相似度推断。
              </p>
              <div className={styles.linkGrid}>
                {(Object.keys(LINK_LABEL) as Array<GraphLink['type']>).map((k) => {
                  const cnt = (data?.links ?? []).filter((l) => l.type === k).length;
                  return (
                    <div key={k} className={`${styles.linkItem}${cnt === 0 ? ' ' + styles.linkItemZero : ''}`}>
                      <span>{LINK_LABEL[k]}</span>
                      <span className="v2-hint">{cnt}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <h3 className="v2-groupTitle">提示</h3>
              <p className="v2-groupNote">滚轮缩放、拖动节点、点节点看详情、双击打开。图的渲染由 Cytoscape.js 负责。</p>
            </div>
          </>
        )}
        </>
      }
      statusLeft={
        stats
          ? `${focusNodeId ? `局部图（${focusDepth} 跳） · ` : ''}${visibleCount} 个节点 · ${stats.links} 条连线${
              data?.meta?.truncated ? '（已按默认上限截断）' : ''
            }`
          : '加载中'
      }
      statusRight={
        <span>
          {layout === 'fcose' ? '力导向' : layout === 'concentric' ? '同心' : layout === 'grid' ? '网格' : '环形'}
        </span>
      }
    >
      {(focusNodeId || returnTo) && (
        <div className={styles.focusBar} data-testid="graph-focus-bar">
          <div className={styles.focusMain}>
            {returnTo && (
              <Link className={styles.returnLink} to={returnTo} data-testid="graph-return-link">
                ← {topicNav.fromTopic ? '返回主题' : '返回刚才阅读的位置'}
              </Link>
            )}
            {focusNodeId && (
              <span className={styles.focusLabel}>
                局部聚焦：
                <strong>
                  {data?.nodes.find((n) => n.id === focusNodeId)?.label ?? focusNodeId}
                </strong>
              </span>
            )}
          </div>
          {focusNodeId && (
            <div className={styles.focusActions}>
              <Segment
                ariaLabel="局部图深度"
                items={[
                  { value: '1', label: '1 跳' },
                  { value: '2', label: '2 跳' },
                ]}
                value={String(focusDepth)}
                onChange={(v) => updateFocusParams(focusNodeId, v === '2' ? 2 : 1)}
              />
              <Button onClick={() => updateFocusParams(null)}>切回全局图</Button>
            </div>
          )}
        </div>
      )}
      {focusNotice && (
        <p className="v2-state" style={{ paddingTop: 6, paddingBottom: 0, color: 'var(--st-partial)' }}>
          {focusNotice}
        </p>
      )}
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
          {focusNodeId && (
            <button type="button" className="v2-linkBtn" onClick={() => updateFocusParams(null)}>
              查看全局图
            </button>
          )}
        </p>
      )}
      {!loading && !error && (data?.nodes.length ?? 0) === 0 && (
        <p className="v2-state">还没有可以上图的记录。记录一条念头，它就会出现在这里。</p>
      )}
      <div className="v2-graphWrap">
        <canvas ref={fxCanvasRef} className={styles.fxCanvas} aria-hidden="true" />
        <div
          ref={wrapRef}
          className={`v2-graphCanvas ${styles.cyStage}`}
          data-cursor={cursorMode}
          aria-label="知识图谱画布"
        />
        {hoveredNode && (
          <div
            className={styles.hoverCard}
            style={{ '--hover-color': TYPE_CSS_COLOR[hoveredNode.type] } as CSSProperties}
          >
            <div className={styles.hoverCardHead}>
              <span className={styles.hoverTypeTag}>
                <NodeShapeIcon type={hoveredNode.type} />
                {TYPE_LABEL[hoveredNode.type]}
              </span>
              <span className={styles.hoverMeta}>
                关联 {hoveredNode.degree} · {dayLabel(hoveredNode.createdAt, tz, todayDateKey(tz))}
              </span>
            </div>
            <p className={styles.hoverTitle}>{hoveredNode.label}</p>
            <p className={styles.hoverHint}>单击锁定关系网 · 拖拽弹性牵引 · 双击打开原文</p>
          </div>
        )}
        <div className={styles.canvasHintPill} aria-hidden="true">
          <span className={physicsEnabled ? styles.hudPulseDot : styles.hudPulseDotOff} />
          <span>{physicsEnabled ? '弹簧物理力场 · 拖拽节点牵引一跳邻居' : '静态拖拽模式'}</span>
        </div>
        <div className={styles.canvasHud} role="toolbar" aria-label="图谱画布交互控制">
          <button
            type="button"
            className={`${styles.hudBtn} ${physicsEnabled ? styles.hudBtnActive : ''}`}
            onClick={() => setPhysicsEnabled((v) => !v)}
            title={physicsEnabled ? '关闭拖拽弹簧物理牵引' : '开启拖拽弹簧物理牵引'}
          >
            <span className={physicsEnabled ? styles.hudPulseDot : styles.hudPulseDotOff} />
            <span>物理牵引</span>
          </button>
          <button
            type="button"
            className={styles.hudBtn}
            onClick={() => {
              nudgeImpulseRef.current = performance.now() + 680;
              setPhysicsEnabled(true);
            }}
            title="给所有节点注入一次柔和排斥舒展脉冲"
          >
            ✦ 舒展
          </button>
          <span className={styles.hudSep} aria-hidden="true" />
          <button
            type="button"
            className={styles.hudBtn}
            onClick={() => {
              const cy = cyRef.current;
              if (!cy) return;
              const next = Math.max(0.25, cy.zoom() * 0.82);
              cy.animate({
                zoom: { level: next, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } },
                duration: 180,
              });
            }}
            aria-label="缩小画布"
            title="缩小"
          >
            −
          </button>
          <button
            type="button"
            className={styles.hudBtn}
            onClick={() => {
              const cy = cyRef.current;
              if (!cy) return;
              cy.animate({ fit: { eles: cy.elements(), padding: 48 }, duration: 260 });
            }}
            title="点击适应窗口（当前缩放比例）"
          >
            {zoomPct}%
          </button>
          <button
            type="button"
            className={styles.hudBtn}
            onClick={() => {
              const cy = cyRef.current;
              if (!cy) return;
              const next = Math.min(2.8, cy.zoom() * 1.22);
              cy.animate({
                zoom: { level: next, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } },
                duration: 180,
              });
            }}
            aria-label="放大画布"
            title="放大"
          >
            +
          </button>
          {selected && (
            <>
              <span className={styles.hudSep} aria-hidden="true" />
              <button
                type="button"
                className={styles.hudBtn}
                onClick={() => {
                  const cy = cyRef.current;
                  if (!cy) return;
                  const el = cy.getElementById(selected.id);
                  if (el.length > 0) {
                    cy.animate({
                      fit: { eles: el.closedNeighborhood(), padding: 80 },
                      duration: 300,
                    });
                  }
                }}
                title="聚焦到当前选中节点及其邻域"
              >
                ◎ 邻域
              </button>
            </>
          )}
        </div>
      </div>
      {selected && (
        <div className={styles.mobileNodeBar} data-testid="graph-mobile-node-bar">
          <div className={styles.mobileNodeHead}>
            <span
              className={styles.mobileNodeBadge}
              style={{ '--node-color': TYPE_CSS_COLOR[selected.type] } as CSSProperties}
            >
              <NodeShapeIcon type={selected.type} />
              {TYPE_LABEL[selected.type]}
            </span>
            <span className={styles.mobileNodeTitle}>{selected.label}</span>
            <button
              type="button"
              className={styles.mobileNodeDismiss}
              aria-label="取消选中节点"
              onClick={() => {
                const cy = cyRef.current;
                cy?.elements().unselect();
                cy?.elements().removeClass('dim activeEdge hover');
                selectedIdRef.current = null;
                setSelected(null);
              }}
            >
              ✕
            </button>
          </div>
          <div className={styles.mobileNodeActions}>
            {selected.href && (
              <Button
                variant="primary"
                onClick={() => openNodeRecord(selected)}
                data-testid="graph-mobile-open-record"
              >
                打开这条记录
              </Button>
            )}
            {focusNodeId !== selected.id ? (
              <Button onClick={() => updateFocusParams(selected.id, 1)}>看局部图</Button>
            ) : (
              <Button onClick={() => updateFocusParams(null)}>切回全局图</Button>
            )}
          </div>
        </div>
      )}
      {!loading && !error && (data?.nodes.length ?? 0) > 0 && (
        <Module title="图的读法" defaultOpen={false}>
          <p className="v2-state">节点大小表示连线多少；形状表示类型（念头圆、尝试方、经验菱形、研究六边形、回顾三角、日程方块）。</p>
        </Module>
      )}
    </V2Shell>
  );
}
