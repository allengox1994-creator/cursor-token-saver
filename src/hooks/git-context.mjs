// Git Diff 上下文包：完整 diff 本地保存，首屏只返回改动 hunks、证据 ID 与关联提示。
// 非 Git 仓库或 git 不可用时返回明确降级，不阻塞其他上下文能力。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { putArtifact, putSourceEvidence } from './context-store.mjs';

function git(root, args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (res.error || res.status !== 0) return null;
  return res.stdout || '';
}

function gitDiff(root, args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (res.error || (res.status !== 0 && res.status !== 1)) return '';
  return res.stdout || '';
}

function parseHunks(diff) {
  const files = new Map();
  let current = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      current = raw === '/dev/null' ? null : raw.replace(/^b\//, '');
      if (current && !files.has(current)) files.set(current, []);
      continue;
    }
    if (!current || !line.startsWith('@@')) continue;
    const m = line.match(/\+(\d+)(?:,(\d+))?/);
    if (m) files.get(current).push({ start: Number(m[1]), count: Number(m[2] || 1) });
  }
  return files;
}

function useful(rel) {
  return !(
    rel.startsWith('.cursor/token-saver/') ||
    rel.startsWith('.git/') ||
    /(^|\/)(node_modules|dist|build|coverage)\//.test(rel)
  );
}

export function gitChangedFiles(root, base = 'HEAD') {
  if (git(root, ['rev-parse', '--is-inside-work-tree']) == null) return { git: false, files: [] };
  const tracked = git(root, ['diff', '--name-only', base, '--'])?.split('\n').filter((x) => x && useful(x)) || [];
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])?.split('\n').filter((x) => x && useful(x)) || [];
  return { git: true, files: [...new Set([...tracked, ...untracked])] };
}

export function buildGitDiffPack(root, args = {}, runtime = {}) {
  const base = typeof args.base === 'string' && args.base.trim() ? args.base.trim() : 'HEAD';
  const isGit = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (isGit == null) {
    const fallback = (runtime.listFiles?.() || []).slice(0, 30);
    return [
      'GIT DIFF CONTEXT: git unavailable or this is not a Git worktree.',
      'Fallback: no reliable changed-file set exists; use context_query search/map. No test selection will be treated as high confidence.',
      ...fallback.map((f) => path.relative(root, f).split(path.sep).join('/'))
    ].join('\n');
  }

  let diff = git(root, ['diff', '--no-ext-diff', '--unified=3', base, '--']) || '';
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])?.split('\n').filter((x) => x && useful(x)) || [];
  for (const rel of untracked) {
    diff += `\n${gitDiff(root, ['diff', '--no-index', '--binary', '--', '/dev/null', rel])}`;
  }
  if (!diff.trim()) return `GIT DIFF CONTEXT base=${base}: working tree is clean.`;

  const artifact = putArtifact(root, diff, { kind: 'git-diff', meta: { base } });
  const hunks = parseHunks(diff);
  const out = [
    `GIT DIFF CONTEXT base=${base} files=${hunks.size} full=${artifact?.id || 'unavailable'}`,
    'Full patch is preserved locally. Expand the diff ID for exact patch text; source IDs below point to current working-tree code.'
  ];
  const maxFiles = Math.min(100, Math.max(1, Number(args.max_files) || 30));
  for (const [rel, ranges] of [...hunks.entries()].slice(0, maxFiles)) {
    if (!fs.existsSync(path.join(root, rel))) {
      out.push(`deleted ${rel}`);
      continue;
    }
    if (!ranges.length) ranges.push({ start: 1, count: 40 });
    const ids = [];
    for (const hunk of ranges.slice(0, 8)) {
      const evidence = putSourceEvidence(root, rel, {
        startLine: Math.max(1, hunk.start - 5),
        endLine: hunk.start + Math.max(1, hunk.count) + 5,
        kind: 'git-diff-context',
        meta: { base }
      });
      if (evidence) ids.push(evidence.id);
    }
    out.push(`modified ${rel} hunks=${ranges.length} evidence=${ids.join(',') || 'unavailable'}`);
  }
  if (hunks.size > maxFiles) out.push(`… ${hunks.size - maxFiles} more files; expand ${artifact?.id} for the complete patch.`);
  return out.join('\n');
}
