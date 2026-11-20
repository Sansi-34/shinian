// 拾念 V2 · 问记录（Ask）
// 流程：提问 → 找相关记录 → 勾选要作为依据的记录 → 预览覆盖度 → 发送 → 轮询状态 → 看答案。
// 规则照旧：答案只能引用你选中的记录；证据不足会直接说不足；观点必须标依据类型（观察/推断）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import type { AskCandidate, AskPublic, AskSearchResponse, AskListItem, AskPreviewResponse } from '../types';
import { todayDateKey, useDisplayTimezone } from '../scheduleTime';
import { dayLabel, dayTimeLabel, fromLocalInputValue } from './format';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Pill, { type StatusKind } from './ui/Pill';
import Button from './ui/Button';
import Spinner from './ui/Spinner';
import DateField from './ui/DateField';
import Segment from './ui/Segment';
import AskAnswerView from './ui/AskAnswerView';
import './shared.css';

// 与服务端 ASK_MAX_RECORDS / ASK_MAX_CHARS 对齐：一次最多 8 条依据、12000 字
const MAX_PICK = 8;

const newOpId = () => 'v2ask-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

function errText(e: unknown, fallback: string) {
  const anyErr = e as { status?: number; body?: { message?: string; error?: string }; message?: string };
  if (anyErr?.body?.message) return anyErr.body.message;
  if (anyErr?.status === 401) return '登录状态已失效，请重新登录。';
  if (anyErr?.status === 0 || anyErr?.message === 'Failed to fetch') return '网络连接失败，请检查服务是否在运行。';
  return fallback;
}

const STATUS: Record<string, { kind: StatusKind; label: string }> = {
  pending: { kind: 'active', label: '生成中' },
  succeeded: { kind: 'done', label: '已生成' },
  failed: { kind: 'fail', label: '生成失败' },
  cancelled: { kind: 'idle', label: '已取消' },
  interrupted: { kind: 'partial', label: '已中断' },
};

const MATCH_LABEL: Record<string, string> = { direct: '关键词命中', relation: '关系命中', expanded: '扩展词命中' };

