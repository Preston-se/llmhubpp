import type { ConfigurationService } from '../service';
import { ConfigurationError, type ConfigPatch } from '../types';
import { assertSafe } from '../validation';
import { describeConfiguration, queryConfiguration } from '../query';
import { toolContract } from './contracts';
import { SETUP_ANSWER_SCHEMA,validateSetupAnswers } from '../onboarding';
import { getConfigurationStatus, previewModelRepair, resolveModelWithVerification } from '../diagnostics';
const text = { type: 'string' };
export interface ConfigurationTool {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        openWorldHint: boolean;
        idempotentHint: boolean;
    };
}
const params: Record<string, Record<string, unknown>> = {
    status:{answers:SETUP_ANSWER_SCHEMA},resolve_model:{model:text},repair:{targetModel:text,baseRevision:text},probe:{kind:{enum:['ollama','openai-compatible','mcp-http']},url:text,credentialRef:{type:'object',properties:{kind:{enum:['api','local','mcp']},id:text},required:['kind','id'],additionalProperties:false},timeoutMs:{type:'integer',minimum:100,maximum:60000}},
    describe: { modules: { type: 'array', items: text }, fieldPaths:{type:'array',minItems:1,maxItems:32,items:text},detail:{enum:['summary','full']},query:text,risk:{type:'array',minItems:1,items:{enum:['low','medium','high']}},limit:{type:'integer',minimum:1,maximum:100},cursor:text }, read: { modules: { type: 'array', items: text },fieldPaths:{type:'array',minItems:1,maxItems:32,items:text},detail:{enum:['summary','full']},limit:{type:'integer',minimum:1,maximum:100},cursor:text },
    preview: { baseRevision: text, operations: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', properties: { op: { enum: ['set', 'clear', 'create', 'update', 'remove'] }, moduleId: { enum: ['settings', 'workspace', 'safeGuard', 'hotkeys', 'resources'] }, fieldId: text, entityId: text, value: {} }, required: ['op', 'moduleId', 'fieldId'], additionalProperties: false } } },
    apply: { previewId: text, baseRevision: text, requestId: text,confirmToken:text }, verify: { operationId: text }, history: { limit: { type: 'integer', minimum: 1, maximum: 100 } }, restore: { operationId: text, baseRevision: text, requestId: text },
    reload:{baseRevision:text,scopes:{type:'array',minItems:1,maxItems:2,uniqueItems:true,items:{enum:['safeGuard','clients']}}},
    check: { kind: { enum: ['api', 'local', 'embedding', 'mcp', 'resource', 'path', 'cli'] }, targetId: text }, export: { modules: { type: 'array', items: text }, includeResources: { type: 'boolean' } }, import_preview: { uploadHandle: text, choices: { type: 'object' } },
};
const required: Record<string, string[]> = {reload:['baseRevision','scopes'],probe:['kind','url'], preview: ['baseRevision', 'operations'], apply: ['previewId', 'baseRevision', 'requestId'], verify: ['operationId'], restore: ['operationId', 'baseRevision', 'requestId'], check: ['kind', 'targetId'], import_preview: ['uploadHandle'] };
export function createConfigurationTools(): ConfigurationTool[] {
    return Object.entries(params).map(([key,properties]) => {
        const contract=toolContract(key);
        return {
            name: 'configuration_'+key,title:contract.title,description:contract.description,outputSchema:contract.outputSchema,
            inputSchema: {type:'object',properties,required:required[key]??[],additionalProperties:false},
            annotations:{readOnlyHint:['describe','read','preview','verify','history','status','resolve_model','repair','probe'].includes(key),destructiveHint:['apply','restore'].includes(key),openWorldHint:['check','probe'].includes(key),idempotentHint:contract.idempotentHint},
        };
    });
}
export interface ConfigurationToolExtensions {
    reload?:(args:Record<string,unknown>,signal?:AbortSignal)=>Promise<unknown>;
    status?:(answers?:unknown)=>Promise<unknown>;
    probe?:(args:Record<string,unknown>,signal?:AbortSignal)=>Promise<unknown>;
    check?: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
    export?: (args: Record<string, unknown>) => Promise<unknown>;
    importPreview?: (args: Record<string, unknown>) => Promise<unknown>;
}
export async function executeConfigurationTool(service: ConfigurationService, name: string, args: Record<string, unknown>, extra: ConfigurationToolExtensions = {}, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new ConfigurationError('closed');
    assertSafe(args);
    const key = name.replace(/^configuration_/, '');
    if (!name.startsWith('configuration_') || !params[key])
        throw new ConfigurationError('unknown-tool');
    if (Object.keys(args).some(k => !Object.prototype.hasOwnProperty.call(params[key], k)) || (required[key] ?? []).some(k => !(k in args)))
        throw new ConfigurationError('invalid-arguments');
    const strings = (key: string) => { if (typeof args[key] !== 'string')
        throw new ConfigurationError('invalid-arguments'); return args[key]; };
    const modules = () => { if (args.modules !== undefined && (!Array.isArray(args.modules) || args.modules.some((v: unknown) => typeof v !== 'string')))
        throw new ConfigurationError('invalid-arguments'); return args.modules as string[] | undefined; };
    switch (key) {
        case 'status': validateSetupAnswers(args.answers);return extra.status?extra.status(args.answers):getConfigurationStatus({service},args.answers);
        case 'resolve_model': return resolveModelWithVerification((await service.inspectSnapshot()).raw,args.model===undefined?undefined:strings('model'));
        case 'probe': if(extra.probe)return extra.probe(args,signal);break;
        case 'repair': return previewModelRepair({service},args);
        case 'describe': modules(); return describeConfiguration(service,args);
        case 'read': modules(); return queryConfiguration(service,args);
        case 'preview': return service.preview({ baseRevision: strings('baseRevision'), operations: args.operations } as ConfigPatch);
        case 'apply': return service.apply({ previewId: strings('previewId'), baseRevision: strings('baseRevision'), requestId: strings('requestId'),...(args.confirmToken===undefined?{}:{confirmToken:strings('confirmToken')}) },signal);
        case 'reload': if(extra.reload)return extra.reload(args,signal);break;
        case 'verify': return service.verify(strings('operationId'));
        case 'history':
            if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 100))
                throw new ConfigurationError('invalid-arguments');
            return { entries: await service.history(args.limit as number | undefined) };
        case 'restore': return service.restore({ operationId: strings('operationId'), baseRevision: strings('baseRevision'), requestId: strings('requestId') },signal);
        case 'check':
            if (extra.check)
                return extra.check(args, signal);
            break;
        case 'export':
            if (args.includeResources !== undefined && typeof args.includeResources !== 'boolean') throw new ConfigurationError('invalid-arguments');
            if (args.includeResources === true || modules()?.includes('resources')) throw new ConfigurationError('local-resource-export-required');
            if (extra.export)
                return extra.export(args);
            break;
        case 'import_preview':
            if (extra.importPreview)
                return extra.importPreview(args);
            break;
    }
    throw new ConfigurationError('capability-unavailable');
}
export function configurationGuide(service: ConfigurationService): string { return `# Llmhub++ Agent configuration\n\n1. configuration_status: follow setup.guidance; ask only missing core questions. Explain recommendations and preserve existing data.\n2. configuration_describe detail=summary / configuration_read fieldPaths: inspect targeted fields and revision. Full schema and field resources are opt-in.\n3. configuration_preview: typed operations, stable entityId, no positional indexes.\n4. configuration_apply: same previewId/baseRevision and unique requestId; risky previews also need confirmToken after authorization review.\n5. configuration_verify / configuration_status: distinguish persisted, runtime, pending and external-not-run. configuration_reload only supports listed scopes.\n\nSecrets are write-only: enter locally, never print keys or connection tokens. probe only fetches metadata/handshake without saving. check explicitly checks an existing configuration and may save system verification records. Preview never runs inference, scripts, conversion or indexing. Configuration is not permission to execute content tasks.\n\nExample: {"baseRevision":"<from read>","operations":[{"op":"set","moduleId":"settings","fieldId":"maxFunctionCalls","value":25}]}\n\n## Modules\n${[...new Set(service.describe().map(d=>d.moduleId))].map(id=>'- '+id).join('\n')}\n\nCore guidance: llmhubpp://configuration/onboarding\nField detail: llmhubpp://docs/field/{path}\nPrompts: first-setup, repair-model, merge-restore\n`; }
