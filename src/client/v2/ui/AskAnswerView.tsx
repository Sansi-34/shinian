// 问答答案的统一渲染：主页面与详情页共用
import type { AskPublic } from '../../types';
import Pill from './Pill';

export default function AskAnswerView({ query }: { query: AskPublic }) {
  const answer = query.answer;
  if (!answer) return null;
  return (
    <div className="v2-form" style={{ width: '100%' }}>
      {answer.insufficientEvidence && (
        <p className="v2-state" style={{ color: 'var(--st-partial)' }}>
          记录里不足以回答这个问题。下面是它认为还缺什么。
        </p>
      )}

      <p className="v2-captureText" style={{ fontSize: 'var(--fs-body)' }}>
        {answer.summary}
      </p>

      {answer.points.length > 0 && (
        <div>
          <h3 className="v2-groupTitle">观点</h3>
          {answer.points.map((pt, i) => (
            <div key={i} className="v2-askPoint">
              <p className="v2-askPointText">{pt.text}</p>
              <div className="v2-askPointMeta">
                <Pill kind={pt.basis === 'observation' ? 'done' : 'partial'}>
                  {pt.basis === 'observation' ? '观察' : '推断'}
                </Pill>
                {pt.condition && <span className="v2-hint">条件：{pt.condition}</span>}
                <span className="v2-hint">来源 {pt.sourceIds.length} 条</span>
              </div>
            </div>
          ))}
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
                  <span key={k} className="v2-hint">
                    {s.condition || s.sourceId}
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
        <h3 className="v2-groupTitle">依据记录</h3>
        {query.sources.length === 0 && <p className="v2-groupNote">这次没有留下依据记录。</p>}
        {query.sources.map((s) => (
          <div key={s.sourceKey} className="v2-groupItem">
            <span>
              {s.title ?? s.text?.slice(0, 24) ?? '（记录已不在）'}
              {s.deleted ? ' · 已删除' : s.changed ? ' · 内容已改' : ''}
              {s.archived ? ' · 已归档' : ''}
            </span>
            <span className="v2-hint">{s.type === 'attempt' ? '尝试' : '念头'}</span>
          </div>
        ))}
      </div>

      {query.answerInvalidated && (
        <p className="v2-state">这份答案已失效：{query.answerInvalidReason ?? '来源记录有变化'}。建议重新问一次。</p>
      )}

      {query.hiddenPointCount > 0 && (
        <p className="v2-groupNote">有 {query.hiddenPointCount} 条观点因为来源已删除被隐藏，不给出来。</p>
      )}
    </div>
  );
}
