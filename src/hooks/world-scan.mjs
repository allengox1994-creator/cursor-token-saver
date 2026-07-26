// 世界模型机械提取器：从项目的确定性配置（package.json / docker-compose /
// nginx / .env / CI workflow）里提取"实体 --关系--> 实体"三元组，存为候选关系记忆。
// 纯行级解析、零依赖、fail-open；每条挂来源文件哈希，配置变了自动 STALE。
// 目的：agent 不必每个新会话重读几百行配置来重建"域名→端口→服务"这类链路。
import fs from 'node:fs';
import path from 'node:path';
import { logEvent } from './_lib.mjs';
import { saveMemory } from './memory-store.mjs';

const SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_TRIPLES_PER_SCAN = 40;
const MAX_FILE_BYTES = 256 * 1024;

function readSmall(root, rel) {
  try {
    const abs = path.join(root, rel);
    if (fs.statSync(abs).size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function stripQuotes(s) {
  return String(s).trim().replace(/^["']|["']$/g, '');
}

function fromPackageJson(root, out) {
  const raw = readSmall(root, 'package.json');
  if (!raw) return;
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return;
  }
  const name = typeof pkg.name === 'string' ? pkg.name : 'package';
  for (const [script, cmd] of Object.entries(pkg.scripts || {}).slice(0, 10)) {
    out.push({ triple: { s: `npm run ${script}`, r: 'executes', o: String(cmd) }, files: ['package.json'] });
  }
  if (typeof pkg.main === 'string') out.push({ triple: { s: name, r: 'entrypoint', o: pkg.main }, files: ['package.json'] });
  for (const [bin, target] of Object.entries(typeof pkg.bin === 'object' && pkg.bin ? pkg.bin : {}).slice(0, 5)) {
    out.push({ triple: { s: `bin ${bin}`, r: 'entrypoint', o: String(target) }, files: ['package.json'] });
  }
}

function fromCompose(root, out) {
  const rel = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find((f) =>
    fs.existsSync(path.join(root, f))
  );
  if (!rel) return;
  const raw = readSmall(root, rel);
  if (!raw) return;
  let inServices = false;
  let service = null;
  let listKey = null;
  for (const line of raw.split('\n')) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (inServices && /^[A-Za-z_#-]/.test(line)) inServices = false; // 回到其他顶层键
    if (!inServices) continue;
    const svc = line.match(/^ {2}([\w.-]+):\s*$/);
    if (svc) {
      service = svc[1];
      listKey = null;
      continue;
    }
    if (!service) continue;
    const kv = line.match(/^\s+(image|container_name)\s*:\s*(.+)$/);
    if (kv) {
      if (kv[1] === 'image') out.push({ triple: { s: service, r: 'uses-image', o: stripQuotes(kv[2]) }, files: [rel] });
      continue;
    }
    if (/^\s+(ports|depends_on)\s*:/.test(line)) {
      listKey = line.match(/^\s+(ports|depends_on)\s*:/)[1];
      continue;
    }
    const item = line.match(/^\s+-\s*(.+)$/);
    if (item && listKey) {
      const val = stripQuotes(item[1]);
      if (listKey === 'ports') out.push({ triple: { s: service, r: 'listens-on', o: `port ${val}` }, files: [rel] });
      if (listKey === 'depends_on') out.push({ triple: { s: service, r: 'depends-on', o: val }, files: [rel] });
      continue;
    }
    if (/^\s+[\w-]+\s*:/.test(line)) listKey = null; // service 下的其他映射键，结束列表
  }
}

function fromNginx(root, out) {
  const dirs = ['.', 'nginx', 'conf', 'config', 'docker', 'deploy'];
  const confs = [];
  for (const dir of dirs) {
    try {
      for (const name of fs.readdirSync(path.join(root, dir))) {
        if (name.endsWith('.conf')) confs.push(path.join(dir, name).replace(/^\.\//, ''));
      }
    } catch {}
    if (confs.length >= 10) break;
  }
  for (const rel of confs.slice(0, 10)) {
    const raw = readSmall(root, rel);
    if (!raw || !/(server_name|proxy_pass|upstream)\s/.test(raw)) continue;
    let block = null;
    const flush = () => {
      if (!block) return;
      for (const name of block.names.slice(0, 3)) {
        for (const port of block.listens.slice(0, 3)) out.push({ triple: { s: name, r: 'listens-on', o: `port ${port}` }, files: [rel] });
        for (const target of block.proxies.slice(0, 3)) out.push({ triple: { s: name, r: 'proxies-to', o: target }, files: [rel] });
      }
      block = null;
    };
    for (const line of raw.split('\n')) {
      if (/^\s*server\s*{/.test(line)) {
        flush();
        block = { names: [], listens: [], proxies: [] };
        continue;
      }
      const up = line.match(/^\s*upstream\s+([\w.-]+)\s*{/);
      if (up) {
        flush();
        block = { names: [`upstream ${up[1]}`], listens: [], proxies: [] };
        continue;
      }
      if (!block) continue;
      const sn = line.match(/^\s*server_name\s+([^;]+);/);
      if (sn) block.names.push(...sn[1].trim().split(/\s+/).slice(0, 3));
      const ls = line.match(/^\s*listen\s+([^;]+);/);
      if (ls) block.listens.push(ls[1].trim().split(/\s+/)[0]);
      const pp = line.match(/^\s*proxy_pass\s+([^;]+);/);
      if (pp) block.proxies.push(pp[1].trim());
      const sv = line.match(/^\s*server\s+([\w.:-]+)\s*;/); // upstream 内的 server 行
      if (sv) block.proxies.push(sv[1]);
    }
    flush();
  }
}

function fromEnv(root, out) {
  const rel = ['.env.example', '.env.sample', '.env'].find((f) => fs.existsSync(path.join(root, f)));
  if (!rel) return;
  const raw = readSmall(root, rel);
  if (!raw) return;
  const keys = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=/);
    if (m) keys.push(m[1]);
    if (keys.length >= 15) break;
  }
  if (keys.length) out.push({ triple: { s: rel, r: 'defines', o: keys.join(', ') }, files: [rel] });
}

function fromWorkflows(root, out) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, '.github', 'workflows')).filter((n) => /\.ya?ml$/.test(n));
  } catch {
    return;
  }
  for (const file of names.slice(0, 5)) {
    const rel = path.join('.github', 'workflows', file);
    const raw = readSmall(root, rel);
    if (!raw) continue;
    const name = raw.match(/^name\s*:\s*(.+)$/m)?.[1];
    const triggers = [];
    const inline = raw.match(/^on\s*:\s*\[([^\]]+)\]/m) || raw.match(/^on\s*:\s*([\w-]+)\s*$/m);
    if (inline) triggers.push(...inline[1].split(',').map((x) => stripQuotes(x)));
    else {
      const onBlock = raw.match(/^on\s*:\s*\n((?: {2,}\S[^\n]*\n?)+)/m);
      if (onBlock) {
        for (const l of onBlock[1].split('\n')) {
          const key = l.match(/^ {2}([\w-]+)\s*:/);
          if (key) triggers.push(key[1]);
        }
      }
    }
    if (triggers.length) {
      out.push({ triple: { s: `CI ${stripQuotes(name || file)}`, r: 'triggered-by', o: triggers.slice(0, 5).join(', ') }, files: [rel] });
    }
  }
}

// 全量扫描：返回保存的关系数。相似条目由 saveMemory 去重合并，重复扫描不膨胀。
export function scanWorld(root) {
  const found = [];
  for (const extractor of [fromPackageJson, fromCompose, fromNginx, fromEnv, fromWorkflows]) {
    try {
      extractor(root, found);
    } catch {}
  }
  let saved = 0;
  for (const item of found.slice(0, MAX_TRIPLES_PER_SCAN)) {
    const res = saveMemory(root, { triple: item.triple, files: item.files, source: 'auto' });
    if (res.memory) saved++;
  }
  return saved;
}

// sessionStart 节流入口：24h 最多重扫一次
export function maybeScanWorld(root) {
  const stampPath = path.join(root, '.cursor', 'token-saver', 'world-scan.json');
  try {
    const last = JSON.parse(fs.readFileSync(stampPath, 'utf8')).lastScan || 0;
    if (Date.now() - last < SCAN_INTERVAL_MS) return 0;
  } catch {}
  let saved = 0;
  try {
    saved = scanWorld(root);
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, JSON.stringify({ lastScan: Date.now(), relations: saved }));
    if (saved > 0) logEvent({ hook: 'session-track', action: 'world_scan', relations: saved }, root);
  } catch {}
  return saved;
}
