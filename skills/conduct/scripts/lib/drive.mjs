// `conduct.mjs drive`: performs the run's mechanical actions and stops at the
// first one that needs the conductor. A `shell` argv is run as given, a `wait`
// is slept, and a template `author` is filled; each result is recorded
// through the record verb. Everything else (agent-tool, skill, touch,
// inspect, a judgment author, done) is a stop.
// conduct.mjs injects `pending`, `claim` and `record` (its own verbs, in
// process) and `runArgv` (lib/exec.mjs), and holds the run's drive lock
// around the loop.
// A shell runs once: a started marker is written before it runs and its
// result after, so a driver that dies between running and recording is
// recorded from the saved result, or stopped for the conductor, on restart.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const DRIVE_LOG = 'drive.log';
export const DRIVE_STARTED = 'drive-started.json';
export const DRIVE_RESULT = 'drive-result.json';
export const DEFAULT_MAX_STEPS = 200;
// A shell action that outlives this is stopped, not recorded: the conductor decides.
export const SHELL_TIMEOUT_MS = 30 * 60 * 1000;
export const BACKGROUND_TIMEOUT_MS = 3 * 60 * 60 * 1000;

// A template author is mechanical: its text is fully given by the action.
// The grant, rulings, amendments, the showcase brief and custody carry no
// template; the lane contract, a lane brief and a release bump do.
export function mechanicalAuthor(action) {
  return action.kind === 'author' && typeof action.template === 'string' && typeof action.outPath === 'string'
    && action.slots !== null && typeof action.slots === 'object' && !Array.isArray(action.slots);
}

// Each key of slots is replaced, as exact text, by its value; a null value
// deletes every line that holds the key. Other <…> placeholders stay, and the
// rest of the text is kept byte for byte (line endings too: a bump's record
// compares the file to its original).
export function fillTemplate(text, slots, append = null) {
  let lines = text.split(/(?<=\n)/);
  for (const [key, value] of Object.entries(slots)) {
    lines = value === null ? lines.filter((line) => !line.includes(key)) : lines.map((line) => line.split(key).join(String(value)));
  }
  return lines.join('') + (append ?? '');
}

// Why an action stops the drive, or null when the drive performs it.
export function stopReason(action) {
  if (!action || action.kind === 'done') return 'done';
  if (action.handBack) return 'hand-back';
  if (action.kind === 'shell') return Array.isArray(action.command) && action.command.length ? null : 'malformed-shell';
  // An announce wait tells the conductor to stop and show the operator a
  // touch; a wake wait, to end its turn until a lane's send or a heartbeat.
  if (action.kind === 'wait') return action.part === 'announce' || action.wake === true ? 'needs-conductor' : null;
  if (mechanicalAuthor(action)) return null;
  return 'needs-conductor';
}

const label = (action) => `${action.kind}/${action.step ?? '-'}/${action.part ?? '-'}`;

// What a shell's markers bind to besides its id: the argv, cwd and env it ran
// with. A pending id whose argv changed since (upgrade-root) is not the same run.
export function argvHash(action) {
  return createHash('sha256').update(JSON.stringify([action.command, action.cwd ?? null, action.env ?? null])).digest('hex').slice(0, 16);
}

// Written whole or not at all: a temp file renamed over the marker.
function writeMarker(deps, path, value) {
  const temp = `${path}.${deps.pid ?? 'drive'}.tmp`;
  deps.write(temp, JSON.stringify(value));
  deps.rename(temp, path);
}

function readMarker(deps, path) {
  if (!deps.exists(path)) return null;
  try {
    return JSON.parse(deps.read(path));
  } catch {
    return { unreadable: true };
  }
}

