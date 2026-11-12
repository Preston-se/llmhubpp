import { CONFIGURATION_SCHEMAS } from './generatedSchema';
import type { ConfigDescriptor, ConfigSchema, ConfigDomain } from './types';
import { RAG_INDEX_IDLE_DEFAULT_SECONDS, RAG_INDEX_IDLE_MAX_SECONDS, RAG_INDEX_IDLE_MIN_SECONDS } from 'src/types';
export { getDocumentationIndex, getFieldKnowledge, validateDocumentationCoverage } from './knowledge';
const readOnly = /^(?:localLlmConfig|localLlmVerified|localLlmAvailableModels|skillsFolderPath|configuredCredentials|dashboardHubMigrationNoticeShown|sentPromptHistory|discussionSettings|contextMemories)$|(?:^|\.)(?:verified|verification|verifiedAt|fingerprint|availableModels|cliVerified|claudeCliVerified|codexCliVerified|antigravityCliMigrated|sourceCollection|sourceManifestId|lastFullSync|embeddingApiKeyConfigured)$/;
function mark(schema: ConfigSchema, path: string): ConfigSchema {
    const copy = structuredClone(schema);
    if (path === 'ragIndexIdleSeconds') {
        copy.type = 'integer';
        copy.minimum = RAG_INDEX_IDLE_MIN_SECONDS;
        copy.maximum = RAG_INDEX_IDLE_MAX_SECONDS;
        copy.default = RAG_INDEX_IDLE_DEFAULT_SECONDS;
    }
    if(copy.enum?.length===2 && copy.enum.every(value=>typeof value==='boolean') && new Set(copy.enum).size===2){copy.type='boolean';delete copy.enum;}
    if(copy.anyOf){copy.anyOf=[...new Map(copy.anyOf.map(item=>[JSON.stringify(item),item])).values()];if(copy.anyOf.length===1)return mark({...copy.anyOf[0],...(copy.description?{description:copy.description}:{})},path);}
    if (readOnly.test(path))
        copy.readOnly = true;
    if (copy.properties)
        for (const [key, value] of Object.entries(copy.properties))
            copy.properties[key] = mark(value, `${path}.${key}`);
    if (copy.items) {
        copy.items = mark(copy.items, path);
        if (copy.items.type === 'object' && copy.items.properties && !copy.items.properties.id)
            copy.items.properties.id = { type: 'string', description: 'Stable configuration entity identifier' };
    }
    if (typeof copy.additionalProperties === 'object')
        copy.additionalProperties = mark(copy.additionalProperties, path);
    return copy;
}
export function configurationEffect(moduleId:string,fieldId:string):'live'|'reload'{
    const manual:Record<string,string[]>={settings:['storageLayout','workspaceFolder','skillsFolder','credentialStorage'],safeGuard:['listenHost','listenPort','markdownVisionEnabled','markdownVisionDirectProviderHook']};
    return manual[moduleId]?.includes(fieldId)?'reload':'live';
}
export function createRegistry(defaults: Partial<Record<ConfigDomain, Record<string, unknown>>> = {}): ConfigDescriptor[] {
    const domains: Record<string, ConfigSchema> = { settings: CONFIGURATION_SCHEMAS.LlmHubSettings, workspace: CONFIGURATION_SCHEMAS.WorkspaceState, safeGuard: CONFIGURATION_SCHEMAS.SafeGuard, hotkeys: { type: 'object', properties: { bindings: { type: 'object', additionalProperties: { type: 'array', items: { type: 'object', properties: { modifiers: { type: 'array', items: { enum: ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'] } }, key: { type: 'string' } }, required: ['modifiers', 'key'], additionalProperties: false } } } } }, resources: { type: 'object', properties: { files: { type: 'object', additionalProperties: { type: 'string' } } } } };
    return Object.entries(domains).flatMap(([moduleId, schema]) => Object.entries(schema.properties ?? {}).map(([fieldId, s]) => ({ moduleId: moduleId as ConfigDomain, fieldId, schema: mark(s, fieldId), description: s.description || fieldId, sensitive: /(apiKey|secret|password|token|env|headers)/i.test(fieldId), readOnly: readOnly.test(fieldId), effect:configurationEffect(moduleId,fieldId), help: `configuration-fields#${moduleId.toLowerCase()}-${fieldId.toLowerCase()}`, defaultValue: defaults[moduleId as ConfigDomain]?.[fieldId] ?? s.default })));
}
