#!/usr/bin/env node
// afterMCPExecution
// 纯观测：记录每次 MCP 工具调用的输出体量，供面板找出"MCP 噪音大户"。不拦截、不修改。
// action 用 observe（与 shell-audit 一致），自动进入面板的 Top 噪音命令榜。
import { readInput, respond, loadConfig, logEvent, addBudgetUsage, projectDir } from './_lib.mjs';
import { putArtifact } from './context-store.mjs';

function sizeOf(v) {
  if (v == null) return 0;
  if (typeof v === 'string') return Buffer.byteLength(v);
  try {
    return Buffer.byteLength(JSON.stringify(v));
  } catch {
    return 0;
  }
}

async function main() {
  const input = await readInput();
  if (!input) return respond({});
  const cfg = loadConfig();
  if (!cfg.hooks.mcpAudit) return respond({});

  const toolName = String(input.tool_name || input.name || 'unknown-mcp-tool');
  // repo-map 自己的调用已由服务器端记录，跳过避免重复
  if (/repo.?map/i.test(toolName)) return respond({});

  const rawOutput = input.tool_output ?? input.output ?? input.result ?? input.tool_response;
  const bytes = sizeOf(rawOutput);
  const convId = input.conversation_id || 'unknown';
  // 传原始文本：CJK 感知的分词估算比 bytes/4 准确
  const budget = addBudgetUsage(convId, 'mcp', typeof rawOutput === 'string' ? rawOutput : bytes);
  const artifact =
    cfg.artifactStore.enabled && bytes > cfg.contextQuery.defaultBudgetChars
      ? putArtifact(projectDir(), typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput), {
          kind: 'mcp-output',
          meta: { toolName, conversationId: convId }
        })
      : null;
  logEvent({
    hook: 'mcp-audit',
    action: 'observe',
    command: `MCP ${toolName}`.slice(0, 160),
    bytes,
    transmittedBytes: bytes,
    originalBytes: bytes,
    artifactId: artifact?.id,
    budgetTokens: budget.usedTokens,
    budgetWarned: budget.warned,
    duration: input.duration,
    conversation_id: convId
  });
  return respond(
    budget.justWarned || artifact
      ? {
          user_message:
            (budget.justWarned
              ? `token-saver: 本会话工具输出约 ${budget.usedTokens} tokens，已达到软预算提醒。`
              : `token-saver: 该 MCP 输出较大，已保存为 ${artifact.id}。`) +
            ` 后续可用 context_expand 精确回取，不限制 exact/full。`
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
