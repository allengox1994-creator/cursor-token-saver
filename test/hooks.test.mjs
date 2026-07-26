// 端到端测试：先用 init 装进临时项目，再对安装后的 hook 脚本喂模拟 JSON 验证行为
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(pkgRoot, 'bin', 'cli.mjs');

let tmp;
const CONV = 'test-conv-1';

function runHook(script, payload, extraEnv = {}) {
  const res = spawnSync('node', [path.join(tmp, '.cursor', 'hooks', 'token-saver', script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CURSOR_PROJECT_DIR: tmp, ...extraEnv }
  });
  assert.equal(res.status, 0, `hook ${script} 应以 0 退出: ${res.stderr}`);
  try {
    return JSON.parse(res.stdout);
  } catch {
    assert.fail(`hook ${script} 输出不是 JSON: ${res.stdout}`);
  }
}

function statsEvents() {
  const p = path.join(tmp, '.cursor', 'token-saver', 'stats.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-saver-test-'));
  // 隔离全局注册表，避免测试污染真实的 ~/.cursor-token-saver
  process.env.CURSOR_TOKEN_SAVER_HOME = path.join(tmp, '.global-home');
  // 测试项目文件
  fs.writeFileSync(path.join(tmp, 'big.js'), Array.from({ length: 1200 }, (_, i) => `const line${i} = ${i};`).join('\n'));
  fs.writeFileSync(path.join(tmp, 'small.js'), 'export const a = 1;\nexport const b = 2;\n');
  fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  fs.writeFileSync(path.join(tmp, 'huge-data.json'), '[' + '1,'.repeat(400000) + '1]'); // ~800KB

  const res = spawnSync('node', [cli, 'init', '--dir', tmp, '--profile', 'standard'], { encoding: 'utf8' });
  assert.equal(res.status, 0, `init 失败: ${res.stderr}`);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('init 写入了所有文件', () => {
  for (const f of [
    '.cursor/hooks.json',
    '.cursor/hooks/token-saver/read-guard.mjs',
    '.cursor/hooks/token-saver/_lib.mjs',
    '.cursor/hooks/token-saver/context-store.mjs',
    '.cursor/hooks/token-saver/context-query.mjs',
    '.cursor/hooks/token-saver/auto-eval.mjs',
    '.cursor/hooks/token-saver/log-parser.mjs',
    '.cursor/hooks/token-saver/summary-store.mjs',
    '.cursor/hooks/token-saver/print-log.mjs',
    '.cursor/token-saver.json',
    '.cursor/rules/token-saver.mdc',
    '.cursorignore'
  ]) {
    assert.ok(fs.existsSync(path.join(tmp, f)), `缺少 ${f}`);
  }
  const hooks = JSON.parse(fs.readFileSync(path.join(tmp, '.cursor', 'hooks.json'), 'utf8'));
  assert.equal(hooks.version, 1);
  assert.equal(hooks.hooks.preToolUse.length, 2);
  const ignore = fs.readFileSync(path.join(tmp, '.cursorignore'), 'utf8');
  assert.match(ignore, /cursor-token-saver/);
  assert.match(ignore, /huge-data\.json/, '应扫描出超大文件');
});

