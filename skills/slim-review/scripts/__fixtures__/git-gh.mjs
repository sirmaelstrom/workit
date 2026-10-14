/**
 * A `gh` runner backed by a local git repository, for the round tests: it
 * answers the GET reads the rounds module makes (`pulls/<n>`, `compare/A...B`
 * as JSON, and a commit or compare as a diff) the way GitHub's REST API does,
 * from the repository's own objects. Anything else throws.
 */
import { execFileSync } from 'node:child_process';

export function git(dir, args, input) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
  });
}

const isAncestor = (dir, a, b) => {
  try { git(dir, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
};

function comparePayload(dir, a, b) {
  const from = git(dir, ['rev-parse', `${a}^{commit}`]).trim();
  const to = git(dir, ['rev-parse', `${b}^{commit}`]).trim();
  let status;
  if (from === to) status = 'identical';
  else if (isAncestor(dir, from, to)) status = 'ahead';
  else if (isAncestor(dir, to, from)) status = 'behind';
  else status = 'diverged';
  const mb = git(dir, ['merge-base', from, to]).trim();
  const shas = git(dir, ['rev-list', '--reverse', '--topo-order', `${mb}..${to}`]).split('\n').filter(Boolean);
  const behind = git(dir, ['rev-list', '--count', `${mb}..${from}`]).trim();
  const commits = shas.map((sha) => ({
    sha,
    parents: git(dir, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1).map((p) => ({ sha: p })),
    commit: { message: git(dir, ['log', '-1', '--format=%B', sha]).trim() },
  }));
  const files = git(dir, ['diff', '--name-only', mb, to]).split('\n').filter(Boolean).map((filename) => ({ filename }));
  return { status, ahead_by: shas.length, behind_by: Number(behind), total_commits: shas.length, commits, files, merge_base_commit: { sha: mb } };
}

/** `runGh(args)` over the repository at `dir`; the PR's base ref is `base`. Records every call. */
export function gitBackedGh(dir, { base = 'main', repo = 'o/r', pr = 1 } = {}) {
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    const accept = args[1] === '-H' ? args[2] : null;
    const diffAccept = accept === 'Accept: application/vnd.github.diff';
    const path = accept ? args[3] : args[1];
    if (args[0] !== 'api' || typeof path !== 'string') throw new Error(`unexpected gh call: ${args.join(' ')}`);
    if (!path.startsWith(`repos/${repo}/`)) throw new Error(`unexpected repo: ${path}`);
    const rest = path.slice(`repos/${repo}/`.length);
    if (!diffAccept && rest === `pulls/${pr}`) return JSON.stringify({ number: pr, base: { ref: base } });
    const compare = /^compare\/(.+)\.\.\.([^.]+)$/.exec(rest);
    if (compare) return diffAccept ? git(dir, ['diff', `${compare[1]}...${compare[2]}`]) : JSON.stringify(comparePayload(dir, compare[1], compare[2]));
    const contents = /^contents\/(.+)\?ref=([0-9a-f]{7,40})$/.exec(rest);
    if (contents && accept === 'Accept: application/vnd.github.raw') {
      return git(dir, ['show', `${contents[2]}:${contents[1].split('/').map(decodeURIComponent).join('/')}`]);
    }
    const commit = /^commits\/([0-9a-f]{7,40})$/.exec(rest);
    if (commit && diffAccept) return git(dir, ['diff', `${commit[1]}^`, commit[1]]);
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { runGh, calls };
}
