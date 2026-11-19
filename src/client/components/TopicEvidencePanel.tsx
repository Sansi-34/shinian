// 经验依据面板：只展示经验成员的直接原始依据（attempt/capture），不递归。
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { ApiError } from '../api';
import type { TopicAskExperience, TopicAskSource } from '../types';
import { OUTCOME_LABEL, formatTime, topicErrorText } from '../types';

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.body?.message || topicErrorText(e.body?.error, fallback);
  if (e instanceof TypeError) return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

type Props = {
  topicId: string;
  /** 只查看某一条经验；不传则显示主题内全部经验 */
  experienceId?: string;
  triggerLabel?: string;
  triggerClassName?: string;
  onAdd: (sourceKeys: string[], sources: TopicAskSource[]) => void;
};

export default function TopicEvidencePanel({
  topicId,
  experienceId,
  triggerLabel = '查看依据并选择',
  triggerClassName = 'btn small',
  onAdd,
}: Props) {
  const [open, setOpen] = useState(false);
  const [experiences, setExperiences] = useState<TopicAskExperience[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const shown = useMemo(
    () => (experienceId ? experiences.filter((item) => item.id === experienceId) : experiences),
    [experiences, experienceId]
  );

  const selectable = useMemo(() => {
    const map = new Map<string, TopicAskSource>();
    for (const experience of shown) {
      const keys = new Set(experience.selectableSourceKeys);
      for (const source of experience.sources) {
        if (source.deleted) continue;
        if (keys.size > 0 && !keys.has(source.sourceKey)) continue;
        map.set(source.sourceKey, source);
      }
    }
    return map;
  }, [shown]);

  async function openPanel() {
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const res = await api.listTopicAskExperiences(topicId);
      setExperiences(res.experiences);
      const keys = new Set<string>();
      for (const experience of res.experiences) {
        if (experienceId && experience.id !== experienceId) continue;
        for (const source of experience.sources) {
          if (!source.deleted && experience.selectableSourceKeys.includes(source.sourceKey)) {
            keys.add(source.sourceKey);
          }
        }
      }
      setSelected(keys);
    } catch (e) {
      setError(errorText(e, '读取经验依据失败'));
    } finally {
      setLoading(false);
    }
  }

  function toggle(source: TopicAskSource) {
    const next = new Set(selected);
    if (next.has(source.sourceKey)) next.delete(source.sourceKey);
    else next.add(source.sourceKey);
    setSelected(next);
  }

  function add() {
    const sources = [...selected]
      .map((key) => selectable.get(key))
      .filter((source): source is TopicAskSource => Boolean(source));
    if (sources.length === 0) return;
    onAdd(sources.map((source) => source.sourceKey), sources);
    setOpen(false);
  }

  return (
    <>
      <button type="button" className={triggerClassName} onClick={() => void openPanel()}>
        {triggerLabel}
      </button>
      {open && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal wide topic-evidence-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="topic-evidence-title"
          >
            <div className="modal-head">
              <div>
                <h3 id="topic-evidence-title">经验依据</h3>
                <p className="modal-sub">
                  这里只展开经验成员的<strong>直接原始依据</strong>（尝试或念头），不会再展开依据里的经验或关系。
                  勾选后会加入「围绕主题提问」的选择。
                </p>
              </div>
              <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="关闭">
                ×
              </button>
            </div>

            {loading ? (
              <p className="muted loading-line" role="status">
                <span className="spinner" aria-hidden="true" /> 读取经验依据…
              </p>
            ) : error ? (
              <div role="alert">
                <p className="error-msg">{error}</p>
                <button type="button" className="btn small" onClick={() => void openPanel()}>
                  重试
                </button>
              </div>
            ) : shown.length === 0 ? (
              <div className="empty-state">
                {experienceId ? '这条经验没有可展开的直接依据。' : '主题里还没有经验成员。'}
              </div>
            ) : (
              <div className="topic-evidence-list">
                {shown.map((experience) => (
                  <section className="topic-evidence-group" key={experience.id} aria-label={experience.title}>
                    <div className="topic-evidence-head">
                      <h4>{experience.title}</h4>
                      <span className="badge topic-type-experience">经验</span>
                      <span className="hint">
                        {experience.sourceCount} 条依据
                        {experience.needsRevision ? ' · 待核对' : ''}
                      </span>
                    </div>
                    {experience.sources.length === 0 ? (
                      <p className="hint">没有仍可访问的直接原始依据。</p>
                    ) : (
                      <ul className="topic-evidence-sources">
                        {experience.sources.map((source) => {
                          const canPick = experience.selectableSourceKeys.includes(source.sourceKey) && !source.deleted;
                          return (
                            <li key={source.sourceKey}>
                              <label className={`topic-check-row${canPick ? '' : ' is-existing'}`}>
                                <input
                                  type="checkbox"
                                  checked={selected.has(source.sourceKey)}
                                  disabled={!canPick}
                                  onChange={() => toggle(source)}
                                />
                                <span className="topic-check-main">
                                  <span className="topic-check-head">
                                    <span className={`badge topic-type-${source.type === 'capture' ? 'thought' : 'attempt'}`}>
                                      {source.type === 'capture' ? '念头' : '尝试'}
                                    </span>
                                    {source.state && <span className={`badge state-${source.state}`}>{source.state === 'done' ? '已结束' : source.state === 'in_progress' ? '进行中' : source.state === 'cancelled' ? '已放弃' : '待尝试'}</span>}
                                    {source.outcome && (
                                      <span className={`badge outcome-${source.outcome}`}>{OUTCOME_LABEL[source.outcome]}</span>
                                    )}
                                    {source.deleted && <span className="badge warn">来源已删除</span>}
                                  </span>
                                  <strong>{source.title || source.sourceKey}</strong>
                                  {source.resultText && <span className="topic-check-summary">{source.resultText}</span>}
                                  {!source.resultText && source.text && (
                                    <span className="topic-check-summary">{source.text}</span>
                                  )}
                                  <span className="topic-check-meta">
                                    {source.originLabel || '来自这条经验'}
                                    {source.observedAt ? ` · ${formatTime(source.observedAt)}` : ''}
                                    {source.openHref && (
                                      <>
                                        {' · '}
                                        <Link to={source.openHref} onClick={(e) => e.stopPropagation()}>
                                          打开原记录
                                        </Link>
                                      </>
                                    )}
                                  </span>
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                ))}
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={add}
                disabled={selected.size === 0 || loading}
              >
                把选中的 {selected.size} 条依据加入提问
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