test('init 幂等且保留用户已有 hooks', () => {
  const hooksPath = path.join(tmp, '.cursor', 'hooks.json');
  const before2 = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  before2.hooks.preToolUse.push({ command: 'echo user-hook' });
  fs.writeFileSync(hooksPath, JSON.stringify(before2));

  const res = spawnSync('node', [cli, 'init', '--dir', tmp], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  const after2 = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  const cmds = after2.hooks.preToolUse.map((e) => e.command);
  assert.ok(cmds.includes('echo user-hook'), '用户 hook 应保留');
  assert.equal(cmds.filter((c) => c.includes('read-guard')).length, 1, '不应重复添加');
});

test('read-guard: 超大文件全量读被拦截并指路', () => {
  const out = runHook('read-guard.mjs', {
    conversation_id: CONV,
    tool_name: 'Read',
    tool_input: { file_path: path.join(tmp, 'big.js') },
    cwd: tmp
  });
  assert.equal(out.permission, 'deny');
  assert.match(out.agent_message, /1,800p/);
  assert.match(out.agent_message, /context_query mode=outline\/read/, '应指向无损上下文工具');
  const ev = statsEvents().find((e) => e.action === 'deny-oversize');
  assert.ok(ev && ev.savedTokens > 0, '应记录 deny-oversize 事件');
});

test('read-guard: 拦截后立即重试同一文件强制放行（防锁死）', () => {
  const out = runHook('read-guard.mjs', {
    conversation_id: CONV,
    tool_name: 'Read',
    tool_input: { file_path: path.join(tmp, 'big.js') },
    cwd: tmp
  });
  assert.equal(out.permission, 'allow');
  const ev = statsEvents().find((e) => e.action === 'override-allow');
  assert.ok(ev, '应记录 override-allow 事件');
});

test('read-guard: 略超上限 25% 以内的文件放行', () => {
  const file = path.join(tmp, 'medium.js');
  fs.writeFileSync(file, Array.from({ length: 900 }, (_, i) => `const m${i} = ${i};`).join('\n'));
  const out = runHook('read-guard.mjs', {
    conversation_id: CONV,
    tool_name: 'Read',
    tool_input: { file_path: file },
    cwd: tmp
  });
  assert.equal(out.permission, 'allow'); // 900 < 800 * 1.25
});

test('read-guard: 带区间参数的读取放行（未来版本兼容）', () => {
  const out = runHook('read-guard.mjs', {
    conversation_id: CONV,
    tool_name: 'Read',
    tool_input: { file_path: path.join(tmp, 'big.js'), offset: 800, limit: 200 },
    cwd: tmp
  });
  assert.equal(out.permission, 'allow');
  assert.equal(out.updated_input, undefined);
});

test('read-guard: 重复读未修改文件被拦截，指路信息存在', () => {
  const payload = {
    conversation_id: CONV,
    tool_name: 'Read',
    tool_input: { file_path: path.join(tmp, 'small.js') },
    cwd: tmp
  };
  assert.equal(runHook('read-guard.mjs', payload).permission, 'allow'); // 第一次
  const second = runHook('read-guard.mjs', payload); // 立刻重复
  assert.equal(second.permission, 'deny');
  assert.match(second.agent_message, /grep/i);
});

test('read-guard: 文件 mtime 变化后允许重读', () => {
  // 用独立会话避免上个用例的 override 状态干扰
  const conv = 'mtime-conv';
  const file = path.join(tmp, 'small2.js');
  fs.writeFileSync(file, 'export const x = 1;\n');
  const payload = { conversation_id: conv, tool_name: 'Read', tool_input: { file_path: file }, cwd: tmp };

  assert.equal(runHook('read-guard.mjs', payload).permission, 'allow');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future); // 模拟外部修改
  assert.equal(runHook('read-guard.mjs', payload).permission, 'allow', 'mtime 变化后应放行');
});

test('edit-invalidate: 编辑后清除已读状态，允许重读', () => {
  const conv = 'edit-conv';
  const file = path.join(tmp, 'small3.js');
  fs.writeFileSync(file, 'export const y = 1;\n');
  const payload = { conversation_id: conv, tool_name: 'Read', tool_input: { file_path: file }, cwd: tmp };

  assert.equal(runHook('read-guard.mjs', payload).permission, 'allow'); // 第一次
  assert.equal(runHook('read-guard.mjs', payload).permission, 'deny'); // 重复被拦

  runHook('edit-invalidate.mjs', { conversation_id: conv, file_path: file, edits: [] });
  assert.equal(runHook('read-guard.mjs', payload).permission, 'allow', '编辑后应放行');
});

