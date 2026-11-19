// 拾念 SHINIAN v0.2 - 日程详情弹层：查看、修改时间、取消安排
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { ApiError } from '../api';
import type { NextAction, ScheduleBlock } from '../types';
import { STATE_LABEL } from '../types';
import {
  formatDateTimeInTimezone,
  formatScheduleFullRange,
  isCrossDaySchedule,
  isSchedulePast,
  scheduleTimezoneLabel,
  useNow,
} from '../scheduleTime';
import ScheduleEditor from './ScheduleEditor';

type Props = {
  schedule: ScheduleBlock;
  displayTimezone: string;
  onClose: () => void;
  onChanged: (schedule: ScheduleBlock) => void;
};

export default function ScheduleDetailModal({
  schedule,
  displayTimezone,
  onClose,
  onChanged,
}: Props) {
  const [current, setCurrent] = useState(schedule);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [cancelling, setCancelling] = useState(false);
  // 取消安排不可撤销：点第一次只进入确认态，第二次才真的取消。
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [nextActionInfo, setNextActionInfo] = useState<NextAction | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement | null>(null);
  const now = useNow();

  const noticeRevisionRef = useRef<number | null>(null);

  useEffect(() => {
    // 修改/取消成功时 current 已是最新 revision，保留结果提示；
    // 只有外部真正换成另一条安排时才清空。
    if (noticeRevisionRef.current !== null && noticeRevisionRef.current === schedule.revision) {
      setCurrent(schedule);
      setMode('view');
      setCancelError(null);
      setConfirmingCancel(false);
      return;
    }
    setCurrent(schedule);
    setMode('view');
    setNotice(null);
    setCancelError(null);
    setConfirmingCancel(false);
  }, [schedule.id, schedule.revision]);

  useEffect(() => {
    const attempt = current.attempt;
    if (!attempt || attempt.origin) {
      setNextActionInfo(null);
      return;
    }
    let active = true;
    void api
      .getNextAction(attempt.id)
      .then((res) => {
        if (active) setNextActionInfo(res.action);
      })
      .catch(() => {
        if (active) setNextActionInfo(null);
      });
    return () => {
      active = false;
    };
  }, [current.attempt?.id, current.attempt?.origin]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      // 先退出确认态，再关弹层，避免误关。
      if (confirmingCancel) {
        setConfirmingCancel(false);
        return;
      }
      onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, confirmingCancel]);

  useEffect(() => {
    if (confirmingCancel) confirmCancelRef.current?.focus();
  }, [confirmingCancel]);

  const past = current.status === 'active' && isSchedulePast(current, now);
  const crossDay = isCrossDaySchedule(current, displayTimezone);
  const fromReview = current.attempt?.origin === 'review_next_action' || Boolean(nextActionInfo);
  const sourceReviewId =
    current.attempt?.sourceReviewId ?? nextActionInfo?.sourceReviewId ?? null;

  async function cancelSchedule() {
    if (cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await api.cancelSchedule(current.id, current.revision);
      setCurrent(res.schedule);
      onChanged(res.schedule);
      noticeRevisionRef.current = res.schedule.revision;
      setNotice('这次安排已取消；尝试状态和记录本身没有改变。');
    } catch (error) {
      if (error instanceof ApiError) {
        const body: any = error.body ?? {};
        if (body.error === 'revision_conflict' && body.current) {
          const latest = body.current as ScheduleBlock;
          setCurrent(latest);
          onChanged(latest);
          setCancelError('这条安排刚被其他窗口修改，已刷新为最新版本，请再次确认是否取消。');
        } else if (body.error === 'already_cancelled') {
          setCancelError('这条安排已经取消，不需要重复操作。');
          if (body.current) {
            setCurrent(body.current as ScheduleBlock);
            onChanged(body.current as ScheduleBlock);
          }
        } else {
          setCancelError(body.message || '取消安排失败，请重试。');
        }
      } else {
        setCancelError('取消安排失败，请重试。');
      }
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="安排详情">
      <div className="modal schedule-detail-modal">
        <div className="schedule-detail-head">
          <div>
            <p className="page-kicker">安排详情</p>
            <h3>{formatScheduleFullRange(current, displayTimezone)}</h3>
          </div>
          <button
            type="button"
            className="btn small"
            onClick={onClose}
            aria-label="关闭安排详情"
            autoFocus
          >
            关闭
          </button>
        </div>

        <div className="schedule-badges">
          {current.status === 'cancelled' ? (
            <span className="badge">已取消</span>
          ) : past ? (
            <span className="badge warn">已过安排时间</span>
          ) : (
            <span className="badge state-in_progress">有效</span>
          )}
          {crossDay && <span className="badge">跨日</span>}
          {fromReview && <span className="badge ai-kind">来自回顾</span>}
          {current.attempt && (
            <span className={`badge state-${current.attempt.state}`}>
              {STATE_LABEL[current.attempt.state]}
            </span>
          )}
        </div>

        {mode === 'edit' ? (
          <ScheduleEditor
            mode="edit"
            schedule={current}
            displayTimezone={displayTimezone}
            onCancel={() => setMode('view')}
            onSaved={(saved) => {
              setCurrent(saved);
              onChanged(saved);
              setMode('view');
              noticeRevisionRef.current = saved.revision;
              setNotice('安排已更新。');
              setCancelError(null);
            }}
          />
        ) : (
          <>
            <dl className="schedule-detail-grid">
              <div>
                <dt>显示时区</dt>
                <dd>{scheduleTimezoneLabel(displayTimezone)}</dd>
              </div>
              <div>
                <dt>安排时区</dt>
                <dd>{scheduleTimezoneLabel(current.timezone)}</dd>
              </div>
              <div>
                <dt>备注</dt>
                <dd className="schedule-detail-note">{current.note || '—'}</dd>
              </div>
              <div>
                <dt>尝试</dt>
                <dd>
                  {current.attempt ? (
                    <Link to={`/attempt/${current.attempt.id}`}>
                      {current.attempt.step} · {STATE_LABEL[current.attempt.state]}
                    </Link>
                  ) : (
                    <span className="muted">尝试已删除</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>念头</dt>
                <dd>
                  {current.capture ? (
                    <Link to={`/capture/${current.capture.id}`}>
                      {current.capture.rawText.slice(0, 60)}
                      {current.capture.rawText.length > 60 ? '…' : ''}
                    </Link>
                  ) : (
                    <span className="muted">念头已删除</span>
                  )}
                </dd>
              </div>
              {fromReview && current.attempt && (
                <div>
                  <dt>下一步行动</dt>
                  <dd>
                    <Link to={`/next-action/${current.attempt.id}`}>打开下一步行动 →</Link>
                  </dd>
                </div>
              )}
              {sourceReviewId && (
                <div>
                  <dt>来源回顾</dt>
                  <dd>
                    <Link to={`/review/${sourceReviewId}`}>打开来源回顾 →</Link>
                  </dd>
                </div>
              )}
              {current.status === 'cancelled' && current.cancelledAt && (
                <div>
                  <dt>取消于</dt>
                  <dd>{formatDateTimeInTimezone(current.cancelledAt, displayTimezone)}</dd>
                </div>
              )}
            </dl>

            {notice && (
              <p className="save-ok" role="status">
                {notice}
              </p>
            )}
            {cancelError && (
              <p className="error-msg" role="alert">
                {cancelError}
              </p>
            )}

            {current.status === 'active' && (
              <>
                <div className="row-actions schedule-detail-actions">
                  <button type="button" className="btn primary" onClick={() => setMode('edit')}>
                    修改时间
                  </button>
                  <button
                    type="button"
                    className="btn danger-outline"
                    data-testid="schedule-cancel"
                    disabled={cancelling || confirmingCancel}
                    aria-expanded={confirmingCancel}
                    onClick={() => {
                      setCancelError(null);
                      setConfirmingCancel(true);
                    }}
                  >
                    取消安排
                  </button>
                  {current.attempt && (
                    <Link className="btn" to={`/attempt/${current.attempt.id}`}>
                      打开尝试
                    </Link>
                  )}
                </div>
                <p className="hint schedule-cancel-hint">
                  「取消安排」只取消这一段时间，不会放弃尝试，也不会删除尝试或念头记录。
                </p>

                {confirmingCancel && (
                  <div
                    className="conflict-banner"
                    role="alertdialog"
                    aria-label="确认取消这次安排"
                    data-testid="schedule-cancel-confirm-panel"
                  >
                    <p>
                      <strong>确认取消这次安排？</strong>
                    </p>
                    <p>
                      将取消 {formatScheduleFullRange(current, displayTimezone)} 这一段安排，取消后不能恢复原状；
                      尝试本身、念头和已记录的结果都不受影响，也不会改变尝试状态。
                    </p>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn danger-outline"
                        data-testid="schedule-cancel-confirm"
                        ref={confirmCancelRef}
                        disabled={cancelling}
                        onClick={() => void cancelSchedule()}
                      >
                        {cancelling ? '取消中…' : '确认取消安排'}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        data-testid="schedule-cancel-abort"
                        disabled={cancelling}
                        onClick={() => {
                          setConfirmingCancel(false);
                          setCancelError(null);
                        }}
                      >
                        返回
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {current.status === 'cancelled' && (
              <div className="row-actions schedule-detail-actions">
                {current.attempt && (
                  <Link className="btn" to={`/attempt/${current.attempt.id}`}>
                    打开尝试
                  </Link>
                )}
                <button type="button" className="btn" onClick={onClose}>
                  关闭
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
