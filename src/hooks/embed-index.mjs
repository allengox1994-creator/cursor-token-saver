// 嵌入索引（零依赖，随 hooks 复制进项目）：
//   - 后端加载：transformers.js（经 init 记录的包路径动态 import）→ Ollama → 无（调用方降级 BM25）
//   - 按符号边界分块，Int8 量化后存 .cursor/token-saver/embed-index.json
//   - 按 mtime+size 增量更新，只重嵌变化的文件
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractSymbols, EXT_LANG } from './symbols.mjs';
import { tokenize } from './analyze.mjs';
import { sha256 } from './context-store.mjs';

export const EMBED_INDEX_SCHEMA = 2;
export const CHUNK_MAX_LINES = 60;
export const CHUNK_TEXT_CAP = 1500;
const CHUNKS_PER_FILE = 20;
const OLLAMA_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';

// ---------- 后端 ----------

// 测试用：确定性伪嵌入（标识符拆分后词袋哈希到 64 维），让相似文本有更高余弦
function fakeEmbedder() {
  const embed1 = (text) => {
    const v = new Float32Array(64);
    for (const w of tokenize(text)) {
      let h = 0;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      v[h % 64] += 1;
    }
    let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    for (let i = 0; i < 64; i++) v[i] /= norm;
    return v;
  };
  return { id: 'fake', embed: async (texts) => texts.map(embed1) };
}

async function ollamaEmbedder(model) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: 'ping' }),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`ollama /api/embed ${res.status}`);
  return {
    id: `ollama:${model}`,
    async embed(texts) {
      const r = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(120000)
      });
      if (!r.ok) throw new Error(`ollama embed failed: ${r.status}`);
      const data = await r.json();
      return data.embeddings.map((e) => {
        const v = Float32Array.from(e);
        let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        for (let i = 0; i < v.length; i++) v[i] /= norm;
        return v;
      });
    }
  };
}

// cfg: token-saver.json 里的 embedding 段 { backend, model, ollamaModel }
// pkgRoot: init 写入的安装包根路径（那里有 node_modules）
export async function loadBackend(cfg = {}, pkgRoot = null) {
  const mode = process.env.TOKEN_SAVER_EMBED_BACKEND || cfg.backend || 'auto';
  if (mode === 'off') return null;
  if (mode === 'fake') return fakeEmbedder();

  if ((mode === 'auto' || mode === 'transformers') && pkgRoot) {
    if (cfg.useGlobalDaemon !== false) {
      try {
        const client = await import(pathToFileURL(path.join(pkgRoot, 'src', 'embed', 'daemon-client.mjs')).href);
        const shared = await client.getDaemonEmbedder(cfg.model || undefined, pkgRoot, { port: cfg.daemonPort });
        if (shared) return shared;
      } catch {}
    }
    try {
      const mod = await import(pathToFileURL(path.join(pkgRoot, 'src', 'embed', 'embedder.mjs')).href);
      return await mod.getEmbedder(cfg.model || undefined);
    } catch (e) {
      if (mode === 'transformers') throw e;
    }
  }
  if (mode === 'auto' || mode === 'ollama') {
    try {
      return await ollamaEmbedder(cfg.ollamaModel || 'nomic-embed-text');
    } catch {
      if (mode === 'ollama') throw new Error('Ollama 不可用或缺少嵌入模型（ollama pull nomic-embed-text）');
    }
  }
  return null;
}

// ---------- 分块 ----------

// symbols: extractSymbols 的输出；返回 [{ start, end, text }]（行号 1-based，含 end）
export function chunkFile(relPath, content, symbols) {
  const lines = content.split('\n');
  const total = lines.length;
  const chunks = [];
  const starts = symbols.map((s) => s.line).filter((l, i, a) => i === 0 || l > a[i - 1]);

  const push = (start, end) => {
    end = Math.min(end, total, start + CHUNK_MAX_LINES - 1);
    if (end < start) return;
    const body = lines.slice(start - 1, end).join('\n').slice(0, CHUNK_TEXT_CAP);
    if (body.trim().length < 20) return;
    chunks.push({ start, end, text: `${relPath}\n${body}` });
  };

  if (starts.length === 0) {
    for (let s = 1; s <= total && chunks.length < CHUNKS_PER_FILE; s += CHUNK_MAX_LINES) {
      push(s, s + CHUNK_MAX_LINES - 1);
    }
    return chunks;
  }
  if (starts[0] > 4) push(1, starts[0] - 1); // 文件头（import 等）
  for (let i = 0; i < starts.length && chunks.length < CHUNKS_PER_FILE; i++) {
    const next = i + 1 < starts.length ? starts[i + 1] - 1 : total;
    push(starts[i], next);
  }
  return chunks;
}