test('read-guard: 文件修改后重读只传无损增量差分', () => {
  const conv = 'delta-conv';
  const file = path.join(tmp, 'delta-file.js');
  fs.writeFileSync(file, Array.from({ length: 40 }, (_, i) => `const d${i} = ${i};`).join('\n'));
  const payload = { conversation_id: conv, tool_name: 'Read', tool_input: { file_path: file }, cwd: tmp };

  assert.equal(runHook('read-guard.mjs', payload).permission, 'allow', '首次全量读放行并留快照');

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[5] = 'const CHANGED_LINE = 999;';
  lines.push('const APPENDED_LINE = 1;');
  fs.writeFileSync(file, lines.join('\n'));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future); // 确保 mtime 变化被稳定检测

  const out = runHook('read-guard.mjs', payload);
  assert.equal(out.permission, 'deny', '变化后的重读应改为传差分');
  assert.match(out.agent_message, /Lossless line diff/);
  assert.match(out.agent_message, /@@ /);
  assert.match(out.agent_message, /\+const CHANGED_LINE = 999;/);
  assert.match(out.agent_message, /\+const APPENDED_LINE = 1;/);
  assert.ok(!out.agent_message.includes('const d20 ='), '未变化的行不应传输');
  assert.match(out.agent_message, /context_expand \{id:"art_[a-f0-9]{12}"/, '应给出可无损回取全文的快照 ID');
  const ev = statsEvents().find((e) => e.action === 'delta-read');
  assert.ok(ev && ev.savedBytes > 0 && ev.changedLines === 3, '应记录 delta-read 节省事件');

  assert.equal(runHook('read-guard.mjs', payload).permission, 'allow', '立即重试仍强制放行（防锁死）');
});

test('read-guard: agent 编辑后的重读走差分而不是全量', () => {
  const conv = 'delta-edit-conv';
  const file = path.join(tmp, 'delta-edit.js');
  fs.writeFileSync(file, Array.from({ length: 30 }, (_, i) => `let e${i} = ${i};`).join('\n'));
  const payload = { conversation_id: conv, tool_name: 'Read', tool_input: { file_path: file }, cwd: tmp };

  assert.equal(runHook('read-guard.mjs', payload).permission, 'allow');
  const modified = fs.readFileSync(file, 'utf8').replace('let e10 = 10;', 'let e10 = 42; // edited');
  fs.writeFileSync(file, modified);
  runHook('edit-invalidate.mjs', { conversation_id: conv, file_path: file, edits: [] });

  const out = runHook('read-guard.mjs', payload);
  assert.equal(out.permission, 'deny');
  assert.match(out.agent_message, /\+let e10 = 42; \/\/ edited/);
});

test('file-blocklist: 锁文件被拦，普通文件放行，用户附加放行', () => {
  const lock = path.join(tmp, 'package-lock.json');
  const denied = runHook('file-blocklist.mjs', {
    conversation_id: CONV,
    file_path: lock,
    content: fs.readFileSync(lock, 'utf8'),
    attachments: []
  });
  assert.equal(denied.permission, 'deny');

  const normal = runHook('file-blocklist.mjs', {
    conversation_id: CONV,
    file_path: path.join(tmp, 'small.js'),
    content: 'export const a = 1;',
    attachments: []
  });
  assert.equal(normal.permission, 'allow');

  const attached = runHook('file-blocklist.mjs', {
    conversation_id: CONV,
    file_path: lock,
    content: '{}',
    attachments: [{ type: 'file', file_path: lock }]
  });
  assert.equal(attached.permission, 'allow');
});

test('file-blocklist: 超大数据文件被拦并指向 mode=profile', () => {
  const data = path.join(tmp, 'huge-data.json');
  const out = runHook('file-blocklist.mjs', {
    conversation_id: CONV,
    file_path: data,
    content: fs.readFileSync(data, 'utf8'),
    attachments: []
  });
  assert.equal(out.permission, 'deny');
  assert.match(out.agent_message, /mode:"profile"/, '数据文件应指向结构画像');
});

