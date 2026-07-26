#!/usr/bin/env node
// afterShellExecution
// 纯观测：记录每条命令的输出体量，供面板找出"浪费大户"。不拦截、不修改。
// 额外的机械记忆提取：同一命令从失败变成功时，把"失败→修复涉及的文件"存为候选 gotcha。
import path from 'node:path';
import { readInput, respond, loadConfig, logEvent, addBudgetUsage, loadState, saveState, projectDir } from './_lib.mjs';
import { saveMemory } from './memory-store.mjs';
import { saveCheckpoint } from './summary-store.mjs';

const FIX_WINDOW_MS = 2 * 60 * 60 * 1000;
// 纯读类命令不进 runbook 时间线：探索动作不是"流程步骤"
const TRIVIAL_CMD_RE =
  /^(ls|cat|head|tail|pwd|cd|echo|which|rg|grep|find|wc|stat|ps|env|printenv|whoami|date|df|du|less|more|file|tree|history|man|type|sleep|clear|git (status|log|diff|show|branch))\b/;

// 失败→修复提取：纯事实（命令、退出码、期间编辑的文件），auto 来源 → candidate 待确认
function extractFixMemory(cfg, state, command) {
  const f = state.lastFailure;
  if (!f || f.command !== command || Date.now() - f.at > FIX_WINDOW_MS) return;
  const root = projectDir();
  const edited = Object.entries(state.recentEdits || {})
    .filter(([, ts]) => ts > f.at)
    .map(([file]) => path.relative(root, file).split(path.sep).join('/'))
    .filter((rel) => rel && !rel.startsWith('..'))
    .slice(0, 8);
  if (!edited.length) return; // 没有编辑的"失败转成功"多半是环境抖动，不值得记
  saveMemory(root, {
    text: `"${f.command}" failed (exit ${f.exitCode}) and passed after editing ${edited.join(', ')}`,
    kind: 'gotcha',
    files: edited,
    source: 'auto'
  });
  logEvent({ hook: 'shell-audit', action: 'memory_save', op: 'auto-fix', command: f.command.slice(0, 160) });
}

async function main() {
  const input = await readInput();
  if (!input || typeof input.command !== 'string') return respond({});
  const cfg = loadConfig();
  if (!cfg.hooks.shellAudit) return respond({});

  const bytes = typeof input.output === 'string' ? Buffer.byteLength(input.output) : 0;
  const convId = input.conversation_id || 'unknown';
  // 传原始文本：CJK 感知的分词估算比 bytes/4 准确
  const budget = addBudgetUsage(convId, 'shell', typeof input.output === 'string' ? input.output : 0);
  const exitCode = Number(input.exit_code ?? input.exitCode ?? input.status ?? 0);
  const normalizedCmd = input.command.replace(/\s+/g, ' ').slice(0, 300);
  // 有实际动作的命令进检查点时间线：任务收尾时机械提取成 runbook 步骤
  if (convId !== 'unknown' && !TRIVIAL_CMD_RE.test(normalizedCmd)) {
    try {
      saveCheckpoint(projectDir(), convId, {
        event: { at: new Date().toISOString(), type: 'command', command: normalizedCmd.slice(0, 200), exitCode }
      });
    } catch {}
  }
  if (Number.isFinite(exitCode) && exitCode !== 0) {
    const state = loadState(convId);
    state.lastFailure = { at: Date.now(), kind: 'shell', command: normalizedCmd, exitCode };
    saveState(convId, state);
  } else if (exitCode === 0) {
    const state = loadState(convId);
    if (state.lastFailure) {
      try {
        if (cfg.memory?.enabled !== false) extractFixMemory(cfg, state, normalizedCmd);
      } catch {}
      if (state.lastFailure.command === normalizedCmd) {
        delete state.lastFailure; // 修复确认后清除，避免重复提取和过期的失败提示
        saveState(convId, state);
      }
    }
  }
  logEvent({
    hook: 'shell-audit',
    action: 'observe',
    command: input.command.replace(/\s+/g, ' ').slice(0, 160),
    bytes,
    transmittedBytes: bytes,
    budgetTokens: budget.usedTokens,
    budgetWarned: budget.warned,
    exitCode,
    duration: input.duration,
    conversation_id: convId
  });
  return respond(
    budget.justWarned
      ? {
          user_message:
            `token-saver: 本会话工具输出约 ${budget.usedTokens} tokens，已达到软预算提醒。` +
            `后续首屏会自动更紧凑，但 context_expand/full 始终可用，不会阻止能力。`
        }
      : {}
  );
}

try {
  await main();
} catch {
  respond({});
}
process.exit(0);
