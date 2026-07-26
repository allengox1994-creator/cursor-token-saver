// 项目语义记忆：跨会话沉淀的工程事实（约定/决策/坑/入口）。
// 与整个工具包同一哲学：记忆挂文件哈希，可验证、会过期（stale），不伪造摘要。
// agent 显式写入为 active；机械提取（checkpoint decisions、失败→修复）只生成 candidate，
// 需要 agent/用户确认后才升级——避免"记忆幻觉"污染后续会话。
// 两个作用域：project（默认，项目内）和 global（~/.cursor-token-saver，跨项目通用事实）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir, globalHome } from './_lib.mjs';

const SCHEMA = 1;
// relation = 世界模型三元组（实体 --关系--> 实体，挂证据文件）；skill = 可复用 runbook（目标 + 步骤）
export const MEMORY_KINDS = ['convention', 'decision', 'gotcha', 'entrypoint', 'fact', 'relation', 'skill'];
const TEXT_MAX = 500;
const FILES_MAX = 8;
const STEPS_MAX = 12;
const MERGE_SIMILARITY = 0.75;

export function memoryPath(root, scope = 'project') {
  return scope === 'global' ? path.join(globalHome(), 'memory.json') : path.join(dataDir(root), 'memory.json');
}

function loadStore(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw.memories)) return raw;
  } catch {}
  return { schemaVersion: SCHEMA, memories: [] };
}

