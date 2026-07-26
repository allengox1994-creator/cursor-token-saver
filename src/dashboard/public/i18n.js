/* 面板中英双语：中文为源文案，字典映射到英文。
   静态 HTML 在加载时按文本节点替换；动态字符串经 tr() 输出。语言选择存 localStorage。 */
(() => {
  const stored = localStorage.getItem('cts-lang');
  const auto = (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  window.LANG = stored === 'zh' || stored === 'en' ? stored : auto;

  const D = {
    'cursor-token-saver 面板': 'cursor-token-saver Dashboard',
    '全局面板': 'Global Dashboard',
    '选择项目': 'Select project',
    '全部项目': 'All projects',
    '剔除': 'Remove',
    '从面板剔除该项目（不删除项目文件；重跑 init 可恢复）': 'Remove this project from the dashboard (files untouched; re-run init to restore)',
    '统计': 'Stats',
    '索引': 'Index',
    '上下文': 'Context',
    '浪费洞察': 'Waste Insights',
    '记忆': 'Memory',
    '配置': 'Config',
    '暂无统计数据 —— 安装 hooks 后在 Cursor 里正常使用，拦截事件会自动出现在这里。':
      'No stats yet — use Cursor normally after installing the hooks and interception events will show up here automatically.',
    '累计节省': 'Total saved',
    '(估算)': '(estimated)',
    '拦截次数': 'Blocks',
    '重复读取 + 低价值文件': 'Repeated reads + low-value files',
    '截断次数': 'Truncations',
    '大文件读取 + 长命令输出': 'Large file reads + long command output',
    '会话 / 压缩': 'Sessions / Compactions',
    '项目总览': 'Project overview',
    '(点击行切换到该项目)': '(click a row to switch)',
    '项目': 'Project',
    '节省 (tokens)': 'Saved (tokens)',
    '≈ 省钱': '\u2248 Money saved',
    '拦截': 'Blocks',
    '截断': 'Truncations',
    '事件': 'Events',
    '语义模型': 'Embedding model',
    '最近活动': 'Last activity',
    '每日节省趋势': 'Daily savings trend',
    '按动作分布': 'By action',
    'Top 浪费文件': 'Top wasteful files',
    'Top 噪音命令（输出体量）': 'Top noisy commands (output volume)',
    '最近事件': 'Recent events',
    '时间': 'Time',
    '来源': 'Source',
    '动作': 'Action',
    '对象': 'Object',
    '费用换算': 'Cost conversion',
    '计价模型': 'Pricing model',
    '输入价 ($/百万 token)': 'Input price ($/M tokens)',
    '美元汇率 (CNY)': 'USD rate (CNY)',
    '保存': 'Save',
    'token 节省值按 字节 / 4 估算、按所选模型的未缓存输入价换算，非账单精确值；上下文压缩事件里的 context_tokens 为 Cursor 上报的真实值。':
      "Token savings are estimated at bytes / 4 and converted with the selected model's uncached input price — not exact billing figures. context_tokens in compaction events is the real value reported by Cursor.",
    '索引是按项目存储的——请在左上角选择一个具体项目查看。':
      'Indexes are stored per project — pick a specific project at the top left.',
    '该项目还没有嵌入索引。Cursor 打开该项目后约 45 秒会自动建立；也可以手动运行':
      'This project has no embedding index yet. It builds automatically ~45s after Cursor opens the project; you can also run',
    '立即预建。': 'to pre-build it now.',
    '嵌入模型': 'Embedding model',
    '已索引文件 / 代码块': 'Indexed files / chunks',
    '健康度': 'Health',
    '自动索引': 'Auto-index',
    '文件明细': 'File details',
    '过滤文件路径…': 'Filter by path…',
    '文件': 'File',
    '代码块': 'Chunks',
    '状态': 'Status',
    '上下文证据按项目存储——请在左上角选择一个具体项目查看。':
      'Context evidence is stored per project — pick a specific project at the top left.',
    '证据条目': 'Evidence entries',
    '本地证据体积': 'Local evidence size',
    '源码仅存引用；体积主要来自完整日志 artifact': 'Source is stored by reference; size mostly comes from full log artifacts',
    '会话软预算': 'Session soft budget',
    '持久检查点': 'Persistent checkpoints',
    '压缩或新会话可按 conversation 恢复': 'Recoverable per conversation after compaction or in a new session',
    '全局索引服务': 'Global index daemon',
    '离线检索评测': 'Offline retrieval eval',
    '最近证据': 'Recent evidence',
    '（只显示项目相对路径和元数据，不直接暴露内容）': '(shows relative paths and metadata only, never raw content)',
    '类型': 'Kind',
    '大小': 'Size',
    '最近访问': 'Last access',
    '校准建议': 'Calibration advice',
    '频繁全量重读的文件': 'Files repeatedly re-read in full',
    '（每次重读都是全额 token；≥3 次才显示）': '(each re-read costs full tokens; shown at ≥3 occurrences)',
    '次数': 'Count',
    '单次体积': 'Size each',
    '重复浪费': 'Wasted on repeats',
    '未治理的高噪音命令': 'Ungoverned noisy commands',
    '（不在 shell-guard 白名单、输出直接进上下文）': '(outside the shell-guard whitelist; output goes straight into context)',
    '命令': 'Command',
    '累计输出': 'Total output',
    '拦截后被重试放行的文件': 'Files force-allowed after blocking',
    '（override 频繁 = 阈值拦错了）': '(frequent overrides = the threshold is miscalibrated)',
    'override 次数': 'Overrides',
    '记忆是按项目存储的 —— 请在左上角选择一个具体项目查看。':
      'Memories are stored per project — pick a specific project at the top left.',
    '生效 / 候选': 'Active / Candidates',
    '累计召回': 'Total recalls',
    '记忆被 agent 用到的次数': 'Times memories were used by the agent',
    '从未召回': 'Never recalled',
    '写了没用上的，考虑清理': 'Saved but never used — consider pruning',
    '过期待确认': 'Stale, needs confirm',
    '挂载文件已变化': 'Linked files have changed',
    '关系 / 技能': 'Relations / Skills',
    '世界模型三元组 / runbook': 'world-model triples / runbooks',
    '语义记忆': 'Semantic memory',
    '（agent 沉淀的工程事实：约定/决策/坑/入口。挂了文件的条目在文件变化后自动标记过期）':
      '(engineering facts the agent saved: conventions/decisions/gotchas/entry points; file-linked entries auto-flag stale when files change)',
    '记忆': 'Memory',
    '作用域': 'Scope',
    '召回': 'Recalls',
    '更新时间': 'Updated',
    '操作': 'Actions',
    '候选 = 机械提取待确认（含 checkpoint 决策和"失败→修复"记录）；过期 = 挂载文件已变化；全局 = 跨项目通用事实；归档条目不进 agent 检索，可随时恢复。':
      'Candidate = mechanically extracted, awaiting confirmation (incl. checkpoint decisions and fail-to-fix records); stale = linked files changed; global = cross-project facts; archived entries leave agent retrieval and can be restored any time.',
    '配置是按项目存储的（各项目的': "Config is stored per project (each project's",
    '）——请在左上角选择一个具体项目后编辑。': ') — pick a specific project at the top left to edit.',
    '激进度档位': 'Aggressiveness profile',
    '档位决定各项阈值的默认值，改完立即生效（hooks 每次执行都会重新读配置）。':
      'The profile sets default thresholds; changes take effect immediately (hooks re-read config on every run).',
    'Hook 开关': 'Hook toggles',
    '阈值覆盖': 'Threshold overrides',
    '(留空使用档位默认值)': '(leave blank for profile defaults)',
    '无损上下文策略': 'Lossless context policy',
    'context_query 首屏字符预算': 'context_query first-screen char budget',
    '每个命中预览字符': 'Preview chars per hit',
    '任务软预算 (tokens，不会硬拦截)': 'Task soft budget (tokens, never hard-blocks)',
    '预算提醒比例 (%)': 'Budget warning ratio (%)',
    'Artifact 保留天数': 'Artifact retention (days)',
    'Artifact 最大体积 (MB)': 'Artifact max size (MB)',
    '全局索引服务端口': 'Global daemon port',
    '共享全局模型实例': 'Share the global model instance',
    '不可用时自动回退项目内后端': 'Falls back to in-project backends when unavailable',
    '索引变化后自动评测': 'Auto-evaluate after index changes',
    '后台低优先级运行；默认每项目最多每天一次': 'Background low priority; at most once per project per day by default',
    '自动评测最短间隔（小时）': 'Min auto-eval interval (hours)',
    '自动评测查询数': 'Auto-eval query count',
    '保存配置': 'Save config',

    /* ---- app.js 动态文案 ---- */
    '读取守卫': 'Read guard',
    '大文件自动限行数；拦截重复全量读取': 'Caps big file reads; blocks repeated full re-reads',
    '低价值文件拦截': 'Low-value file blocking',
    '锁文件 / 构建产物 / 超大数据文件': 'Lockfiles / build output / oversized data files',
    '命令输出治理': 'Command output governance',
    '高噪音命令只回显头尾，完整日志落盘': 'Noisy commands echo head/tail only; full logs saved to disk',
    '编辑失效': 'Edit invalidation',
    '文件编辑后允许重读（防误拦，建议开启）': 'Allows re-reads after edits (prevents false blocks; keep on)',
    '命令审计': 'Command audit',
    '记录输出体量，找出噪音大户（纯统计）': 'Records output volume to find noise hogs (stats only)',
    'MCP 审计': 'MCP audit',
    '记录 MCP 工具输出体量（纯统计）': 'Records MCP tool output volume (stats only)',
    '会话跟踪': 'Session tracking',
    '会话与上下文压缩统计（纯统计）': 'Session and compaction stats (stats only)',
    '全量读取行数上限': 'Full-read line cap',
    '重复读取拦截窗口 (毫秒, 0=关闭)': 'Repeat-read block window (ms, 0=off)',
    '数据文件拦截阈值 (字节)': 'Data-file block threshold (bytes)',
    '命令输出保留头部行数': 'Command output head lines kept',
    '命令输出保留尾部行数': 'Command output tail lines kept',
    '读取截断': 'Read capped',
    '拦截超大读取': 'Oversized read blocked',
    '拦截重复读': 'Repeat read blocked',
    '重试放行': 'Retry allowed',
    '拦截文件': 'File blocked',
    '输出截断': 'Output truncated',
    '命令改写': 'Command rewritten',
    '会话开始': 'Session start',
    '会话结束': 'Session stop',
    '上下文压缩': 'Context compaction',
    '仓库地图': 'Repo map',
    '文件大纲': 'File outline',
    '紧凑搜索': 'Compact search',
    '语义搜索': 'Semantic search',
    '压缩读取': 'Compact read',
    '索引自动刷新': 'Index auto-refresh',
    '索引自动构建': 'Index auto-build',
    '脚本自动升级': 'Script auto-upgrade',
    '无损上下文查询': 'Lossless context query',
    '证据展开': 'Evidence expand',
    '完整日志回取': 'Full log recovery',
    '增量重读差分': 'Delta re-read',
    '工具结果去重': 'Tool result dedup',
    '智能测试选择': 'Smart test selection',
    '任务检查点': 'Task checkpoint',
    '.cursorignore 自动维护': '.cursorignore auto-maintain',
    '记忆保存': 'Memory save',
    '记忆召回': 'Memory recall',
    '新鲜': 'Fresh',
    '待刷新': 'Stale',
    '未索引': 'Unindexed',
    '已删除': 'Deleted',
    '约定': 'convention',
    '决策': 'decision',
    '坑': 'gotcha',
    '入口': 'entrypoint',
    '事实': 'fact',
    '关系': 'relation',
    '技能': 'skill',
    '自定义': 'Custom',
    '已保存': 'Saved',
    '保存失败': 'Save failed',
    '剔除失败: ': 'Remove failed: ',
    '从面板剔除「{0}」？\n\n只是不再聚合展示，项目里的 hooks、配置和统计不受影响，新会话也不会自动加回。想恢复时在该项目重跑 cursor-token-saver init。':
      'Remove "{0}" from the dashboard?\n\nIt only leaves the aggregate view — the hooks, config and stats inside the project are untouched, and new sessions will not re-add it. To restore, re-run cursor-token-saver init in that project.',
    '· 语义搜索模型: {0}': '· semantic search model: {0}',
    '· 语义搜索索引未建立': '· semantic search index not built',
    '未建索引': 'no index',
    '≈ {0} ({1} · 按 {2} 输入价)': '≈ {0} ({1} · at {2} input price)',
    '≈ {0} 原始内容': '≈ {0} of raw content',
    '最近压缩时上下文 {0} tokens': 'Context at last compaction: {0} tokens',
    '尚无压缩事件': 'No compaction events yet',
    '节省 tokens': 'Saved tokens',
    '输出字节': 'Output bytes',
    '未运行': 'Not running',
    'MCP 服务器（随 Cursor 打开项目启动）还没写过心跳':
      "The MCP server (starts when Cursor opens the project) hasn't written a heartbeat yet",
    '已停止': 'Stopped',
    'MCP 服务器进程不在了——重启 Cursor 或在 MCP 设置里刷新':
      'The MCP server process is gone — restart Cursor or refresh it under MCP settings',
    '脚本已升级，待重启': 'Scripts upgraded, restart pending',
    '刷新该项目的 repo-map MCP 后加载新代码': "Refresh this project's repo-map MCP to load the new code",
    '运行中': 'Running',
    '建索引中…': 'Indexing…',
    '建索引中… {0}/{1}': 'Indexing… {0}/{1}',
    '已禁用 (autoIndex=false)': 'Disabled (autoIndex=false)',
    '无嵌入后端': 'No embedding backend',
    '出错': 'Error',
    '等待首次检查': 'Awaiting first check',
    '上次检查 {0}': 'Last check {0}',
    '上次重建 {0}（{1} 个文件）': 'Last rebuild {0} ({1} files)',
    '每 5 分钟自动检查一次': 'Auto-checks every 5 minutes',
    '未知': 'Unknown',
    '更新于 {0}': 'Updated {0}',
    '索引体积 {0}': 'Index size {0}',
    '全部新鲜': 'All fresh',
    '{0} 项待同步': '{0} pending',
    '语义搜索结果为最新代码': 'Semantic search reflects the latest code',
    '待刷新 {0} · 未索引 {1} · 已删除 {2}': 'stale {0} · unindexed {1} · deleted {2}',
    '——正在建索引，完成后自动消化': ' — indexing now, absorbed automatically when done',
    '——自动检查每 5 分钟一次，最迟 5 分钟内重嵌': ' — auto-check runs every 5 minutes; re-embedded within 5 minutes at most',
    '——自动索引未运行，重启 Cursor 后会处理': " — auto-indexing isn't running; it will catch up after restarting Cursor",
    '… 另有 {0} 个文件，可用过滤框缩小范围': '… {0} more files — narrow down with the filter box',
    '没有匹配的文件': 'No matching files',
    '源码引用 {0} · artifact {1} · 去重命中 {2} · 展开 {3}': 'source refs {0} · artifacts {1} · dedup hits {2} · expands {3}',
    '{0} 个会话 · 合计 {1} tokens · 传输 {2} / 原始 {3}': '{0} sessions · {1} tokens total · transmitted {2} / raw {3}',
    'PID {0} · 127.0.0.1:{1} · 所有项目共享模型': 'PID {0} · 127.0.0.1:{1} · model shared by all projects',
    '首次神经检索时自动启动；失败立即回退项目内模型': 'Starts on first neural retrieval; falls back to the in-project model on failure',
    '已自动计划': 'Auto-scheduled',
    '预计 {0} 后台低优先级运行': 'Expected to run in background after {0}',
    '自动评测中…': 'Auto-evaluating…',
    '不阻塞 Agent；完成后这里自动显示 Hit@K / MRR': "Doesn't block the agent; Hit@K / MRR shows here when done",
    '已关闭': 'Off',
    '可在配置页重新开启索引变化后自动评测': 'Re-enable auto-eval after index changes on the Config page',
    '评测失败': 'Eval failed',
    '失败不影响索引和正常检索': "Failures don't affect the index or normal retrieval",
    '等待索引变化': 'Waiting for index changes',
    '索引首次构建或增量刷新后会自动后台评测': 'Runs automatically in background after the first build or an incremental refresh',
    '本地 artifact': 'local artifact',
    '还没有证据；调用 context_query 后会出现在这里': 'No evidence yet; it appears after context_query calls',
    '（最近 {0} 天，支持全部项目聚合）': '(last {0} days; aggregates across all projects)',
    '没有发现频繁重读的文件': 'No repeatedly re-read files found',
    '没有发现未治理的高噪音命令': 'No ungoverned noisy commands found',
    '没有发生过 override（拦截判断都被接受）': 'No overrides (all blocks were accepted)',
    '技能累计复用 {0} 次': 'Skills reused {0} times total',
    '还没有记忆。agent 调用 memory_save 或保存带决策的 checkpoint 后会出现在这里。':
      'No memories yet — they appear after the agent calls memory_save or saves a checkpoint with decisions.',
    '已归档': 'Archived',
    '候选': 'Candidate',
    '生效': 'Active',
    '过期': 'STALE',
    '确认': 'Confirm',
    '编辑': 'Edit',
    '恢复': 'Restore',
    '归档': 'Archive',
    '删除': 'Delete',
    '机械提取复发次数': 'recurrence count from mechanical extraction',
    '全局': 'Global',
    '编辑记忆内容：': 'Edit memory text:',
    '彻底删除这条记忆？（归档是可恢复的软删除，删除不可恢复）':
      'Permanently delete this memory? (Archiving is a recoverable soft delete; deletion is not.)',
    '保守': 'Conservative',
    '只拦最明确的浪费，几乎零能力影响': 'Blocks only the most clear-cut waste; near-zero capability impact',
    '标准': 'Standard',
    '推荐档位：省得多且不丢信息': 'Recommended: saves a lot without losing information',
    '极致': 'Extreme',
    '最大化节省，接受轻微使用摩擦': 'Maximum savings; accepts slight friction',
    '读取上限 {0} 行 · 重复读窗口 {1} 分钟': 'Read cap {0} lines · repeat-read window {1} min',
    '数据文件阈值 {0} KB · 命令输出 头{1}/尾{2} 行': 'Data-file threshold {0} KB · output head {1}/tail {2} lines',
    '档位默认: {0}': 'profile default: {0}',
    '保存中…': 'Saving…',
    '已保存，立即生效': 'Saved — effective immediately',
    '保存失败: ': 'Save failed: '
  };

  window.tr = (key, ...args) => {
    let s = window.LANG === 'en' && D[key] ? D[key] : key;
    for (let i = 0; i < args.length; i++) s = s.split('{' + i + '}').join(String(args[i]));
    return s;
  };

  /* 服务端下发的浪费建议是带参数的中文整句，按已知模板翻译 */
  const SUGGESTION_RULES = [
    [/^「(.+)」(\d+) 天内被全量读 (\d+) 次（每次 ~(\d+)KB）。重复间隔超过了拦截窗口——可调大 repeatReadWindowMs，或让 agent 改用 context_query mode=read\/read_compact。$/,
      '"$1" was fully read $3 times in $2 days (~$4KB each). The interval exceeded the block window — raise repeatReadWindowMs, or have the agent use context_query mode=read/read_compact.'],
    [/^命令「(.+)」累计产出 (\d+)KB 未治理输出（(\d+) 次）。不在 shell-guard 白名单内——考虑让 agent 重定向到文件后 grep，或反馈加入白名单。$/,
      'Command "$1" produced $2KB of ungoverned output over $3 runs. It is outside the shell-guard whitelist — have the agent redirect to a file and grep, or request whitelisting.'],
    [/^拦截后被重试放行的比例偏高（(\d+)\/(\d+)）。agent 坚持要全文说明阈值拦错了——考虑调大 readMaxLines 或缩短重复读窗口。$/,
      'A high share of blocks were retried through ($1/$2). The agent insisting on full text means the threshold is miscalibrated — raise readMaxLines or shorten the repeat-read window.'],
    [/^有 (\d+) 次大数据文件（json\/csv\/log 等 >128KB）全量读。agent 可用 context_query mode=profile 拿结构画像，再按正则\/行区间精确回取。$/,
      '$1 full reads of large data files (json/csv/log >128KB). The agent can use context_query mode=profile for a structural profile, then recall exact rows by regex/line range.'],
    [/^过去 7 天没有发现明显的浪费点，当前配置与实际使用匹配良好。$/,
      'No obvious waste found in the past 7 days — the current config matches real usage well.']
  ];
  window.trSuggestion = (s) => {
    if (window.LANG !== 'en') return s;
    for (const [re, out] of SUGGESTION_RULES) {
      if (re.test(s)) return s.replace(re, out);
    }
    return s;
  };

  /* 静态 DOM 翻译（脚本在 </body> 前加载，DOM 已就绪） */
  document.documentElement.lang = window.LANG === 'en' ? 'en' : 'zh-CN';
  if (window.LANG === 'en') {
    document.title = D['cursor-token-saver 面板'];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const trimmed = node.nodeValue.trim();
      if (trimmed && D[trimmed]) node.nodeValue = node.nodeValue.replace(trimmed, D[trimmed]);
    }
    for (const el of document.querySelectorAll('[title], [placeholder]')) {
      for (const attr of ['title', 'placeholder']) {
        const v = el.getAttribute(attr);
        if (v && D[v]) el.setAttribute(attr, D[v]);
      }
    }
  }

  /* 语言切换按钮 */
  const btn = document.getElementById('lang-btn');
  if (btn) {
    btn.textContent = window.LANG === 'en' ? '中文' : 'EN';
    btn.addEventListener('click', () => {
      localStorage.setItem('cts-lang', window.LANG === 'en' ? 'zh' : 'en');
      location.reload();
    });
  }
})();
