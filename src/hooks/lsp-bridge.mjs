// 按需 LSP 桥：只在显式查询时启动已安装的 language server。
// 任何缺失、超时或协议错误都会熔断并返回 unavailable，调用方回退文本/import 图。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SPECS = {
  '.js': ['typescript-language-server', ['--stdio'], 'javascript'],
  '.jsx': ['typescript-language-server', ['--stdio'], 'javascriptreact'],
  '.ts': ['typescript-language-server', ['--stdio'], 'typescript'],
  '.tsx': ['typescript-language-server', ['--stdio'], 'typescriptreact'],
  '.py': ['pyright-langserver', ['--stdio'], 'python'],
  '.rs': ['rust-analyzer', [], 'rust'],
  '.go': ['gopls', ['serve'], 'go']
};

const clients = new Map();
const failedUntil = new Map();

function onPath(command) {
  const res = spawnSync('which', [command], { encoding: 'utf8', timeout: 500 });
  return res.status === 0;
}

class LspClient {
  constructor(root, command, args) {
    this.root = root;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.child = spawn(command, args, { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('language server exited'));
      this.pending.clear();
    });
    process.once('exit', () => {
      try {
        this.child.kill();
      } catch {}
    });
  }

  send(message) {
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(m[1]);
      if (this.buffer.length < headerEnd + 4 + length) return;
      const raw = this.buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      this.buffer = this.buffer.slice(headerEnd + 4 + length);
      try {
        const msg = JSON.parse(raw);
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
        } else if (msg.id != null && msg.method) {
          const result =
            msg.method === 'workspace/configuration'
              ? (msg.params?.items || []).map(() => null)
              : msg.method === 'workspace/workspaceFolders'
                ? [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }]
                : null;
          this.send({ jsonrpc: '2.0', id: msg.id, result });
        }
      } catch {}
    }
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }
}

async function getClient(root, spec, timeoutMs) {
  const [command, args] = spec;
  if ((failedUntil.get(command) || 0) > Date.now()) return null;
  if (!onPath(command)) {
    failedUntil.set(command, Date.now() + 5 * 60 * 1000);
    return null;
  }
  const key = `${root}:${command}`;
  if (clients.has(key)) return clients.get(key);
  let client = null;
  try {
    client = new LspClient(root, command, args);
    await client.request(
      'initialize',
      {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(root).href, name: path.basename(root) }]
      },
      timeoutMs
    );
    client.notify('initialized', {});
    clients.set(key, client);
    return client;
  } catch {
    try {
      client?.child.kill();
    } catch {}
    failedUntil.set(command, Date.now() + 60 * 1000);
    return null;
  }
}

function positionFor(file, args) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  if (Number.isFinite(Number(args.line))) {
    return { line: Math.max(0, Number(args.line) - 1), character: Math.max(0, Number(args.column || 1) - 1) };
  }
  const symbol = String(args.symbol || '').trim();
  if (!symbol) return { line: 0, character: 0 };
  for (let i = 0; i < lines.length; i++) {
    const col = lines[i].indexOf(symbol);
    if (col >= 0) return { line: i, character: col };
  }
  return { line: 0, character: 0 };
}

function normalizeLocations(root, result) {
  const values = Array.isArray(result) ? result : result ? [result] : [];
  return values
    .map((loc) => {
      const uri = loc.uri || loc.targetUri;
      const range = loc.range || loc.targetSelectionRange || loc.targetRange;
      if (!uri || !range) return null;
      let file;
      try {
        file = fileURLToPath(uri);
      } catch {
        return null;
      }
      const rel = path.relative(root, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
      return {
        rel: rel.split(path.sep).join('/'),
        line: range.start.line + 1,
        column: range.start.character + 1,
        endLine: range.end.line + 1
      };
    })
    .filter(Boolean);
}

export async function lspQuery(root, args = {}) {
  const file = path.resolve(root, args.file || '');
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
    return { available: false, reason: 'file not found or outside project', locations: [] };
  }
  const spec = SPECS[path.extname(file).toLowerCase()];
  if (!spec) return { available: false, reason: 'no configured language server for this file type', locations: [] };
  const timeoutMs = Math.min(5000, Math.max(300, Number(args.timeout_ms) || 1500));
  const client = await getClient(root, spec, timeoutMs);
  if (!client) return { available: false, reason: `${spec[0]} unavailable or circuit open`, locations: [] };
  const uri = pathToFileURL(file).href;
  const text = fs.readFileSync(file, 'utf8');
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: spec[2], version: 1, text }
  });
  const position = positionFor(file, args);
  try {
    const method = args.action === 'definition' ? 'textDocument/definition' : 'textDocument/references';
    const params = { textDocument: { uri }, position };
    if (method.endsWith('/references')) params.context = { includeDeclaration: true };
    const result = await client.request(method, params, timeoutMs);
    return { available: true, server: spec[0], method, locations: normalizeLocations(root, result) };
  } catch (e) {
    clients.delete(`${root}:${spec[0]}`);
    try {
      client.child.kill();
    } catch {}
    failedUntil.set(spec[0], Date.now() + 60 * 1000);
    return { available: false, reason: String(e?.message || e), locations: [] };
  }
}
