import { ROOT_DOCUMENTATION } from '../../configuration/documentationCatalog';
import { configurationError } from '../../configuration/errors';
import type { ConfigApplyResult, ConfigDescriptor, ConfigDomain, ConfigPreview } from '../../configuration/types';
import { settingsText as tr } from './settingsText';

export function configurationModuleName(moduleId: ConfigDomain): string {
    switch (moduleId) {
        case 'settings': return tr('Models, interface, folders, and extensions', '模型、界面、目录与扩展');
        case 'workspace': return tr('Knowledge bases and chat preferences', '知识库与对话偏好');
        case 'safeGuard': return 'Safe Guard';
        case 'hotkeys': return tr('Llmhub++ shortcuts', '本插件快捷键');
        case 'resources': return tr('Custom workflows, scripts, and skills', '自定义工作流、脚本与 Skills');
    }
}

export function configurationFieldLabel(field: ConfigDescriptor): string {
    const knowledge = ROOT_DOCUMENTATION[field.moduleId + '.' + field.fieldId];
    const english = field.description === field.fieldId
        ? field.fieldId.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, first => first.toUpperCase())
        : field.description;
    return tr(english, knowledge?.title ?? field.fieldId);
}

export function configurationStatusLabel(status: ConfigApplyResult['status']): string {
    switch (status) {
        case 'applied': return tr('Applied', '已应用');
        case 'reload-required': return tr('Reload required', '需要重载');
        case 'verification-failed': return tr('Verification failed', '验证失败');
        case 'recovery-required': return tr('Recovery required', '需要恢复');
    }
}

const englishErrors: Partial<Record<string, string>> = {
    LOCAL_PASSWORD_REQUIRED: 'Enter the original passphrase in this window before previewing the encrypted bundle.',
    WRONG_PASSWORD_OR_CORRUPT: 'Check the passphrase or try a complete backup. The bundle could not be unlocked.',
    LOCAL_RESOURCE_EXPORT_REQUIRED: 'Select the resource files and set a passphrase to export them with encryption.',
    RESOURCE_PATHS_REQUIRED: 'Select the resource files to include, or clear the resources module.',
    RESOURCE_NOT_FOUND: 'Check that the selected resource paths exist.',
    REVISION_CONFLICT: 'The configuration changed. Reopen the form and preview again.',
    PREVIEW_NOT_FOUND: 'The preview is no longer available. Preview again.',
    PREVIEW_EXPIRED: 'The preview expired. Preview again.',
    CONFIRMATION_INVALID: 'The confirmation does not match this preview. Review a new preview.',
    CONFIRMATION_REQUIRED: 'Review the risks in the preview and confirm the change.',
    VALIDATION_FAILED: 'Check that the values match the field types and allowed ranges.',
    INVALID_ARGUMENTS: 'Check the input format and try again.',
    READ_ONLY_FIELD: 'This field is maintained by the application.',
    RECOVERY_REQUIRED: 'The last update needs recovery. See the troubleshooting guide.',
    SAVE_FAILED: 'The change could not be saved. The previous configuration was restored.',
    BUSY: 'Wait for active work to finish and try again.',
};

export function configurationErrorText(error: unknown): string {
    const detail = configurationError(error);
    const code = String(detail.code);
    const english = englishErrors[code] ?? 'The operation could not be completed. Check the configuration and try again.';
    return tr(english, [detail.message, detail.hint].join('\n')) + '\n' + code;
}

const englishRiskByPath: Record<string, string> = {
    'safeGuard.enabled': 'Safe Guard checks will be disabled for requests sent through the proxy.',
    'safeGuard.upstreamBaseUrl': 'The proxy destination changes. Review where model requests and attachments will be sent.',
    'safeGuard.defaultReadOnlyEnabled': 'New chats can start with write access when read-only protection is disabled.',
    'safeGuard.enforceProxyReadOnly': 'The proxy will stop enforcing read-only tool access.',
    'settings.credentialStorage': 'Credential storage changes. Check access on this device and before restoring a backup.',
    'settings.cloudVaultToolAllowedFolders': 'The model tools can access a wider set of folders. Check the new scope before applying.',
    'resources.files': 'This import changes a managed resource that can be run as a script. Review the selected file before using it.',
    'settings.requestControls.budgetEnabled': 'Turning off the monthly hard budget allows requests beyond the limit or with unknown prices.',
    'settings.requestControls.monthlyBudgetCny': 'The new limit allows more managed spending this month.',
    'settings.requestControls.openingBalanceCny': 'Reducing earlier spending leaves more of the monthly budget available.',
    'settings.requestControls.openingBalanceMonth': 'Changing the opening balance month can leave more of the current budget available.',
    'settings.requestControls.outbound': 'The change relaxes the current restrictions on sending note text. Compare the previous and new policies.',
    'settings.requestControls.localOrigins': 'The new trusted origins can bypass restrictions applied to remote requests.',
    'settings.requestControls.redactionRules': 'Changing active redaction rules can allow previously redacted text to be sent.',
};

type PreviewDisplay = Pick<ConfigPreview, 'changes' | 'risks'> & Partial<Pick<ConfigPreview, 'issues' | 'warnings' | 'reloadRequired'>>;

export function configurationPreviewText(preview: PreviewDisplay): string {
    const risks = preview.risks?.map(risk => {
        const path = risk.path.split('.');
        const root = path.slice(0, 2).join('.');
        const english = englishRiskByPath[risk.path] ?? englishRiskByPath[root] ??
            'This change affects access, automation, or an executable setting. Review the changed value and field guidance before applying.';
        return { ...risk, reason: tr(english, risk.reason) };
    });
    const warnings = preview.warnings?.map(warning => warning.code === "REINDEX_REQUIRED" ? {
        ...warning,
        message: tr("Embedding or chunk settings changed. The existing index is kept. Review what to update before rebuilding.", warning.message),
    } : warning);
    return JSON.stringify({ ...preview, risks, warnings }, null, 2);
}
