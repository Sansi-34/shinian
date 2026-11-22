// 拾念 V2 · 深度研究列表（支持从任意念头发起 GitHub 调研 + 查看历史研究）
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api';
import type { Capture, ResearchListItem } from '../types';
import ResearchStarter from '../components/ResearchStarter';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Row from './ui/Row';
import Pill, { type StatusKind } from './ui/Pill';
import Button from './ui/Button';
import Modal from './ui/Modal';
import Spinner from './ui/Spinner';
import { dayLabel } from './format';
import { todayDateKey, useDisplayTimezone } from '../scheduleTime';
import './shared.css';
import './empty-page.css';

function errText(e: unknown, fallback: string) {
  const anyErr = e as { status?: number; body?: { message?: string }; message?: string };
  if (anyErr?.body?.message) return anyErr.body.message;
  if (anyErr?.status === 0 || anyErr?.message === 'Failed to fetch') return '网络连接失败，请检查网络或服务是否在运行，然后重试。';
  return fallback;
}

const STATUS: Record<string, { kind: StatusKind; label: string }> = {
  searching: { kind: 'active', label: '检索中' },
  candidates: { kind: 'active', label: '待选仓库' },
  fetching: { kind: 'active', label: '读取资料' },
  generating: { kind: 'active', label: '生成对比' },
  succeeded: { kind: 'done', label: '已完成' },
  failed: { kind: 'fail', label: '失败' },
  cancelled: { kind: 'idle', label: '已取消' },
  interrupted: { kind: 'partial', label: '已中断' },
};

export default function ResearchV2Page() {
  const navigate = useNavigate();
  const [timezone] = useDisplayTimezone();
  const [items, setItems] = useState<ResearchListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 发起新研究弹窗：先选一条念头，再进入 ResearchStarter 确认范围
  const [pickerOpen, setPickerOpen] = useState(false);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [capturesLoading, setCapturesLoading] = useState(false);
  const [activeCapture, setActiveCapture] = useState<Capture | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listSavedResearch(20);
      setItems(res.research ?? []);
    } catch (e) {
      setError(errText(e, '研究列表加载失败，请重试。'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openNewResearch() {
    setPickerOpen(true);
    setActiveCapture(null);
    setCapturesLoading(true);
    try {
      const res = await api.listCaptures(false);
      const thoughts = (res.captures ?? []).filter((c) => c.kind !== 'experience');
      setCaptures(thoughts);
    } catch {
      setCaptures([]);
    } finally {
      setCapturesLoading(false);
    }
  }

  const done = items.filter((r) => r.status === 'succeeded').length;
  const failed = items.filter((r) => r.status === 'failed' || r.status === 'interrupted').length;
  const isEmpty = !loading && !error && items.length === 0;

  return (
    <V2Shell
      rightTitle="概览"
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">操作</h3>
            <div className="v2-sideActions">
              <button
                type="button"
                className="v2-sideAction"
                onClick={() => void openNewResearch()}
                data-testid="research-new-btn"
              >
                <span>+ 发起新研究（GitHub）</span>
              </button>
            </div>
          </div>
          <div>
            <h3 className="v2-groupTitle">研究</h3>
            <div className="v2-groupItem">
              已完成
              <span>{done}</span>
            </div>
            <div className="v2-groupItem">
              失败 / 中断
              <span>{failed}</span>
            </div>
            <div className="v2-groupItem">
              共保存
              <span>{items.length}</span>
            </div>
          </div>
          <div>
            <h3 className="v2-groupTitle">说明</h3>
            <p className="v2-groupNote">
              研究只读获取 GitHub 公开仓库元数据、README、许可证和发布资料（最多 10 个候选、深入比较 3 个），结论必须标注外部依据。
            </p>
          </div>
        </>
      }
      statusLeft={`研究 ${items.length} · 已完成 ${done}`}
      statusRight={<span>GitHub 只读调研</span>}
    >
      {isEmpty ? (
        <div className="v2-empty">
          <div className="v2-empty-mark" aria-hidden="true" />
          <h2 className="v2-empty-title">还没有保存的研究</h2>
          <p className="v2-empty-text">
            研究只读取 GitHub 公开仓库资料，最多列出 10 个候选、深入比较 3 个，并可把选中的小实验存为自己的尝试。
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <Button variant="primary" onClick={() => void openNewResearch()} data-testid="research-empty-start">
              从念头发起研究 →
            </Button>
            <Link className="v2-ghostLink" to="/settings/ai">
              配置模型 / GitHub Token
            </Link>
          </div>
        </div>
      ) : (
        <Module title="已保存的研究" count={items.length}>
          {loading && <p className="v2-state"><Spinner /></p>}
          {!loading && error && (
            <p className="v2-state">
              {error}
              <button type="button" className="v2-linkBtn" onClick={() => void load()}>
                重试
              </button>
            </p>
          )}
          {items.map((r, i) => {
            const st = STATUS[r.status] ?? { kind: 'idle' as StatusKind, label: r.status };
            return (
              <Row
                key={r.id}
                index={i}
                time={dayLabel(r.createdAt, timezone, todayDateKey(timezone))}
                to={'/research/' + r.id}
                title={r.question}
                sub={r.summary || (r.errorCode ? '错误：' + r.errorCode : '未生成结论')}
                side={<Pill kind={st.kind}>{st.label}</Pill>}
              />
            );
          })}
        </Module>
      )}

      <Modal
        open={pickerOpen}
        title={activeCapture ? '确认研究问题与范围' : '选择一条念头发起 GitHub 研究'}
        onClose={() => {
          setPickerOpen(false);
          setActiveCapture(null);
        }}
        width={680}
      >
        {!activeCapture ? (
          <>
            <p className="v2-groupNote">
              研究需要挂在一条已有念头上，之后采纳的小实验会存成这条念头的尝试。
            </p>
            {capturesLoading && <Spinner label="加载念头中…" />}
            {!capturesLoading && captures.length === 0 && (
              <p className="v2-groupNote">
                还没有念头，请先回 <Link to="/">首页</Link> 记一条念头。
              </p>
            )}
            {captures.slice(0, 30).map((c) => (
              <div key={c.id} className="v2-candRow">
                <span className="v2-candText">{c.rawText.slice(0, 72)}</span>
                <Button onClick={() => setActiveCapture(c)}>选这条</Button>
              </div>
            ))}
          </>
        ) : (
          <ResearchStarter
            capture={activeCapture}
            onClose={() => {
              setPickerOpen(false);
              setActiveCapture(null);
            }}
            onStarted={(researchId) => {
              setPickerOpen(false);
              setActiveCapture(null);
              navigate('/research/' + researchId);
            }}
          />
        )}
      </Modal>
    </V2Shell>
  );
}
