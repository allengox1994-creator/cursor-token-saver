// MCP repo map 服务器测试：init 装进临时项目后，走真实 stdio JSON-RPC 验证协议与三个工具
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(pkgRoot, 'bin', 'cli.mjs');

let tmp;
let server;
let nextId = 1;
const pending = new Map(); // id -> resolve

function rpc(method, params) {
  const id = nextId++;
  const p = new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`rpc ${method} 超时`));
    }, 5000);
  });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return p;
}

async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  assert.ok(res.result, `tools/call ${name} 应有 result: ${JSON.stringify(res)}`);
  assert.equal(res.result.isError, false);
  return res.result.content[0].text;
}

function setToolDedupe(ms) {
  const cfgPath = path.join(tmp, '.cursor', 'token-saver.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.contextQuery = { ...(cfg.contextQuery || {}), toolDedupeMs: ms };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-saver-mcp-'));
  process.env.CURSOR_TOKEN_SAVER_HOME = path.join(tmp, '.global-home');
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(
    path.join(tmp, 'src', 'app.ts'),
    [
      'export interface User { id: number }',
      'export type UserMap = Record<number, User>;',
      'export class UserService {',
      '  find(id: number) { return null; }',
      '}',
      'export async function loadUsers(): Promise<User[]> {',
      '  return [];',
      '}',
      'const helper = (x: number) => x * 2;',
      'export const MAGIC_TOKEN_XYZ = 42;'
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(tmp, 'src', 'util.py'),
    ['class Parser:', '    def parse(self, text):', '        return text', '', 'async def fetch_data(url):', '    pass'].join('\n')
  );
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'not a source file');
  // 重要性排序 fixture：core.ts 被 extra.ts 引用，应排在未被引用的文件前面
  fs.writeFileSync(path.join(tmp, 'src', 'core.ts'), 'export function coreThing() { return 1; }\n');
  fs.writeFileSync(
    path.join(tmp, 'src', 'extra.ts'),
    "import { coreThing } from './core';\nexport const useIt = () => coreThing();\n"
  );
  // read_compact fixture：注释、空行、超长字符串
  fs.writeFileSync(
    path.join(tmp, 'src', 'messy.js'),
    [
      '// header comment',
      'const A = 1;',
      '',
      '/* block',
      '   comment */',
      `const LONG = "${'x'.repeat(120)}";`,
      'function go() {',
      '  return A;',
      '}'
    ].join('\n')
  );

  const res = spawnSync('node', [cli, 'init', '--dir', tmp, '--profile', 'standard'], { encoding: 'utf8' });
  assert.equal(res.status, 0, `init 失败: ${res.stderr}`);

  // 多数用例会用相同参数重复调工具并断言完整输出，先关掉结果去重（专项用例再临时打开）
  setToolDedupe(0);

  // 测试用确定性伪嵌入后端，避免依赖模型下载
  server = spawn('node', [path.join(tmp, '.cursor', 'hooks', 'token-saver', 'mcp-repo-map.mjs')], {
    cwd: tmp,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TOKEN_SAVER_EMBED_BACKEND: 'fake' }
  });
  let buf = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
});

