// 拾念 SHINIAN · 知识网络（全局图 / 局部图 / 搜索 / 筛选 / 稳定布局）
// 设计目标：把念头、经验、尝试、研究、回顾、安排投影为同一张可探索的关系网；图只读，业务数据仍从原记录进入。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import type { GraphLink, GraphNode, GraphResponse, GraphSearchHit, GraphNodeType } from '../types';
import { GRAPH_TYPE_LABEL, formatTime } from '../types';
import { readTopicNav } from '../components/topicNav';
// 节点详情面板的补充样式（副标题 / 按钮层级 / 画布空态提示）。只作用于本页。
import '../graph-detail.css';

const DEFAULT_W = 1200;
const DEFAULT_H = 820;
// Obsidian 默认图谱的节点色（graph.json 里 colorGroups 的 rgb 14048454）。
const MONO_COLOR = '#d65cc6';

/**
 * 力导向与外观参数。字段名与默认值对齐 Obsidian graph.json 的显示/力度分区，
 * 让同一套调参语言在两边说得通：centerStrength / repelStrength / linkStrength /
 * linkDistance / nodeSizeMultiplier / lineSizeMultiplier / textFadeMultiplier。
 */
type ForceSettings = {
  repelStrength: number;
  centerStrength: number;
  linkStrength: number;
  linkDistance: number;
  nodeSize: number;
  lineSize: number;
  textFade: number;
};
const DEFAULT_FORCES: ForceSettings = {
  repelStrength: 10,
  centerStrength: 0.5187,
  linkStrength: 1,
  linkDistance: 250,
  nodeSize: 0.851,
  lineSize: 1.469,
  textFade: -3,
};
const FORCE_ORDER: Array<keyof ForceSettings> = [
  'centerStrength',
  'repelStrength',
  'linkStrength',
  'linkDistance',
  'nodeSize',
  'lineSize',
  'textFade',
];
const FORCE_RANGE: Record<
  keyof ForceSettings,
  { min: number; max: number; step: number; label: string }
> = {
  centerStrength: { min: 0.05, max: 1, step: 0.01, label: '中心力' },
  repelStrength: { min: 0, max: 30, step: 0.5, label: '斥力' },
  linkStrength: { min: 0, max: 1, step: 0.02, label: '连线力' },
  linkDistance: { min: 20, max: 500, step: 10, label: '连线距离' },
  nodeSize: { min: 0.3, max: 3, step: 0.05, label: '节点大小' },
  lineSize: { min: 0.3, max: 3, step: 0.05, label: '连线粗细' },
  textFade: { min: -10, max: 10, step: 0.5, label: '文字淡出' },
};
/** 着色方式：类型（现有语义）/ 按所属念头分组 / 单色（Obsidian 默认观感）。 */
type ColorMode = 'type' | 'group' | 'mono';
const COLOR_MODE_LABEL: Record<ColorMode, string> = {
  type: '按记录类型',
  group: '按所属念头',
  mono: '单色',
};

const TYPE_COLOR: Record<GraphNode['type'], string> = {
  capture: '#aeb8c6',
  attempt: '#8aa2c2',
  research: '#a28fbd',
  review: '#b8a079',
  schedule: '#8aa89a',
  experience: '#c0aaa2',
};
const EDGE_COLOR = 'rgba(150, 155, 164, 0.30)';
const EDGE_ACTIVE = 'rgba(222, 227, 235, 0.62)';
const TYPE_RADIUS: Record<GraphNode['type'], number> = {
  capture: 5.2,
  attempt: 3.2,
  research: 3.8,
  review: 3.6,
  schedule: 2.8,
  experience: 4.2,
};
const STATE_LABEL: Record<string, string> = {
  todo: '待开始',
  in_progress: '进行中',
  done: '已完成',
  cancelled: '已放弃',
  pending: '生成中',
  succeeded: '已完成',
  failed: '失败',
  interrupted: '已中断',
};
const OUTCOME_LABEL: Record<string, string> = {
  success: '成功',
  failure: '失败',
  undetermined: '未确定',
};
const ORIGIN_LABEL: Record<string, string> = {
  manual: '自己创建',
  ai_suggestion: 'AI 建议采用',
  review_next_action: '来自回顾的下一步',
  research_experiment: '来自研究小实验',
  experience_retry: '参考经验再试',
};
const RELATION_LABEL: Record<GraphLink['type'], string> = {
  contains: '包含',
  references: '引用旧结果',
  related: '关联记录',
  researches: '研究',
  adopted: '采用尝试',
  scheduled: '安排',
  reviews: '回顾',
  evidence: '依据',
  used: '被尝试引用',
  context: '所属念头',
};
const ALL_TYPES: GraphNodeType[] = [
  'capture',
  'experience',
  'attempt',
  'research',
  'review',
  'schedule',
];
const ALL_RELATIONS: GraphLink['type'][] = [
  'contains',
  'references',
  'related',
  'researches',
  'adopted',
  'scheduled',
  'reviews',
  'evidence',
  'used',
  'context',
];

function relationText(link: GraphLink, outgoing: boolean): string {
  if (link.type === 'contains') return outgoing ? '包含这次尝试' : '属于这个念头';
  if (link.type === 'references') {
    return outgoing ? '引用了这条旧结果' : '被这条尝试引用';
  }
  if (link.type === 'related') return outgoing ? '关联到' : '被关联';
  if (link.type === 'researches') return outgoing ? '发起了这项研究' : '研究自这个念头';
  if (link.type === 'adopted') return outgoing ? '从研究采用为尝试' : '来自这项研究';
  if (link.type === 'scheduled') return outgoing ? '安排了时间' : '属于这次尝试';
  if (link.type === 'reviews') return outgoing ? '回顾了' : '被这次回顾引用';
  if (link.type === 'evidence') {
    return outgoing ? '依据这条记录' : '被这条经验引用为依据';
  }
  if (link.type === 'used') {
    return outgoing ? '参考这条经验再试' : '这次尝试引用了它';
  }
  if (link.type === 'context') {
    return outgoing ? '所属念头' : '这条经验所属的念头';
  }
  return link.label;
}

type Camera = { x: number; y: number; k: number };

/** 节点数不超过它时，画布给一行空态提示（再少就真的显得像没加载出来）。 */
const SMALL_CANVAS_NODES = 5;

function normText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 节点详情面板的两段文字。
 * 大标题（h2）已经完整说过节点名，所以：
 * - 副标题只说「这条记录属于谁、什么时候来的」，不再复述标题；
 * - 正文只放标题里没出现过的那段文字；标题已经把正文说完时整段不显示，
 *   避免同一句话在大标题和 14px 灰字里各说一遍。
 */
