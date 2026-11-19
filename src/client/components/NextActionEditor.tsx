// 拾念 SHINIAN · 把阶段回顾里的一条经验变成下一步行动
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { ApiError } from '../api';
import type {
  AttemptOutcome,
  NextAction,
  NextActionConflict,
  NextActionPreview,
  NextActionPreviewSourceAttempt,
  NextActionScheduleInput,
} from '../types';
import {
  nextActionErrorText,
  newOperationId,
  OUTCOME_LABEL,
  STATE_LABEL,
} from '../types';
import {
  dateKeyDiffDays,
  formatScheduleFullRange,
  isValidDateKey,
  isValidTimeString,
  minutesOfTime,
  todayDateKey,
} from '../scheduleTime';

type Props = {
  reviewId: string;
  experienceIndex: number;
  onClose: () => void;
  onCreated: (action: NextAction) => void;
};

type LoadError = { code: string | null; message: string };

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function addMinutesToTime(start: string, minutes: number): string {
  const total = Math.min(23 * 60 + 59, minutesOfTime(start) + Math.max(1, minutes));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

function apiErrorCode(error: unknown): string | null {
  return error instanceof ApiError && typeof error.body?.error === 'string'
    ? error.body.error
    : null;
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return nextActionErrorText(error.body?.error, error.body?.message || fallback);
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function sourceAttemptDeleted(source: NextActionPreviewSourceAttempt): boolean {
  return source.deleted || source.exists === false;
}

function sourceOutcomeLabel(outcome: AttemptOutcome | null): string | null {
  return outcome ? OUTCOME_LABEL[outcome] : null;
}

export default function NextActionEditor({
  reviewId,
  experienceIndex,
  onClose,
  onCreated,
}: Props) {
  const [preview, setPreview] = useState<NextActionPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadError | null>(null);

  const [captureId, setCaptureId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [minutesInput, setMinutesInput] = useState('');
  const [scheduleEnabled, setScheduleEnabled] = useState(true);
  const [date, setDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [crossDay, setCrossDay] = useState(false);
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('10:30');

  const [titleError, setTitleError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [minutesError, setMinutesError] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<NextActionConflict | null>(null);
  const [sourceChanged, setSourceChanged] = useState(false);
  const [sourceDeleted, setSourceDeleted] = useState(false);
  const [captureChanged, setCaptureChanged] = useState(false);
  const [created, setCreated] = useState<NextAction | null>(null);
  const [replayed, setReplayed] = useState(false);

  const [contextToken, setContextToken] = useState('');
  const operationIdRef = useRef<string | null>(null);
  const lastSignatureRef = useRef<string | null>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadPreview(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId, experienceIndex]);

  function applyPreview(res: NextActionPreview, preserveDraft: boolean) {
    setPreview(res);
    setContextToken(res.contextToken);
    setLoadError(null);
    setSourceChanged(false);
    setSourceDeleted(false);
    setCaptureChanged(false);
    setReplayed(false);

    const defaultCapture =
      res.captures.find((item) => item.id === res.defaults.captureId) ?? res.captures[0] ?? null;
    const timezone = res.defaults.timezone || 'Asia/Shanghai';
    const suggestedDate =
      res.defaults.suggestedDate && isValidDateKey(res.defaults.suggestedDate)
        ? res.defaults.suggestedDate
        : todayDateKey(timezone);
    const defaultMinutes =
      typeof res.defaults.estimatedMinutes === 'number' ? res.defaults.estimatedMinutes : 30;

    if (!preserveDraft) {
      setCaptureId(defaultCapture?.id ?? '');
      setTitle(res.defaults.title ?? '');
      setDescription(res.defaults.description ?? '');
      setMinutesInput(
        typeof res.defaults.estimatedMinutes === 'number'
          ? String(res.defaults.estimatedMinutes)
          : ''
      );
      setDate(suggestedDate);
      setEndDate(suggestedDate);
      setCrossDay(false);
      setStartTime('10:00');
      setEndTime(addMinutesToTime('10:00', defaultMinutes));
    } else {
      setCaptureId((prev) =>
        res.captures.some((item) => item.id === prev) ? prev : defaultCapture?.id ?? ''
      );
      setDate((prev) => (isValidDateKey(prev) ? prev : suggestedDate));
      setEndDate((prev) => (isValidDateKey(prev) ? prev : suggestedDate));
    }
  }

  async function loadPreview(preserveDraft: boolean) {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.getNextActionPreview(reviewId, experienceIndex);
      applyPreview(res, preserveDraft);
    } catch (error) {
      const code = apiErrorCode(error);
      setLoadError({
        code,
        message: apiErrorMessage(error, '无法读取这条经验的下一步建议'),
      });
    } finally {
      setLoading(false);
    }
  }

  function selectedCaptureRevision(): number {
    if (!preview) return 0;
    return (
      preview.captures.find((item) => item.id === captureId)?.revision ??
      preview.captures[0]?.revision ??
      0
    );
  }

  function validate(): boolean {
    let ok = true;
    if (!captureId) {
      setSaveError('请选择这条行动所属的念头。');
      ok = false;
    }
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setTitleError('请填写行动标题。');
      ok = false;
    } else if (trimmedTitle.length > 120) {
      setTitleError('标题最多 120 字。');
      ok = false;
    } else {
      setTitleError(null);
    }
    if (description.length > 2000) {
      setDescriptionError('行动说明最多 2000 字。');
      ok = false;
    } else {
      setDescriptionError(null);
    }

    const minutesText = minutesInput.trim();
    if (minutesText) {
      const minutes = Number(minutesText);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        setMinutesError('预计耗时需为 1–1440 的整数分钟。');
        ok = false;
      } else {
        setMinutesError(null);
      }
    } else {
      setMinutesError(null);
    }

    if (scheduleEnabled) {
      const effectiveEndDate = crossDay ? endDate : date;
      if (!isValidDateKey(date)) {
        setScheduleError('请选择有效的计划日期。');
        ok = false;
      } else if (crossDay && !isValidDateKey(endDate)) {
        setScheduleError('请选择有效的结束日期。');
        ok = false;
      } else if (crossDay && isValidDateKey(endDate) && endDate < date) {
        setScheduleError('结束日期不能早于开始日期。');
        ok = false;
      } else if (!isValidTimeString(startTime) || !isValidTimeString(endTime)) {
        setScheduleError('请选择有效的开始和结束时间。');
        ok = false;
      } else if (isValidDateKey(effectiveEndDate)) {
        const durationMinutes =
          dateKeyDiffDays(date, effectiveEndDate) * 1440 +
          minutesOfTime(endTime) -
          minutesOfTime(startTime);
        if (durationMinutes <= 0) {
          setScheduleError(
            crossDay
              ? '结束时间必须晚于开始时间（跨日请确认结束日期已顺延）。'
              : '结束时间必须晚于开始时间；跨午夜请勾选「跨日」并设置结束日期。'
          );
          ok = false;
        } else if (durationMinutes > 7 * 1440) {
          setScheduleError('单次安排最长 7 天。');
          ok = false;
        } else {
          setScheduleError(null);
        }
      } else {
        setScheduleError(null);
      }
    } else {
      setScheduleError(null);
    }

    return ok;
  }

  function signatureFor(schedule: NextActionScheduleInput | null): string {
    return JSON.stringify({
      captureId,
      title: title.trim(),
      description: description.trim() || null,
      minutesInput,
      schedule,
      contextToken,
    });
  }

  async function submit(mode: 'normal' | 'confirm' | 'unscheduled') {
    if (saving || !preview || !contextToken) return;
    setSaveError(null);
    if (!validate()) return;

    const useSchedule = mode === 'unscheduled' ? false : scheduleEnabled;
    if (mode === 'confirm' && (!conflict || !conflict.conflictToken)) {
      setSaveError('冲突信息已变化，请重新保存后再确认。');
      return;
    }

    let schedule: NextActionScheduleInput | null = null;
    if (useSchedule) {
      schedule = {
        date,
        endDate: crossDay ? endDate : date,
        startTime,
        endTime,
        timezone: preview.defaults.timezone || 'Asia/Shanghai',
        note: null,
      };
      if (mode === 'confirm' && conflict) {
        schedule.confirmOverlap = true;
        schedule.conflictToken = conflict.conflictToken;
        schedule.expectedConflictIds = conflict.conflicts.map((item) => item.id).sort();
      }
    }

    const signature = signatureFor(schedule);
    let operationId = operationIdRef.current;
    if (!operationId || lastSignatureRef.current !== signature) {
      operationId = newOperationId();
      operationIdRef.current = operationId;
      lastSignatureRef.current = signature;
    }

    setSaving(true);
    try {
      const res = await api.createNextAction(reviewId, {
        captureId,
        captureRevision: selectedCaptureRevision(),
        experienceIndex,
        title: title.trim(),
        description: description.trim() ? description.trim() : null,
        estimatedMinutes: minutesInput.trim() ? Number(minutesInput) : null,
        contextToken,
        operationId,
        schedule,
      });
      operationIdRef.current = null;
      lastSignatureRef.current = null;
      setConflict(null);
      setCreated(res.nextAction);
      setReplayed(Boolean(res.replayed));
      onCreated(res.nextAction);
    } catch (error) {
      handleSaveError(error);
    } finally {
      setSaving(false);
    }
  }

  function handleSaveError(error: unknown) {
    if (!(error instanceof ApiError)) {
      setSaveError('网络异常，草稿已保留，请重试。');
      return;
    }
    const body: any = error.body ?? {};
    const code: string | null = typeof body.error === 'string' ? body.error : null;

    if (code === 'schedule_conflict' || code === 'schedule_conflict_changed') {
      const conflicts = Array.isArray(body.conflicts) ? body.conflicts : [];
      setConflict({
        error: code,
        message: body.message || nextActionErrorText(code),
        conflicts,
        conflictToken: typeof body.conflictToken === 'string' ? body.conflictToken : null,
        requiresConfirmation: true,
        options: body.options,
      });
      setSaveError(null);
      return;
    }

    // 时区/DST 类错误：服务端已经给出人话，这里补一句「下一步该怎么做」。
    if (code === 'nonexistent_local_time') {
      setSaveError(
        body.message ||
          '这个本地时间在夏令时切换中不存在，请换一个开始或结束时间。'
      );
      return;
    }

    if (code === 'ambiguous_local_time') {
      const zone = typeof body.zone === 'string' ? body.zone : '所选的时区';
      const local = typeof body.local === 'string' ? body.local : '这个本地时间';
      setSaveError(
        `${zone} 的 ${local} 在夏令时切换里出现了两次，这里不能自动猜。` +
          '可以把「加入日程」先取消、保存为未排程行动，再到这条行动的「日程安排 → 安排时间」里选择较早/较晚一次。'
      );
      return;
    }

    if (code === 'invalid_timezone') {
      setSaveError(
        `时区无效（${typeof body.timezone === 'string' ? body.timezone : '未知时区'}）。` +
          '请到日程页换一个显示时区后重试。'
      );
      return;
    }

    if (code === 'sources_changed') {
      if (Array.isArray(body.sourceAttempts)) {
        setPreview((prev) => (prev ? { ...prev, sourceAttempts: body.sourceAttempts } : prev));
      }
      if (typeof body.contextToken === 'string' && body.contextToken) {
        setContextToken(body.contextToken);
      }
      setSourceChanged(true);
      setSaveError(nextActionErrorText(code, body.message));
      return;
    }

    if (code === 'source_deleted') {
      setSourceDeleted(true);
      setSaveError(nextActionErrorText(code, body.message));
      return;
    }

    if (code === 'capture_changed') {
      if (typeof body.currentRevision === 'number') {
        setPreview((prev) =>
          prev
            ? {
                ...prev,
                captures: prev.captures.map((item) =>
                  item.id === captureId ? { ...item, revision: body.currentRevision } : item
                ),
              }
            : prev
        );
      }
      setCaptureChanged(true);
      setSaveError(nextActionErrorText(code, body.message));
      return;
    }

    if (code === 'operation_key_conflict') {
      operationIdRef.current = null;
      lastSignatureRef.current = null;
      setSaveError('这次提交与上一次不一致，请重新提交。');
      return;
    }

    setSaveError(apiErrorMessage(error, '保存下一步失败，请重试。'));
  }

  const allSourcesDeleted = Boolean(
    preview && preview.sourceAttempts.length > 0 && preview.sourceAttempts.every(sourceAttemptDeleted)
  );

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="把经验变成下一步">
      <div className="modal wide next-action-editor" data-testid="next-action-editor">
        <div className="next-action-editor-head">
          <div>
            <p className="page-kicker">下一步行动</p>
            <h3>把这条经验变成下一步</h3>
          </div>
          <button type="button" className="btn small" onClick={onClose} aria-label="关闭下一步编辑">
            关闭
          </button>
        </div>

        {loading && (
          <p className="muted loading-line" role="status">
            <span className="spinner" aria-hidden="true" /> 正在读取来源与建议…
          </p>
        )}

        {!loading && loadError && (
          <div role="alert">
            <p className="error-msg">{loadError.message}</p>
            <p className="hint">
              模型回顾文本只是建议；如果来源已删除，这里不会显示已删除的正文。
            </p>
            <div className="row-actions">
              <button type="button" className="btn" onClick={() => void loadPreview(false)}>
                重试
              </button>
              <Link className="btn" to={`/review/${reviewId}`}>
                返回回顾
              </Link>
            </div>
          </div>
        )}

        {!loading && preview && !loadError && created && (
          <div className="next-action-success" role="status">
            <h4>下一步行动已保存</h4>
            <p className="next-action-success-title">{created.title}</p>
            <p className="hint">
              {replayed
                ? '这次提交此前已处理过，没有重复创建下一步。'
                : '你确认后的标题与说明已保存为行动；AI 回顾文本仍是建议，不会自动变成事实。'}
            </p>
            <div className="row-actions next-action-success-actions">
              <Link
                className="btn primary"
                to={`/next-action/${created.id}`}
                data-testid="next-action-open"
              >
                查看下一步
              </Link>
              <Link className="btn" to={`/attempt/${created.id}`} data-testid="next-action-attempt">
                进入尝试
              </Link>
              <button type="button" className="btn" onClick={onClose}>
                返回回顾
              </button>
            </div>
          </div>
        )}

        {!loading && preview && !loadError && !created && (
          <>
            <p className="next-action-ai-note">
              下面是模型根据这次回顾生成的建议，不是事实。你保存的标题与说明会成为你确认的下一步行动。
            </p>

            <section className="next-action-experience" aria-label="来源经验（模型建议）">
              <div className="next-action-experience-head">
                <span className="next-action-experience-label">来源经验</span>
                <span className="badge ai-kind">模型推断/建议</span>
              </div>
              <p className="next-action-experience-text">{preview.experience.text}</p>
              <p className="hint">只读。来源记录如下，保存行动不会修改这些记录。</p>
              <ul className="next-action-preview-sources">
                {preview.sourceAttempts.map((source) => {
                  const deleted = sourceAttemptDeleted(source);
                  return (
                    <li key={source.attemptId} className={deleted ? 'deleted' : undefined}>
                      {deleted ? (
                        <span className="muted">来源已删除，不显示正文。</span>
                      ) : (
                        <>
                          <span className="next-action-preview-source-title">
                            {source.step || '来源尝试'}
                          </span>
                          {source.state && (
                            <span className={`badge state-${source.state}`}>
                              {STATE_LABEL[source.state]}
                            </span>
                          )}
                          {source.changed && <span className="badge warn">来源有更新</span>}
                          {sourceOutcomeLabel(source.outcome) && (
                            <span className={`badge outcome-${source.outcome}`}>
                              {sourceOutcomeLabel(source.outcome)}
                            </span>
                          )}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>

            <form
              className="next-action-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void submit('normal');
              }}
            >
              <label className="field">
                <span>当前念头</span>
                <select
                  data-testid="next-action-capture"
                  value={captureId}
                  onChange={(event) => {
                    setCaptureId(event.target.value);
                    setCaptureChanged(false);
                    setSaveError(null);
                  }}
                  required
                >
                  {preview.captures.map((capture) => (
                    <option key={capture.id} value={capture.id}>
                      {capture.rawText.length > 80
                        ? `${capture.rawText.slice(0, 80)}…`
                        : capture.rawText}
                    </option>
                  ))}
                </select>
                <span className="field-hint">下一步行动会挂在这条念头下。</span>
              </label>

              <label className="field">
                <span>建议行动标题</span>
                <input
                  data-testid="next-action-title"
                  type="text"
                  value={title}
                  maxLength={120}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setTitleError(null);
                  }}
                  placeholder="例如「只在 2 kHz 下复测闪烁」"
                  required
                />
                {titleError && <span className="field-error">{titleError}</span>}
              </label>

              <label className="field">
                <span>行动说明（选填）</span>
                <textarea
                  data-testid="next-action-description"
                  rows={3}
                  value={description}
                  maxLength={2000}
                  onChange={(event) => {
                    setDescription(event.target.value);
                    setDescriptionError(null);
                  }}
                  placeholder="例如「固定其他条件，只改变频率。」"
                />
                <span className="char-count">{description.length}/2000</span>
                {descriptionError && <span className="field-error">{descriptionError}</span>}
              </label>

              <label className="field">
                <span>预计耗时（分钟，选填）</span>
                <input
                  data-testid="next-action-minutes"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1440}
                  value={minutesInput}
                  onChange={(event) => {
                    setMinutesInput(event.target.value);
                    setMinutesError(null);
                  }}
                  placeholder="例如 30"
                />
                {minutesError && <span className="field-error">{minutesError}</span>}
              </label>

              <label className="schedule-check next-action-schedule-toggle">
                <input
                  data-testid="next-action-schedule-toggle"
                  type="checkbox"
                  checked={scheduleEnabled}
                  onChange={(event) => {
                    setScheduleEnabled(event.target.checked);
                    setConflict(null);
                    setScheduleError(null);
                  }}
                />
                <span>加入日程</span>
              </label>
              <p className="hint">加入日程只是安排打算什么时候做；不加入也可以先保存为未排程行动。</p>

              <div className="next-action-schedule-fields">
                <label className="field">
                  <span>计划日期</span>
                  <input
                    ref={dateInputRef}
                    data-testid="next-action-date"
                    type="date"
                    value={date}
                    disabled={!scheduleEnabled}
                    onChange={(event) => {
                      const next = event.target.value;
                      setDate(next);
                      if (!crossDay) setEndDate(next);
                      else if (endDate && next && endDate < next) setEndDate(next);
                      setScheduleError(null);
                      setConflict(null);
                    }}
                  />
                </label>
                <label className="field">
                  <span>开始时间</span>
                  <input
                    data-testid="next-action-start-time"
                    type="time"
                    value={startTime}
                    disabled={!scheduleEnabled}
                    onChange={(event) => {
                      setStartTime(event.target.value);
                      setScheduleError(null);
                      setConflict(null);
                    }}
                  />
                </label>
                <label className="field">
                  <span>结束时间</span>
                  <input
                    data-testid="next-action-end-time"
                    type="time"
                    value={endTime}
                    disabled={!scheduleEnabled}
                    onChange={(event) => {
                      setEndTime(event.target.value);
                      setScheduleError(null);
                      setConflict(null);
                    }}
                  />
                </label>
              </div>

              <label className="schedule-check">
                <input
                  data-testid="next-action-crossday"
                  type="checkbox"
                  checked={crossDay}
                  disabled={!scheduleEnabled}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setCrossDay(checked);
                    if (!checked) {
                      setEndDate(date);
                    } else if (
                      isValidDateKey(date) &&
                      isValidTimeString(startTime) &&
                      isValidTimeString(endTime) &&
                      minutesOfTime(endTime) <= minutesOfTime(startTime)
                    ) {
                      // 跨午夜：勾上就把结束日期顺延一天，省一次手填。
                      const nextDay = new Date(`${date}T00:00:00`);
                      nextDay.setDate(nextDay.getDate() + 1);
                      setEndDate(
                        `${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(
                          2,
                          '0'
                        )}-${String(nextDay.getDate()).padStart(2, '0')}`
                      );
                    } else if (!isValidDateKey(endDate)) {
                      setEndDate(date);
                    }
                    setScheduleError(null);
                    setConflict(null);
                  }}
                />
                <span>跨日（结束日期与开始日期不同）</span>
              </label>

              {crossDay && (
                <label className="field next-action-end-date">
                  <span>结束日期</span>
                  <input
                    data-testid="next-action-end-date"
                    type="date"
                    value={endDate}
                    min={date || undefined}
                    disabled={!scheduleEnabled}
                    onChange={(event) => {
                      setEndDate(event.target.value);
                      setScheduleError(null);
                      setConflict(null);
                    }}
                  />
                </label>
              )}
              {crossDay &&
                isValidDateKey(date) &&
                isValidDateKey(endDate) &&
                isValidTimeString(startTime) &&
                isValidTimeString(endTime) &&
                dateKeyDiffDays(date, endDate) * 1440 +
                  minutesOfTime(endTime) -
                  minutesOfTime(startTime) >
                  0 && (
                  <p className="hint">
                    将安排在 {date} {startTime} – {endDate} {endTime}（跨日，最长 7 天）。
                  </p>
                )}
              {scheduleError && <p className="field-error">{scheduleError}</p>}

              {!sourceChanged &&
                preview.sourceAttempts.some(
                  (source) => source.changed && !sourceAttemptDeleted(source)
                ) && (
                  <div className="conflict-banner" role="status" data-testid="next-action-source-changed">
                    <p>
                      <strong>来源记录有更新。</strong>
                      预览里的来源尝试在回顾保存后被修改；保存前请确认最新来源。
                    </p>
                  </div>
                )}

              {sourceDeleted && (
                <div className="review-banner danger" role="alert" data-testid="next-action-source-deleted">
                  <strong>来源已删除</strong>
                  <p>这条经验依赖的来源记录已删除，无法继续创建下一步；已删除来源的正文不会显示。</p>
                </div>
              )}

              {sourceChanged && (
                <div className="conflict-banner" role="alert" data-testid="next-action-source-changed">
                  <p>
                    <strong>来源记录有变化。</strong>
                    请确认下方最新来源后继续；你的草稿仍然保留。
                  </p>
                  <ul className="next-action-preview-sources">
                    {preview.sourceAttempts.map((source) => (
                      <li key={source.attemptId}>
                        <span className="next-action-preview-source-title">
                          {sourceAttemptDeleted(source) ? '来源已删除' : source.step || '来源尝试'}
                        </span>
                        {!sourceAttemptDeleted(source) && source.state && (
                          <span className="badge">{STATE_LABEL[source.state]}</span>
                        )}
                        {!sourceAttemptDeleted(source) && source.changed && (
                          <span className="badge warn">来源有更新</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn primary"
                      disabled={saving}
                      onClick={() => void submit('normal')}
                    >
                      用最新来源继续保存
                    </button>
                  </div>
                </div>
              )}

              {captureChanged && (
                <div className="conflict-banner" role="alert">
                  <p>念头内容在编辑期间发生了变化，请刷新来源后再保存；草稿仍保留。</p>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => void loadPreview(true)}
                    >
                      刷新来源
                    </button>
                  </div>
                </div>
              )}

              {conflict && (
                <div
                  className="conflict-banner schedule-conflict-panel"
                  role="alert"
                  data-testid="next-action-conflict"
                >
                  <p>
                    <strong>
                      {conflict.error === 'schedule_conflict_changed'
                        ? '冲突安排有变化。'
                        : conflict.message || '与现有安排重叠。'}
                    </strong>
                  </p>
                  {conflict.conflicts.length > 0 ? (
                    <ul className="schedule-conflict-list">
                      {conflict.conflicts.map((item) => (
                        <li key={item.id}>
                          <span>{formatScheduleFullRange(item, item.timezone)}</span>
                          <span className="muted">
                            {item.attempt?.step ?? '（尝试已删除）'} · {item.timezone}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">服务端没有返回具体冲突对象，请再次确认。</p>
                  )}
                  <p className="hint">
                    「仍然保存」会让两段安排同时存在；相邻时段不算重叠。也可以改成未排程行动。
                  </p>
                  <div className="row-actions next-action-conflict-actions">
                    <button
                      type="button"
                      className="btn primary"
                      data-testid="next-action-confirm-overlap"
                      disabled={saving || !conflict.conflictToken}
                      onClick={() => void submit('confirm')}
                    >
                      {saving ? '保存中…' : '仍然保存'}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={saving}
                      onClick={() => {
                        setConflict(null);
                        dateInputRef.current?.focus();
                      }}
                    >
                      修改时间
                    </button>
                    <button
                      type="button"
                      className="btn"
                      data-testid="next-action-save-unscheduled"
                      disabled={saving}
                      onClick={() => void submit('unscheduled')}
                    >
                      保存为未排程行动
                    </button>
                    <Link className="btn" to="/schedule">
                      查看冲突日程
                    </Link>
                  </div>
                </div>
              )}

              {saveError && (
                <p className="error-msg" role="alert">
                  {saveError}
                </p>
              )}

              <div className="row-actions next-action-form-actions">
                <button
                  type="submit"
                  className="btn primary"
                  data-testid="next-action-save"
                  disabled={saving || sourceDeleted || allSourcesDeleted}
                >
                  {saving ? '保存中…' : '保存下一步'}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={saving}
                  onClick={() => {
                    setScheduleEnabled(false);
                    setConflict(null);
                  }}
                >
                  取消加入日程
                </button>
                <button type="button" className="btn" onClick={onClose} disabled={saving}>
                  取消
                </button>
              </div>
              {allSourcesDeleted && !sourceDeleted && (
                <p className="hint" data-testid="next-action-source-deleted">
                  预览里的来源尝试都已删除；保存可能返回「来源已删除」，不会显示已删除正文。
                </p>
              )}
            </form>
          </>
        )}
      </div>
    </div>
  );
}
