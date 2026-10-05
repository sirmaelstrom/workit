// The conductor end to end, through runConduct only: intake → touch 1 → spec
// → mint → build → release → analyze → showcase. These scenarios are
// SCRIPTED. A fake agent answers every action from a script, and a fake
// executor answers every program, so they prove the conductor against an
// authored /spec output (the three-WP workshop under __fixtures__/seam/) and
// authored lane reports. The real producer → consumer run, with the installed
// skill invoking /spec for real, is RC-1 Phase E (D19.26).
//
// Every conduct.mjs shell action (lane spawn/alive/check, land gate/merged,
// analyze) runs in-process through runConduct with the same fakes, from the
// plugin root its argv names. No network, no sleeps: a wait is recorded,
// never slept (a test that needs time to pass advances the injected clock).
//
// The self-hosted handover test proves the conductor's state after the
// release (the root, the version, the files it checks) and that verbs from
// the old root are refused. Running the next verb through the installed
// copy's own conduct.mjs is proven by RC-1 Phase E (the installed skill run
// from a fresh session), not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConduct } from './conduct.mjs';
import { STEPS, readEvents } from './lib/state.mjs';
import { shellArgv } from './lib/exec.mjs';
import { correlation } from './lib/touch.mjs';
import { SEAM_ROWS } from './lib/analyze.mjs';
import { namedSeam } from './lib/phases/showcase.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '__fixtures__');
const SEAM = join(FIX, 'seam');
const T0 = Date.parse('2026-10-04T18:00:00.000Z');
const GOAL = 'seam run';
const ANCHOR = 'a0a0a0a0-0000-4000-8000-000000000001';
const IDENTITY = 'Sun Oct 4 18:00:00 2026 claude';
const BASE = 'b'.repeat(40);
const RELEASE_HEAD = 'e'.repeat(40);
const LANE_COST = 0.25;
const LIVE = ['dispatched', 'pr', 'review', 'amending', 'gate'];
const OFF = ['herdr', 'notify', 'spend', 'spine', 'council', 'kb', 'verify'].flatMap((name) => ['--no-adapter', name]);
const PRIVATE_PATHS = [/[A-Za-z]:[\\/]+(Users|Development)\b/i, /[\\/]Users[\\/][^\\/\s"]+[\\/]/];

const text = (...parts) => readFileSync(join(FIX, ...parts), 'utf8');
const captured = (...parts) => JSON.parse(text(...parts));
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const sha = (prefix, n) => `${prefix}${String(n).padStart(39, '0')}`;
const num = (id) => Number(id.slice(3));
const out = (result) => JSON.parse(result.stdout);
// A synthetic `claude -p --output-format json` result line: the exec lane's cost.
const LANE_LOG = (n) => `${JSON.stringify({ type: 'result', subtype: 'success', session_id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, total_cost_usd: LANE_COST })}\n`;

// ---- the harness ----

function seam(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workit-seam-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, opts.herdr ? 'projects' : 'src', 'repo');
  cpSync(join(SEAM, 'repo'), repo, { recursive: true });
  const plugin = join(dir, 'plugin');
  for (const sub of [['reference', 'templates'], ['skills', 'conduct', 'templates'], ['.claude-plugin']]) mkdirSync(join(plugin, ...sub), { recursive: true });
  cpSync(join(FIX, 'build', 'lane-contract.template.md'), join(plugin, 'reference', 'templates', 'lane-contract.template.md'));
  cpSync(join(HERE, '..', 'templates', 'lane-brief.md'), join(plugin, 'skills', 'conduct', 'templates', 'lane-brief.md'));
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'workit', homepage: `https://github.com/example/${opts.selfHosted ? 'scratch' : 'plugin'}` }));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  const h = {
    dir, repo, plugin, home, runs: join(dir, 'runs'), runDir: null, trace: [], calls: [], heads: {}, life: {}, spawns: {}, reports: {}, findings: {},
    answers: { preapproval: { key: 'a' }, showcase: { key: 'a' }, blocked: { key: 'a' }, ...opts.answers }, rulings: [], codes: [], seq: 0,
    depth: opts.depth ?? 'deep', gateCommand: opts.gateCommand ?? 'node --version', clock: T0, ...opts.h,
  };
  h.installed = (snapshot) => writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'),
    text('seam', `installed-plugins-${snapshot}.json`).replaceAll('<plugins>', join(dir, 'plugins').replaceAll('\\', '/')));
  h.installed('before');
  h.head = (id) => h.heads[id] ?? sha('a', num(id));
  h.bump = (id) => (h.heads[id] = sha('c', (h.seq += 1) * 100 + num(id)));
  h.deps = {
    exec: (program, args, options = {}) => fakeExec(h, program, args, options),
    env: { HOME: home, ...(opts.herdr ? { HERDR_ENV: '1' } : {}), ...opts.env }, platform: 'linux', home, stdinIsTTY: false, pluginRoot: plugin,
    now: () => h.clock, timestamp: () => new Date((h.clock += 1000)).toISOString(), newRunId: () => 'abcd1234', lockWaitMs: 0,
    sleep: async () => {}, resolveCodex: () => 'codex', spawnDetached: (program, args, options) => fakeSpawn(h, options),
    pidAlive: (pid) => (h.life[`WP-${String(pid - 4200).padStart(2, '0')}`] ?? 0) > 0,
  };
  h.run = (argv, more = {}) => runConduct(argv, { ...h.deps, ...more });
  h.state = () => JSON.parse(readFileSync(join(h.runDir, 'state.json'), 'utf8'));
  h.events = () => readEvents(h.runDir, { exists: existsSync, read: (path) => readFileSync(path, 'utf8') }, h.state());
  h.wp = (id) => h.state().wps.find((wp) => wp.id === id);
  h.analysis = () => readFileSync(join(h.runDir, 'run-analysis.md'), 'utf8');
  return h;
}

