import type { IncomingMessage, Server, ServerResponse } from 'http';
import { createServer } from 'http';
import type { ConfigurationService } from '../service';
import { ConfigurationError } from '../types';
import { configurationError } from '../errors';
import { configurationSuccess } from './contracts';
import {getConfigurationStatus} from '../diagnostics';
import {CONFIGURATION_INSTRUCTIONS,listConfigurationResources,listConfigurationResourceTemplates,readConfigurationResource} from './resources';
import {listConfigurationPrompts,getConfigurationPrompt} from './prompts';
import { createConfigurationTools, executeConfigurationTool, type ConfigurationToolExtensions } from './tools';
export interface ConfigurationServerStatus {
    state: 'closed' | 'starting' | 'open' | 'failed';
    endpoint?: string;
    error?: string;
}
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export class ConfigurationMcpServer {
    private server: Server | null = null;
    private token = '';
    private state: ConfigurationServerStatus = { state: 'closed' };
    private stopping = false;
    private handles = new Map<string, {
        bytes: Uint8Array;
        kind: 'upload' | 'download';
    }>();
    private lifecycle = new AbortController();
    private disposed=false;
    private requests = new Map<string, AbortController>();
    constructor(private service: ConfigurationService, private extra: ConfigurationToolExtensions = {}) { }
    getStatus(): ConfigurationServerStatus { return { ...this.state }; }
    getSignal(): AbortSignal { return this.lifecycle.signal; }
    async start(): Promise<{
        endpoint: string;
        token: string;
    }> {
        if(this.disposed)throw new ConfigurationError('closed');
        if (this.state.state === 'open')
            return { endpoint: this.state.endpoint!, token: this.token };
        if (this.server)
            throw new ConfigurationError('starting');
        this.stopping = false;
        this.lifecycle = new AbortController();
        this.state = { state: 'starting' };
        this.token = Array.from(crypto.getRandomValues(new Uint8Array(32)), v => v.toString(16).padStart(2, '0')).join('');
        const server = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent)
            this.respond(res, 500, { error: 'internal-error' });
        else
            res.end(); }); });
        this.server = server;
        server.requestTimeout = 30000;
        server.headersTimeout = 10000;
        server.maxHeadersCount = 30;
        try {
            await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
            const address = server.address();
            if (!address || typeof address === 'string')
                throw new ConfigurationError('listen-failed');
            this.state = { state: 'open', endpoint: `http://127.0.0.1:${address.port}/mcp` };
            return { endpoint: this.state.endpoint!, token: this.token };
        }
        catch {
            this.state = { state: 'failed', error: '无法开启本机配置服务' };
            server.close();
            this.server = null;
            throw new ConfigurationError('listen-failed');
        }
    }
    async stop(): Promise<void> { this.stopping = true; this.lifecycle.abort(); this.token = ''; this.handles.clear(); const server = this.server; this.server = null; this.state = { state: 'closed' }; if (server) {
        const closed = new Promise<void>(resolve => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
    } await this.service.drain(); }
    async dispose():Promise<void>{this.disposed=true;await this.stop();}
    /** Invalidate requests and bundle handles from the previous session. A journaled write can still finish or roll back. */
    rotateToken(): Promise<string> { this.lifecycle.abort(); this.lifecycle = new AbortController(); this.token = crypto.randomUUID() + crypto.randomUUID(); this.handles.clear(); return Promise.resolve(this.token); }
    putDownload(bytes: Uint8Array): {
        handle: string;
        path: string;
    } { if (bytes.byteLength > 20 * 1024 * 1024)
        throw new ConfigurationError('bundle-too-large'); const handle = crypto.randomUUID(); if (this.handles.size >= 10)
        this.handles.delete(this.handles.keys().next().value!); this.handles.set(handle, { bytes, kind: 'download' }); return { handle, path: `/configuration-bundles/${handle}` }; }
    getUpload(handle: string): Uint8Array { const item = this.handles.get(handle); if (item?.kind !== 'upload')
        throw new ConfigurationError('invalid-handle'); return item.bytes; }
    private respond(res: ServerResponse, status: number, value?: unknown) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(value === undefined ? '' : JSON.stringify(value)); }
    private async body(req: IncomingMessage, max: number): Promise<Uint8Array> { const parts: Buffer[] = []; let length = 0; for await (const part of req) {
        const bytes = Buffer.from(part as Uint8Array);
        length += bytes.length;
        if (length > max)
            throw new ConfigurationError('request-too-large');
        parts.push(bytes);
    } return Buffer.concat(parts); }
    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1'), expected = new URL(this.state.endpoint ?? 'http://127.0.0.1');
        if (this.stopping || this.state.state !== 'open') {
            this.respond(res, 503);
            return;
        }
        if (req.headers.host !== expected.host || req.headers.origin && req.headers.origin !== expected.origin) {
            this.respond(res, 403);
            return;
        }
        if (req.headers.authorization !== `Bearer ${this.token}`) {
            this.respond(res, 401);
            return;
        }
        const lifecycle = this.lifecycle.signal;
        if (req.headers['mcp-protocol-version'] && !VERSIONS.includes(String(req.headers['mcp-protocol-version']))) {
            this.respond(res, 400);
            return;
        }
        if (url.pathname === '/configuration-bundles' && req.method === 'POST') {
            try {
                const bytes = await this.body(req, 20 * 1024 * 1024);
                if (lifecycle.aborted) {
                    this.respond(res, 401);
                    return;
                }
                const handle = crypto.randomUUID();
                if (this.handles.size >= 10)
                    this.handles.delete(this.handles.keys().next().value!);
                this.handles.set(handle, { bytes, kind: 'upload' });
                this.respond(res, 200, { uploadHandle: handle });
            }
            catch {
                this.respond(res, 413);
            }
            return;
        }
        if (url.pathname.startsWith('/configuration-bundles/') && req.method === 'GET') {
            const item = this.handles.get(url.pathname.split('/').pop()!);
            if (!item || item.kind !== 'download') {
                this.respond(res, 404);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="llmhubpp-config.zip"', 'Cache-Control': 'no-store' });
            res.end(item.bytes);
            return;
        }
        if (url.pathname !== '/mcp') {
            this.respond(res, 404);
            return;
        }
        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            this.respond(res, 405);
            return;
        }
        if (!req.headers['content-type']?.includes('application/json')) {
            this.respond(res, 415);
            return;
        }
        let message: {
            jsonrpc?: string;
            id?: number | string;
            method?: string;
            params?: Record<string, unknown>;
        };
        try {
            message = JSON.parse(new TextDecoder().decode(await this.body(req, 2 * 1024 * 1024))) as typeof message;
        }
        catch (error) {
            this.respond(res, error instanceof ConfigurationError ? 413 : 400);
            return;
        }
        if (lifecycle.aborted) {
            this.respond(res, 401);
            return;
        }
        if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            this.respond(res, 400);
            return;
        }
        if (message.id === undefined) {
            if (message.method === 'notifications/cancelled')
                this.requests.get(String(message.params?.requestId))?.abort();
            this.respond(res, 202);
            return;
        }
        const params = message.params ?? {};
        let result: unknown;
        switch (message.method) {
            case 'initialize':
                result = { protocolVersion: VERSIONS.includes(String(params.protocolVersion)) ? params.protocolVersion : VERSIONS[0], serverInfo: { name: 'llmhubpp-configuration', version: '1.1.0' }, capabilities: { tools: {}, resources: {},prompts:{} },instructions:CONFIGURATION_INSTRUCTIONS };
                break;
            case 'ping':
                result = {};
                break;
            case 'tools/list':
                result = { tools: createConfigurationTools() };
                break;
            case 'resources/list':
                result = listConfigurationResources();
                break;
            case 'resources/templates/list':result=listConfigurationResourceTemplates();break;
            case 'resources/read':
                try{result=readConfigurationResource(this.service,params.uri);}catch{
                    this.respond(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown-resource' } });
                    return;
                }
                break;
            case 'prompts/list':result=listConfigurationPrompts();break;
            case 'prompts/get':
                try{result=await getConfigurationPrompt(params,answers=>this.extra.status?this.extra.status(answers):getConfigurationStatus({service:this.service},answers));}catch{
                    this.respond(res,200,{jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'invalid-prompt-arguments'}});return;
                }break;
            case 'tools/call': {
                const controller = new AbortController(), abort = () => controller.abort();
                lifecycle.addEventListener('abort', abort, { once: true });
                if (lifecycle.aborted) controller.abort();
                this.requests.set(String(message.id), controller);
                try {
                    if (typeof params.name !== 'string' || params.arguments !== undefined && (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)))
                        throw new ConfigurationError('invalid-arguments');
                    const value = await executeConfigurationTool(this.service, params.name, params.arguments as Record<string, unknown> ?? {}, this.extra, controller.signal);
                    const failed=value&&typeof value==='object'&&Reflect.get(value,'success')===false;
                    const structuredContent = failed?{...value,...configurationError(new ConfigurationError('connection-failed'))}:configurationSuccess(value);
                    result = { ...(failed?{isError:true}:{}),content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
                }
                catch (error) {
                    const structuredContent=configurationError(error);
                    result = { isError: true, content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
                }
                finally {
                    this.requests.delete(String(message.id));
                    lifecycle.removeEventListener('abort', abort);
                }
                break;
            }
            default:
                this.respond(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method-not-found' } });
                return;
        }
        this.respond(res, 200, { jsonrpc: '2.0', id: message.id, result });
    }
}
