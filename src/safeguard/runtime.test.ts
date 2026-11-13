import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url);
class Component { load(){(this as any).onload?.();} unload(){(this as any).onunload?.();} }
class Plugin extends Component {}
const load=(file:string,overrides:Record<string,unknown>={})=>{
  const context={module:{exports:{}},require:(id:string)=>overrides[id]??(id==='obsidian'?{Component,Plugin,PluginSettingTab:class{},Modal:class{},Setting:class{},Notice:class{},normalizePath:(p:string)=>p}:require(id)),console,setTimeout,clearTimeout,URL};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
  return context.module.exports as any;
};
describe('Safe Guard internalization equivalence',()=>{
  const Legacy=load('vendor/safe-guard-0.6.2.js');
  const Unified=load('src/safeguard/runtime.js');
  it('refuses configuration restart when a proxy response is still active',async()=>{
    const guard=new Unified({manifest:{},app:{}});guard.settings={listenHost:'127.0.0.1',listenPort:11435};guard.configurationActiveRequests=1;
    let restarts=0;guard.restartProxy=async()=>{restarts++;};
    expect(await guard.reloadConfigurationProxy?.()).toMatchObject({applied:false,reason:'busy'});expect(restarts).toBe(0);
  });
  it('retains every original business method byte-for-byte',()=>{
    const ignored=new Set(['constructor','onload','getLlmHubPlugin','onunload','startProxy']);
    let compared=0;
    for(const name of Object.getOwnPropertyNames(Legacy.prototype)){
      if(ignored.has(name))continue;
      expect(Unified.prototype[name]?.toString().replace(/\r\n/g,'\n'),name).toBe(Legacy.prototype[name].toString().replace(/\r\n/g,'\n'));compared++;
    }
    expect(compared).toBeGreaterThan(110);
    expect(Unified.prototype.onunload.toString().replace(/\r\n/g,'\n').replace('    this.disposed = true;\n','')).toBe(Legacy.prototype.onunload.toString().replace(/\r\n/g,'\n'));
    const original=Legacy.prototype.onload.toString().replace(/^async onload\(\)/,'async initialize()');
    expect(Unified.prototype.initialize.toString().replace(/\r\n/g,'\n').replace('    if (this.disposed) return;\n','').replace('    if (this.disposed || this.isUnloading) return;\n','')).toBe(original.replace(/\r\n/g,'\n'));
  });
  it('directly owns the host and serializes independent settings writes',async()=>{
    const files=new Map([['plugin/data.json','{"host":true}']]);let active=0,max=0;
    const host={manifest:{dir:'plugin',version:'0.36.7'},app:{vault:{adapter:{write:async(p:string,text:string)=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));files.set(p,text);active--;}}}}};
    const guard=new Unified(host);
    expect(guard.getLlmHubPlugin()).toBe(host);
    const data={routerEnabled:false,custom:{future:42}};
    const first=guard.saveData(data);data.routerEnabled=true;
    await Promise.all([first,guard.saveData(data)]);
    expect(max).toBe(1);
    expect(JSON.parse(files.get('plugin/safe-guard.json')!)).toEqual(data);
    expect(files.get('plugin/data.json')).toBe('{"host":true}');
  });
  it('does not resurrect observers or fetch hooks if unloaded during async proxy startup',async()=>{
    const guard=new Unified({manifest:{dir:'plugin'},app:{}});
    guard.loadData=async()=>null;guard.addSettingTab=()=>{};
    let release!:(value:boolean)=>void;
    guard.startProxy=()=>new Promise<boolean>(r=>{release=r;});
    let setup=0,hooks=0;
    guard.setupVaultModeGuard=()=>setup++;
    guard.installDirectProviderVisionHook=()=>hooks++;
    const initializing=guard.initialize();
    await new Promise(r=>setTimeout(r,0));
    await guard.onunload();release(false);await initializing;
    expect(setup).toBe(0);expect(hooks).toBe(0);
  });
  it('closes a server whose listen completes after the component has unloaded',async()=>{
    const server=Object.assign(new EventEmitter(),{listening:false,listen(){},close(callback?:()=>void){this.listening=false;callback?.();}});
    const Runtime=load('src/safeguard/runtime.js',{'http':{createServer:()=>server}});
    const guard=new Runtime({manifest:{dir:'plugin'},app:{}});
    guard.loadData=async()=>null;guard.addSettingTab=()=>{};
    guard.setupVaultModeGuard=()=>{};guard.installDirectProviderVisionHook=()=>{};
    const initializing=guard.initialize();await new Promise(r=>setTimeout(r,0));
    await guard.onunload();server.listening=true;server.emit('listening');await initializing;
    expect(server.listening).toBe(false);
  });
});

it.each([['en', 'Enable safety checks', 'Save and apply'], ['zh', '启用安全检查', '保存并应用']])(
  'renders the installed Safe Guard settings in %s', async (locale, enabled, apply) => {
    const labels: string[] = [];
    const root = {
      empty() {}, setText(value: string) { labels.push(value); },
      createEl(_tag: string, options?: { text?: string }) { if (options?.text) labels.push(options.text); return root; },
      createSpan(options?: { text?: string }) { return root.createEl('span', options); },
      createDiv() { return root; },
    };
    class SettingTab { containerEl = root; }
    class Setting {
      setName(name: string) { labels.push(name); return this; }
      setDesc() { return this; } addToggle() { return this; } addText() { return this; } addDropdown() { return this; }
      setButtonText(name: string) { labels.push(name); return this; }
      setCta() { return this; } setWarning() { return this; } onClick() { return this; }
      addButton(render: (button: Setting) => void) { render(new Setting()); return this; }
    }
    const Runtime = load('src/safeguard/runtime.js', {
      obsidian: { Component, Plugin, PluginSettingTab: SettingTab, Modal: class {}, Setting, Notice: class {}, normalizePath: (p: string) => p },
    });
    let tab: { display(): void } | undefined;
    const guard = new Runtime({ manifest: {}, app: {}, addSettingTab(value: typeof tab) { tab = value; } },
      (english: string, chinese: string) => locale === 'zh' ? chinese : english);
    guard.loadData = async () => null;
    guard.startProxy = async () => false;
    guard.setupVaultModeGuard = () => {};
    guard.installDirectProviderVisionHook = () => {};
    guard.getAdvancedRoute = () => null;
    guard.getCompressionModelOptions = () => [];
    guard.getContextState = () => ({});
    guard.getContextHealth = () => ({ modelLabel: 'Synthetic model', ratio: 0, level: 'healthy' });
    await guard.initialize();
    tab!.display();
    expect(labels).toEqual(expect.arrayContaining([enabled, apply]));
  },
);
