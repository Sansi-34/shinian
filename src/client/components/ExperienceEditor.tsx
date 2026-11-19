// 拾念 SHINIAN · 经验编辑面板
// 只有明确点「保存经验」才创建记录；取消不写库；重复提交由 operationId 幂等。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { ApiError } from '../api';
import type {
  ExperienceDraft,
  ExperienceDraftSource,
  ExperiencePublic,
  ExperienceSource,
} from '../types';
import { OUTCOME_LABEL, formatTime, newOperationId } from '../types';

type EditorSource = {
  sourceKey: string;
  type: 'attempt' | 'capture';
  id: string;
  captureId: string | null;
  title: string;
  text: string;
  resultText: string | null;
  outcome: string | null;
  state: string | null;
  observedAt: number | null;
  openHref: string | null;
  exists: boolean;
  changed: boolean;
  deleted: boolean;
  kind: string;
};

function sourceFromPublic(source: ExperienceSource): EditorSource {
  return {
    sourceKey: source.sourceKey,
    type: source.type,
    id: source.id,
    captureId: source.captureId,
    title: source.title,
    text: source.deleted ? '' : source.text,
    resultText: source.deleted ? null : source.resultText,
    outcome: source.deleted ? null : source.outcome,
    state: source.deleted ? null : source.state,
    observedAt: source.deleted ? null : source.observedAt,
    openHref: source.deleted ? null : source.openHref,
    exists: source.exists,
    changed: source.changed,
    deleted: source.deleted,
    kind: source.kind,
  };
}

