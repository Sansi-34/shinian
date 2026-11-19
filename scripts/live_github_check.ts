// 真实 GitHub REST API 只读联调：关键词检索 → 仓库元数据 / README / 许可证 / 发布信息
// 用法：node node_modules/tsx/dist/cli.mjs scripts/live_github_check.ts
// 只读公开仓库，不使用 Token；如已配置 SHINIAN_GITHUB_API_BASE，仅允许本机回环地址。
import {
  readRepositoryDetail,
  searchRepositories,
} from '../src/server/githubClient';
import { GITHUB_API_BASE } from '../src/server/githubSettings';

const QUERY = process.env.SHINIAN_LIVE_QUERY || 'offline wake word';

function clip(text: string, size = 80): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, size);
}

async function main() {
  console.log(`GitHub API：${GITHUB_API_BASE}`);
  console.log(`检索词：${QUERY}`);
  const search = await searchRepositories(QUERY, {
    timeoutMs: 15_000,
    retries: 1,
    perPage: 3,
  });
  console.log(`命中总数：${search.total}（${search.incomplete ? '结果不完整' : '完整'}）`);
  for (const item of search.candidates) {
    console.log(
      `- ${item.fullName} · ${item.language ?? '未知语言'} · ★${item.stars} · 归档=${item.archived} · 许可证=${item.license?.spdxId ?? 'GitHub 未检测到'} · 推送=${item.pushedAt ?? '未知'}`
    );
  }
  if (search.candidates.length === 0) {
    console.log('没有候选，结束。');
    return;
  }

  const target = search.candidates[0];
  const detail = await readRepositoryDetail(target.owner, target.name, {
    timeoutMs: 15_000,
    retries: 1,
    maxReadmeChars: 4000,
    maxReleaseChars: 1000,
  });
  const meta = detail.candidate;
  console.log(`\n读取：${meta.fullName}（${meta.htmlUrl}）`);
  console.log(`描述：${clip(meta.description ?? '（无）')}`);
  console.log(`默认分支：${meta.defaultBranch} · 归档=${meta.archived} · Fork=${meta.fork}`);
  console.log(`推送时间 pushed_at=${meta.pushedAt ?? '未知'} · 元数据更新时间 updated_at=${meta.updatedAt ?? '未知'}`);
  console.log(`许可证检测：${meta.license?.spdxId ?? 'GitHub 未检测到'}`);
  console.log(
    `README：${detail.readme.status} · ${detail.readme.path} · ${detail.readme.url} · ${detail.readme.text.length} 字符`
  );
  console.log(`README 摘要：${clip(detail.readme.text)}`);
  console.log(
    `许可证文件：${detail.license.status} · ${detail.license.path ?? '—'} · ${detail.license.url}`
  );
  console.log(
    `发布：${detail.releases.status} · ${detail.releases.text.length} 字符 · ${detail.releases.url}`
  );
  const missing = [
    ['README', detail.readme],
    ['许可证', detail.license],
    ['发布', detail.releases],
  ].filter(([, item]) => item.status !== 'ok');
  console.log(
    `缺失/失败：${
      missing.length === 0
        ? '无'
        : missing.map(([label, item]) => `${label}:${item.note ?? item.status}`).join('；')
    }`
  );
}

main().catch((error) => {
  console.error('真实 GitHub 联调失败：', error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
