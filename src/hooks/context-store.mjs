// 内容寻址证据仓（零依赖）：
// - 源码只存路径/区间/哈希引用，展开时从工作树精确读取，避免复制整仓库
// - 命令/MCP 原始输出存 blobs，紧凑结果始终可按 ID 无损回取
// - manifest 原子写；损坏、过期、越界均 fail-open 为可诊断结果
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, loadState, saveState } from './_lib.mjs';

export const CONTEXT_STORE_SCHEMA = 1;

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function contextStoreDir(root) {
  return path.join(dataDir(root), 'context-store');
}

function manifestPath(root) {
  return path.join(contextStoreDir(root), 'manifest.json');
}

function emptyManifest() {
  return { schemaVersion: CONTEXT_STORE_SCHEMA, updatedAt: null, entries: {} };
}

export function loadManifest(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(root), 'utf8'));
    if (parsed?.schemaVersion === CONTEXT_STORE_SCHEMA && parsed.entries) return parsed;
  } catch {}
  return emptyManifest();
}

function saveManifest(root, manifest, { replace = false } = {}) {
  const dir = contextStoreDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const target = manifestPath(root);
  const lock = `${target}.lock`;
  let fd;
  const deadline = Date.now() + 2000;
  while (fd == null && Date.now() < deadline) {
    try {
      fd = fs.openSync(lock, 'wx');
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock);
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (fd == null) return;
  try {
    if (!replace) {
      try {
        const latest = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (latest?.schemaVersion === CONTEXT_STORE_SCHEMA && latest.entries) {
          manifest.entries = { ...latest.entries, ...manifest.entries };
        }
      } catch {}
    }
    manifest.updatedAt = new Date().toISOString();
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(manifest));
    fs.renameSync(tmp, target);
  } finally {
    try {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    } catch {}
  }
}

function relInside(root, file) {
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return { abs, rel: rel.split(path.sep).join('/') };
}

function sourceSlice(content, startLine = 1, endLine = Infinity) {
  const lines = content.split('\n');
  const start = Math.max(1, Math.floor(Number(startLine) || 1));
  const end = Math.min(lines.length, Number.isFinite(Number(endLine)) ? Math.floor(Number(endLine)) : lines.length);
  return { text: lines.slice(start - 1, Math.max(start - 1, end)).join('\n'), start, end, totalLines: lines.length };
}

export function putSourceEvidence(root, file, options = {}) {
  try {
    const safe = relInside(root, file);
    if (!safe) return null;
    const st = fs.statSync(safe.abs);
    if (!st.isFile()) return null;
    const content = fs.readFileSync(safe.abs, 'utf8');
    const slice = sourceSlice(content, options.startLine, options.endLine);
    const contentHash = sha256(slice.text);
    // 12 位 hex（48bit）：ID 在工具输出里高频出现，短一点每次都省；碰撞概率可忽略
    const id = `src_${sha256(`${safe.rel}:${slice.start}:${slice.end}:${contentHash}`).slice(0, 12)}`;
    const manifest = loadManifest(root);
    manifest.entries[id] = {
      id,
      kind: options.kind || 'source',
      rel: safe.rel,
      startLine: slice.start,
      endLine: slice.end,
      totalLines: slice.totalLines,
      stamp: `${st.mtimeMs}:${st.size}`,
      contentHash,
      bytes: Buffer.byteLength(slice.text),
      createdAt: manifest.entries[id]?.createdAt || new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      meta: options.meta || {}
    };
    saveManifest(root, manifest);
    return manifest.entries[id];
  } catch {
    return null;
  }
}

export function putArtifact(root, text, options = {}) {
  try {
    const raw = String(text ?? '');
    const contentHash = sha256(raw);
    const id = `art_${contentHash.slice(0, 12)}`;
    const dir = path.join(contextStoreDir(root), 'blobs');
    fs.mkdirSync(dir, { recursive: true });
    const blob = path.join(dir, `${contentHash}.txt`);
    if (!fs.existsSync(blob)) fs.writeFileSync(blob, raw);
    const manifest = loadManifest(root);
    manifest.entries[id] = {
      id,
      kind: options.kind || 'artifact',
      contentHash,
      blob: path.relative(contextStoreDir(root), blob).split(path.sep).join('/'),
      bytes: Buffer.byteLength(raw),
      lines: raw ? raw.split('\n').length : 0,
      createdAt: manifest.entries[id]?.createdAt || new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      meta: options.meta || {}
    };
    saveManifest(root, manifest);
    return manifest.entries[id];
  } catch {
    return null;
  }
}

function lineWindow(text, options = {}) {
  const lines = text.split('\n');
  if (typeof options.regex === 'string' && options.regex) {
    let re;
    try {
      re = new RegExp(options.regex, 'i');
    } catch {
      return { error: `invalid regex: ${options.regex}` };
    }
    const radius = Math.min(50, Math.max(0, Number(options.radius) || 3));
    const hits = [];
    for (let i = 0; i < lines.length && hits.length < 20; i++) {
      if (re.test(lines[i])) hits.push({ line: i + 1, text: lines.slice(Math.max(0, i - radius), i + radius + 1).join('\n') });
    }
    return { text: hits.map((h) => `--- around line ${h.line} ---\n${h.text}`).join('\n'), hits: hits.length };
  }
  const start = Math.max(1, Number(options.startLine) || 1);
  const end = Math.min(lines.length, Number(options.endLine) || lines.length);
  return { text: lines.slice(start - 1, end).join('\n'), startLine: start, endLine: end };
}