function sourceFromDraft(source: ExperienceDraftSource): EditorSource {
  return {
    sourceKey: source.sourceKey,
    type: source.type,
    id: source.id,
    captureId: source.captureId,
    title: source.title,
    text: source.text,
    resultText: source.resultText,
    outcome: source.outcome,
    state: source.state,
    observedAt: source.observedAt,
    openHref: source.openHref,
    exists: source.exists,
    changed: source.changed,
    deleted: false,
    kind: source.kind,
  };
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.body?.message || fallback;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export default function ExperienceEditor({
  mode,
  draft,
  experience,
  onCancel,
  onSaved,
  reviseAttempt,
}: {
  mode: 'create' | 'revise';
  draft?: ExperienceDraft;
  experience?: ExperiencePublic;
  onCancel: () => void;
  onSaved: (experience: ExperiencePublic) => void;
  reviseAttempt?: { id: string; title: string; resultText: string | null; outcome: string | null } | null;
}) {
  const initial = useMemo(() => {
    if (mode === 'revise' && experience) {
      return {
        title: experience.title,
        understanding: experience.understanding,
        conditions: experience.conditions,
        limitations: experience.limitations,
        by: experience.derivation.by,
        modelBasis: experience.derivation.modelBasis,
        hint: experience.derivation.confirmNote,
        sources: experience.sources.map(sourceFromPublic),
      };
    }
    if (draft) {
      return {
        title: draft.title,
        understanding: draft.understanding,
        conditions: draft.conditions,
        limitations: draft.limitations,
        by: draft.by,
        modelBasis: draft.modelBasis,
        hint: draft.hint,
        sources: draft.sources.map(sourceFromDraft),
      };
    }
    return {
      title: '',
      understanding: '',
      conditions: '',
      limitations: '',
      by: 'user' as const,
      modelBasis: null,
      hint: '',
      sources: [] as EditorSource[],
    };
  }, [draft, experience, mode]);

  const [title, setTitle] = useState(initial.title);
  const [understanding, setUnderstanding] = useState(initial.understanding);
  const [conditions, setConditions] = useState(initial.conditions);
  const [limitations, setLimitations] = useState(initial.limitations);
  const [sources, setSources] = useState<EditorSource[]>(initial.sources);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<ExperienceDraftSource[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const operationIdRef = useRef(newOperationId());
  const submittingRef = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, saving]);

  const hasPracticeResult = sources.some(
    (source) => !source.deleted && Boolean(source.resultText && source.resultText.trim())
  );
  const hasModelSource = sources.some((source) => source.kind === 'experience');
  const selectedKeys = useMemo(() => new Set(sources.map((source) => source.sourceKey)), [sources]);

  function removeSource(sourceKey: string) {
    setSources((current) => current.filter((source) => source.sourceKey !== sourceKey));
  }

  async function searchSources(event?: React.FormEvent) {
    event?.preventDefault();
    setSearching(true);
    setSearchError(null);
    try {
      const res = await api.getExperienceSourceCandidates(
        search,
        mode === 'revise' ? experience?.id ?? null : null
      );
      setCandidates(res.candidates.filter((candidate) => !selectedKeys.has(candidate.sourceKey)));
    } catch (e) {
      setSearchError(errorText(e, '搜索来源失败，请稍后重试。'));
    } finally {
      setSearching(false);
    }
  }

  function addSource(candidate: ExperienceDraftSource) {
    setSources((current) => [...current, sourceFromDraft(candidate)].slice(0, 8));
    setCandidates((current) => current.filter((item) => item.sourceKey !== candidate.sourceKey));
  }

  async function save() {
    if (submittingRef.current) return;
    setError(null);
    setConflict(false);
    setNotice(null);
    const cleanTitle = title.trim();
    const cleanUnderstanding = understanding.trim();
    if (!cleanTitle) {
      setError('请先写一个标题。');
      return;
    }
    if (!cleanUnderstanding) {
      setError('请先写下你的理解。');
      return;
    }
    if (sources.length === 0 || !sources.some((source) => source.exists && !source.deleted)) {
      setError('至少关联一条仍可访问的原记录，才能保存经验。');
      return;
    }
    submittingRef.current = true;
    setSaving(true);
    try {
      if (mode === 'create') {
        const res = await api.createExperience({
          title: cleanTitle,
          understanding: cleanUnderstanding,
          conditions: conditions.trim(),
          limitations: limitations.trim(),
          by: initial.by,
          modelBasis: initial.modelBasis,
          originKind: draft?.originKind ?? 'manual',
          originQueryId: draft?.originQueryId ?? null,
          originPointIndex: draft?.originPointIndex ?? null,
          originAttemptId: draft?.originAttemptId ?? null,
          contextCaptureId: draft?.contextCaptureId ?? null,
          sourceKeys: sources.map((source) => source.sourceKey),
          operationId: operationIdRef.current,
        });
        onSaved(res.experience);
      } else if (experience) {
        const res = await api.updateExperience(experience.id, {
          title: cleanTitle,
          understanding: cleanUnderstanding,
          conditions: conditions.trim(),
          limitations: limitations.trim(),
          sourceKeys: sources.map((source) => source.sourceKey),
          revision: experience.revision,
          operationId: operationIdRef.current,
        });
        onSaved(res.experience);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true);
        setError(
          (e.body?.message as string) ||
            '这份经验刚刚在别处被修改。你的文字还在，可以先核对再保存。'
        );
      } else if (e instanceof ApiError && e.body?.error === 'source_unavailable') {
        setError('有来源记录已被删除，请移除它或补选一条仍可访问的记录。');
      } else {
        setError(errorText(e, '保存失败，请稍后重试。'));
      }
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  }

  async function reloadLatest() {
    if (!experience) return;
    setNotice(null);
    try {
      const res = await api.getExperience(experience.id);
      const latest = res.experience;
      setTitle(latest.title);
      setUnderstanding(latest.understanding);
      setConditions(latest.conditions);
      setLimitations(latest.limitations);
      setSources(latest.sources.map(sourceFromPublic));
      setConflict(false);
      setError('已载入最新版本；你刚才的文字已被替换，请核对后再次保存。');
    } catch (e) {
      setError(errorText(e, '读取最新版本失败。'));
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal experience-editor"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'create' ? '记成经验' : '修订经验'}
        data-testid="experience-editor"
      >
        <div className="modal-head">
          <div>
            <h3>{mode === 'create' ? '记成经验' : '修订经验'}</h3>
            <p className="modal-sub">
              {mode === 'create'
                ? '这是你整理后的理解，可以随时修改；保存只表示愿意保留，不代表已证实。'
                : '保留原理解，同时补充条件、限制或反例；一次结果不会被自动概括成普遍有效。'}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="取消编辑">
            ×
          </button>
        </div>

        <div className="experience-editor-body">
          {initial.by === 'model' ? (
            <p className="experience-model-note" role="note">
              <span className="badge ai-kind">由模型推断整理</span>
              {initial.modelBasis === 'observation' ? '由模型从原始记录整理' : '由模型推断整理'}
              ；保存后会一直保留这个出处，不会被显示成已证实。
            </p>
          ) : (
            <p className="experience-user-note" role="note">
              由你自己整理，不调用模型；来源和后续实践都可以随时核对。
            </p>
          )}

          {reviseAttempt && (
            <div className="readonly-block experience-revise-result">
              <strong>这次尝试的结果：{reviseAttempt.title}</strong>
              <p>{reviseAttempt.resultText || '还没有填写实际结果。'}</p>
              {reviseAttempt.outcome && <span className="badge">{OUTCOME_LABEL[reviseAttempt.outcome as keyof typeof OUTCOME_LABEL]}</span>}
            </div>
          )}

          <label className="field">
            <span>标题</span>
            <input
              ref={titleRef}
              type="text"
              value={title}
              maxLength={120}
              data-testid="experience-title"
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：睡前把手机放到书桌上"
            />
            <span className="char-count">{title.length} / 120</span>
          </label>

          <label className="field">
            <span>我的理解</span>
            <textarea
              value={understanding}
              maxLength={4000}
              rows={6}
              data-testid="experience-understanding"
              onChange={(event) => setUnderstanding(event.target.value)}
              placeholder="根据这些记录，我目前这样理解……"
            />
            <span className="char-count">{understanding.length} / 4000</span>
          </label>

          {!hasPracticeResult && (
            <p className="experience-no-practice" role="status">
              尚无实践结果支持：下面只有念头或整理摘要，还没有带结果的原始尝试。
            </p>
          )}

          <label className="field">
            <span>适用条件（可选）</span>
            <textarea
              value={conditions}
              maxLength={2000}
              rows={3}
              onChange={(event) => setConditions(event.target.value)}
              placeholder="例如：普通工作日晚上、没有临时工作消息时。"
            />
            <span className="char-count">{conditions.length} / 2000</span>
          </label>

          <label className="field">
            <span>限制或还不确定的地方（可选）</span>
            <textarea
              value={limitations}
              maxLength={2000}
              rows={3}
              data-testid="experience-limitations"
              onChange={(event) => setLimitations(event.target.value)}
              placeholder="例如：只试过两次；有临时工作消息时不一定有效。"
            />
            <span className="char-count">{limitations.length} / 2000</span>
          </label>

          <div className="experience-sources-edit">
            <div className="section-head">
              <h4>来源记录</h4>
              <span className="muted">
                {sources.filter((source) => source.exists && !source.deleted).length} 条可用
              </span>
            </div>
            {sources.length === 0 && <p className="muted">还没有来源，保存前至少补一条。</p>}
            <ul className="experience-source-edit-list">
              {sources.map((source) => (
                <li key={source.sourceKey} className="experience-source-edit-item">
                  <div className="experience-source-edit-main">
                    <div className="experience-source-edit-title">
                      {source.openHref ? (
                        <Link to={source.openHref}>{source.title}</Link>
                      ) : (
                        <span>{source.title}</span>
                      )}
                      {source.kind === 'experience' && (
                        <span className="badge">经验整理 · 非原始观察</span>
                      )}
                      {source.deleted && <span className="badge warn">来源已删除</span>}
                      {!source.deleted && source.changed && (
                        <span className="badge warn">来源有更新</span>
                      )}
                    </div>
                    {source.resultText && <p className="experience-source-result">{source.resultText}</p>}
                    {!source.resultText && source.text && (
                      <p className="muted experience-source-text">{source.text}</p>
                    )}
                    {source.observedAt && (
                      <span className="card-meta">结果时间：{formatTime(source.observedAt)}</span>
                    )}
                    {source.id && (
                      <Link
                        className="inline-link"
                        to={`/graph?focus=${source.type}:${source.id}`}
                      >
                        在局部图中查看 →
                      </Link>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn small danger-outline"
                    onClick={() => removeSource(source.sourceKey)}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>

            <form className="experience-source-search" onSubmit={(event) => void searchSources(event)}>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="补选来源：搜索旧尝试、结果或念头…"
                aria-label="补选来源"
              />
              <button type="submit" className="btn small" disabled={searching}>
                {searching ? '搜索中…' : '查找'}
              </button>
            </form>
            {searchError && <p className="error-msg">{searchError}</p>}
            {candidates.length > 0 && (
              <ul className="experience-candidate-list">
                {candidates.map((candidate) => (
                  <li key={candidate.sourceKey}>
                    <div>
                      <span>{candidate.title}</span>
                      <p className="muted">{candidate.resultText || candidate.text}</p>
                    </div>
                    <button type="button" className="btn small" onClick={() => addSource(candidate)}>
                      加入
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {hasModelSource && (
              <p className="hint">
                其中一条来源本身是经验整理。它只能说明你当时的理解，不能替代底层原始记录。
              </p>
            )}
          </div>

          {error && (
            <p className={conflict ? 'error-msg conflict-banner' : 'error-msg'} role="alert">
              {error}
            </p>
          )}
          {conflict && (
            <button type="button" className="btn small" onClick={() => void reloadLatest()}>
              载入最新版本
            </button>
          )}
          {notice && <p className="save-ok">{notice}</p>}

          <div className="modal-actions">
            <button type="button" className="btn" onClick={onCancel} disabled={saving}>
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => void save()}
              disabled={saving || sources.length === 0}
              data-testid="experience-save"
            >
              {saving ? '保存中…' : mode === 'create' ? '保存经验' : '保存修订'}
            </button>
          </div>
          <p className="hint">
            取消不会创建任何记录。同一份内容重复提交只会保存一次。
          </p>
        </div>
      </section>
    </div>
  );
}
