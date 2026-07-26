// 自动检索评测调度器：仅由索引变更触发，延迟、限频、后台低优先级执行。
// 调度状态持久化；MCP 进程提前退出时，下次启动会恢复未完成计划。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dataDir, loadConfig } from './_lib.mjs';

const timers = new Map();
const MAX_TIMER_MS = 2_147_000_000;

function statusPath(root) {
  return path.join(dataDir(root), 'eval-status.json');
}

function reportPath(root) {
  return path.join(dataDir(root), 'eval-report.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeStatus(root, patch) {
  try {
    fs.mkdirSync(dataDir(root), { recursive: true });
    const prev = readJson(statusPath(root)) || {};
    fs.writeFileSync(statusPath(root), JSON.stringify({ ...prev, ...patch }, null, 2) + '\n');
  } catch {}
}

function lastEvalAt(root) {
  const report = readJson(reportPath(root));
  const value = Date.parse(report?.generatedAt || '');
  return Number.isFinite(value) ? value : 0;
}

function spawnEval(root, pkgRoot, limit) {
  const logs = path.join(dataDir(root), 'eval.log');
  const out = fs.openSync(logs, 'a');
  let child;
  try {
    child = spawn(
      process.execPath,
      [path.join(pkgRoot, 'bin', 'cli.mjs'), 'eval', '--dir', root, '--limit', String(limit), '--auto'],
      { cwd: root, detached: true, stdio: ['ignore', out, out], env: process.env }
    );
    child.unref();
    try {
      os.setPriority(child.pid, 10);
    } catch {}
  } finally {
    fs.closeSync(out);
  }
  return child?.pid;
}

export function scheduleAutoEval(root, options = {}) {
  const embedding = loadConfig(root).embedding || {};
  if (embedding.autoEval === false) {
    writeStatus(root, { state: 'disabled', updatedAt: new Date().toISOString() });
    return { scheduled: false, reason: 'disabled' };
  }
  const pkgRoot = options.pkgRoot;
  if (!pkgRoot || !fs.existsSync(path.join(pkgRoot, 'bin', 'cli.mjs'))) {
    writeStatus(root, { state: 'unavailable', error: 'package root unavailable', updatedAt: new Date().toISOString() });
    return { scheduled: false, reason: 'package unavailable' };
  }
  const interval =
    Number(process.env.TOKEN_SAVER_AUTO_EVAL_INTERVAL_MS) ||
    Math.max(1, Number(embedding.autoEvalIntervalHours) || 24) * 60 * 60 * 1000;
  const delay = Number(process.env.TOKEN_SAVER_AUTO_EVAL_DELAY_MS) || 2 * 60 * 1000;
  const previous = lastEvalAt(root);
  const persistedDue = Number(options.dueAt) || 0;
  const dueAt = options.resume
    ? Math.max(Date.now() + 1000, persistedDue, previous ? previous + interval : 0)
    : Math.max(Date.now() + delay, previous ? previous + interval : 0);
  const existing = timers.get(root);
  if (existing) clearTimeout(existing);
  writeStatus(root, {
    state: 'scheduled',
    reason: options.reason || 'index changed',
    requestedAt: new Date().toISOString(),
    dueAt: new Date(dueAt).toISOString(),
    error: null
  });
  const timer = setTimeout(async () => {
    timers.delete(root);
    if (Date.now() + 100 < dueAt) {
      scheduleAutoEval(root, { ...options, dueAt, resume: true });
      return;
    }
    const current = loadConfig(root).embedding || {};
    if (current.autoEval === false) {
      writeStatus(root, { state: 'disabled', updatedAt: new Date().toISOString() });
      return;
    }
    try {
      writeStatus(root, { state: 'starting', startedAt: new Date().toISOString() });
      const pid = options.runner
        ? await options.runner()
        : spawnEval(root, pkgRoot, Math.min(200, Math.max(5, Number(current.autoEvalLimit) || 50)));
      if (pid) writeStatus(root, { pid });
    } catch (e) {
      writeStatus(root, { state: 'error', error: String(e?.message || e), updatedAt: new Date().toISOString() });
    }
  }, Math.min(MAX_TIMER_MS, Math.max(0, dueAt - Date.now())));
  timer.unref();
  timers.set(root, timer);
  return { scheduled: true, dueAt };
}

export function resumeAutoEval(root, pkgRoot) {
  const status = readJson(statusPath(root));
  if (!status || !['scheduled', 'starting', 'waiting', 'running'].includes(status.state)) return false;
  if (['starting', 'waiting', 'running'].includes(status.state) && status.pid) {
    try {
      process.kill(status.pid, 0);
      return false;
    } catch {}
  }
  // 进程已消失时恢复持久计划；CLI 锁还会做跨 MCP 的最终防重。
  scheduleAutoEval(root, {
    pkgRoot,
    reason: status.reason || 'resume pending evaluation',
    dueAt: Date.parse(status.dueAt || '') || 0,
    resume: true
  });
  return true;
}

export function ensureAutoEvalBaseline(root, pkgRoot) {
  const status = readJson(statusPath(root));
  if (status && ['scheduled', 'starting', 'waiting', 'running'].includes(status.state)) {
    return resumeAutoEval(root, pkgRoot);
  }
  try {
    const indexMtime = fs.statSync(path.join(dataDir(root), 'embed-index.json')).mtimeMs;
    const reportMtime = fs.statSync(reportPath(root)).mtimeMs;
    if (reportMtime >= indexMtime) return false;
  } catch (e) {
    // 没有报告但已有索引时建立首次基线；没有索引则等待索引构建完成。
    if (!fs.existsSync(path.join(dataDir(root), 'embed-index.json'))) return false;
  }
  return scheduleAutoEval(root, { pkgRoot, reason: 'index newer than evaluation baseline' }).scheduled;
}
