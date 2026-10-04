// The scheduler: which WPs a deep spec has, what each one writes, and which
// may start now. A WP's file set is read only under the orchestrator's Files
// field rule; a WP with no parsed files conflicts with every other WP.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConductError } from './state.mjs';

// Nothing else holds a lane slot (D12).
export const LIVE_STATES = Object.freeze(['dispatched', 'pr', 'review', 'amending', 'gate']);

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
// that begins with a field label.
export function parseFiles(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('**Files:**'));
  if (start < 0) return [];
  const files = [];
  for (const line of lines.slice(start + 1)) {
    if (FIELD_LABEL.test(line)) break;
    if (!/^- (Create|Modify) /.test(line)) continue;
    const token = /`([^`]+)`/.exec(line);
    if (token) files.push(...expandBraces(token[1].trim()));
  }
  return files;
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
    const model = modelAt < 0 ? '' : (cells[modelAt] ?? '');
    byId.set(id[1], { name: id[2], model: model === '' || model === '-' ? 'opus' : model });
  }
  return byId;
}

function waves(orchestrator) {
  const byId = new Map();
  for (const line of section(orchestrator, 'Wave Plan')) {
    const match = /^Wave (\d+):(.*)$/.exec(line.trim());
    if (match) for (const id of match[2].match(WP_ID) ?? []) byId.set(id, Number(match[1]));
  }
  return byId;
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
    const tier = /\*\*Review tier:\*\*\s*(T\d)\b/.exec(text);
    return {
      id, name: rows.get(id)?.name || heading[2].trim(), specPath, wave: waveOf.get(id), files: parseFiles(text),
      precondition: fieldText(lines, 'Precondition') ?? '', tier: tier ? tier[1] : 'T1',
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

const normalize = (path) => path.replace(/\\/g, '/').replace(/^\.\//, '');

// Fail safe (D18): an empty set conflicts with everything.
export function filesDisjoint(a, b) {
  if (!a?.length || !b?.length) return false;
  const left = a.map(normalize);
  const right = b.map(normalize);
  const contains = (dir, path) => dir.endsWith('/') && path.startsWith(dir);
  return !left.some((x) => right.some((y) => x === y || contains(x, y) || contains(y, x)));
}

// The pending WPs that may start now, in id order, within the lane cap.
export function dispatchable(state) {
  if (state.dispatchHalt) return [];
  const wps = state.wps ?? [];
  const running = wps.filter((wp) => LIVE_STATES.includes(wp.state));
  const merged = new Set(wps.filter((wp) => wp.state === 'merged').map((wp) => wp.id));
  const picked = [];
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const wp of wps.filter((candidate) => candidate.state === 'pending').sort(byId)) {
    if (running.length + picked.length >= (state.intent?.lanesCap ?? 1)) break;
    if (!(wp.dependsOn ?? []).every((id) => merged.has(id))) continue;
    if ([...running, ...picked].every((other) => filesDisjoint(wp.files, other.files))) picked.push(wp);
  }
  return picked;
}
