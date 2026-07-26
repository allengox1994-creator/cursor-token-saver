// 诚实的省 token 基准测试：在真实项目文件上重放六类典型 agent 操作，
// 对比"原始全量传输"和"经过 token-saver 首屏"的 token 量。
// 口径说明（营销引用时必须带上）：
//   1. 度量的是传输层 token（CJK 感知估算），不是 API 账单——账单还受模型缓存、系统提示等影响；
//   2. 每类场景独立计算，总计是"这些场景加总"，不代表任意会话都能省这个比例；
//   3. 所有压缩都可通过 context_expand 无损恢复，节省不以丢信息为代价。
import fs from 'node:fs';
import path from 'node:path';
import { estTokensText } from '../hooks/_lib.mjs';
import { compactContent } from '../hooks/analyze.mjs';
import { extractSymbols, EXT_LANG } from '../hooks/symbols.mjs';
import { lineDiff } from '../hooks/delta.mjs';
import { profileData } from '../hooks/data-profile.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '.cursor', 'coverage', '.venv']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const IDENTICAL_MARKER_TOKENS = 30; // "byte-identical" 标记行的近似成本

function walk(root, { maxFiles = 400 } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env.example') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(abs);
        continue;
      }
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.size === 0 || st.size > MAX_FILE_BYTES) continue;
      out.push({ abs, rel: path.relative(root, abs).split(path.sep).join('/'), size: st.size, ext: path.extname(abs).toLowerCase() });
    }
  }
  return out;
}

