import type { LlmHubPlugin } from "src/plugin";
import type {ConfigPatch,ConfigApplyResult} from '../../configuration/types';

export interface SettingsContext {
  plugin: LlmHubPlugin;
  display: () => void;
  /** Mutable ref for RAG sync cancellation */
  syncCancelRef: { value: boolean; controllers: Map<string, AbortController> };
}

/** All new controls can explicitly use the same validated path as the external Agent. */
export async function applyConfiguration(ctx:SettingsContext,patch:ConfigPatch):Promise<ConfigApplyResult>{
 const service=ctx.plugin.configuration?.service;if(!service)throw Error('configuration-unavailable');
 const preview=await service.preview(patch);return service.apply({previewId:preview.id,baseRevision:preview.baseRevision,requestId:crypto.randomUUID()});
}
