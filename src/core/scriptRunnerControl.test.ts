import {describe,it,expect,vi} from 'vitest';
import {spawn} from 'node:child_process';
vi.mock('./cliProvider',()=>({getChildProcess:()=>({spawn}),findNodeBinary:()=>process.execPath}));
import {runScript} from './scriptRunner';
describe('script cancellation',()=>{
 it('has stopped the owned process when cancellation resolves',async()=>{
  const controller=new AbortController();let pid=0;
  const result=await runScript({command:process.execPath,args:['-e','console.log("PID="+process.pid);setInterval(()=>{},1000)'],signal:controller.signal,onOutput:text=>{const m=/PID=(\d+)/.exec(text);if(m){pid=Number(m[1]);controller.abort();}},timeout:2000});expect(result.success).toBe(false);let alive=true;try{process.kill(pid,0);}catch{alive=false;}expect(alive).toBe(false);
 });
 it('excludes acknowledged paused time from the execution timeout',async()=>{
  let paused=false;
  const result=await runScript({command:process.execPath,args:['-e','console.log("PAUSED");setTimeout(()=>console.log("RESUMED"),240);setTimeout(()=>process.exit(0),280)'],timeout:180,isPaused:()=>paused,onOutput:text=>{if(text.includes('PAUSED'))paused=true;if(text.includes('RESUMED'))paused=false;}});
  expect(result.success).toBe(true);
 });
 it('cancels an owned process and returns promptly',async()=>{
  const controller=new AbortController();
  const start=Date.now();
  const result=await runScript({command:process.execPath,args:['-e','console.log("READY");setInterval(()=>{},1000)'],signal:controller.signal,onOutput:text=>{if(text.includes('READY'))controller.abort();},timeout:1500});
  expect(result.success).toBe(false);expect(result.error).toMatch(/取消|cancel/i);expect(Date.now()-start).toBeLessThan(1400);
 });
});
