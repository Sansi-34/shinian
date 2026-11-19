import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
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

export type { AiErrorCode };
