#!/usr/bin/env node
// preToolUse (matcher: Shell)
// 只对白名单里的高噪音命令做改写：完整输出落盘到临时文件，
// 终端只回显头尾（由 print-log.mjs 打印并统计节省量），并告知完整日志路径。
// 含管道/重定向/多命令等复杂语法的命令一律放行，不碰语义。
import fs from 'node:fs';
import path from 'node:path';
import { readInput, respond, loadConfig, logEvent, projectDir } from './_lib.mjs';

const ALLOW = { permission: 'allow' };

const NOISY_COMMANDS = [
  // 包管理
  /^(npm|pnpm|yarn|bun)\s+(install|ci|i|add|update|upgrade)\b/,
  /^(pip3?|pipx)\s+install\b/,
  /^python3?\s+-m\s+pip\s+install\b/,
  /^(poetry|uv)\s+(install|sync|add|lock)\b/,
  /^(apt-get|apt|brew)\s+(install|update|upgrade)\b/,
  /^composer\s+(install|update)\b/,
  /^git\s+clone\b/,
  // 构建
  /^(npm|pnpm|yarn|bun)\s+run\s+build\b/,
  /^cargo\s+(build|check|clippy|fetch)\b/,
  /^go\s+(build|vet)\b/,
  /^docker\s+(build|pull)\b/,
  /^docker\s+compose\s+build\b/,
  /^make(\s+\w[\w-]*)?\s*$/,
  /^(npx\s+)?(tsc|webpack|vite\s+build|next\s+build)\b/,
  /^mvn\b/,
  /^(\.\/)?gradlew?\s+(build|assemble|test)\b/,
  // 测试与静态检查（失败详情在落盘日志里，头尾通常已含摘要）
  /^(python3?\s+-m\s+)?pytest\b/,
  /^go\s+test\b/,
  /^cargo\s+test\b/,
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/,
  /^(npx\s+)?(jest|vitest|mocha)\b/,
  /^(npx\s+)?(eslint|prettier|ruff|flake8)\b/,
  // 大输出查询
  /^git\s+log\b/
];

// 出现这些语法说明命令有自己的输出处理或多段语义，不改写
const UNSAFE_SYNTAX = /[\n\r|;&<>`]|\$\(/;

// 纯 && 串联且每段都在白名单内的命令链可以整体治理（典型：build && test）。
// 段内仍不允许任何复杂语法；任何一段不在白名单就整条放行。
function isGovernable(cmd) {
  if (!UNSAFE_SYNTAX.test(cmd)) return NOISY_COMMANDS.some((re) => re.test(cmd));
  const segments = cmd.split('&&').map((s) => s.trim());
  return (
    segments.length > 1 &&
    segments.every((s) => s && !UNSAFE_SYNTAX.test(s) && NOISY_COMMANDS.some((re) => re.test(s)))
  );
}

async function main() {
  const input = await readInput();
  if (!input || input.tool_name !== 'Shell') return respond(ALLOW);
  const cfg = loadConfig();
  if (!cfg.hooks.shellGuard || !cfg.shellGuardEnabled) return respond(ALLOW);
  if (process.platform === 'win32') return respond(ALLOW);

  const ti = input.tool_input || {};
  const cmd = typeof ti.command === 'string' ? ti.command.trim() : '';
  if (!cmd || cmd.includes('token-saver')) return respond(ALLOW);
  if (!isGovernable(cmd)) return respond(ALLOW);

  const root = projectDir();
  const helper = path.join(root, '.cursor', 'hooks', 'token-saver', 'print-log.mjs');
  if (!fs.existsSync(helper)) return respond(ALLOW);

  const convId = input.conversation_id || 'unknown';
  const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
  const rewritten =
    `__tsl=$(mktemp); { ${cmd}; } >"$__tsl" 2>&1; __tse=$?; ` +
    `node ${q(helper)} "$__tsl" ${cfg.shellHeadLines} ${cfg.shellTailLines} ${q(root)} ${q(convId)} ${q(cmd.slice(0, 500))} "$__tse"; ` +
    `( exit $__tse )`;

  logEvent({
    hook: 'shell-guard',
    action: 'rewrite',
    command: cmd.slice(0, 200),
    conversation_id: convId
  });
  return respond({ permission: 'allow', updated_input: { ...ti, command: rewritten } });
}

try {
  await main();
} catch {
  respond(ALLOW);
}
process.exit(0);