function readUtf8(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

// 模拟"改动约 2% 行后重读"
function simulateEdit(content) {
  const lines = content.split('\n');
  for (let i = 25; i < lines.length; i += 50) lines[i] = lines[i] + ' // edited-for-bench';
  return lines.join('\n');
}

export function runBench(root, { maxFiles = 8 } = {}) {
  const files = walk(root);
  const source = files
    .filter((f) => EXT_LANG[f.ext])
    .sort((a, b) => b.size - a.size)
    .slice(0, maxFiles)
    .map((f) => ({ ...f, content: readUtf8(f.abs) }))
    .filter((f) => f.content);
  const scenarios = [];
  const add = (name, desc, baseline, tool) => {
    if (baseline <= 0) return;
    scenarios.push({
      name,
      desc,
      baselineTokens: Math.round(baseline),
      toolTokens: Math.round(tool),
      savedTokens: Math.round(Math.max(0, baseline - tool)),
      savedPct: Math.round(Math.max(0, 1 - tool / baseline) * 100)
    });
  };

  if (source.length) {
    // 1. 结构浏览：全文 vs 符号大纲（context_query mode=outline）
    let base = 0;
    let tool = 0;
    for (const f of source) {
      const { symbols } = extractSymbols(f.content, EXT_LANG[f.ext]);
      base += estTokensText(f.content);
      tool += estTokensText(symbols.map((s) => `${s.line} ${s.text}`).join('\n')) + 20;
    }
    add('outline', `浏览 ${source.length} 个最大源文件的结构（全文 → 符号大纲）`, base, tool);

    // 2. 精读：全文 vs 压缩视图（去注释/空行/折叠长字面量，mode=read）
    base = 0;
    tool = 0;
    for (const f of source) {
      base += estTokensText(f.content);
      tool += estTokensText(compactContent(f.content, EXT_LANG[f.ext]).text) + 20;
    }
    add('compact-read', `精读同一批文件（全文 → 无损压缩视图，可按 ID 恢复）`, base, tool);

    // 3. 未变文件重读：全文 vs byte-identical 标记
    base = source.reduce((s, f) => s + estTokensText(f.content), 0);
    add('unchanged-reread', `重读未变化的文件（全文重传 → 一行"内容未变"标记）`, base, source.length * IDENTICAL_MARKER_TOKENS);

    // 4. 编辑后重读：全文 vs 行级差分
    base = 0;
    tool = 0;
    for (const f of source) {
      const edited = simulateEdit(f.content);
      base += estTokensText(edited);
      tool += estTokensText(lineDiff(f.content, edited).text) + 20;
    }
    add('edited-reread', `小改动后重读（全文重传 → 行级无损差分，约改 2% 行）`, base, tool);
  }

  // 5. 重复命令输出：两次全量 vs 全量 + 一致标记
  const logLine = (i) => `[${new Date(2026, 0, 1, 0, 0, i % 60).toISOString()}] INFO module-${i % 7} processed item ${i} in ${(i % 90) + 10}ms`;
  const fakeLog = Array.from({ length: 1500 }, (_, i) => logLine(i)).join('\n');
  add(
    'repeat-command',
    '重复执行输出相同的命令，如反复跑测试（两次全量 → 全量 + 一致标记）',
    estTokensText(fakeLog) * 2,
    estTokensText(fakeLog) + IDENTICAL_MARKER_TOKENS
  );

  // 6. 数据文件：全文 vs 结构画像（mode=profile）
  const dataFile = files
    .filter((f) => ['.json', '.csv', '.yaml', '.yml', '.jsonl'].includes(f.ext) && f.rel !== 'package.json')
    .sort((a, b) => b.size - a.size)[0];
  if (dataFile) {
    const content = readUtf8(dataFile.abs);
    if (content) {
      add(
        'data-profile',
        `读取数据文件 ${dataFile.rel}（全文 → 结构画像，原文可按 ID/正则回取）`,
        estTokensText(content),
        estTokensText(profileData(content, dataFile.ext).text) + 20
      );
    }
  }

  const totals = scenarios.reduce(
    (t, s) => ({ baselineTokens: t.baselineTokens + s.baselineTokens, toolTokens: t.toolTokens + s.toolTokens }),
    { baselineTokens: 0, toolTokens: 0 }
  );
  const report = {
    generatedAt: new Date().toISOString(),
    root,
    filesSampled: source.map((f) => f.rel),
    scenarios,
    totals: {
      ...totals,
      savedTokens: totals.baselineTokens - totals.toolTokens,
      savedPct: totals.baselineTokens ? Math.round((1 - totals.toolTokens / totals.baselineTokens) * 100) : 0
    },
    caveats: [
      '度量口径是传输层 token（CJK 感知估算），不是 API 账单；账单还受提示缓存等因素影响。',
      '各场景独立计算；实际会话的节省比例取决于操作构成。',
      '所有压缩均可通过 context_expand 无损恢复，不以丢失信息为代价。'
    ]
  };
  try {
    const outDir = path.join(root, '.cursor', 'token-saver');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'bench-report.json'), JSON.stringify(report, null, 2));
  } catch {}
  return report;
}

export function printBench(report) {
  const fmt = (n) => n.toLocaleString('en-US');
  const lines = [
    `token-saver 基准测试 — ${report.root}`,
    `采样文件: ${report.filesSampled.length ? report.filesSampled.join(', ') : '(无源文件)'}`,
    '',
    '场景                  原始 tokens    工具 tokens    节省',
    '-'.repeat(64)
  ];
  for (const s of report.scenarios) {
    lines.push(
      `${s.name.padEnd(20)}  ${fmt(s.baselineTokens).padStart(11)}  ${fmt(s.toolTokens).padStart(11)}  ${String(s.savedPct + '%').padStart(5)}`
    );
    lines.push(`  ${s.desc}`);
  }
  lines.push('-'.repeat(64));
  lines.push(
    `总计                  ${fmt(report.totals.baselineTokens).padStart(11)}  ${fmt(report.totals.toolTokens).padStart(11)}  ${String(report.totals.savedPct + '%').padStart(5)}`
  );
  lines.push('');
  for (const c of report.caveats) lines.push(`* ${c}`);
  lines.push('');
  lines.push(`报告已写入 .cursor/token-saver/bench-report.json`);
  process.stdout.write(lines.join('\n') + '\n');
}
