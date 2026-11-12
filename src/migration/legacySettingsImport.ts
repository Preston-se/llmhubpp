/** Pure preparation only. The host must obtain explicit confirmation, persist a
 * backup before writing, and restart before loading imported settings. No file,
 * secret-store, workflow or model operation is performed by this module. */
export interface LegacyImportSummary {
  readonly apiProviders: number;
  readonly workflowTriggers: number;
  readonly workflowHotkeys: number;
  readonly slashCommands: number;
  readonly destinationExists: boolean;
  readonly reusesWorkspace: boolean;
  readonly usesDeviceSecrets: boolean;
}

export interface ConfirmedLegacySettingsImport {
  readonly settingsText: string;
  readonly previousSettingsText: string | null;
  readonly requiresRestart: true;
}

export interface LegacySettingsImportPlan {
  readonly summary: Readonly<LegacyImportSummary>;
  readonly confirm: (currentSource: string, currentDestination: string | null) => ConfirmedLegacySettingsImport;
}

export function prepareLegacySettingsImport(
  sourceText: string,
  destinationText: string | null,
): LegacySettingsImportPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    // Parser errors may include snippets containing credentials.
    throw new Error("Invalid legacy settings JSON object");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid legacy settings JSON object");
  }
  const settings = parsed as Record<string, unknown>;
  const count = (key: string): number => Array.isArray(settings[key]) ? settings[key].length : 0;
  const summary = Object.freeze({
    apiProviders: count("apiProviders"),
    workflowTriggers: count("enabledWorkflowEventTriggers"),
    workflowHotkeys: count("enabledWorkflowHotkeys"),
    slashCommands: count("slashCommands"),
    destinationExists: destinationText !== null,
    // Settings preserve the configured workspace (or the legacy default).
    // This does not copy its history, indexes or files into an isolated vault.
    reusesWorkspace: true,
    usesDeviceSecrets: settings.credentialStorage === "secretStorage",
  });
  return Object.freeze({
    summary,
    confirm: (currentSource: string, currentDestination: string | null): ConfirmedLegacySettingsImport => {
      // The host re-reads both files after the preview. Reject stale confirmation
      // rather than silently replacing settings that changed in the meantime.
      if (currentSource !== sourceText || currentDestination !== destinationText) {
        throw new Error("Settings changed since preview; prepare the import again");
      }
      // Retain the complete original text, including unknown advanced fields.
      // Do not merge defaults or credentials here; existing loaders handle that.
      return Object.freeze({ settingsText: sourceText, previousSettingsText: destinationText, requiresRestart: true });
    },
  });
}
