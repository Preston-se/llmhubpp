import { ConfigurationError, type ConfigDescriptor, type ConfigSchema } from './types';
import { blockedKeys, isSensitiveKey } from './validation';

export const CONFIGURATION_MODULES = ['settings', 'workspace', 'safeGuard', 'hotkeys', 'resources'] as const;
export interface FieldPath extends ConfigDescriptor { path: string; root: string }
export function assertConfigurationModules(modules?: string[]): void {
    if (modules === undefined) return;
    if (!Array.isArray(modules) || modules.some(module => typeof module !== 'string')) throw new ConfigurationError('invalid-arguments');
    const unknown = modules.filter(module => !(CONFIGURATION_MODULES as readonly string[]).includes(module));
    if (unknown.length) {
        const suggested = [...new Set(unknown.map(module => module.split('.')[0]).filter(module => (CONFIGURATION_MODULES as readonly string[]).includes(module)))];
        throw new ConfigurationError('unknown-module', [], { didYouMean: suggested.length ? suggested : [...CONFIGURATION_MODULES], parameter: 'modules', useFieldPaths: unknown.some(module=>module.includes('.')) });
    }
}
export function collectFieldPaths(descriptors: ConfigDescriptor[]): FieldPath[] {
    const paths = new Map<string, FieldPath>();
    for (const descriptor of descriptors) {
        const root = descriptor.moduleId + '.' + descriptor.fieldId;
        const visit = (schema: ConfigSchema, path: string, readonly: boolean, sensitive: boolean) => {
            const field = { ...descriptor, path, root, schema, readOnly: readonly || schema.readOnly === true,
                sensitive: sensitive || path.split('.').some(isSensitiveKey), description: schema.description || descriptor.description };
            if (!paths.has(path)) paths.set(path, field);
            for (const [name, child] of Object.entries(schema.properties ?? {})) visit(child, path+'.'+name,field.readOnly,field.sensitive);
            if (schema.items) visit(schema.items,path+'.*',field.readOnly,field.sensitive);
            if (typeof schema.additionalProperties === 'object') visit(schema.additionalProperties,path+'.*',field.readOnly,field.sensitive);
            for (const alternative of schema.anyOf ?? []) visit(alternative,path,field.readOnly,field.sensitive);
        };
        visit(descriptor.schema,root,descriptor.readOnly,descriptor.sensitive);
    }
    return [...paths.values()];
}
export function findFieldPath(fields: FieldPath[], path: string): FieldPath | undefined {
    if (typeof path !== 'string' || path.length > 400 || path.split('.').some(part=>!part || blockedKeys.has(part))) return undefined;
    return fields.find(field=>field.path===path) ?? fields.find(field=>{
        const actual=path.split('.'), declared=field.path.split('.');
        return actual.length===declared.length && declared.every((part,index)=>part===actual[index] || part==='*' && !/^\d+$/.test(actual[index]));
    });
}
