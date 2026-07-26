import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  gcContextStore,
  getEvidence,
  loadManifest,
  markDelivered,
  putArtifact,
  putSourceEvidence,
  storeStats
} from '../src/hooks/context-store.mjs';
import { buildIndex, collectSourceFiles, EMBED_INDEX_SCHEMA } from '../src/hooks/embed-index.mjs';

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-saver-context-'));
  fs.mkdirSync(path.join(root, '.cursor', 'token-saver'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sample.js'), ['// important contract', 'export const value = 42;', 'console.log(value);'].join('\n'));
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('源码证据 ID 稳定、精确展开且区间变化后报 stale', () => {
  const a = putSourceEvidence(root, 'sample.js', { startLine: 1, endLine: 2, kind: 'test' });
  const b = putSourceEvidence(root, 'sample.js', { startLine: 1, endLine: 2, kind: 'test' });
  assert.equal(a.id, b.id);
  const exact = getEvidence(root, a.id);
  assert.equal(exact.exact, true);
  assert.match(exact.text, /important contract/);
  fs.writeFileSync(path.join(root, 'sample.js'), fs.readFileSync(path.join(root, 'sample.js'), 'utf8').replace('42', '43'));
  assert.equal(getEvidence(root, a.id).stale, true);
});

test('artifact 支持完整、正则窗口回取与会话哈希去重', () => {
  const raw = ['start', 'line two', 'UNIQUE_FAILURE', 'line four', 'finish'].join('\n');
  const artifact = putArtifact(root, raw, { kind: 'shell-log' });
  assert.match(artifact.id, /^art_[a-f0-9]{12}$/);
  assert.equal(getEvidence(root, artifact.id, { level: 'full' }).text, raw);
  const around = getEvidence(root, artifact.id, { regex: 'UNIQUE_FAILURE', radius: 1 });
  assert.equal(around.hits, 1);
  assert.match(around.text, /line two\nUNIQUE_FAILURE\nline four/);

  assert.equal(markDelivered(root, 'conv', artifact.contentHash, artifact.bytes).duplicate, false);
  assert.equal(markDelivered(root, 'conv', artifact.contentHash, artifact.bytes).duplicate, true);
});

test('manifest 损坏时 fail-open，统计与 GC 可用', () => {
  const stats = storeStats(root);
  assert.ok(stats.entries >= 1);
  const manifest = loadManifest(root);
  for (const entry of Object.values(manifest.entries)) entry.accessedAt = '2000-01-01T00:00:00Z';
  const manifestPath = path.join(root, '.cursor', 'token-saver', 'context-store', 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.ok(gcContextStore(root, { ttlMs: 60000, maxBytes: 1024 * 1024 }).removed >= 1);

  fs.writeFileSync(manifestPath, '{broken');
  assert.deepEqual(loadManifest(root).entries, {});
  assert.match(getEvidence(root, 'missing').error, /unknown evidence/);
});

test('旧嵌入索引 schema 会渐进迁移并补内容哈希', async () => {
  const files = collectSourceFiles(root);
  const old = { model: 'unit', files: { 'sample.js': { stamp: files[0].stamp, chunks: [] } } };
  const backend = {
    id: 'unit',
    embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0, 0]))
  };
  const migrated = await buildIndex(backend, files, old);
  assert.equal(migrated.schemaVersion, EMBED_INDEX_SCHEMA);
  assert.match(migrated.files['sample.js'].contentHash, /^[a-f0-9]{64}$/);
  assert.ok(migrated.files['sample.js'].chunks.length > 0);
});
