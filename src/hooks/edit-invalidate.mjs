#!/usr/bin/env node
// afterFileEdit
// 文件被编辑后标记 editedAt 并清除 denial：read-guard 不会误拦编辑后的合理重读，
// 且保留读取快照引用，让下次重读可以走无损增量差分而不是全量重传。
import fs from 'node:fs';
import {
  readInput,
  respond,
  loadConfig,
  loadState,
  saveState,
  allStateFiles,
  projectDir
} from './_lib.mjs';
import { saveCheckpoint } from './summary-store.mjs';

async function main() {
  const input = await readInput();
  if (!input || typeof input.file_path !== 'string') return respond({});
  const cfg = loadConfig();
  if (!cfg.hooks.editInvalidate) return respond({});

  const file = input.file_path;
  const clear = (state) => {
    let touched = false;
    if (state.denials && state.denials[file]) {
      delete state.denials[file];
      touched = true;
    }
    if (state.reads && state.reads[file]) {
      // 保留快照引用，标记已编辑：重读时优先走增量差分（无快照则直接放行）
      state.reads[file].editedAt = Date.now();
      touched = true;
    }
    return touched;
  };

  if (input.conversation_id) {
    const state = loadState(input.conversation_id);
    clear(state);
    // 记录最近编辑：失败→修复的机械记忆提取需要"失败之后改了哪些文件"
    state.recentEdits = state.recentEdits || {};
    state.recentEdits[file] = Date.now();
    const keys = Object.keys(state.recentEdits);
    if (keys.length > 50) {
      for (const k of keys.sort((a, b) => state.recentEdits[a] - state.recentEdits[b]).slice(0, keys.length - 50)) {
        delete state.recentEdits[k];
      }
    }
    saveState(input.conversation_id, state);
    saveCheckpoint(projectDir(), input.conversation_id, {
      filesTouched: [file],
      event: { at: new Date().toISOString(), type: 'file-edit', file }
    });
  } else {
    // Tab 等来源没有会话 ID，清理所有会话状态里的该文件
    for (const f of allStateFiles()) {
      try {
        const state = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (clear(state)) fs.writeFileSync(f, JSON.stringify(state));
      } catch {}
    }
  }
  return respond({});
}

try {
  await main();
} catch {
  respond({});
}
process.exit(0);
