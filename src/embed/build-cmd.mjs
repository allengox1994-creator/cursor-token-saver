// CLI: cursor-token-saver index —— 预建嵌入索引（首次会下载模型，之后 semantic_search 立即可用）
import { loadConfig } from '../hooks/_lib.mjs';
import { loadBackend, loadIndex, saveIndex, buildIndex, collectSourceFiles, staleCount } from '../hooks/embed-index.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildCmd(root) {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const cfg = loadConfig(root).embedding || {};

  console.log('加载嵌入后端（首次运行会下载模型，缓存于 ~/.cursor-token-saver/models，所有项目共享）…');
  const backend = await loadBackend(cfg, pkgRoot);
  if (!backend) {
    console.error('错误: 没有可用的嵌入后端。检查安装包依赖（npm install）或启动 Ollama。');
    process.exit(1);
  }
  console.log(`后端: ${backend.id}`);

  const files = collectSourceFiles(root);
  const prev = loadIndex(root);
  // 模型变更时全部重嵌
  const stale = prev && prev.model === backend.id ? staleCount(prev, files) : files.length;
  console.log(`源码文件 ${files.length} 个，需要嵌入 ${stale} 个（其余复用缓存）`);

  const startAt = Date.now();
  const idx = await buildIndex(backend, files, prev, (done, total) => {
    if (done % 20 === 0 || done === total) {
      process.stdout.write(`\r嵌入进度: ${done}/${total}`);
    }
  });
  saveIndex(root, idx);
  const chunks = Object.values(idx.files).reduce((s, f) => s + f.chunks.length, 0);
  console.log(`\n完成: ${chunks} 个代码块，耗时 ${((Date.now() - startAt) / 1000).toFixed(1)}s`);
  console.log(`索引: ${path.join(root, '.cursor', 'token-saver', 'embed-index.json')}`);
}