test('shell-guard: 白名单噪音命令被改写为落盘+头尾回显', () => {
  const out = runHook('shell-guard.mjs', {
    conversation_id: CONV,
    tool_name: 'Shell',
    tool_input: { command: 'npm install' },
    cwd: tmp
  });
  assert.ok(out.updated_input, '应返回 updated_input');
  assert.match(out.updated_input.command, /mktemp/);
  assert.match(out.updated_input.command, /print-log\.mjs/);
  assert.match(out.updated_input.command, /exit \$__tse/);
});

test('shell-guard: 复杂语法和非白名单命令放行不改写', () => {
  for (const command of [
    'npm install && ls dist', // 链中含非白名单段
    'npm install > out.txt',
    'npm install | tee log.txt',
    'pytest; echo done',
    'ls -la',
    'git status'
  ]) {
    const out = runHook('shell-guard.mjs', {
      conversation_id: CONV,
      tool_name: 'Shell',
      tool_input: { command },
      cwd: tmp
    });
    assert.equal(out.updated_input, undefined, `不应改写: ${command}`);
  }
});

test('shell-guard: 纯 && 且全白名单的命令链整体包装', () => {
  for (const command of ['npm install && npm test', 'npm run build && cargo test', 'npm test']) {
    const out = runHook('shell-guard.mjs', {
      conversation_id: CONV,
      tool_name: 'Shell',
      tool_input: { command },
      cwd: tmp
    });
    assert.ok(out.updated_input, `应改写: ${command}`);
    assert.match(out.updated_input.command, /print-log\.mjs/);
    assert.match(out.updated_input.command, /exit \$__tse/, '链整体退出码应被保留');
  }
});

test('shell-guard: 扩展白名单覆盖测试/构建/git log', () => {
  for (const command of ['pytest -q', 'go test ./...', 'cargo test', 'npm run build', 'git log --oneline -50', 'npx tsc --noEmit', 'make']) {
    const out = runHook('shell-guard.mjs', {
      conversation_id: CONV,
      tool_name: 'Shell',
      tool_input: { command },
      cwd: tmp
    });
    assert.ok(out.updated_input, `应改写: ${command}`);
    assert.match(out.updated_input.command, /print-log\.mjs/);
  }
});

test('mcp-audit: 记录 MCP 工具输出体量', () => {
  const out = runHook('mcp-audit.mjs', {
    hook_event_name: 'afterMCPExecution',
    conversation_id: CONV,
    tool_name: 'some-server_big_query',
    tool_output: 'x'.repeat(5000)
  });
  assert.deepEqual(out, {});
  const ev = statsEvents().find((e) => e.hook === 'mcp-audit');
  assert.ok(ev, '应有 mcp-audit 事件');
  assert.equal(ev.bytes, 5000);
  assert.match(ev.command, /^MCP some-server_big_query/);
});

