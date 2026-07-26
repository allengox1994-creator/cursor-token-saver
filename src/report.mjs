// 终端统计报表：npx cursor-token-saver report [--all]
import { aggregate, aggregateAll } from './dashboard/aggregate.mjs';
import { liveProjects, loadSettings } from './hooks/_lib.mjs';

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '0');
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function moneyLine(tokens) {
  const s = loadSettings();
  const usd = (tokens / 1e6) * s.pricePerMTokUsd;
  return `≈ 省 ¥${(usd * s.usdToCny).toFixed(2)} ($${usd.toFixed(2)}，按 ${s.priceName} 输入价 $${s.pricePerMTokUsd}/M 估算)`;
}

// 全局报表：聚合注册表里所有项目
export function reportAll() {
  const projects = liveProjects();
  if (projects.length === 0) {
    console.log('\n全局注册表为空。在各项目里运行 init（或开一次 Cursor 会话）后会自动登记。\n');
    return;
  }
  const s = aggregateAll(projects);
  console.log(`\ncursor-token-saver 全局报表  (${projects.length} 个项目)`);
  console.log('='.repeat(64));
  console.log(`累计节省(估算): ${fmt(s.totals.savedTokens)} tokens  (${kb(s.totals.savedBytes)})  ${moneyLine(s.totals.savedTokens)}`);
  console.log(`拦截 ${fmt(s.totals.denies)} 次 | 截断 ${fmt(s.totals.caps + s.totals.truncates)} 次 | 事件总数 ${fmt(s.totals.events)}`);
  console.log('\n按项目:');
  for (const p of s.perProject) {
    console.log(
      `  ${fmt(p.totals.savedTokens).padStart(10)} tokens | ${String(p.totals.events).padStart(5)} 事件 | ${p.name}  (${p.path})`
    );
  }
  console.log('\n提示: 全局面板 npx cursor-token-saver dashboard；单项目明细 report --dir <path>\n');
}

export function report(root) {
  const s = aggregate(root);
  const t = s.totals;

  console.log(`\ncursor-token-saver 统计报表  (项目: ${root})`);
  console.log('='.repeat(64));
  if (t.events === 0) {
    console.log('暂无数据。先运行 init 安装 hooks，再在 Cursor 里正常使用即可积累统计。\n');
    return;
  }

  console.log(`累计节省(估算): ${fmt(t.savedTokens)} tokens  (${kb(t.savedBytes)})  ${moneyLine(t.savedTokens)}`);
  console.log(
    `拦截 ${fmt(t.denies)} 次 | 读取截断 ${fmt(t.caps)} 次 | 输出截断 ${fmt(t.truncates)} 次 | ` +
      `命令改写 ${fmt(t.rewrites)} 次`
  );
  console.log(`会话 ${fmt(t.sessions)} 个 | 上下文压缩 ${fmt(t.compactions)} 次 | 事件总数 ${fmt(t.events)}`);

  if (Object.keys(s.savedByHook).length > 0) {
    console.log('\n按来源节省:');
    for (const [hook, tokens] of Object.entries(s.savedByHook).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${hook.padEnd(16)} ${fmt(tokens)} tokens`);
    }
  }

  if (s.topFiles.length > 0) {
    console.log('\nTop 浪费文件（被拦/被截）:');
    for (const f of s.topFiles.slice(0, 5)) {
      console.log(`  ${fmt(f.savedTokens).padStart(10)} tokens  x${f.count}  ${f.file}`);
    }
  }

  if (s.topCommands.length > 0) {
    console.log('\nTop 噪音命令（按输出体量）:');
    for (const c of s.topCommands.slice(0, 5)) {
      console.log(`  ${kb(c.bytes).padStart(10)}  x${c.count}  ${c.command.slice(0, 60)}`);
    }
  }

  if (s.compactions.length > 0) {
    const last = s.compactions[s.compactions.length - 1];
    console.log(
      `\n最近一次上下文压缩: ${last.ts}  ${fmt(last.context_tokens)} tokens (${last.context_usage_percent}%)`
    );
  }
  console.log('\n提示: token 节省值为估算（字节/4）。面板: npx cursor-token-saver dashboard\n');
}
