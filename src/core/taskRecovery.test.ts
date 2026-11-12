import {describe,it,expect} from 'vitest';import {TaskManager} from './taskManager';import {TaskJournal} from './taskJournal';import {memoryVault} from './testSupport/memoryVault';
const tick=()=>new Promise(r=>setTimeout(r,0));
describe('durable task recovery',()=>{
 it('can continue in the same window after save-and-exit fails',async()=>{
  const v=memoryVault(),m=new TaskManager();let resumed=0;await m.initialize(new TaskJournal(v.io as any,'jobs'),async()=>{resumed++;});
  const pending=m.run('job',async task=>new Promise<void>((_r,reject)=>task.signal.addEventListener('abort',()=>reject(Object.assign(Error(),{name:'AbortError'})))),{descriptor:{kind:'rag',setting:'S'}}).catch(()=>{});await tick();v.fail('tasks-');await expect(m.suspendAll()).rejects.toThrow();await pending;v.fail('');m.list()[0].resume();await tick();await m.flush();expect(resumed).toBe(1);expect(m.list()[0].snapshot.status).toBe('completed');
 });
 it('guards close until the final completed record is durable',async()=>{
  const v=memoryVault();const journal=new TaskJournal(v.io as any,'jobs'),save=journal.save.bind(journal);let release!:()=>void;
  journal.save=async tasks=>{if(tasks.some(t=>t.status==='completed'))await new Promise<void>(r=>release=r);return save(tasks);};
  const m=new TaskManager();await m.initialize(journal,async()=>{});const pending=m.run('job',async()=>{});while(!release)await tick();expect(m.hasUnfinished()).toBe(true);release();await pending;expect(m.hasUnfinished()).toBe(false);
 });
 it('never stores arbitrary stderr credential formats',async()=>{
  const v=memoryVault(),m=new TaskManager();await m.initialize(new TaskJournal(v.io as any,'jobs'),async()=>{});for(const message of ['API_KEY=ENV_SECRET','Authorization: Basic BASIC_SECRET','{"apiKey":"JSON_SECRET"}'])m.create('custom').fail(Error(message));await m.flush();const text=[...v.files.values()].join('');for(const secret of ['ENV_SECRET','BASIC_SECRET','JSON_SECRET'])expect(text).not.toContain(secret);
 });
 it('persists only safe stage, file identifiers and known error categories',async()=>{
  const v=memoryVault(),m=new TaskManager();await m.initialize(new TaskJournal(v.io as any,'jobs'),async()=>{});
  const task=m.create('索引资料','Library/note.md',{kind:'rag',setting:'Library'});
  task.update('Bearer STAGE_SECRET',1,2,'API_KEY=DETAIL_SECRET');
  task.saved('https://example.test/file?access_token=URL_SECRET');
  task.fail(Object.assign(Error('Authorization: Basic ERROR_SECRET'),{code:'embedding-missing'}));await m.flush();
  const text=[...v.files.values()].join('');for(const secret of ['STAGE_SECRET','DETAIL_SECRET','URL_SECRET','ERROR_SECRET'])expect(text).not.toContain(secret);
  const reloaded=new TaskManager();await reloaded.initialize(new TaskJournal(v.io as any,'jobs'),async()=>{});
  expect(reloaded.list()[0].snapshot).toMatchObject({status:'failed',errorCode:'embedding-missing',detail:'',savedDetail:''});
 });
 it('reads an older journal and restores an unfinished RAG job paused',async()=>{
  const v=memoryVault();await v.io.mkdir('jobs');
  await v.io.write('jobs/tasks-123.json',JSON.stringify({version:1,tasks:[{id:'1-1',title:'旧索引',source:'Library/a.md',stage:'旧阶段',status:'running',completed:1,total:2,detail:'Library/a.md',updatedAt:1,descriptor:{kind:'rag',setting:'Library'}}]}));
  let calls=0;const m=new TaskManager();await m.initialize(new TaskJournal(v.io as any,'jobs'),async()=>{calls++;});
  expect(m.list()[0].snapshot).toMatchObject({status:'paused',descriptor:{kind:'rag',setting:'Library'}});expect(calls).toBe(0);
 });
 it('does not replay a task when its recovery identifier contains a credential',async()=>{
  const v=memoryVault(),m=new TaskManager();await m.initialize(new TaskJournal(v.io as any,'jobs'),async()=>{});
  m.create('index','',{kind:'rag',setting:'API_KEY=PRIVATE_SECRET'}).update('扫描RAG文档');await m.flush();
  expect([...v.files.values()].join('')).not.toContain('PRIVATE_SECRET');
  let calls=0;const restored=new TaskManager();await restored.initialize(new TaskJournal(v.io as any,'jobs'),async()=>{calls++;});
  expect(restored.list()[0].snapshot.status).toBe('interrupted');restored.list()[0].resume();expect(calls).toBe(0);
 });
 it('persists only approved descriptor fields and redacts credential-shaped errors',async()=>{
  const v=memoryVault(),m=new TaskManager();await m.initialize(new TaskJournal(v.io as any,'jobs'),async()=>{});
  const task=m.create('custom','safe',{kind:'custom',source:'Inbox/x',env:{API_KEY:'DO_NOT_PERSIST'}} as any);task.fail(Error('request https://example/?api_key=PRIVATE_TOKEN'));await m.flush();
  const all=[...v.files.values()].filter(v=>typeof v==='string').join('');expect(all).not.toContain('DO_NOT_PERSIST');expect(all).not.toContain('PRIVATE_TOKEN');
 });
 it('restores interrupted work paused and only resumes once when requested',async()=>{
  const v=memoryVault(),first=new TaskManager();await first.initialize(new TaskJournal(v.io as any,'jobs'),async()=>{});
  const work=first.run('RAG',async task=>{task.update('generate',32,80);task.saved('part1');await new Promise<void>((_r,reject)=>task.signal.addEventListener('abort',()=>reject(Object.assign(Error(),{name:'AbortError'}))));},{descriptor:{kind:'rag',setting:'S'},serial:true});const caught=work.catch(()=>{});await tick();await first.suspendAll();await caught;
  const second=new TaskManager();let calls=0;await second.initialize(new TaskJournal(v.io as any,'jobs'),async()=>{calls++;});const task=second.list()[0];expect(task.snapshot.status).toBe('paused');expect(task.snapshot.savedCount).toBe(1);expect(calls).toBe(0);task.resume();task.resume();await tick();await second.flush();expect(calls).toBe(1);expect(task.snapshot.status).toBe('completed');
  const third=new TaskManager();await third.initialize(new TaskJournal(v.io as any,'jobs'),async()=>{});expect(third.list()[0].snapshot.status).toBe('completed');
 });
 it('does not replay custom commands and surfaces failed persistence',async()=>{
  const v=memoryVault(),m=new TaskManager();await m.initialize(new TaskJournal(v.io as any,'jobs'),async()=>{});m.create('custom','workflow',{kind:'custom',workflow:'workflows/custom.md'}).update('script');await m.flush();
  const next=new TaskManager();let calls=0;await next.initialize(new TaskJournal(v.io as any,'jobs'),async()=>{calls++;});expect(next.list()[0].snapshot.status).toBe('interrupted');next.list()[0].resume();expect(calls).toBe(0);v.fail('tasks-');await expect(next.suspendAll()).rejects.toThrow('disk failure');
 });
});
