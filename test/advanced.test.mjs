import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { buildGitDiffPack } from '../src/hooks/git-context.mjs';
import { selectTests } from '../src/hooks/test-selector.mjs';
import { extractImports } from '../src/hooks/analyze.mjs';
import { extractSymbols, EXT_LANG } from '../src/hooks/symbols.mjs';
import { lspQuery } from '../src/hooks/lsp-bridge.mjs';
import { startDaemon } from '../src/embed/daemon-server.mjs';
import { getDaemonEmbedder } from '../src/embed/daemon-client.mjs';
import { evaluateRetrieval } from '../src/eval/retrieval-eval.mjs';
import { startAll } from '../src/start-all.mjs';
import { scheduleAutoEval } from '../src/hooks/auto-eval.mjs';

let root;
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

function runtime() {
  const list = ['src/math.ts', 'src/math.test.ts'].map((f) => path.join(root, f));
  return {
    listFiles: () => list,
    symbolsFor(file) {
      const content = fs.readFileSync(file, 'utf8');
      const lang = EXT_LANG[path.extname(file)];
      return { ...extractSymbols(content, lang), imports: extractImports(file, content, lang, root) };
    }
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-saver-advanced-'));
  process.env.CURSOR_TOKEN_SAVER_HOME = path.join(root, '.global');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, '.cursor', 'token-saver'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { test: 'node --test' } })
  );
  fs.writeFileSync(
    path.join(root, 'src', 'math.ts'),
    [
      'export function addNumbers(a: number, b: number) { return a + b; }',
      'export function subtractNumbers(a: number, b: number) { return a - b; }',
      'export function multiplyNumbers(a: number, b: number) { return a * b; }',
      'export function divideNumbers(a: number, b: number) { return a / b; }',
      'export function clampNumber(a: number) { return Math.max(0, a); }'
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(root, 'src', 'math.test.ts'),
    "import { addNumbers } from './math';\ntest('add', () => addNumbers(1, 2));\n"
  );
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  fs.writeFileSync(
    path.join(root, 'src', 'math.ts'),
    fs.readFileSync(path.join(root, 'src', 'math.ts'), 'utf8').replace('a + b', 'Number(a) + Number(b)')
  );
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('Git Diff 上下文包保留完整 patch 并返回当前源码证据', () => {
  const out = buildGitDiffPack(root, {}, runtime());
  assert.match(out, /GIT DIFF CONTEXT base=HEAD files=1 full=art_/);
  assert.match(out, /modified src\/math\.ts/);
  assert.match(out, /evidence=src_/);
});

test('智能测试选择：迭代选相关测试，最终阶段强制全量', () => {
  const iter = selectTests(root, { phase: 'iterate' }, runtime());
  assert.match(iter, /confidence=high/);
  assert.match(iter, /command=npm test -- src\/math\.test\.ts/);
  assert.match(iter, /Always run full_command before final handoff/);
  const final = selectTests(root, { phase: 'final' }, runtime());
  assert.match(final, /command=npm test$/m);
  assert.match(final, /Fallback active/);
});

test('LSP 不可用时在短时间内返回可诊断回退', async () => {
  const oldPath = process.env.PATH;
  process.env.PATH = root; // 保证测试不依赖开发机是否安装 language server
  const started = Date.now();
  const result = await lspQuery(root, { file: 'src/math.ts', symbol: 'addNumbers', timeout_ms: 300 });
  process.env.PATH = oldPath;
  assert.equal(result.available, false);
  assert.match(result.reason, /unavailable|circuit/);
  assert.ok(Date.now() - started < 1000);
});

test('全局守护进程健康检查与嵌入协议', async () => {
  const server = startDaemon(0, {
    getBackend: async (model) => ({
      id: `transformers:${model}`,
      embed: async (texts) => texts.map((text) => Float32Array.from([text.length, 1]))
    })
  });
  await new Promise((resolve) => server.on('listening', resolve));
  const port = server.address().port;
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.ok, true);
  const embedded = await (
    await fetch(`http://127.0.0.1:${port}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'unit', texts: ['abc'] })
    })
  ).json();
  assert.deepEqual(embedded.vectors, [[3, 1]]);
  const oldPort = process.env.TOKEN_SAVER_DAEMON_PORT;
  process.env.TOKEN_SAVER_DAEMON_PORT = String(port);
  const client = await getDaemonEmbedder('unit', root);
  assert.equal(client.id, 'transformers:unit');
  assert.deepEqual(Array.from((await client.embed(['abcd']))[0]), [4, 1]);
  if (oldPort == null) delete process.env.TOKEN_SAVER_DAEMON_PORT;
  else process.env.TOKEN_SAVER_DAEMON_PORT = oldPort;
  await new Promise((resolve) => server.close(resolve));
});

test('离线检索评测生成 Hit@K/MRR，且不进入正常请求路径', async () => {
  const old = process.env.TOKEN_SAVER_EMBED_BACKEND;
  process.env.TOKEN_SAVER_EMBED_BACKEND = 'fake';
  const report = await evaluateRetrieval(root, { limit: 10 });
  if (old == null) delete process.env.TOKEN_SAVER_EMBED_BACKEND;
  else process.env.TOKEN_SAVER_EMBED_BACKEND = old;
  assert.ok(report.cases >= 5);
  assert.ok(report.hitAt1 >= 0 && report.hitAt1 <= 1);
  assert.ok(report.hitAt5 >= report.hitAt1);
  assert.ok(report.mrr >= 0 && report.mrr <= 1);
});

test('一键启动器后台拉起全部服务且重复执行不重复启动', async () => {
  const dashboardPort = await freePort();
  let daemonPort = await freePort();
  while (daemonPort === dashboardPort) daemonPort = await freePort();
  const first = await startAll({ dashboardPort, daemonPort });
  assert.equal(first.ok, true);
  assert.ok(first.services.every((service) => !service.alreadyRunning && service.pid));
  const second = await startAll({ dashboardPort, daemonPort });
  assert.equal(second.ok, true);
  assert.ok(second.services.every((service) => service.alreadyRunning));
  for (const service of first.services) {
    try {
      process.kill(service.pid);
    } catch {}
  }
});

test('索引变化会延迟调度自动评测，且不阻塞调用方', async () => {
  const oldDelay = process.env.TOKEN_SAVER_AUTO_EVAL_DELAY_MS;
  process.env.TOKEN_SAVER_AUTO_EVAL_DELAY_MS = '20';
  let runs = 0;
  const started = Date.now();
  const scheduled = scheduleAutoEval(root, {
    pkgRoot: process.cwd(),
    reason: 'unit index refresh',
    runner: async () => {
      runs++;
    }
  });
  assert.equal(scheduled.scheduled, true);
  assert.ok(Date.now() - started < 100);
  const deadline = Date.now() + 1000;
  while (!runs && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  if (oldDelay == null) delete process.env.TOKEN_SAVER_AUTO_EVAL_DELAY_MS;
  else process.env.TOKEN_SAVER_AUTO_EVAL_DELAY_MS = oldDelay;
  assert.equal(runs, 1);
  const status = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'token-saver', 'eval-status.json'), 'utf8'));
  assert.equal(status.state, 'starting');
  assert.match(status.reason, /unit index refresh/);
});
