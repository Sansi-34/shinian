// 拾念 SHINIAN · 首页 V2.0 - CommandSearch
// 统一搜索与快捷操作：常驻搜索框 + "/" 聚焦 + ⌘/Ctrl+K 快捷面板。
// 只做导航与本地搜索，不调用模型、不创建任何记录。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

type Props = {
  /** 导出数据的回调（复用首页既有导出入口） */
  onExport: () => void;
  exporting: boolean;
  /** 让外部（快捷键）打开快捷面板 */
  openSignal?: number;
};

type Command = { id: string; label: string; hint: string; run: () => void };

export default function CommandSearch({ onExport, exporting, openSignal }: Props) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const paletteInputRef = useRef<HTMLInputElement>(null);

  function go(path: string) {
    setPaletteOpen(false);
    setFilter('');
    navigate(path);
  }

  const commands = useMemo<Command[]>(
    () => [
      { id: 'new', label: '记下新念头', hint: '回到首页快速输入', run: () => { setPaletteOpen(false); inputRef.current?.blur(); window.scrollTo({ top: 0, behavior: 'smooth' }); const t = document.querySelector<HTMLTextAreaElement>('.capture-input'); t?.focus(); } },
      { id: 'search', label: '搜索念头、尝试与结果', hint: '打开搜索页', run: () => go(query.trim() ? `/search?q=${encodeURIComponent(query.trim())}` : '/search') },
      { id: 'ask', label: '问我的记录', hint: '按需调用 AI，不自动创建任务', run: () => go('/ask') },
      { id: 'topics', label: '我的主题', hint: '查看正在探索的问题', run: () => go('/topics') },
      { id: 'graph', label: '知识网络', hint: '查看真实关联', run: () => go('/graph') },
      { id: 'schedule', label: '日程安排', hint: '查看与安排时间', run: () => go('/schedule') },
      { id: 'export', label: '导出全部数据', hint: '下载 JSON 备份', run: () => { setPaletteOpen(false); onExport(); } },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query]
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.hint}`.toLowerCase().includes(q));
  }, [commands, filter]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      // 中文/日文输入法组字期间的按键不能触发全局快捷，否则会把标点输入误判成命令。
      const composing = e.isComposing || e.keyCode === 229;
      if (composing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // "/" 只在没有输入焦点、且不在组字时聚焦搜索框；中文标点不会误触。
      if (e.key === '/' && !typing && !composing && !paletteOpen && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false);
        else if (document.activeElement === inputRef.current) inputRef.current?.blur();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen]);

  useEffect(() => {
    // 0 是初始值，不能因为拿到初始值就弹出面板。
    if (typeof openSignal === 'number' && openSignal > 0) setPaletteOpen(true);
  }, [openSignal]);

  useEffect(() => {
    if (paletteOpen) {
      setFilter('');
      // 等面板渲染后再聚焦
      window.setTimeout(() => paletteInputRef.current?.focus(), 0);
    }
  }, [paletteOpen]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
    else inputRef.current?.focus();
  }

  return (
    <>
      <form className="search-bar command-search" onSubmit={submit} role="search">
        <input
          ref={inputRef}
          type="search"
          placeholder="搜索念头、尝试或结果…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索，按斜杠键聚焦"
        />
        <button
          type="button"
          className="btn command-open"
          onClick={() => setPaletteOpen(true)}
          aria-label="打开快捷操作面板"
          title="快捷操作（Ctrl/⌘ + K）"
        >
          快捷
        </button>
        <button type="submit" className="btn">搜索</button>
      </form>

      {paletteOpen && (
        <div
          className="command-backdrop"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setPaletteOpen(false); }}
        >
          <div className="command-palette" role="dialog" aria-modal="true" aria-label="快捷操作">
            <div className="command-palette-head">
              <input
                ref={paletteInputRef}
                type="text"
                placeholder="输入操作名称…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && filtered.length) filtered[0].run();
                }}
                aria-label="筛选快捷操作"
              />
              <button type="button" className="btn small" onClick={() => setPaletteOpen(false)}>关闭</button>
            </div>
            <ul className="command-list">
              {filtered.length === 0 ? (
                <li className="command-empty">没有匹配的快捷操作。</li>
              ) : (
                filtered.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="command-item" onClick={c.run} disabled={c.id === 'export' && exporting}>
                      <span className="command-item-label">{c.label}</span>
                      <span className="command-item-hint">{c.hint}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
            <p className="command-foot hint">↑↓ 选择 · Enter 执行 · Esc 关闭 · ⌘/Ctrl+K 开关</p>
          </div>
        </div>
      )}
    </>
  );
}
