import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { spawnPtyProcess } from './ptyProcess';

describe('PTY isolated Node process', () => {
  it('supports real output, input and clean exit without renderer Workers', async () => {
    const pty = spawnPtyProcess({
      helperPath: path.resolve('resources/terminal/pty-host.cjs'),
      modulePath: path.resolve('node_modules/node-pty'),
      command: process.platform === 'win32' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : '/bin/sh',
      args: process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-Command', 'Write-Output "READY-731"; $x = [Console]::ReadLine(); Write-Output ("PTY:" + $x)'] : ['-c', 'echo READY-731; read x; echo PTY:$x'],
      cwd: process.cwd(), cols: 80, rows: 20, env: process.env as Record<string, string>,
    });
    let output = '';
    let sent = false;
    pty.onData(data => { output += data; if (!sent && output.includes('READY-731')) { sent=true; pty.write('INPUT-731\r'); } });
    pty.resize(100, 25);
    const timer=setTimeout(()=>pty.kill(), 10000);
    const exit = await new Promise<{exitCode: number}>(resolve => pty.onExit(resolve));
    clearTimeout(timer);
    expect(exit.exitCode).toBe(0);
    expect(output).toContain('PTY:INPUT-731');
  });
  it('reports a failed process rather than hanging', async () => {
    const pty = spawnPtyProcess({helperPath: path.resolve('resources/terminal/pty-host.cjs'),modulePath: path.resolve('node_modules/node-pty'),command: 'LLMHUBPP-MISSING-731',args: [],cwd: process.cwd(),cols: 80,rows: 20,env: process.env as Record<string,string>});
    let output=''; pty.onData(data => { output+=data; });
    const exit=await new Promise<{exitCode:number}>(resolve=>pty.onExit(resolve));
    expect(exit.exitCode).not.toBe(0);
    expect(output).toMatch(/error|failed|not found|cannot/i);
  });
});
