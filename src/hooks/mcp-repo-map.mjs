#!/usr/bin/env node
// token-saver 的 MCP repo map 服务器（零依赖，stdio + 换行分隔 JSON-RPC 2.0）。
// 提供统一无损上下文工具 + 五个兼容工具：
//   context_query   三路检索、map/outline/read、Git diff、LSP、调用关系
//   context_expand  按证据 ID 无损展开
//   context_checkpoint 持久任务检查点
//   test_select     Git 改动驱动的测试选择（最终阶段全量回退）
//   repo_map        整个仓库的符号地图（import 图 PageRank 排序，重要文件更详细）
//   file_outline    单个文件的符号大纲 + 行号（配合区间读取）
//   smart_search    精确紧凑搜索（优先 ripgrep），只返回 path:line: 单行
//   semantic_search 概念级搜索：本地神经嵌入 + BM25 混合（索引未就绪时自动降级 BM25）
//   read_compact    压缩读取：去注释/空行/长字面量，保留原始行号
// 启动方式（.cursor/mcp.json）：node .cursor/hooks/token-saver/mcp-repo-map.mjs
// cwd 即项目根；也可用 --root <path> 显式指定。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractSymbols, EXT_LANG } from './symbols.mjs';
import { compactContent, extractImports, pageRank, buildDocIndex, bm25Search, bestLines } from './analyze.mjs';
import {
  loadBackend,
  loadIndex,
  saveIndex,
  buildIndex,
  searchIndex,
  collectSourceFiles,
  staleCount
} from './embed-index.mjs';
import { logEvent, estTokens, loadConfig } from './_lib.mjs';
import { createContextTools } from './context-query.mjs';
import { putArtifact, putSourceEvidence, sha256 } from './context-store.mjs';
import { selectTests } from './test-selector.mjs';
import { ensureAutoEvalBaseline, resumeAutoEval, scheduleAutoEval } from './auto-eval.mjs';

const SERVER_INFO = { name: 'token-saver-repo-map', version: '0.10.0' };

const rootArgIdx = process.argv.indexOf('--root');
const ROOT = path.resolve(rootArgIdx >= 0 ? process.argv[rootArgIdx + 1] : process.cwd());

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', '.venv', 'venv',
  '__pycache__', 'vendor', 'target', '.idea', '.vscode'
]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SOURCE_FILES = 800;
const MAX_WALK = 20000;
const DEFAULT_BUDGET = 12000;
const SYMBOLS_PER_FILE_IN_MAP = 30;

function insideRoot(file) {
  const abs = path.resolve(ROOT, file);
  return abs.startsWith(ROOT + path.sep) ? abs : null;
}

// ---------- 文件遍历与符号缓存 ----------

const symbolCache = new Map(); // absPath -> { mtimeMs, size, lines, symbols, imports, doc }

function listSourceFiles(baseDir) {
  const results = [];
  let visited = 0;
  const queue = [baseDir];
  while (queue.length > 0 && visited < MAX_WALK && results.length < MAX_SOURCE_FILES) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visited++ > MAX_WALK || results.length >= MAX_SOURCE_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (/\.min\.(js|css)$/.test(entry.name)) continue;
      if (EXT_LANG[path.extname(entry.name).toLowerCase()]) results.push(full);
    }
  }
  return results;
}

