// 零依赖行级差分：先掐掉公共前后缀，中间区域用 LCS 回溯出 hunks。
// 变化区域过大时返回 null，调用方回退全量传输——差分只在真正省的时候用。
const MAX_DP_CELLS = 1_000_000; // 1000x1000 行的变化区域，足够覆盖常规编辑

export function lineDiff(oldText, newText, { context = 2 } = {}) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) {
    return { identical: true, changedLines: 0, hunks: 0, text: '', oldLines: a.length, newLines: b.length };
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let ops;
  if (midA.length * midB.length <= MAX_DP_CELLS) {
    ops = lcsOps(midA, midB);
  } else if (midA.length + midB.length <= 4000) {
    // 变化区域太大不值得精确 LCS：整块替换，仍然无损
    ops = [...midA.map(() => 'del'), ...midB.map(() => 'ins')];
  } else {
    return null;
  }

  // ops 展开成带行号的编辑序列（相对完整文件）
  const edits = [];
  let ai = start;
  let bi = start;
  for (const op of ops) {
    if (op === 'keep') edits.push({ op, aLine: ai++, bLine: bi++ });
    else if (op === 'del') edits.push({ op, aLine: ai++ });
    else edits.push({ op, bLine: bi++ });
  }

  const changedLines = edits.filter((e) => e.op !== 'keep').length;
  const out = [];
  let hunks = 0;
  let i = 0;
  while (i < edits.length) {
    if (edits[i].op === 'keep') {
      i++;
      continue;
    }
    // 一个 hunk：向前带 context 行，向后吞并间隔 <= 2*context 的变更
    let from = i;
    let to = i;
    let scan = i + 1;
    let gap = 0;
    while (scan < edits.length) {
      if (edits[scan].op === 'keep') {
        gap++;
        if (gap > context * 2) break;
      } else {
        to = scan;
        gap = 0;
      }
      scan++;
    }
    const ctxBefore = Math.max(0, from - context);
    const ctxAfter = Math.min(edits.length - 1, to + context);
    const slice = edits.slice(ctxBefore, ctxAfter + 1);
    const oldStart = (slice.find((e) => e.aLine != null)?.aLine ?? start) + 1;
    const newStart = (slice.find((e) => e.bLine != null)?.bLine ?? start) + 1;
    const oldCount = slice.filter((e) => e.aLine != null).length;
    const newCount = slice.filter((e) => e.bLine != null).length;
    hunks++;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const e of slice) {
      if (e.op === 'keep') out.push(` ${a[e.aLine]}`);
      else if (e.op === 'del') out.push(`-${a[e.aLine]}`);
      else out.push(`+${b[e.bLine]}`);
    }
    i = ctxAfter + 1;
  }

  return { identical: false, changedLines, hunks, text: out.join('\n'), oldLines: a.length, newLines: b.length };
}

function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度（一维滚动不便回溯，直接存满表）
  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('keep');
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push('del');
      i++;
    } else {
      ops.push('ins');
      j++;
    }
  }
  while (i < n) {
    ops.push('del');
    i++;
  }
  while (j < m) {
    ops.push('ins');
    j++;
  }
  return ops;
}
