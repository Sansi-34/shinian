// 研究一下：念头详情与研究列表里的发起面板（确认问题与范围 → 预览 → 发起研究）
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
import { RESEARCH_STATUS_LABEL, newOperationId, researchErrorText } from '../types';
import styles from './ResearchStarter.module.css';

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
  const [constraintsOpen, setConstraintsOpen] = useState(false);
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

  const filledConstraintsCount = Object.values(constraints).filter((v) => Boolean(v && v.trim())).length;
  const constraintsText = Object.entries(preview?.constraints ?? {}).filter(([, value]) => value);

  return (
    <div className={styles.root}>
      <form className={styles.form} onSubmit={loadPreview}>
        {/* 1. 核心：研究问题 */}
        <label className={styles.field}>
          <span className={styles.labelRow}>
            <span className={styles.label}>研究问题</span>
            <span className={styles.counter}>{question.length} / 1000</span>
          </span>
          <textarea
            className={styles.textarea}
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value);
              markStale();
            }}
            rows={3}
            maxLength={1000}
            placeholder="把念头收窄成一个可以查开源资料回答的具体问题"
            required
          />
          <span className={styles.hint}>默认带入念头原文，可改成更具体的技术问题。</span>
        </label>

        {/* 2. 核心：GitHub 检索范围 */}
        <div className={styles.scopeSection}>
          <div className={styles.scopeHeader}>
            <span className={styles.label}>查找方式</span>
            <div className={styles.segment} role="tablist" aria-label="检索方式">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'keyword'}
                className={`${styles.segBtn}${mode === 'keyword' ? ` ${styles.segBtnActive}` : ''}`}
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
                className={`${styles.segBtn}${mode === 'repositories' ? ` ${styles.segBtnActive}` : ''}`}
                onClick={() => {
                  setMode('repositories');
                  markStale();
                }}
              >
                指定仓库地址
              </button>
            </div>
          </div>

          {mode === 'keyword' ? (
            <label className={styles.field}>
              <span className={styles.labelRow}>
                <span className={styles.label}>GitHub 检索词</span>
                <span className={styles.counter}>最多返回 10 个候选</span>
              </span>
              <input
                className={styles.input}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  markStale();
                }}
                maxLength={256}
                placeholder="例如：ros2 differential drive robot car"
              />
              <span className={styles.hint}>会原样提交给 GitHub 搜索，建议用英文技术关键词。</span>
            </label>
          ) : (
            <label className={styles.field}>
              <span className={styles.labelRow}>
                <span className={styles.label}>仓库地址（每行一个）</span>
                <span className={styles.counter}>最多 10 个仓库</span>
              </span>
              <textarea
                className={styles.textarea}
                value={repoInput}
                onChange={(e) => {
                  setRepoInput(e.target.value);
                  markStale();
                }}
                rows={3}
                placeholder={'https://github.com/owner/repo\nowner/repo'}
              />
              <span className={styles.hint}>支持完整 GitHub 链接或 owner/repo，只通过公开只读 API 读取。</span>
            </label>
          )}
        </div>

        {/* 3. 次级：补充约束条件（折叠收纳，避免淹没主操作） */}
        <div className={styles.constraintsBox}>
          <button
            type="button"
            className={styles.constraintsToggle}
            aria-expanded={constraintsOpen}
            onClick={() => setConstraintsOpen((v) => !v)}
          >
            <span className={styles.constraintsTitleWrap}>
              <span className={styles.constraintsTitle}>补充限制条件（可选）</span>
              {filledConstraintsCount > 0 && (
                <span className={styles.constraintsCount}>已填 {filledConstraintsCount} 项</span>
              )}
            </span>
            <span className={styles.constraintsMeta}>
              <span>目标 / 环境 / 语言 / 时间 / 必选条件</span>
              <span className={`${styles.chevron}${constraintsOpen ? ` ${styles.chevronOpen}` : ''}`} aria-hidden="true">
                ▾
              </span>
            </span>
          </button>

          {constraintsOpen && (
            <div className={styles.constraintsBody}>
              <div className={styles.grid}>
                <label className={styles.field}>
                  <span className={styles.label}>想实现什么</span>
                  <input
                    className={`${styles.input} ${styles.compactInput}`}
                    value={constraints.goal ?? ''}
                    onChange={(e) => {
                      setConstraints({ ...constraints, goal: e.target.value });
                      markStale();
                    }}
                    maxLength={200}
                    placeholder="例如：在本机做离线语音唤醒"
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>已有硬件或技术环境</span>
                  <input
                    className={`${styles.input} ${styles.compactInput}`}
                    value={constraints.environment ?? ''}
                    onChange={(e) => {
                      setConstraints({ ...constraints, environment: e.target.value });
                      markStale();
                    }}
                    maxLength={200}
                    placeholder="例如：树莓派 / ESP32 / Windows"
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>希望使用的语言</span>
                  <input
                    className={`${styles.input} ${styles.compactInput}`}
                    value={constraints.language ?? ''}
                    onChange={(e) => {
                      setConstraints({ ...constraints, language: e.target.value });
                      markStale();
                    }}
                    maxLength={200}
                    placeholder="例如：Python 或 C++"
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>可投入时间</span>
                  <input
                    className={`${styles.input} ${styles.compactInput}`}
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

              <label className={styles.field}>
                <span className={styles.label}>必须满足的条件</span>
                <input
                  className={`${styles.input} ${styles.compactInput}`}
                  value={constraints.requirements ?? ''}
                  onChange={(e) => {
                    setConstraints({ ...constraints, requirements: e.target.value });
                    markStale();
                  }}
                  maxLength={200}
                  placeholder="例如：离线运行、MIT 许可、不依赖云端 API"
                />
              </label>
            </div>
          )}
        </div>

        {previewError && (
          <p className={styles.errorBox} role="alert">
            {previewError}
          </p>
        )}

        {(!preview || previewStale) && (
          <div className={styles.footerBar}>
            <span className={styles.footerNote}>只读公开仓库 · 先预览再发送</span>
            <div className={styles.actions}>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>
                取消
              </button>
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                type="submit"
                disabled={previewLoading}
              >
                {previewLoading ? '正在整理预览…' : previewStale ? '重新生成预览' : '预览将发送的内容'}
              </button>
            </div>
          </div>
        )}
      </form>

      {/* 步骤 2：发起前确认 */}
      {preview && (
        <div className={`${styles.previewCard}${previewStale ? ` ${styles.previewStale}` : ''}`}>
          <div className={styles.previewHead}>
            <h4 className={styles.previewTitle}>发起前确认</h4>
            <span className={styles.pill}>{previewStale ? '需重新预览' : '待确认'}</span>
          </div>
          <dl className={styles.facts}>
            <div className={styles.factRow}>
              <dt>提交给 GitHub</dt>
              <dd className={styles.mono}>{preview.searchDisplay}</dd>
            </div>
            <div className={styles.factRow}>
              <dt>研究问题</dt>
              <dd>{preview.question}</dd>
            </div>
            {constraintsText.length > 0 && (
              <div className={styles.factRow}>
                <dt>限制条件</dt>
                <dd className={styles.chipList}>
                  {constraintsText.map(([key, value]) => (
                    <span key={key} className={styles.factChip}>
                      {value}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            <div className={styles.factRow}>
              <dt>读取范围</dt>
              <dd>
                候选 ≤ {preview.limits.maxCandidates} · 深入 ≤ {preview.limits.maxSelected} · 单份 README ≤{' '}
                {preview.limits.maxReadmeChars} 字 · 并发 {preview.limits.concurrency} · 模型调用 {preview.modelCalls} 次
              </dd>
            </div>
            <div className={styles.factRow}>
              <dt>模型输入</dt>
              <dd>{preview.modelInput.note}</dd>
            </div>
            <div className={styles.factRow}>
              <dt>模型状态</dt>
              <dd>
                {preview.ai.enabled
                  ? `将使用「${preview.ai.config?.name ?? '已配置模型'}」生成对比`
                  : '模型未启用：可先获取并查看仓库资料，配置模型后再生成对比'}
              </dd>
            </div>
            <div className={styles.factRow}>
              <dt>GitHub 凭据</dt>
              <dd>
                {preview.github.hasToken
                  ? '使用已配置的 Token（只发送给 GitHub API）'
                  : '匿名公开读取（额度较低；可在设置页配置 Token）'}
              </dd>
            </div>
          </dl>

          {previewStale && (
            <p className={`${styles.hint} ${styles.hintWarn}`}>
              上方输入已修改，请先点「重新生成预览」确认最新内容后再发起。
            </p>
          )}
          {submitError && (
            <p className={styles.errorBox} role="alert">
              {submitError}
            </p>
          )}

          <div className={styles.previewFooter}>
            <span className={styles.footerNote}>确认后开始只读检索</span>
            <div className={styles.actions}>
              <button
                className={`${styles.btn} ${styles.btnGhost}`}
                type="button"
                onClick={onClose}
                disabled={submitting}
              >
                收起
              </button>
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                type="button"
                onClick={confirmStart}
                disabled={submitting || previewStale}
              >
                {submitting ? '正在发起…' : '确认并发起研究'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 历史研究记录 */}
      {(existing.length > 0 || existingError) && (
        <div className={styles.history}>
          <div className={styles.previewHead}>
            <span className={styles.label}>这条念头的研究记录</span>
            <span className={styles.counter}>{existing.length} 次</span>
          </div>
          {existingError && <p className={styles.hint}>{existingError}</p>}
          <ul className={styles.historyList}>
            {existing.slice(0, 6).map((item) => (
              <li key={item.id}>
                <Link to={`/research/${item.id}`} className={styles.historyLink}>
                  <span className={styles.historyQuestion}>{item.question}</span>
                  <span className={styles.pill}>
                    {item.savedAt ? '已保存' : '未保存'} · {RESEARCH_STATUS_LABEL[item.status] ?? item.status}
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
