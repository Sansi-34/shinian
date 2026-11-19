import { NavLink } from 'react-router-dom';
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

const SYSTEM: RailItem[] = [
  { to: '/settings/ai', label: '设置', icon: 'gear' },
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
} as const;

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg
      width="18"
      height="18"
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

function Item({ item }: { item: RailItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => (isActive ? `${styles.link} ${styles.active}` : styles.link)}
      aria-label={item.label}
      title={item.label}
    >
      <Icon name={item.icon} />
      <span className={styles.tip}>{item.label}</span>
    </NavLink>
  );
}

export default function Rail({ onMore }: { onMore?: () => void }) {
  return (
    <aside className={styles.rail} aria-label="主导航">
      <div className={styles.brand} aria-hidden="true">
        拾
      </div>
      <div className={styles.group}>
        {PRIMARY.map((i) => (
          <Item key={i.to} item={i} />
        ))}
      </div>
      <div className={styles.sep} aria-hidden="true" />
      <div className={styles.group}>
        {INSIGHT.map((i) => (
          <Item key={i.to} item={i} />
        ))}
      </div>
      <div className={styles.spacer} />
      <div className={styles.group}>
        {SYSTEM.map((i) => (
          <Item key={i.to} item={i} />
        ))}
        <button type="button" className={styles.link} onClick={onMore} aria-label="更多" title="更多">
          <Icon name="dots" />
          <span className={styles.tip}>更多</span>
        </button>
      </div>
    </aside>
  );
}