// 一次读取，同时计算符号、import 引用和 BM25 词频索引，按 mtime 缓存
function symbolsFor(absPath) {
  let st;
  try {
    st = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (st.size > MAX_FILE_BYTES) return { lines: -1, symbols: [], imports: [], doc: null, skipped: 'too large' };
  const cached = symbolCache.get(absPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  let content;
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const lang = EXT_LANG[path.extname(absPath).toLowerCase()];
  const result = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    ...extractSymbols(content, lang),
    imports: extractImports(absPath, content, lang, ROOT),
    doc: buildDocIndex(content)
  };
  symbolCache.set(absPath, result);
  return result;
}

// ---------- 工具实现 ----------

function toolRepoMap(args = {}) {
  const focus = typeof args.path === 'string' ? args.path.replace(/^\/+|\/+$/g, '') : '';
  const budget = Number.isFinite(Number(args.budget_chars))
    ? Math.max(2000, Number(args.budget_chars))
    : DEFAULT_BUDGET;
  const baseDir = focus ? insideRoot(focus) : ROOT;
  if (!baseDir) return `repo_map: path outside project: ${focus}`;
  if (!fs.existsSync(baseDir)) return `repo_map: path not found: ${focus}`;

  const files = listSourceFiles(baseDir);
  const infos = new Map();
  const graph = new Map();
  for (const file of files) {
    const info = symbolsFor(file);
    if (!info) continue;
    infos.set(file, info);
    graph.set(file, new Set(info.imports || []));
  }

  // 重要性排序：被引用越多的文件排越前，且分到更多符号行
  const ranks = pageRank([...infos.keys()], graph);
  const ordered = [...infos.keys()].sort((a, b) => (ranks.get(b) || 0) - (ranks.get(a) || 0));
  const topCut = Math.max(1, Math.ceil(ordered.length * 0.25));

  const blocks = [];
  for (let idx = 0; idx < ordered.length; idx++) {
    const file = ordered[idx];
    const info = infos.get(file);
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const star = idx < topCut && ordered.length > 4 ? ' ★' : '';
    const head = `${rel} [${info.lines}L]${star}`;
    if (info.symbols.length === 0) {
      blocks.push(head);
      continue;
    }
    const cap = idx < topCut ? SYMBOLS_PER_FILE_IN_MAP : 8;
    const shown = info.symbols.slice(0, cap);
    const lines = shown.map((s) => `  ${s.line} ${s.text}`);
    if (info.symbols.length > shown.length) {
      lines.push(`  … +${info.symbols.length - shown.length} more (use file_outline)`);
    }
    blocks.push([head, ...lines].join('\n'));
  }

  const header =
    `REPO MAP  root=${path.basename(ROOT)}${focus ? ` focus=${focus}` : ''}  ` +
    `(${files.length} source files, ordered by importance; ★ = most referenced)\n` +
    `Format: <path> [<total lines>L] / <line> <signature>. ` +
    `Next: file_outline for full outline, smart_search/semantic_search to locate code, read_compact to read cheaply.\n`;

  let out = header;
  let truncatedAt = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (out.length + blocks[i].length + 2 > budget) {
      truncatedAt = blocks.length - i;
      break;
    }
    out += '\n' + blocks[i];
  }
  if (truncatedAt > 0) {
    out += `\n\n…truncated (${truncatedAt} files omitted for budget). Call repo_map with {"path":"<subdir>"} or a larger budget_chars.`;
  }
  return out;
}

function toolFileOutline(args = {}) {
  if (typeof args.file !== 'string') return 'file_outline: "file" is required';
  const abs = insideRoot(args.file);
  if (!abs) return `file_outline: path outside project: ${args.file}`;
  if (!fs.existsSync(abs)) return `file_outline: file not found: ${args.file}`;
  const info = symbolsFor(abs);
  if (!info) return `file_outline: cannot read: ${args.file}`;
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (info.skipped) return `${rel}: skipped (${info.skipped})`;
  const lines = info.symbols.slice(0, 200).map((s) => `${s.line} ${s.text}`);
  return (
    `${rel} — ${info.lines} lines, ${info.symbols.length} symbols\n` +
    (lines.length ? lines.join('\n') : '(no symbols detected — likely config/data file)') +
    `\n\nRead only the ranges you need (offset/limit).`
  );
}

