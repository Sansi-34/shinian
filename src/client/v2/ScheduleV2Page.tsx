// 拾念 V2 · 日程（未来 7 天只读视图；新建/改时间仍在旧版）
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import type { ScheduleBlock } from '../types';
import {
  addDaysToDateKey,
  dateKeyInTimezone,
  formatScheduleTimeRange,
  sortSchedules,
  todayDateKey,
  useDisplayTimezone,
} from '../scheduleTime';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Row from './ui/Row';
import Pill from './ui/Pill';
import './shared.css';

function errText(e: unknown, fallback: string) {
  const anyErr = e as { status?: number; body?: { message?: string }; message?: string };
  if (anyErr?.body?.message) return anyErr.body.message;
  if (anyErr?.status === 0 || anyErr?.message === 'Failed to fetch') return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  return fallback;
}

const DAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export default function ScheduleV2Page() {
  const [timezone] = useDisplayTimezone();
  const [items, setItems] = useState<ScheduleBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const today = todayDateKey(timezone);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listSchedules({ from: today, to: addDaysToDateKey(today, 7), timezone });
      setItems(sortSchedules(res.schedules ?? []));
    } catch (e) {
      setError(errText(e, '日程加载失败，请重试。'));
    } finally {
      setLoading(false);
    }
  }, [today, timezone]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map<string, ScheduleBlock[]>();
    for (const s of items) {
      const key = dateKeyInTimezone(s.startsAt, timezone);
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items, timezone]);

  const todayCount = items.filter((s) => dateKeyInTimezone(s.startsAt, timezone) === today).length;

  return (
    <V2Shell
      rightTitle="概览"
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">接下来 7 天</h3>
            <div className="v2-groupItem">
              今天
              <span>{todayCount}</span>
            </div>
            <div className="v2-groupItem">
              合计
              <span>{items.length}</span>
            </div>
            <div className="v2-groupItem">
              有日期的天
              <span>{groups.length}</span>
            </div>
          </div>
          <div>
            <h3 className="v2-groupTitle">说明</h3>
            <p className="v2-groupNote">日程只是时间占位，不会自动创建尝试或改状态；冲突需要你自己判断。</p>
            <Link className="v2-groupItem" to="/schedule">
              旧版日程页（新建 / 改时间）
              <span>→</span>
            </Link>
          </div>
        </>
      }
      statusLeft={`${today} · 今天 ${todayCount} 项 · 7 天内 ${items.length} 项`}
      statusRight={<span>{timezone}</span>}
    >
      {loading && <p className="v2-state">加载中…</p>}
      {!loading && error && (
        <p className="v2-state">
          {error}
          <button type="button" className="v2-linkBtn" onClick={() => void load()}>
            重试
          </button>
        </p>
      )}
      {!loading && !error && items.length === 0 && (
        <p className="v2-state">接下来 7 天没有安排。日程只能手动创建——去旧版日程页排一段时间。</p>
      )}

      {groups.map(([key, list]) => {
        const d = new Date(key + 'T00:00:00');
        const isToday = key === today;
        return (
          <Module key={key} title={`${isToday ? '今天' : DAY_LABEL[d.getDay()]} · ${key.slice(5)}`} count={list.length}>
            {list.map((s, i) => (
              <Row
                key={s.id}
                index={i}
                time={formatScheduleTimeRange(s, timezone)}
                to={s.attemptId ? '/v2/attempt/' + s.attemptId : '/schedule'}
                title={s.attempt?.step ?? s.note ?? '日程安排'}
                sub={s.capture ? '来自「' + s.capture.rawText + '」' : '无关联念头'}
                side={s.status === 'cancelled' ? <Pill kind="idle">已取消</Pill> : <Pill kind="active">已排日程</Pill>}
              />
            ))}
          </Module>
        );
      })}
    </V2Shell>
  );
}
