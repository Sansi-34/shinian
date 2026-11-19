// 主题导出 Markdown：预览范围、勾选一跳依据、确认下载 ZIP。
import { useEffect, useRef, useState } from 'react';
import api, { ApiError } from '../api';
import type {
  TopicExportBasisCandidate,
  TopicExportEntityType,
  TopicExportFileEntry,
  TopicExportLimitKey,
  TopicExportPreview,
} from '../types';

type Props = {
  topicId: string;
  topicName?: string;
  onClose: () => void;
  /** 下载开始后的提示，交给主题页在面板关闭后继续显示。 */
  onDownloaded?: (message: string) => void;
};

type Busy = 'initial' | 'refresh' | null;

type ExportError = {
  message: string;
  retryable: boolean;
};

type FileGroup = {
  type: string;
  label: string;
  files: TopicExportFileEntry[];
};

const INDEPENDENT_COPY_NOTICE =
  '独立副本，之后在拾念中的修改或删除不会自动更新已下载文件。';

const FILE_TYPE_LABEL: Record<string, string> = {
  index: '索引',
  readme: '说明',
  manifest: '清单',
  thought: '念头',
  experience: '经验',
  attempt: '尝试',
};

const FILE_TYPE_ORDER: TopicExportEntityType[] = [
  'index',
  'readme',
  'manifest',
  'thought',
  'experience',
  'attempt',
];

const OMITTED_LABEL: Array<{
  key: 'manualLink' | 'attemptReference' | 'experienceSource' | 'experienceAdoption';
  label: string;
}> = [
  { key: 'manualLink', label: '手动关联' },
  { key: 'attemptReference', label: '尝试引用' },
  { key: 'experienceSource', label: '经验依据' },
  { key: 'experienceAdoption', label: '经验采用' },
];

const LIMIT_LABEL: Record<TopicExportLimitKey, string> = {
  files: '文件数',
  attempts: '尝试数',
  bytes: 'ZIP 大小',
};

function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function groupFiles(files: TopicExportFileEntry[]): FileGroup[] {
  const groups = new Map<string, TopicExportFileEntry[]>();
  for (const file of files) {
    const type = FILE_TYPE_ORDER.includes(file.entityType) ? file.entityType : 'other';
    const list = groups.get(type);
    if (list) list.push(file);
    else groups.set(type, [file]);
  }
  const order = [...FILE_TYPE_ORDER, 'other'];
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const indexA = order.indexOf(a as TopicExportEntityType | 'other');
      const indexB = order.indexOf(b as TopicExportEntityType | 'other');
      return (indexA < 0 ? order.length : indexA) - (indexB < 0 ? order.length : indexB);
    })
    .map(([type, list]) => ({
      type,
      label: FILE_TYPE_LABEL[type] ?? type,
      files: list,
    }));
}

function invalidBasisKeys(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.status !== 400) return [];
  const body = error.body ?? {};
  if (body.field !== 'includeBasisKeys' || !Array.isArray(body.invalidKeys)) return [];
  return body.invalidKeys.filter((key: unknown): key is string => typeof key === 'string');
}

function previewErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (typeof error.body?.message === 'string' && error.body.message) {
      return error.body.message;
    }
    if (error.status === 404) return '主题已不存在。';
    if (error.status === 401) return '登录状态已失效，请重新登录后再试。';
    return `读取导出预览失败（HTTP ${error.status}），请重试。`;
  }
  if (error instanceof TypeError) return '网络连接失败，请检查网络后重试。';
  return '读取导出预览失败，请重试。';
}

function exportErrorText(error: unknown): ExportError {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return { message: '主题已不存在。', retryable: false };
    }
    if (error.status === 401) {
      return { message: '登录状态已失效，请重新登录后再试。', retryable: false };
    }
    if (error.status === 400) {
      return {
        message:
          typeof error.body?.message === 'string' && error.body.message
            ? error.body.message
            : '导出请求无效，请调整范围后重试。',
        retryable: false,
      };
    }
    return {
      message:
        typeof error.body?.message === 'string' && error.body.message
          ? error.body.message
          : '导出失败，请稍后重试。',
      retryable: error.status >= 500,
    };
  }
  if (error instanceof TypeError) {
    return { message: '网络连接失败，请检查网络后重试。', retryable: true };
  }
  return { message: '导出失败，请重试。', retryable: true };
}

