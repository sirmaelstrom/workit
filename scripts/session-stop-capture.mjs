#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function sessionId(payload) {
  return payload?.session_id ?? payload?.sessionId ?? payload?.session?.id ?? null;
}

export function runStopCapture(payload, overrides = {}) {
  const deps = { exists: existsSync, read: (path) => readFileSync(path, 'utf8'), write: (path, value) => writeFileSync(path, value, 'utf8'), remove: (path) => rmSync(path, { force: true }), mkdir: (path) => mkdirSync(path, { recursive: true }), env: process.env, ...overrides };
  const id = sessionId(payload);
  if (!id) return { captured: false };
  const root = deps.env.WORKIT_SESSION_CHAIN_DIR ?? join(deps.env.HOME ?? deps.env.USERPROFILE ?? '.', '.workit', 'session-chain');
  const marker = join(root, 'final-pending', id);
  if (!deps.exists(marker)) return { captured: false };
  const final = join(root, 'final', `${id}.md`);
  deps.mkdir(dirname(final));
  deps.write(final, String(payload.last_assistant_message ?? ''));
  deps.remove(marker);
  return { captured: true, path: final };
}

async function main() {
  let raw = '';
  for await (const part of process.stdin) raw += part;
  try { runStopCapture(JSON.parse(raw)); } catch { /* Hooks must never make Stop fail. */ }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
