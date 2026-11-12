/**
 * Script Runner
 * Shared logic for executing scripts/commands via child_process.spawn.
 * Used by skill script execution (Chat.tsx) and shell workflow node.
 * Desktop only — mobile environments do not have child_process.
 */

import { Platform } from "obsidian";
import { getChildProcess, findNodeBinary } from "./cliProvider";

/**
 * Resolve interpreter from file extension.
 * Returns null for unknown extensions (direct execution with shebang).
 */
export function getInterpreter(filePath: string): { command: string; args: string[] } | null {
  const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "sh":
    case "bash":
      return { command: "bash", args: [filePath] };
    case "py":
      return { command: "python3", args: [filePath] };
    case "js":
    case "mjs":
      return { command: findNodeBinary(), args: [filePath] };
    case "ts":
      return { command: "npx", args: ["tsx", filePath] };
    case "rb":
      return { command: "ruby", args: [filePath] };
    default:
      return null;
  }
}

export interface RunScriptOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
  isPaused?: () => boolean;
}

export interface RunScriptResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
  terminationFailed?:boolean;
}

const DEFAULT_TIMEOUT = 60_000;

/**
 * Execute a command via child_process.spawn with shell: false.
 * Returns a promise that resolves with the result.
 */
export function runScript(options: RunScriptOptions): Promise<RunScriptResult> {
  if (Platform.isMobile) {
    return Promise.resolve({
      success: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      error: "Script execution is not available on mobile",
    });
  }

  const { command, args, cwd, env, timeout = DEFAULT_TIMEOUT, signal } = options;
  if (signal?.aborted) return Promise.resolve({success: false, stdout: '', stderr: '', exitCode: null, error: '任务已取消'});
  const { spawn } = getChildProcess();

  return new Promise((resolve) => {
    try {
      const proc = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        cwd: cwd || undefined,
        env: {
          ...(typeof process !== "undefined" ? process.env : {}),
          ...env,
        },
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');
      const stopOwnedTree = ():Promise<boolean> => new Promise(resolve=>{
        if(proc.exitCode!==null){resolve(true);return;}
        let done=false;
        const finish=(stopped:boolean)=>{if(done)return;done=true;window.clearTimeout(killDeadline);proc.removeListener('close',closed);resolve(stopped);};
        const closed=()=>finish(true);
        const killDeadline=window.setTimeout(()=>finish(false),5000);
        proc.once('close',closed);
        if(typeof process!=='undefined'&&process.platform==='win32'&&proc.pid){
          const killer=spawn('taskkill',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
          killer.once('error',()=>proc.kill());killer.once('close',(code:number|null)=>{if(code!==0&&proc.exitCode===null)proc.kill();});
        }else proc.kill();
      });
      const cancelled = () => {
        if (settled) return;
        settled = true; window.clearInterval(timer);
        signal?.removeEventListener('abort', cancelled);
        void stopOwnedTree().then(stopped=>resolve({success:false,stdout:stdout.trim(),stderr:stderr.trim(),exitCode:null,error:stopped?'任务已取消':'无法确认脚本进程退出',terminationFailed:!stopped}));
      };

      proc.stdout?.on("data", (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        options.onOutput?.(text);
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      let remaining = timeout;
      let lastTick = Date.now();
      const timer = window.setInterval(() => {
        const now = Date.now();
        if (!options.isPaused?.()) remaining -= now - lastTick;
        lastTick = now;
        if (settled || remaining > 0) return;
        window.clearInterval(timer);
        settled = true;
        signal?.removeEventListener('abort', cancelled);
        void stopOwnedTree().then(stopped=>resolve({
          success: false,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: null,
          error: `Script timed out after ${timeout / 1000} seconds`,terminationFailed:!stopped,
        }));
      }, Math.max(10, Math.min(100, timeout / 4)));
      signal?.addEventListener('abort', cancelled, {once: true});
      if (signal?.aborted) cancelled();

      proc.on("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        window.clearInterval(timer);
        signal?.removeEventListener('abort', cancelled);
        resolve({
          success: code === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code,
        });
      });

      proc.on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        window.clearInterval(timer);
        signal?.removeEventListener('abort', cancelled);
        resolve({
          success: false,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: null,
          error: err.message,
        });
      });
    } catch (err) {
      resolve({
        success: false,
        stdout: "",
        stderr: "",
        exitCode: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
