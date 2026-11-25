// Every change bumps the minor version and adds a CHANGELOG.md entry (see CHANGELOG.md).
// Checks that extension.json and all workspace packages share one version, that internal
// dependencies pin it, that CHANGELOG.md's newest entry is that version, and, given a base
// ref (CI on pull requests), that the version is higher than the base's.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const errors = [];
const version = read('packages/extension/extension.json').version;

for (const p of ['packages/core/package.json', 'packages/cli/package.json', 'packages/extension/package.json']) {
  const pkg = read(p);
  if (pkg.version !== version) errors.push(`${p}: version ${pkg.version}, extension.json has ${version}`);
  for (const [dep, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }))
    if (dep.startsWith('@returnpath/') && v !== version) errors.push(`${p}: ${dep} pinned to ${v}, expected ${version}`);
}

const top = readFileSync('CHANGELOG.md', 'utf8').match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
if (top !== version) errors.push(`CHANGELOG.md: newest entry is ${top ?? 'missing'}, expected ${version}`);

const base = process.argv[2];
if (base) {
  const parse = (v) => v.split('.').map(Number);
  let baseVersion;
  try {
    baseVersion = JSON.parse(execFileSync('git', ['show', `${base}:packages/extension/extension.json`], { encoding: 'utf8' })).version;
  } catch {
    console.log(`No extension.json on ${base}; skipping the version-bump check.`);
  }
  if (baseVersion) {
    const [a, b] = [parse(version), parse(baseVersion)];
    const higher = a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
    if (!higher) errors.push(`version ${version} must raise the minor (or major) version of ${base} (${baseVersion})`);
  }
}

if (errors.length) {
  console.error(errors.map((e) => `error: ${e}`).join('\n'));
  process.exit(1);
}
console.log(`version ${version}: consistent${base ? `, higher than ${base}` : ''}, CHANGELOG entry present`);
