#!/usr/bin/env node
// Local sync worker: keeps this clone on the latest code (rebuilding the .eext when it changes)
// and publishes the extension's run files (<base>.log + <base>.results.json, see
// packages/extension/src/runner.ts) to the orphan branch agent-runs, where agents can fetch them.
// No dependencies beyond Node >= 20 and git with push access to the remote.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_FILE = /^return-path_\d{8}-\d{6}_[0-9a-f]{8}\.(?:log|results\.json)$/;
const SETTLE_MS = 3000;
const EEXT_DIR = path.join(REPO, 'packages', 'extension', 'build', 'dist');

const { values: opts } = parseArgs({
  options: {
    'once': { type: 'boolean', default: false },
    'interval': { type: 'string', default: '30' },
    'remote': { type: 'string', default: 'origin' },
    'branch': { type: 'string' },
    'runs-branch': { type: 'string', default: 'agent-runs' },
    'inbox': { type: 'string', multiple: true },
    'no-pull': { type: 'boolean', default: false },
    'no-build': { type: 'boolean', default: false },
    'no-push': { type: 'boolean', default: false },
    'help': { type: 'boolean', short: 'h', default: false },
  },
});

if (opts.help) {
  console.log(`Usage: npm run sync -- [options]

  --once                 run one sync cycle and exit
  --interval <sec>       seconds between cycles (default 30)
  --branch <name>        code branch to follow (default: the branch checked out now)
  --runs-branch <name>   branch that receives run files (default agent-runs)
  --inbox <dir>          folder to collect run files from; repeatable
                         (default: <repo>/agent-runs, the folder to pick with
                         Return Path > Set Run Folder...)
  --remote <name>        git remote (default origin)
  --no-pull              do not pull or rebuild code
  --no-build             pull but do not rebuild the extension
  --no-push              collect run files but do not push them`);
  process.exit(0);
}

const remote = opts.remote;
const runsBranch = opts['runs-branch'];
const worktree = path.join(REPO, '.agent-runs-branch');
const inboxes = (opts.inbox?.length ? opts.inbox : [path.join(REPO, 'agent-runs')])
  .map(p => path.resolve(p.replace(/^~(?=$|[/\\])/, os.homedir())));

function log(...args) {
  console.log(new Date().toLocaleTimeString(), ...args);
}

function git(args, cwd = REPO) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(args, cwd = REPO) {
  try {
    return git(args, cwd);
  }
  catch {
    return undefined;
  }
}

function gitErr(err) {
  return (err.stderr?.toString() || err.message).trim().split('\n').slice(-3).join(' | ');
}

function npm(args) {
  const res = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32' });
  return res.status === 0;
}

function remoteHas(branch) {
  return Boolean(tryGit(['ls-remote', '--exit-code', '--heads', remote, branch]));
}

function isDirty(cwd = REPO) {
  return git(['status', '--porcelain', '--untracked-files=no'], cwd) !== '';
}

const codeBranch = opts.branch ?? git(['rev-parse', '--abbrev-ref', 'HEAD']);

function build(reason) {
  if (opts['no-build'])
    return;
  log(`building extension (${reason})`);
  if (!npm(['run', 'build:extension'])) {
    log('build failed; fix the error above, the next pull will retry');
    return;
  }
  for (const f of eextFiles())
    log(`ready to import: ${path.join(EEXT_DIR, f)}`);
}

function eextFiles() {
  return fs.existsSync(EEXT_DIR) ? fs.readdirSync(EEXT_DIR).filter(f => f.endsWith('.eext')) : [];
}

function installDeps() {
  log('installing dependencies');
  return npm(fs.existsSync(path.join(REPO, 'package-lock.json')) ? ['ci'] : ['install']);
}

let firstCycle = true;

function pullCode() {
  try {
    git(['fetch', '--quiet', remote, codeBranch]);
  }
  catch (err) {
    log(`fetch ${remote}/${codeBranch} failed: ${gitErr(err)}`);
    return;
  }

  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== codeBranch) {
    if (isDirty()) {
      log(`on ${current} with local changes; not switching to ${codeBranch}`);
      return;
    }
    if (tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${codeBranch}`]))
      git(['checkout', '--quiet', codeBranch]);
    else
      git(['checkout', '--quiet', '-b', codeBranch, '--track', `${remote}/${codeBranch}`]);
    log(`switched to ${codeBranch}`);
  }

  const before = git(['rev-parse', 'HEAD']);
  if (isDirty()) {
    if (firstCycle)
      log('local changes in tracked files; skipping pulls until they are committed or stashed');
  }
  else {
    try {
      git(['merge', '--ff-only', '--quiet', `${remote}/${codeBranch}`]);
    }
    catch (err) {
      log(`cannot fast-forward ${codeBranch} to ${remote}/${codeBranch} (diverged?): ${gitErr(err)}`);
    }
  }
  const after = git(['rev-parse', 'HEAD']);

  const changed = before === after ? [] : git(['diff', '--name-only', before, after]).split('\n').filter(Boolean);
  if (changed.length)
    log(`pulled ${git(['rev-list', '--count', `${before}..${after}`])} commit(s) on ${codeBranch}: ${git(['log', '-1', '--format=%h %s', after])}`);

  const needsDeps = !fs.existsSync(path.join(REPO, 'node_modules')) || changed.some(f => /(?:^|\/)package(?:-lock)?\.json$/.test(f));
  if (needsDeps && !opts['no-build'] && !installDeps())
    return;

  if (changed.length)
    build('code changed');
  else if (firstCycle && !eextFiles().length)
    build('no .eext built yet');
}

function ensureRunsWorktree() {
  if (fs.existsSync(path.join(worktree, '.git')))
    return;
  tryGit(['worktree', 'prune']);
  const hasLocal = Boolean(tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${runsBranch}`]));
  const hasRemote = remoteHas(runsBranch);

  if (hasLocal) {
    git(['worktree', 'add', '--quiet', worktree, runsBranch]);
  }
  else if (hasRemote) {
    git(['fetch', '--quiet', remote, runsBranch]);
    git(['worktree', 'add', '--quiet', '-b', runsBranch, worktree, `${remote}/${runsBranch}`]);
  }
  else {
    git(['worktree', 'add', '--quiet', '--detach', worktree]);
    git(['checkout', '--quiet', '--orphan', runsBranch], worktree);
    git(['rm', '-rf', '--quiet', '.'], worktree);
    fs.writeFileSync(path.join(worktree, 'README.md'), `# ${runsBranch}

Run files written by the EasyEDA extension and published by \`scripts/agent-sync.mjs\`.
Each run has \`runs/<base>.log\` and \`runs/<base>.results.json\`; \`LATEST\` holds the newest base name.
This branch has no shared history with the code branches; do not merge it.
`);
    fs.mkdirSync(path.join(worktree, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'runs', '.gitkeep'), '');
    git(['add', '-A'], worktree);
    git(['commit', '--quiet', '-m', `Create ${runsBranch} branch for extension run files`], worktree);
    log(`created orphan branch ${runsBranch}`);
  }
  log(`run files go to ${worktree} (branch ${runsBranch})`);
}

