// 线上体验版的 fetch 替身：把 /api 请求交给浏览器内的 localStorage 数据层。
import { handleLocalRequest } from './handlers';
import { ensureAccount, exportAll } from './store';

function parseBody(body: BodyInit | null | undefined): any {
  if (body == null) return undefined;
  if (typeof body === 'string') {
    if (!body.trim()) return undefined;
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
  return undefined;
}

export async function localRequest(
  path: string,
  options?: RequestInit
): Promise<{ status: number; body: any }> {
  ensureAccount();
  const method = (options?.method ?? 'GET').toUpperCase();
  const body = parseBody(options?.body);
  // 让页面里的 loading 状态有真实的一帧，同时保持交互节奏轻快。
  await new Promise((resolve) => setTimeout(resolve, 30));
  return handleLocalRequest(method, path, body);
}

export function localExport(): { blob: Blob; filename: string } {
  const stamp = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const filename = `shinian-export-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(
    stamp.getDate()
  )}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.json`;
  const text = JSON.stringify(exportAll(), null, 2);
  return { blob: new Blob([text], { type: 'application/json' }), filename };
}

export { clearStandaloneData, exportAll } from './store';