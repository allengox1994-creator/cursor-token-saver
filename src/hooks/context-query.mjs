// 统一无损上下文查询层。首屏只传最小证据；每项都带稳定 ID，可精确展开。
import fs from 'node:fs';
import path from 'node:path';
import { EXT_LANG } from './symbols.mjs';
import { compactContent, reverseGraph, traverseGraph } from './analyze.mjs';
import {
  getEvidence,
  loadManifest,
  markDelivered,
  putArtifact,
  putSourceEvidence
} from './context-store.mjs';
import { reciprocalRankFuse, retrievalConfidence } from './hybrid-search.mjs';
import { loadCheckpoint, saveCheckpoint, summaryDir } from './summary-store.mjs';
import { allStateFiles, estTokensText, loadConfig, loadState, logEvent } from './_lib.mjs';
import { buildGitDiffPack, gitChangedFiles } from './git-context.mjs';
import { lspQuery } from './lsp-bridge.mjs';
import { profileData } from './data-profile.mjs';
import {
  archiveMemory,
  confirmMemory,
  extractRunbookMemory,
  mergeMemories,
  saveMemory,
  searchMemories,
  topMemories,
  worldQuery
} from './memory-store.mjs';

function relPath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function projectFile(root, file) {
  const abs = path.resolve(root, file);
  return abs.startsWith(root + path.sep) ? abs : null;
}

function readPreview(root, rel, range, query, cap) {
  try {
    const lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n');
    const start = Math.max(1, range?.start || 1);
    const end = Math.min(lines.length, range?.end || start + 20);
    const tokens = String(query || '')
      .toLowerCase()
      .split(/[^a-zA-Z0-9]+/)
      .filter((x) => x.length > 1);
    let idx = lines.slice(start - 1, end).findIndex((line) => tokens.some((t) => line.toLowerCase().includes(t)));
    if (idx < 0) idx = lines.slice(start - 1, end).findIndex((line) => line.trim());
    const line = idx < 0 ? '' : lines[start - 1 + idx].trim();
    return { line: start + Math.max(0, idx), text: line.slice(0, cap), totalLines: lines.length };
  } catch {
    return { line: range?.start || 1, text: '', totalLines: 0 };
  }
}

function parseBudget(args, cfg, usedTokens = 0) {
  let budget = Number(args.budget_chars) || cfg.contextQuery.defaultBudgetChars;
  const ratio = usedTokens / Math.max(1, cfg.taskBudget.maxTokens);
  if (cfg.taskBudget.enabled && ratio >= cfg.taskBudget.warnAtPercent / 100) budget = Math.max(1200, Math.round(budget * 0.5));
  return Math.max(800, Math.min(50000, budget));
}