async function start(h, extra = []) {
  const result = await h.run(['intake', '--goal', GOAL, '--repo', h.repo, '--runs-root', h.runs, ...extra]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  h.runDir = out(result).runDir;
  h.pending = out(result).action;
}

const idOfWorktree = (path) => (/-release$/.test(path) ? 'release' : /-(wp-\d+)$/.exec(path)?.[1].toUpperCase());
const prOf = (id) => (id === 'release' ? 200 : 100 + num(id));
const idOfPr = (n) => (Number(n) === 200 ? 'release' : `WP-${String(Number(n) - 100).padStart(2, '0')}`);
const headOf = (h, id) => (id === 'release' ? h.releaseHead?.() ?? RELEASE_HEAD : h.head(id));
const mergeSha = (id) => (id === 'release' ? sha('d', 99) : sha('d', num(id)));

// [regex over "program args…", (h, match, input) → result]; h.rules first.
const RULES = [
  [/^git -C \S+ rev-parse --is-inside-work-tree$/, () => ok('true\n')],
  [/^git -C (\S+) rev-parse --show-toplevel$/, (h, m) => ok(`${m[1]}\n`)],
  [/^git -C \S+ config --get remote\.origin\.url$/, () => ok('https://github.com/example/scratch.git\n')],
  [/^gh auth status --hostname github\.com$/, () => ok('github.com\n  ✓ Logged in (synthetic)\n')],
  [/^gh repo view example\/scratch --json nameWithOwner,defaultBranchRef$/, () => ok(JSON.stringify({ nameWithOwner: 'example/scratch', defaultBranchRef: { name: 'main' } }))],
  [/^gh api --paginate repos\/example\/scratch\/actions\/workflows --jq \.workflows\[\]$/, () => ok(`${JSON.stringify({ state: 'active', path: '.github/workflows/ci.yml' })}\n`)],
  [/^claude --version$/, () => ok('2.1.0 (Claude Code)\n')],
  [/^codex --version$/, () => ({ code: 1, stdout: '', stderr: 'codex: not found' })],
  [/^herdr agent list$/, () => ok('[]')],
  [/^sh -c command -v "\$1" sh (\S+)$/, (h, m) => ok(`/bin/${m[1]}\n`)],
  [/^sh -c id=/, () => ok(`${IDENTITY}\n`)],
  [/^git -C \S+ rev-parse origin\/main$/, () => ok(`${BASE}\n`)],
  [/^git -C (\S+) worktree add (\S+) -b \S+ origin\/main$/, (h, m) => {
    // The release worktree carries the bump files, as a checkout of origin/main would.
    if (idOfWorktree(m[2]) === 'release') cpSync(join(m[1], '.claude-plugin'), join(m[2], '.claude-plugin'), { recursive: true });
    return ok();
  }],
  [/^git -C \S+ rev-list --count \S+\.\.HEAD$/, () => ok('1\n')],
  [/^gh pr list --repo example\/scratch --head conduct\/\S+\/(wp-\d+) --state all --json number,headRefOid,state$/, (h, m) => {
    const id = m[1].toUpperCase();
    return ok(JSON.stringify([{ number: prOf(id), headRefOid: h.head(id), state: 'OPEN' }]));
  }],
  [/^gh pr view (\d+) --repo example\/scratch --json headRefName,state,body$/, (h, m) => {
    const id = idOfPr(m[1]);
    return ok(JSON.stringify({ headRefName: `conduct/seam-run/${id.toLowerCase()}`, state: 'OPEN', body: readFileSync(join(h.runDir, `lane-${id.toLowerCase()}-report.md`), 'utf8') }));
  }],
  [/^gh pr view (\d+) --repo example\/scratch --json headRefOid,baseRefName,state$/, (h, m) => ok(JSON.stringify({ headRefOid: headOf(h, idOfPr(m[1])), baseRefName: 'main', state: 'OPEN' }))],
  [/^gh pr view (\d+) --repo example\/scratch --json mergeCommit$/, (h, m) => ok(JSON.stringify({ mergeCommit: { oid: mergeSha(idOfPr(m[1])) } }))],
  [/^gh pr diff (\d+) --repo example\/scratch --name-only$/, (h, m) => ok(h.diff?.[idOfPr(m[1])] ?? 'src/x.mjs\n')],
  [/^gh pr (ready|merge) /, () => ok()],
  [/^gh pr create --draft --repo example\/scratch /, () => ok('https://github.com/example/scratch/pull/200\n')],
  [/^node \S+pr-review\.mjs managed /, () => ok(JSON.stringify({ mode: 'standalone' }))],
  [/^node \S+pr-review\.mjs post --pr (\d+)/, (h, m) => {
    const id = idOfPr(m[1]);
    return ok(`findings ${h.findings[id]?.length ? h.findings[id].shift() : 0}\n`);
  }],
  [/^node \S+pr-review\.mjs threads /, () => ok()],
  [/^node \S+pr-review\.mjs (uncertainty|lens|reply) /, () => ok()],
  [/^gh api graphql -f query=query/, () => ok(text('land', 'review-threads-145.json'))],
  [/^gh api graphql -f query=mutation/, () => ok('{}')],
  [/^git -C (\S+) rev-parse HEAD$/, (h, m) => ok(`${headOf(h, idOfWorktree(m[1]))}\n`)],
  [/^git -C (\S+) rev-parse HEAD origin\/main$/, (h, m) => ok(`${h.bump(idOfWorktree(m[1]))}\n${'9'.repeat(40)}\n`)],
  [/^git -C \S+ (fetch origin|rebase origin\/main|push |add |commit )/, () => ok()],
  [/^git -C \S+ merge-base --is-ancestor /, () => ok()],
  [/^git -C \S+ diff --no-color --no-ext-diff --no-textconv (\w+) (\w+)$/, (h, m) => ok(`diff ${m[1]} ${m[2]}\n`)],
  [/^git -C \S+ patch-id --verbatim$/, () => ok(`${'f'.repeat(40)} x\n`)],
  [/^git -C \S+ diff --quiet (?:--no-renames )?(\w+) (\w+)$/, (h, m) => ({ code: h.treeMismatch === m[2] ? 1 : 0, stdout: '', stderr: '' })],
  [/^git -C \S+ diff --name-only \S+ \S+$/, (h) => ok(h.amendDiff ?? 'src/x.mjs\n')],
  [/^git -C \S+ diff --no-color --output=/, () => ok()],
  [/^git -C \S+ show origin\/main:\.workit\/conduct\.json$/, () => ({ code: 128, stdout: '', stderr: "fatal: path '.workit/conduct.json' does not exist in 'origin/main'" })],
  [/^gh api repos\/example\/scratch\/commits\/(\w+)\/check-runs\?per_page=100 --paginate$/, (h, m) => (h.checkRuns ? h.checkRuns(m[1]) : ok(text('land', 'check-runs-green.json')))],
  [/^gh api repos\/example\/scratch\/commits\/\w+\/status\?per_page=100 --paginate$/, () => ok(text('land', 'commit-status-green.json'))],
  [/^gh api repos\/example\/scratch\/branches\/main\/protection\/required_status_checks$/, () => ok(text('land', 'required-checks.json'))],
  [/^node \S+escape-reader\.mjs --repo example\/scratch --since (\S+)$/, () => {
    const { code, stdout, stderr } = captured('seam', 'escape-reader.json');
    return { code, stdout, stderr };
  }],
  [/^claude plugin update workit@workit$/, (h) => {
    if (h.selfHosted && h.installAfter !== false) h.installed('after');
    return { code: h.afterCode ?? 0, stdout: '', stderr: h.afterCode ? 'update failed (synthetic)' : '' };
  }],
  [/^node --test$/, (h) => ({ code: h.verifyCode ?? 0, stdout: '', stderr: h.verifyCode ? 'not ok 1 - synthetic' : '' })],
  [/^sh -c /, (h, m, input, args) => ({ code: 0, stdout: /spend/.test(args.at(-1)) ? `${h.spendOut?.length ? h.spendOut.shift() : '1'}\n` : '', stderr: '' })],
];

function fakeExec(h, program, args, { input } = {}) {
  const key = [program, ...args].join(' ');
  h.calls.push(key);
  for (const [pattern, answer] of [...(h.rules ?? []), ...RULES]) {
    const match = pattern.exec(key);
    if (match) return answer(h, match, input, args);
  }
  return { code: 127, stdout: '', stderr: `unexpected command: ${key}` };
}

// The lane writes its report (an amendment pushes a new head first).
function writeReport(h, id, amended) {
  if (amended) h.bump(id);
  const name = h.reports[id]?.length ? h.reports[id].shift() : h.lastReport?.[id] ?? 'build/report-built.md';
  (h.lastReport ??= {})[id] = name;
  writeFileSync(join(h.runDir, `lane-${id.toLowerCase()}-report.md`), text(name).replaceAll('{pr}', String(prOf(id))).replaceAll('{head}', h.head(id)));
}

function fakeSpawn(h, { logPath }) {
  const id = /lane-(wp-\d+)\.log$/.exec(logPath)[1].toUpperCase();
  h.spawns[id] = (h.spawns[id] ?? 0) + 1;
  h.life[id] = h.lives?.[id] ?? 1;
  writeFileSync(logPath, LANE_LOG(num(id)), { flag: 'a' });
  writeReport(h, id, h.spawns[id] > 1);
  return { pid: 4200 + num(id) };
}

function herdrVerb(h, action) {
  const id = action.wpId;
  const verb = action.command[2];
  if (verb === 'create') return ok(JSON.stringify({ paneId: `pane-${id}`, path: `${h.repo}-wt-seam-run-${id.toLowerCase()}`, branch: `conduct/seam-run/${id.toLowerCase()}` }));
  if (verb === 'start') return ok(JSON.stringify({ startedAt: h.deps.timestamp() }));
  if (verb === 'prompt') {
    h.spawns[id] = (h.spawns[id] ?? 0) + 1;
    h.life[id] = h.lives?.[id] ?? 1;
    writeReport(h, id, h.spawns[id] > 1);
    return ok();
  }
  if (verb === 'wait') {
    if ((h.life[id] ?? 0) > 0) {
      h.life[id] -= 1;
      return { code: 4, stdout: '', stderr: 'timeout' };
    }
    return ok();
  }
  return ok();
}

async function conductVerb(h, action) {
  const root = resolve(dirname(action.command[1]), '..', '..', '..');
  const argv = action.command.slice(2);
  const result = await runConduct(argv, { ...h.deps, pluginRoot: root });
  if (argv[0] === 'lane' && argv[1] === 'alive') {
    const id = argv[argv.indexOf('--wp') + 1];
    h.life[id] = Math.max(0, (h.life[id] ?? 0) - 1);
  }
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

function fill(action) {
  let body = readFileSync(action.template, 'utf8');
  for (const [slot, value] of Object.entries(action.slots)) {
    if (action.part === 'bump') body = body.replace(slot, value);
    else body = value === null ? body.split('\n').filter((line) => !line.includes(slot)).join('\n') : body.replaceAll(slot, value);
  }
  return action.append ? `${body}${action.append}` : body;
}

function author(h, action) {
  if (action.step === 'ruling') {
    const value = h.rulings.length ? h.rulings.shift() : { ruled: action.ruling.keys.at(-1), evidence: 'node --test: 12 pass' };
    mkdirSync(dirname(action.outPath), { recursive: true });
    writeFileSync(action.outPath, JSON.stringify(value));
  } else if (action.step === 'council') {
    mkdirSync(dirname(action.outPath), { recursive: true });
    writeFileSync(action.outPath, JSON.stringify({ title: action.title }));
  } else if (action.files) {
    mkdirSync(action.outPath, { recursive: true });
    for (const file of action.files) writeFileSync(file.path, `${file.verdict}\n`);
  } else {
    mkdirSync(dirname(action.outPath), { recursive: true });
    writeFileSync(action.outPath, action.template ? fill(action) : action.instruction);
  }
  return {};
}

async function answerTouch(h, n) {
  const touch = h.state().touches[n - 1];
  const { key, text: words } = h.answers[touch.kind];
  const result = await h.run(['answer', '--run', h.runDir, '--touch', String(n), '--key', key, ...(words ? ['--text', words] : [])], { stdinIsTTY: true });
  assert.equal(result.code, 0, result.stdout);
}

function tool(h, action) {
  const state = h.state();
  switch (action.tool) {
    case 'spine_quest': {
      if (action.step === 'anchor') return { quests: [{ id: ANCHOR, campaign: { slug: 'seam', title: 'Seam campaign' }, latestReceipt: null }] };
      const touch = state.touches.find((candidate) => candidate.status === 'filed');
      const { key, text: words = null } = h.answers[touch.kind];
      return { quests: [{ id: ANCHOR, latestReceipt: { outcome: 'answered', question: `${correlation(state, touch)} synthetic question`,
        answer: { key, text: words, by: 'operator:seam', answeredAt: new Date(h.clock).toISOString() } } }] };
    }
    case 'spine_receipt': return { id: `00000000-0000-4000-8000-${String((h.seq += 1)).padStart(12, '0')}`, questId: action.args.questId, outcome: action.args.outcome };
    case 'spine_update': return { ok: true, questId: action.args.questId };
    case 'spine_author': return { quests: action.args.quests.map((quest, i) => ({ key: quest.key, id: `00000000-0000-4000-8000-00000000010${i + 1}` })) };
    case 'council_review': return { models: { opus: { status: 'success' } } };
    case 'council_synthesize': return { findings: h.council?.length ? h.council.shift() : 0, seats: ['opus'] };
    case 'council_challenge': return { success: true };
    default: throw new Error(`no fake for ${action.tool}`);
  }
}

// The scripted /spec: the workshop it wrote, and the record it reports.
function spec(h) {
  const { workshopDir } = h.state();
  if (h.depth === 'none') return { depth: 'none', workshopDir, gateCommand: h.gateCommand };
  cpSync(join(SEAM, 'workshop'), workshopDir, { recursive: true });
  h.onWorkshop?.(workshopDir);
  return { depth: 'deep', workshopDir, wps: [{ id: 'WP-01' }] };
}

async function perform(h, action) {
  const custom = h.custom?.(action);
  if (custom !== undefined) return custom;
  switch (action.kind) {
    case 'touch':
      await answerTouch(h, action.touch.n);
      return {};
    case 'wait':
      if (h.waitClock) h.clock += action.waitMs ?? 0;
      if (action.part === 'announce') {
        const open = h.state().touches.find((touch) => touch.status === 'open');
        await answerTouch(h, open.n);
      }
      return {};
    case 'author': return author(h, action);
    case 'skill': return spec(h);
    case 'agent-tool': return tool(h, action);
    default: {
      const { command } = action;
      if (command[0] === 'node' && command[1].endsWith('conduct.mjs')) return conductVerb(h, action);
      if (command[0] === 'node' && command[1].endsWith('lane.mjs')) {
        h.calls.push(command.join(' '));
        return herdrVerb(h, action);
      }
      const [program, ...args] = command;
      return fakeExec(h, program, args);
    }
  }
}

// next → perform → record until `until(action)` (left pending) or done.
async function drive(h, { until = () => false, max = 3000 } = {}) {
  let action = h.pending;
  h.pending = null;
  for (let i = 0; i < max; i += 1) {
    if (!action) {
      const result = await h.run(['next', '--run', h.runDir]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      action = out(result).action;
    }
    if (action.kind === 'done') return action;
    if (h.trace.at(-1)?.id !== action.id) {
      h.trace.push(action);
      h.onEmit?.(action);
    }
    if (until(action, h)) {
      h.pending = action;
      return action;
    }
    // A spine hand-back ends the conductor's turn; the next turn resumes it.
    if (action.handBack) {
      const resumed = await h.run(['next', '--resume', h.runDir]);
      assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
      action = out(resumed).action;
      continue;
    }
    const result = await perform(h, action);
    const recorded = await h.run(['record', '--run', h.runDir, '--action', action.id, '--result', JSON.stringify(result), ...(h.manual?.(action) ? ['--manual'] : [])]);
    if (recorded.code !== 0) throw new Error(`record ${action.id} (${action.step}/${action.part}): exit ${recorded.code}: ${recorded.stdout} ${recorded.stderr}`);
    h.onRecorded?.(action, out(recorded));
    action = out(recorded).action;
  }
  throw new Error(`drive did not settle: ${h.trace.slice(-6).map((a) => `${a.id}/${a.part ?? ''}${a.wpId ? `@${a.wpId}` : ''}`).join(', ')}`);
}

const of = (h, id) => h.trace.filter((a) => a.wpId === id);
const key = (a) => `${a.step}/${a.part ?? ''}`;
const section = (analysis, title) => analysis.split(/^## /m).find((part) => part.startsWith(`${title}\n`)) ?? '';
const row = (analysis, seamRow) => section(analysis, 'Seam coverage').split('\n').find((line) => line.startsWith(`- ${seamRow}:`)) ?? '';
const merges = (h) => h.trace.filter((a) => a.step === 'merge' && a.part === 'ready');
// The touch-opened events written before the analysis ran (it runs while the
// analyze action is pending, before the showcase opens).
function openedBeforeAnalysis(h) {
  const events = h.events();
  const analyze = events.findIndex((e) => e.event === 'emitted' && e.step === 'analyze');
  assert.ok(analyze > 0);
  return events.slice(0, analyze).filter((e) => e.event === 'touch-opened').length;
}

// A three-WP deep run to the showcase, adapters off, the release recipe on.
async function portability(t, opts = {}) {
  const h = seam(t, opts);
  let most = 0;
  h.onEmit = () => { most = Math.max(most, h.state().wps.filter((wp) => LIVE.includes(wp.state)).length); };
  await start(h, OFF);
  const done = await drive(h);
  return { h, done, most: () => most };
}

// ---- the tests ----

test('portability: every adapter off, a three-WP deep run from intake to closed; WP-02 ∥ WP-03; the second merge rebases, gates and lands at the rebased head', async (t) => {
  const { h, done, most } = await portability(t, { h: { reports: { 'WP-03': ['seam/report-no-runtime.md', 'build/report-built.md'] }, lives: { 'WP-02': 2, 'WP-03': 2 } } });
  assert.equal(done.kind, 'done');
  const state = h.state();
  assert.equal(state.phase, 'closed');
  assert.deepEqual(state.wps.map((wp) => [wp.id, wp.wave, wp.state]), [['WP-01', 1, 'merged'], ['WP-02', 2, 'merged'], ['WP-03', 2, 'merged']]);
  assert.equal(state.release.state, 'done');
  // The touch went through `answer` with an injected TTY; then spec, mint, build.
  assert.deepEqual(h.trace.slice(0, 2).map((a) => a.kind), ['touch', 'skill']);
  assert.equal(h.trace.find((a) => a.phase === 'build').step, 'contract');
  assert.ok(!h.trace.some((a) => a.kind === 'agent-tool'), 'no agent-tool action on the core path');
  assert.ok(!h.calls.some((call) => /lane\.mjs/.test(call)), 'no lane.mjs argv executed');
  assert.ok(most() >= 2, 'WP-02 and WP-03 were live at the same time');
  const [first, second] = merges(h).map((a) => a.wpId).filter((id) => id !== 'WP-01');
  assert.ok(first && second);
  const mine = of(h, second);
  const firstRebase = mine.findIndex((a) => a.step === 'rebase');
  const reviews = mine.filter((a) => ['review', 'post'].includes(a.step));
  assert.ok(reviews.length > 0 && firstRebase > 0, 'the second WP was reviewed and rebased');
  assert.ok(reviews.every((a) => mine.indexOf(a) < firstRebase), 'every review action precedes the rebase');
  const ready = mine.findIndex((a) => key(a) === 'merge/ready');
  const tail = mine.slice(firstRebase, ready).filter((a) => a.kind !== 'wait').map(key);
  assert.deepEqual(tail, ['rebase/fetch', 'rebase/pre-head', 'rebase/rebase', 'rebase/post-heads', 'rebase/push', 'gate-cmd/gate-cmd', 'gate/gate']);
  // The second merge waited for the first: its rebase starts after the first merged.
  assert.ok(h.trace.indexOf(mine[firstRebase]) > h.trace.findIndex((a) => a.wpId === first && a.step === 'merged'));
  const wp = state.wps.find((candidate) => candidate.id === second);
  assert.equal(wp.gate.head, wp.rebases.at(-1).to, 'land gate ran at the rebased head');
  assert.notEqual(wp.rebases.at(-1).to, wp.rebases.at(-1).from);
});

test('release PR (D16, D17, D19): base rev-parse, slot-form bumps, no review, land gate and merged --wp release; every release event carries seam release; the lock is the release\'s from fetch to merged (D20)', async (t) => {
  const h = seam(t);
  const lock = {};
  h.onRecorded = (action) => {
    if (action.phase === 'release' && action.part === 'fetch') lock.afterFetch = h.state().mergeLock;
    if (action.phase === 'release' && action.step === 'gate') lock.gate = h.state().release.gate;
    if (action.phase === 'release' && action.step === 'merged') lock.afterMerged = h.state().mergeLock;
  };
  await start(h, OFF);
  await drive(h);
  const release = h.trace.filter((a) => a.phase === 'release');
  assert.deepEqual(release.filter((a) => a.kind !== 'wait').map(key), [
    'release/fetch', 'release/base', 'release/worktree', 'release/bump', 'release/bump',
    'release/add', 'release/commit', 'release/head', 'release/push', 'release/pr', 'gate/gate',
    'merge/ready', 'merge/squash', 'merge/merge-commit', 'merged/merged', 'release/after', 'release/verify',
  ]);
  assert.ok(release.every((a) => a.seam === 'release'));
  assert.deepEqual(release.find((a) => a.part === 'base').command.slice(-2), ['rev-parse', 'origin/main']);
  const bumps = release.filter((a) => a.part === 'bump');
  assert.deepEqual(bumps.map((a) => a.slots), [{ '"version": "0.1.0"': '"version": "0.1.1"' }, { '"version": "0.1.0"': '"version": "0.1.1"' }]);
  assert.ok(bumps.every((a) => a.template === a.outPath && a.outPath.includes(`${'repo'}-wt-seam-run-release`)));
  assert.ok(!release.some((a) => ['review', 'post', 'council'].includes(a.step)), 'no review: the release PR is T0');
  assert.deepEqual(release.find((a) => a.step === 'gate').command.slice(-4), ['--run', h.runDir, '--wp', 'release']);
  assert.deepEqual(release.find((a) => a.step === 'merged').command.slice(-6), ['--run', h.runDir, '--wp', 'release', '--merge-sha', sha('d', 99)]);
  const events = h.events().filter((e) => release.some((a) => a.id === e.actionId));
  assert.ok(events.length > 0 && events.every((e) => e.seam === 'release'));
  assert.deepEqual(lock.afterFetch, { wpId: 'release', since: lock.afterFetch.since });
  assert.ok(lock.gate.ok && !lock.gate.causes.includes('lock'), 'land gate --wp release passes condition (0)');
  assert.equal(lock.afterMerged, null);
  const state = h.state();
  assert.deepEqual(state.release.version, { from: '0.1.0', to: '0.1.1' });
  assert.match(state.release.gate.unreviewedTail, /\(T0\)$/);
});

test('hold at PR (D12): touch 1 (b) → WP-01 held, WP-02 and WP-03 deferred naming it, no merge action, release not-exercised (held), the showcase lists them, zero merges audited', async (t) => {
  const h = seam(t, { answers: { preapproval: { key: 'b' } } });
  await start(h, OFF);
  const showcase = await drive(h, { until: (a) => a.step === 'showcase' });
  const state = h.state();
  assert.deepEqual(state.wps.map((wp) => wp.state), ['held', 'deferred', 'deferred']);
  assert.match(state.wps[1].reason, /WP-01/);
  assert.match(state.wps[2].reason, /WP-01/);
  assert.ok(!h.trace.some((a) => ['merge', 'merged'].includes(a.step)), 'no merge action was ever emitted');
  assert.deepEqual([state.release.state, state.release.reason], ['not-exercised', 'held']);
  const question = state.touches.find((touch) => touch.kind === 'showcase').question;
  assert.match(question, /Open PRs of held WPs: WP-01 https:\/\/github\.com\/example\/scratch\/pull\/101/);
  assert.match(question, /Deferred WPs: WP-02: depends on WP-01, which is held; WP-03: depends on WP-01, which is held/);
  assert.equal(showcase.kind, 'touch');
  assert.match(section(h.analysis(), 'Pre-approval audit'), /^- merges: 0$/m);
  // U3: every run PR is listed with its status, the open held one included.
  assert.match(section(h.analysis(), 'Escapes'), /^run PRs: #101 WP-01 open \(held\)$/m);
  assert.match(row(h.analysis(), 'release'), /^- release: not exercised/);
  assert.match(section(h.analysis(), 'Seam coverage'), /^ {2}- release not exercised: held$/m);
});

test('release only after a complete build (D19.10): WP-03 refuted, WP-01 and WP-02 merged → not-exercised (incomplete build), no release worktree', async (t) => {
  const h = seam(t, { h: { reports: { 'WP-03': ['build/report-refuted.md'] } } });
  await start(h, OFF);
  await drive(h, { until: (a) => a.step === 'showcase' });
  const state = h.state();
  assert.deepEqual(state.wps.map((wp) => wp.state), ['merged', 'merged', 'refuted']);
  assert.deepEqual([state.release.state, state.release.reason], ['not-exercised', 'incomplete build']);
  assert.ok(!h.calls.some((call) => /worktree add \S+-release /.test(call)));
  assert.ok(!h.trace.some((a) => a.phase === 'release'));
  assert.equal(state.phase, 'showcase');
});

// A depth-none run (one WP-00 lane) to a stop condition.
async function nonePath(t, opts = {}, extra = OFF) {
  const h = seam(t, { depth: 'none', ...opts });
  await start(h, extra);
  return h;
}

test('release failures (D20): land gate --wp release code 5, a verify exit 1 and an after exit 1 each end the release failed, unlocked, at analyze; the analysis and the showcase name it', async (t) => {
  const red = JSON.parse(text('land', 'check-runs-green.json'));
  red.check_runs[0].conclusion = 'failure';
  const cases = [
    ['land gate', { checkRuns: (s) => ok(JSON.stringify(s === RELEASE_HEAD ? red : JSON.parse(text('land', 'check-runs-green.json')))) }, /^land gate: CI failed at head/],
    ['verify', { verifyCode: 1 }, /^verify "node --test" exited 1: not ok 1 - synthetic$/],
    ['after', { afterCode: 1 }, /^after "claude plugin update workit@workit" exited 1: update failed \(synthetic\)$/],
    // Before the gate: only the release itself can release its lock.
    ['pr create', { rules: [[/^gh pr create /, () => ({ code: 1, stdout: '', stderr: 'pull request create failed (synthetic)' })]] }, /^pr exited 1: pull request create failed \(synthetic\)$/],
  ];
  for (const [name, patch, reason] of cases) {
    const h = await nonePath(t, { h: patch });
    const analyze = await drive(h, { until: (a) => a.step === 'analyze' });
    const state = h.state();
    assert.equal(state.release.state, 'failed', name);
    assert.match(state.release.reason, reason, name);
    assert.equal(state.mergeLock, null, name);
    assert.equal(state.phase, 'analyze', name);
    assert.equal(analyze.kind, 'shell');
    await drive(h, { until: (a) => a.step === 'showcase' });
    assert.ok(section(h.analysis(), 'Queue accounting').includes(`- release: failed: ${state.release.reason}`), name);
    // The failed release's PR link is in the question when the PR exists (U4).
    const link = state.release.pr ? ` https://github.com/example/scratch/pull/${state.release.pr.number}` : '';
    assert.ok(h.state().touches.find((touch) => touch.kind === 'showcase').question.includes(`Release: failed (${state.release.reason})${link}`), name);
    if (name === 'land gate') assert.ok(link);
  }
});

test('release bumps (M2): checked before emission — no slot, a duplicate slot, a file edited twice → failed and unlocked; a reformatted edit → record exits 2, state.json byte-identical', async (t) => {
  const plugin = (version) => ({ name: 'scratch', version, description: 'Placeholder plugin manifest for the seam fixture.', homepage: 'https://github.com/example/scratch' });
  const twice = { name: 'scratch', version: '0.1.0', plugins: [{ name: 'scratch', version: '0.1.0' }] };
  const cases = [
    ['compact JSON, no slot', (repo) => writeFileSync(join(repo, '.claude-plugin', 'plugin.json'), JSON.stringify(plugin('0.1.0'))), /^bump: \.claude-plugin\/plugin\.json: slot occurs 0 times$/],
    ['duplicate slot', (repo) => writeFileSync(join(repo, '.claude-plugin', 'marketplace.json'), `${JSON.stringify(twice, null, 2)}\n`), /^bump: \.claude-plugin\/marketplace\.json: slot occurs 2 times$/],
    ['a file edited twice', (repo) => {
      const config = JSON.parse(readFileSync(join(repo, '.workit', 'conduct.json'), 'utf8'));
      config.release.bump = [{ file: '.claude-plugin/plugin.json', jsonPath: 'version' }, { file: '.claude-plugin/plugin.json', jsonPath: 'version' }];
      writeFileSync(join(repo, '.workit', 'conduct.json'), JSON.stringify(config));
    }, /^bump plan edits \.claude-plugin\/plugin\.json twice$/],
    // C2-1: one file under two spellings is still one file.
    ['one file by two paths', (repo) => {
      const config = JSON.parse(readFileSync(join(repo, '.workit', 'conduct.json'), 'utf8'));
      config.release.bump = [{ file: '.claude-plugin/plugin.json', jsonPath: 'version' }, { file: './.claude-plugin/plugin.json', jsonPath: 'version' }];
      writeFileSync(join(repo, '.workit', 'conduct.json'), JSON.stringify(config));
    }, /^bump plan edits \.\/\.claude-plugin\/plugin\.json twice$/],
    // C2-2: the only expected-spacing slot is a nested field, not jsonPath.
    ['a unique slot on the wrong field', (repo) => writeFileSync(join(repo, '.claude-plugin', 'plugin.json'), '{"name":"scratch","version":"0.1.0","nested":{"version": "0.1.0"}}\n'),
      /^bump: \.claude-plugin\/plugin\.json: slot does not edit version$/],
  ];
  for (const [name, edit, reason] of cases) {
    const h = seam(t, { depth: 'none' });
    edit(h.repo);
    await start(h, OFF);
    await drive(h, { until: (a) => a.step === 'analyze' });
    const state = h.state();
    assert.deepEqual([state.release.state, state.mergeLock, state.phase], ['failed', null, 'analyze'], name);
    assert.match(state.release.reason, reason, name);
    assert.ok(!h.trace.some((a) => a.part === 'bump'), `${name}: no bump action was emitted`);
  }
  const h = await nonePath(t);
  const bump = await drive(h, { until: (a) => a.part === 'bump' });
  const before = readFileSync(join(h.runDir, 'state.json'));
  // The right value, reformatted: the JSON check alone would accept it.
  writeFileSync(bump.outPath, JSON.stringify(plugin('0.1.1')));
  const result = await h.run(['record', '--run', h.runDir, '--action', bump.id, '--result', '{}']);
  assert.equal(result.code, 2);
  assert.match(out(result).error, /must be the original with only "version": "0\.1\.0" replaced/);
  assert.ok(readFileSync(join(h.runDir, 'state.json')).equals(before));
});

test('release merge-commit lookup (U1): {code:1, stderr:"HTTP 502 Bad Gateway"} through runConduct → release failed, lock released, phase analyze', async (t) => {
  const h = await nonePath(t);
  const lookup = await drive(h, { until: (a) => a.phase === 'release' && a.part === 'merge-commit' });
  assert.equal(h.state().mergeLock.wpId, 'release');
  const result = await h.run(['record', '--run', h.runDir, '--action', lookup.id, '--result', JSON.stringify({ code: 1, stdout: '', stderr: 'HTTP 502 Bad Gateway' })]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(out(result).action.step, 'analyze');
  const state = h.state();
  assert.deepEqual([state.release.state, state.release.reason, state.mergeLock, state.phase],
    ['failed', 'merge: merge-commit failed (exit 1): HTTP 502 Bad Gateway', null, 'analyze']);
  // C2-8: the squash landed, so the release PR is merged, unconfirmed; not open.
  h.pending = out(result).action;
  await drive(h, { until: (a) => a.step === 'showcase' });
  assert.match(section(h.analysis(), 'Escapes'), /^run PRs: #100 WP-00 merged, #200 release merged \(merge commit unconfirmed\)$/m);
});

test('release CI deadline (C2-4): one 30-minute window per head from the earliest absent-or-pending reading; a new head restarts it', async (t) => {
  const green = JSON.parse(text('land', 'check-runs-green.json'));
  const pending = ok(JSON.stringify({ ...green, check_runs: green.check_runs.map((run) => ({ ...run, status: 'in_progress', conclusion: null })) }));
  const missing = { code: 1, stdout: '', stderr: 'gh: No commit found for SHA (HTTP 422)' };
  const minutes = (h, from) => (h.clock - from) / 60000;
  const cases = [
    ['missing, then pending at 29', (m) => (m < 29 ? missing : pending), [30, 33]],
    ['pending, then missing at 29', (m) => (m < 29 ? pending : missing), [30, 33]],
    ['missing; a new head at 20', (m) => missing, [50, 53], 20],
  ];
  for (const [name, reading, [low, high], newHeadAt] of cases) {
    const h = await nonePath(t, { h: { waitClock: true } });
    let firstAt = null;
    h.releaseHead = () => (newHeadAt && firstAt !== null && minutes(h, firstAt) >= newHeadAt ? 'f'.repeat(40) : RELEASE_HEAD);
    h.checkRuns = (s) => {
      if (s !== RELEASE_HEAD && s !== 'f'.repeat(40)) return ok(JSON.stringify(green));
      firstAt ??= h.clock;
      return reading(minutes(h, firstAt));
    };
    await drive(h, { until: (a) => a.step === 'analyze' });
    const state = h.state();
    assert.deepEqual([state.release.state, state.release.reason, state.mergeLock], ['failed', 'land gate: CI did not complete at head', null], name);
    const elapsed = minutes(h, firstAt);
    assert.ok(elapsed >= low && elapsed < high, `${name}: failed after ${elapsed} minutes`);
  }
});

test('release CI window (Split 3): no CI at the release head waits 30 minutes per head; CI appearing after 10 minutes continues, none by 30 fails the release', async (t) => {
  const zero = ok(text('land', 'check-runs-zero.json'));
  const green = ok(text('land', 'check-runs-green.json'));
  for (const appears of [12, null]) {
    const h = await nonePath(t, { h: { waitClock: true } });
    let firstAt = null;
    h.checkRuns = (s) => {
      if (s !== RELEASE_HEAD) return green;
      firstAt ??= h.clock;
      return appears !== null && h.clock - firstAt >= appears * 60000 ? green : zero;
    };
    await drive(h, { until: (a) => a.step === 'analyze' });
    const state = h.state();
    const gates = h.trace.filter((a) => a.phase === 'release' && a.step === 'gate' && a.kind === 'shell');
    if (appears) {
      assert.equal(state.release.state, 'done');
      assert.ok(gates.length > 10, `${gates.length} gate reads across the window`);
      assert.ok(h.events().some((e) => e.phase === 'release' && e.step === 'gate'));
    } else {
      assert.deepEqual([state.release.state, state.release.reason, state.mergeLock], ['failed', 'land gate: CI did not complete at head', null]);
      assert.ok(h.clock - firstAt >= 30 * 60000 && h.clock - firstAt < 33 * 60000, `${(h.clock - firstAt) / 60000} minutes`);
    }
  }
});

test('release failures (D20): land merged --wp release code 5 → dispatchHalt and a blocked touch with no wpId; any answer fails the release', async (t) => {
  const h = await nonePath(t, { h: { treeMismatch: sha('d', 99) } });
  await drive(h, { until: (a) => a.kind === 'touch' && h.state().touches[a.touch.n - 1].kind === 'blocked' });
  let state = h.state();
  assert.ok(state.dispatchHalt);
  const touch = state.touches.at(-1);
  assert.deepEqual([touch.kind, touch.wpId], ['blocked', null]);
  await drive(h, { until: (a) => a.step === 'analyze' });
  state = h.state();
  assert.equal(state.release.state, 'failed');
  assert.match(state.release.reason, /squash tree differs.*operator answer \(a\)/);
});

// A fixture plugin install: plugin.json at `version`, SKILL.md and conduct.mjs.
function install(root, version) {
  mkdirSync(join(root, 'skills', 'conduct', 'scripts'), { recursive: true });
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'workit', version }));
  writeFileSync(join(root, 'skills', 'conduct', 'SKILL.md'), '# placeholder\n');
  writeFileSync(join(root, 'skills', 'conduct', 'scripts', 'conduct.mjs'), '// placeholder: the installed copy; Phase E runs it\n');
}

test('plugin-root handover (M1): an update that left the old install (same root, old version) fails the release; the destination must carry the bump\'s version and conduct.mjs', async (t) => {
  const h = await nonePath(t, { selfHosted: true, h: { selfHosted: true, installAfter: false } });
  install(join(h.dir, 'plugins', 'workit', '0.1.0'), '0.1.0');
  await drive(h, { until: (a) => a.step === 'analyze' });
  let state = h.state();
  assert.deepEqual([state.release.state, state.release.reason, state.handover, state.mergeLock], ['failed', 'handover: installed version is 0.1.0, not 0.1.1', null, null]);
  const g = await nonePath(t, { selfHosted: true, h: { selfHosted: true } });
  const after = join(g.dir, 'plugins', 'workit', '0.1.1');
  install(after, '0.1.1');
  rmSync(join(after, 'skills', 'conduct', 'scripts', 'conduct.mjs'));
  await drive(g, { until: (a) => a.step === 'analyze' });
  state = g.state();
  assert.equal(state.release.state, 'failed');
  assert.match(state.release.reason, /^handover: .+conduct\.mjs is missing$/);
});

test('plugin-root handover (D19.22): self-hosted → state.handover and the after snapshot\'s root; the old root exits 2 naming it, the new one emits analyze', async (t) => {
  const h = await nonePath(t, { selfHosted: true, h: { selfHosted: true } });
  const after = join(h.dir, 'plugins', 'workit', '0.1.1');
  install(after, '0.1.1');
  await drive(h, { until: (a) => a.step === 'analyze' });
  assert.ok(existsSync(join(h.state().pluginRoot, 'skills', 'conduct', 'scripts', 'conduct.mjs')), 'the destination holds conduct.mjs');
  const state = h.state();
  assert.equal(state.release.state, 'done');
  assert.equal(state.pluginRoot.replaceAll('\\', '/'), after.replaceAll('\\', '/'));
  assert.deepEqual(state.handover.from, h.plugin);
  h.pending = null;
  const old = await h.run(['next', '--run', h.runDir]);
  assert.equal(old.code, 2);
  assert.ok(out(old).error.includes(state.pluginRoot));
  const fresh = out(await h.run(['next', '--run', h.runDir], { pluginRoot: state.pluginRoot })).action;
  assert.equal(fresh.step, 'analyze');
  assert.equal(fresh.command[1], join(state.pluginRoot, 'skills', 'conduct', 'scripts', 'conduct.mjs'));
});

test('analyze is a shell action (D19.20): no escape-reader call until the agent runs it', async (t) => {
  const h = await nonePath(t);
  const analyze = await drive(h, { until: (a) => a.step === 'analyze' });
  assert.deepEqual([analyze.kind, analyze.step, analyze.seam], ['shell', 'analyze', 'run-analysis']);
  assert.deepEqual(analyze.command, ['node', join(h.plugin, 'skills', 'conduct', 'scripts', 'conduct.mjs'), 'analyze', '--run', h.runDir]);
  assert.equal(analyze.expects.type, 'exit0');
  assert.ok(!h.calls.some((call) => /escape-reader/.test(call)));
  assert.ok(!existsSync(join(h.runDir, 'run-analysis.md')));
  await drive(h, { until: (a) => a.step === 'showcase' });
  assert.equal(h.calls.filter((call) => /escape-reader/.test(call)).length, 1);
  assert.equal(h.state().phase, 'showcase');
});

test('analysis counts (D16, D17): recorded N equals the touch-opened events; an escalated ruling\'s blocked touch makes recorded: 2; --manual review steps read by hand', async (t) => {
  const h = await nonePath(t, { h: { reports: { 'WP-00': ['build/report-needs-conductor.md', 'build/report-built.md'] }, rulings: [{ escalate: true, why: 'only the operator can pick the flag name' }] } });
  h.manual = (a) => ['review', 'post'].includes(a.step);
  await drive(h, { until: (a) => a.step === 'showcase' });
  const analysis = h.analysis();
  assert.equal(openedBeforeAnalysis(h), 2);
  assert.match(section(analysis, 'Touches'), /^recorded: 2$/m);
  assert.match(section(analysis, 'Touches'), /^- touch 2 \(blocked, WP-00\): answered \(a\)$/m);
  assert.match(section(analysis, 'Touches'), /^showcase: opens after this file \(the total at close is 3\)$/m);
  assert.match(row(analysis, 'review-tier'), /^- review-tier: by hand/);
  assert.match(row(analysis, 'lane-dispatch'), /^- lane-dispatch: owned/);
});

test('not-exercised steps (D18): a "human review" gate command lists gate-cmd under merge-gate as not exercised, with the reason', async (t) => {
  const h = await nonePath(t, { gateCommand: 'human review' });
  await drive(h, { until: (a) => a.step === 'showcase' });
  assert.ok(!h.trace.some((a) => a.step === 'gate-cmd'));
  assert.match(section(h.analysis(), 'Seam coverage'), /^- merge-gate: owned .*\n {2}- gate-cmd not exercised \(WP-00\): "human review" is not a command$/m);
});

test('spend on (D19.28, M4): a metered run that stays below budget shows its last reading in the audit; a halted one shows the reading after the halt', async (t) => {
  const flags = ['--no-adapter', 'herdr', '--no-adapter', 'notify'];
  const below = await nonePath(t, { env: { WORKIT_SPEND_CMD: 'spend-meter' }, h: { spendOut: ['3.5', '4.25'] } }, flags);
  await drive(below, { until: (a) => a.step === 'showcase' });
  assert.ok(!below.state().touches.some((touch) => touch.kind === 'blocked'), 'no budget halt');
  const last = below.state().build.lastSpend;
  assert.equal(last.usd, 4.25);
  const audit = section(below.analysis(), 'Pre-approval audit');
  assert.ok(audit.includes(`- budget: metered by the spend adapter; spend reading: $4.25 (read ${last.at})`), audit);
  assert.ok(!audit.includes('unmetered'));
  const halted = await nonePath(t, { env: { WORKIT_SPEND_CMD: 'spend-meter' }, answers: { blocked: { key: 'a', text: 'budget 100' } }, h: { spendOut: ['30'] } }, flags);
  await drive(halted, { until: (a) => a.step === 'showcase' });
  assert.match(section(halted.analysis(), 'Pre-approval audit'), /^- budget: metered by the spend adapter; spend reading: \$1\.00 \(read \S+\)$/m);
});

test('judgment threads (D19.9): a judgment row\'s thread is listed under the audit and in the showcase question', async (t) => {
  const h = await nonePath(t, { h: { reports: { 'WP-00': ['build/report-built.md', 'build/report-amendment.md'] }, findings: { 'WP-00': [3] }, amendDiff: 'docs/notes.md\n' } });
  await drive(h, { until: (a) => a.step === 'showcase' });
  const line = 'WP-00 PR #100 comment 4177261828: thread PRRT_kwDOS_8yoc6oxnvx resolved';
  assert.ok(section(h.analysis(), 'Pre-approval audit').includes(`  - ${line}`), section(h.analysis(), 'Pre-approval audit'));
  assert.ok(h.state().touches.find((touch) => touch.kind === 'showcase').question.includes(line));
});

test('adjudication evidence (C1-14, C2-6): a council WP\'s adjudication row reads from its adjudicated events alone', async (t) => {
  const flags = ['herdr', 'notify', 'spend', 'spine', 'kb', 'verify'].flatMap((name) => ['--no-adapter', name]);
  const h = await nonePath(t, { h: { reports: { 'WP-00': ['build/report-built.md', 'build/report-council-amendment.md'] }, council: [2, 0], diff: { 'WP-00': 'src/a.test.mjs\n' } } },
    [...flags, '--adapter', 'council']);
  await drive(h, { until: (a) => a.step === 'showcase' });
  assert.ok(!h.trace.some((a) => ['reply', 'thread-ids', 'resolve'].includes(a.step)), 'a council WP emits no reply, thread-ids or resolve');
  const adjudicated = h.events().filter((e) => e.event === 'adjudicated');
  assert.equal(adjudicated.length, 1);
  assert.equal(row(h.analysis(), 'adjudication'), '- adjudication: owned (adjudicated)');
});

test('send-back is terminal (D19.5): (c) naming merge-gate → sent-back with the seam and text; next is done; no later merge, release or lane event; replay 0, other id 5', async (t) => {
  const words = 'The merge-gate let a stale base through; reopen from there.';
  const h = await nonePath(t, { answers: { showcase: { key: 'c', text: words } } });
  const done = await drive(h);
  assert.equal(done.kind, 'done');
  const state = h.state();
  assert.equal(state.phase, 'sent-back');
  assert.deepEqual(state.sentBack, { seam: 'merge-gate', text: words });
  assert.equal(out(await h.run(['next', '--run', h.runDir])).action.kind, 'done');
  const events = h.events();
  const at = events.findIndex((e) => e.event === 'showcase-answered');
  assert.ok(at > 0);
  const LATE = new Set(['rebase', 'gate-cmd', 'gate', 'merge', 'merged', 'release', 'admit', 'create', 'start', 'prompt', 'wait', 'check', 'stop']);
  assert.deepEqual(events.slice(at + 1).filter((e) => LATE.has(e.step)), []);
  const count = events.length;
  assert.equal((await h.run(['record', '--run', h.runDir, '--action', state.lastRecorded, '--result', '{}'])).code, 0);
  assert.equal(h.events().length, count);
  assert.equal((await h.run(['record', '--run', h.runDir, '--action', '1-preapproval', '--result', '{}'])).code, 5);
});

test('depth none: one WP-00 lane from <run>/wp-00.md, no mint action, through closed; the wp-mint row reads not exercised', async (t) => {
  const h = await nonePath(t);
  assert.equal((await drive(h)).kind, 'done');
  const state = h.state();
  assert.equal(state.phase, 'closed');
  assert.deepEqual(state.wps.map((wp) => [wp.id, wp.specPath]), [['WP-00', join(h.runDir, 'wp-00.md')]]);
  assert.ok(!h.trace.some((a) => a.step === 'mint'));
  assert.equal(row(h.analysis(), 'wp-mint'), '- wp-mint: not exercised');
});

test('the analysis: headings in order; seam rows; runtime exercise from an amended report; escapes labeled with the run PRs; unmetered lower bound; resume equals the uninterrupted next', async (t) => {
  const { h } = await portability(t, { h: { reports: { 'WP-03': ['seam/report-no-runtime.md', 'build/report-built.md'] } } });
  const analysis = h.analysis();
  assert.deepEqual([...analysis.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['Queue accounting', 'Touches', 'Seam coverage', 'Runtime exercise',
    'Where the time went', 'Catches by watcher position', 'Escapes', 'Pre-approval audit', 'Recommendations']);
  assert.deepEqual(section(analysis, 'Seam coverage').split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).split(':')[0]), SEAM_ROWS);
  const opened = openedBeforeAnalysis(h);
  assert.match(section(analysis, 'Touches'), new RegExp(`^recorded: ${opened}$`, 'm'));
  assert.match(section(analysis, 'Runtime exercise'), /^- WP-03: exercised \(field: CLI: `node src\/right\.mjs` prints `right`\.\)$/m);
  assert.equal(h.spawns['WP-03'], 2, 'WP-03 was amended once for its missing section');
  assert.match(section(analysis, 'Escapes'), /^repo-wide since 2026-10-04: saw 1, missed 1, unreviewed 0, unparsed 0 \(2 Escape lines\)$/m);
  assert.match(section(analysis, 'Escapes'), /^run PRs: #101 WP-01 merged, #102 WP-02 merged, #103 WP-03 merged, #200 release merged$/m);
  // U2: the spine-off mint is evidence of its own.
  assert.equal(row(analysis, 'wp-mint'), '- wp-mint: owned (minted)');
  // C1-3: the runtime row cites the checks that stored each verdict.
  const checks = h.state().wps.map((wp) => wp.runtimeVerdictBy.actionId);
  assert.equal(row(analysis, 'runtime-exercise'), `- runtime-exercise: owned (${checks.join(', ')})`);
  assert.match(section(analysis, 'Pre-approval audit'), /^- budget: unmetered; lane-only lower bound \$0\.75 /m);
  assert.match(section(analysis, 'Pre-approval audit'), /^- merges: 4$/m);
  for (const seamRow of ['spec-depth', 'workshop-scaffold', 'spec-review']) assert.match(row(analysis, seamRow), /^- \S+: owned \(\d+-spec\)$/);
});

test('resume (M5): stopped after the release PR merges, `--resume` from the run dir drives the rest of the run through the same {step, kind, part} sequence as the uninterrupted run', async (t) => {
  const shape = (a) => ({ step: a.step, kind: a.kind, part: a.part ?? null });
  const isMerged = (a) => a.phase === 'release' && a.step === 'merged';
  // The uninterrupted run, and its tail after the release PR merged.
  const whole = seam(t);
  await start(whole, OFF);
  assert.equal((await drive(whole)).kind, 'done');
  const expected = whole.trace.slice(whole.trace.findIndex(isMerged) + 1).map(shape);
  // The same run stopped once that merged is recorded, then resumed from the
  // run dir by a fresh runConduct and driven to its end.
  const h = seam(t);
  let merged = false;
  h.onRecorded = (action) => { merged ||= isMerged(action); };
  await start(h, OFF);
  await drive(h, { until: () => merged });
  const stoppedAt = h.trace.length - 1;
  const resumed = await runConduct(['--resume', h.runDir], { ...h.deps });
  assert.equal(resumed.code, 0);
  h.pending = out(resumed).action;
  assert.equal((await drive(h)).kind, 'done');
  const tail = h.trace.slice(stoppedAt).map(shape);
  assert.deepEqual(expected.map((a) => `${a.step}/${a.part}`), ['release/after', 'release/verify', 'analyze/null', 'showcase/null']);
  assert.deepEqual(tail, expected);
  assert.equal(h.state().phase, 'closed');
});

test('spine + herdr: spine_author once, a receipt per WP stop, touches filed once and read back, lane steps through lane.mjs --log, the runtime-only check; notify env (D20); seams keyed on seam (D19.15)', async (t) => {
  const notify = 'notify-cmd --channel conduct';
  const h = seam(t, { herdr: true, env: { WORKIT_NOTIFY_CMD: notify } });
  await start(h, ['--adapter', 'spine', '--anchor', ANCHOR.slice(0, 8), '--no-adapter', 'spend']);
  assert.equal((await drive(h)).kind, 'done');
  const state = h.state();
  assert.deepEqual(state.wps.map((wp) => wp.state), ['merged', 'merged', 'merged']);
  assert.equal(h.trace.filter((a) => a.tool === 'spine_author').length, 1);
  for (const wp of state.wps) {
    const mine = of(h, wp.id);
    assert.equal(mine.filter((a) => a.tool === 'spine_update' && a.args.currentPhase === 'build').length, 1, `${wp.id} flip`);
    assert.equal(mine.filter((a) => a.tool === 'spine_receipt' && a.args.outcome === 'completed').length, 1, `${wp.id} merge receipt`);
    assert.equal(mine.filter((a) => a.tool === 'spine_update' && a.args.workState === 'done').length, 1, `${wp.id} done`);
  }
  for (const touch of state.touches) {
    const filings = h.trace.filter((a) => a.tool === 'spine_receipt' && a.args.outcome === 'needs_input' && a.args.question.startsWith(touch.tag));
    assert.equal(filings.length, 1, touch.tag);
    const next = h.trace[h.trace.indexOf(filings[0]) + 1];
    assert.deepEqual([next.tool, next.args.ids], ['spine_quest', [ANCHOR]]);
  }
  const herdr = h.trace.filter((a) => a.wpId && ['admit', 'start', 'prompt', 'wait', 'stop'].includes(a.step) && a.kind === 'shell');
  assert.ok(herdr.length > 0 && herdr.every((a) => a.command[1].endsWith('lane.mjs') && a.command.includes('--log')));
  for (const wp of state.wps) {
    const checks = of(h, wp.id).filter((a) => a.step === 'check');
    const runtime = checks.filter((a) => a.command.includes('--runtime-only'));
    assert.ok(runtime.length >= 1 && runtime.every((a) => a.seam === 'runtime-exercise' && a.command[1].endsWith('conduct.mjs')));
    for (const a of runtime) {
      const shape = h.trace[h.trace.indexOf(a) + 1];
      assert.deepEqual([shape.command[2], shape.command.includes('--expect-report')], ['check', true], 'the runtime-only check and lane.mjs check --expect-report run as a pair');
    }
  }
  const notifies = h.trace.filter((a) => a.step === 'notify');
  assert.equal(notifies.length, 3, 'one per WP merge; the release emits none');
  for (const a of notifies) {
    assert.deepEqual(a.command, shellArgv(notify, 'linux'));
    assert.deepEqual(Object.keys(a.env).sort(), ['WORKIT_NOTIFY_PR', 'WORKIT_NOTIFY_REVERT', 'WORKIT_NOTIFY_SHA']);
    assert.ok(!a.command.some((arg) => arg.includes(a.env.WORKIT_NOTIFY_SHA)));
  }
  // Seams keyed on the `seam` field: the runtime-only checks sit under runtime-exercise only.
  const analysis = h.analysis();
  const runtimeIds = h.trace.filter((a) => a.command?.includes('--runtime-only')).map((a) => a.id);
  for (const id of runtimeIds) {
    assert.ok(row(analysis, 'runtime-exercise').includes(id), id);
    assert.ok(!row(analysis, 'lane-wait').split(/[(), ]+/).includes(id), id);
  }
  assert.match(row(analysis, 'lane-wait'), /\d+-wait/);
  // Action ids, plus the release's own state event (no action id).
  const releaseCites = row(analysis, 'release').replace(/^- release: owned \(|\)$/g, '').split(', ');
  const releaseIds = releaseCites.filter((cite) => /^\d+-/.test(cite));
  assert.deepEqual(releaseCites.filter((cite) => !/^\d+-/.test(cite)), ['release']);
  assert.ok(releaseIds.length > 5 && releaseIds.every((id) => h.trace.find((a) => a.id === id)?.phase === 'release'), row(analysis, 'release'));
  const opened = openedBeforeAnalysis(h);
  assert.match(section(analysis, 'Touches'), new RegExp(`^recorded: ${opened}$`, 'm'));
  for (const run of [h.trace]) {
    for (const a of run) {
      const [, step] = /^\d+-(.+)$/.exec(a.id);
      assert.ok(STEPS.includes(step) && a.step === step, a.id);
    }
  }
  assert.ok(h.events().every((e) => 'step' in e && 'seam' in e));
});

// E6: the spine read-back's no-answer cases. `reply` picks what the next
// touch read-back returns; 'operator' falls through to the scripted answer.
function spineReplies(h) {
  h.reply = 'none';
  h.custom = (action) => {
    if (action.tool !== 'spine_quest' || action.step === 'anchor' || h.reply === 'operator') return undefined;
    const state = h.state();
    const touch = state.touches.find((candidate) => candidate.status === 'filed');
    const answer = { key: 'a', text: null, by: 'operator:seam', answeredAt: new Date(h.clock).toISOString() };
    const latest = {
      none: { outcome: 'needs_input', question: `${correlation(state, touch)} synthetic question`, answer: null },
      stale: { outcome: 'answered', question: `${touch.tag} (run 00000000/${touch.filings}) synthetic question`, answer },
      agent: { outcome: 'answered', question: `${correlation(state, touch)} synthetic question`, answer: { ...answer, by: 'agent:claude' } },
    }[h.reply];
    return { quests: [{ id: ANCHOR, latestReceipt: latest }] };
  };
}
const SPINE_ONLY = ['--adapter', 'spine', '--anchor', ANCHOR.slice(0, 8), '--no-adapter', 'herdr', '--no-adapter', 'notify', '--no-adapter', 'spend'];
const isHandBack = (a) => a.handBack === true;
const needsInput = (h) => h.trace.filter((a) => a.tool === 'spine_receipt' && a.args.outcome === 'needs_input');

test('E6 hand-back (spine): no attributed answer → a touch-kind hand-back, never a wait; record leaves it pending; next --resume reads back; stale or unattributed answers hand back again; the operator\'s answer reaches /spec', async (t) => {
  const h = seam(t);
  spineReplies(h);
  await start(h, SPINE_ONLY);
  const back = await drive(h, { until: isHandBack, max: 10 });
  assert.deepEqual(h.trace.map((a) => `${a.tool ?? a.kind}/${a.part ?? ''}`), ['spine_quest/', 'spine_receipt/receipt', 'spine_quest/read-back', 'touch/hand-back']);
  assert.deepEqual([back.kind, back.step, back.touch.n, back.seam], ['touch', 'preapproval', 1, 'operator-touch']);
  assert.match(back.instruction, /^Stop and end your turn: \[conduct seam-run touch 1\] is filed on quest a0a0a0a0-/);
  assert.ok(back.instruction.includes(`next --resume "${h.runDir}"`), back.instruction);
  // Recording a hand-back changes nothing: the same action, answered: false.
  const recorded = await h.run(['record', '--run', h.runDir, '--action', back.id, '--result', '{}']);
  assert.deepEqual([recorded.code, out(recorded).answered, out(recorded).action.id], [0, false, back.id]);
  // The resume: the hand-back is consumed and the touch is read back, not re-filed.
  const resumed = out(await h.run(['next', '--resume', h.runDir])).action;
  assert.deepEqual([resumed.tool, resumed.part], ['spine_quest', 'read-back']);
  assert.ok(h.events().some((e) => e.event === 'resumed' && e.actionId === back.id && e.seam === 'operator-touch'));
  // Another run's answer to the same tag: hand back again, no new filing.
  h.reply = 'stale';
  h.pending = resumed;
  assert.equal((await drive(h, { until: isHandBack, max: 5 })).part, 'hand-back');
  assert.equal(needsInput(h).length, 1);
  // An answer not stamped operator: is refused (exit 3) and re-filed; unanswered, it hands back.
  h.reply = 'agent';
  const read = out(await h.run(['next', '--resume', h.runDir])).action;
  const refused = await h.run(['record', '--run', h.runDir, '--action', read.id, '--result', JSON.stringify(await perform(h, read))]);
  assert.equal(refused.code, 3);
  assert.equal(out(refused).action.tool, 'spine_receipt');
  h.reply = 'none';
  h.pending = out(refused).action;
  assert.equal((await drive(h, { until: isHandBack, max: 5 })).part, 'hand-back');
  assert.equal(h.state().touches[0].filings, 2);
  // The operator answers: the next resume reads it back and the run reaches /spec.
  h.reply = 'operator';
  const spec = await drive(h, { until: (a) => a.kind === 'skill', max: 5 });
  assert.equal(spec.step, 'spec');
  assert.equal(h.state().touches[0].answer.by, 'operator:seam');
  assert.ok(!h.trace.some((a) => a.kind === 'wait'), 'no wait at any touch');
});

test('E6 hand-back (spine): the showcase touch hands back the same way; the resumed read-back closes the run', async (t) => {
  const h = seam(t);
  spineReplies(h);
  h.reply = 'operator';
  await start(h, SPINE_ONLY);
  h.onEmit = (a) => { if (a.step === 'showcase' && a.part === 'receipt') h.reply = 'none'; };
  const back = await drive(h, { until: isHandBack });
  assert.deepEqual([back.kind, back.step, back.part], ['touch', 'showcase', 'hand-back']);
  assert.equal(h.trace.filter(isHandBack).length, 1, 'touch 1 was answered at its first read-back');
  h.reply = 'operator';
  assert.equal((await drive(h)).kind, 'done');
  assert.equal(h.state().phase, 'closed');
  assert.ok(!h.trace.some((a) => a.kind === 'wait' && a.touch), 'no touch-tagged wait');
});

test('E6 hand-back (spine): the release anomaly\'s touch hands back with seam release (its action and its resumed event); the resume reads back; any operator answer fails the release', async (t) => {
  const h = await nonePath(t, { h: { treeMismatch: sha('d', 99) } }, SPINE_ONLY);
  spineReplies(h);
  h.reply = 'operator';
  h.onEmit = (a) => { if (a.step === 'touch' && a.part === 'receipt') h.reply = 'none'; };
  const back = await drive(h, { until: isHandBack });
  assert.deepEqual([back.kind, back.step, back.part, back.seam], ['touch', 'touch', 'hand-back', 'release']);
  assert.deepEqual([h.state().touches[back.touch.n - 1].kind, h.state().touches[back.touch.n - 1].wpId], ['blocked', null]);
  const resumed = out(await h.run(['next', '--resume', h.runDir])).action;
  assert.deepEqual([resumed.tool, resumed.part, resumed.seam], ['spine_quest', 'read-back', 'release']);
  assert.deepEqual(h.events().filter((e) => e.event === 'resumed').map((e) => [e.actionId, e.seam]), [[back.id, 'release']]);
  h.reply = 'operator';
  h.pending = resumed;
  await drive(h, { until: (a) => a.step === 'analyze' });
  assert.equal(h.state().release.state, 'failed');
  assert.match(h.state().release.reason, /squash tree differs.*operator answer \(a\)/);
});

test('action ids (D18, D19.15): every action id in the portability run is <seq>-<step> with step in STEPS; every event carries step and seam', async (t) => {
  const { h } = await portability(t);
  for (const a of h.trace) {
    const [, step] = /^\d+-(.+)$/.exec(a.id);
    assert.ok(STEPS.includes(step) && a.step === step, a.id);
  }
  assert.ok(h.events().every((e) => 'step' in e && 'seam' in e));
});

test('mint switch: a workshop tier defect is a spec defect `next` names (exit 2), never a crash; fixed, the run goes on', async (t) => {
  const h = seam(t);
  h.onWorkshop = (workshopDir) => {
    const path = join(workshopDir, 'work-packages', 'wp-02-left.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('**Review tier:** T1', '**Review tier:** T5'));
  };
  await start(h, OFF);
  const specAction = await drive(h, { until: (a) => a.kind === 'skill' });
  const recorded = await h.run(['record', '--run', h.runDir, '--action', specAction.id, '--result', JSON.stringify(spec(h))]);
  assert.equal(recorded.code, 2);
  assert.match(out(recorded).error, /^spec defect in .+: WP-02: \*\*Review tier:\*\* value "T5" is not T0, T1 or T2\. Fix the workshop, then run next again\.$/);
  assert.equal(out(recorded).recorded, specAction.id);
  assert.equal(h.state().phase, 'mint');
  assert.equal((await h.run(['next', '--run', h.runDir])).code, 2);
  const path = join(h.state().workshopDir, 'work-packages', 'wp-02-left.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('T5', 'T1'));
  const next = out(await h.run(['next', '--run', h.runDir])).action;
  assert.equal(next.step, 'contract');
  assert.deepEqual(h.state().wps.map((wp) => wp.id), ['WP-01', 'WP-02', 'WP-03']);
});

test('deep mint needs its workshop (C1-1): a missing orchestrator, or a workshop with no WP, is a spec defect; nothing mints from the record', async (t) => {
  const cases = [
    ['missing orchestrator', (dir) => rmSync(join(dir, 'work-packages', '_orchestrator.md')), /_orchestrator\.md is missing\. Fix the workshop, then run next again\.$/],
    ['no work package', (dir) => { for (const name of readdirSync(join(dir, 'work-packages')).filter((n) => n.startsWith('wp-'))) rmSync(join(dir, 'work-packages', name)); },
      /work-packages holds no wp-\*\.md work package\. Fix the workshop, then run next again\.$/],
  ];
  for (const [name, breakIt, message] of cases) {
    const h = seam(t);
    h.onWorkshop = breakIt;
    await start(h, OFF);
    const specAction = await drive(h, { until: (a) => a.kind === 'skill' });
    const recorded = await h.run(['record', '--run', h.runDir, '--action', specAction.id, '--result', JSON.stringify({ ...spec(h), wps: [{ id: 'WP-01' }] })]);
    assert.equal(recorded.code, 2, name);
    assert.match(out(recorded).error, /^spec defect in /, name);
    assert.match(out(recorded).error, message, name);
    const state = h.state();
    assert.deepEqual([state.phase, state.wps], ['mint', []], name);
  }
});

test('touch filings (C1-2): a showcase filing acknowledged with ok:false, success:false, no receipt uuid, another quest or another outcome stays open and is re-emitted', async (t) => {
  const h = seam(t, { depth: 'none' });
  await start(h, ['--adapter', 'spine', '--anchor', ANCHOR.slice(0, 8), ...['herdr', 'notify', 'spend'].flatMap((name) => ['--no-adapter', name])]);
  const filing = await drive(h, { until: (a) => a.tool === 'spine_receipt' && a.args.question?.includes('touch 2]') });
  const good = { id: '00000000-0000-4000-8000-0000000000aa', questId: ANCHOR, outcome: 'needs_input' };
  const bad = [{ ...good, ok: false }, { ...good, success: false }, { questId: ANCHOR, outcome: 'needs_input' },
    { ...good, questId: '11111111-0000-4000-8000-000000000001' }, { ...good, outcome: 'answered' }];
  for (const result of bad) {
    const recorded = await h.run(['record', '--run', h.runDir, '--action', filing.id, '--result', JSON.stringify(result)]);
    assert.equal(recorded.code, 2, JSON.stringify(result));
    assert.match(out(recorded).error, /^spine_receipt did not file \[conduct seam-run touch 2\]/);
    const state = h.state();
    assert.equal(state.touches[1].status, 'open');
    assert.equal(state.pending.id, filing.id);
    assert.deepEqual(out(await h.run(['next', '--run', h.runDir])).action, filing);
  }
  // C2-10: `error: null` is no error.
  const filed = out(await h.run(['record', '--run', h.runDir, '--action', filing.id, '--result', JSON.stringify({ ...good, error: null })]));
  assert.equal(filed.action.tool, 'spine_quest');
  assert.deepEqual([h.state().touches[1].status, h.state().touches[1].receiptId], ['filed', good.id]);
});

test('runtime ownership (C1-3): the runtime row cites the verdict-storing checks; a --manual check reads by hand, a missing verdict not exercised', async (t) => {
  const manual = await nonePath(t);
  manual.manual = (a) => a.step === 'check';
  await drive(manual, { until: (a) => a.step === 'showcase' });
  const id = manual.state().wps[0].runtimeVerdictBy.actionId;
  assert.equal(row(manual.analysis(), 'runtime-exercise'), `- runtime-exercise: by hand (${id})`);
  assert.match(row(manual.analysis(), 'lane-wait'), /^- lane-wait: by hand/);
  // A stored `missing` verdict is not an exercise, whoever recorded it.
  const owned = await nonePath(t);
  await drive(owned, { until: (a) => a.step === 'showcase' });
  assert.match(row(owned.analysis(), 'runtime-exercise'), /^- runtime-exercise: owned \(\d+-check\)$/);
  const path = join(owned.runDir, 'state.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.wps[0].runtimeVerdict = 'missing';
  writeFileSync(path, JSON.stringify(state));
  assert.equal((await owned.run(['analyze', '--run', owned.runDir])).code, 0);
  assert.equal(row(owned.analysis(), 'runtime-exercise'), '- runtime-exercise: not exercised');
  assert.match(section(owned.analysis(), 'Runtime exercise'), /^- WP-00: missing /m);
  // C2-7: a verdict whose producing record cannot be read is by hand, never owned.
  state.wps[0].runtimeVerdict = 'exercised';
  state.wps[0].runtimeVerdictBy = { actionId: null };
  writeFileSync(path, JSON.stringify(state));
  assert.equal((await owned.run(['analyze', '--run', owned.runDir])).code, 0);
  assert.equal(row(owned.analysis(), 'runtime-exercise'), '- runtime-exercise: by hand (provenance unread)');
});

test('send-back seam (M3): `seam: <name>` wins; otherwise exactly one named seam; aliases map to spec; the touch seam (operator-touch, formerly touches) is never taken', () => {
  assert.equal(namedSeam('The release notes are wrong; send back to merge-gate.'), null);
  assert.equal(namedSeam('The release notes are wrong; seam: merge-gate.'), 'merge-gate');
  assert.equal(namedSeam('reopen at the merge-gate'), 'merge-gate');
  assert.equal(namedSeam('seam: spec-review — the council missed it'), 'spec');
  assert.equal(namedSeam('the runtime-exercise row was vacuous'), 'runtime-exercise');
  assert.equal(namedSeam('seam: touches'), null);
  assert.equal(namedSeam('seam: operator-touch'), null);
  assert.equal(namedSeam('the operator-touch was slow'), null);
  assert.ok(!SEAM_ROWS.includes('operator-touch') && !SEAM_ROWS.includes('touches'));
  assert.equal(namedSeam('too many touches'), null);
  assert.equal(namedSeam(null), null);
  // C2-3: an explicit form decides alone, on its whole token.
  assert.equal(namedSeam('seam: bogus; the release failed'), null);
  assert.equal(namedSeam('seam: touches - the merge-gate wait was long'), null);
  assert.equal(namedSeam('seam: merge-gate2'), null);
  assert.equal(namedSeam('seam: merge-gate.x'), null);
  assert.equal(namedSeam('seam: merge-gate.'), 'merge-gate');
  assert.equal(namedSeam('seam: release, the bump was wrong'), 'release');
});

test('failure showcase (U4): a blocked WP and an open run touch are named in the question with their reasons', async (t) => {
  // WP-00's merged tree differs: it blocks and a run-level touch opens, which
  // the operator leaves unanswered into the showcase.
  const h = await nonePath(t, { h: { treeMismatch: sha('d', 0) } });
  h.custom = (a) => (a.kind === 'wait' && a.part === 'announce' ? {} : undefined);
  await drive(h, { until: (a) => a.step === 'showcase' });
  const state = h.state();
  assert.equal(state.wps[0].state, 'blocked');
  const touch = state.touches.find((candidate) => candidate.kind === 'blocked');
  assert.equal(touch.status, 'open');
  const question = state.touches.find((candidate) => candidate.kind === 'showcase').question;
  assert.ok(question.includes(`Blocked touches still open: touch ${touch.n}`), question);
  assert.ok(question.includes('Refuted or blocked WPs: WP-00 blocked: merged tree differs from the checked head (https://github.com/example/scratch/pull/100)'), question);
  assert.ok(question.includes('Release: not-exercised (incomplete build)'));
  assert.ok(!/conductor names here by hand/.test(question), 'no agent-facing placeholder');
  assert.match(question, /write `seam: <name>`/);
  // C2-8: merged, then blocked by the post-merge tree check: still merged.
  assert.match(section(h.analysis(), 'Escapes'), /^run PRs: #100 WP-00 merged \(post-merge check failed\)$/m);
});

test('fixture paths: no file under __fixtures__/seam matches either Must 8 regex', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(SEAM);
  assert.ok(files.length >= 12, files.join(', '));
  for (const path of files) assert.deepEqual(PRIVATE_PATHS.filter((pattern) => pattern.test(readFileSync(path, 'utf8'))).map(String), [], path);
  assert.ok(PRIVATE_PATHS.every((pattern) => pattern.test(['C:', 'Users', 'someone', 'x'].join('\\'))), 'the regexes still fire on a private path');
});
