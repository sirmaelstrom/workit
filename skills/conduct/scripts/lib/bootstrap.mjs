// conduct bootstrap: check a repo against the greenfield manifest
// (reference/templates/repo/manifest.json, quest 977d3efb) and, with --write,
// copy a template for every missing file. Existing files are never rewritten.
// A file that exists but lacks a required marker is reported, not repaired.
//
// The verdict is the exit code: 0 when every applicable item and setting
// passes, 3 when anything is missing, incomplete or unverified, 2 on usage.
// A setting that cannot be read is `unverified`, never a pass. `--offline`
// skips settings and says so in the output.
import { dirname, join, basename, relative, sep } from 'node:path';
import { ConductError } from './state.mjs';

// The plugin root comes from conduct.mjs (deps.pluginRoot), never from this
// module's own URL (conduct.test.mjs 'pluginRoot from conduct.mjs only').
export const repoTemplates = (pluginRoot) => join(pluginRoot, 'reference', 'templates', 'repo');

export function loadManifest(read, root) {
  const manifest = JSON.parse(read(join(root, 'manifest.json')));
  if (manifest.version !== 1 || !Array.isArray(manifest.items)) throw new ConductError(2, `unreadable repo manifest at ${root}`);
  return manifest;
}

// The stacks whose `when` file exists, and the items that apply: core items
// with any stack template override, then each stack's own items.
export function applicableItems(manifest, exists, repo) {
  const stacks = Object.entries(manifest.stacks ?? {}).filter(([, stack]) => exists(join(repo, stack.when))).map(([name]) => name);
  const overrides = Object.assign({}, ...stacks.map((name) => manifest.stacks[name].templates ?? {}));
  const core = manifest.items.map((item) => (overrides[item.id] ? { ...item, template: overrides[item.id] } : item));
  return { stacks, items: [...core, ...stacks.flatMap((name) => manifest.stacks[name].items.map((item) => ({ ...item, stack: name })))] };
}

const toPosix = (path) => path.split(sep).join('/');

