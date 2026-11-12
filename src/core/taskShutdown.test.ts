import {describe,it,expect,vi} from 'vitest';import {TaskShutdown,clearHeldQuitProgress} from './taskShutdown';
const tick=()=>new Promise(r=>setTimeout(r,0));
describe('safe close protocol',()=>{
 it('opens the exit decision when a native close happens before browser unload', async () => {
  const prompt = vi.fn(async () => false);
  const guard = new TaskShutdown(() => true, prompt, async () => {}, () => {}, () => {});
  const preventDefault = vi.fn();
  guard.onNativeClose({ preventDefault });
  await tick();
  expect(prompt).toHaveBeenCalledOnce();
  expect(preventDefault).toHaveBeenCalledOnce();
  guard.dispose();
 });
 it('blocks the core quit hook and marks the native delayed-destroy event',()=>{
  const guard=new TaskShutdown(()=>true,()=>new Promise(()=>{}),async()=>{},()=>{},()=>{});const stop=vi.fn(),prevent=vi.fn();guard.onClose({preventDefault:()=>{},stopImmediatePropagation:stop});guard.onNativeClose({preventDefault:prevent});expect(stop).toHaveBeenCalledOnce();expect(prevent).toHaveBeenCalledOnce();guard.dispose();
 });
 it('reveals the blocked native window so the prompt is visible',async()=>{
  const reveal=vi.fn();const guard=new TaskShutdown(()=>true,()=>new Promise(()=>{}),async()=>{},()=>{},()=>{},reveal);guard.onClose({preventDefault:()=>{}});await tick();expect(reveal).toHaveBeenCalledOnce();guard.dispose();
 });
 it('keeps the window open when cancelled and closes only after save',async()=>{
  let answer=false,release!:()=>void;const close=vi.fn(),save=vi.fn(()=>new Promise<void>(r=>release=r));const guard=new TaskShutdown(()=>true,async()=>answer,save,close,()=>{});
  const e={preventDefault:vi.fn(),returnValue:undefined as unknown};guard.onClose(e);await tick();expect(close).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();answer=true;guard.onClose(e);await tick();expect(close).not.toHaveBeenCalled();release();await tick();expect(close).toHaveBeenCalledOnce();guard.onClose(e);expect(e.preventDefault).toHaveBeenCalledTimes(2);
 });
 it('reports failed save and does not exit',async()=>{
  const close=vi.fn(),error=vi.fn();const guard=new TaskShutdown(()=>true,async()=>true,async()=>{throw Error('disk');},close,error);guard.onClose({preventDefault:()=>{}});await tick();expect(error).toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
 });
});

describe('held quit progress overlay',()=>{
 it('removes only the stranded saving screen when a quit is held',()=>{
  const saving={querySelector:()=>({textContent:'Saving...'}),remove:vi.fn()};
  const unrelated={querySelector:()=>({textContent:'Loading workspace...'}),remove:vi.fn()};
  const remove=vi.fn();const doc={body:{classList:{contains:()=>true,remove}},querySelectorAll:()=>[saving,unrelated]} as unknown as Document;
  clearHeldQuitProgress(doc);expect(saving.remove).toHaveBeenCalledOnce();expect(unrelated.remove).not.toHaveBeenCalled();expect(remove).toHaveBeenCalledWith('in-progress');
 });
 it('leaves ordinary load progress alone',()=>{
  const node={querySelector:()=>({textContent:'Loading workspace...'}),remove:vi.fn()},remove=vi.fn();
  const doc={body:{classList:{contains:()=>true,remove}},querySelectorAll:()=>[node]} as unknown as Document;
  clearHeldQuitProgress(doc);expect(node.remove).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();
 });
});