// ---------- Int8 量化 ----------

export function quantize(vec) {
  let max = 1e-9;
  for (const x of vec) max = Math.max(max, Math.abs(x));
  const scale = max / 127;
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) q[i] = Math.round(vec[i] / scale);
  return { b64: Buffer.from(q.buffer).toString('base64'), scale };
}

export function dequantize(b64, scale) {
  const buf = Buffer.from(b64, 'base64');
  const q = new Int8Array(buf.buffer, buf.byteOffset, buf.length);
  const v = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) v[i] = q[i] * scale;
  return v;
}

function cosine(a, b) {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // 向量已归一化（量化误差可忽略），点积即余弦
}

// ---------- 索引 ----------

export function indexPath(root) {
  return path.join(root, '.cursor', 'token-saver', 'embed-index.json');
}

export function loadIndex(root) {
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath(root), 'utf8'));
    if (idx && idx.files) return { schemaVersion: idx.schemaVersion || 1, ...idx };
  } catch {}
  return null;
}

export function saveIndex(root, idx) {
  try {
    fs.mkdirSync(path.dirname(indexPath(root)), { recursive: true });
    fs.writeFileSync(indexPath(root), JSON.stringify(idx));
  } catch {}
}

export function fileStamp(st) {
  return `${st.mtimeMs}:${st.size}`;
}

// 收集可嵌入的源码文件（只 stat 不读内容；load() 按需惰性读取）
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', '.venv', 'venv',
  '__pycache__', 'vendor', 'target', '.idea', '.vscode'
]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 800;

export function collectSourceFiles(root) {
  const results = [];
  const queue = [root];
  let visited = 0;
  while (queue.length > 0 && results.length < MAX_FILES && visited < 20000) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visited++ > 20000 || results.length >= MAX_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(abs);
        continue;
      }
      if (!entry.isFile() || /\.min\.(js|css)$/.test(entry.name)) continue;
      const lang = EXT_LANG[path.extname(entry.name).toLowerCase()];
      if (!lang) continue;
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      results.push({
        rel,
        stamp: fileStamp(st),
        load() {
          const content = fs.readFileSync(abs, 'utf8');
          return { content, symbols: extractSymbols(content, lang).symbols };
        }
      });
    }
  }
  return results;
}

// 统计有多少文件的向量已失效（需要重嵌）
export function staleCount(idx, files) {
  if (!idx?.files) return files.length;
  let n = 0;
  for (const f of files) {
    const entry = idx.files[f.rel];
    if (!entry || entry.stamp !== f.stamp || !entry.contentHash || idx.schemaVersion !== EMBED_INDEX_SCHEMA) n++;
  }
  return n;
}

// 构建/增量更新索引。files 来自 collectSourceFiles；只有 stamp 变化的文件才会读内容并重嵌。
export async function buildIndex(backend, files, prevIndex, onProgress) {
  const idx = { schemaVersion: EMBED_INDEX_SCHEMA, model: backend.id, files: {} };
  const prev =
    prevIndex && prevIndex.model === backend.id && prevIndex.schemaVersion === EMBED_INDEX_SCHEMA
      ? prevIndex.files
      : {};
  let done = 0;

  for (const f of files) {
    if (prev[f.rel] && prev[f.rel].stamp === f.stamp) {
      idx.files[f.rel] = prev[f.rel]; // 未变化，直接复用
    } else {
      let loaded;
      try {
        loaded = f.load();
      } catch {
        done++;
        continue;
      }
      const chunks = chunkFile(f.rel, loaded.content, loaded.symbols);
      const entry = { stamp: f.stamp, contentHash: sha256(loaded.content), chunks: [] };
      for (let i = 0; i < chunks.length; i += 16) {
        const batch = chunks.slice(i, i + 16);
        const vecs = await backend.embed(batch.map((c) => c.text));
        for (let j = 0; j < batch.length; j++) {
          const { b64, scale } = quantize(vecs[j]);
          entry.chunks.push({ start: batch[j].start, end: batch[j].end, v: b64, s: scale });
        }
      }
      idx.files[f.rel] = entry;
    }
    done++;
    if (onProgress) onProgress(done, files.length);
  }
  return idx;
}

// 返回 [{ rel, start, end, score }] 降序；过滤接近零分的噪音块
const MIN_SCORE = 0.05;

export async function searchIndex(backend, idx, query, topK = 12) {
  const [qv] = await backend.embed([query]);
  const hits = [];
  for (const [rel, entry] of Object.entries(idx.files)) {
    for (const c of entry.chunks) {
      const score = cosine(qv, dequantize(c.v, c.s));
      if (score > MIN_SCORE) hits.push({ rel, start: c.start, end: c.end, score });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, topK);
}
