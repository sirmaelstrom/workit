import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NEAR_EMPTY_COMMITS, bindBootstrap, bootstrap, bootstrapBrief, bootstrapScope, bootstrapWp, detectGreenfield, fillTemplate, loadManifest, repoTemplates,
  runBootstrapVerb,
} from './bootstrap.mjs';
import { runConduct } from '../conduct.mjs';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const REPO_TEMPLATES = repoTemplates(PLUGIN_ROOT);
const VALUES = { name: 'demo', year: '2026', owner: 'Owner Name' };

function fixture(t, files = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'conduct-bootstrap-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return repo;
}

// Real filesystem; `gh repo view` is the only fake.
function deps(gh = { code: 0, stdout: JSON.stringify({ nameWithOwner: 'o/demo', visibility: 'PRIVATE', deleteBranchOnMerge: true }), stderr: '' }) {
  const calls = [];
  return {
    calls,
    pluginRoot: PLUGIN_ROOT,
    exists: existsSync,
    read: (path) => readFileSync(path, 'utf8'),
    write: (path, text) => writeFileSync(path, text),
    list: (path) => readdirSync(path),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    now: () => Date.UTC(2026, 9, 16),
    exec: (program, args, options) => {
      calls.push([program, ...args]);
      if (program === 'gh') return gh;
      if (args.includes('--show-toplevel')) return { code: 0, stdout: `${args[1]}\n`, stderr: '' };
      if (args.includes('user.name')) return { code: 0, stdout: 'Owner Name\n', stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
  };
}

const byId = (report) => Object.fromEntries(report.items.map((item) => [item.id, item]));

test('every template the manifest names exists, and the public-flip checklist too', () => {
  const manifest = loadManifest((path) => readFileSync(path, 'utf8'), REPO_TEMPLATES);
  const named = [
    ...manifest.items.map((item) => item.template),
    ...Object.values(manifest.stacks).flatMap((stack) => [...Object.values(stack.templates ?? {}), ...stack.items.map((item) => item.template)]),
  ].filter(Boolean);
  assert.ok(named.length >= 10, 'the guard read the manifest');
  for (const name of named) assert.ok(existsSync(join(REPO_TEMPLATES, 'files', name)), `template ${name} is missing`);
  assert.ok(existsSync(join(REPO_TEMPLATES, manifest.publicFlip)));
});

test('an empty repo fails every core item; no package.json means no node items', (t) => {
  const repo = fixture(t);
  const report = bootstrap(repo, { deps: deps(), values: VALUES, templates: REPO_TEMPLATES });
  assert.equal(report.ok, false);
  assert.deepEqual(report.stacks, []);
  assert.ok(report.items.every((item) => item.status === 'missing'));
  assert.ok(!report.items.some((item) => item.stack === 'node'));
  assert.deepEqual(report.written, []);
});

test('--write fills the gaps from templates, never overwrites, and reports what still needs a hand', (t) => {
  const repo = fixture(t, { 'README.md': '# mine\n', 'package.json': '{"name":"demo"}', 'CLAUDE.md': '# notes without the import\n' });
  const report = bootstrap(repo, { write: true, deps: deps(), values: VALUES, templates: REPO_TEMPLATES });
  assert.deepEqual(report.stacks, ['node']);
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), '# mine\n', 'an existing file is never rewritten');
  assert.equal(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), '# notes without the import\n', 'an incomplete file is reported, not repaired');
  const items = byId(report);
  assert.equal(items.readme.status, 'present');
  assert.equal(items['claude-stub'].status, 'incomplete');
  assert.equal(items.engines.status, 'incomplete'); // no template: a hand edit
  assert.equal(items.license.status, 'written');
  assert.match(readFileSync(join(repo, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 Owner Name/);
  // The node stack swaps the CI and dependabot templates.
  const ci = readFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /node-version-file: \.nvmrc/);
  assert.match(ci, /group: ci-\$\{\{ github\.ref \}\}/, 'GitHub expressions survive placeholder filling');
  assert.equal(items.ci.status, 'written');
  assert.equal(items['dependabot-npm'].status, 'written'); // the node dependabot template carries npm
  assert.deepEqual(report.failing, ['claude-stub: incomplete (missing "@AGENTS.md")', 'engines: incomplete (package.json has no engines.node)']);
  assert.equal(report.ok, false);
});

test('a repo that already meets the manifest passes, with workflow markers spread across files', (t) => {
  const repo = fixture(t);
  bootstrap(repo, { write: true, deps: deps(), values: VALUES, templates: REPO_TEMPLATES });
  // Split the CI: gitleaks lives in its own workflow and still counts.
  const ci = readFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'utf8');
  const at = ci.indexOf('  secret-scan:');
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), ci.slice(0, at));
  writeFileSync(join(repo, '.github', 'workflows', 'secrets.yml'), `on: pull_request\njobs:\n${ci.slice(at)}`);
  const report = bootstrap(repo, { deps: deps(), values: VALUES, templates: REPO_TEMPLATES });
  assert.deepEqual(report.failing, []);
  assert.equal(report.ok, true);
  // Remove the scan entirely: the marker check catches it.
  writeFileSync(join(repo, '.github', 'workflows', 'secrets.yml'), 'on: pull_request\n');
  assert.deepEqual(bootstrap(repo, { deps: deps(), values: VALUES, templates: REPO_TEMPLATES }).failing, ['ci: incomplete (missing "gitleaks")']);
});

