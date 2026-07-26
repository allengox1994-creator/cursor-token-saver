// 全局嵌入守护进程客户端。连接/启动失败时返回 null，调用方立即回退项目内后端。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { globalHome } from '../hooks/_lib.mjs';
import { DEFAULT_MODEL, getEmbedder } from './embedder.mjs';

function readState(defaultPort = 4518) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(globalHome(), 'daemon.json'), 'utf8'));
    return { port: Number(state.port) || defaultPort, pid: state.pid };
  } catch {
    return { port: defaultPort, pid: null };
  }
}

async function healthy(port, timeout = 300) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeout) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon(pkgRoot, port) {
  if (await healthy(port)) return true;
  try {
    const child = spawn(process.execPath, [path.join(pkgRoot, 'bin', 'cli.mjs'), 'daemon', '--port', String(port)], {
      cwd: pkgRoot,
      detached: true,
      stdio: 'ignore',
      env: process.env
    });
    child.unref();
  } catch {
    return false;
  }
  const deadline = Date.now() + 1800;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await healthy(port, 200)) return true;
  }
  return false;
}

export async function getDaemonEmbedder(model = DEFAULT_MODEL, pkgRoot, options = {}) {
  if (!pkgRoot || process.env.TOKEN_SAVER_EMBED_DAEMON === 'off') return null;
  const configuredPort = Number(process.env.TOKEN_SAVER_DAEMON_PORT || options.port) || 4518;
  const state = readState(configuredPort);
  const port = state.port;
  if (!(await ensureDaemon(pkgRoot, port))) return null;
  let failedUntil = 0;
  let local = null;
  return {
    // 与本地 transformers 后端保持相同 ID，切换守护进程不会导致无意义的全量重嵌。
    id: `transformers:${model}`,
    daemon: true,
    async embed(texts) {
      if (Date.now() >= failedUntil) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, texts }),
            signal: AbortSignal.timeout(120000)
          });
          if (!res.ok) throw new Error(`global embedding daemon failed: ${res.status}`);
          const body = await res.json();
          if (!Array.isArray(body.vectors)) throw new Error(body.error || 'invalid daemon response');
          return body.vectors.map((v) => Float32Array.from(v));
        } catch {
          failedUntil = Date.now() + 60 * 1000;
        }
      }
      // 推理中的崩溃同样 fail-open：本进程加载同一模型，ID 不变，索引无需重建。
      local ||= getEmbedder(model);
      return (await local).embed(texts);
    }
  };
}

export async function daemonStatus(port = Number(process.env.TOKEN_SAVER_DAEMON_PORT) || 4518) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return res.ok ? await res.json() : { ok: false };
  } catch {
    return { ok: false };
  }
}
