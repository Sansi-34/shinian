// 拾念 SHINIAN v0.1 - 应用主组件（路由 + 会话）
// 全站统一使用 V2 轻量导航栏（Rail）：桌面 60px 图标栏 + 移动 56px 底栏。
import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom';
import LoginPage from './pages/LoginPage';
import SettingsAiPage from './pages/SettingsAiPage';
import ActivityPage from './pages/ActivityPage';
import ReviewPage from './pages/ReviewPage';
import ReviewDetailPage from './pages/ReviewDetailPage';
import NextActionPage from './pages/NextActionPage';
import ResearchPage from './pages/ResearchPage';
import ExperienceDetailPage from './pages/ExperienceDetailPage';
import HomeV2Page from './v2/HomeV2Page';
import SearchV2Page from './v2/SearchV2Page';
import TopicsV2Page from './v2/TopicsV2Page';
import ExperiencesV2Page from './v2/ExperiencesV2Page';
import ScheduleV2Page from './v2/ScheduleV2Page';
import ResearchV2Page from './v2/ResearchV2Page';
import CaptureV2Page from './v2/CaptureV2Page';
import AttemptV2Page from './v2/AttemptV2Page';
import KitPage from './v2/KitPage';
import AskV2Page from './v2/AskV2Page';
import AskV2DetailPage from './v2/AskV2DetailPage';
import TopicV2Page from './v2/TopicV2Page';
import GraphV2Page from './v2/GraphV2Page';
import Rail from './v2/ui/Rail';
import { useV2Theme } from './v2/theme';
import './v2/tokens.css';
import api from './api';

// 兼容跳转要保住 query：旧书签 /v2/search?q=xxx 不能把 q 丢掉
function KeepQueryRedirect({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={to + location.search} replace />;
}

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
  const [v2Theme] = useV2Theme();

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

  if (!checked) {
    return (
      <div className="app-loading">
        <span className="spinner" aria-hidden="true" />
        <span>拾念加载中…</span>
      </div>
    );
  }

  const V2_EXACT = ['/', '/search', '/topics', '/experiences', '/schedule', '/research'];
  const v2Mode =
    location.pathname === '/kit' ||
    location.pathname === '/ask' ||
    location.pathname.startsWith('/ask/') ||
    location.pathname.startsWith('/topics/') ||
    location.pathname === '/graph' ||
    V2_EXACT.includes(location.pathname) ||
    location.pathname.startsWith('/capture/') ||
    location.pathname.startsWith('/attempt/');
  const isLogin = location.pathname === '/login';
  const showLegacyRail = !v2Mode && !isLogin;

  return (
    <div className={`app${v2Mode ? ' v2-mode' : ''}${showLegacyRail ? ' legacy-with-rail' : ''}${isLogin ? ' no-shell' : ''}`}>
      {showLegacyRail && (
        <div className="v2-chrome" data-v2-theme={v2Theme}>
          <Rail />
        </div>
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
          <Route path="/kit" element={<KitPage />} />

          {/* ---------- 二级详情与设置页（共享 V2 导航条） ---------- */}
          <Route path="/topics/:topicId" element={<TopicV2Page />} />
          <Route path="/experience/:id" element={<ExperienceDetailPage />} />
          <Route path="/research/:researchId" element={<ResearchPage />} />
          <Route path="/next-action/:nextActionId" element={<NextActionPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/review/:reviewId" element={<ReviewDetailPage />} />
          <Route path="/ask" element={<AskV2Page />} />
          <Route path="/ask/:queryId" element={<AskV2DetailPage />} />
          <Route path="/graph" element={<GraphV2Page />} />
          <Route path="/settings/ai" element={<SettingsAiPage />} />
          <Route path="/login" element={<LoginPage onLogin={setUsername} />} />

          {/* ---------- 未匹配：旧书签（/legacy/* 等）一律回首页，不留空白页 ---------- */}
          <Route path="*" element={<Navigate to="/" replace />} />

          {/* ---------- 老书签兼容 ---------- */}
          <Route path="/v2" element={<Navigate to="/" replace />} />
          <Route path="/v2/search" element={<KeepQueryRedirect to="/search" />} />
          <Route path="/v2/topics" element={<KeepQueryRedirect to="/topics" />} />
          <Route path="/v2/experiences" element={<KeepQueryRedirect to="/experiences" />} />
          <Route path="/v2/schedule" element={<KeepQueryRedirect to="/schedule" />} />
          <Route path="/v2/research" element={<KeepQueryRedirect to="/research" />} />
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
