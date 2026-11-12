import { it, expect } from 'vitest';
import { matchesSchema, redact } from './validation';
import { createRegistry } from './registry';
import type { ConfigSchema } from './types';

it('accepts an unset optional property while enforcing required and unknown properties', () => {
    const schema: ConfigSchema = { type: 'object', required: ['name'], additionalProperties: false,
        properties: { name: { type: 'string' }, headers: { type: 'object' } } };
    expect(matchesSchema({ name: 'Search', headers: undefined }, schema)).toBe(true);
    expect(matchesSchema({ name: undefined }, schema)).toBe(false);
    expect(matchesSchema({ name: 'Search', unknown: undefined }, schema)).toBe(false);
    expect(matchesSchema({ name: 'Search', headers: '' }, schema)).toBe(false);
});
it('omits credentials embedded in URLs and treats access tokens as secrets', () => {
    const value = { proxyUrl: 'http://user:SECRET@127.0.0.1:9000', baseUrl: 'https://example.test?api_key=SECRET', accessToken: 'SECRET', contextWindowTokens: 16000 };
    const output = redact(value, '', 'omit');
    expect(JSON.stringify(output)).not.toContain('SECRET');
    expect(output).toMatchObject({ contextWindowTokens: 16000 });
});
it('accepts whole seconds from 5 to 900 for the index delay in configuration transactions', () => {
    const schema = createRegistry().find(field => field.moduleId === 'settings' && field.fieldId === 'ragIndexIdleSeconds')?.schema;
    expect(schema).toBeDefined();
    expect([5, 600, 900, 4, 901, 5.5, '600', ''].map(value => matchesSchema(value, schema!)))
        .toEqual([true, true, true, false, false, false, false, false]);
});
