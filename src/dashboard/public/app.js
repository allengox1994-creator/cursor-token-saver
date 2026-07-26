/* global Chart */
const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '0');
const kb = (n) => `${((n || 0) / 1024).toFixed(1)} KB`;

const HOOK_DESCS = {
  readGuard: ['读取守卫', '大文件自动限行数；拦截重复全量读取'],
  fileBlocklist: ['低价值文件拦截', '锁文件 / 构建产物 / 超大数据文件'],
  shellGuard: ['命令输出治理', '高噪音命令只回显头尾，完整日志落盘'],
  editInvalidate: ['编辑失效', '文件编辑后允许重读（防误拦，建议开启）'],
  shellAudit: ['命令审计', '记录输出体量，找出噪音大户（纯统计）'],
  mcpAudit: ['MCP 审计', '记录 MCP 工具输出体量（纯统计）'],
  sessionTrack: ['会话跟踪', '会话与上下文压缩统计（纯统计）']
};

const OVERRIDE_DESCS = {
  readMaxLines: '全量读取行数上限',
  repeatReadWindowMs: '重复读取拦截窗口 (毫秒, 0=关闭)',
  blockMaxDataBytes: '数据文件拦截阈值 (字节)',
  shellHeadLines: '命令输出保留头部行数',
  shellTailLines: '命令输出保留尾部行数'
};

const ACTION_LABELS = {
  cap: ['读取截断', 'save'],
  'deny-oversize': ['拦截超大读取', 'save'],
  'deny-repeat': ['拦截重复读', 'deny'],
  'override-allow': ['重试放行', 'info'],
  deny: ['拦截文件', 'deny'],
  truncate: ['输出截断', 'save'],
  rewrite: ['命令改写', 'info'],
  observe: ['命令审计', 'info'],
  session_start: ['会话开始', 'info'],
  stop: ['会话结束', 'info'],
  compact: ['上下文压缩', 'warn'],
  repo_map: ['仓库地图', 'save'],
  file_outline: ['文件大纲', 'save'],
  smart_search: ['紧凑搜索', 'save'],
  semantic_search: ['语义搜索', 'save'],
  read_compact: ['压缩读取', 'save'],
  index_refresh: ['索引自动刷新', 'info'],
  index_build: ['索引自动构建', 'info'],
  scripts_sync: ['脚本自动升级', 'info'],
  context_query: ['无损上下文查询', 'save'],
  context_expand: ['证据展开', 'info'],
  artifact_recover: ['完整日志回取', 'info'],
  'delta-read': ['增量重读差分', 'save'],
  tool_dedup: ['工具结果去重', 'save'],
  test_select: ['智能测试选择', 'info'],
  context_checkpoint: ['任务检查点', 'info'],
  ignore_rescan: ['.cursorignore 自动维护', 'info'],
  memory_save: ['记忆保存', 'info'],
  memory_recall: ['记忆召回', 'info']
};

const chartDefaults = {
  color: '#8b93a3',
  borderColor: '#262b36'
};
let charts = [];
let currentProject = 'all';

/* ---------- 计价设置 ---------- */
const PRICE_PRESETS = [
  { name: 'Claude Sonnet', price: 3 },
  { name: 'Claude Opus', price: 15 },
  { name: 'GPT', price: 2.5 },
  { name: 'Gemini Pro', price: 1.25 },
  { name: 'DeepSeek', price: 0.27 },
  { name: '自定义', price: null }
];
let settings = { priceName: 'Claude Sonnet', pricePerMTokUsd: 3, usdToCny: 7.2 };

function money(tokens) {
  const usd = (tokens / 1e6) * settings.pricePerMTokUsd;
  const cny = usd * settings.usdToCny;
  const f = (n, sym) => sym + (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2));
  return { usd: f(usd, '$'), cny: f(cny, '¥') };
}

function shortModel(m) {
  if (!m) return '';
  return m.replace(/^transformers:/, '').replace(/^ollama:/, 'ollama/').split('/').pop();
}

async function loadSettings() {
  const data = await (await fetch('/api/settings')).json();
  settings = data.settings;
  const sel = $('#price-preset');
  sel.innerHTML = '';
  for (const p of PRICE_PRESETS) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.price != null ? `${p.name} ($${p.price}/M)` : p.name;
    sel.appendChild(o);
  }
  sel.value = PRICE_PRESETS.some((p) => p.name === settings.priceName) ? settings.priceName : '自定义';
  $('#price-input').value = settings.pricePerMTokUsd;
  $('#rate-input').value = settings.usdToCny;
}

