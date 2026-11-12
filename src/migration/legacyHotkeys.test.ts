import {describe,it,expect} from 'vitest';
import {migrateLegacyHotkeys} from './legacyHotkeys';
import type {MigrationFiles} from './unifiedStorage';
describe('legacy shortcut migration',()=>{
 it('backs up exact bytes and copies both plugin prefixes, including workflow IDs',async()=>{
  const raw=JSON.stringify({'llm-hub:open-chat':[{modifiers:['Mod'],key:'L'}],'llm-hub-safe-guard:compress-current-context':[{modifiers:['Alt'],key:'C'}],'llm-hub:workflow-user-custom':[],'other:run':[{key:'X'}]});
  const data=new Map([['cfg/hotkeys.json',raw]]);const order:string[]=[];
  const io:MigrationFiles={exists:async p=>data.has(p),read:async p=>data.get(p)!,mkdir:async()=>{},write:async(p,t)=>{order.push(p);data.set(p,t);}};
  expect(await migrateLegacyHotkeys(io,'cfg','plugin')).toBe(true);
  const result=JSON.parse(data.get('cfg/hotkeys.json')!);
  expect(result['llmhubpp:open-chat']).toEqual([{modifiers:['Mod'],key:'L'}]);
  expect(result['llmhubpp:compress-current-context']).toEqual([{modifiers:['Alt'],key:'C'}]);
  expect(result['llmhubpp:workflow-user-custom']).toEqual([]);
  expect(result['other:run']).toEqual([{key:'X'}]);
  expect(data.get('plugin/legacy-backup/hotkeys.json')).toBe(raw);
  expect(order.at(-1)).toBe('cfg/hotkeys.json');
 });
 it('respects an existing new binding, keeps old bindings, and is idempotent',async()=>{
  const raw=JSON.stringify({'llm-hub:open-chat':[{key:'A'}],'llmhubpp:open-chat':[]});
  const data=new Map([['cfg/hotkeys.json',raw]]);
  const io:MigrationFiles={exists:async p=>data.has(p),read:async p=>data.get(p)!,mkdir:async()=>{},write:async(p,t)=>{data.set(p,t);}};
  expect(await migrateLegacyHotkeys(io,'cfg','plugin')).toBe(false);
  expect(data.get('cfg/hotkeys.json')).toBe(raw);
 });
});
