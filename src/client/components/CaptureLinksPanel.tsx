// 拾念 SHINIAN · 手动关联 / 反链面板
// 关联是用户手动建立的关系；反链读取同一条记录，不代表证据关系。
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { ApiError } from '../api';
import type { CaptureLinkCandidate, CaptureLinkItem } from '../types';
import { formatTime, newOperationId } from '../types';

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.body?.message || fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function itemHref(item: CaptureLinkItem): string {
  return item.capture.href ?? `/capture/${item.capture.id}`;
}

function itemTitle(item: CaptureLinkItem): string {
  return item.capture.title || item.capture.summary || item.capture.rawText;
}

export default function CaptureLinksPanel({ captureId }: { captureId: string }) {
  const [out, setOut] = useState<CaptureLinkItem[]>([]);
  const [incoming, setIncoming] = useState<CaptureLinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<CaptureLinkCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const operationIdRef = useRef(newOperationId());

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listCaptureLinks(captureId);
      setOut(res.out);
      setIncoming(res.in);
    } catch (e) {
      setError(errorText(e, '读取关联失败。'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureId]);

  async function search() {
    setSearching(true);
    setError(null);
    try {
      const res = await api.searchCaptureLinkCandidates(captureId, query.trim(), 12);
      setCandidates(res.captures);
    } catch (e) {
      setError(errorText(e, '搜索关联对象失败。'));
    } finally {
      setSearching(false);
    }
  }

  async function addLink(candidate: CaptureLinkCandidate) {
    if (saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.createCaptureLink(captureId, {
        toCaptureId: candidate.id,
        note: null,
        operationId: operationIdRef.current,
      });
      operationIdRef.current = newOperationId();
      setNotice(`已关联「${candidate.title || candidate.summary}」。`);
      setCandidates((current) => current.filter((item) => item.id !== candidate.id));
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError('这条关联已经存在，或操作编号重复。');
      } else {
        setError(errorText(e, '建立关联失败。'));
      }
    } finally {
      setSaving(false);
    }
  }

  async function removeLink(item: CaptureLinkItem) {
    if (saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.deleteCaptureLink(item.id);
      setNotice('已解除这条手动关联。');
      await load();
    } catch (e) {
      setError(errorText(e, '解除关联失败。'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="section capture-links-panel" aria-label="手动关联与反链">
      <div className="section-head">
        <h3>关联的念头</h3>
        <span className="muted">手动建立，不代表证据关系</span>
      </div>

      {loading && <p className="muted">读取关联…</p>}
      {error && <p className="error-msg" role="alert">{error}</p>}
      {notice && <p className="save-ok" role="status">{notice}</p>}

      <div className="links-columns">
        <div>
          <h4 className="links-subtitle">我关联到（{out.length}）</h4>
          {out.length === 0 ? (
            <p className="muted">还没有主动关联。</p>
          ) : (
            <ul className="link-list">
              {out.map((item) => (
                <li key={item.id}>
                  <Link to={itemHref(item)}>{itemTitle(item)}</Link>
                  {item.capture.kind === 'experience' && <span className="badge">经验</span>}
                  {item.note && <p className="muted">{item.note}</p>}
                  <span className="card-meta">{formatTime(item.createdAt)}</span>
                  <button
                    type="button"
                    className="btn small danger-outline"
                    onClick={() => void removeLink(item)}
                    disabled={saving}
                  >
                    解除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="links-subtitle">被关联（{incoming.length}）</h4>
          {incoming.length === 0 ? (
            <p className="muted">还没有其他记录关联到这里。</p>
          ) : (
            <ul className="link-list">
              {incoming.map((item) => (
                <li key={item.id}>
                  <Link to={itemHref(item)}>{itemTitle(item)}</Link>
                  {item.capture.kind === 'experience' && <span className="badge">经验</span>}
                  {item.note && <p className="muted">{item.note}</p>}
                  <span className="card-meta">{formatTime(item.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <form
        className="experience-source-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索要关联的念头或经验…"
          aria-label="搜索关联对象"
        />
        <button type="submit" className="btn small" disabled={searching}>
          {searching ? '搜索中…' : '查找'}
        </button>
      </form>
      {candidates.length > 0 && (
        <ul className="experience-candidate-list">
          {candidates.map((candidate) => (
            <li key={candidate.id}>
              <div>
                <span>{candidate.title || candidate.summary}</span>
                <p className="muted">
                  {candidate.kind === 'experience' ? '经验整理' : '念头'} · {candidate.snippet}
                </p>
              </div>
              <button
                type="button"
                className="btn small"
                onClick={() => void addLink(candidate)}
                disabled={saving || candidate.alreadyLinked}
              >
                {candidate.alreadyLinked ? '已关联' : '关联'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
