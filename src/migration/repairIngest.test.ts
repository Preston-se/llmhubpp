import {describe,it,expect} from 'vitest';
import {repairKnownIngest} from './repairIngest';
import type {MigrationFiles} from './unifiedStorage';
function fixture(script='original\r\n'){
 const data=new Map([['work/tools/source-auto-ingest.ps1',script],['plugin/resources/inbox/source-auto-ingest.legacy.ps1','original\n'],['plugin/resources/inbox/source-auto-ingest.ps1','fixed\n'],['plugin/resources/inbox/Normalize-Xlsx.ps1','helper'],['plugin/resources/inbox/Publish-Markdown.ps1','publisher'],['plugin/resources/inbox/Ingest-Receipt.ps1','receipt']]);
 const writes:string[]=[];
 const io:MigrationFiles={exists:async p=>data.has(p),read:async p=>data.get(p)!,mkdir:async()=>{},write:async(p,t)=>{writes.push(p);data.set(p,t);}};
 return {data,writes,io};
}
describe('existing known Inbox XLSX repair',()=>{
 it('repairs exact known legacy script after a byte-preserving backup',async()=>{
  const f=fixture();expect(await repairKnownIngest(f.io,'plugin','work')).toBe(true);
  expect(f.data.get('plugin/legacy-backup/source-auto-ingest.ps1')).toBe('original\r\n');
  expect(f.data.get('work/tools/source-auto-ingest.ps1')).toBe('fixed\n');
  expect(f.data.get('work/tools/Normalize-Xlsx.ps1')).toBe('helper');
  expect(f.writes[0]).toContain('legacy-backup');
  expect(await repairKnownIngest(f.io,'plugin','work')).toBe(false);
 });
 it('upgrades the exact previous fixed preset and protects a custom publisher',async()=>{
  const known=fixture('previous\r\n');known.data.set('plugin/resources/inbox/source-auto-ingest.v2.2-fixed.ps1','previous\n');
  expect(await repairKnownIngest(known.io,'plugin','work')).toBe(true);expect(known.data.get('work/tools/Publish-Markdown.ps1')).toBe('publisher');
  const custom=fixture();custom.data.set('work/tools/Publish-Markdown.ps1','custom publisher');expect(await repairKnownIngest(custom.io,'plugin','work')).toBe(false);expect(custom.writes).toEqual([]);
 });
 it('upgrades R6 scripts and publisher only after backing them up',async()=>{
  const f=fixture('r6');f.data.set('plugin/resources/inbox/source-auto-ingest.r6.ps1','r6');f.data.set('plugin/resources/inbox/Publish-Markdown.r6.ps1','old publisher');f.data.set('work/tools/Publish-Markdown.ps1','old publisher');
  expect(await repairKnownIngest(f.io,'plugin','work')).toBe(true);expect(f.data.get('work/tools/Publish-Markdown.ps1')).toBe('publisher');expect(f.data.get('work/tools/Ingest-Receipt.ps1')).toBe('receipt');expect([...f.data.values()]).toContain('old publisher');
 });
 it('does not overwrite user edits or a conflicting helper',async()=>{
  const custom=fixture('my custom parser');expect(await repairKnownIngest(custom.io,'plugin','work')).toBe(false);expect(custom.writes).toEqual([]);
  const conflict=fixture();conflict.data.set('work/tools/Normalize-Xlsx.ps1','user helper');
  expect(await repairKnownIngest(conflict.io,'plugin','work')).toBe(false);expect(conflict.writes).toEqual([]);
 });
});
