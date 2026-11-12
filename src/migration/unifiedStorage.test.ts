import { describe, expect, it } from 'vitest';
import { initializeUnifiedStorage, type MigrationFiles } from './unifiedStorage';

function files(initial: Record<string,string>) {
  const values=new Map(Object.entries(initial));
  const writes:string[]=[];
  const io:MigrationFiles={exists:async p=>values.has(p),read:async p=>values.get(p)!,mkdir:async()=>{},write:async(p,text)=>{writes.push(p);values.set(p,text);}};
  return {values,writes,io};
}
describe('unified storage initialization',()=>{
  it('backs up exact legacy data before importing unknown fields and never changes the source',async()=>{
    const raw='{"advanced":{"unknown":42},"apiProviders":[{"apiKey":"test-only"}]}';
    const f=files({'cfg/plugins/llm-hub/data.json':raw,'cfg/plugins/llm-hub-safe-guard/data.json':'{"routerEnabled":false}'});
    await initializeUnifiedStorage(f.io,'cfg','cfg/plugins/llmhubpp');
    expect(f.values.get('cfg/plugins/llmhubpp/data.json')).toBe(raw);
    expect(f.values.get('cfg/plugins/llm-hub/data.json')).toBe(raw);
    expect(f.writes.indexOf('cfg/plugins/llmhubpp/legacy-backup/llm-hub.json')).toBeLessThan(f.writes.indexOf('cfg/plugins/llmhubpp/data.json'));
    expect(f.values.get('cfg/plugins/llmhubpp/safe-guard.json')).toContain('false');
  });
  it('never overwrites existing destination or its prior backups',async()=>{
    const f=files({'cfg/plugins/llm-hub/data.json':'{"old":1}','cfg/plugins/llmhubpp/data.json':'{"new":2}','cfg/plugins/llmhubpp/legacy-backup/llm-hub.json':'snapshot'});
    await initializeUnifiedStorage(f.io,'cfg','cfg/plugins/llmhubpp');
    expect(f.values.get('cfg/plugins/llmhubpp/data.json')).toBe('{"new":2}');
    expect(f.values.get('cfg/plugins/llmhubpp/legacy-backup/llm-hub.json')).toBe('snapshot');
  });
  it('rejects malformed source before any destination write',async()=>{
    const f=files({'cfg/plugins/llm-hub/data.json':'[]'});
    await expect(initializeUnifiedStorage(f.io,'cfg','cfg/plugins/llmhubpp')).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });
  it('preserves backup and stops if source changes during preparation',async()=>{
    const f=files({'cfg/plugins/llm-hub/data.json':'{"old":1}'});
    const write=f.io.write;
    f.io.write=async(p,t)=>{await write(p,t);if(p.includes('legacy-backup'))f.values.set('cfg/plugins/llm-hub/data.json','{"old":2}');};
    await expect(initializeUnifiedStorage(f.io,'cfg','cfg/plugins/llmhubpp')).rejects.toThrow(/changed/);
    expect(f.values.has('cfg/plugins/llmhubpp/data.json')).toBe(false);
  });
});