test('任务软预算只提醒、不硬拦截，并持久累计', () => {
  const cfgPath = path.join(tmp, '.cursor', 'token-saver.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const previous = cfg.taskBudget;
  cfg.taskBudget = { enabled: true, maxTokens: 10, warnAtPercent: 50, hardLimit: false };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const out = runHook('mcp-audit.mjs', {
    hook_event_name: 'afterMCPExecution',
    conversation_id: 'budget-conv',
    tool_name: 'other_big_tool',
    tool_output: 'x'.repeat(100)
  });
  assert.match(out.user_message, /软预算提醒/);
  const state = JSON.parse(
    fs.readFileSync(path.join(tmp, '.cursor', 'token-saver', 'state', 'budget-conv.json'), 'utf8')
  );
  assert.equal(state.budget.usedTokens, 26); // 文本感知估算：100 字节 ASCII ≈ 100/3.9
  assert.equal(state.budget.warned, true);
  cfg.taskBudget = previous;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
});

test('print-log: 长输出打印头尾并记录节省量', () => {
  const log = path.join(tmp, 'fake-output.log');
  fs.writeFileSync(log, Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const res = spawnSync(
    'node',
    [path.join(tmp, '.cursor', 'hooks', 'token-saver', 'print-log.mjs'), log, '50', '100', tmp, CONV],
    { encoding: 'utf8', env: { ...process.env, CURSOR_PROJECT_DIR: tmp } }
  );
  assert.equal(res.status, 0);
  assert.match(res.stdout, /line 0\n/);
  assert.match(res.stdout, /line 499/);
  assert.match(res.stdout, /token-saver.*artifact=art_[a-f0-9]{12}/);
  assert.ok(!res.stdout.includes('line 250'), '中间行应被省略');
  const ev = statsEvents().find((e) => e.action === 'truncate');
  assert.ok(ev && ev.savedBytes > 0);
});

test('print-log: 同命令重复运行只回差分，逐字节相同则一行标记', () => {
  const runPrint = (content) => {
    const log = path.join(tmp, `loop-${Date.now()}-${Math.random()}.log`);
    fs.writeFileSync(log, content);
    return spawnSync(
      'node',
      [path.join(tmp, '.cursor', 'hooks', 'token-saver', 'print-log.mjs'), log, '30', '60', tmp, CONV, 'npm run loop-test', '1'],
      { encoding: 'utf8', env: { ...process.env, CURSOR_PROJECT_DIR: tmp } }
    ).stdout;
  };
  const base = Array.from({ length: 300 }, (_, i) => (i === 150 ? 'FAIL old assertion' : `loop line ${i}`));
  const first = runPrint(base.join('\n') + '\n');
  assert.match(first, /artifact=art_/, '首次运行正常落盘');

  const changed = [...base];
  changed[150] = 'PASS fixed assertion';
  changed[200] = 'FAIL brand new failure';
  const second = runPrint(changed.join('\n') + '\n');
  assert.match(second, /Lossless diff vs previous run/);
  assert.match(second, /-FAIL old assertion/);
  assert.match(second, /\+FAIL brand new failure/);
  assert.ok(!second.includes('loop line 100'), '未变化的行不应重复传输');

  const third = runPrint(changed.join('\n') + '\n');
  assert.match(third, /byte-identical to the previous run/);
  const events = statsEvents().filter((e) => e.action === 'truncate' && e.mode);
  assert.ok(events.some((e) => e.mode === 'delta'), '应记录差分模式');
  assert.ok(events.some((e) => e.mode === 'identical'), '应记录相同输出模式');
});

test('print-log: 短输出原样打印', () => {
  const log = path.join(tmp, 'short.log');
  fs.writeFileSync(log, 'ok\ndone\n');
  const res = spawnSync(
    'node',
    [path.join(tmp, '.cursor', 'hooks', 'token-saver', 'print-log.mjs'), log, '50', '100', tmp, CONV],
    { encoding: 'utf8' }
  );
  assert.equal(res.stdout, 'ok\ndone\n');
});

test('print-log: 软预算告警后首屏自动减半', () => {
  const raw = Array.from({ length: 140 }, (_, i) => `row ${i}`).join('\n') + '\n';
  const runPrint = (conv) => {
    const log = path.join(tmp, `tighten-${conv}.log`);
    fs.writeFileSync(log, raw);
    return spawnSync(
      'node',
      [path.join(tmp, '.cursor', 'hooks', 'token-saver', 'print-log.mjs'), log, '50', '100', tmp, conv],
      { encoding: 'utf8' }
    ).stdout;
  };
  // 未告警会话：140 行 ≤ 50+100+10，全量打印
  assert.equal(runPrint('calm-conv'), raw);

  // 已告警会话：head/tail 减半（25/50），同样的输出改走截断路径
  const stateDir = path.join(tmp, '.cursor', 'token-saver', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'warned-conv.json'),
    JSON.stringify({ reads: {}, denials: {}, budget: { usedTokens: 99999, warned: true } })
  );
  const tightened = runPrint('warned-conv');
  assert.notEqual(tightened, raw, '告警后不应再全量打印');
  assert.match(tightened, /token-saver.*artifact=/);
});

test('session-track: sessionStart 节流重扫 .cursorignore 收编新超大文件', () => {
  const bigFile = path.join(tmp, 'new-dump.sql');
  fs.writeFileSync(bigFile, 'x'.repeat(500 * 1024)); // 超过 400KB 扫描阈值
  const stampPath = path.join(tmp, '.cursor', 'token-saver', 'ignore-scan.json');
  fs.rmSync(stampPath, { force: true });

  runHook('session-track.mjs', { conversation_id: CONV, hook_event_name: 'sessionStart' });

  const ignore = fs.readFileSync(path.join(tmp, '.cursorignore'), 'utf8');
  assert.match(ignore, /new-dump\.sql/, '新出现的超大文件应进入标记块');
  const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  assert.ok(stamp.lastScan > 0);

  // 24h 内不重复扫描：手动删掉条目后再次 sessionStart 不应恢复
  fs.writeFileSync(path.join(tmp, '.cursorignore'), ignore.replace(/new-dump\.sql\n/, ''));
  runHook('session-track.mjs', { conversation_id: CONV, hook_event_name: 'sessionStart' });
  assert.ok(!fs.readFileSync(path.join(tmp, '.cursorignore'), 'utf8').includes('new-dump.sql'), '节流期内不应重扫');
  fs.rmSync(bigFile, { force: true });
});

test('session-track: sessionStart 节流扫描配置文件生成世界模型关系', () => {
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'hooks-demo', scripts: { build: 'tsc -p .' } })
  );
  fs.rmSync(path.join(tmp, '.cursor', 'token-saver', 'world-scan.json'), { force: true });

  runHook('session-track.mjs', { conversation_id: CONV, hook_event_name: 'sessionStart' });

  const stamp = JSON.parse(fs.readFileSync(path.join(tmp, '.cursor', 'token-saver', 'world-scan.json'), 'utf8'));
  assert.ok(stamp.lastScan > 0);
  const mem = JSON.parse(fs.readFileSync(path.join(tmp, '.cursor', 'token-saver', 'memory.json'), 'utf8'));
  const rel = mem.memories.find((m) => m.kind === 'relation' && m.text === 'npm run build --executes--> tsc -p .');
  assert.ok(rel, 'package.json 脚本应被提取为关系候选');
  assert.equal(rel.status, 'candidate');
  assert.equal(rel.files[0].path, 'package.json');
});

