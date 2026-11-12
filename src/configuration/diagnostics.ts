import { DEFAULT_SETTINGS, getDefaultModel, getApiProviderId, getApiProviderModelName, isApiProviderModel, getLocalLlmId, getLocalLlmModelName, getLocalLlmConfig, isLocalLlmModel, normalizeDeprecatedModelIdentifier, type LlmHubSettings } from '../types';
import { ConfigurationError, type RawSnapshot, type ConfigPreview, type ConfigWarning } from './types';
import type { ConfigurationService } from './service';
import { getVerificationFingerprint } from './verification';
import { redact } from './validation';
import { getSetupGuidance } from './onboarding';
import {getLocalLlmEnabledModels} from '../types';
import {validateSetupAnswers} from './onboarding';

export interface ModelResolution{
 selected:string|null;effective:string;resolved:{kind:'api'|'local'|'cli';configId:string;model:string}|null;ready:boolean;reason:string|null;
 resolutionSource:'explicit'|'legacy-identifier'|'runtime-default'|'normalized-identifier';suggestions:string[];credentialConfigured?:boolean;
 verification?:'legacy'|'unverified'|'current'|'stale';
 verifiedAt?:number;
 runtimeFallback?:{identifier:string;reason:string};
}
export interface DiagnosticsContext{
 service:ConfigurationService;
 pluginVersion?:string;
 guardRuntime?:()=>Record<string,unknown>;
 ragRuntime?:(name:string)=>Promise<Record<string,unknown>|undefined>;
 reloadState?:()=>Record<string,unknown>;
}
function modelSettings(raw:RawSnapshot):LlmHubSettings{
 return {...DEFAULT_SETTINGS,...raw.settings,
  apiProviders:Array.isArray(raw.settings.apiProviders)?raw.settings.apiProviders as LlmHubSettings['apiProviders']:[],
  localLlmConfigs:Array.isArray(raw.settings.localLlmConfigs)?raw.settings.localLlmConfigs as LlmHubSettings['localLlmConfigs']:[],
  cliConfig:{...DEFAULT_SETTINGS.cliConfig,...(raw.settings.cliConfig && typeof raw.settings.cliConfig==='object'?raw.settings.cliConfig:{})},
 } as LlmHubSettings;
}
function candidates(settings:LlmHubSettings):string[]{
 const result:string[]=[];
 for(const provider of settings.apiProviders)if(provider.enabled && provider.verified && (!['gemini','anthropic','opencodego'].includes(provider.type)||configured(provider.apiKey)))for(const model of provider.enabledModels??[])result.push('api:'+provider.id+':'+model);
 for(const entry of settings.localLlmConfigs)if(entry.enabled!==false && entry.verified){
  const models=getLocalLlmEnabledModels(entry);
  for(const model of models)if(getLocalLlmConfig('local-llm:'+entry.id+':'+model,settings))result.push('local-llm:'+entry.id+':'+model);
 }
 for(const[id,key]of [['antigravity-cli','cliVerified'],['claude-cli','claudeCliVerified'],['codex-cli','codexCliVerified']] as const)if(settings.cliConfig[key])result.push(id);
 return [...new Set(result)];
}
function configured(value:unknown):boolean{
 return typeof value==='string'?value.length>0:!!value && typeof value==='object' && Reflect.get(value,'configured')===true;
}
export function resolveConfiguredModel(raw:RawSnapshot,identifier?:string):ModelResolution{
 const settings=modelSettings(raw),selected=identifier??(typeof raw.workspace.selectedModel==='string'?raw.workspace.selectedModel:null);
 const effective=normalizeDeprecatedModelIdentifier(selected||getDefaultModel(settings));
 const result:ModelResolution={selected,effective,resolved:null,ready:false,reason:null,resolutionSource:selected?(selected!==effective?'normalized-identifier':'explicit'):'runtime-default',suggestions:candidates(settings)};
 const fail=(reason:string)=>({...result,reason});
 if(isApiProviderModel(effective)){
  const id=getApiProviderId(effective),provider=settings.apiProviders.find(entry=>entry.id===id);
  if(!provider)return fail('PROVIDER_MISSING');
  if(!provider.enabled)return fail('CONFIG_DISABLED');
  if(['gemini','anthropic','opencodego'].includes(provider.type)&&!configured(provider.apiKey))return {...fail('CREDENTIAL_MISSING'),credentialConfigured:false};
  if(!provider.verified)return fail('UNVERIFIED');
  const requested=getApiProviderModelName(effective),model=requested||provider.enabledModels?.[0]||'';
  if(!model)return fail('MODEL_NOT_CONFIGURED');
  if(!provider.enabledModels?.includes(model))return fail('MODEL_NOT_ENABLED');
  return {...result,resolved:{kind:'api',configId:id,model},ready:true,credentialConfigured:configured(provider.apiKey),verification:'legacy',resolutionSource:requested?result.resolutionSource:'legacy-identifier'};
 }
 if(isLocalLlmModel(effective)){
  const id=getLocalLlmId(effective),entry=id?settings.localLlmConfigs.find(config=>config.id===id):settings.localLlmConfigs.find(config=>config.verified&&config.enabled!==false);
  if(!entry)return fail('LOCAL_CONFIG_MISSING');
  if(entry.enabled===false)return fail('CONFIG_DISABLED');
  if(!entry.verified)return fail('UNVERIFIED');
  const enabled=getLocalLlmEnabledModels(entry),requested=getLocalLlmModelName(effective);
  if(requested&&!enabled.includes(requested))return {...fail('MODEL_NOT_ENABLED'),...(enabled[0]?{runtimeFallback:{identifier:'local-llm:'+entry.id+':'+enabled[0],reason:'workspace-selection-fallback'}}:{})};
  const resolved=getLocalLlmConfig(effective,settings);
  if(!resolved?.model)return fail('MODEL_NOT_ENABLED');
  return {...result,resolved:{kind:'local',configId:entry.id,model:resolved.model},ready:true,verification:'legacy',resolutionSource:id && getLocalLlmModelName(effective)?result.resolutionSource:'legacy-identifier'};
 }
 const cli:Record<string,'cliVerified'|'claudeCliVerified'|'codexCliVerified'>={'antigravity-cli':'cliVerified','claude-cli':'claudeCliVerified','codex-cli':'codexCliVerified'};
 if(Object.prototype.hasOwnProperty.call(cli,effective)){
  if(!settings.cliConfig[cli[effective]])return fail('CLI_NOT_CONFIGURED');
  return {...result,resolved:{kind:'cli',configId:effective,model:effective==='codex-cli'?settings.cliConfig.codexCliModel??effective:effective},ready:true,verification:'legacy'};
 }
 return fail('UNSUPPORTED_MODEL_IDENTIFIER');
}
const dangling=new Set(['PROVIDER_MISSING','LOCAL_CONFIG_MISSING','MODEL_NOT_ENABLED','MODEL_NOT_CONFIGURED','CONFIG_DISABLED','UNSUPPORTED_MODEL_IDENTIFIER']);
export function modelReferenceWarnings(raw:RawSnapshot):ConfigWarning[]{
 if(typeof raw.workspace.selectedModel!=='string')return [];
 const model=resolveConfiguredModel(raw);
 if(model.ready)return [];
 return [{code:dangling.has(model.reason??'')?'DANGLING_MODEL_REFERENCE':'MODEL_NEEDS_CHECK',path:'workspace.selectedModel',
  message:dangling.has(model.reason??'')?'当前保存的模型选择不可用：'+model.reason:'当前模型尚未完成可用性检查：'+model.reason,
  fix:dangling.has(model.reason??'')?'configuration_repair':'configuration_check'}];
}
export function assertModelDependencyChange(before:RawSnapshot,after:RawSnapshot):void{
 if(typeof after.workspace.selectedModel!=='string')return;
 const previous=resolveConfiguredModel(before),next=resolveConfiguredModel(after);
 if(dangling.has(next.reason??'') && (before.workspace.selectedModel!==after.workspace.selectedModel || previous.ready))
  throw new ConfigurationError('dependency-unresolved',[],{path:'workspace.selectedModel',reason:next.reason});
}
export async function resolveModelWithVerification(raw:RawSnapshot,identifier?:string):Promise<ModelResolution>{
 const cache=new Map<string,Promise<string>>();
 const attest=async(result:ModelResolution):Promise<ModelResolution>=>{
  if(!result.resolved||result.resolved.kind==='cli')return result;
  const kind=result.resolved.kind,entries=raw.settings[kind==='api'?'apiProviders':'localLlmConfigs'] as Record<string,unknown>[];
  const entity=entries.find(entry=>entry.id===result.resolved!.configId)!,record=entity.verification as Record<string,unknown>|undefined;
  if(!record)return result;
  const key=kind+':'+result.resolved.configId;
  if(!cache.has(key))cache.set(key,getVerificationFingerprint(entity,kind==='api'?raw.settings:{}));
  const current=record.fingerprint===await cache.get(key);
  return {...result,ready:current,verification:current?'current':'stale',reason:current?result.reason:'VERIFICATION_STALE',verifiedAt:typeof record.verifiedAt==='number'?record.verifiedAt:undefined};
 };
 const base=resolveConfiguredModel(raw,identifier),result=await attest(base),suggestions:string[]=[];
 for(const candidate of base.suggestions){if((await attest(resolveConfiguredModel(raw,candidate))).ready)suggestions.push(candidate);if(suggestions.length===10)break;}
 return {...result,suggestions};
}
export async function getConfigurationStatus(context:DiagnosticsContext,answers?:unknown):Promise<Record<string,unknown>>{
 const preferences=validateSetupAnswers(answers);
 const snapshot=await context.service.inspectSnapshot(),raw=redact(snapshot.raw) as RawSnapshot,model=await resolveModelWithVerification(snapshot.raw),guard=raw.safeGuard;
 const name=typeof raw.workspace.selectedRagSetting==='string'?raw.workspace.selectedRagSetting:null;
 const settings=raw.workspace.ragSettings as Record<string,Record<string,unknown>>|undefined,rag=name?settings?.[name]:undefined;
 const kind=rag?.externalIndexPath?'external':Array.isArray(rag?.sourceRagSettings)&&rag.sourceRagSettings.length?'combined':'internal';
 const knownIndex=name && context.ragRuntime?await context.ragRuntime(name):undefined;
 const warnings=modelReferenceWarnings(raw);
 const recoveryRequired=context.service.recoveryRequired;
 if(recoveryRequired)warnings.push({code:'RECOVERY_REQUIRED',path:'configuration',message:'上次配置事务需要本地恢复；当前可查询和导出，写入暂停。',fix:'local-configuration-recovery'});
 if(!model.ready&&!warnings.length)warnings.push({code:'MODEL_NEEDS_CHECK',path:'workspace.selectedModel',message:'当前连接验证已过期：'+model.reason,fix:'configuration_check'});
 const currentValues:Record<string,unknown>={};
 for (const key of ['ragIndexIdleSeconds', 'ragContinueAfterClose', 'groundedAnswersByDefault']) {
  if (raw.settings[key] !== undefined) currentValues['settings.'+key] = raw.settings[key];
 }
 const controls=raw.settings.requestControls as Record<string,unknown>|undefined;
 for(const key of ['maxOutputTokens','maxToolRounds','outbound','budgetEnabled','monthlyBudgetCny'])if(controls?.[key]!==undefined)currentValues['settings.requestControls.'+key]=controls[key];
 if(guard.defaultReadOnlyEnabled!==undefined)currentValues['safeGuard.defaultReadOnlyEnabled']=guard.defaultReadOnlyEnabled;
 if(rag)for(const key of ['topK','chunkSize','autoUpdateIndex'])if(rag[key]!==undefined)currentValues['workspace.ragSettings.*.'+key]=rag[key];
 const needsRag=preferences.purpose==='notes'&&!rag||name!==null&&!rag;
 const modelAction=model.reason==='CREDENTIAL_MISSING'?'local-credential-entry':model.reason==='VERIFICATION_STALE'||model.reason==='UNVERIFIED'?'configuration_check':model.suggestions.length?'configuration_repair':'configuration_describe';
 const result={revision:snapshot.revision,recoveryRequired,plugin:{version:context.pluginVersion??'unknown',mcpVersion:'1.1',schemaVersion:1},
  model,guard:{enabled:guard.enabled===true,listenHost:typeof guard.listenHost==='string'?guard.listenHost:null,listenPort:typeof guard.listenPort==='number'?guard.listenPort:null,
   upstream:typeof guard.upstreamBaseUrl==='string'?guard.upstreamBaseUrl:null,upstreamReachable:'unknown',runtime:'unknown',...context.guardRuntime?.()},
  rag:{selected:name,configured:!!rag,kind:name?rag?kind:'missing':'none',readOnly:kind==='external'||kind==='combined',indexReady:'unknown',needsReindex:'unknown',...knownIndex},
  reload:context.reloadState?.()??{pending:'unknown',paths:[]},
  setup:{needsSetup:!model.ready||needsRag,reason:!model.ready?(model.suggestions.length?'SELECTION_NEEDS_REPAIR':'NO_READY_MODEL'):needsRag?'RAG_CONFIGURATION_MISSING':null,guideUri:'llmhubpp://configuration/onboarding',existing:{modelLocation:(raw.settings.localLlmConfigs as unknown[]??[]).length?(raw.settings.apiProviders as unknown[]??[]).length?'mixed':'local':(raw.settings.apiProviders as unknown[]??[]).length?'existing':undefined,ragConfigured:!!rag,values:currentValues}},
  warnings,nextActions:recoveryRequired?['local-configuration-recovery']:!model.ready?[modelAction]:needsRag?['configuration_describe','configuration_read']:[],
 };
 return {...result,setup:{...result.setup,guidance:getSetupGuidance(result,answers)}};
}
export async function previewModelRepair(context:DiagnosticsContext,args:Record<string,unknown>):Promise<object>{
 const snapshot=await context.service.inspectSnapshot(),resolution=await resolveModelWithVerification(snapshot.raw);
 if(args.targetModel===undefined)return {revision:snapshot.revision,preview:false,suggestions:resolution.suggestions,changes:[],nextActions:['configuration_read']};
 if(typeof args.targetModel!=='string'||typeof args.baseRevision!=='string')throw new ConfigurationError('invalid-arguments',[],{fields:['targetModel','baseRevision']});
 const target=await resolveModelWithVerification(snapshot.raw,args.targetModel);
 if(!target.ready)throw new ConfigurationError('dependency-unresolved',[],{path:'workspace.selectedModel',reason:target.reason});
 const preview:ConfigPreview=await context.service.preview({baseRevision:args.baseRevision,operations:[{op:'set',moduleId:'workspace',fieldId:'selectedModel',value:args.targetModel}]});
 return {...preview,preview:true,suggestions:resolution.suggestions,nextActions:['configuration_apply']};
}