function toolReadCompact(args = {}) {
  if (typeof args.file !== 'string') return 'read_compact: "file" is required';
  const abs = insideRoot(args.file);
  if (!abs) return `read_compact: path outside project: ${args.file}`;
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return `read_compact: file not found: ${args.file}`;
  }
  if (st.size > MAX_FILE_BYTES) return `read_compact: file too large (${Math.round(st.size / 1024)} KB); use file_outline + ranged reads`;
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return `read_compact: cannot read: ${args.file}`;
  }
  const lang = EXT_LANG[path.extname(abs).toLowerCase()];
  const startLine = Number.isFinite(Number(args.start_line)) ? Math.max(1, Number(args.start_line)) : 1;
  const endLine = Number.isFinite(Number(args.end_line)) ? Number(args.end_line) : Infinity;
  const res = compactContent(content, lang, { startLine, endLine });
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const evidence = putSourceEvidence(ROOT, rel, {
    startLine,
    endLine: Number.isFinite(endLine) ? endLine : res.originalLines,
    kind: 'read-compact'
  });

  const savedBytes = Math.max(0, Buffer.byteLength(content) - Buffer.byteLength(res.text));
  try {
    logEvent(
      { hook: 'mcp-repo-map', action: 'read_compact', file: rel, savedBytes, savedTokens: estTokens(savedBytes) },
      ROOT
    );
  } catch {}

  return (
    `${rel} — compact view (${res.keptLines}/${res.originalLines} lines kept; comments/blanks/long literals stripped). ` +
    `Exact source: ${evidence?.id || 'unavailable'} (context_expand). ` +
    `Format: <original line number>|<code>. Use these line numbers for edits and ranged reads.\n\n` +
    (res.text || '(file is empty after compaction)')
  );
}

// ---------- 嵌入索引状态机（懒加载 + 后台建索引 + 增量刷新） ----------

const embed = { state: 'idle', backend: null, index: null, done: 0, total: 0, error: null, initPromise: null };

// 心跳状态文件：让面板能看到自动索引是否在运行、上次检查/重建时间
const STATUS_PATH = path.join(ROOT, '.cursor', 'token-saver', 'embed-status.json');
const embedStatus = {
  pid: process.pid,
  state: 'idle',
  model: null,
  lastCheck: null,
  lastBuild: null,
  embedded: 0,
  done: 0,
  total: 0,
  error: null,
  needsRestart: false,
  serverVersion: SERVER_INFO.version
};
function writeEmbedStatus(patch) {
  try {
    Object.assign(embedStatus, patch);
    fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
    fs.writeFileSync(STATUS_PATH, JSON.stringify(embedStatus));
  } catch {}
}

function readPkgRoot() {
  try {
    const { packageRoot } = JSON.parse(
      fs.readFileSync(path.join(ROOT, '.cursor', 'token-saver', 'pkg.json'), 'utf8')
    );
    return packageRoot;
  } catch {
    return null;
  }
}

function ensureEmbedInit() {
  if (embed.initPromise) return embed.initPromise;
  embed.initPromise = (async () => {
    try {
      const cfg = loadConfig(ROOT).embedding || {};
      const backend = await loadBackend(cfg, readPkgRoot());
      if (!backend) {
        embed.state = 'no-backend';
        writeEmbedStatus({ state: 'no-backend', lastCheck: new Date().toISOString() });
        return;
      }
      embed.backend = backend;
      embed.state = 'building';
      writeEmbedStatus({ state: 'building', model: backend.id });
      const prev = loadIndex(ROOT);
      const files = collectSourceFiles(ROOT);
      const embedded = prev && prev.model === backend.id ? staleCount(prev, files) : files.length;
      let lastProgressWrite = 0;
      const idx = await buildIndex(backend, files, prev, (d, t) => {
        embed.done = d;
        embed.total = t;
        // 长构建时每 2 秒把进度写进心跳，面板能显示"建索引中 N/M"
        if (Date.now() - lastProgressWrite > 2000) {
          lastProgressWrite = Date.now();
          writeEmbedStatus({ state: 'building', done: d, total: t });
        }
      });
      if (embedded > 0 || !prev) saveIndex(ROOT, idx);
      embed.index = embedded > 0 || !prev ? idx : prev;
      embed.state = 'ready';
      const now = new Date().toISOString();
      writeEmbedStatus({ state: 'ready', lastCheck: now, lastBuild: embedded > 0 ? now : embedStatus.lastBuild, embedded, done: 0, total: 0 });
      if (embedded > 0) {
        logEvent({ hook: 'mcp-repo-map', action: 'index_build', files: embedded }, ROOT);
        scheduleAutoEval(ROOT, { pkgRoot: readPkgRoot(), reason: `index build: ${embedded} files` });
      } else ensureAutoEvalBaseline(ROOT, readPkgRoot());
    } catch (e) {
      embed.state = 'error';
      embed.error = String(e?.message || e);
      writeEmbedStatus({ state: 'error', error: embed.error, lastCheck: new Date().toISOString() });
    }
  })();
  return embed.initPromise;
}

