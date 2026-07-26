// 持久任务检查点。不会伪造 AI 摘要：
// Agent 可通过 context_checkpoint 写语义决策；hooks 只追加确定性的状态/验证事件。
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './_lib.mjs';

function sanitize(id) {
  return String(id || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

export function summaryDir(root) {
  return path.join(dataDir(root), 'summaries');
}

function summaryPath(root, conversationId) {
  return path.join(summaryDir(root), `${sanitize(conversationId)}.json`);
}

export function loadCheckpoint(root, conversationId) {
  try {
    return JSON.parse(fs.readFileSync(summaryPath(root, conversationId), 'utf8'));
  } catch {
    return null;
  }
}

export function saveCheckpoint(root, conversationId, patch = {}) {
  try {
    const prev = loadCheckpoint(root, conversationId) || {
      schemaVersion: 1,
      conversationId: conversationId || 'default',
      createdAt: new Date().toISOString(),
      events: []
    };
    const next = {
      ...prev,
      ...patch,
      filesTouched: [...new Set([...(prev.filesTouched || []), ...(patch.filesTouched || [])])].slice(-200),
      decisions: patch.decisions || prev.decisions || [],
      openQuestions: patch.openQuestions || prev.openQuestions || [],
      updatedAt: new Date().toISOString()
    };
    if (patch.event) next.events = [...(prev.events || []), patch.event].slice(-100);
    delete next.event;
    fs.mkdirSync(summaryDir(root), { recursive: true });
    const target = summaryPath(root, conversationId);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, target);
    return next;
  } catch {
    return null;
  }
}

export function gcCheckpoints(root, maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
  let removed = 0;
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(summaryDir(root))) {
      const file = path.join(summaryDir(root), name);
      if (name.endsWith('.json') && fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
        removed++;
      }
    }
  } catch {}
  return removed;
}