function persistStore(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function loadMemories(root, { scope = 'project' } = {}) {
  return loadStore(memoryPath(root, scope));
}

function fileHash(root, rel) {
  try {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(path.resolve(root) + path.sep)) return null;
    const buf = fs.readFileSync(abs);
    if (buf.length > 8 * 1024 * 1024) return null;
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

// 记忆文本经常是中英混合：英文按词、CJK 按 bigram，检索和去重共用
export function memTokens(text) {
  const s = String(text || '').toLowerCase();
  const words = s.match(/[a-z0-9_.-]{2,}/g) || [];
  const cjkRuns = s.match(/[\u3400-\u9fff]+/g) || [];
  const bigrams = [];
  for (const run of cjkRuns) {
    if (run.length === 1) bigrams.push(run);
    for (let i = 0; i < run.length - 1; i++) bigrams.push(run.slice(i, i + 2));
  }
  return [...words, ...bigrams];
}

function similarity(a, b) {
  const ta = new Set(memTokens(a));
  const tb = new Set(memTokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// 记忆是否过期：任一挂载文件的当前哈希与保存时不同（文件被删也算过期）。
// 全局记忆不挂文件，永不 stale——它只该存放不依赖具体文件的通用事实。
export function isStale(root, memory) {
  if (memory.scope === 'global') return false;
  for (const ref of memory.files || []) {
    if (!ref.hash) continue;
    if (fileHash(root, ref.path) !== ref.hash) return true;
  }
  return false;
}

function normalizeTriple(triple) {
  if (!triple || typeof triple !== 'object') return null;
  const s = String(triple.s || '').trim().slice(0, 120);
  const r = String(triple.r || '').trim().slice(0, 60);
  const o = String(triple.o || '').trim().slice(0, 120);
  return s && r && o ? { s, r, o } : null;
}

// 保存记忆。与现有条目高度相似时合并而不是新增；
// 显式保存（agent）会确认条目（active + 刷新哈希），机械提取（auto）只轻触 updatedAt。
// triple 存在时是世界模型关系（kind 强制 relation，text 可省略自动生成）；
// steps 存在时是技能 runbook；skill 复发（相似 auto 条目再次出现）提升 confidence。
export function saveMemory(root, { text, kind, files = [], source = 'agent', status, scope = 'project', triple, steps } = {}) {
  const t = normalizeTriple(triple);
  if (t) kind = 'relation';
  const clean = String(text || (t ? `${t.s} --${t.r}--> ${t.o}` : '')).trim().slice(0, TEXT_MAX);
  if (!clean) return { error: 'memory text is required' };
  const cleanSteps = Array.isArray(steps)
    ? steps.map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, STEPS_MAX)
    : null;
  if (cleanSteps?.length) kind = kind === 'relation' ? kind : 'skill';
  const file = memoryPath(root, scope);
  const data = loadStore(file);
  const now = new Date().toISOString();
  const fileRefs =
    scope === 'global'
      ? [] // 全局记忆跨项目使用，文件引用无意义
      : (Array.isArray(files) ? files : []).slice(0, FILES_MAX).map((f) => ({ path: String(f), hash: fileHash(root, String(f)) }));

  const existing = data.memories.find(
    (m) => m.status !== 'deleted' && similarity(m.text, clean) >= MERGE_SIMILARITY
  );
  if (existing) {
    existing.updatedAt = now;
    // 复发检测：同一技能被再次机械提取 → 置信度 +1（排序加权），但仍需确认才生效
    if (source === 'auto' && (existing.kind === 'skill' || cleanSteps?.length)) {
      existing.confidence = (existing.confidence || 1) + 1;
      if (cleanSteps?.length) existing.steps = cleanSteps;
    }
    if (source === 'agent') {
      existing.text = clean;
      if (MEMORY_KINDS.includes(kind)) existing.kind = kind;
      if (fileRefs.length) existing.files = fileRefs;
      if (t) existing.triple = t;
      if (cleanSteps?.length) existing.steps = cleanSteps;
      existing.status = 'active';
      existing.lastConfirmedAt = now;
      existing.uses = (existing.uses || 0) + 1;
    }
    persistStore(file, data);
    return { memory: existing, merged: true };
  }

  const memory = {
    id: `mem_${crypto.randomBytes(6).toString('hex')}`,
    text: clean,
    kind: MEMORY_KINDS.includes(kind) ? kind : 'fact',
    files: fileRefs,
    ...(t ? { triple: t } : {}),
    ...(cleanSteps?.length ? { steps: cleanSteps, confidence: 1 } : {}),
    source: source === 'auto' ? 'auto' : 'agent',
    status: status === 'candidate' || source === 'auto' ? 'candidate' : 'active',
    ...(scope === 'global' ? { scope: 'global' } : {}),
    uses: 0,
    createdAt: now,
    updatedAt: now,
    lastConfirmedAt: source === 'auto' ? null : now,
    lastRecalledAt: null
  };
  data.memories.push(memory);
  persistStore(file, data);
  return { memory, merged: false };
}

// 按 ID 定位记忆：先项目库、后全局库
function findMemory(root, id) {
  for (const scope of ['project', 'global']) {
    const file = memoryPath(root, scope);
    const data = loadStore(file);
    const memory = data.memories.find((x) => x.id === id);
    if (memory) return { file, data, memory, scope };
  }
  return null;
}

// 确认记忆：candidate/过期条目升级为 active，并按当前文件内容刷新哈希
export function confirmMemory(root, id) {
  const found = findMemory(root, id);
  if (!found) return { error: `memory not found: ${id}` };
  const now = new Date().toISOString();
  const m = found.memory;
  m.status = 'active';
  m.lastConfirmedAt = now;
  m.updatedAt = now;
  m.uses = (m.uses || 0) + 1;
  if (found.scope === 'project') {
    m.files = (m.files || []).map((ref) => ({ path: ref.path, hash: fileHash(root, ref.path) }));
  }
  persistStore(found.file, found.data);
  return { memory: m };
}

// 归档（软删除，可在面板恢复）
export function archiveMemory(root, id) {
  return updateMemory(root, id, { status: 'archived' });
}

export function updateMemory(root, id, patch = {}) {
  const found = findMemory(root, id);
  if (!found) return { error: `memory not found: ${id}` };
  const m = found.memory;
  if (typeof patch.text === 'string' && patch.text.trim()) m.text = patch.text.trim().slice(0, TEXT_MAX);
  if (MEMORY_KINDS.includes(patch.kind)) m.kind = patch.kind;
  if (['active', 'candidate', 'archived'].includes(patch.status)) m.status = patch.status;
  m.updatedAt = new Date().toISOString();
  persistStore(found.file, found.data);
  return { memory: m };
}

export function deleteMemory(root, id) {
  const found = findMemory(root, id);
  if (!found) return { error: `memory not found: ${id}` };
  found.data.memories = found.data.memories.filter((x) => x.id !== id);
  persistStore(found.file, found.data);
  return { ok: true };
}

// agent 显式整合：多条相关记忆合并成一条精炼版，原条目归档并记录去向（溯源不丢）
export function mergeMemories(root, ids, { text, kind, files = [] } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return { error: 'merged text is required' };
  if (!Array.isArray(ids) || ids.length < 2) return { error: 'at least 2 memory ids are required' };
  const found = ids.map((id) => findMemory(root, id));
  const missing = ids.filter((_, i) => !found[i]);
  if (missing.length) return { error: `memory not found: ${missing.join(', ')}` };
  const scopes = new Set(found.map((f) => f.scope));
  if (scopes.size > 1) return { error: 'cannot merge across scopes (project vs global); merge within one scope' };
  const scope = found[0].scope;

  const res = saveMemory(root, { text: clean, kind, files, source: 'agent', scope });
  if (res.error) return res;
  const mergedId = res.memory.id;
  // 逐条归档原条目（saveMemory 可能已把某条相似原文合并成了新条目本身，跳过它）
  const file = memoryPath(root, scope);
  const data = loadStore(file);
  const target = data.memories.find((x) => x.id === mergedId);
  let uses = target?.uses || 0;
  for (const id of ids) {
    if (id === mergedId) continue;
    const m = data.memories.find((x) => x.id === id);
    if (!m) continue;
    uses += m.uses || 0;
    m.status = 'archived';
    m.mergedInto = mergedId;
    m.updatedAt = new Date().toISOString();
  }
  if (target) {
    target.uses = uses;
    target.mergedFrom = ids.filter((id) => id !== mergedId);
  }
  persistStore(file, data);
  return { memory: target || res.memory };
}

function markRecalled(file, data, hits) {
  if (!hits.length) return;
  const now = new Date().toISOString();
  for (const m of hits) {
    m.lastRecalledAt = now;
    m.uses = (m.uses || 0) + 1;
  }
  try {
    persistStore(file, data);
  } catch {}
}

// 读取两个作用域的库，返回 [{file, data, entries(带 scope)}]
function bothStores(root) {
  return ['project', 'global'].map((scope) => {
    const file = memoryPath(root, scope);
    const data = loadStore(file);
    return { scope, file, data };
  });
}

// 检索：token 重叠评分（英文词 + CJK bigram），项目库和全局库一起查，命中即续期
export function searchMemories(root, query, { max = 8 } = {}) {
  const qTokens = new Set(memTokens(query));
  if (!qTokens.size) return [];
  const stores = bothStores(root);
  const scored = [];
  for (const store of stores) {
    for (const m of store.data.memories) {
      if (m.status === 'archived') continue;
      const tokens = new Set(
        memTokens(m.text + ' ' + (m.files || []).map((f) => f.path).join(' ') + ' ' + (m.steps || []).join(' '))
      );
      let inter = 0;
      for (const t of qTokens) if (tokens.has(t)) inter++;
      if (!inter) continue;
      const score = inter / qTokens.size + (m.text.toLowerCase().includes(String(query).toLowerCase()) ? 0.5 : 0);
      scored.push({ store, memory: m, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || Date.parse(b.memory.updatedAt) - Date.parse(a.memory.updatedAt));
  const hits = scored.slice(0, max);
  for (const store of stores) {
    markRecalled(store.file, store.data, hits.filter((h) => h.store === store).map((h) => h.memory));
  }
  return hits.map((h) => ({ ...h.memory, scope: h.store.scope, score: h.score, stale: isStale(root, { ...h.memory, scope: h.store.scope }) }));
}

// bootstrap 用：active 按使用量/新鲜度排序，candidate 殿后标注待确认
export function topMemories(root, { max = 6 } = {}) {
  const stores = bothStores(root);
  const all = stores.flatMap((store) =>
    store.data.memories.filter((m) => m.status !== 'archived').map((m) => ({ store, memory: m }))
  );
  const rank = ({ memory: m }) =>
    (m.uses || 0) * 2 +
    ((m.confidence || 1) - 1) + // 复发次数越多的技能越先出现
    Math.max(0, 30 - (Date.now() - Date.parse(m.updatedAt || 0)) / (24 * 60 * 60 * 1000)) / 30;
  const active = all.filter((x) => x.memory.status === 'active').sort((a, b) => rank(b) - rank(a));
  const candidates = all.filter((x) => x.memory.status === 'candidate').sort((a, b) => rank(b) - rank(a));
  const picked = [...active, ...candidates].slice(0, max);
  for (const store of stores) {
    markRecalled(store.file, store.data, picked.filter((x) => x.store === store).map((x) => x.memory));
  }
  return picked.map(({ store, memory: m }) => ({ ...m, scope: store.scope, stale: isStale(root, { ...m, scope: store.scope }) }));
}

// 世界模型查询：实体匹配 → 沿三元组扩展一到两跳，返回子图（关系条目 + 命中跳数）。
// 只是查询视角，不是独立存储——关系就是带 triple 的记忆，复用确认/过期/衰减全套机制。
export function worldQuery(root, query, { max = 20, hops = 2 } = {}) {
  const stores = bothStores(root);
  const relations = stores.flatMap((store) =>
    store.data.memories.filter((m) => m.status !== 'archived' && m.triple).map((m) => ({ store, memory: m }))
  );
  if (!relations.length) return [];
  const qTokens = new Set(memTokens(query));
  const norm = (x) => String(x).toLowerCase().trim();
  const entityMatches = (entity) => {
    const tokens = memTokens(entity);
    return tokens.some((t) => qTokens.has(t)) || norm(entity).includes(norm(query));
  };
  // 种子：s/r/o 任意一端匹配查询词
  const picked = new Map();
  const seedEntities = new Set();
  for (const rel of relations) {
    const { s, r, o } = rel.memory.triple;
    if (entityMatches(s) || entityMatches(o) || entityMatches(r)) {
      picked.set(rel.memory.id, { ...rel, hop: 1 });
      seedEntities.add(norm(s));
      seedEntities.add(norm(o));
    }
  }
  // 扩展：与种子实体相连的关系再收一跳
  if (hops >= 2 && picked.size) {
    for (const rel of relations) {
      if (picked.has(rel.memory.id)) continue;
      const { s, o } = rel.memory.triple;
      if (seedEntities.has(norm(s)) || seedEntities.has(norm(o))) picked.set(rel.memory.id, { ...rel, hop: 2 });
    }
  }
  const hits = [...picked.values()].sort((a, b) => a.hop - b.hop || (b.memory.uses || 0) - (a.memory.uses || 0)).slice(0, max);
  for (const store of stores) {
    markRecalled(store.file, store.data, hits.filter((h) => h.store === store).map((h) => h.memory));
  }
  return hits.map((h) => ({ ...h.memory, scope: h.store.scope, hop: h.hop, stale: isStale(root, { ...h.memory, scope: h.store.scope }) }));
}

// 从已完成任务的检查点机械提取 runbook 候选：目标 + 成功执行的命令序列。
// 只取确定性信号（exit 0 的命令事件），不做任何生成式总结；无命令步骤则不提取（低信号）。
export function extractRunbookMemory(root, checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  const goal = String(checkpoint.goal || '').trim();
  if (!goal) return null;
  const steps = [];
  for (const ev of checkpoint.events || []) {
    if (ev.type !== 'command' || ev.exitCode !== 0 || typeof ev.command !== 'string') continue;
    if (steps[steps.length - 1] === ev.command) continue; // 连续重复只留一次
    steps.push(ev.command);
  }
  if (steps.length < 2) return null; // 单条命令谈不上"流程"
  const res = saveMemory(root, {
    text: `Runbook: ${goal}`.slice(0, TEXT_MAX),
    kind: 'skill',
    steps: steps.slice(-STEPS_MAX),
    source: 'auto'
  });
  return res.memory || null;
}

// 面板/报表用：两个作用域的条目（带 scope 与 stale）+ 效果度量
export function memoryOverview(root) {
  const entries = bothStores(root).flatMap(({ scope, data }) =>
    data.memories.map((m) => ({ ...m, scope, stale: m.status === 'archived' ? false : isStale(root, { ...m, scope }) }))
  );
  const live = entries.filter((m) => m.status !== 'archived');
  const stats = {
    active: entries.filter((m) => m.status === 'active').length,
    candidate: entries.filter((m) => m.status === 'candidate').length,
    archived: entries.filter((m) => m.status === 'archived').length,
    neverRecalled: live.filter((m) => !m.lastRecalledAt).length,
    stale: live.filter((m) => m.stale).length,
    totalRecalls: entries.reduce((s, m) => s + (m.uses || 0), 0),
    relations: live.filter((m) => m.kind === 'relation').length,
    skills: live.filter((m) => m.kind === 'skill').length,
    skillReuse: live.filter((m) => m.kind === 'skill').reduce((s, m) => s + (m.uses || 0), 0)
  };
  return {
    stats,
    memories: entries.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
  };
}

// 衰减治理：长期未召回/未确认的 active 记忆归档；candidate 更快过期；总量封顶。
// 归档不是删除——面板可见可恢复，信息不丢。项目库与全局库都治理。
export function decayMemories(root, { decayDays = 45, maxActive = 200 } = {}) {
  const now = Date.now();
  const lastAlive = (m) =>
    Math.max(Date.parse(m.lastRecalledAt || 0) || 0, Date.parse(m.lastConfirmedAt || 0) || 0, Date.parse(m.createdAt || 0) || 0);
  let archived = 0;
  for (const { file, data } of bothStores(root)) {
    if (!data.memories.length) continue;
    let touched = false;
    for (const m of data.memories) {
      if (m.status === 'archived') continue;
      const ageDays = (now - lastAlive(m)) / (24 * 60 * 60 * 1000);
      const limit = m.status === 'candidate' ? Math.min(14, decayDays) : decayDays;
      if (ageDays > limit) {
        m.status = 'archived';
        m.updatedAt = new Date().toISOString();
        archived++;
        touched = true;
      }
    }
    const active = data.memories.filter((m) => m.status !== 'archived');
    if (active.length > maxActive) {
      const overflow = active.sort((a, b) => lastAlive(a) - lastAlive(b)).slice(0, active.length - maxActive);
      for (const m of overflow) {
        m.status = 'archived';
        m.updatedAt = new Date().toISOString();
        archived++;
        touched = true;
      }
    }
    if (touched) persistStore(file, data);
  }
  return archived;
}
