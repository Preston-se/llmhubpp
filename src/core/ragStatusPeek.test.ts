import {it,expect,vi} from 'vitest';
import {memoryVault} from './testSupport/memoryVault';
import {initLocalRagStore,resetLocalRagStore} from './localRagStore';
it('reports only cached metadata without loading any vectors for configuration status',async()=>{
 resetLocalRagStore();const memory=memoryVault(),store=initLocalRagStore();await store.load(memory.app,['Demo']);
 const read=vi.spyOn(memory.app.vault.adapter,'read'),binary=vi.spyOn(memory.app.vault.adapter,'readBinary');
 const peek=(store as typeof store&{peekConfigurationStatus?:(name:string)=>unknown}).peekConfigurationStatus?.('Demo');
 expect(peek).toMatchObject({indexReady:'unknown',evidence:'not-loaded'});expect(read).not.toHaveBeenCalled();expect(binary).not.toHaveBeenCalled();
});
