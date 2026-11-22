// 问答答案的统一渲染：主页面、详情页、首页对话卡片共用
// 严格遵守边界：来源 chip 与站内链接全部由服务端 sources 查表生成，绝不采信模型文本链接；
// 支持点回原文、查看局部图谱（保留主题/页面返回上下文）、以及从带引用观点整理成经验。
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import api, { ApiError } from '../../api';
import type { AskPublic, AskSourcePublic, ExperienceDraft, ExperiencePublic } from '../../types';
import { ASK_TYPE_LABEL, OUTCOME_LABEL, STATE_LABEL, experienceErrorText } from '../../types';
import ExperienceEditor from '../../components/ExperienceEditor';
import { topicAwareHref, type TopicNavContext } from '../../components/topicNav';
import Pill from './Pill';

function normalizeGraphHref(href: string | null, returnTo: string | null, topicNav?: TopicNavContext): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, 'http://shinian.local');
    if (url.pathname === '/graph' && url.searchParams.has('focus')) {
      const focused = url.searchParams.get('focus') ?? '';
      url.searchParams.delete('focus');
      url.searchParams.set('node', focused);
    }
    if (returnTo && !url.searchParams.has('returnTo')) {
      url.searchParams.set('returnTo', returnTo);
    }
    const raw = `${url.pathname}${url.search}`;
    return topicNav ? topicAwareHref(raw, topicNav) : raw;
  } catch {
    return href;
  }
}

