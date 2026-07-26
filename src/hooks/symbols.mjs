// 多语言符号提取（零依赖正则方案）：给 repo map 用的"够用就好"的大纲提取。
// 不追求编译器级精度，目标是让 agent 用极少 token 看清代码结构，再按行区间精读。
const JS_PATTERNS = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*\s*\(/,
  /^(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*\s*\(/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:require\(|await\s)/,
  /^\s*export\s+(?:const|let|var)\s+[A-Za-z_$][\w$]*/
];

const TS_PATTERNS = [
  ...JS_PATTERNS,
  /^\s*(?:export\s+)?interface\s+[A-Za-z_$][\w$]*/,
  /^\s*(?:export\s+)?type\s+[A-Za-z_$][\w$]*\s*=/,
  /^\s*(?:export\s+)?(?:const\s+)?enum\s+[A-Za-z_$][\w$]*/
];

const LANG_PATTERNS = {
  js: JS_PATTERNS,
  ts: TS_PATTERNS,
  py: [/^\s*(?:async\s+)?def\s+\w+\s*\(/, /^\s*class\s+\w+/],
  go: [/^func\s+(?:\(\s*\w+\s+\*?[\w.]+\s*\)\s*)?\w+\s*\(/, /^type\s+\w+\s+(?:struct|interface)\b/],
  rs: [
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+\w+/,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod)\s+\w+/,
    /^impl\b.+/
  ],
  java: [
    /^\s*(?:public|private|protected|static|final|abstract|\s)*(?:class|interface|enum|record)\s+\w+/,
    /^\s{2,8}(?:public|private|protected)\s+[\w<>\[\], ?]+\s+\w+\s*\([^;]*\)\s*(?:\{|throws)/
  ],
  kt: [
    /^\s*(?:open\s+|sealed\s+|data\s+|abstract\s+)*(?:class|interface|object|enum class)\s+\w+/,
    /^\s*(?:override\s+|suspend\s+|private\s+|public\s+|internal\s+)*fun\s+\w+/
  ],
  swift: [
    /^\s*(?:public\s+|private\s+|internal\s+|open\s+|final\s+)*(?:class|struct|enum|protocol|extension)\s+\w+/,
    /^\s*(?:public\s+|private\s+|internal\s+|open\s+|static\s+|override\s+)*func\s+\w+/
  ],
  cs: [
    /^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|\s)*(?:class|interface|enum|struct|record)\s+\w+/,
    /^\s{2,8}(?:public|private|protected|internal)\s+[\w<>\[\], ?]+\s+\w+\s*\([^;]*\)/
  ],
  rb: [/^\s*(?:class|module)\s+\w+/, /^\s*def\s+[\w.?!]+/],
  php: [
    /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+\w+/,
    /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+\w+/
  ],
  c: [
    /^[A-Za-z_][\w\s*]*\s+\**\w+\s*\([^;]*\)\s*\{?\s*$/,
    /^(?:typedef\s+)?(?:struct|enum|union)\s+\w+/,
    /^#define\s+\w+\(/
  ]
};

export const EXT_LANG = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.py': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'java',
  '.kt': 'kt', '.kts': 'kt',
  '.swift': 'swift',
  '.cs': 'cs',
  '.rb': 'rb',
  '.php': 'php',
  '.c': 'c', '.h': 'c', '.cpp': 'c', '.cc': 'c', '.hpp': 'c', '.hh': 'c'
};

const MAX_SIG_LEN = 110;

// 返回 { lines, symbols: [{ line, text }] }
export function extractSymbols(content, lang) {
  const patterns = LANG_PATTERNS[lang];
  const rawLines = content.split('\n');
  const symbols = [];
  if (!patterns) return { lines: rawLines.length, symbols };

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line || line.length > 500) continue;
    for (const re of patterns) {
      if (re.test(line)) {
        // 保留缩进以体现嵌套结构（tab 归一为 2 空格，最多 8 空格）
        const indent = (line.match(/^[\t ]*/)[0] || '').replace(/\t/g, '  ').slice(0, 8);
        let sig = line.trim().replace(/\s+/g, ' ');
        sig = sig.replace(/\s*[{=]\s*$/, ''); // 去掉行尾的 { 或 =
        if (sig.length > MAX_SIG_LEN) sig = sig.slice(0, MAX_SIG_LEN) + '…';
        symbols.push({ line: i + 1, text: indent + sig });
        break;
      }
    }
  }
  return { lines: rawLines.length, symbols };
}
