import {it,expect} from 'vitest';
import {inspectHotkeyConflict} from './hotkeyConflicts';
it('uses effective binding overrides and reports conflicts without stealing them',()=>{
 const commands={palette:{id:'palette',name:'命令面板',hotkeys:[{modifiers:['Mod'],key:'P'}]},'llmhubpp:search':{id:'llmhubpp:search',name:'Search'}};
 const result=inspectHotkeyConflict('llmhubpp:search',{modifiers:['Ctrl'],key:'p'},{commands,bindings:{palette:[{modifiers:['Mod'],key:'P'}]},platform:'windows',available:true});expect(result.conflicts[0].name).toBe('命令面板');
 expect(inspectHotkeyConflict('llmhubpp:search',{modifiers:['Ctrl'],key:'p'},{commands,bindings:{palette:[]},platform:'windows',available:true}).conflicts).toEqual([]);
 expect(inspectHotkeyConflict('llmhubpp:search',{modifiers:[],key:'p'},{commands,bindings:{},available:false}).checked).toBe(false);
});