$('#price-preset').addEventListener('change', (ev) => {
  const preset = PRICE_PRESETS.find((p) => p.name === ev.target.value);
  if (preset && preset.price != null) $('#price-input').value = preset.price;
});

$('#price-save').addEventListener('click', async () => {
  const body = {
    priceName: $('#price-preset').value,
    pricePerMTokUsd: Number($('#price-input').value),
    usdToCny: Number($('#rate-input').value)
  };
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.ok) {
    settings = data.settings;
    $('#price-msg').textContent = '已保存';
    loadStats();
  } else {
    $('#price-msg').textContent = '保存失败';
  }
  setTimeout(() => ($('#price-msg').textContent = ''), 3000);
});

/* ---------- 项目选择 ---------- */
async function loadProjects() {
  const data = await (await fetch('/api/projects')).json();
  const sel = $('#project-select');
  const prev = currentProject;
  sel.innerHTML = '<option value="all">全部项目</option>';
  for (const p of data.projects) {
    const optEl = document.createElement('option');
    optEl.value = p.path;
    optEl.textContent = p.name;
    optEl.title = p.path;
    sel.appendChild(optEl);
  }
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : 'all';
  currentProject = sel.value;
}

function switchProject(value) {
  currentProject = value;
  $('#project-select').value = value;
  $('#project-remove').classList.toggle('hidden', value === 'all');
  loadStats();
  loadConfig();
  if ($('#tab-index').classList.contains('active')) loadIndexView();
  if ($('#tab-context').classList.contains('active')) loadContextView();
  if ($('#tab-waste').classList.contains('active')) loadWasteView();
  if ($('#tab-memory').classList.contains('active')) loadMemoryView();
}

$('#project-select').addEventListener('change', (ev) => switchProject(ev.target.value));

$('#project-remove').addEventListener('click', async () => {
  if (currentProject === 'all') return;
  const name = $('#project-select').selectedOptions[0]?.textContent || currentProject;
  if (!confirm(`从面板剔除「${name}」？\n\n只是不再聚合展示，项目里的 hooks、配置和统计不受影响，新会话也不会自动加回。想恢复时在该项目重跑 cursor-token-saver init。`)) return;
  const res = await fetch('/api/projects?project=' + encodeURIComponent(currentProject), { method: 'DELETE' });
  const data = await res.json();
  if (data.ok) {
    await loadProjects();
    switchProject('all');
  } else {
    alert('剔除失败: ' + (data.error || res.status));
  }
});

/* ---------- tabs ---------- */
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $('#tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'index') loadIndexView();
    if (btn.dataset.tab === 'context') loadContextView();
    if (btn.dataset.tab === 'waste') loadWasteView();
    if (btn.dataset.tab === 'memory') loadMemoryView();
  });
});

/* ---------- stats ---------- */
function makeChart(id, config) {
  if (typeof Chart === 'undefined') return; // CDN 加载失败时降级为纯表格
  const el = $(id);
  if (!el) return;
  charts.push(new Chart(el, config));
}

