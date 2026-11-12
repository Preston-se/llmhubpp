import {describe,it,expect} from 'vitest';
import {TaskManager,controlledRequest} from './taskManager';
import {TaskJournal} from './taskJournal';
import {memoryVault} from './testSupport/memoryVault';
describe('controlled background work',()=>{
 it('bounds a stalled cancellable request with a timeout',async()=>{
  await expect(controlledRequest(undefined,signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))),20)).rejects.toMatchObject({name:'TimeoutError'});
 });
 it('pauses at a checkpoint and resumes without losing progress',async()=>{
  const tasks=new TaskManager();const task=tasks.create('test','book');task.update('转换',2,10);
  task.pause();let resumed=false;const waiting=task.checkpoint().then(()=>{resumed=true;});
  await new Promise(r=>setTimeout(r,5));expect(resumed).toBe(false);expect(task.snapshot.status).toBe('paused');
  task.resume();await waiting;expect(task.snapshot.completed).toBe(2);expect(resumed).toBe(true);
 });
 it('cancels a paused task immediately',async()=>{
  const task=new TaskManager().create('test');task.pause();
  const wait=task.checkpoint();task.cancel();await expect(wait).rejects.toMatchObject({name:'AbortError'});
  expect(task.signal.aborted).toBe(true);expect(task.snapshot.status).toBe('cancelled');
 });
 it('serializes index writers and never executes a cancelled queued task',async()=>{
  const tasks=new TaskManager();let release!:()=>void;const order:string[]=[];
  const a=tasks.run('first',async()=>{order.push('a');await new Promise<void>(r=>release=r);}, {serial:true});
  await new Promise(r=>setTimeout(r,0));
  expect(tasks.list()[0].snapshot.status).toBe('running');
  const b=tasks.run('second',async()=>{order.push('b');},{serial:true});
  expect(tasks.list()[1].snapshot.status).toBe('queued');
  const rejected=expect(b).rejects.toMatchObject({name:'AbortError'});
  tasks.list().find(t=>t.snapshot.title==='second')!.cancel();release();await a;await rejected;
  expect(order).toEqual(['a']);
 });
 it('settles a cancelled queued task immediately without allowing a later writer to pass the running one',async()=>{
  const tasks=new TaskManager();let release!:()=>void;const order:string[]=[];
  const a=tasks.run('first',async()=>{order.push('a');await new Promise<void>(r=>release=r);},{serial:true});
  await new Promise(r=>setTimeout(r,0));
  const controller=new AbortController();
  const b=tasks.run('second',async()=>{order.push('b');},{serial:true,signal:controller.signal});
  const c=tasks.run('third',async()=>{order.push('c');},{serial:true});
  const settled=b.then(()=>false,()=>true);controller.abort();
  const immediate=await Promise.race([settled,new Promise<boolean>(r=>setTimeout(()=>r(false),20))]);
  expect(immediate).toBe(true);expect(order).toEqual(['a']);
  release();await Promise.all([a,c]);expect(order).toEqual(['a','c']);
 });
 it('does not mark a task completed when cancellation races with its final result',async()=>{
  const tasks=new TaskManager(),controller=new AbortController();
  const pending=tasks.run('final',async()=>{controller.abort();return 'already saved';},{signal:controller.signal});
  await expect(pending).rejects.toMatchObject({name:'AbortError'});
  expect(tasks.list()[0].snapshot.status).toBe('cancelled');
 });
 it('notifies the task center when saving fails or recovers without another task change',async()=>{
  const memory=memoryVault(),tasks=new TaskManager();
  await tasks.initialize(new TaskJournal(memory.app.vault.adapter,'Tasks'),async()=>{});
  const errors:(string|undefined)[]=[];
  const unsubscribe=tasks.subscribe(()=>errors.push(tasks.lastSaveError?.message));
  tasks.create('task');
  memory.fail('tasks-');
  await expect(tasks.flush()).rejects.toThrow('disk failure');
  expect(errors.at(-1)).toBe('disk failure');
  memory.fail('');
  await tasks.flush();
  expect(errors.at(-1)).toBeUndefined();
  unsubscribe();tasks.dispose();
 });
});
