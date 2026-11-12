import {test} from 'node:test';import assert from 'node:assert/strict';import {readdir,readFile} from 'node:fs/promises';
test('offline help links and packaged illustrations all resolve',async()=>{
 const names=(await readdir('resources/help')).filter(n=>n.endsWith('.md'));assert.ok(names.length>=14);
 for(const name of names){const text=await readFile('resources/help/'+name,'utf8');assert.ok(!/Bearer [a-f0-9]{32,}/i.test(text));for(const match of text.matchAll(/\]\(help:([a-z-]+)/g))assert.ok(names.includes(match[1]+'.md'),`${name}: ${match[1]}`);for(const match of text.matchAll(/\]\((images\/[a-z-]+\.svg)\)/g))assert.ok((await readFile('resources/help/'+match[1])).length>0);}
});
