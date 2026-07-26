// 离线检索评测：从真实导出符号自动构造可复现 query→expected-file 数据集，
// 评测 exact + BM25 + neural RRF 的 Hit@1/Hit@5/MRR。只在 CLI eval 时运行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocIndex, bm25Search } from '../hooks/analyze.mjs';
import { collectSourceFiles, buildIndex, loadBackend, loadIndex, searchIndex } from '../hooks/embed-index.mjs';
import { reciprocalRankFuse } from '../hooks/hybrid-search.mjs';
import { loadConfig, dataDir } from '../hooks/_lib.mjs';

const LOCK_MAX_AGE = 2 * 60 * 60 * 1000;

function evalStatusPath(root) {
  return path.join(dataDir(root), 'eval-status.json');
}

function evalLockPath(root) {
  return path.join(dataDir(root), 'eval.lock');
}

function writeEvalStatus(root, patch) {
  try {
    let prev = {};
    try {
      prev = JSON.parse(fs.readFileSync(evalStatusPath(root), 'utf8'));
    } catch {}
    fs.mkdirSync(dataDir(root), { recursive: true });
    fs.writeFileSync(evalStatusPath(root), JSON.stringify({ ...prev, ...patch }, null, 2) + '\n');
  } catch {}
}

function acquireLock(root) {
  fs.mkdirSync(dataDir(root), { recursive: true });
  const lock = evalLockPath(root);
  try {
    const fd = fs.openSync(lock, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_MAX_AGE) {
        fs.unlinkSync(lock);
        return acquireLock(root);
      }
    } catch {}
    return false;
  }
}

function symbolName(text) {
  const patterns = [
    /\b(?:function|class|interface|type|enum|def|struct|trait|func)\s+([A-Za-z_$][\w$]*)/,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

function words(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
}

export async function evaluateRetrieval(root, options = {}) {
  const limit = Math.min(200, Math.max(5, Number(options.limit) || 50));
  const files = collectSourceFiles(root);
  const loaded = new Map();
  const docs = new Map();
  const cases = [];
  for (const file of files) {
    let value;
    try {
      value = file.load();
    } catch {
      continue;
    }
    loaded.set(file.rel, value.content);
    docs.set(file.rel, buildDocIndex(value.content));
    for (const symbol of value.symbols) {
      const name = symbolName(symbol.text);
      if (!name || name.length < 4) continue;
      cases.push({ query: words(name), symbol: name, expected: file.rel });
      if (cases.length >= limit) break;
    }
    if (cases.length >= limit) break;
  }
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const backend = await loadBackend(loadConfig(root).embedding || {}, pkgRoot);
  const index = backend ? await buildIndex(backend, files, loadIndex(root), null) : null;
  const rows = [];
  const started = Date.now();
  for (const item of cases) {
    const exact = [];
    for (const [rel, content] of loaded) {
      if (content.includes(item.symbol)) exact.push({ rel });
    }
    const bm25 = bm25Search(item.query, docs, { topN: 20 }).map((h) => ({ rel: h.file }));
    const vector = backend && index ? await searchIndex(backend, index, item.query, 20) : [];
    const ranked = reciprocalRankFuse({ exact, bm25, vector }, { topN: 20 });
    const rank = ranked.findIndex((h) => h.rel === item.expected) + 1;
    rows.push({ ...item, rank: rank || null, top: ranked.slice(0, 5).map((h) => h.rel) });
  }
  const found = rows.filter((r) => r.rank);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root: path.basename(root),
    backend: backend?.id || 'BM25+exact only',
    cases: rows.length,
    hitAt1: rows.length ? rows.filter((r) => r.rank === 1).length / rows.length : 0,
    hitAt5: rows.length ? rows.filter((r) => r.rank && r.rank <= 5).length / rows.length : 0,
    mrr: rows.length ? found.reduce((n, r) => n + 1 / r.rank, 0) / rows.length : 0,
    durationMs: Date.now() - started,
    rows
  };
}

export async function runRetrievalEval(root, options = {}) {
  let locked = acquireLock(root);
  if (!locked && options.auto) {
    writeEvalStatus(root, {
      state: 'waiting',
      pid: process.pid,
      automatic: true,
      reason: 'another evaluation holds the lock',
      updatedAt: new Date().toISOString()
    });
    const deadline = Date.now() + LOCK_MAX_AGE;
    while (!locked && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30 * 1000));
      locked = acquireLock(root);
    }
  }
  if (!locked) {
    const message = '已有检索评测正在运行，本次不重复启动。';
    if (options.auto) {
      writeEvalStatus(root, { state: 'error', error: message, finishedAt: new Date().toISOString() });
      console.log(message);
      return null;
    }
    throw new Error(message);
  }
  writeEvalStatus(root, {
    state: 'running',
    pid: process.pid,
    automatic: Boolean(options.auto),
    startedAt: new Date().toISOString(),
    error: null
  });
  try {
    console.log(`${options.auto ? '自动' : '手动'}离线构造符号查询并评测 exact + BM25 + neural RRF…`);
    const report = await evaluateRetrieval(root, options);
    fs.mkdirSync(dataDir(root), { recursive: true });
    const target = path.join(dataDir(root), 'eval-report.json');
    fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
    writeEvalStatus(root, {
      state: 'ready',
      finishedAt: new Date().toISOString(),
      generatedAt: report.generatedAt,
      cases: report.cases,
      hitAt1: report.hitAt1,
      hitAt5: report.hitAt5,
      mrr: report.mrr,
      error: null
    });
    console.log(
      `完成: ${report.cases} queries · Hit@1 ${(report.hitAt1 * 100).toFixed(1)}% · ` +
        `Hit@5 ${(report.hitAt5 * 100).toFixed(1)}% · MRR ${report.mrr.toFixed(3)} · ${report.durationMs}ms`
    );
    console.log(`报告: ${target}`);
    return report;
  } catch (e) {
    writeEvalStatus(root, {
      state: 'error',
      error: String(e?.message || e),
      finishedAt: new Date().toISOString()
    });
    throw e;
  } finally {
    try {
      fs.unlinkSync(evalLockPath(root));
    } catch {}
  }
}
