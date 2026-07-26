// 从 stats.jsonl 聚合出面板和报表需要的所有数据
import fs from 'node:fs';
import path from 'node:path';
import { statsPath } from '../hooks/_lib.mjs';

// 该项目语义搜索当前使用的嵌入模型（无索引则为 null）
export function embedModelFor(root) {
  try {
    const idx = JSON.parse(
      fs.readFileSync(path.join(root, '.cursor', 'token-saver', 'embed-index.json'), 'utf8')
    );
    return idx.model || null;
  } catch {
    return null;
  }
}

export function readEvents(root) {
  let raw = '';
  try {
    raw = fs.readFileSync(statsPath(root), 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

export function aggregate(root) {
  return aggregateEvents(readEvents(root));
}

// 全局聚合：合并多个项目的事件（每条事件打上 project 名），并附带按项目的汇总
export function aggregateAll(projects) {
  const perProject = [];
  let all = [];
  for (const p of projects) {
    const events = readEvents(p.path).map((e) => ({ ...e, project: p.name }));
    const agg = aggregateEvents(events);
    perProject.push({
      path: p.path,
      name: p.name,
      lastSeen: p.lastSeen,
      lastEventTs: events.length > 0 ? events[events.length - 1].ts : null,
      embedModel: embedModelFor(p.path),
      totals: agg.totals
    });
    all = all.concat(events);
  }
  all.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  perProject.sort((a, b) => b.totals.savedTokens - a.totals.savedTokens);
  return { ...aggregateEvents(all), perProject };
}

export function aggregateEvents(events) {
  const totals = {
    savedTokens: 0,
    savedBytes: 0,
    denies: 0,
    caps: 0,
    truncates: 0,
    rewrites: 0,
    sessions: 0,
    compactions: 0,
    originalBytes: 0,
    transmittedBytes: 0,
    dedupHits: 0,
    expands: 0,
    artifactRecoveries: 0,
    budgetWarnings: 0,
    events: events.length
  };
  const daily = new Map();
  const byAction = {};
  const savedByHook = {};
  const fileMap = new Map();
  const commandMap = new Map();
  const compactions = [];

  for (const e of events) {
    const saved = typeof e.savedTokens === 'number' ? e.savedTokens : 0;
    totals.savedTokens += saved;
    totals.savedBytes += typeof e.savedBytes === 'number' ? e.savedBytes : 0;
    totals.originalBytes += typeof e.originalBytes === 'number' ? e.originalBytes : 0;
    totals.transmittedBytes += typeof e.transmittedBytes === 'number' ? e.transmittedBytes : 0;
    totals.dedupHits += typeof e.deduplicated === 'number' ? e.deduplicated : 0;
    if (e.action === 'context_expand') totals.expands += 1;
    if (e.action === 'artifact_recover') totals.artifactRecoveries += 1;
    if (e.budgetWarned) totals.budgetWarnings += 1;

    byAction[e.action] = (byAction[e.action] || 0) + 1;
    if (saved > 0) savedByHook[e.hook] = (savedByHook[e.hook] || 0) + saved;

    if (e.action === 'deny' || e.action === 'deny-repeat') totals.denies += 1;
    if (e.action === 'cap' || e.action === 'deny-oversize') totals.caps += 1;
    if (e.action === 'truncate') totals.truncates += 1;
    if (e.action === 'rewrite') totals.rewrites += 1;
    if (e.action === 'session_start') totals.sessions += 1;
    if (e.action === 'compact') {
      totals.compactions += 1;
      compactions.push({
        ts: e.ts,
        context_tokens: e.context_tokens,
        context_usage_percent: e.context_usage_percent,
        trigger: e.trigger
      });
    }

    const day = typeof e.ts === 'string' ? e.ts.slice(0, 10) : 'unknown';
    const d = daily.get(day) || { date: day, savedTokens: 0, events: 0 };
    d.savedTokens += saved;
    d.events += 1;
    daily.set(day, d);

    if (e.file && saved > 0) {
      // 全局聚合时带项目前缀，避免不同项目的同名文件混在一起
      const fileKey = e.project ? `${e.project}: ${e.file}` : e.file;
      const f = fileMap.get(fileKey) || { file: fileKey, savedTokens: 0, count: 0 };
      f.savedTokens += saved;
      f.count += 1;
      fileMap.set(fileKey, f);
    }
    if (e.action === 'observe' && e.command) {
      const c = commandMap.get(e.command) || { command: e.command, bytes: 0, count: 0 };
      c.bytes += typeof e.bytes === 'number' ? e.bytes : 0;
      c.count += 1;
      commandMap.set(e.command, c);
    }
  }

  return {
    totals,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byAction,
    savedByHook,
    topFiles: [...fileMap.values()].sort((a, b) => b.savedTokens - a.savedTokens).slice(0, 10),
    topCommands: [...commandMap.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    compactions: compactions.slice(-20),
    // 放行读取（action=read）是高频观测事件，只进浪费洞察，不刷屏最近事件流
    recent: events.filter((e) => e.action !== 'read').slice(-80).reverse()
  };
}

// ---------- 浪费洞察：找出"没省到"的地方，给出校准建议 ----------

const DATA_EXT_RE = /\.(json|jsonl|ndjson|csv|tsv|log|txt|xml)$/i;
const WASTE_WINDOW_DAYS = 7;

export function wasteInsights(events) {
  const cutoff = Date.now() - WASTE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recent = events.filter((e) => typeof e.ts === 'string' && Date.parse(e.ts) >= cutoff);
  const keyOf = (e, base) => (e.project ? `${e.project}: ${base}` : base);

  // 1. 同一文件被多次放行的全量读（窗口外重复；每次都是全额 token）
  const readMap = new Map();
  let dataReads = 0;
  for (const e of recent) {
    if (e.action !== 'read' || !e.file) continue;
    const key = keyOf(e, e.file);
    const r = readMap.get(key) || { file: key, count: 0, bytes: 0 };
    r.count += 1;
    r.bytes = Math.max(r.bytes, e.bytes || 0);
    readMap.set(key, r);
    if (DATA_EXT_RE.test(e.file) && (e.bytes || 0) > 128 * 1024) dataReads += 1;
  }
  const repeatedReads = [...readMap.values()]
    .filter((r) => r.count >= 3)
    .map((r) => ({ ...r, wastedBytes: (r.count - 1) * r.bytes }))
    .sort((a, b) => b.wastedBytes - a.wastedBytes)
    .slice(0, 10);

  // 2. 未治理的高噪音命令（被 shell-guard 改写过的命令串包含 token-saver，天然排除）
  const cmdMap = new Map();
  for (const e of recent) {
    if (e.hook !== 'shell-audit' || e.action !== 'observe' || !e.command) continue;
    if (e.command.includes('token-saver') || e.command.includes('mktemp')) continue;
    const key = keyOf(e, e.command.split(/\s+/).slice(0, 3).join(' '));
    const c = cmdMap.get(key) || { command: key, count: 0, bytes: 0 };
    c.count += 1;
    c.bytes += e.bytes || 0;
    cmdMap.set(key, c);
  }
  const ungoverned = [...cmdMap.values()]
    .filter((c) => c.bytes >= 50 * 1024)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10);

  // 3. 拦截后被重试放行（override）最多的文件：高频 override 说明阈值拦错了
  const overrideMap = new Map();
  let denies = 0;
  let overrides = 0;
  for (const e of recent) {
    if (e.hook !== 'read-guard') continue;
    if (e.action === 'deny-oversize' || e.action === 'deny-repeat') denies += 1;
    if (e.action === 'override-allow') {
      overrides += 1;
      const key = keyOf(e, e.file || '');
      overrideMap.set(key, (overrideMap.get(key) || 0) + 1);
    }
  }
  const topOverrides = [...overrideMap.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const suggestions = [];
  if (repeatedReads.length) {
    const top = repeatedReads[0];
    suggestions.push(
      `「${top.file}」${WASTE_WINDOW_DAYS} 天内被全量读 ${top.count} 次（每次 ~${Math.round(top.bytes / 1024)}KB）。` +
        `重复间隔超过了拦截窗口——可调大 repeatReadWindowMs，或让 agent 改用 context_query mode=read/read_compact。`
    );
  }
  if (ungoverned.length) {
    const top = ungoverned[0];
    suggestions.push(
      `命令「${top.command}」累计产出 ${Math.round(top.bytes / 1024)}KB 未治理输出（${top.count} 次）。` +
        `不在 shell-guard 白名单内——考虑让 agent 重定向到文件后 grep，或反馈加入白名单。`
    );
  }
  if (denies >= 4 && overrides / denies > 0.5) {
    suggestions.push(
      `拦截后被重试放行的比例偏高（${overrides}/${denies}）。agent 坚持要全文说明阈值拦错了——` +
        `考虑调大 readMaxLines 或缩短重复读窗口。`
    );
  }
  if (dataReads > 0) {
    suggestions.push(
      `有 ${dataReads} 次大数据文件（json/csv/log 等 >128KB）全量读。agent 可用 context_query mode=profile 拿结构画像，再按正则/行区间精确回取。`
    );
  }
  if (!suggestions.length) suggestions.push('过去 7 天没有发现明显的浪费点，当前配置与实际使用匹配良好。');

  return { windowDays: WASTE_WINDOW_DAYS, repeatedReads, ungoverned, topOverrides, denies, overrides, suggestions };
}
