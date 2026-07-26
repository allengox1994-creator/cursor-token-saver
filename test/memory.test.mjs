// 项目语义记忆单元测试：保存/合并去重/CJK 检索/stale 检测/确认/衰减
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  saveMemory,
  loadMemories,
  searchMemories,
  topMemories,
  confirmMemory,
  archiveMemory,
  updateMemory,
  deleteMemory,
  decayMemories,
  mergeMemories,
  memoryOverview,
  extractRunbookMemory,
  worldQuery,
  isStale,
  memTokens
} from '../src/hooks/memory-store.mjs';
import { scanWorld, maybeScanWorld } from '../src/hooks/world-scan.mjs';

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-saver-memory-'));
  process.env.CURSOR_TOKEN_SAVER_HOME = path.join(root, '.global-home'); // 全局库隔离到临时目录
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'auth.ts'), 'export const provider = "AuthProvider";\n');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('memTokens 同时覆盖英文词和 CJK bigram', () => {
  const tokens = memTokens('构建命令是 pnpm build:web');
  assert.ok(tokens.includes('pnpm'));
  assert.ok(tokens.includes('build'));
  assert.ok(tokens.includes('构建'));
  assert.ok(tokens.includes('命令'));
});

test('保存记忆：agent 保存为 active，挂载文件记录哈希', () => {
  const res = saveMemory(root, {
    text: '鉴权统一走 AuthProvider，其他入口是废弃副本',
    kind: 'convention',
    files: ['src/auth.ts']
  });
  assert.equal(res.merged, false);
  assert.match(res.memory.id, /^mem_[a-f0-9]{12}$/);
  assert.equal(res.memory.status, 'active');
  assert.ok(res.memory.files[0].hash, '应记录文件哈希用于 stale 检测');
});

test('相似文本合并而不是新增；auto 提取只生成 candidate 且不自我确认', () => {
  const merged = saveMemory(root, {
    text: '鉴权统一走 AuthProvider，其他的入口是废弃副本',
    kind: 'convention'
  });
  assert.equal(merged.merged, true, '高相似度应合并');
  assert.equal(loadMemories(root).memories.length, 1);

  const auto = saveMemory(root, { text: '选择 vitest 而不是 jest：启动快 3 倍', source: 'auto' });
  assert.equal(auto.memory.status, 'candidate');
  assert.equal(auto.memory.lastConfirmedAt, null);

  // auto 重复提取合并进现有条目，但不应把 candidate 升级为 active
  const again = saveMemory(root, { text: '选择 vitest 而不是 jest：启动快 3 倍', source: 'auto' });
  assert.equal(again.merged, true);
  assert.equal(again.memory.status, 'candidate', '机械重复提取不能自我确认');
});

test('检索：中文查询命中中英混合记忆，命中即续期', () => {
  const hits = searchMemories(root, '鉴权在哪里处理');
  assert.ok(hits.length >= 1);
  assert.match(hits[0].text, /AuthProvider/);
  assert.ok(hits[0].uses >= 1, '召回应累计 uses');

  const en = searchMemories(root, 'vitest jest');
  assert.match(en[0].text, /vitest/);

  assert.equal(searchMemories(root, 'kubernetes helm chart').length, 0, '无关查询不应有命中');
});

test('stale 检测：挂载文件变化后标记过期，confirm 刷新哈希恢复', () => {
  fs.appendFileSync(path.join(root, 'src', 'auth.ts'), '// changed\n');
  const m = loadMemories(root).memories.find((x) => x.text.includes('AuthProvider'));
  assert.equal(isStale(root, m), true, '文件变化后应过期');

  confirmMemory(root, m.id);
  const fresh = loadMemories(root).memories.find((x) => x.id === m.id);
  assert.equal(isStale(root, fresh), false, '确认后按当前内容刷新哈希');
  assert.equal(fresh.status, 'active');
});

test('topMemories：active 在前 candidate 殿后并带 stale 标记', () => {
  const top = topMemories(root, { max: 10 });
  assert.ok(top.length >= 2);
  const statuses = top.map((m) => m.status);
  assert.ok(statuses.indexOf('candidate') > statuses.indexOf('active'));
  assert.ok(top.every((m) => typeof m.stale === 'boolean'));
});

test('编辑/归档/删除', () => {
  const { memory } = saveMemory(root, { text: 'temp memory for crud', kind: 'fact' });
  const upd = updateMemory(root, memory.id, { text: 'edited memory text', kind: 'gotcha' });
  assert.equal(upd.memory.text, 'edited memory text');
  assert.equal(upd.memory.kind, 'gotcha');

  archiveMemory(root, memory.id);
  assert.equal(loadMemories(root).memories.find((x) => x.id === memory.id).status, 'archived');
  assert.ok(!searchMemories(root, 'edited memory text').length, '归档条目不进检索');

  deleteMemory(root, memory.id);
  assert.ok(!loadMemories(root).memories.find((x) => x.id === memory.id));
  assert.ok(deleteMemory(root, memory.id).error, '重复删除报错');
});

