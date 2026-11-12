import { spawn } from 'child_process';
import { setTimeout as nodeTimeout, clearTimeout as clearNodeTimeout } from 'timers';

export interface PtyProcessOptions {
  helperPath: string;
  modulePath: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  nodePath?: string;
}

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: {exitCode: number; signal?: number}) => void): void;
}

/** Worker-dependent node-pty runs in a short-lived Node child, not Electron's renderer. */
export function spawnPtyProcess(options: PtyProcessOptions): PtyProcess {
  const child = spawn(options.nodePath || options.env.LLMHUBPP_NODE_PATH || 'node', [options.helperPath], {
    cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: {exitCode: number}) => void> = [];
  let pending = '';
  let exited: {exitCode: number} | undefined;
  let killTimer: ReturnType<typeof nodeTimeout> | undefined;
  const emit = (data: string) => dataListeners.forEach(callback => callback(data));
  const finish = (exitCode: number) => {
    if (exited) return;
    if (killTimer) clearNodeTimeout(killTimer);
    exited = {exitCode};
    exitListeners.forEach(callback => callback(exited!));
  };
  const send = (message: object) => {
    if (!exited && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n');
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const message = JSON.parse(line) as {type: string; data?: string};
        if (message.type === 'data' || message.type === 'error') emit(message.data || '');
      } catch { emit(line); }
    }
  });
  child.stderr.on('data', (data: Buffer) => emit(data.toString()));
  child.stdin.on('error', () => {}); // An exiting helper may close stdin first.
  child.on('error', error => { emit(`Terminal process error: ${error.message}`); finish(1); });
  child.on('close', code => finish(code ?? 1));
  send({type: 'start', ...options});
  return {
    write: data => send({type: 'write', data}),
    resize: (cols, rows) => send({type: 'resize', cols, rows}),
    kill: () => {
      if (exited || killTimer) return;
      send({type: 'kill'});
      killTimer = nodeTimeout(() => child.kill(), 2000);
    },
    onData: callback => { dataListeners.push(callback); },
    onExit: callback => { if (exited) callback(exited); else exitListeners.push(callback); },
  };
}
