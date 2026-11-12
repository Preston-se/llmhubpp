import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({calls:[] as string[],release:undefined as undefined|(()=>void),waiting:Promise.resolve()}));
vi.mock('./plugin',()=>({LlmHubPlugin:class {
  app:any;manifest:any;settings={workspaceFolder:'LLMHub'};ready=Promise.resolve();
  constructor(app:any,manifest:any){this.app=app;this.manifest=manifest;}
  onload(){state.calls.push('host');} onunload(){state.calls.push('host-unloaded');}
  loadCSS(){state.calls.push('css');return Promise.resolve();}
  addChild(child:any){child.load();} register(){}
  initializeConfiguration(){state.calls.push('configuration');return Promise.resolve();}
}}));
vi.mock('./safeguard/runtime.js',()=>({default:class {
  ready=state.waiting;
  load(){state.calls.push('guard');} unload(){state.calls.push('guard-unloaded');}
}}));
vi.mock('./migration/unifiedStorage',()=>({initializeUnifiedStorage:async()=>{}}));
vi.mock('./migration/legacyHotkeys',()=>({migrateLegacyHotkeys:async()=>false}));
vi.mock('./migration/installPreset',()=>({installInboxPreset:async()=>{}}));
vi.mock('./configuration/recovery',()=>({recoverConfigurationFiles:async()=>{state.calls.push('recovery');return true;}}));
import {UnifiedPlugin} from './unifiedPlugin';
describe('Obsidian startup stylesheet timing',()=>{
 beforeEach(()=>{state.calls=[];state.waiting=new Promise<void>(resolve=>{state.release=resolve;});});
 const plugin=()=>new UnifiedPlugin({plugins:{enabledPlugins:new Set()},vault:{adapter:{},configDir:'.obsidian'}} as any,{dir:'.obsidian/plugins/llmhubpp'} as any);
 it('loads CSS before waiting for proxy startup, even if the listener is delayed',async()=>{
  const p=plugin(),loading=p.onload();
  await new Promise(r=>setTimeout(r,0));
  try {expect(state.calls[0]).toBe('css');expect(state.calls).toContain('guard');}
  finally{state.release!();await loading;}
 });
 it('does not insert duplicate CSS when Obsidian calls loadCSS after onload',async()=>{
  const p=plugin(),loading=p.onload();state.release!();await loading;
  await p.loadCSS();await p.loadCSS();
  expect(state.calls.filter(c=>c==='css')).toHaveLength(1);
 });
 it('checks pending recovery before host startup and drains configuration before explicit teardown',async()=>{
  const p=plugin();state.release!();await p.onload();expect(state.calls.indexOf('recovery')).toBeLessThan(state.calls.indexOf('host'));
  let done!:()=>void;(p as any).configuration={dispose:()=>new Promise<void>(r=>{done=r;})};p.onunload();expect(state.calls).not.toContain('host-unloaded');done();await new Promise(r=>setTimeout(r,0));expect(state.calls).toContain('host-unloaded');
 });
});
