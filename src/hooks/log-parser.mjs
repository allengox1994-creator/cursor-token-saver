// 常见测试/构建日志的零依赖结构化提取器。
// 只决定首屏展示哪些行，完整原文始终由 context-store artifact 保存。
const FAILURE_RE =
  /(^|\s)(FAIL(?:ED)?|ERROR|AssertionError|panic:|Caused by:|error(?:\[E\d+\])?:|fatal:|✖|×)\b|tests? failed|BUILD FAILURE/i;
const SUMMARY_RE =
  /(tests?|suites?|passed|failed|skipped|errors?|warnings?|finished|duration|time|compiled|build).{0,120}$/i;
const STACK_RE = /^\s*(at\s+|File\s+".+", line\s+\d+|[\w./-]+\.(?:js|ts|tsx|py|rs|go|java):\d+)/;

export function detectFramework(command = '', raw = '') {
  const text = `${command}\n${raw.slice(0, 2000)}`.toLowerCase();
  if (/pytest|assertionerror/.test(text)) return 'pytest';
  if (/jest|vitest|test suites?:/.test(text)) return 'jest/vitest';
  if (/cargo (test|build|check)|error\[e\d+\]/.test(text)) return 'cargo';
  if (/go test|--- fail:/.test(text)) return 'go-test';
  if (/tsc|typescript|webpack|vite|next build/.test(text)) return 'compiler/build';
  return 'generic';
}

export function structureLog(raw, { command = '', exitCode = 0, maxLines = 120 } = {}) {
  const lines = String(raw || '').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const framework = detectFramework(command, raw);
  const selected = new Set();
  const addWindow = (i, before, after) => {
    for (let n = Math.max(0, i - before); n <= Math.min(lines.length - 1, i + after); n++) selected.add(n);
  };

  for (let i = 0; i < lines.length; i++) {
    if (FAILURE_RE.test(lines[i])) addWindow(i, 2, 8);
    else if (STACK_RE.test(lines[i]) && exitCode !== 0) addWindow(i, 0, 1);
    else if (SUMMARY_RE.test(lines[i]) && (i < 20 || i >= lines.length - 40)) selected.add(i);
    if (selected.size >= maxLines * 2) break;
  }
  // 未识别时保留少量头尾；成功日志优先尾部摘要。
  if (selected.size === 0) {
    const head = exitCode === 0 ? 8 : 20;
    const tail = exitCode === 0 ? 30 : 50;
    for (let i = 0; i < Math.min(head, lines.length); i++) selected.add(i);
    for (let i = Math.max(0, lines.length - tail); i < lines.length; i++) selected.add(i);
  }

  const ordered = [...selected].sort((a, b) => a - b).slice(0, maxLines);
  const output = [];
  let previous = -1;
  for (const i of ordered) {
    if (i > previous + 1) output.push(`… omitted lines ${previous + 2}-${i}`);
    output.push(`${i + 1}|${lines[i]}`);
    previous = i;
  }
  if (previous < lines.length - 1) output.push(`… omitted lines ${previous + 2}-${lines.length}`);
  return {
    framework,
    totalLines: lines.length,
    shownLines: ordered.length,
    omittedLines: Math.max(0, lines.length - ordered.length),
    text: output.join('\n')
  };
}