function sourceHref(source: AskSourcePublic, returnTo: string | null, topicNav?: TopicNavContext): string | null {
  if (!source.openHref || source.deleted || !source.exists) return null;
  if (topicNav?.fromTopic) return topicAwareHref(source.openHref, topicNav);
  if (!returnTo) return source.openHref;
  const [path, qs = ''] = source.openHref.split('?');
  const p = new URLSearchParams(qs);
  if (!p.has('returnTo')) p.set('returnTo', returnTo);
  return `${path}?${p.toString()}`;
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function SourceChip({
  sourceId,
  sources,
  returnTo,
  topicNav,
}: {
  sourceId: string;
  sources: AskSourcePublic[];
  returnTo: string | null;
  topicNav?: TopicNavContext;
}) {
  const idx = sources.findIndex((item) => item.sourceKey === sourceId);
  const source = idx >= 0 ? sources[idx] : null;
  if (!source) {
    return <span className="v2-sourceChip is-missing">来源不可用</span>;
  }
  const pos = idx + 1;
  if (source.deleted || !source.exists) {
    return (
      <span className="v2-sourceChip is-deleted" title={`发送时的第 ${pos} 条来源已删除`}>
        来源#{pos} 已删除
      </span>
    );
  }
  const label = `#${pos} ${ASK_TYPE_LABEL[source.type]} · ${truncate(source.title || source.id, 18)}`;
  const to = sourceHref(source, returnTo, topicNav);
  if (!to) {
    return <span className="v2-sourceChip">{label}</span>;
  }
  return (
    <Link className="v2-sourceChip" to={to} title={source.title || source.id} data-testid="ask-point-source-link">
      {label}
      {source.changed ? '（已更新）' : ''}
    </Link>
  );
}

export default function AskAnswerView({
  query,
  topicNav,
  returnTo,
}: {
  query: AskPublic;
  topicNav?: TopicNavContext;
  returnTo?: string | null;
}) {
  const location = useLocation();
  const [draftLoadingIdx, setDraftLoadingIdx] = useState<number | null>(null);
  const [expDraft, setExpDraft] = useState<ExperienceDraft | null>(null);
  const [expError, setExpError] = useState<string | null>(null);
  const [savedExp, setSavedExp] = useState<ExperiencePublic | null>(null);

  const answer = query.answer;
  if (!answer) return null;

  const effectiveReturnTo = returnTo ?? `${location.pathname}${location.search}`;

  async function startExperienceFromPoint(pointIndex: number) {
    if (draftLoadingIdx !== null) return;
    setDraftLoadingIdx(pointIndex);
    setExpError(null);
    try {
      const res = await api.getAskExperienceDraft(query.id, pointIndex);
      setExpDraft(res.draft);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.body?.message || experienceErrorText(e.body?.error, '这条观点暂时不能整理成经验。')
          : '这条观点暂时不能整理成经验。';
      setExpError(msg);
    } finally {
      setDraftLoadingIdx(null);
    }
  }

  return (
    <div className="v2-form" style={{ width: '100%' }}>
      {answer.insufficientEvidence && (
        <p className="v2-state" style={{ color: 'var(--st-partial)', padding: '6px 0' }}>
          记录里不足以回答这个问题。下面是它认为还缺什么。
        </p>
      )}

      <p className="v2-captureText" style={{ fontSize: 'var(--fs-body)', margin: 0 }}>
        {answer.summary}
      </p>

      {expError && (
        <p className="v2-groupNote" style={{ color: 'var(--st-fail)' }} role="alert">
          {expError}
        </p>
      )}

      {savedExp && (
        <p className="v2-groupNote" style={{ color: 'var(--st-done)' }} role="status">
          已将观点保存为经验「{savedExp.title}」
          <Link
            className="v2-linkBtn"
            to={topicNav ? topicAwareHref('/experience/' + savedExp.id, topicNav) : '/experience/' + savedExp.id}
          >
            打开经验详情 →
          </Link>
        </p>
      )}

      {answer.points.length > 0 && (
        <div>
          <h3 className="v2-groupTitle">观点</h3>
          {answer.points.map((pt, i) => {
            const hasLiveSource = pt.sourceIds.some((sid) => {
              const s = query.sources.find((item) => item.sourceKey === sid);
              return Boolean(s && s.exists && !s.deleted);
            });
            return (
              <div key={i} className="v2-askPoint" data-testid="ask-point-card">
                <p className="v2-askPointText">{pt.text}</p>
                <div className="v2-askPointMeta">
                  <Pill kind={pt.basis === 'observation' ? 'done' : 'partial'}>
                    {pt.basis === 'observation' ? '记录中的观察' : '模型推断 · 非事实'}
                  </Pill>
                  {pt.condition && <span className="v2-hint">条件：{pt.condition}</span>}
                  {pt.sourceIds.map((sid) => (
                    <SourceChip
                      key={sid}
                      sourceId={sid}
                      sources={query.sources}
                      returnTo={effectiveReturnTo}
                      topicNav={topicNav}
                    />
                  ))}
                  {hasLiveSource && !query.answerInvalidated && (
                    <button
                      type="button"
                      className="v2-miniBtn"
                      style={{ marginLeft: 'auto' }}
                      disabled={draftLoadingIdx !== null}
                      onClick={() => void startExperienceFromPoint(i)}
                      data-testid="ask-save-experience"
                    >
                      {draftLoadingIdx === i ? '准备中…' : '记成经验'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {answer.contradictions.length > 0 && (
        <div>
          <h3 className="v2-groupTitle">记录之间互相矛盾</h3>
          {answer.contradictions.map((c, i) => (
            <div key={i} className="v2-askPoint">
              <p className="v2-askPointText">{c.text}</p>
              <div className="v2-askPointMeta">
                {c.sides.map((s, k) => (
                  <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <SourceChip
                      sourceId={s.sourceId}
                      sources={query.sources}
                      returnTo={effectiveReturnTo}
                      topicNav={topicNav}
                    />
                    {s.condition && <span className="v2-hint">（{s.condition}）</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {answer.missing.length > 0 && (
        <div>
          <h3 className="v2-groupTitle">还缺什么</h3>
          <ul className="v2-conflictList">
            {answer.missing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="v2-groupTitle">依据记录（仅限本次勾选发送的材料）</h3>
        {query.sources.length === 0 && <p className="v2-groupNote">这次没有留下依据记录。</p>}
        <div className="v2-askSourceList">
          {query.sources.map((s, idx) => {
            const deleted = s.deleted || !s.exists;
            const openTo = sourceHref(s, effectiveReturnTo, topicNav);
            const graphTo = !deleted ? normalizeGraphHref(s.graphHref, effectiveReturnTo, topicNav) : null;
            return (
              <div key={s.sourceKey} className="v2-askSourceCard" data-testid="ask-source-item">
                <div className="v2-askSourceHead">
                  <span className="v2-hint">#{idx + 1}</span>
                  <span className="v2-askSourceTitle">
                    {deleted ? '（来源已删除）' : s.title || s.text?.slice(0, 32) || s.id}
                  </span>
                  <Pill kind="idle">{ASK_TYPE_LABEL[s.type]}</Pill>
                  {!deleted && s.type === 'attempt' && s.state && (
                    <Pill kind={s.state === 'done' ? 'done' : s.state === 'in_progress' ? 'active' : 'idle'}>
                      {STATE_LABEL[s.state] ?? s.state}
                    </Pill>
                  )}
                  {!deleted && s.outcome && (
                    <Pill kind={s.outcome === 'success' ? 'done' : s.outcome === 'failure' ? 'fail' : 'partial'}>
                      {OUTCOME_LABEL[s.outcome]}
                    </Pill>
                  )}
                  {deleted && <Pill kind="fail">已删除</Pill>}
                  {!deleted && s.changed && <Pill kind="partial">来源有更新</Pill>}
                  {!deleted && s.archived && <Pill kind="idle">已归档</Pill>}
                </div>
                {!deleted && s.resultText && (
                  <p className="v2-groupNote" style={{ marginTop: 4, color: 'var(--ink-2)' }}>
                    结果：{s.resultText}
                  </p>
                )}
                {!deleted && !s.resultText && s.text && (
                  <p className="v2-groupNote" style={{ marginTop: 4 }}>
                    {truncate(s.text, 120)}
                  </p>
                )}
                {!deleted && s.changed && (
                  <p className="v2-groupNote" style={{ marginTop: 4, color: 'var(--st-partial)' }}>
                    发送后原记录已修改，打开原文可查看最新内容。
                  </p>
                )}
                {!deleted && (openTo || graphTo) && (
                  <div className="v2-askSourceActions">
                    {openTo && (
                      <Link className="v2-miniBtn" to={openTo} data-testid="ask-open-source">
                        打开原记录 →
                      </Link>
                    )}
                    {graphTo && (
                      <Link className="v2-miniBtn" to={graphTo} data-testid="ask-open-graph">
                        在图谱中查看 →
                      </Link>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {query.answerInvalidated && (
        <p className="v2-state" style={{ color: 'var(--st-fail)', paddingLeft: 0 }}>
          这份答案已失效：{query.answerInvalidReason ?? '来源记录有变化'}。建议重新问一次。
        </p>
      )}

      {query.hiddenPointCount > 0 && (
        <p className="v2-groupNote">有 {query.hiddenPointCount} 条观点因为来源已删除被隐藏，不给出来。</p>
      )}

      {expDraft && (
        <ExperienceEditor
          mode="create"
          draft={expDraft}
          onCancel={() => setExpDraft(null)}
          onSaved={(saved) => {
            setExpDraft(null);
            setSavedExp(saved);
          }}
        />
      )}
    </div>
  );
}
