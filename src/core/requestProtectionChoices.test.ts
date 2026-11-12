import { expect, it, vi } from 'vitest';
import { memoryVault } from './testSupport/memoryVault';
import { RequestProtectionChoices } from './requestProtectionChoices';
const scope={origin:'http://localhost:4096',model:'provider/model',reason:'delegated-service',settingsKey:'same'};
it('persists explicit choices and serializes simultaneous first requests',async()=>{
  const v=memoryVault(),choose=vi.fn(async()=>true),choices=new RequestProtectionChoices(v.io as never,'usage/choices.json',choose);
  expect(await Promise.all([choices.allow(scope),choices.allow(scope)])).toEqual([true,true]);expect(choose).toHaveBeenCalledOnce();
  const again=new RequestProtectionChoices(v.io as never,'usage/choices.json',choose);
  expect(await again.allow(scope)).toBe(true);expect(choose).toHaveBeenCalledOnce();
  await again.allow({...scope,settingsKey:'changed'});expect(choose).toHaveBeenCalledTimes(2);
});
it('remembers rejection, while closing the prompt leaves the choice undecided',async()=>{
  const v=memoryVault(),choose=vi.fn<()=>Promise<boolean|undefined>>().mockResolvedValueOnce(undefined).mockResolvedValue(false);
  const choices=new RequestProtectionChoices(v.io as never,'usage/choices.json',choose);
  expect(await choices.allow(scope)).toBe(false);expect(await choices.allow(scope)).toBe(false);expect(await choices.allow(scope)).toBe(false);
  expect(choose).toHaveBeenCalledTimes(2);
});
it('persists distinct scopes on adapters that reject rename-overwrite and resets them',async()=>{
  const v=memoryVault(),rename=v.io.rename;
  v.io.rename=async(from,to)=>{if(await v.io.exists(to))throw Error('Destination file already exists');await rename(from,to);};
  const choose=vi.fn(async()=>true),choices=new RequestProtectionChoices(v.io as never,'usage/choices.json',choose);
  await choices.allow(scope);await choices.allow({...scope,model:'other'});expect(choose).toHaveBeenCalledTimes(2);
  await choices.reset();await choices.allow(scope);expect(choose).toHaveBeenCalledTimes(3);
});
it('loads a background permission without asking or inheriting another purpose', async () => {
  const v = memoryVault();
  const choose = vi.fn(async () => true);
  const writer = new RequestProtectionChoices(v.io as never, 'usage/choices.json', choose);
  const index = { ...scope, reason: 'knowledge-index' };
  await writer.allow(index);
  const reader = new RequestProtectionChoices(v.io as never, 'usage/choices.json', choose);
  expect(await reader.remembered({ ...index, reason: 'knowledge-query' })).toBeUndefined();
  expect(await reader.remembered(index)).toBe(true);
  expect(reader.known(index)).toBe(true);
  expect(choose).toHaveBeenCalledOnce();
  await reader.reset();
  expect(reader.known(index)).toBeUndefined();
  expect(await reader.remembered(index)).toBeUndefined();
});