after(() => {
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('init 注册了 mcp.json 并复制了服务器脚本', () => {
  const mcp = JSON.parse(fs.readFileSync(path.join(tmp, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers['repo-map'], {
    command: 'node',
    args: ['.cursor/hooks/token-saver/mcp-repo-map.mjs']
  });
  assert.ok(fs.existsSync(path.join(tmp, '.cursor', 'hooks', 'token-saver', 'symbols.mjs')));
});

test('initialize 握手返回协议版本与 serverInfo', async () => {
  const res = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' }
  });
  assert.equal(res.result.protocolVersion, '2024-11-05');
  assert.equal(res.result.serverInfo.name, 'token-saver-repo-map');
  assert.ok(res.result.capabilities.tools);
  // initialized 通知不应产生响应
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

test('tools/list 默认只暴露统一无损工具，legacy 定义隐藏但仍可调用', async () => {
  const res = await rpc('tools/list', {});
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['context_checkpoint', 'context_expand', 'context_query', 'memory_save', 'test_select']);

  // legacyTools=true 时恢复展示全部 9 个
  const cfgPath = path.join(tmp, '.cursor', 'token-saver.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.contextQuery = { ...(cfg.contextQuery || {}), legacyTools: true };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  try {
    const all = await rpc('tools/list', {});
    assert.deepEqual(all.result.tools.map((t) => t.name).sort(), [
      'context_checkpoint',
      'context_expand',
      'context_query',
      'file_outline',
      'memory_save',
      'read_compact',
      'repo_map',
      'semantic_search',
      'smart_search',
      'test_select'
    ]);
  } finally {
    delete cfg.contextQuery.legacyTools;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  }

  // 隐藏不等于禁用：未列出的 legacy 工具通过 tools/call 依然可用
  const outline = await callTool('file_outline', { file: 'src/app.ts' });
  assert.match(outline, /loadUsers/);
  for (const t of res.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 20);
  }
});

test('repo_map 返回 TS 与 Python 的符号和行号', async () => {
  const text = await callTool('repo_map', {});
  assert.match(text, /src\/app\.ts \[\d+L\]/);
  assert.match(text, /3 export class UserService/);
  assert.match(text, /6 export async function loadUsers/);
  assert.match(text, /1 export interface User/);
  assert.match(text, /9 const helper/);
  assert.match(text, /src\/util\.py/);
  assert.match(text, /class Parser/);
  assert.match(text, /async def fetch_data/);
  assert.ok(!text.includes('notes.txt'), '非源码文件不应出现');
});

test('repo_map 按重要性排序：被引用的文件排在前面', async () => {
  const text = await callTool('repo_map', {});
  const posCore = text.indexOf('src/core.ts');
  const posApp = text.indexOf('src/app.ts');
  const posExtra = text.indexOf('src/extra.ts');
  assert.ok(posCore >= 0 && posApp >= 0 && posExtra >= 0);
  assert.ok(posCore < posApp && posCore < posExtra, 'core.ts 被引用，应排最前');
});

test('read_compact 去掉注释/空行并保留原始行号', async () => {
  const text = await callTool('read_compact', { file: 'src/messy.js' });
  assert.match(text, /compact view \(5\/9 lines kept/);
  assert.match(text, /2\|const A = 1;/);
  assert.match(text, /7\|function go\(\)/);
  assert.ok(!text.includes('header comment'), '行注释应被去掉');
  assert.ok(!text.includes('block'), '块注释应被去掉');
  assert.match(text, /6\|const LONG = "x{60}…"/, '超长字符串应被折叠');
  const stats = fs
    .readFileSync(path.join(tmp, '.cursor', 'token-saver', 'stats.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const ev = stats.find((e) => e.action === 'read_compact');
  assert.ok(ev && ev.savedTokens > 0, '应记录节省量');
});

test('semantic_search 混合检索命中并落盘嵌入索引', async () => {
  const text = await callTool('semantic_search', { query: 'load users' });
  assert.match(text, /src\/app\.ts/);
  assert.match(text, /export async function loadUsers/);
  assert.match(text, /hybrid: neural embeddings \+ BM25/, 'fake 后端下应走混合检索');
  const idxPath = path.join(tmp, '.cursor', 'token-saver', 'embed-index.json');
  assert.ok(fs.existsSync(idxPath), '嵌入索引应落盘');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  assert.equal(idx.model, 'fake');
  assert.ok(Object.keys(idx.files).length >= 3);
  const anyChunk = Object.values(idx.files)[0].chunks[0];
  assert.ok(anyChunk.v && typeof anyChunk.s === 'number', '向量应为 Int8 量化存储');

  // 纯停用词查询：无有效 token，向量与 BM25 都应为空
  const none = await callTool('semantic_search', { query: 'the and with that' });
  assert.match(none, /no matches/);
});

test('semantic_search 文件修改后增量重嵌', async () => {
  const newFile = path.join(tmp, 'src', 'billing.ts');
  fs.writeFileSync(newFile, 'export function calculateInvoiceTotal(items: number[]) {\n  return items.reduce((a, b) => a + b, 0);\n}\n');
  const text = await callTool('semantic_search', { query: 'calculate invoice total' });
  assert.match(text, /src\/billing\.ts/, '新文件应被增量嵌入并命中');
  const idx = JSON.parse(fs.readFileSync(path.join(tmp, '.cursor', 'token-saver', 'embed-index.json'), 'utf8'));
  assert.ok(idx.files['src/billing.ts'], '索引应包含新文件');
});

test('repo_map 支持子目录聚焦与预算截断提示', async () => {
  const focused = await callTool('repo_map', { path: 'src' });
  assert.match(focused, /focus=src/);
  const missing = await callTool('repo_map', { path: 'no-such-dir' });
  assert.match(missing, /path not found/);
});

test('file_outline 返回单文件大纲', async () => {
  const text = await callTool('file_outline', { file: 'src/app.ts' });
  assert.match(text, /src\/app\.ts — 10 lines, \d+ symbols/);
  assert.match(text, /3 export class UserService/);
  const bad = await callTool('file_outline', { file: 'nope.ts' });
  assert.match(bad, /not found/);
});

test('smart_search 返回 path:line 紧凑结果', async () => {
  const text = await callTool('smart_search', { query: 'MAGIC_TOKEN_XYZ' });
  assert.match(text, /src\/app\.ts:10:/);
  const none = await callTool('smart_search', { query: 'definitely_not_present_zzz' });
  assert.match(none, /no matches/);
});

test('context_query 三路检索返回稳定证据 ID，可精确展开并去重', async () => {
  const first = await callTool('context_query', {
    mode: 'search',
    query: 'load users',
    max_results: 3,
    conversation_id: 'context-conv'
  });
  assert.match(first, /confidence=/);
  assert.match(first, /sources=.*(?:exact|bm25|vector)/);
  const id = first.match(/\b(src_[a-f0-9]{12})\b/)?.[1];
  assert.ok(id, '应返回源码证据 ID');

  const exact = await callTool('context_expand', { id, level: 'exact', conversation_id: 'context-conv' });
  assert.match(exact, /exact=true/);
  assert.match(exact, /loadUsers|User/);

  const repeated = await callTool('context_query', {
    mode: 'search',
    query: 'load users',
    max_results: 3,
    conversation_id: 'context-conv'
  });
  assert.match(repeated, /already_sent/, '同会话相同内容不应再次内联');
});

test('context_query callgraph、read 与 checkpoint', async () => {
  const graph = await callTool('context_query', {
    mode: 'callgraph',
    file: 'src/core.ts',
    direction: 'callers'
  });
  assert.match(graph, /approximate import\/reference graph/);
  assert.match(graph, /src\/extra\.ts/);
  assert.match(graph, /src_[a-f0-9]{12}/);

  const read = await callTool('context_query', { mode: 'read', file: 'src/messy.js', start_line: 1, end_line: 9 });
  assert.match(read, /exact=src_[a-f0-9]{12}/);
  assert.ok(!read.includes('header comment'));

  await callTool('context_checkpoint', {
    action: 'save',
    conversation_id: 'cp-1',
    goal: 'verify context tools',
    status: 'working',
    files_touched: ['src/app.ts'],
    decisions: ['keep legacy tools']
  });
  const checkpoint = await callTool('context_checkpoint', { action: 'get', conversation_id: 'cp-1' });
  assert.match(checkpoint, /verify context tools/);
  assert.match(checkpoint, /keep legacy tools/);
});

test('Git diff 与测试选择在非 Git 项目安全回退', async () => {
  const diff = await callTool('context_query', { mode: 'diff' });
  assert.match(diff, /git unavailable|not a Git worktree/i);
  assert.match(diff, /no reliable changed-file set/i);
  const tests = await callTool('test_select', { phase: 'final' });
  assert.match(tests, /confidence=none/);
  assert.match(tests, /Fallback active/);
});

test('context_expand 检测源码证据过期', async () => {
  const result = await callTool('context_query', {
    mode: 'search',
    query: 'MAGIC_TOKEN_XYZ',
    max_results: 1,
    conversation_id: 'stale-conv'
  });
  const id = result.match(/\b(src_[a-f0-9]{12})\s+src\/app\.ts:/)?.[1];
  assert.ok(id);
  const appPath = path.join(tmp, 'src', 'app.ts');
  fs.writeFileSync(appPath, fs.readFileSync(appPath, 'utf8').replace('MAGIC_TOKEN_XYZ = 42', 'MAGIC_TOKEN_XYZ = 99'));
  const stale = await callTool('context_expand', { id, level: 'exact' });
  assert.match(stale, /STALE/);
});

test('context_query mode=read symbol：目标符号全文 + 其余骨架', async () => {
  const text = await callTool('context_query', { mode: 'read', file: 'src/app.ts', symbol: 'UserService' });
  assert.match(text, /symbol=UserService lines 3-5/);
  assert.match(text, /exact=src_[a-f0-9]{12}/);
  assert.match(text, /find\(id: number\)/, '目标符号的函数体应完整');
  assert.match(text, /skeleton after/);
  assert.match(text, /6 export async function loadUsers/, '其余符号折叠为骨架行');
  assert.ok(!text.includes('return [];'), '其他符号的函数体不应传输');

  const miss = await callTool('context_query', { mode: 'read', file: 'src/app.ts', symbol: 'UserServ' });
  assert.match(miss, /not found/);
  assert.match(miss, /Close matches:/);
  assert.match(miss, /UserService/);
});

test('context_query mode=profile：数据文件结构画像 + 无损回取', async () => {
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'data', 'users.json'),
    JSON.stringify(
      {
        version: 2,
        users: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `user-${i}`, tags: ['a', 'b'] })),
        settings: { theme: 'dark', magicNumber: 12345 }
      },
      null,
      2
    )
  );
  const text = await callTool('context_query', { mode: 'profile', file: 'data/users.json' });
  assert.match(text, /profile data\/users\.json — json/);
  assert.match(text, /array\[200\] of object/);
  assert.match(text, /id: number/);
  assert.match(text, /settings:/);
  assert.ok(!text.includes('user-150'), '不应内联全部数据');
  const id = text.match(/exact=(src_[a-f0-9]{12})/)?.[1];
  assert.ok(id, '画像应带证据 ID');
  const rec = await callTool('context_expand', { id, regex: 'user-150', radius: 1 });
  assert.match(rec, /user-150/, '任意原始记录可按正则精确回取');

  fs.writeFileSync(
    path.join(tmp, 'data', 'rows.csv'),
    'id,name,score\n' + Array.from({ length: 50 }, (_, i) => `${i},n${i},${i * 2}`).join('\n') + '\n'
  );
  const csv = await callTool('context_query', { mode: 'profile', file: 'data/rows.csv' });
  assert.match(csv, /— csv/);
  assert.match(csv, /50 data rows, 3 columns/);
  assert.match(csv, /header: id, name, score/);
  assert.ok(!csv.includes('n25,'), '中段数据行不应传输');
});

