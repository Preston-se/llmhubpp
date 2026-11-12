import { DEFAULT_RAG_SETTING } from '../types';
import { DEFAULT_REQUEST_CONTROLS } from '../core/requestUsage';
import { ConfigurationError, type ConfigDescriptor, type ConfigSchema } from './types';
import { collectFieldPaths, findFieldPath, type FieldPath } from './schemaPaths';
import { ROOT_DOCUMENTATION, LEAF_DOCUMENTATION, type DocumentationRisk } from './documentationCatalog';
import { DOCUMENTED_FIELD_PATHS } from './documentationPaths';
import { matchesSchema } from './validation';

export interface FieldKnowledge {
 path:string;title:string;summary:string;schema:ConfigSchema;unit?:string;risk:DocumentationRisk;effect:'live'|'reload';keywords:string[];
 readOnly:boolean;sensitive:boolean;readOnlyReason?:string;helpUri:string;anchor:string;userTopic:string;
 recommendation?:{value:unknown;when:string;why:string};impacts:string[];dependencies:string[];verification:string[];pitfalls:string[];
 examples:{value:unknown;when:string}[];
}
export function fieldAnchor(path:string):string{return path.toLowerCase().replace(/\*/g,'entry').replace(/\./g,'-');}
const reviewed=new Set(DOCUMENTED_FIELD_PATHS);
const searchAliases:Record<string,string[]>={
 'settings.localLlmConfigs':['Ollama','LM Studio','本地模型','局域网'],
 'settings.apiProviders':['云端','API','远程模型'],
 'settings.requestControls':['预算','费用','隐私','脱敏','出站'],
 'workspace.ragSettings':['RAG','知识库','索引','嵌入','检索'],
 'settings.ragIndexIdleSeconds':['延时','空闲','编辑后等待','索引'],
 'settings.ragContinueAfterClose':['退出','关闭笔记','索引'],
 'settings.groundedAnswersByDefault':['问答','知识库','本地模型'],
};
const specialImpacts:Record<string,string[]>={
 topK:['更多候选有助于补足分散证据，也可能混入不相关片段。','更少候选可减少上下文和费用，但可能遗漏需要的证据。'],
 scoreThreshold:['提高门槛更严格，可能漏掉换一种说法的资料。','降低门槛更宽松，需检查无关片段是否增加。'],
 chunkSize:['较大文本块保留上下文，但定位更粗、单段负载更大。','较小文本块定位更细，但向量和检索块数可能增加。'],
 chunkOverlap:['增加重叠能减少段落边界遗漏。','重叠过多会增加重复索引和远端上下文；必须小于块长度。'],
 autoUpdateIndex:['开启后，匹配范围的保存会排队调用嵌入服务。','关闭后继续编辑不会自动重建，但仍可手动更新单篇。'],
 ragIndexIdleSeconds:['缩短等待可以更快搜索到新版本。','长时间连续编辑时，较长的等待可减少重复调用。'],
 ragContinueAfterClose:['开启可在关页时选继续等待。','关闭可在关页时选择更新或留到重开。'],
 groundedAnswersByDefault:['开启后，普通文本问题默认检索选定知识库。','关闭后可为当前问题手动开启，或使用阅读右键入口。'],
 monthlyBudgetCny:['提高额度可容纳更多受管付费请求，也允许更高支出。','降低额度更早拦截；外部 CLI、MCP、实时语音费用不包含在内。'],
 maxOutputTokens:['较高上限允许长回答，但需要更多预算预留。','较低上限节省预留，可能使回答被截断。'],
 maxToolRounds:['更多回合可能完成复杂任务，同时增加时间和费用。','较少回合减少循环开销，可能需要用户分段推进任务。'],
 maxContextChars:['较小预算减少外发负载，较早轮次可能不再提供给模型。','本地历史仍完整；最近目标与工具配对超限时会停止而非乱截。'],
 outbound:['从仅本地改为远端策略会扩大资料发送范围；取消确认或脱敏会移除对应保护，须核对风险预览。','收紧为仅本地会限制远端服务；确认与脱敏提供不同保护，互换时需明确取舍。','文字脱敏不能可靠处理图片/PDF 等二进制，需另选发送策略。','无法覆盖所选保护的入口会在本地说明限制并询问范围内例外；同设置、服务、模型和原因下复用决定，可在请求控制中重置。允许例外不会关闭全局保护。'],
 budgetEnabled:['关闭硬预算后，新受管付费请求不再因月度额度或未知费率而被阻止，费用记录仍保留。','开启前需配置完整费率、月度额度与已有支出；外部 CLI、MCP 和实时语音费用独立核对。','本地明确允许的保护例外单独记录为费用未知且不受硬预算覆盖；不得把例外当作受限计费成功。'],
 localOrigins:['扩大受信本地 origin 范围，会让这些服务绕过远端确认、仅本地限制或付费预算预检；先核对服务与实际费用。','删除 origin 会收紧对应豁免，可能使原有局域网服务需要确认或受到预算限制。'],
 redactionRules:['修改或移除使用中的规则可能失去原有保护，规则顺序与替换文字也会影响结果，需先测试合成样本。','文字规则不能保证移除所有秘密，也不能可靠处理二进制附件。'],
 openingBalanceCny:['降低本月启用前支出，会增加硬预算剩余额度；应按账单核对，历史费用记录不因此改写。','提高已有支出会收紧可用额度；仅在启用前支出月份匹配本月时计入。'],
 openingBalanceMonth:['从本月改成其他月份会移除当前预算中的这笔启用前支出，可能扩大可用额度。','其他月份的启用前支出不会重复计入本月，换月后按真实账单登记。'],
 defaultReadOnlyEnabled:['开启时按现有权限边界限制写入，适合资料阅读起点。','关闭可能扩大写能力，只在用户明确需要并授权时调整。'],
};
function risk(field:FieldPath):DocumentationRisk{
 if(field.readOnly)return 'low';
 if(/^settings\.requestControls\.(?:outbound|budgetEnabled|localOrigins|redactionRules|monthlyBudgetCny|openingBalanceCny|openingBalanceMonth)(?:\.|$)/.test(field.path))return 'high';
 if(/^(?:safeGuard\.(?:enabled|listenHost|upstreamBaseUrl|defaultReadOnlyEnabled|enforceProxyReadOnly)|settings\.(?:credentialStorage|cloudVaultToolAllowedFolders|enabledWorkflowEventTriggers)|resources\.files)(?:\.|$)/.test(field.path)
   || /(?:\.autoApprove|\.command|\.args|\.env|\.vaultToolMode|\.(?:codex|claude|gemini)CliPath)$/.test(field.path)
   || /^settings\.(?:mcpServers|agentPlugins)\..*\.(?:enabled|allowedTools)$/.test(field.path)
   || /^settings\.mcpServers\.\*\.(?:env|headers)(?:\.|$)/.test(field.path))return 'high';
 return ROOT_DOCUMENTATION[field.root]?.risk??'medium';
}
function unit(path:string):string|undefined{
 if(/monthlyBudgetCny$/.test(path))return 'CNY/月';
 if(/Cny$|PerMillion$|searchPerRequest$/.test(path))return /PerMillion$/.test(path)?'CNY/百万 Token':'CNY';
 if(/Chars$|chunkSize$|chunkOverlap$/.test(path))return 'JS 字符（UTF-16）';
 if(/Tokens$|maxTokens$/.test(path))return 'Token';
 if(/Seconds$/.test(path))return '秒';
 if(/MB$/.test(path))return 'MiB';
 if(/Ratio$|scoreThreshold$/.test(path))return '比例';
 if(/topK$/.test(path))return '个候选片段';
 return undefined;
}
function suggested(field:FieldPath):FieldKnowledge['recommendation']{
 const leaf=field.path.split('.').filter(part=>part!=='*').pop()!;
 if(field.readOnly||field.sensitive)return;
 if(field.root==='workspace.ragSettings' && ['topK','scoreThreshold','chunkSize','chunkOverlap','pdfChunkPages'].includes(leaf)){
  return {value:Reflect.get(DEFAULT_RAG_SETTING,leaf) as unknown,when:'新建普通文本知识库、缺少实测数据时，先使用当前源码默认起点；已有用户值不覆盖。',why:'先建立可验证基线，再用自己的问题检查遗漏、噪声和上下文开销。'};
 }
 if(field.path==='workspace.ragSettings.*.autoUpdateIndex')return {value:true,when:'新建内部可写索引、嵌入服务已配置且允许后台调用时；旧配置保留用户选择。',why:'让编辑后的笔记及时进入检索；有费用或离线要求时可关闭并手动更新。'};
 if(field.root==='settings.requestControls' && Object.prototype.hasOwnProperty.call(DEFAULT_REQUEST_CONTROLS,leaf)){
  const value:unknown=Reflect.get(DEFAULT_REQUEST_CONTROLS,leaf);
  if(typeof value==='number'||typeof value==='boolean'||leaf==='outbound')return {value,when:'首次配置且用户尚无其他偏好时，先说明当前建议及保护覆盖范围，再按预算和隐私意愿选择。',why:'建议起点来自运行时默认；开启硬预算前补全费率和本月已有支出，不能保证整机总费用。'};
 }
 if(field.path==='safeGuard.defaultReadOnlyEnabled')return {value:true,when:'以资料阅读、检索和问答为主，尚未明确授权写入任务时。',why:'先验证可用性和资料范围，再按真实任务开放写能力。'};
 const value=field.schema.default??(field.path===field.root?field.defaultValue:undefined);
 if(typeof value==='number'||typeof value==='boolean')return {value,when:'尚无实际故障或任务需要时，先保留当前程序默认；已有用户设置优先。',why:'避免在缺少测量或用途依据时同时改变多个参数。'};
 return undefined;
}
function materialize(field:FieldPath):FieldKnowledge|undefined{
 if(!reviewed.has(field.path))return;
 const root=ROOT_DOCUMENTATION[field.root],leaf=field.path.split('.').filter(part=>part!=='*').pop()!;
 if(!root)return;
 const local=field.path===field.root||leaf===field.root.split('.').pop()?root:LEAF_DOCUMENTATION[leaf];
 if(!local)return;
 const summary=local.summary,readOnlyReason=field.readOnly?'由系统维护，不能通过外部 patch 伪造；使用对应检查或原操作更新。':undefined;
 const dependencies=field.root==='workspace.ragSettings' && field.path!==field.root?['workspace.ragSettings'] : field.root==='settings.apiProviders'||field.root==='settings.localLlmConfigs'?['workspace.selectedModel']:[];
 return {path:field.path,title:local.title,summary,schema:field.schema,unit:unit(field.path),risk:risk(field),effect:field.effect,readOnly:field.readOnly,sensitive:field.sensitive,keywords:searchAliases[field.root]??[],
   ...(readOnlyReason?{readOnlyReason}:{}),helpUri:'llmhubpp://docs/field/'+encodeURIComponent(field.path),anchor:fieldAnchor(field.path),userTopic:root.userTopic,
   recommendation:suggested(field),impacts:specialImpacts[leaf]??[summary,field.readOnly?readOnlyReason!:'先保留现有值，按当前用途与验证结果调整，不因接入 Agent 重置其他配置。'],
   dependencies,verification:field.readOnly?['从 configuration_status 或对应原生界面核对系统状态。']:['先 configuration_preview 查看差异，再 apply；按字段生效方式复查状态，网络检查需显式执行。'],
   pitfalls:[field.sensitive?'不要把凭据或秘密正文放进聊天、普通日志、Wiki 或明文导出。':root.summary],
   examples:field.schema.default!==undefined && !field.sensitive?[{value:field.schema.default,when:'此字段的当前源码默认值，仅示例其类型与起点。'}]:[],
 };
}
export function getDocumentationIndex(descriptors:ConfigDescriptor[]):FieldKnowledge[]{return collectFieldPaths(descriptors).flatMap(field=>{const result=materialize(field);return result?[result]:[];});}
export function getFieldKnowledge(path:string,descriptors:ConfigDescriptor[]):FieldKnowledge{
 const field=findFieldPath(collectFieldPaths(descriptors),path), result=field?materialize(field):undefined;
 if(!result)throw new ConfigurationError(field?'documentation-missing':'unknown-field',[],{path});
 return result;
}
function writableSchema(schema:ConfigSchema):ConfigSchema{
 const result=structuredClone(schema);result.readOnly=false;
 for(const[key,child]of Object.entries(result.properties??{}))result.properties![key]=writableSchema(child);
 if(result.items)result.items=writableSchema(result.items);
 if(typeof result.additionalProperties==='object')result.additionalProperties=writableSchema(result.additionalProperties);
 if(result.anyOf)result.anyOf=result.anyOf.map(writableSchema);
 return result;
}
export function validateDocumentationCoverage(paths:FieldPath[],docs:FieldKnowledge[]):{code:string;path:string}[]{
 const declared=new Map(paths.map(field=>[field.path,field])),documented=new Map(docs.map(field=>[field.path,field])),issues:{code:string;path:string}[]=[];
 const add=(code:string,path:string)=>issues.push({code,path});
 for(const field of paths)if(!documented.has(field.path))add('missing-field',field.path);
 for(const field of docs){
  const shape=declared.get(field.path);
  if(!shape){add('orphan-field',field.path);continue;}
  if(!field.title || field.summary?.length<8 || field.summary===field.path.split('.').pop())add('missing-explanation',field.path);
  if(field.dependencies?.some(path=>!declared.has(path)))add('unknown-dependency',field.path);
  const schema=writableSchema(shape.schema);
  if(field.examples?.some(example=>!matchesSchema(example.value,schema)))add('invalid-example',field.path);
  if(field.recommendation && (!field.recommendation.when || field.recommendation.when.length<8 || !field.recommendation.why))add('invalid-recommendation',field.path);
  if(field.recommendation && field.recommendation.value!==undefined && !matchesSchema(field.recommendation.value,schema))add('invalid-recommendation',field.path);
 }
 for(const path of DOCUMENTED_FIELD_PATHS)if(!declared.has(path)&&!issues.some(issue=>issue.path===path))add('orphan-field',path);
 const roots=new Set(paths.map(field=>field.root));
 for(const path of Object.keys(ROOT_DOCUMENTATION))if(!roots.has(path)&&!issues.some(issue=>issue.path===path))add('orphan-field',path);
 return issues;
}
export function fieldDocumentation(field:FieldKnowledge):string{
 const recommendation=field.recommendation?'\n## 推荐起点\n'+JSON.stringify(field.recommendation.value)+'\n\n适用：'+field.recommendation.when+'\n\n原因：'+field.recommendation.why:'';
 return '# '+field.title+'\n\n'+field.summary+'\n\n字段：'+field.path+'\n类型：'+(field.schema.type??'union')+(field.unit?'；单位：'+field.unit:'')+'\n生效：'+field.effect+'；风险：'+field.risk+
   (field.readOnlyReason?'\n只读原因：'+field.readOnlyReason:'')+recommendation+'\n\n## 影响与权衡\n'+field.impacts.map(text=>'- '+text).join('\n')+'\n\n## 依赖\n'+(field.dependencies.length?field.dependencies.map(path=>'- llmhubpp://docs/field/'+encodeURIComponent(path)).join('\n'):'无额外配置依赖。')+'\n\n## 类型与示例\n```json\n'+JSON.stringify(field.schema,null,2)+'\n```\n'+(field.sensitive?'凭据不提供真实示例；请在插件本地填写。':field.examples.length?field.examples.map(example=>JSON.stringify(example.value)+'：'+example.when).join('\n'):field.recommendation?'类型示例：'+JSON.stringify(field.recommendation.value)+'；'+field.recommendation.when:'按上面的类型和当前实体填写；不伪造系统状态。')+'\n\n## 验证\n'+field.verification.map(text=>'- '+text).join('\n')+'\n\n## 注意\n'+field.pitfalls.map(text=>'- '+text).join('\n')+'\n\n用户指南：help:'+field.userTopic+'\n';
}
