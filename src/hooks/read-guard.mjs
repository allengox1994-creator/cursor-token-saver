#!/usr/bin/env node
// preToolUse (matcher: Read)
// 1. 超过行数上限的全量读 -> deny + 指路（context_query / read_compact / 区间读）
// 2. 短时间内重复读同一未修改文件 -> deny + 指路
// 3. 增量重读：文件自上次全量读后发生变化 -> 只传无损行差分（旧内容 + diff = 新内容），
//    新内容整体存为快照 artifact，任何时候可按 ID 精确恢复。
// 防锁死兜底：任何 deny 之后，agent 对同一文件立即重试一次即强制放行（override）。
import fs from 'node:fs';
import path from 'node:path';
import {
  readInput,
  respond,
  loadConfig,
  logEvent,
  estTokens,
  loadState,
  saveState,
  projectDir
} from './_lib.mjs';
import { putArtifact, getEvidence } from './context-store.mjs';
import { lineDiff } from './delta.mjs';

const ALLOW = { permission: 'allow' };
const OVERRIDE_WINDOW_MS = 5 * 60 * 1000;
const SNAPSHOT_MAX_BYTES = 512 * 1024;

// 记录"这次交付给模型的完整内容"，供下次变化后做无损差分
function takeSnapshot(content, file, convId) {
  if (content == null || Buffer.byteLength(content) > SNAPSHOT_MAX_BYTES) return null;
  return putArtifact(projectDir(), content, {
    kind: 'read-snapshot',
    meta: { file, conversationId: convId }
  });
}