test('只读工具结果去重：短窗口内相同结果只回标记 + artifact ID', async () => {
  setToolDedupe(10 * 60 * 1000);
  try {
    const first = await callTool('repo_map', { budget_chars: 9000 });
    assert.match(first, /src\/core\.ts/, '首次调用返回完整结果');
    const second = await callTool('repo_map', { budget_chars: 9000 });
    assert.match(second, /byte-identical to your call/);
    assert.match(second, /context_expand \{id:"art_[a-f0-9]{12}"/, '完整结果可按 ID 无损回取');
    assert.ok(!second.includes('src/util.py'), '重复内容不应再次内联');

    // 底层数据变化 → 结果哈希变化 → 正常返回新结果
    fs.writeFileSync(path.join(tmp, 'src', 'fresh.ts'), 'export function freshlyAdded() { return 1; }\n');
    const third = await callTool('repo_map', { budget_chars: 9000 });
    assert.match(third, /fresh\.ts/, '数据变化后不去重');

    const stats = fs
      .readFileSync(path.join(tmp, '.cursor', 'token-saver', 'stats.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const ev = stats.find((e) => e.action === 'tool_dedup');
    assert.ok(ev && ev.savedBytes > 0, '应记录 tool_dedup 节省事件');
  } finally {
    setToolDedupe(0);
  }
});

test('memory_save 保存/确认/遗忘，context_query mode=memory 召回并检测 stale', async () => {
  fs.writeFileSync(path.join(tmp, 'src', 'memfile.ts'), 'export const BUILD = "npm run build:web";\n');
  const saved = await callTool('memory_save', {
    text: 'Build command is npm run build:web, never plain npm build',
    kind: 'convention',
    files: ['src/memfile.ts']
  });
  const memId = saved.match(/\b(mem_[a-f0-9]{12})\b/)?.[1];
  assert.ok(memId, `应返回记忆 ID: ${saved}`);

  const recall = await callTool('context_query', { mode: 'memory', query: 'how to build' });
  assert.match(recall, /npm run build:web/);
  assert.match(recall, /\[convention\]/);
  assert.ok(!recall.includes('STALE: linked files changed'), '文件未变不应标记过期');

  // 挂载文件变化 → 召回时明确标记 STALE；confirm 后恢复
  fs.appendFileSync(path.join(tmp, 'src', 'memfile.ts'), '// changed\n');
  const staleRecall = await callTool('context_query', { mode: 'memory', query: 'build command' });
  assert.match(staleRecall, /STALE: linked files changed/);
  await callTool('memory_save', { action: 'confirm', id: memId });
  const confirmed = await callTool('context_query', { mode: 'memory', query: 'build command' });
  assert.ok(!confirmed.includes('STALE: linked files changed'), 'confirm 后应按当前文件刷新哈希');

  // checkpoint 的 decisions 已被机械提取为候选记忆
  const candidates = await callTool('context_query', { mode: 'memory', query: 'keep legacy tools' });
  assert.match(candidates, /unconfirmed/, '机械提取的决策应是待确认候选');

  // forget 归档后不再出现在检索里
  await callTool('memory_save', { action: 'forget', id: memId });
  const gone = await callTool('context_query', { mode: 'memory', query: 'how to build' });
  assert.ok(!gone.includes(memId), '归档条目不应再被召回');

  const stats = fs
    .readFileSync(path.join(tmp, '.cursor', 'token-saver', 'stats.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(stats.some((e) => e.action === 'memory_save'), '应记录 memory_save 事件');
  assert.ok(stats.some((e) => e.action === 'memory_recall'), '应记录 memory_recall 事件');
});

test('memory_save merge 整合与 scope=global 跨项目记忆', async () => {
  const a = (await callTool('memory_save', { text: 'API routes are defined in src/routes', kind: 'entrypoint' })).match(/\b(mem_[a-f0-9]{12})\b/)?.[1];
  const b = (await callTool('memory_save', { text: 'Route handlers must return typed responses', kind: 'convention' })).match(/\b(mem_[a-f0-9]{12})\b/)?.[1];
  assert.ok(a && b);
  const merged = await callTool('memory_save', {
    action: 'merge',
    ids: [a, b],
    text: 'Routes live in src/routes; handlers must return typed responses',
    kind: 'convention'
  });
  assert.match(merged, /Merged 2 memories into mem_[a-f0-9]{12}/);
  assert.match(merged, /originals archived with provenance/);

  const globalSaved = await callTool('memory_save', { text: 'User prefers pnpm across all projects', kind: 'convention', scope: 'global' });
  assert.match(globalSaved, /\(global, cross-project\)/);
  const recall = await callTool('context_query', { mode: 'memory', query: 'pnpm preference' });
  assert.match(recall, /\[global\]/, '召回应标注全局作用域');
});

test('memory_save triple 存关系，context_query mode=world 返回实体子图', async () => {
  const saved = await callTool('memory_save', { triple: { s: 'api.demo.com', r: 'proxies-to', o: 'port 9501' } });
  assert.match(saved, /\[relation\]/);
  await callTool('memory_save', { triple: { s: 'api-svc', r: 'listens-on', o: 'port 9501' } });
  await callTool('memory_save', { triple: { s: 'api-svc', r: 'depends-on', o: 'redis-cache' } });

  const world = await callTool('context_query', { mode: 'world', query: '9501' });
  assert.match(world, /api\.demo\.com --proxies-to--> port 9501/);
  assert.match(world, /hop1 .*api-svc --listens-on--> port 9501/);
  assert.match(world, /hop2 .*api-svc --depends-on--> redis-cache/, '相连实体应二跳收入');

  const miss = await callTool('context_query', { mode: 'world', query: 'nonexistent-entity-zzz' });
  assert.match(miss, /no relations match/);
});

test('检索融合：mode=search 结果自动附带高相关记忆', async () => {
  await callTool('memory_save', { text: 'MAGIC_TOKEN_XYZ is the feature flag for the beta rollout', kind: 'fact' });
  const out = await callTool('context_query', { mode: 'search', query: 'MAGIC_TOKEN_XYZ' });
  assert.match(out, /related memory:/, '代码命中之外应附带相关记忆');
  assert.match(out, /feature flag for the beta rollout/);
});

test('checkpoint 收尾自动提取 runbook 候选技能', async () => {
  const conv = 'runbook-conv';
  // 预置命令时间线（真实场景由 shell-audit hook 写入）
  fs.mkdirSync(path.join(tmp, '.cursor', 'token-saver', 'summaries'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.cursor', 'token-saver', 'summaries', `${conv}.json`),
    JSON.stringify({
      schemaVersion: 1,
      conversationId: conv,
      createdAt: new Date().toISOString(),
      events: [
        { at: new Date().toISOString(), type: 'command', command: 'npm run build', exitCode: 0 },
        { at: new Date().toISOString(), type: 'command', command: 'npm run deploy:staging', exitCode: 0 },
        { at: new Date().toISOString(), type: 'command', command: 'curl -f https://staging.demo.com/health', exitCode: 0 }
      ]
    })
  );
  const out = await callTool('context_checkpoint', {
    conversation_id: conv,
    goal: 'deploy the demo service to staging',
    status: 'done'
  });
  assert.match(out, /Runbook candidate extracted .* (mem_[a-f0-9]{12})/);

  const mem = JSON.parse(fs.readFileSync(path.join(tmp, '.cursor', 'token-saver', 'memory.json'), 'utf8'));
  const skill = mem.memories.find((m) => m.kind === 'skill');
  assert.ok(skill, '应生成技能记忆');
  assert.equal(skill.status, 'candidate');
  assert.match(skill.text, /Runbook: deploy the demo service to staging/);
  assert.deepEqual(skill.steps, ['npm run build', 'npm run deploy:staging', 'curl -f https://staging.demo.com/health']);

  // 未收尾的 checkpoint 不提取
  const cont = await callTool('context_checkpoint', { conversation_id: conv, goal: 'next thing', status: 'in progress' });
  assert.ok(!/Runbook candidate/.test(cont));
  // 清理本测试的检查点，避免抢占后续 bootstrap 测试的"最新检查点"
  fs.rmSync(path.join(tmp, '.cursor', 'token-saver', 'summaries', `${conv}.json`), { force: true });
});

test('context_query mode=bootstrap 返回新会话热启动包', async () => {
  const text = await callTool('context_query', { mode: 'bootstrap' });
  assert.match(text, /CONTEXT BOOTSTRAP/);
  assert.match(text, /verify context tools/, '应包含最近的检查点目标');
  assert.match(text, /git: not a repository/, '非 Git 项目如实说明');
  assert.match(text, /project memory/, '应包含项目记忆条目');
  assert.match(text, /recent evidence/, '应列出最近证据 ID');
  assert.match(text, /src_[a-f0-9]{12}/);
});

test('并发 context_query 请求都能完成且 manifest 不损坏', async () => {
  const [a, b] = await Promise.all([
    callTool('context_query', { mode: 'search', query: 'core thing', conversation_id: 'parallel-a' }),
    callTool('context_query', { mode: 'outline', file: 'src/extra.ts', conversation_id: 'parallel-b' })
  ]);
  assert.match(a, /CONTEXT QUERY/);
  assert.match(b, /CONTEXT QUERY outline/);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(tmp, '.cursor', 'token-saver', 'context-store', 'manifest.json'), 'utf8')
  );
  assert.ok(Object.keys(manifest.entries).length >= 2);
});

test('未知方法返回 -32601，服务器不退出', async () => {
  const res = await rpc('bogus/method', {});
  assert.equal(res.error.code, -32601);
  assert.equal(server.exitCode, null, '服务器应保持运行');
});

test('服务器启动后自动建索引（无需调用 semantic_search）', async () => {
  // 独立项目 + 独立服务器，缩短自动建索延迟到 150ms
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'token-saver-auto-'));
  fs.writeFileSync(path.join(tmp2, 'main.js'), 'export function autoIndexedThing() { return 42; }\n');
  const init = spawnSync('node', [cli, 'init', '--dir', tmp2], { encoding: 'utf8', env: process.env });
  assert.equal(init.status, 0);

  const auto = spawn('node', [path.join(tmp2, '.cursor', 'hooks', 'token-saver', 'mcp-repo-map.mjs')], {
    cwd: tmp2,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TOKEN_SAVER_EMBED_BACKEND: 'fake', TOKEN_SAVER_AUTO_DELAY_MS: '150' }
  });
  try {
    const idxPath = path.join(tmp2, '.cursor', 'token-saver', 'embed-index.json');
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(idxPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(idxPath), '索引应被自动建立');
    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    assert.equal(idx.model, 'fake');
    assert.ok(idx.files['main.js'], '应包含源码文件');

    // 心跳状态文件：面板据此展示自动索引是否在运行
    const statusPath = path.join(tmp2, '.cursor', 'token-saver', 'embed-status.json');
    assert.ok(fs.existsSync(statusPath), '应写入 embed-status.json 心跳');
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(status.state, 'ready');
    assert.equal(status.pid, auto.pid);
    assert.ok(status.lastBuild, '首次构建应记录 lastBuild');
    const evalStatus = JSON.parse(
      fs.readFileSync(path.join(tmp2, '.cursor', 'token-saver', 'eval-status.json'), 'utf8')
    );
    assert.equal(evalStatus.state, 'scheduled');
    assert.match(evalStatus.reason, /index build/);

    // 首次构建应留下 index_build 统计事件
    const stats = fs.readFileSync(path.join(tmp2, '.cursor', 'token-saver', 'stats.jsonl'), 'utf8');
    assert.ok(stats.includes('"index_build"'), '应记录 index_build 事件');
  } finally {
    auto.kill();
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

test('工具调用写入了统计事件', () => {
  const statsFile = path.join(tmp, '.cursor', 'token-saver', 'stats.jsonl');
  const events = fs
    .readFileSync(statsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.hook === 'mcp-repo-map');
  const actions = new Set(events.map((e) => e.action));
  for (const a of [
    'repo_map',
    'file_outline',
    'smart_search',
    'semantic_search',
    'read_compact',
    'context_query',
    'context_expand',
    'context_checkpoint',
    'test_select'
  ]) {
    assert.ok(actions.has(a), `应有 ${a} 事件`);
  }
  // read_compact/tool_dedup 记录 savedBytes，索引构建/刷新记录 files，
  // 记忆事件记录 hits/op，其余记录输出 bytes
  const sizeField = (e) =>
    e.action === 'read_compact' || e.action === 'tool_dedup'
      ? e.savedBytes
      : e.action === 'index_build' || e.action === 'index_refresh'
        ? e.files
        : e.action === 'memory_recall'
          ? e.hits
          : e.bytes;
  assert.ok(events.filter((e) => e.action !== 'memory_save').every((e) => typeof sizeField(e) === 'number'));
});