export async function drive({ runDir, maxSteps = DEFAULT_MAX_STEPS }, deps) {
  const log = (fields) => deps.append(join(runDir, DRIVE_LOG), `${fields.join(' ')}\n`);
  const performed = [];
  const finish = (code, out) => ({ code, out: { ...out, steps: performed.length, performed } });
  const startedPath = join(runDir, DRIVE_STARTED);
  const resultPath = join(runDir, DRIVE_RESULT);

  // The run's pending action, emitted when none is: the next verb's work,
  // except that a hand-back is never consumed and an open rotation is refused.
  const first = await deps.pending();
  if (first.code !== 0) {
    log([deps.timestamp(), '-', 'pending', `exit=${first.code}`, 'refused']);
    return finish(first.code, { ok: false, stopped: 'refused', refusal: first.out });
  }
  let action = first.out.action;

  for (;;) {
    const why = stopReason(action);
    if (why) {
      log([deps.timestamp(), action?.id ?? '-', action ? label(action) : 'done', `stop=${why}`]);
      return finish(0, { ok: true, stopped: why, action });
    }
    if (performed.length >= maxSteps) {
      log([deps.timestamp(), action.id, label(action), 'stop=max-steps']);
      return finish(0, { ok: true, stopped: 'max-steps', action });
    }
    // The run is still where the driver left it, and drive.lock names this
    // action: a conductor verb that moved it meanwhile stops the drive here.
    const claim = await deps.claim(action.id);
    if (claim.code !== 0) {
      log([deps.timestamp(), action.id, label(action), `exit=${claim.code}`, 'refused']);
      return finish(claim.code, { ok: false, stopped: 'refused', action, refusal: claim.out });
    }
    if (claim.out.found !== action.id) {
      log([deps.timestamp(), action.id, label(action), `stop=pending-moved found=${claim.out.found ?? '-'}`]);
      return finish(1, { ok: false, stopped: 'pending-moved', action, found: claim.out.found });
    }

    const startedAt = deps.timestamp();
    const t0 = deps.now();
    let result;
    let code = '-';
    let replayed = false;
    if (action.kind === 'shell') {
      const hash = argvHash(action);
      const saved = readMarker(deps, resultPath);
      const started = readMarker(deps, startedPath);
      if (saved?.id === action.id && saved.argvHash === hash) {
        // It ran and its result was saved, but the record never landed.
        result = saved.result;
        code = result?.code ?? '-';
        replayed = true;
      } else if (started && (started.unreadable || started.id === action.id)) {
        // It started and no result was saved: it may have done its work. Only
        // the conductor can say, so it is never run again from here.
        log([startedAt, action.id, label(action), 'stop=reconcile']);
        return finish(1, { ok: false, stopped: 'reconcile', action, marker: { path: startedPath, ...started } });
      } else {
        const [program, ...args] = action.command;
        const env = { ...deps.env, ...(action.env ?? {}) };
        // A Windows command shim (npm.cmd) cannot start without cmd.exe, and
        // drive does not guess at cmd.exe quoting: the conductor runs it.
        const shimStop = () => {
          log([startedAt, action.id, label(action), 'stop=needs-conductor', 'reason=windows-shim']);
          return finish(0, { ok: true, stopped: 'needs-conductor', reason: 'windows-shim', action });
        };
        if (deps.platform === 'win32' && deps.windowsShim(program, { env, cwd: action.cwd })) return shimStop();
        writeMarker(deps, startedPath, { id: action.id, argvHash: hash, startedAt, pid: deps.pid ?? null });
        const run = await deps.runArgv(program, args, {
          cwd: action.cwd, env, timeout: action.background ? BACKGROUND_TIMEOUT_MS : SHELL_TIMEOUT_MS,
        });
        if (run.spawnError) {
          // It never started: no marker holds the next drive, and no
          // synthetic exit code is recorded as its result.
          deps.remove(startedPath);
          const bare = !/[\\/]/.test(program);
          if (deps.platform === 'win32' && bare && ['ENOENT', 'EINVAL'].includes(run.spawnError)) return shimStop();
          log([startedAt, action.id, label(action), `stop=spawn-failed spawnError=${run.spawnError}`]);
          return finish(1, { ok: false, stopped: 'spawn-failed', action, spawnError: run.spawnError, stderr: run.stderr });
        }
        if (run.timedOut) {
          // Its process tree was killed; without proof the root is gone, the
          // stop says so. The started marker stays: the next drive reconciles.
          const verified = run.killVerified === true;
          log([startedAt, action.id, label(action), 'exit=timeout', `${((deps.now() - t0) / 1000).toFixed(1)}s`, ...(verified ? [] : ['unverified'])]);
          return finish(1, { ok: false, stopped: verified ? 'shell-timeout' : 'timeout-unverified', action, stdout: run.stdout, stderr: run.stderr });
        }
        result = { code: run.code, stdout: run.stdout, stderr: run.stderr };
        code = run.code;
        writeMarker(deps, resultPath, { id: action.id, argvHash: hash, finishedAt: deps.timestamp(), result });
      }
    } else if (action.kind === 'wait') {
      await deps.sleep(action.waitMs ?? 0);
      result = {};
    } else {
      try {
        deps.write(action.outPath, fillTemplate(deps.read(action.template), action.slots, action.append ?? null));
      } catch (error) {
        log([startedAt, action.id, label(action), 'exit=-', 'author-failed']);
        return finish(1, { ok: false, stopped: 'author-failed', action, error: error.message });
      }
      result = {};
    }
    const seconds = `${((deps.now() - t0) / 1000).toFixed(1)}s`;

    // A shell's result is saved before it is recorded (above), so a failed
    // record is replayed from the file, never by running the command again.
    const recorded = await deps.record(action.id, result);
    log([startedAt, action.id, label(action), `exit=${code}`, seconds, ...(replayed ? ['replayed'] : []), ...(recorded.code !== 0 ? [`record=${recorded.code}`] : [])]);
    performed.push({ id: action.id, kind: action.kind, step: action.step ?? null, part: action.part ?? null, ...(action.kind === 'shell' ? { code } : {}), ...(replayed ? { replayed } : {}) });
    if (recorded.code !== 0) {
      // With `recorded`, the record landed and a later step failed: `next` gets
      // the next action. Without it, nothing was recorded and the action is
      // pending; a shell's saved result stays for the conductor to read.
      return finish(recorded.code, {
        ok: false, stopped: recorded.out?.recorded ? 'after-record' : 'record-failed', action, record: recorded.out,
        ...(action.kind === 'shell' && !recorded.out?.recorded ? { saved: resultPath } : {}),
      });
    }
    if (action.kind === 'shell') {
      deps.remove(resultPath);
      deps.remove(startedPath);
    }
    action = recorded.out.action;
  }
}
