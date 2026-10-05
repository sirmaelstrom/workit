// Agent CLIs and adapters. Agents (claude, codex) are probed into
// state.agents; adapters replace a core mechanism when present. herdr, notify,
// spend and answer are probed; spine, council, kb and verify are declared by
// the agent, because a script cannot see MCP tools.
import { isAbsolute } from 'node:path';
import { resolveProgram } from './exec.mjs';
import { ANSWER_ENV, parseAnswerCommand } from './answer.mjs';

export const AGENTS = Object.freeze(['claude', 'codex']);
export const PROBED_ADAPTERS = Object.freeze(['herdr', 'notify', 'spend', 'answer']);
export const DECLARED_ADAPTERS = Object.freeze(['spine', 'council', 'kb', 'verify']);
export const ADAPTERS = Object.freeze([...PROBED_ADAPTERS, ...DECLARED_ADAPTERS]);

// The one place model ids live in the skill.
export const LANE_MODELS = Object.freeze({
  claude: Object.freeze({ opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' }),
  codex: Object.freeze({ opus: 'gpt-6.1-sol', sonnet: 'gpt-6.1-sol' }),
});

export function laneModel(agent, label) {
  if (!Object.hasOwn(LANE_MODELS, agent)) throw new Error(`unknown lane agent: ${agent}`);
  const raw = label == null ? '' : String(label).trim();
  if (raw.startsWith('claude-') || raw.startsWith('gpt-')) return raw;
  const key = raw === '' || raw === '-' ? 'opus' : raw.toLowerCase();
  if (!Object.hasOwn(LANE_MODELS[agent], key)) throw new Error(`unknown lane model label for ${agent}: ${label}`);
  return LANE_MODELS[agent][key];
}

export function firstLine(text) {
  return String(text ?? '').trim().split(/\r?\n/)[0] ?? '';
}

function probeVersion(exec, program) {
  const result = exec(program, ['--version']);
  return result.code === 0
    ? { on: true, evidence: 'probed', detail: firstLine(result.stdout) || `${program} --version exit 0` }
    : { on: false, evidence: 'probed', detail: firstLine(result.stderr) || `${program} --version exit ${result.code}` };
}

function probeAgents({ exec, platform, resolveCodex }) {
  const agents = { claude: probeVersion(exec, 'claude') };
  let codex;
  try {
    codex = resolveProgram('codex', { platform, resolveCodex });
  } catch (error) {
    agents.codex = { on: false, evidence: 'probed', detail: error.message };
    return agents;
  }
  agents.codex = probeVersion(exec, codex);
  return agents;
}

// Whether a program resolves, looked up without running it: an absolute path
// must exist; a bare name goes through `where` (win32) or `command -v`.
function resolves(program, { exec, exists, platform }) {
  if (isAbsolute(program)) return { ok: exists(program), how: `${program} ${exists(program) ? 'exists' : 'does not exist'}` };
  const result = platform === 'win32' ? exec('where', [program]) : exec('sh', ['-c', 'command -v "$1"', 'sh', program]);
  return { ok: result.code === 0, how: result.code === 0 ? `resolves to ${firstLine(result.stdout)}` : `does not resolve (exit ${result.code})` };
}

// A shell-string adapter command: on when it is set and its program resolves
// (D2). On win32, cmd.exe /d /s /c mis-quotes a string holding a double quote,
// so such a command is never run, or even resolved.
function probeCommand(env, name, probe) {
  const command = env[name];
  if (!command) return { on: false, evidence: 'probed', detail: `${name} is not set` };
  if (probe.platform === 'win32' && command.includes('"')) {
    return { on: false, evidence: 'probed', detail: `${name} contains a double quote; cmd.exe would mis-quote it` };
  }
  const program = command.trim().split(/\s+/)[0];
  const found = resolves(program, probe);
  return { on: found.ok, evidence: 'probed', detail: `${name} is set; ${program} ${found.how}` };
}

// An argv adapter command (no shell): on when it parses and its program resolves.
function probeArgv(env, probe) {
  const { argv, problem } = parseAnswerCommand(env[ANSWER_ENV]);
  if (!argv) return { on: false, evidence: 'probed', detail: problem };
  const found = resolves(argv[0], probe);
  return { on: found.ok, evidence: 'probed', detail: `${ANSWER_ENV} is set; ${argv[0]} ${found.how}` };
}

export function detectAdapters({ env = {}, exec, exists = () => false, declared = [], forcedOff = [], platform, resolveCodex }) {
  const agents = probeAgents({ exec, platform, resolveCodex });
  const adapters = {};
  for (const name of ADAPTERS) {
    if (forcedOff.includes(name)) {
      adapters[name] = { on: false, evidence: 'forced-off', detail: `--no-adapter ${name}` };
    } else if (name === 'herdr') {
      if (env.HERDR_ENV !== '1') {
        adapters.herdr = { on: false, evidence: 'probed', detail: 'HERDR_ENV is not 1' };
      } else {
        const result = exec('herdr', ['agent', 'list']);
        adapters.herdr = { on: result.code === 0, evidence: 'probed', detail: `herdr agent list exit ${result.code}` };
      }
    } else if (name === 'notify') {
      adapters.notify = probeCommand(env, 'WORKIT_NOTIFY_CMD', { exec, exists, platform });
    } else if (name === 'spend') {
      adapters.spend = probeCommand(env, 'WORKIT_SPEND_CMD', { exec, exists, platform });
    } else if (name === 'answer') {
      adapters.answer = probeArgv(env, { exec, exists, platform });
    } else {
      adapters[name] = declared.includes(name)
        ? { on: true, evidence: 'declared', detail: `--adapter ${name}` }
        : { on: false, evidence: 'declared', detail: 'not declared' };
    }
  }
  return { adapters, agents };
}
