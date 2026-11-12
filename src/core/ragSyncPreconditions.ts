import { t } from "src/i18n";

export type RagSyncPreconditionCode = "store-unavailable" | "setting-not-found" | "index-not-syncable" | "embedding-missing";

export class RagSyncPreconditionError extends Error {
  constructor(readonly code: RagSyncPreconditionCode) {
    super(t({
      "store-unavailable": "sync.errorStoreUnavailable",
      "setting-not-found": "sync.errorSettingMissing",
      "index-not-syncable": "settings.externalIndexSyncDisabled",
      "embedding-missing": "sync.errorEmbeddingMissing",
    }[code] as Parameters<typeof t>[0]));
    this.name = "RagSyncPreconditionError";
  }
}

export function assertRagSyncReady(input: {
  storeReady: boolean;
  setting: { externalIndexPath?: string; sourceRagSettings?: string[]; embeddingBaseUrl?: string } | null | undefined;
  embeddingKey: string;
}): void {
  if (!input.storeReady) throw new RagSyncPreconditionError("store-unavailable");
  if (!input.setting) throw new RagSyncPreconditionError("setting-not-found");
  if (input.setting.externalIndexPath || input.setting.sourceRagSettings?.length) throw new RagSyncPreconditionError("index-not-syncable");
  if (!input.setting.embeddingBaseUrl && !input.embeddingKey) throw new RagSyncPreconditionError("embedding-missing");
}
