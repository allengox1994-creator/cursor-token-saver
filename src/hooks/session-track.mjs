#!/usr/bin/env node
// sessionStart / stop / preCompact 共用一个脚本，按 hook_event_name 分派。
// 会话统计 + 压缩事件记录（preCompact 提供真实 context_tokens，用于面板校准展示）。
import fs from 'node:fs';
import path from 'node:path';
import {
  readInput,
  respond,
  loadConfig,
  logEvent,
  gcStates,
  registerProject,
  syncHookScripts,
  projectDir
} from './_lib.mjs';
import { gcContextStore } from './context-store.mjs';
import { gcCheckpoints, saveCheckpoint, summaryDir } from './summary-store.mjs';
import { mergeCursorIgnore } from './cursorignore.mjs';
import { decayMemories } from './memory-store.mjs';
import { maybeScanWorld } from './world-scan.mjs';

const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BOOTSTRAP_FRESH_MS = 48 * 60 * 60 * 1000;
const IGNORE_RESCAN_MS = 24 * 60 * 60 * 1000;

// .cursorignore 会话期自动维护：每 24h 重扫一次新出现的超大文件，防止索引期后
// 生成的数据/日志文件被意外带进上下文。只动我们的标记块，用户内容不碰。
function maybeRescanIgnore(root) {
  const stampPath = path.join(root, '.cursor', 'token-saver', 'ignore-scan.json');
  try {
    const last = JSON.parse(fs.readFileSync(stampPath, 'utf8')).lastScan || 0;
    if (Date.now() - last < IGNORE_RESCAN_MS) return;
  } catch {}
  try {
    const { count, changed } = mergeCursorIgnore(root);
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, JSON.stringify({ lastScan: Date.now(), count }));
    if (changed) logEvent({ hook: 'session-track', action: 'ignore_rescan', entries: count });
  } catch {}
}

// 最近 48h 内有检查点 → 新会话提示可用 bootstrap 热启动包（一次工具调用恢复任务状态）
function recentCheckpointHint() {
  try {
    let newest = 0;
    for (const name of fs.readdirSync(summaryDir(projectDir()))) {
      if (!name.endsWith('.json')) continue;
      newest = Math.max(newest, fs.statSync(path.join(summaryDir(projectDir()), name)).mtimeMs);
    }
    return newest > 0 && Date.now() - newest < BOOTSTRAP_FRESH_MS;
  } catch {
    return false;
  }
}

async function main() {
  const input = await readInput();
  if (!input) return respond({});
  const cfg = loadConfig();
  if (!cfg.hooks.sessionTrack) return respond({});

  switch (input.hook_event_name) {
    case 'sessionStart': {
      gcStates(STATE_MAX_AGE_MS);
      registerProject(); // 登记到全局注册表，供全局面板聚合
      const synced = syncHookScripts(); // 包升级后自动更新本项目的脚本副本
      if (synced > 0) {
        logEvent({ hook: 'session-track', action: 'scripts_sync', files: synced });
        // 磁盘脚本已更新，但常驻 MCP 仍是旧内存代码；面板明确提示需要重启。
        try {
          const statusPath = path.join(projectDir(), '.cursor', 'token-saver', 'embed-status.json');
          let status = {};
          try {
            status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
          } catch {}
          fs.mkdirSync(path.dirname(statusPath), { recursive: true });
          fs.writeFileSync(statusPath, JSON.stringify({ ...status, needsRestart: true, scriptsSyncedAt: new Date().toISOString() }));
        } catch {}
      }
      gcContextStore(projectDir(), cfg.artifactStore);
      gcCheckpoints(projectDir());
      maybeRescanIgnore(projectDir());
      // 记忆衰减：长期未用的条目归档（可恢复），控制记忆本身的 token 成本
      try {
        if (cfg.memory.enabled) decayMemories(projectDir(), cfg.memory);
      } catch {}
      // 世界模型：24h 节流重扫配置文件，机械提取实体关系候选
      try {
        if (cfg.memory.enabled) maybeScanWorld(projectDir());
      } catch {}
      logEvent({
        hook: 'session-track',
        action: 'session_start',
        composer_mode: input.composer_mode,
        is_background_agent: input.is_background_agent,
        conversation_id: input.conversation_id || input.session_id
      });
      if (cfg.contextQuery.bootstrapHint !== false && recentCheckpointHint()) {
        // 若该 Cursor 版本不支持 sessionStart 注入 agent_message 则被静默忽略，无副作用
        return respond({
          agent_message:
            'token-saver: recent task state exists for this project. If continuing prior work, call ' +
            'context_query {mode:"bootstrap"} first — it restores checkpoint, changed files and evidence IDs in a few hundred tokens.'
        });
      }
      return respond({});
    }
    case 'stop': {
      saveCheckpoint(projectDir(), input.conversation_id || input.session_id || 'default', {
        status: input.status || 'stopped',
        event: { at: new Date().toISOString(), type: 'stop', loopCount: input.loop_count }
      });
      logEvent({
        hook: 'session-track',
        action: 'stop',
        status: input.status,
        loop_count: input.loop_count,
        conversation_id: input.conversation_id
      });
      return respond({});
    }
    case 'preCompact': {
      saveCheckpoint(projectDir(), input.conversation_id || 'default', {
        context: {
          tokens: input.context_tokens,
          usagePercent: input.context_usage_percent,
          windowSize: input.context_window_size
        },
        event: { at: new Date().toISOString(), type: 'preCompact', trigger: input.trigger }
      });
      logEvent({
        hook: 'session-track',
        action: 'compact',
        trigger: input.trigger,
        context_tokens: input.context_tokens,
        context_usage_percent: input.context_usage_percent,
        context_window_size: input.context_window_size,
        messages_to_compact: input.messages_to_compact,
        conversation_id: input.conversation_id
      });
      if (cfg.compactNotice) {
        return respond({
          user_message:
            `token-saver: 上下文已用 ${input.context_usage_percent ?? '?'}%` +
            `（约 ${input.context_tokens ?? '?'} tokens），即将压缩。` +
            `机械检查点已保存；可用 context_checkpoint action=get 恢复。若任务已收敛，开新会话更省。`
        });
      }
      return respond({});
    }
    default:
      return respond({});
  }
}

try {
  await main();
} catch {
  respond({});
}
process.exit(0);
