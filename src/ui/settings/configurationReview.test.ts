import {it,expect,vi,beforeEach} from 'vitest';
const h=vi.hoisted(()=>({controls:[] as any[],pre:[] as any[]}));
vi.mock('obsidian',async original=>{
 const base=await original<any>();
 class Element{
  text='';value='';addClass(){}empty(){}setText(value:string){this.text=value;}
  createDiv(){return new Element();}createEl(tag:string){const el=new Element();if(tag==='pre')h.pre.push(el);return el;}
 }
 class Control{
  text='';inputEl=new Element();change:((value:string)=>void)=()=>{};click:()=>unknown=()=>{};
  setButtonText(v:string){this.text=v;return this;}setCta(){return this;}setDisabled(){return this;}setValue(){return this;}addOption(){return this;}
  onChange(fn:(value:string)=>void){this.change=fn;return this;}onClick(fn:()=>unknown){this.click=fn;return this;}
 }
 class Setting{
  constructor(_root:unknown){}setName(){return this;}setDesc(){return this;}
  add(fn:(control:Control)=>void,type:string){const control=new Control();h.controls.push({type,control});fn(control);return this;}
  addDropdown(fn:(control:Control)=>void){return this.add(fn,'dropdown');}addTextArea(fn:(control:Control)=>void){return this.add(fn,'textarea');}addButton(fn:(control:Control)=>void){return this.add(fn,'button');}
 }
 class Modal{contentEl=new Element();constructor(_app:unknown){}setTitle(){}}
 return {...base,Modal,Setting};
});
import {ConfigurationEditorModal} from './ConfigurationEditorModal';
import {configurationFixture} from '../../configuration/configurationFixture.test-utils';
beforeEach(()=>{h.controls=[];h.pre=[];});
async function preview(){
 const f=configurationFixture();f.raw.safeGuard.enabled=true;
 const modal=new ConfigurationEditorModal({app:{},configuration:{service:f.service,trackModal:()=>{}}} as any,'safeGuard');modal.onOpen();
 await vi.waitFor(()=>expect(h.controls.some(item=>item.type==='textarea')).toBe(true));
 h.controls.find(item=>item.type==='textarea').control.change('false');
 h.controls.find(item=>item.control.text==='预览差异').control.click();
 await vi.waitFor(()=>expect(h.pre.at(-1).text).toContain('enabled'));
 return f;
}
it('shows risk explanations in the local configuration preview',async()=>{await preview();expect(h.pre.at(-1).text).toContain('risks');});
it('lets the explicit native apply button submit the same reviewed risk acknowledgment',async()=>{
 const f=await preview();h.controls.find(item=>item.control.text==='应用').control.click();
 await vi.waitFor(()=>expect(f.raw.safeGuard.enabled).toBe(false));expect(f.writes).toEqual(['safeGuard']);
});