test('settings: an unreadable gh is unverified, never a pass; a private repo is pointed at the public-flip checklist', (t) => {
  const repo = fixture(t);
  bootstrap(repo, { write: true, deps: deps(), values: VALUES, templates: REPO_TEMPLATES });
  const down = bootstrap(repo, { deps: deps({ code: 1, stdout: '', stderr: 'gh: not logged in\n' }), values: VALUES, templates: REPO_TEMPLATES });
  assert.equal(down.ok, false);
  assert.deepEqual(down.failing, ['delete-branch-on-merge: unverified (gh: not logged in)']);
  const off = bootstrap(repo, { deps: deps({ code: 0, stdout: JSON.stringify({ nameWithOwner: 'o/demo', visibility: 'PRIVATE', deleteBranchOnMerge: false }), stderr: '' }), values: VALUES, templates: REPO_TEMPLATES });
  assert.deepEqual(off.failing, ['delete-branch-on-merge: missing (deleteBranchOnMerge is false)']);
  assert.equal(off.settings[0].fix, 'gh repo edit o/demo --delete-branch-on-merge');
  assert.match(off.publicFlip.due, /private free-plan repo/);
  const pub = bootstrap(repo, { deps: deps({ code: 0, stdout: JSON.stringify({ nameWithOwner: 'o/demo', visibility: 'PUBLIC', deleteBranchOnMerge: true }), stderr: '' }), values: VALUES, templates: REPO_TEMPLATES });
  assert.equal(pub.ok, true);
  assert.equal(pub.publicFlip.due, null);
  const offline = deps();
  assert.equal(bootstrap(repo, { offline: true, deps: offline, values: VALUES, templates: REPO_TEMPLATES }).settings, 'skipped (--offline)');
  assert.ok(!offline.calls.some(([program]) => program === 'gh'), '--offline makes no gh call');
});

test('review #243: a .node-version repo gets CI that names it; .yaml workflows count; markers in comments do not', (t) => {
  const repo = fixture(t, { 'package.json': '{"name":"demo","engines":{"node":">=24"}}', '.node-version': '24\n' });
  bootstrap(repo, { write: true, deps: deps(), values: VALUES, templates: REPO_TEMPLATES });
  assert.match(readFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'utf8'), /node-version-file: \.node-version\n/);
  assert.equal(existsSync(join(repo, '.nvmrc')), false, 'the accepted pin is kept, not doubled');
  // The same workflow under .yaml satisfies the item; --write adds no ci.yml beside it.
  const yaml = fixture(t);
  bootstrap(yaml, { write: true, deps: deps(), values: VALUES, templates: REPO_TEMPLATES });
  const ci = join(yaml, '.github', 'workflows', 'ci.yml');
  writeFileSync(join(yaml, '.github', 'workflows', 'ci.yaml'), readFileSync(ci, 'utf8'));
  rmSync(ci);
  const again = bootstrap(yaml, { write: true, deps: deps(), values: VALUES, templates: REPO_TEMPLATES });
  assert.equal(byId(again).ci.status, 'present');
  assert.equal(existsSync(ci), false);
  // Markers that appear only in comments are absent.
  writeFileSync(join(yaml, '.github', 'workflows', 'ci.yaml'), 'on: push\njobs: {}\n# pull_request concurrency: cancel-in-progress: true timeout-minutes: gitleaks\nname: x # gitleaks\n');
  assert.match(byId(bootstrap(yaml, { deps: deps(), values: VALUES, templates: REPO_TEMPLATES })).ci.detail, /missing "pull_request", "concurrency:", "cancel-in-progress: true", "timeout-minutes:", "gitleaks"/);
});

test('fillTemplate writes LF even from a CRLF checkout of the template', () => {
  assert.equal(fillTemplate('a: {{name}}\r\nb: 1\r\n', VALUES), 'a: demo\nb: 1\n');
});

test('fillTemplate replaces only its own three keys', () => {
  assert.equal(fillTemplate('{{name}} {{year}} {{owner}} ${{ github.ref }} {{other}}', VALUES), 'demo 2026 Owner Name ${{ github.ref }} {{other}}');
});

test('the verb: exit 3 with gaps, 0 once complete, 2 without --repo', async (t) => {
  const repo = fixture(t);
  const d = deps();
  assert.equal(runBootstrapVerb({ repo }, d).code, 3);
  assert.equal(runBootstrapVerb({ repo, write: true }, d).code, 0);
  const viaCli = await runConduct(['bootstrap', '--repo', repo, '--offline'], { ...d, importModule: (rel) => import(new URL(`../${rel}`, import.meta.url)) });
  assert.equal(viaCli.code, 0);
  assert.equal(JSON.parse(viaCli.stdout).ok, true);
  const usage = await runConduct(['bootstrap'], { ...d, importModule: (rel) => import(new URL(`../${rel}`, import.meta.url)) });
  assert.equal(usage.code, 2);
});

