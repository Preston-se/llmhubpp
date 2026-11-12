import { expect, it } from 'vitest';
import Ajv from 'ajv';
import { ConfigurationMcpServer } from './server';
import { configurationFixture } from '../configurationFixture.test-utils';

it('offers consumer-valid output contracts and actionable execution errors over authenticated HTTP', async () => {
    const f = configurationFixture(), server = new ConfigurationMcpServer(f.service), connection = await server.start();
    const call = async (method: string, params: unknown) => (await (await fetch(connection.endpoint, {
        method: 'POST', headers: { Authorization: 'Bearer '+connection.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })).json()).result;
    try {
        const list = await call('tools/list', {});
        const consumer = new Ajv({ allErrors: true });
        for (const tool of list.tools) {
            expect(tool.title).toBeTruthy();
            expect(tool.outputSchema).toMatchObject({ type: 'object' });
            expect(typeof tool.annotations.idempotentHint).toBe('boolean');
        }
        const snap = await f.service.read();
        const error = await call('tools/call', { name: 'configuration_apply', arguments: { previewId: 'never-created', baseRevision: snap.revision, requestId: 'missing' } });
        expect(error.isError).toBe(true);
        expect(error.structuredContent).toMatchObject({ ok: false, code: 'PREVIEW_NOT_FOUND', retryable: true });
        expect(error.structuredContent.message.length).toBeGreaterThan(5);
        expect(error.structuredContent.hint).toMatch(/preview/);
        expect(JSON.parse(error.content[0].text)).toEqual(error.structuredContent);
        const apply = list.tools.find((tool: {name:string}) => tool.name === 'configuration_apply');
        expect(consumer.validate(apply.outputSchema,error.structuredContent),JSON.stringify(consumer.errors)).toBe(true);
        const read = await call('tools/call', { name: 'configuration_read', arguments: { fieldPaths: ['safeGuard.upstreamBaseUrl'] } });
        const schema = list.tools.find((tool: {name:string}) => tool.name === 'configuration_read').outputSchema;
        expect(consumer.validate(schema,read.structuredContent),JSON.stringify(consumer.errors)).toBe(true);
        expect(JSON.stringify(read)).not.toContain('PRIVATE-KEY');
    } finally { await server.dispose(); }
});
