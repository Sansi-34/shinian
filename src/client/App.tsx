// 拾念 SHINIAN v0.1 - 应用主组件（路由 + 会话）
// V2.2：桌面轻量侧栏 + 移动折叠菜单；仅改外壳，路由与功能入口全部保留。
import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams, Link, NavLink, useLocation } from 'react-router-dom';
import HomePage from './pages/HomePage';
import CaptureDetailPage from './pages/CaptureDetailPage';
import AttemptDetailPage from './pages/AttemptDetailPage';
import SearchPage from './pages/SearchPage';
import LoginPage from './pages/LoginPage';
import SettingsAiPage from './pages/SettingsAiPage';
import ActivityPage from './pages/ActivityPage';
import ReviewPage from './pages/ReviewPage';
import ReviewDetailPage from './pages/ReviewDetailPage';
import NextActionPage from './pages/NextActionPage';
import SchedulePage from './pages/SchedulePage';
import ResearchPage from './pages/ResearchPage';
import ResearchIndexPage from './pages/ResearchIndexPage';
import AskPage from './pages/AskPage';
import AskDetailPage from './pages/AskDetailPage';
import ExperiencesPage from './pages/ExperiencesPage';
import ExperienceDetailPage from './pages/ExperienceDetailPage';
import GraphPage from './pages/GraphPage';
import TopicsPage from './pages/TopicsPage';
import TopicPage from './pages/TopicPage';
import ThemeSwitcher from './ThemeSwitcher';
import HomeV2Page from './v2/HomeV2Page';
import SearchV2Page from './v2/SearchV2Page';
import TopicsV2Page from './v2/TopicsV2Page';
import ExperiencesV2Page from './v2/ExperiencesV2Page';
import ScheduleV2Page from './v2/ScheduleV2Page';
import ResearchV2Page from './v2/ResearchV2Page';
import CaptureV2Page from './v2/CaptureV2Page';
import AttemptV2Page from './v2/AttemptV2Page';
import api from './api';

const navClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? 'nav-link active' : 'nav-link';

/**
 * 主导航：承载日常核心实践流转（记念头、聚主题、存经验、定日程）
 * 合并原先同时指向 /topics 的重复入口「学习」与「项目」为统一的「主题」。
 */
const PRIMARY_NAV: Array<{ to: string; label: string; icon: string; end?: boolean }> = [
  { to: '/', label: '首页', icon: '✦', end: true },
  { to: '/search', label: '念头', icon: '✎' },
  { to: '/topics', label: '主题', icon: '◈' },
  { to: '/experiences', label: '经验', icon: '★' },
  { to: '/schedule', label: '日程', icon: '◷' },
];

/** 次级导航：探索与复盘工具，所有原有入口完整保留 */
const SECONDARY_NAV: Array<{ to: string; label: string; icon: string }> = [
  { to: '/ask', label: '问记录', icon: '💬' },
  { to: '/graph', label: '知识大脑', icon: '🕸' },
  { to: '/review', label: '周期回顾', icon: '↻' },
  { to: '/activity', label: '操作动态', icon: '⚡' },
  { to: '/research', label: '深度研究', icon: '🔍' },
  { to: '/settings/ai', label: '偏好设置', icon: '⚙' },
];

function CaptureRedirect() {
  const { captureId } = useParams();
  return <Navigate to={'/capture/' + (captureId ?? '')} replace />;
}

function AttemptRedirect() {
  const { attemptId } = useParams();
  return <Navigate to={'/attempt/' + (attemptId ?? '')} replace />;
}