test('session-track: preCompact 记录真实 token 并提示', () => {
  const out = runHook('session-track.mjs', {
    conversation_id: CONV,
    hook_event_name: 'preCompact',
    trigger: 'auto',
    context_tokens: 120000,
    context_usage_percent: 85,
    context_window_size: 140000,
    messages_to_compact: 30
  });
  assert.match(out.user_message, /开新会话/);
  const ev = statsEvents().find((e) => e.action === 'compact');
  assert.equal(ev.context_tokens, 120000);
  const checkpoint = JSON.parse(
    fs.readFileSync(path.join(tmp, '.cursor', 'token-saver', 'summaries', `${CONV}.json`), 'utf8')
  );
  assert.equal(checkpoint.context.tokens, 120000);
});

test('session-track: sessionStart 自动同步过期的脚本副本', () => {
  const copy = path.join(tmp, '.cursor', 'hooks', 'token-saver', 'analyze.mjs');
  fs.writeFileSync(copy, '// 旧版本占位\n'); // 模拟包升级后项目里还是旧副本

  runHook('session-track.mjs', { conversation_id: CONV, hook_event_name: 'sessionStart' });

  const fresh = fs.readFileSync(path.join(pkgRoot, 'src', 'hooks', 'analyze.mjs'), 'utf8');
  assert.equal(fs.readFileSync(copy, 'utf8'), fresh, '副本应被更新为包内最新版');
  const ev = statsEvents().find((e) => e.action === 'scripts_sync');
  assert.ok(ev && ev.files >= 1, '应记录 scripts_sync 事件');
});

