import {describe,it,expect} from 'vitest';
import {discardManagedBinaryEventText} from './shell';
describe('managed ingest event context',()=>{
 it('drops binary pseudo-text only for the built-in path-based preset',()=>{
  const variables=new Map<string,unknown>([['_eventFilePath','Inbox/book.epub'],['_eventFileContent','binary garbage']]);
  discardManagedBinaryEventText(['-File','tools/custom.ps1'],variables);expect(variables.has('_eventFileContent')).toBe(true);
  discardManagedBinaryEventText(['-File','tools/vm-source-auto-ingest.ps1'],variables);expect(variables.has('_eventFileContent')).toBe(false);expect(variables.get('_eventFilePath')).toBe('Inbox/book.epub');
  variables.set('_eventFilePath','Inbox/note.md');variables.set('_eventFileContent','text');discardManagedBinaryEventText(['source-auto-ingest.ps1'],variables);expect(variables.get('_eventFileContent')).toBe('text');
 });
});
