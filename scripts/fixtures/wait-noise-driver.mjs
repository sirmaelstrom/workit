// Drives one `lane wait` through the REAL `execute`: each of the first N
// `herdr agent wait` polls is a child process that writes herdr's timeout JSON
// to stderr and exits 1, the way herdr answers a poll that saw no settled
// state. Prints the verdict as `main()` does. Run as a subprocess by
// lane.test.mjs, which reads this process's stdout and stderr.
//   node wait-noise-driver.mjs <log> <timeouts>
import { execute, runLane } from '../lane.mjs';

const [log, count] = process.argv.slice(2);
const timeouts = Number(count);
const herdrTimeout = `process.stderr.write(${JSON.stringify(`${JSON.stringify({ error: { code: 'timeout', message: 'timed out waiting for agent status' }, id: 'cli:agent:wait' })}\n`)}); process.exit(1);`;
let waits = 0;
const exec = (program, args, options) => {
  if (program === 'herdr' && args[0] === 'agent' && args[1] === 'wait') {
    waits++;
    if (waits <= timeouts) return execute(process.execPath, ['-e', herdrTimeout], options);
    return { code: 0, stdout: '{"result":{"agent_status":"done"}}', stderr: '' };
  }
  if (program === 'herdr' && args[0] === 'agent' && args[1] === 'read') return { code: 0, stdout: 'working', stderr: '' };
  return { code: 0, stdout: '{"result":{}}', stderr: '' };
};
const result = await runLane(['wait', 'lane-a', '--until', 'done', '--timeout', '600000', '--log', log], {
  exec, sleep: async () => {},
});
console.log(JSON.stringify(result.output));
