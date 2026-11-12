import {ConfigurationError} from './types';
import {getFieldKnowledge} from './knowledge';
import {createRegistry} from './registry';
export const CORE_SETUP_QUESTIONS=[
 {id:'purpose',title:'主要用来做什么？',explanation:'用途决定是否需要知识库、视觉模型或自动化；先完成一个常见任务，再展开高级项。',options:[{value:'chat',label:'普通聊天',impact:'先配聊天模型即可。'},{value:'notes',label:'资料阅读与检索',impact:'还需选择资料范围和嵌入服务。'},{value:'images',label:'图片与复杂资料',impact:'要验证视觉或文字解析能力及图片外发。'},{value:'automation',label:'工作流与自动化',impact:'工具权限和执行任务需要单独授权。'}]},
 {id:'modelLocation',title:'使用哪里的模型或已有服务？',explanation:'本机/局域网需已有运行服务；云端需要账号与外发许可。插件不会自动安装或下载模型。',options:[{value:'local',label:'本机已有模型',impact:'可减少资料出站，能力和速度取决于本机。'},{value:'lan',label:'局域网服务',impact:'需明确服务地址及是否属于受信本地 origin。'},{value:'cloud',label:'云端 API',impact:'资料会发送给服务商，需核对费用与隐私。'},{value:'mixed',label:'按任务混用',impact:'区分本地与云端用途，不静默切换服务。'},{value:'existing',label:'沿用已有配置',impact:'先诊断和验证，保留模型列表与当前值。'}]},
 {id:'privacy',title:'资料允许怎样发送和修改？',explanation:'先说明资料会去哪里。只读限制库写入，不等于禁止外发；文字脱敏不能可靠处理图片或 PDF。',options:[{value:'local-only',label:'仅本地发送',impact:'远端调用会被拦截，局域网需明确加入受信 origin。'},{value:'confirm',label:'远端发送前确认',impact:'便于核对正文，二进制不能按文字预检。'},{value:'redact',label:'规则脱敏',impact:'需先测试规则，不能保证去除所有秘密。'},{value:'unchanged',label:'沿用原发送方式',impact:'不改变外发正文，需用户理解所选服务。'}]},
 {id:'budget',title:'是否付费，以及本月预算和已有支出？',explanation:'硬预算只覆盖受管 HTTP；需实际人民币费率与已有支出。未知费率会拦截，CLI、MCP 和实时语音另计。',options:[{value:'free-local',label:'先用本地或免费服务',impact:'不自动启用硬预算，服务商收费仍需另核对。'},{value:'paid-capped',label:'付费并设上限',impact:'先填预算、已有支出和费率，预留输出费用。'},{value:'review',label:'先解释再决定',impact:'保留现有设置，不把未知费用当作免费。'}]},
 {id:'materials',title:'要处理哪些资料，是否已有索引？',explanation:'明确格式、目录和规模，优先保留原件与旧索引；转换、同步和重建是独立执行任务。',options:[{value:'existing-index',label:'沿用已有索引',impact:'先查可读性和兼容性，不重新迁移。'},{value:'new-text',label:'新的文字资料',impact:'先小范围验证解析与检索，再扩大范围。'},{value:'complex-files',label:'PDF、图片或复杂文件',impact:'先看解析质量，扫描件可能需要另行 OCR。'},{value:'none',label:'暂不使用资料库',impact:'普通聊天可先完成，稍后再补知识库。'}]},
] as const;
export const SETUP_ANSWER_SCHEMA={type:'object',properties:{
 purpose:{enum:CORE_SETUP_QUESTIONS[0].options.map(x=>x.value)},modelLocation:{enum:CORE_SETUP_QUESTIONS[1].options.map(x=>x.value)},privacy:{enum:CORE_SETUP_QUESTIONS[2].options.map(x=>x.value)},materials:{enum:CORE_SETUP_QUESTIONS[4].options.map(x=>x.value)},
 budget:{type:'object',properties:{paid:{type:'boolean'},monthlyCny:{type:'number',minimum:0},spentCny:{type:'number',minimum:0}},required:['paid'],additionalProperties:false},
},additionalProperties:false};
import {assertSafe,matchesSchema} from './validation';
type RecordValue=Record<string,unknown>;
const record=(value:unknown):RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as RecordValue:{};
export function validateSetupAnswers(value:unknown):RecordValue{
 if(value===undefined)return {};
 assertSafe(value);if(!matchesSchema(value,SETUP_ANSWER_SCHEMA))throw new ConfigurationError('invalid-arguments');
 return value as RecordValue;
}
export function getSetupGuidance(status:RecordValue,rawAnswers?:unknown){
 const answers={...validateSetupAnswers(rawAnswers)},model=record(status.model),setup=record(status.setup),existing=record(setup.existing),suggestions=Array.isArray(model.suggestions)?model.suggestions as string[]:[];
 if(!answers.modelLocation&&existing.modelLocation)answers.modelLocation=existing.modelLocation;
 if(!answers.materials&&existing.ragConfigured)answers.materials='existing-index';
 if(answers.purpose==='chat'&&!answers.materials)answers.materials='none';
 const repair=model.ready!==true&&suggestions.length>0;
 const missingRag=setup.reason==='RAG_CONFIGURATION_MISSING';
 const budgetAnswer=record(answers.budget),missingBudget=budgetAnswer.paid===true&&(budgetAnswer.monthlyCny===undefined||budgetAnswer.spentCny===undefined);
 const questions=model.ready===true&&!missingRag||repair?[]:CORE_SETUP_QUESTIONS.filter(question=>!(question.id==='modelLocation'&&model.ready===true)&&(answers[question.id]===undefined||question.id==='budget'&&missingBudget)).map(question=>question.id==='budget'&&answers.budget!==undefined?{...question,title:'还需要哪些预算金额和启用前支出？',explanation:'已知道你会使用付费服务；只补充尚缺的月度上限与此前支出，未知费用不当免费。'}:question);
 const registry=createRegistry(),paths=['safeGuard.defaultReadOnlyEnabled','settings.requestControls.maxOutputTokens','settings.requestControls.maxToolRounds'];
 if(answers.purpose==='notes'||answers.purpose==='images')paths.push('workspace.ragSettings.*.topK','workspace.ragSettings.*.chunkSize','workspace.ragSettings.*.autoUpdateIndex');
 if(answers.privacy)paths.push('settings.requestControls.outbound');
 if(answers.budget)paths.push('settings.requestControls.budgetEnabled','settings.requestControls.monthlyBudgetCny');
 const currentValues=record(existing.values);
 const recommendations=paths.map(path=>{
  const field=getFieldKnowledge(path,registry),recommendation=field.recommendation;
  const budget=record(answers.budget);
  const explicit=path.endsWith('.outbound')&&answers.privacy!==undefined||path.endsWith('.budgetEnabled')&&answers.budget!==undefined||path.endsWith('.monthlyBudgetCny')&&typeof budget.monthlyCny==='number';
  const keep=!explicit&&currentValues[path]!==undefined;
  const value=keep?currentValues[path]:path.endsWith('.outbound')?answers.privacy:path.endsWith('.budgetEnabled')?budget.paid===true:path.endsWith('.monthlyBudgetCny')&&typeof budget.monthlyCny==='number'?budget.monthlyCny:recommendation?.value;
  return {path,title:field.title,value,action:keep?'keep':'consider',when:keep?'已有用户值且未要求改变该项时，保留现状。':recommendation?.when??'用户已明确此偏好时；未回答就先解释并保留现状。',why:path.endsWith('.budgetEnabled')?'付费上限需配套实际费率和本月已有支出；未知费率会阻止受管调用。':recommendation?.why??field.summary,impacts:field.impacts,helpUri:field.helpUri,requiresUserChoice:questions.length>0};
 });
 return {phase:repair?'repair-selection':model.ready===true&&!missingRag?'review-current':questions.length?'ask-core':'propose',preserveExisting:true,questions,knownAnswers:answers,recommendations,
  credentialInstruction:'请用户在插件本地填写密钥或密码；Agent 只读取 configured/missing，不让用户粘贴秘密到聊天。',
  collaborationRules:['关键选择按“控制什么、推荐起点、适用原因、不同倾向影响、何时再调”说明，不只抛字段名。','先给保留项、新建项、原因、影响和验证的短提案；已有范围授权可直接 preview/apply，普通字段不重复询问。','先 status 与定向 read/describe；候选服务可显式 probe，受管服务用 check。列表成功不等于生成、视觉或嵌入质量通过。','配置不授权转换、同步、重建索引、推理、下载、执行脚本或扩大权限。','有可用候选但当前选择失效时，先 repair，不自动新建同名服务。'],
  proposalOutline:{preserve:['当前配置、模型、原件、旧索引和自定义能力'],configure:recommendations.map(item=>item.path),validation:['明确目标的 metadata/handshake probe（不保存）','已有配置的 check（可记录验证）','apply 后 verify 和 status；真实资料质量单独验证']},
 };
}
export function setupGuidanceMarkdown(guidance:ReturnType<typeof getSetupGuidance>):string{
 return '# 协作配置引导\n\n'+guidance.credentialInstruction+'\n\n'+guidance.collaborationRules.map(text=>'- '+text).join('\n')+'\n\n## 核心选择\n'+CORE_SETUP_QUESTIONS.map(question=>'### '+question.title+'\n'+question.explanation+'\n\n'+question.options.map(option=>'- '+option.label+'：'+option.impact).join('\n')).join('\n\n')+'\n\n## 当前建议\n'+guidance.recommendations.map(item=>'### '+item.title+'\n控制：'+getFieldKnowledge(item.path,createRegistry()).summary+'\n\n推荐起点：'+JSON.stringify(item.value)+'\n\n适用：'+item.when+'\n\n原因：'+item.why+'\n\n'+item.impacts.map(text=>'- '+text).join('\n')+'\n\n详解：'+item.helpUri).join('\n\n')+'\n';
}