export default function AskV2Page() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [tz] = useDisplayTimezone();

  // 提问
  const qParam = params.get('q') ?? '';
  const [question, setQuestion] = useState(qParam);
  const [keywords, setKeywords] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  useEffect(() => {
    if (qParam) setQuestion(qParam);
  }, [qParam]);

  // 检索结果
  const [search, setSearch] = useState<AskSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [onlyKind, setOnlyKind] = useState<'all' | 'attempt' | 'capture'>('all');

  // 预览与生成
  const [preview, setPreview] = useState<AskPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState<AskPublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 历史
  const [recent, setRecent] = useState<AskListItem[] | null>(null);
  const pollRef = useRef<number | null>(null);

  const loadRecent = useCallback(async () => {
    try {
      const res = await api.listAskQueries(12);
      setRecent(res.queries ?? []);
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  // 生成中轮询
  useEffect(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (!query || query.status !== 'pending') return;
    pollRef.current = window.setInterval(async () => {
      try {
        const res = await api.getAskQuery(query.id);
        setQuery(res.query);
        if (res.query.status !== 'pending') {
          void loadRecent();
        }
      } catch {
        /* 轮询失败不打断页面，下一次继续 */
      }
    }, 1500);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [query, loadRecent]);

  const rangeOf = () => {
    const from = fromDate ? fromLocalInputValue(fromDate + 'T00:00', tz) : null;
    const to = toDate ? fromLocalInputValue(toDate + 'T23:59', tz) : null;
    return { from, to };
  };

  async function runSearch() {
    if (searching) return;
    const q = question.trim();
    if (!q) {
      setError('先写一个你想问的问题。');
      return;
    }
    setSearching(true);
    setError(null);
    setNotice(null);
    setPreview(null);
    try {
      const { from, to } = rangeOf();
      const res = await api.searchAskCandidates({ question: q, keywords: keywords.trim(), from, to, limit: 40 });
      setSearch(res);
      // 默认选中前 8 条（服务端上限），让用户自行取消
      setSelected(new Set((res.candidates ?? []).slice(0, MAX_PICK).map((c) => c.sourceKey)));
      if ((res.candidates ?? []).length === 0) setNotice('没有匹配到记录。可以换关键词，或放宽时间范围。');
    } catch (e) {
      setError(errText(e, '检索失败，请重试。'));
    } finally {
      setSearching(false);
    }
  }

  const candidates: AskCandidate[] = useMemo(() => {
    const list = search?.candidates ?? [];
    if (onlyKind === 'all') return list;
    return list.filter((c) => c.type === onlyKind);
  }, [search, onlyKind]);

  function toggle(key: string) {
    setPreview(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        if (next.size >= MAX_PICK) {
          setNotice(`一次最多选 ${MAX_PICK} 条记录，先取消几条再选。`);
          return prev;
        }
        next.add(key);
      }
      setNotice(null);
      return next;
    });
  }

  async function loadPreview() {
    if (!search) return;
    if (selected.size === 0) {
      setError('至少选一条记录作为依据。');
      return;
    }
    setPreviewLoading(true);
    setError(null);
    try {
      const { from, to } = rangeOf();
      const res = await api.previewAsk({
        question: search.question,
        keywords: (search.keywords ?? []).join(' '),
        from,
        to,
        sourceKeys: Array.from(selected),
      });
      setPreview(res);
      if (!res.coverage.withinLimit) {
        setNotice(`选中的记录超出上限（${res.coverage.selectedRecords}/${res.coverage.maxRecords} 条，${res.coverage.selectedChars}/${res.coverage.maxChars} 字），请减少勾选。`);
      }
    } catch (e) {
      setError(errText(e, '预览失败，请重试。'));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function send() {
    if (!preview || creating) return;
    setCreating(true);
    setError(null);
    try {
      const { from, to } = rangeOf();
      const res = await api.createAskQuery({
        question: preview.question,
        keywords: (preview.keywords ?? []).join(' '),
        from,
        to,
        sourceKeys: Array.from(selected),
        contextToken: preview.contextToken,
        operationId: newOpId(),
      });
      setQuery(res.query);
      setNotice(null);
      void loadRecent();
    } catch (e) {
      setError(errText(e, '发送失败，请重试。'));
    } finally {
      setCreating(false);
    }
  }

  async function cancelQuery() {
    if (!query) return;
    try {
      const res = await api.cancelAskQuery(query.id);
      setQuery(res.query);
      void loadRecent();
    } catch (e) {
      setError(errText(e, '取消失败，请重试。'));
    }
  }

  function startOver() {
    setQuery(null);
    setPreview(null);
    setSearch(null);
    setSelected(new Set());
    setError(null);
    setNotice(null);
  }

  const st = query ? STATUS[query.status] ?? { kind: 'idle' as StatusKind, label: query.status } : null;

  return (
    <V2Shell
      leftTitle="问答记录"
      leftCount={recent?.length ?? 0}
      left={
        <>
          {recent === null && (
            <p className="v2-state">
              <Spinner />
            </p>
          )}
          {recent?.length === 0 && <p className="v2-state">还没有问过。第一次提问会记在这里，连同当时的依据一起。</p>}
          {(recent ?? []).map((r, i) => (
            <button
              key={r.id}
              type="button"
              className="v2-leftItem v2-leftBtn"
              style={{ '--i': i } as React.CSSProperties}
              onClick={() => navigate('/ask/' + r.id)}
            >
              <span className="v2-leftTitle">{r.question}</span>
              <span className="v2-leftMeta">
                {dayLabel(r.createdAt, tz, todayDateKey(tz))} · {STATUS[r.status]?.label ?? r.status}
                {r.insufficientEvidence ? ' · 证据不足' : ''}
              </span>
            </button>
          ))}
        </>
      }
      rightTitle="规则"
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">AI 能看什么</h3>
            <p className="v2-groupNote">只接收你这次勾选的记录，不联网、不读库外内容。答案里的每一条观点必须指向具体来源。</p>
          </div>
          <div>
            <h3 className="v2-groupTitle">模型</h3>
            <p className="v2-groupNote">
              {search?.ai?.configured
                ? search.ai.enabled
                  ? `已配置：${search.ai.config?.modelId ?? ''}`
                  : '已配置但当前关闭（设置里可以开）'
                : '还没有配置模型 —— 仍可检索记录，但发不出去。去设置填一个。'}
            </p>
          </div>
          <div>
            <h3 className="v2-groupTitle">证据不足</h3>
            <p className="v2-groupNote">记录不够时它会直接说不足，而不是编一个答案。这种情况也算一次有效问答。</p>
          </div>
        </>
      }
      statusLeft={search ? `命中 ${search.total} 条 · 已选 ${selected.size} 条` : '还没有检索'}
      statusRight={query ? <span>{st?.label}</span> : <span>未开始</span>}
    >
      {!query && (
        <>
          <div className="v2-captureHead">
            <div className="v2-form" style={{ width: '100%' }}>
              <div className="v2-field">
                <span className="v2-fieldLabel">你想问什么</span>
                <input
                  className="v2-input"
                  style={{ maxWidth: 'none', width: '100%' }}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
                    if (e.key === 'Enter' && !composing) void runSearch();
                  }}
                  placeholder="例如：调光闪烁这件事，我试过的方案里哪个有效？"
                  aria-label="问题"
                  maxLength={500}
                />
              </div>
              <div className="v2-field">
                <span className="v2-fieldLabel">关键词（可留空，留空按问题原文找）</span>
                <input
                  className="v2-input"
                  style={{ maxWidth: 'none', width: '100%' }}
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  placeholder="闪烁 调光 频率"
                  aria-label="关键词"
                  maxLength={200}
                />
              </div>
              <div className="v2-field">
                <span className="v2-fieldLabel">时间范围（可留空）</span>
                <div className="v2-timeRow">
                  <DateField value={fromDate ? fromDate + 'T00:00' : ''} onChange={(v) => setFromDate(v.slice(0, 10))} timezone={tz} label="起始日期" dateOnly />
                  <span className="v2-hint">到</span>
                  <DateField value={toDate ? toDate + 'T00:00' : ''} onChange={(v) => setToDate(v.slice(0, 10))} timezone={tz} label="结束日期" dateOnly />
                </div>
              </div>
              <div className="v2-captureActions">
                <Button variant="primary" onClick={() => void runSearch()} disabled={searching}>
                  {searching ? '检索中…' : '找相关记录'}
                </Button>
                {(fromDate || toDate) && (
                  <Button
                    onClick={() => {
                      setFromDate('');
                      setToDate('');
                    }}
                  >
                    清空时间
                  </Button>
                )}
                {searching && <Spinner label="检索中" />}
              </div>
            </div>
            {error && (
              <p className="v2-state" style={{ color: 'var(--st-fail)' }}>
                {error}
              </p>
            )}
            {notice && <p className="v2-state">{notice}</p>}
          </div>

          {search && (
            <Module title="选作依据的记录" count={candidates.length}>
              <div className="v2-toolbar" style={{ padding: 'var(--sp-2) var(--sp-4)' }}>
                <Segment
                  ariaLabel="记录类型"
                  items={[
                    { value: 'all' as const, label: `全部 ${search.candidates?.length ?? 0}` },
                    { value: 'attempt' as const, label: `尝试 ${(search.candidates ?? []).filter((c) => c.type === 'attempt').length}` },
                    { value: 'capture' as const, label: `念头 ${(search.candidates ?? []).filter((c) => c.type === 'capture').length}` },
                  ]}
                  value={onlyKind}
                  onChange={setOnlyKind}
                />
                <button
                  type="button"
                  className="v2-linkBtn"
                  onClick={() => {
                    const keys = candidates.map((c) => c.sourceKey);
                    setSelected(new Set(keys.slice(0, MAX_PICK)));
                    setPreview(null);
                    setNotice(keys.length > MAX_PICK ? `一次最多选 ${MAX_PICK} 条，已选前 ${MAX_PICK} 条。` : null);
                  }}
                >
                  全选前 {MAX_PICK} 条
                </button>
                <button
                  type="button"
                  className="v2-linkBtn"
                  onClick={() => {
                    setSelected(new Set());
                    setPreview(null);
                    setNotice(null);
                  }}
                >
                  全不选
                </button>
              </div>
              {candidates.length === 0 && <p className="v2-state">没有符合条件的记录。</p>}
              {candidates.map((c, i) => (
                <label key={c.sourceKey} className="v2-askPick" style={{ '--i': i } as React.CSSProperties}>
                  <input type="checkbox" checked={selected.has(c.sourceKey)} onChange={() => toggle(c.sourceKey)} />
                  <span className="v2-askPickMain">
                    <span className="v2-askPickTitle">{c.title}</span>
                    <span className="v2-leftMeta">
                      {MATCH_LABEL[c.matchKind] ?? c.matchKind}
                      {c.date ? ' · ' + dayLabel(c.date, tz, todayDateKey(tz)) : ''}
                      {c.state === 'done' && c.outcome ? ' · 已有结果' : ''}
                      {c.archived ? ' · 已归档' : ''}
                    </span>
                    <span className="v2-askPickSnippet">{c.snippet}</span>
                  </span>
                </label>
              ))}
              <div className="v2-captureActions" style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
                <Button variant="primary" onClick={() => void loadPreview()} disabled={previewLoading || selected.size === 0}>
                  {previewLoading ? '准备中…' : `预览并发送（已选 ${selected.size}/${MAX_PICK}）`}
                </Button>
                {previewLoading && <Spinner />}
              </div>
            </Module>
          )}

          {preview && (
            <Module title="发送前确认" count={preview.coverage.selectedRecords}>
              {error && (
                <p className="v2-state" style={{ color: 'var(--st-fail)' }}>
                  {error}
                </p>
              )}
              <ul className="v2-conflictList" style={{ padding: '0 var(--sp-4)' }}>
                <li>
                  选中 {preview.coverage.selectedRecords} / {preview.coverage.maxRecords} 条，
                  {preview.coverage.selectedChars} / {preview.coverage.maxChars} 字
                </li>
                <li>
                  模型：{preview.ai.configured ? (preview.ai.enabled ? search?.ai?.config?.modelId ?? '已配置' : '已配置但关闭') : '未配置'}
                </li>
                <li>时间范围：{preview.range.fromLocal ?? '不限'} ~ {preview.range.toLocal ?? '不限'}</li>
              </ul>
              {(!preview.ai.configured || !preview.ai.enabled || !preview.coverage.withinLimit) && (
                <p className="v2-state">
                  {!preview.ai.configured || !preview.ai.enabled
                    ? '模型还没配置或已关闭，现在发不出去。记录本身仍然可以检索和勾选。'
                    : '选中的内容超出上限，回上一步减少勾选。'}
                </p>
              )}
              <div className="v2-captureActions" style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
                <Button
                  variant="primary"
                  onClick={() => void send()}
                  disabled={creating || !preview.ai.configured || !preview.ai.enabled || !preview.coverage.withinLimit}
                >
                  {creating ? '发送中…' : '发送给模型'}
                </Button>
                <Button onClick={() => setPreview(null)}>回上一步</Button>
                {creating && <Spinner label="发送中" />}
              </div>
            </Module>
          )}
        </>
      )}

      {query && (
        <div className="v2-captureHead">
          <p className="v2-captureText">{query.question}</p>
          <div className="v2-captureActions">
            <Pill kind={st?.kind ?? 'idle'}>{st?.label}</Pill>
            <span className="v2-hint">
              {dayTimeLabel(query.createdAt, tz)} · 依据 {query.sources?.length ?? 0} 条
              {query.durationMs ? ` · 用时 ${(query.durationMs / 1000).toFixed(1)}s` : ''}
            </span>
            {query.status === 'pending' && query.canCancel && (
              <Button onClick={() => void cancelQuery()}>取消生成</Button>
            )}
            <Button onClick={startOver}>问下一个</Button>
          </div>

          {query.status === 'pending' && (
            <p className="v2-state">
              <Spinner label="模型正在读你选的记录…" />
            </p>
          )}

          {query.status !== 'pending' && (
            <div className="v2-form" style={{ width: '100%' }}>
              {query.status === 'failed' && (
                <p className="v2-state" style={{ color: 'var(--st-fail)' }}>
                  生成失败：{query.errorMessage ?? query.errorCode ?? '未知原因'}。可以重试或减少记录。
                </p>
              )}
              {query.status === 'cancelled' && <p className="v2-state">这次生成已取消，没有保存答案。</p>}
              {query.status === 'interrupted' && <p className="v2-state">生成被中断（可能是服务重启）。可以重新问一次。</p>}

              {query.answer && <AskAnswerView query={query} />}
            </div>
          )}
        </div>
      )}
    </V2Shell>
  );
}
