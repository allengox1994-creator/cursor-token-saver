// 神经网络嵌入封装（存在于安装包内，不复制进项目）。
// 复制进项目的 embed-index.mjs 会按 init 记录的包路径动态 import 本文件；
// 因此本文件可以使用 npm 依赖 @huggingface/transformers（本地 ONNX 推理，无需联网调用 API）。
// 模型缓存在 ~/.cursor-token-saver/models/，所有项目共享，只下载一次。
// 国内网络可设置 HF_ENDPOINT=https://hf-mirror.com 走镜像。
import os from 'node:os';
import path from 'node:path';

// 多语言模型：中文/英文查询都可用（量化版约 120MB，一次下载全局共享）。
// 想要更小的英文模型可在配置里改 model 为 'Xenova/all-MiniLM-L6-v2'（约 23MB）。
export const DEFAULT_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

let pipePromise = null;
let loadedModel = null;

export async function getEmbedder(modelId = DEFAULT_MODEL) {
  if (!pipePromise || loadedModel !== modelId) {
    loadedModel = modelId;
    pipePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = process.env.CURSOR_TOKEN_SAVER_HOME
        ? path.join(process.env.CURSOR_TOKEN_SAVER_HOME, 'models')
        : path.join(os.homedir(), '.cursor-token-saver', 'models');
      if (process.env.HF_ENDPOINT) {
        env.remoteHost = process.env.HF_ENDPOINT.replace(/\/+$/, '');
      }
      return pipeline('feature-extraction', modelId, { dtype: 'q8' });
    })();
  }
  const pipe = await pipePromise;
  return {
    id: `transformers:${modelId}`,
    // texts: string[] -> Float32Array[]（已 L2 归一化，可直接点积算余弦）
    async embed(texts) {
      const out = await pipe(texts, { pooling: 'mean', normalize: true });
      const [n, d] = out.dims;
      const vecs = [];
      for (let i = 0; i < n; i++) {
        vecs.push(new Float32Array(out.data.buffer, out.data.byteOffset + i * d * 4, d).slice());
      }
      return vecs;
    }
  };
}
