// 拾念 SHINIAN v0.1 - 念头详情：编辑/归档/删除 + 尝试列表 + 手动或 AI 开始一步
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api, { ApiError } from '../api';
import type {
  AiGeneration,
  AiSettings,
  Attempt,
  AttemptState,
  Capture,
  CaptureLinkCandidate,
  CaptureLinkItem,
  CaptureLinksResponse,
  CaptureReferencesResponse,
  DeletePreview,
  ExperienceCandidate,
  ExperiencePreview,
  ExperiencePreviewSource,
  GenerationSource,
  NextAction,
} from '../types';
import {
  aiErrorText,
  formatTime,
  newOperationId,
  OUTCOME_LABEL,
  STATE_LABEL,
} from '../types';
import ResearchStarter from '../components/ResearchStarter';
import TopicMembership from '../components/TopicMembership';
import { readTopicNav, topicAwareHref } from '../components/topicNav';

type AiAction = 'cancel' | 'dismiss' | 'accept';
type ExperienceMode = 'select' | 'preview' | 'result';
type GenerationOrigin = 'ai' | 'experience';

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    return e.body?.message || aiErrorText(e.body?.error, fallback);
  }
  return fallback;
}

export default function CaptureDetailPage() {
  const { captureId = '' } = useParams<{ captureId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const topicNav = readTopicNav(searchParams);

  const [capture, setCapture] = useState<Capture | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [nextActions, setNextActions] = useState<NextAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 致命加载失败（念头不存在 / 服务不可用）：单独保存，用于渲染可重试的错误页
  const [loadFailure, setLoadFailure] = useState<{ status: number; message: string } | null>(null);
  const captureIdRef = useRef(captureId);

  // 关联记录（有方向的手动链接 + 反链）与尝试引用汇总
  const [links, setLinks] = useState<CaptureLinksResponse | null>(null);
  const [references, setReferences] = useState<CaptureReferencesResponse | null>(null);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [linkComposerOpen, setLinkComposerOpen] = useState(false);
  const [linkQuery, setLinkQuery] = useState('');
  const [linkCandidates, setLinkCandidates] = useState<CaptureLinkCandidate[]>([]);
  const [linkCandidatesLoading, setLinkCandidatesLoading] = useState(false);
  const [linkCandidatesError, setLinkCandidatesError] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState<CaptureLinkCandidate | null>(null);
  const [linkNote, setLinkNote] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [removingLinkId, setRemovingLinkId] = useState<string | null>(null);
  const linkOperationIdRef = useRef(newOperationId());

  // 编辑念头
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [conflict, setConflict] = useState<{ currentRawText: string; currentRevision: number } | null>(null);
  const [saving, setSaving] = useState(false);

  // 归档 / 恢复
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null);

  // 删除
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 手动新尝试
  const [manualOpen, setManualOpen] = useState(false);
  const [step, setStep] = useState('');
  const [attemptState, setAttemptState] = useState<AttemptState>('todo');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [stepTouched, setStepTouched] = useState(false);
  const [createdAttempt, setCreatedAttempt] = useState<{ id: string; step: string } | null>(null);
  const operationIdRef = useRef(newOperationId());
  const attemptInputRef = useRef<HTMLInputElement>(null);

  // AI 设置与生成
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiSettingsLoading, setAiSettingsLoading] = useState(true);
  const [aiSettingsError, setAiSettingsError] = useState<string | null>(null);
  const [aiRestoring, setAiRestoring] = useState(true);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiConfirm, setAiConfirm] = useState(false);
  const [aiConstraint, setAiConstraint] = useState('');
  const [generation, setGeneration] = useState<AiGeneration | null>(null);
  const [aiSubmitting, setAiSubmitting] = useState(false);
  const aiSubmittingRef = useRef(false);
  const aiOperationIdRef = useRef(newOperationId());
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<AiAction | null>(null);
  const actionBusyRef = useRef(false);
  const [retryConfirm, setRetryConfirm] = useState(false);
  const [editStepOpen, setEditStepOpen] = useState(false);
  const [editedStep, setEditedStep] = useState('');
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [clarifyAnswer, setClarifyAnswer] = useState('');
  const [generationOrigin, setGenerationOrigin] = useState<GenerationOrigin>('ai');

  // 研究一下
  const [researchOpen, setResearchOpen] = useState(false);

  // 参考旧经验
  const [experienceOpen, setExperienceOpen] = useState(false);
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>('select');
  const [experienceCandidates, setExperienceCandidates] = useState<ExperienceCandidate[]>([]);
  const [experienceQuery, setExperienceQuery] = useState('');
  const [experienceSuggestedQuery, setExperienceSuggestedQuery] = useState('');
  const [experienceTotal, setExperienceTotal] = useState(0);
  const [experienceLimit, setExperienceLimit] = useState(12);
  const [experienceLoading, setExperienceLoading] = useState(false);
  const [experienceError, setExperienceError] = useState<string | null>(null);
  const [experienceSearched, setExperienceSearched] = useState(false);
  const [selectedExperiences, setSelectedExperiences] = useState<ExperienceCandidate[]>([]);
  const [experienceConstraint, setExperienceConstraint] = useState('');
  const [experiencePreview, setExperiencePreview] = useState<ExperiencePreview | null>(null);
  const [experienceContextToken, setExperienceContextToken] = useState<string | null>(null);
  const [experiencePreviewLoading, setExperiencePreviewLoading] = useState(false);
  const [experiencePreviewError, setExperiencePreviewError] = useState<string | null>(null);
  const [experiencePreviewStale, setExperiencePreviewStale] = useState(false);
  const [experienceNotice, setExperienceNotice] = useState<string | null>(null);
  const experienceOperationIdRef = useRef(newOperationId());
  const experienceSearchRef = useRef<HTMLInputElement>(null);
  const experienceQueryHandledRef = useRef<string | null>(null);

  const aiConfig = aiSettings?.config ?? null;
  const aiReady = Boolean(aiSettings?.configured && aiConfig?.enabled && aiConfig?.hasApiKey);
  const maxConstraint = aiSettings?.limits.maxConstraintChars ?? 200;
  const maxCapture = aiSettings?.limits.maxCaptureChars ?? 4000;
  const maxStep = 500;
  const expired = Boolean(
    generation &&
      generation.status === 'succeeded' &&
      (generation.isExpired ||
        (capture !== null && capture.revision !== generation.captureRevision))
  );
  const generationSources = generation?.sources ?? [];
  const sourcesIssue = Boolean(
    generation &&
      (generation.contextInvalidated ||
        generation.sourcesChanged ||
        generationSources.some((source) => source.deleted || source.changed))
  );

  useEffect(() => {
    captureIdRef.current = captureId;
    resetAiState();
    load();
    loadAiSettings();
    loadLatest();
  }, [captureId]);

  // 从研究页「修改问题，重新研究」打开：直接展开研究入口
  useEffect(() => {
    if (!capture) return;
    if (searchParams.get('research') === '1') openResearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture?.id]);

  // 生成中每 1 秒轮询；状态变化后自动停止
  useEffect(() => {
    if (!generation || generation.status !== 'pending') return;
    const generationId = generation.id;
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const res = await api.getGeneration(generationId);
        if (active) setGeneration(res.generation);
      } catch (e) {
        if (active && e instanceof ApiError && e.status === 404) {
          setGeneration(null);
          setAiError('这次生成记录已不存在，请重新生成。');
        }
        // 其他网络错误保持轮询，页面刷新后可恢复
      }
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [generation?.id, generation?.status]);

  // 从阶段回顾带入一条旧经验：自动打开现有预览流程，但用户仍要确认才会生成。
  useEffect(() => {
    const attemptId = searchParams.get('experience');
    if (!capture || !attemptId) return;
    const guard = `${capture.id}:${attemptId}`;
    if (experienceQueryHandledRef.current === guard) return;
    experienceQueryHandledRef.current = guard;
    void bootstrapExperienceFromQuery(attemptId);
  }, [capture?.id, capture?.revision, searchParams]);

  function resetAiState() {
    setAiSettings(null);
    setAiSettingsError(null);
    setAiSettingsLoading(true);
    setAiRestoring(true);
    setAiOpen(false);
    setAiConfirm(false);
    setAiConstraint('');
    setGeneration(null);
    setAiError(null);
    setAiNotice(null);
    setActionBusy(null);
    setRetryConfirm(false);
    setEditStepOpen(false);
    setEditedStep('');
    setAdoptError(null);
    setClarifyAnswer('');
    setGenerationOrigin('ai');
    setExperienceOpen(false);
    setExperienceMode('select');
    setExperienceCandidates([]);
    setExperienceQuery('');
    setExperienceSuggestedQuery('');
    setExperienceTotal(0);
    setExperienceLimit(12);
    setExperienceLoading(false);
    setExperienceError(null);
    setExperienceSearched(false);
    setSelectedExperiences([]);
    setExperienceConstraint('');
    setExperiencePreview(null);
    setExperienceContextToken(null);
    setExperiencePreviewLoading(false);
    setExperiencePreviewError(null);
    setExperiencePreviewStale(false);
    setExperienceNotice(null);
    experienceOperationIdRef.current = newOperationId();
    aiSubmittingRef.current = false;
    actionBusyRef.current = false;
    aiOperationIdRef.current = newOperationId();
  }

  async function load() {
    if (!captureId) return;
    setLoading(true);
    setError(null);
    setLoadFailure(null);
    setCreatedAttempt(null);
    setLinks(null);
    setReferences(null);
    setLinksError(null);
    setLinkComposerOpen(false);
    setLinkTarget(null);
    setLinkCandidates([]);
    setLinkError(null);
    setLinkNotice(null);
    setArchiveNotice(null);
    linkOperationIdRef.current = newOperationId();
    try {
      const capRes = await api.getCapture(captureId);
      if (captureIdRef.current !== captureId) return;
      if (capRes.capture.kind === 'experience') {
        navigate(`/experience/${captureId}`, { replace: true });
        return;
      }
      setCapture(capRes.capture);
      setDraft(capRes.capture.rawText);
      const attRes = await api.listAttempts(captureId);
      if (captureIdRef.current !== captureId) return;
      setAttempts(attRes.attempts ?? []);
      void loadLinks(captureId);
      try {
        const nextRes = await api.listCaptureNextActions(captureId);
        if (captureIdRef.current === captureId) setNextActions(nextRes.actions ?? []);
      } catch {
        // 旧服务端没有下一步接口时，保留原有尝试列表
        if (captureIdRef.current === captureId) setNextActions([]);
      }
    } catch (e: any) {
      if (captureIdRef.current !== captureId) return;
      const status = e instanceof ApiError ? e.status ?? 0 : 0;
      const message =
        status === 404
          ? '这条念头不存在，可能已被删除。'
          : status >= 400
            ? e.body?.message || '无法读取这条念头，请稍后重试。'
            : '无法连接到本地服务，请确认服务正在运行后重试。';
      setLoadFailure({ status, message });
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function loadLinks(targetId = captureId) {
    setLinksLoading(true);
    setLinksError(null);
    try {
      const [linkRes, refRes] = await Promise.all([
        api.listCaptureLinks(targetId),
        api.listCaptureReferences(targetId),
      ]);
      if (captureIdRef.current !== targetId) return;
      setLinks(linkRes);
      setReferences(refRes);
    } catch (e: unknown) {
      if (captureIdRef.current === targetId) {
        // 加载失败不冒充空数据：清空列表并给出原因与重试入口
        setLinks(null);
        setReferences(null);
        setLinksError(errorMessage(e, '关联记录加载失败'));
      }
    } finally {
      if (captureIdRef.current === targetId) setLinksLoading(false);
    }
  }

  async function searchLinkCandidates(term = linkQuery) {
    setLinkCandidatesLoading(true);
    setLinkCandidatesError(null);
    try {
      const res = await api.searchCaptureLinkCandidates(captureId, term, 12);
      if (captureIdRef.current !== captureId) return;
      setLinkCandidates(res.captures ?? []);
    } catch (e: unknown) {
      setLinkCandidatesError(errorMessage(e, '搜索失败'));
    } finally {
      setLinkCandidatesLoading(false);
    }
  }

  function openLinkComposer() {
    setLinkComposerOpen(true);
    setLinkError(null);
    setLinkNotice(null);
    setLinkTarget(null);
    setLinkNote('');
    setLinkQuery('');
    linkOperationIdRef.current = newOperationId();
    if (linkCandidates.length === 0) void searchLinkCandidates('');
  }

  function closeLinkComposer() {
    setLinkComposerOpen(false);
    setLinkTarget(null);
    setLinkNote('');
    setLinkQuery('');
    setLinkCandidates([]);
    setLinkCandidatesError(null);
    setLinkError(null);
  }

  async function submitLink() {
    if (!linkTarget || linkBusy) return;
    setLinkBusy(true);
    setLinkError(null);
    setLinkNotice(null);
    try {
      await api.createCaptureLink(captureId, {
        toCaptureId: linkTarget.id,
        note: linkNote.trim() || null,
        operationId: linkOperationIdRef.current,
      });
      setLinkNotice(
        `已建立关联：这条念头关联到「${linkTarget.summary}」。对方详情会同步出现反链。`
      );
      linkOperationIdRef.current = newOperationId();
      setLinkTarget(null);
      setLinkNote('');
      await loadLinks(captureId);
      await searchLinkCandidates(linkQuery);
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 409 && e.body?.error === 'duplicate_link') {
        setLinkError('这条关联已经存在，不需要重复保存。');
        await searchLinkCandidates(linkQuery);
      } else if (e instanceof ApiError) {
        setLinkError(
          e.body?.error === 'self_link_not_allowed'
            ? '不能把一条念头关联到它自己。'
            : e.body?.error === 'note_too_long'
              ? '关联说明最多 200 字。'
              : e.body?.message || e.message || '关联失败'
        );
      } else {
        setLinkError('关联失败');
      }
    } finally {
      setLinkBusy(false);
    }
  }

  async function removeLink(link: CaptureLinkItem) {
    if (removingLinkId) return;
    setRemovingLinkId(link.id);
    setLinkError(null);
    setLinkNotice(null);
    try {
      await api.deleteCaptureLink(link.id);
      setLinkNotice(
        link.direction === 'out'
          ? `已解除到「${link.capture.summary}」的关联。`
          : `已解除来自「${link.capture.summary}」的关联。`
      );
      await loadLinks(captureId);
    } catch (e: unknown) {
      setLinkError(errorMessage(e, '解除关联失败，请重试。'));
    } finally {
      setRemovingLinkId(null);
    }
  }

  async function loadAiSettings() {
    setAiSettingsLoading(true);
    setAiSettingsError(null);
    try {
      const data = await api.getAiSettings();
      setAiSettings(data);
    } catch (e) {
      setAiSettingsError(errorMessage(e, '无法读取 AI 设置'));
    } finally {
      setAiSettingsLoading(false);
    }
  }

  function sourceToCandidate(source: GenerationSource): ExperienceCandidate {
    return {
      id: source.attemptId,
      captureId: source.captureId ?? '',
      captureText: source.captureText ?? '',
      captureArchived: false,
      captureRevision: 0,
      step: source.step ?? '旧尝试',
      resultText: source.resultText ?? '',
      outcome: source.outcome ?? null,
      observedAt: source.observedAt ?? null,
      sourceUrl: source.sourceUrl ?? null,
      revision: source.attemptRevision ?? 0,
      createdAt: source.observedAt ?? 0,
      updatedAt: source.observedAt ?? 0,
      matchReasons: [],
    };
  }

  function generationHasExperience(generationItem: AiGeneration): boolean {
    return Boolean(
      (generationItem.sources?.length ?? 0) > 0 ||
        generationItem.contextInvalidated ||
        generationItem.contextInvalidReason
    );
  }

  async function loadLatest() {
    if (!captureId) return;
    setAiRestoring(true);
    try {
      const res = await api.getLatestSuggestion(captureId);
      if (captureIdRef.current !== captureId) return;
      if (res.generation) {
        const hasExperience = generationHasExperience(res.generation);
        setGeneration(res.generation);
        setGenerationOrigin(hasExperience ? 'experience' : 'ai');
        setAiConstraint(res.generation.constraint ?? '');
        if (hasExperience) {
          setExperienceConstraint(res.generation.constraint ?? '');
          setSelectedExperiences(
            (res.generation.sources ?? []).filter((source) => !source.deleted).map(sourceToCandidate)
          );
          setExperienceMode('result');
          setExperienceOpen(true);
          setAiOpen(false);
        } else {
          setExperienceOpen(false);
          setAiOpen(true);
        }
        setAiConfirm(false);
      }
    } catch {
      // 没有生成历史或 AI 路由不可用时保持安静，不影响手动流程
    } finally {
      setAiRestoring(false);
    }
  }

  async function saveEdit() {
    if (!capture) return;
    const text = draft.trim();
    if (!text) return;
    // 冲突后点「重试保存（覆盖最新版）」时用服务端返回的最新版本号，
    // 否则会一直拿着旧 revision 反复 409，永远保存不进去。
    const baseRevision = conflict?.currentRevision ?? capture.revision;
    setSaving(true);
    setError(null);
    try {
      const res = await api.updateCapture(capture.id, text, baseRevision);
      setCapture(res.capture);
      setDraft(res.capture.rawText);
      setEditing(false);
      setConflict(null);
      if (generation?.status === 'succeeded' && generation.captureRevision !== res.capture.revision) {
        setAiNotice('念头已修改，已有建议已过期。');
      }
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict({
          currentRawText: e.body?.currentRawText ?? '',
          currentRevision: e.body?.currentRevision ?? baseRevision,
        });
      } else {
        setError(errorMessage(e, '保存失败，请重试'));
      }
    } finally {
      setSaving(false);
    }
  }

  async function toggleArchive() {
    if (!capture || archiveBusy) return;
    const wasArchived = Boolean(capture.archivedAt);
    setArchiveBusy(true);
    setError(null);
    setArchiveNotice(null);
    try {
      const res = wasArchived
        ? await api.restoreCapture(capture.id)
        : await api.archiveCapture(capture.id);
      setCapture(res.capture);
      setArchiveNotice(
        wasArchived
          ? '已恢复这条念头，可以继续记录尝试。'
          : '已归档这条念头；可在首页「已归档」里找回。',
      );
    } catch (e: any) {
      setError(errorMessage(e, wasArchived ? '恢复失败，请重试。' : '归档失败，请重试。'));
    } finally {
      setArchiveBusy(false);
    }
  }

  async function openDeletePreview() {
    if (!capture || previewLoading) return;
    setPreviewLoading(true);
    setDeleteError(null);
    try {
      const p = await api.deletePreview(capture.id);
      setPreview(p);
    } catch (e: any) {
      setDeleteError(errorMessage(e, '无法获取删除影响范围，请重试。'));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function confirmDelete() {
    if (!capture || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteCapture(capture.id);
      navigate('/');
    } catch (e: any) {
      // 错误必须显示在弹窗内：弹窗遮住页头，页头的错误提示用户看不到
      setDeleteError(errorMessage(e, '删除失败，请重试。'));
      setDeleting(false);
    }
  }

  async function createAttempt(e: React.FormEvent) {
    e.preventDefault();
    setStepTouched(true);
    const s = step.trim();
    if (!capture || creating || !s || s.length > maxStep) return;
    setCreating(true);
    setCreateError(null);
    setCreatedAttempt(null);
    try {
      const res = await api.createAttempt(capture.id, {
        step: s,
        state: attemptState,
        operationId: operationIdRef.current,
      });
      operationIdRef.current = newOperationId(); // 成功后换新操作 ID
      setCreatedAttempt({ id: res.attempt.id, step: res.attempt.step });
      setStep('');
      setStepTouched(false);
      setAttemptState('todo');
      const attRes = await api.listAttempts(capture.id);
      setAttempts(attRes.attempts ?? []);
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409 && e.body?.existingId) {
        // 重复点击/重试（服务端回放）：同样给出明确的「打开并记录结果」入口
        setCreatedAttempt({
          id: String(e.body.existingId),
          step: typeof e.body?.step === 'string' ? e.body.step : s,
        });
        const attRes = await api.listAttempts(capture.id);
        setAttempts(attRes.attempts ?? []);
        setStep('');
        setStepTouched(false);
        setCreateError(null);
      } else {
        setCreateError(errorMessage(e, '创建失败，可重试。'));
      }
    } finally {
      setCreating(false);
    }
  }

  function openManual() {
    setManualOpen(true);
    setAiOpen(false);
    setExperienceOpen(false);
    setResearchOpen(false);
    setStepTouched(false);
    setCreateError(null);
    window.setTimeout(() => {
      attemptInputRef.current?.focus();
      attemptInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  }

  function openAi() {
    if (generation?.status === 'pending') {
      if (generationOrigin === 'experience') {
        setExperienceOpen(true);
        setExperienceMode('result');
        setAiOpen(false);
      } else {
        setAiOpen(true);
        setAiConfirm(false);
        setExperienceOpen(false);
      }
      return;
    }
    setAiOpen(true);
    setManualOpen(false);
    setExperienceOpen(false);
    setResearchOpen(false);
    setAiConfirm(!(generation && generationOrigin === 'ai'));
    setAiError(null);
    setAiNotice(null);
    setRetryConfirm(false);
  }

  function openExperience() {
    if (generation?.status === 'pending') {
      if (generationOrigin === 'ai') {
        setAiOpen(true);
        setAiConfirm(false);
        setExperienceOpen(false);
      } else {
        setExperienceOpen(true);
        setExperienceMode('result');
        setAiOpen(false);
      }
      return;
    }
    setExperienceOpen(true);
    setManualOpen(false);
    setAiOpen(false);
    setResearchOpen(false);
    setExperienceNotice(null);
    setExperiencePreviewError(null);
    if (generation && generationOrigin === 'experience') {
      setExperienceMode('result');
    } else {
      setExperienceMode('select');
      setExperiencePreview(null);
      setExperienceContextToken(null);
      setExperiencePreviewStale(false);
      if ((generation?.sources?.length ?? 0) > 0) {
        setSelectedExperiences(
          (generation?.sources ?? []).filter((source) => !source.deleted).map(sourceToCandidate)
        );
        setExperienceConstraint(generation?.constraint ?? '');
      }
      void loadExperienceCandidates('');
    }
  }

  function openResearch() {
    setResearchOpen(true);
    setManualOpen(false);
    setAiOpen(false);
    setExperienceOpen(false);
  }

  /** 阶段回顾跳转：直接带入一条来源并请求服务端预览；不会自动生成。 */
  async function bootstrapExperienceFromQuery(attemptId: string) {
    if (!capture) return;
    setExperienceOpen(true);
    setManualOpen(false);
    setAiOpen(false);
    setResearchOpen(false);
    setExperienceMode('preview');
    setExperiencePreview(null);
    setExperienceContextToken(null);
    setExperiencePreviewError(null);
    setExperiencePreviewStale(false);
    setExperienceNotice('来自阶段回顾：已带入这条旧经验，确认预览后才会生成。');
    setExperiencePreviewLoading(true);
    setSelectedExperiences([]);
    setExperienceConstraint('');
    try {
      const res = await api.previewExperience(capture.id, {
        captureRevision: capture.revision,
        sourceAttemptIds: [attemptId],
      });
      setExperiencePreview(res);
      setExperienceContextToken(res.contextToken);
      setExperienceConstraint(res.constraint ?? '');
      setSelectedExperiences(res.sources.map(experienceSourceToCandidate));
      setExperienceMode('preview');
      experienceOperationIdRef.current = newOperationId();
    } catch (e) {
      setExperienceMode('select');
      setExperiencePreviewError(
        errorMessage(e, '无法带入这条旧经验，请检查 AI 配置或重新选择。')
      );
      void loadExperienceCandidates('');
    } finally {
      setExperiencePreviewLoading(false);
    }
  }

  function closeAi() {
    setAiOpen(false);
    setAiConfirm(false);
    setAiError(null);
    setRetryConfirm(false);
  }

  function closeExperience() {
    setExperienceOpen(false);
    setExperiencePreviewError(null);
    setExperienceNotice(null);
  }

  function startExperienceSelection() {
    setExperienceOpen(true);
    setManualOpen(false);
    setAiOpen(false);
    setExperienceMode('select');
    setExperiencePreview(null);
    setExperienceContextToken(null);
    setExperiencePreviewError(null);
    setExperiencePreviewStale(false);
    setExperienceNotice(null);
    void loadExperienceCandidates('');
  }

  function startConfirmForRegenerate() {
    setAiOpen(true);
    setAiConfirm(true);
    setAiError(null);
    setAiNotice(null);
    setRetryConfirm(false);
    if (generation?.constraint) setAiConstraint(generation.constraint);
  }

  function applyCaptureUpdate(revision: unknown, rawText: unknown) {
    if (typeof revision !== 'number' || typeof rawText !== 'string') return;
    setCapture((c) => (c ? { ...c, revision, rawText } : c));
    if (!editing) setDraft(rawText);
  }

  function experienceSourceToCandidate(source: ExperiencePreviewSource): ExperienceCandidate {
    return {
      id: source.attemptId,
      captureId: source.captureId,
      captureText: source.captureText,
      captureArchived: source.captureArchived,
      captureRevision: source.captureRevision,
      step: source.step,
      resultText: source.resultText,
      outcome: source.outcome,
      observedAt: source.observedAt,
      sourceUrl: source.sourceUrl,
      revision: source.attemptRevision,
      createdAt: source.observedAt ?? 0,
      updatedAt: source.observedAt ?? 0,
      matchReasons: [],
    };
  }

  function clearExperiencePreviewState() {
    setExperiencePreview(null);
    setExperienceContextToken(null);
    setExperiencePreviewStale(false);
    setExperiencePreviewError(null);
  }

  async function loadExperienceCandidates(query: string) {
    if (!captureId) return;
    setExperienceLoading(true);
    setExperienceError(null);
    setExperienceNotice(null);
    try {
      const res = await api.getExperienceCandidates(captureId, query.trim() || undefined, 12);
      if (captureIdRef.current !== captureId) return;
      setExperienceCandidates(res.candidates ?? []);
      setExperienceQuery(res.query || query);
      setExperienceSuggestedQuery(res.suggestedQuery || '');
      setExperienceTotal(res.total ?? 0);
      setExperienceLimit(res.limit ?? 12);
      setExperienceSearched(true);
    } catch (e) {
      if (captureIdRef.current === captureId) {
        setExperienceError(errorMessage(e, '无法读取旧经验'));
        setExperienceSearched(true);
      }
    } finally {
      setExperienceLoading(false);
    }
  }

  function toggleExperienceSource(candidate: ExperienceCandidate) {
    if (selectedExperiences.some((item) => item.id === candidate.id)) {
      setSelectedExperiences(selectedExperiences.filter((item) => item.id !== candidate.id));
      clearExperiencePreviewState();
      setExperienceNotice(null);
      return;
    }
    if (selectedExperiences.length >= 3) {
      setExperienceNotice('最多选择 3 条旧经验。');
      return;
    }
    setSelectedExperiences([...selectedExperiences, candidate]);
    clearExperiencePreviewState();
    setExperienceNotice(null);
  }

  function removeExperienceSelection(id: string) {
    setSelectedExperiences(selectedExperiences.filter((item) => item.id !== id));
    clearExperiencePreviewState();
    setExperienceNotice(null);
  }

  async function startExperiencePreview() {
    if (!capture || experiencePreviewLoading || aiSubmittingRef.current) return;
    if (selectedExperiences.length < 1) {
      setExperiencePreviewError('先选择 1 条旧经验，再查看预览。');
      return;
    }
    if (selectedExperiences.length > 3) {
      setExperiencePreviewError('最多选择 3 条旧经验。');
      return;
    }
    if (!aiReady) {
      setExperiencePreviewError('AI 尚未配置或已停用，请先去设置。');
      return;
    }

    setExperiencePreviewLoading(true);
    setExperiencePreviewError(null);
    setExperiencePreviewStale(false);
    setExperienceNotice(null);
    setAiError(null);
    try {
      const res = await api.previewExperience(capture.id, {
        captureRevision: capture.revision,
        constraint: experienceConstraint.trim() || undefined,
        sourceAttemptIds: selectedExperiences.map((item) => item.id),
      });
      if (captureIdRef.current !== capture.id) return;
      setExperiencePreview(res);
      setExperienceContextToken(res.contextToken);
      setExperienceConstraint(res.constraint ?? '');
      setSelectedExperiences(res.sources.map(experienceSourceToCandidate));
      setExperienceMode('preview');
      setExperiencePreviewError(null);
      experienceOperationIdRef.current = newOperationId();
    } catch (e) {
      if (captureIdRef.current !== capture.id) return;
      handleExperiencePreviewError(e);
    } finally {
      setExperiencePreviewLoading(false);
    }
  }

  function handleExperiencePreviewError(e: unknown) {
    if (!(e instanceof ApiError)) {
      setExperiencePreviewError('网络异常，请重试。已选择的来源和限制不会丢失。');
      return;
    }
    const code = e.body?.error;
    if (code === 'version_conflict') {
      applyCaptureUpdate(e.body?.currentRevision, e.body?.currentRawText);
      setExperiencePreviewError('当前念头已更新，请刷新预览后重新确认。');
      setExperiencePreviewStale(true);
    } else if (code === 'context_changed') {
      setExperiencePreviewError(
        e.body?.message || '预览后记录或配置有变化，请刷新预览并重新确认。'
      );
      setExperiencePreviewStale(true);
    } else if (code === 'source_unavailable') {
      const ids = Array.isArray(e.body?.sourceIds) ? e.body.sourceIds : [];
      setExperiencePreviewError(
        ids.length > 0
          ? `有 ${ids.length} 条来源已不可用，请返回选择移除后重试。`
          : '部分来源已不可用，请返回选择移除后重试。'
      );
      setExperiencePreviewStale(true);
    } else if (code === 'ai_not_configured' || code === 'ai_disabled') {
      void loadAiSettings();
      setExperiencePreviewError(e.body?.message || aiErrorText(code, 'AI 不可用'));
    } else {
      setExperiencePreviewError(e.body?.message || aiErrorText(code, '预览失败，请重试'));
    }
  }

  function removePreviewSource(attemptId: string) {
    setSelectedExperiences(selectedExperiences.filter((item) => item.id !== attemptId));
    setExperiencePreview(null);
    setExperienceContextToken(null);
    setExperiencePreviewStale(false);
    setExperiencePreviewError(null);
    setExperienceMode('select');
    setExperienceNotice(
      selectedExperiences.length <= 1 ? '已移除，请再选择 1–3 条有观察的旧经验。' : null
    );
  }

  function backToExperienceSelection() {
    setExperienceMode('select');
    setExperiencePreview(null);
    setExperienceContextToken(null);
    setExperiencePreviewStale(false);
    setExperiencePreviewError(null);
  }

  function confirmExperienceGeneration() {
    if (!experiencePreview || !experienceContextToken || !capture) return;
    if (experiencePreviewStale) {
      setExperiencePreviewError('预览内容已变化，请刷新预览后重新确认。');
      return;
    }
    void requestGeneration(experiencePreview.constraint ?? '', {
      sourceAttemptIds: experiencePreview.sources.map((source) => source.attemptId),
      contextToken: experienceContextToken,
      captureRevision: experiencePreview.capture.revision,
    });
  }

  async function requestGeneration(
    constraintText: string,
    experienceContext?: {
      sourceAttemptIds: string[];
      contextToken: string;
      captureRevision?: number;
    }
  ) {
    if (!capture || aiSubmittingRef.current) return;
    if (generation?.status === 'pending') {
      setAiError('正在生成，请稍候或取消等待。');
      return;
    }
    if (!aiReady) {
      setAiError('AI 尚未配置或已停用，请先到设置中检查。');
      return;
    }
    if (capture.rawText.length > maxCapture) {
      setAiError(`念头原文超过 ${maxCapture} 字，无法生成。`);
      return;
    }
    const constraint = constraintText.trim();
    if (constraint.length > maxConstraint) {
      setAiError(`补充限制不能超过 ${maxConstraint} 字。`);
      return;
    }
    const experienceRequest =
      experienceContext && experienceContext.sourceAttemptIds.length > 0
        ? experienceContext
        : undefined;
    if (experienceRequest && !experienceRequest.contextToken) {
      setAiError('预览已失效，请重新预览后再确认。');
      setExperiencePreviewStale(true);
      return;
    }

    aiSubmittingRef.current = true;
    setAiSubmitting(true);
    setAiConstraint(constraint);
    if (experienceRequest) setExperienceConstraint(constraint);
    setAiError(null);
    setAiNotice(null);
    setRetryConfirm(false);
    setAdoptError(null);
    try {
      const res = await api.createSuggestion(capture.id, {
        captureRevision: experienceRequest?.captureRevision ?? capture.revision,
        constraint: constraint || undefined,
        operationId: experienceRequest
          ? experienceOperationIdRef.current
          : aiOperationIdRef.current,
        ...(experienceRequest
          ? {
              sourceAttemptIds: experienceRequest.sourceAttemptIds,
              contextToken: experienceRequest.contextToken,
            }
          : {}),
      });
      if (experienceRequest) {
        experienceOperationIdRef.current = newOperationId();
      } else {
        aiOperationIdRef.current = newOperationId();
      }
      if (captureIdRef.current !== capture.id) return;
      setGeneration(res.generation);
      setGenerationOrigin(experienceRequest ? 'experience' : 'ai');
      if (experienceRequest) {
        setExperienceOpen(true);
        setAiOpen(false);
        setExperienceMode('result');
        setExperiencePreviewStale(false);
        setExperiencePreviewError(null);
      } else {
        setExperienceOpen(false);
        setAiOpen(true);
        setAiConfirm(false);
      }
      setEditStepOpen(false);
      setClarifyAnswer('');
      if (res.replayed) setAiNotice('已恢复这次生成。');
    } catch (e) {
      if (captureIdRef.current !== capture.id) return;
      if (e instanceof ApiError) {
        const code = e.body?.error;
        if (code === 'context_changed' || code === 'source_unavailable') {
          setExperienceOpen(true);
          setAiOpen(false);
          setExperienceMode('preview');
          setExperiencePreviewError(
            e.body?.message ||
              (code === 'source_unavailable'
                ? '部分来源已不可用，请返回选择移除后重试。'
                : '预览后记录或配置有变化，请刷新预览并重新确认。')
          );
          setExperiencePreviewStale(true);
        } else if (code === 'version_conflict') {
          applyCaptureUpdate(e.body?.currentRevision, e.body?.currentRawText);
          if (experienceRequest) {
            setExperienceOpen(true);
            setAiOpen(false);
            setExperienceMode('preview');
            setExperiencePreviewError('当前念头已更新，请刷新预览后重新确认。');
            setExperiencePreviewStale(true);
          } else {
            setAiError(e.body?.message || '念头已更新，请确认最新内容后重新生成。');
            setAiConfirm(true);
          }
        } else if (code === 'generation_in_progress' && e.body?.generationId) {
          try {
            const res = await api.getGeneration(e.body.generationId);
            const hasExperience = generationHasExperience(res.generation);
            setGeneration(res.generation);
            setGenerationOrigin(hasExperience ? 'experience' : 'ai');
            if (hasExperience) {
              setExperienceOpen(true);
              setExperienceMode('result');
              setAiOpen(false);
            } else {
              setAiOpen(true);
              setAiConfirm(false);
              setExperienceOpen(false);
            }
          } catch {
            setAiError('这个念头已有生成任务正在进行，请刷新页面查看。');
          }
        } else if (code === 'ai_not_configured' || code === 'ai_disabled') {
          await loadAiSettings();
          const msg = e.body?.message || aiErrorText(code, 'AI 不可用');
          if (experienceRequest) {
            setExperiencePreviewError(msg);
            setAiError(msg);
          } else {
            setAiError(msg);
          }
        } else if (code === 'operation_key_conflict') {
          if (experienceRequest) {
            experienceOperationIdRef.current = newOperationId();
            setExperiencePreviewError('操作状态冲突，已准备好重新提交，请再试一次。');
            setAiError('操作状态冲突，已准备好重新提交，请再试一次。');
          } else {
            aiOperationIdRef.current = newOperationId();
            setAiError('操作状态冲突，已准备好重新提交，请再试一次。');
          }
        } else {
          const msg = e.body?.message || aiErrorText(code, '生成请求失败');
          if (experienceRequest) {
            setExperiencePreviewError(msg);
            setAiError(msg);
          } else {
            setAiError(msg);
          }
        }
      } else {
        const msg = '网络异常，未确认是否已开始生成。可重试（同一操作会自动去重）或刷新页面查看。';
        if (experienceRequest) {
          setExperiencePreviewError(msg);
          setAiError(msg);
        } else {
          setAiError(msg);
        }
      }
    } finally {
      aiSubmittingRef.current = false;
      setAiSubmitting(false);
    }
  }

  async function refreshGeneration(id?: string) {
    const genId = id ?? generation?.id;
    if (!genId) return;
    try {
      const res = await api.getGeneration(genId);
      setGeneration(res.generation);
      return res.generation;
    } catch {
      return null;
    }
  }

  async function retryExperienceGeneration() {
    if (!capture || !generation || experiencePreviewLoading || aiSubmittingRef.current) return;
    const sourceIds = (generation.sources ?? [])
      .filter((source) => !source.deleted)
      .map((source) => source.attemptId);
    if (sourceIds.length === 0) {
      startExperienceSelection();
      setExperiencePreviewError('来源记录已不可用，请重新选择旧经验。');
      return;
    }
    const constraint = (experienceConstraint || generation.constraint || '').trim();
    setExperiencePreviewLoading(true);
    setExperiencePreviewError(null);
    setExperiencePreviewStale(false);
    setExperienceOpen(true);
    setAiOpen(false);
    try {
      const res = await api.previewExperience(capture.id, {
        captureRevision: capture.revision,
        constraint: constraint || undefined,
        sourceAttemptIds: sourceIds,
      });
      if (captureIdRef.current !== capture.id) return;
      setExperiencePreview(res);
      setExperienceContextToken(res.contextToken);
      setExperienceConstraint(res.constraint ?? '');
      setSelectedExperiences(res.sources.map(experienceSourceToCandidate));
      setExperienceMode('preview');
      experienceOperationIdRef.current = newOperationId();
      await requestGeneration(res.constraint ?? constraint, {
        sourceAttemptIds: sourceIds,
        contextToken: res.contextToken,
        captureRevision: res.capture.revision,
      });
    } catch (e) {
      if (captureIdRef.current !== capture.id) return;
      handleExperiencePreviewError(e);
      setExperienceMode(experiencePreview ? 'preview' : 'select');
      if (!experiencePreview) void loadExperienceCandidates('');
    } finally {
      setExperiencePreviewLoading(false);
    }
  }

  function retryCurrentGeneration() {
    if (generationOrigin === 'experience') {
      void retryExperienceGeneration();
      return;
    }
    void requestGeneration(aiConstraint);
  }

  function regenerateFromSuggestion() {
    if (generationOrigin === 'experience') {
      void retryExperienceGeneration();
      return;
    }
    void requestGeneration(generation?.constraint ?? aiConstraint);
  }

  async function cancelCurrentGeneration() {
    if (!generation || actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy('cancel');
    setAiError(null);
    try {
      const res = await api.cancelGeneration(generation.id);
      setGeneration(res.generation);
    } catch (e) {
      if (e instanceof ApiError && e.body?.error === 'not_pending') {
        const latest = await refreshGeneration();
        if (latest && latest.status !== 'pending') {
          setAiNotice('生成已经结束，已更新为最新状态。');
        } else {
          setAiError('生成状态已变化，请刷新页面查看。');
        }
      } else {
        setAiError(errorMessage(e, '取消失败，请重试'));
      }
    } finally {
      actionBusyRef.current = false;
      setActionBusy(null);
    }
  }

  async function dismissCurrent() {
    if (!generation || actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy('dismiss');
    setAiError(null);
    try {
      await api.dismissGeneration(generation.id);
      setGeneration(null);
      setAiOpen(false);
      setExperienceOpen(false);
      setAiConfirm(false);
      setEditStepOpen(false);
      setExperienceMode('select');
      setAiNotice('已暂时放下这条建议。');
    } catch (e) {
      if (e instanceof ApiError && e.body?.error === 'not_pending') {
        setAiError('生成尚未结束，请先取消等待。');
        await refreshGeneration();
      } else {
        setAiError(errorMessage(e, '暂时放下失败，请重试'));
      }
    } finally {
      actionBusyRef.current = false;
      setActionBusy(null);
    }
  }

  function openAdoptEditor() {
    if (!generation?.suggestion || expired) return;
    setEditedStep(generation.suggestion.step ?? '');
    setEditStepOpen(true);
    setAdoptError(null);
    setAiError(null);
  }

  async function adoptSuggestion() {
    if (!generation || actionBusyRef.current) return;
    const finalStep = editedStep.trim();
    if (!finalStep) {
      setAdoptError('请填写要采用的尝试内容。');
      return;
    }
    if (finalStep.length > maxStep) {
      setAdoptError(`尝试内容不能超过 ${maxStep} 字。`);
      return;
    }
    if (expired) {
      setAdoptError('念头已修改，这条建议已过期，不能采用。');
      return;
    }
    if (sourcesIssue) {
      setAdoptError('建议依据已变化，不能采用。请重新生成。');
      return;
    }

    actionBusyRef.current = true;
    setActionBusy('accept');
    setAdoptError(null);
    setAiError(null);
    try {
      const res = await api.acceptGeneration(generation.id, {
        step: finalStep,
        operationId: newOperationId(),
      });
      navigate(`/attempt/${res.attempt.id}?from=ai`);
    } catch (e) {
      if (e instanceof ApiError) {
        const code = e.body?.error;
        if (code === 'suggestion_expired') {
          applyCaptureUpdate(e.body?.currentRevision, e.body?.currentRawText);
          setGeneration((g) => (g ? { ...g, isExpired: true } : g));
          setAdoptError('念头已修改，这条建议已过期，不能采用。');
        } else if (code === 'sources_changed') {
          const currentSources = Array.isArray(e.body?.sources)
            ? (e.body.sources as GenerationSource[])
            : undefined;
          setGeneration((g) =>
            g ? { ...g, sources: currentSources ?? g.sources, sourcesChanged: true } : g
          );
          setAdoptError('建议依据已变化，不能采用。已编辑的文字保留，可重新生成。');
        } else if (code === 'not_adoptable') {
          setAdoptError('该建议不能直接采用。');
          await refreshGeneration();
        } else if (code === 'version_conflict') {
          applyCaptureUpdate(e.body?.currentRevision, e.body?.currentRawText);
          setAdoptError('念头已更新，请返回建议重新选择。');
        } else {
          setAdoptError(e.body?.message || aiErrorText(code, '采用失败，请重试'));
        }
      } else {
        setAdoptError('网络异常，请重试。同一建议重复提交只会创建一个尝试。');
      }
    } finally {
      actionBusyRef.current = false;
      setActionBusy(null);
    }
  }

  async function submitClarify() {
    if (!generation || aiSubmittingRef.current) return;
    const answer = clarifyAnswer.trim();
    if (!answer) return;
    const base = (generation.constraint ?? '').trim();
    const merged = base ? `${base}；${answer}` : answer;
    if (merged.length > maxConstraint) {
      setAiError(`补充内容加上原有补充限制共 ${merged.length} 字，请控制在 ${maxConstraint} 字内。`);
      return;
    }

    if (generationOrigin === 'experience') {
      if (!capture) return;
      const sourceIds = (generation.sources ?? [])
        .filter((source) => !source.deleted)
        .map((source) => source.attemptId);
      if (sourceIds.length === 0) {
        setAiError('来源记录已不可用，请重新选择旧经验。');
        startExperienceSelection();
        return;
      }
      setExperiencePreviewLoading(true);
      setAiError(null);
      setExperiencePreviewError(null);
      try {
        const res = await api.previewExperience(capture.id, {
          captureRevision: capture.revision,
          constraint: merged,
          sourceAttemptIds: sourceIds,
        });
        if (captureIdRef.current !== capture.id) return;
        setExperiencePreview(res);
        setExperienceContextToken(res.contextToken);
        setExperienceConstraint(res.constraint ?? merged);
        setSelectedExperiences(res.sources.map(experienceSourceToCandidate));
        setExperiencePreviewStale(false);
        setExperienceOpen(true);
        setAiOpen(false);
        experienceOperationIdRef.current = newOperationId();
        await requestGeneration(res.constraint ?? merged, {
          sourceAttemptIds: sourceIds,
          contextToken: res.contextToken,
          captureRevision: res.capture.revision,
        });
      } catch (e) {
        if (captureIdRef.current !== capture.id) return;
        handleExperiencePreviewError(e);
        setExperienceOpen(true);
        setAiOpen(false);
        setExperienceMode(experiencePreview ? 'preview' : 'select');
      } finally {
        setExperiencePreviewLoading(false);
      }
      return;
    }

    await requestGeneration(merged);
  }

  function continueManual() {
    setAiOpen(false);
    setAiConfirm(false);
    openManual();
  }

  function renderAiLoading() {
    return (
      <div className="ai-loading" role="status">
        <span className="spinner" aria-hidden="true" />
        <span>正在读取 AI 设置…</span>
      </div>
    );
  }

  function renderAiGuide() {
    if (!aiConfig) {
      return (
        <div className="ai-guide">
          <h4>先配置 AI 模型</h4>
          <p>配置一个 OpenAI 兼容模型后，可以让它根据这条念头提出一个小尝试。</p>
          <div className="row-actions">
            <Link to="/settings/ai" className="btn primary">去设置</Link>
            <button type="button" className="btn" onClick={closeAi}>取消</button>
          </div>
        </div>
      );
    }
    if (!aiConfig.hasApiKey) {
      return (
        <div className="ai-guide">
          <h4>还缺 API Key</h4>
          <p>当前配置已保存，但还没有可用的 API Key。</p>
          <div className="row-actions">
            <Link to="/settings/ai" className="btn primary">去设置</Link>
            <button type="button" className="btn" onClick={closeAi}>取消</button>
          </div>
        </div>
      );
    }
    return (
      <div className="ai-guide">
        <h4>AI 已停用</h4>
        <p>当前配置已停用，不会发送任何内容。可在设置中启用后返回。</p>
        <div className="row-actions">
          <Link to="/settings/ai" className="btn primary">去设置</Link>
          <button type="button" className="btn" onClick={closeAi}>取消</button>
        </div>
      </div>
    );
  }

  function renderAiSettingsError() {
    return (
      <div className="ai-guide">
        <h4>无法读取 AI 设置</h4>
        <p className="error-msg" role="alert">{aiSettingsError}</p>
        <div className="row-actions">
          <button type="button" className="btn" onClick={loadAiSettings}>重试</button>
          <button type="button" className="btn" onClick={closeAi}>取消</button>
        </div>
      </div>
    );
  }

  function renderConfirm() {
    if (!aiConfig) return renderAiGuide();
    return (
      <div className="ai-confirm">
        <div className="ai-confirm-head">
          <h4>确认发送内容</h4>
          <span className="ai-target" title="目标配置与模型">
            {aiConfig.name} · {aiConfig.modelId}
          </span>
        </div>
        <div className="readonly-field">
          <span className="readonly-label">将发送：念头原文</span>
          <div className="readonly-block">{capture?.rawText}</div>
          <span className="char-count">
            {capture?.rawText.length ?? 0} / {maxCapture}
          </span>
        </div>
        <label className="field">
          <span>补充限制（选填，最多 {maxConstraint} 字）</span>
          <textarea
            rows={2}
            value={aiConstraint}
            maxLength={maxConstraint}
            placeholder="例如：只有十分钟 / 暂时没有器材"
            onChange={(e) => {
              setAiConstraint(e.target.value);
              setAiError(null);
            }}
          />
          <span className="char-count">{aiConstraint.length} / {maxConstraint}</span>
        </label>
        <p className="ai-privacy">只发送当前念头和这句限制，不会发送历史记录。</p>
        <p className="hint">生成会调用一次模型，可能产生少量费用。</p>
        {(capture?.rawText.length ?? 0) > maxCapture && (
          <p className="error-msg" role="alert">念头原文超过 {maxCapture} 字，请先精简。</p>
        )}
        {aiError && <p className="error-msg" role="alert">{aiError}</p>}
        <div className="row-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => requestGeneration(aiConstraint)}
            disabled={aiSubmitting || (capture?.rawText.length ?? 0) > maxCapture}
          >
            {aiSubmitting ? '提交中…' : '确认并生成'}
          </button>
          <button type="button" className="btn" onClick={() => {
            setAiConfirm(false);
            setAiError(null);
            if (!generation) closeAi();
          }} disabled={aiSubmitting}>
            取消
          </button>
        </div>
      </div>
    );
  }

  function renderPending() {
    if (!generation) return null;
    return (
      <div className="gen-status pending" role="status" aria-live="polite">
        <div className="gen-head">
          <span className="spinner" aria-hidden="true" />
          <h4>正在生成建议…</h4>
        </div>
        <p className="muted">
          已发送给 {generation.configName} · {generation.modelId}。通常几秒内完成，最长约{' '}
          {Math.round((aiSettings?.limits.timeoutMs ?? 60000) / 1000)} 秒。
        </p>
        {aiError && <p className="error-msg" role="alert">{aiError}</p>}
        <div className="row-actions">
          <button
            type="button"
            className="btn"
            onClick={cancelCurrentGeneration}
            disabled={actionBusy === 'cancel'}
          >
            {actionBusy === 'cancel' ? '取消中…' : '取消等待'}
          </button>
        </div>
      </div>
    );
  }

  function renderFailedOrStopped() {
    if (!generation) return null;
    const isInterrupted = generation.status === 'interrupted';
    const isCancelled = generation.status === 'cancelled';

    if (isCancelled) {
      return (
        <div className="gen-status cancelled">
          <div className="gen-head">
            <h4>已取消本次生成</h4>
          </div>
          <p className="muted">{generation.errorMessage || '已取消本次生成。'}</p>
          {aiError && <p className="error-msg" role="alert">{aiError}</p>}
          <div className="row-actions">
            <button type="button" className="btn primary" onClick={retryCurrentGeneration} disabled={!aiReady || aiSubmitting}>
              {aiSubmitting ? '提交中…' : '重新生成'}
            </button>
            <button type="button" className="btn" onClick={continueManual}>继续自己写一步</button>
            <button type="button" className="btn" onClick={dismissCurrent} disabled={actionBusy === 'dismiss'}>
              {actionBusy === 'dismiss' ? '放下中…' : '暂时放下'}
            </button>
          </div>
        </div>
      );
    }

    if (isInterrupted) {
      return (
        <div className="gen-status interrupted" role="alert">
          <div className="gen-head">
            <h4>生成已中断</h4>
          </div>
          <p className="gen-error-detail">
            {generation.errorMessage || '服务重启，本次生成已中断，可重新生成。'}
          </p>
          <div className="sent-snapshot">
            <span>当时发送的念头</span>
            <p>{generation.inputText}</p>
            {generation.constraint && <p className="hint">补充限制：{generation.constraint}</p>}
          </div>
          {aiError && <p className="error-msg" role="alert">{aiError}</p>}
          <div className="row-actions">
            <button type="button" className="btn primary" onClick={retryCurrentGeneration} disabled={!aiReady || aiSubmitting}>
              {aiSubmitting ? '提交中…' : '重新生成'}
            </button>
            <button type="button" className="btn" onClick={continueManual}>继续自己写一步</button>
            <button type="button" className="btn" onClick={dismissCurrent} disabled={actionBusy === 'dismiss'}>
              {actionBusy === 'dismiss' ? '放下中…' : '暂时放下'}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="gen-status failed" role="alert">
        <div className="gen-head">
          <h4>生成失败</h4>
        </div>
        <p className="gen-error-label">{aiErrorText(generation.errorCode, '生成失败')}</p>
        {generation.errorMessage && <p className="gen-error-detail">{generation.errorMessage}</p>}
        <div className="sent-snapshot">
          <span>已发送的念头</span>
          <p>{generation.inputText}</p>
        </div>
        <label className="field retry-constraint">
          <span>补充限制（选填，最多 {maxConstraint} 字）</span>
          <textarea
            rows={2}
            value={generationOrigin === 'experience' ? experienceConstraint : aiConstraint}
            maxLength={maxConstraint}
            placeholder="例如：只有十分钟 / 暂时没有器材"
            onChange={(e) => {
              const value = e.target.value;
              setAiConstraint(value);
              if (generationOrigin === 'experience') setExperienceConstraint(value);
              setAiError(null);
            }}
          />
          <span className="char-count">
            {(generationOrigin === 'experience' ? experienceConstraint : aiConstraint).length} / {maxConstraint}
          </span>
        </label>
        <p className="fee-hint">前一次请求可能已经产生费用。重试会再次调用模型。</p>
        {aiError && <p className="error-msg" role="alert">{aiError}</p>}
        {retryConfirm ? (
          <div className="fee-confirm">
            <p>确认重新生成？会再次调用模型。</p>
            <div className="row-actions">
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  setRetryConfirm(false);
                  retryCurrentGeneration();
                }}
                disabled={aiSubmitting || !aiReady}
              >
                {aiSubmitting ? '提交中…' : '仍然重试'}
              </button>
              <button type="button" className="btn" onClick={() => setRetryConfirm(false)}>取消</button>
            </div>
          </div>
        ) : (
          <div className="row-actions">
            <button type="button" className="btn primary" onClick={() => setRetryConfirm(true)} disabled={aiSubmitting || !aiReady}>
              手动重试
            </button>
            <button type="button" className="btn" onClick={continueManual}>继续自己写一步</button>
            <button type="button" className="btn" onClick={dismissCurrent} disabled={actionBusy === 'dismiss'}>
              {actionBusy === 'dismiss' ? '放下中…' : '暂时放下'}
            </button>
          </div>
        )}
        {!aiReady && <p className="hint">AI 配置当前不可用，可继续自己写一步。</p>}
      </div>
    );
  }

  function renderGenerationSources() {
    if (!generation) return null;
    // 只展示模型实际引用的来源；被删除的来源保留删除提示，未实际引用的选择不冒充“参考”。
    const sources = (generation.sources ?? []).filter((source) => Boolean(source.note) || source.deleted);
    if (sources.length === 0 && !sourcesIssue) return null;
    return (
      <div className="generation-sources">
        <div className="generation-sources-head">
          <h5>参考的旧经验</h5>
          <span className="muted">{sources.length} 条</span>
        </div>
        {sourcesIssue && (
          <div className="expired-banner" role="alert">
            <strong>依据已变化</strong>
            <p>
              {generation.contextInvalidReason ||
                '旧经验记录或所属念头有更新，这条建议不能采用。请重新生成。'}
            </p>
          </div>
        )}
        {sources.length > 0 && (
          <ul className="generation-source-list">
            {sources.map((source) => (
              <li
                key={source.attemptId}
                className={`generation-source${source.deleted ? ' deleted' : ''}${
                  source.changed ? ' changed' : ''
                }`}
              >
                <div className="generation-source-head">
                  {source.deleted ? (
                    <span className="source-title muted">来源已删除（内容不可用）</span>
                  ) : (
                    <Link to={`/attempt/${source.attemptId}`} className="source-title">
                      {source.step || '旧尝试'}
                    </Link>
                  )}
                  {!source.deleted && (
                    <span className={`badge outcome-${source.outcome ?? 'undetermined'}`}>
                      {source.outcome ? OUTCOME_LABEL[source.outcome] : '未判定'}
                    </span>
                  )}
                  {!source.deleted && source.observedAt && (
                    <span className="muted source-time">{formatTime(source.observedAt)}</span>
                  )}
                  {source.changed && !source.deleted && (
                    <span className="badge warn">来源有更新</span>
                  )}
                </div>
                {!source.deleted && (
                  <p className="generation-source-result">
                    {source.resultText || '（这条记录没有观察文本）'}
                  </p>
                )}
                {!source.deleted && source.captureText && (
                  <p className="generation-source-capture">
                    所属念头：
                    {source.captureId ? (
                      <Link to={`/capture/${source.captureId}`}>{source.captureText}</Link>
                    ) : (
                      source.captureText
                    )}
                  </p>
                )}
                {source.note && (
                  <p className="generation-source-note">模型说明：{source.note}</p>
                )}
                {!source.deleted && source.sourceUrl && (
                  <a
                    className="generation-source-link"
                    href={source.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                  >
                    来源链接
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  function renderExecutableActions() {
    if (!generation?.suggestion) return null;
    if (generation.adoptedAttemptId) {
      return (
        <div className="row-actions">
          <Link className="btn primary" to={`/attempt/${generation.adoptedAttemptId}?from=ai`}>
            打开已创建的尝试
          </Link>
          <button type="button" className="btn" onClick={dismissCurrent} disabled={actionBusy === 'dismiss'}>
            {actionBusy === 'dismiss' ? '放下中…' : '暂时放下'}
          </button>
        </div>
      );
    }
    if (sourcesIssue) {
      return (
        <div className="row-actions">
          <button type="button" className="btn primary" disabled title="依据已变化，不能采用">
            编辑并采用
          </button>
          <button
            type="button"
            className="btn"
            onClick={regenerateFromSuggestion}
            disabled={aiSubmitting || experiencePreviewLoading || !aiReady}
            title={!aiReady ? 'AI 配置当前不可用' : undefined}
          >
            {aiSubmitting || experiencePreviewLoading ? '处理中…' : '重新生成'}
          </button>
          <button type="button" className="btn" onClick={dismissCurrent} disabled={actionBusy === 'dismiss'}>
            {actionBusy === 'dismiss' ? '放下中…' : '暂时放下'}
          </button>
        </div>
      );
    }
    if (expired) {
      return (
        <div className="row-actions">
          <button type="button" className="btn primary" disabled title="建议已过期，不能采用">
            编辑并采用
          </button>
          <button
            type="button"
            className="btn"
            onClick={generationOrigin === 'experience' ? regenerateFromSuggestion : startConfirmForRegenerate}
            disabled={aiSubmitting || experiencePreviewLoading || !aiReady}
            title={!aiReady ? 'AI 配置当前不可用' : undefined}
          >
            {aiSubmitting || experiencePreviewLoading ? '处理中…' : '按新原文重新生成'}
          </button>
          <button type="button" className="btn" onClick={dismissCurrent} disabled={actionBusy === 'dismiss'}>
            {actionBusy === 'dismiss' ? '放下中…' : '暂时放下'}
          </button>
        </div>
      );
    }
    return (
      <div className="row-actions">
        <button type="button" className="btn primary" onClick={openAdoptEditor} disabled={editStepOpen || sourcesIssue}>
          编辑并采用
        </button>
        <button
          type="button"
          className="btn"
          onClick={regenerateFromSuggestion}
          disabled={aiSubmitting || experiencePreviewLoading || !aiReady}
          title={!aiReady ? 'AI 配置当前不可用' : undefined}
        >
          {aiSubmitting || experiencePreviewLoading ? '处理中…' : '重新生成'}
        </button>
        <button type="button" className="btn" onClick={dismissCurrent} disabled={actionBusy === 'dismiss'}>
          {actionBusy === 'dismiss' ? '放下中…' : '暂时放下'}
        </button>
      </div>
    );
  }

  function renderSuggestion() {
    if (!generation) return null;
    const suggestion = generation.suggestion;
    if (!suggestion) {
      return (
        <div className="gen-status failed" role="alert">
          <div className="gen-head"><h4>生成结果不完整</h4></div>
          <p className="gen-error-detail">没有收到可用的建议内容，可以重新生成。</p>
          <div className="row-actions">
            <button type="button" className="btn primary" onClick={retryCurrentGeneration} disabled={!aiReady || aiSubmitting}>
              {aiSubmitting ? '提交中…' : '重新生成'}
            </button>
            <button type="button" className="btn" onClick={dismissCurrent} disabled={actionBusy === 'dismiss'}>暂时放下</button>
          </div>
        </div>
      );
    }

    if (suggestion.kind === 'defer') {
      return (
        <div className="suggestion-card kind-defer">
          <div className="suggestion-head">
            <h4>先记着</h4>
            <span className="badge ai-kind">暂缓</span>
          </div>
          <p className="suggestion-why">{suggestion.why}</p>
          {renderGenerationSources()}
          <p className="suggestion-meta">已生成于 {formatTime(generation.createdAt)} · {generation.configName} · {generation.modelId}</p>
          {aiError && <p className="error-msg" role="alert">{aiError}</p>}
          <div className="row-actions">
            <button type="button" className="btn" onClick={regenerateFromSuggestion} disabled={aiSubmitting || experiencePreviewLoading || !aiReady}>
              {aiSubmitting || experiencePreviewLoading ? '处理中…' : '重新生成'}
            </button>
            <button type="button" className="btn" onClick={dismissCurrent} disabled={actionBusy === 'dismiss'}>
              {actionBusy === 'dismiss' ? '放下中…' : '暂时放下'}
            </button>
          </div>
        </div>
      );
    }

    if (suggestion.kind === 'clarify') {
      return (
        <div className="suggestion-card kind-clarify">
          <div className="suggestion-head">
            <h4>还差一点信息</h4>
            <span className="badge ai-kind">需要补充</span>
          </div>
          <p className="suggestion-why">{suggestion.why}</p>
          <div className="suggestion-question">
            <span>关键问题</span>
            <p>{suggestion.question}</p>
          </div>
          {renderGenerationSources()}
          <form
            className="clarify-form"
            onSubmit={(e) => {
              e.preventDefault();
              submitClarify();
            }}
          >
            <label className="field">
              <span>补充这一点（最多 {maxConstraint} 字）</span>
              <input
                type="text"
                value={clarifyAnswer}
                maxLength={maxConstraint}
                placeholder="回答上面的问题"
                onChange={(e) => {
                  setClarifyAnswer(e.target.value);
                  setAiError(null);
                }}
              />
              <span className="char-count">{clarifyAnswer.length} / {maxConstraint}</span>
            </label>
            {generation.constraint && (
              <p className="hint">会连同原补充限制一起发送（合计最多 {maxConstraint} 字）。</p>
            )}
            {aiError && <p className="error-msg" role="alert">{aiError}</p>}
            <div className="row-actions">
              <button
                type="submit"
                className="btn primary"
                disabled={!clarifyAnswer.trim() || aiSubmitting || experiencePreviewLoading || !aiReady}
              >
                {aiSubmitting || experiencePreviewLoading ? '处理中…' : '补充并重新生成'}
              </button>
              {sourcesIssue && (
                <button
                  type="button"
                  className="btn"
                  onClick={regenerateFromSuggestion}
                  disabled={aiSubmitting || experiencePreviewLoading || !aiReady}
                >
                  重新生成
                </button>
              )}
              <button type="button" className="btn" onClick={dismissCurrent} disabled={actionBusy === 'dismiss'}>
                {actionBusy === 'dismiss' ? '放下中…' : '暂时放下'}
              </button>
            </div>
          </form>
        </div>
      );
    }

    return (
      <div className="suggestion-card kind-executable">
        <div className="suggestion-head">
          <h4>可以试这一步</h4>
          <span className="badge ai-kind">可执行</span>
        </div>
        {expired && (
          <div className="expired-banner" role="alert">
            <strong>念头已修改，这条建议已过期</strong>
            <p>旧建议仍保留供参考，但不能采用。按当前原文重新生成后，才能采用新建议。</p>
          </div>
        )}
        <p className="suggestion-step">{suggestion.step}</p>
        <p className="suggestion-why">{suggestion.why}</p>
        {renderGenerationSources()}
        {suggestion.estimatedMinutes != null && (
          <p className="suggestion-meta">预计投入：约 {suggestion.estimatedMinutes} 分钟（估计）</p>
        )}
        <p className="suggestion-meta">
          生成于 {formatTime(generation.createdAt)} · {generation.configName} · {generation.modelId}
        </p>
        {aiError && <p className="error-msg" role="alert">{aiError}</p>}
        {renderExecutableActions()}

        {editStepOpen && !generation.adoptedAttemptId && (
          <div className="adopt-editor">
            <label className="field">
              <span>要采用的尝试内容（最多 {maxStep} 字）</span>
              <textarea
                rows={3}
                value={editedStep}
                maxLength={maxStep}
                autoFocus
                onChange={(e) => {
                  setEditedStep(e.target.value);
                  setAdoptError(null);
                }}
              />
              <span className="char-count">{editedStep.length} / {maxStep}</span>
            </label>
            {adoptError && <p className="error-msg" role="alert">{adoptError}</p>}
            <div className="row-actions">
              <button
                type="button"
                className="btn primary"
                onClick={adoptSuggestion}
                disabled={
                  actionBusy === 'accept' ||
                  !editedStep.trim() ||
                  expired ||
                  sourcesIssue
                }
              >
                {actionBusy === 'accept' ? '采用中…' : '采用并创建尝试'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setEditStepOpen(false);
                  setAdoptError(null);
                }}
                disabled={actionBusy === 'accept'}
              >
                取消
              </button>
            </div>
          </div>
        )}
        {adoptError && !editStepOpen && <p className="error-msg" role="alert">{adoptError}</p>}
      </div>
    );
  }

  function renderGeneration() {
    if (!generation) return null;
    let content = null;
    if (generation.status === 'pending') content = renderPending();
    else if (generation.status === 'failed' || generation.status === 'cancelled' || generation.status === 'interrupted') {
      content = renderFailedOrStopped();
    } else if (generation.status === 'succeeded') content = renderSuggestion();

    return (
      <>
        {!aiSettingsLoading && !aiSettingsError && !aiReady && (
          <p className="inline-warn">
            AI 配置当前不可用。已有建议仍可查看或采用；重新生成前请先检查设置。
          </p>
        )}
        {aiNotice && <p className="save-ok" role="status">{aiNotice}</p>}
        {content}
      </>
    );
  }

  function renderExperienceCandidate(candidate: ExperienceCandidate) {
    const selected = selectedExperiences.some((item) => item.id === candidate.id);
    const atLimit = selectedExperiences.length >= 3 && !selected;
    return (
      <article
        key={candidate.id}
        className={`experience-card${selected ? ' selected' : ''}`}
        aria-label={`旧经验：${candidate.step}`}
      >
        <div className="experience-card-top">
          <label className="experience-pick">
            <input
              type="checkbox"
              checked={selected}
              disabled={atLimit}
              onChange={() => toggleExperienceSource(candidate)}
            />
            <span>{selected ? '已选' : '选择'}</span>
          </label>
          <span className={`badge outcome-${candidate.outcome ?? 'undetermined'}`}>
            {candidate.outcome ? OUTCOME_LABEL[candidate.outcome] : '未判定'}
          </span>
          {candidate.captureArchived && <span className="badge">已归档</span>}
          <time className="experience-time">
            发生：{formatTime(candidate.observedAt ?? candidate.updatedAt)}
          </time>
        </div>
        <h5 className="experience-step">{candidate.step}</h5>
        <p className="experience-result" title={candidate.resultText}>
          {candidate.resultText}
        </p>
        <p className="experience-capture">
          所属念头：
          <Link to={`/capture/${candidate.captureId}`}>{candidate.captureText}</Link>
        </p>
        {candidate.matchReasons.length > 0 && (
          <div className="experience-reasons" aria-label="命中原因">
            <span>命中：</span>
            {candidate.matchReasons.map((reason) => (
              <span key={reason} className="experience-reason">{reason}</span>
            ))}
          </div>
        )}
        <div className="experience-card-links">
          <Link to={`/attempt/${candidate.id}`}>打开原尝试 →</Link>
          {candidate.sourceUrl && (
            <a
              href={candidate.sourceUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
            >
              来源链接
            </a>
          )}
        </div>
      </article>
    );
  }

  function renderExperienceSelection() {
    const selectedCount = selectedExperiences.length;
    return (
      <div className="experience-select-panel">
        <p className="hint">
          从过去的尝试里挑 1–3 条有实际观察的记录，AI 会结合它们给出新尝试；失败或未判定的记录也可以参考。
        </p>
        {!aiReady && !aiSettingsLoading && (
          <p className="inline-warn">
            AI 尚未配置或已停用，仍可浏览旧经验。<Link to="/settings/ai">去设置</Link>
          </p>
        )}
        <form
          className="experience-search"
          onSubmit={(e) => {
            e.preventDefault();
            void loadExperienceCandidates(experienceQuery);
          }}
        >
          <input
            ref={experienceSearchRef}
            type="search"
            value={experienceQuery}
            placeholder={experienceSuggestedQuery ? `例如：${experienceSuggestedQuery}` : '搜索旧尝试、结果或念头…'}
            aria-label="搜索旧经验"
            onChange={(e) => setExperienceQuery(e.target.value)}
          />
          <button className="btn" type="submit" disabled={experienceLoading}>
            {experienceLoading ? '搜索中…' : '搜索'}
          </button>
        </form>
        {experienceSearched && !experienceLoading && !experienceError && (
          <p className="hint">
            共 {experienceTotal} 条匹配，展示 {experienceCandidates.length} 条（最多 {experienceLimit} 条）。排序按关键词命中、明确引用关系和时间；结果评价不参与排序。
          </p>
        )}
        {experienceLoading && (
          <p className="loading-line muted" role="status">
            <span className="spinner" aria-hidden="true" /> 正在查找旧经验…
          </p>
        )}
        {experienceError && (
          <div className="experience-error" role="alert">
            <p className="error-msg">{experienceError}</p>
            <button
              type="button"
              className="btn small"
              onClick={() => void loadExperienceCandidates(experienceQuery)}
            >
              重试
            </button>
          </div>
        )}
        {experienceSearched && !experienceLoading && !experienceError && experienceCandidates.length === 0 && (
          <>
            <div className="empty-state">没有找到符合搜索词、且有实际观察的旧经验。</div>
            <div className="row-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  experienceSearchRef.current?.focus();
                  experienceSearchRef.current?.select();
                }}
              >
                修改搜索词
              </button>
              <button type="button" className="btn" onClick={openAi}>
                改用普通 AI 建议
              </button>
            </div>
          </>
        )}
        {experienceCandidates.length > 0 && (
          <div className="experience-list">{experienceCandidates.map(renderExperienceCandidate)}</div>
        )}

        <div className="experience-selected">
          <div className="experience-selected-head">
            <strong>已选 {selectedCount}/3</strong>
            {selectedCount === 3 && <span className="hint">已达到上限，可先移除再换选。</span>}
          </div>
          {selectedCount === 0 ? (
            <p className="hint">还没有选择来源。至少选择 1 条才能预览。</p>
          ) : (
            <ul className="experience-selected-list">
              {selectedExperiences.map((source) => (
                <li key={source.id}>
                  <span className="experience-selected-title">{source.step}</span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => removeExperienceSelection(source.id)}
                    aria-label={`移除 ${source.step}`}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label className="field">
          <span>补充限制（选填，最多 {maxConstraint} 字）</span>
          <textarea
            rows={2}
            value={experienceConstraint}
            maxLength={maxConstraint}
            placeholder="例如：只有十分钟 / 暂时没有器材"
            onChange={(e) => {
              setExperienceConstraint(e.target.value);
              setExperiencePreviewError(null);
            }}
          />
          <span className="char-count">{experienceConstraint.length} / {maxConstraint}</span>
        </label>
        {experienceNotice && <p className="save-ok" role="status">{experienceNotice}</p>}
        {experiencePreviewError && <p className="error-msg" role="alert">{experiencePreviewError}</p>}
        <div className="row-actions">
          <button
            type="button"
            className="btn primary"
            onClick={startExperiencePreview}
            disabled={selectedCount === 0 || experiencePreviewLoading || !aiReady}
            title={!aiReady ? 'AI 配置当前不可用' : undefined}
          >
            {experiencePreviewLoading ? '读取预览中…' : '结合这些经验，帮我试一步'}
          </button>
          <button type="button" className="btn" onClick={openAi}>
            改用普通 AI 建议
          </button>
        </div>
        {selectedCount === 0 && <p className="hint">至少选择 1 条旧经验。</p>}
      </div>
    );
  }

  function renderExperiencePreview() {
    if (!experiencePreview) return null;
    return (
      <div className="experience-preview">
        <div className="ai-confirm-head">
          <h4>确认这次参考</h4>
          <span className="ai-target">
            {experiencePreview.config.name} · {experiencePreview.config.modelId}
          </span>
        </div>
        {experiencePreviewStale && (
          <div className="expired-banner" role="alert">
            <strong>预览内容已变化</strong>
            <p>记录或配置在预览后发生了变化，请刷新预览并重新确认后再生成。</p>
          </div>
        )}
        <div className="readonly-field">
          <span className="readonly-label">当前念头</span>
          <div className="readonly-block">{experiencePreview.capture.rawText}</div>
        </div>
        <div className="preview-constraint">
          <span>补充限制</span>
          <p>{experiencePreview.constraint || '未填写'}</p>
        </div>
        <div className="preview-source-block">
          <div className="preview-source-head">
            <h5>参考的旧经验</h5>
            <span className="muted">{experiencePreview.sources.length}/3 条</span>
          </div>
          <ul className="preview-source-list">
            {experiencePreview.sources.map((source) => (
              <li key={source.attemptId} className="preview-source">
                <div className="preview-source-title">
                  <Link to={`/attempt/${source.attemptId}`}><strong>{source.step}</strong></Link>
                  <span className={`badge outcome-${source.outcome ?? 'undetermined'}`}>
                    {source.outcome ? OUTCOME_LABEL[source.outcome] : '未判定'}
                  </span>
                  {source.captureArchived && <span className="badge">已归档</span>}
                </div>
                <p className="preview-source-result">{source.resultText}</p>
                <p className="preview-source-meta">
                  时间：{formatTime(source.observedAt)}
                  {' · '}所属念头：
                  <Link to={`/capture/${source.captureId}`}>{source.captureText}</Link>
                </p>
                <div className="preview-source-actions">
                  {source.sourceUrl && (
                    <a
                      href={source.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                    >
                      来源链接
                    </a>
                  )}
                  <button
                    type="button"
                    className="link"
                    onClick={() => removePreviewSource(source.attemptId)}
                  >
                    移除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
        {experiencePreviewError && (
          <p className="error-msg" role="alert">{experiencePreviewError}</p>
        )}
        <div className="row-actions">
          <button
            type="button"
            className="btn primary"
            onClick={confirmExperienceGeneration}
            disabled={
              experiencePreviewStale ||
              experiencePreviewLoading ||
              aiSubmitting ||
              !aiReady
            }
            title={!aiReady ? 'AI 配置当前不可用' : undefined}
          >
            {aiSubmitting ? '提交中…' : '确认并生成'}
          </button>
          <button type="button" className="btn" onClick={backToExperienceSelection}>
            返回选择
          </button>
          {experiencePreviewStale && (
            <button
              type="button"
              className="btn"
              onClick={startExperiencePreview}
              disabled={experiencePreviewLoading}
            >
              {experiencePreviewLoading ? '刷新中…' : '刷新预览'}
            </button>
          )}
        </div>
      </div>
    );
  }

  function renderExperienceContent() {
    if (experienceMode === 'result' && generation && generationOrigin === 'experience') {
      return renderGeneration();
    }
    if (experienceMode === 'preview' && experiencePreview) {
      return renderExperiencePreview();
    }
    return renderExperienceSelection();
  }

  function renderAiContent() {
    if (aiConfirm) {
      if (aiSettingsLoading) return renderAiLoading();
      if (aiSettingsError) return renderAiSettingsError();
      if (!aiReady) return renderAiGuide();
      return renderConfirm();
    }
    if (generation) return renderGeneration();
    if (aiSettingsLoading || aiRestoring) return renderAiLoading();
    if (aiSettingsError) return renderAiSettingsError();
    if (!aiReady) return renderAiGuide();
    return renderConfirm();
  }

  if (loading) return <div className="page"><p className="muted">加载中…</p></div>;
  if (!capture) {
    const canGoBack = location.key !== 'default';
    return (
      <div className="page capture-page">
        <div className="crumb">
          <Link to="/">← 返回列表</Link>
          {canGoBack && (
            <>
              {' · '}
              <button
                type="button"
                className="link topic-back-link"
                onClick={() => navigate(-1)}
                data-testid="capture-back-previous"
              >
                ← 返回上一页
              </button>
            </>
          )}
        </div>
        <div className="home-load-error" role="alert" data-testid="capture-load-error">
          <p className="error-msg">{loadFailure?.message || error || '念头不存在'}</p>
          <p className="hint">
            {loadFailure && loadFailure.status === 404
              ? '链接里的念头可能已被删除。也可以回到首页查看其他记录。'
              : '记录没有被删除，只是这次没读到：检查本地服务是否在运行，然后重试。'}
          </p>
          <div className="row-actions">
            <button
              type="button"
              className="btn small primary"
              onClick={() => void load()}
              data-testid="capture-load-retry"
            >
              重试
            </button>
            <button type="button" className="btn small" onClick={() => navigate(-1)}>
              返回上一页
            </button>
            <Link className="btn small" to="/">返回首页</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page capture-page">
      <div className="crumb">
        <Link to="/">← 返回列表</Link>
        {location.key !== 'default' && (
          <>
            {' · '}
            <button
              type="button"
              className="link topic-back-link"
              onClick={() => navigate(-1)}
              data-testid="capture-back-previous"
            >
              ← 返回上一页
            </button>
          </>
        )}
        {topicNav.fromTopic && topicNav.returnTo && (
          <>
            {' · '}
            <Link to={topicNav.returnTo} className="topic-back-link" data-testid="capture-back-topic">
              ← 返回主题
            </Link>
          </>
        )}
      </div>

      <header className="detail-head">
        {editing ? (
          <div className="edit-block">
            <textarea
              className="capture-input"
              value={draft}
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
            {conflict && (
              <div className="conflict-banner" role="alert">
                <p>版本冲突：其他窗口已更新这条念头，你的文字仍保留在这里。</p>
                <p className="muted">最新内容：{conflict.currentRawText}</p>
                <div className="row-actions">
                  <button
                    className="btn small"
                    onClick={() => {
                      setDraft(conflict.currentRawText);
                      setCapture((c) => (c ? { ...c, revision: conflict.currentRevision, rawText: conflict.currentRawText } : c));
                      setConflict(null);
                    }}
                  >
                    查看最新内容并采用
                  </button>
                  <button className="btn small" onClick={saveEdit} disabled={saving}>
                    重试保存（覆盖最新版）
                  </button>
                </div>
              </div>
            )}
            {!draft.trim() && (
              <p className="error-msg" role="alert">念头正文不能为空：写下至少一个字再保存。</p>
            )}
            <div className="row-actions">
              <button className="btn primary" onClick={saveEdit} disabled={saving || !draft.trim()}>
                {saving ? '保存中…' : '保存'}
              </button>
              <button
                className="btn"
                onClick={() => {
                  setEditing(false);
                  setDraft(capture.rawText);
                  setConflict(null);
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <>
            <h2 className="detail-title">{capture.rawText}</h2>
            <p className="card-meta">
              创建于 {formatTime(capture.createdAt)} · 版本 {capture.revision}
              {capture.archivedAt ? ' · 已归档' : ''}
            </p>
            <div className="row-actions">
              <button className="btn small" onClick={() => setEditing(true)}>编辑</button>
              <button
                className="btn small"
                onClick={() => void toggleArchive()}
                disabled={archiveBusy}
                aria-busy={archiveBusy}
                data-testid="capture-archive-toggle"
              >
                {archiveBusy ? '处理中…' : capture.archivedAt ? '恢复' : '归档'}
              </button>
              <button
                className="btn small danger"
                onClick={() => void openDeletePreview()}
                disabled={previewLoading}
                aria-busy={previewLoading}
                data-testid="capture-delete-open"
              >
                {previewLoading ? '读取影响范围…' : '删除…'}
              </button>
            </div>
            {archiveNotice && (
              <p className="save-ok" role="status" data-testid="capture-archive-notice">
                {archiveNotice}
              </p>
            )}
            {deleteError && !preview && (
              <p className="error-msg" role="alert" data-testid="capture-delete-error">
                {deleteError}
              </p>
            )}
          </>
        )}
        {error && <p className="error-msg" role="alert">{error}</p>}
      </header>

      <TopicMembership captureId={capture.id} returnTo={topicNav.returnTo} />

      <section className="section capture-links-section" aria-label="关联记录">
        <div className="section-head">
          <h3>
            关联记录{' '}
            <span className="muted">
              ({(links?.counts.out ?? 0) + (links?.counts.in ?? 0)})
            </span>
          </h3>
          <div className="row-actions">
            <Link
              className="btn small"
              to={topicAwareHref(`/graph?node=capture:${capture.id}&depth=1`, topicNav)}
              data-testid="capture-open-local-graph"
            >
              查看局部图
            </Link>
            <button
              type="button"
              className="btn small"
              onClick={openLinkComposer}
              data-testid="capture-link-open"
            >
              ＋ 关联一条念头
            </button>
          </div>
        </div>
        <p className="hint">
          关联有方向：这里分别显示「关联到」与「被关联」。链接按稳定 ID 保存，修改念头正文不会断开。
        </p>
        {linkNotice && <p className="save-ok" role="status">{linkNotice}</p>}
        {linkError && !linkComposerOpen && <p className="error-msg" role="alert">{linkError}</p>}
        {linksLoading && (
          <p className="loading-line muted" role="status">
            <span className="spinner" aria-hidden="true" /> 正在读取关联记录…
          </p>
        )}
        {linksError && !linksLoading && (
          <div className="home-load-error" role="alert" data-testid="capture-links-error">
            <p className="error-msg">{linksError}</p>
            <p className="hint">这次没读到关联记录与引用关系，不代表它们不存在，可以重试。</p>
            <button type="button" className="btn small" onClick={() => void loadLinks(captureId)}>
              重试
            </button>
          </div>
        )}

        {linkComposerOpen && (
          <div className="link-composer" role="region" aria-label="关联一条念头">
            <div className="link-composer-head">
              <h4>选择要关联的念头</h4>
              <button type="button" className="btn small" onClick={closeLinkComposer}>
                收起
              </button>
            </div>
            <form
              className="search-bar"
              onSubmit={(e) => {
                e.preventDefault();
                void searchLinkCandidates(linkQuery);
              }}
            >
              <input
                type="search"
                value={linkQuery}
                onChange={(e) => setLinkQuery(e.target.value)}
                placeholder="搜索另一条念头，例如「闪烁」"
                aria-label="搜索要关联的念头"
                autoFocus
              />
              <button className="btn" type="submit" disabled={linkCandidatesLoading}>
                {linkCandidatesLoading ? '搜索中…' : '搜索'}
              </button>
            </form>
            {linkCandidatesError && (
              <p className="error-msg" role="alert">{linkCandidatesError}</p>
            )}
            <ul className="link-candidates" aria-label="可关联的念头">
              {linkCandidates.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    className="link-candidate"
                    onClick={() => {
                      setLinkTarget(candidate);
                      setLinkNote('');
                      setLinkError(null);
                    }}
                    disabled={candidate.alreadyLinked || linkBusy}
                    aria-pressed={linkTarget?.id === candidate.id}
                  >
                    <span className="link-candidate-text">{candidate.snippet}</span>
                    <span className="link-candidate-meta">
                      {formatTime(candidate.createdAt)}
                      {candidate.archived ? ' · 已归档' : ''}
                      {candidate.alreadyLinked ? ' · 已关联' : ''}
                    </span>
                  </button>
                </li>
              ))}
              {!linkCandidatesLoading && linkCandidates.length === 0 && (
                <li className="muted">
                  {linkQuery.trim() ? '没有找到匹配的念头。' : '还没有可以关联的其他念头。'}
                </li>
              )}
            </ul>
            {linkTarget && (
              <div className="link-target">
                <p>
                  将关联到：<strong>{linkTarget.summary}</strong>
                  <span className="muted"> · {formatTime(linkTarget.createdAt)}</span>
                </p>
                <label className="field">
                  <span>关联说明（选填，最多 200 字）</span>
                  <input
                    type="text"
                    value={linkNote}
                    maxLength={200}
                    onChange={(e) => setLinkNote(e.target.value)}
                    placeholder="例如「这两条在讨论同一个闪烁问题」"
                  />
                </label>
                {linkError && <p className="error-msg" role="alert">{linkError}</p>}
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => void submitLink()}
                    disabled={linkBusy}
                    data-testid="capture-link-submit"
                  >
                    {linkBusy ? '正在关联…' : '确认关联'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setLinkTarget(null)}
                    disabled={linkBusy}
                  >
                    重选
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {!linksError && (
        <div className="link-columns">
          <div className="link-column">
            <h4>
              关联到 <span className="muted">({links?.out.length ?? 0})</span>
            </h4>
            {(links?.out.length ?? 0) === 0 ? (
              <p className="empty-state">还没有主动关联的念头。</p>
            ) : (
              <ul className="capture-link-list">
                {(links?.out ?? []).map((item) => (
                  <li
                    key={item.id}
                    className="capture-link-row capture-link-out"
                    data-direction="out"
                    data-testid="capture-link-row"
                  >
                    <div className="capture-link-main">
                      <Link to={`/capture/${item.capture.id}`} className="capture-link-title">
                        {item.capture.summary}
                      </Link>
                      <span className="capture-link-date">
                        {formatTime(item.capture.createdAt)}
                        {item.capture.archived ? ' · 已归档' : ''}
                      </span>
                    </div>
                    {item.note && <p className="capture-link-note">关联说明：{item.note}</p>}
                    <div className="capture-link-actions">
                      <Link to={`/capture/${item.capture.id}`} className="link">
                        打开
                      </Link>
                      <button
                        type="button"
                        className="link danger-link"
                        onClick={() => void removeLink(item)}
                        disabled={removingLinkId === item.id}
                        data-testid="capture-link-remove"
                      >
                        {removingLinkId === item.id ? '解除中…' : '解除关联'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="link-column">
            <h4>
              被关联 <span className="muted">({links?.in.length ?? 0})</span>
            </h4>
            {(links?.in.length ?? 0) === 0 ? (
              <p className="empty-state">还没有其他念头关联到这里。</p>
            ) : (
              <ul className="capture-link-list">
                {(links?.in ?? []).map((item) => (
                  <li
                    key={item.id}
                    className="capture-link-row capture-link-in"
                    data-direction="in"
                    data-testid="capture-link-row"
                  >
                    <div className="capture-link-main">
                      <Link to={`/capture/${item.capture.id}`} className="capture-link-title">
                        {item.capture.summary}
                      </Link>
                      <span className="capture-link-date">
                        {formatTime(item.capture.createdAt)}
                        {item.capture.archived ? ' · 已归档' : ''}
                      </span>
                    </div>
                    <p className="capture-link-direction">被这条念头关联</p>
                    {item.note && <p className="capture-link-note">关联说明：{item.note}</p>}
                    <div className="capture-link-actions">
                      <Link to={`/capture/${item.capture.id}`} className="link">
                        打开
                      </Link>
                      <button
                        type="button"
                        className="link danger-link"
                        onClick={() => void removeLink(item)}
                        disabled={removingLinkId === item.id}
                        data-testid="capture-link-remove"
                      >
                        {removingLinkId === item.id ? '解除中…' : '解除关联'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        )}
      </section>

      <section className="section start-section">
        <div className="section-head">
          <h3>开始一步</h3>
          <span className="hint">选一种方式开始</span>
        </div>

        <div className="start-choices">
          <button
            type="button"
            className={`start-card${manualOpen ? ' active' : ''}`}
            onClick={openManual}
            aria-expanded={manualOpen}
          >
            <span className="start-card-kicker">自己写</span>
            <span className="start-card-title">自己写一步</span>
            <span className="start-card-sub">写下一个具体、能立刻开始的小尝试。</span>
          </button>
          <button
            type="button"
            className={`start-card ai${aiOpen ? ' active' : ''}`}
            onClick={openAi}
            aria-expanded={aiOpen}
          >
            <span className="start-card-kicker">AI 辅助</span>
            <span className="start-card-title">帮我试一步 <span className="ai-tag">AI</span></span>
            <span className="start-card-sub">根据这条念头，生成一个低负担的小尝试。</span>
          </button>
          <button
            type="button"
            className={`start-card experience${experienceOpen ? ' active' : ''}`}
            onClick={openExperience}
            aria-expanded={experienceOpen}
          >
            <span className="start-card-kicker">旧经验</span>
            <span className="start-card-title">参考旧经验</span>
            <span className="start-card-sub">从过去的尝试里找依据。</span>
          </button>
          <button
            type="button"
            className={`start-card research${researchOpen ? ' active' : ''}`}
            onClick={openResearch}
            aria-expanded={researchOpen}
          >
            <span className="start-card-kicker">公开仓库</span>
            <span className="start-card-title">研究一下</span>
            <span className="start-card-sub">检索 GitHub 项目，对比后选一个小实验。</span>
          </button>
        </div>

        {researchOpen && capture && (
          <div className="ai-panel research-panel" aria-label="研究一下">
            <div className="ai-panel-head">
              <div>
                <h4>研究一下</h4>
                <p className="hint">
                  先检索公开仓库，再选择最多 3 个深入读取；模型对比只在你确认后发生。
                </p>
              </div>
              <button type="button" className="btn small" onClick={() => setResearchOpen(false)}>
                收起
              </button>
            </div>
            <ResearchStarter
              capture={capture}
              onStarted={(researchId) => navigate(`/research/${researchId}`)}
              onClose={() => setResearchOpen(false)}
            />
          </div>
        )}

        {manualOpen && (
          <form className="attempt-form manual-attempt" onSubmit={createAttempt}>
            <input
              ref={attemptInputRef}
              type="text"
              placeholder="想做的小尝试，例如「比较两种 PWM 频率」"
              value={step}
              maxLength={maxStep}
              onChange={(e) => setStep(e.target.value)}
              onBlur={() => setStepTouched(true)}
              aria-label="尝试内容"
              aria-invalid={stepTouched && !step.trim() ? true : undefined}
              required
            />
            <select
              value={attemptState}
              onChange={(e) => setAttemptState(e.target.value as AttemptState)}
              aria-label="尝试状态"
            >
              <option value="todo">待尝试</option>
              <option value="in_progress">进行中</option>
              <option value="done">已结束</option>
              <option value="cancelled">已放弃</option>
            </select>
            <button className="btn primary" type="submit" disabled={creating}>
              {creating ? '创建中…' : '创建尝试'}
            </button>
          </form>
        )}
        {manualOpen && (
          <p className="hint">
            这一步要做什么（必填，最多 {maxStep} 字）· 已输入 {step.trim().length} 字
          </p>
        )}
        {manualOpen && stepTouched && !step.trim() && (
          <p className="error-msg" role="alert" data-testid="attempt-step-error">
            请先写下这一步要做什么（至少 1 个字），才能创建尝试。
          </p>
        )}
        {createError && <p className="error-msg" role="alert">{createError}</p>}

        {createdAttempt && (
          <div className="attempt-created-note" role="status" data-testid="attempt-created-note">
            <div>
              <p>
                已创建尝试：<strong>{createdAttempt.step}</strong>
              </p>
              <p className="hint">现在可以打开这次尝试，记录实际结果。</p>
            </div>
            <div className="attempt-created-actions">
              <Link
                className="btn primary small"
                to={`/attempt/${createdAttempt.id}`}
                data-testid="attempt-created-open"
              >
                打开并记录结果 →
              </Link>
              <button type="button" className="link" onClick={() => setCreatedAttempt(null)}>
                关闭
              </button>
            </div>
          </div>
        )}

        {aiOpen && (
          <div className="ai-panel" aria-label="AI 帮我试一步">
            <div className="ai-panel-head">
              <h4>帮我试一步</h4>
              <button type="button" className="btn small" onClick={closeAi}>收起</button>
            </div>
            {aiNotice && !generation && <p className="save-ok" role="status">{aiNotice}</p>}
            {aiError && !generation && !aiConfirm && <p className="error-msg" role="alert">{aiError}</p>}
            {renderAiContent()}
          </div>
        )}

        {experienceOpen && (
          <div className="ai-panel experience-panel" aria-label="参考旧经验">
            <div className="ai-panel-head">
              <h4>参考旧经验</h4>
              <div className="ai-panel-actions">
                {experienceMode === 'result' &&
                  generation &&
                  generation.status !== 'pending' && (
                    <button
                      type="button"
                      className="btn small"
                      onClick={startExperienceSelection}
                    >
                      重新选择来源
                    </button>
                  )}
                <button type="button" className="btn small" onClick={closeExperience}>收起</button>
              </div>
            </div>
            {renderExperienceContent()}
          </div>
        )}

        {!aiOpen && !experienceOpen && aiNotice && (
          <p className="save-ok" role="status">{aiNotice}</p>
        )}
      </section>

      {nextActions.length > 0 && (
        <section className="section capture-next-actions" aria-label="下一步行动">
          <div className="section-head">
            <h3>下一步行动 <span className="muted">({nextActions.length})</span></h3>
            <span className="hint">来自阶段回顾，由你确认后保存</span>
          </div>
          <p className="hint">这些行动会出现在下方尝试记录里；打开可以查看来源、编辑或安排时间。</p>
          <ul className="next-action-list">
            {nextActions.map((action) => (
              <li className="next-action-list-item" key={action.id}>
                <Link
                  className="next-action-list-link"
                  to={`/next-action/${action.id}`}
                  data-testid="capture-next-action"
                >
                  <span className="next-action-list-title">{action.title}</span>
                  <span className="next-action-list-meta">
                    <span className={`badge state-${action.state}`}>{STATE_LABEL[action.state]}</span>
                    {action.estimatedMinutes != null && (
                      <span className="badge">预计 {action.estimatedMinutes} 分钟</span>
                    )}
                    <span className="muted">创建于 {formatTime(action.createdAt)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="section">
        <h3>尝试记录 <span className="muted">({attempts.length})</span></h3>
        {attempts.length === 0 ? (
          <p className="empty-state">还没有尝试。上面写一个小尝试，开始第一步。</p>
        ) : (
          <ul className="card-list">
            {attempts.map((att) => (
              <li key={att.id} className="card">
                <Link to={`/attempt/${att.id}`} className="card-main">
                  <p className="card-text">{att.step}</p>
                  <p className="card-meta">
                    <span className={`badge state-${att.state}`}>{STATE_LABEL[att.state]}</span>
                    {att.outcome && <span className={`badge outcome-${att.outcome}`}>{OUTCOME_LABEL[att.outcome]}</span>}
                    {att.resultText ? ` · ${att.resultText.slice(0, 50)}${att.resultText.length > 50 ? '…' : ''}` : ' · 暂无结果'}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section capture-references-section" aria-label="引用与复用">
        <div className="section-head">
          <h3>引用与复用</h3>
          <span className="hint">尝试之间真实发生的引用，不是模型推断</span>
        </div>
        <p className="hint">
          这里显示这条念头下的尝试「我参考了什么」，以及后来哪些尝试「用过这条结果」。结果文本按引用当时的快照保留；来源有更新时会单独标出。
        </p>
        {linksError && (
          <p className="error-msg" role="alert">
            引用关系这次没读到（{linksError}）。可以在上方「关联记录」里重试，这不代表引用关系不存在。
          </p>
        )}
        {!linksError && (
        <div className="link-columns">
          <div className="link-column">
            <h4>
              我参考了什么{' '}
              <span className="muted">({references?.out.length ?? 0})</span>
            </h4>
            {(references?.out.length ?? 0) === 0 ? (
              <p className="empty-state">这条念头下的尝试还没有引用过旧结果。</p>
            ) : (
              <ul className="capture-ref-list">
                {(references?.out ?? []).map((ref) => (
                  <li key={ref.id} className="capture-ref-row" data-testid="capture-reference-out">
                    <p className="capture-ref-title">
                      <Link to={`/attempt/${ref.from.id}`}>{ref.from.step}</Link>
                      <span className="capture-ref-arrow">引用了</span>
                      <Link to={`/attempt/${ref.to.id}`}>{ref.to.step}</Link>
                    </p>
                    <p className="capture-ref-snapshot">
                      引用时的结果：{ref.snapshotResultText || '（当时无结果）'}
                    </p>
                    {ref.to.updatedSinceSnapshot && (
                      <span className="badge warn">来源有更新</span>
                    )}
                    {ref.note && <p className="capture-ref-note">说明：{ref.note}</p>}
                    <p className="capture-ref-meta">
                      来自「{ref.to.captureText.slice(0, 40)}
                      {ref.to.captureText.length > 40 ? '…' : ''}」 · {formatTime(ref.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="link-column">
            <h4>
              后来哪里用过这条结果{' '}
              <span className="muted">({references?.in.length ?? 0})</span>
            </h4>
            {(references?.in.length ?? 0) === 0 ? (
              <p className="empty-state">还没有其他尝试引用这里的结果。</p>
            ) : (
              <ul className="capture-ref-list">
                {(references?.in ?? []).map((ref) => (
                  <li key={ref.id} className="capture-ref-row" data-testid="capture-reference-in">
                    <p className="capture-ref-title">
                      <Link to={`/attempt/${ref.from.id}`}>{ref.from.step}</Link>
                      <span className="capture-ref-arrow">引用了</span>
                      <Link to={`/attempt/${ref.to.id}`}>{ref.to.step}</Link>
                    </p>
                    <p className="capture-ref-snapshot">
                      引用时的结果：{ref.snapshotResultText || '（当时无结果）'}
                    </p>
                    {ref.note && <p className="capture-ref-note">用途：{ref.note}</p>}
                    <p className="capture-ref-meta">
                      来自「{ref.from.captureText.slice(0, 40)}
                      {ref.from.captureText.length > 40 ? '…' : ''}」 · {formatTime(ref.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        )}
      </section>

      {preview && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="删除确认">
          <div className="modal">
            <h3>永久删除这条念头？</h3>
            <p>此操作不可撤销。将同时删除：</p>
            <ul className="impact-list">
              <li>{preview.attemptCount} 条尝试</li>
              <li>{preview.referencesToAttempts} 条「其他尝试引用这些结果」的引用</li>
              <li>{preview.referencesFromAttempts} 条「这些尝试引用其他结果」的引用</li>
              {typeof preview.captureLinkCount === 'number' && preview.captureLinkCount > 0 && (
                <li>{preview.captureLinkCount} 条手动关联（两个方向都会解除）</li>
              )}
              {typeof preview.researchCount === 'number' && preview.researchCount > 0 && (
                <li>
                  {preview.researchCount} 次研究记录及其已获取资料（由研究创建的尝试会保留，但「来源研究」会显示已删除）
                </li>
              )}
              {typeof preview.scheduleCount === 'number' && (
                <li>{preview.scheduleCount} 条日程安排（含已取消）</li>
              )}
              {typeof preview.generationCount === 'number' && preview.generationCount > 0 && (
                <li>{preview.generationCount} 条 AI 生成记录</li>
              )}
            </ul>
            <p className="muted">其他念头和尝试会保留。</p>
            {preview.affectedExperiences && preview.affectedExperiences.length > 0 && (
              <div className="delete-affected">
                <h4>会受影响的经验</h4>
                <ul className="impact-list">
                  {preview.affectedExperiences.map((impact) => (
                    <li key={impact.id}>
                      《{impact.title}》：{impact.deletedSourceCount} 条依据会被清理；
                      {impact.willClearUnderstanding
                        ? '模型整理的正文会保守清空并标记待修订。'
                        : '正文保留并标记建议重新核对。'}
                    </li>
                  ))}
                </ul>
                <p className="hint">受影响经验的来源正文快照也会清理，不会只在界面隐藏。</p>
              </div>
            )}
            <div className="row-actions">
              <button className="btn danger" onClick={confirmDelete} disabled={deleting}>
                {deleting ? '删除中…' : '确认删除'}
              </button>
              <button className="btn" onClick={() => { setPreview(null); setDeleteError(null); }} disabled={deleting}>取消</button>
            </div>
            {deleteError && (
              <p className="error-msg" role="alert" data-testid="capture-delete-modal-error">
                {deleteError}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
