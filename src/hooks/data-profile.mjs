// 数据文件画像（零依赖）：JSON/JSONL/CSV/TSV/YAML 返回结构概览而不是全文。
// 画像是有损的首屏，但配合 source evidence ID（正则/行区间精确回取）整体无损。
const MAX_KEYS = 30;
const MAX_DEPTH = 4;
const MAX_LINES = 90;
const SAMPLE_LEN = 60;

function sample(value) {
  const s = typeof value === 'string' ? JSON.stringify(value) : String(value);
  return s.length > SAMPLE_LEN ? s.slice(0, SAMPLE_LEN) + '…' : s;
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// 数组元素结构可能不一致：合并前几个元素的键集合
function mergeObjectKeys(items) {
  const keys = new Map();
  for (const item of items.slice(0, 20)) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const [k, v] of Object.entries(item)) if (!keys.has(k)) keys.set(k, v);
    }
  }
  return keys;
}

function schemaLines(value, indent, depth, out) {
  if (out.length >= MAX_LINES) return;
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    const elemTypes = [...new Set(value.slice(0, 50).map(typeName))];
    out.push(`${pad}array[${value.length}] of ${elemTypes.join('|') || 'unknown'}`);
    if (depth < MAX_DEPTH && elemTypes.includes('object')) {
      const keys = mergeObjectKeys(value);
      let n = 0;
      for (const [k, v] of keys) {
        if (++n > MAX_KEYS || out.length >= MAX_LINES) {
          out.push(`${pad}  … ${keys.size - MAX_KEYS} more keys`);
          break;
        }
        describeKey(k, v, indent + 1, depth + 1, out);
      }
    }
    return;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    out.push(`${pad}object (${entries.length} keys)`);
    let n = 0;
    for (const [k, v] of entries) {
      if (++n > MAX_KEYS || out.length >= MAX_LINES) {
        out.push(`${pad}  … ${entries.length - MAX_KEYS} more keys`);
        break;
      }
      if (depth < MAX_DEPTH) describeKey(k, v, indent + 1, depth + 1, out);
    }
    return;
  }
  out.push(`${pad}${typeName(value)} (e.g. ${sample(value)})`);
}

function describeKey(key, value, indent, depth, out) {
  if (out.length >= MAX_LINES) return;
  const pad = '  '.repeat(indent);
  const t = typeName(value);
  if (t === 'object' || t === 'array') {
    out.push(`${pad}${key}:`);
    schemaLines(value, indent + 1, depth, out);
  } else {
    out.push(`${pad}${key}: ${t} (e.g. ${sample(value)})`);
  }
}

function profileJson(content) {
  const parsed = JSON.parse(content);
  const out = [];
  schemaLines(parsed, 0, 0, out);
  return { type: 'json', text: out.join('\n') };
}

function profileJsonl(content) {
  const lines = content.split('\n').filter((l) => l.trim());
  const parsed = [];
  for (const line of lines.slice(0, 50)) {
    try {
      parsed.push(JSON.parse(line));
    } catch {}
  }
  const out = [`${lines.length} records (schema merged from first ${parsed.length})`];
  const keys = mergeObjectKeys(parsed);
  let n = 0;
  for (const [k, v] of keys) {
    if (++n > MAX_KEYS) {
      out.push(`  … ${keys.size - MAX_KEYS} more keys`);
      break;
    }
    describeKey(k, v, 1, 1, out);
  }
  return { type: 'jsonl', text: out.join('\n') };
}

function profileCsv(content, sep) {
  const lines = content.split('\n').filter((l) => l.length);
  const cell = (line) =>
    line
      .split(sep)
      .map((c) => (c.length > 40 ? c.slice(0, 40) + '…' : c))
      .join(sep === '\t' ? ' | ' : ', ');
  const out = [
    `${lines.length - 1} data rows, ${lines[0]?.split(sep).length || 0} columns`,
    `header: ${cell(lines[0] || '')}`
  ];
  for (const line of lines.slice(1, 4)) out.push(`row: ${cell(line)}`);
  if (lines.length > 5) out.push(`… ${lines.length - 5} rows omitted`, `last row: ${cell(lines[lines.length - 1])}`);
  return { type: sep === '\t' ? 'tsv' : 'csv', text: out.join('\n') };
}

// 无解析器的 YAML 大纲：按缩进列出浅层键
function profileYaml(content) {
  const lines = content.split('\n');
  const out = [`${lines.length} lines, top-level structure:`];
  for (let i = 0; i < lines.length && out.length < MAX_LINES; i++) {
    const m = lines[i].match(/^(\s{0,4})(- )?("[^"]+"|'[^']+'|[\w./-]+)\s*:/);
    if (m) out.push(`${i + 1}| ${lines[i].trimEnd().slice(0, 100)}`);
  }
  if (out.length >= MAX_LINES) out.push('… more keys omitted');
  return { type: 'yaml', text: out.join('\n') };
}

function profileText(content) {
  const lines = content.split('\n');
  const cap = (l) => (l.length > 160 ? l.slice(0, 160) + '…' : l);
  const out = [`${lines.length} lines; head/tail preview:`];
  for (const l of lines.slice(0, 5)) out.push(cap(l));
  if (lines.length > 10) out.push(`… ${lines.length - 10} lines omitted`);
  for (const l of lines.slice(-5)) if (lines.length > 5) out.push(cap(l));
  return { type: 'text', text: out.join('\n') };
}

export function profileData(content, ext) {
  const e = String(ext || '').toLowerCase();
  try {
    if (e === '.json') return profileJson(content);
    if (e === '.jsonl' || e === '.ndjson') return profileJsonl(content);
    if (e === '.csv') return profileCsv(content, ',');
    if (e === '.tsv') return profileCsv(content, '\t');
    if (e === '.yaml' || e === '.yml') return profileYaml(content);
  } catch {
    // 解析失败（如损坏的 JSON）退回通用文本画像，仍然可用
  }
  return profileText(content);
}
