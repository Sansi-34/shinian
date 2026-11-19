// 「下次继续」突出卡：固定尝试、从相关尝试重选、或新建一个尝试后固定。
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { ApiError } from '../api';
import type { Attempt, Topic, TopicAttempt } from '../types';
import {
  OUTCOME_LABEL,
  TOPIC_ATTEMPT_STATUS_LABEL,
  formatTime,
  newOperationId,
  topicAttemptDisplayState,
  topicErrorText,
} from '../types';
import { topicAwareHref, type TopicNavContext } from './topicNav';

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.body?.message || topicErrorText(e.body?.error, fallback);
  if (e instanceof TypeError) return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

const CLEARED_REASON_LABEL: Record<string, string> = {
  attempt_deleted: '固定的尝试已被删除',
  attempt_cancelled: '固定的尝试已取消',
  member_removed: '固定的尝试所属念头已移出主题',
};

type Props = {
  topic: Topic;
  returnTo: string;
  onTopicChange: (topic: Topic) => void;
  /** 新建尝试会改变主题的聚合尝试列表，通知外层重新拉取。 */
  onAttemptsChanged?: () => void;
};

export default function TopicNextStep({ topic, returnTo, onTopicChange, onAttemptsChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clearedDismissed, setClearedDismissed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  const [candidates, setCandidates] = useState<TopicAttempt[]>([]);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [candidateOffset, setCandidateOffset] = useState(0);
  const [candidateHasMore, setCandidateHasMore] = useState(false);
  const [candidatePick, setCandidatePick] = useState<string | null>(null);

  const [newCaptureId, setNewCaptureId] = useState('');
  const [newStep, setNewStep] = useState('');
  const [fixAfterCreate, setFixAfterCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdAttempt, setCreatedAttempt] = useState<Attempt | null>(null);
  const [fixCreatedBusy, setFixCreatedBusy] = useState(false);
  const [fixCreatedError, setFixCreatedError] = useState<string | null>(null);
  const operationRef = useRef(newOperationId());
  const fixOperationRef = useRef(newOperationId());

  const thoughtMembers = topic.members.filter(
    (member) => member.type === 'thought' && !member.archived
  );
  const next = topic.nextAttempt;
  const nextDisplay = next ? topicAttemptDisplayState(next) : null;
  const clearedReason = topic.nextAttemptClearedReason;

  useEffect(() => {
    setNotice(null);
    setError(null);
    setClearedDismissed(false);
    setPickerOpen(false);
    setNewOpen(false);
    setCreatedAttempt(null);
    setNewStep('');
    setNewCaptureId('');
  }, [topic.id]);

  async function reloadTopic() {
    const res = await api.getTopic(topic.id);
    onTopicChange(res.topic);
  }

  async function loadCandidates(reset = true) {
    setCandidateLoading(true);
    setCandidateError(null);
    try {
      const res = await api.listTopicAttempts(topic.id, {
        limit: 50,
        offset: reset ? 0 : candidateOffset,
        state: 'all',
      });
      const open = res.attempts.filter(
        (attempt) => attempt.state === 'todo' || attempt.state === 'in_progress'
      );
      setCandidates((prev) => (reset ? open : [...prev, ...open]));
      setCandidateOffset((reset ? 0 : candidateOffset) + res.attempts.length);
      setCandidateHasMore(res.hasMore);
      if (reset && open.length === 0 && res.attempts.length === 0) {
        setCandidateError('这个主题的普通念头下还没有尝试，可在右侧新建一个。');
      }
    } catch (e) {
      setCandidateError(errorText(e, '读取相关尝试失败'));
    } finally {
      setCandidateLoading(false);
    }
  }

  function openPicker() {
    setPickerOpen(true);
    setCandidatePick(null);
    setCandidateOffset(0);
    void loadCandidates(true);
  }

  function currentContext(): TopicNavContext {
    return { fromTopic: true, topicId: topic.id, returnTo };
  }

  async function clearNext() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.setTopicNextAttempt(topic.id, {
        attemptId: null,
        expectedRevision: topic.revision,
        operationId: newOperationId(),
      });
      if (res.topic) onTopicChange(res.topic);
      else await reloadTopic();
      setNotice('已清除固定的下次继续；尝试本身和结果都还在。');
      setClearedDismissed(true);
    } catch (e) {
      setError(errorText(e, '清除固定失败'));
    } finally {
      setBusy(false);
    }
  }

  async function fixExisting() {
    if (!candidatePick || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.setTopicNextAttempt(topic.id, {
        attemptId: candidatePick,
        expectedRevision: topic.revision,
        operationId: newOperationId(),
      });
      if (res.topic) onTopicChange(res.topic);
      else await reloadTopic();
      if (res.clearedReason) {
        setNotice(
          `已固定新的下一步；原固定尝试已失效（${
            CLEARED_REASON_LABEL[res.clearedReason] ?? res.clearedReason
          }）。`
        );
      } else {
        setNotice('已固定为下次继续。');
      }
      setPickerOpen(false);
      setCandidatePick(null);
    } catch (e) {
      setError(errorText(e, '固定下次继续失败'));
    } finally {
      setBusy(false);
    }
  }

  async function createNewAttempt() {
    const step = newStep.trim();
    if (!step) {
      setError('先写下这一步要做什么。');
      return;
    }
    if (!newCaptureId) {
      setError('先选择一个本主题中的普通念头。');
      return;
    }
    if (creating) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.createAttempt(newCaptureId, {
        step,
        state: 'todo',
        operationId: operationRef.current,
      });
      operationRef.current = newOperationId();
      setCreatedAttempt(res.attempt);
      setNotice('尝试已创建（待尝试）；没有修改状态，也没有自动安排时间。');
      onAttemptsChanged?.();
      if (fixAfterCreate) {
        await fixCreatedAttempt(res.attempt.id);
      }
    } catch (e) {
      setError(errorText(e, '新建尝试失败'));
    } finally {
      setCreating(false);
    }
  }

  async function fixCreatedAttempt(attemptId: string) {
    setFixCreatedBusy(true);
    setFixCreatedError(null);
    try {
      const res = await api.setTopicNextAttempt(topic.id, {
        attemptId,
        expectedRevision: topic.revision,
        operationId: fixOperationRef.current,
      });
      fixOperationRef.current = newOperationId();
      if (res.topic) onTopicChange(res.topic);
      else await reloadTopic();
      setNotice('已把新建的尝试固定为下次继续。');
    } catch (e) {
      setFixCreatedError(errorText(e, '尝试已创建，但固定下次继续失败；可以稍后重试。'));
    } finally {
      setFixCreatedBusy(false);
    }
  }

  return (
    <section className="topic-next" aria-labelledby="topic-next-title" data-testid="topic-next-card">
      <div className="topic-next-head">
        <div>
          <p className="page-kicker">下次继续</p>
          <h2 id="topic-next-title">固定这一步，下次从这里接着做</h2>
        </div>
        {next && (
          <button
            type="button"
            className="btn small"
            onClick={() => void clearNext()}
            disabled={busy}
            data-testid="topic-next-clear"
          >
            {busy ? '处理中…' : '清除固定'}
          </button>
        )}
      </div>

      {clearedReason && !clearedDismissed && (
        <div className="topic-cleared-banner" role="status">
          <strong>原固定的尝试已失效</strong>
          <p>{CLEARED_REASON_LABEL[clearedReason] ?? clearedReason}；已自动清除固定，原尝试记录仍保留。</p>
          <button type="button" className="btn small" onClick={() => setClearedDismissed(true)}>
            知道了
          </button>
        </div>
      )}

      {next ? (
        <div className={`topic-next-main state-${nextDisplay}`} data-testid="topic-next-current">
          <div className="topic-next-main-top">
            <span className={`badge topic-attempt-${nextDisplay}`}>
              {nextDisplay ? TOPIC_ATTEMPT_STATUS_LABEL[nextDisplay] : ''}
            </span>
            {next.outcome && (
              <span className={`badge outcome-${next.outcome}`}>
                {OUTCOME_LABEL[next.outcome]}
              </span>
            )}
            <span className="badge">{next.state === 'in_progress' ? '进行中' : next.state === 'done' ? '已结束' : '待尝试'}</span>
          </div>
          <p className="topic-next-step">{next.step}</p>
          <p className="topic-next-capture">
            所属念头：{next.captureText || '（念头正文不可用）'}
            {next.captureArchived && <span className="badge">已归档</span>}
          </p>
          <p className="topic-next-result">
            结果：{next.resultText?.trim() ? next.resultText : '还没有记录结果'}
            {next.observedAt ? ` · 观察于 ${formatTime(next.observedAt)}` : ''}
          </p>
          <div className="topic-next-actions">
            {next.state === 'done' ? (
              <>
                <span className="topic-next-done-note">这一步已记录结果</span>
                <Link
                  className="btn small primary"
                  to={topicAwareHref(`/attempt/${next.id}`, currentContext())}
                  data-testid="topic-next-open"
                >
                  查看结果
                </Link>
              </>
            ) : (
              <Link
                className="btn small primary"
                to={topicAwareHref(`/attempt/${next.id}`, currentContext())}
                data-testid="topic-next-open"
              >
                打开尝试，继续做
              </Link>
            )}
            <button
              type="button"
              className="btn small"
              onClick={() => (pickerOpen ? setPickerOpen(false) : openPicker())}
              aria-expanded={pickerOpen}
              data-testid="topic-next-reselect"
            >
              从相关尝试重选
            </button>
          </div>
        </div>
      ) : (
        <div className="topic-next-empty">
          <p>还没有固定下一步。可以从主题里未完成的尝试中选一个，或直接新建一个尝试。</p>
          <div className="topic-next-actions">
            <button
              type="button"
              className="btn primary small"
              onClick={() => (pickerOpen ? setPickerOpen(false) : openPicker())}
              aria-expanded={pickerOpen}
              data-testid="topic-next-reselect"
            >
              选择一个相关尝试
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => setNewOpen((value) => !value)}
              aria-expanded={newOpen}
              data-testid="topic-next-new"
            >
              新建尝试
            </button>
          </div>
        </div>
      )}

      {notice && (
        <p className="save-ok" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-msg" role="alert">
          {error}
        </p>
      )}

      {pickerOpen && (
        <div className="topic-next-picker" role="region" aria-label="选择相关尝试">
          <div className="topic-next-picker-head">
            <h3>只显示未完成 / 进行中的尝试</h3>
            <button type="button" className="link" onClick={() => setPickerOpen(false)}>
              收起
            </button>
          </div>
          {candidateLoading ? (
            <p className="muted loading-line" role="status">
              <span className="spinner" aria-hidden="true" /> 读取相关尝试…
            </p>
          ) : candidates.length === 0 ? (
            <p className="muted">{candidateError || '没有可选的未完成尝试。'}</p>
          ) : (
            <ul className="topic-next-candidate-list">
              {candidates.map((attempt) => (
                <li key={attempt.id}>
                  <label className="topic-check-row">
                    <input
                      type="radio"
                      name="topic-next-candidate"
                      checked={candidatePick === attempt.id}
                      onChange={() => setCandidatePick(attempt.id)}
                    />
                    <span className="topic-check-main">
                      <span className="topic-check-head">
                        <span className="badge">{attempt.state === 'in_progress' ? '进行中' : '待尝试'}</span>
                        <span className="topic-check-meta">{formatTime(attempt.createdAt)}</span>
                      </span>
                      <strong>{attempt.step}</strong>
                      <span className="topic-check-summary">
                        {attempt.captureText || '所属念头不可用'}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {candidateHasMore && (
            <button
              type="button"
              className="btn small"
              onClick={() => void loadCandidates(false)}
              disabled={candidateLoading}
            >
              加载更多尝试
            </button>
          )}
          <div className="row-actions">
            <button
              type="button"
              className="btn primary small"
              onClick={() => void fixExisting()}
              disabled={!candidatePick || busy}
            >
              固定为下次继续
            </button>
          </div>
        </div>
      )}

      {newOpen && (
        <div className="topic-next-new" role="region" aria-label="新建尝试">
          <div className="topic-next-picker-head">
            <h3>新建一个尝试</h3>
            <button type="button" className="link" onClick={() => setNewOpen(false)}>
              收起
            </button>
          </div>
          <p className="hint">
            只创建一个「待尝试」的步骤；不会自动开始、改状态或安排时间。创建后可勾选固定为下次继续。
          </p>
          {createdAttempt ? (
            <div className="topic-created-attempt" role="status">
              <p>已创建：{createdAttempt.step}</p>
              <div className="row-actions">
                <Link className="btn small" to={topicAwareHref(`/attempt/${createdAttempt.id}`, currentContext())}>
                  打开尝试
                </Link>
                {!next && (
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => void fixCreatedAttempt(createdAttempt.id)}
                    disabled={fixCreatedBusy}
                  >
                    {fixCreatedBusy ? '固定中…' : '固定为下次继续'}
                  </button>
                )}
                <button type="button" className="btn small" onClick={() => setCreatedAttempt(null)}>
                  再建一个
                </button>
              </div>
              {fixCreatedError && <p className="error-msg">{fixCreatedError}</p>}
            </div>
          ) : (
            <>
              <label className="field">
                <span>选择本主题中的一个普通念头</span>
                <select
                  value={newCaptureId}
                  onChange={(e) => setNewCaptureId(e.target.value)}
                  data-testid="topic-next-new-capture"
                >
                  <option value="">请选择念头</option>
                  {thoughtMembers.map((member) => (
                    <option key={member.captureId} value={member.captureId}>
                      {member.title}
                    </option>
                  ))}
                </select>
              </label>
              {thoughtMembers.length === 0 && (
                <p className="hint warn">主题里还没有可用的普通念头；先把一条念头加入主题。</p>
              )}
              <label className="field">
                <span>这一步做什么</span>
                <input
                  type="text"
                  value={newStep}
                  maxLength={500}
                  onChange={(e) => setNewStep(e.target.value)}
                  placeholder="例如：把 PWM 频率从 500 Hz 改到 2 kHz 再观察"
                  data-testid="topic-next-new-step"
                />
              </label>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={fixAfterCreate}
                  onChange={(e) => setFixAfterCreate(e.target.checked)}
                />
                <span>
                  <strong>创建后固定为下次继续</strong>
                  <span className="field-hint">可选；固定不等于开始尝试。</span>
                </span>
              </label>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn primary small"
                  onClick={() => void createNewAttempt()}
                  disabled={creating || !newStep.trim() || !newCaptureId}
                  data-testid="topic-next-new-submit"
                >
                  {creating ? '创建中…' : '创建尝试'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
