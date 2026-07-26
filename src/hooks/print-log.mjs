#!/usr/bin/env node
// shell-guard 改写命令的回显助手：短输出全量打印；长输出打印头尾 + 完整日志路径，
// 并把真实节省量写入统计。同命令重复运行时（典型：测试迭代循环）优先输出
// 与上一次运行的无损差分——新增/消失的行一目了然，完整输出始终可按 artifact ID 回取。
// 永远 exit 0，不影响原命令退出码的传递。
// 用法: node print-log.mjs <logPath> <headLines> <tailLines> <projectDir> <conversationId> <command> <exitCode>
import fs from 'node:fs';
import { logEvent, estTokensText, loadConfig, loadState } from './_lib.mjs';
import { putArtifact, getEvidence, loadManifest, sha256 } from './context-store.mjs';
import { structureLog } from './log-parser.mjs';
import { lineDiff } from './delta.mjs';

const PREV_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DELTA_MAX_CHANGED_LINES = 200;

// 找同一命令最近一次运行的 artifact（用于差分）；排除内容完全相同的当前这次
function findPreviousRun(root, command, currentHash) {
  try {
    const cutoff = Date.now() - PREV_RUN_MAX_AGE_MS;
    let best = null;
    for (const entry of Object.values(loadManifest(root).entries)) {
      if (entry.kind !== 'shell-log' || entry.meta?.command !== command) continue;
      if (Date.parse(entry.createdAt || 0) < cutoff) continue;
      if (!best || Date.parse(entry.createdAt) > Date.parse(best.createdAt)) best = entry;
    }
    return best && best.contentHash !== currentHash ? { prev: best, identicalTo: null } : { prev: null, identicalTo: best };
  } catch {
    return { prev: null, identicalTo: null };
  }
}

const [, , logPath, headArg, tailArg, root, convId, command = '', exitArg = '0'] = process.argv;

try {
  let head = Math.max(1, parseInt(headArg, 10) || 50);
  let tail = Math.max(1, parseInt(tailArg, 10) || 100);
  const exitCode = Number(exitArg) || 0;
  const cfg = loadConfig(root);
  // 会话软预算达到提醒线后，后续首屏自动减半（exact/full 展开不受影响）
  try {
    if (convId && loadState(convId, root).budget?.warned) {
      head = Math.max(10, Math.floor(head / 2));
      tail = Math.max(20, Math.floor(tail / 2));
    }
  } catch {}
  const raw = fs.readFileSync(logPath, 'utf8');
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  // 输出不长就原样打印（多给 10 行余量，避免为省几行打断输出）
  if (lines.length <= head + tail + 10) {
    process.stdout.write(raw);
  } else {
    const totalBytes = Buffer.byteLength(raw);
    const commandKey = command.slice(0, 300);
    const currentHash = sha256(raw);
    const { prev, identicalTo } =
      cfg.artifactStore.enabled && cfg.artifactStore.deltaLogs !== false
        ? findPreviousRun(root, commandKey, currentHash)
        : { prev: null, identicalTo: null };
    const artifact = cfg.artifactStore.enabled
      ? putArtifact(root, raw, {
          kind: 'shell-log',
          meta: { command: commandKey, exitCode, conversationId: convId }
        })
      : null;
    const structured = cfg.artifactStore.structuredLogs
      ? structureLog(raw, { command, exitCode, maxLines: head + tail })
      : null;
    const marker =
      `[token-saver] exit=${exitCode} ${structured?.framework || 'generic'} ` +
      `${lines.length}L/${Math.round(totalBytes / 1024)}KB artifact=${artifact?.id || logPath} ` +
      `(context_expand id → full/regex/line-range)`;

    let shown = null;
    let mode = 'structured';
    if (identicalTo && artifact) {
      // 输出与上次运行逐字节相同：一行标记 + 结尾摘要即可
      mode = 'identical';
      shown =
        `${marker}\n[token-saver] byte-identical to the previous run (${new Date(identicalTo.createdAt).toISOString()}). Last lines:\n` +
        lines.slice(-3).join('\n') + '\n';
    } else if (prev && artifact) {
      const old = getEvidence(root, prev.id, {});
      if (typeof old.text === 'string' && !old.error) {
        const diff = lineDiff(old.text, raw);
        const structuredBytes = structured ? Buffer.byteLength(structured.text) : Infinity;
        if (
          diff &&
          !diff.identical &&
          diff.changedLines <= DELTA_MAX_CHANGED_LINES &&
          Buffer.byteLength(diff.text) < Math.min(structuredBytes, totalBytes * 0.5)
        ) {
          mode = 'delta';
          shown =
            `${marker}\n[token-saver] Lossless diff vs previous run (${prev.id}, ${diff.changedLines} changed lines; ` +
            `'+' new, '-' gone; unchanged failures were shown last run).\n${diff.text}\n` +
            `--- final lines ---\n` + lines.slice(-3).join('\n') + '\n';
        }
      }
    }
    if (shown == null) {
      shown = structured
        ? `${marker}\n${structured.text}\n`
        : [...lines.slice(0, head), '', marker, '', ...lines.slice(-tail)].join('\n') + '\n';
    }
    process.stdout.write(shown);

    const savedBytes = Math.max(0, totalBytes - Buffer.byteLength(shown));
    logEvent(
      {
        hook: 'shell-guard',
        action: 'truncate',
        mode,
        artifactId: artifact?.id,
        prevArtifactId: prev?.id || identicalTo?.id,
        lines: lines.length,
        omittedLines: structured?.omittedLines,
        framework: structured?.framework,
        exitCode,
        originalBytes: totalBytes,
        transmittedBytes: Buffer.byteLength(shown),
        savedBytes,
        savedTokens: Math.max(0, estTokensText(raw) - estTokensText(shown)),
        conversation_id: convId
      },
      root
    );
  }
} catch {}
try {
  fs.unlinkSync(logPath);
} catch {}
process.exit(0);
