// 全局面板后端：聚合注册表（~/.cursor-token-saver/projects.json）里所有项目的统计，
// 配置读写按项目进行。从任意目录启动均可；若当前目录是已安装项目会顺带登记。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { aggregate, aggregateAll, embedModelFor, readEvents, wasteInsights } from './aggregate.mjs';
import { collectSourceFiles, indexPath, EMBED_INDEX_SCHEMA } from '../hooks/embed-index.mjs';
import {
  PROFILES,
  DEFAULT_HOOK_TOGGLES,
  OVERRIDE_KEYS,
  configPath,
  registerProject,
  unregisterProject,
  liveProjects,
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  CONFIG_VERSION,
  DEFAULT_CONTEXT_QUERY,
  DEFAULT_ARTIFACT_STORE,
  DEFAULT_TASK_BUDGET,
  DEFAULT_EMBEDDING,
  DEFAULT_MEMORY,
  allStateFiles,
  globalHome
} from '../hooks/_lib.mjs';
import { loadManifest, storeStats } from '../hooks/context-store.mjs';
import { summaryDir } from '../hooks/summary-store.mjs';
import { memoryOverview, updateMemory, deleteMemory, confirmMemory } from '../hooks/memory-store.mjs';

function readConfigFile(root) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
  } catch {}
  return {
    ...raw,
    configVersion: CONFIG_VERSION,
    profile: PROFILES[raw.profile] ? raw.profile : 'standard',
    hooks: { ...DEFAULT_HOOK_TOGGLES, ...(raw.hooks || {}) },
    overrides: raw.overrides || {},
    embedding: { ...DEFAULT_EMBEDDING, ...(raw.embedding || {}) },
    contextQuery: { ...DEFAULT_CONTEXT_QUERY, ...(raw.contextQuery || {}) },
    artifactStore: { ...DEFAULT_ARTIFACT_STORE, ...(raw.artifactStore || {}) },
    taskBudget: { ...DEFAULT_TASK_BUDGET, ...(raw.taskBudget || {}), hardLimit: false }
  };
}

function validateConfig(body) {
  const errors = [];
  const clean = {
    configVersion: CONFIG_VERSION,
    profile: 'standard',
    hooks: {},
    overrides: {},
    embedding: { ...DEFAULT_EMBEDDING, ...(body?.embedding || {}) },
    contextQuery: { ...DEFAULT_CONTEXT_QUERY },
    artifactStore: { ...DEFAULT_ARTIFACT_STORE },
    taskBudget: { ...DEFAULT_TASK_BUDGET },
    memory: { ...DEFAULT_MEMORY }
  };

  if (typeof body?.profile === 'string' && PROFILES[body.profile]) clean.profile = body.profile;
  else errors.push('profile 无效');

  for (const key of Object.keys(DEFAULT_HOOK_TOGGLES)) {
    const v = body?.hooks?.[key];
    clean.hooks[key] = typeof v === 'boolean' ? v : DEFAULT_HOOK_TOGGLES[key];
  }
  for (const key of OVERRIDE_KEYS) {
    const v = body?.overrides?.[key];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) clean.overrides[key] = n;
    else errors.push(`overrides.${key} 必须是非负数字`);
  }
  const sections = [
    ['embedding', DEFAULT_EMBEDDING],
    ['contextQuery', DEFAULT_CONTEXT_QUERY],
    ['artifactStore', DEFAULT_ARTIFACT_STORE],
    ['taskBudget', DEFAULT_TASK_BUDGET],
    ['memory', DEFAULT_MEMORY]
  ];
  for (const [section, defaults] of sections) {
    for (const [key, fallback] of Object.entries(defaults)) {
      const value = body?.[section]?.[key];
      if (typeof fallback === 'boolean') clean[section][key] = typeof value === 'boolean' ? value : fallback;
      else if (typeof fallback === 'number') {
        if (value == null || value === '') {
          clean[section][key] = fallback;
          continue;
        }
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) clean[section][key] = n;
        else errors.push(`${section}.${key} 必须是非负数字`);
      } else clean[section][key] = value ?? fallback;
    }
  }
  clean.taskBudget.hardLimit = false; // 能力保证：面板/API 都不能开启硬拦截
  return { clean, errors };
}

// 只允许操作注册表里的项目，防止面板 API 被用来读写任意路径
function resolveProject(req) {
  const q = req.query.project;
  if (typeof q !== 'string' || !q) return null;
  return liveProjects().find((p) => p.path === q) || null;
}