// 文件变化后的增量刷新：少量失效同步重嵌，大量失效转后台
async function refreshEmbedIndex() {
  const files = collectSourceFiles(ROOT);
  const stale = staleCount(embed.index, files);
  if (stale === 0) return '';
  const rebuild = async () => {
    const idx = await buildIndex(embed.backend, files, embed.index, null);
    saveIndex(ROOT, idx);
    embed.index = idx;
    scheduleAutoEval(ROOT, { pkgRoot: readPkgRoot(), reason: `on-demand refresh: ${stale} files` });
  };
  if (stale <= 20) {
    await rebuild();
    return '';
  }
  rebuild().catch(() => {});
  return ` (${stale} files re-indexing in background)`;
}

function bm25Results(query, topN) {
  const docs = new Map();
  for (const file of listSourceFiles(ROOT)) {
    const info = symbolsFor(file);
    if (info?.doc) docs.set(file, info.doc);
  }
  return bm25Search(query, docs, { topN }).map((h) => ({
    rel: path.relative(ROOT, h.file).split(path.sep).join('/'),
    range: null
  }));
}

async function toolSemanticSearch(args = {}) {
  if (typeof args.query !== 'string' || !args.query.trim()) return 'semantic_search: "query" is required';
  const query = args.query;
  const topN = Number.isFinite(Number(args.max_files)) ? Math.min(30, Math.max(1, Number(args.max_files))) : 8;

  // 首次调用触发后端加载与建索引；最多等 3 秒，没好就先用 BM25 顶上
  const init = ensureEmbedInit();
  await Promise.race([init, new Promise((r) => setTimeout(r, 3000))]);

  let note = '';
  let vecHits = [];
  if (embed.state === 'ready') {
    note = await refreshEmbedIndex();
    vecHits = await searchIndex(embed.backend, embed.index, query, topN * 2);
  } else if (embed.state === 'building') {
    note = ` (neural index building: ${embed.done}/${embed.total} files; BM25 results this time)`;
  } else if (embed.state === 'no-backend') {
    note = ' (BM25 only; neural embeddings unavailable — see README "语义搜索")';
  } else if (embed.state === 'error') {
    note = ` (BM25 only; embedding backend error: ${embed.error})`;
  }

  // RRF 融合：向量分块命中 + BM25 文件命中
  const K = 60;
  const merged = new Map(); // rel -> { score, range }
  vecHits.forEach((h, i) => {
    const cur = merged.get(h.rel) || { score: 0, range: null };
    cur.score += 1 / (K + i);
    if (!cur.range) cur.range = { start: h.start, end: h.end };
    merged.set(h.rel, cur);
  });
  bm25Results(query, topN).forEach((h, i) => {
    const cur = merged.get(h.rel) || { score: 0, range: null };
    cur.score += 1 / (K + i);
    merged.set(h.rel, cur);
  });

  const ranked = [...merged.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, topN);
  if (ranked.length === 0) {
    return `semantic_search: no matches for "${query}". Try different words or smart_search for exact strings.`;
  }

  const mode = embed.state === 'ready' ? 'hybrid: neural embeddings + BM25' : 'BM25';
  const out = [`Top ${ranked.length} results for "${query}" (${mode})${note}:`];
  for (const [rel, info] of ranked) {
    const loc = info.range ? `:${info.range.start}-${info.range.end}` : '';
    out.push(`\n${rel}${loc}`);
    let content;
    try {
      content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    if (info.range) {
      const sliceLines = content.split('\n').slice(info.range.start - 1, info.range.end);
      const hits = bestLines(sliceLines.join('\n'), query, 2);
      if (hits.length > 0) {
        for (const l of hits) out.push(`  ${info.range.start + l.line - 1}: ${l.text}`);
      } else {
        // 查询词不在代码里（如中文查询）：展示区间首个非空行作为预览
        const firstIdx = sliceLines.findIndex((l) => l.trim());
        if (firstIdx >= 0) out.push(`  ${info.range.start + firstIdx}: ${sliceLines[firstIdx].trim().slice(0, 160)}`);
      }
    } else {
      for (const l of bestLines(content, query, 2)) out.push(`  ${l.line}: ${l.text}`);
    }
  }
  return out.join('\n');
}

function ripgrepSearch(query, { regex, glob, maxResults }) {
  const rgArgs = ['--line-number', '--no-heading', '--color=never', '-S', '--max-columns', '200'];
  if (!regex) rgArgs.push('-F');
  if (glob) rgArgs.push('-g', glob);
  for (const d of SKIP_DIRS) rgArgs.push('-g', `!${d}`);
  rgArgs.push('--', query, '.');
  const res = spawnSync('rg', rgArgs, { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (res.error) return null; // rg 不存在
  if (res.status !== 0 && !res.stdout) return { lines: [] };
  const lines = res.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => (l.startsWith('./') ? l.slice(2) : l))
    .slice(0, maxResults);
  return { lines };
}

function fallbackSearch(query, { regex, maxResults }) {
  let matcher;
  if (regex) {
    try {
      matcher = new RegExp(query, 'i');
    } catch {
      return [`smart_search: invalid regex: ${query}`];
    }
  }
  const needle = query.toLowerCase();
  const out = [];
  for (const file of listSourceFiles(ROOT)) {
    if (out.length >= maxResults) break;
    let content;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && out.length < maxResults; i++) {
      const hit = regex ? matcher.test(lines[i]) : lines[i].toLowerCase().includes(needle);
      if (hit) out.push(`${rel}:${i + 1}:${lines[i].trim().slice(0, 200)}`);
    }
  }
  return out;
}

function toolSmartSearch(args = {}) {
  if (typeof args.query !== 'string' || !args.query.trim()) return 'smart_search: "query" is required';
  const opts = {
    regex: args.regex === true,
    glob: typeof args.glob === 'string' ? args.glob : null,
    maxResults: Number.isFinite(Number(args.max_results))
      ? Math.min(200, Math.max(1, Number(args.max_results)))
      : 50
  };
  const rg = ripgrepSearch(args.query, opts);
  const lines = rg ? rg.lines : fallbackSearch(args.query, opts);
  if (lines.length === 0) return `smart_search: no matches for "${args.query}"${opts.glob ? ` (glob ${opts.glob})` : ''}`;
  return (
    `${lines.length} matches for "${args.query}"${rg ? '' : ' (builtin scan; install ripgrep for better results)'}\n` +
    lines.join('\n')
  );
}

function exactResults(query, maxResults) {
  const found = ripgrepSearch(query, { regex: false, glob: null, maxResults });
  const lines = found ? found.lines : fallbackSearch(query, { regex: false, maxResults });
  return lines
    .map((line) => {
      const m = line.match(/^(.*?):(\d+):(.*)$/);
      return m ? { rel: m[1], line: Number(m[2]), text: m[3] } : null;
    })
    .filter(Boolean);
}

async function vectorResults(query, topN) {
  const init = ensureEmbedInit();
  await Promise.race([init, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (embed.state !== 'ready') return [];
  await refreshEmbedIndex();
  return searchIndex(embed.backend, embed.index, query, topN);
}

const contextTools = createContextTools(ROOT, {
  listFiles: () => listSourceFiles(ROOT),
  symbolsFor,
  exactSearch: exactResults,
  bm25Search: bm25Results,
  vectorSearch: vectorResults,
  repoMap: toolRepoMap
});
const toolTestSelect = (args = {}) =>
  selectTests(ROOT, args, { listFiles: () => listSourceFiles(ROOT), symbolsFor });

// ---------- MCP 协议层 ----------

// 工具定义会附在每一次 LLM 请求里：描述保持最短可用，legacy 工具默认不进 tools/list
// （tools/call 永远接受，能力不减；配置 contextQuery.legacyTools=true 恢复展示）。
const TOOLS = [
  {
    name: 'context_query',
    description:
      'Primary lossless code/context tool. mode: search=hybrid exact+BM25+neural (previews+evidence IDs) | map | outline | callgraph | read (compact range; symbol=X gives that symbol full + file skeleton) | profile (JSON/CSV/YAML schema) | diff (git hunks) | lsp (refs/defs, auto-fallback) | bootstrap (resume prior task) | memory (recall facts) | world (entity/infra relation graph).',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['search', 'map', 'outline', 'callgraph', 'read', 'profile', 'diff', 'lsp', 'bootstrap', 'memory', 'world'] },
        query: { type: 'string' },
        file: { type: 'string' },
        path: { type: 'string' },
        direction: { type: 'string', enum: ['both', 'callers', 'callees', 'importers', 'dependencies'] },
        depth: { type: 'number' },
        start_line: { type: 'number' },
        end_line: { type: 'number' },
        max_results: { type: 'number' },
        max_files: { type: 'number' },
        base: { type: 'string' },
        action: { type: 'string', enum: ['references', 'definition'] },
        symbol: { type: 'string' },
        line: { type: 'number' },
        column: { type: 'number' },
        timeout_ms: { type: 'number' },
        budget_chars: { type: 'number' },
        conversation_id: { type: 'string' }
      }
    },
    handler: contextTools.query
  },
  {
    name: 'context_expand',
    description: 'Expand an evidence/artifact ID losslessly: level preview|compact|exact|full, or a regex/line-range window.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        level: { type: 'string', enum: ['preview', 'symbol', 'compact', 'exact', 'full'] },
        start_line: { type: 'number' },
        end_line: { type: 'number' },
        regex: { type: 'string' },
        radius: { type: 'number' },
        conversation_id: { type: 'string' }
      },
      required: ['id']
    },
    handler: contextTools.expand
  },
  {
    name: 'context_checkpoint',
    description: 'Get/save a persistent task checkpoint (goal, status, files, decisions, open questions) for compaction or a new session.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'save'] },
        conversation_id: { type: 'string' },
        goal: { type: 'string' },
        status: { type: 'string' },
        files_touched: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'string' } },
        open_questions: { type: 'array', items: { type: 'string' } }
      }
    },
    handler: contextTools.checkpoint
  },
  {
    name: 'memory_save',
    description:
      'Save a durable project memory (convention/decision/gotcha/entrypoint) with optional linked files for staleness checks; triple {s,r,o} saves an entity relation (world model), steps[] saves a skill runbook; action=confirm/forget by id, action=merge with ids[]+text consolidates entries, scope=global for cross-project facts. Recall via context_query mode=memory/world or bootstrap.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'confirm', 'forget', 'merge'] },
        text: { type: 'string' },
        kind: { type: 'string', enum: ['convention', 'decision', 'gotcha', 'entrypoint', 'fact', 'relation', 'skill'] },
        files: { type: 'array', items: { type: 'string' } },
        triple: {
          type: 'object',
          properties: { s: { type: 'string' }, r: { type: 'string' }, o: { type: 'string' } }
        },
        steps: { type: 'array', items: { type: 'string' } },
        id: { type: 'string' },
        ids: { type: 'array', items: { type: 'string' } },
        scope: { type: 'string', enum: ['project', 'global'] },
        conversation_id: { type: 'string' }
      }
    },
    handler: (args) => contextTools.memorySave(args)
  },
  {
    name: 'test_select',
    description: 'Pick tests relevant to git changes. phase=iterate may narrow with a full-suite fallback; phase=final always returns the full suite.',
    inputSchema: {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: ['iterate', 'final'] },
        base: { type: 'string' }
      }
    },
    handler: toolTestSelect
  },
  {
    name: 'repo_map',
    legacy: true,
    description: 'Legacy alias of context_query mode=map: importance-ranked repo symbol map.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, budget_chars: { type: 'number' } }
    },
    handler: toolRepoMap
  },
  {
    name: 'file_outline',
    legacy: true,
    description: 'Legacy alias of context_query mode=outline: one-file symbol outline with line numbers.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' } },
      required: ['file']
    },
    handler: toolFileOutline
  },
  {
    name: 'smart_search',
    legacy: true,
    description: 'Legacy exact string/regex search returning path:line hits (context_query mode=search covers this).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        regex: { type: 'boolean' },
        glob: { type: 'string' },
        max_results: { type: 'number' }
      },
      required: ['query']
    },
    handler: toolSmartSearch
  },
  {
    name: 'semantic_search',
    legacy: true,
    description: 'Legacy concept search via local embeddings + BM25 (context_query mode=search covers this).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, max_files: { type: 'number' } },
      required: ['query']
    },
    handler: toolSemanticSearch
  },
  {
    name: 'read_compact',
    legacy: true,
    description: 'Legacy compact file read, original line numbers kept (context_query mode=read covers this).',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        start_line: { type: 'number' },
        end_line: { type: 'number' }
      },
      required: ['file']
    },
    handler: toolReadCompact
  }
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ---------- 只读工具结果去重（unchanged-since-last-call） ----------
// 相同参数的只读工具在短窗口内产出逐字节相同的结果时，只回一行标记 + artifact ID。
// 显式恢复类工具永不去重；artifact ID 保证任何会话都能无损回取完整结果。
const DEDUP_EXEMPT = new Set(['context_expand', 'context_checkpoint', 'memory_save']);
const DEDUP_MIN_BYTES = 500;
const lastToolResults = new Map(); // key -> { hash, at, preview }

