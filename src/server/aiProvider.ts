import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText } from 'ai';
import { z } from 'zod';
import {
  AiError,
  createGuardedFetch,
  getAiTestTimeoutMs,
  getAiTimeoutMs,
  type AiErrorCode,
} from './aiSettings';

export const TEST_SYSTEM_PROMPT = '你是连接测试助手。';
export const TEST_USER_PROMPT = '请只回复：连接正常';

export const SUGGESTION_SYSTEM_PROMPT = [
  '你是「拾念」的 AI 辅助助手。围绕用户当前的一个念想，给出一个具体、低负担、能马上开始的小尝试。',
  '只输出一个 JSON 对象，不要输出解释、Markdown 或代码围栏。JSON 字段：',
  '{"kind":"executable|defer|clarify","step":string|null,"why":string,"estimatedMinutes":number|null,"question":string|null,"sources":[{"attemptId":string,"note":string}]}',
  '规则：',
  '- 用户表达忙碌、犹豫或暂时搁置时，kind 用 "defer"，step 为 null，question 为 null，why 说明尊重暂缓。',
  '- 信息不足时，kind 用 "clarify"，step 为 null，estimatedMinutes 为 null，question 只问一个关键问题。',
  '- 其余情况 kind 用 "executable"，step 是一个具体、低负担、能开始的小步骤（不超过 200 字），estimatedMinutes 为 1–120 的整数或 null，question 为 null。',
  '- 如果用户提供了「参考的旧经验」，sources 只能使用其中列出的 attemptId；executable 在有旧经验时至少引用 1 条；defer/clarify 可以引用 0 到所选来源数量。',
  '- 没有提供旧经验时，sources 必须为 []。',
  '- sources[].note 用一句简短说明这条旧经验如何支持当前建议，不超过 200 字。',
  '- 不要在 step/why/question 等用户可读文字中写 attemptId、方括号来源 ID 或内部标识；这些只放在 sources 字段。',
  '- 不编造用户的经历、成果、截止日期或已掌握的能力；不编造旧经验来源。',
  '- 不调用任何工具。',
  '- 简短。',
].join('\n');

export const suggestionSchema = z.object({
  kind: z.enum(['executable', 'defer', 'clarify']),
  step: z.string().trim().max(200).nullable(),
  why: z.string().trim().min(1).max(300),
  estimatedMinutes: z.number().int().min(1).max(120).nullable(),
  question: z.string().trim().min(1).max(200).nullable(),
  sources: z
    .array(
      z.object({
        attemptId: z.string().min(1).max(120),
        note: z.string().trim().min(1).max(200),
      })
    )
    .max(3),
});

export type Suggestion = z.infer<typeof suggestionSchema>;

export type SuggestionSourceForPrompt = {
  attemptId: string;
  step: string;
  resultText: string;
  outcome: string | null;
  observedAt: number | null;
  captureText: string;
};

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ProviderConfig = {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  allowLocal: boolean;
};

export type GenerationResult = {
  suggestion: Suggestion;
  usage: ModelUsage | null;
  durationMs: number;
};

function invalidResponse(detail: string): AiError {
  return new AiError('invalid_response', '响应格式不支持。', detail);
}

/** 剥掉 ```json 围栏，取第一个 { 到最后一个 } 之间的内容。 */
export function extractJsonText(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw invalidResponse('模型返回内容中找不到 JSON 对象。');
  }
  return text.slice(start, end + 1);
}

function semanticError(message: string): AiError {
  return invalidResponse(`建议 JSON 语义校验失败：${message}`);
}

/**
 * 严格解析并做 kind / sources 语义校验。
 * selectedSourceIds 为空表示本次请求没有参考旧经验，此时 sources 必须为 []。
 */
