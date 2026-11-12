/**
 * Shell node handler.
 * Executes a shell command via child_process.spawn (desktop only).
 */
import { App } from "obsidian";
import type { WorkflowNode, ExecutionContext } from "../types";
import { parseJsonRecord, replaceVariables } from "./utils";
import { runScript } from "../../core/scriptRunner";
import type { ManagedTask } from '../../core/taskManager';

const DEFAULT_TIMEOUT = 60_000;

export function updateShellProgress(task:ManagedTask|undefined,stage:string,current:number,total:number,detail:string):void{
  if(stage==='已暂停')task?.acknowledgePause();
  else task?.update(stage,current,total,detail);
}


/** Built-in binary ingest consumes paths; retain event text for every custom shell. */
export function discardManagedBinaryEventText(args: string[], variables: Map<string, unknown>): void {
  if (!args.some(arg => /(?:^|[\\/])(?:vm-)?source-auto-ingest\.ps1$/i.test(arg))) return;
  const value = variables.get('_eventFilePath');
  const path = typeof value === 'string' ? value : '';
  if (/\.(epub|pdf|docx?|pptx?|xlsx?|zip|7z|png|jpe?g|gif|webp)$/i.test(path)) variables.delete('_eventFileContent');
}


export async function handleShellNode(
  node: WorkflowNode,
  context: ExecutionContext,
  app: App,
  task?: ManagedTask,
): Promise<void> {
  const commandTemplate = node.properties["command"];
  if (!commandTemplate) throw new Error("Shell node missing 'command' property");

  const command = replaceVariables(commandTemplate, context);

  // Parse args: JSON array or empty
  let args: string[] = [];
  const argsTemplate = node.properties["args"];
  if (argsTemplate) {
    const argsStr = replaceVariables(argsTemplate, context);
    try {
      const parsed = JSON.parse(argsStr) as unknown;
      if (Array.isArray(parsed)) {
        args = parsed.map(String);
      }
    } catch {
      // Treat as a single argument if not valid JSON array
      args = [argsStr];
    }
  }

  discardManagedBinaryEventText(args, context.variables);

  // Working directory
  const cwdTemplate = node.properties["cwd"];
  const vaultBasePath = (app.vault.adapter as { basePath?: string }).basePath || ".";
  const cwd = cwdTemplate ? replaceVariables(cwdTemplate, context) : vaultBasePath;

  // Timeout
  const timeoutStr = node.properties["timeout"];
  const timeout = timeoutStr ? parseInt(timeoutStr, 10) || DEFAULT_TIMEOUT : DEFAULT_TIMEOUT;

  // Parse env: JSON object of environment variables
  const envVars: Record<string, string> = { VAULT_PATH: vaultBasePath };
  const envTemplate = node.properties["env"];
  if (envTemplate) {
    const envStr = replaceVariables(envTemplate, context);
    try {
      const parsed = parseJsonRecord(envStr);
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          envVars[k] = String(v);
        }
      }
    } catch {
      // Ignore invalid JSON
    }
  }

  await task?.checkpoint();
  let unsubscribe: (() => void) | undefined;
  let writes = Promise.resolve();
  if (task) {
    const directory = `${app.vault.configDir}/llmhubpp-tasks`;
    const temp = `${directory}/temp/${task.snapshot.id}`;
    for (const folder of [directory, temp]) if (!await app.vault.adapter.exists(folder)) await app.vault.adapter.mkdir(folder);
    const relative = `${directory}/${task.snapshot.id}.json`;
    envVars.LLMHUBPP_TASK_CONTROL = `${vaultBasePath}/${relative}`;
    if(task.snapshot.descriptor?.kind==='ingest')envVars.LLMHUBPP_INGEST_RECEIPT=`${vaultBasePath}/${directory}/${task.snapshot.id}.receipt.json`;
    envVars.TEMP = `${vaultBasePath}/${temp}`; envVars.TMP = envVars.TEMP;
    let last = '';
    const writeState = () => {
      const state = task.snapshot;
      const text = JSON.stringify({pause: ['pausing', 'paused'].includes(state.status), cancel: task.signal.aborted});
      if (text === last) return;
      last = text;
      writes = writes.then(() => app.vault.adapter.write(relative, text)).catch(error => {
        task.cancel();
        console.error('[LLM Hub] Task control file could not be written', error instanceof Error ? error.message : 'I/O error');
      });
    };
    writeState(); await writes; unsubscribe = task.observe(writeState);
  }
  task?.update('正在转换/执行脚本');
  let output = '';
  let safeToClean=false;
  const result = await runScript({
    command, args, cwd, timeout, env: envVars, signal: task?.signal,
    isPaused: () => task?.snapshot.status === 'paused',
    onOutput: text => {
      output += text;
      let newline: number;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline).trim(); output = output.slice(newline + 1);
        const progress = /^LLMHUBPP_PROGRESS\|([^|]+)\|(\d+)\|(\d+)\|(.*)$/.exec(line);
        if (progress) {
          updateShellProgress(task,progress[1],Number(progress[2]),Number(progress[3]),progress[4]);
        }
      }
    },
  }).then(result=>{safeToClean=!result.terminationFailed;return result;}).finally(async () => {
    unsubscribe?.();await writes.catch(()=>{});
    if(task?.snapshot.descriptor?.kind==='ingest'&&safeToClean){
      const temp=`${app.vault.configDir}/llmhubpp-tasks/temp/${task.snapshot.id}`;
      const loader=window as unknown as {require:(id:string)=>unknown};const path=loader.require('path') as typeof import('path');
      const root=path.resolve(vaultBasePath,app.vault.configDir,'llmhubpp-tasks','temp'),target=path.resolve(vaultBasePath,temp);
      if(/^\d+-\d+$/.test(task.snapshot.id)&&path.dirname(target)===root&&target.startsWith(root+path.sep)&&await app.vault.adapter.exists(temp))try{await app.vault.adapter.rmdir(temp,true);}catch{/* Retain locked owned scratch for a later cleanup attempt. */}
    }
  });
  if(result.terminationFailed)throw Object.assign(new Error('无法确认任务子进程退出，请检查后重试关闭'),{name:'TaskTerminationError'});
  if(task?.signal.aborted)throw Object.assign(new Error('任务已取消'),{name:'AbortError'});
  result.stdout = result.stdout.split(/\r?\n/).filter(line => !line.startsWith('LLMHUBPP_PROGRESS|')).join('\n');

  // Save results to variables
  const saveTo = node.properties["saveTo"];
  if (saveTo) {
    context.variables.set(saveTo, result.stdout);
  }

  const saveStderrTo = node.properties["saveStderrTo"];
  if (saveStderrTo) {
    context.variables.set(saveStderrTo, result.stderr);
  }

  const saveExitCodeTo = node.properties["saveExitCodeTo"];
  if (saveExitCodeTo) {
    context.variables.set(saveExitCodeTo, String(result.exitCode ?? ""));
  }

  // throwOnError defaults to "true"
  const throwOnError = node.properties["throwOnError"] !== "false";
  if (throwOnError && !result.success) {
    throw new Error(`Shell command failed (exit ${result.exitCode}): ${result.error || result.stderr}`);
  }
}
