// 代码分析三件套（零依赖，供 mcp-repo-map.mjs 使用）：
//   1. compactContent  压缩读取：去注释/空行/折叠长字面量，保留原始行号
//   2. extractImports + pageRank  文件重要性：import 引用图 + PageRank
//   3. BM25 概念级搜索：标识符拆分（camelCase/snake_case）+ BM25 打分
import fs from 'node:fs';
import path from 'node:path';

// ---------- 1. 压缩读取 ----------

const C_LIKE = new Set(['js', 'ts', 'go', 'rs', 'java', 'kt', 'swift', 'cs', 'c', 'php']);
const HASH_STYLE = new Set(['py', 'rb', 'php']);
const MAX_LINE_LEN = 240;
const STR_COLLAPSE_AT = 80;
const STR_KEEP = 60;

// 返回 { text, originalLines, keptLines, removedLines }
export function compactContent(content, lang, { startLine = 1, endLine = Infinity } = {}) {
  const lines = content.split('\n');
  const out = [];
  let removed = 0;
  let inBlock = false; // /* ... */ 内
  let inDoc = false; // python 三引号块内
  const collapseRe = /(["'`])((?:\\.|(?!\1)[^\\\n]){80,})\1/g;

  for (let i = startLine - 1; i < Math.min(lines.length, endLine); i++) {
    const raw = lines[i];
    const t = raw.trim();

    if (inBlock) {
      removed++;
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (inDoc) {
      removed++;
      if (t.includes('"""') || t.includes("'''")) inDoc = false;
      continue;
    }
    if (!t) {
      removed++;
      continue;
    }
    if (C_LIKE.has(lang)) {
      if (t.startsWith('//') || t.startsWith('*') || t === '*/') {
        removed++;
        continue;
      }
      if (t.startsWith('/*')) {
        removed++;
        if (!t.includes('*/')) inBlock = true;
        continue;
      }
    }
    if (HASH_STYLE.has(lang) && t.startsWith('#') && !t.startsWith('#!')) {
      removed++;
      continue;
    }
    if (lang === 'py' && (t.startsWith('"""') || t.startsWith("'''"))) {
      removed++;
      // 单行 docstring（"""..."""）不进入块状态
      const q = t.slice(0, 3);
      if (!(t.length > 3 && t.endsWith(q))) inDoc = true;
      continue;
    }

    let line = raw.replace(collapseRe, (m, quote, body) => `${quote}${body.slice(0, STR_KEEP)}…${quote}`);
    if (line.length > MAX_LINE_LEN) line = line.slice(0, MAX_LINE_LEN) + '…';
    out.push(`${i + 1}|${line}`);
  }

  return {
    text: out.join('\n'),
    originalLines: lines.length,
    keptLines: out.length,
    removedLines: removed
  };
}

// ---------- 2. import 图 + PageRank ----------

const JS_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'];
const JS_IMPORT_RES = [
  /(?:^|\s)import\s+(?:[\w${},*\s]+\s+from\s+)?['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:^|\s)export\s+(?:[\w${},*\s]+\s+)?from\s+['"]([^'"]+)['"]/g
];

function resolveJsImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // 外部包不参与图
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, ...JS_EXTS.map((e) => base + e), ...JS_EXTS.map((e) => path.join(base, 'index' + e))];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

function resolvePyImport(root, fromFile, spec) {
  // from .a.b import x  /  import pkg.mod
  let base;
  if (spec.startsWith('.')) {
    const ups = spec.match(/^\.+/)[0].length;
    let dir = path.dirname(fromFile);
    for (let i = 1; i < ups; i++) dir = path.dirname(dir);
    const rest = spec.slice(ups);
    base = rest ? path.join(dir, ...rest.split('.')) : dir;
  } else {
    base = path.join(root, ...spec.split('.'));
  }
  for (const c of [base + '.py', path.join(base, '__init__.py')]) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

// 返回该文件引用到的本仓库文件绝对路径列表
export function extractImports(absPath, content, lang, root) {
  const targets = [];
  if (lang === 'js' || lang === 'ts') {
    for (const re of JS_IMPORT_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(content))) {
        const resolved = resolveJsImport(absPath, m[1]);
        if (resolved) targets.push(resolved);
      }
    }
  } else if (lang === 'py') {
    for (const line of content.split('\n')) {
      const mFrom = line.match(/^\s*from\s+([\w.]+)\s+import\b/);
      const mImp = line.match(/^\s*import\s+([\w.]+)/);
      const spec = mFrom ? mFrom[1] : mImp ? mImp[1] : null;
      if (!spec) continue;
      const resolved = resolvePyImport(root, absPath, spec);
      if (resolved) targets.push(resolved);
    }
  }
  return targets;
}

// graph: Map<file, Set<importedFile>>；返回 Map<file, rank>
export function pageRank(files, graph, { damping = 0.85, iterations = 20 } = {}) {
  const n = files.length;
  if (n === 0) return new Map();
  const rank = new Map(files.map((f) => [f, 1 / n]));
  const incoming = new Map(files.map((f) => [f, []]));
  const outDegree = new Map();
  for (const [from, tos] of graph) {
    const valid = [...tos].filter((t) => incoming.has(t) && t !== from);
    outDegree.set(from, valid.length);
    for (const to of valid) incoming.get(to).push(from);
  }
  for (let it = 0; it < iterations; it++) {
    const next = new Map();
    for (const f of files) {
      let sum = 0;
      for (const src of incoming.get(f)) sum += rank.get(src) / (outDegree.get(src) || 1);
      next.set(f, (1 - damping) / n + damping * sum);
    }
    for (const [f, v] of next) rank.set(f, v);
  }
  return rank;
}

export function reverseGraph(files, graph) {
  const reversed = new Map(files.map((f) => [f, new Set()]));
  for (const [from, tos] of graph) {
    for (const to of tos || []) {
      if (reversed.has(to)) reversed.get(to).add(from);
    }
  }
  return reversed;
}

// 循环安全的文件依赖遍历。正则 import 图是近似关系，调用方必须向用户标注。
export function traverseGraph(start, graph, { depth = 1, maxNodes = 50 } = {}) {
  const out = [];
  const seen = new Set([start]);
  const queue = [{ file: start, depth: 0 }];
  while (queue.length && out.length < maxNodes) {
    const cur = queue.shift();
    if (cur.depth >= depth) continue;
    for (const next of graph.get(cur.file) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      const item = { file: next, depth: cur.depth + 1 };
      out.push(item);
      queue.push(item);
      if (out.length >= maxNodes) break;
    }
  }
  return out;
}

// ---------- 3. BM25 概念级搜索 ----------

const STOPWORDS = new Set([
  'the', 'and', 'for', 'not', 'with', 'that', 'this', 'from', 'are', 'was',
  'function', 'const', 'let', 'var', 'return', 'import', 'export', 'class', 'def',
  'self', 'new', 'null', 'undefined', 'true', 'false', 'else', 'while', 'async',
  'await', 'public', 'private', 'static', 'void', 'int', 'string', 'require',
  'type', 'interface', 'extends', 'implements', 'try', 'catch', 'throw', 'use', 'pub', 'func', 'end'
]);

export function tokenize(text) {
  const out = [];
  for (const word of text.split(/[^A-Za-z0-9]+/)) {
    if (!word) continue;
    // camelCase / PascalCase / 数字边界拆分
    for (const part of word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').split(' ')) {
      const t = part.toLowerCase();
      if (t.length >= 2 && !STOPWORDS.has(t)) out.push(t);
    }
  }
  return out;
}

export function buildDocIndex(content) {
  const tf = new Map();
  const tokens = tokenize(content);
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return { tf, len: tokens.length };
}

// docs: Map<file, {tf, len}>；返回 [{file, score}] 降序
export function bm25Search(query, docs, { k1 = 1.2, b = 0.75, topN = 10 } = {}) {
  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0) return [];
  const N = docs.size;
  let avgLen = 0;
  for (const d of docs.values()) avgLen += d.len;
  avgLen = avgLen / (N || 1) || 1;

  const df = new Map();
  for (const t of qTokens) {
    let count = 0;
    for (const d of docs.values()) if (d.tf.has(t)) count++;
    df.set(t, count);
  }

  const scores = [];
  for (const [file, d] of docs) {
    let score = 0;
    for (const t of qTokens) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen));
    }
    if (score > 0) scores.push({ file, score });
  }
  return scores.sort((a, b2) => b2.score - a.score).slice(0, topN);
}

// 在单个文件里找与查询词最相关的行（供搜索结果定位行号）
export function bestLines(content, query, maxLines = 3) {
  const qTokens = [...new Set(tokenize(query))];
  const lines = content.split('\n');
  const scored = [];
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    let hits = 0;
    for (const t of qTokens) if (lower.includes(t)) hits++;
    if (hits > 0) scored.push({ line: i + 1, hits, text: lines[i].trim().slice(0, 160) });
  }
  return scored.sort((a, b) => b.hits - a.hits || a.line - b.line).slice(0, maxLines);
}
