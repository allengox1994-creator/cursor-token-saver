// init 安装器：把 hooks、配置、rule、.cursorignore 装进目标项目。
// 幂等：重复运行只更新我们自己的条目，不动用户已有的 hooks / 配置 / ignore 内容。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROFILES,
  DEFAULT_HOOK_TOGGLES,
  registerProject,
  CONFIG_VERSION,
  DEFAULT_CONTEXT_QUERY,
  DEFAULT_ARTIFACT_STORE,
  DEFAULT_TASK_BUDGET,
  DEFAULT_EMBEDDING,
  DEFAULT_MEMORY
} from '../hooks/_lib.mjs';
import { mergeCursorIgnore } from '../hooks/cursorignore.mjs';

const HOOK_FILES = [
  '_lib.mjs',
  'read-guard.mjs',
  'file-blocklist.mjs',
  'shell-guard.mjs',
  'print-log.mjs',
  'edit-invalidate.mjs',
  'shell-audit.mjs',
  'mcp-audit.mjs',
  'session-track.mjs',
  'symbols.mjs',
  'analyze.mjs',
  'context-store.mjs',
  'hybrid-search.mjs',
  'context-query.mjs',
  'cursorignore.mjs',
  'data-profile.mjs',
  'delta.mjs',
  'git-context.mjs',
  'lsp-bridge.mjs',
  'test-selector.mjs',
  'auto-eval.mjs',
  'summary-store.mjs',
  'log-parser.mjs',
  'embed-index.mjs',
  'memory-store.mjs',
  'world-scan.mjs',
  'mcp-repo-map.mjs'
];

// 这段 rule 每个会话都会注入一次，保持最短可用（详细行为已由工具输出自身引导）。
const RULE_CONTENT = `---
description: Token-efficient working style (cursor-token-saver)
alwaysApply: true
---

- Explore code with \`context_query\` first: mode=search (hybrid retrieval, evidence IDs) / map / outline / callgraph / read (add \`symbol\` for one full symbol + file skeleton) / profile (JSON/CSV/YAML structure) / diff (git changes) / lsp (precise refs/defs, trust its fallback) / bootstrap (resume a prior task) / memory (recall facts) / world (entity/infra relations: domains, ports, services, scripts).
- Previews are routing hints. Before editing — or whenever comments, literals or omitted lines may matter, tests fail, or candidates conflict — \`context_expand\` the evidence ID (level=exact/full) instead of guessing; everything is recoverable by ID.
- Iterate with \`test_select\` phase=iterate (run its fallback if selected tests fail); always run phase=final before handoff. Save \`context_checkpoint\` before compaction/handoff.
- Save durable project facts (build commands, conventions, decisions, solved gotchas) with \`memory_save\` right after establishing them (triple {s,r,o} for infra/entity relations; steps[] for reusable runbooks; scope=global for cross-project facts; action=merge to consolidate similar entries); recall via bootstrap or \`context_query\` mode=memory/world, and confirm entries marked unconfirmed/STALE before relying on them.
- Trust delta and dedup markers: apply lossless line diffs to the copy in your context; a "byte-identical" result means reuse what you already have.
- Do not re-read unchanged files; do not restate large code in replies (cite path:line); redirect long command output to a file and grep it.
- Delegate broad exploration to an explore subagent; agree on a short plan for large tasks; once a task converges, prefer a fresh session over compaction.
`;

function hookCommand(file) {
  return `node .cursor/hooks/token-saver/${file}`;
}

function tokenSaverHookEntries() {
  return {
    preToolUse: [
      { command: hookCommand('read-guard.mjs'), matcher: '^Read$' },
      { command: hookCommand('shell-guard.mjs'), matcher: '^Shell$' }
    ],
    beforeReadFile: [{ command: hookCommand('file-blocklist.mjs'), matcher: '^Read$' }],
    afterFileEdit: [{ command: hookCommand('edit-invalidate.mjs') }],
    afterShellExecution: [{ command: hookCommand('shell-audit.mjs') }],
    afterMCPExecution: [{ command: hookCommand('mcp-audit.mjs') }],
    sessionStart: [{ command: hookCommand('session-track.mjs') }],
    stop: [{ command: hookCommand('session-track.mjs') }],
    preCompact: [{ command: hookCommand('session-track.mjs') }]
  };
}

function mergeMcpJson(mcpJsonPath) {
  let existing = {};
  if (fs.existsSync(mcpJsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
    } catch {
      fs.copyFileSync(mcpJsonPath, mcpJsonPath + '.bak');
      console.warn(`警告: 原 mcp.json 无法解析，已备份为 mcp.json.bak 后重建`);
      existing = {};
    }
  }
  existing.mcpServers = existing.mcpServers || {};
  existing.mcpServers['repo-map'] = {
    command: 'node',
    args: ['.cursor/hooks/token-saver/mcp-repo-map.mjs']
  };
  fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n');
}

