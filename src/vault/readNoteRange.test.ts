
import { describe,it,expect,vi } from 'vitest';
import { TFile } from 'obsidian';
import { executeToolCall } from './toolExecutor';
import { getHostVaultTools } from 'src/core/vaultToolAccessPolicy';
function fixture(text:string) {
  const file=Object.assign(new TFile(),{path:'Notes/long.md',name:'long.md',basename:'long',extension:'md'});
  const read=vi.fn(async()=>text);
  const app={vault:{getAbstractFileByPath:(path:string)=>path===file.path?file:null,getFiles:()=>[file],getMarkdownFiles:()=>[file],read},workspace:{getActiveFile:()=>file}} as any;
  return {app,file,read};
}
describe('bounded long-note reads',()=>{
  it('reads a 300000-character note from start to end with exact continuation and a stable source guard',async()=>{
    const text='甲'.repeat(100000)+'中'.repeat(100000)+'末'.repeat(100000),f=fixture(text);
    let args:any={fileName:f.file.path},joined='';
    for(let index=0;index<20;index++){
      const result=await executeToolCall(f.app,'read_note',args,{maxNoteChars:20000});
      expect(result.success).toBe(true);expect((result.content as string).length).toBeLessThanOrEqual(20000);
      joined+=result.content;
      if(!result.continuation)break;
      args=(result.continuation as any).args;
    }
    expect(joined).toBe(text);
  });
  it('returns only a requested heading/line range and never reads a disallowed target',async()=>{
    const f=fixture('# Intro\nprivate\n# Middle\nonly middle\n# End\nlast');
    const heading=await executeToolCall(f.app,'read_note',{fileName:f.file.path,heading:'Middle'});
    expect(heading.content).toBe('# Middle\nonly middle\n');
    const line=await executeToolCall(f.app,'read_note',{fileName:f.file.path,startLine:6,endLine:6});
    expect(line.content).toBe('last');
    f.read.mockClear();
    expect((await executeToolCall(f.app,'read_note',{fileName:f.file.path,startOffset:0},{limitVaultToolScope:true,vaultToolAllowedFolders:['Other']})).success).toBe(false);
    expect(f.read).not.toHaveBeenCalled();
  });
  it('rejects stale continuation and advertises exact range parameters',async()=>{
    const f=fixture('first');
    expect((await executeToolCall(f.app,'read_note',{fileName:f.file.path,startOffset:0,sourceHash:'stale'})).success).toBe(false);
    expect(getHostVaultTools().find(tool=>tool.name==='read_note')?.parameters.properties).toHaveProperty('startOffset');
  });
});
