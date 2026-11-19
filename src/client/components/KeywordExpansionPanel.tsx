// 拾念 SHINIAN · 检索词扩展面板
// 只把问题与当前检索词发给模型，不发送历史记录正文；所有调用均由用户显式触发。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { ApiError } from '../api';
import type { AiSettings } from '../types';
import {
  ASK_MAX_SUGGESTION_TERM_CHARS,
  ASK_MAX_SUGGESTION_TERMS,
  askErrorText,
  newOperationId,
} from '../types';

type KeywordExpansionPanelProps = {
  question: string;
  keywords: string;
  topicId: string | null;
  scopeHash: string | null;
  expandedKeywords: string[];
  onApply: (terms: string[]) => void;
  onClear: () => void;
};

type TermRow = {
  id: string;
  value: string;
  checked: boolean;
};

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const code = e.body?.errorCode ?? e.body?.error;
    return e.body?.message || askErrorText(code, fallback);
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

function errorCodeOf(e: unknown): string | null {
  return e instanceof ApiError ? (e.body?.errorCode ?? e.body?.error ?? null) : null;
}

export default function KeywordExpansionPanel({
  question,
  keywords,
  topicId,
  scopeHash,
  expandedKeywords,
  onApply,
  onClear,
}: KeywordExpansionPanelProps) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [terms, setTerms] = useState<TermRow[]>([]);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generateErrorCode, setGenerateErrorCode] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const seqRef = useRef(0);
  const operationIdRef = useRef(newOperationId());

  const requestKey = `${question}\u0000${keywords}\u0000${topicId ?? ''}\u0000${scopeHash ?? ''}`;
  const requestKeyRef = useRef(requestKey);

  // 问题、检索词或主题范围变化时，取消旧请求并清空面板结果；迟到响应会被 seq/key 双重丢弃。
  useEffect(() => {
    requestKeyRef.current = requestKey;
    seqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    inFlightRef.current = false;
    operationIdRef.current = newOperationId();
    setGenerating(false);
    setTerms([]);
    setGenerated(false);
    setGenerateError(null);
    setGenerateErrorCode(null);
    setOpen(false);
  }, [requestKey]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const config = settings?.config ?? null;
  const configured = Boolean(settings?.configured && config?.hasApiKey);
  const enabled = Boolean(config?.enabled);
  const selectedCount = useMemo(
    () => terms.filter((term) => term.checked && term.value.trim()).length,
    [terms]
  );
  const canGenerate = Boolean(
    question.trim() && config && configured && enabled && !settingsLoading && !generating
  );

  async function loadSettings() {
    if (settingsLoading) return;
    setSettingsLoading(true);
    setSettingsError(null);
    try {
      const res = await api.getAiSettings();
      setSettings(res);
    } catch (e) {
      setSettingsError(errorMessage(e, '无法读取模型配置'));
    } finally {
      setSettingsLoading(false);
    }
  }

  function closePanel() {
    abortRef.current?.abort();
    abortRef.current = null;
    inFlightRef.current = false;
    seqRef.current += 1;
    setGenerating(false);
    setOpen(false);
  }

  function togglePanel() {
    if (open) {
      closePanel();
      return;
    }
    setOpen(true);
    setGenerateError(null);
    setGenerateErrorCode(null);
    if (!settings && !settingsLoading) void loadSettings();
  }

  async function generateTerms() {
    if (!canGenerate || inFlightRef.current) return;
    if (!config) {
      setGenerateErrorCode('ai_not_configured');
      setGenerateError('尚未配置 AI 模型，不能生成替代词。');
      return;
    }
    if (!configured) {
      setGenerateErrorCode('ai_not_configured');
      setGenerateError('尚未配置模型 API Key，不能生成替代词。请先去设置。');
      return;
    }
    if (!enabled) {
      setGenerateErrorCode('ai_disabled');
      setGenerateError('AI 模型已停用，不能生成替代词。请先去设置启用。');
      return;
    }

    const controller = new AbortController();
    const seq = ++seqRef.current;
    const keyAtStart = requestKeyRef.current;
    abortRef.current = controller;
    inFlightRef.current = true;
    setGenerating(true);
    setGenerated(false);
    setTerms([]);
    setGenerateError(null);
    setGenerateErrorCode(null);

    try {
      const res = await api.suggestAskKeywords(
        {
          operationId: operationIdRef.current,
          question: question.trim(),
          keywords: keywords.trim() ? keywords : undefined,
          topicId,
          scopeHash,
          configVersion: config.configVersion,
        },
        { signal: controller.signal }
      );
      if (
        controller.signal.aborted ||
        seq !== seqRef.current ||
        keyAtStart !== requestKeyRef.current
      ) {
        return;
      }
      setTerms(
        res.terms.slice(0, ASK_MAX_SUGGESTION_TERMS).map((value, index) => ({
          id: `${index}-${value}`,
          value,
          checked: false,
        }))
      );
      setGenerated(true);
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              config: prev.config
                ? {
                    ...prev.config,
                    name: res.config.name,
                    modelId: res.config.modelId,
                    configVersion: res.config.configVersion,
                  }
                : prev.config,
            }
          : prev
      );
      operationIdRef.current = newOperationId();
    } catch (e) {
      if (
        controller.signal.aborted ||
        seq !== seqRef.current ||
        keyAtStart !== requestKeyRef.current
      ) {
        return;
      }
      setGenerateErrorCode(errorCodeOf(e));
      setGenerateError(errorMessage(e, '生成替代词失败，请重试'));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      inFlightRef.current = false;
      if (seq === seqRef.current) setGenerating(false);
    }
  }

  function cancelGeneration() {
    abortRef.current?.abort();
    abortRef.current = null;
    inFlightRef.current = false;
    seqRef.current += 1;
    setGenerating(false);
    setGenerateErrorCode('cancelled');
    setGenerateError('已取消生成替代词。原问题和检索词仍可继续使用。');
  }

  function toggleTerm(id: string) {
    setTerms((prev) =>
      prev.map((term) => (term.id === id ? { ...term, checked: !term.checked } : term))
    );
  }

  function editTerm(id: string, value: string) {
    setTerms((prev) =>
      prev.map((term) => (term.id === id ? { ...term, value } : term))
    );
  }

  function removeTerm(id: string) {
    setTerms((prev) => prev.filter((term) => term.id !== id));
  }

  function applyTerms() {
    const picked: string[] = [];
    const seen = new Set<string>();
    for (const term of terms) {
      const value = term.value.trim();
      if (!term.checked || !value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(value);
      if (picked.length >= ASK_MAX_SUGGESTION_TERMS) break;
    }
    if (picked.length === 0) {
      setGenerateError('请至少勾选 1 个替代词。');
      return;
    }
    setGenerateError(null);
    setGenerateErrorCode(null);
    onApply(picked);
  }

  function clearExpansion() {
    setTerms([]);
    setGenerated(false);
    setGenerateError(null);
    setGenerateErrorCode(null);
    onClear();
  }

  return (
    <div className="ask-expand">
      <div className="ask-expand-trigger-row">
        <button
          type="button"
          className="btn small ask-expand-trigger"
          data-testid="ask-expand-trigger"
          aria-expanded={open}
          aria-controls="ask-expand-panel"
          onClick={togglePanel}
        >
          换些关键词找找
        </button>
        {expandedKeywords.length > 0 && (
          <span className="ask-expand-applied" role="status">
            当前扩展词：{expandedKeywords.join('、')}
          </span>
        )}
      </div>

      {open && (
        <section
          id="ask-expand-panel"
          className="ask-expand-panel"
          data-testid="ask-expand-panel"
          aria-label="换些关键词找找"
        >
          <div className="ask-expand-head">
            <div>
              <h3>换些关键词找找</h3>
              <p className="hint">
                只把下面的问题和当前检索词发给模型，让它建议替代表达；不会发送任何历史记录正文。
              </p>
            </div>
            <button type="button" className="link" onClick={closePanel}>
              收起
            </button>
          </div>

          <dl className="ask-expand-meta">
            <div>
              <dt>将发送的问题</dt>
              <dd>{question.trim() || '（未填写）'}</dd>
            </div>
            <div>
              <dt>当前检索词</dt>
              <dd>{keywords.trim() || '（空，浏览全部）'}</dd>
            </div>
            <div>
              <dt>目标模型</dt>
              <dd>
                {settingsLoading
                  ? '正在读取模型配置…'
                  : config
                    ? `${config.name} · ${config.modelId}`
                    : '未配置'}
                {!settingsLoading && config && !configured && (
                  <span className="badge warn">未配置 API Key</span>
                )}
                {!settingsLoading && config && configured && !enabled && (
                  <span className="badge warn">已停用</span>
                )}
              </dd>
            </div>
          </dl>

          <div className="ask-expand-note">
            <p>会向模型发起一次检索词建议请求，可能产生费用。</p>
            <p>本次不发送历史记录正文；原问题和原检索词不会被替换。</p>
          </div>

          {settingsLoading && (
            <p className="muted loading-line" role="status">
              <span className="spinner" aria-hidden="true" /> 正在读取模型配置…
            </p>
          )}
          {settingsError && (
            <div role="alert" className="ask-expand-error">
              <p className="error-msg">{settingsError}</p>
              <button type="button" className="btn small" onClick={() => void loadSettings()}>
                重试读取配置
              </button>
            </div>
          )}
          {!settingsLoading && !settingsError && !configured && (
            <p className="ask-expand-guidance">
              还没有可用的模型配置，生成按钮已禁用；仍可手动修改检索词并正常查找。
              <Link to="/settings/ai">去设置 AI →</Link>
            </p>
          )}
          {!settingsLoading && !settingsError && configured && !enabled && (
            <p className="ask-expand-guidance">
              AI 模型已停用，生成按钮已禁用；仍可手动修改检索词并正常查找。
              <Link to="/settings/ai">去启用 AI →</Link>
            </p>
          )}

          <div className="ask-expand-generate-row">
            {!generating ? (
              <button
                type="button"
                className="btn primary"
                data-testid="ask-expand-generate"
                onClick={() => void generateTerms()}
                disabled={!canGenerate}
              >
                生成替代词
              </button>
            ) : (
              <button type="button" className="btn" onClick={cancelGeneration}>
                取消生成
              </button>
            )}
            <span className="hint">最多 5 个短词；生成后默认不勾选。</span>
          </div>
          {!question.trim() && (
            <p className="hint">先写下想问的问题，才能生成替代词。</p>
          )}

          {generateError && (
            <div className="ask-expand-error" role="alert">
              <p className="error-msg">{generateError}</p>
              {(generateErrorCode === 'ai_not_configured' ||
                generateErrorCode === 'ai_disabled') && (
                <Link className="btn small" to="/settings/ai">
                  去设置
                </Link>
              )}
              {generateErrorCode === 'config_changed' && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setSettings(null);
                    void loadSettings();
                  }}
                >
                  重新读取配置
                </button>
              )}
              {generateErrorCode === 'topic_scope_changed' && (
                <span className="hint">主题范围已变化，请重新检索后再试。</span>
              )}
            </div>
          )}

          {generated && terms.length === 0 && (
            <p className="ask-expand-empty" role="status">
              这次没有生成可用的替代词，可以手动修改检索词继续查找。
            </p>
          )}

          {terms.length > 0 && (
            <>
              <div className="ask-expand-terms-head">
                <strong>候选替代词</strong>
                <span className="hint">
                  已勾选 {selectedCount} / {terms.length}
                </span>
              </div>
              <ul className="ask-expand-term-list">
                {terms.map((term) => (
                  <li className="ask-expand-term-row" key={term.id} data-testid="ask-expand-term">
                    <label className="ask-expand-term-check">
                      <input
                        type="checkbox"
                        checked={term.checked}
                        onChange={() => toggleTerm(term.id)}
                        aria-label={`使用替代词 ${term.value}`}
                      />
                    </label>
                    <input
                      type="text"
                      className="ask-expand-term-input"
                      data-testid="ask-expand-term-input"
                      value={term.value}
                      maxLength={ASK_MAX_SUGGESTION_TERM_CHARS}
                      aria-label="编辑替代词"
                      onChange={(e) => editTerm(term.id, e.target.value)}
                    />
                    <button
                      type="button"
                      className="link"
                      onClick={() => removeTerm(term.id)}
                      aria-label={`移除替代词 ${term.value}`}
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ul>
              <div className="ask-expand-actions">
                <button
                  type="button"
                  className="btn primary"
                  data-testid="ask-expand-apply"
                  onClick={applyTerms}
                  disabled={selectedCount === 0 || generating}
                >
                  用这些词查找
                </button>
                {expandedKeywords.length > 0 && (
                  <button
                    type="button"
                    className="btn"
                    data-testid="ask-expand-clear"
                    onClick={clearExpansion}
                  >
                    清除扩展
                  </button>
                )}
              </div>
            </>
          )}

          {terms.length === 0 && expandedKeywords.length > 0 && (
            <div className="ask-expand-actions">
              <button
                type="button"
                className="btn"
                data-testid="ask-expand-clear"
                onClick={clearExpansion}
              >
                清除扩展
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
