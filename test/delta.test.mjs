// 行差分模块单元测试：无损性、hunk 格式、超大变化回退
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff } from '../src/hooks/delta.mjs';

test('内容相同返回 identical', () => {
  const d = lineDiff('a\nb\nc', 'a\nb\nc');
  assert.equal(d.identical, true);
  assert.equal(d.changedLines, 0);
});

test('单行修改产出最小 hunk，行号正确', () => {
  const oldText = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
  const newText = ['l1', 'l2', 'CHANGED', 'l4', 'l5'].join('\n');
  const d = lineDiff(oldText, newText);
  assert.equal(d.identical, false);
  assert.equal(d.changedLines, 2); // 一删一增
  assert.match(d.text, /@@ -3,1 \+3,1 @@/);
  assert.match(d.text, /-l3/);
  assert.match(d.text, /\+CHANGED/);
});

test('多处修改产出多个 hunk，中段未变行不出现', () => {
  const oldLines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const newLines = [...oldLines];
  newLines[10] = 'edit A';
  newLines[80] = 'edit B';
  const d = lineDiff(oldLines.join('\n'), newLines.join('\n'));
  assert.equal(d.hunks, 2);
  assert.match(d.text, /\+edit A/);
  assert.match(d.text, /\+edit B/);
  assert.ok(!d.text.includes('line 50'), '远离修改点的行不应传输');
});

test('末尾追加行', () => {
  const d = lineDiff('a\nb', 'a\nb\nc\nd');
  assert.equal(d.changedLines, 2);
  assert.match(d.text, /\+c/);
  assert.match(d.text, /\+d/);
});

test('中等规模整块替换仍无损（del 全部旧行 + ins 全部新行）', () => {
  // 变化区域 > MAX_DP_CELLS 但总行数 <= 4000：整块替换
  const oldText = Array.from({ length: 1500 }, (_, i) => `old ${i}`).join('\n');
  const newText = Array.from({ length: 1500 }, (_, i) => `new ${i}`).join('\n');
  const d = lineDiff(oldText, newText);
  assert.ok(d, '应返回结果而非 null');
  assert.equal(d.changedLines, 3000);
});

test('超大变化区域返回 null（调用方回退全量）', () => {
  const oldText = Array.from({ length: 5000 }, (_, i) => `old ${i}`).join('\n');
  const newText = Array.from({ length: 5000 }, (_, i) => `new ${i}`).join('\n');
  assert.equal(lineDiff(oldText, newText), null);
});

test('差分可无损重建新文件', () => {
  const oldLines = Array.from({ length: 60 }, (_, i) => `base ${i}`);
  const newLines = [...oldLines];
  newLines.splice(20, 2, 'replaced X', 'replaced Y', 'inserted Z');
  newLines.push('tail line');
  const oldText = oldLines.join('\n');
  const newText = newLines.join('\n');
  const d = lineDiff(oldText, newText, { context: 2 });

  // 按 hunk 头行号把差分应用回旧文本，应精确重建新文本
  const rebuilt = [...oldLines];
  let offset = 0;
  const hunkRe = /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/;
  const blocks = d.text.split(/^(?=@@ )/m).filter(Boolean);
  for (const block of blocks) {
    const [head, ...body] = block.split('\n');
    const m = head.match(hunkRe);
    assert.ok(m, `hunk 头格式: ${head}`);
    const oldStart = Number(m[1]);
    const oldCount = Number(m[2]);
    const replacement = body.filter((l) => l.startsWith(' ') || l.startsWith('+')).map((l) => l.slice(1));
    rebuilt.splice(oldStart - 1 + offset, oldCount, ...replacement);
    offset += replacement.length - oldCount;
  }
  assert.equal(rebuilt.join('\n'), newText, '应用差分后应与新文件逐字节一致');
});
