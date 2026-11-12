import { expect, it } from 'vitest';
import { request } from 'http';
import { once } from 'events';
import { configurationFixture } from '../configurationFixture.test-utils';
import { ConfigurationMcpServer } from './server';
import { getConfigurationStatus } from '../diagnostics';

function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}
async function halfRequest(endpoint: string, token: string, body: string) {
    const req = request(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Expect: '100-continue' } });
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
        req.on('error', reject);
        req.on('response', res => {
            let text = '';
            res.on('data', part => { text += String(part); });
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode!, body: text }));
        });
    });
    req.flushHeaders();
    await once(req, 'continue');
    const split = Math.floor(body.length / 2);
    req.write(body.slice(0, split));
    return { req, response, finish: () => req.end(body.slice(split)) };
}
async function rpc(endpoint: string, token: string, method: string, params: object) {
    const res = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return res.json();
}

it('rejects an old authenticated half-body apply after token rotation and permits a fresh-session retry', async () => {
    const f = configurationFixture(), server = new ConfigurationMcpServer(f.service), connection = await server.start();
    const p = await f.service.preview({ baseRevision: (await f.service.read()).revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 27 }] });
    const args = { previewId: p.id, baseRevision: p.baseRevision, requestId: 'half-body' };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'configuration_apply', arguments: args } });
    const pending = await halfRequest(connection.endpoint, connection.token, body);
    try {
        const newToken = await server.rotateToken();
        pending.finish();
        expect((await pending.response).status).toBe(401);
        expect(f.writes).toEqual([]);
        expect(f.raw.settings.maxFunctionCalls).toBe(20);
        const result = await rpc(connection.endpoint, newToken, 'tools/call', { name: 'configuration_apply', arguments: args });
        expect(result.result.structuredContent.persisted).toBe(true);
        expect(f.raw.settings.maxFunctionCalls).toBe(27);
    } finally { pending.req.destroy(); await server.dispose(); }
});

it('does not create a new upload handle from an old-session partial upload', async () => {
    const f = configurationFixture(), server = new ConfigurationMcpServer(f.service), connection = await server.start();
    const pending = await halfRequest(connection.endpoint.replace('/mcp', '/configuration-bundles'), connection.token, 'synthetic-upload');
    try {
        await server.rotateToken();
        pending.finish();
        const result = await pending.response;
        expect(result.status).toBe(401);
        expect(result.body).not.toContain('uploadHandle');
    } finally { pending.req.destroy(); await server.dispose(); }
});

it('cancels a fully received apply if rotation occurs during validation before the journal starts', async () => {
    const f = configurationFixture(), server = new ConfigurationMcpServer(f.service), connection = await server.start();
    const p = await f.service.preview({ baseRevision: (await f.service.read()).revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 27 }] });
    const entered = gate(), release = gate();
    f.backend.validate = async () => { entered.resolve(); await release.promise; return []; };
    const pending = rpc(connection.endpoint, connection.token, 'tools/call', { name: 'configuration_apply', arguments: { previewId: p.id, baseRevision: p.baseRevision, requestId: 'pre-journal' } });
    try {
        await entered.promise;
        await server.rotateToken();
        release.resolve();
        expect((await pending).result.structuredContent).toMatchObject({ ok: false, code: 'SERVICE_CLOSED' });
        expect(f.writes).toEqual([]);
    } finally { release.resolve(); await pending; await server.dispose(); }
});

it('finishes an apply already admitted to the journal so rotation cannot leave a partial transaction', async () => {
    const f = configurationFixture(), server = new ConfigurationMcpServer(f.service), connection = await server.start();
    const p = await f.service.preview({ baseRevision: (await f.service.read()).revision, operations: [{ op: 'set', moduleId: 'settings', fieldId: 'maxFunctionCalls', value: 27 }] });
    const entered = gate(), release = gate();
    f.backend.journal = async value => { if (value) { entered.resolve(); await release.promise; } };
    const pending = rpc(connection.endpoint, connection.token, 'tools/call', { name: 'configuration_apply', arguments: { previewId: p.id, baseRevision: p.baseRevision, requestId: 'post-journal' } });
    try {
        await entered.promise;
        await server.rotateToken();
        release.resolve();
        expect((await pending).result.structuredContent).toMatchObject({ ok: true, persisted: true });
        expect(f.raw.settings.maxFunctionCalls).toBe(27);
    } finally { release.resolve(); await pending; await server.dispose(); }
});

it.each([false, true])('uses purpose=notes for both status and first-setup prompt with host extension %s', async extension => {
    const f = configurationFixture();
    Object.assign((f.raw.settings.apiProviders as object[])[0], { verified: true, enabledModels: ['m'] });
    f.raw.workspace.selectedModel = 'api:a:m';
    const server = new ConfigurationMcpServer(f.service, extension ? { status: answers => getConfigurationStatus({ service: f.service }, answers) } : {}), connection = await server.start();
    try {
        const answers = { purpose: 'notes' };
        const status = (await rpc(connection.endpoint, connection.token, 'tools/call', { name: 'configuration_status', arguments: { answers } })).result.structuredContent;
        const prompt = (await rpc(connection.endpoint, connection.token, 'prompts/get', { name: 'first-setup', arguments: { answers: JSON.stringify(answers) } })).result;
        const guidance = JSON.parse(prompt.messages[0].content.text.split('\n\n').slice(1).join('\n\n'));
        expect(guidance.phase).toBe('ask-core');
        expect(guidance.questions).toContainEqual(expect.objectContaining({ id: 'materials' }));
        expect(guidance).toEqual(status.setup.guidance);
        expect(f.writes).toEqual([]);
    } finally { await server.dispose(); }
});
