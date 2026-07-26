// 智能测试选择：迭代阶段只选与 Git 改动有直接/反向依赖关系的测试；
// 任何不确定性、无匹配或 final 阶段都返回全量测试，绝不静默跳过验证。
import fs from 'node:fs';
import path from 'node:path';
import { gitChangedFiles } from './git-context.mjs';
import { putSourceEvidence } from './context-store.mjs';

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function isTestFile(file) {
  return /(^|\/)(__tests__\/|tests?\/)|(?:^|[._-])(test|spec)s?\.[^.]+$|_test\.go$|^test_.*\.py$/i.test(file);
}

function commandInfo(root, files) {
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {}
  if (pkg?.scripts?.test) {
    const runner = fs.existsSync(path.join(root, 'pnpm-lock.yaml'))
      ? 'pnpm test'
      : fs.existsSync(path.join(root, 'yarn.lock'))
        ? 'yarn test'
        : fs.existsSync(path.join(root, 'bun.lockb'))
          ? 'bun test'
          : 'npm test --';
    return { kind: 'js', full: runner.replace(/ --$/, ''), selected: files.length ? `${runner} ${files.join(' ')}` : null };
  }
  if (files.some((f) => f.endsWith('.py')) || fs.existsSync(path.join(root, 'pytest.ini'))) {
    return { kind: 'pytest', full: 'pytest', selected: files.length ? `pytest ${files.join(' ')}` : null };
  }
  if (fs.existsSync(path.join(root, 'go.mod'))) {
    const dirs = [...new Set(files.map((f) => `./${path.posix.dirname(f)}`).map((d) => (d === './.' ? '.' : d)))];
    return { kind: 'go', full: 'go test ./...', selected: dirs.length ? `go test ${dirs.join(' ')}` : null };
  }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    return { kind: 'cargo', full: 'cargo test', selected: null };
  }
  return { kind: 'unknown', full: null, selected: null };
}

export function selectTests(root, args = {}, runtime = {}) {
  const phase = args.phase === 'final' ? 'final' : 'iterate';
  const changed = gitChangedFiles(root, args.base || 'HEAD');
  const allAbs = runtime.listFiles?.() || [];
  const all = new Map(allAbs.map((f) => [rel(root, f), f]));
  const changedSet = new Set(changed.files);
  const selected = new Set([...changedSet].filter(isTestFile));
  const covered = new Set();

  // 直接命名关系 + import 反向关系。
  for (const source of changed.files.filter((f) => !isTestFile(f))) {
    const ext = path.extname(source);
    const base = source.slice(0, -ext.length);
    const name = path.posix.basename(base);
    const dir = path.posix.dirname(source);
    const direct = [
      `${base}.test${ext}`,
      `${base}.spec${ext}`,
      `${dir}/__tests__/${name}.test${ext}`,
      `${dir}/test_${name}${ext}`,
      `${base}_test${ext}`
    ];
    for (const candidate of direct) {
      if (all.has(candidate)) {
        selected.add(candidate);
        covered.add(source);
      }
    }
    const sourceAbs = all.get(source);
    if (!sourceAbs) continue;
    for (const [candidate, abs] of all) {
      if (!isTestFile(candidate)) continue;
      const imports = runtime.symbolsFor?.(abs)?.imports || [];
      if (imports.includes(sourceAbs)) {
        selected.add(candidate);
        covered.add(source);
      }
    }
  }

  // Go 的相关测试按包运行，测试文件不一定直接 import 被改文件。
  if (changed.files.some((f) => f.endsWith('.go'))) {
    for (const source of changed.files.filter((f) => f.endsWith('.go'))) {
      const dir = path.posix.dirname(source);
      const packageTests = [...all.keys()].filter((f) => path.posix.dirname(f) === dir && f.endsWith('_test.go'));
      for (const test of packageTests) selected.add(test);
      if (packageTests.length) covered.add(source);
    }
  }

  const relevant = [...selected].sort();
  const command = commandInfo(root, relevant);
  const sourceChanges = changed.files.filter((f) => !isTestFile(f));
  const allCovered = sourceChanges.length > 0 && sourceChanges.every((f) => covered.has(f));
  const confidence = !changed.git ? 'none' : relevant.length && allCovered ? 'high' : relevant.length ? 'medium' : 'low';
  const forceFull = phase === 'final' || confidence !== 'high' || !command.selected;
  const chosen = forceFull ? command.full : command.selected;
  const out = [
    `TEST SELECT phase=${phase} confidence=${confidence} changed=${changed.files.length} selected=${relevant.length}`,
    `command=${chosen || '(no test command detected)'}`,
    command.full ? `full_command=${command.full}` : 'full_command=(unknown; inspect project test configuration)',
    forceFull
      ? 'Fallback active: full suite selected because this is final verification or coverage confidence is low.'
      : `Iteration command is targeted. Safe fallback command: (${command.selected}) || (${command.full}). Always run full_command before final handoff.`
  ];
  for (const file of relevant.slice(0, 50)) {
    const evidence = putSourceEvidence(root, file, { startLine: 1, endLine: 200, kind: 'selected-test' });
    out.push(`${file} ${evidence?.id || ''}`.trim());
  }
  return out.join('\n');
}
