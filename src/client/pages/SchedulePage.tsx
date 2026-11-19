// 拾念 SHINIAN v0.2 - 日程页：今日 / 本周视图 + 显示时区切换
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import type { NextAction, ScheduleBlock } from '../types';
import { STATE_LABEL } from '../types';
import {
  DISPLAY_TIMEZONES,
  addDaysToDateKey,
  formatDateKeyLabel,
  formatMonthDay,
  formatScheduleTimeRange,
  formatWeekRangeLabel,
  isCrossDaySchedule,
  isSchedulePast,
  readStoredDisplayTimezoneWithNotice,
  scheduleCoversDate,
  sortSchedules,
  startOfWeekDateKey,
  storeDisplayTimezone,
  timezoneFallbackNotice,
  todayDateKey,
  useDisplayTimezone,
  useNow,
  weekDateKeys,
  weekdayLabel,
} from '../scheduleTime';
import ScheduleDetailModal from '../components/ScheduleDetailModal';

type ViewMode = 'today' | 'week';

export default function SchedulePage() {
  const [timezone, setTimezone] = useDisplayTimezone();
  // 浏览器里存的显示时区若非法，scheduleTime 会回退到默认时区；
  // 这里把那句提示显示出来，避免「时间怎么不是我设的」这种困惑。
  const [timezoneFallback] = useState(() => readStoredDisplayTimezoneWithNotice().rejectedTimezone);
  const [fallbackDismissed, setFallbackDismissed] = useState(false);
  const [view, setView] = useState<ViewMode>('today');
  const [anchorDate, setAnchorDate] = useState(() => todayDateKey(timezone));
  const [schedules, setSchedules] = useState<ScheduleBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [detail, setDetail] = useState<ScheduleBlock | null>(null);
  const [selectedWeekDay, setSelectedWeekDay] = useState(() => todayDateKey(timezone));
  // 日程列表的 attempt 摘要若来自旧服务端（没有 origin 字段），
  // 用下一步行动详情补足「来自回顾」标记与来源链接。
  const [nextActionFallback, setNextActionFallback] = useState<Record<string, NextAction>>({});
  const now = useNow();

  const weekStart = startOfWeekDateKey(anchorDate);
  const rangeFrom = view === 'today' ? anchorDate : weekStart;
  const rangeTo = addDaysToDateKey(rangeFrom, view === 'today' ? 1 : 7);
  const todayKey = todayDateKey(timezone);
  const isAnchorToday = anchorDate === todayKey;
  const isCurrentWeek = weekStart === startOfWeekDateKey(todayKey);

  const timezoneOptions = useMemo(() => {
    if (DISPLAY_TIMEZONES.some((option) => option.value === timezone)) {
      return DISPLAY_TIMEZONES;
    }
    return [{ value: timezone, label: timezone }, ...DISPLAY_TIMEZONES];
  }, [timezone]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listSchedules({ from: rangeFrom, to: rangeTo, timezone })
      .then((res) => {
        if (cancelled) return;
        setSchedules(sortSchedules(res.schedules ?? []));
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.body?.message || e?.message || '日程加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rangeFrom, rangeTo, timezone, refreshKey]);

  useEffect(() => {
    const attemptIds = [
      ...new Set(
        schedules
          .filter((schedule) => schedule.attempt && !schedule.attempt.origin)
          .map((schedule) => schedule.attempt!.id)
      ),
    ];
    if (attemptIds.length === 0) {
      setNextActionFallback({});
      return;
    }
    let active = true;
    void Promise.all(
      attemptIds.map(async (attemptId) => {
        try {
          const res = await api.getNextAction(attemptId);
          return res.action;
        } catch {
          return null;
        }
      })
    ).then((actions) => {
      if (!active) return;
      const map: Record<string, NextAction> = {};
      for (const action of actions) {
        if (action) map[action.id] = action;
      }
      setNextActionFallback(map);
    });
    return () => {
      active = false;
    };
  }, [schedules]);

  useEffect(() => {
    setSelectedWeekDay((prev) => {
      const week = weekDateKeys(anchorDate);
      return week.includes(prev) ? prev : week[0];
    });
  }, [anchorDate]);

  const todayItems = useMemo(
    () => schedules.filter((schedule) => scheduleCoversDate(schedule, anchorDate, timezone)),
    [schedules, anchorDate, timezone]
  );

  const weekDays = useMemo(
    () =>
      weekDateKeys(anchorDate).map((key) => ({
        key,
        items: schedules.filter((schedule) => scheduleCoversDate(schedule, key, timezone)),
      })),
    [schedules, anchorDate, timezone]
  );

  function shiftPeriod(direction: -1 | 1) {
    setAnchorDate((prev) => addDaysToDateKey(prev, view === 'week' ? direction * 7 : direction));
  }

  function goToday() {
    const next = todayDateKey(timezone);
    setAnchorDate(next);
    setSelectedWeekDay(next);
  }

  function switchView(next: ViewMode) {
    setView(next);
    if (next === 'week') {
      const week = weekDateKeys(anchorDate);
      setSelectedWeekDay(week.includes(todayKey) ? todayKey : week[0]);
    }
  }

  function scrollToWeekDay(key: string) {
    setSelectedWeekDay(key);
    const element = document.getElementById(`week-day-${key}`);
    element?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }

  function handleChanged(updated: ScheduleBlock) {
    setSchedules((prev) => {
      if (updated.status === 'cancelled') {
        return prev.filter((item) => item.id !== updated.id);
      }
      const exists = prev.some((item) => item.id === updated.id);
      if (!exists) return sortSchedules([...prev, updated]);
      return sortSchedules(prev.map((item) => (item.id === updated.id ? updated : item)));
    });
    setDetail((prev) => (prev && prev.id === updated.id ? updated : prev));
  }

  function renderScheduleItem(schedule: ScheduleBlock, dayKey?: string) {
    const crossDay = isCrossDaySchedule(schedule, timezone);
    const past = isSchedulePast(schedule, now);
    const fallback = schedule.attempt ? nextActionFallback[schedule.attempt.id] : null;
    const fromReview = schedule.attempt?.origin === 'review_next_action' || Boolean(fallback);
    const sourceReviewId =
      schedule.attempt?.sourceReviewId ?? fallback?.sourceReviewId ?? null;
    const hasLinks = Boolean(sourceReviewId || fromReview || schedule.capture);
    return (
      <li key={dayKey ? `${dayKey}-${schedule.id}` : schedule.id} className="schedule-item">
        <button
          type="button"
          className="schedule-item-main"
          data-testid="schedule-detail"
          onClick={() => setDetail(schedule)}
          aria-label={`查看安排详情：${formatScheduleTimeRange(schedule, timezone)} ${
            schedule.attempt?.step ?? ''
          }`}
        >
          <span className="schedule-item-time">
            {formatScheduleTimeRange(schedule, timezone)}
          </span>
          <span className="schedule-item-title">
            {schedule.attempt?.step ?? '（尝试已删除）'}
          </span>
          <span className="schedule-item-meta">
            {crossDay && <span className="badge">跨日</span>}
            {past && <span className="badge warn">已过安排时间</span>}
            {fromReview && <span className="badge ai-kind">来自回顾</span>}
            {schedule.attempt && (
              <span className={`badge state-${schedule.attempt.state}`}>
                {STATE_LABEL[schedule.attempt.state]}
              </span>
            )}
            <span className="schedule-open-hint">查看详情</span>
          </span>
        </button>
        {hasLinks && (
          <div className="schedule-item-links">
            {sourceReviewId && <Link to={`/review/${sourceReviewId}`}>来源回顾</Link>}
            {fromReview && schedule.attempt && (
              <Link to={`/next-action/${schedule.attempt.id}`}>下一步行动</Link>
            )}
            {schedule.capture && (
              <Link to={`/capture/${schedule.capture.id}`}>所属念头</Link>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="page schedule-page">
      <header className="schedule-page-head">
        <div>
          <span className="page-kicker">实践节奏 · 日程安排</span>
          <h1 className="page-title">实践日程</h1>
          <p className="page-subtitle">
            {view === 'today'
              ? `${isAnchorToday ? '今天' : '查看'} · ${formatDateKeyLabel(anchorDate)}`
              : `${isCurrentWeek ? '本周' : '这一周'} · ${formatWeekRangeLabel(weekStart)}`}
            <span className="schedule-subtitle-sep"> · </span>
            显示时区 {timezone} · 安排是规划时间，不会强行变更尝试状态
          </p>
        </div>
        <label className="field schedule-timezone-field">
          <span>显示时区</span>
          <select
            data-testid="display-timezone"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          >
            {timezoneOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}（{option.value}）
              </option>
            ))}
          </select>
        </label>
      </header>

      {timezoneFallback && !fallbackDismissed && (
        <div className="conflict-banner" role="status" data-testid="timezone-fallback-notice">
          <p>
            <strong>显示时区已回退。</strong>
            {timezoneFallbackNotice(timezoneFallback)}
          </p>
          <div className="row-actions">
            <button
              type="button"
              className="btn small"
              onClick={() => {
                storeDisplayTimezone(timezone);
                setFallbackDismissed(true);
              }}
            >
              修正为 {timezone}
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => setFallbackDismissed(true)}
            >
              知道了
            </button>
          </div>
        </div>
      )}

      <div className="schedule-toolbar">
        <div className="schedule-view-tabs" role="tablist" aria-label="日程视图">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'today'}
            className={view === 'today' ? 'tab active' : 'tab'}
            onClick={() => switchView('today')}
          >
            今日
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'week'}
            className={view === 'week' ? 'tab active' : 'tab'}
            onClick={() => switchView('week')}
          >
            本周
          </button>
        </div>
        <div className="schedule-period-nav">
          <button
            type="button"
            className="btn small"
            data-testid="week-nav-prev"
            aria-label={view === 'week' ? '上一周' : '前一天'}
            onClick={() => shiftPeriod(-1)}
          >
            {view === 'week' ? '上一周' : '前一天'}
          </button>
          <button type="button" className="btn small" data-testid="week-today" onClick={goToday}>
            回到今天
          </button>
          <button
            type="button"
            className="btn small"
            data-testid="week-nav-next"
            aria-label={view === 'week' ? '下一周' : '后一天'}
            onClick={() => shiftPeriod(1)}
          >
            {view === 'week' ? '下一周' : '后一天'}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="muted loading-line" role="status">
          <span className="spinner" aria-hidden="true" /> 加载日程…
        </p>
      ) : error ? (
        <div className="schedule-error state" role="alert">
          <p className="error-msg">{error}</p>
          <button type="button" className="btn" onClick={() => setRefreshKey((key) => key + 1)}>
            重试
          </button>
        </div>
      ) : view === 'today' ? (
        <section className="section schedule-today-section" aria-label="今日安排">
          <div className="section-head">
            <h2>{formatDateKeyLabel(anchorDate)}</h2>
            <span className="muted">{todayItems.length} 个安排</span>
          </div>
          {todayItems.length === 0 ? (
            <div className="empty-state schedule-empty">
              <p>{isAnchorToday ? '今天没有安排。' : '这一天没有安排。'}</p>
              <p className="muted">日程来自尝试：先打开一个念头，创建尝试后就能安排时间。</p>
              <Link className="btn small" to="/">
                去念头里安排
              </Link>
            </div>
          ) : (
            <ul className="schedule-list">{todayItems.map((item) => renderScheduleItem(item))}</ul>
          )}
        </section>
      ) : (
        <>
          <div className="week-day-tabs" role="tablist" aria-label="选择本周日期">
            {weekDays.map(({ key, items }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={selectedWeekDay === key}
                className={`week-day-tab${selectedWeekDay === key ? ' active' : ''}${
                  key === todayKey ? ' is-today' : ''
                }`}
                onClick={() => scrollToWeekDay(key)}
              >
                <span>{weekdayLabel(key)}</span>
                <span className="week-day-tab-date">{formatMonthDay(key)}</span>
                <span className="week-day-tab-count">{items.length}</span>
              </button>
            ))}
          </div>

          <div className="week-board">
            {weekDays.map(({ key, items }) => (
              <section
                key={key}
                id={`week-day-${key}`}
                className={`week-day${key === todayKey ? ' is-today' : ''}`}
                aria-label={`${formatDateKeyLabel(key)}的安排`}
              >
                <header className="week-day-head">
                  <div>
                    <strong>{weekdayLabel(key)}</strong>
                    <span className="week-day-date">{formatMonthDay(key)}</span>
                  </div>
                  {key === todayKey && <span className="badge">今天</span>}
                </header>
                {items.length === 0 ? (
                  <p className="week-day-empty">没有安排</p>
                ) : (
                  <ul className="week-day-list">
                    {items.map((item) => renderScheduleItem(item, key))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </>
      )}

      <p className="hint schedule-footnote">
        日程只是「打算什么时候做」，不会改变尝试状态。取消安排也只影响这一段时间。
      </p>

      {detail && (
        <ScheduleDetailModal
          schedule={detail}
          displayTimezone={timezone}
          onClose={() => setDetail(null)}
          onChanged={handleChanged}
        />
      )}
    </div>
  );
}