function limitErrorText(error: ApiError): string {
  const body = error.body ?? {};
  const message =
    typeof body.message === 'string' && body.message
      ? body.message
      : '导出内容超过上限，请缩小范围后重试。';
  const details = body.details ?? {};
  const exceeded: TopicExportLimitKey[] = Array.isArray(details.exceeded)
    ? details.exceeded.filter((key: unknown): key is TopicExportLimitKey =>
        typeof key === 'string' && Object.prototype.hasOwnProperty.call(LIMIT_LABEL, key)
      )
    : [];
  const actual = details.actual ?? {};
  const limits = details.limits ?? {};
  const parts = exceeded.map((key) => {
    if (key === 'bytes') {
      return `${LIMIT_LABEL[key]} ${formatBytes(actual.bytes)} / 上限 ${formatBytes(
        limits.maxBytes
      )}`;
    }
    if (key === 'files') {
      return `${LIMIT_LABEL[key]} ${actual.files ?? '—'} / 上限 ${limits.maxFiles ?? '—'}`;
    }
    return `${LIMIT_LABEL[key]} ${actual.attempts ?? '—'} / 上限 ${limits.maxAttempts ?? '—'}`;
  });
  const detailsText = parts.length > 0 ? `（${parts.join('；')}）` : '';
  return `${message}${detailsText} 建议：取消勾选归档记录、减少追加依据，或缩小主题范围后重试。`;
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function TopicExportPanel({
  topicId,
  topicName,
  onClose,
  onDownloaded,
}: Props) {
  const [includeArchived, setIncludeArchived] = useState(true);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<TopicExportPreview | null>(null);
  const [busy, setBusy] = useState<Busy>('initial');
  const [downloading, setDownloading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<ExportError | null>(null);
  const [scopeNotice, setScopeNotice] = useState<string | null>(null);
  const [panelNotice, setPanelNotice] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const previewSeq = useRef(0);

  async function requestPreview(options: {
    includeArchived: boolean;
    basisKeys: string[];
    mode: 'initial' | 'refresh';
    allowInvalidRetry?: boolean;
    keepNotice?: boolean;
  }) {
    const seq = ++previewSeq.current;
    setBusy(options.mode);
    setPreviewError(null);
    if (!options.keepNotice) setPanelNotice(null);
    try {
      const result = await api.previewTopicExport(topicId, {
        includeArchived: options.includeArchived,
        includeBasisKeys: options.basisKeys,
      });
      if (seq !== previewSeq.current) return;
      setPreview(result);
      setIncludeArchived(result.scope.includeArchived);
      setSelectedKeys(new Set(result.scope.includeBasisKeys));
    } catch (error) {
      if (seq !== previewSeq.current) return;
      const invalid =
        options.allowInvalidRetry !== false ? invalidBasisKeys(error) : [];
      if (invalid.length > 0) {
        const nextKeys = options.basisKeys.filter((key) => !invalid.includes(key));
        setSelectedKeys(new Set(nextKeys));
        setPanelNotice('部分依据已不在范围内，已取消选择。');
        await requestPreview({
          ...options,
          basisKeys: nextKeys,
          allowInvalidRetry: false,
          keepNotice: true,
        });
        return;
      }
      setPreviewError(previewErrorText(error));
    } finally {
      if (seq === previewSeq.current) setBusy(null);
    }
  }

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    setPreview(null);
    setPreviewError(null);
    setExportError(null);
    setScopeNotice(null);
    setPanelNotice(null);
    setDownloaded(null);
    setSelectedKeys(new Set());
    setIncludeArchived(true);
    void requestPreview({
      includeArchived: true,
      basisKeys: [],
      mode: 'initial',
      allowInvalidRetry: true,
    });
    const frame = window.requestAnimationFrame(() => {
      closeRef.current?.focus();
    });
    return () => {
      previewSeq.current += 1;
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || downloading) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [downloading, onClose]);

  function handlePanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const candidates = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])'
      )
    ).filter(
      (element) =>
        !element.hasAttribute('disabled') &&
        (element === document.activeElement || element.getClientRects().length > 0)
    );
    if (candidates.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = candidates[0];
    const last = candidates[candidates.length - 1];
    if (event.shiftKey) {
      if (document.activeElement === first || document.activeElement === panel) {
        event.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function toggleArchived() {
    if (busy !== null || downloading) return;
    const next = !includeArchived;
    setIncludeArchived(next);
    setScopeNotice(null);
    setExportError(null);
    setDownloaded(null);
    void requestPreview({
      includeArchived: next,
      basisKeys: [...selectedKeys],
      mode: 'refresh',
      allowInvalidRetry: true,
    });
  }

  function toggleBasis(candidate: TopicExportBasisCandidate) {
    if (
      busy !== null ||
      downloading ||
      !candidate.selectable ||
      candidate.deleted
    ) {
      return;
    }
    const next = new Set(selectedKeys);
    if (next.has(candidate.sourceKey)) next.delete(candidate.sourceKey);
    else {
      if (
        preview &&
        next.size >= preview.scope.limits.maxBasisKeys
      ) {
        setPanelNotice(
          `最多只能追加 ${preview.scope.limits.maxBasisKeys} 条一跳依据，请先取消一些选择。`
        );
        return;
      }
      next.add(candidate.sourceKey);
    }
    setSelectedKeys(next);
    setScopeNotice(null);
    setExportError(null);
    setDownloaded(null);
    void requestPreview({
      includeArchived,
      basisKeys: [...next],
      mode: 'refresh',
      allowInvalidRetry: true,
    });
  }

  function retryPreview() {
    if (busy !== null || downloading) return;
    void requestPreview({
      includeArchived,
      basisKeys: [...selectedKeys],
      mode: preview ? 'refresh' : 'initial',
      allowInvalidRetry: true,
    });
  }

  async function downloadZip() {
    if (!preview || busy !== null || downloading || previewError) return;
    if (!preview.canExport || !preview.scopeHash) return;
    setDownloading(true);
    setExportError(null);
    setScopeNotice(null);
    setDownloaded(null);
    try {
      const result = await api.downloadTopicExport(topicId, {
        includeArchived,
        includeBasisKeys: [...selectedKeys],
        expectedScopeHash: preview.scopeHash,
      });
      triggerBlobDownload(result.blob, result.filename);
      setDownloaded(INDEPENDENT_COPY_NOTICE);
      onDownloaded?.(`ZIP 已开始下载。${INDEPENDENT_COPY_NOTICE}`);
    } catch (error) {
      if (error instanceof ApiError && error.body?.error === 'export_scope_changed') {
        const changedKeys = Array.isArray(error.body?.invalidKeys)
          ? error.body.invalidKeys.filter(
              (key: unknown): key is string => typeof key === 'string'
            )
          : [];
        const nextKeys = changedKeys.length
          ? [...selectedKeys].filter((key) => !changedKeys.includes(key))
          : [...selectedKeys];
        if (changedKeys.length > 0) {
          setSelectedKeys(new Set(nextKeys));
          setPanelNotice('部分依据已不在范围内，已取消选择。');
        }
        setScopeNotice('导出范围已变化，已自动刷新预览；请核对后再次确认导出。');
        await requestPreview({
          includeArchived,
          basisKeys: nextKeys,
          mode: 'refresh',
          allowInvalidRetry: true,
          keepNotice: true,
        });
      } else if (
        error instanceof ApiError &&
        error.status === 400 &&
        error.body?.field === 'includeBasisKeys'
      ) {
        const invalidKeys = Array.isArray(error.body.invalidKeys)
          ? error.body.invalidKeys.filter(
              (key: unknown): key is string => typeof key === 'string'
            )
          : [];
        const nextKeys = invalidKeys.length
          ? [...selectedKeys].filter((key) => !invalidKeys.includes(key))
          : [...selectedKeys];
        if (invalidKeys.length > 0) {
          setSelectedKeys(new Set(nextKeys));
          setPanelNotice('部分依据已不在范围内，已取消选择。');
        }
        setScopeNotice('部分依据已不在范围内，已自动刷新预览；请确认后再次导出。');
        await requestPreview({
          includeArchived,
          basisKeys: nextKeys,
          mode: 'refresh',
          allowInvalidRetry: true,
          keepNotice: true,
        });
      } else if (error instanceof ApiError && error.status === 413) {
        setExportError({ message: limitErrorText(error), retryable: false });
      } else {
        setExportError(exportErrorText(error));
      }
    } finally {
      setDownloading(false);
    }
  }

  const groups = preview ? groupFiles(preview.scope.files) : [];
  const selectedBasisCount = preview
    ? preview.scope.counts.basisThoughts +
      preview.scope.counts.basisExperiences +
      preview.scope.counts.basisAttempts
    : 0;
  const blockedReason = !preview
    ? ''
    : preview.scope.limits.exceeded.length > 0
      ? '当前范围超过导出上限，请先调整范围。'
      : !preview.canExport
        ? '当前范围暂时不可导出，请查看上方提示。'
        : !preview.scopeHash
          ? '预览校验值缺失，请重新预览。'
          : '';
  const confirmDisabled =
    busy !== null ||
    downloading ||
    !preview ||
    Boolean(previewError) ||
    !preview.canExport ||
    !preview.scopeHash;

  return (
    <div
      className="topic-export-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !downloading) onClose();
      }}
    >
      <section
        className="topic-export-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="topic-export-title"
        aria-describedby="topic-export-desc"
        aria-busy={busy !== null || downloading}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={handlePanelKeyDown}
        data-testid="topic-export-panel"
      >
        <div className="topic-export-head">
          <div className="topic-export-head-main">
            <p className="page-kicker">Markdown ZIP</p>
            <h2 id="topic-export-title">导出主题</h2>
            <p className="topic-export-sub" id="topic-export-desc">
              {preview
                ? `「${preview.topic.title || topicName || '这个主题'}」导出为 Markdown 文件包，只读取当前数据，不会修改拾念。`
                : `「${topicName || '这个主题'}」导出为 Markdown 文件包，只读取当前数据，不会修改拾念。`}
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            ref={closeRef}
            onClick={onClose}
            disabled={downloading}
            aria-label="关闭导出面板"
            data-testid="topic-export-close"
          >
            ×
          </button>
        </div>

        <div className="topic-export-body">
          {busy === 'initial' && !preview ? (
            <p className="muted loading-line" role="status">
              <span className="spinner" aria-hidden="true" /> 正在读取导出范围…
            </p>
          ) : previewError && !preview ? (
            <div className="topic-export-error" role="alert">
              <p>{previewError}</p>
              <button type="button" className="btn small" onClick={retryPreview}>
                重试预览
              </button>
            </div>
          ) : preview ? (
            <>
              {previewError && (
                <div className="topic-export-error" role="alert">
                  <p>{previewError}</p>
                  <button type="button" className="btn small" onClick={retryPreview}>
                    重试预览
                  </button>
                </div>
              )}

              {scopeNotice && (
                <p className="topic-export-scope-notice" role="alert">
                  {scopeNotice}
                </p>
              )}
              {panelNotice && (
                <p className="topic-export-notice" role="status">
                  {panelNotice}
                </p>
              )}
              {downloaded && (
                <div className="topic-export-success" role="status">
                  <p>{downloaded}</p>
                  <p className="hint">ZIP 已保存到你选择的位置；拾念不会追踪或同步这份副本。</p>
                </div>
              )}
              {exportError && (
                <div className="topic-export-error" role="alert">
                  <p>{exportError.message}</p>
                  {exportError.retryable && (
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => void downloadZip()}
                      disabled={downloading || busy !== null}
                    >
                      重试下载
                    </button>
                  )}
                </div>
              )}

              <div className="topic-export-topic-state">
                <span className="badge">{preview.topic.archived ? '主题已归档' : '主题未归档'}</span>
                <span className="hint">版本 {preview.topic.revision}</span>
                {preview.scope.archived.members > 0 && (
                  <span className="hint">
                    归档成员 {preview.scope.archived.members} 条（念头{' '}
                    {preview.scope.archived.thoughts} · 经验{' '}
                    {preview.scope.archived.experiences}）
                  </span>
                )}
              </div>

              <dl className="topic-export-counts" data-testid="topic-export-summary">
                <div className="topic-export-count">
                  <dt>念头</dt>
                  <dd>{preview.scope.counts.thoughts}</dd>
                </div>
                <div className="topic-export-count">
                  <dt>经验</dt>
                  <dd>{preview.scope.counts.experiences}</dd>
                </div>
                <div className="topic-export-count">
                  <dt>尝试</dt>
                  <dd>{preview.scope.counts.attempts}</dd>
                </div>
                <div className="topic-export-count">
                  <dt>文件数</dt>
                  <dd>{preview.scope.counts.files}</dd>
                </div>
                <div className="topic-export-count">
                  <dt>预计大小</dt>
                  <dd>{formatBytes(preview.scope.estimatedBytes)}</dd>
                </div>
              </dl>
              {selectedBasisCount > 0 && (
                <p className="topic-export-basis-summary-line hint">
                  已追加一跳依据：念头 {preview.scope.counts.basisThoughts} · 经验{' '}
                  {preview.scope.counts.basisExperiences} · 尝试{' '}
                  {preview.scope.counts.basisAttempts}
                </p>
              )}

              <label className="topic-export-toggle">
                <input
                  type="checkbox"
                  checked={includeArchived}
                  disabled={busy !== null || downloading}
                  onChange={toggleArchived}
                  data-testid="topic-export-include-archived"
                />
                <span className="topic-export-toggle-main">
                  <strong>包含归档记录</strong>
                  <span className="field-hint">
                    默认包含主题内已归档的普通念头、经验及其尝试；关闭后重新预览，归档记录不会写入 ZIP。
                  </span>
                </span>
              </label>

              <details className="topic-export-files" data-testid="topic-export-files">
                <summary data-testid="topic-export-files-toggle">
                  <span>文件清单</span>
                  <span className="badge">{preview.scope.counts.files}</span>
                  <span className="hint">展开查看 path 与标题</span>
                </summary>
                <div className="topic-export-file-groups">
                  {groups.map((group) => (
                    <details className="topic-export-file-group" key={group.type}>
                      <summary>
                        <span>{group.label}</span>
                        <span className="hint">{group.files.length} 个文件</span>
                      </summary>
                      <ul className="topic-export-file-list">
                        {group.files.map((file, index) => (
                          <li
                            className="topic-export-file"
                            key={`${file.path}:${index}`}
                          >
                            <code className="topic-export-file-path">{file.path}</code>
                            <span className="topic-export-file-title">{file.title}</span>
                            <span className="topic-export-file-flags">
                              {file.archived && <span className="badge">已归档</span>}
                              {file.basis && <span className="badge ai-kind">一跳依据</span>}
                              {file.revision != null && (
                                <span className="hint">版本 {file.revision}</span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </div>
              </details>

              <section
                className="topic-export-section"
                aria-labelledby="topic-export-basis-title"
              >
                <div className="topic-export-section-head">
                  <h3 id="topic-export-basis-title">可追加的一跳直接依据</h3>
                  <span className="hint">
                    已选 {selectedKeys.size} / {preview.scope.limits.maxBasisKeys}
                  </span>
                </div>
                <p className="hint">
                  只追加勾选的那一条记录本身，不递归加入它的主题、其他尝试、引用或后续实践；已删除来源不可选。
                </p>
                {preview.scope.basisCandidates.length === 0 ? (
                  <p className="topic-export-empty">
                    没有主题外的一跳直接依据可追加。
                  </p>
                ) : (
                  <ul
                    className="topic-export-basis-list"
                    data-testid="topic-export-basis-list"
                  >
                    {preview.scope.basisCandidates.map((candidate) => {
                      const checked = selectedKeys.has(candidate.sourceKey);
                      const atLimit =
                        !checked &&
                        selectedKeys.size >= preview.scope.limits.maxBasisKeys;
                      const disabled =
                        busy !== null ||
                        downloading ||
                        !candidate.selectable ||
                        candidate.deleted ||
                        atLimit;
                      return (
                        <li key={candidate.sourceKey}>
                          <label
                            className={`topic-export-basis${
                              disabled ? ' is-disabled' : ''
                            }`}
                            title={
                              candidate.deleted
                                ? '来源已删除，不能追加'
                                : atLimit
                                  ? `最多选择 ${preview.scope.limits.maxBasisKeys} 条`
                                  : undefined
                            }
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={disabled}
                              onChange={() => toggleBasis(candidate)}
                              aria-label={`追加一跳依据：${candidate.title}`}
                            />
                            <span className="topic-export-basis-main">
                              <span className="topic-export-basis-head">
                                <span className="badge">
                                  {candidate.entityType === 'thought'
                                    ? '念头'
                                    : '尝试'}
                                </span>
                                {candidate.deleted ? (
                                  <span className="badge">来源已删除</span>
                                ) : (
                                  candidate.reason && (
                                    <span className="hint">{candidate.reason}</span>
                                  )
                                )}
                              </span>
                              <strong className="topic-export-basis-title">
                                {candidate.title}
                              </strong>
                              {candidate.summary && (
                                <span className="topic-export-basis-summary">
                                  {candidate.summary}
                                </span>
                              )}
                              <span className="topic-export-basis-source">
                                来源经验：
                                {candidate.sourceExperienceTitle ||
                                  candidate.referencedBy[0] ||
                                  '（未命名经验）'}
                                {candidate.referencedBy.length > 1
                                  ? ` · 被 ${candidate.referencedBy.length} 份经验引用`
                                  : ''}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section
                className="topic-export-section topic-export-omitted"
                aria-labelledby="topic-export-omitted-title"
              >
                <div className="topic-export-section-head">
                  <h3 id="topic-export-omitted-title">未包含的关联</h3>
                  <span className="badge">{preview.scope.omittedRelations.total}</span>
                </div>
                {preview.scope.omittedRelations.total === 0 ? (
                  <p className="hint">没有因另一端未包含或已删除而省略的关联。</p>
                ) : (
                  <>
                    <p className="hint">
                      共 {preview.scope.omittedRelations.total}{' '}
                      条真实关系因另一端未包含在本次导出或已删除而省略，不会写入 ZIP，也不返回标题。
                    </p>
                    <dl className="topic-export-omitted-list">
                      {OMITTED_LABEL.map((item) => (
                        <div key={item.key}>
                          <dt>{item.label}</dt>
                          <dd>{preview.scope.omittedRelations.byType[item.key]}</dd>
                        </div>
                      ))}
                    </dl>
                  </>
                )}
              </section>

              <section
                className={`topic-export-limits${
                  preview.scope.limits.exceeded.length > 0 ? ' is-exceeded' : ''
                }`}
                aria-labelledby="topic-export-limits-title"
              >
                <h3 id="topic-export-limits-title">限制与提示</h3>
                <p className="topic-export-limits-line">
                  上限：文件 {preview.scope.limits.maxFiles} · 尝试{' '}
                  {preview.scope.limits.maxAttempts} · ZIP{' '}
                  {formatBytes(preview.scope.limits.maxBytes)} · 一跳依据{' '}
                  {preview.scope.limits.maxBasisKeys}
                </p>
                <p className="hint">
                  <strong>超限怎么办：</strong>超过任一上限时，预览仍会显示真实规模，但「下载 ZIP」不能下载
                  （直接请求导出会返回 413）。可以关闭「包含归档记录」、取消勾选已追加的一跳依据，
                  或把一次探索拆成多个主题后重新预览。
                </p>
                {preview.scope.limits.exceeded.length > 0 && (
                  <div className="topic-export-warning" role="alert">
                    <strong>超过导出上限，暂时不能下载 ZIP。</strong>
                    <ul>
                      {preview.scope.limits.exceeded.map((key) => {
                        if (key === 'files') {
                          return (
                            <li key={key}>
                              文件数 {preview.scope.counts.files} / 上限{' '}
                              {preview.scope.limits.maxFiles}
                            </li>
                          );
                        }
                        if (key === 'attempts') {
                          return (
                            <li key={key}>
                              尝试数 {preview.scope.counts.attempts} / 上限{' '}
                              {preview.scope.limits.maxAttempts}
                            </li>
                          );
                        }
                        return (
                          <li key={key}>
                            预计大小 {formatBytes(preview.scope.estimatedBytes)} / 上限{' '}
                            {formatBytes(preview.scope.limits.maxBytes)}
                          </li>
                        );
                      })}
                    </ul>
                    <p className="hint">按上面的办法缩小范围后会重新预览，预览通过才能下载。</p>
                  </div>
                )}
                {preview.scope.warnings.length > 0 && (
                  <ul className="topic-export-warnings" role="status">
                    {preview.scope.warnings.map((warning, index) => (
                      <li key={`${index}:${warning}`}>{warning}</li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : null}
        </div>

        <div className="topic-export-foot">
          <p className="hint topic-export-foot-hint">
            {downloading
              ? '正在生成 ZIP，请稍候…'
              : busy === 'refresh'
                ? '正在更新预览…'
                : previewError
                  ? '预览已失效，请重试后再下载。'
                  : exportError
                    ? '本次导出失败，请查看上方原因。'
                    : blockedReason ||
                      (preview
                        ? `将生成 ${preview.scope.counts.files} 个文件的独立副本。`
                        : '')}
          </p>
          <div className="topic-export-foot-actions">
            <button
              type="button"
              className="btn"
              onClick={onClose}
              disabled={downloading}
            >
              关闭
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => void downloadZip()}
              disabled={confirmDisabled}
              data-testid="topic-export-confirm"
            >
              {downloading ? '生成中…' : '下载 ZIP'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
