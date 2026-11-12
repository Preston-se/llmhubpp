import {describe,it,expect} from 'vitest';
import {saveRagSnapshot,loadRagSnapshot,renameRagIndex,deleteRagIndex} from './localRagStorage';
import {memoryVault} from './testSupport/memoryVault';
const index=(text:string)=>({meta:[{filePath:'n.md',chunkIndex:0,text}],dimension:2,fileChecksums:{'n.md':text},embeddingModel:'m',chunkSize:800,chunkOverlap:150});
describe('durable paired RAG generations',()=>{
 it('prunes failed orphan payloads once a new complete generation is saved',async()=>{
  const v=memoryVault();await saveRagSnapshot(v.app,'S',index('old'),new Float32Array([1,2]),'W');v.fail('vectors-');await expect(saveRagSnapshot(v.app,'S',index('failed'),new Float32Array([3,4]),'W')).rejects.toThrow();v.fail('');await saveRagSnapshot(v.app,'S',index('new'),new Float32Array([5,6]),'W');expect([...v.files.keys()].filter(k=>/\/index-.*json$/.test(k))).toHaveLength(2);
 });
 it('retains the previous valid generation when a newer old record is corrupt',async()=>{
  const v=memoryVault();await saveRagSnapshot(v.app,'S',index('old-good'),new Float32Array([1,2]),'W');await saveRagSnapshot(v.app,'S',index('corrupt'),new Float32Array([3,4]),'W');let marker=JSON.parse(v.files.get([...v.files.keys()].filter(k=>k.includes('/commit-')).sort().at(-1)!) as string);v.files.set(marker.vectors,new Float32Array([99,99]).buffer);await saveRagSnapshot(v.app,'S',index('latest'),new Float32Array([5,6]),'W');marker=JSON.parse(v.files.get([...v.files.keys()].filter(k=>k.includes('/commit-')).sort().at(-1)!) as string);v.files.set(marker.vectors,new Float32Array([99,99]).buffer);expect((await loadRagSnapshot(v.app,'S','W'))?.index.meta[0].text).toBe('old-good');
 });
 it.each(['vectors-','commit-'])('retains prior generation after interrupted %s write',async(part)=>{
  const v=memoryVault();await saveRagSnapshot(v.app,'S',index('old'),new Float32Array([1,2]),'W');v.fail(part);
  await expect(saveRagSnapshot(v.app,'S',index('new'),new Float32Array([3,4]),'W')).rejects.toThrow('disk failure');
  expect((await loadRagSnapshot(v.app,'S','W'))?.index.meta[0].text).toBe('old');
 });
 it('validates checksums and falls back to prior complete generation',async()=>{
  const v=memoryVault();await saveRagSnapshot(v.app,'S',index('old'),new Float32Array([1,2]),'W');await saveRagSnapshot(v.app,'S',index('new'),new Float32Array([3,4]),'W');
  const latest=[...v.files.keys()].filter(k=>k.includes('/commit-')).sort().at(-1)!;
  const marker=JSON.parse(v.files.get(latest) as string);v.files.set(marker.vectors,new Float32Array([99,99]).buffer);
  expect((await loadRagSnapshot(v.app,'S','W'))?.index.meta[0].text).toBe('old');
 });
 it('loads legacy files and rename/clear include canonical generations',async()=>{
  const v=memoryVault();v.files.set('W/rag/S/index.json',JSON.stringify(index('legacy')));v.files.set('W/rag/S/vectors.bin',new Float32Array([1,2]).buffer);
  expect((await loadRagSnapshot(v.app,'S','W'))?.index.meta[0].text).toBe('legacy');
  await saveRagSnapshot(v.app,'S',index('canonical'),new Float32Array([3,4]),'W');await renameRagIndex(v.app,'S','Next','W');
  expect((await loadRagSnapshot(v.app,'Next','W'))?.index.meta[0].text).toBe('canonical');await deleteRagIndex(v.app,'Next','W');expect(await loadRagSnapshot(v.app,'Next','W')).toBe(null);
 });
});
