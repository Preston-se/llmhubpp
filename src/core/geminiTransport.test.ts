import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@google/genai', async () => await import('@google/genai/web'));
const transport = vi.hoisted(() => ({ direct: vi.fn(), proxy: vi.fn() }));
vi.mock('./proxyFetch', () => ({ createNodeFetch: () => transport.direct, createProxyFetch: () => transport.proxy }));
import { GeminiClient } from './gemini';
import { configureRequestCapture } from './outboundRequest';
import { DEFAULT_REQUEST_CONTROLS, RequestUsageLedger } from './requestUsage';
import { memoryVault } from './testSupport/memoryVault';
afterEach(() => { configureRequestCapture(undefined); vi.restoreAllMocks(); transport.direct.mockReset(); transport.proxy.mockReset(); });
async function setup(outbound: typeof DEFAULT_REQUEST_CONTROLS.outbound) {
  const settings = { ...DEFAULT_REQUEST_CONTROLS, outbound, redactionRules: [{ pattern: 'PRIVATE', replacement: 'hidden' }] };
  const ledger = new RequestUsageLedger(memoryVault().io as never, 'usage', () => settings);
  await ledger.initialize();
  const confirm = vi.fn(async () => false);
  configureRequestCapture({ ledger, settings: () => settings, confirm });
  return { ledger, confirm };
}
async function consume(client: GeminiClient) {
  const chunks = [];
  for await (const c of client.chatWithToolsStream([{ role: 'user', content: 'PRIVATE', timestamp: 0 }], [], undefined, undefined, undefined, false, { disableTools: true })) chunks.push(c);
  return chunks;
}
function response() {
  const event = { event_type: 'interaction.completed', interaction: { id: 'synthetic-id', status: 'completed' } };
  return new Response('event: interaction.completed\ndata: ' + JSON.stringify(event) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
it('enforces local-only through the real browser SDK public chat entry', async () => {
  await setup('local-only'); const globalWire = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
  transport.direct.mockImplementation(async () => response());
  const chunks = await consume(new GeminiClient('synthetic-key'));
  expect(chunks.some(c => c.type === 'error')).toBe(true);
  expect(globalWire).not.toHaveBeenCalled(); expect(transport.direct).not.toHaveBeenCalled();
});
it('uses captured proxy transport and redacts actual browser SDK requests', async () => {
  const f = await setup('redact'); const globalWire = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
  transport.proxy.mockImplementation(async () => response());
  await consume(new GeminiClient('synthetic-key', 'gemini-3.8-flash', 'http://proxy.invalid'));
  expect(transport.proxy).toHaveBeenCalled(); expect(globalWire).not.toHaveBeenCalled();
  const [input, init] = transport.proxy.mock.calls[0];
  const body = init?.body ?? await input.clone().text();
  expect(body).toContain('hidden'); expect(body).not.toContain('PRIVATE');
  expect(f.ledger.records()).toHaveLength(1);
});
it('cancelled payload confirmation prevents real SDK dispatch', async () => {
  const f = await setup('confirm'); const wire = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
  await consume(new GeminiClient('synthetic-key'));
  expect(f.confirm).toHaveBeenCalled(); expect(wire).not.toHaveBeenCalled(); expect(transport.direct).not.toHaveBeenCalled();
});