export function start(root, port = 4517) {
  registerProject(root);

  const app = express();
  app.use(express.json());

  app.get('/api/projects', (req, res) => {
    res.json({ projects: liveProjects() });
  });

  // 剔除管理：移出注册表并加入 excluded（sessionStart 不会自动登记回来）。
  // 只动注册表，项目里的 hooks/配置/统计原样保留；重跑 init 可恢复。
  app.delete('/api/projects', (req, res) => {
    const proj = resolveProject(req);
    if (!proj) return res.status(404).json({ error: 'unknown project' });
    unregisterProject(proj.path);
    res.json({ ok: true, projects: liveProjects() });
  });

  // project=all（默认）聚合全部；project=<abs path> 看单个项目
  app.get('/api/summary', (req, res) => {
    const q = req.query.project;
    if (!q || q === 'all') {
      return res.json({ project: 'all', ...aggregateAll(liveProjects()) });
    }
    const proj = resolveProject(req);
    if (!proj) return res.status(404).json({ error: 'unknown project' });
    res.json({ project: proj.path, embedModel: embedModelFor(proj.path), ...aggregate(proj.path) });
  });

  // 浪费洞察：没省到的地方 + 校准建议。project=all 聚合全部项目
  app.get('/api/waste', (req, res) => {
    const q = req.query.project;
    if (!q || q === 'all') {
      let all = [];
      for (const p of liveProjects()) {
        all = all.concat(readEvents(p.path).map((e) => ({ ...e, project: p.name })));
      }
      return res.json({ project: 'all', ...wasteInsights(all) });
    }
    const proj = resolveProject(req);
    if (!proj) return res.status(404).json({ error: 'unknown project' });
    res.json({ project: proj.path, ...wasteInsights(readEvents(proj.path)) });
  });

  // 项目语义记忆：查看（项目 + 全局条目、效果度量）/编辑/确认/归档/删除
  app.get('/api/memory', (req, res) => {
    const proj = resolveProject(req);
    if (!proj) return res.status(404).json({ error: 'unknown project' });
    res.json(memoryOverview(proj.path));
  });

  app.put('/api/memory', (req, res) => {
    const proj = resolveProject(req);
    if (!proj) return res.status(404).json({ error: 'unknown project' });
    const { id, action, text, kind, status } = req.body || {};
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id is required' });
    const result = action === 'confirm' ? confirmMemory(proj.path, id) : updateMemory(proj.path, id, { text, kind, status });
    if (result.error) return res.status(404).json({ error: result.error });
    res.json({ ok: true, memory: result.memory });
  });

  app.delete('/api/memory', (req, res) => {
    const proj = resolveProject(req);
    if (!proj) return res.status(404).json({ error: 'unknown project' });
    const result = deleteMemory(proj.path, String(req.query.id || ''));
    if (result.error) return res.status(404).json({ error: result.error });
    res.json({ ok: true });
  });

  // 嵌入索引明细：概况 + 逐文件状态
  app.get('/api/index', (req, res) => {
    const proj = resolveProject(req);
    if (!proj) return res.status(404).json({ error: 'unknown project' });

    // 自动索引心跳：MCP 服务器每次检查/重建都会写 embed-status.json
    let auto = null;
    try {
      const s = JSON.parse(
        fs.readFileSync(path.join(proj.path, '.cursor', 'token-saver', 'embed-status.json'), 'utf8')
      );
      let alive = false;
      try {
        process.kill(s.pid, 0);
        alive = true;
      } catch {}
      auto = { ...s, alive };
    } catch {}

    const p = indexPath(proj.path);
    let idx;
    let st;
    try {
      idx = JSON.parse(fs.readFileSync(p, 'utf8'));
      st = fs.statSync(p);
    } catch {
      return res.json({ project: proj.path, exists: false, auto });
    }

    // 与磁盘现状对比：ok=新鲜 stale=已变化待重嵌 new=尚未索引 deleted=文件已删
    const current = new Map(collectSourceFiles(proj.path).map((f) => [f.rel, f.stamp]));
    const files = [];
    const totals = { ok: 0, stale: 0, new: 0, deleted: 0, chunks: 0 };
    for (const [rel, entry] of Object.entries(idx.files || {})) {
      const stamp = current.get(rel);
      const status =
        stamp == null
          ? 'deleted'
          : stamp === entry.stamp && entry.contentHash && idx.schemaVersion === EMBED_INDEX_SCHEMA
            ? 'ok'
            : 'stale';
      totals[status] += 1;
      totals.chunks += entry.chunks.length;
      files.push({ rel, chunks: entry.chunks.length, status });
      current.delete(rel);
    }
    for (const rel of current.keys()) {
      totals.new += 1;
      files.push({ rel, chunks: 0, status: 'new' });
    }
    const order = { stale: 0, new: 1, deleted: 2, ok: 3 };
    files.sort((a, b) => order[a.status] - order[b.status] || a.rel.localeCompare(b.rel));

    res.json({
      project: proj.path,
      exists: true,
      model: idx.model || null,
      updatedAt: st.mtime.toISOString(),
      sizeBytes: st.size,
      totals,
      auto,
      files: files.slice(0, 1000)
    });
  });

  app.get('/api/context', (req, res) => {
    const proj = resolveProject(req);
    if (!proj) return res.status(404).json({ error: 'unknown project' });
    const manifest = loadManifest(proj.path);
    const recent = Object.values(manifest.entries)
      .sort((a, b) => String(b.accessedAt || b.createdAt).localeCompare(String(a.accessedAt || a.createdAt)))
      .slice(0, 200)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        rel: e.rel || null,
        bytes: e.bytes || 0,
        createdAt: e.createdAt,
        accessedAt: e.accessedAt,
        meta: e.meta || {}
      }));
    let budget = { sessions: 0, usedTokens: 0, maxUsedTokens: 0 };
    for (const file of allStateFiles(proj.path)) {
      try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        const used = Number(state.budget?.usedTokens) || 0;
        budget.sessions++;
        budget.usedTokens += used;
        budget.maxUsedTokens = Math.max(budget.maxUsedTokens, used);
      } catch {}
    }
    let checkpoints = 0;
    try {
      checkpoints = fs.readdirSync(summaryDir(proj.path)).filter((x) => x.endsWith('.json')).length;
    } catch {}
    const metrics = aggregate(proj.path).totals;
    let daemon = null;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(globalHome(), 'daemon.json'), 'utf8'));
      let alive = false;
      try {
        process.kill(state.pid, 0);
        alive = true;
      } catch {}
      daemon = { ...state, alive };
    } catch {}
    let evaluation = null;
    try {
      const report = JSON.parse(
        fs.readFileSync(path.join(proj.path, '.cursor', 'token-saver', 'eval-report.json'), 'utf8')
      );
      evaluation = {
        generatedAt: report.generatedAt,
        cases: report.cases,
        hitAt1: report.hitAt1,
        hitAt5: report.hitAt5,
        mrr: report.mrr,
        backend: report.backend
      };
    } catch {}
    let evaluationStatus = null;
    try {
      evaluationStatus = JSON.parse(
        fs.readFileSync(path.join(proj.path, '.cursor', 'token-saver', 'eval-status.json'), 'utf8')
      );
    } catch {}
    res.json({
      project: proj.path,
      store: storeStats(proj.path),
      budget,
      checkpoints,
      metrics,
      daemon,
      evaluation,
      evaluationStatus,
      recent
    });
  });

  // 全局设置（计价模型/汇率）
  app.get('/api/settings', (req, res) => {
    res.json({ settings: loadSettings() });
  });

  app.put('/api/settings', (req, res) => {
    const b = req.body || {};
    const clean = { ...DEFAULT_SETTINGS };
    if (typeof b.priceName === 'string' && b.priceName.trim()) clean.priceName = b.priceName.trim().slice(0, 60);
    const price = Number(b.pricePerMTokUsd);
    const rate = Number(b.usdToCny);
    if (Number.isFinite(price) && price > 0) clean.pricePerMTokUsd = price;
    if (Number.isFinite(rate) && rate > 0) clean.usdToCny = rate;
    try {
      saveSettings(clean);
      res.json({ ok: true, settings: clean });
    } catch (e) {
      res.status(500).json({ ok: false, errors: [String(e?.message || e)] });
    }
  });

  app.get('/api/config', (req, res) => {
    const proj = resolveProject(req);
    if (!proj) return res.status(404).json({ error: 'unknown project' });
    res.json({
      project: proj.path,
      config: readConfigFile(proj.path),
      profiles: PROFILES,
      hookToggles: DEFAULT_HOOK_TOGGLES,
      overrideKeys: OVERRIDE_KEYS
    });
  });

  app.put('/api/config', (req, res) => {
    const proj = resolveProject(req);
    if (!proj) return res.status(404).json({ ok: false, errors: ['unknown project'] });
    const { clean, errors } = validateConfig(req.body);
    if (errors.length > 0) return res.status(400).json({ ok: false, errors });
    try {
      fs.mkdirSync(path.dirname(configPath(proj.path)), { recursive: true });
      fs.writeFileSync(configPath(proj.path), JSON.stringify(clean, null, 2) + '\n');
      res.json({ ok: true, config: clean });
    } catch (e) {
      res.status(500).json({ ok: false, errors: [String(e?.message || e)] });
    }
  });

  const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
  app.use(express.static(pub));

  const server = app.listen(port, () => {
    const projects = liveProjects();
    console.log(`cursor-token-saver 全局面板已启动: http://localhost:${server.address().port}`);
    console.log(`已登记项目 ${projects.length} 个:`);
    for (const p of projects) console.log(`  - ${p.path}`);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`错误: 端口 ${port} 已被占用（可能已有一个面板在运行），换端口: --port ${port + 1}`);
      process.exit(1);
    }
    throw e;
  });
  return server;
}
