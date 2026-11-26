// Downloads a CI build of the extension: `npm run fetch:build -- <pr-number|main> [--out <dir>]`.
// A pull request gets the .eext of its newest successful CI run (artifact easyeda-return-path_v<version><letter>,
// or extension-eext from runs before 0.1.30). main gets the newest GitHub Release asset, else its newest CI artifact.
// The file keeps its name, so the version (and build letter) stays in it. Needs the GitHub CLI, logged in.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'rbhun/easyeda-return-path';
let target;
let out = join(homedir(), 'Downloads');
for (const args = process.argv.slice(2); args.length;) {
  const a = args.shift();
  if (a === '--out') out = args.shift();
  else target = a;
}
if (!target) {
  console.error('Usage: npm run fetch:build -- <pr-number|main> [--out <dir>]');
  process.exit(1);
}

const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const json = (...a) => JSON.parse(gh(...a));
const tmp = mkdtempSync(join(tmpdir(), 'returnpath-build-'));

function finish() {
  const files = readdirSync(tmp, { recursive: true }).filter(f => String(f).endsWith('.eext'));
  if (!files.length) throw new Error('the download held no .eext file');
  for (const f of files) {
    const name = String(f).split(/[\\/]/).pop();
    const dest = join(out, name);
    if (existsSync(dest)) console.log(`already there: ${dest}`);
    else {
      copyFileSync(join(tmp, String(f)), dest);
      console.log(`saved ${dest}`);
    }
  }
}

function fromRun(branch, sha) {
  const runs = json('run', 'list', '-R', REPO, '--workflow', 'CI', '--branch', branch, '--status', 'success', '--limit', '20', '--json', 'databaseId,headSha');
  const run = runs.find(r => !sha || r.headSha === sha) ?? runs[0];
  if (!run) throw new Error(`no successful CI run on ${branch}`);
  if (sha && run.headSha !== sha) console.warn(`warning: no successful CI run for the current head ${sha.slice(0, 7)}; using ${run.headSha.slice(0, 7)}`);
  const artifacts = json('api', `repos/${REPO}/actions/runs/${run.databaseId}/artifacts`).artifacts
    .filter(a => !a.expired && (a.name.startsWith('easyeda-return-path_v') || a.name === 'extension-eext'));
  if (!artifacts.length) throw new Error(`CI run ${run.databaseId} uploaded no .eext artifact`);
  for (const a of artifacts) gh('run', 'download', String(run.databaseId), '-R', REPO, '-n', a.name, '-D', join(tmp, a.name));
}

if (target === 'main') {
  try {
    gh('release', 'download', '-R', REPO, '-p', '*.eext', '-D', tmp);
  } catch {
    console.warn('no release with an .eext yet; using the newest CI build of main');
    fromRun('main');
  }
} else {
  const pr = json('pr', 'view', target, '-R', REPO, '--json', 'headRefName,headRefOid');
  fromRun(pr.headRefName, pr.headRefOid);
}
finish();
