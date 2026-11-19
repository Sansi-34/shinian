// 拾念 V2 · 组件样板页（/kit）
// 目的：把 V2 的零件与引入的交互摆在一起，方便肉眼确认节奏与样式。
// 这里不连真实数据，全部是本地状态。
import { useState } from 'react';
import V2Shell from './V2Shell';
import Module from './ui/Module';
import Row from './ui/Row';
import Pill, { type StatusKind } from './ui/Pill';
import Button from './ui/Button';
import GhostChip from './ui/GhostChip';
import Spinner from './ui/Spinner';
import Segment from './ui/Segment';
import HoldConfirm from './ui/HoldConfirm';
import CopyButton from './ui/CopyButton';
import DateField from './ui/DateField';
import Modal from './ui/Modal';
import { useDisplayTimezone } from '../scheduleTime';
import { dayTimeLabel } from './format';
import './shared.css';

const KINDS: Array<{ kind: StatusKind; label: string }> = [
  { kind: 'active', label: '进行中' },
  { kind: 'done', label: '已记录结果' },
  { kind: 'partial', label: '部分成功' },
  { kind: 'fail', label: '未达成' },
  { kind: 'idle', label: '未开始' },
];

export default function KitPage() {
  const [tz] = useDisplayTimezone();
  const [seg, setSeg] = useState<'a' | 'b' | 'c'>('a');
  const [filter, setFilter] = useState<'all' | 'capture' | 'attempt'>('all');
  const [date, setDate] = useState('');
  const [modal, setModal] = useState(false);
  const [holdDone, setHoldDone] = useState(0);

  return (
    <V2Shell
      rightTitle="说明"
      right={
        <>
          <div>
            <h3 className="v2-groupTitle">这页是什么</h3>
            <p className="v2-groupNote">
              正式页面的零件都在这里：按钮、状态胶囊、行、折叠模块、加载、分段、长按确认、复制、日期控件、弹层。
              改样式先来这页看，不用去真实数据里翻。
            </p>
          </div>
          <div>
            <h3 className="v2-groupTitle">主题</h3>
            <p className="v2-groupNote">底部状态栏右侧切换暗色 / 纸张，这一页所有零件都会跟着变。</p>
          </div>
        </>
      }
      statusLeft="组件样板 · 无真实数据"
      statusRight={<span>DEV</span>}
    >
      <Module title="状态胶囊 Pill" count={KINDS.length}>
        <div className="v2-ghosts" style={{ borderBottom: 0 }}>
          {KINDS.map((k) => (
            <Pill key={k.kind} kind={k.kind}>
              {k.label}
            </Pill>
          ))}
        </div>
      </Module>

      <Module title="按钮 Button / 幽灵按钮 GhostChip" count={3}>
        <div className="v2-ghosts" style={{ borderBottom: 0 }}>
          <Button variant="primary">主按钮</Button>
          <Button>次按钮</Button>
          <GhostChip count={3}>隐藏模块降级</GhostChip>
        </div>
      </Module>

      <Module title="加载 Spinner" count={2}>
        <div className="v2-ghosts" style={{ borderBottom: 0 }}>
          <Spinner />
          <Spinner label="检索中" size={18} />
        </div>
      </Module>

      <Module title="分段 Segment（选中块滑动）" count={1}>
        <div className="v2-form">
          <div className="v2-field">
            <span className="v2-fieldLabel">三档</span>
            <Segment
              ariaLabel="三档示例"
              items={[
                { value: 'a' as const, label: '第一档' },
                { value: 'b' as const, label: '第二档' },
                { value: 'c' as const, label: '第三档很长' },
              ]}
              value={seg}
              onChange={setSeg}
            />
          </div>
          <div className="v2-field">
            <span className="v2-fieldLabel">搜索页真实用法</span>
            <Segment
              ariaLabel="结果类型示例"
              items={[
                { value: 'all' as const, label: '全部 12' },
                { value: 'capture' as const, label: '念头 8' },
                { value: 'attempt' as const, label: '尝试 4' },
              ]}
              value={filter}
              onChange={setFilter}
            />
          </div>
        </div>
      </Module>

      <Module title="长按确认 HoldConfirm（删除等危险操作）" count={holdDone}>
        <div className="v2-form">
          <p className="v2-groupNote" style={{ margin: 0 }}>
            按住不放，填满才执行；中途松手会退回。键盘按住空格或回车同样生效。轻点会提示。
          </p>
          <div className="v2-captureActions">
            <HoldConfirm label="按住确认删除" onConfirm={() => setHoldDone((n) => n + 1)} />
            <span className="v2-hint">已执行 {holdDone} 次</span>
          </div>
        </div>
      </Module>

      <Module title="复制 CopyButton" count={1}>
        <div className="v2-ghosts" style={{ borderBottom: 0 }}>
          <CopyButton text="PWM 频率从 500 Hz 提到 2 kHz，闪烁减轻" label="复制结果" />
        </div>
      </Module>

      <Module title="日期控件 DateField" count={1}>
        <div className="v2-form">
          <div className="v2-field">
            <span className="v2-fieldLabel">选日期与时间（按 {tz}）</span>
            <DateField value={date} onChange={setDate} timezone={tz} label="示例时间" />
            {date && <span className="v2-hint">将记录为 {dayTimeLabel(new Date(date).getTime(), tz)}</span>}
          </div>
        </div>
      </Module>

      <Module title="行 Row 与折叠模块 Module" count={2}>
        <Row index={0} time="今天" title="低频闪烁消失，但亮度调节变得不线性" sub="尝试结果 · 台灯调光" side={<Pill kind="done">已记录</Pill>} />
        <Row index={1} time="昨天" title="ESP32 上做离线唤醒词，麦克风底噪很大" sub="念头 · 1 次尝试" side={<Pill kind="idle">想法</Pill>} />
      </Module>

      <div className="v2-ghosts">
        <Button onClick={() => setModal(true)}>打开弹层 Modal</Button>
      </div>

      <Modal
        open={modal}
        title="弹层标题"
        onClose={() => setModal(false)}
        footer={
          <>
            <Button onClick={() => setModal(false)}>取消</Button>
            <Button variant="primary" onClick={() => setModal(false)}>
              确定
            </Button>
          </>
        }
      >
        <p>弹层挂到 body 上，不会被折叠模块的 overflow 裁掉；Esc 与点遮罩都能关。</p>
        <p className="v2-groupNote">删除类操作在这里会换成「按住确认」按钮。</p>
      </Modal>
    </V2Shell>
  );
}