export function createContextTools(root, runtime) {
  async function search(args, cfg) {
    const query = String(args.query || '').trim();
    if (!query) return 'context_query(search): "query" is required';
    const wanted = Math.min(30, Math.max(1, Number(args.max_results) || cfg.contextQuery.maxResults));
    const state = args.conversation_id ? loadState(args.conversation_id, root) : {};
    const recentFailure = state.lastFailure && Date.now() - state.lastFailure.at < 10 * 60 * 1000;
    const candidateN =
      cfg.contextQuery.autoExpandLowConfidence || recentFailure ? Math.max(wanted * (recentFailure ? 4 : 3), 20) : wanted;
    const [exact, bm25, vector] = await Promise.all([
      Promise.resolve(runtime.exactSearch(query, candidateN)),
      Promise.resolve(runtime.bm25Search(query, candidateN)),
      Promise.resolve(runtime.vectorSearch(query, candidateN))
    ]);
    const fused = reciprocalRankFuse({ exact, bm25, vector }, { topN: candidateN });
    const confidence = retrievalConfidence(fused);
    if (!fused.length) {
      let msg = `CONTEXT QUERY search: no matches for "${query}". Exact, BM25 and neural paths were all checked.`;
      // 代码没命中不等于一无所知：相关记忆（事实/关系/技能）照样附上
      try {
        if (cfg.memory.enabled) {
          const related = searchMemories(root, query, { max: 3 }).filter((m) => m.score >= 0.34);
          if (related.length) {
            msg += '\n\nrelated memory:\n' + related.map((m) => `  ${memoryLine(m).split('\n')[0]}`).join('\n');
            logEvent(
              { hook: 'mcp-repo-map', action: 'memory_recall', via: 'search', query, hits: related.length, conversation_id: args.conversation_id },
              root
            );
          }
        }
      } catch {}
      return msg;
    }

    // 低置信度不臆断：扩大内部候选集合，但首屏仍受预算控制。
    const maxShown = confidence.level === 'low' ? Math.min(wanted + 4, fused.length) : wanted;
    const out = [
      `CONTEXT QUERY search "${query}" — confidence=${confidence.level} (${confidence.reason})`,
      recentFailure ? `Recent failing command detected; candidate set auto-expanded: ${state.lastFailure.command}` : '',
      'context_expand any id for exact source.'
    ].filter(Boolean);
    let bytes = Buffer.byteLength(out.join('\n'));
    let deduplicated = 0;
    const budget = parseBudget(args, cfg, state.budget?.usedTokens || 0);
    for (const hit of fused.slice(0, maxShown)) {
      const range = hit.range
        ? { start: Math.max(1, hit.range.start - 3), end: hit.range.end + 3 }
        : { start: 1, end: 40 };
      const preview = readPreview(root, hit.rel, range, query, cfg.contextQuery.previewChars);
      const evidence = putSourceEvidence(root, hit.rel, {
        startLine: range.start,
        endLine: Math.min(preview.totalLines || range.end, range.end),
        kind: 'search-hit',
        meta: { query, score: hit.score, confidence: hit.confidence, sources: hit.sources }
      });
      if (!evidence) continue;
      const delivery = cfg.contextQuery.dedupePerConversation
        ? markDelivered(root, args.conversation_id, evidence.contentHash, Buffer.byteLength(preview.text))
        : { duplicate: false };
      const duplicate = delivery.duplicate && args.level !== 'exact';
      if (duplicate) deduplicated++;
      const block =
        `${evidence.id}  ${hit.rel}:${preview.line}  sources=${hit.sources.join('+')}  score=${hit.score.toFixed(2)}` +
        `\n  ${duplicate ? '[already_sent; expand by id if needed]' : preview.text || '(no preview)'}`;
      if (bytes + Buffer.byteLength(block) > budget) break;
      out.push(block);
      bytes += Buffer.byteLength(block);
    }
    if (confidence.level === 'low') out.push('Low confidence: candidates were widened automatically; expand multiple IDs before editing.');
    // 检索融合：代码命中之外，把高相关的记忆/关系/技能顺带附上（零额外调用）
    try {
      if (cfg.memory.enabled) {
        const related = searchMemories(root, query, { max: 3 }).filter((m) => m.score >= 0.34);
        if (related.length) {
          out.push('related memory:\n' + related.map((m) => `  ${memoryLine(m).split('\n')[0]}`).join('\n'));
          logEvent(
            { hook: 'mcp-repo-map', action: 'memory_recall', via: 'search', query, hits: related.length, conversation_id: args.conversation_id },
            root
          );
        }
      }
    } catch {}
    logEvent(
      {
        hook: 'mcp-repo-map',
        action: 'context_query',
        mode: 'search',
        bytes,
        candidates: fused.length,
        deduplicated,
        confidence: confidence.level,
        conversation_id: args.conversation_id
      },
      root
    );
    return out.join('\n\n');
  }

  function callgraph(args) {
    if (typeof args.file !== 'string') return 'context_query(callgraph): "file" is required';
    const abs = projectFile(root, args.file);
    if (!abs || !fs.existsSync(abs)) return `context_query(callgraph): file not found: ${args.file}`;
    const files = runtime.listFiles();
    const graph = new Map();
    for (const file of files) graph.set(file, new Set(runtime.symbolsFor(file)?.imports || []));
    const direction = args.direction || 'both';
    const depth = Math.min(3, Math.max(1, Number(args.depth) || 1));
    const rows = [];
    if (direction === 'both' || direction === 'callees' || direction === 'dependencies') {
      for (const x of traverseGraph(abs, graph, { depth })) rows.push({ ...x, relation: 'depends-on' });
    }
    if (direction === 'both' || direction === 'callers' || direction === 'importers') {
      const rev = reverseGraph(files, graph);
      for (const x of traverseGraph(abs, rev, { depth })) rows.push({ ...x, relation: 'imported-by' });
    }
    const unique = [...new Map(rows.map((x) => [`${x.relation}:${x.file}`, x])).values()];
    const out = [
      `CONTEXT QUERY callgraph ${relPath(root, abs)} — approximate import/reference graph (regex-based, depth=${depth})`,
      'Relations are not compiler-grade call edges; exact source remains available by evidence ID.'
    ];
    for (const row of unique.slice(0, 50)) {
      const info = runtime.symbolsFor(row.file);
      const evidence = putSourceEvidence(root, row.file, {
        startLine: 1,
        endLine: Math.max(1, info?.lines || 1),
        kind: 'callgraph',
        meta: { relation: row.relation, depth: row.depth }
      });
      out.push(`${row.relation} depth=${row.depth} ${relPath(root, row.file)}  ${evidence?.id || ''}`.trim());
    }
    if (!unique.length) out.push('(no local import relationships detected)');
    return out.join('\n');
  }

  function outline(args) {
    if (typeof args.file !== 'string') return 'context_query(outline): "file" is required';
    const abs = projectFile(root, args.file);
    if (!abs) return `context_query(outline): file outside project: ${args.file}`;
    const info = runtime.symbolsFor(abs);
    if (!info) return `context_query(outline): cannot read ${args.file}`;
    const evidence = putSourceEvidence(root, args.file, {
      startLine: 1,
      endLine: Math.max(1, info.lines || 1),
      kind: 'outline'
    });
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 60));
    const symbols = info.symbols.slice(offset, offset + limit).map((s) => `${s.line} ${s.text}`);
    return [
      `CONTEXT QUERY outline ${relPath(root, abs)} — ${info.lines} lines, ${info.symbols.length} symbols, exact=${evidence?.id || 'unavailable'}`,
      ...symbols,
      info.symbols.length > offset + limit ? `… ${info.symbols.length - offset - limit} more; call with offset=${offset + limit}` : ''
    ]
      .filter(Boolean)
      .join('\n');
  }

  function read(args) {
    if (typeof args.file !== 'string') return 'context_query(read): "file" is required';
    const abs = projectFile(root, args.file);
    if (!abs) return `context_query(read): file outside project: ${args.file}`;
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      return `context_query(read): cannot read ${args.file}`;
    }
    if (typeof args.symbol === 'string' && args.symbol.trim()) return symbolRead(abs, content, args);
    const startLine = Math.max(1, Number(args.start_line) || 1);
    const endLine = Number.isFinite(Number(args.end_line)) ? Number(args.end_line) : content.split('\n').length;
    const evidence = putSourceEvidence(root, args.file, { startLine, endLine, kind: 'read' });
    const lang = EXT_LANG[path.extname(abs).toLowerCase()];
    const compact = compactContent(content, lang, { startLine, endLine });
    return (
      `CONTEXT QUERY read ${relPath(root, abs)} exact=${evidence?.id || 'unavailable'} ` +
      `(${compact.keptLines}/${compact.originalLines} lines shown; context_expand exact/full restores all text)\n\n` +
      (compact.text || '(empty compact view)')
    );
  }

  // 符号级骨架读取：目标符号全文 + 文件其余部分折叠成"一行一个符号"的骨架
  function symbolRead(abs, content, args) {
    const rel = relPath(root, abs);
    const info = runtime.symbolsFor(abs);
    if (!info || !info.symbols.length) {
      return `context_query(read): no symbols detected in ${rel}; use start_line/end_line instead`;
    }
    const wanted = args.symbol.trim();
    const wordRe = new RegExp(`\\b${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const idx = info.symbols.findIndex((s) => wordRe.test(s.text));
    if (idx < 0) {
      const near = info.symbols
        .filter((s) => s.text.toLowerCase().includes(wanted.toLowerCase()))
        .slice(0, 5)
        .map((s) => `${s.line} ${s.text.trim()}`);
      return (
        `context_query(read): symbol "${wanted}" not found in ${rel}.` +
        (near.length ? `\nClose matches:\n${near.join('\n')}` : ` File has ${info.symbols.length} symbols; try mode=outline.`)
      );
    }
    const lines = content.split('\n');
    const target = info.symbols[idx];
    const indentOf = (lineNo) => (lines[lineNo - 1]?.match(/^[\t ]*/)[0] || '').replace(/\t/g, '  ').length;
    const targetIndent = indentOf(target.line);
    // 目标范围：到下一个缩进不深于目标的符号为止（覆盖类体/嵌套函数）
    let endLine = lines.length;
    for (let i = idx + 1; i < info.symbols.length; i++) {
      if (indentOf(info.symbols[i].line) <= targetIndent) {
        endLine = info.symbols[i].line - 1;
        break;
      }
    }
    const evidence = putSourceEvidence(root, rel, { startLine: target.line, endLine, kind: 'symbol-read', meta: { symbol: wanted } });
    const lang = EXT_LANG[path.extname(abs).toLowerCase()];
    const compact = compactContent(content, lang, { startLine: target.line, endLine });
    const skeleton = (list) => list.map((s) => `${s.line} ${s.text}`).join('\n');
    const before = info.symbols.slice(0, idx).slice(-40);
    const after = info.symbols.filter((s) => s.line > endLine).slice(0, 40);
    const out = [
      `CONTEXT QUERY read ${rel} symbol=${wanted} lines ${target.line}-${endLine} exact=${evidence?.id || 'unavailable'} ` +
        `(rest of file folded to a symbol skeleton; expand any range with mode=read start_line/end_line)`
    ];
    if (before.length) out.push(`--- skeleton before ---\n${skeleton(before)}`);
    out.push(`--- ${wanted} (full, compact view) ---\n${compact.text || '(empty)'}`);
    if (after.length) out.push(`--- skeleton after ---\n${skeleton(after)}`);
    return out.join('\n\n');
  }

  // 数据文件画像：结构概览替代全文；证据 ID 支持正则/行区间精确回取原始内容
  function profile(args) {
    if (typeof args.file !== 'string') return 'context_query(profile): "file" is required';
    const abs = projectFile(root, args.file);
    if (!abs) return `context_query(profile): file outside project: ${args.file}`;
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return `context_query(profile): file not found: ${args.file}`;
    }
    if (st.size > 64 * 1024 * 1024) {
      return `context_query(profile): ${args.file} is ${Math.round(st.size / 1024 / 1024)}MB — too large to profile; use shell tools (head/wc/jq) on it directly`;
    }
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      return `context_query(profile): cannot read ${args.file}`;
    }
    const rel = relPath(root, abs);
    const totalLines = content ? content.split('\n').length : 0;
    const result = profileData(content, path.extname(abs));
    const evidence = putSourceEvidence(root, rel, { startLine: 1, endLine: totalLines, kind: 'data-profile' });
    const text =
      `CONTEXT QUERY profile ${rel} — ${result.type}, ${totalLines} lines/${Math.round(st.size / 1024)}KB, exact=${evidence?.id || 'unavailable'}\n` +
      `Structure profile below; recover ANY raw content losslessly: context_expand {id, regex} or {id, start_line, end_line}.\n\n` +
      result.text;
    const savedBytes = Math.max(0, st.size - Buffer.byteLength(text));
    logEvent(
      {
        hook: 'mcp-repo-map',
        action: 'context_query',
        mode: 'profile',
        file: rel,
        bytes: Buffer.byteLength(text),
        savedBytes,
        savedTokens: estTokensText(content) - estTokensText(text) > 0 ? estTokensText(content) - estTokensText(text) : 0,
        conversation_id: args.conversation_id
      },
      root
    );
    return text;
  }

  async function lsp(args) {
    const result = await lspQuery(root, args);
    if (!result.available) {
      const fallback = typeof args.file === 'string' ? callgraph({ ...args, direction: args.direction || 'both' }) : '';
      return (
        `LSP unavailable: ${result.reason}. Fell back immediately to the zero-dependency import/reference graph.` +
        (fallback ? `\n\n${fallback}` : '')
      );
    }
    const out = [
      `LSP ${result.method} via ${result.server}: ${result.locations.length} locations`,
      'Compiler/language-server result; every location has a lossless source evidence ID.'
    ];
    for (const loc of result.locations.slice(0, 100)) {
      const evidence = putSourceEvidence(root, loc.rel, {
        startLine: Math.max(1, loc.line - 3),
        endLine: loc.endLine + 3,
        kind: 'lsp-location',
        meta: { server: result.server, method: result.method }
      });
      out.push(`${loc.rel}:${loc.line}:${loc.column} ${evidence?.id || ''}`.trim());
    }
    return out.join('\n');
  }

  // 记忆条目的单行渲染：状态/过期/作用域/置信度标注跟着条目走，agent 一眼可辨可信度
  function memoryLine(m) {
    const flags = [m.status === 'candidate' ? 'unconfirmed' : '', m.stale ? 'STALE: linked files changed' : '']
      .filter(Boolean)
      .join(', ');
    const files = (m.files || []).map((f) => f.path).join(', ');
    const scope = m.scope === 'global' ? ' [global]' : '';
    const conf = (m.confidence || 1) > 1 ? ` (seen ×${m.confidence})` : '';
    const steps = m.kind === 'skill' && m.steps?.length ? `\n  steps: ${m.steps.map((s, i) => `${i + 1}) ${s}`).join('  ')}` : '';
    return `${m.id} [${m.kind}]${scope}${conf}${flags ? ` (${flags})` : ''} ${m.text}${files ? `\n  files: ${files}` : ''}${steps}`;
  }

  // 世界模型查询：实体子图（关系记忆），一行三元组顶几百行配置文件
  function world(args, cfg) {
    if (!cfg.memory.enabled) return 'project memory is disabled by configuration';
    const query = String(args.query || '').trim();
    if (!query) return 'context_query(world): "query" is required (an entity: domain/port/service/script...)';
    const max = Math.min(30, Math.max(1, Number(args.max_results) || 15));
    const hits = worldQuery(root, query, { max });
    logEvent(
      { hook: 'mcp-repo-map', action: 'memory_recall', via: 'world', query, hits: hits.length, conversation_id: args.conversation_id },
      root
    );
    if (!hits.length) {
      return (
        `CONTEXT QUERY world: no relations match "${query}". Relations come from config scans (package.json/compose/nginx/env/CI) ` +
        `and memory_save with a triple {s,r,o}.`
      );
    }
    const line = (m) => {
      const status = [m.status === 'candidate' ? 'unconfirmed' : '', m.stale ? 'STALE' : ''].filter(Boolean).join(',');
      return `${m.id} hop${m.hop} ${m.triple.s} --${m.triple.r}--> ${m.triple.o}${status ? `  [${status}]` : ''}${
        m.files?.length ? `  (${m.files.map((f) => f.path).join(', ')})` : ''
      }`;
    };
    return [
      `CONTEXT QUERY world "${query}" — ${hits.length} relations (entity graph from verified memories; confirm unconfirmed/STALE via memory_save action=confirm)`,
      ...hits.map(line)
    ].join('\n');
  }

  // 项目语义记忆检索：带 query 按相关性，缺省返回最常用/最新条目
  function memory(args, cfg) {
    if (!cfg.memory.enabled) return 'project memory is disabled by configuration';
    const query = String(args.query || '').trim();
    const max = Math.min(20, Math.max(1, Number(args.max_results) || 8));
    const hits = query ? searchMemories(root, query, { max }) : topMemories(root, { max });
    logEvent(
      { hook: 'mcp-repo-map', action: 'memory_recall', query: query || '(top)', hits: hits.length, conversation_id: args.conversation_id },
      root
    );
    if (!hits.length) {
      return `CONTEXT QUERY memory: no ${query ? `matches for "${query}"` : 'memories saved yet'}. Save durable project facts with memory_save.`;
    }
    return [
      `CONTEXT QUERY memory — ${hits.length} entries. Confirm unconfirmed/STALE entries (memory_save action=confirm) before relying on them.`,
      ...hits.map(memoryLine)
    ].join('\n\n');
  }

  // memory_save 工具：save（默认）/ confirm / forget / merge
  function memorySave(args = {}) {
    const cfg = loadConfig(root);
    if (!cfg.memory.enabled) return 'project memory is disabled by configuration';
    const action = args.action || 'save';
    if (action === 'confirm' || action === 'forget') {
      if (typeof args.id !== 'string' || !args.id) return `memory_save(${action}): "id" is required`;
      const res = action === 'confirm' ? confirmMemory(root, args.id) : archiveMemory(root, args.id);
      if (res.error) return `memory_save: ${res.error}`;
      logEvent({ hook: 'mcp-repo-map', action: 'memory_save', op: action, memoryId: args.id, conversation_id: args.conversation_id }, root);
      return action === 'confirm'
        ? `Memory ${args.id} confirmed against current files.`
        : `Memory ${args.id} archived (recoverable from the dashboard).`;
    }
    if (action === 'merge') {
      const res = mergeMemories(root, Array.isArray(args.ids) ? args.ids.map(String) : [], {
        text: args.text,
        kind: args.kind,
        files: Array.isArray(args.files) ? args.files.map(String) : []
      });
      if (res.error) return `memory_save(merge): ${res.error}`;
      logEvent(
        { hook: 'mcp-repo-map', action: 'memory_save', op: 'consolidate', memoryId: res.memory.id, mergedFrom: args.ids, conversation_id: args.conversation_id },
        root
      );
      return `Merged ${args.ids.length} memories into ${res.memory.id} [${res.memory.kind}]; originals archived with provenance (mergedInto).`;
    }
    const scope = args.scope === 'global' ? 'global' : 'project';
    const res = saveMemory(root, {
      text: args.text,
      kind: args.kind,
      files: Array.isArray(args.files) ? args.files.map(String) : [],
      triple: args.triple,
      steps: Array.isArray(args.steps) ? args.steps.map(String) : undefined,
      source: 'agent',
      scope
    });
    if (res.error) return `memory_save: ${res.error}`;
    logEvent(
      { hook: 'mcp-repo-map', action: 'memory_save', op: res.merged ? 'merge' : 'create', memoryId: res.memory.id, scope, conversation_id: args.conversation_id },
      root
    );
    return (
      `Memory ${res.merged ? 'merged into' : 'saved as'} ${res.memory.id} [${res.memory.kind}]${scope === 'global' ? ' (global, cross-project)' : ''}. ` +
      `It will surface in bootstrap and context_query mode=memory.`
    );
  }

  // 新会话热启动包：几百 token 恢复"上个会话在做什么"，全部条目带 ID/哈希可无损校验
  function bootstrap() {
    const out = ['CONTEXT BOOTSTRAP — warm-start pack for a new session (all items are verifiable references, not summaries)'];
    try {
      let latest = null;
      for (const name of fs.readdirSync(summaryDir(root))) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(summaryDir(root), name);
        if (!latest || fs.statSync(file).mtimeMs > latest.mtimeMs) {
          latest = { mtimeMs: fs.statSync(file).mtimeMs, file };
        }
      }
      if (latest) {
        const cp = JSON.parse(fs.readFileSync(latest.file, 'utf8'));
        out.push(
          `checkpoint (${cp.conversationId}, ${cp.updatedAt}):` +
            (cp.goal ? `\n  goal: ${cp.goal}` : '') +
            (cp.status ? `\n  status: ${cp.status}` : '') +
            ((cp.filesTouched || []).length ? `\n  files touched: ${cp.filesTouched.slice(-15).join(', ')}` : '') +
            ((cp.decisions || []).length ? `\n  decisions: ${cp.decisions.slice(-8).join(' | ')}` : '') +
            ((cp.openQuestions || []).length ? `\n  open questions: ${cp.openQuestions.slice(-5).join(' | ')}` : '')
        );
      } else out.push('checkpoint: none saved yet');
    } catch {
      out.push('checkpoint: none saved yet');
    }
    try {
      const changed = gitChangedFiles(root);
      out.push(
        changed.git
          ? changed.files.length
            ? `git working tree: ${changed.files.length} changed files — ${changed.files.slice(0, 20).join(', ')}` +
              `\n  (context_query mode=diff for hunk-level evidence)`
            : 'git working tree: clean'
          : 'git: not a repository'
      );
    } catch {}
    try {
      let failure = null;
      for (const f of allStateFiles(root)) {
        const state = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (state.lastFailure && (!failure || state.lastFailure.at > failure.at)) failure = state.lastFailure;
      }
      if (failure && Date.now() - failure.at < 24 * 60 * 60 * 1000) {
        out.push(`last failing command (${new Date(failure.at).toISOString()}): ${failure.command} (exit ${failure.exitCode})`);
      }
    } catch {}
    try {
      const cfg = loadConfig(root);
      if (cfg.memory.enabled) {
        const memories = topMemories(root, { max: cfg.memory.bootstrapMax });
        if (memories.length) {
          out.push(
            `project memory (durable facts; confirm unconfirmed/STALE before relying):\n` +
              memories.map((m) => `  ${memoryLine(m).split('\n')[0]}`).join('\n')
          );
        }
      }
    } catch {}
    try {
      const entries = Object.values(loadManifest(root).entries)
        .filter((e) => e.rel)
        .sort((a, b) => Date.parse(b.accessedAt || 0) - Date.parse(a.accessedAt || 0))
        .slice(0, 5);
      if (entries.length) {
        out.push(
          'recent evidence (context_expand by id for exact source):\n' +
            entries.map((e) => `  ${e.id}  ${e.rel}:${e.startLine}-${e.endLine}`).join('\n')
        );
      }
    } catch {}
    return out.join('\n\n');
  }

  async function query(args = {}) {
    const cfg = loadConfig(root);
    if (!cfg.contextQuery.enabled) return 'context_query is disabled by project configuration';
    const mode = args.mode || 'search';
    if (mode === 'search') return search(args, cfg);
    if (mode === 'bootstrap') return bootstrap();
    if (mode === 'memory') return memory(args, cfg);
    if (mode === 'world') return world(args, cfg);
    if (mode === 'map') {
      const text = runtime.repoMap(args);
      const evidence = putArtifact(root, text, { kind: 'repo-map', meta: { path: args.path || '' } });
      return `CONTEXT QUERY map exact=${evidence?.id || 'unavailable'}\n${text}`;
    }
    if (mode === 'outline') return outline(args);
    if (mode === 'callgraph') return callgraph(args);
    if (mode === 'read') return read(args);
    if (mode === 'profile') return profile(args);
    if (mode === 'diff') return buildGitDiffPack(root, args, runtime);
    if (mode === 'lsp') return lsp(args);
    return `context_query: unknown mode "${mode}"`;
  }

  function expand(args = {}) {
    if (typeof args.id !== 'string') return 'context_expand: "id" is required';
    const level = args.level || 'exact';
    const found = getEvidence(root, args.id, {
      level: level === 'full' ? 'full' : 'exact',
      startLine: args.start_line,
      endLine: args.end_line,
      regex: args.regex,
      radius: args.radius
    });
    if (found.stale) return `CONTEXT EXPAND ${args.id}: STALE — ${found.error}. Run context_query again for current evidence.`;
    if (found.error) return `CONTEXT EXPAND ${args.id}: ${found.error}`;
    let text = found.text || '';
    if (level === 'preview') text = text.split('\n').find((line) => line.trim())?.slice(0, 240) || '';
    if (level === 'compact' && found.entry.rel) {
      const lang = EXT_LANG[path.extname(found.entry.rel).toLowerCase()];
      text = compactContent(text, lang).text;
    }
    const bytes = Buffer.byteLength(text);
    logEvent(
      {
        hook: 'mcp-repo-map',
        action: found.entry.blob ? 'artifact_recover' : 'context_expand',
        evidenceId: args.id,
        level,
        bytes,
        conversation_id: args.conversation_id
      },
      root
    );
    return `CONTEXT EXPAND ${args.id} level=${level} exact=true bytes=${bytes} (~${estTokensText(text)} tokens)\n\n${text}`;
  }

  function checkpoint(args = {}) {
    const conversationId = args.conversation_id || 'default';
    if (args.action === 'get' || (!args.action && !args.goal && !args.status)) {
      const found = loadCheckpoint(root, conversationId);
      return found ? JSON.stringify(found, null, 2) : `No checkpoint for ${conversationId}`;
    }
    const saved = saveCheckpoint(root, conversationId, {
      goal: typeof args.goal === 'string' ? args.goal.slice(0, 1000) : undefined,
      status: typeof args.status === 'string' ? args.status.slice(0, 200) : undefined,
      filesTouched: Array.isArray(args.files_touched) ? args.files_touched.map(String) : [],
      decisions: Array.isArray(args.decisions) ? args.decisions.map(String).slice(0, 50) : undefined,
      openQuestions: Array.isArray(args.open_questions) ? args.open_questions.map(String).slice(0, 50) : undefined,
      event: { at: new Date().toISOString(), type: 'agent-checkpoint' }
    });
    // 机械提取：checkpoint 里的决策自动生成候选记忆（去重合并，candidate 状态待确认）
    let runbook = null;
    try {
      const cfg = loadConfig(root);
      if (cfg.memory.enabled && Array.isArray(args.decisions)) {
        for (const d of args.decisions.slice(0, 20)) {
          saveMemory(root, { text: String(d), kind: 'decision', source: 'auto' });
        }
      }
      // 任务收尾：从时间线里 exit 0 的命令序列机械提取 runbook 候选技能
      if (cfg.memory.enabled && saved && /\b(done|complete|completed|finished|shipped|resolved)\b|完成|收尾|已上线/i.test(String(args.status || ''))) {
        runbook = extractRunbookMemory(root, saved);
        if (runbook) {
          logEvent(
            { hook: 'mcp-repo-map', action: 'memory_save', op: 'auto-runbook', memoryId: runbook.id, conversation_id: args.conversation_id },
            root
          );
        }
      }
    } catch {}
    return saved
      ? `Checkpoint saved for ${conversationId} at ${saved.updatedAt}` +
          (runbook ? `\nRunbook candidate extracted from this task's command timeline: ${runbook.id} (confirm to keep).` : '')
      : 'Checkpoint write failed (fail-open)';
  }

  return { query, expand, checkpoint, memorySave };
}
