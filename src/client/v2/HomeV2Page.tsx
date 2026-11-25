// 拾念 V2 · 首页（ChatGPT / Claude 风格 AI 对话与辅助记录工作台）
// - 默认意图「问 AI · 辅助记录」：像 ChatGPT 一样自由问大模型帮忙，支持多轮追问；
//   同时模型按需提炼「念头 + 尝试」草案，支持回答后一键存库或预览微调后再存。
// - 支持随时切换「直记念头」（免模型秒存）与「问我的记录」（严格基于勾选依据回答）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import type {
  AiModelsResponse,
  AiSettings,
  AskCandidate,
  AskListItem,
  AskPreviewResponse,
  AskPublic,
  AskSearchResponse,
  AssistDraftAttempt,
  Attempt,
  Capture,
  RecentAttempt,
} from '../types';
import { todayDateKey, useDisplayTimezone } from '../scheduleTime';
import { dayLabel, dayTimeLabel } from './format';
import { readRecentModelIds, rememberRecentModelId } from './preferences';
import V2Shell from './V2Shell';
import Pill, { type StatusKind } from './ui/Pill';
import Button from './ui/Button';
import Spinner from './ui/Spinner';
import AskAnswerView from './ui/AskAnswerView';
import RichReplyText from './ui/RichReplyText';
import './shared.css';
import styles from './HomeV2Page.module.css';

type ChatMode = 'assist' | 'capture' | 'ask';

const MAX_PICK = 8;
const makeOpId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function errText(e: unknown, fallback: string) {
  const anyErr = e as { status?: number; body?: { message?: string; error?: string }; message?: string };
  if (anyErr?.body?.message) return anyErr.body.message;
  if (anyErr?.status === 401) return '登录状态已失效，请重新登录。';
  if (anyErr?.status === 0 || anyErr?.message === 'Failed to fetch') {
    return '网络连接失败，请检查服务是否在运行。';
  }
  return fallback;
}

/** 当模型未自动附带结构化草案时，根据用户提问与 AI 回复生成可编辑的初始念头文本 */
function buildFallbackCaptureText(userText: string, reply: string): string {
  const q = userText.trim();
  const cleanReply = reply
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#*`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleanReply) return q.slice(0, 400);
  const summary = cleanReply.length > 220 ? cleanReply.slice(0, 220) + '…' : cleanReply;
  return `${q}\n\nAI 解答要点：${summary}`.slice(0, 800);
}

const ASK_STATUS_PILL: Record<string, { kind: StatusKind; label: string }> = {
  pending: { kind: 'active', label: '生成中' },
  succeeded: { kind: 'done', label: '已生成' },
  failed: { kind: 'fail', label: '生成失败' },
  cancelled: { kind: 'idle', label: '已取消' },
  interrupted: { kind: 'partial', label: '已中断' },
};

const MODE_LABEL: Record<ChatMode, string> = {
  assist: '问 AI · 辅助记录',
  capture: '直记念头',
  ask: '问我的记录',
};

type AssistAttemptPick = AssistDraftAttempt & {
  checked: boolean;
  opId: string;
  savedAttemptId?: string;
};

type AssistTurn = {
  id: string;
  kind: 'assist';
  userText: string;
  createdAt: number;
  loading: boolean;
  cancelled: boolean;
  interrupted: boolean;
  reply: string | null;
  modelId: string | null;
  durationMs: number | null;
  tokens: number | null;
  draftText: string;
  draftDirty: boolean;
  hasDraft: boolean;
  draftExpanded: boolean;
  draftAttempts: AssistAttemptPick[];
  newAttemptText: string;
  savingDraft: boolean;
  /** 念头一旦入库即暂存，防止后续某条尝试保存失败重试时重复创建念头 */
  createdCapture: Capture | null;
  savedCapture: Capture | null;
  savedAttemptsCount: number;
  copied: boolean;
  error: string | null;
  errorCode: string | null;
};

type CaptureTurn = {
  id: string;
  kind: 'capture';
  userText: string;
  createdAt: number;
  capture: Capture | null;
  retrying: boolean;
  error: string | null;
  attemptDraft: string;
  attemptSaving: boolean;
  attemptError: string | null;
  addedAttempts: Attempt[];
};

type AskTurn = {
  id: string;
  kind: 'ask';
  userText: string;
  createdAt: number;
  searching: boolean;
  search: AskSearchResponse | null;
  selectedKeys: string[];
  previewLoading: boolean;
  preview: AskPreviewResponse | null;
  creating: boolean;
  query: AskPublic | null;
  error: string | null;
  notice: string | null;
};

type ChatTurn = AssistTurn | CaptureTurn | AskTurn;

