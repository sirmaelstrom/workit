import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  createReviewWorktree,
  REVIEW_REMOTE_BASE_DEFAULT,
  reviewRemoteBase,
} from './pr-review-worktree.mjs';

const REPO = 'review-owner/review-repo';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';

function recordingRun(headSha = HEAD) {
  const calls = [];
  return {
    calls,
    run(program, args) {
      calls.push({ program, args: [...args] });
      return args.includes('rev-parse') ? `${headSha}\n` : '';
    },
  };
}

function remoteCalls(calls) {
  return calls.filter(({ args }) => args.includes('remote') || args.includes('fetch'));
}

function remoteArguments(calls) {
  return remoteCalls(calls).map(({ args }) => args.includes('fetch') ? args.at(-2) : args.at(-1));
}

test('R1: default remote base is GitHub without executing git', () => {
  const { calls, run } = recordingRun();
  const checkout = createReviewWorktree({ repo: REPO, headSha: HEAD, run, diag: () => {}, env: {} });
  try {
    const expected = `${REVIEW_REMOTE_BASE_DEFAULT}/${REPO}.git`;
    assert.equal(reviewRemoteBase({}), REVIEW_REMOTE_BASE_DEFAULT);
    assert.deepEqual(remoteArguments(calls), [expected, expected]);
    assert.ok(calls.every(({ program }) => program === GIT), 'the fake run recorded requests but executed nothing');
  } finally {
    checkout.cleanup();
  }
});

test('R2: override trims the trailing slash for both git remote calls', () => {
  const { calls, run } = recordingRun();
  const checkout = createReviewWorktree({
    repo: REPO,
    headSha: HEAD,
    run,
    diag: () => {},
    env: { PR_REVIEW_REMOTE_BASE: 'https://mirror.example/' },
  });
  try {
    const recorded = remoteCalls(calls).flatMap(({ args }) => args);
    assert.deepEqual(remoteArguments(calls), [
      'https://mirror.example/review-owner/review-repo.git',
      'https://mirror.example/review-owner/review-repo.git',
    ]);
    assert.equal(recorded.some((arg) => arg.includes('github.com')), false);
  } finally {
    checkout.cleanup();
  }
});

test('R3: a local bare repository supplies a real pinned checkout', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'review-worktree-r3-'));
  const source = join(fixtureRoot, 'source');
  const bare = join(fixtureRoot, 'review-owner', 'review-repo.git');
  const calls = [];
  const run = (program, args, options = {}) => {
    calls.push({ program, args: [...args] });
    return execFileSync(program, args, { cwd: options.cwd, encoding: 'utf8' });
  };
  try {
    execFileSync(GIT, ['init', source], { encoding: 'utf8' });
    execFileSync(GIT, ['-C', source, 'config', 'user.name', 'Review test'], { encoding: 'utf8' });
    execFileSync(GIT, ['-C', source, 'config', 'user.email', 'review@example.invalid'], { encoding: 'utf8' });
    writeFileSync(join(source, 'README.md'), 'pinned\n', 'utf8');
    execFileSync(GIT, ['-C', source, 'add', '.'], { encoding: 'utf8' });
    execFileSync(GIT, ['-C', source, 'commit', '-m', 'pinned'], { encoding: 'utf8' });
    const headSha = execFileSync(GIT, ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    mkdirSync(dirname(bare), { recursive: true });
    execFileSync(GIT, ['clone', '--bare', source, bare], { encoding: 'utf8' });

    const checkout = createReviewWorktree({ repo: REPO, headSha, run, diag: () => {}, env: { PR_REVIEW_REMOTE_BASE: fixtureRoot } });
    const checkoutRoot = dirname(checkout.cwd);
    try {
      assert.equal(execFileSync(GIT, ['-C', checkout.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), headSha);
      checkout.assertHead();
    } finally {
      checkout.cleanup();
    }
    assert.equal(existsSync(checkoutRoot), false, 'cleanup removes the mkdtemp root');
    assert.equal(calls.flatMap(({ args }) => args).some((arg) => arg.includes('github.com')), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('R4: an empty local base fails without falling back to GitHub', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'review-worktree-r4-'));
  const calls = [];
  const run = (program, args, options = {}) => {
    calls.push({ program, args: [...args] });
    return execFileSync(program, args, { cwd: options.cwd, encoding: 'utf8' });
  };
  try {
    assert.throws(() => createReviewWorktree({ repo: REPO, headSha: HEAD, run, diag: () => {}, env: { PR_REVIEW_REMOTE_BASE: fixtureRoot } }));
    const createdRoot = dirname(calls.find(({ args }) => args[0] === 'init' && args[1] === '--bare').args.at(-1));
    const fetchArgs = calls.find(({ args }) => args.includes('fetch')).args;
    assert.equal(existsSync(createdRoot), false, 'the failed checkout is cleaned up');
    assert.ok(fetchArgs.includes(`${fixtureRoot}/${REPO}.git`));
    assert.equal(calls.flatMap(({ args }) => args).some((arg) => arg.includes('github.com')), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