test('shell-audit: 记录命令输出体量', () => {
  runHook('shell-audit.mjs', {
    conversation_id: CONV,
    command: 'npm test',
    output: 'x'.repeat(5000),
    duration: 1234
  });
  const ev = statsEvents().find((e) => e.action === 'observe');
  assert.equal(ev.bytes, 5000);
});

test('失败→修复机械提取：同命令转成功且期间有编辑时生成候选 gotcha 记忆', () => {
  const conv = 'fixflow-conv';
  const fixFile = path.join(tmp, 'src-fix.ts');
  fs.writeFileSync(fixFile, 'export const broken = true;\n');

  // 1. 命令失败 → 记录 lastFailure
  runHook('shell-audit.mjs', { conversation_id: conv, command: 'npm run flaky-build', output: 'boom', exit_code: 2 });
  // 2. 期间编辑了文件
  runHook('edit-invalidate.mjs', { conversation_id: conv, file_path: fixFile });
  // 3. 同一命令成功 → 提取候选记忆并清除 lastFailure
  runHook('shell-audit.mjs', { conversation_id: conv, command: 'npm run flaky-build', output: 'ok', exit_code: 0 });

  const mem = JSON.parse(fs.readFileSync(path.join(tmp, '.cursor', 'token-saver', 'memory.json'), 'utf8'));
  const entry = mem.memories.find((m) => m.text.includes('npm run flaky-build'));
  assert.ok(entry, '应生成失败→修复记忆');
  assert.equal(entry.status, 'candidate', '机械提取应是候选状态');
  assert.equal(entry.kind, 'gotcha');
  assert.match(entry.text, /failed \(exit 2\) and passed after editing src-fix\.ts/);
  assert.ok(entry.files[0].hash, '应挂修复文件的哈希');

  const state = JSON.parse(fs.readFileSync(path.join(tmp, '.cursor', 'token-saver', 'state', `${conv}.json`), 'utf8'));
  assert.ok(!state.lastFailure, '修复确认后应清除 lastFailure');

  // 有动作的命令应进入检查点时间线（runbook 提取的原料），带退出码
  const cp = JSON.parse(fs.readFileSync(path.join(tmp, '.cursor', 'token-saver', 'summaries', `${conv}.json`), 'utf8'));
  const cmdEvents = (cp.events || []).filter((e) => e.type === 'command' && e.command === 'npm run flaky-build');
  assert.equal(cmdEvents.length, 2, '失败与成功两次执行都应记录');
  assert.deepEqual(cmdEvents.map((e) => e.exitCode), [2, 0]);

  // 没有编辑的"失败转成功"（环境抖动）不应生成记忆
  runHook('shell-audit.mjs', { conversation_id: conv, command: 'npm run other-task', output: 'boom', exit_code: 1 });
  runHook('shell-audit.mjs', { conversation_id: conv, command: 'npm run other-task', output: 'ok', exit_code: 0 });
  const mem2 = JSON.parse(fs.readFileSync(path.join(tmp, '.cursor', 'token-saver', 'memory.json'), 'utf8'));
  assert.ok(!mem2.memories.some((m) => m.text.includes('other-task')), '无编辑不应提取');
});

test('hook 输入损坏时 fail-open', () => {
  const res = spawnSync('node', [path.join(tmp, '.cursor', 'hooks', 'token-saver', 'read-guard.mjs')], {
    input: 'not-json{{{',
    encoding: 'utf8',
    env: { ...process.env, CURSOR_PROJECT_DIR: tmp }
  });
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).permission, 'allow');
});

test('配置即时生效: extreme 档读取上限变为 400', () => {
  const cfgPath = path.join(tmp, '.cursor', 'token-saver.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.profile = 'extreme';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  const out = runHook('read-guard.mjs', {
    conversation_id: 'another-conv',
    tool_name: 'Read',
    tool_input: { file_path: path.join(tmp, 'big.js') },
    cwd: tmp
  });
  assert.equal(out.permission, 'deny');
  assert.match(out.agent_message, /1,400p/);

  cfg.profile = 'standard';
  cfg.overrides = { readMaxLines: 600 };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const out2 = runHook('read-guard.mjs', {
    conversation_id: 'third-conv',
    tool_name: 'Read',
    tool_input: { file_path: path.join(tmp, 'big.js') },
    cwd: tmp
  });
  assert.match(out2.agent_message, /1,600p/, 'overrides 应覆盖档位默认值');
});