export default function HomeV2Page() {
  const [timezone] = useDisplayTimezone();

  // 基础库数据（左栏历史与状态栏）
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [attempts, setAttempts] = useState<RecentAttempt[]>([]);
  const [asks, setAsks] = useState<AskListItem[]>([]);
  const [topicsTotal, setTopicsTotal] = useState(0);
  const [experiencesTotal, setExperiencesTotal] = useState(0);

  // 对话状态：默认「AI 辅助记录」
  const [mode, setMode] = useState<ChatMode>('assist');
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [activeAskId, setActiveAskId] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);

  // 大模型选择与切换
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [modelPopOpen, setModelPopOpen] = useState(false);
  const [modelsData, setModelsData] = useState<AiModelsResponse | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const [customModelId, setCustomModelId] = useState('');
  const [switchingModel, setSwitchingModel] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [recentModels, setRecentModels] = useState<string[]>(readRecentModelIds);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const assistAbortRef = useRef<AbortController | null>(null);
  const chatSessionRef = useRef(0);
  const userTouchedModeRef = useRef(false);
  const defaultModeAppliedRef = useRef(false);

  const selectMode = useCallback((next: ChatMode) => {
    userTouchedModeRef.current = true;
    setMode(next);
  }, []);

  useEffect(() => {
    return () => {
      assistAbortRef.current?.abort();
    };
  }, []);

  const loadSidebar = useCallback(async () => {
    try {
      const [capRes, attRes, askRes, topicRes, expRes, aiRes] = await Promise.all([
        api.listCaptures(false),
        api.listRecentAttempts(6),
        api.listAskQueries(12),
        api.listTopics({ limit: 1, archived: 'exclude' }),
        api.listExperiences({ archived: 'exclude', limit: 1 }),
        api.getAiSettings(),
      ]);
      setCaptures(capRes.captures ?? []);
      setAttempts(attRes.attempts ?? []);
      setAsks(askRes.queries ?? []);
      setTopicsTotal(topicRes.total ?? (topicRes.topics ?? []).length);
      setExperiencesTotal(expRes.experiences?.length ?? 0);
      setAiSettings(aiRes);
      if (aiRes.config?.modelId) {
        setRecentModels(rememberRecentModelId(aiRes.config.modelId));
      }
      // 未配置或停用 AI 时，首次默认落到「直记念头」，让无 AI 流程 10 秒内直接记下
      if (!defaultModeAppliedRef.current && !userTouchedModeRef.current) {
        defaultModeAppliedRef.current = true;
        if (!aiRes.configured || !aiRes.config?.enabled) {
          setMode('capture');
        }
      }
    } catch {
      /* 静默保底，避免侧栏刷新报错打断主对话 */
    }
  }, []);

  useEffect(() => {
    void loadSidebar();
  }, [loadSidebar]);

  // 点击浮层外或按 Esc 关闭各弹出浮层
  useEffect(() => {
    if (!modelPopOpen && !plusMenuOpen && !modeMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (modelPickerRef.current && !modelPickerRef.current.contains(target)) {
        setModelPopOpen(false);
      }
      if (plusMenuRef.current && !plusMenuRef.current.contains(target)) {
        setPlusMenuOpen(false);
      }
      if (modeMenuRef.current && !modeMenuRef.current.contains(target)) {
        setModeMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setModelPopOpen(false);
        setPlusMenuOpen(false);
        setModeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [modelPopOpen, plusMenuOpen, modeMenuOpen]);

  async function refreshAvailableModels() {
    setModelsLoading(true);
    setModelError(null);
    try {
      const res = await api.getAiModels();
      setModelsData(res);
    } catch (e) {
      setModelError(errText(e, '无法拉取可用模型列表。'));
    } finally {
      setModelsLoading(false);
    }
  }

  function toggleModelPopover() {
    const next = !modelPopOpen;
    setModelPopOpen(next);
    setPlusMenuOpen(false);
    setModeMenuOpen(false);
    setModelError(null);
    if (next && !modelsData && !modelsLoading) {
      void refreshAvailableModels();
    }
  }

  async function switchModelId(targetModelId: string, overrideEnabled?: boolean) {
    const cfg = aiSettings?.config;
    const nextId = targetModelId.trim();
    if (!cfg || !nextId || switchingModel) return;
    setSwitchingModel(true);
    setModelError(null);
    try {
      const res = await api.saveAiSettings({
        name: cfg.name,
        baseUrl: cfg.baseUrl,
        modelId: nextId,
        enabled: overrideEnabled ?? cfg.enabled,
        allowLocal: cfg.allowLocal,
      });
      setAiSettings(res);
      setRecentModels(rememberRecentModelId(nextId));
      setCustomModelId('');
      setModelPopOpen(false);
    } catch (e) {
      setModelError(errText(e, '切换大模型失败，请重试。'));
    } finally {
      setSwitchingModel(false);
    }
  }

  // 输入框自适应高度
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(Math.max(el.scrollHeight, 36), 180) + 'px';
  }, [input, turns.length]);

  // 新消息到来自动轻滚到底部
  useEffect(() => {
    if (turns.length === 0) return;
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length]);

  // 轮询所有处于 pending 状态的「问我的记录」回合
  const pendingAskIds = turns
    .filter((t): t is AskTurn => t.kind === 'ask' && t.query?.status === 'pending')
    .map((t) => `${t.id}:${t.query!.id}`)
    .join(',');

  useEffect(() => {
    if (!pendingAskIds) return;
    const pairs = pendingAskIds.split(',').map((s) => {
      const [turnId, queryId] = s.split(':');
      return { turnId, queryId };
    });
    const timer = window.setInterval(async () => {
      for (const { turnId, queryId } of pairs) {
        try {
          const res = await api.getAskQuery(queryId);
          setTurns((prev) =>
            prev.map((t) => (t.id === turnId && t.kind === 'ask' ? { ...t, query: res.query } : t))
          );
          if (res.query.status !== 'pending') {
            void loadSidebar();
          }
        } catch {
          /* 轮询单次失败继续下一轮 */
        }
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [pendingAskIds, loadSidebar]);

  function stopAssistGeneration() {
    assistAbortRef.current?.abort();
    assistAbortRef.current = null;
    setSubmitting(false);
    setTurns((prev) =>
      prev.map((t) =>
        t.kind === 'assist' && t.loading
          ? {
              ...t,
              loading: false,
              cancelled: true,
              error: t.reply ? null : '已取消本次生成，你的输入仍保留，可直接重试或放回输入框修改。',
            }
          : t
      )
    );
  }

  function restoreToInput(text: string, targetMode?: ChatMode) {
    if (targetMode) selectMode(targetMode);
    setInput(text);
    window.setTimeout(() => textareaRef.current?.focus(), 30);
  }

  function startNewChat() {
    chatSessionRef.current += 1;
    assistAbortRef.current?.abort();
    assistAbortRef.current = null;
    setSubmitting(false);
    setTurns([]);
    setActiveAskId(null);
    setInput('');
    window.setTimeout(() => textareaRef.current?.focus(), 40);
  }

  async function openHistoryAsk(item: AskListItem) {
    setLoadingHistory(true);
    setActiveAskId(item.id);
    try {
      const res = await api.getAskQuery(item.id);
      const q = res.query;
      const turn: AskTurn = {
        id: 'hist-' + q.id,
        kind: 'ask',
        userText: q.question,
        createdAt: q.createdAt,
        searching: false,
        search: null,
        selectedKeys: [],
        previewLoading: false,
        preview: null,
        creating: false,
        query: q,
        error: null,
        notice: null,
      };
      setMode('ask');
      setTurns([turn]);
    } catch {
      /* ignore */
    } finally {
      setLoadingHistory(false);
    }
  }

  function collectAssistHistory(untilTurnId?: string) {
    const slice = untilTurnId
      ? turns.slice(
          0,
          Math.max(
            0,
            turns.findIndex((t) => t.id === untilTurnId)
          )
        )
      : turns;
    const history: Array<{ role: 'user' | 'assistant'; text: string }> = [];
    for (const t of slice.slice(-4)) {
      if (t.kind === 'assist') {
        history.push({ role: 'user', text: t.userText });
        if (t.reply) history.push({ role: 'assistant', text: t.reply });
      }
    }
    return history;
  }

  async function runAssistCall(
    turnId: string,
    promptText: string,
    history: Array<{ role: 'user' | 'assistant'; text: string }>
  ) {
    const sessionToken = chatSessionRef.current;
    assistAbortRef.current?.abort();
    const controller = new AbortController();
    assistAbortRef.current = controller;

    try {
      const res = await api.assistCaptureStream(
        { message: promptText, history },
        {
          onStart: ({ modelId }) => {
            if (sessionToken !== chatSessionRef.current) return;
            setTurns((prev) =>
              prev.map((t) =>
                t.id === turnId && t.kind === 'assist' ? { ...t, modelId: modelId || t.modelId } : t
              )
            );
          },
          onDelta: (_delta, accumulated) => {
            if (sessionToken !== chatSessionRef.current) return;
            setTurns((prev) =>
              prev.map((t) =>
                t.id === turnId && t.kind === 'assist' ? { ...t, reply: accumulated } : t
              )
            );
          },
        },
        controller.signal
      );

      if (sessionToken !== chatSessionRef.current) return;
      setTurns((prev) =>
        prev.map((t) => {
          if (t.id !== turnId || t.kind !== 'assist') return t;
          const nextHasDraft = Boolean(res.draft && res.draft.captureText);
          // 保留用户此前已手动编辑过的草案正文与步骤，避免重试时覆写丢失编辑
          const preserveUserEdit = t.draftDirty && Boolean(t.draftText.trim());
          return {
            ...t,
            loading: false,
            cancelled: false,
            interrupted: false,
            error: null,
            errorCode: null,
            reply: res.reply,
            modelId: res.modelId,
            durationMs: res.durationMs,
            tokens: res.usage?.totalTokens ?? null,
            hasDraft: preserveUserEdit ? true : nextHasDraft,
            draftExpanded: preserveUserEdit
              ? true
              : Boolean(res.draft && res.draft.captureText && res.draft.autoOpen !== false),
            draftText: preserveUserEdit ? t.draftText : (res.draft?.captureText ?? ''),
            draftAttempts: preserveUserEdit
              ? t.draftAttempts
              : (res.draft?.attempts ?? []).map((a) => ({
                  step: a.step,
                  state: 'todo' as const,
                  resultText: null,
                  outcome: null,
                  checked: true,
                  opId: makeOpId('assist-att'),
                })),
          };
        })
      );
    } catch (e) {
      if (sessionToken !== chatSessionRef.current) return;
      const aborted = controller.signal.aborted || (e as { name?: string })?.name === 'AbortError';
      if (aborted) {
        setTurns((prev) =>
          prev.map((t) =>
            t.id === turnId && t.kind === 'assist' && t.loading
              ? {
                  ...t,
                  loading: false,
                  cancelled: true,
                  error: t.reply ? null : '已取消本次生成，你的输入仍保留，可直接重试或放回输入框修改。',
                }
              : t
          )
        );
        return;
      }
      const anyErr = e as { body?: { error?: string } };
      const code = anyErr?.body?.error ?? null;
      const codeMeansInterrupted =
        code === 'incomplete_stream' ||
        code === 'empty_stream' ||
        code === 'interrupted';
      const msg = errText(e, '模型调用失败，请检查模型设置后重试。');
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId && t.kind === 'assist'
            ? {
                ...t,
                loading: false,
                interrupted: codeMeansInterrupted || Boolean(t.reply && t.reply.trim()),
                error: msg,
                errorCode: code,
              }
            : t
        )
      );
    } finally {
      if (assistAbortRef.current === controller) {
        assistAbortRef.current = null;
      }
      if (sessionToken === chatSessionRef.current) {
        setSubmitting(false);
      }
    }
  }

  async function handleSend(overrideText?: string, overrideMode?: ChatMode) {
    const raw = (overrideText ?? input).trim();
    const targetMode = overrideMode ?? mode;
    if (!raw || submitting) return;

    if (overrideText === undefined) setInput('');
    setSubmitting(true);
    setActiveAskId(null);
    const turnId = makeOpId('turn');

    if (targetMode === 'assist') {
      const history = collectAssistHistory();
      const initialTurn: AssistTurn = {
        id: turnId,
        kind: 'assist',
        userText: raw,
        createdAt: Date.now(),
        loading: true,
        cancelled: false,
        interrupted: false,
        reply: null,
        modelId: null,
        durationMs: null,
        tokens: null,
        draftText: '',
        draftDirty: false,
        hasDraft: false,
        draftExpanded: false,
        draftAttempts: [],
        newAttemptText: '',
        savingDraft: false,
        createdCapture: null,
        savedCapture: null,
        savedAttemptsCount: 0,
        copied: false,
        error: null,
        errorCode: null,
      };
      setTurns((prev) => [...prev, initialTurn]);
      await runAssistCall(turnId, raw, history);
      return;
    }

    if (targetMode === 'capture') {
      const initialTurn: CaptureTurn = {
        id: turnId,
        kind: 'capture',
        userText: raw,
        createdAt: Date.now(),
        capture: null,
        retrying: false,
        error: null,
        attemptDraft: '',
        attemptSaving: false,
        attemptError: null,
        addedAttempts: [],
      };
      setTurns((prev) => [...prev, initialTurn]);
      try {
        const res = await api.createCapture(raw);
        setTurns((prev) =>
          prev.map((t) =>
            t.id === turnId && t.kind === 'capture' ? { ...t, capture: res.capture, error: null } : t
          )
        );
        void loadSidebar();
      } catch (e) {
        const msg = errText(e, '保存念头失败，原文仍已保留，可重试或放回输入框修改。');
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId && t.kind === 'capture' ? { ...t, error: msg } : t))
        );
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // 问我的记录：先检索本机候选记录（不绕过依据确认）
    const askTurn: AskTurn = {
      id: turnId,
      kind: 'ask',
      userText: raw,
      createdAt: Date.now(),
      searching: true,
      search: null,
      selectedKeys: [],
      previewLoading: false,
      preview: null,
      creating: false,
      query: null,
      error: null,
      notice: null,
    };
    setTurns((prev) => [...prev, askTurn]);
    try {
      const searchRes = await api.searchAskCandidates({
        question: raw,
        from: null,
        to: null,
        limit: 40,
      });
      const defaultSelected = (searchRes.candidates ?? [])
        .slice(0, MAX_PICK)
        .map((c) => c.sourceKey);
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId && t.kind === 'ask'
            ? {
                ...t,
                searching: false,
                search: searchRes,
                selectedKeys: defaultSelected,
                notice:
                  (searchRes.candidates ?? []).length === 0
                    ? '本机记录里还没有匹配到相关内容，可以直接请 AI 大模型解答，或先记录几条念头。'
                    : null,
              }
            : t
        )
      );
    } catch (e) {
      const msg = errText(e, '检索相关记录失败，请重试。');
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId && t.kind === 'ask' ? { ...t, searching: false, error: msg } : t
        )
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function retryCaptureTurn(turn: CaptureTurn) {
    if (turn.retrying || turn.capture) return;
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turn.id && t.kind === 'capture' ? { ...t, retrying: true, error: null } : t
      )
    );
    try {
      const res = await api.createCapture(turn.userText);
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turn.id && t.kind === 'capture'
            ? { ...t, retrying: false, capture: res.capture, error: null }
            : t
        )
      );
      void loadSidebar();
    } catch (e) {
      const msg = errText(e, '保存念头失败，原文仍已保留，请重试。');
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turn.id && t.kind === 'capture' ? { ...t, retrying: false, error: msg } : t
        )
      );
    }
  }

  async function retryAssistTurn(turn: AssistTurn) {
    if (submitting || turn.loading) return;
    const history = collectAssistHistory(turn.id);
    setSubmitting(true);
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turn.id && t.kind === 'assist'
          ? { ...t, loading: true, cancelled: false, interrupted: false, error: null, errorCode: null }
          : t
      )
    );
    await runAssistCall(turn.id, turn.userText, history);
  }

  function openManualDraft(turn: AssistTurn) {
    setTurns((prev) =>
      prev.map((t) => {
        if (t.id !== turn.id || t.kind !== 'assist') return t;
        return {
          ...t,
          draftExpanded: true,
          draftText: t.draftText.trim()
            ? t.draftText
            : buildFallbackCaptureText(t.userText, t.reply ?? ''),
        };
      })
    );
  }

  function appendDraftAttempt(turnId: string) {
    setTurns((prev) =>
      prev.map((t) => {
        if (t.id !== turnId || t.kind !== 'assist') return t;
        const step = t.newAttemptText.trim();
        if (!step) return t;
        return {
          ...t,
          draftDirty: true,
          newAttemptText: '',
          draftAttempts: [
            ...t.draftAttempts,
            {
              step: step.slice(0, 500),
              state: 'todo',
              resultText: null,
              outcome: null,
              checked: true,
              opId: makeOpId('assist-att'),
            },
          ],
        };
      })
    );
  }

  async function copyReplyText(turnId: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setTurns((prev) =>
        prev.map((t) => (t.id === turnId && t.kind === 'assist' ? { ...t, copied: true } : t))
      );
      window.setTimeout(() => {
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId && t.kind === 'assist' ? { ...t, copied: false } : t))
        );
      }, 1600);
    } catch {
      /* 忽略剪贴板权限限制 */
    }
  }

  function switchToAssistAndAsk(questionText: string) {
    if (submitting) return;
    setMode('assist');
    void handleSend(questionText, 'assist');
  }

  async function saveAssistDraft(turn: AssistTurn, fallbackRawText?: string) {
    const rawText = (fallbackRawText ?? turn.draftText).trim();
    if (!rawText || turn.savingDraft || turn.savedCapture) return;
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turn.id && t.kind === 'assist' ? { ...t, savingDraft: true, error: null } : t
      )
    );
    try {
      // 幂等防重：若上一次已建好念头但某条尝试失败，直接复用 createdCapture，绝不重复建念头
      let captureObj = turn.createdCapture;
      if (!captureObj) {
        const capRes = await api.createCapture(rawText);
        captureObj = capRes.capture;
        setTurns((prev) =>
          prev.map((t) =>
            t.id === turn.id && t.kind === 'assist' ? { ...t, createdCapture: captureObj } : t
          )
        );
      }

      const picked = fallbackRawText
        ? []
        : turn.draftAttempts.filter((a) => a.checked && a.step.trim().length > 0);
      let addedCount = 0;
      const savedMap = new Map<string, string>();
      for (const a of picked) {
        if (a.savedAttemptId) {
          addedCount += 1;
          continue;
        }
        // 严格遵守边界：模型建议的尝试绝不直接写成用户亲自观察到的结果
        const attRes = await api.createAttempt(captureObj.id, {
          step: a.step.trim().slice(0, 500),
          state: 'todo',
          resultText: null,
          outcome: null,
          operationId: a.opId,
        });
        savedMap.set(a.opId, attRes.attempt.id);
        addedCount += 1;
      }

      setTurns((prev) =>
        prev.map((t) =>
          t.id === turn.id && t.kind === 'assist'
            ? {
                ...t,
                savingDraft: false,
                createdCapture: captureObj,
                savedCapture: captureObj,
                savedAttemptsCount: addedCount,
                draftAttempts: t.draftAttempts.map((item) =>
                  savedMap.has(item.opId) ? { ...item, savedAttemptId: savedMap.get(item.opId) } : item
                ),
              }
            : t
        )
      );
      void loadSidebar();
    } catch (e) {
      const msg = errText(e, '写入记录库失败，已保留你编辑的草案内容，重试不会重复创建已保存项。');
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turn.id && t.kind === 'assist' ? { ...t, savingDraft: false, error: msg } : t
        )
      );
    }
  }

  async function addInlineAttempt(turn: CaptureTurn) {
    const step = turn.attemptDraft.trim();
    if (!step || !turn.capture || turn.attemptSaving) return;
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turn.id && t.kind === 'capture'
          ? { ...t, attemptSaving: true, attemptError: null }
          : t
      )
    );
    try {
      const res = await api.createAttempt(turn.capture.id, {
        step,
        state: 'todo',
        operationId: makeOpId('chat-att'),
      });
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turn.id && t.kind === 'capture'
            ? {
                ...t,
                attemptDraft: '',
                attemptSaving: false,
                addedAttempts: [...t.addedAttempts, res.attempt],
              }
            : t
        )
      );
      void loadSidebar();
    } catch (e) {
      const msg = errText(e, '添加尝试失败，请重试。');
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turn.id && t.kind === 'capture'
            ? { ...t, attemptSaving: false, attemptError: msg }
            : t
        )
      );
    }
  }

  function toggleAskCandidate(turnId: string, sourceKey: string) {
    setTurns((prev) =>
      prev.map((t) => {
        if (t.id !== turnId || t.kind !== 'ask') return t;
        const exists = t.selectedKeys.includes(sourceKey);
        if (exists) {
          return {
            ...t,
            preview: null,
            notice: null,
            selectedKeys: t.selectedKeys.filter((k) => k !== sourceKey),
          };
        }
        if (t.selectedKeys.length >= MAX_PICK) {
          return {
            ...t,
            notice: `每次回答最多选择 ${MAX_PICK} 条记录作为依据，请先取消几条。`,
          };
        }
        return {
          ...t,
          preview: null,
          notice: null,
          selectedKeys: [...t.selectedKeys, sourceKey],
        };
      })
    );
  }

  async function previewAndAsk(turn: AskTurn) {
    if (!turn.search || turn.selectedKeys.length === 0 || turn.previewLoading || turn.creating) return;
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turn.id && t.kind === 'ask'
          ? { ...t, previewLoading: true, error: null, notice: null }
          : t
      )
    );
    try {
      const previewRes = await api.previewAsk({
        question: turn.search.question,
        keywords: (turn.search.keywords ?? []).join(' '),
        from: null,
        to: null,
        sourceKeys: turn.selectedKeys,
      });

      if (!previewRes.ai.configured || !previewRes.ai.enabled) {
        setTurns((prev) =>
          prev.map((t) =>
            t.id === turn.id && t.kind === 'ask'
              ? {
                  ...t,
                  previewLoading: false,
                  preview: previewRes,
                  notice: previewRes.ai.configured
                    ? 'AI 模型当前已停用，请先在「AI 模型设置」中启用后再发送。'
                    : '尚未配置 AI 模型，请先去「AI 模型设置」配置；当前已为你选出相关记录。',
                }
              : t
          )
        );
        return;
      }

      if (!previewRes.coverage.withinLimit) {
        setTurns((prev) =>
          prev.map((t) =>
            t.id === turn.id && t.kind === 'ask'
              ? {
                  ...t,
                  previewLoading: false,
                  preview: previewRes,
                  notice: `已选 ${previewRes.coverage.selectedRecords}/${previewRes.coverage.maxRecords} 条（${previewRes.coverage.selectedChars}/${previewRes.coverage.maxChars} 字），超出单次上限，请减少勾选后再发送。`,
                }
              : t
          )
        );
        return;
      }

      setTurns((prev) =>
        prev.map((t) =>
          t.id === turn.id && t.kind === 'ask'
            ? { ...t, previewLoading: false, creating: true, preview: previewRes }
            : t
        )
      );

      const created = await api.createAskQuery({
        question: previewRes.question,
        keywords: previewRes.keywords.join(' '),
        from: null,
        to: null,
        sourceKeys: turn.selectedKeys,
        contextToken: previewRes.contextToken,
        operationId: makeOpId('chat-ask'),
      });
      setActiveAskId(created.query.id);
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turn.id && t.kind === 'ask'
            ? { ...t, creating: false, query: created.query }
            : t
        )
      );
      void loadSidebar();
    } catch (e) {
      const msg = errText(e, '发送失败，请重试。');
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turn.id && t.kind === 'ask'
            ? { ...t, previewLoading: false, creating: false, error: msg }
            : t
        )
      );
    }
  }

  async function cancelTurnQuery(turnId: string, queryId: string) {
    try {
      const res = await api.cancelAskQuery(queryId);
      setTurns((prev) =>
        prev.map((t) => (t.id === turnId && t.kind === 'ask' ? { ...t, query: res.query } : t))
      );
    } catch {
      /* ignore */
    }
  }

  const todoAttempt = attempts.find((a) => a.state === 'todo' || a.state === 'in_progress');
  const latestCapture = captures[0];

  const activeCfg = aiSettings?.config ?? null;
  const mergedModels = Array.from(
    new Set([
      ...(activeCfg?.modelId ? [activeCfg.modelId] : []),
      ...(modelsData?.models ?? []),
      ...recentModels,
    ])
  );
  const filteredModels = modelFilter.trim()
    ? mergedModels.filter((m) => m.toLowerCase().includes(modelFilter.trim().toLowerCase()))
    : mergedModels;

  const composerNode = (
    <div className={styles.composerCard}>
      <textarea
        ref={textareaRef}
        className={styles.textarea}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          const composing = e.nativeEvent.isComposing || e.keyCode === 229;
          if (e.key === 'Enter' && !e.shiftKey && !composing) {
            e.preventDefault();
            void handleSend();
          }
        }}
        placeholder={
          mode === 'assist'
            ? '向 AI 提问任何问题、请大模型帮忙分析，或聊聊想法与刚试过的做法（回答后可一键存为念头）…'
            : mode === 'capture'
              ? '直记念头：不经过模型，写完直接保存到本地记录库…'
              : '问我的记录：输入你想基于真实记录查问的问题…'
        }
        aria-label={`${MODE_LABEL[mode]}输入框`}
        maxLength={4000}
        rows={2}
      />
      <div className={styles.composerBar}>
        <div className={styles.leftControls}>
          <div className={styles.popWrap} ref={plusMenuRef}>
            <button
              type="button"
              className={styles.plusCircleBtn}
              aria-label="更多快捷操作"
              aria-expanded={plusMenuOpen}
              title="快捷功能与工作台跳转"
              onClick={() => {
                setPlusMenuOpen((v) => !v);
                setModeMenuOpen(false);
                setModelPopOpen(false);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>

            {plusMenuOpen && (
              <div className={styles.smallMenu} role="menu" aria-label="快捷入口">
                {latestCapture && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.smallMenuItem}
                    onClick={() => {
                      const snippet = latestCapture.rawText.slice(0, 14);
                      setMode('ask');
                      setInput(`关于「${snippet}」，我之前试过什么、效果怎样？`);
                      setPlusMenuOpen(false);
                      textareaRef.current?.focus();
                    }}
                  >
                    <span>
                      问最近念头
                      <span className={styles.smallMenuSub}>关于「{latestCapture.rawText.slice(0, 12)}」</span>
                    </span>
                  </button>
                )}
                {todoAttempt && (
                  <Link
                    to={'/attempt/' + todoAttempt.id}
                    role="menuitem"
                    className={styles.smallMenuItem}
                    onClick={() => setPlusMenuOpen(false)}
                  >
                    <span>
                      继续当前尝试
                      <span className={styles.smallMenuSub}>{todoAttempt.step.slice(0, 18)}</span>
                    </span>
                  </Link>
                )}
                <Link
                  to="/search"
                  role="menuitem"
                  className={styles.smallMenuItem}
                  onClick={() => setPlusMenuOpen(false)}
                >
                  <span>打开念头列表与现在要做 →</span>
                </Link>
                <Link
                  to="/review"
                  role="menuitem"
                  className={styles.smallMenuItem}
                  onClick={() => setPlusMenuOpen(false)}
                >
                  <span>周期回顾与念头日程表 →</span>
                </Link>
              </div>
            )}
          </div>

          <div className={styles.popWrap} ref={modeMenuRef}>
            <button
              type="button"
              className={styles.ghostSelectBtn}
              aria-expanded={modeMenuOpen}
              aria-haspopup="menu"
              aria-label="切换输入意图"
              onClick={() => {
                setModeMenuOpen((v) => !v);
                setPlusMenuOpen(false);
                setModelPopOpen(false);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {mode === 'assist' ? (
                  <path d="M12 3l1.9 5.5L19.5 10l-5.6 1.5L12 17l-1.9-5.5L4.5 10l5.6-1.5Z" />
                ) : mode === 'capture' ? (
                  <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                ) : (
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                )}
              </svg>
              <span className={styles.modeLabelText}>{MODE_LABEL[mode]}</span>
              <span className={styles.chevSmall} aria-hidden="true">
                ⌄
              </span>
            </button>

            {modeMenuOpen && (
              <div className={styles.smallMenu} role="menu" aria-label="选择输入意图">
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.smallMenuItem}${mode === 'assist' ? ' ' + styles.smallMenuItemActive : ''}`}
                  onClick={() => {
                    selectMode('assist');
                    setModeMenuOpen(false);
                    textareaRef.current?.focus();
                  }}
                >
                  <span>
                    问 AI · 辅助记录
                    <span className={styles.smallMenuSub}>像 ChatGPT 一样自由问 AI 帮忙，也可一键存为念头与尝试</span>
                  </span>
                  {mode === 'assist' && <span style={{ color: 'var(--accent)' }}>✓</span>}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.smallMenuItem}${mode === 'capture' ? ' ' + styles.smallMenuItemActive : ''}`}
                  onClick={() => {
                    selectMode('capture');
                    setModeMenuOpen(false);
                    textareaRef.current?.focus();
                  }}
                >
                  <span>
                    直记念头
                    <span className={styles.smallMenuSub}>不经大模型，立刻保存为新念头</span>
                  </span>
                  {mode === 'capture' && <span style={{ color: 'var(--accent)' }}>✓</span>}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.smallMenuItem}${mode === 'ask' ? ' ' + styles.smallMenuItemActive : ''}`}
                  onClick={() => {
                    selectMode('ask');
                    setModeMenuOpen(false);
                    textareaRef.current?.focus();
                  }}
                >
                  <span>
                    问我的记录
                    <span className={styles.smallMenuSub}>检索本机记录，确认依据后问大模型</span>
                  </span>
                  {mode === 'ask' && <span style={{ color: 'var(--accent)' }}>✓</span>}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className={styles.sendSide}>
          <div className={styles.modelPickerWrap} ref={modelPickerRef}>
            <button
              type="button"
              className={styles.modelTrigger}
              onClick={toggleModelPopover}
              aria-expanded={modelPopOpen}
              aria-haspopup="dialog"
              aria-label="选择大模型"
              title={
                activeCfg
                  ? `${activeCfg.name} · ${activeCfg.modelId}${activeCfg.enabled ? '' : '（已停用）'}`
                  : '尚未配置大模型，点击配置或选择'
              }
            >
              <span className={styles.modelName}>
                {activeCfg ? activeCfg.modelId : '选择大模型'}
              </span>
              <span className={styles.chevSmall} aria-hidden="true">
                ⌄
              </span>
            </button>

            {modelPopOpen && (
              <div className={styles.modelPopover} role="dialog" aria-label="选择大模型">
                <div className={styles.modelPopHead}>
                  <span className={styles.modelPopTitle}>
                    {activeCfg ? `${activeCfg.name} · 模型` : '尚未配置大模型'}
                  </span>
                  <div className={styles.modelPopActions}>
                    {activeCfg && (
                      <>
                        <button
                          type="button"
                          className={styles.modelMiniBtn}
                          disabled={switchingModel}
                          onClick={() => void switchModelId(activeCfg.modelId, !activeCfg.enabled)}
                        >
                          {activeCfg.enabled ? '停用' : '启用'}
                        </button>
                        <button
                          type="button"
                          className={styles.modelMiniBtn}
                          disabled={modelsLoading}
                          onClick={() => void refreshAvailableModels()}
                        >
                          {modelsLoading ? '刷新中…' : '刷新'}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {!activeCfg ? (
                  <>
                    <p className="v2-groupNote">
                      先在设置里填入一次 Base URL 与 API Key，之后即可在这里随时切换大模型。
                    </p>
                    <Link to="/settings/ai" className={styles.botLink} onClick={() => setModelPopOpen(false)}>
                      去配置 AI 模型与密钥 →
                    </Link>
                  </>
                ) : (
                  <>
                    {mergedModels.length > 5 && (
                      <input
                        className={styles.modelFilterInput}
                        value={modelFilter}
                        onChange={(e) => setModelFilter(e.target.value)}
                        placeholder="筛选可用模型…"
                        aria-label="筛选大模型"
                      />
                    )}

                    <div className={styles.modelList}>
                      {filteredModels.length === 0 ? (
                        <p className="v2-groupNote" style={{ padding: '4px 6px' }}>
                          没有匹配的模型，可在下方直接输入 Model ID。
                        </p>
                      ) : (
                        filteredModels.map((m) => {
                          const selected = m === activeCfg.modelId;
                          return (
                            <button
                              key={m}
                              type="button"
                              className={`${styles.modelOption}${selected ? ' ' + styles.modelOptionActive : ''}`}
                              disabled={switchingModel}
                              onClick={() => void switchModelId(m)}
                            >
                              <span className={styles.modelOptionId}>{m}</span>
                              {selected && (
                                <span style={{ color: 'var(--accent)', fontSize: 12 }} aria-label="当前使用">
                                  ✓
                                </span>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>

                    <div className={styles.modelCustomRow}>
                      <input
                        className={styles.modelCustomInput}
                        value={customModelId}
                        onChange={(e) => setCustomModelId(e.target.value)}
                        onKeyDown={(e) => {
                          const composing = e.nativeEvent.isComposing || e.keyCode === 229;
                          if (e.key === 'Enter' && !composing && customModelId.trim()) {
                            e.preventDefault();
                            void switchModelId(customModelId);
                          }
                        }}
                        placeholder="输入自定义 Model ID…"
                        aria-label="输入自定义 Model ID"
                        maxLength={120}
                      />
                      <button
                        type="button"
                        className={styles.modelMiniBtn}
                        disabled={switchingModel || !customModelId.trim()}
                        onClick={() => void switchModelId(customModelId)}
                      >
                        切换
                      </button>
                    </div>

                    {modelsData?.note && (
                      <p className="v2-groupNote" style={{ fontSize: 11 }}>
                        {modelsData.note}
                      </p>
                    )}
                    {modelError && (
                      <p style={{ margin: 0, fontSize: 11.5, color: 'var(--st-fail)' }}>{modelError}</p>
                    )}

                    <div className={styles.modelPopFoot}>
                      <span>{activeCfg.enabled ? '模型已就绪' : '当前已停用'}</span>
                      <Link to="/settings/ai" className={styles.botLink} onClick={() => setModelPopOpen(false)}>
                        修改地址/密钥 →
                      </Link>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {submitting && turns.some((t) => t.kind === 'assist' && t.loading) ? (
            <button
              type="button"
              className={styles.sendBtn}
              onClick={stopAssistGeneration}
              aria-label="停止生成"
              title="停止生成"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                <rect x="1.5" y="1.5" width="9" height="9" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className={styles.sendBtn}
              onClick={() => void handleSend()}
              disabled={submitting || !input.trim()}
              aria-label={`发送（${MODE_LABEL[mode]}）`}
              title="发送"
            >
              {submitting ? (
                <Spinner size={15} hideLabel />
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <V2Shell
      leftTitle="对话"
      leftCount={asks.length}
      mobileLeftLabel="历史问答 / 最近念头"
      mobileTopRight={
        <button
          type="button"
          className={styles.mobileNewChatBtn}
          onClick={startNewChat}
          data-testid="home-mobile-new-chat"
        >
          + 新对话
        </button>
      }
      left={
        <>
          <div className={styles.sideTop}>
            <button
              type="button"
              className={styles.newChatBtn}
              onClick={startNewChat}
              data-close-drawer="true"
            >
              <span>+ 开启新对话</span>
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>首页</span>
            </button>
          </div>

          <h3 className={styles.sideSectionTitle}>历史问答</h3>
          {loadingHistory && (
            <p className="v2-state">
              <Spinner />
            </p>
          )}
          {asks.length === 0 && <p className="v2-groupNote" style={{ padding: '4px 14px 8px' }}>还没有向记录提过问。</p>}
          {asks.map((q, i) => (
            <button
              key={q.id}
              type="button"
              className="v2-leftItem v2-leftBtn"
              aria-current={activeAskId === q.id ? 'page' : undefined}
              style={{ '--i': Math.min(i, 10) } as React.CSSProperties}
              onClick={() => void openHistoryAsk(q)}
            >
              <span className="v2-leftTitle">{q.question}</span>
              <span className="v2-leftMeta">
                {dayLabel(q.createdAt, timezone, todayDateKey(timezone))} · {ASK_STATUS_PILL[q.status]?.label ?? q.status}
              </span>
            </button>
          ))}

          <h3 className={styles.sideSectionTitle}>最近念头</h3>
          {captures.slice(0, 6).map((c, i) => (
            <Link
              key={c.id}
              to={'/capture/' + c.id}
              className="v2-leftItem"
              style={{ '--i': Math.min(i, 6) } as React.CSSProperties}
            >
              <span className="v2-leftTitle">{c.rawText}</span>
              <span className="v2-leftMeta">{dayLabel(c.createdAt, timezone, todayDateKey(timezone))}</span>
            </Link>
          ))}
          <Link to="/search" className="v2-leftMore">
            打开全部念头工作台（{captures.length}） →
          </Link>
        </>
      }
      statusLeft={`对话工作台 · ${captures.length} 念头 · ${topicsTotal} 主题 · ${experiencesTotal} 经验`}
      statusRight={<span>当前模式：{MODE_LABEL[mode]}</span>}
    >
      <div className={styles.stage} data-fixed-stage="true">
        {turns.length === 0 ? (
          <div className={styles.welcomeWrap}>
            <h1 className={styles.welcomeTitle}>今天想问点什么，或记点什么？</h1>
            <div className={styles.composerOuter}>{composerNode}</div>
          </div>
        ) : (
          <>
            <div className={styles.thread} aria-live="polite">
              {turns.map((turn) => (
                <div key={turn.id} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {/* 用户消息气泡 */}
                  <div className={styles.msgUserRow}>
                    <span className={styles.msgModeTag}>
                      {MODE_LABEL[turn.kind]} · {dayTimeLabel(turn.createdAt, timezone)}
                    </span>
                    <div className={styles.msgUserBubble}>{turn.userText}</div>
                  </div>

                  {/* 拾念助手回复气泡 */}
                  <div className={styles.msgBotRow}>
                    <div className={styles.botAvatar} aria-hidden="true">
                      拾
                    </div>
                    <div className={styles.botBody}>
                      {turn.kind === 'assist' ? (
                        <div className={styles.botCard}>
                          {turn.loading && !turn.reply && (
                            <div className={styles.botCardHead}>
                              <p className={styles.botLead}>
                                <Spinner label={`正在请 ${turn.modelId ?? activeCfg?.modelId ?? '大模型'} 思考回答…`} />
                              </p>
                              <button
                                type="button"
                                className={styles.ghostActionBtn}
                                onClick={stopAssistGeneration}
                              >
                                停止
                              </button>
                            </div>
                          )}

                          {!turn.loading && turn.error && !turn.reply && (
                            <>
                              <p className={styles.botLead} style={{ color: 'var(--st-fail)' }}>
                                {turn.error}
                              </p>
                              <div className="v2-captureActions">
                                <Button
                                  variant="primary"
                                  disabled={submitting}
                                  onClick={() => void retryAssistTurn(turn)}
                                >
                                  重试
                                </Button>
                                <Button
                                  disabled={submitting}
                                  onClick={() => restoreToInput(turn.userText, 'assist')}
                                >
                                  放回输入框修改
                                </Button>
                                {!turn.savedCapture ? (
                                  <Button
                                    onClick={() => void saveAssistDraft(turn, turn.userText)}
                                    disabled={turn.savingDraft}
                                  >
                                    {turn.savingDraft ? '保存中…' : '先按原文直接存为念头'}
                                  </Button>
                                ) : (
                                  <Link to={'/capture/' + turn.savedCapture.id} className={styles.botLink}>
                                    已按原文存好，查看念头详情 →
                                  </Link>
                                )}
                                {(turn.errorCode === 'ai_not_configured' || turn.errorCode === 'ai_disabled') && (
                                  <Link to="/settings/ai" className={styles.botLink}>
                                    前往「AI 模型设置」 →
                                  </Link>
                                )}
                              </div>
                            </>
                          )}

                          {turn.reply && (
                            <>
                              {(turn.modelId || turn.durationMs !== null) && (
                                <div className={styles.assistMeta}>
                                  {turn.modelId && <span>{turn.modelId}</span>}
                                  {turn.durationMs !== null && <span>· {(turn.durationMs / 1000).toFixed(1)}s</span>}
                                  {turn.tokens !== null && turn.tokens > 0 && <span>· {turn.tokens} tok</span>}
                                </div>
                              )}
                              <RichReplyText text={turn.reply} />

                              {turn.loading && (
                                <div className={styles.replyActionRow}>
                                  <Spinner size={12} label="继续输出中…" />
                                  <button
                                    type="button"
                                    className={styles.ghostActionBtn}
                                    onClick={stopAssistGeneration}
                                  >
                                    停止生成
                                  </button>
                                </div>
                              )}

                              {!turn.loading && (turn.cancelled || turn.interrupted) && (
                                <p className="v2-groupNote" style={{ color: 'var(--st-partial)', margin: '4px 0' }} role="status">
                                  {turn.cancelled
                                    ? '已取消生成，以上为已输出的部分内容；你可以重试、放回输入框修改，或按需编辑存为念头。'
                                    : `流式回复在完成前中断${turn.error ? `（${turn.error}）` : ''}；已保留已输出内容与原文，可重试或手动保存。`}
                                </p>
                              )}

                              {!turn.loading && !turn.draftExpanded && (
                                <div className={styles.replyActionRow}>
                                  {turn.savedCapture ? (
                                    <>
                                      <Pill kind="done">
                                        已存为念头
                                        {turn.savedAttemptsCount > 0 ? `（含 ${turn.savedAttemptsCount} 条尝试）` : ''}
                                      </Pill>
                                      <Link to={'/capture/' + turn.savedCapture.id} className={styles.botLink}>
                                        打开念头详情 →
                                      </Link>
                                    </>
                                  ) : turn.hasDraft && turn.draftText.trim() ? (
                                    <>
                                      <button
                                        type="button"
                                        className={styles.primaryTinyBtn}
                                        disabled={turn.savingDraft}
                                        onClick={() => void saveAssistDraft(turn)}
                                      >
                                        {turn.savingDraft
                                          ? '保存中…'
                                          : `一键存为念头${
                                              turn.draftAttempts.filter((a) => a.checked).length > 0
                                                ? `（含 ${turn.draftAttempts.filter((a) => a.checked).length} 条尝试）`
                                                : ''
                                            }`}
                                      </button>
                                      <button
                                        type="button"
                                        className={styles.ghostActionBtn}
                                        disabled={turn.savingDraft}
                                        onClick={() =>
                                          setTurns((prev) =>
                                            prev.map((t) =>
                                              t.id === turn.id && t.kind === 'assist'
                                                ? { ...t, draftExpanded: true }
                                                : t
                                            )
                                          )
                                        }
                                      >
                                        预览并微调
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      type="button"
                                      className={styles.primaryTinyBtn}
                                      onClick={() => openManualDraft(turn)}
                                    >
                                      存为念头 / 尝试
                                    </button>
                                  )}

                                  <button
                                    type="button"
                                    className={styles.ghostActionBtn}
                                    onClick={() => void copyReplyText(turn.id, turn.reply!)}
                                  >
                                    {turn.copied ? '已复制 ✓' : '复制回答'}
                                  </button>

                                  {!turn.savedCapture && (
                                    <button
                                      type="button"
                                      className={styles.ghostActionBtn}
                                      disabled={submitting}
                                      onClick={() => void retryAssistTurn(turn)}
                                    >
                                      {turn.modelId && activeCfg?.modelId && turn.modelId !== activeCfg.modelId
                                        ? `改用 ${activeCfg.modelId} 重答`
                                        : '重答'}
                                    </button>
                                  )}

                                  {!turn.savedCapture && (turn.cancelled || turn.interrupted) && (
                                    <button
                                      type="button"
                                      className={styles.ghostActionBtn}
                                      disabled={submitting}
                                      onClick={() => restoreToInput(turn.userText, 'assist')}
                                    >
                                      放回输入框修改
                                    </button>
                                  )}
                                </div>
                              )}

                              {!turn.loading && !turn.draftExpanded && turn.error && !turn.interrupted && (
                                <span style={{ fontSize: 12, color: 'var(--st-fail)' }}>{turn.error}</span>
                              )}

                              {!turn.loading && turn.draftExpanded && (
                                <div className={styles.draftBox}>
                                  <div className={styles.botCardHead}>
                                    <span className="v2-fieldLabel" style={{ margin: 0 }}>
                                      整理为念头与尝试（可微调后再存）
                                    </span>
                                    {turn.savedCapture ? (
                                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                                        <Pill kind="done">
                                          已存{turn.savedAttemptsCount > 0 ? `（含 ${turn.savedAttemptsCount} 条尝试）` : ''}
                                        </Pill>
                                        <Link to={'/capture/' + turn.savedCapture.id} className={styles.botLink}>
                                          打开念头详情 →
                                        </Link>
                                      </div>
                                    ) : (
                                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                        <button
                                          type="button"
                                          className={styles.ghostActionBtn}
                                          onClick={() => void copyReplyText(turn.id, turn.reply!)}
                                        >
                                          {turn.copied ? '已复制 ✓' : '复制回答'}
                                        </button>
                                        <button
                                          type="button"
                                          className={styles.ghostActionBtn}
                                          onClick={() =>
                                            setTurns((prev) =>
                                              prev.map((t) =>
                                                t.id === turn.id && t.kind === 'assist'
                                                  ? { ...t, draftExpanded: false }
                                                  : t
                                              )
                                            )
                                          }
                                        >
                                          收起
                                        </button>
                                      </div>
                                    )}
                                  </div>

                                  <div>
                                    <label className={styles.draftFieldLabel}>念头正文（可按需微调后再存）</label>
                                    <textarea
                                      className={styles.draftTextarea}
                                      value={turn.draftText}
                                      disabled={Boolean(turn.savedCapture) || turn.savingDraft}
                                      maxLength={4000}
                                      aria-label="草案念头正文"
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        setTurns((prev) =>
                                          prev.map((t) =>
                                            t.id === turn.id && t.kind === 'assist'
                                              ? { ...t, draftText: val, draftDirty: true }
                                              : t
                                          )
                                        );
                                      }}
                                    />
                                  </div>

                                  {turn.draftAttempts.length > 0 && (
                                    <div className={styles.draftAttemptList}>
                                      <span className={styles.draftFieldLabel}>
                                        建议的尝试步骤（可直接编辑，保存为「待尝试」，结果留待你亲自执行后填写）
                                      </span>
                                      {turn.draftAttempts.map((att, idx) => (
                                        <div key={att.opId} className={styles.draftAttemptItem}>
                                          <input
                                            type="checkbox"
                                            checked={att.checked}
                                            disabled={Boolean(turn.savedCapture) || turn.savingDraft}
                                            aria-label={`勾选第 ${idx + 1} 条建议尝试`}
                                            onChange={() =>
                                              setTurns((prev) =>
                                                prev.map((t) => {
                                                  if (t.id !== turn.id || t.kind !== 'assist') return t;
                                                  return {
                                                    ...t,
                                                    draftDirty: true,
                                                    draftAttempts: t.draftAttempts.map((item, k) =>
                                                      k === idx ? { ...item, checked: !item.checked } : item
                                                    ),
                                                  };
                                                })
                                              )
                                            }
                                          />
                                          <div className={styles.draftAttemptMain} style={{ flex: 1 }}>
                                            <input
                                              type="text"
                                              className={styles.inlineInput}
                                              style={{ width: '100%' }}
                                              value={att.step}
                                              maxLength={500}
                                              disabled={Boolean(turn.savedCapture) || turn.savingDraft}
                                              aria-label={`编辑第 ${idx + 1} 条建议尝试`}
                                              onChange={(e) => {
                                                const val = e.target.value;
                                                setTurns((prev) =>
                                                  prev.map((t) => {
                                                    if (t.id !== turn.id || t.kind !== 'assist') return t;
                                                    return {
                                                      ...t,
                                                      draftDirty: true,
                                                      draftAttempts: t.draftAttempts.map((item, k) =>
                                                        k === idx ? { ...item, step: val } : item
                                                      ),
                                                    };
                                                  })
                                                );
                                              }}
                                            />
                                            <span className="v2-hint">待尝试 · 结果需亲自实测后填写</span>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                  {!turn.savedCapture && (
                                    <>
                                      <div className={styles.inlineStepRow}>
                                        <input
                                          className={styles.inlineInput}
                                          value={turn.newAttemptText}
                                          disabled={turn.savingDraft}
                                          onChange={(e) => {
                                            const val = e.target.value;
                                            setTurns((prev) =>
                                              prev.map((t) =>
                                                t.id === turn.id && t.kind === 'assist'
                                                  ? { ...t, newAttemptText: val }
                                                  : t
                                              )
                                            );
                                          }}
                                          onKeyDown={(e) => {
                                            const composing = e.nativeEvent.isComposing || e.keyCode === 229;
                                            if (e.key === 'Enter' && !composing) {
                                              e.preventDefault();
                                              appendDraftAttempt(turn.id);
                                            }
                                          }}
                                          placeholder="可补充一条想顺手去试的步骤（回车添加）…"
                                          aria-label="补充尝试步骤"
                                          maxLength={500}
                                        />
                                        <Button
                                          disabled={turn.savingDraft || !turn.newAttemptText.trim()}
                                          onClick={() => appendDraftAttempt(turn.id)}
                                        >
                                          添一步
                                        </Button>
                                      </div>

                                      <div className="v2-captureActions">
                                        <Button
                                          variant="primary"
                                          disabled={turn.savingDraft || !turn.draftText.trim()}
                                          onClick={() => void saveAssistDraft(turn)}
                                        >
                                          {turn.savingDraft
                                            ? '保存中…'
                                            : `一键保存到记录库${
                                                turn.draftAttempts.filter((a) => a.checked).length > 0
                                                  ? `（含 ${turn.draftAttempts.filter((a) => a.checked).length} 条尝试）`
                                                  : ''
                                              }`}
                                        </Button>
                                      </div>
                                    </>
                                  )}

                                  {turn.error && (
                                    <span style={{ fontSize: 12, color: 'var(--st-fail)' }}>{turn.error}</span>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      ) : turn.kind === 'capture' ? (
                        <div className={styles.botCard}>
                          {turn.error ? (
                            <>
                              <p className={styles.botLead} style={{ color: 'var(--st-fail)' }}>
                                {turn.error}
                              </p>
                              <div className="v2-captureActions">
                                <Button
                                  variant="primary"
                                  disabled={turn.retrying}
                                  onClick={() => void retryCaptureTurn(turn)}
                                >
                                  {turn.retrying ? '重试中…' : '重试保存'}
                                </Button>
                                <Button onClick={() => restoreToInput(turn.userText, 'capture')}>
                                  放回输入框修改
                                </Button>
                              </div>
                            </>
                          ) : !turn.capture ? (
                            <p className={styles.botLead}>
                              <Spinner label="正在保存念头…" />
                            </p>
                          ) : (
                            <>
                              <div className={styles.botCardHead}>
                                <span className={styles.botLead}>
                                  已将这条念头保存到本地记录库。可以直接在下面追加一步打算去试的动作：
                                </span>
                                <Link to={'/capture/' + turn.capture.id} className={styles.botLink}>
                                  打开念头详情 →
                                </Link>
                              </div>

                              {turn.addedAttempts.length > 0 && (
                                <div className={styles.addedAttemptList}>
                                  {turn.addedAttempts.map((a) => (
                                    <Link
                                      key={a.id}
                                      to={'/attempt/' + a.id}
                                      className={styles.addedAttemptItem}
                                    >
                                      <span>试一步：{a.step}</span>
                                      <Pill kind="idle">未开始</Pill>
                                    </Link>
                                  ))}
                                </div>
                              )}

                              <div className={styles.inlineAttemptRow}>
                                <input
                                  className={styles.inlineInput}
                                  value={turn.attemptDraft}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setTurns((prev) =>
                                      prev.map((t) =>
                                        t.id === turn.id && t.kind === 'capture'
                                          ? { ...t, attemptDraft: val }
                                          : t
                                      )
                                    );
                                  }}
                                  onKeyDown={(e) => {
                                    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
                                    if (e.key === 'Enter' && !composing) void addInlineAttempt(turn);
                                  }}
                                  placeholder="例如：先做一次 10 分钟对照小测试…"
                                  aria-label="追加下一步尝试"
                                  maxLength={500}
                                />
                                <Button
                                  onClick={() => void addInlineAttempt(turn)}
                                  disabled={turn.attemptSaving || !turn.attemptDraft.trim()}
                                >
                                  {turn.attemptSaving ? '保存中…' : '添一步'}
                                </Button>
                              </div>
                              {turn.attemptError && (
                                <span style={{ fontSize: 12, color: 'var(--st-fail)' }}>{turn.attemptError}</span>
                              )}
                            </>
                          )}
                        </div>
                      ) : (
                        <div className={styles.botCard}>
                          {turn.searching && (
                            <p className={styles.botLead}>
                              <Spinner label="正在检索本机相关念头与尝试记录…" />
                            </p>
                          )}

                          {turn.error && (
                            <p className={styles.botLead} style={{ color: 'var(--st-fail)' }}>
                              {turn.error}
                            </p>
                          )}

                          {!turn.searching && turn.search && !turn.query && (
                            <>
                              <div className={styles.botCardHead}>
                                <span className={styles.botLead}>
                                  匹配到 {turn.search.candidates.length} 条本机记录；请确认作为回答依据的记录（已选{' '}
                                  {turn.selectedKeys.length}/{MAX_PICK} 条）：
                                </span>
                                <Link to={'/ask?q=' + encodeURIComponent(turn.userText)} className={styles.botLink}>
                                  前往完整问答页 →
                                </Link>
                              </div>

                              {turn.search.candidates.length > 0 && (
                                <div className={styles.pickList}>
                                  {turn.search.candidates.slice(0, 20).map((c: AskCandidate) => (
                                    <label key={c.sourceKey} className={styles.pickItem}>
                                      <input
                                        type="checkbox"
                                        checked={turn.selectedKeys.includes(c.sourceKey)}
                                        onChange={() => toggleAskCandidate(turn.id, c.sourceKey)}
                                      />
                                      <span className={styles.pickText}>
                                        <span className={styles.pickTitle}>{c.title}</span>
                                        <span className={styles.pickSub}>
                                          {c.type === 'attempt' ? '尝试' : '念头'} · {c.snippet}
                                        </span>
                                      </span>
                                    </label>
                                  ))}
                                </div>
                              )}

                              {turn.notice && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  <p className="v2-groupNote" style={{ color: 'var(--st-partial)' }}>
                                    {turn.notice}
                                  </p>
                                  {turn.preview && (!turn.preview.ai.configured || !turn.preview.ai.enabled) && (
                                    <div>
                                      <Link to="/settings/ai" className={styles.botLink}>
                                        前往「AI 模型设置」配置或启用 →
                                      </Link>
                                    </div>
                                  )}
                                </div>
                              )}

                              {turn.search.candidates.length > 0 ? (
                                <div className="v2-captureActions">
                                  <Button
                                    variant="primary"
                                    disabled={
                                      turn.selectedKeys.length === 0 || turn.previewLoading || turn.creating
                                    }
                                    onClick={() => void previewAndAsk(turn)}
                                  >
                                    {turn.previewLoading || turn.creating
                                      ? '发送中…'
                                      : `确认依据并发送给 AI（${turn.selectedKeys.length} 条）`}
                                  </Button>
                                  <Button
                                    disabled={submitting}
                                    onClick={() => switchToAssistAndAsk(turn.userText)}
                                  >
                                    不限本机记录，直接问 AI →
                                  </Button>
                                </div>
                              ) : (
                                <div className="v2-captureActions">
                                  <Button
                                    variant="primary"
                                    disabled={submitting}
                                    onClick={() => switchToAssistAndAsk(turn.userText)}
                                  >
                                    {`改由 AI 大模型直接解答（${activeCfg?.modelId ?? '默认模型'}） →`}
                                  </Button>
                                </div>
                              )}
                            </>
                          )}

                          {turn.query && (
                            <>
                              <div className={styles.botCardHead}>
                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                  <Pill kind={ASK_STATUS_PILL[turn.query.status]?.kind ?? 'idle'}>
                                    {ASK_STATUS_PILL[turn.query.status]?.label ?? turn.query.status}
                                  </Pill>
                                  <span className="v2-hint">
                                    依据 {turn.query.sources?.length ?? 0} 条
                                    {turn.query.durationMs ? ` · 用时 ${(turn.query.durationMs / 1000).toFixed(1)}s` : ''}
                                  </span>
                                </div>
                                <Link to={'/ask/' + turn.query.id} className={styles.botLink}>
                                  打开问答详情 →
                                </Link>
                              </div>

                              {turn.query.status === 'pending' && (
                                <div className="v2-captureActions">
                                  <Spinner label="模型正在阅读你选中的记录…" />
                                  {turn.query.canCancel && (
                                    <Button onClick={() => void cancelTurnQuery(turn.id, turn.query!.id)}>
                                      取消生成
                                    </Button>
                                  )}
                                </div>
                              )}

                              {turn.query.status === 'failed' && (
                                <p className={styles.botLead} style={{ color: 'var(--st-fail)' }}>
                                  生成失败：{turn.query.errorMessage ?? turn.query.errorCode ?? '未知错误'}
                                </p>
                              )}

                              {turn.query.status === 'cancelled' && (
                                <p className="v2-groupNote">这次问答已取消，未保存答案。</p>
                              )}

                              {turn.query.status === 'interrupted' && (
                                <p className="v2-groupNote">生成被中断，可在右侧重新发起提问。</p>
                              )}

                              {turn.query.answer && (
                                <>
                                  <AskAnswerView query={turn.query} />
                                  {turn.query.answer.insufficientEvidence && (
                                    <div className={styles.replyActionRow}>
                                      <button
                                        type="button"
                                        className={styles.ghostActionBtn}
                                        disabled={submitting}
                                        onClick={() => switchToAssistAndAsk(turn.userText)}
                                      >
                                        记录不足，改由 AI 大模型直接解答 →
                                      </button>
                                    </div>
                                  )}
                                </>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={threadEndRef} />
            </div>

            <div className={styles.bottomDock}>{composerNode}</div>
          </>
        )}
      </div>
    </V2Shell>
  );
}
