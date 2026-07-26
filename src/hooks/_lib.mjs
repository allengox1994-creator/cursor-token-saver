// 零依赖共享库：会被 init 一并复制到目标项目 .cursor/hooks/token-saver/ 下，
// 因此只能依赖 node 标准库，且只能被同目录脚本以相对路径引用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROFILES = {
  conservative: {
    label: '保守',
    description: '只拦最明确的浪费，几乎零能力影响',
    readMaxLines: 1500,
    repeatReadWindowMs: 0,
    blockMaxDataBytes: 1024 * 1024,
    shellGuardEnabled: false,
    shellHeadLines: 80,
    shellTailLines: 160,
    compactNotice: false
  },
  standard: {
    label: '标准',
    description: '推荐档位：省得多且不丢信息',
    readMaxLines: 800,
    repeatReadWindowMs: 15 * 60 * 1000,
    blockMaxDataBytes: 512 * 1024,
    shellGuardEnabled: true,
    shellHeadLines: 50,
    shellTailLines: 100,
    compactNotice: true
  },
  extreme: {
    label: '极致',
    description: '最大化节省，接受轻微使用摩擦',
    readMaxLines: 400,
    repeatReadWindowMs: 45 * 60 * 1000,
    blockMaxDataBytes: 128 * 1024,
    shellGuardEnabled: true,
    shellHeadLines: 30,
    shellTailLines: 60,
    compactNotice: true
  }
};

export const DEFAULT_HOOK_TOGGLES = {
  readGuard: true,
  fileBlocklist: true,
  shellGuard: true,
  editInvalidate: true,
  shellAudit: true,
  mcpAudit: true,
  sessionTrack: true
};

export const OVERRIDE_KEYS = [
  'readMaxLines',
  'repeatReadWindowMs',
  'blockMaxDataBytes',
  'shellHeadLines',
  'shellTailLines'
];

export const CONFIG_VERSION = 2;
export const DEFAULT_CONTEXT_QUERY = {
  enabled: true,
  defaultBudgetChars: 5000,
  previewChars: 180,
  maxResults: 8,
  autoExpandLowConfidence: true,
  dedupePerConversation: true,
  deltaRead: true,
  deltaReadMaxLines: 200,
  toolDedupeMs: 10 * 60 * 1000,
  bootstrapHint: true,
  // 兼容旧工具（repo_map 等 5 个）默认不出现在 tools/list：每个工具定义都会
  // 附在每次 LLM 请求里持续耗 token，而 context_query 已覆盖全部能力。
  // 仍可通过 tools/call 调用；设 true 恢复展示。
  legacyTools: false
};
export const DEFAULT_ARTIFACT_STORE = {
  enabled: true,
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  maxBytes: 512 * 1024 * 1024,
  structuredLogs: true,
  deltaLogs: true
};
export const DEFAULT_TASK_BUDGET = {
  enabled: true,
  maxTokens: 80000,
  warnAtPercent: 80,
  hardLimit: false
};
// 项目语义记忆：跨会话沉淀工程事实，新会话冷启动不再重复探索
export const DEFAULT_MEMORY = {
  enabled: true,
  maxActive: 200,
  decayDays: 45,
  bootstrapMax: 6
};
export const DEFAULT_EMBEDDING = {
  backend: 'auto',
  autoIndex: true,
  useGlobalDaemon: true,
  daemonPort: 4518,
  autoEval: true,
  autoEvalIntervalHours: 24,
  autoEvalLimit: 50
};

export function projectDir() {
  return process.env.CURSOR_PROJECT_DIR || process.cwd();
}

export function dataDir(root = projectDir()) {
  return path.join(root, '.cursor', 'token-saver');
}

export function configPath(root = projectDir()) {
  return path.join(root, '.cursor', 'token-saver.json');
}

export function statsPath(root = projectDir()) {
  return path.join(dataDir(root), 'stats.jsonl');
}

