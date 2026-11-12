import {ConfigurationError} from '../types';
import {getSetupGuidance,validateSetupAnswers} from '../onboarding';
const PROMPTS=[
 {name:'first-setup',title:'首次合理配置',description:'先问最多五类核心问题，解释推荐方案，保留已有配置；高级项按需。',arguments:[{name:'answers',description:'已知核心答案 JSON，可省略；禁止密钥。',required:false}]},
 {name:'repair-model',title:'修复失效模型选择',description:'诊断原模型身份、依赖与验证，目标明确后只生成修复预览。',arguments:[]},
 {name:'merge-restore',title:'合并或恢复配置',description:'核对模块、路径冲突和凭据缺项，通过原预览事务恢复。',arguments:[]},
];
export function listConfigurationPrompts(){return {prompts:structuredClone(PROMPTS)};}
export async function getConfigurationPrompt(params:Record<string,unknown>,status:(answers?:unknown)=>Promise<unknown>){
 const prompt=PROMPTS.find(item=>item.name===params.name);
 if(!prompt||Object.keys(params).some(key=>!['name','arguments'].includes(key)))throw new ConfigurationError('invalid-arguments');
 const args=params.arguments??{};
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!prompt.arguments.some(arg=>arg.name===key)))throw new ConfigurationError('invalid-arguments');
 let task:string;
 if(prompt.name==='first-setup'){
  const value:unknown=Reflect.get(args,'answers');let answers:unknown;
  if(value!==undefined){if(typeof value!=='string'||value.length>4096)throw new ConfigurationError('invalid-arguments');try{answers=JSON.parse(value) as unknown;}catch{throw new ConfigurationError('invalid-arguments');}}
  validateSetupAnswers(answers);const current=await status(answers) as Record<string,unknown>,guidance=getSetupGuidance(current,answers);
  task='协助用户合理配置 Llmhub++。只问 guidance.questions 中尚缺的核心问题；不要重复已知答案。逐项解释用途、推荐起点、适用原因、倾向影响和何时再调。先给短提案；已有范围授权无需重复问普通字段。密钥请用户在插件本地填写密钥，不贴聊天。保留旧配置/模型/索引/自定义能力，不运行推理、转换或重建。\n\n'+JSON.stringify(guidance,null,2);
 }else if(prompt.name==='repair-model')task='先 configuration_status 和 configuration_resolve_model，说明请求身份与 fallback 的区别。缺服务/禁用/模型未启用/验证过期分别处理，不静默新建 Provider。让用户明确目标或沿用已授权目标，configuration_repair 只生成预览；原 apply 保存后 verify/status，必要时显式 check。保留其他配置，不重建索引。';
 else task='先说明是本次运行 restore 还是跨重载配置包合并。普通包不含密钥；本地解锁加密包，不上传口令。只合并选定模块，核对目录映射、缺失依赖和自定义资源冲突；检查目标资源后选择保留或另存，不自动覆盖。import_preview/restore 的风险预览需核对授权，再 apply、verify/status；不能在线应用的给本地步骤。原件、模型和索引不迁移。';
 return {description:prompt.description,messages:[{role:'user',content:{type:'text',text:task}}]};
}
