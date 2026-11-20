// V2 导航：桌面 = 左侧图标栏；≤900px = 底部标签栏（原来移动端图标栏直接盖在内容上）。
// 「更多」菜单也在这里：低频入口 + 主题切换 + 退出登录（V2 页面以前没有退出入口）。
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import api from '../../api';
import { useV2Theme } from '../theme';
import styles from './Rail.module.css';

type RailItem = { to: string; label: string; icon: keyof typeof ICONS; end?: boolean };

const PRIMARY: RailItem[] = [
  { to: '/', label: '首页', icon: 'home', end: true },
  { to: '/search', label: '念头', icon: 'list' },
  { to: '/topics', label: '主题', icon: 'grid' },
  { to: '/ask', label: '问记录', icon: 'chat' },
];

const INSIGHT: RailItem[] = [
  { to: '/graph', label: '知识网络', icon: 'graph' },
  { to: '/review', label: '周期回顾', icon: 'refresh' },
];

const SYSTEM: RailItem[] = [{ to: '/settings/ai', label: '设置', icon: 'gear' }];

// 「更多」只放图标栏里没有的入口；移动端标签栏放不下的三项（网络 / 回顾 / 设置）也收进来
const MORE: Array<RailItem & { mobileOnly?: boolean }> = [
  { to: '/experiences', label: '经验', icon: 'star' },
  { to: '/schedule', label: '日程', icon: 'clock' },
  { to: '/activity', label: '操作动态', icon: 'pulse' },
  { to: '/research', label: '深度研究', icon: 'search' },
  ...INSIGHT.map((i) => ({ ...i, mobileOnly: true })),
  ...SYSTEM.map((i) => ({ ...i, mobileOnly: true })),
];

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  list: 'M4 5h16M4 12h11M4 19h7',
  grid: 'M3 4h8v7H3zM13 4h8v7h-8zM3 13h18v7H3z',
  chat: 'M4 5h16v11H9l-5 4z',
  graph: 'M6 7a2.4 2.4 0 1 0 0-.01M18 9a2.4 2.4 0 1 0 0-.01M11 18a2.4 2.4 0 1 0 0-.01M8.2 8.2 15.8 8.7M7.4 9.2 9.8 15.8M16.4 11.2 12.4 15.9',
  refresh: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7.5V12l3 2',
  pulse: 'M3 12h4l2.5-6 5 12 2.5-6H21',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M20 20l-4-4',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  out: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
} as const;

function Icon({ name, size = 18 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

function Item({ item, className }: { item: RailItem; className?: string }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        [styles.link, isActive ? styles.active : '', className ?? ''].filter(Boolean).join(' ')
      }
      aria-label={item.label}
      title={item.label}
    >
      <Icon name={item.icon} />
      <span className={styles.tip}>{item.label}</span>
      <span className={styles.tabLabel} aria-hidden="true">
        {item.label}
      </span>
    </NavLink>
  );
}

export default function Rail() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [theme, changeTheme] = useV2Theme();

  // 切页即收起；Esc 关闭
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // 当前页落在「更多」里时，让「更多」按钮也亮起来，否则用户不知道自己在哪
  const inMore = MORE.some((m) => location.pathname === m.to || location.pathname.startsWith(m.to + '/'));
  const inMoreMobileOnly = MORE.some(
    (m) => m.mobileOnly && (location.pathname === m.to || location.pathname.startsWith(m.to + '/'))
  );
  const inMoreDesktop = inMore && !inMoreMobileOnly;

  async function logout() {
    await api.destroySession().catch(() => {});
    // 整页跳转：让外壳重新检查会话，不留任何旧页面状态
    window.location.assign('/login');
  }

  return (
    <>
      <aside className={styles.rail} aria-label="主导航">
        <Link to="/" className={styles.brand} aria-label="拾念首页" title="拾念">
          拾
        </Link>
        <div className={styles.group}>
          {PRIMARY.map((i) => (
            <Item key={i.to} item={i} />
          ))}
        </div>
        <div className={`${styles.sep} ${styles.desktopOnly}`} aria-hidden="true" />
        <div className={`${styles.group} ${styles.desktopOnly}`}>
          {INSIGHT.map((i) => (
            <Item key={i.to} item={i} />
          ))}
        </div>
        <div className={styles.spacer} />
        <div className={styles.group}>
          {SYSTEM.map((i) => (
            <Item key={i.to} item={i} className={styles.desktopOnly} />
          ))}
          <button
            type="button"
            className={[
              styles.link,
              open ? styles.active : '',
              inMoreDesktop ? styles.activeDesktop : '',
              inMore ? styles.activeMobile : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => setOpen((v) => !v)}
            aria-label="更多"
            aria-expanded={open}
            aria-haspopup="menu"
            title="更多"
          >
            <Icon name="dots" />
            <span className={styles.tip}>更多</span>
            <span className={styles.tabLabel} aria-hidden="true">
              更多
            </span>
          </button>
        </div>
      </aside>

      {open && (
        <>
          {/* 点空白处关掉，避免用户被困在浮层里 */}
          <button type="button" className={styles.scrim} aria-label="关闭更多入口" onClick={() => setOpen(false)} />
          <div className={styles.panel} role="menu" aria-label="更多入口">
            <div className={styles.panelLabel}>更多入口</div>
            {MORE.map((m) => (
              <NavLink
                key={m.to}
                to={m.to}
                role="menuitem"
                className={({ isActive }) =>
                  [styles.panelItem, isActive ? styles.panelItemActive : '', m.mobileOnly ? styles.mobileOnly : '']
                    .filter(Boolean)
                    .join(' ')
                }
                onClick={() => setOpen(false)}
              >
                <Icon name={m.icon} size={16} />
                {m.label}
              </NavLink>
            ))}
            <div className={styles.panelSep} aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              className={styles.panelItem}
              onClick={() => changeTheme(theme === 'dark' ? 'paper' : 'dark')}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
              {theme === 'dark' ? '切到纸张主题' : '切到暗色主题'}
            </button>
            <button type="button" role="menuitem" className={styles.panelItem} onClick={() => void logout()}>
              <Icon name="out" size={16} />
              退出登录
            </button>
          </div>
        </>
      )}
    </>
  );
}
