import type { ConfigurationService } from '../service';
import { canonical, digest } from '../service';
import { ConfigurationError, type ConfigOperation, type ConfigSchema, type RawSnapshot } from '../types';
import { assertSafe, blockedKeys, mergeObject } from '../validation';
import type { BundleInspection } from './codec';
import { decryptCredentialPayload } from './credentials';
export interface ImportChoices {
    modules?: string[];
    pathMappings?: Record<string, string>;
    resourceConflicts?: Record<string, string>;
    password?: string;
}
function stripReadOnly(value: unknown, schema: ConfigSchema): unknown {
    if (schema.readOnly)
        return undefined;
    if (Array.isArray(value))
        return value.map(v => stripReadOnly(v, schema.items ?? {}));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).flatMap(([key, v]) => { const s = schema.properties?.[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : {}); const next = stripReadOnly(v, s); return next === undefined ? [] : [[key, next]]; }));
    return value;
}
export function portableMerge(old: unknown, next: unknown): unknown {
    if (Array.isArray(next) && next.every(v => v && typeof v === 'object' && typeof Reflect.get(v, 'id') === 'string')) {
        const existing: unknown[] = Array.isArray(old) ? old : [];
        const incoming = next.map(v => mergeObject(existing.find((o: unknown) => o && typeof o === 'object' && Reflect.get(o, 'id') === Reflect.get(v, 'id')), v));
        return [...incoming, ...existing.filter((o: unknown) => !next.some(n => o && typeof o === 'object' && Reflect.get(o, 'id') === Reflect.get(n, 'id')))];
    }
    if (next && old && typeof next === 'object' && typeof old === 'object' && !Array.isArray(next))
        return Object.fromEntries([...new Set([...Object.keys(old), ...Object.keys(next)])].map(key => [key, Object.prototype.hasOwnProperty.call(next, key) ? portableMerge(Reflect.get(old, key), Reflect.get(next, key)) : Reflect.get(old, key)]));
    return structuredClone(next);
}
function mapPaths(value: unknown, mappings: Record<string, string>, key = ''): unknown {
    if (typeof value === 'string' && /(path|folder|directory|command)$/i.test(key)) {
        if (mappings[value])
            return mappings[value];
        if (/^(?:[a-z]:[\\/]|\\\\)/i.test(value))
            throw new ConfigurationError('path-mapping-required');
    }
    if (Array.isArray(value))
        return value.map(v => mapPaths(v, mappings, key));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapPaths(v, mappings, k)]));
    return value;
}
export async function previewConfigurationImport(service: ConfigurationService, current: RawSnapshot, bundle: BundleInspection, choices: ImportChoices = {}): Promise<Awaited<ReturnType<ConfigurationService['preview']>>> {
    assertSafe(choices);
    // The merged values and optimistic revision must describe the same snapshot,
    // including any resource inspection, before asynchronous local decryption.
    current = structuredClone(current);
    const baseRevision = await digest(current);
    if (bundle.credentials && !choices.password)
        throw new ConfigurationError('local-password-required');
    const incoming = structuredClone(bundle.snapshot);
    if (bundle.credentials && choices.password) {
        const secrets = await decryptCredentialPayload(bundle.credentials, choices.password);
        assertSafe(secrets);
        if (!secrets || typeof secrets !== 'object')
            throw new ConfigurationError('invalid-credentials');
        for (const [encoded, value] of Object.entries(secrets)) {
            const path = JSON.parse(encoded) as string[];
            if (!Array.isArray(path) || path.some(k => typeof k !== 'string' || blockedKeys.has(k)))
                throw new ConfigurationError('invalid-credentials');
            let target: object = incoming;
            for (const segment of path.slice(0, -1)) {
                const next = Reflect.get(target, segment) as unknown;
                if (!next || typeof next !== 'object')
                    throw new ConfigurationError('invalid-credentials');
                target = next;
            }
            Reflect.set(target, path[path.length - 1], value);
        }
    }
    const ops: ConfigOperation[] = [];
    for (const d of service.describe()) {
        if (d.readOnly || choices.modules && !choices.modules.includes(d.moduleId))
            continue;
        const value = incoming[d.moduleId]?.[d.fieldId];
        if (value === undefined)
            continue;
        let next = portableMerge(current[d.moduleId][d.fieldId], stripReadOnly(value, d.schema));
        next = mapPaths(next, choices.pathMappings ?? {}, d.fieldId);
        if (d.moduleId === 'resources' && d.fieldId === 'files') {
            const files = value as Record<string, string>, absent = current.resources.absentPaths as string[] ?? [], existing = Object.fromEntries(Object.entries(current.resources.files as Record<string, string> ?? {}).filter(([path]) => !absent.includes(path))), result = { ...existing };
            for (const [path, text] of Object.entries(files)) {
                if (existing[path] !== undefined && existing[path] !== text) {
                    const choice = choices.resourceConflicts?.[path];
                    if (!choice)
                        throw new ConfigurationError('resource-conflict');
                    if (choice === 'keep')
                        continue;
                    if (existing[choice] !== undefined)
                        throw new ConfigurationError('resource-conflict');
                    result[choice] = text;
                }
                else
                    result[path] = text;
            }
            next = result;
        }
        if (canonical(next) !== canonical(current[d.moduleId][d.fieldId]))
            ops.push({ op: 'set', moduleId: d.moduleId, fieldId: d.fieldId, value: next });
    }
    if (!ops.length) {
        const currentRevision = (await service.read()).revision;
        if (baseRevision !== currentRevision)
            throw new ConfigurationError('conflict', [], { currentRevision });
        throw new ConfigurationError('no-changes');
    }
    return service.preview({ baseRevision, operations: ops });
}
