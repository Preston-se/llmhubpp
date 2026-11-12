
import { TFile, type App } from 'obsidian';
import { resolveNoteFile, isVaultTextFile } from 'obsidian-llm-hub-common/vault';
import { isPathInAllowedVaultFolders, VAULT_TOOL_SCOPE_DENIED_MSG } from 'obsidian-llm-hub-common/core';
import type { ToolExecutionContext, ToolResult } from './toolExecutor';
import { ragDigest } from 'src/core/localRagStorage';
export const READ_NOTE_RANGE_PROPERTIES = {
  startOffset: { type:'integer', description:'Zero-based UTF-16 offset, supplied by continuation. Do not combine with a line range or heading.' },
  endOffset: { type:'integer', description:'Exclusive end offset for the selected range.' },
  sourceHash: { type:'string', description:'Source hash from a previous read; prevents continuing across changed file contents.' },
  heading: { type:'string', description:'Exact Markdown heading title. Reads that section only; ambiguous titles are rejected.' },
  maxChars: { type:'integer', description:'Optional smaller character budget. A larger value cannot exceed the configured per-read limit.' },
};
/** Preserves original permission checks; reads locally in full but returns only the selected, budgeted slice. */
export async function readNoteRange(app:App,args:Record<string,unknown>,context?:ToolExecutionContext):Promise<ToolResult|null> {
  const name=typeof args.fileName==='string'?args.fileName:undefined;
  const file=args.activeNote?app.workspace.getActiveFile():name?resolveNoteFile(app,name):null;
  if(!(file instanceof TFile)||!isVaultTextFile(file))return null;
  if(context?.limitVaultToolScope&&context.vaultToolAllowedFolders?.length&&!isPathInAllowedVaultFolders(file.path,context.vaultToolAllowedFolders))
    return {success:false,error:VAULT_TOOL_SCOPE_DENIED_MSG,allowedFolders:[...context.vaultToolAllowedFolders]};
  if(args.startPage!==undefined||args.endPage!==undefined)return null;
  const integer=(key:string)=>args[key]===undefined?undefined:Number(args[key]);
  const startLine=integer('startLine'),endLine=integer('endLine'),startOffset=integer('startOffset'),endOffset=integer('endOffset'),requested=integer('maxChars');
  if([startLine,endLine,requested].some(value=>value!==undefined&&(!Number.isSafeInteger(value)||value<1))
    ||[startOffset,endOffset].some(value=>value!==undefined&&(!Number.isSafeInteger(value)||value<0)))
    return {success:false,error:'Range values must be valid nonnegative offsets or positive line numbers/budgets.'};
  const heading=typeof args.heading==='string'?args.heading:undefined;
  if((startOffset!==undefined&&(startLine!==undefined||endLine!==undefined||heading!==undefined))||(heading!==undefined&&(startLine!==undefined||endLine!==undefined)))
    return {success:false,error:'Choose one offset, line range or heading.'};
  const text=await app.vault.read(file),sourceHash=await ragDigest(text);
  if(args.sourceHash!==undefined&&args.sourceHash!==sourceHash)return {success:false,path:file.path,error:'The source changed; read the desired range again before continuing.'};
  const lines=text.split('\n'),offsets=[0]; for(let i=0;i<lines.length;i++)offsets.push(offsets[i]+lines[i].length+1);
  let from=startOffset??0,to=endOffset??text.length;
  if(startLine!==undefined||endLine!==undefined){
    if((startLine??1)>(endLine??lines.length))return {success:false,error:'startLine must not exceed endLine.'};
    from=offsets[Math.min((startLine??1)-1,lines.length)]??text.length;
    to=Math.min(text.length,offsets[Math.min(endLine??lines.length,lines.length)]??text.length);
  }
  if(heading!==undefined){
    const headings:Array<{title:string;level:number;at:number}>=[];let fence='';
    lines.forEach((line,index)=>{
      const boundary=line.match(/^\s{0,3}(\x60{3,}|~{3,})/);
      if(boundary){if(!fence)fence=boundary[1];else if(boundary[1][0]===fence[0]&&boundary[1].length>=fence.length)fence='';return;}
      const match=!fence&&line.match(/^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
      if(match)headings.push({title:match[2],level:match[1].length,at:offsets[index]});
    });
    const matches=headings.filter(item=>item.title===heading);
    if(matches.length!==1)return {success:false,path:file.path,error:matches.length?'Heading is ambiguous; use a line range.':'Heading not found.'};
    const selected=matches[0];from=selected.at;
    to=headings.find(item=>item.at>from&&item.level<=selected.level)?.at??text.length;
  }
  if(from>text.length||to>text.length||from>to)return {success:false,path:file.path,error:'Requested range is outside the document.'};
  const configured=Math.max(1,Math.min(1000000,context?.maxNoteChars??20000));
  const limit=Math.min(configured,requested??configured);
  let end=Math.min(to,from+limit);
  if(end<to&&end>from&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff)end--;
  if(end===from&&to>from)end=Math.min(to,from+2);
  const startLineNumber=offsets.findIndex(offset=>offset>from),endLineNumber=offsets.findIndex(offset=>offset>=end);
  return {success:true,path:file.path,content:text.slice(from,end),sourceHash,startOffset:from,endOffset:end,totalChars:text.length,
    startLine:startLineNumber<0?lines.length:startLineNumber,endLine:endLineNumber<0?lines.length:Math.max(1,endLineNumber),totalLines:lines.length,
    truncated:end<to,remainingChars:to-end,...(end<to?{continuation:{tool:'read_note',args:{fileName:file.path,startOffset:end,endOffset:to,sourceHash}}}:{})};
}