test('全局作用域：存到全局库、不挂文件、跨查询召回并带 scope 标记', () => {
  const res = saveMemory(root, { text: 'always use pnpm for all my projects', kind: 'convention', files: ['src/auth.ts'], scope: 'global' });
  assert.equal(res.memory.scope, 'global');
  assert.deepEqual(res.memory.files, [], '全局记忆不应挂项目文件');
  assert.equal(loadMemories(root, { scope: 'global' }).memories.length, 1);
  assert.ok(!loadMemories(root).memories.find((m) => m.id === res.memory.id), '不应写进项目库');

  const hits = searchMemories(root, 'pnpm');
  const hit = hits.find((h) => h.id === res.memory.id);
  assert.ok(hit, '项目内检索应能召回全局记忆');
  assert.equal(hit.scope, 'global');
  assert.equal(hit.stale, false);

  // 按 ID 的操作能找到全局库里的条目
  assert.ok(!updateMemory(root, res.memory.id, { text: 'always use pnpm, never npm or yarn' }).error);
});

test('merge：多条记忆整合成一条，原条目归档且保留溯源', () => {
  const a = saveMemory(root, { text: 'tests live under test/ directory', kind: 'convention' }).memory;
  const b = saveMemory(root, { text: 'run node --test to execute the suite', kind: 'convention' }).memory;
  const res = mergeMemories(root, [a.id, b.id], { text: 'Tests live in test/, run with node --test', kind: 'convention' });
  assert.ok(!res.error, res.error);
  assert.equal(res.memory.status, 'active');
  assert.deepEqual(res.memory.mergedFrom.sort(), [a.id, b.id].sort());

  const data = loadMemories(root);
  assert.equal(data.memories.find((x) => x.id === a.id).status, 'archived');
  assert.equal(data.memories.find((x) => x.id === a.id).mergedInto, res.memory.id);
  assert.ok(res.memory.uses >= 0);

  // 跨作用域拒绝合并；不足两条拒绝
  const g = loadMemories(root, { scope: 'global' }).memories[0];
  assert.ok(mergeMemories(root, [res.memory.id, g.id], { text: 'x' }).error, '跨作用域应报错');
  assert.ok(mergeMemories(root, [res.memory.id], { text: 'x' }).error);
});

test('memoryOverview：合并两库并输出效果度量', () => {
  const view = memoryOverview(root);
  assert.ok(view.memories.some((m) => m.scope === 'global'));
  assert.ok(view.memories.some((m) => m.scope === 'project'));
  const st = view.stats;
  assert.ok(st.active >= 1 && st.archived >= 2, `active=${st.active} archived=${st.archived}`);
  assert.equal(typeof st.neverRecalled, 'number');
  assert.equal(typeof st.totalRecalls, 'number');
  assert.equal(typeof st.stale, 'number');
});

test('关系记忆：triple 强制 relation 类型并自动生成文本', () => {
  const res = saveMemory(root, { triple: { s: 'api.example.com', r: 'proxies-to', o: 'port 9501' }, files: ['src/auth.ts'] });
  assert.equal(res.memory.kind, 'relation');
  assert.equal(res.memory.text, 'api.example.com --proxies-to--> port 9501');
  assert.deepEqual(res.memory.triple, { s: 'api.example.com', r: 'proxies-to', o: 'port 9501' });
  assert.ok(res.memory.files[0].hash, '关系记忆同样挂证据哈希');
  assert.ok(saveMemory(root, { triple: { s: 'x', r: '', o: 'y' } }).error, '不完整三元组应报错');
});

test('worldQuery：实体匹配一跳 + 相连实体二跳，无关关系不进子图', () => {
  saveMemory(root, { triple: { s: 'api-service', r: 'listens-on', o: 'port 9501' } });
  saveMemory(root, { triple: { s: 'api-service', r: 'depends-on', o: 'redis' } });
  saveMemory(root, { triple: { s: 'web.example.com', r: 'proxies-to', o: 'port 3000' } });

  const hits = worldQuery(root, '9501');
  const texts = hits.map((h) => h.text);
  assert.ok(texts.some((t) => t.includes('api.example.com')), '直接命中一跳');
  assert.ok(texts.some((t) => t.includes('listens-on')), '同实体的关系一跳');
  const dep = hits.find((h) => h.text.includes('redis'));
  assert.ok(dep && dep.hop === 2, 'api-service 相连的依赖应作为二跳收入');
  assert.ok(!texts.some((t) => t.includes('port 3000')), '无关实体不应进子图');
  assert.ok(hits.every((h) => typeof h.stale === 'boolean' && h.triple));
});

