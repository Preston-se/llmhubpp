import type { HostConfiguration } from './host';
import { ConfigurationError } from './types';
import { normalizeStoragePath } from '../core/storagePaths';
import { attestConnection } from './verification';
export { probeEndpoint } from './probe';
export async function checkConfiguration(configuration: HostConfiguration, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const { kind, targetId } = input;
    if (typeof targetId !== 'string')
        throw new ConfigurationError('invalid-target');
    const host = configuration.host, base = (await configuration.service.read()).revision;
    const origin=configuration.captureDraft();
    if (kind === 'path')
        return { exists: await host.app.vault.adapter.exists(normalizeStoragePath(targetId, true)), scope: 'vault' };
    if (kind === 'resource') {
        await configuration.inspectResources([targetId]);
        return { path: targetId, exists: await host.app.vault.adapter.exists(targetId), snapshot: await configuration.service.read(['resources']) };
    }
    let timer: number | undefined;
    let expired = false;
    let abort: () => void = () => { };
    const ensureCurrent = async () => { if (expired || signal?.aborted)
        throw new ConfigurationError('check-cancelled'); if ((await configuration.service.read()).revision !== base)
        throw new ConfigurationError('conflict'); };
    const action = async () => {
        if (kind === 'api') {
            const provider = host.settings.apiProviders.find(p => p.id === targetId);
            if (!provider)
                throw new ConfigurationError('entity-not-found');
            const p = structuredClone(provider), proxy = host.settings.proxyUrl, bypass = host.settings.proxyBypass;
            const result = p.type === 'gemini' ? await (await import('../core/gemini')).verifyGeminiProvider(p.apiKey, proxy, bypass) : p.type === 'anthropic' ? await (await import('../core/anthropicProvider')).verifyAnthropicProvider(p.baseUrl, p.apiKey, proxy, bypass) : p.type === 'opencodego' ? await (await import('../core/openaiProvider')).verifyOpencodeGo(p.baseUrl, p.apiKey, proxy, bypass) : await (await import('../core/openaiProvider')).verifyApiProvider(p.baseUrl, p.apiKey, proxy, bypass);
            await ensureCurrent();
            if (!result.success)
                return { success: false, code: 'connection-failed' };
            const draft = structuredClone(host.settings);
            const next = draft.apiProviders.find(x => x.id === targetId)!;
            next.availableModels = result.models ?? [];
            next.verified = true;
            next.verification=await attestConnection(p as unknown as Record<string,unknown>,{proxyUrl:proxy,proxyBypass:bypass});
            await ensureCurrent();
            await configuration.saveUi('settings', draft as unknown as Record<string, unknown>, origin);
            return { success: true, models: result.models ?? [] };
        }
        if (kind === 'local') {
            const config = host.settings.localLlmConfigs.find(p => p.id === targetId);
            if (!config)
                throw new ConfigurationError('entity-not-found');
            const checked=structuredClone(config);
            const result = await (await import('../core/localLlmProvider')).verifyLocalLlm(checked);
            await ensureCurrent();
            if (!result.success)
                return { success: false, code: 'connection-failed' };
            const draft = structuredClone(host.settings), next = draft.localLlmConfigs.find(x => x.id === targetId)!;
            next.verified = true;
            next.availableModels = result.models ?? [];
            next.verification=await attestConnection(checked as unknown as Record<string,unknown>);
            await ensureCurrent();
            await configuration.saveUi('settings', draft as unknown as Record<string, unknown>, origin);
            return { success: true, models: result.models ?? [] };
        }
        if (kind === 'embedding') {
            const rag = host.workspaceState.ragSettings[targetId];
            if (!rag)
                throw new ConfigurationError('entity-not-found');
            const { resolveEmbeddingConnection } = await import('../core/embeddingCredentials');
            const connection = resolveEmbeddingConnection(rag, host.settings);
            if (connection.status !== 'ready') return { success: false, code: 'connection-failed' };
            const models = await (await import('../core/embeddingProvider')).fetchEmbeddingModels(connection.apiKey, connection.baseUrl, host.settings.proxyUrl, host.settings.proxyBypass);
            await ensureCurrent();
            return { models };
        }
        if (kind === 'mcp') {
            const server = host.settings.mcpServers.find(s => Reflect.get(s, 'id') === targetId || s.name === targetId);
            if (!server)
                throw new ConfigurationError('entity-not-found');
            const client = (await import('../core/mcpClient')).createMcpClient(server);
            try {
                await client.initialize();
                const tools = await client.listTools();
                await ensureCurrent();
                return { tools };
            }
            finally {
                await client.close();
            }
        }
        if (kind === 'cli') {
            const cli = await import('../core/cliProvider'), cfg = host.settings.cliConfig;
            if (!['codex', 'claude', 'antigravity'].includes(targetId))
                throw new ConfigurationError('invalid-target');
            const result = targetId === 'codex' ? await cli.verifyCodexCli(cfg.codexCliPath) : targetId === 'claude' ? await cli.verifyClaudeCli(cfg.claudeCliPath) : await cli.verifyCli(cfg.geminiCliPath);
            await ensureCurrent();
            if (result.success) {
                const draft = structuredClone(host.settings);
                if (targetId === 'codex')
                    draft.cliConfig.codexCliVerified = true;
                else if (targetId === 'claude')
                    draft.cliConfig.claudeCliVerified = true;
                else
                    draft.cliConfig.cliVerified = true;
                await configuration.saveUi('settings', draft as unknown as Record<string, unknown>, origin);
            }
            return { success: result.success };
        }
        throw new ConfigurationError('invalid-check-kind');
    };
    try {
        return await Promise.race([action(), new Promise((_, reject) => { abort = () => { expired = true; reject(new ConfigurationError('check-cancelled')); }; if (signal?.aborted)
                abort();
            else
                signal?.addEventListener('abort', abort, { once: true }); timer = window.setTimeout(() => { expired = true; reject(new ConfigurationError('check-timeout')); }, 60000); })]);
    }
    catch (error) {
        if (error instanceof ConfigurationError)
            throw error;
        throw new ConfigurationError('check-failed');
    }
    finally {
        if (timer)
            window.clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}
