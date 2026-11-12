import {it,expect} from 'vitest';
import {resolveReadingMenu} from './readingMenuPolicy';
it('filters each context, orders stable actions and ignores unknown future ids',()=>{
 const items=[{id:'search',title:'Search'},{id:'current',title:'Ask'},{id:'quiz',title:'Quiz'}];
 expect(resolveReadingMenu('pdf',items,{enabled:true,presentation:'flat',actions:{search:{enabled:false},quiz:{label:'练习',order:0},current:{order:2}},contexts:{pdf:true}}).map(i=>[i.id,i.title])).toEqual([['quiz','练习'],['current','Ask']]);
 expect(resolveReadingMenu('pdf',items,{enabled:false})).toEqual([]);expect(resolveReadingMenu('file',items,{contexts:{file:false}})).toEqual([]);
});
