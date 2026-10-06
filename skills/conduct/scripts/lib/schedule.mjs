// The scheduler: which WPs a deep spec has, what each one writes, and which
// may start now. A WP's file set is read only under the orchestrator's Files
// field rule; a WP with no parsed files conflicts with every other WP.
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { LANE_MODELS, laneModel } from './adapters.mjs';
import { ConductError } from './state.mjs';

// These states hold a lane slot (D12). So does a lane whose process has not
// been observed to exit, whatever its WP's state (laneOccupied).
export const LIVE_STATES = Object.freeze(['dispatched', 'pr', 'review', 'amending', 'gate']);

export const laneOccupied = (wp) => Boolean(wp.lane?.startedAt) && !wp.lane?.exitedAt;

const FIELD_LABEL = /^\*\*[^*\n]+:\*\*/;
const WP_ID = /\bWP-\d+\b/g;

// The lines of one level-2 section, without its heading.
function section(text, title) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

// `a/{b,c}.mjs` → `a/b.mjs`, `a/c.mjs`, in order; groups may repeat.
function expandBraces(token) {
  const match = /\{([^{}]*)\}/.exec(token);
  if (!match) return [token];
  return match[1].split(',').flatMap((alt) => expandBraces(token.slice(0, match.index) + alt + token.slice(match.index + match[0].length)));
}

// The value of a `**<Field>:**` label: its own line's text, plus the lines
// after it up to the next field label or heading.
function fieldText(lines, field) {
  const start = lines.findIndex((line) => line.startsWith(`**${field}:**`));
  if (start < 0) return null;
  const body = [lines[start].slice(field.length + 5)];
  for (const line of lines.slice(start + 1)) {
    if (FIELD_LABEL.test(line) || /^#/.test(line)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

// The Files field rule: bullets under `**Files:**` that begin `- Create ` or
// `- Modify `, first backticked token each; the list ends at the next line
// that begins with a field label. Each path is repository-relative, posix,
// with `.` and `..` resolved; one that leaves the repository is refused.
export function parseFiles(text, where = 'Files') {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('**Files:**'));
  if (start < 0) return [];
  const files = [];
  for (const line of lines.slice(start + 1)) {
    if (FIELD_LABEL.test(line)) break;
    if (!/^- (Create|Modify) /.test(line)) continue;
    const token = /`([^`]+)`/.exec(line);
    if (token) files.push(...expandBraces(token[1].trim()).map((path) => repoPath(path, where)));
  }
  return files;
}

// `a\b/../c/` → `a/c/`; null when the path is absolute, drive-qualified
// (`C:x`, `C:../x`) or leaves the repo. Trailing dots and spaces are dropped
// from each segment, as Windows does (`a.mjs.` is `a.mjs`). Containment is checked
// after normalization: `.../x` becomes `/x`, which is absolute, so it is refused too.
export function normalizePath(path) {
  const slashed = String(path).replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(slashed) || slashed.startsWith('/')) return null;
  const segments = slashed.split('/').map((segment) => (segment === '.' || segment === '..' ? segment : segment.replace(/[. ]+$/, '')));
  const normal = posix.normalize(segments.join('/'));
  return normal === '..' || normal.startsWith('../') || normal.startsWith('/') || normal === '.' || normal === './' ? null : normal;
}

function repoPath(path, where) {
  const normal = normalizePath(path);
  if (normal === null) throw new ConductError(2, `${where}: \`${path}\` is not a path inside the repository`);
  return normal;
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

// Inventory rows by WP id: { name, model }. The Model column is optional.
function inventory(orchestrator) {
  const rows = section(orchestrator, 'Package Inventory').filter((line) => line.trim().startsWith('|'));
  if (rows.length < 2) return new Map();
  const header = tableCells(rows[0]).map((cell) => cell.toLowerCase());
  const modelAt = header.indexOf('model');
  const byId = new Map();
  for (const row of rows.slice(2)) {
    const cells = tableCells(row);
    const id = /^(WP-\d+)\s*:?\s*(.*)$/.exec(cells[0] ?? '');
    if (!id) continue;
    const raw = modelAt < 0 ? '' : (cells[modelAt] ?? '');
    const model = raw === '' || raw === '-' ? 'opus' : raw;
    // An unknown label fails here, at parse, never at emission.
    for (const agent of Object.keys(LANE_MODELS)) {
      try {
        laneModel(agent, model);
      } catch (error) {
        throw new ConductError(2, `${id[1]}: the inventory's Model "${raw}" is not a lane model label (${error.message})`);
      }
    }
    byId.set(id[1], { name: id[2], model });
  }
  return byId;
}

// The top-level `[…]` entries of a line; brackets nested in a name stay inside.
function topLevelEntries(text) {
  const entries = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '[' && depth++ === 0) start = i + 1;
    else if (text[i] === ']' && depth > 0 && --depth === 0) entries.push(text.slice(start, i));
  }
  return entries;
}

// `Wave N: [WP-01: name] [WP-02: name]`: a WP is the id opening a top-level
// entry, never an id inside a name. A WP in two waves is a parse error.
function waves(orchestrator) {
  const byId = new Map();
  for (const line of section(orchestrator, 'Wave Plan')) {
    const match = /^Wave (\d+):(.*)$/.exec(line.trim());
    for (const entry of match ? topLevelEntries(match[2]) : []) {
      const id = /^\s*(WP-\d+)\b/.exec(entry)?.[1];
      if (!id) continue;
      if (byId.has(id)) throw new ConductError(2, `${id} is in two waves of the orchestrator's ## Wave Plan (${byId.get(id)} and ${match[1]})`);
      byId.set(id, Number(match[1]));
    }
  }
  return byId;
}