function nodePanelText(node: GraphNode | null): { subtitle: string; body: string } {
  if (!node) return { subtitle: '', body: '' };
  const label = normText(node.label);
  const head = label.replace(/…$/, '');
  const detail = normText(node.detail);
  // 剪掉正文开头「标题已经说过」的那一截，剩下的才是新信息。
  const rest = detail.startsWith(head) ? detail.slice(head.length).trim() : detail;
  const fresh = rest === label ? '' : rest;
  // 已撤下正文的回顾，正文区另有专门的提示块，这里不重复。
  const body =
    fresh && node.origin !== 'content_withheld'
      ? `${label.endsWith('…') ? '…' : ''}${fresh.replace(/^[。，、；：,.;:!?！？\s]+/, '')}`
      : '';

  const parts: string[] = [];
  const parent = node.captureLabel ? normText(node.captureLabel) : '';
  // 念头的 captureLabel 就是它自己，经验的 captureLabel 是它自己的标题：都不必说「属于」。
  if (node.type !== 'capture' && node.type !== 'experience' && parent && parent !== label) {
    parts.push(`属于「${parent}」`);
  }
  parts.push(`${node.type === 'schedule' ? '安排在' : '创建于'} ${formatTime(node.createdAt)}`);
  return { subtitle: parts.join(' · '), body };
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/* —— 任务 A · 知识网络动效（只决定「怎么把算好的位置演给人看」，不参与任何布局计算）——
 * 位置仍然由 buildLayout() 同步算完且完全确定；这一层只是一次性的入场演出，
 * 每条规则都可以单独降级：prefers-reduced-motion / 大图 / 用户开始交互。
 */
const SETTLE_MS = 1000; // 就位收敛时长
const SETTLE_FROM = 0.66; // 起始收拢比例（相对画布中心）——0.66 是"一眼看得出在收拢"的实测档位
const SETTLE_STEPS = 24; // 进度量化档数：最多 24 轮重渲染，慢帧自动并档
const STAGGER_GLOBAL_MS = 340; // 全图：按 id 哈希铺开的入场波宽
const STAGGER_LOCAL_MS = 260; // 局部图：最外一档（两跳及以外）的延迟
const STAGGER_JITTER_MS = 60; // 同一档内按 id 哈希的抖动上限
const MOTION_NODE_LIMIT = 240; // 节点数超过它 → 跳过收敛（保帧率）
const MOTION_LINK_LIMIT = 600; // 连线数超过它 → 跳过收敛（保帧率）

/** 把入场延迟写进节点/连线的内联 CSS 变量，由 graph-motion.css 消费。 */
function introStyle(delayMs: number): CSSProperties {
  return { '--in-delay': `${Math.round(delayMs)}ms` } as CSSProperties;
}

function radiusOf(node: GraphNode, scale = 1): number {
  const extra = Math.min(1.2, Math.sqrt(node.degree) * 0.4);
  return (TYPE_RADIUS[node.type] + extra) * scale;
}

/** 分组键：同一念头下的记录归一组；独立记录各自成组。 */
function groupKeyOf(node: GraphNode): string {
  return node.captureId ?? node.captureLabel ?? node.id;
}

/** 由分组键稳定映射到色相，同一念头每次刷新颜色不变。 */
function groupColor(key: string): string {
  return `hsl(${hash(key) % 360}, 46%, 68%)`;
}

function nodeColorOf(node: GraphNode, mode: ColorMode): string {
  if (mode === 'mono') return MONO_COLOR;
  if (mode === 'group') return groupColor(groupKeyOf(node));
  return TYPE_COLOR[node.type];
}

function buildLayout(
  nodes: GraphNode[],
  links: GraphLink[],
  width: number,
  height: number,
  nodeScale = 1,
  centerId: string | null = null,
  forces: ForceSettings = DEFAULT_FORCES
) {
  const W = width;
  const H = height;
  // 以 Obsidian 默认值为 1 的倍率：默认参数下布局与改造前完全一致，
  // 调参只改变倍率，不会让已有数据在刷新时跳到一个陌生的形状。
  const repelScale = forces.repelStrength / DEFAULT_FORCES.repelStrength;
  const centerScale = forces.centerStrength / DEFAULT_FORCES.centerStrength;
  const distScale = forces.linkDistance / DEFAULT_FORCES.linkDistance;
  const linkScale = forces.linkStrength / DEFAULT_FORCES.linkStrength;
  const pos = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  if (nodes.length === 0) return pos;
  const n = nodes.length;
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const link of links) {
    adjacency.get(link.source)?.add(link.target);
    adjacency.get(link.target)?.add(link.source);
  }

  // 稳定初始位置：按 ID 哈希排序后落在确定性的黄金角螺旋上。
  // 不依赖随机数，也不依赖当前筛选，因此刷新和切换筛选时不会跳动。
  const ordered = [...nodes].sort(
    (a, b) => (hash(a.id) % 1000003) - (hash(b.id) % 1000003)
  );
  const golden = Math.PI * (3 - Math.sqrt(5));
  const rx = Math.max(120, Math.min(W * 0.4, H * 0.58));
  const ry = Math.max(100, Math.min(H * 0.4, W * 0.58));
  ordered.forEach((node, index) => {
    if (centerId && node.id === centerId) {
      pos.set(node.id, { x: W / 2, y: H / 2, vx: 0, vy: 0 });
      return;
    }
    const t = Math.sqrt((index + 0.6) / n);
    const angle = index * golden + ((hash(node.id) % 360) / 360) * 0.4;
    pos.set(node.id, {
      x: W / 2 + Math.cos(angle) * rx * t,
      y: H / 2 + Math.sin(angle) * ry * t,
      vx: 0,
      vy: 0,
    });
  });

  // 局部图：按一跳 / 两跳距离放到中心节点周围的环上。
  if (centerId && pos.has(centerId)) {
    const dist = new Map<string, number>([[centerId, 0]]);
    let frontier = [centerId];
    for (let step = 1; step <= 2; step += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const neighbor of adjacency.get(id) ?? []) {
          if (dist.has(neighbor)) continue;
          dist.set(neighbor, step);
          next.push(neighbor);
        }
      }
      frontier = next;
    }
    for (const node of nodes) {
      if (node.id === centerId) continue;
      const step = dist.get(node.id) ?? 2;
      const angle = ((hash(node.id) % 1000) / 1000) * Math.PI * 2;
      const radius = step === 1 ? Math.min(W, H) * 0.34 : Math.min(W, H) * 0.5;
      pos.set(node.id, {
        x: W / 2 + Math.cos(angle) * radius,
        y: H / 2 + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      });
    }
  }

  const iterations = n > 320 ? 80 : n > 180 ? 110 : n > 80 ? 150 : 190;
  const cut = 190;
  const cell = cut;
  for (let step = 0; step < iterations; step += 1) {
    const grid = new Map<string, number[]>();
    for (let i = 0; i < n; i += 1) {
      const p = pos.get(nodes[i].id)!;
      const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(i);
      else grid.set(key, [i]);
    }

    // 局部排斥：只比较相邻网格，密集区自然形成更松的团块。
    for (let i = 0; i < n; i += 1) {
      const a = pos.get(nodes[i].id)!;
      const cx = Math.floor(a.x / cell);
      const cy = Math.floor(a.y / cell);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          for (const j of grid.get(`${cx + ox},${cy + oy}`) ?? []) {
            if (j <= i) continue;
            const b = pos.get(nodes[j].id)!;
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            const d2 = dx * dx + dy * dy + 0.01;
            if (d2 > cut * cut) continue;
            const min = radiusOf(nodes[i], nodeScale) + radiusOf(nodes[j], nodeScale) + 9;
            const d = Math.sqrt(d2);
            if (d < min) {
              const push = (min - d) * 0.34;
              dx = (dx / d) * push;
              dy = (dy / d) * push;
              a.vx -= dx;
              a.vy -= dy;
              b.vx += dx;
              b.vy += dy;
            } else {
              const force = (520 * repelScale) / d2;
              a.vx -= (dx / d) * force;
              a.vy -= (dy / d) * force;
              b.vx += (dx / d) * force;
              b.vy += (dy / d) * force;
            }
          }
        }
      }
    }

    for (const link of links) {
      const a = pos.get(link.source);
      const b = pos.get(link.target);
      if (!a || !b) continue;
      const desiredBase =
        link.type === 'scheduled'
          ? 34
          : link.type === 'contains'
            ? 66
            : link.type === 'related'
              ? 96
              : link.type === 'references'
                ? 104
                : 78;
      const desired = centerId
        ? link.source === centerId || link.target === centerId
          ? 170
          : 120
        : desiredBase * distScale;
      const strength =
        (centerId
          ? 0.022
          : link.type === 'related' || link.type === 'references'
            ? 0.055
            : 0.038) * linkScale;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const force = (d - desired) * strength;
      a.vx += (dx / d) * force;
      a.vy += (dy / d) * force;
      b.vx -= (dx / d) * force;
      b.vy -= (dy / d) * force;
    }

    for (const node of nodes) {
      const p = pos.get(node.id)!;
      if (centerId && node.id === centerId) {
        p.x = W / 2;
        p.y = H / 2;
        p.vx = 0;
        p.vy = 0;
        continue;
      }
      p.vx += (W / 2 - p.x) * 0.0022 * centerScale;
      p.vy += (H / 2 - p.y) * 0.0022 * centerScale;
      p.vx *= 0.84;
      p.vy *= 0.84;
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (speed > 32) {
        p.vx = (p.vx / speed) * 32;
        p.vy = (p.vy / speed) * 32;
      }
      p.x = Math.max(28, Math.min(W - 28, p.x + p.vx));
      p.y = Math.max(46, Math.min(H - 92, p.y + p.vy));
    }
  }

  // 按包围盒归一化到画布；上限 1.35 避免只有两三个记录时被拉得过大。
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const fit = Math.min(centerId ? 2.4 : 1.35, (W - 150) / spanX, (H - 170) / spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (const p of pos.values()) {
    if (centerId) {
      p.x = W / 2 + (p.x - W / 2) * fit;
      p.y = H / 2 + (p.y - H / 2) * fit;
    } else {
      p.x = W / 2 + (p.x - cx) * fit;
      p.y = H / 2 + (p.y - cy) * fit;
    }
    p.x = Math.max(30, Math.min(W - 30, p.x));
    p.y = Math.max(58, Math.min(H - 104, p.y));
  }
  return pos;
}
export default function GraphPage() {
  const [data, setData] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusData, setFocusData] = useState<GraphResponse | null>(null);
  const [focusLoading, setFocusLoading] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const topicNav = readTopicNav(searchParams);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchHits, setSearchHits] = useState<GraphSearchHit[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [typeFilters, setTypeFilters] = useState<Set<GraphNodeType>>(new Set(ALL_TYPES));
  const [relationFilters, setRelationFilters] = useState<Set<GraphLink['type']>>(
    new Set(ALL_RELATIONS)
  );
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [hideOrphans, setHideOrphans] = useState(false);
  const [reuseOpen, setReuseOpen] = useState(false);
  const [reuseCaptures, setReuseCaptures] = useState<Array<{ id: string; rawText: string }>>([]);
  const [reuseCaptureId, setReuseCaptureId] = useState('');
  const [reuseNewIdea, setReuseNewIdea] = useState('');
  const [reuseMode, setReuseMode] = useState<'existing' | 'new'>('existing');
  const [reuseBusy, setReuseBusy] = useState(false);
  const [reuseError, setReuseError] = useState<string | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, k: 1 });
  const [forces, setForces] = useState<ForceSettings>(DEFAULT_FORCES);
  const [forceOpen, setForceOpen] = useState(false);
  const [colorMode, setColorMode] = useState<ColorMode>('type');
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [includeArchived, setIncludeArchived] = useState(() =>
    Boolean(searchParams.get('node'))
  );
  const [depth, setDepth] = useState<1 | 2>(() => (searchParams.get('depth') === '2' ? 2 : 1));
  const [focusMissing, setFocusMissing] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const [dragOffsets, setDragOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  // 就位收敛进度：1 = 已就位（终态，和布局结果完全一致），<1 = 正在从收拢态张开。
  const [settleProgress, setSettleProgress] = useState(1);
  const settleRafRef = useRef<number | null>(null);
  // 是否要求减少动态效果。只在挂载时读一次；CSS 侧还有一层全局降级兜底。
  const [reducedMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  const dragRef = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const nodeDragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    /** 是否真的挪动过。pointerup 时需要它，不能依赖尚未提交的 state。 */
    moved: boolean;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [frame, setFrame] = useState({ w: DEFAULT_W, h: DEFAULT_H, cssW: 860 });
  const navigate = useNavigate();

  async function loadGraph(archived = includeArchived) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getGraph(archived);
      setData(res);
      const requested = searchParams.get('node');
      const requestedDepth: 1 | 2 = searchParams.get('depth') === '2' ? 2 : 1;
      if (requested) {
        setDepth(requestedDepth);
        const local = await focusNode(requested, false, archived, requestedDepth);
        // 局部图刷新：URL 里同时记着中心（node）和当前选中的节点（focus），
        // 两个都要恢复，否则刷新后选中的节点会跳回中心，和地址栏说的不一致。
        const focusParam = searchParams.get('focus');
        if (local && focusParam && focusParam !== requested) {
          if (local.nodes.some((node) => node.id === focusParam)) setSelectedId(focusParam);
        }
        return;
      }
      setFocusData(null);
      const focusParam = searchParams.get('focus');
      if (focusParam) {
        const exists = res.nodes.some((node) => node.id === focusParam);
        setFocusMissing(
          exists ? null : '没有在图中找到这个节点，可能已删除或超出显示上限。'
        );
        if (exists) {
          setSelectedId(focusParam);
          return;
        }
      } else {
        setFocusMissing(null);
      }
      if (!selectedId && res.nodes.length && res.nodes.length <= 12) {
        const firstCapture = res.nodes.find((n) => n.type === 'capture');
        setSelectedId(firstCapture?.id ?? res.nodes[0].id);
      }
    } catch (e: any) {
      setError(e?.body?.message || e?.message || '知识网络加载失败');
    } finally {
      setLoading(false);
    }
  }

  /** 选中节点只写入 focus；只有「局部图」才写 node，刷新后仍停留在局部模式。 */
  function syncFocusParam(nodeId: string | null) {
    const next = new URLSearchParams(searchParams);
    if (nodeId) next.set('focus', nodeId);
    else next.delete('focus');
    setSearchParams(next, { replace: true });
  }

  function syncLocalParams(nodeId: string | null, nextDepth: 1 | 2) {
    const next = new URLSearchParams(searchParams);
    if (nodeId) {
      next.set('node', nodeId);
      next.set('depth', String(nextDepth));
      next.set('focus', nodeId);
    } else {
      next.delete('node');
      next.delete('depth');
    }
    setSearchParams(next, { replace: true });
  }

  async function focusNode(
    nodeId: string,
    syncUrl = true,
    archived = includeArchived,
    nextDepth: 1 | 2 = depth
  ) {
    setFocusLoading(true);
    setError(null);
    setFocusMissing(null);
    try {
      const local = await api.focusGraph(nodeId, archived, nextDepth);
      setFocusData(local);
      setSelectedId(nodeId);
      setDepth(nextDepth);
      setReuseOpen(false);
      setCamera({ x: 0, y: 0, k: 1 });
      if (syncUrl) syncLocalParams(nodeId, nextDepth);
      return local;
    } catch (e: any) {
      setFocusData(null);
      const notFound = e?.status === 404 || e?.body?.error === 'node_not_found';
      const message = notFound
        ? '这条链接指向的记录已不存在或不可见（可能已删除或已归档）。可以切换「包含归档」或回到全图。'
        : e?.body?.message || e?.message || '这个节点暂时无法载入';
      setFocusMissing(message);
      setError(null);
      if (syncUrl) {
        const next = new URLSearchParams(searchParams);
        next.delete('node');
        next.delete('depth');
        if (notFound) next.set('focus', nodeId);
        setSearchParams(next, { replace: true });
      }
      return null;
    } finally {
      setFocusLoading(false);
    }
  }

  function returnToFullGraph() {
    setFocusData(null);
    setSearchOpen(false);
    setFocusMissing(null);
    syncLocalParams(null, depth);
  }

  /** 断链时「回到全图」：把地址里的失效 node / depth / focus 一起清掉，刷新后不会再报同一条。 */
  function dismissBrokenLink() {
    setFocusMissing(null);
    setError(null);
    const next = new URLSearchParams(searchParams);
    next.delete('node');
    next.delete('depth');
    next.delete('focus');
    setSearchParams(next, { replace: true });
  }

  /** 局部载入失败后的重试：优先用地址里记着的那条链接。 */
  function retryFocusLink(archived = includeArchived) {
    const target = searchParams.get('node') || searchParams.get('focus');
    if (!target) {
      setFocusMissing(null);
      return;
    }
    void focusNode(target, true, archived, depth);
  }

  /** 已归档的记录在「仅看当前」下会被判为不可见，用包含归档再试一次。 */
  function retryFocusWithArchived() {
    setIncludeArchived(true);
    retryFocusLink(true);
  }

  async function changeLocalDepth(nextDepth: 1 | 2) {
    // 范围始终以当前局部图的中心为准：选中别的节点只是看详情，不改变这张图的中心，
    // 否则标题写的是 A、图里画的却是从 B 出发的两跳。
    const center = focusData?.meta?.focus ?? selectedId;
    if (!center || nextDepth === depth) return;
    await focusNode(center, true, includeArchived, nextDepth);
  }

  useEffect(() => {
    loadGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived]);

  useEffect(() => {
    const handler = () => {
      setCamera({ x: 0, y: 0, k: 1 });
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  const view = focusData ?? data;

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // 只在宽度真的变了才重算画布比例。
      // 高度会随着右侧详情面板的内容长短变化，若跟着它重算，
      // 每次选中节点整张图都会重排一次（拖动节点时会直接被这一步打断）。
      setFrame((prev) =>
        Math.abs(prev.cssW - rect.width) < 1
          ? prev
          : {
              w: DEFAULT_W,
              h: Math.min(
                1480,
                Math.max(560, Math.round(DEFAULT_W * (rect.height / rect.width)))
              ),
              cssW: rect.width,
            }
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [view]);

  useEffect(() => {
    nodeDragRef.current = null;
    setDraggingNodeId(null);
    setDragOffsets({});
    setPinnedIds(new Set());
  }, [view, frame.w, frame.h]);

  const labelScale = Math.min(2.6, Math.max(1.2, DEFAULT_W / frame.cssW * 0.9));
  const nodeScale = Math.min(1.8, 1 + (labelScale - 1) * 0.65) * forces.nodeSize;

  const layout = useMemo(
    () =>
      view
        ? buildLayout(
            view.nodes,
            view.links,
            frame.w,
            frame.h,
            nodeScale,
            view.meta?.focus ?? null,
            forces
          )
        : new Map(),
    [view, frame.w, frame.h, nodeScale, forces]
  );
  // —— 任务 A · 收敛动画的 key ——
  // 数据签名 + 画布尺寸 + 焦点 id，故意**不含 forces**：
  // 拖动「斥力 / 连线距离」滑杆会让布局重算，但那是调参，不该重播收敛动画。
  const layoutSignature = useMemo(() => {
    if (!view) return 'empty';
    let acc = 0;
    for (const node of view.nodes) acc = (acc + hash(node.id)) % 1000003;
    return `${view.nodes.length}:${view.links.length}:${acc}:${view.meta?.focus ?? '-'}`;
  }, [view]);
  const motionKey = `${layoutSignature}|${frame.w}x${frame.h}`;
  // 收敛进度 → 张开比例（easeOutCubic）。进度为 1 时完全不动坐标。
  const settleEase =
    settleProgress >= 1 ? 1 : 1 - Math.pow(1 - Math.max(0, settleProgress), 3);

  const viewLayout = useMemo(() => {
    const positions = new Map(layout);
    for (const [id, offset] of Object.entries(dragOffsets)) {
      const p = positions.get(id);
      if (p) positions.set(id, { ...p, x: p.x + offset.x, y: p.y + offset.y });
    }
    // —— 任务 A · 就位收敛 ——
    // 只在「收拢 → 张开」还没走完时改写坐标：终点比例是 1，因此收敛结束后
    // 这里得到的坐标与 buildLayout() 的结果逐位相同（确定性不破）。
    if (settleEase < 1) {
      const cx = frame.w / 2;
      const cy = frame.h / 2;
      const ratio = SETTLE_FROM + (1 - SETTLE_FROM) * settleEase;
      for (const [id, p] of positions) {
        positions.set(id, { x: cx + (p.x - cx) * ratio, y: cy + (p.y - cy) * ratio });
      }
    }
    return positions;
  }, [layout, dragOffsets, settleEase, frame.w, frame.h]);

  useLayoutEffect(() => {
    // 只在 key 变化时重播（换数据 / 换画布尺寸 / 换焦点）。
    // 用 layout effect 是为了在首次绘制前就把进度归零：否则会先满尺寸闪一帧再收拢。
    if (!view) return;
    // 降级 1：用户要求减少动效 → 不白跑 rAF，直接落在终态。
    // 降级 2：大图优先保帧率 → 跳过收敛（错峰淡入仍由 CSS 保留）。
    const tooLarge =
      view.nodes.length > MOTION_NODE_LIMIT || view.links.length > MOTION_LINK_LIMIT;
    if (reducedMotion || tooLarge) {
      setSettleProgress(1);
      return;
    }
    setSettleProgress(0);
    const start = performance.now();
    const tick = (now: number) => {
      // 进度按真实耗时推进，但只跨过 1/SETTLE_STEPS 档位时才写 state：
      // 慢帧自动并档，整段动画最多 18 轮重渲染（该页面拖拽时本来就在整图重渲染）。
      const raw = Math.min(1, (now - start) / SETTLE_MS);
      const stepped = Math.floor(raw * SETTLE_STEPS) / SETTLE_STEPS;
      setSettleProgress((prev) => (stepped > prev ? stepped : prev));
      settleRafRef.current = raw < 1 ? requestAnimationFrame(tick) : null;
    };
    settleRafRef.current = requestAnimationFrame(tick);
    // 卸载 / key 变化时清理 rAF，避免泄漏和陈旧动画继续驱动新数据。
    return () => {
      if (settleRafRef.current !== null) {
        cancelAnimationFrame(settleRafRef.current);
        settleRafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [motionKey]);
  const selected = view?.nodes.find((n) => n.id === selectedId) ?? null;
  // 详情面板的副标题 / 正文：只补标题没说过的信息（见 nodePanelText）。
  const nodeText = nodePanelText(selected);
  // 局部图的中心是请求时那个稳定 ID，不一定等于用户此刻选中的节点。
  // 标题与「一跳 / 两跳」都必须说中心，才能和实际画出来的范围对得上。
  const focusCenter =
    (focusData && focusData.nodes.find((n) => n.id === (focusData.meta?.focus ?? ''))) || null;
  const focusId = hoveredId;
  const related = useMemo(() => {
    if (!view || !selectedId) return [] as GraphNode[];
    const ids = new Set<string>();
    for (const l of view.links) {
      if (l.source === selectedId) ids.add(l.target);
      if (l.target === selectedId) ids.add(l.source);
    }
    return view.nodes.filter((n) => ids.has(n.id));
  }, [view, selectedId]);
  const activeLinkIds = useMemo(() => {
    if (!view || !focusId) return new Set<string>();
    return new Set(view.links.filter((l) => l.source === focusId || l.target === focusId).map((l) => l.id));
  }, [view, focusId]);
  const visibleNodes = useMemo(
    () =>
      (view?.nodes ?? []).filter(
        (node) => typeFilters.has(node.type) && (!hideOrphans || node.degree > 0)
      ),
    [view, typeFilters, hideOrphans]
  );
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleLinks = useMemo(
    () =>
      (view?.links ?? []).filter(
        (l) =>
          relationFilters.has(l.type) &&
          visibleNodeIds.has(l.source) &&
          visibleNodeIds.has(l.target)
      ),
    [view, relationFilters, visibleNodeIds]
  );
  /**
   * 逐节点入场延迟（ms），由渲染层写到内联变量 --in-delay 上。
   * 局部图：中心 0 → 一跳邻居 90 → 其余 180，同档内按 id 稳定哈希抖动 0–40ms；
   * 全图：按 id 稳定哈希铺成 0–220ms 的波。
   * 只跟 view 走：切筛选不重排延迟（滤镜只是让部分节点重新挂载，重新挂载的节点会各自播一次）。
   */
  const introDelayOf = useMemo(() => {
    const delays = new Map<string, number>();
    if (!view) return delays;
    const focus = view.meta?.focus ?? null;
    if (focus) {
      const oneHop = new Set<string>();
      for (const link of view.links) {
        if (link.source === focus) oneHop.add(link.target);
        if (link.target === focus) oneHop.add(link.source);
      }
      for (const node of view.nodes) {
        if (node.id === focus) {
          delays.set(node.id, 0);
          continue;
        }
        const tier = oneHop.has(node.id) ? 130 : STAGGER_LOCAL_MS;
        delays.set(node.id, tier + (hash(node.id) % STAGGER_JITTER_MS));
      }
    } else {
      for (const node of view.nodes) {
        delays.set(node.id, hash(node.id) % (STAGGER_GLOBAL_MS + 1));
      }
    }
    return delays;
  }, [view]);
  const relationRows = useMemo(() => {
    if (!view || !selectedId) return [];
    return view.links
      .filter((l) => l.source === selectedId || l.target === selectedId)
      .map((link) => {
        const outgoing = link.source === selectedId;
        const otherId = outgoing ? link.target : link.source;
        const other = view.nodes.find((n) => n.id === otherId) ?? null;
        if (!other) return null;
        return { link, other, outgoing, text: relationText(link, outgoing) };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
  }, [view, selectedId]);
  const visibleLabels = useMemo(() => {
    const result = new Map<string, boolean>();
    const boxes: Array<{ x1: number; x2: number; y1: number; y2: number }> = [];
    const neighbors = new Set<string>();
    if (selectedId && view) {
      for (const link of view.links) {
        if (link.source === selectedId) neighbors.add(link.target);
        if (link.target === selectedId) neighbors.add(link.source);
      }
    }
    const allOrdered = [...visibleNodes].sort((a, b) => {
      if (a.id === selectedId) return -1;
      if (b.id === selectedId) return 1;
      if (neighbors.has(a.id) && !neighbors.has(b.id)) return -1;
      if (neighbors.has(b.id) && !neighbors.has(a.id)) return 1;
      if (a.type === 'capture' && b.type !== 'capture') return -1;
      if (b.type === 'capture' && a.type !== 'capture') return 1;
      return b.degree - a.degree;
    });
    // 默认只给焦点、直接邻居和少量重要念头标签；放大后逐步放开。
    let captureLabels = 0;
    const maxCaptureLabels =
      camera.k >= 1.6 ? Number.POSITIVE_INFINITY : frame.cssW < 620 ? 3 : 5;
    const ordered = allOrdered.filter((node) => {
      if (node.id === selectedId || neighbors.has(node.id)) return true;
      if (node.type === 'capture') {
        if (captureLabels >= maxCaptureLabels) return false;
        captureLabels += 1;
        return true;
      }
      if (camera.k < 1.45) return false;
      if (node.type === 'schedule' && camera.k < 2.1) return false;
      return true;
    });
    for (const n of ordered) {
      const p = viewLayout.get(n.id);
      if (!p) continue;
      const fontSize = (n.type === 'capture' ? 11.5 : 10.5) * labelScale;
      const width = Math.max(36, Math.min(190, n.label.length * fontSize * 0.95));
      const height = (n.type === 'capture' ? 32 : 22) * labelScale;
      const r = radiusOf(n, nodeScale);
      const labelX = Math.max(
        20 - p.x,
        Math.min(frame.w - 20 - p.x - width, -width / 2)
      );
      const box = {
        x1: p.x + labelX,
        x2: p.x + labelX + width,
        y1: p.y + r + 6 * labelScale,
        y2: p.y + r + 6 * labelScale + height,
      };
      const overlaps = boxes.some(
        (b) => box.x1 < b.x2 - 10 && box.x2 > b.x1 + 10 && box.y1 < b.y2 - 3 && box.y2 > b.y1 + 3
      );
      // 当前选中节点的标签优先保留；密集区域只做标签之间的避让，不再因为压住小圆点就整片隐藏。
      const hidden = overlaps && n.id !== selectedId;
      result.set(n.id, !hidden);
      if (!hidden) boxes.push(box);
    }
    // 极密集时也至少保留几个重要念头的标签，让用户知道这张网里有谁。
    const shownCaptures = allOrdered.filter(
      (node) => node.type === 'capture' && result.get(node.id) === true
    ).length;
    if (shownCaptures < Math.min(3, maxCaptureLabels)) {
      const forced = allOrdered
        .filter((node) => node.type === 'capture' && result.get(node.id) !== true)
        .slice(0, Math.min(3, maxCaptureLabels) - shownCaptures);
      for (const node of forced) result.set(node.id, true);
    }
    return result;
  }, [visibleNodes, viewLayout, labelScale, nodeScale, frame.w, frame.cssW, selectedId, view, camera.k]);

  async function runSearch(nextTypes = typeFilters) {
    const term = searchTerm.trim();
    if (!term) {
      setSearchError('先输入要找回的内容。');
      setSearchHits([]);
      setSearchTotal(0);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const res = await api.searchGraph(term, {
        archived: includeArchived,
        types: Array.from(nextTypes),
        limit: 30,
      });
      setSearchHits(res.results);
      setSearchTotal(res.total);
    } catch (e: any) {
      setSearchError(e?.body?.message || e?.message || '搜索失败');
      setSearchHits([]);
      setSearchTotal(0);
    } finally {
      setSearching(false);
    }
  }

  function toggleType(type: GraphNodeType) {
    const next = new Set(typeFilters);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    if (next.size === 0) ALL_TYPES.forEach((t) => next.add(t));
    setTypeFilters(next);
    if (searchTerm.trim()) void runSearch(next);
  }

  function toggleRelation(type: GraphLink['type']) {
    const next = new Set(relationFilters);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    if (next.size === 0) ALL_RELATIONS.forEach((t) => next.add(t));
    setRelationFilters(next);
  }

  async function openSearchHit(hit: GraphSearchHit) {
    await focusNode(hit.node.id);
    setSearchOpen(false);
  }

  async function copyNodeLink() {
    if (!selectedId) return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyStatus('copied');
      window.setTimeout(() => setCopyStatus('idle'), 1600);
    } catch {
      setCopyStatus('idle');
      setError('复制失败，可以手动复制地址栏里的链接。');
    }
  }

  async function openReuse() {
    if (reuseOpen) {
      setReuseOpen(false);
      return;
    }
    setReuseOpen(true);
    setReuseError(null);
    if (reuseCaptures.length === 0) {
      try {
        const res = await api.listCaptures(false);
        setReuseCaptures(res.captures);
        setReuseCaptureId(res.captures[0]?.id ?? '');
        if (!res.captures.length) setReuseMode('new');
      } catch (e: any) {
        setReuseError(e?.message || '念头列表加载失败');
      }
    }
  }

  function startExperienceFor(captureId: string, attemptId: string) {
    navigate(`/capture/${captureId}?experience=${encodeURIComponent(attemptId)}`);
  }

  async function createIdeaAndExperience() {
    const text = reuseNewIdea.trim();
    if (!text || !selected || selected.type !== 'attempt' || reuseBusy) return;
    setReuseBusy(true);
    setReuseError(null);
    try {
      const res = await api.createCapture(text);
      startExperienceFor(res.capture.id, selected.id.replace(/^attempt:/, ''));
    } catch (e: any) {
      setReuseError(e?.body?.message || e?.message || '念头保存失败');
    } finally {
      setReuseBusy(false);
    }
  }


  async function saveIdea() {
    const text = composer.trim();
    if (!text || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.createCapture(text);
      setComposer('');
      setJustSaved(res.capture.id);
      const graph = await api.getGraph(includeArchived);
      setData(graph);
      setFocusData(null);
      setSelectedId(`capture:${res.capture.id}`);
      syncFocusParam(`capture:${res.capture.id}`);
    } catch (e: any) {
      setError(e?.body?.message || e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  function graphPoint(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const local = point.matrixTransform(ctm.inverse());
    return {
      x: (local.x - camera.x * frame.w) / camera.k,
      y: (local.y - camera.y * frame.h) / camera.k,
    };
  }

  /**
   * 用户一旦开始交互（拖节点 / 拖画布 / 滚轮缩放）就立刻结束收敛：
   * 不能拖着一张还在缩放的图，否则鼠标落点和节点位置对不上。
   */
  function endSettleNow() {
    if (settleRafRef.current !== null) {
      cancelAnimationFrame(settleRafRef.current);
      settleRafRef.current = null;
    }
    setSettleProgress((prev) => (prev === 1 ? prev : 1));
  }

  function onNodePointerDown(e: React.PointerEvent<SVGGElement>, id: string) {
    e.stopPropagation();
    e.preventDefault();
    endSettleNow();
    const point = graphPoint(e.clientX, e.clientY);
    if (!point) return;
    const offset = dragOffsets[id] ?? { x: 0, y: 0 };
    nodeDragRef.current = {
      id,
      startX: point.x,
      startY: point.y,
      offsetX: offset.x,
      offsetY: offset.y,
      moved: false,
    };
    setSelectedId(id);
    setDraggingNodeId(id);
    // 拖动路径不写 URL：选中由随后的 click 负责同步，
    // 中途改 URL 会让整页在拖动期间重算布局，把拖动本身打断。
  }

  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    endSettleNow();
    setCamera((c) => {
      const nextK = Math.max(0.45, Math.min(2.8, c.k * (e.deltaY > 0 ? 0.9 : 1.1)));
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return { ...c, k: nextK };
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;
      return {
        k: nextK,
        x: mx - (mx - c.x) * (nextK / c.k),
        y: my - (my - c.y) * (nextK / c.k),
      };
    });
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if ((e.target as HTMLElement).closest('[data-node]')) return;
    endSettleNow();
    dragRef.current = { x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (nodeDragRef.current) {
      const point = graphPoint(e.clientX, e.clientY);
      if (!point) return;
      const drag = nodeDragRef.current;
      const base = layout.get(drag.id);
      const dx = point.x - drag.startX;
      const dy = point.y - drag.startY;
      // 一旦真的拖出距离就立刻固定：不等 pointerup，避免依赖尚未提交的 state。
      if (!drag.moved && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
        drag.moved = true;
        setPinnedIds((prev) => (prev.has(drag.id) ? prev : new Set(prev).add(drag.id)));
      }
      const nextX = base
        ? Math.max(24 - base.x, Math.min(frame.w - 24 - base.x, drag.offsetX + dx))
        : drag.offsetX + dx;
      const nextY = base
        ? Math.max(24 - base.y, Math.min(frame.h - 24 - base.y, drag.offsetY + dy))
        : drag.offsetY + dy;
      setDragOffsets((prev) => ({
        ...prev,
        [drag.id]: { x: nextX, y: nextY },
      }));
      return;
    }
    // 起点必须在这里就拷出来：setCamera 的 updater 是等到下一次渲染才执行的，
    // 那时 pointerup 可能已经把 dragRef 清空了。用 dragRef.current!.cx 会在松手后抛错，
    // 整张图被 React 卸载成白屏（拖动平移是最主要的手势，不能崩）。
    const drag = dragRef.current;
    if (!drag) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dx = (e.clientX - drag.x) / rect.width;
    const dy = (e.clientY - drag.y) / rect.height;
    setCamera((c) => ({ ...c, x: drag.cx + dx, y: drag.cy + dy }));
  }

  function onPointerUp() {
    const dragged = nodeDragRef.current;
    // 只有真的挪动过才把节点钉住；单纯点击选中不应被固定。
    if (dragged?.moved) {
      setPinnedIds((prev) => new Set(prev).add(dragged.id));
    }
    dragRef.current = null;
    nodeDragRef.current = null;
    setDraggingNodeId(null);
  }

  /** 指针被系统取消（触摸滚动、手势中断）时只清理现场，不把节点钉住。 */
  function onPointerCancel() {
    dragRef.current = null;
    nodeDragRef.current = null;
    setDraggingNodeId(null);
  }

  /** 释放一个被拖动的节点，让它回到布局算出的位置。 */
  function unpinNode(id: string) {
    setPinnedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setDragOffsets((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function resetCamera() {
    setCamera({ x: 0, y: 0, k: 1 });
    setDragOffsets({});
    setPinnedIds(new Set());
  }

  if (loading && !data) {
    return (
      <div className="graph-page graph-loading">
        <div className="graph-orbit" />
        <p>正在整理你的知识网络…</p>
      </div>
    );
  }

  const nodes = visibleNodes;
  const links = visibleLinks;
  // textFadeMultiplier：负值让标签随缩小更快变淡，正值让它在小比例下也保持清晰。
  const textFadeSlope = -forces.textFade / 10;
  const labelOpacityOf = (isCapture: boolean) =>
    Math.max(
      0.08,
      Math.min(1, (isCapture ? 1 : 0.96) + (camera.k - 1) * textFadeSlope * 1.6)
    );
  const formatForceValue = (key: keyof ForceSettings) => {
    if (key === 'centerStrength' || key === 'linkStrength') return forces[key].toFixed(2);
    if (key === 'nodeSize' || key === 'lineSize') return `${forces[key].toFixed(2)}×`;
    return String(forces[key]);
  };
  // 加载失败时只显示错误，不把空数组冒充成「网络里还没有记录」。
  const isEmpty = !loading && !error && (view?.nodes.length ?? 0) === 0;
  const isFilteredEmpty =
    !loading && !error && (view?.nodes.length ?? 0) > 0 && nodes.length === 0;
  // 动效验证钩子：收敛进行中 data-settle="running"，收拢到终态后为 "done"。
  // data-settle-mode 说明这次是完整播放还是因降级跳过。
  const settleState = settleProgress < 1 ? 'running' : 'done';
  const settleMode = !view
    ? 'idle'
    : reducedMotion
      ? 'reduced-motion'
      : view.nodes.length > MOTION_NODE_LIMIT || view.links.length > MOTION_LINK_LIMIT
        ? 'large-graph'
        : 'full';

  return (
    <div className={`graph-page ${selected ? 'has-selection' : ''}`}>
      <div className="graph-atmosphere" aria-hidden="true" />
      <div className="graph-main">
      <section className="graph-stage" aria-label="知识网络">
        <div className="graph-intro">
          <p className="graph-eyebrow">KNOWLEDGE GRAPH</p>
          <h1>知识网络</h1>
          <p className="graph-subtitle">拖动浏览，滚轮缩放，点击节点查看关联。</p>
        </div>
        <div className="graph-controls">
          <button
            type="button"
            className="graph-chip"
            aria-pressed={includeArchived}
            onClick={() => setIncludeArchived((v) => !v)}
          >
            {includeArchived ? '已包含归档' : '仅看当前'}
          </button>
          <button type="button" className="graph-chip" onClick={resetCamera}>
            归位
          </button>
          <button
            type="button"
            className="graph-chip"
            aria-expanded={searchOpen}
            onClick={() => setSearchOpen((v) => !v)}
          >
            {searchOpen ? '收起搜索与筛选' : '搜索 / 筛选'}
          </button>
        </div>

        <div className="graph-search-wrap">
          <form
            className="graph-search-form"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              setSearchOpen(true);
              void runSearch();
            }}
          >
            <input
              type="search"
              value={searchTerm}
              placeholder="搜索念头原文、尝试标题或实际结果…"
              aria-label="搜索知识网络"
              onFocus={() => setSearchOpen(true)}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <button type="submit" disabled={searching}>
              {searching ? '查找中' : '查找'}
            </button>
          </form>

          {searchOpen && (
            <div className="graph-search-panel">
              <div className="graph-filter-row">
                <span className="graph-filter-label">记录</span>
                {ALL_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={`graph-filter-chip${typeFilters.has(type) ? ' is-on' : ''}`}
                    aria-pressed={typeFilters.has(type)}
                    onClick={() => toggleType(type)}
                  >
                    {GRAPH_TYPE_LABEL[type]}
                  </button>
                ))}
              </div>
              <div className="graph-filter-row">
                <span className="graph-filter-label">关系</span>
                {ALL_RELATIONS.map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={`graph-filter-chip${relationFilters.has(type) ? ' is-on' : ''}`}
                    aria-pressed={relationFilters.has(type)}
                    onClick={() => toggleRelation(type)}
                  >
                    {RELATION_LABEL[type]}
                  </button>
                ))}
              </div>

              <div className="graph-filter-row">
                <span className="graph-filter-label">显示</span>
                <label className="graph-filter-check">
                  <input
                    type="checkbox"
                    checked={hideOrphans}
                    onChange={(e) => setHideOrphans(e.target.checked)}
                  />
                  隐藏孤立节点
                </label>
              </div>

              <div className="graph-force-section">
                <button
                  type="button"
                  className="graph-force-toggle"
                  aria-expanded={forceOpen}
                  data-testid="graph-force-toggle"
                  onClick={() => setForceOpen((v) => !v)}
                >
                  {forceOpen ? '收起外观与力度' : '外观 / 力度'}
                </button>
                {forceOpen && (
                  <div
                    className="graph-force-panel"
                    data-testid="graph-force-panel"
                    role="group"
                    aria-label="外观与力度"
                  >
                    <div className="graph-filter-row">
                      <span className="graph-filter-label">着色</span>
                      {(Object.keys(COLOR_MODE_LABEL) as ColorMode[]).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={`graph-filter-chip${colorMode === mode ? ' is-on' : ''}`}
                          aria-pressed={colorMode === mode}
                          onClick={() => setColorMode(mode)}
                        >
                          {COLOR_MODE_LABEL[mode]}
                        </button>
                      ))}
                    </div>
                    <div className="graph-force-grid">
                      {FORCE_ORDER.map((key) => {
                        const range = FORCE_RANGE[key];
                        return (
                          <label key={key} className="graph-force-field">
                            <span className="graph-force-name">{range.label}</span>
                            <input
                              type="range"
                              min={range.min}
                              max={range.max}
                              step={range.step}
                              value={forces[key]}
                              aria-label={range.label}
                              onChange={(e) =>
                                setForces((prev) => ({ ...prev, [key]: Number(e.target.value) }))
                              }
                            />
                            <span className="graph-force-value">{formatForceValue(key)}</span>
                          </label>
                        );
                      })}
                    </div>
                    <div className="graph-force-actions">
                      <span className="graph-force-hint">
                        拖动节点可固定位置，双击或按退格释放。调参只改变这张图的读法，不写入任何记录。
                      </span>
                      <button
                        type="button"
                        className="graph-filter-chip"
                        onClick={() => setForces(DEFAULT_FORCES)}
                      >
                        恢复默认
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {searchError && <p className="graph-search-error" role="alert">{searchError}</p>}
              {!searchError && searchHits.length === 0 && !searching && (
                <p className="graph-search-hint">
                  {searchTerm.trim()
                    ? '没有找到匹配的记录。可以换一个词，或包含归档记录再试。'
                    : '输入一个旧结果里的词，找回它属于哪条念头、后来被哪些尝试用过。'}
                </p>
              )}
              {searchHits.length > 0 && (
                <>
                  <p className="graph-search-count">
                    找到 {searchTotal} 条
                    {searchHits.length < searchTotal ? `（列出前 ${searchHits.length} 条）` : ''}
                    {' · '}选择一条会载入它的局部关系并定位
                  </p>
                  <div className="graph-search-results">
                    {searchHits.map((hit) => (
                      <button
                        key={hit.node.id}
                        type="button"
                        className="graph-search-result"
                        onClick={() => void openSearchHit(hit)}
                      >
                        <span
                          className="graph-search-type"
                          style={{ color: TYPE_COLOR[hit.node.type] }}
                        >
                          {GRAPH_TYPE_LABEL[hit.node.type]}
                        </span>
                        <span className="graph-search-snippet">{hit.snippet}</span>
                        <span className="graph-search-meta">
                          {hit.captureLabel ? `属于「${hit.captureLabel}」` : '独立记录'}
                          {hit.archived ? ' · 已归档' : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {focusLoading && <p className="graph-focus-note">正在载入局部关系…</p>}
        {focusData && !focusLoading && (
          <div className="graph-focus-bar">
            <span>
              局部图 · {focusCenter?.label ?? selected?.label ?? '一个节点'} ·{' '}
              {depth === 2 ? '两跳' : '一跳'}关系
            </span>
            <div className="graph-depth-toggle" role="group" aria-label="局部图范围">
              <button
                type="button"
                aria-pressed={depth === 1}
                onClick={() => void changeLocalDepth(1)}
              >
                一跳
              </button>
              <button
                type="button"
                aria-pressed={depth === 2}
                onClick={() => void changeLocalDepth(2)}
              >
                两跳
              </button>
            </div>
            {topicNav.fromTopic && topicNav.returnTo && (
              <Link className="graph-return-topic" to={topicNav.returnTo} data-testid="graph-return-topic">
                返回主题
              </Link>
            )}
            <button type="button" onClick={returnToFullGraph}>返回全图</button>
          </div>
        )}
        {!focusData && data?.meta?.truncated && (
          <p className="graph-limit-note" role="status">
            全图仅显示最近 {data.meta.shownCaptures} / {data.meta.totalCaptures} 条念头；
            用上方搜索可以定位更早的记录并打开它的局部图。
          </p>
        )}
        {isFilteredEmpty && (
          <div className="graph-empty-state" role="status">
            <strong>当前筛选下没有可见节点</strong>
            <p>重新勾选记录或关系类型，或取消「隐藏孤立节点」。</p>
          </div>
        )}
        {!loading && error && !view && (
          <div className="graph-empty-state" data-testid="graph-load-error" role="alert">
            <strong>知识网络加载失败</strong>
            <p>{error}</p>
            <button
              type="button"
              className="graph-secondary"
              style={{ pointerEvents: 'auto', marginTop: 6 }}
              onClick={() => void loadGraph()}
            >
              再试一次
            </button>
          </div>
        )}
        {loading && view && (
          <p className="graph-focus-note" data-testid="graph-refreshing" role="status">
            正在更新全图…
          </p>
        )}
        {isEmpty && (
          <div className="graph-empty-state" data-testid="graph-empty" role="status">
            <strong>网络里还没有记录</strong>
            <p>先在念头页写下一个念头；它会成为这张网的第一颗种子。</p>
            <Link to="/">去写一个念头</Link>
          </div>
        )}

        {/*
          C · 节点很少时画布几乎全空，第一眼像没加载出来。
          这一行只是提示：pointer-events: none，拖拽 / 缩放全部穿透到 svg。
        */}
        {!loading && !error && nodes.length > 0 && nodes.length <= SMALL_CANVAS_NODES && (
          <p className="gd-scope gd-canvas-hint" data-testid="graph-small-hint">
            当前只有 {nodes.length} 个节点 · 在首页记念头、或在右侧「投入网络」写一条，网络就会长出来
          </p>
        )}

        <svg
          ref={svgRef}
          className="graph-svg"
          data-settle={settleState}
          data-settle-mode={settleMode}
          data-settle-progress={settleProgress.toFixed(3)}
          viewBox={`0 0 ${frame.w} ${frame.h}`}
          // 顶部对齐而不是居中：画布高度会随右侧详情面板的内容长短变化（stage 被 grid 拉伸），
          // 而 ResizeObserver 刻意只跟宽度重算（见上面那段注释），于是 box 变高时 viewBox 的
          // 高宽比不再匹配。用 meet + 居中时，这段多出来的高度会把整张图往下推（实测 166px），
          // 按下节点的瞬间图就跳走，pointerup / click 落到空白处，选中也就进不了 URL。
          // 改成 YMin 后多出来的高度落在下方，缩放和位置都不动，注释里那句意图才真正成立。
          preserveAspectRatio="xMidYMin meet"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          <g
            transform={`translate(${camera.x * frame.w} ${camera.y * frame.h}) scale(${camera.k})`}
            style={{ transformOrigin: '0 0' }}
          >
            <g className="graph-edges">
              {links.map((link) => {
                const a = viewLayout.get(link.source);
                const b = viewLayout.get(link.target);
                if (!a || !b) return null;
                const active = activeLinkIds.has(link.id);
                const dim = Boolean(focusId) && !active;
                // 连线跟随较早起跑的那一端入场，看起来像从节点长出来。
                const edgeDelay = Math.min(
                  introDelayOf.get(link.source) ?? 0,
                  introDelayOf.get(link.target) ?? 0
                );
                return (
                  <path
                    key={link.id}
                    d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`}
                    stroke={active ? EDGE_ACTIVE : EDGE_COLOR}
                    strokeWidth={(active ? 1.6 : 1) * forces.lineSize}
                    className={`graph-edge${active ? ' active' : ''}${dim ? ' dim' : ''}`}
                    fill="none"
                    style={introStyle(edgeDelay)}
                  />
                );
              })}
            </g>
            <g className="graph-nodes">
              {nodes.map((node) => {
                const p = viewLayout.get(node.id);
                if (!p) return null;
                const r = radiusOf(node, nodeScale);
                const color = nodeColorOf(node, colorMode);
                const active = selectedId === node.id || focusId === node.id;
                const pinned = pinnedIds.has(node.id);
                const connected =
                  Boolean(focusId) &&
                  Boolean(
                    view?.links.some(
                      (l) =>
                        (l.source === focusId && l.target === node.id) ||
                        (l.target === focusId && l.source === node.id)
                    )
                  );
                const dim = Boolean(focusId) && !active && !connected;
                const labelWidth = 14 * 12 * labelScale;
                const labelX = Math.max(
                  20 - p.x,
                  Math.min(frame.w - 20 - p.x - labelWidth, -labelWidth / 2)
                );
                const showLabel = visibleLabels.get(node.id) === true;
                const visualRadius = active ? r + 1.2 : r;
                const selectNode = () => {
                  setSelectedId(node.id);
                  syncFocusParam(node.id);
                };
                return (
                  <g
                    key={node.id}
                    data-node="1"
                    role="button"
                    tabIndex={0}
                    aria-label={`${GRAPH_TYPE_LABEL[node.type]}：${node.label}，${node.degree} 条连接${pinned ? '，已固定位置' : ''}`}
                    aria-pressed={selectedId === node.id}
                    transform={`translate(${p.x} ${p.y})`}
                    style={introStyle(introDelayOf.get(node.id) ?? 0)}
                    className={`graph-node graph-node-${node.type}${active ? ' active' : ''}${dim ? ' dim' : ''}${draggingNodeId === node.id ? ' is-dragging' : ''}${pinned ? ' is-pinned' : ''}`}
                    onPointerDown={(e) => onNodePointerDown(e, node.id)}
                    onClick={selectNode}
                    onDoubleClick={() => unpinNode(node.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectNode();
                      }
                      if (e.key === 'Backspace' || e.key === 'Delete') {
                        e.preventDefault();
                        unpinNode(node.id);
                      }
                    }}
                    onPointerEnter={() => setHoveredId(node.id)}
                    onPointerLeave={() => setHoveredId(null)}
                  >
                    <circle r={Math.max(14, 16 / camera.k)} fill="transparent" />
                    {pinned && (
                      <circle
                        r={visualRadius + 4.4}
                        fill="none"
                        stroke="rgba(214, 92, 198, 0.6)"
                        strokeWidth={0.9 / Math.max(0.6, camera.k)}
                        strokeDasharray="2.2 2.6"
                        className="graph-pin-ring"
                      />
                    )}
                    <circle
                      r={visualRadius + 1.8}
                      fill="none"
                      stroke={active ? 'rgba(232, 237, 244, 0.75)' : 'rgba(230, 235, 242, 0.1)'}
                      strokeWidth={active ? 1.3 : 0.7}
                    />
                    <circle
                      r={visualRadius}
                      fill={active ? '#e8edf4' : color}
                      className="graph-node-core"
                    />
                    {showLabel && node.type === 'capture' && (
                      <foreignObject
                        x={labelX}
                        y={r + 7 * labelScale}
                        width={labelWidth}
                        height={46 * labelScale}
                      >
                        <div
                          className="graph-node-label-html"
                          style={{
                            fontSize: 12 * labelScale,
                            lineHeight: 1.28,
                            opacity: active ? 1 : labelOpacityOf(true),
                            color: active ? '#f1f3f6' : 'rgba(205, 210, 219, 0.72)',
                          }}
                        >
                          {node.label}
                        </div>
                      </foreignObject>
                    )}
                    {showLabel && node.type !== 'capture' && (
                      <text
                        y={r + 10 * labelScale}
                        textAnchor="middle"
                        className="graph-node-label"
                        style={{ fontSize: 11 * labelScale, opacity: active ? 1 : labelOpacityOf(false) }}
                        fill={active ? '#f1f3f6' : 'rgba(200, 205, 214, 0.7)'}
                      >
                        {node.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
      </section>

      <div className="graph-readout">
        <div className="graph-readout-stats" aria-label="网络统计">
          <span><b>{view?.stats.captures ?? 0}</b> 念头</span>
          <span><b>{view?.stats.attempts ?? 0}</b> 尝试</span>
          <span><b>{view?.stats.experiences ?? 0}</b> 经验</span>
          <span><b>{view?.stats.research ?? 0}</b> 研究</span>
          <span><b>{view?.stats.reviews ?? 0}</b> 回顾</span>
          {Boolean(view?.stats.schedules) && (
            <span><b>{view?.stats.schedules ?? 0}</b> 安排</span>
          )}
          <span><b>{view?.stats.links ?? 0}</b> 连接</span>
        </div>
        <div className="graph-readout-legend" aria-hidden="true">
          {colorMode === 'type' ? (
            (['capture', 'experience', 'attempt', 'research', 'review', 'schedule'] as const).map(
              (t) => (
                <span key={t}><i style={{ background: TYPE_COLOR[t] }} />{GRAPH_TYPE_LABEL[t]}</span>
              )
            )
          ) : colorMode === 'group' ? (
            <span><i style={{ background: groupColor('同组') }} />同色为同一念头</span>
          ) : (
            <span><i style={{ background: MONO_COLOR }} />单色</span>
          )}
        </div>
        <div className="graph-readout-hint">
          {focusData
            ? `局部${depth === 2 ? '两跳' : '一跳'}关系 · 可返回全图`
            : '拖动平移 · 滚轮缩放 · 拖节点固定位置（双击释放）'}
        </div>
      </div>
      </div>

      <aside className="graph-panel" aria-label="节点详情">
        <div className="graph-panel-head">
          <span className="graph-panel-kicker">节点详情</span>
          {focusMissing && (
            <div className="graph-focus-missing" role="status" data-testid="graph-focus-missing">
              <p style={{ margin: 0 }}>{focusMissing}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                <button
                  type="button"
                  className="graph-secondary"
                  onClick={() => retryFocusLink()}
                >
                  重新载入这条记录
                </button>
                {!includeArchived && (
                  <button
                    type="button"
                    className="graph-secondary"
                    onClick={() => retryFocusWithArchived()}
                  >
                    包含归档后重试
                  </button>
                )}
                <button
                  type="button"
                  className="graph-secondary"
                  data-testid="graph-back-to-full"
                  onClick={() => dismissBrokenLink()}
                >
                  回到全图
                </button>
              </div>
            </div>
          )}
        </div>
        {selected ? (
          <>
            <div className="graph-node-type" style={{ color: TYPE_COLOR[selected.type] }}>
              <span style={{ borderColor: TYPE_COLOR[selected.type] }} />
              {GRAPH_TYPE_LABEL[selected.type]}{selected.archived ? ' · 已归档' : ''}
            </div>
            {!visibleNodeIds.has(selected.id) && (
              <p className="graph-hidden-note" role="status">
                这个节点被当前筛选隐藏，详情仍可查看。
              </p>
            )}
            <h2>{selected.label}</h2>
            {nodeText.subtitle && (
              <p className="gd-scope gd-sub">{nodeText.subtitle}</p>
            )}
            {nodeText.body && <p className="graph-detail gd-body">{nodeText.body}</p>}

            {selected.type === 'attempt' && selected.resultText && (
              <div className="graph-observation">
                <span>实际观察</span>
                <p>{selected.resultText}</p>
                {selected.outcome && (
                  <em className={`graph-outcome is-${selected.outcome}`}>
                    {OUTCOME_LABEL[selected.outcome] ?? selected.outcome}
                  </em>
                )}
              </div>
            )}
            {selected.type === 'attempt' && !selected.resultText && (
              <p className="graph-empty-observation">还没有记录实际结果，暂时不能当作经验复用。</p>
            )}

            {selected.type === 'review' && selected.origin === 'content_withheld' && (
              <div className="graph-withheld" role="status">
                <strong>生成正文已撤下</strong>
                <p>{selected.detail}</p>
              </div>
            )}

            {/* 所属念头已并入副标题（见 nodePanelText），这里不再重复一行。 */}

            <dl className="graph-meta">
              <div><dt>连接</dt><dd>{selected.degree} 条</dd></div>
              {/* 创建时间已由副标题给出（见 nodePanelText），这里不再重复一行「时间」。 */}
              {selected.state && (
                <div><dt>状态</dt><dd>{STATE_LABEL[selected.state] ?? selected.state}</dd></div>
              )}
              {selected.observedAt && (
                <div><dt>观察时间</dt><dd>{formatTime(selected.observedAt)}</dd></div>
              )}
              {selected.origin && ORIGIN_LABEL[selected.origin] && (
                <div><dt>来源</dt><dd>{ORIGIN_LABEL[selected.origin]}</dd></div>
              )}
              {selected.endsAt && (
                <div><dt>结束</dt><dd>{formatTime(selected.endsAt)}</dd></div>
              )}
            </dl>

            {selected.sourceUrl && (
              <p className="graph-source-link">
                来源链接：
                <a href={selected.sourceUrl} target="_blank" rel="noreferrer">
                  {selected.sourceUrl}
                </a>
              </p>
            )}

            {/* 三个动作统一成 1 主 + 2 次、同尺寸并排：主按钮只有「打开原记录」。 */}
            <div className="gd-scope graph-actions gd-actions">
              <Link to={selected.href} className="graph-open gd-btn gd-btn-primary">
                {selected.type === 'experience' ? '打开经验' : '打开原记录'}
              </Link>
              <button
                type="button"
                className="graph-secondary gd-btn gd-btn-secondary"
                onClick={() => void copyNodeLink()}
              >
                {copyStatus === 'copied' ? '已复制链接' : '复制节点链接'}
              </button>
              {!focusData && (
                <button
                  type="button"
                  className="graph-secondary gd-btn gd-btn-secondary graph-center-btn"
                  onClick={() => void focusNode(selected.id, true, includeArchived, depth)}
                >
                  查看局部图（{depth === 2 ? '两跳' : '一跳'}）
                </button>
              )}
              {focusData && focusData.meta?.focus !== selected.id && (
                <button
                  type="button"
                  className="graph-secondary gd-btn gd-btn-secondary graph-center-btn"
                  onClick={() => void focusNode(selected.id, true, includeArchived, depth)}
                >
                  以它为中心查看局部图
                </button>
              )}
            </div>

            {selected.type === 'attempt' && selected.resultText && (
              <div className="graph-reuse">
                <button
                  type="button"
                  className="graph-reuse-toggle"
                  aria-expanded={reuseOpen}
                  onClick={() => void openReuse()}
                >
                  {reuseOpen ? '收起经验复用' : '用这条经验试一步'}
                </button>
                {reuseOpen && (
                  <div className="graph-reuse-body">
                    <p className="graph-reuse-hint">
                      只会预选这条结果。打开念头后，仍要在预览里确认发送内容，才会调用模型。
                    </p>
                    <div className="graph-reuse-tabs" role="tablist">
                      <button
                        type="button"
                        className={reuseMode === 'existing' ? 'is-on' : ''}
                        onClick={() => setReuseMode('existing')}
                      >
                        选择现有念头
                      </button>
                      <button
                        type="button"
                        className={reuseMode === 'new' ? 'is-on' : ''}
                        onClick={() => setReuseMode('new')}
                      >
                        先记一条新念头
                      </button>
                    </div>
                    {reuseMode === 'existing' ? (
                      <>
                        <label className="graph-reuse-field">
                          把这条经验带到
                          <select
                            value={reuseCaptureId}
                            onChange={(e) => setReuseCaptureId(e.target.value)}
                          >
                            {reuseCaptures.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.rawText.replace(/\s+/g, ' ').slice(0, 48)}
                              </option>
                            ))}
                          </select>
                        </label>
                        {reuseCaptures.length === 0 ? (
                          <p className="graph-reuse-hint">当前没有可用念头，可以先记一条新的。</p>
                        ) : (
                          <button
                            type="button"
                            className="graph-reuse-go"
                            disabled={!reuseCaptureId}
                            onClick={() =>
                              startExperienceFor(
                                reuseCaptureId,
                                selected.id.replace(/^attempt:/, '')
                              )
                            }
                          >
                            进入经验预览
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <textarea
                          rows={3}
                          value={reuseNewIdea}
                          onChange={(e) => setReuseNewIdea(e.target.value)}
                          placeholder="先写下一个新念头…"
                        />
                        <button
                          type="button"
                          className="graph-reuse-go"
                          disabled={!reuseNewIdea.trim() || reuseBusy}
                          onClick={() => void createIdeaAndExperience()}
                        >
                          {reuseBusy ? '正在保存…' : '保存并进入经验预览'}
                        </button>
                      </>
                    )}
                    {reuseError && <p className="graph-error" role="alert">{reuseError}</p>}
                  </div>
                )}
              </div>
            )}

            <div className="graph-related">
              <p className="graph-related-title">
                关联到 {relationRows.filter((row) => row.outgoing).length} 条
              </p>
              {relationRows.filter((row) => row.outgoing).length === 0 ? (
                <p className="graph-empty-related">没有主动关联出去的记录。</p>
              ) : (
                relationRows
                  .filter((row) => row.outgoing)
                  .map((row) => (
                    <div key={row.link.id} className="graph-related-row graph-related-direction">
                      <span className="graph-rel-arrow" aria-hidden="true">→</span>
                      <em>{row.text}</em>
                      <button
                        type="button"
                        className="graph-rel-target"
                        onClick={() => {
                          setSelectedId(row.other.id);
                          syncFocusParam(row.other.id);
                        }}
                      >
                        {row.other.label}
                      </button>
                      <span className="graph-rel-type">{GRAPH_TYPE_LABEL[row.other.type]}</span>
                    </div>
                  ))
              )}
              <p className="graph-related-title graph-related-title-in">
                被关联 {relationRows.filter((row) => !row.outgoing).length} 条
              </p>
              {relationRows.filter((row) => !row.outgoing).length === 0 ? (
                <p className="graph-empty-related">还没有其他记录关联到这里。</p>
              ) : (
                relationRows
                  .filter((row) => !row.outgoing)
                  .map((row) => (
                    <div key={row.link.id} className="graph-related-row graph-related-direction">
                      <span className="graph-rel-arrow" aria-hidden="true">←</span>
                      <em>{row.text}</em>
                      <button
                        type="button"
                        className="graph-rel-target"
                        onClick={() => {
                          setSelectedId(row.other.id);
                          syncFocusParam(row.other.id);
                        }}
                      >
                        {row.other.label}
                      </button>
                      <span className="graph-rel-type">{GRAPH_TYPE_LABEL[row.other.type]}</span>
                    </div>
                  ))
              )}
            </div>
            {related.length === 0 && (
              <p className="graph-isolated-note">孤立节点不会被隐藏，仍可打开原记录或用于新的尝试。</p>
            )}
          </>
        ) : (
          <>
            <div className="graph-node-type">等待信号</div>
            <h2>点一个节点</h2>
            <p className="graph-detail">选中念头、尝试或研究，查看它和哪些事件真正连在一起。</p>
            {searchOpen && searchTerm.trim() && (
              <p className="graph-detail">也可以直接从上方搜索结果定位一条旧经验。</p>
            )}
          </>
        )}

        <form
          className="graph-compose"
          onSubmit={(e) => {
            e.preventDefault();
            saveIdea();
          }}
        >
          <label htmlFor="graph-new">把一个念头投进网络</label>
          <textarea
            id="graph-new"
            rows={3}
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            placeholder="不用分类，先写下来…"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                saveIdea();
              }
            }}
          />
          <div className="graph-compose-actions">
            <span>{composer.length ? `${composer.length} 字` : '只保存在本机'}</span>
            <button type="submit" disabled={!composer.trim() || saving}>
              {saving ? '正在落入…' : '投入网络'}
            </button>
          </div>
        </form>
        {justSaved && (
          <p className="graph-save-note">
            已加入网络。
            <button type="button" onClick={() => navigate(`/capture/${justSaved}`)}>打开念头</button>
          </p>
        )}
        {error && view && <p className="graph-error" role="alert">{error}</p>}
      </aside>

      <div className="graph-mobile-bar">
        <span>{nodes.length} 个节点 · {links.length} 条连接</span>
        <Link to="/">回到列表</Link>
      </div>
    </div>
  );
}