function Shell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    api
      .checkSession()
      .then((res) => setUsername(res.username))
      .catch(() => setUsername(null))
      .finally(() => setChecked(true));
  }, []);

  // 未登录时进入登录页（本机单人实例）
  useEffect(() => {
    if (checked && !username && location.pathname !== '/login') {
      navigate('/login', { replace: true });
    }
  }, [checked, username, location.pathname, navigate]);

  // 路由变化时自动收起移动菜单
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  async function logout() {
    await api.destroySession().catch(() => {});
    setUsername(null);
    navigate('/login');
  }

  if (!checked) {
    return (
      <div className="app-loading">
        <span className="spinner" aria-hidden="true" />
        <span>拾念加载中…</span>
      </div>
    );
  }

  const graphMode = location.pathname.startsWith('/graph');
  // 登录页不显示侧栏；图谱页保留原有深色全屏视觉。
  // V2 已接管这些正式路径；其余（问记录/动态/回顾/图谱/设置/详情类）暂时还是旧实现
  const V2_EXACT = ['/', '/search', '/topics', '/experiences', '/schedule', '/research'];
  const v2Mode =
    V2_EXACT.includes(location.pathname) ||
    location.pathname.startsWith('/capture/') ||
    location.pathname.startsWith('/attempt/');
  const showShell = !graphMode && !v2Mode && location.pathname !== '/login';

  return (
    <div
      className={`app shell-v2${
        location.pathname.startsWith('/research') ||
        location.pathname.startsWith('/ask') ||
        location.pathname.startsWith('/topics')
          ? ' wide'
          : ''
      }${graphMode ? ' graph-mode' : ''}${v2Mode ? ' v2-mode' : ''}${showShell ? '' : ' no-shell'}`}
    >
      {showShell && (
        <aside className={`app-sidebar${menuOpen ? ' open' : ''}`} aria-label="主导航">
          <div className="sidebar-top">
            <Link to="/" className="brand" aria-label="拾念首页">
              <span className="brand-badge">念</span>
              <span className="brand-text">拾念</span>
              <span className="brand-sub">SHINIAN</span>
            </Link>
            <button
              type="button"
              className="sidebar-close"
              onClick={() => setMenuOpen(false)}
              aria-label="关闭菜单"
            >
              ✕
            </button>
          </div>

          <div className="sidebar-scrollable">
            <div className="sidebar-section-label">日常流转</div>
            <nav className="app-nav sidebar-nav" aria-label="主要导航">
              {PRIMARY_NAV.map((item) => (
                <NavLink key={item.to + item.label} to={item.to} end={item.end} className={navClass}>
                  <span className="nav-icon" aria-hidden="true">{item.icon}</span>
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              ))}
            </nav>

            <div className="sidebar-section-label">探索与回顾</div>
            <nav className="app-nav sidebar-nav secondary" aria-label="次级导航">
              {SECONDARY_NAV.map((item) => (
                <NavLink key={item.to} to={item.to} className={navClass}>
                  <span className="nav-icon" aria-hidden="true">{item.icon}</span>
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="sidebar-bottom">
            <ThemeSwitcher />
            {username ? (
              <div className="user-profile-bar">
                <span className="user-avatar" title={`当前用户：${username}`}>
                  {username.slice(0, 1).toUpperCase()}
                </span>
                <span className="user-name" title={username}>{username}</span>
                <button type="button" className="btn-logout" onClick={logout} title="退出登录">
                  退出
                </button>
              </div>
            ) : (
              <Link to="/login" className="btn small primary full-width">登录</Link>
            )}
          </div>
        </aside>
      )}

      {showShell && menuOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          onClick={() => setMenuOpen(false)}
          aria-label="关闭菜单"
        />
      )}

      {showShell && (
        <header className="app-header">
          <button
            type="button"
            className="menu-toggle"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="打开菜单"
            aria-expanded={menuOpen}
          >
            <span className="menu-glyph" aria-hidden="true">☰</span>
            <span className="menu-text">导航</span>
          </button>
          <Link to="/" className="mobile-header-brand">
            拾念 <span>SHINIAN</span>
          </Link>
          <Link to="/search" className="header-search" aria-label="搜索">
            <span className="search-glyph" aria-hidden="true">⌕</span>
          </Link>
        </header>
      )}

      <main className="app-main">
        <Routes>
          {/* ---------- V2：正式路径 ---------- */}
          <Route path="/" element={<HomeV2Page />} />
          <Route path="/search" element={<SearchV2Page />} />
          <Route path="/topics" element={<TopicsV2Page />} />
          <Route path="/experiences" element={<ExperiencesV2Page />} />
          <Route path="/schedule" element={<ScheduleV2Page />} />
          <Route path="/research" element={<ResearchV2Page />} />
          <Route path="/capture/:captureId" element={<CaptureV2Page />} />
          <Route path="/attempt/:attemptId" element={<AttemptV2Page />} />

          {/* ---------- 尚未迁移：先沿用旧实现（旧外壳） ---------- */}
          <Route path="/topics/:topicId" element={<TopicPage />} />
          <Route path="/experience/:id" element={<ExperienceDetailPage />} />
          <Route path="/research/:researchId" element={<ResearchPage />} />
          <Route path="/next-action/:nextActionId" element={<NextActionPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/review/:reviewId" element={<ReviewDetailPage />} />
          <Route path="/ask" element={<AskPage />} />
          <Route path="/ask/:queryId" element={<AskDetailPage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/settings/ai" element={<SettingsAiPage />} />
          <Route path="/login" element={<LoginPage onLogin={setUsername} />} />

          {/* ---------- 旧版：V2 接管正式路径后留在这里对照 / 兜底 ---------- */}
          <Route path="/legacy" element={<HomePage />} />
          <Route path="/legacy/search" element={<SearchPage />} />
          <Route path="/legacy/topics" element={<TopicsPage />} />
          <Route path="/legacy/experiences" element={<ExperiencesPage />} />
          <Route path="/legacy/schedule" element={<SchedulePage />} />
          <Route path="/legacy/research" element={<ResearchIndexPage />} />
          <Route path="/legacy/capture/:captureId" element={<CaptureDetailPage />} />
          <Route path="/legacy/attempt/:attemptId" element={<AttemptDetailPage />} />

          {/* ---------- 老书签兼容 ---------- */}
          <Route path="/v2" element={<Navigate to="/" replace />} />
          <Route path="/v2/search" element={<Navigate to="/search" replace />} />
          <Route path="/v2/topics" element={<Navigate to="/topics" replace />} />
          <Route path="/v2/experiences" element={<Navigate to="/experiences" replace />} />
          <Route path="/v2/schedule" element={<Navigate to="/schedule" replace />} />
          <Route path="/v2/research" element={<Navigate to="/research" replace />} />
          <Route path="/v2/capture/:captureId" element={<CaptureRedirect />} />
          <Route path="/v2/attempt/:attemptId" element={<AttemptRedirect />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