export function parseSuggestionOutput(raw: string, selectedSourceIds: string[] = []): Suggestion {
  const jsonText = extractJsonText(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw invalidResponse('模型返回内容不是合法 JSON。');
  }
  const result = suggestionSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const detail = issue ? `${issue.path.join('.') || 'root'}：${issue.message}` : '字段校验失败。';
    throw invalidResponse(`建议 JSON 字段校验失败：${detail}`);
  }
  const suggestion = result.data;
  const selected = new Set(selectedSourceIds);
  const seen = new Set<string>();
  for (const source of suggestion.sources) {
    if (!selected.has(source.attemptId)) {
      throw semanticError(`sources 包含未选中的来源：${source.attemptId}`);
    }
    if (seen.has(source.attemptId)) {
      throw semanticError(`sources 包含重复来源：${source.attemptId}`);
    }
    seen.add(source.attemptId);
  }
  if (selected.size === 0 && suggestion.sources.length > 0) {
    throw semanticError('本次没有选择旧经验，sources 必须为 []。');
  }
  if (
    suggestion.kind === 'executable' &&
    selected.size > 0 &&
    suggestion.sources.length === 0
  ) {
    throw semanticError('executable 有参考旧经验时至少引用 1 条来源。');
  }
  if (suggestion.kind === 'executable') {
    if (!suggestion.step || !suggestion.step.trim()) {
      throw semanticError('executable 必须提供非空 step。');
    }
    if (suggestion.question !== null) {
      throw semanticError('executable 的 question 必须为 null。');
    }
  } else if (suggestion.kind === 'defer') {
    if (suggestion.step !== null) throw semanticError('defer 的 step 必须为 null。');
    if (suggestion.question !== null) throw semanticError('defer 的 question 必须为 null。');
  } else if (suggestion.kind === 'clarify') {
    if (suggestion.step !== null) throw semanticError('clarify 的 step 必须为 null。');
    if (suggestion.estimatedMinutes !== null) {
      throw semanticError('clarify 的 estimatedMinutes 必须为 null。');
    }
    if (!suggestion.question || !suggestion.question.trim()) {
      throw semanticError('clarify 必须提供非空 question。');
    }
  }
  return suggestion;
}

export function buildSuggestionUserPrompt(
  captureText: string,
  constraint: string | null,
  sources: SuggestionSourceForPrompt[] = []
): string {
  const lines = [`念头原文：`, captureText];
  if (constraint && constraint.trim()) {
    lines.push('', `补充限制：${constraint.trim()}`);
  }
  if (sources.length > 0) {
    lines.push('', '参考的旧经验（只能使用下列方括号中的 attemptId）：');
    for (const source of sources) {
      lines.push(`[${source.attemptId}] 标题：${source.step}`);
      lines.push(`观察：${source.resultText}`);
      if (source.outcome) lines.push(`评价：${source.outcome}`);
      if (source.observedAt) lines.push(`发生时间：${source.observedAt}`);
      if (source.captureText) lines.push(`所属念头：${source.captureText}`);
    }
    lines.push('请只使用上面列出的 attemptId 作为 sources。');
  }
  return lines.join('\n');
}

function mapUsage(usage: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}): ModelUsage | null {
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.totalTokens === undefined
  ) {
    return null;
  }
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
  };
}

