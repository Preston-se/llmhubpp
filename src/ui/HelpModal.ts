import { settingsText as tr } from "./settings/settingsText";
import {Component,MarkdownRenderer,Modal} from 'obsidian';
import type {LlmHubPlugin} from '../plugin';
import {HELP_TOPICS,helpTopicTitle} from './helpRoutes';
export class HelpModal extends Modal{
    private component=new Component();
    private articleComponent?:Component;
    private sequence=0;
    private history:{topic:string;scroll:number}[]=[];
    private article?:HTMLElement;
    private closed=false;
    constructor(private plugin:LlmHubPlugin,private topic='index'){super(plugin.app);plugin.configuration?.trackModal(this);}
    onOpen():void{this.closed=false;this.component.load();this.modalEl.addClass('llmhubpp-help-modal');this.setTitle('Llmhub++ · Wiki');void this.render();}
    private navigate(next:string,remember=true,scroll?:number):void{
        const [page,anchor]=next.split('#');
        if(!HELP_TOPICS[page]||anchor&&!/^[a-z0-9-]+$/.test(anchor))return;
        if(remember&&next!==this.topic)this.history.push({topic:this.topic,scroll:this.article?.scrollTop??0});
        this.topic=next;void this.render(scroll);
    }
    private async render(scroll?:number):Promise<void>{
        const sequence=++this.sequence,root=this.contentEl;
        this.articleComponent&&this.component.removeChild(this.articleComponent);
        this.articleComponent=this.component.addChild(new Component());
        root.empty();root.addClass('llmhubpp-help-content');
        const toolbar=root.createDiv({cls:'llmhubpp-help-toolbar'});
        const back=toolbar.createEl('button',{text:tr("← Back", '← 返回'),attr:{type:'button'}});back.disabled=!this.history.length;
        back.addEventListener('click',()=>{const previous=this.history.pop();if(previous)this.navigate(previous.topic,false,previous.scroll);});
        toolbar.createEl('button',{text:tr("Feature map", '功能地图'),attr:{type:'button'}}).addEventListener('click',()=>this.navigate('index'));
        const select=toolbar.createEl('select',{attr:{'aria-label':tr("Choose a Wiki topic", '选择 Wiki 主题')}});
        for(const id of Object.keys(HELP_TOPICS))select.createEl('option',{text:helpTopicTitle(id),value:id});
        select.value=this.topic.split('#')[0];select.addEventListener('change',()=>this.navigate(select.value));
        const contents=root.createEl('details',{cls:'llmhubpp-help-toc'});
        contents.createEl('summary',{text:tr("On this page", '本页目录')});
        const nav=contents.createEl('nav',{attr:{'aria-label':tr("On this page", '本页目录')}});
        const article=root.createDiv({cls:'llmhubpp-help-article markdown-rendered'});this.article=article;
        // Topics are allowlisted. Read assets from the installed package so the Wiki also works offline.
        const path=this.plugin.manifest.dir+'/resources/help/'+this.topic.split('#')[0]+'.md';
        try{
            const text=await this.app.vault.adapter.read(path);
            if(this.closed||sequence!==this.sequence)return;
            // Resolve packaged images in place; preserve their order and proximity to the relevant steps.
            const markdown=text.replace(/!\[([^\]]*)\]\(images\/([a-z0-9-]+\.svg)\)/g,(_all,alt:string,file:string)=>
                '!['+alt+']('+this.app.vault.adapter.getResourcePath(this.plugin.manifest.dir+'/resources/help/images/'+file)+')');
            await MarkdownRenderer.render(this.app,markdown,article,path,this.articleComponent);
            if(this.closed||sequence!==this.sequence)return;
            let number=0;
            for(const heading of Array.from(article.querySelectorAll('h2,h3'))){
                const previous=heading.previousElementSibling,anchor=previous?.id||previous?.querySelector('a[id]')?.id;
                const id=anchor||heading.id||'section-'+(++number);
                if(!anchor)heading.id=id;
                const link=nav.createEl('a',{text:heading.textContent??tr("Section", '章节'),href:'#'+id});
                if(heading.tagName==='H3')link.addClass('llmhubpp-help-toc-sub');
                link.addEventListener('click',event=>{event.preventDefault();article.querySelector('[id="'+id.replace(/["\\]/g,'')+'"]')?.scrollIntoView({block:'start'});});
            }
            if(!nav.childElementCount)contents.hidden=true;
            for(const image of Array.from(article.querySelectorAll('img'))){image.removeAttribute('width');image.removeAttribute('height');image.loading='lazy';}
            const anchor=this.topic.split('#')[1];
            if(scroll!==undefined)article.scrollTop=scroll;
            else if(anchor&&/^[a-z0-9-]+$/.test(anchor))article.querySelector('[id="'+anchor+'"]')?.scrollIntoView({block:'start'});
        }catch{if(sequence===this.sequence)article.setText(tr("Help is unavailable. Check that you installed the full package.", '帮助资源暂不可用，请检查安装包是否完整。'));}
        article.addEventListener('click',event=>{
            const target=event.target instanceof Element?event.target:null,link=target?.closest('a');
            const href=link?.getAttribute('href')??link?.getAttribute('data-href')??'';
            if(href.startsWith('help:')){event.preventDefault();event.stopPropagation();this.navigate(href.slice(5));}
            else if(href.startsWith('settings:')){event.preventDefault();event.stopPropagation();void import('./SettingsTab').then(({SettingsTab})=>new SettingsTab(this.app,this.plugin).openSection(href.slice(9)));}
            else if(/^#[a-z0-9-]+$/.test(href)){event.preventDefault();event.stopPropagation();article.querySelector('[id="'+href.slice(1)+'"]')?.scrollIntoView({block:'start'});}
        });
    }
    onClose():void{this.closed=true;this.sequence++;this.component.unload();this.contentEl.empty();}
}