export function getEvidence(root, id, options = {}) {
  try {
    const manifest = loadManifest(root);
    const entry = manifest.entries[id];
    if (!entry) return { error: `unknown evidence id: ${id}` };
    entry.accessedAt = new Date().toISOString();
    saveManifest(root, manifest);
    if (entry.rel) {
      const safe = relInside(root, entry.rel);
      if (!safe) return { error: 'evidence path escaped project root' };
      const st = fs.statSync(safe.abs);
      const currentStamp = `${st.mtimeMs}:${st.size}`;
      const content = fs.readFileSync(safe.abs, 'utf8');
      const current = sourceSlice(content, entry.startLine, entry.endLine);
      const currentHash = sha256(current.text);
      if (currentStamp !== entry.stamp || currentHash !== entry.contentHash) {
        return { stale: true, entry, error: 'source changed since this evidence was created' };
      }
      if (options.level === 'full') return { entry, text: content, exact: true };
      const sourceOptions = { ...options };
      if (options.startLine != null) sourceOptions.startLine = Math.max(1, Number(options.startLine) - entry.startLine + 1);
      if (options.endLine != null) sourceOptions.endLine = Math.max(1, Number(options.endLine) - entry.startLine + 1);
      const selected = lineWindow(current.text, sourceOptions);
      return { entry, ...selected, exact: true };
    }
    const base = contextStoreDir(root);
    const blob = path.resolve(base, entry.blob || '');
    if (!blob.startsWith(base + path.sep)) return { error: 'artifact path escaped context store' };
    const raw = fs.readFileSync(blob, 'utf8');
    return { entry, ...lineWindow(raw, options), exact: true };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

// 同一会话已传输的哈希不重复发送；exact/full 显式展开不受此限制。
export function markDelivered(root, conversationId, contentHash, bytes = 0) {
  if (!conversationId || !contentHash) return { duplicate: false };
  const state = loadState(conversationId, root);
  state.delivered = state.delivered || {};
  state.budget = state.budget || { usedTokens: 0, byKind: {} };
  const duplicate = Boolean(state.delivered[contentHash]);
  state.delivered[contentHash] = { at: Date.now(), bytes };
  if (!duplicate) {
    const tokens = Math.max(0, Math.round(bytes / 4));
    state.budget.usedTokens = (state.budget.usedTokens || 0) + tokens;
    state.budget.byKind.context = (state.budget.byKind.context || 0) + tokens;
  }
  saveState(conversationId, state, root);
  return { duplicate, usedTokens: state.budget.usedTokens || 0 };
}

export function storeStats(root) {
  const manifest = loadManifest(root);
  const entries = Object.values(manifest.entries);
  return {
    schemaVersion: manifest.schemaVersion,
    entries: entries.length,
    sourceEntries: entries.filter((e) => e.rel).length,
    artifacts: entries.filter((e) => e.blob).length,
    bytes: entries.reduce((n, e) => n + (e.bytes || 0), 0),
    updatedAt: manifest.updatedAt
  };
}

export function gcContextStore(root, options = {}) {
  try {
    const maxAgeMs = Math.max(60_000, Number(options.ttlMs) || 7 * 24 * 60 * 60 * 1000);
    const maxBytes = Math.max(1024 * 1024, Number(options.maxBytes) || 512 * 1024 * 1024);
    const cutoff = Date.now() - maxAgeMs;
    const manifest = loadManifest(root);
    const entries = Object.values(manifest.entries).sort(
      (a, b) => Date.parse(a.accessedAt || a.createdAt || 0) - Date.parse(b.accessedAt || b.createdAt || 0)
    );
    let bytes = entries.reduce((n, e) => n + (e.bytes || 0), 0);
    let removed = 0;
    for (const entry of entries) {
      const old = Date.parse(entry.accessedAt || entry.createdAt || 0) < cutoff;
      if (!old && bytes <= maxBytes) continue;
      delete manifest.entries[entry.id];
      bytes -= entry.bytes || 0;
      removed++;
    }
    const liveBlobs = new Set(Object.values(manifest.entries).map((e) => e.blob).filter(Boolean));
    const blobDir = path.join(contextStoreDir(root), 'blobs');
    try {
      for (const name of fs.readdirSync(blobDir)) {
        const rel = `blobs/${name}`;
        if (!liveBlobs.has(rel)) fs.unlinkSync(path.join(blobDir, name));
      }
    } catch {}
    if (removed) saveManifest(root, manifest, { replace: true });
    return { removed, bytes };
  } catch {
    return { removed: 0, bytes: 0 };
  }
}