function dedupeKey(name, args = {}) {
  const rest = { ...args };
  delete rest.conversation_id;
  return `${name}:${JSON.stringify(rest)}`;
}

function maybeDedupe(name, args, text) {
  try {
    const windowMs = loadConfig(ROOT).contextQuery.toolDedupeMs;
    if (!windowMs || windowMs <= 0 || DEDUP_EXEMPT.has(name)) return null;
    if (typeof text !== 'string' || Buffer.byteLength(text) < DEDUP_MIN_BYTES) return null;
    const key = dedupeKey(name, args);
    const hash = sha256(text);
    const prev = lastToolResults.get(key);
    lastToolResults.set(key, { hash, at: Date.now() });
    if (lastToolResults.size > 500) {
      lastToolResults.delete(lastToolResults.keys().next().value);
    }
    if (!prev || prev.hash !== hash || Date.now() - prev.at > windowMs) return null;
    const artifact = putArtifact(ROOT, text, { kind: 'tool-result', meta: { tool: name } });
    if (!artifact) return null;
    const firstLine = text.split('\n').find((l) => l.trim())?.slice(0, 80) || '';
    const short =
      `[token-saver] ${name} result byte-identical to your call ${Math.round((Date.now() - prev.at) / 1000)}s ago ` +
      `(begins: "${firstLine}"). Full: context_expand {id:"${artifact.id}",level:"full"}.`;
    const savedBytes = Math.max(0, Buffer.byteLength(text) - Buffer.byteLength(short));
    logEvent(
      { hook: 'mcp-repo-map', action: 'tool_dedup', tool: name, savedBytes, savedTokens: estTokens(savedBytes) },
      ROOT
    );
    return short;
  } catch {
    return null;
  }
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO
          }
        });
      case 'ping':
        return isRequest && send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list': {
        // legacy 工具默认不展示（省每次请求的定义 token），tools/call 仍然接受
        const showLegacy = loadConfig(ROOT).contextQuery.legacyTools === true;
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS.filter((t) => showLegacy || !t.legacy).map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema
            }))
          }
        });
      }
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) {
          return send({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: `unknown tool: ${params?.name}` }], isError: true }
          });
        }
        let text = await tool.handler(params?.arguments || {});
        const deduped = maybeDedupe(tool.name, params?.arguments, text);
        if (deduped != null) text = deduped;
        // 这些工具在内部记录更精确的节省/去重/展开字段，这里不重复
        if (!['read_compact', 'context_query', 'context_expand'].includes(tool.name)) {
          try {
            logEvent(
              { hook: 'mcp-repo-map', action: tool.name, bytes: text.length, args: JSON.stringify(params?.arguments || {}).slice(0, 120) },
              ROOT
            );
          } catch {}
        }
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
      }
      case 'resources/list':
        return isRequest && send({ jsonrpc: '2.0', id, result: { resources: [] } });
      case 'prompts/list':
        return isRequest && send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      default:
        // 通知（无 id）静默忽略；未知请求返回标准错误
        if (isRequest) {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
        }
    }
  } catch (e) {
    if (isRequest) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message || e) } });
    }
  }
}

