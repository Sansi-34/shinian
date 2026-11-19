// 研究一下：念头详情里的发起面板（预览 → 确认 → 创建研究）
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { ApiError } from '../api';
import type {
  Capture,
  ResearchConstraints,
  ResearchListItem,
  ResearchPreview,
  ResearchSearchInput,
} from '../types';
import { newOperationId, researchErrorText } from '../types';

function emptyConstraints(): ResearchConstraints {
  return { goal: '', environment: '', language: '', timeBudget: '', requirements: '' };
}

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    return e.body?.message || researchErrorText(e.body?.error, fallback);
  }
  return fallback;
}

type Props = {
  capture: Capture;
  onStarted: (researchId: string) => void;
  onClose: () => void;
};

export default function ResearchStarter({ capture, onStarted, onClose }: Props) {
  const [question, setQuestion] = useState(capture.rawText);
  const [constraints, setConstraints] = useState<ResearchConstraints>(emptyConstraints());
  const [mode, setMode] = useState<'keyword' | 'repositories'>('keyword');
  const [query, setQuery] = useState('');
  const [repoInput, setRepoInput] = useState('');
  const [preview, setPreview] = useState<ResearchPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [existing, setExisting] = useState<ResearchListItem[]>([]);
  const [existingError, setExistingError] = useState<string | null>(null);
  const operationIdRef = useRef(newOperationId());
  const submittingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    api
      .listCaptureResearch(capture.id)
      .then((res) => {
        if (alive) setExisting(res.research);
      })
      .catch(() => {
        if (alive) setExistingError('暂时无法读取已有研究记录。');
      });
    return () => {
      alive = false;
    };
  }, [capture.id]);

  function markStale() {
    if (preview) setPreviewStale(true);
  }

  function buildSearch(): ResearchSearchInput {
    if (mode === 'repositories') {
      const repos = repoInput
        .split(/\n|,|，/)
        .map((item) => item.trim())
        .filter(Boolean);
      return { mode: 'repositories', query: null, repos };
    }
    return { mode: 'keyword', query: query.trim(), repos: [] };
  }

  async function loadPreview(e: React.FormEvent) {
    e.preventDefault();
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await api.previewResearch(capture.id, {
        captureRevision: capture.revision,
        question,
        constraints,
        search: buildSearch(),
      });
      setPreview(res);
      setPreviewStale(false);
      operationIdRef.current = newOperationId();
    } catch (err) {
      setPreview(null);
      setPreviewError(errorMessage(err, '无法生成研究预览，请检查输入。'));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function confirmStart() {
    if (!preview || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.createResearch(capture.id, {
        captureRevision: preview.capture.revision,
        question: preview.question,
        constraints: preview.constraints,
        search: preview.search as ResearchSearchInput,
        contextToken: preview.contextToken,
        operationId: operationIdRef.current,
      });
      onStarted(res.research.id);
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      if (apiErr?.body?.currentRevision) {
        setPreviewStale(true);
        setSubmitError('念头在预览后被修改，请重新预览。');
      } else {
        setSubmitError(errorMessage(err, '发起研究失败，请稍后再试。'));
      }
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const constraintsText = Object.entries(preview?.constraints ?? {}).filter(([, value]) => value);

  return (
    <div className="research-starter">
      <form className="attempt-form research-form" onSubmit={loadPreview}>
        <label className="field">
          <span>研究问题</span>
          <textarea
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value);
              markStale();
            }}
            rows={3}
            maxLength={1000}
            placeholder="把念头变成一个可以查资料回答的问题"
            required
          />
          <span className="field-hint">{question.length}/1000 · 默认使用念头原文，可改成更具体的问题</span>
        </label>

        <div className="research-grid">
          <label className="field">
            <span>想实现什么（可选）</span>
            <input
              value={constraints.goal ?? ''}
              onChange={(e) => {
                setConstraints({ ...constraints, goal: e.target.value });
                markStale();
              }}
              maxLength={200}
              placeholder="例如：在本机做一个离线语音唤醒"
            />
          </label>
          <label className="field">
            <span>已有硬件或技术环境（可选）</span>
            <input
              value={constraints.environment ?? ''}
              onChange={(e) => {
                setConstraints({ ...constraints, environment: e.target.value });
                markStale();
              }}
              maxLength={200}
              placeholder="例如：Windows 11 / RTX 5060 / 无树莓派"
            />
          </label>
          <label className="field">
            <span>希望使用的语言（可选）</span>
            <input
              value={constraints.language ?? ''}
              onChange={(e) => {
                setConstraints({ ...constraints, language: e.target.value });
                markStale();
              }}
              maxLength={200}
              placeholder="例如：Python 或 C++"
            />
          </label>
          <label className="field">
            <span>可投入时间（可选）</span>
            <input
              value={constraints.timeBudget ?? ''}
              onChange={(e) => {
                setConstraints({ ...constraints, timeBudget: e.target.value });
                markStale();
              }}
              maxLength={200}
              placeholder="例如：这个周末 4 小时"
            />
          </label>
        </div>

        <label className="field">
          <span>必须满足的条件（可选）</span>
          <input
            value={constraints.requirements ?? ''}
            onChange={(e) => {
              setConstraints({ ...constraints, requirements: e.target.value });
              markStale();
            }}
            maxLength={200}
            placeholder="例如：离线运行、MIT 许可、不依赖云端 API"
          />
        </label>

        <div className="segmented" role="tablist" aria-label="检索方式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'keyword'}
            className={mode === 'keyword' ? 'active' : ''}
            onClick={() => {
              setMode('keyword');
              markStale();
            }}
          >
            按关键词查找
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'repositories'}
            className={mode === 'repositories' ? 'active' : ''}
            onClick={() => {
              setMode('repositories');
              markStale();
            }}
          >
            指定仓库地址
          </button>
        </div>

        {mode === 'keyword' ? (
          <label className="field">
            <span>GitHub 检索词</span>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                markStale();
              }}
              maxLength={256}
              placeholder="例如：offline wake word embedded"
            />
            <span className="field-hint">会原样提交给 GitHub 搜索，最多返回 10 个候选。</span>
          </label>
        ) : (
          <label className="field">
            <span>仓库地址（每行一个）</span>
            <textarea
              value={repoInput}
              onChange={(e) => {
                setRepoInput(e.target.value);
                markStale();
              }}
              rows={3}
              placeholder={'https://github.com/owner/repo\nowner/repo'}
            />
            <span className="field-hint">支持完整 GitHub 链接或 owner/repo，最多 10 个；读取时只会请求固定 API。</span>
          </label>
        )}

        {(!preview || previewStale) && (
          <button className="btn primary" type="submit" disabled={previewLoading}>
            {previewLoading ? '正在整理预览…' : previewStale ? '重新生成预览' : '预览将发送的内容'}
          </button>
        )}
        {previewError && <p className="error-msg" role="alert">{previewError}</p>}
      </form>

      {preview && (
        <div className={`research-preview${previewStale ? ' stale' : ''}`}>
          <div className="section-head compact">
            <h4>发起前确认</h4>
            <span className="badge subtle">预览</span>
          </div>
          <dl className="research-facts">
            <div>
              <dt>提交给 GitHub</dt>
              <dd className="mono">{preview.searchDisplay}</dd>
            </div>
            <div>
              <dt>研究问题</dt>
              <dd>{preview.question}</dd>
            </div>
            {constraintsText.length > 0 && (
              <div>
                <dt>限制</dt>
                <dd>
                  {constraintsText.map(([key, value]) => (
                    <span key={key} className="fact-chip">{value}</span>
                  ))}
                </dd>
              </div>
            )}
            <div>
              <dt>数量限制</dt>
              <dd>
                候选 ≤ {preview.limits.maxCandidates}；深入 ≤ {preview.limits.maxSelected}；单份 README ≤{' '}
                {preview.limits.maxReadmeChars} 字符；GitHub 并发 {preview.limits.concurrency}；模型调用{' '}
                {preview.modelCalls} 次
              </dd>
            </div>
            <div>
              <dt>模型输入</dt>
              <dd>{preview.modelInput.note}</dd>
            </div>
            <div>
              <dt>模型状态</dt>
              <dd>
                {preview.ai.enabled
                  ? `将使用「${preview.ai.config?.name ?? '已配置模型'}」生成对比`
                  : '模型未启用：可以先获取并查看仓库资料，配置模型后再生成对比'}
              </dd>
            </div>
            <div>
              <dt>GitHub 凭据</dt>
              <dd>
                {preview.github.hasToken
                  ? '使用已配置的 Token（只发送给 GitHub API）'
                  : '匿名公开读取（额度较低；可在设置页配置 Token）'}
              </dd>
            </div>
          </dl>
          {previewStale && (
            <p className="hint warn">输入已修改，请先重新生成预览，确认后再发起。</p>
          )}
          <div className="row-actions">
            <button className="btn primary" type="button" onClick={confirmStart} disabled={submitting || previewStale}>
              {submitting ? '正在发起…' : '确认并发起研究'}
            </button>
            <button className="btn ghost" type="button" onClick={onClose} disabled={submitting}>
              收起
            </button>
          </div>
          {submitError && <p className="error-msg" role="alert">{submitError}</p>}
        </div>
      )}

      {(existing.length > 0 || existingError) && (
        <div className="research-history">
          <div className="section-head compact">
            <h4>这条念头的研究记录</h4>
            <span className="hint">{existing.length} 次</span>
          </div>
          {existingError && <p className="hint">{existingError}</p>}
          <ul className="research-history-list">
            {existing.slice(0, 6).map((item) => (
              <li key={item.id}>
                <Link to={`/research/${item.id}`}>
                  <span className="research-history-question">{item.question}</span>
                  <span className="badge subtle">
                    {item.savedAt ? '已保存' : '未保存'} · {item.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
