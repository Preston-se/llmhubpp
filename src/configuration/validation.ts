import { ConfigurationError, type ConfigSchema } from './types';
export const blockedKeys = new Set(['__proto__', 'prototype', 'constructor']);
export function assertSafe(value: unknown, depth = 0): void {
    if (depth > 40)
        throw new ConfigurationError('too-deep');
    if (typeof value === 'number' && !Number.isFinite(value))
        throw new ConfigurationError('invalid');
    if (value && typeof value === 'object')
        for (const [key, child] of Object.entries(value)) {
            if (blockedKeys.has(key))
                throw new ConfigurationError('invalid-key');
            assertSafe(child, depth + 1);
        }
}
export function matchesSchema(value: unknown, schema: ConfigSchema, partial = false): boolean {
    if (schema.readOnly)
        return false;
    if (schema.enum)
        return schema.enum.includes(value);
    if (schema.anyOf)
        return schema.anyOf.some(s => matchesSchema(value, s, partial));
    switch (schema.type) {
        case 'string': return typeof value === 'string';
        case 'boolean': return typeof value === 'boolean';
        case 'number':
        case 'integer': return typeof value === 'number' && Number.isFinite(value)
            && (schema.type !== 'integer' || Number.isInteger(value))
            && (schema.minimum === undefined || value >= schema.minimum)
            && (schema.maximum === undefined || value <= schema.maximum);
        case 'null': return value === null;
        case 'array': return Array.isArray(value) && value.every(v => matchesSchema(v, schema.items ?? {}));
        case 'object': {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
            const required = (schema.required ?? []).filter(key => !schema.properties?.[key]?.readOnly);
            if (!partial && !required.every(key => Object.prototype.hasOwnProperty.call(value, key))) return false;
            return Object.entries(value).every(([key, entry]) => {
                const property = Object.prototype.hasOwnProperty.call(schema.properties ?? {}, key) ? schema.properties?.[key] : undefined;
                // In-memory settings can explicitly carry an unset optional field before JSON serialization.
                if (entry === undefined && property && !property.readOnly && !required.includes(key)) return true;
                const entrySchema = property ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
                return !!entrySchema && matchesSchema(entry, entrySchema, partial);
            });
        }
        default: return false;
    }
}
export const isSensitiveKey = (key: string): boolean => /(?:api.?key|secret|password|token$|authorization|headers|^env$|privatekey|^salt$|fingerprint)/i.test(key);
export function hasEmbeddedCredentials(value: unknown): boolean {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value))
        return false;
    try {
        const url = new URL(value);
        return !!url.username || !!url.password || [...url.searchParams.keys()].some(key => /(?:key|token|secret|password|sig(?:nature)?)/i.test(key));
    }
    catch {
        return false;
    }
}
export const sensitiveResourceText = (value: unknown): boolean => typeof value === 'string' && /(?:api[_-]?key|access[_-]?token|password|secret|authorization)[\s"']*[:=]/i.test(value);
export function secretMaterial(value: unknown, path: string[] = [], result: Record<string, unknown> = {}): Record<string, unknown> {
    if (value && typeof value === 'object')
        for (const [key, child] of Object.entries(value)) {
            if (isSensitiveKey(key) || hasEmbeddedCredentials(child) || /\.(?:json|ya?ml|ps1|py|js|mjs|cjs|sh|md|txt)$/i.test(key) && sensitiveResourceText(child)) {
                if (child !== undefined && child !== null && child !== '')
                    result[JSON.stringify([...path, key])] = child;
            }
            else
                secretMaterial(child, [...path, key], result);
        }
    return result;
}
export function redact(value: unknown, key = '', mode: 'display' | 'omit' = 'display'): unknown {
    if (['contextMemories', 'sentPromptHistory', 'discussionSettings'].includes(key))
        return mode === 'omit' ? undefined : { managed: true };
    if (isSensitiveKey(key) || hasEmbeddedCredentials(value) || /\.(?:json|ya?ml|ps1|py|js|mjs|cjs|sh|md|txt)$/i.test(key) && sensitiveResourceText(value))
        return mode === 'omit' ? undefined : { configured: value !== undefined && value !== null && value !== '' };
    if (Array.isArray(value))
        return value.map(v => redact(v, '', mode));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).flatMap(([k, v]) => { const r = redact(v, k, mode); return r === undefined ? [] : [[k, r]]; }));
    return value;
}
export function mergeObject(old: unknown, next: unknown): unknown {
    if (!old || !next || Array.isArray(next) || typeof old !== 'object' || typeof next !== 'object')
        return structuredClone(next);
    const result = { ...old };
    for (const [key, value] of Object.entries(next))
        Reflect.set(result, key, mergeObject(Reflect.get(result, key), value));
    return result;
}
/** Restore the old topology while retaining only unchanged, omitted secrets and transient user state. */
export function restoreConfigurationValue(before: unknown, current: unknown): unknown {
    if (Array.isArray(before))
        return before.map(item => { const id: unknown = item && typeof item === 'object' ? Reflect.get(item, 'id') : undefined; const match: unknown = Array.isArray(current) ? current.find((v: unknown) => id !== undefined && v && typeof v === 'object' && Reflect.get(v, 'id') === id) : undefined; return restoreConfigurationValue(item, match); });
    if (before && typeof before === 'object') {
        const result: Record<string, unknown> = Object.fromEntries(Object.entries(before).map(([key, value]) => [key, restoreConfigurationValue(value, current && typeof current === 'object' ? Reflect.get(current, key) : undefined)]));
        if (current && typeof current === 'object')
            for (const [key, value] of Object.entries(current))
                if (!Object.prototype.hasOwnProperty.call(result, key) && (isSensitiveKey(key) || hasEmbeddedCredentials(value) || sensitiveResourceText(value) || ['contextMemories', 'sentPromptHistory', 'discussionSettings'].includes(key)))
                    result[key] = structuredClone(value);
        return result;
    }
    return structuredClone(before);
}
