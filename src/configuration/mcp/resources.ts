import type {ConfigurationService} from '../service';
import {ConfigurationError} from '../types';
import {getDocumentationIndex,getFieldKnowledge,fieldDocumentation} from '../knowledge';
import {getSetupGuidance,setupGuidanceMarkdown} from '../onboarding';
import {configurationGuide} from './tools';
export const CONFIGURATION_INSTRUCTIONS='先调用 configuration_status。空配置先了解用途、模型位置、隐私、预算和资料，解释推荐起点、影响和验证；已知答案不重复问。优先 detail=summary 或 fieldPaths 定向读取。字段详解按需读 llmhubpp://docs/field/{path}。仅有 tools 的客户端也可从 status.setup.guidance 开始。密钥请用户本地填写；保留现有模型、资料、索引与自定义能力。配置经 preview→apply→verify/status；高风险回执绑定同一预览，不代表可证明人类同意。probe 只元数据/握手，check 可受信更新验证；禁止把保存当作可用。内容执行、推理、转换和索引重建需另有授权；不自动安装或迁移。';
export function listConfigurationResources(){return {resources:[
 {uri:'llmhubpp://configuration/guide',name:'Agent configuration guide',title:'Agent 配置流程',mimeType:'text/markdown'},
 {uri:'llmhubpp://configuration/onboarding',name:'setup-guidance',title:'首次协作配置',mimeType:'text/markdown'},
 {uri:'llmhubpp://docs/index',name:'configuration-docs-index',title:'配置文档导航',mimeType:'text/markdown'},
]};}
export function listConfigurationResourceTemplates(){return {resourceTemplates:[{uriTemplate:'llmhubpp://docs/field/{path}',name:'configuration-field',title:'按字段读取配置详解',description:'path 使用 configuration_describe 返回的公开字段路径，含集合 *；按 URI 编码，不是磁盘路径。',mimeType:'text/markdown'}]};}
export function readConfigurationResource(service:ConfigurationService,uri:unknown){
 if(typeof uri!=='string'||uri.length>2048)throw new ConfigurationError('unknown-resource');
 let text:string;
 if(uri==='llmhubpp://configuration/guide')text=configurationGuide(service);
 else if(uri==='llmhubpp://configuration/onboarding')text=setupGuidanceMarkdown(getSetupGuidance({model:{ready:false,suggestions:[]},setup:{}}));
 else if(uri==='llmhubpp://docs/index'){
  const fields=getDocumentationIndex(service.describe()),topics=[...new Set(fields.map(field=>field.userTopic))];
  text='# 配置文档导航\n\n先 configuration_status，再定向 configuration_describe。\n\n'+topics.map(topic=>'- 用户指南：help:'+topic).join('\n')+'\n\n字段详文：llmhubpp://docs/field/{path}。用 describe 的 helpUri 惰性读取，无需加载全部字段。';
 }else if(uri.startsWith('llmhubpp://docs/field/')){
  let path:string;try{path=decodeURIComponent(uri.slice('llmhubpp://docs/field/'.length));}catch{throw new ConfigurationError('unknown-resource');}
  if(!/^[a-zA-Z0-9_.*-]+$/.test(path)||path.includes('..'))throw new ConfigurationError('unknown-resource');
  text=fieldDocumentation(getFieldKnowledge(path,service.describe()));
 }else throw new ConfigurationError('unknown-resource');
 return {contents:[{uri,mimeType:'text/markdown',text}]};
}