async function main() {
  const input = await readInput();
  if (!input || input.tool_name !== 'Read') return respond(ALLOW);
  const cfg = loadConfig();
  if (!cfg.hooks.readGuard) return respond(ALLOW);

  const ti = input.tool_input || {};
  const rawPath = ti.file_path || ti.path || ti.target_file;
  if (!rawPath || typeof rawPath !== 'string') return respond(ALLOW);
  const file = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(input.cwd || projectDir(), rawPath);

  // 若未来版本开始传区间参数，区间读取直接放行
  if (ti.limit != null || ti.offset != null) return respond(ALLOW);

  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return respond(ALLOW);
  }
  if (!st.isFile()) return respond(ALLOW);

  const convId = input.conversation_id || 'unknown';
  const state = loadState(convId);
  state.reads = state.reads || {};
  state.denials = state.denials || {};
  const now = Date.now();

  // 防锁死：刚被拦过又来读同一文件 = agent 坚持需要，放行
  const denial = state.denials[file];
  if (denial && now - denial.at < OVERRIDE_WINDOW_MS) {
    delete state.denials[file];
    let overrideContent = null;
    try {
      if (st.size <= SNAPSHOT_MAX_BYTES) overrideContent = fs.readFileSync(file, 'utf8');
    } catch {}
    const snap = takeSnapshot(overrideContent, file, convId);
    state.reads[file] = { at: now, mtimeMs: st.mtimeMs, ...(snap ? { snapshotId: snap.id } : {}) };
    saveState(convId, state);
    logEvent({
      hook: 'read-guard',
      action: 'override-allow',
      file,
      conversation_id: convId
    });
    return respond(ALLOW);
  }

  // 重复读取未修改的文件（agent 自己编辑过的文件走下面的差分路径）
  const prev = state.reads[file];
  if (
    prev &&
    !prev.editedAt &&
    cfg.repeatReadWindowMs > 0 &&
    now - prev.at < cfg.repeatReadWindowMs &&
    prev.mtimeMs === st.mtimeMs
  ) {
    const mins = Math.max(1, Math.round((now - prev.at) / 60000));
    state.denials[file] = { at: now };
    saveState(convId, state);
    logEvent({
      hook: 'read-guard',
      action: 'deny-repeat',
      file,
      savedBytes: st.size,
      savedTokens: estTokens(st.size),
      conversation_id: convId
    });
    const guidance =
      `token-saver: You already read ${file} in full ${mins} min ago and it has not been modified since. ` +
      `Reuse the content from your context, call context_query/context_expand for a lossless targeted range, or grep a specific symbol. ` +
      `If you truly need it again, repeat the exact same read once to override.`;
    return respond({
      permission: 'deny',
      agent_message: guidance,
      user_message: `token-saver: 拦截了对 ${path.basename(file)} 的重复读取（${mins} 分钟内已读过且未修改；agent 重试一次即放行）`
    });
  }

  // 行数统计（超大文件按平均行宽估算，不逐行数）
  let content = null;
  let lines;
  if (st.size <= 8 * 1024 * 1024) {
    try {
      content = fs.readFileSync(file, 'utf8');
      lines = content.length ? content.split('\n').length : 0;
    } catch {
      return respond(ALLOW);
    }
  } else {
    lines = Math.ceil(st.size / 40);
  }

  // 增量重读：读过全量且文件已变化（或 agent 自己编辑过）→ 只传无损差分
  if (
    prev?.snapshotId &&
    content != null &&
    cfg.contextQuery.deltaRead !== false &&
    (prev.mtimeMs !== st.mtimeMs || prev.editedAt)
  ) {
    const old = getEvidence(projectDir(), prev.snapshotId, { level: 'full' });
    if (!old.error && typeof old.text === 'string') {
      const diff = lineDiff(old.text, content);
      if (diff?.identical) {
        // 只是 touch 过（或编辑后内容未变）：内容与模型已有版本一致，直接放行并刷新状态
        state.reads[file] = { at: now, mtimeMs: st.mtimeMs, snapshotId: prev.snapshotId };
        saveState(convId, state);
        logEvent({ hook: 'read-guard', action: 'read', file, bytes: st.size, lines, conversation_id: convId });
        return respond(ALLOW);
      }
      const contentBytes = Buffer.byteLength(content);
      const diffBytes = diff ? Buffer.byteLength(diff.text) : Infinity;
      const maxChanged = cfg.contextQuery.deltaReadMaxLines || 200;
      if (diff && diff.changedLines <= maxChanged && diffBytes < contentBytes * 0.6) {
        const snap = takeSnapshot(content, file, convId);
        state.reads[file] = {
          at: now,
          mtimeMs: st.mtimeMs,
          ...(snap ? { snapshotId: snap.id } : {})
        };
        state.denials[file] = { at: now };
        saveState(convId, state);
        const savedBytes = Math.max(0, contentBytes - diffBytes);
        logEvent({
          hook: 'read-guard',
          action: 'delta-read',
          file,
          changedLines: diff.changedLines,
          originalBytes: contentBytes,
          transmittedBytes: diffBytes,
          savedBytes,
          savedTokens: estTokens(savedBytes),
          conversation_id: convId
        });
        const guidance =
          `token-saver: ${file} changed since your last full read. Lossless line diff below ` +
          `(${diff.changedLines} changed lines out of ${diff.newLines}); apply it to the copy already in your context. ` +
          (snap ? `Exact full current content: context_expand {id:"${snap.id}",level:"full"}. ` : '') +
          `If you need the whole raw file, repeat the exact same read once to override.\n\n${diff.text}`;
        return respond({
          permission: 'deny',
          agent_message: guidance,
          user_message: `token-saver: ${path.basename(file)} 以增量差分代替全量重读（${diff.changedLines} 行变化，省 ~${estTokens(savedBytes)} tokens）`
        });
      }
    }
  }

  // 25% 宽限：略超上限的文件直接放行，避免临界文件多一轮往返
  if (lines > cfg.readMaxLines * 1.25) {
    const savedBytes = Math.max(0, Math.round(st.size * (1 - cfg.readMaxLines / lines)));
    state.denials[file] = { at: now };
    saveState(convId, state);
    logEvent({
      hook: 'read-guard',
      action: 'deny-oversize',
      file,
      lines,
      maxLines: cfg.readMaxLines,
      savedBytes,
      savedTokens: estTokens(savedBytes),
      conversation_id: convId
    });
    const guidance =
      `token-saver: ${file} has ${lines} lines (~${Math.round(st.size / 1024)} KB). ` +
      `Full reads over ${cfg.readMaxLines} lines are blocked to save tokens. ` +
      `Prefer context_query mode=outline/read, then context_expand by evidence ID for exact source; ` +
      `ranged reads also work, e.g. sed -n '1,${cfg.readMaxLines}p' "${file}". ` +
      `If you truly need the whole raw file, repeat the exact same read once to override.`;
    return respond({
      permission: 'deny',
      agent_message: guidance,
      user_message: `token-saver: 拦截了对 ${path.basename(file)} 的全量读取（${lines} 行 > 上限 ${cfg.readMaxLines} 行；agent 重试一次即放行）`
    });
  }

  const snap = takeSnapshot(content, file, convId);
  state.reads[file] = { at: now, mtimeMs: st.mtimeMs, ...(snap ? { snapshotId: snap.id } : {}) };
  saveState(convId, state);
  // 纯观测：记录放行的全量读，供面板"浪费洞察"找出频繁重读/超大数据读取
  logEvent({ hook: 'read-guard', action: 'read', file, bytes: st.size, lines, conversation_id: convId });
  return respond(ALLOW);
}

try {
  await main();
} catch {
  respond(ALLOW); // fail-open：自身出错绝不拦人
}
process.exit(0);