// 有效配置 = 档位默认值 + hook 开关 + 数值覆盖，每次 hook 执行时实时读取，面板改完即生效
export function loadConfig(root = projectDir()) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
  } catch {}
  const profile = PROFILES[raw.profile] ? raw.profile : 'standard';
  const cfg = {
    configVersion: CONFIG_VERSION,
    profile,
    hooks: { ...DEFAULT_HOOK_TOGGLES, ...(raw.hooks || {}) },
    embedding: { ...DEFAULT_EMBEDDING, ...(raw.embedding || {}) },
    contextQuery: { ...DEFAULT_CONTEXT_QUERY, ...(raw.contextQuery || {}) },
    artifactStore: { ...DEFAULT_ARTIFACT_STORE, ...(raw.artifactStore || {}) },
    taskBudget: { ...DEFAULT_TASK_BUDGET, ...(raw.taskBudget || {}), hardLimit: false },
    memory: { ...DEFAULT_MEMORY, ...(raw.memory || {}) },
    ...PROFILES[profile]
  };
  for (const key of OVERRIDE_KEYS) {
    const v = raw.overrides ? raw.overrides[key] : undefined;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cfg[key] = v;
  }
  return cfg;
}

export function logEvent(evt, root = projectDir()) {
  try {
    fs.mkdirSync(dataDir(root), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...evt });
    fs.appendFileSync(statsPath(root), line + '\n');
  } catch {}
}

// 粗略估算：约 4 字节 = 1 token，面板会标注这是估算值
export function estTokens(bytes) {
  return Math.max(0, Math.round(bytes / 4));
}

// 文本感知估算：CJK 约 1 字符 = 1 token（UTF-8 下 3 字节），其余按 ~3.9 字节 = 1 token。
// 比 bytes/4 对中文/日韩内容准确得多；仍是估算，但预算与统计的量级正确。
const CJK_RE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;
export function estTokensText(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  const cjk = (s.match(CJK_RE) || []).length;
  const restBytes = Math.max(0, Buffer.byteLength(s) - cjk * 3);
  return Math.max(0, Math.round(cjk + restBytes / 3.9));
}

function stateDir(root = projectDir()) {
  return path.join(dataDir(root), 'state');
}

function sanitizeId(s) {
  return String(s || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function statePath(convId, root = projectDir()) {
  return path.join(stateDir(root), sanitizeId(convId) + '.json');
}

export function loadState(convId, root = projectDir()) {
  try {
    return JSON.parse(fs.readFileSync(statePath(convId, root), 'utf8'));
  } catch {
    return { reads: {}, denials: {}, delivered: {}, budget: { usedTokens: 0, byKind: {} } };
  }
}

export function saveState(convId, state, root = projectDir()) {
  try {
    fs.mkdirSync(stateDir(root), { recursive: true });
    fs.writeFileSync(statePath(convId, root), JSON.stringify(state));
  } catch {}
}

// sizeOrText 传字符串时用文本感知分词估算（对 CJK 准确），传数字时按字节估算
export function addBudgetUsage(convId, kind, sizeOrText, root = projectDir()) {
  const tokens = typeof sizeOrText === 'string' ? estTokensText(sizeOrText) : estTokens(Number(sizeOrText));
  if (!convId || !Number.isFinite(tokens) || tokens <= 0) return { usedTokens: 0, warned: false };
  const cfg = loadConfig(root);
  const state = loadState(convId, root);
  state.budget = state.budget || { usedTokens: 0, byKind: {} };
  state.budget.byKind = state.budget.byKind || {};
  const wasWarned = Boolean(state.budget.warned);
  state.budget.usedTokens = (state.budget.usedTokens || 0) + tokens;
  state.budget.byKind[kind] = (state.budget.byKind[kind] || 0) + tokens;
  const threshold = cfg.taskBudget.maxTokens * (cfg.taskBudget.warnAtPercent / 100);
  const warned = cfg.taskBudget.enabled && state.budget.usedTokens >= threshold;
  state.budget.warned = warned;
  state.budget.updatedAt = new Date().toISOString();
  saveState(convId, state, root);
  return { usedTokens: state.budget.usedTokens, maxTokens: cfg.taskBudget.maxTokens, warned, justWarned: warned && !wasWarned };
}

export function allStateFiles(root = projectDir()) {
  try {
    return fs
      .readdirSync(stateDir(root))
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(stateDir(root), f));
  } catch {
    return [];
  }
}

export function gcStates(maxAgeMs, root = projectDir()) {
  const cutoff = Date.now() - maxAgeMs;
  for (const f of allStateFiles(root)) {
    try {
      if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f);
    } catch {}
  }
}

// ---------- 全局项目注册表（供全局面板/报表聚合所有项目） ----------