test('estTokensText: CJK 感知的分词估算', async () => {
  const { estTokensText } = await import(pathToFileURL(path.join(pkgRoot, 'src', 'hooks', '_lib.mjs')).href);
  assert.equal(estTokensText('你好，世界'), 5, '中文约 1 字 1 token，而不是 bytes/4 的 ~4 倍误差');
  const ascii = 'const value = compute(items) + 1;';
  assert.ok(Math.abs(estTokensText(ascii) - ascii.length / 3.9) <= 1, '英文/代码仍接近 4 字节 1 token');
  assert.equal(estTokensText(''), 0);
});

test('aggregate: 汇总数据正确，read 观测事件不刷屏最近事件流', async () => {
  const { aggregate } = await import(path.join(pkgRoot, 'src', 'dashboard', 'aggregate.mjs'));
  const prevEnv = process.env.CURSOR_PROJECT_DIR;
  process.env.CURSOR_PROJECT_DIR = tmp;
  const s = aggregate(tmp);
  process.env.CURSOR_PROJECT_DIR = prevEnv;
  assert.ok(s.totals.savedTokens > 0);
  assert.ok(s.totals.denies >= 2);
  assert.ok(s.totals.caps >= 1);
  assert.ok(s.topFiles.length > 0);
  assert.ok(s.byAction.compact >= 1);
  assert.ok(s.recent.every((e) => e.action !== 'read'), '放行读取只进浪费洞察，不进最近事件');
});

test('wasteInsights: 识别重复读、未治理命令与 override，并给出建议', async () => {
  const { wasteInsights } = await import(path.join(pkgRoot, 'src', 'dashboard', 'aggregate.mjs'));
  const ts = new Date().toISOString();
  const events = [
    ...Array.from({ length: 4 }, () => ({ ts, hook: 'read-guard', action: 'read', file: 'src/hot.js', bytes: 200 * 1024 })),
    { ts, hook: 'read-guard', action: 'read', file: 'data/big.json', bytes: 300 * 1024 },
    { ts, hook: 'shell-audit', action: 'observe', command: 'python generate.py --all', bytes: 400 * 1024 },
    { ts, hook: 'shell-audit', action: 'observe', command: 'python generate.py --all', bytes: 500 * 1024 },
    { ts, hook: 'shell-audit', action: 'observe', command: 'mktemp token-saver governed', bytes: 900 * 1024 },
    ...Array.from({ length: 4 }, () => ({ ts, hook: 'read-guard', action: 'deny-oversize', file: 'src/hot.js' })),
    ...Array.from({ length: 3 }, () => ({ ts, hook: 'read-guard', action: 'override-allow', file: 'src/hot.js' }))
  ];
  const w = wasteInsights(events);
  assert.equal(w.repeatedReads[0].file, 'src/hot.js');
  assert.equal(w.repeatedReads[0].count, 4);
  assert.equal(w.ungoverned.length, 1, '已治理（token-saver 包装）的命令不应出现');
  assert.match(w.ungoverned[0].command, /python generate\.py/);
  assert.equal(w.topOverrides[0].count, 3);
  const joined = w.suggestions.join('\n');
  assert.match(joined, /repeatReadWindowMs|context_query/);
  assert.match(joined, /白名单|重定向/);
  assert.match(joined, /readMaxLines/);
  assert.match(joined, /profile/);

  // 过去 7 天无事件 → 不误报
  const empty = wasteInsights([{ ts: '2000-01-01T00:00:00Z', hook: 'read-guard', action: 'read', file: 'x', bytes: 1 }]);
  assert.equal(empty.repeatedReads.length, 0);
  assert.match(empty.suggestions[0], /没有发现/);
});