function collectRuns() {
  const dest = path.join(worktree, 'runs');
  fs.mkdirSync(dest, { recursive: true });
  const added = [];
  const now = Date.now();
  for (const dir of inboxes) {
    let names;
    try {
      names = fs.readdirSync(dir);
    }
    catch {
      continue;
    }
    for (const name of names) {
      if (!RUN_FILE.test(name) || fs.existsSync(path.join(dest, name)))
        continue;
      const src = path.join(dir, name);
      if (now - fs.statSync(src).mtimeMs < SETTLE_MS)
        continue;
      fs.copyFileSync(src, path.join(dest, name));
      added.push(name);
    }
  }
  for (const name of added.filter(n => n.endsWith('.results.json'))) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dest, name), 'utf-8'));
      const what = [r.command ?? 'unknown command', r.net, r.version && `v${r.version}`].filter(Boolean).join(', ');
      log(`new run ${name.replace(/\.results\.json$/, '')} (${what}): ${r.status ?? 'unknown'}${r.error ? `: ${r.error.message}` : ''}`);
    }
    catch {
      log(`new results file ${name} is not valid JSON`);
    }
  }
  return added;
}

/** Points LATEST at the newest run; returns its base name, or undefined when there are no runs. */
function updateLatest() {
  const newest = fs.readdirSync(path.join(worktree, 'runs')).filter(n => RUN_FILE.test(n)).sort().pop();
  if (!newest)
    return undefined;
  const base = newest.replace(/\.(?:log|results\.json)$/, '');
  fs.writeFileSync(path.join(worktree, 'LATEST'), `${base}\n`);
  return base;
}

function commitIfChanged(message) {
  git(['add', '-A'], worktree);
  if (git(['status', '--porcelain'], worktree) !== '')
    git(['commit', '--quiet', '-m', message], worktree);
}

function pushRuns(added) {
  if (added.length)
    commitIfChanged(`Add ${added.length} run file(s), latest ${updateLatest()}`);
  if (opts['no-push'])
    return;

  const remoteExists = remoteHas(runsBranch);
  if (remoteExists) {
    git(['fetch', '--quiet', remote, runsBranch], worktree);
    if (git(['rev-list', '--count', `HEAD..${remote}/${runsBranch}`], worktree) !== '0') {
      try {
        // Run files have unique names, so the only possible conflict is LATEST, which is rebuilt below.
        git(['rebase', '--quiet', '-X', 'theirs', `${remote}/${runsBranch}`], worktree);
      }
      catch (err) {
        tryGit(['rebase', '--abort'], worktree);
        log(`rebase onto ${remote}/${runsBranch} failed, will retry: ${gitErr(err)}`);
        return;
      }
      const latest = updateLatest();
      if (latest)
        commitIfChanged(`Point LATEST at ${latest}`);
    }
    if (git(['rev-list', '--count', `${remote}/${runsBranch}..HEAD`], worktree) === '0')
      return;
  }
  try {
    git(['push', '--quiet', '-u', remote, `HEAD:refs/heads/${runsBranch}`], worktree);
    log(`pushed run files to ${remote}/${runsBranch}`);
  }
  catch (err) {
    log(`push failed, will retry next cycle: ${gitErr(err)}`);
  }
}

function cycle() {
  if (!opts['no-pull'])
    pullCode();
  ensureRunsWorktree();
  pushRuns(collectRuns());
  firstCycle = false;
}

log(`agent-sync in ${REPO}`);
log(`following ${remote}/${codeBranch}${opts['no-pull'] ? ' (pull disabled)' : ''}; watching ${inboxes.join(', ')}`);

const intervalMs = Math.max(5, Number(opts.interval) || 30) * 1000;
for (;;) {
  try {
    cycle();
  }
  catch (err) {
    log(`cycle failed: ${gitErr(err)}`);
  }
  if (opts.once)
    break;
  await new Promise(resolve => setTimeout(resolve, intervalMs));
}
