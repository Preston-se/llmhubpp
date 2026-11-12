export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonObject = {
    [key: string]: JsonValue;
};
export type ConfigDomain = 'settings' | 'workspace' | 'safeGuard' | 'hotkeys' | 'resources';
export type RawSnapshot = Record<ConfigDomain, Record<string, unknown>>;
export interface ConfigSchema {
    type?: string;
    enum?: unknown[];
    anyOf?: ConfigSchema[];
    properties?: Record<string, ConfigSchema>;
    required?: string[];
    additionalProperties?: ConfigSchema | boolean;
    items?: ConfigSchema;
    description?: string;
    default?: unknown;
    minimum?: number;
    maximum?: number;
    readOnly?: boolean;
}
export interface ConfigDescriptor {
    moduleId: ConfigDomain;
    fieldId: string;
    schema: ConfigSchema;
    description: string;
    sensitive: boolean;
    readOnly: boolean;
    effect: 'live' | 'reload';
    help: string;
    defaultValue?: unknown;
}
export interface ConfigOperation {
    op: 'set' | 'clear' | 'create' | 'update' | 'remove';
    moduleId: ConfigDomain;
    fieldId: string;
    entityId?: string;
    value?: unknown;
}
export interface ConfigPatch {
    baseRevision: string;
    operations: ConfigOperation[];
}
export interface ConfigIssue {
    code: string;
    moduleId?: string;
    fieldId?: string;
    message: string;
}
export interface ConfigChange {
    moduleId: ConfigDomain;
    fieldId: string;
    entityId?: string;
    before: unknown;
    after: unknown;
}
export interface ConfigWarning {code:string;path:string;message:string;fix:string}
export interface ConfigSnapshot {
    revision: string;
    modules: RawSnapshot;
}
export interface ConfigPreview {
    risks?:import('./risk').ConfigurationRisk[];
    confirmation?:{required:true;token:string};
    id: string;
    baseRevision: string;
    expiresAt: number;
    changes: ConfigChange[];
    issues: ConfigIssue[];
    reloadRequired: boolean;
    warnings?: ConfigWarning[];
}
export interface ConfigApplyResult {
    persisted?:boolean;
    changes?:ConfigActivation[];
    operationId: string;
    revision: string;
    status: 'applied' | 'reload-required' | 'verification-failed' | 'recovery-required';
    issues: ConfigIssue[];
    warnings?: ConfigWarning[];
}
export interface ConfigHistoryEntry {
    activation?:ConfigActivation[];
    operationId: string;
    time: number;
    changes: ConfigChange[];
    status: ConfigApplyResult['status'];
    revision: string;
}
export interface ConfigActivation{moduleId:ConfigDomain;fieldId:string;entityId?:string;saved:boolean;activation:'applied'|'pending-reload'|'activation-failed';operationId:string}
export interface ConfigurationJournal {
    id: string;
    before: RawSnapshot;
    after: RawSnapshot;
    domains: ConfigDomain[];
    state: 'pending' | 'recovery-required';
    hasSecrets: boolean;
}
export interface ConfigurationBackend {
    read(): Promise<RawSnapshot>;
    write(domain: ConfigDomain, value: Record<string, unknown>, phase?: 'apply' | 'rollback'): Promise<void>;
    activate(domains: ConfigDomain[]): Promise<{
        reloadRequired: boolean;
    }>;
    journal(value: ConfigurationJournal | null, before?: RawSnapshot): Promise<void>;
    loadJournal(): Promise<ConfigurationJournal | null>;
    validate?(before: RawSnapshot, after: RawSnapshot, operations: ConfigOperation[]): Promise<ConfigIssue[]>;
    recordHistory?(entries: ConfigHistoryEntry[]): Promise<void>;
    loadHistory?(): Promise<ConfigHistoryEntry[]>;
}
export class ConfigurationError extends Error {
    constructor(public code: string, public issues: ConfigIssue[] = [], public context: Record<string, unknown> = {}) { super(code); this.name = 'ConfigurationError'; }
}