async function loadStats() {
  const s = await (await fetch('/api/summary?project=' + encodeURIComponent(currentProject))).json();
  if (s.error) return;
  const isAll = s.project === 'all';
  $('#empty-hint').classList.toggle('hidden', s.totals.events > 0);
  document.body.classList.toggle('view-all', isAll);

  // 全局视图：项目总览表
  $('#panel-projects').classList.toggle('hidden', !isAll);
  if (isAll) {
    const ptbody = $('#projects-table tbody');
    ptbody.innerHTML = '';
    for (const p of s.perProject || []) {
      const m = money(p.totals.savedTokens);
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.innerHTML =
        `<td title="${escapeHtml(p.path)}">${escapeHtml(p.name)}</td>` +
        `<td class="num">${fmt(p.totals.savedTokens)}</td>` +
        `<td class="num">${m.cny}</td>` +
        `<td class="num">${fmt(p.totals.denies)}</td>` +
        `<td class="num">${fmt(p.totals.caps + p.totals.truncates)}</td>` +
        `<td class="num">${fmt(p.totals.events)}</td>` +
        `<td class="muted" title="${escapeHtml(p.embedModel || '')}">${escapeHtml(shortModel(p.embedModel) || '未建索引')}</td>` +
        `<td class="muted">${(p.lastEventTs || '').replace('T', ' ').slice(5, 16)}</td>`;
      tr.addEventListener('click', () => switchProject(p.path));
      ptbody.appendChild(tr);
    }
  }

  // 嵌入模型显示：单项目视图取自身；全局视图汇总去重
  const models = isAll
    ? [...new Set((s.perProject || []).map((p) => p.embedModel).filter(Boolean))]
    : s.embedModel
      ? [s.embedModel]
      : [];
  $('#embed-model-line').textContent =
    models.length > 0 ? `· 语义搜索模型: ${models.map(shortModel).join(', ')}` : '· 语义搜索索引未建立';

  $('#c-saved').textContent = fmt(s.totals.savedTokens);
  const m = money(s.totals.savedTokens);
  $('#c-saved-money').textContent = `≈ ${m.cny} (${m.usd} · 按 ${settings.priceName} 输入价)`;
  $('#c-saved-bytes').textContent = `≈ ${kb(s.totals.savedBytes)} 原始内容`;
  $('#c-denies').textContent = fmt(s.totals.denies);
  $('#c-truncs').textContent = fmt(s.totals.caps + s.totals.truncates);
  $('#c-sessions').textContent = `${fmt(s.totals.sessions)} / ${fmt(s.totals.compactions)}`;
  const lastCompact = s.compactions[s.compactions.length - 1];
  $('#c-compact-hint').textContent = lastCompact
    ? `最近压缩时上下文 ${fmt(lastCompact.context_tokens)} tokens`
    : '尚无压缩事件';

  charts.forEach((c) => c.destroy());
  charts = [];

  makeChart('#chart-daily', {
    type: 'line',
    data: {
      labels: s.daily.map((d) => d.date),
      datasets: [{
        label: '节省 tokens',
        data: s.daily.map((d) => d.savedTokens),
        borderColor: '#4ade80',
        backgroundColor: 'rgba(74,222,128,0.15)',
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: chartDefaults.color }, grid: { color: chartDefaults.borderColor } },
        y: { ticks: { color: chartDefaults.color }, grid: { color: chartDefaults.borderColor } }
      }
    }
  });

  const actionEntries = Object.entries(s.byAction).filter(([a]) => ACTION_LABELS[a]);
  makeChart('#chart-actions', {
    type: 'doughnut',
    data: {
      labels: actionEntries.map(([a]) => ACTION_LABELS[a][0]),
      datasets: [{
        data: actionEntries.map(([, n]) => n),
        backgroundColor: ['#4ade80', '#f87171', '#60a5fa', '#fbbf24', '#a78bfa', '#f472b6', '#34d399', '#fb923c', '#94a3b8'],
        borderWidth: 0
      }]
    },
    options: { plugins: { legend: { position: 'right', labels: { color: chartDefaults.color } } } }
  });

  makeChart('#chart-files', {
    type: 'bar',
    data: {
      labels: s.topFiles.map((f) => f.file.split('/').pop()),
      datasets: [{ label: '节省 tokens', data: s.topFiles.map((f) => f.savedTokens), backgroundColor: '#4ade80' }]
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: chartDefaults.color }, grid: { color: chartDefaults.borderColor } },
        y: { ticks: { color: chartDefaults.color }, grid: { display: false } }
      }
    }
  });

  makeChart('#chart-commands', {
    type: 'bar',
    data: {
      labels: s.topCommands.map((c) => (c.command.length > 30 ? c.command.slice(0, 30) + '…' : c.command)),
      datasets: [{ label: '输出字节', data: s.topCommands.map((c) => c.bytes), backgroundColor: '#60a5fa' }]
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: chartDefaults.color }, grid: { color: chartDefaults.borderColor } },
        y: { ticks: { color: chartDefaults.color }, grid: { display: false } }
      }
    }
  });

  const tbody = $('#events-table tbody');
  tbody.innerHTML = '';
  for (const e of s.recent.slice(0, 40)) {
    const [label, cls] = ACTION_LABELS[e.action] || [e.action, 'info'];
    const obj = e.file || e.command || e.evidenceId || e.artifactId || e.logPath ||
      (e.action === 'compact' ? `${fmt(e.context_tokens)} tokens (${e.context_usage_percent}%)` : '') || '';
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${(e.ts || '').replace('T', ' ').slice(5, 19)}</td>` +
      `<td class="col-project">${escapeHtml(e.project || '')}</td>` +
      `<td>${e.hook || ''}</td>` +
      `<td><span class="badge ${cls}">${label}</span></td>` +
      `<td class="obj" title="${escapeHtml(obj)}">${escapeHtml(obj)}</td>` +
      `<td class="num">${e.savedTokens ? fmt(e.savedTokens) : ''}</td>`;
    tbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------- index ---------- */
const INDEX_STATUS = {
  ok: ['新鲜', 'save'],
  stale: ['待刷新', 'warn'],
  new: ['未索引', 'info'],
  deleted: ['已删除', 'deny']
};
let indexFiles = [];

function renderAutoStatus(auto) {
  const el = $('#i-auto');
  const sub = $('#i-auto-sub');
  if (!auto) {
    el.textContent = '未运行';
    sub.textContent = 'MCP 服务器（随 Cursor 打开项目启动）还没写过心跳';
    return;
  }
  if (!auto.alive) {
    el.textContent = '已停止';
    sub.textContent = 'MCP 服务器进程不在了——重启 Cursor 或在 MCP 设置里刷新';
    return;
  }
  if (auto.needsRestart) {
    el.textContent = '脚本已升级，待重启';
    sub.textContent = '刷新该项目的 repo-map MCP 后加载新代码';
    return;
  }
  const STATE = {
    ready: '运行中',
    building: '建索引中…',
    disabled: '已禁用 (autoIndex=false)',
    'no-backend': '无嵌入后端',
    error: '出错',
    idle: '等待首次检查'
  };
  el.textContent =
    auto.state === 'building' && auto.total > 0 ? `建索引中… ${auto.done}/${auto.total}` : STATE[auto.state] || auto.state;
  const parts = [];
  if (auto.lastCheck) parts.push('上次检查 ' + new Date(auto.lastCheck).toLocaleTimeString());
  if (auto.lastBuild) parts.push('上次重建 ' + new Date(auto.lastBuild).toLocaleTimeString() + `（${auto.embedded} 个文件）`);
  if (auto.error) parts.push(auto.error);
  sub.textContent = parts.join(' · ') || '每 5 分钟自动检查一次';
}

async function loadIndexView() {
  const isAll = currentProject === 'all';
  $('#index-hint').classList.toggle('hidden', !isAll);
  $('#index-none').classList.add('hidden');
  $('#index-body').classList.toggle('hidden', isAll);
  if (isAll) return;
  const data = await (await fetch('/api/index?project=' + encodeURIComponent(currentProject))).json();
  if (data.error) return;
  if (!data.exists) {
    $('#index-body').classList.add('hidden');
    $('#index-none').classList.remove('hidden');
    return;
  }
  renderAutoStatus(data.auto);
  $('#i-model').textContent = shortModel(data.model) || '未知';
  $('#i-updated').textContent = '更新于 ' + new Date(data.updatedAt).toLocaleString();
  const t = data.totals;
  $('#i-files').textContent = `${fmt(t.ok + t.stale + t.deleted)} / ${fmt(t.chunks)}`;
  $('#i-size').textContent = '索引体积 ' + kb(data.sizeBytes);
  const pending = t.stale + t.new + t.deleted;
  $('#i-health').textContent = pending === 0 ? '全部新鲜' : `${fmt(pending)} 项待同步`;
  let healthSub = '语义搜索结果为最新代码';
  if (pending > 0) {
    const detail = `待刷新 ${t.stale} · 未索引 ${t.new} · 已删除 ${t.deleted}`;
    if (data.auto?.alive && data.auto.state === 'building') healthSub = detail + '——正在建索引，完成后自动消化';
    else if (data.auto?.alive) healthSub = detail + '——自动检查每 5 分钟一次，最迟 5 分钟内重嵌';
    else healthSub = detail + '——自动索引未运行，重启 Cursor 后会处理';
  }
  $('#i-health-sub').textContent = healthSub;
  indexFiles = data.files;
  renderIndexTable();
}

function renderIndexTable() {
  const q = ($('#index-filter').value || '').toLowerCase();
  const rows = indexFiles.filter((f) => !q || f.rel.toLowerCase().includes(q));
  const tbody = $('#index-table tbody');
  tbody.innerHTML = rows
    .slice(0, 300)
    .map((f) => {
      const [label, cls] = INDEX_STATUS[f.status] || [f.status, 'info'];
      return `<tr><td>${escapeHtml(f.rel)}</td><td class="num">${f.chunks || '-'}</td><td><span class="badge ${cls}">${label}</span></td></tr>`;
    })
    .join('');
  if (rows.length > 300) {
    tbody.innerHTML += `<tr><td colspan="3" class="obj">… 另有 ${fmt(rows.length - 300)} 个文件，可用过滤框缩小范围</td></tr>`;
  }
  if (!rows.length) tbody.innerHTML = '<tr><td colspan="3" class="obj">没有匹配的文件</td></tr>';
}

$('#index-filter').addEventListener('input', renderIndexTable);

// 停留在索引页时每 30 秒自动刷新（MCP 服务器启动 45 秒后才建索，避免"看起来没动静"）
setInterval(() => {
  if ($('#tab-index').classList.contains('active') && currentProject !== 'all') loadIndexView();
}, 30 * 1000);

/* ---------- lossless context ---------- */
async function loadContextView() {
  const isAll = currentProject === 'all';
  $('#context-hint').classList.toggle('hidden', !isAll);
  $('#context-body').classList.toggle('hidden', isAll);
  if (isAll) return;
  const data = await (await fetch('/api/context?project=' + encodeURIComponent(currentProject))).json();
  if (data.error) return;
  $('#x-entries').textContent = fmt(data.store.entries);
  $('#x-entry-sub').textContent =
    `源码引用 ${fmt(data.store.sourceEntries)} · artifact ${fmt(data.store.artifacts)} · ` +
    `去重命中 ${fmt(data.metrics?.dedupHits)} · 展开 ${fmt(data.metrics?.expands)}`;
  $('#x-bytes').textContent = kb(data.store.bytes);
  $('#x-budget').textContent = fmt(data.budget.maxUsedTokens);
  $('#x-budget-sub').textContent =
    `${fmt(data.budget.sessions)} 个会话 · 合计 ${fmt(data.budget.usedTokens)} tokens · ` +
    `传输 ${kb(data.metrics?.transmittedBytes)} / 原始 ${kb(data.metrics?.originalBytes)}`;
  $('#x-checkpoints').textContent = fmt(data.checkpoints);
  $('#x-daemon').textContent = data.daemon?.alive ? '运行中' : '未运行';
  $('#x-daemon-sub').textContent = data.daemon?.alive
    ? `PID ${data.daemon.pid} · 127.0.0.1:${data.daemon.port} · 所有项目共享模型`
    : '首次神经检索时自动启动；失败立即回退项目内模型';
  const evalState = data.evaluationStatus?.state;
  if (evalState === 'scheduled') {
    $('#x-eval').textContent = '已自动计划';
    $('#x-eval-sub').textContent = `预计 ${new Date(data.evaluationStatus.dueAt).toLocaleString()} 后台低优先级运行`;
  } else if (evalState === 'starting' || evalState === 'waiting' || evalState === 'running') {
    $('#x-eval').textContent = '自动评测中…';
    $('#x-eval-sub').textContent = '不阻塞 Agent；完成后这里自动显示 Hit@K / MRR';
  } else if (evalState === 'disabled') {
    $('#x-eval').textContent = '已关闭';
    $('#x-eval-sub').textContent = '可在配置页重新开启索引变化后自动评测';
  } else if (evalState === 'error') {
    $('#x-eval').textContent = '评测失败';
    $('#x-eval-sub').textContent = data.evaluationStatus.error || '失败不影响索引和正常检索';
  } else {
    $('#x-eval').textContent = data.evaluation ? `Hit@5 ${(data.evaluation.hitAt5 * 100).toFixed(1)}%` : '等待索引变化';
    $('#x-eval-sub').textContent = data.evaluation
      ? `${fmt(data.evaluation.cases)} queries · Hit@1 ${(data.evaluation.hitAt1 * 100).toFixed(1)}% · MRR ${data.evaluation.mrr.toFixed(3)}`
      : '索引首次构建或增量刷新后会自动后台评测';
  }
  const tbody = $('#context-table tbody');
  tbody.innerHTML = (data.recent || [])
    .map(
      (e) =>
        `<tr><td><code>${escapeHtml(e.id)}</code></td><td>${escapeHtml(e.kind || '')}</td>` +
        `<td class="obj">${escapeHtml(e.rel || '本地 artifact')}</td><td class="num">${kb(e.bytes)}</td>` +
        `<td class="muted">${new Date(e.accessedAt || e.createdAt).toLocaleString()}</td></tr>`
    )
    .join('');
  if (!data.recent?.length) tbody.innerHTML = '<tr><td colspan="5" class="obj">还没有证据；调用 context_query 后会出现在这里</td></tr>';
}

/* ---------- waste insights ---------- */
async function loadWasteView() {
  const data = await (await fetch('/api/waste?project=' + encodeURIComponent(currentProject))).json();
  if (data.error) return;
  $('#waste-window').textContent = `（最近 ${data.windowDays} 天，支持全部项目聚合）`;

  const ul = $('#waste-suggestions');
  ul.innerHTML = '';
  for (const s of data.suggestions) {
    const li = document.createElement('li');
    li.textContent = s;
    ul.appendChild(li);
  }

  const fill = (sel, rows, render, emptyText) => {
    const tbody = $(sel + ' tbody');
    tbody.innerHTML = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="4" class="muted">${emptyText}</td>`;
      tbody.appendChild(tr);
      return;
    }
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = render(r);
      tbody.appendChild(tr);
    }
  };
  const kb = (b) => (b >= 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');
  fill(
    '#waste-reads',
    data.repeatedReads,
    (r) =>
      `<td class="obj" title="${escapeHtml(r.file)}">${escapeHtml(r.file)}</td>` +
      `<td class="num">${r.count}</td><td class="num">${kb(r.bytes)}</td><td class="num">${kb(r.wastedBytes)}</td>`,
    '没有发现频繁重读的文件'
  );
  fill(
    '#waste-commands',
    data.ungoverned,
    (r) =>
      `<td class="obj" title="${escapeHtml(r.command)}">${escapeHtml(r.command)}</td>` +
      `<td class="num">${r.count}</td><td class="num">${kb(r.bytes)}</td>`,
    '没有发现未治理的高噪音命令'
  );
  fill(
    '#waste-overrides',
    data.topOverrides,
    (r) => `<td class="obj" title="${escapeHtml(r.file)}">${escapeHtml(r.file)}</td><td class="num">${r.count}</td>`,
    '没有发生过 override（拦截判断都被接受）'
  );
}