// ---- the /conduct wiring (quest 977d3efb: trigger (c), writer (d)) ----

test('detectGreenfield: on for no CI workflow or a near-empty history; an unread count is not a trigger', () => {
  assert.deepEqual(detectGreenfield({ ciWorkflows: 0, commits: 40 }), { on: true, why: ['no CI workflow can gate a PR'], commits: 40 });
  assert.deepEqual(detectGreenfield({ ciWorkflows: 2, commits: NEAR_EMPTY_COMMITS }), { on: true, why: [`${NEAR_EMPTY_COMMITS} commits on HEAD`], commits: NEAR_EMPTY_COMMITS });
  assert.deepEqual(detectGreenfield({ ciWorkflows: 2, commits: 1 }).why, ['1 commit on HEAD']);
  assert.equal(detectGreenfield({ ciWorkflows: 0, commits: 1 }).why.length, 2);
  assert.equal(detectGreenfield({ ciWorkflows: 2, commits: NEAR_EMPTY_COMMITS + 1 }).on, false);
  assert.deepEqual(detectGreenfield({ ciWorkflows: null, commits: null }), { on: false, why: [], commits: null });
});

test('bootstrapScope: every failing item\'s path, node items included before package.json exists; creates are the absent ones', (t) => {
  const repo = fixture(t, { 'README.md': '# mine\n', 'CLAUDE.md': '# no import\n', '.github/workflows/build.yml': 'on: push\n' });
  const scope = bootstrapScope(repo, { deps: deps(), templates: REPO_TEMPLATES });
  assert.ok(!scope.files.includes('README.md'), 'a passing item adds no path');
  for (const path of ['CLAUDE.md', 'LICENSE', '.github/workflows/ci.yml', '.github/workflows/build.yml', '.nvmrc', 'package.json', '.prettierrc', '.github/dependabot.yml']) {
    assert.ok(scope.files.includes(path), `${path} is in scope`);
  }
  assert.equal(scope.files.filter((path) => path === '.github/dependabot.yml').length, 1, 'a shared path is listed once');
  assert.ok(!scope.creates.includes('CLAUDE.md') && !scope.creates.includes('.github/workflows/build.yml'), 'an existing file is not a Create path');
  assert.ok(scope.creates.includes('LICENSE') && scope.creates.includes('.github/workflows/ci.yml'));
  assert.ok(scope.failing.includes('claude-stub') && scope.failing.includes('engines'));
});

test('bootstrapWp and bindBootstrap: WP-01 of a deep spec, else WP-00; Files and Create paths widen once', (t) => {
  assert.equal(bootstrapWp([{ id: 'WP-02' }, { id: 'WP-01' }]).id, 'WP-01');
  assert.equal(bootstrapWp([{ id: 'WP-00' }]).id, 'WP-00');
  assert.equal(bootstrapWp([{ id: 'WP-02' }]), null);
  const repo = fixture(t, { 'README.md': '# mine\n' });
  const state = {
    pluginRoot: PLUGIN_ROOT, intent: { repo: { path: repo }, greenfield: { on: true, why: ['no CI workflow can gate a PR'] } },
    wps: [{ id: 'WP-01', files: ['src/a.ts', 'LICENSE'], creates: ['src/a.ts'] }, { id: 'WP-02', files: ['src/b.ts'], creates: [] }],
  };
  const wp = bindBootstrap(state, deps());
  assert.equal(wp.id, 'WP-01');
  assert.equal(wp.files.filter((path) => path === 'LICENSE').length, 1);
  assert.ok(wp.files.includes('src/a.ts') && wp.files.includes('.github/workflows/ci.yml'));
  assert.ok(wp.creates.includes('.github/workflows/ci.yml') && !wp.creates.includes('README.md'));
  assert.deepEqual(state.wps[1].files, ['src/b.ts'], 'no other WP is touched');
  assert.ok(wp.bootstrap.failing.includes('ci'));
  const brief = bootstrapBrief(state, wp, '/wt');
  assert.match(brief, /^## Greenfield bootstrap$/m);
  assert.ok(brief.includes(`node ${join(PLUGIN_ROOT, 'skills', 'conduct', 'scripts', 'conduct.mjs')} bootstrap --repo /wt --write --offline`));
  assert.ok(brief.includes('`.github/workflows/ci.yml`'));
  // Off: nothing changes.
  const off = { ...state, intent: { ...state.intent, greenfield: { on: false, why: [] } }, wps: [{ id: 'WP-01', files: [] }] };
  assert.equal(bindBootstrap(off, deps()), null);
  assert.deepEqual(off.wps[0], { id: 'WP-01', files: [] });
});
