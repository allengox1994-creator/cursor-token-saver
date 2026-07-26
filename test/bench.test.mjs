// 基准测试工具：在临时项目上验证六类场景的度量与报告输出
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBench } from '../src/bench/bench.mjs';

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-saver-bench-'));
  fs.mkdirSync(path.join(root, 'src'));
  // 带注释/空行的源文件（压缩视图有节省空间）
  fs.writeFileSync(
    path.join(root, 'src', 'big.ts'),
    Array.from({ length: 400 }, (_, i) =>
      i % 4 === 0 ? `// comment line ${i}` : i % 4 === 1 ? '' : `export function fn${i}() { return ${i}; }`
    ).join('\n')
  );
  fs.writeFileSync(
    path.join(root, 'src', 'other.js'),
    Array.from({ length: 200 }, (_, i) => `const v${i} = ${i}; // trailing note`).join('\n')
  );
  // 数据文件（画像场景）
  fs.writeFileSync(
    path.join(root, 'data.json'),
    JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `user-${i}`, active: i % 2 === 0 })) })
  );
  fs.writeFileSync(path.join(root, 'node_modules-decoy.txt'), 'not scanned as source');
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), 'should be skipped');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('runBench：六类场景齐全、有正节省、口径声明完整、报告落盘', () => {
  const report = runBench(root, { maxFiles: 4 });
  const names = report.scenarios.map((s) => s.name);
  for (const expected of ['outline', 'compact-read', 'unchanged-reread', 'edited-reread', 'repeat-command', 'data-profile']) {
    assert.ok(names.includes(expected), `缺少场景 ${expected}`);
  }
  assert.ok(!report.filesSampled.some((f) => f.includes('node_modules/')), 'node_modules 不应被采样');
  for (const s of report.scenarios) {
    assert.ok(s.baselineTokens > 0 && s.toolTokens > 0, `${s.name} 度量应为正数`);
    assert.equal(s.savedTokens, s.baselineTokens - s.toolTokens < 0 ? 0 : s.baselineTokens - s.toolTokens);
  }
  assert.ok(report.totals.savedPct > 20, `总节省应显著（实际 ${report.totals.savedPct}%）`);
  assert.ok(report.totals.baselineTokens > report.totals.toolTokens);
  assert.equal(report.caveats.length, 3, '诚实口径声明必须在报告里');

  const saved = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'token-saver', 'bench-report.json'), 'utf8'));
  assert.equal(saved.totals.savedPct, report.totals.savedPct);
});

test('runBench：未变文件重读与重复命令是节省大头', () => {
  const report = runBench(root, { maxFiles: 4 });
  const reread = report.scenarios.find((s) => s.name === 'unchanged-reread');
  assert.ok(reread.savedPct > 90, '未变重读应接近全省');
  const repeat = report.scenarios.find((s) => s.name === 'repeat-command');
  assert.ok(repeat.savedPct >= 45 && repeat.savedPct <= 55, '重复命令应省约一半');
});