// A WP's tier: what it declares, not what it quotes. Fenced blocks, `>` lines and inline
// code spans are dropped first (skills/spec-validate/scripts/validate.mjs does the same):
// a fence closes only on the same character with a run at least as long as its opener, a
// span is delimited by equal-length backtick runs, and a span that is the label's own value
// (**Review tier:** `T2`) is the value. The value is the first token after the label and must
// be T0, T1 or T2. No declaration is T1; a value outside the three, or two different values,
// is a parse error.
function reviewTier(text, where) {
  let fence = null;
  const prose = text.split(/\r?\n/).filter((line) => {
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.len) fence = null;
      return false;
    }
    const open = /^\s*(?:(`{3,})[^`]*|(~{3,}).*)$/.exec(line);
    if (open) { fence = { char: (open[1] ?? open[2])[0], len: (open[1] ?? open[2]).length }; return false; }
    return !/^\s*>/.test(line);
  }).map((line) => line
    .replace(/(\*\*Review tier:\*\*\s*)(`+)\s*([^`\s]+)\s*\2(?!`)/g, '$1$3')
    .replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, '')).join('\n');
  const values = new Set([...prose.matchAll(/\*\*Review tier:\*\*\s*(\S*)/g)].map((match) => match[1].replace(/[,;.]$/, '')));
  const bad = [...values].find((value) => !/^T[012]$/.test(value));
  if (bad !== undefined) throw new ConductError(2, `${where}: **Review tier:** value "${bad}" is not T0, T1 or T2`);
  if (values.size > 1) throw new ConductError(2, `${where}: conflicting **Review tier:** declarations (${[...values].join(', ')})`);
  return values.size ? [...values][0] : 'T1';
}

export function parseWorkPackages(workshopDir, { read = (path) => readFileSync(path, 'utf8'), list = readdirSync } = {}) {
  const dir = join(workshopDir, 'work-packages');
  const orchestrator = read(join(dir, '_orchestrator.md'));
  const waveOf = waves(orchestrator);
  const rows = inventory(orchestrator);
  const wps = list(dir).filter((name) => /^wp-.*\.md$/i.test(name)).sort().map((name) => {
    const specPath = join(dir, name);
    const text = read(specPath);
    const lines = text.split(/\r?\n/);
    const heading = /^#\s+(WP-\d+):\s*(.*)$/m.exec(text);
    if (!heading) throw new ConductError(2, `${specPath} has no "# WP-<n>: <name>" heading`);
    const id = heading[1];
    if (!waveOf.has(id)) throw new ConductError(2, `${id} is not in the orchestrator's ## Wave Plan`);
    const tier = reviewTier(text, id);
    return {
      id, name: rows.get(id)?.name || heading[2].trim(), specPath, wave: waveOf.get(id), files: parseFiles(text, id),
      precondition: fieldText(lines, 'Precondition') ?? '', verification: fieldText(lines, 'Verification'), tier,
      model: rows.get(id)?.model ?? 'opus', runtimeExercise: fieldText(lines, 'Runtime exercise') ?? '',
    };
  });
  // dependsOn: the ids the Precondition names from earlier waves, union the
  // whole immediately preceding wave.
  return wps.map((wp) => {
    const named = (wp.precondition.match(WP_ID) ?? []).filter((id) => waveOf.has(id) && waveOf.get(id) < wp.wave);
    const previous = wps.filter((other) => other.wave === wp.wave - 1).map((other) => other.id);
    return { ...wp, dependsOn: [...new Set([...named, ...previous])].sort() };
  });
}

// Fail safe (D18): an empty set conflicts with everything, and so does a path
// that leaves the repository. Paths compare normalized and case-folded: a
// false conflict only serializes two WPs, a false disjoint corrupts a merge.
export function filesDisjoint(a, b) {
  if (!a?.length || !b?.length) return false;
  const fold = (paths) => paths.map((path) => normalizePath(path)?.toLowerCase() ?? null);
  const left = fold(a);
  const right = fold(b);
  if (left.includes(null) || right.includes(null)) return false;
  // A path conflicts with itself and with anything under it, slash or not:
  // `src/lib` may be a directory.
  const bare = (path) => path.replace(/\/$/, '');
  const overlaps = (x, y) => x === y || y.startsWith(`${x}/`);
  return !left.map(bare).some((x) => right.map(bare).some((y) => overlaps(x, y) || overlaps(y, x)));
}

// The pending WPs that may start now, in id order, within the lane cap. A WP
// whose admission was refused waits until its `notBefore`.
export function dispatchable(state, { now = Date.now() } = {}) {
  if (state.dispatchHalt) return [];
  const wps = state.wps ?? [];
  const running = wps.filter((wp) => LIVE_STATES.includes(wp.state) || laneOccupied(wp));
  const merged = new Set(wps.filter((wp) => wp.state === 'merged').map((wp) => wp.id));
  const picked = [];
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const ready = (wp) => !wp.notBefore || Date.parse(wp.notBefore) <= now;
  for (const wp of wps.filter((candidate) => candidate.state === 'pending' && ready(candidate) && !laneOccupied(candidate)).sort(byId)) {
    if (running.length + picked.length >= (state.intent?.lanesCap ?? 1)) break;
    if (!(wp.dependsOn ?? []).every((id) => merged.has(id))) continue;
    if ([...running, ...picked].every((other) => filesDisjoint(wp.files, other.files))) picked.push(wp);
  }
  return picked;
}
