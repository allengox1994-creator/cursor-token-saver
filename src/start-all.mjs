// 重启电脑后的一键启动器：幂等拉起全局面板和全局嵌入服务。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { globalHome } from './hooks/_lib.mjs';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function healthy(url, timeout = 600) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(url, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await healthy(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function ensureService(name, args, healthUrl, logFile) {
  if (await healthy(healthUrl)) return { name, ok: true, alreadyRunning: true };
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  let child;
  try {
    child = spawn(process.execPath, [path.join(pkgRoot, 'bin', 'cli.mjs'), ...args], {
      cwd: pkgRoot,
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env
    });
    child.unref();
  } finally {
    fs.closeSync(out);
  }
  const ok = await waitHealthy(healthUrl);
  return { name, ok, alreadyRunning: false, pid: child?.pid, logFile };
}

export async function startAll(options = {}) {
  const dashboardPort = Number(options.dashboardPort) || 4517;
  const daemonPort = Number(options.daemonPort) || 4518;
  const logs = path.join(globalHome(), 'logs');
  const services = [];
  services.push(
    await ensureService(
      '全局索引服务',
      ['daemon', '--port', String(daemonPort)],
      `http://127.0.0.1:${daemonPort}/health`,
      path.join(logs, 'daemon.log')
    )
  );
  services.push(
    await ensureService(
      '全局面板（含前端）',
      ['dashboard', '--port', String(dashboardPort)],
      `http://127.0.0.1:${dashboardPort}/api/projects`,
      path.join(logs, 'dashboard.log')
    )
  );
  return {
    ok: services.every((service) => service.ok),
    dashboardUrl: `http://127.0.0.1:${dashboardPort}`,
    services
  };
}

export async function startAllCmd(options = {}) {
  console.log('启动 Cursor Token Saver 服务…');
  const result = await startAll(options);
  for (const service of result.services) {
    if (service.ok) {
      console.log(`  ✓ ${service.name}${service.alreadyRunning ? ' 已在运行' : ` 已启动 (PID ${service.pid})`}`);
    } else {
      console.error(`  ✗ ${service.name} 启动失败，日志: ${service.logFile}`);
    }
  }
  if (result.ok) {
    console.log(`面板: ${result.dashboardUrl}`);
  } else {
    process.exitCode = 1;
  }
  return result;
}