/* ---------- memory ---------- */
const MEMORY_KIND_LABELS = { convention: '约定', decision: '决策', gotcha: '坑', entrypoint: '入口', fact: '事实', relation: '关系', skill: '技能' };

async function loadMemoryView() {
  const isAll = currentProject === 'all';
  $('#memory-hint').classList.toggle('hidden', !isAll);
  $('#memory-body').classList.toggle('hidden', isAll);
  if (isAll) return;
  const data = await (await fetch('/api/memory?project=' + encodeURIComponent(currentProject))).json();
  if (data.error) return;
  const st = data.stats || {};
  $('#mem-counts').textContent = `${st.active ?? 0} / ${st.candidate ?? 0}`;
  $('#mem-recalls').textContent = st.totalRecalls ?? 0;
  $('#mem-never').textContent = st.neverRecalled ?? 0;
  $('#mem-stale').textContent = st.stale ?? 0;
  $('#mem-world').textContent = `${st.relations ?? 0} / ${st.skills ?? 0}`;
  $('#mem-skill-reuse').textContent = `技能累计复用 ${st.skillReuse ?? 0} 次`;
  const tbody = $('#memory-table tbody');
  tbody.innerHTML = '';
  if (!data.memories.length) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="obj">还没有记忆。agent 调用 memory_save 或保存带决策的 checkpoint 后会出现在这里。</td></tr>';
    return;
  }
  for (const m of data.memories) {
    const status =
      m.status === 'archived'
        ? '<span class="muted">归档</span>'
        : (m.status === 'candidate' ? '<span class="mem-candidate">候选</span>' : '<span class="mem-active">生效</span>') +
          (m.stale ? ' <span class="mem-stale">过期</span>' : '');
    const files = (m.files || []).map((f) => f.path).join(', ');
    const extra =
      m.kind === 'skill' && (m.steps || []).length
        ? m.steps.map((s, i) => `${i + 1}) ${s}`).join('　')
        : files;
    const conf = (m.confidence || 1) > 1 ? ` <span class="mem-candidate" title="机械提取复发次数">×${m.confidence}</span>` : '';
    const actions = [
      m.status !== 'archived' && (m.status === 'candidate' || m.stale) ? `<button data-act="confirm" data-id="${m.id}">确认</button>` : '',
      `<button data-act="edit" data-id="${m.id}">编辑</button>`,
      m.status === 'archived'
        ? `<button data-act="restore" data-id="${m.id}">恢复</button>`
        : `<button data-act="archive" data-id="${m.id}">归档</button>`,
      `<button data-act="delete" data-id="${m.id}">删除</button>`
    ]
      .filter(Boolean)
      .join(' ');
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="obj" title="${escapeHtml(extra)}">${escapeHtml(m.text)}${conf}${extra ? `<div class="muted mem-files">${escapeHtml(extra)}</div>` : ''}</td>` +
      `<td>${MEMORY_KIND_LABELS[m.kind] || escapeHtml(m.kind)}</td>` +
      `<td>${m.scope === 'global' ? '<span class="mem-candidate">全局</span>' : '项目'}</td><td>${status}</td>` +
      `<td class="num">${m.uses || 0}</td><td class="muted">${new Date(m.updatedAt).toLocaleString()}</td>` +
      `<td class="mem-actions">${actions}</td>`;
    tbody.appendChild(tr);
  }
}

$('#memory-table').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  const call = (body, method = 'PUT') =>
    fetch('/api/memory?project=' + encodeURIComponent(currentProject) + (method === 'DELETE' ? '&id=' + encodeURIComponent(id) : ''), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'DELETE' ? undefined : JSON.stringify({ id, ...body })
    });
  if (act === 'confirm') await call({ action: 'confirm' });
  if (act === 'archive') await call({ status: 'archived' });
  if (act === 'restore') await call({ status: 'active' });
  if (act === 'edit') {
    const row = btn.closest('tr');
    const current = row?.querySelector('td.obj')?.childNodes[0]?.textContent || '';
    const text = prompt('编辑记忆内容：', current);
    if (text == null || !text.trim()) return;
    await call({ text: text.trim() });
  }
  if (act === 'delete') {
    if (!confirm('彻底删除这条记忆？（归档是可恢复的软删除，删除不可恢复）')) return;
    await call(null, 'DELETE');
  }
  loadMemoryView();
});

/* ---------- config ---------- */
let configState = null;
let profilesMeta = {};

async function loadConfig() {
  const isAll = currentProject === 'all';
  $('#config-hint').classList.toggle('hidden', !isAll);
  $('#config-body').classList.toggle('hidden', isAll);
  if (isAll) return;
  const data = await (await fetch('/api/config?project=' + encodeURIComponent(currentProject))).json();
  if (data.error) return;
  configState = data.config;
  profilesMeta = data.profiles;
  renderProfiles();
  renderToggles();
  renderOverrides(data.overrideKeys);
  $('#cfg-context-budget').value = configState.contextQuery.defaultBudgetChars;
  $('#cfg-preview-chars').value = configState.contextQuery.previewChars;
  $('#cfg-task-budget').value = configState.taskBudget.maxTokens;
  $('#cfg-warn-percent').value = configState.taskBudget.warnAtPercent;
  $('#cfg-artifact-days').value = Math.round(configState.artifactStore.ttlMs / 86400000);
  $('#cfg-artifact-mb').value = Math.round(configState.artifactStore.maxBytes / 1048576);
  $('#cfg-daemon-port').value = configState.embedding.daemonPort || 4518;
  $('#cfg-daemon-enabled').checked = configState.embedding.useGlobalDaemon !== false;
  $('#cfg-auto-eval').checked = configState.embedding.autoEval !== false;
  $('#cfg-auto-eval-hours').value = configState.embedding.autoEvalIntervalHours || 24;
  $('#cfg-auto-eval-limit').value = configState.embedding.autoEvalLimit || 50;
}

function renderProfiles() {
  const wrap = $('#profile-cards');
  wrap.innerHTML = '';
  for (const [key, p] of Object.entries(profilesMeta)) {
    const div = document.createElement('div');
    div.className = 'profile-card' + (configState.profile === key ? ' selected' : '');
    div.innerHTML =
      `<div class="p-name">${p.label} <span class="muted">${key}</span></div>` +
      `<div class="p-desc">${p.description}</div>` +
      `<div class="p-meta">读取上限 ${p.readMaxLines} 行 · 重复读窗口 ${p.repeatReadWindowMs / 60000} 分钟<br>` +
      `数据文件阈值 ${Math.round(p.blockMaxDataBytes / 1024)} KB · 命令输出 头${p.shellHeadLines}/尾${p.shellTailLines} 行</div>`;
    div.addEventListener('click', () => {
      configState.profile = key;
      renderProfiles();
    });
    wrap.appendChild(div);
  }
}

function renderToggles() {
  const wrap = $('#hook-toggles');
  wrap.innerHTML = '';
  for (const [key, [name, desc]] of Object.entries(HOOK_DESCS)) {
    const row = document.createElement('div');
    row.className = 'toggle-row';
    row.innerHTML =
      `<div><div class="t-name">${name}</div><div class="t-desc">${desc}</div></div>` +
      `<label class="switch"><input type="checkbox" data-key="${key}" ${configState.hooks?.[key] !== false ? 'checked' : ''}><span class="slider"></span></label>`;
    row.querySelector('input').addEventListener('change', (ev) => {
      configState.hooks = configState.hooks || {};
      configState.hooks[key] = ev.target.checked;
    });
    wrap.appendChild(row);
  }
}

function renderOverrides(keys) {
  const wrap = $('#override-inputs');
  wrap.innerHTML = '';
  for (const key of keys) {
    const row = document.createElement('div');
    row.className = 'override-row';
    const current = configState.overrides?.[key];
    row.innerHTML =
      `<label>${OVERRIDE_DESCS[key] || key}</label>` +
      `<input type="number" min="0" data-key="${key}" value="${current ?? ''}" placeholder="档位默认: ${profilesMeta[configState.profile]?.[key] ?? ''}">`;
    row.querySelector('input').addEventListener('input', (ev) => {
      configState.overrides = configState.overrides || {};
      if (ev.target.value === '') delete configState.overrides[key];
      else configState.overrides[key] = Number(ev.target.value);
    });
    wrap.appendChild(row);
  }
}

$('#save-btn').addEventListener('click', async () => {
  const btn = $('#save-btn');
  const msg = $('#save-msg');
  btn.disabled = true;
  msg.textContent = '保存中…';
  try {
    configState.contextQuery.defaultBudgetChars = Number($('#cfg-context-budget').value);
    configState.contextQuery.previewChars = Number($('#cfg-preview-chars').value);
    configState.taskBudget.maxTokens = Number($('#cfg-task-budget').value);
    configState.taskBudget.warnAtPercent = Number($('#cfg-warn-percent').value);
    configState.taskBudget.hardLimit = false;
    configState.artifactStore.ttlMs = Number($('#cfg-artifact-days').value) * 86400000;
    configState.artifactStore.maxBytes = Number($('#cfg-artifact-mb').value) * 1048576;
    configState.embedding = configState.embedding || {};
    configState.embedding.daemonPort = Number($('#cfg-daemon-port').value);
    configState.embedding.useGlobalDaemon = $('#cfg-daemon-enabled').checked;
    configState.embedding.autoEval = $('#cfg-auto-eval').checked;
    configState.embedding.autoEvalIntervalHours = Number($('#cfg-auto-eval-hours').value);
    configState.embedding.autoEvalLimit = Number($('#cfg-auto-eval-limit').value);
    const res = await fetch('/api/config?project=' + encodeURIComponent(currentProject), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configState)
    });
    const data = await res.json();
    msg.textContent = data.ok ? '已保存，立即生效' : `保存失败: ${(data.errors || []).join(', ')}`;
  } catch (e) {
    msg.textContent = '保存失败: ' + e.message;
  }
  btn.disabled = false;
  setTimeout(() => (msg.textContent = ''), 4000);
});

/* ---------- boot ---------- */
(async () => {
  await Promise.all([loadProjects(), loadSettings()]);
  loadStats();
  loadConfig();
})();
setInterval(async () => {
  await loadProjects();
  loadStats();
  if ($('#tab-context').classList.contains('active') && currentProject !== 'all') loadContextView();
}, 15000);
