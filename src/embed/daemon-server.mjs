// 全局嵌入守护进程：所有项目共享一个 transformers 模型实例。
// 仅监听 127.0.0.1；项目索引仍各自落盘，保证隔离和可删除性。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { getEmbedder, DEFAULT_MODEL } from './embedder.mjs';
import { globalHome } from '../hooks/_lib.mjs';

const MAX_BODY = 8 * 1024 * 1024;

function statePath() {
  return path.join(globalHome(), 'daemon.json');
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY) throw new Error('request too large');
  }
  return JSON.parse(raw || '{}');
}

export function startDaemon(port = 4518, options = {}) {
  const backendFactory = options.getBackend || getEmbedder;
  const models = new Set();
  const projects = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return json(res, 200, { ok: true, pid: process.pid, models: [...models], projects: projects.size });
      }
      if (req.method === 'POST' && req.url === '/project') {
        const body = await readJson(req);
        if (typeof body.path === 'string') projects.set(body.path, { seenAt: new Date().toISOString(), model: body.model });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/embed') {
        const body = await readJson(req);
        const texts = Array.isArray(body.texts) ? body.texts.map(String).slice(0, 64) : [];
        if (!texts.length) return json(res, 400, { error: 'texts is required' });
        const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL;
        const backend = await backendFactory(model);
        models.add(model);
        const vectors = await backend.embed(texts);
        return json(res, 200, { id: backend.id, vectors: vectors.map((v) => Array.from(v)) });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const actual = server.address().port;
    fs.mkdirSync(globalHome(), { recursive: true });
    fs.writeFileSync(
      statePath(),
      JSON.stringify({ pid: process.pid, port: actual, startedAt: new Date().toISOString() }, null, 2)
    );
    console.log(`cursor-token-saver 全局索引服务: http://127.0.0.1:${actual}`);
  });
  server.on('close', () => {
    try {
      const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
      if (state.pid === process.pid) fs.unlinkSync(statePath());
    } catch {}
  });
  return server;
}
