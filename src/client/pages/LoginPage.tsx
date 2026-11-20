// 拾念 SHINIAN - 本地单用户登录（无外部网络依赖，首次输入名字即创建本机账号）
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import CosmosBackdrop from '../v2/ui/CosmosBackdrop';
import { useV2Theme } from '../v2/theme';

export default function LoginPage({ onLogin }: { onLogin: (username: string) => void }) {
  const [theme] = useV2Theme();
  const [username, setUsername] = useState('我');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function login(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.createAccount(username.trim() || '我');
      onLogin(res.username);
      navigate('/');
    } catch (err: any) {
      setError(err?.message || '登录失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={theme === 'dark' ? 'login-cosmos-shell' : undefined}>
      <CosmosBackdrop active={theme === 'dark'} />
      <div className="page login-page">
      <div className="login-card-container">
        <div className="login-motto-tag">把规矩先立住，这样做起来才不烧心。</div>
        <form className="login-card" onSubmit={login}>
          <div className="login-header">
            <div className="login-logo-mark">念</div>
            <h1 className="login-title">拾念 <span>SHINIAN</span></h1>
            <p className="login-lead">
              灵感来了？先丢进拾念，别让它像“我刚才要干啥来着”一样人间蒸发。
            </p>
          </div>

          <div className="login-intro-note">
            <p><strong>单人本机空间</strong> · 数据完全保存在当前电脑本地，无云端泄露之忧。</p>
          </div>

          <label className="field">
            <span className="field-label">你的称呼 / 名字</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="例如：我、阿念"
              autoFocus
              className="login-input"
            />
            <span className="field-hint">首次使用将以此身份开启你的本地知识实践库</span>
          </label>

          {error && <p className="error-msg" role="alert">{error}</p>}

          <button className="btn primary login-submit" type="submit" disabled={busy}>
            {busy ? '正在开启…' : '开启拾念之旅'}
          </button>
        </form>

        {/* 五个步骤已经自带序号，箭头只会带来换行后悬空的问题，去掉 */}
        <div className="login-loop-steps">
          <div className="step-pill">1. 记下念头</div>
          <div className="step-pill">2. 试一步</div>
          <div className="step-pill">3. 记录真实结果</div>
          <div className="step-pill">4. 整理经验</div>
          <div className="step-pill">5. 召唤存档</div>
        </div>
      </div>
    </div>
    </div>
  );
}
