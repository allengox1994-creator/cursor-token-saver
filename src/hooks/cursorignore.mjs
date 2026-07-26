// 生成/合并 .cursorignore：静态低价值清单 + 扫描出的超大文件。
// 我们的条目放在标记块内，重复 init 时整块替换，不碰用户自己的内容。
import fs from 'node:fs';
import path from 'node:path';

const BEGIN_MARK = '# >>> cursor-token-saver >>>';
const END_MARK = '# <<< cursor-token-saver <<<';

const STATIC_LINES = [
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  '*.min.js',
  '*.min.css',
  '*.map',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'composer.lock',
  'Gemfile.lock',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  '*.zip',
  '*.gz',
  '*.tar',
  '*.tgz',
  '*.mp4',
  '*.mp3',
  '*.mov',
  '*.wasm'
];

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'target'
]);

const BIG_FILE_BYTES = 400 * 1024;
const MAX_VISITED = 50000;
const MAX_RESULTS = 200;
const MAX_DEPTH = 8;

// 已被静态规则覆盖的文件不用再单独列出
const STATIC_EXT = /\.(min\.js|min\.css|map|woff2?|ttf|eot|zip|gz|tar|tgz|mp4|mp3|mov|wasm)$/i;
const STATIC_BASENAMES = new Set(
  STATIC_LINES.filter((l) => !l.includes('*') && !l.endsWith('/')).map((l) => l.toLowerCase())
);

export function findBigFiles(root) {
  const results = [];
  let visited = 0;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && visited < MAX_VISITED && results.length < MAX_RESULTS) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited++ > MAX_VISITED || results.length >= MAX_RESULTS) break;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth < MAX_DEPTH) {
          queue.push({ dir: full, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (STATIC_EXT.test(lower) || STATIC_BASENAMES.has(lower)) continue;
      try {
        if (fs.statSync(full).size > BIG_FILE_BYTES) {
          results.push(path.relative(root, full).split(path.sep).join('/'));
        }
      } catch {}
    }
  }
  return results;
}

export function mergeCursorIgnore(root) {
  const target = path.join(root, '.cursorignore');
  let original = '';
  try {
    original = fs.readFileSync(target, 'utf8');
  } catch {}

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(`${esc(BEGIN_MARK)}[\\s\\S]*?${esc(END_MARK)}\\n?`, 'g');
  const existing = original.replace(blockRe, '').trimEnd();

  const userLines = new Set(existing.split('\n').map((s) => s.trim()));
  const lines = [...STATIC_LINES, ...findBigFiles(root)].filter((l) => !userLines.has(l));

  const out =
    (existing ? existing + '\n\n' : '') + BEGIN_MARK + '\n' + lines.join('\n') + '\n' + END_MARK + '\n';
  const changed = out !== original;
  if (changed) fs.writeFileSync(target, out);
  return { count: lines.length, changed };
}
