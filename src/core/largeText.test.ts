import {describe,it,expect} from 'vitest';
import {_chunkText as chunkText, _simpleChecksum as checksum, _chunkTextAsync as chunkAsync, _simpleChecksumAsync as checksumAsync} from './localRagStore';
describe('responsive long text preparation',()=>{
 it('rejects invalid chunk sizes instead of entering a non-progressing loop',()=>{
  expect(()=>chunkText('正文',0,0)).toThrow();
  expect(()=>chunkText('正文',-1,0)).toThrow();
 });
 it('yields during long Chinese text and preserves existing chunk/checksum semantics',async()=>{
  const text=('中文段落没有英文句点。'.repeat(90)+'\n\n').repeat(2500);
  let timerRan=false;setTimeout(()=>{timerRan=true;},0);
  const actual=await chunkAsync(text,800,150);
  expect(timerRan).toBe(true);expect(actual).toEqual(chunkText(text,800,150));
  expect(await checksumAsync(text)).toBe(checksum(text));
 });
 it('honors cancellation while preparing a document',async()=>{
  const c=new AbortController();c.abort();
  await expect(chunkAsync('正文'.repeat(200000),800,150,{signal:c.signal,checkpoint:async()=>{throw Object.assign(new Error('cancelled'),{name:'AbortError'});},update:()=>{}})).rejects.toMatchObject({name:'AbortError'});
 });
});
