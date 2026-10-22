// Whether a failed gate command failed on the host rather than on the code: a
// suite whose every failure is a timeout (a loaded host runs everything
// slower), and a probe of whether the host is quiet enough to run it again.
//
// The classifier reads the failure listing a runner prints after its run:
// node:test's spec reporter (`✖ failing tests:`) and vitest's default reporter
// (`Failed Tests N` / `Failed Suites N`). Output it can't read in full, from
// another runner or reporter, cut short, or holding both runners' listings,
// is not classified, so the failure stays the lane's to fix.
import { cpus } from 'node:os';

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

const NODE_LISTING = '✖ failing tests:';
const NODE_TIMEOUT = /^'test timed out after \d+ms'$/;
// A parent's timeout cancels the children still running under it.
const NODE_CANCELLED = /^'test did not finish before its parent and was cancelled'$/;
// A suite listed because a child failed: the child's own entry decides.
const NODE_SUBTESTS = /^'\d+ subtests? failed'$/;
const NODE_SUMMARY = /^ℹ (?:fail|cancelled) \d+$/;
const NODE_DURATION = / \(\d+(?:\.\d+)?ms\)$/;

const VITEST_HEADER = /^⎯+ Failed (?:Tests|Suites) (\d+) ⎯+$/;
// Each listed failure ends with `[n/N]`: N is every failure of the run.
const VITEST_FOOTER = /\[(\d+)\/(\d+)\]⎯*$/;
const VITEST_ENTRY = /^ FAIL {2}\S/;
const VITEST_TIMEOUT = /^Error: (?:Test|Hook) timed out in \d+ms\.$/;
const VITEST_UNHANDLED = /^⎯+ Unhandled (?:Errors?|Rejections?) ⎯+$|^\s*Errors\s+\d+ errors?\b/;

const textLines = (text) => String(text ?? '').replace(ANSI, '').split(/\r?\n/);

function nodeListing(all) {
  const start = all.findIndex((line) => line.trim() === NODE_LISTING);
  if (start < 0) return null;
  // The summary is printed once the run ends: without it the run did not
  // finish. Its counts include parents the listing leaves out, so they do not
  // bound the listing.
  const progress = all.slice(0, start);
  if (progress.filter((line) => NODE_SUMMARY.test(line.trim())).length < 2) return null;
  const entries = [];
  const listed = new Map();
  const body = all.slice(start + 1);
  for (let i = 0; i < body.length; i += 1) {
    if (!/^test at \S/.test(body[i])) continue;
    const error = body.slice(i + 2).find((line) => line.trim())?.trim() ?? '';
    if (!/^✖ /.test(body[i + 1] ?? '') || !error) return null;
    entries.push(error);
    const name = body[i + 1].slice(2).replace(NODE_DURATION, '');
    listed.set(name, (listed.get(name) ?? 0) + 1);
  }
  // Every failed leaf the run printed (a `✖` line no `▶` opened at its
  // indent) has its own entry, so a listing cut between entries is caught.
  const opened = new Set();
  for (const line of progress) {
    const m = /^(\s*)([▶✖]) (.+)$/.exec(line);
    if (!m) continue;
    const name = m[3].replace(NODE_DURATION, '');
    if (m[2] === '▶') opened.add(`${m[1]}${name}`);
    else if (!opened.has(`${m[1]}${name}`)) {
      if (!listed.get(name)) return null;
      listed.set(name, listed.get(name) - 1);
    }
  }
  const counted = entries.filter((error) => !NODE_SUBTESTS.test(error));
  const timeouts = counted.filter((error) => NODE_TIMEOUT.test(error)).length;
  const cancelled = counted.filter((error) => NODE_CANCELLED.test(error)).length;
  return { runner: 'node', failures: entries.length, timeouts, other: counted.length - timeouts - cancelled };
}

function vitestListing(all) {
  let headed = 0;
  let total = null;
  let last = 0;
  let listing = false;
  const errors = [];
  for (let i = 0; i < all.length; i += 1) {
    // An error outside any test is not a timeout the listing can show.
    if (VITEST_UNHANDLED.test(all[i])) return null;
    const header = VITEST_HEADER.exec(all[i]);
    const footer = listing ? VITEST_FOOTER.exec(all[i]) : null;
    if (header) {
      headed += Number(header[1]);
      listing = true;
    } else if (footer) {
      total = Math.max(total ?? 0, Number(footer[2]));
      last = Math.max(last, Number(footer[1]));
    } else if (listing && VITEST_ENTRY.test(all[i])) {
      errors.push(all.slice(i + 1).find((line) => line.trim())?.trim() ?? '');
    }
  }
  // The `[N/N]` footer closes the listing: without it the read was cut.
  if (!listing || errors.length !== headed || errors.length !== total || last !== total) return null;
  const timeouts = errors.filter((error) => VITEST_TIMEOUT.test(error)).length;
  return { runner: 'vitest', failures: errors.length, timeouts, other: errors.length - timeouts };
}

/**
 * The failure listing of a gate command's output, or null when no runner's
 * listing is there in full. `allTimeout` holds when at least one failure is a
 * timeout and none is anything else (a child its parent's timeout cancelled
 * counts with the timeout).
 */
export function gateFailureKind(stdout, stderr) {
  const all = [...textLines(stdout), ...textLines(stderr)];
  const vitest = vitestListing(all), node = nodeListing(all);
  // Two runners' listings in one output: neither one accounts for every failure.
  if (vitest && node) return null;
  const found = vitest ?? node;
  if (!found || found.failures === 0) return null;
  return { ...found, allTimeout: found.timeouts > 0 && found.other === 0 };
}

// ---- the quiet-host probe (`conduct.mjs quiet`) ----

export const QUIET_DEFAULTS = Object.freeze({ samples: 3, intervalMs: 60000, maxBusy: 30 });

const cpuTotals = (list) => list.reduce((sum, cpu) => {
  const { user, nice, sys, idle, irq } = cpu.times;
  return { busy: sum.busy + user + nice + sys + irq, all: sum.all + user + nice + sys + idle + irq };
}, { busy: 0, all: 0 });

/**
 * Busy CPU, in percent of every core, over `samples` intervals of
 * `intervalMs`. Quiet when every interval is under `maxBusy`. Node reports
 * per-core times on Windows and Linux alike, so this runs on both.
 */
export async function quietProbe({ samples = QUIET_DEFAULTS.samples, intervalMs = QUIET_DEFAULTS.intervalMs, maxBusy = QUIET_DEFAULTS.maxBusy } = {}, deps = {}) {
  const read = deps.cpus ?? cpus;
  const sleep = deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const busy = [];
  let before = cpuTotals(read());
  for (let n = 0; n < samples; n += 1) {
    await sleep(intervalMs);
    const after = cpuTotals(read());
    const all = after.all - before.all;
    busy.push(all > 0 ? Math.round(((after.busy - before.busy) / all) * 100) : 0);
    before = after;
  }
  return { quiet: busy.every((pct) => pct < maxBusy), busy, maxBusy, intervalMs };
}