export type CallOptions = {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type ModelCallResult = { text: string; usage: ModelUsage | null; durationMs: number };

export async function callModel(
  config: ProviderConfig,
  options: CallOptions
): Promise<ModelCallResult> {
  const provider = createOpenAICompatible({
    name: 'shinian',
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    fetch: createGuardedFetch({ allowLocal: config.allowLocal }),
    includeUsage: true,
  });
  const model = provider.chatModel(config.modelId);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  const startedAt = Date.now();
  try {
    const result = await generateText({
      model,
      system: options.system,
      prompt: options.prompt,
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
      maxRetries: 0,
      abortSignal: controller.signal,
    });
    const text = result.text ?? '';
    if (!text.trim()) {
      throw invalidResponse('模型返回了空文本。');
    }
    return { text, usage: mapUsage(result.usage), durationMs: Date.now() - startedAt };
  } catch (error) {
    // 超时优先于取消判断：超时也通过 abort 触发，但必须归类为 timeout。
    if (timedOut) {
      throw new AiError('timeout', '请求超时。', `请求超过 ${options.timeoutMs}ms 未完成。`);
    }
    if (options.signal?.aborted) {
      throw new AiError('cancelled', '已取消本次生成。', '用户已取消本次生成。');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
  }
}

/** 固定连接测试：不读取任何用户念头。只有非空 assistant 文本才算成功。 */
export async function testConnection(
  config: ProviderConfig
): Promise<{ durationMs: number; usage: ModelUsage | null }> {
  const result = await callModel(config, {
    system: TEST_SYSTEM_PROMPT,
    prompt: TEST_USER_PROMPT,
    maxOutputTokens: 16,
    temperature: 0,
    timeoutMs: getAiTestTimeoutMs(),
  });
  return { durationMs: result.durationMs, usage: result.usage };
}

/** 生成建议：模型调用必须在数据库事务之外。 */
export async function generateSuggestion(
  config: ProviderConfig,
  input: {
    captureText: string;
    constraint: string | null;
    sources?: SuggestionSourceForPrompt[];
    signal?: AbortSignal;
  }
): Promise<GenerationResult> {
  const sources = input.sources ?? [];
  const result = await callModel(config, {
    system: SUGGESTION_SYSTEM_PROMPT,
    prompt: buildSuggestionUserPrompt(input.captureText, input.constraint, sources),
    maxOutputTokens: 300,
    temperature: 0.3,
    timeoutMs: getAiTimeoutMs(),
    signal: input.signal,
  });
  const suggestion = parseSuggestionOutput(
    result.text,
    sources.map((source) => source.attemptId)
  );
  return { suggestion, usage: result.usage, durationMs: result.durationMs };
}

// ---------- 对话式 AI 问答与辅助记录 ----------

const ASSIST_SYSTEM_PROMPT = [
  '你是「拾念」内置的通用 AI 助手兼辅助记录伙伴。你既能像 ChatGPT / Claude 一样直接回答各类问题、分析方案、拆解任务、润色表达、编写或讲解技术细节，也能帮用户把零散的想法与试错过程整理成「念头 + 尝试」记录草案。',
  '',
  '【正文回复要求】',
  '1. 当用户向你提问、求助或让你帮忙完成某项任务时，请直接、详尽、条理清晰地解答（可使用分点、小标题或代码块，不要敷衍成一两句话）。',
  '2. 当用户叙述自己遇到的状况、想法或刚试过的做法时，给出真诚有用的启发或可行建议，同时忠于原意帮他梳理清楚。',
  '3. 当用户只是打招呼（如「你好」「在吗」）或客套致谢时，友好简短回应，欢迎他自由提问或聊聊最近在试的事。',
  '4. 严禁编造用户自身未曾说过的工作经历、实验结果、数字或日期；通用知识请如实作答，不确定的地方坦诚说明。',
  '',
  '【末尾结构化草案标记（供前端一键存为念头使用）】',
  '只要本轮用户输入包含实质性的问题、想法、任务或实验经历（即不是纯打招呼或客套话），请在全部正文回复的最末尾另起一行附上且仅附上一个标记块：',
  '<shinian_draft>',
  '{"autoOpen":boolean,"captureText":string,"attempts":[{"step":string,"state":"todo"|"done","resultText":string|null,"outcome":"success"|"failure"|"undetermined"|null}]}',
  '</shinian_draft>',
  '标记字段规则：',
  '- autoOpen：若用户明显在记录一件事/想法/实验经过，设为 true；若用户主要是提问求助或让 AI 帮忙分析/写作，设为 false。',
  '- captureText：凝练清晰、便于日后回看的一句或一段中文念头（不超过 400 字）。若是问答求助，可总结「想解决的问题与核心方向」。',
  '- attempts（0~3 条）：',
  '  * 用户明确说过某件已做且观察到结果的事 -> state:"done"，填上 step 与忠实概括的 resultText，outcome 选 success/failure/undetermined；',
  '  * 针对待解问题或后续建议中具体可执行的一小步 -> state:"todo"，resultText:null，outcome:null。',
  '- 除上述纯 JSON（单行或多行）外，不要在 <shinian_draft> 标签内写注释，也不要把 JSON 语法带进正文。',
].join('\n');

const assistDraftSchema = z.object({
  shouldRecord: z.boolean().optional().default(true),
  autoOpen: z.boolean().optional().default(true),
  captureText: z.string().trim().max(800),
  attempts: z
    .array(
      z.object({
        step: z.string().trim().min(1).max(300),
        state: z.enum(['todo', 'done']),
        resultText: z.string().trim().max(1000).nullable().optional(),
        outcome: z.enum(['success', 'failure', 'undetermined']).nullable().optional(),
      })
    )
    .max(3)
    .default([]),
});

const assistOutputSchema = z.object({
  reply: z.string().trim().min(1).max(8000),
  draft: assistDraftSchema.nullable().optional(),
});

export type AssistDraftAttempt = {
  step: string;
  state: 'todo' | 'done';
  resultText: string | null;
  outcome: 'success' | 'failure' | 'undetermined' | null;
};

export type AssistDraft = {
  captureText: string;
  attempts: AssistDraftAttempt[];
  autoOpen?: boolean;
};

export type AssistCaptureResult = {
  reply: string;
  draft: AssistDraft | null;
  usage: ModelUsage | null;
  durationMs: number;
};

function normalizeAssistDraft(rawDraft: z.infer<typeof assistDraftSchema>): AssistDraft | null {
  if (rawDraft.shouldRecord === false || !rawDraft.captureText.trim()) {
    return null;
  }
  return {
    captureText: rawDraft.captureText.trim().slice(0, 4000),
    autoOpen: rawDraft.autoOpen !== false,
    attempts: rawDraft.attempts
      .filter((a) => a.step.trim().length > 0)
      .slice(0, 3)
      .map((a) => ({
        step: a.step.trim().slice(0, 500),
        state: a.state,
        resultText: a.state === 'done' && a.resultText ? a.resultText.trim().slice(0, 4000) : null,
        outcome: a.state === 'done' ? a.outcome ?? 'undetermined' : null,
      })),
  };
}

export function parseAssistCaptureOutput(raw: string): { reply: string; draft: AssistDraft | null } {
  const trimmed = raw.trim();

  // 1) 新协议：正文在前，末尾附带 <shinian_draft>...</shinian_draft>
  const tagMatch = trimmed.match(/<shinian_draft>\s*([\s\S]*?)\s*<\/shinian_draft>/i);
  if (tagMatch) {
    const cleanReply = trimmed.slice(0, tagMatch.index).trim() || trimmed.replace(tagMatch[0], '').trim();
    try {
      const jsonText = extractJsonText(tagMatch[1]);
      const parsed = assistDraftSchema.safeParse(JSON.parse(jsonText));
      if (parsed.success) {
        const draft = normalizeAssistDraft(parsed.data);
        if (cleanReply) {
          return { reply: cleanReply, draft };
        }
      }
    } catch {
      /* 标记块 JSON 解析失败时仍保留完整自然回复正文 */
    }
    if (cleanReply) {
      return { reply: cleanReply, draft: null };
    }
  }

  // 防截断兜底：若生成在 <shinian_draft> 中途被截断，剥除未闭合尾巴，避免泄露源码标签
  const unclosedIdx = trimmed.search(/<shinian_draft>/i);
  if (unclosedIdx > 0) {
    return { reply: trimmed.slice(0, unclosedIdx).trim().slice(0, 8000), draft: null };
  }

  // 2) 向后兼容旧格式：{ "reply": ..., "draft": ... }
  if (trimmed.startsWith('{') || trimmed.startsWith('```')) {
    try {
      const jsonText = extractJsonText(trimmed);
      const checked = assistOutputSchema.safeParse(JSON.parse(jsonText));
      if (checked.success) {
        const draft = checked.data.draft ? normalizeAssistDraft(checked.data.draft) : null;
        return { reply: checked.data.reply, draft };
      }
    } catch {
      /* 非结构化纯文本回复，直接按自然正文展示 */
    }
  }

  return { reply: trimmed.slice(0, 8000), draft: null };
}

const DRAFT_OPEN_TAG = '<shinian_draft>';

/** 计算流式推送期间可安全展示给用户的前缀文本，隐藏末尾草案标记及未闭合片段 */
export function visibleReplyPrefix(raw: string): string {
  const trimmedLeft = raw.trimStart();
  if (!trimmedLeft) return '';
  // 若偶发模型按旧 JSON 顶层包壳，暂缓至结束解析出 cleanReply 再展示
  if (trimmedLeft.startsWith('{')) return '';

  const lower = raw.toLowerCase();
  const tagIdx = lower.indexOf(DRAFT_OPEN_TAG);
  if (tagIdx >= 0) {
    return raw.slice(0, tagIdx).trimEnd();
  }

  // 检查末尾是否正在吐出半截 <shinian_draft> 标签前缀
  const tailStart = Math.max(0, raw.length - DRAFT_OPEN_TAG.length);
  const lastLt = raw.lastIndexOf('<');
  if (lastLt >= tailStart) {
    const tailLower = raw.slice(lastLt).toLowerCase();
    if (DRAFT_OPEN_TAG.startsWith(tailLower)) {
      return raw.slice(0, lastLt).trimEnd();
    }
  }
  return raw;
}

function buildAssistUserPrompt(input: {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
}): string {
  const lines: string[] = [];
  const hist = (input.history ?? []).slice(-6);
  if (hist.length > 0) {
    lines.push('近期对话上下文：');
    for (const h of hist) {
      lines.push(`${h.role === 'user' ? '用户' : '助手'}：${h.text.slice(0, 1200)}`);
    }
    lines.push('');
  }
  lines.push(`当前用户输入：${input.message}`);
  return lines.join('\n');
}

export async function assistCaptureWithAi(
  config: ProviderConfig,
  input: {
    message: string;
    history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  }
): Promise<AssistCaptureResult> {
  const result = await callModel(config, {
    system: ASSIST_SYSTEM_PROMPT,
    prompt: buildAssistUserPrompt(input),
    maxOutputTokens: 1800,
    temperature: 0.45,
    timeoutMs: Math.max(getAiTimeoutMs(), 90_000),
  });
  const parsed = parseAssistCaptureOutput(result.text);
  return {
    reply: parsed.reply,
    draft: parsed.draft,
    usage: result.usage,
    durationMs: result.durationMs,
  };
}

export async function streamAssistCaptureWithAi(
  config: ProviderConfig,
  input: {
    message: string;
    history?: Array<{ role: 'user' | 'assistant'; text: string }>;
    signal?: AbortSignal;
  },
  onDelta: (visibleFullText: string, deltaText: string) => void
): Promise<AssistCaptureResult> {
  const provider = createOpenAICompatible({
    name: 'shinian',
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    fetch: createGuardedFetch({ allowLocal: config.allowLocal }),
    includeUsage: true,
  });

  const controller = new AbortController();
  const idleTimeoutMs = Math.max(getAiTimeoutMs(), 60_000);
  const totalTimeoutMs = Math.max(getAiTimeoutMs() * 3, 180_000);
  let timedOut = false;

  const totalTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, totalTimeoutMs);

  let idleTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, idleTimeoutMs);

  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleTimeoutMs);
  };

  const onAbort = () => controller.abort();
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener('abort', onAbort, { once: true });
  }

  const startedAt = Date.now();
  let fullRaw = '';
  let emittedLength = 0;

  try {
    const result = streamText({
      model: provider.chatModel(config.modelId),
      system: ASSIST_SYSTEM_PROMPT,
      prompt: buildAssistUserPrompt(input),
      maxOutputTokens: 1800,
      temperature: 0.45,
      maxRetries: 0,
      abortSignal: controller.signal,
    });

    for await (const delta of result.textStream) {
      resetIdle();
      fullRaw += delta;
      const nextVisible = visibleReplyPrefix(fullRaw);
      if (nextVisible.length > emittedLength) {
        const piece = nextVisible.slice(emittedLength);
        emittedLength = nextVisible.length;
        onDelta(nextVisible, piece);
      }
    }

    if (!fullRaw.trim()) {
      throw invalidResponse('模型返回了空文本。');
    }

    const totalUsage = await Promise.resolve(result.totalUsage).catch(() => undefined);
    const parsed = parseAssistCaptureOutput(fullRaw);
    return {
      reply: parsed.reply,
      draft: parsed.draft,
      usage: totalUsage ? mapUsage(totalUsage) : null,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (timedOut) {
      throw new AiError('timeout', '请求超时。', `模型流式响应超时（空闲 > ${idleTimeoutMs}ms 或总耗时超限）。`);
    }
    if (input.signal?.aborted) {
      throw new AiError('cancelled', '已停止生成。', '用户已停止本次生成。');
    }
    throw error;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    if (input.signal) input.signal.removeEventListener('abort', onAbort);
  }
}

export type { AiErrorCode };
