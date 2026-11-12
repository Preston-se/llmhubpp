import { ConfigurationError, type ConfigDescriptor, type ConfigDomain, type ConfigOperation, type ConfigPatch, type ConfigPreview, type RawSnapshot, type ConfigApplyResult, type ConfigHistoryEntry, type ConfigurationBackend, type ConfigSchema } from './types';
import { assertSafe, blockedKeys, isSensitiveKey, matchesSchema, mergeObject, redact, secretMaterial } from './validation';
import { assertConfigurationModules } from './schemaPaths';
import { assertModelDependencyChange, modelReferenceWarnings } from './diagnostics';
import { getVerificationFingerprint } from './verification';
import { assessConfigurationRisk,reindexWarnings } from './risk';
import { embeddingDestinationIdentity } from '../core/embeddingCredentials';
import { sameMcpConnection } from '../core/mcpApproval';
import type { McpServerConfig } from '../types';
export function canonical(value: unknown): string { return JSON.stringify(value, (_k, v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v); }
export async function digest(value: unknown): Promise<string> { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))); return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join(''); }
const clone = <T>(value: T): T => structuredClone(value);
function preserveManaged(before:unknown,after:unknown,schema:ConfigSchema):unknown{
    if(schema.readOnly)return after===undefined?clone(before):after;
    if(Array.isArray(after)&&schema.items){
        const old=Array.isArray(before)?before as Record<string,unknown>[]:[];
        return after.map((entry:unknown)=>{
            const id=entry&&typeof entry==='object'?Reflect.get(entry,'id') as unknown:undefined;
            return preserveManaged(old.find(item=>item?.id===id),entry,schema.items!);
        });
    }
    if(after&&typeof after==='object'&&!Array.isArray(after)){
        const value=after as Record<string,unknown>,old=before&&typeof before==='object'?before as Record<string,unknown>:{};
        for(const [key,child]of Object.entries(schema.properties??{})){
            const managed=preserveManaged(old[key],value[key],child);
            if(managed!==undefined)value[key]=managed;
        }
        if(typeof schema.additionalProperties==='object')for(const key of Object.keys(value))if(!schema.properties?.[key])value[key]=preserveManaged(old[key],value[key],schema.additionalProperties);
    }
    return after;
}
interface Pending {
    trusted:boolean;
    public: ConfigPreview;
    patch: ConfigPatch;
    before: RawSnapshot;
    after: RawSnapshot;
    domains: ConfigDomain[];
}
export class ConfigurationService {
    private previews = new Map<string, Pending>();
    private expiredPreviews = new Map<string, number>();
    private results = new Map<string, {
        input: string;
        result: ConfigApplyResult;
    }>();
    private entries: ConfigHistoryEntry[] = [];
    private backups = new Map<string, RawSnapshot>();
    private queue: Promise<unknown> = Promise.resolve();
    private blocked = false;
    private accepting = true;
    private pendingActivation=new Set<string>();
    getReloadState(){return {pending:this.pendingActivation.size>0,paths:[...this.pendingActivation]};}
    markActivated(paths:string[]):void{for(const path of paths)this.pendingActivation.delete(path);}
    get recoveryRequired(): boolean { return this.blocked; }
    constructor(private descriptors: ConfigDescriptor[], private backend: ConfigurationBackend) { }
    describe(moduleIds?: string[]): ConfigDescriptor[] { assertConfigurationModules(moduleIds); return clone(this.descriptors.filter(d => !moduleIds || moduleIds.includes(d.moduleId))); }
    /** Internal host diagnostics only; never pass raw snapshots to an external tool. */
    async inspectSnapshot(){const raw=await this.backend.read();return {revision:await digest(raw),raw};}
    async read(moduleIds?: string[]) { assertConfigurationModules(moduleIds); const {revision,raw}=await this.inspectSnapshot(); return { revision, modules: redact(Object.fromEntries(Object.entries(raw).filter(([id]) => !moduleIds || moduleIds.includes(id)))) as RawSnapshot }; }
    preview(patch: ConfigPatch): Promise<ConfigPreview> { return this.buildPreview(patch, false); }
    /** Only existing host UI/internal saves may preserve runtime-maintained fields. Never exposed to MCP. */
    previewTrusted(patch: ConfigPatch): Promise<ConfigPreview> { return this.buildPreview(patch, true); }
    private async buildPreview(patch: ConfigPatch, trusted: boolean): Promise<ConfigPreview> {
        assertSafe(patch);
        if (!Array.isArray(patch.operations) || !patch.operations.length || patch.operations.length > 200)
            throw new ConfigurationError('invalid-batch');
        const before = await this.backend.read();
        const currentRevision = await digest(before);
        if (currentRevision !== patch.baseRevision)
            throw new ConfigurationError('conflict', [], { currentRevision });
        const after = clone(before);
        const changes: ConfigPreview['changes'] = [];
        const domains = new Set<ConfigDomain>();
        let reloadRequired = false;
        for (const op of patch.operations) {
            let descriptor = this.descriptors.find(d => d.moduleId === op.moduleId && d.fieldId === op.fieldId.split('.')[0]);
            if (!descriptor || descriptor.readOnly && !trusted)
                throw new ConfigurationError('unknown-or-readonly-field');
            if (trusted) {
                descriptor = clone(descriptor);
                const permit = (s: ConfigSchema) => { s.readOnly = false; Object.values(s.properties ?? {}).forEach(permit); if (s.items)
                    permit(s.items); if (typeof s.additionalProperties === 'object')
                    permit(s.additionalProperties); s.anyOf?.forEach(permit); };
                permit(descriptor.schema);
            }
            if (trusted && descriptor.readOnly) {
                if (op.op === 'clear')
                    delete after[op.moduleId][descriptor.fieldId];
                else
                    after[op.moduleId][descriptor.fieldId] = clone(op.value);
            }
            else
                this.applyOperation(after, op, descriptor);
            domains.add(op.moduleId);
            reloadRequired ||= descriptor.effect === 'reload';
            changes.push({ moduleId: op.moduleId, fieldId: op.fieldId, entityId: op.entityId, before: redact(before[op.moduleId][descriptor.fieldId], descriptor.fieldId), after: redact(after[op.moduleId][descriptor.fieldId], descriptor.fieldId) });
        }
        if(!trusted)for(const descriptor of this.descriptors){
            const value=preserveManaged(before[descriptor.moduleId][descriptor.fieldId],after[descriptor.moduleId][descriptor.fieldId],descriptor.schema);
            if(value!==undefined)after[descriptor.moduleId][descriptor.fieldId]=value;
        }
        {
            const priorServers = before.settings.mcpServers as McpServerConfig[] | undefined;
            for (const server of after.settings.mcpServers as McpServerConfig[] ?? []) {
                const prior = server.id && priorServers?.find(entry => entry.id === server.id);
                // An edit can carry forward the old tool list with a different destination.
                if (prior && prior.allowedTools?.length && server.allowedTools?.length && !sameMcpConnection(prior, server)) {
                    server.allowedTools = server.allowedTools.filter(tool => !prior.allowedTools?.includes(tool));
                }
            }
            for (const field of ['apiProviders', 'localLlmConfigs']) {
                const old = before.settings[field] as Record<string, unknown>[] ?? [];
                for (const entry of after.settings[field] as Record<string, unknown>[] ?? []) {
                    const prior = old.find(e => e.id === entry.id);
                    const network=field==='apiProviders'?after.settings:{};
                    const changed=!prior || ['baseUrl', 'type', 'framework', 'apiKey', 'username', 'password'].some(k => canonical(prior[k]) !== canonical(entry[k])) || field==='apiProviders'&&['proxyUrl','proxyBypass'].some(k=>before.settings[k]!==after.settings[k]);
                    const attestation=entry.verification as Record<string,unknown>|undefined;
                    const fresh=changed&&trusted&&entry.verified&&attestation?.fingerprint!==undefined&&attestation.fingerprint===await getVerificationFingerprint(entry,network);
                    if (changed&&!fresh) {
                        entry.verified = false;
                        entry.availableModels = [];
                        delete entry.verification;
                    }
                }
            }
            const oldCli = before.settings.cliConfig as Record<string, unknown> ?? {}, nextCli = after.settings.cliConfig as Record<string, unknown> ?? {};
            for (const [path, flag] of [['codexCliPath', 'codexCliVerified'], ['claudeCliPath', 'claudeCliVerified'], ['geminiCliPath', 'cliVerified']])
                if (oldCli[path] !== nextCli[path])
                    nextCli[flag] = false;
            for (const change of changes) {
                const root = change.fieldId.split('.')[0];
                change.after = redact(after[change.moduleId][root], root);
            }
        }
        this.validateCombined(after);
        const priorIndexes = before.workspace.ragSettings as Record<string, Record<string, unknown>> | undefined;
        const nextIndexes = after.workspace.ragSettings as Record<string, Record<string, unknown>> | undefined;
        for (const [name, next] of Object.entries(nextIndexes ?? {})) {
            const prior = priorIndexes?.[name];
            if (!prior || prior.embeddingBaseUrl === next.embeddingBaseUrl) continue;
            let nextDestination: string;
            try { nextDestination = embeddingDestinationIdentity(typeof next.embeddingBaseUrl === 'string' ? next.embeddingBaseUrl : undefined); }
            catch { throw new ConfigurationError('embedding-endpoint-invalid'); }
            let priorDestination: string | undefined;
            try { priorDestination = embeddingDestinationIdentity(typeof prior.embeddingBaseUrl === 'string' ? prior.embeddingBaseUrl : undefined); } catch { /* An invalid old URL can be corrected. */ }
            if (priorDestination === nextDestination) continue;
            const oldKey = typeof prior.embeddingApiKey === 'string' ? prior.embeddingApiKey.trim() : '';
            const newKey = typeof next.embeddingApiKey === 'string' ? next.embeddingApiKey.trim() : '';
            if (oldKey && oldKey === newKey || prior.embeddingApiKeyConfigured && !oldKey && !newKey && next.embeddingApiKeyConfigured) {
                throw new ConfigurationError('embedding-credential-rebind-required');
            }
        }
        if(!trusted)assertModelDependencyChange(before,after);
        const issues = await this.backend.validate?.(before, after, patch.operations) ?? [];
        if (issues.some(i => i.code !== 'reload-required' && i.code !== 'missing-dependency'))
            throw new ConfigurationError('invalid', issues);
        const risks=assessConfigurationRisk(patch.operations,before,after,this.descriptors);
        const pub:ConfigPreview = { id: crypto.randomUUID(), baseRevision: patch.baseRevision, expiresAt: Date.now() + 600000, changes, issues, reloadRequired, risks,...(!trusted&&risks.length?{confirmation:{required:true as const,token:crypto.randomUUID()}}:{}),warnings:[...modelReferenceWarnings(after),...reindexWarnings(before,after)] };
        for (const [id, p] of this.previews)
            if (p.public.expiresAt < Date.now()) {
                this.expiredPreviews.set(id, p.public.expiresAt);
                this.previews.delete(id);
            }
        while(this.expiredPreviews.size>100)this.expiredPreviews.delete(this.expiredPreviews.keys().next().value!);
        if (this.previews.size >= 20)
            this.previews.delete(this.previews.keys().next().value!);
        this.previews.set(pub.id, { public: pub, patch: clone(patch), before, after, domains: [...domains],trusted });
        return clone(pub);
    }
    private applyOperation(data: RawSnapshot, op: ConfigOperation, d: ConfigDescriptor): void {
        if (!['set', 'clear', 'create', 'update', 'remove'].includes(op.op))
            throw new ConfigurationError('invalid-operation');
        const parts = op.fieldId.split('.');
        if (parts.some(p => !p || blockedKeys.has(p)))
            throw new ConfigurationError('invalid-key');
        let object = data[op.moduleId], key = parts[0], schema = d.schema;
        for (let index = 0;; index++) {
            if (schema.readOnly)
                throw new ConfigurationError('readonly');
            const collection = schema.type === 'array' || (schema.type === 'object' && typeof schema.additionalProperties === 'object');
            if (collection && op.entityId !== undefined) {
                if (!op.entityId || blockedKeys.has(op.entityId))
                    throw new ConfigurationError('invalid-entity');
                const items = object[key] ?? (schema.type === 'array' ? [] : {});
                object[key] = items;
                if (schema.type === 'array') {
                    if (!Array.isArray(items))
                        throw new ConfigurationError('invalid');
                    const find = items.findIndex((v: unknown) => v && typeof v === 'object' && Reflect.get(v, 'id') === op.entityId);
                    if (find < 0) {
                        if (op.op !== 'create' || index !== parts.length - 1)
                            throw new ConfigurationError('entity-not-found');
                        if (!op.value || typeof op.value !== 'object' || Reflect.get(op.value, 'id') !== op.entityId)
                            throw new ConfigurationError('invalid-entity');
                        this.checkValue(op.value, schema.items!, false);
                        items.push(clone(op.value));
                        return;
                    }
                    if (op.op === 'create')
                        throw new ConfigurationError('duplicate-entity');
                    if (index === parts.length - 1) {
                        if (op.op === 'remove') {
                            items.splice(find, 1);
                            return;
                        }
                        this.checkValue(op.value, schema.items!, true, items[find]);
                        items[find] = mergeObject(items[find], op.value);
                        return;
                    }
                    object = items[find] as Record<string, unknown>;
                    schema = schema.items!;
                }
                else {
                    const map = items as Record<string, unknown>;
                    schema = schema.additionalProperties as ConfigSchema;
                    if (index === parts.length - 1) {
                        if (op.op === 'remove') {
                            delete map[op.entityId];
                            return;
                        }
                        if (op.op === 'create' && Object.prototype.hasOwnProperty.call(map, op.entityId))
                            throw new ConfigurationError('duplicate-entity');
                        this.checkValue(op.value, schema, op.op !== 'create', map[op.entityId]);
                        map[op.entityId] = op.op === 'update' ? mergeObject(map[op.entityId], op.value) : clone(op.value);
                        return;
                    }
                    if (!map[op.entityId])
                        throw new ConfigurationError('entity-not-found');
                    object = map[op.entityId] as Record<string, unknown>;
                }
            }
            if (index === parts.length - 1) {
                if (op.op === 'clear') {
                    const fallback = parts.length === 1 ? d.defaultValue : schema.default;
                    if (fallback === undefined)
                        delete object[key];
                    else
                        object[key] = clone(fallback);
                    return;
                }
                if (op.op === 'remove')
                    throw new ConfigurationError('remove-requires-entity');
                this.checkValue(op.value, schema, op.op === 'update', object[key]);
                object[key] = op.op === 'update' ? mergeObject(object[key], op.value) : clone(op.value);
                return;
            }
            if (!collection || op.entityId === undefined) {
                if (!object[key] || typeof object[key] !== 'object')
                    object[key] = {};
                object = object[key] as Record<string, unknown>;
            }
            key = parts[index + 1];
            schema = schema.properties?.[key] ?? {};
            if (!schema.type && !schema.enum && !schema.anyOf)
                throw new ConfigurationError('unknown-field');
        }
    }
    private checkValue(value: unknown, schema: ConfigSchema, partial: boolean, previous?: unknown): void {
        const checked = clone(schema);
        const permitUnchanged = (s: ConfigSchema, v: unknown, old: unknown): void => {
            if (s.readOnly) {
                if(canonical(v)!==canonical(old))throw new ConfigurationError('readonly');
                return;
            }
            if (Array.isArray(v) && s.items) {
                for (const item of v as unknown[]) {
                    const id: unknown = item && typeof item === 'object' ? Reflect.get(item, 'id') : undefined;
                    const prior: unknown = Array.isArray(old) ? old.find((o: unknown) => id !== undefined && o && typeof o === 'object' && Reflect.get(o, 'id') === id) : undefined;
                    permitUnchanged(s.items, item, prior);
                }
            }
            else if (v && typeof v === 'object')
                for (const [key, item] of Object.entries(v)) {
                    const child = s.properties?.[key] ?? (typeof s.additionalProperties === 'object' ? s.additionalProperties : undefined);
                    if (child)
                        permitUnchanged(child, item, old && typeof old === 'object' ? Reflect.get(old, key) : undefined);
                }
        };
        permitUnchanged(checked, value, previous);
        const permit = (s: ConfigSchema) => { s.required = s.required?.filter(k => !s.properties?.[k]?.readOnly && !isSensitiveKey(k)); s.readOnly = false; Object.values(s.properties ?? {}).forEach(permit); if (s.items)
            permit(s.items); if (typeof s.additionalProperties === 'object')
            permit(s.additionalProperties); s.anyOf?.forEach(permit); };
        permit(checked);
        if (!matchesSchema(value, checked, partial))
            throw new ConfigurationError('invalid');
    }
    private validateCombined(data: RawSnapshot): void {
        for (const name of ['apiProviders', 'localLlmConfigs', 'slashCommands', 'knowledgeSources', 'agentPlugins']) {
            const entries = data.settings[name];
            if (Array.isArray(entries)) {
                const ids = entries.map((v: Record<string, unknown>) => v.id).filter(Boolean);
                if (new Set(ids).size !== ids.length)
                    throw new ConfigurationError('duplicate-entity');
            }
        }
        for (const rag of Object.values(data.workspace.ragSettings ?? {}) as Record<string, unknown>[]) {
            const size = Number(rag.chunkSize ?? 500), overlap = Number(rag.chunkOverlap ?? 100), topK = Number(rag.topK ?? 5), score = Number(rag.scoreThreshold ?? 0.3);
            if (size < 1 || overlap < 0 || overlap >= size || topK < 1 || !Number.isInteger(topK) || score < 0 || score > 1)
                throw new ConfigurationError('invalid');
        }
        if (data.safeGuard.listenHost !== undefined && data.safeGuard.listenHost !== '127.0.0.1')
            throw new ConfigurationError('loopback-required');
        for (const key of ['maxFunctionCalls', 'maxNoteChars', 'listNotesLimit', 'maxSavedChatHistories'])
            if (data.settings[key] !== undefined && (Number(data.settings[key]) < (key === 'maxSavedChatHistories' ? 0 : 1) || !Number.isInteger(data.settings[key])))
                throw new ConfigurationError('invalid');
        if (data.safeGuard.listenPort !== undefined && (!Number.isInteger(data.safeGuard.listenPort) || Number(data.safeGuard.listenPort) < 1 || Number(data.safeGuard.listenPort) > 65535))
            throw new ConfigurationError('invalid');
    }
    /** A preview owns its base revision and confirmation. Repeated request IDs replay the same result. */
    apply(input: {
        confirmToken?:string;
        previewId: string;
        baseRevision: string;
        requestId: string;
    }, signal?: AbortSignal): Promise<ConfigApplyResult> {
        if (!this.accepting)
            return Promise.reject(new ConfigurationError('closed'));
        const task = this.queue.then(() => this.commit(input, signal));
        this.queue = task.catch(() => { });
        return task;
    }
    private async commit(input: {
        confirmToken?:string;
        previewId: string;
        baseRevision: string;
        requestId: string;
    }, signal?: AbortSignal): Promise<ConfigApplyResult> {
        if (signal?.aborted) throw new ConfigurationError('closed');
        if (this.blocked)
            throw new ConfigurationError('recovery-required');
        if (!input.requestId || input.requestId.length > 200)
            throw new ConfigurationError('invalid-request-id');
        const prior = this.results.get(input.requestId);
        if (prior) {
            if (prior.input !== canonical(input))
                throw new ConfigurationError('request-id-reused');
            return clone(prior.result);
        }
        const p = this.previews.get(input.previewId);
        if (!p) {
            const expiresAt=this.expiredPreviews.get(input.previewId);
            throw new ConfigurationError(expiresAt===undefined?'preview-not-found':'preview-expired', [], expiresAt===undefined?{}:{expiresAt});
        }
        if (p.public.expiresAt < Date.now())
            throw new ConfigurationError('preview-expired', [], { expiresAt:p.public.expiresAt });
        const current = await this.backend.read();
        const currentRevision=await digest(current);
        if (input.baseRevision !== p.public.baseRevision || currentRevision !== input.baseRevision)
            throw new ConfigurationError('conflict', [], { currentRevision });
        if(p.public.confirmation){
            if(!input.confirmToken)throw new ConfigurationError('confirmation-required',[],{previewId:p.public.id,paths:p.public.risks?.map(risk=>risk.path)});
            if(input.confirmToken!==p.public.confirmation.token)throw new ConfigurationError('confirmation-invalid');
        }
        await this.backend.validate?.(current, p.after, p.patch.operations).then(issues => { if (issues.some(i => i.code !== 'reload-required' && i.code !== 'missing-dependency'))
            throw new ConfigurationError('invalid', issues); });
        const id = crypto.randomUUID();
        const beforePublic = redact(p.before, '', 'omit') as RawSnapshot, afterPublic = redact(p.after, '', 'omit') as RawSnapshot;
        const hasSecrets = canonical(secretMaterial(p.before)) !== canonical(secretMaterial(p.after));
        delete beforePublic.safeGuard.contextMemories;
        delete afterPublic.safeGuard.contextMemories;
        delete beforePublic.workspace.sentPromptHistory;
        delete afterPublic.workspace.sentPromptHistory;
        const journal = { id, before: beforePublic, after: afterPublic, domains: p.domains, state: 'pending' as const, hasSecrets };
        // Once journal creation starts, finish or roll back through the existing
        // transaction path even if the client disconnects or rotates its token.
        if (signal?.aborted) throw new ConfigurationError('closed');
        await this.backend.journal(journal, p.before);
        const attempted: ConfigDomain[] = [];
        try {
            for (const domain of p.domains) {
                attempted.push(domain);
                await this.backend.write(domain, p.after[domain]);
            }
        }
        catch {
            let restored = true;
            for (const domain of attempted.reverse())
                try {
                    await this.backend.write(domain, p.before[domain], 'rollback');
                }
                catch {
                    restored = false;
                }
            if (!restored) {
                this.blocked = true;
                await this.backend.journal({ ...journal, state: 'recovery-required' }).catch(() => { });
                throw new ConfigurationError('recovery-required');
            }
            await this.backend.journal(null);
            throw new ConfigurationError('save-failed');
        }
        let status: ConfigApplyResult['status'] = p.public.reloadRequired ? 'reload-required' : 'applied';
        let runtimeReload=false,activationFailed=false;
        try {
            if ((await this.backend.activate(p.domains)).reloadRequired){runtimeReload=true;
                status = 'reload-required';
            }
        }
        catch {
            status = 'verification-failed';
            activationFailed=true;
        }
        const revision = await digest(await this.backend.read());
        const changes=p.public.changes.map(change=>{
            const pending=runtimeReload||this.descriptors.find(d=>d.moduleId===change.moduleId&&d.fieldId===change.fieldId.split('.')[0])?.effect==='reload';
            const path=change.moduleId+'.'+change.fieldId;
            if(pending||activationFailed)this.pendingActivation.add(path);
            else this.pendingActivation.delete(path);
            return {moduleId:change.moduleId,fieldId:change.fieldId,entityId:change.entityId,saved:true,activation:activationFailed?'activation-failed' as const:pending?'pending-reload' as const:'applied' as const,operationId:id};
        });
        const result: ConfigApplyResult = { operationId: id, revision, status,persisted:true,changes,warnings:p.public.warnings, issues: status === 'verification-failed' ? [{ code: 'activation-failed', message: '配置已保存；运行时生效失败，请检查并重载。' }] : [] };
        this.entries.unshift({ operationId: id, time: Date.now(), changes: p.public.changes, status, revision,activation:changes });
        this.entries = this.entries.slice(0, 100);
        this.backups.set(id, p.before);
        if (this.backups.size > 20)
            this.backups.delete(this.backups.keys().next().value!);
        try {
            await this.backend.recordHistory?.(this.entries);
            await this.backend.journal(null);
        }
        catch {
            this.blocked = true;
            result.status = 'recovery-required';
            result.issues.push({ code: 'journal-finalize-failed', message: '配置已写入，但变更记录未能完成，请检查恢复状态。' });
        }
        this.results.set(input.requestId, { input: canonical(input), result });
        if (this.results.size > 100)
            this.results.delete(this.results.keys().next().value!);
        this.previews.delete(input.previewId);
        return clone(result);
    }
    async verify(operationId: string) { const entry = this.entries.find(e => e.operationId === operationId); if (!entry)
        throw new ConfigurationError('operation-not-found'); return { operationId, status: entry.status,persisted:true,unchangedSinceApply: (await this.read()).revision === entry.revision,runtime:{pending:(entry.activation??[]).map(change=>change.moduleId+'.'+change.fieldId).filter(path=>this.pendingActivation.has(path)),scope:'current-session'}, externalChecks: 'not-run' }; }
    history(limit = 20): Promise<ConfigHistoryEntry[]> { return Promise.resolve(clone(this.entries.slice(0, Math.min(100, Math.max(0, limit))))); }
    async restore(input: {
        operationId: string;
        baseRevision: string;
        requestId: string;
    }, signal?: AbortSignal): Promise<ConfigApplyResult|{status:'confirmation-required';revision:string;operationId:string;preview:ConfigPreview;nextActions:string[]}> {
        if (signal?.aborted) throw new ConfigurationError('closed');
        const before = this.backups.get(input.operationId);
        if (!before)
            throw new ConfigurationError('restore-unavailable');
        const current = await this.backend.read();
        if (await digest(current) !== input.baseRevision)
            throw new ConfigurationError('conflict');
        const entry = this.entries.find(e => e.operationId === input.operationId)!;
        if (entry.revision !== input.baseRevision)
            throw new ConfigurationError('conflict');
        const operations: ConfigOperation[] = [];
        for (const d of this.descriptors)
            if (!d.readOnly && canonical(current[d.moduleId][d.fieldId]) !== canonical(before[d.moduleId][d.fieldId]))
                operations.push({ op: before[d.moduleId][d.fieldId] === undefined ? 'clear' : 'set', moduleId: d.moduleId, fieldId: d.fieldId, value: before[d.moduleId][d.fieldId] });
        const pub = await this.preview({ baseRevision: input.baseRevision, operations });
        if(pub.confirmation)return {status:'confirmation-required',revision:input.baseRevision,operationId:input.operationId,preview:pub,nextActions:['explain-risks-and-authorization','configuration_apply']};
        return this.apply({ previewId: pub.id, baseRevision: pub.baseRevision, requestId: input.requestId }, signal);
    }
    async recover(): Promise<void> { try {
        const journal = await this.backend.loadJournal();
        if (journal)
            this.blocked = true;
    }
    catch {
        this.blocked = true;
    } try {
        const entries = await this.backend.loadHistory?.();
        if (entries)
            this.entries = entries.filter(e => e && typeof e.operationId === 'string' && typeof e.time === 'number' && Array.isArray(e.changes) && typeof e.revision === 'string').slice(0, 100);
    }
    catch { /* Unreadable optional history must not destroy current settings. */ } }
    async drain(): Promise<void> { await this.queue; }
    beginShutdown(): void { this.accepting = false; }
}
