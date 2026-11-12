'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node CommonJS process. */
// One terminal per process. Only stdin/stdout JSON messages; no port or service.
const readline = require('node:readline');
const {setTimeout: nodeTimeout} = require('node:timers');
let pty;
let ending = false;
const send = (type, data) => process.stdout.write(JSON.stringify({type, data}) + '\n');
const exit = code => {
  if (ending) return;
  ending = true;
  process.stdout.write('', () => process.exit(code));
};
const stop = () => {
  try { pty?.kill(); } catch { /* The terminal may already have exited. */ }
  nodeTimeout(() => exit(0), 500).unref();
  if (!pty) exit(0);
};
readline.createInterface({input: process.stdin}).on('line', line => {
  try {
    const message = JSON.parse(line);
    if (message.type === 'start' && !pty) {
      pty = require(message.modulePath).spawn(message.command, message.args, {
        name: 'xterm-256color', cwd: message.cwd, env: message.env, cols: message.cols, rows: message.rows,
      });
      pty.onData(data => send('data', data));
      pty.onExit(event => exit(event.exitCode));
    } else if (message.type === 'write') pty?.write(message.data);
    else if (message.type === 'resize') pty?.resize(message.cols, message.rows);
    else if (message.type === 'kill') stop();
  } catch (error) { send('error', `Terminal error: ${error.message}`); exit(1); }
}).on('close', stop);
process.on('SIGTERM', stop);
/* eslint-enable @typescript-eslint/no-require-imports -- End standalone Node module. */