test('runbook 提取：exit 0 命令序列成为候选技能，复发提升置信度', () => {
  const cp = {
    goal: 'deploy the api service',
    events: [
      { type: 'command', command: 'npm run build', exitCode: 0 },
      { type: 'command', command: 'npm run build', exitCode: 0 }, // 连续重复只留一次
      { type: 'command', command: 'ssh deploy@host bad', exitCode: 1 }, // 失败不进步骤
      { type: 'file-edit', file: 'x.ts' },
      { type: 'command', command: 'npm test', exitCode: 0 }
    ]
  };
  const skill = extractRunbookMemory(root, cp);
  assert.ok(skill, '应提取 runbook');
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.status, 'candidate');
  assert.deepEqual(skill.steps, ['npm run build', 'npm test']);
  assert.equal(skill.confidence, 1);

  const again = extractRunbookMemory(root, cp);
  assert.equal(again.id, skill.id, '相同 runbook 合并');
  assert.equal(again.confidence, 2, '复发应提升置信度');
  assert.equal(again.status, 'candidate', '复发不能自我确认');

  assert.equal(extractRunbookMemory(root, { goal: 'x', events: [{ type: 'command', command: 'one', exitCode: 0 }] }), null, '单命令不算流程');
  assert.equal(extractRunbookMemory(root, { events: cp.events }), null, '无目标不提取');
});

test('world-scan：从 package.json/compose/nginx/env/CI 机械提取候选关系，重扫不膨胀', () => {
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'token-saver-worldscan-'));
  fs.writeFileSync(
    path.join(root2, 'package.json'),
    JSON.stringify({ name: 'demo', main: 'src/index.js', scripts: { dev: 'node src/index.js', build: 'tsc -p .' } })
  );
  fs.writeFileSync(
    path.join(root2, 'docker-compose.yml'),
    'services:\n  api:\n    image: node:20\n    ports:\n      - "8080:3000"\n    depends_on:\n      - redis\n  redis:\n    image: redis:7\n'
  );
  fs.mkdirSync(path.join(root2, 'nginx'));
  fs.writeFileSync(
    path.join(root2, 'nginx', 'api.conf'),
    'upstream backend {\n  server 127.0.0.1:9501;\n}\nserver {\n  listen 443 ssl;\n  server_name api.example.com;\n  location / {\n    proxy_pass http://backend;\n  }\n}\n'
  );
  fs.writeFileSync(path.join(root2, '.env.example'), 'DB_HOST=localhost\nAPI_KEY=\n# comment\n');
  fs.mkdirSync(path.join(root2, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root2, '.github', 'workflows', 'ci.yml'), 'name: CI\non: [push, pull_request]\njobs: {}\n');

  const saved = scanWorld(root2);
  assert.ok(saved >= 8, `应提取多条关系（实际 ${saved}）`);
  const mems = loadMemories(root2).memories;
  assert.ok(mems.every((m) => m.kind === 'relation' && m.status === 'candidate'), '机械提取全部是候选关系');
  const texts = mems.map((m) => m.text);
  assert.ok(texts.includes('npm run build --executes--> tsc -p .'));
  assert.ok(texts.includes('demo --entrypoint--> src/index.js'));
  assert.ok(texts.includes('api --listens-on--> port 8080:3000'));
  assert.ok(texts.includes('api --depends-on--> redis'));
  assert.ok(texts.includes('api.example.com --listens-on--> port 443'));
  assert.ok(texts.includes('api.example.com --proxies-to--> http://backend'));
  assert.ok(texts.includes('upstream backend --proxies-to--> 127.0.0.1:9501'));
  assert.ok(texts.some((t) => t.startsWith('.env.example --defines--> DB_HOST')));
  assert.ok(texts.includes('CI CI --triggered-by--> push, pull_request'));

  const before = mems.length;
  scanWorld(root2);
  assert.equal(loadMemories(root2).memories.length, before, '重扫相似合并，不重复膨胀');

  // 节流入口：写 stamp，24h 内不再扫
  fs.rmSync(path.join(root2, '.cursor'), { recursive: true, force: true });
  assert.ok(maybeScanWorld(root2) > 0);
  assert.ok(fs.existsSync(path.join(root2, '.cursor', 'token-saver', 'world-scan.json')));
  assert.equal(maybeScanWorld(root2), 0, '24h 内重复调用直接跳过');
  fs.rmSync(root2, { recursive: true, force: true });
});

test('衰减：长期未用归档，candidate 更快过期，总量封顶', () => {
  const data = loadMemories(root);
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const mid = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  for (const m of data.memories) {
    if (m.status === 'active') Object.assign(m, { createdAt: old, lastConfirmedAt: old, lastRecalledAt: old });
    if (m.status === 'candidate') Object.assign(m, { createdAt: mid, lastConfirmedAt: null, lastRecalledAt: null });
  }
  fs.writeFileSync(path.join(root, '.cursor', 'token-saver', 'memory.json'), JSON.stringify(data, null, 2));

  const archived = decayMemories(root, { decayDays: 45, maxActive: 200 });
  assert.ok(archived >= 2, `60 天未用的 active 和 20 天未确认的 candidate 都应归档（实际 ${archived}）`);
  assert.ok(loadMemories(root).memories.every((m) => m.status === 'archived'));
});