// `.github/workflows/*.yml`-style globs: one directory, a `*` in the file name.
function globFiles(repo, glob, { exists, list }) {
  const dir = dirname(glob);
  const pattern = new RegExp(`^${basename(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  const abs = join(repo, dir);
  if (!exists(abs)) return [];
  return list(abs).filter((name) => pattern.test(name)).sort().map((name) => toPosix(join(dir, name)));
}

function jsonField(text, dotted) {
  try {
    return dotted.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), JSON.parse(text));
  } catch {
    return undefined;
  }
}

// A YAML file's markers count only outside comments: a full-line `#` comment
// and a trailing ` #` comment are dropped before the search (review #243).
// The search stays textual; it does not prove a job is wired to a trigger.
const YAML = /\.ya?ml$/i;
export function markerText(path, text) {
  if (!YAML.test(path)) return text;
  return text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).map((line) => line.replace(/\s#.*$/, '')).join('\n');
}

export function checkItem(repo, item, fs) {
  const base = { id: item.id, path: item.path, why: item.why, ...(item.stack ? { stack: item.stack } : {}) };
  const globs = [item.glob ?? []].flat();
  const candidates = globs.length ? globs.flatMap((glob) => globFiles(repo, glob, fs)) : (item.anyOf ?? [item.path]).filter((path) => fs.exists(join(repo, path)));
  if (candidates.length === 0) return { ...base, status: 'missing', detail: globs.length ? `no file matches ${globs.join(' or ')}` : `none of ${(item.anyOf ?? [item.path]).join(', ')}` };
  const found = globs.length ? candidates : [candidates[0]];
  if (item.json) {
    const value = jsonField(fs.read(join(repo, found[0])), item.json);
    return value === undefined || value === null || value === ''
      ? { ...base, status: 'incomplete', found: found[0], detail: `${found[0]} has no ${item.json}` }
      : { ...base, status: 'present', found: found[0] };
  }
  if (item.contains?.length) {
    const texts = found.map((path) => markerText(path, fs.read(join(repo, path))));
    const absent = item.contains.filter((marker) => !texts.some((text) => text.includes(marker)));
    if (absent.length) return { ...base, status: 'incomplete', found: found.join(', '), detail: `missing ${absent.map((m) => JSON.stringify(m)).join(', ')}` };
  }
  return { ...base, status: 'present', found: found.join(', ') };
}

// One `gh repo view` read for every setting. A failed read leaves each
// setting `unverified` with the reason.
export function checkSettings(repo, settings, exec) {
  if (!settings?.length) return { visibility: null, settings: [] };
  const fields = [...new Set(['nameWithOwner', 'visibility', ...settings.map((s) => s.field)])];
  const view = exec('gh', ['repo', 'view', '--json', fields.join(',')], { cwd: repo });
  let data = null;
  try { data = view.code === 0 ? JSON.parse(view.stdout) : null; } catch { data = null; }
  const why = data ? null : (String(view.stderr ?? '').trim().split(/\r?\n/)[0] || `gh repo view exited ${view.code}`);
  return {
    visibility: data?.visibility ?? null,
    nameWithOwner: data?.nameWithOwner ?? null,
    settings: settings.map((s) => {
      const out = { id: s.id, field: s.field, expect: s.expect, why: s.why, fix: data?.nameWithOwner ? s.fix.replace('{repo}', data.nameWithOwner) : s.fix };
      if (!data) return { ...out, status: 'unverified', detail: why };
      return data[s.field] === s.expect ? { ...out, status: 'present' } : { ...out, status: 'missing', detail: `${s.field} is ${JSON.stringify(data[s.field])}` };
    }),
  };
}

// Written files are LF whatever the checkout did to the template (a Windows
// clone with core.autocrlf hands back CRLF): .editorconfig asks for LF, and
// the Windows CI job caught a CRLF render (PR #243, run 38846428461).
export function fillTemplate(text, values) {
  return text.replace(/\r\n/g, '\n').replace(/\{\{(name|year|owner|nodeVersionFile)\}\}/g, (_, key) => values[key]);
}

// The Node pin the generated CI points setup-node at: the one the repo already
// has (the manifest accepts either), else the .nvmrc --write is about to add.
export function nodeVersionFile(repo, exists) {
  return !exists(join(repo, '.nvmrc')) && exists(join(repo, '.node-version')) ? '.node-version' : '.nvmrc';
}

export function bootstrap(repo, { write = false, offline = false, deps, templates, values }) {
  const fs = { exists: deps.exists, read: deps.read, list: deps.list };
  const manifest = loadManifest(deps.read, templates);
  const { stacks, items } = applicableItems(manifest, deps.exists, repo);
  const written = [];
  if (write) {
    for (const item of items) {
      const status = checkItem(repo, item, fs);
      if (status.status !== 'missing' || !item.template) continue;
      const target = join(repo, item.path);
      if (deps.exists(target)) continue; // another item already wrote this path
      deps.mkdir(dirname(target));
      deps.write(target, fillTemplate(deps.read(join(templates, 'files', item.template)), { ...values, nodeVersionFile: nodeVersionFile(repo, deps.exists) }));
      written.push(item.path);
    }
  }
  const results = items.map((item) => {
    const result = checkItem(repo, item, fs);
    return written.includes(item.path) && result.status === 'present' ? { ...result, status: 'written' } : result;
  });
  const remote = offline ? { visibility: null, settings: [] } : checkSettings(repo, manifest.settings, deps.exec);
  const failing = [...results, ...remote.settings].filter((r) => !['present', 'written'].includes(r.status));
  const isPrivate = remote.visibility === 'PRIVATE' || remote.visibility === 'INTERNAL';
  return {
    ok: failing.length === 0,
    repo,
    stacks,
    items: results,
    settings: offline ? 'skipped (--offline)' : remote.settings,
    written,
    failing: failing.map((r) => `${r.id}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`),
    publicFlip: {
      visibility: remote.visibility,
      checklist: join(templates, manifest.publicFlip),
      due: isPrivate ? 'when the repo goes public: branch protection, secret scanning and push protection are unavailable on a private free-plan repo' : null,
    },
  };
}

// ---- the /conduct wiring (quest 977d3efb, operator answer (c) + writer (d)) ----

// The gate cause a failing bootstrap check carries. land.mjs classifies any
// cause it does not name as an amendment, so this one is lane-fixable.
export const BOOTSTRAP_CAUSE = 'bootstrap';
// "A near-empty history": at most this many commits on the checkout's HEAD.
export const NEAR_EMPTY_COMMITS = 3;

// The intake trigger (answer (c)): on when the repo has no CI workflow that
// can gate a PR (ciWorkflows 0) or a near-empty history. An unread workflow
// count (null) is not a trigger on its own: a gh failure must not turn the
// check on for an established repo. An unread commit count is not one either.
export function detectGreenfield({ ciWorkflows, commits }) {
  const why = [];
  if (ciWorkflows === 0) why.push('no CI workflow can gate a PR');
  if (Number.isInteger(commits) && commits <= NEAR_EMPTY_COMMITS) why.push(`${commits} commit${commits === 1 ? '' : 's'} on HEAD`);
  return { on: why.length > 0, why, commits: Number.isInteger(commits) ? commits : null };
}

// The paths the bootstrap WP's lane may need to write (writer (d)): every
// applicable manifest item that does not pass on the checkout. A stack applies
// when its `when` file exists or is one of `wpFiles` (WP-01 of a greenfield
// run often creates the package.json that turns the node items on), so a
// stack neither has nor plans adds nothing (council review 1). An incomplete
// item adds the file it found as well as its default path. `creates` holds the
// ones absent from the checkout, so the brief preflight lets the brief name them.
export function bootstrapScope(repo, { deps, templates, wpFiles = [] }) {
  const fs = { exists: deps.exists, read: deps.read, list: deps.list };
  const manifest = loadManifest(deps.read, templates);
  const planned = new Set(wpFiles.map(toPosix));
  const { items } = applicableItems(manifest, (path) => deps.exists(path) || planned.has(toPosix(relative(repo, path))), repo);
  const failing = items.map((item) => checkItem(repo, item, fs)).filter((result) => result.status !== 'present');
  const files = [...new Set(failing.flatMap((result) => [result.path, ...String(result.found ?? '').split(', ').filter(Boolean)]))];
  return { files, creates: files.filter((path) => !deps.exists(join(repo, path))), failing: failing.map((result) => result.id) };
}

// The WP that carries the bootstrap: WP-01 of a deep spec, else the single
// WP-00 of a none|lite one, else the first WP by wave then id (a workshop
// that numbers from WP-02 still gets the gate it was promised on touch 1).
export function bootstrapWp(wps) {
  const ordered = [...wps].sort((a, b) => (a.wave ?? 1) - (b.wave ?? 1) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  return wps.find((wp) => /^wp-0*1$/i.test(wp.id)) ?? wps.find((wp) => /^wp-0*0$/i.test(wp.id)) ?? ordered[0] ?? null;
}

// Mint binds the scope to that WP, read from the repo checkout then: its
// Files and Create paths gain the manifest paths, and `wp.bootstrap` (the
// paths and the items failing at mint) turns the land gate's check on. The
// manifest is read from the run's plugin root, the same root the gate's
// verb and the brief's command run from.
export function bindBootstrap(state, deps) {
  if (!state.intent.greenfield?.on) return null;
  const wp = bootstrapWp(state.wps);
  if (!wp) return null;
  let scope;
  try {
    scope = bootstrapScope(state.intent.repo.path, { deps, templates: repoTemplates(state.pluginRoot), wpFiles: [...(wp.files ?? []), ...(wp.creates ?? [])] });
  } catch (error) {
    if (error instanceof ConductError) throw error;
    throw new ConductError(4, `the greenfield manifest is unreadable under ${repoTemplates(state.pluginRoot)}: ${error.message}`);
  }
  wp.files = [...new Set([...(wp.files ?? []), ...scope.files])];
  wp.creates = [...new Set([...(wp.creates ?? []), ...scope.creates])];
  wp.bootstrap = { files: scope.files, failing: scope.failing };
  return wp;
}

// The lane brief's addition for the bootstrap WP: run the verb with --write,
// finish what it reports for a hand edit, and leave repo settings alone.
export function bootstrapBrief(state, wp, worktree) {
  const script = join(state.pluginRoot, 'skills', 'conduct', 'scripts', 'conduct.mjs');
  const files = wp.bootstrap.files.length ? wp.bootstrap.files.map((path) => `\`${path}\``).join(', ') : 'none (every item passed at mint)';
  return [
    '## Greenfield bootstrap', '',
    `Intake found a greenfield repo (${state.intent.greenfield.why.join('; ')}), so this WP also brings the repo up to the greenfield manifest. The land gate holds it, as an amendment, until \`bootstrap --offline\` exits 0 on your worktree with every file it reads committed.`, '',
    `The conductor added these manifest paths to this WP's Files, beyond the Files list in the WP spec; for them this section is the scope: ${files}.`, '',
    `Run \`node ${script} bootstrap --repo ${worktree} --write --offline\`, then finish by hand every item its report still lists under \`failing\` (a marker a file lacks, \`engines.node\`). Commit the files with this WP's work: an uncommitted or untracked manifest file fails the gate.`, '',
    `Repo settings (\`deleteBranchOnMerge\`, branch protection) are not yours, and the gate checks files only. Run \`node ${script} bootstrap --repo ${worktree}\` once (read-only: it adds the settings check) and put each \`gh repo edit\` fix its report prints under \`## Follow-ups\`.`,
    '',
  ].join('\n');
}

// The land gate's check, for the bootstrap WP only: the verb, offline, run on
// the lane's worktree. Exit 3 is the lane-fixable failure; any other non-zero
// exit is infrastructure. A pass counts only when every file the report read
// is committed at HEAD: the verb reads the working tree, and a file the lane
// wrote but never committed would pass here and never land (council review 1).
export function gateBootstrap(state, wp, exec) {
  if (!wp.bootstrap) return null;
  const script = join(state.pluginRoot, 'skills', 'conduct', 'scripts', 'conduct.mjs');
  const wt = wp.lane.worktree;
  const r = exec('node', [script, 'bootstrap', '--repo', wt, '--offline']);
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { report = null; }
  const unreadable = (why) => ({ failure: `bootstrap check unreadable: ${why}`, cause: 'infra' });
  if (r.code === 3 && Array.isArray(report?.failing)) return { failure: `bootstrap check fails: ${report.failing.join('; ')}`, cause: BOOTSTRAP_CAUSE };
  if (r.code !== 0 || !Array.isArray(report?.items)) return unreadable(`exit ${r.code}: ${String(r.stderr || r.stdout || '').trim().split(/\r?\n/)[0]}`);
  const read = [...new Set(report.items.flatMap((item) => String(item.found ?? '').split(', ').filter(Boolean)))];
  if (!read.length) return null;
  const status = exec('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=all', '--ignored', '--', ...read]);
  if (status.code !== 0) return unreadable(`git status exited ${status.code}: ${String(status.stderr ?? '').trim().split(/\r?\n/)[0]}`);
  const dirty = status.stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.slice(3));
  return dirty.length ? { failure: `bootstrap check passes only on files not committed at HEAD: ${dirty.join(', ')}`, cause: BOOTSTRAP_CAUSE } : null;
}

// The repo's name for `{{name}}`: origin's repository, else the checkout's
// directory. A lane worktree's directory is `<repo>-wt-<slug>-wp-01`, which
// must not become a README title (council review 1).
export function repoName(repo, exec) {
  const origin = exec('git', ['-C', repo, 'config', '--get', 'remote.origin.url']);
  const match = origin.code === 0 ? /([^/:\\]+?)(?:\.git)?\/?\s*$/.exec(origin.stdout.trim()) : null;
  return match?.[1] || basename(repo);
}

// `conduct.mjs bootstrap --repo <abs> [--write] [--offline]`: no run dir;
// prints one JSON object and exits 0 (all pass) or 3.
export function runBootstrapVerb(flags, deps) {
  if (typeof flags.repo !== 'string') throw new ConductError(2, 'bootstrap needs --repo <abs path to a git checkout>');
  const top = deps.exec('git', ['-C', flags.repo, 'rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) throw new ConductError(2, `${flags.repo} is not a git work tree`);
  const repo = top.stdout.trim();
  const user = deps.exec('git', ['-C', repo, 'config', 'user.name']);
  const values = { name: repoName(repo, deps.exec), year: String(new Date(deps.now()).getUTCFullYear()), owner: user.code === 0 && user.stdout.trim() ? user.stdout.trim() : '<owner>' };
  const report = bootstrap(repo, { write: flags.write === true, offline: flags.offline === true, deps, templates: repoTemplates(deps.pluginRoot), values });
  return { code: report.ok ? 0 : 3, report };
}