function mergeHooksJson(hooksJsonPath) {
  let existing = { version: 1, hooks: {} };
  if (fs.existsSync(hooksJsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    } catch {
      fs.copyFileSync(hooksJsonPath, hooksJsonPath + '.bak');
      console.warn(`警告: 原 hooks.json 无法解析，已备份为 hooks.json.bak 后重建`);
      existing = { version: 1, hooks: {} };
    }
  }
  existing.version = existing.version || 1;
  existing.hooks = existing.hooks || {};

  for (const [event, entries] of Object.entries(tokenSaverHookEntries())) {
    const kept = (existing.hooks[event] || []).filter(
      (e) => !(e && typeof e.command === 'string' && e.command.includes('hooks/token-saver/'))
    );
    existing.hooks[event] = [...kept, ...entries];
  }
  fs.writeFileSync(hooksJsonPath, JSON.stringify(existing, null, 2) + '\n');
}

export function install(dir, opts = {}) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`错误: 目录不存在: ${dir}`);
    process.exit(1);
  }
  if (opts.profile && !PROFILES[opts.profile]) {
    console.error(`错误: 未知档位 "${opts.profile}"，可选: ${Object.keys(PROFILES).join(' | ')}`);
    process.exit(1);
  }

  const cursorDir = path.join(dir, '.cursor');
  const hookDir = path.join(cursorDir, 'hooks', 'token-saver');
  const rulesDir = path.join(cursorDir, 'rules');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.mkdirSync(rulesDir, { recursive: true });

  // 1. 复制 hook 脚本（零依赖，直接可跑）
  const srcHooksDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
  for (const file of HOOK_FILES) {
    fs.copyFileSync(path.join(srcHooksDir, file), path.join(hookDir, file));
  }

  // 2. 合并 hooks.json 和 mcp.json
  mergeHooksJson(path.join(cursorDir, 'hooks.json'));
  mergeMcpJson(path.join(cursorDir, 'mcp.json'));

  // 3. 配置文件：不存在才创建；显式传 --profile 时更新档位
  const configPath = path.join(cursorDir, 'token-saver.json');
  let config = {
    configVersion: CONFIG_VERSION,
    profile: 'standard',
    hooks: { ...DEFAULT_HOOK_TOGGLES },
    overrides: {},
    embedding: { ...DEFAULT_EMBEDDING },
    contextQuery: { ...DEFAULT_CONTEXT_QUERY },
    artifactStore: { ...DEFAULT_ARTIFACT_STORE },
    taskBudget: { ...DEFAULT_TASK_BUDGET },
    memory: { ...DEFAULT_MEMORY }
  };
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {}
  }
  if (opts.profile) config.profile = opts.profile;
  config.configVersion = CONFIG_VERSION;
  config.embedding = { ...DEFAULT_EMBEDDING, ...(config.embedding || {}) };
  config.contextQuery = { ...DEFAULT_CONTEXT_QUERY, ...(config.contextQuery || {}) };
  config.artifactStore = { ...DEFAULT_ARTIFACT_STORE, ...(config.artifactStore || {}) };
  config.taskBudget = { ...DEFAULT_TASK_BUDGET, ...(config.taskBudget || {}), hardLimit: false };
  config.memory = { ...DEFAULT_MEMORY, ...(config.memory || {}) };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  // 4. 精简 rule
  fs.writeFileSync(path.join(rulesDir, 'token-saver.mdc'), RULE_CONTENT);

  // 5. .cursorignore
  const ignoreCount = mergeCursorIgnore(dir).count;

  // 6. 记录安装包路径：复制进项目的 MCP 服务器靠它加载神经嵌入依赖（transformers.js）
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dataDir = path.join(cursorDir, 'token-saver');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'pkg.json'), JSON.stringify({ packageRoot: pkgRoot }, null, 2) + '\n');
  const statusPath = path.join(dataDir, 'embed-status.json');
  let status = {};
  try {
    status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  } catch {}
  fs.writeFileSync(
    statusPath,
    JSON.stringify({ ...status, needsRestart: true, scriptsSyncedAt: new Date().toISOString() }, null, 2) + '\n'
  );

  // 7. 登记到全局注册表（~/.cursor-token-saver/projects.json），供全局面板聚合。
  // 显式 init 视为恢复管理：即使之前在面板剔除过也重新登记
  registerProject(dir, { force: true });

  const profile = PROFILES[config.profile] ? config.profile : 'standard';
  console.log(`cursor-token-saver 已安装到 ${dir}
  档位: ${profile}（${PROFILES[profile].label} - ${PROFILES[profile].description}）
  写入:
    .cursor/hooks.json               (合并，保留原有 hooks)
    .cursor/mcp.json                 (合并，注册 repo-map MCP 服务器)
    .cursor/hooks/token-saver/       (${HOOK_FILES.length} 个脚本)
    .cursor/token-saver.json         (配置，面板或手改即时生效)
    .cursor/rules/token-saver.mdc    (省 token 行为规则)
    .cursorignore                    (标记块内 ${ignoreCount} 条)
  已登记到全局注册表（~/.cursor-token-saver/projects.json），全局面板可见此项目
  下一步:
    - Cursor 会自动加载 hooks（设置 -> Hooks 可确认；无效则重启 Cursor）
    - 设置 -> MCP 中启用 repo-map 服务器（首次需要确认）
    - npx cursor-token-saver dashboard   打开全局面板（所有项目的统计与配置）
    - npx cursor-token-saver report --all  终端看全局汇总`);
}
