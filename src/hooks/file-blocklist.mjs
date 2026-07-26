#!/usr/bin/env node
// beforeReadFile (matcher: Read)
// 硬拦截低信息密度文件：锁文件、构建产物、压缩产物、超大数据文件。
// 用户主动 @ 附加的文件永远放行。
import path from 'node:path';
import { readInput, respond, loadConfig, logEvent, estTokens } from './_lib.mjs';

const ALLOW = { permission: 'allow' };

const LOCKFILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'cargo.lock',
  'poetry.lock',
  'uv.lock',
  'pipfile.lock',
  'composer.lock',
  'gemfile.lock',
  'podfile.lock',
  'go.sum'
]);

const GENERATED_SEGMENTS = new Set([
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  'node_modules',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'target'
]);

const DATA_EXTS = new Set([
  '.json',
  '.jsonl',
  '.ndjson',
  '.csv',
  '.tsv',
  '.log',
  '.txt',
  '.xml',
  '.svg'
]);

async function main() {
  const input = await readInput();
  if (!input || typeof input.file_path !== 'string') return respond(ALLOW);
  const cfg = loadConfig();
  if (!cfg.hooks.fileBlocklist) return respond(ALLOW);

  const file = input.file_path;

  // 用户明确附加到对话的文件是明确意图，放行
  const attached = (input.attachments || []).some(
    (a) => a && a.type === 'file' && a.file_path === file
  );
  if (attached) return respond(ALLOW);

  const base = path.basename(file).toLowerCase();
  const ext = path.extname(base);
  const dirSegments = file.split(/[\\/]/).slice(0, -1).map((s) => s.toLowerCase());
  const bytes = typeof input.content === 'string' ? Buffer.byteLength(input.content) : 0;

  let reason = null;
  if (LOCKFILES.has(base)) reason = '依赖锁文件';
  else if (/\.min\.(js|css)$/.test(base) || base.endsWith('.map')) reason = '压缩/映射产物';
  else if (dirSegments.some((s) => GENERATED_SEGMENTS.has(s))) reason = '构建产物或依赖目录';
  else if (DATA_EXTS.has(ext) && bytes > cfg.blockMaxDataBytes)
    reason = `超大数据文件（${Math.round(bytes / 1024)} KB）`;

  if (!reason) return respond(ALLOW);

  logEvent({
    hook: 'file-blocklist',
    action: 'deny',
    file,
    reason,
    savedBytes: bytes,
    savedTokens: estTokens(bytes),
    conversation_id: input.conversation_id
  });
  const isData = DATA_EXTS.has(ext);
  return respond({
    permission: 'deny',
    agent_message:
      `token-saver: reading ${file} in full is blocked (${reason}). ` +
      (isData
        ? `Call context_query {mode:"profile", file:"..."} for a structure profile with a lossless evidence ID, then context_expand by regex/line range for exact records. `
        : `Use grep for targeted lookups. `) +
      `The file itself is untouched on disk.`,
    user_message:
      `token-saver: 已拦截读取 ${path.basename(file)}（${reason}）。` +
      (isData ? `agent 可用 context_query mode=profile 获取结构画像并按需精确回取。` : `如确需内容请用 grep 精确查询。`) +
      `也可在 .cursor/token-saver.json 中关闭 fileBlocklist。`
  });
}

try {
  await main();
} catch {
  respond(ALLOW);
}
process.exit(0);
