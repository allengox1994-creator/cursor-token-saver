// 全局后台测试：注册表、跨项目聚合、全局面板 API
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(pkgRoot, 'bin', 'cli.mjs');

let base;
let projA;
let projB;
let server;
let baseUrl;

function writeStats(proj, events) {
  const dir = path.join(proj, '.cursor', 'token-saver');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stats.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'token-saver-global-'));
  process.env.CURSOR_TOKEN_SAVER_HOME = path.join(base, 'global-home');
  projA = path.join(base, 'proj-a');
  projB = path.join(base, 'proj-b');
  fs.mkdirSync(projA);
  fs.mkdirSync(projB);

  for (const p of [projA, projB]) {
    const res = spawnSync('node', [cli, 'init', '--dir', p], { encoding: 'utf8', env: process.env });
    assert.equal(res.status, 0, `init 失败: ${res.stderr}`);
  }

  writeStats(projA, [
    { ts: '2026-07-13T01:00:00Z', hook: 'read-guard', action: 'deny-oversize', file: 'a.js', savedBytes: 4000, savedTokens: 1000 },
    { ts: '2026-07-13T02:00:00Z', hook: 'session-track', action: 'session_start' }
  ]);
  writeStats(projB, [
    { ts: '2026-07-13T03:00:00Z', hook: 'print-log', action: 'truncate', savedBytes: 800, savedTokens: 200 },
    { ts: '2026-07-13T04:00:00Z', hook: 'read-guard', action: 'deny-repeat', file: 'a.js', savedBytes: 1200, savedTokens: 300 }
  ]);

  const { start } = await import('../src/dashboard/server.mjs');
  server = start(projA, 0);
  await new Promise((resolve) => server.on('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

test('init 把项目登记进全局注册表', () => {
  const reg = JSON.parse(
    fs.readFileSync(path.join(process.env.CURSOR_TOKEN_SAVER_HOME, 'projects.json'), 'utf8')
  );
  const paths = reg.projects.map((p) => p.path).sort();
  assert.deepEqual(paths, [projA, projB].sort());
  for (const p of reg.projects) {
    assert.ok(p.name && p.addedAt && p.lastSeen);
  }
});

test('GET /api/projects 返回所有存活项目', async () => {
  const data = await (await fetch(`${baseUrl}/api/projects`)).json();
  assert.equal(data.projects.length, 2);
});

test('GET /api/summary?project=all 聚合全部项目', async () => {
  const s = await (await fetch(`${baseUrl}/api/summary?project=all`)).json();
  assert.equal(s.project, 'all');
  assert.equal(s.totals.savedTokens, 1500);
  assert.equal(s.totals.events, 4);
  assert.equal(s.perProject.length, 2);
  // 按节省量排序：proj-a (1000) 在前
  assert.equal(s.perProject[0].name, 'proj-a');
  assert.equal(s.perProject[0].totals.savedTokens, 1000);
  // 同名文件带项目前缀，不混在一起
  const files = s.topFiles.map((f) => f.file).sort();
  assert.deepEqual(files, ['proj-a: a.js', 'proj-b: a.js']);
  // 事件带项目名
  assert.ok(s.recent.every((e) => e.project === 'proj-a' || e.project === 'proj-b'));
});

test('GET /api/summary?project=<path> 只看单项目', async () => {
  const s = await (await fetch(`${baseUrl}/api/summary?project=${encodeURIComponent(projB)}`)).json();
  assert.equal(s.project, projB);
  assert.equal(s.totals.savedTokens, 500);
  assert.equal(s.totals.events, 2);
});

test('配置读写按项目隔离，且拒绝注册表之外的路径', async () => {
  const putRes = await fetch(`${baseUrl}/api/config?project=${encodeURIComponent(projB)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profile: 'extreme',
      hooks: {},
      overrides: {},
      contextQuery: { defaultBudgetChars: 3200, previewChars: 120 },
      artifactStore: { ttlMs: 86400000, maxBytes: 10485760 },
      taskBudget: { maxTokens: 40000, warnAtPercent: 70, hardLimit: true }
    })
  });
  assert.equal((await putRes.json()).ok, true);

  const bCfg = await (await fetch(`${baseUrl}/api/config?project=${encodeURIComponent(projB)}`)).json();
  assert.equal(bCfg.config.profile, 'extreme');
  assert.equal(bCfg.config.contextQuery.defaultBudgetChars, 3200);
  assert.equal(bCfg.config.taskBudget.maxTokens, 40000);
  assert.equal(bCfg.config.taskBudget.hardLimit, false, '服务端强制关闭硬限制，避免损害能力');
  const aCfg = await (await fetch(`${baseUrl}/api/config?project=${encodeURIComponent(projA)}`)).json();
  assert.equal(aCfg.config.profile, 'standard', 'A 项目配置不应被影响');

  const evil = await fetch(`${baseUrl}/api/config?project=${encodeURIComponent(os.tmpdir())}`);
  assert.equal(evil.status, 404);
});

test('计价设置读写 + 报表费用换算', async () => {
  const def = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.equal(def.settings.pricePerMTokUsd, 3, '默认 $3/M');

  const put = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priceName: 'Claude Opus', pricePerMTokUsd: 15, usdToCny: 7 })
  });
  assert.equal((await put.json()).ok, true);
  const got = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.equal(got.settings.pricePerMTokUsd, 15);

  // 报表用保存后的价：1500 tokens * $15/M * 7 = ¥0.16
  const res = spawnSync('node', [cli, 'report', '--all'], { encoding: 'utf8', env: process.env });
  assert.match(res.stdout, /≈ 省 ¥0\.16/);
  assert.match(res.stdout, /Claude Opus/);
});

test('summary 返回嵌入模型信息', async () => {
  fs.mkdirSync(path.join(projA, '.cursor', 'token-saver'), { recursive: true });
  fs.writeFileSync(
    path.join(projA, '.cursor', 'token-saver', 'embed-index.json'),
    JSON.stringify({ model: 'transformers:test-model', files: {} })
  );
  const one = await (await fetch(`${baseUrl}/api/summary?project=${encodeURIComponent(projA)}`)).json();
  assert.equal(one.embedModel, 'transformers:test-model');
  const all = await (await fetch(`${baseUrl}/api/summary?project=all`)).json();
  const pa = all.perProject.find((p) => p.path === projA);
  assert.equal(pa.embedModel, 'transformers:test-model');
});

test('GET /api/index 返回索引概况与逐文件状态', async () => {
  // 无索引的项目
  const none = await (await fetch(`${baseUrl}/api/index?project=${encodeURIComponent(projB)}`)).json();
  assert.equal(none.exists, false);

  // 构造：fresh.js 新鲜、changed.js 过期、new.js 未索引、gone.js 已删除
  fs.writeFileSync(path.join(projA, 'fresh.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(projA, 'changed.js'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(projA, 'new.js'), 'export const c = 3;\n');
  const st = fs.statSync(path.join(projA, 'fresh.js'));
  const chunk = { start: 1, end: 1, v: 'AA==', s: 1 };
  fs.writeFileSync(
    path.join(projA, '.cursor', 'token-saver', 'embed-index.json'),
    JSON.stringify({
      schemaVersion: 2,
      model: 'transformers:test-model',
      files: {
        'fresh.js': { stamp: `${st.mtimeMs}:${st.size}`, contentHash: 'fresh', chunks: [chunk, chunk] },
        'changed.js': { stamp: '0:0', contentHash: 'changed', chunks: [chunk] },
        'gone.js': { stamp: '0:0', contentHash: 'gone', chunks: [chunk] }
      }
    })
  );

  // 自动索引心跳（用本测试进程的 pid 模拟存活的 MCP 服务器）
  fs.writeFileSync(
    path.join(projA, '.cursor', 'token-saver', 'embed-status.json'),
    JSON.stringify({ pid: process.pid, state: 'ready', lastCheck: '2026-07-15T06:00:00Z', lastBuild: null, embedded: 0 })
  );

  const data = await (await fetch(`${baseUrl}/api/index?project=${encodeURIComponent(projA)}`)).json();
  assert.equal(data.exists, true);
  assert.equal(data.model, 'transformers:test-model');
  assert.equal(data.auto.state, 'ready');
  assert.equal(data.auto.alive, true, '心跳 pid 存活时 alive 应为 true');
  assert.ok(data.updatedAt && data.sizeBytes > 0);
  assert.deepEqual(data.totals, { ok: 1, stale: 1, new: 1, deleted: 1, chunks: 4 });

  const byRel = Object.fromEntries(data.files.map((f) => [f.rel, f]));
  assert.equal(byRel['fresh.js'].status, 'ok');
  assert.equal(byRel['fresh.js'].chunks, 2);
  assert.equal(byRel['changed.js'].status, 'stale');
  assert.equal(byRel['new.js'].status, 'new');
  assert.equal(byRel['gone.js'].status, 'deleted');
  // 待处理的排在前面
  assert.equal(data.files[data.files.length - 1].rel, 'fresh.js');
});

test('GET /api/context 返回证据、预算与检查点统计且不暴露 blob 路径', async () => {
  const store = path.join(projA, '.cursor', 'token-saver', 'context-store');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(
    path.join(store, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: '2026-07-15T08:00:00Z',
      entries: {
        art_abc: {
          id: 'art_abc',
          kind: 'shell-log',
          blob: 'blobs/secret.txt',
          bytes: 123,
          createdAt: '2026-07-15T08:00:00Z',
          accessedAt: '2026-07-15T08:00:00Z'
        }
      }
    })
  );
  const stateDir = path.join(projA, '.cursor', 'token-saver', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'budget.json'), JSON.stringify({ budget: { usedTokens: 321 } }));
  const summaryDir = path.join(projA, '.cursor', 'token-saver', 'summaries');
  fs.mkdirSync(summaryDir, { recursive: true });
  fs.writeFileSync(path.join(summaryDir, 'c.json'), '{}');
  fs.writeFileSync(
    path.join(projA, '.cursor', 'token-saver', 'eval-report.json'),
    JSON.stringify({ generatedAt: '2026-07-15T08:00:00Z', cases: 10, hitAt1: 0.8, hitAt5: 1, mrr: 0.9, backend: 'fake' })
  );
  fs.writeFileSync(
    path.join(projA, '.cursor', 'token-saver', 'eval-status.json'),
    JSON.stringify({ state: 'scheduled', dueAt: '2026-07-16T08:00:00Z', reason: 'index build' })
  );
  fs.mkdirSync(process.env.CURSOR_TOKEN_SAVER_HOME, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.CURSOR_TOKEN_SAVER_HOME, 'daemon.json'),
    JSON.stringify({ pid: process.pid, port: 4518, startedAt: '2026-07-15T08:00:00Z' })
  );

  const data = await (await fetch(`${baseUrl}/api/context?project=${encodeURIComponent(projA)}`)).json();
  assert.equal(data.store.entries, 1);
  assert.equal(data.store.artifacts, 1);
  assert.equal(data.budget.maxUsedTokens, 321);
  assert.equal(data.checkpoints, 1);
  assert.equal(data.daemon.alive, true);
  assert.equal(data.evaluation.hitAt5, 1);
  assert.equal(data.evaluationStatus.state, 'scheduled');
  assert.equal(data.recent[0].id, 'art_abc');
  assert.equal('blob' in data.recent[0], false, 'API 不应返回内部 blob 路径');
});

test('记忆 API：查看/确认/编辑/删除按项目隔离', async () => {
  const { saveMemory } = await import('../src/hooks/memory-store.mjs');
  const { memory } = saveMemory(projA, { text: 'projA uses pnpm not npm', kind: 'convention' });
  const auto = saveMemory(projA, { text: 'decided to keep express for dashboard', kind: 'decision', source: 'auto' });

  const list = await (await fetch(`${baseUrl}/api/memory?project=${encodeURIComponent(projA)}`)).json();
  assert.equal(list.memories.length, 2);
  assert.ok(list.memories.every((m) => typeof m.stale === 'boolean'));
  assert.equal(list.stats.active, 1);
  assert.equal(list.stats.candidate, 1);
  assert.equal(typeof list.stats.neverRecalled, 'number');
  assert.equal(typeof list.stats.totalRecalls, 'number');
  assert.equal(typeof list.stats.relations, 'number');
  assert.equal(typeof list.stats.skills, 'number');
  assert.equal(typeof list.stats.skillReuse, 'number');

  // 确认候选
  const confirmRes = await fetch(`${baseUrl}/api/memory?project=${encodeURIComponent(projA)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: auto.memory.id, action: 'confirm' })
  });
  assert.equal((await confirmRes.json()).memory.status, 'active');

  // 编辑文本
  const editRes = await fetch(`${baseUrl}/api/memory?project=${encodeURIComponent(projA)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: memory.id, text: 'projA uses pnpm exclusively' })
  });
  assert.equal((await editRes.json()).memory.text, 'projA uses pnpm exclusively');

  // 删除 + 未注册项目 404
  const del = await fetch(`${baseUrl}/api/memory?project=${encodeURIComponent(projA)}&id=${memory.id}`, { method: 'DELETE' });
  assert.equal((await del.json()).ok, true);
  const bad = await fetch(`${baseUrl}/api/memory?project=/nope`, { method: 'DELETE' });
  assert.equal(bad.status, 404);
});

test('report --all 输出全局汇总', () => {
  const res = spawnSync('node', [cli, 'report', '--all'], { encoding: 'utf8', env: process.env });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /全局报表\s+\(2 个项目\)/);
  assert.match(res.stdout, /1,500 tokens/);
  assert.match(res.stdout, /proj-a/);
  assert.match(res.stdout, /proj-b/);
});

test('删掉的项目会被注册表自动清理', async () => {
  fs.rmSync(projB, { recursive: true, force: true });
  const data = await (await fetch(`${baseUrl}/api/projects`)).json();
  assert.deepEqual(data.projects.map((p) => p.path), [projA]);
  const s = await (await fetch(`${baseUrl}/api/summary?project=all`)).json();
  assert.equal(s.totals.savedTokens, 1000);
});

test('DELETE /api/projects 剔除项目且 sessionStart 不会自动加回，重跑 init 可恢复', async () => {
  // 注册表之外的路径返回 404
  const bad = await fetch(`${baseUrl}/api/projects?project=${encodeURIComponent('/nope')}`, { method: 'DELETE' });
  assert.equal(bad.status, 404);

  const res = await fetch(`${baseUrl}/api/projects?project=${encodeURIComponent(projA)}`, { method: 'DELETE' });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.deepEqual(data.projects, []);

  // 项目磁盘文件不受影响，只是进了 excluded 名单
  assert.ok(fs.existsSync(path.join(projA, '.cursor', 'token-saver.json')), '项目本身的安装不应被删除');
  const reg = JSON.parse(fs.readFileSync(path.join(process.env.CURSOR_TOKEN_SAVER_HOME, 'projects.json'), 'utf8'));
  assert.deepEqual(reg.excluded, [projA]);

  // 普通登记（sessionStart 路径）不会把剔除的项目加回来
  const { registerProject } = await import('../src/hooks/_lib.mjs');
  registerProject(projA);
  const after = await (await fetch(`${baseUrl}/api/projects`)).json();
  assert.deepEqual(after.projects, [], '剔除后 sessionStart 不应自动登记');

  // 显式重跑 init 视为恢复管理
  const init = spawnSync('node', [cli, 'init', '--dir', projA], { encoding: 'utf8', env: process.env });
  assert.equal(init.status, 0);
  const restored = await (await fetch(`${baseUrl}/api/projects`)).json();
  assert.deepEqual(restored.projects.map((p) => p.path), [projA]);
  const reg2 = JSON.parse(fs.readFileSync(path.join(process.env.CURSOR_TOKEN_SAVER_HOME, 'projects.json'), 'utf8'));
  assert.deepEqual(reg2.excluded, [], '恢复后应移出 excluded 名单');
});
