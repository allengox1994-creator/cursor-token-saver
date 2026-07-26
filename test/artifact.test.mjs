import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEvidence } from '../src/hooks/context-store.mjs';
import { structureLog } from '../src/hooks/log-parser.mjs';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const printer = path.join(pkgRoot, 'src', 'hooks', 'print-log.mjs');
let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-saver-artifact-'));
  fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cursor', 'token-saver.json'), JSON.stringify({ profile: 'standard' }));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('Jest/Pytest/Cargo/Go 日志均能提取失败核心', () => {
  const fixtures = [
    ['npx jest', 'FAIL src/a.test.ts\nExpected: 1\nReceived: 2\nTest Suites: 1 failed', 'jest/vitest'],
    ['pytest', 'test_api.py::test_x FAILED\nE AssertionError: boom\n1 failed', 'pytest'],
    ['cargo test', 'error[E0308]: mismatched types\n --> src/main.rs:4:2\ntest result: FAILED', 'cargo'],
    ['go test ./...', '--- FAIL: TestThing (0.00s)\npkg/a_test.go:12: expected true\nFAIL', 'go-test']
  ];
  for (const [command, raw, framework] of fixtures) {
    const out = structureLog(raw, { command, exitCode: 1 });
    assert.equal(out.framework, framework);
    assert.match(out.text, /FAIL|failed|error/i);
    assert.ok(out.shownLines > 0);
  }
});

test('长输出完整保存为 artifact，首屏可恢复任意省略内容', () => {
  const log = path.join(root, 'long.log');
  const raw = Array.from({ length: 500 }, (_, i) => (i === 250 ? 'UNIQUE_OMITTED_FAILURE' : `line ${i}`)).join('\n') + '\n';
  fs.writeFileSync(log, raw);
  const res = spawnSync('node', [printer, log, '20', '30', root, 'artifact-conv', 'npm test', '1'], {
    encoding: 'utf8'
  });
  assert.equal(res.status, 0);
  const id = res.stdout.match(/artifact=(art_[a-f0-9]{12})/)?.[1];
  assert.ok(id);
  assert.ok(!res.stdout.includes('line 200'), '首屏不应输出无关中段');
  const full = getEvidence(root, id, { level: 'full' });
  assert.equal(full.text, raw);
  const hit = getEvidence(root, id, { regex: 'UNIQUE_OMITTED_FAILURE', radius: 1 });
  assert.match(hit.text, /line 249\nUNIQUE_OMITTED_FAILURE\nline 251/);
  assert.equal(fs.existsSync(log), false, '临时日志已搬入内容仓后应删除');
});

test('短输出保持原样且 helper 永远不改变命令退出码', () => {
  const log = path.join(root, 'short.log');
  fs.writeFileSync(log, 'ok\ndone\n');
  const res = spawnSync('node', [printer, log, '20', '30', root, 'artifact-conv', 'npm test', '7'], {
    encoding: 'utf8'
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'ok\ndone\n');
});