export function globalHome() {
  return process.env.CURSOR_TOKEN_SAVER_HOME || path.join(os.homedir(), '.cursor-token-saver');
}

export function registryPath() {
  return path.join(globalHome(), 'projects.json');
}

export function loadRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    if (Array.isArray(raw.projects)) return { excluded: [], ...raw };
  } catch {}
  return { projects: [], excluded: [] };
}

function saveRegistry(reg) {
  fs.mkdirSync(globalHome(), { recursive: true });
  fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2) + '\n');
}

// 把项目登记到全局注册表；init 和每次 sessionStart 都会调用（幂等、失败静默）。
// 被面板剔除（excluded）的项目不会被 sessionStart 自动登记回来；
// 显式重跑 init 时传 force=true，视为用户想恢复管理。
export function registerProject(root = projectDir(), { force = false } = {}) {
  try {
    const abs = path.resolve(root);
    // 只登记真正装过 token-saver 的项目
    if (!fs.existsSync(configPath(abs))) return;
    const reg = loadRegistry();
    if (reg.excluded.includes(abs)) {
      if (!force) return;
      reg.excluded = reg.excluded.filter((p) => p !== abs);
    }
    const now = new Date().toISOString();
    const existing = reg.projects.find((p) => p.path === abs);
    if (existing) existing.lastSeen = now;
    else reg.projects.push({ path: abs, name: path.basename(abs), addedAt: now, lastSeen: now });
    saveRegistry(reg);
  } catch {}
}

// 从面板剔除项目：移出注册表并记入 excluded，不动项目磁盘上的任何文件
export function unregisterProject(root) {
  const abs = path.resolve(root);
  const reg = loadRegistry();
  reg.projects = reg.projects.filter((p) => p.path !== abs);
  if (!reg.excluded.includes(abs)) reg.excluded.push(abs);
  saveRegistry(reg);
}

// 自动同步脚本副本：包升级后，下次会话开始时把新版 hooks 复制进项目，
// 无需手动重跑 init。返回更新的文件数；任何一步失败都静默放弃（fail-open）。
export function syncHookScripts(root = projectDir()) {
  try {
    const { packageRoot } = JSON.parse(
      fs.readFileSync(path.join(root, '.cursor', 'token-saver', 'pkg.json'), 'utf8')
    );
    const srcDir = path.join(packageRoot, 'src', 'hooks');
    const dstDir = path.join(root, '.cursor', 'hooks', 'token-saver');
    if (!fs.existsSync(srcDir) || !fs.existsSync(dstDir)) return 0;
    let updated = 0;
    for (const name of fs.readdirSync(srcDir)) {
      if (!name.endsWith('.mjs')) continue;
      const src = fs.readFileSync(path.join(srcDir, name));
      let same = false;
      try {
        same = src.equals(fs.readFileSync(path.join(dstDir, name)));
      } catch {}
      if (!same) {
        fs.writeFileSync(path.join(dstDir, name), src);
        updated++;
      }
    }
    return updated;
  } catch {
    return 0;
  }
}

// 全局面板设置（计价等），存 ~/.cursor-token-saver/settings.json
export const DEFAULT_SETTINGS = {
  priceName: 'Claude Sonnet', // 计价用的模型名（仅展示）
  pricePerMTokUsd: 3, // 每百万输入 token 的美元价
  usdToCny: 7.2
};

export function settingsPath() {
  return path.join(globalHome(), 'settings.json');
}

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s) {
  fs.mkdirSync(globalHome(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + '\n');
}

// 返回注册表中仍然存在于磁盘的项目（顺带清掉失效条目）
export function liveProjects() {
  const reg = loadRegistry();
  const live = reg.projects.filter((p) => {
    try {
      return fs.existsSync(configPath(p.path));
    } catch {
      return false;
    }
  });
  if (live.length !== reg.projects.length) {
    try {
      fs.mkdirSync(globalHome(), { recursive: true });
      fs.writeFileSync(registryPath(), JSON.stringify({ ...reg, projects: live }, null, 2) + '\n');
    } catch {}
  }
  return live;
}

export function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export async function readInput() {
  try {
    return JSON.parse(await readStdin());
  } catch {
    return null;
  }
}

export function respond(obj) {
  try {
    process.stdout.write(JSON.stringify(obj ?? {}));
  } catch {}
}
