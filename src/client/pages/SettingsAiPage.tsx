// 拾念 SHINIAN v0.1 - AI 模型设置页
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { ApiError } from '../api';
import type { AiSettings } from '../types';
import {
  AI_CONFIG_STATUS_LABEL,
  aiErrorText,
  formatTime,
  getAiConfigStatus,
} from '../types';

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    return e.body?.message || aiErrorText(e.body?.error, fallback);
  }
  return fallback;
}

export default function SettingsAiPage() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelId, setModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [replaceKey, setReplaceKey] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [allowLocal, setAllowLocal] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  // GitHub Token（可选，研究一下）
  const [github, setGithub] = useState<{
    configured: boolean;
    hasToken: boolean;
    tokenFingerprint: string | null;
    updatedAt: number | null;
    apiBase: string;
    note: string;
  } | null>(null);
  const [githubLoading, setGithubLoading] = useState(true);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubToken, setGithubToken] = useState('');
  const [githubSaving, setGithubSaving] = useState(false);
  const [githubNotice, setGithubNotice] = useState<string | null>(null);
  const [githubTest, setGithubTest] = useState<{
    login: string;
    scopes: string | null;
    rate: { limit: number | null; remaining: number | null; resetAt: number | null };
    apiBase: string;
  } | null>(null);
  const [githubTestError, setGithubTestError] = useState<string | null>(null);
  const [githubTesting, setGithubTesting] = useState(false);
  const [githubClearOpen, setGithubClearOpen] = useState(false);
  const [githubClearing, setGithubClearing] = useState(false);

  const config = settings?.config ?? null;
  const status = getAiConfigStatus(config);
  const test = config?.test ?? null;

  const dirty = config
    ? name !== config.name ||
      baseUrl !== config.baseUrl ||
      modelId !== config.modelId ||
      enabled !== config.enabled ||
      allowLocal !== config.allowLocal ||
      apiKey.trim().length > 0
    : Boolean(
        name.trim() ||
          baseUrl.trim() ||
          modelId.trim() ||
          apiKey.trim() ||
          !enabled ||
          allowLocal
      );

  useEffect(() => {
    load();
    loadGithub();
  }, []);

  async function loadGithub() {
    setGithubLoading(true);
    setGithubError(null);
    try {
      setGithub(await api.getGithubSettings());
    } catch (e) {
      setGithubError(errorMessage(e, '无法读取 GitHub 设置'));
    } finally {
      setGithubLoading(false);
    }
  }

  async function saveGithub(e: React.FormEvent) {
    e.preventDefault();
    if (githubSaving || !githubToken.trim()) return;
    setGithubSaving(true);
    setGithubNotice(null);
    setGithubError(null);
    setGithubTest(null);
    setGithubTestError(null);
    try {
      const res = await api.saveGithubToken(githubToken.trim());
      setGithub({
        configured: res.configured,
        hasToken: res.hasToken,
        tokenFingerprint: res.tokenFingerprint,
        updatedAt: res.updatedAt,
        apiBase: res.apiBase,
        note: res.note,
      });
      setGithubToken('');
      setGithubNotice('GitHub Token 已加密保存；只会在读取公开仓库时发送给 GitHub API。');
    } catch (error) {
      setGithubError(errorMessage(error, '保存 GitHub Token 失败'));
    } finally {
      setGithubSaving(false);
    }
  }

  async function testGithub() {
    if (githubTesting || !github?.hasToken) return;
    setGithubTesting(true);
    setGithubTestError(null);
    setGithubNotice(null);
    try {
      setGithubTest(await api.testGithubToken());
    } catch (error) {
      setGithubTest(null);
      setGithubTestError(errorMessage(error, 'GitHub 连接测试失败'));
    } finally {
      setGithubTesting(false);
    }
  }

  async function clearGithub() {
    setGithubClearing(true);
    setGithubError(null);
    try {
      await api.deleteGithubToken();
      setGithub({
        configured: false,
        hasToken: false,
        tokenFingerprint: null,
        updatedAt: null,
        apiBase: github?.apiBase ?? 'https://api.github.com',
        note: '不填写 Token 时使用 GitHub 公开读取额度。',
      });
      setGithubTest(null);
      setGithubClearOpen(false);
      setGithubNotice('GitHub Token 已清除；之后会使用匿名公开读取。');
    } catch (error) {
      setGithubError(errorMessage(error, '清除 GitHub Token 失败'));
    } finally {
      setGithubClearing(false);
    }
  }

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.getAiSettings();
      applySettings(data);
    } catch (e) {
      setLoadError(errorMessage(e, '无法读取 AI 设置'));
    } finally {
      setLoading(false);
    }
  }

  function applySettings(data: AiSettings) {
    setSettings(data);
    const c = data.config;
    setName(c?.name ?? '');
    setBaseUrl(c?.baseUrl ?? '');
    setModelId(c?.modelId ?? '');
    setEnabled(c?.enabled ?? true);
    setAllowLocal(c?.allowLocal ?? false);
    setApiKey('');
    setReplaceKey(!c?.hasApiKey);
    setFieldError(null);
    setSaveError(null);
    setTestError(null);
  }

  function clearFeedback() {
    setNotice(null);
    setSaveError(null);
    setFieldError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving || testing || !dirty) return;
    setSaveError(null);

    const trimmedName = name.trim();
    const trimmedBase = baseUrl.trim();
    const trimmedModel = modelId.trim();

    if (!trimmedName) {
      setFieldError({ field: 'name', message: '请填写配置名称。' });
      return;
    }
    if (trimmedName.length > 40) {
      setFieldError({ field: 'name', message: '配置名称不能超过 40 个字符。' });
      return;
    }
    if (!trimmedBase) {
      setFieldError({ field: 'baseUrl', message: '请填写 Base URL。' });
      return;
    }
    if (!trimmedModel) {
      setFieldError({ field: 'modelId', message: '请填写 Model ID。' });
      return;
    }
    if (trimmedModel.length > 120) {
      setFieldError({ field: 'modelId', message: 'Model ID 不能超过 120 个字符。' });
      return;
    }
    if (!config?.hasApiKey && !apiKey.trim()) {
      setFieldError({ field: 'apiKey', message: '首次保存需要填写 API Key。' });
      return;
    }

    setSaving(true);
    setNotice(null);
    setSaveError(null);
    setFieldError(null);
    try {
      const res = await api.saveAiSettings({
        name: trimmedName,
        baseUrl: trimmedBase,
        modelId: trimmedModel,
        apiKey: apiKey.trim() ? apiKey : undefined,
        enabled,
        allowLocal,
      });
      applySettings(res);
      const nextTest = res.config?.test;
      setNotice(
        nextTest?.stale
          ? '设置已保存。地址、模型或密钥有变化，连接测试已标记为过期。'
          : '设置已保存。'
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        setFieldError({
          field: e.body?.field,
          message: e.body?.message || '设置格式不正确，请检查。',
        });
      } else {
        setSaveError(errorMessage(e, '保存失败，请重试'));
      }
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    if (!config || testing) return;
    if (dirty) {
      setTestError('有未保存的修改，请先保存后再测试。');
      return;
    }
    if (!config.enabled) {
      setTestError('配置已停用，测试前请先启用并保存。');
      return;
    }
    setTesting(true);
    setTestError(null);
    setNotice(null);
    try {
      const res = await api.testAiSettings();
      setSettings((prev) => (prev ? { ...prev, config: res.config } : prev));
      setNotice(res.test.status === 'success' ? '连接测试成功。' : '连接测试失败，请查看测试结果。');
    } catch (e) {
      setTestError(errorMessage(e, '连接测试失败，请稍后重试'));
    } finally {
      setTesting(false);
    }
  }

  async function clearConfig() {
    if (clearing) return;
    setClearing(true);
    setClearError(null);
    try {
      await api.deleteAiSettings();
      const prev = settings;
      applySettings({
        configured: false,
        config: null,
        masterKey: prev?.masterKey ?? { path: 'db/master.key', exists: false },
        limits: prev?.limits ?? {
          maxCaptureChars: 4000,
          maxConstraintChars: 200,
          timeoutMs: 60000,
        },
      });
      setClearOpen(false);
      setNotice('AI 配置已清除。生成历史仍保留。');
    } catch (e) {
      setClearError(errorMessage(e, '清除失败，请重试'));
    } finally {
      setClearing(false);
    }
  }

  if (loading) {
    return (
      <div className="page settings-page">
        <p className="muted" role="status">加载中…</p>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="page settings-page">
        <div className="crumb"><Link to="/">← 返回列表</Link></div>
        <h1 className="page-title">AI 模型</h1>
        <p className="error-msg" role="alert">{loadError || '无法读取 AI 设置'}</p>
        <button className="btn" onClick={load}>重试</button>
      </div>
    );
  }

  return (
    <div className="page settings-page">
      <div className="crumb"><Link to="/">← 返回列表</Link></div>

      <div className="settings-head">
        <div>
          <h1 className="page-title">AI 模型</h1>
          <p className="page-subtitle">
            这里配置的是全局模型：问我的记录、回顾、研究一下与「换些关键词找找」都会用它。
            填好名称、Base URL、Model ID 和 API Key 四项并保存即可；密钥只保存在本机。
          </p>
        </div>
        <span className={`ai-status-badge status-${status}`} role="status">
          {AI_CONFIG_STATUS_LABEL[status]}
        </span>
      </div>

      {status === 'unconfigured' && (
        <p className="hint" role="status">
          还没有可用的模型配置：生成回答与生成替代词都会被禁用，检索和核对来源不受影响。
          填好下面四项并保存，再点「测试连接」确认能通即可。
        </p>
      )}

      {dirty && (
        <div className="unsaved-banner" role="status">
          <span>有未保存的修改。</span>
          <button type="submit" form="ai-settings-form" className="btn primary small" disabled={saving}>
            保存修改
          </button>
        </div>
      )}

      {notice && <p className="save-ok" role="status">{notice}</p>}

      <form id="ai-settings-form" className="settings-form" onSubmit={save} noValidate>
        <section className="section">
          <h3>基本信息</h3>
          <label className="field">
            <span>配置名称</span>
            <input
              type="text"
              value={name}
              maxLength={40}
              placeholder="例如：DeepSeek"
              onChange={(e) => {
                setName(e.target.value);
                clearFeedback();
              }}
            />
            {fieldError?.field === 'name' && <span className="field-error" role="alert">{fieldError.message}</span>}
          </label>

          <label className="field">
            <span>Base URL</span>
            <input
              type="url"
              value={baseUrl}
              placeholder="https://api.deepseek.com/v1"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                clearFeedback();
              }}
            />
            <span className="field-hint">
              填写 OpenAI 兼容服务根地址，例如 https://api.openai.com/v1。末尾斜杠会自动处理；未写 /v1 时会自动补上。
            </span>
            <span className="field-hint">
              也支持 https://api.deepseek.com/v1、http://127.0.0.1:11434/v1（本机地址需勾选下方允许）。
            </span>
            {fieldError?.field === 'baseUrl' && <span className="field-error" role="alert">{fieldError.message}</span>}
          </label>

          <label className="field">
            <span>Model ID</span>
            <input
              type="text"
              value={modelId}
              maxLength={120}
              placeholder="例如：deepseek-chat"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setModelId(e.target.value);
                clearFeedback();
              }}
            />
            {fieldError?.field === 'modelId' && <span className="field-error" role="alert">{fieldError.message}</span>}
          </label>

          {config?.hasApiKey ? (
            <div className="key-block">
              <div className="key-row">
                <span className="key-state">API Key 已配置</span>
                {!replaceKey ? (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      setReplaceKey(true);
                      setNotice(null);
                    }}
                  >
                    替换密钥
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      setReplaceKey(false);
                      setApiKey('');
                      setFieldError(null);
                    }}
                  >
                    取消替换
                  </button>
                )}
              </div>
              {replaceKey && (
                <label className="field">
                  <span>新 API Key</span>
                  <input
                    type="password"
                    value={apiKey}
                    placeholder="输入新的 API Key"
                    autoComplete="new-password"
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      clearFeedback();
                    }}
                  />
                  <span className="field-hint">留空保存则保留原密钥。</span>
                  {fieldError?.field === 'apiKey' && <span className="field-error" role="alert">{fieldError.message}</span>}
                </label>
              )}
            </div>
          ) : (
            <label className="field">
              <span>API Key</span>
              <input
                type="password"
                value={apiKey}
                placeholder="输入 API Key"
                autoComplete="new-password"
                onChange={(e) => {
                  setApiKey(e.target.value);
                  clearFeedback();
                }}
              />
              <span className="field-hint">仅用于本机调用模型；保存后只显示「已配置」。</span>
              {fieldError?.field === 'apiKey' && <span className="field-error" role="alert">{fieldError.message}</span>}
            </label>
          )}

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                clearFeedback();
              }}
            />
            <span>
              <strong>启用这个配置</strong>
              <span className="field-hint">停用后「帮我试一步」不会调用模型。</span>
            </span>
          </label>

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={allowLocal}
              onChange={(e) => {
                setAllowLocal(e.target.checked);
                clearFeedback();
              }}
            />
            <span>
              <strong>允许本机/内网地址</strong>
              <span className="field-hint">
                仅在连接 Ollama 等本机服务时勾选。公网地址不需要开启。
              </span>
            </span>
          </label>

          {saveError && <p className="error-msg" role="alert">{saveError}</p>}
          {fieldError && !fieldError.field && <p className="error-msg" role="alert">{fieldError.message}</p>}

          <div className="form-actions">
            <button className="btn primary" type="submit" disabled={!dirty || saving || testing}>
              {saving ? '保存中…' : '保存设置'}
            </button>
            {dirty && <span className="hint">修改尚未保存</span>}
          </div>
        </section>
      </form>

      <section className="section test-panel" aria-live="polite">
        <div className="section-head">
          <h3>连接测试</h3>
          {test && (
            <span
              className={`ai-status-badge small status-${
                test.stale ? 'stale' : test.status === 'success' ? 'success' : 'failure'
              }`}
            >
              {test.stale
                ? AI_CONFIG_STATUS_LABEL.stale
                : test.status === 'success'
                  ? AI_CONFIG_STATUS_LABEL.success
                  : AI_CONFIG_STATUS_LABEL.failure}
            </span>
          )}
        </div>
        <p className="hint">将发送一次固定短请求，可能产生少量模型费用。</p>
        <div className="row-actions">
          <button
            className="btn"
            type="button"
            onClick={runTest}
            disabled={!config || !config.enabled || dirty || testing || saving}
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
          {dirty && <span className="hint">有未保存的修改，请先保存后再测试。</span>}
          {!config && <span className="hint">保存配置后才能测试。</span>}
          {config && !config.enabled && <span className="hint">配置已停用，测试前请先启用并保存。</span>}
        </div>
        {testError && <p className="error-msg" role="alert">{testError}</p>}

        {test ? (
          <div className={`test-result ${test.status}${test.stale ? ' stale' : ''}`}>
            {test.stale && (
              <p className="stale-note">地址、模型或密钥已变更，这份结果不再代表当前配置，请重新测试。</p>
            )}
            <dl className="test-meta">
              <div>
                <dt>实际模型</dt>
                <dd>{test.modelId}</dd>
              </div>
              <div>
                <dt>测试时间</dt>
                <dd>{formatTime(test.testedAt)}</dd>
              </div>
              <div>
                <dt>耗时</dt>
                <dd>{test.durationMs} ms</dd>
              </div>
              <div>
                <dt>地址</dt>
                <dd className="break-all">{test.baseUrl}</dd>
              </div>
            </dl>
            {test.status === 'failure' && (
              <div className="test-failure">
                <p>
                  <strong>{aiErrorText(test.errorCode, '连接失败')}</strong>
                </p>
                {test.errorDetail && <p className="test-detail">{test.errorDetail}</p>}
              </div>
            )}
          </div>
        ) : (
          <p className="muted">尚未测试。保存配置后可测试连接。</p>
        )}
      </section>

      <section className="section github-settings" aria-live="polite">
        <div className="section-head">
          <h3>GitHub 公开读取（研究一下）</h3>
          <span className={`ai-status-badge small status-${github?.hasToken ? 'success' : 'stale'}`}>
            {github?.hasToken ? '已配置 Token' : '匿名读取'}
          </span>
        </div>
        <p className="hint">
          不配置 Token 也能读取 GitHub 公开仓库，但匿名额度较低；配置后只在请求 GitHub API 时使用，
          不会发送给模型。Token 与 API Key 同样使用 AES-256-GCM 加密保存在本机。
        </p>
        {githubLoading && <p className="muted">正在读取 GitHub 设置…</p>}
        {githubError && <p className="error-msg" role="alert">{githubError}</p>}
        {github && (
          <>
            <dl className="test-meta">
              <div>
                <dt>接口地址</dt>
                <dd className="break-all">{github.apiBase}</dd>
              </div>
              <div>
                <dt>Token</dt>
                <dd>
                  {github.hasToken
                    ? `已配置（指纹 ${github.tokenFingerprint ?? '—'}，${github.updatedAt ? formatTime(github.updatedAt) : '—'}）`
                    : '未配置，使用匿名公开额度'}
                </dd>
              </div>
            </dl>
            {github.hasToken && (
              <div className="row-actions">
                <button className="btn" type="button" onClick={testGithub} disabled={githubTesting}>
                  {githubTesting ? '测试中…' : '测试 Token'}
                </button>
                <button className="btn danger-outline" type="button" onClick={() => setGithubClearOpen(true)}>
                  清除 Token…
                </button>
              </div>
            )}
            {githubTestError && <p className="error-msg" role="alert">{githubTestError}</p>}
            {githubTest && (
              <div className="test-result success">
                <dl className="test-meta">
                  <div><dt>登录账号</dt><dd>{githubTest.login}</dd></div>
                  <div><dt>Scopes</dt><dd>{githubTest.scopes || '（未返回）'}</dd></div>
                  <div>
                    <dt>剩余额度</dt>
                    <dd>{githubTest.rate.remaining ?? '未知'} / {githubTest.rate.limit ?? '未知'}</dd>
                  </div>
                  <div>
                    <dt>额度重置</dt>
                    <dd>{githubTest.rate.resetAt ? formatTime(githubTest.rate.resetAt) : '未知'}</dd>
                  </div>
                </dl>
              </div>
            )}
            <form className="settings-form" onSubmit={saveGithub}>
              <label className="field">
                <span>{github.hasToken ? '替换 GitHub Token' : 'GitHub Token（可选）'}</span>
                <input
                  type="password"
                  value={githubToken}
                  placeholder={github.hasToken ? '输入新 Token 以替换' : 'github_pat_… 或 ghp_…'}
                  autoComplete="new-password"
                  spellCheck={false}
                  onChange={(e) => {
                    setGithubToken(e.target.value);
                    setGithubNotice(null);
                  }}
                />
                <span className="field-hint">
                  公开仓库只需只读权限；建议使用 fine-grained token，并只授予 Public repositories 读取。
                </span>
              </label>
              {githubNotice && <p className="save-ok" role="status">{githubNotice}</p>}
              <div className="form-actions">
                <button className="btn primary" type="submit" disabled={githubSaving || !githubToken.trim()}>
                  {githubSaving ? '保存中…' : github.hasToken ? '替换 Token' : '保存 Token'}
                </button>
              </div>
            </form>
            <p className="hint">
              GitHub 未检测到许可证时，只代表仓库没有 LICENSE 文件，不代表可以直接商用；依赖许可证和你的具体使用方式仍需单独判断。
            </p>
          </>
        )}
        {github?.hasToken && (
          <p className="hint">
            本机 API Key 与 GitHub Token 的主密钥都位于 db/master.key；备份时需一并保留。
          </p>
        )}
      </section>

      {githubClearOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="clear-github-title">
          <div className="modal">
            <h3 id="clear-github-title">清除 GitHub Token？</h3>
            <p>之后研究一下会改用匿名公开读取，额度更低。已获取的仓库资料不会受影响。</p>
            <div className="row-actions">
              <button className="btn danger" type="button" onClick={clearGithub} disabled={githubClearing}>
                {githubClearing ? '清除中…' : '确认清除'}
              </button>
              <button className="btn" type="button" onClick={() => setGithubClearOpen(false)} disabled={githubClearing}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="section info-section">
        <h3>主密钥</h3>
        <p className="info-text">
          API Key 使用 AES-256-GCM 加密后保存在本机数据库；主密钥位于 db/master.key，不存于数据库。备份或迁移时需同时保留该文件；丢失后只能重新填写 API Key。
        </p>
        <p className="hint break-all">
          主密钥路径：<code>{settings.masterKey.path}</code>
          {settings.masterKey.exists ? '（文件已存在）' : '（尚未生成，首次保存 API Key 时创建）'}
        </p>
      </section>

      {config && (
        <section className="section danger-zone">
          <h3>清除配置</h3>
          <p className="muted">删除当前模型配置和已保存的加密 API Key。生成历史会保留。</p>
          <button type="button" className="btn danger-outline" onClick={() => setClearOpen(true)}>
            清除配置…
          </button>
        </section>
      )}

      {clearOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="clear-ai-title">
          <div className="modal">
            <h3 id="clear-ai-title">清除 AI 配置？</h3>
            <p>将删除配置名称、Base URL、Model ID 和已保存的加密 API Key。</p>
            <p className="muted">已有生成记录会保留。此操作不可撤销；之后可重新填写配置。</p>
            {clearError && <p className="error-msg" role="alert">{clearError}</p>}
            <div className="row-actions">
              <button
                type="button"
                className="btn danger"
                onClick={clearConfig}
                disabled={clearing}
              >
                {clearing ? '清除中…' : '确认清除'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setClearOpen(false)}
                disabled={clearing}
                autoFocus
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