// ---------- 自动建索引 / 定时增量刷新 ----------
// 服务器是常驻进程：启动后自动建嵌入索引，之后定时做廉价的过期检查（只 stat），
// 有文件变化才重嵌变化的部分。配置 embedding.autoIndex = false 可关闭。
const AUTO_DELAY_MS = Number(process.env.TOKEN_SAVER_AUTO_DELAY_MS) || 45 * 1000;
const AUTO_INTERVAL_MS = Number(process.env.TOKEN_SAVER_AUTO_INTERVAL_MS) || 5 * 60 * 1000;
resumeAutoEval(ROOT, readPkgRoot());

async function autoIndexTick() {
  try {
    const cfgE = loadConfig(ROOT).embedding || {};
    if (cfgE.autoIndex === false) {
      writeEmbedStatus({ state: 'disabled', lastCheck: new Date().toISOString() });
      return;
    }
    if (embed.state === 'idle') {
      await ensureEmbedInit(); // 首次：加载后端 + 全量建索引（增量复用已有缓存）
      return;
    }
    if (embed.state !== 'ready') return;
    const files = collectSourceFiles(ROOT);
    const stale = staleCount(embed.index, files);
    if (stale === 0) {
      writeEmbedStatus({ lastCheck: new Date().toISOString() });
      return;
    }
    const idx = await buildIndex(embed.backend, files, embed.index, null);
    saveIndex(ROOT, idx);
    embed.index = idx;
    const now = new Date().toISOString();
    writeEmbedStatus({ lastCheck: now, lastBuild: now, embedded: stale });
    logEvent({ hook: 'mcp-repo-map', action: 'index_refresh', files: stale }, ROOT);
    scheduleAutoEval(ROOT, { pkgRoot: readPkgRoot(), reason: `automatic refresh: ${stale} files` });
  } catch {}
}

const autoTimer = setTimeout(() => {
  autoIndexTick();
  setInterval(autoIndexTick, AUTO_INTERVAL_MS).unref();
}, AUTO_DELAY_MS);
autoTimer.unref(); // 不阻止进程随 stdin 关闭退出

let buffer = '';
let inFlight = 0;
let stdinEnded = false;

// stdin 关闭后等在途请求完成、stdout 刷完再退出（否则异步工具的响应会被丢掉）
function maybeExit() {
  if (stdinEnded && inFlight === 0) {
    process.stdout.write('', () => process.exit(0));
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    inFlight++;
    handleMessage(msg)
      .catch(() => {})
      .finally(() => {
        inFlight--;
        maybeExit();
      });
  }
});
process.stdin.on('end', () => {
  stdinEnded = true;
  maybeExit();
});
