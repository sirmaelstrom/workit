// conduct bootstrap: check a repo against the greenfield manifest
// (reference/templates/repo/manifest.json, quest 977d3efb) and, with --write,
// copy a template for every missing file. Existing files are never rewritten.
// A file that exists but lacks a required marker is reported, not repaired.
//
// The verdict is the exit code: 0 when every applicable item and setting
// passes, 3 when anything is missing, incomplete or unverified, 2 on usage.
// A setting that cannot be read is `unverified`, never a pass. `--offline`
// skips settings and says so in the output.
import { dirname, join, basename, sep } from 'node:path';
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

export function fillTemplate(text, values) {
  return text.replace(/\{\{(name|year|owner|nodeVersionFile)\}\}/g, (_, key) => values[key]);
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

// `conduct.mjs bootstrap --repo <abs> [--write] [--offline]`: no run dir;
// prints one JSON object and exits 0 (all pass) or 3.
export function runBootstrapVerb(flags, deps) {
  if (typeof flags.repo !== 'string') throw new ConductError(2, 'bootstrap needs --repo <abs path to a git checkout>');
  const top = deps.exec('git', ['-C', flags.repo, 'rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) throw new ConductError(2, `${flags.repo} is not a git work tree`);
  const repo = top.stdout.trim();
  const user = deps.exec('git', ['-C', repo, 'config', 'user.name']);
  const values = { name: basename(repo), year: String(new Date(deps.now()).getUTCFullYear()), owner: user.code === 0 && user.stdout.trim() ? user.stdout.trim() : '<owner>' };
  const report = bootstrap(repo, { write: flags.write === true, offline: flags.offline === true, deps, templates: repoTemplates(deps.pluginRoot), values });
  return { code: report.ok ? 0 : 3, report };
}
