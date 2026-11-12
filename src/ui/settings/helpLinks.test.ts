import {it,expect} from 'vitest';
import {resolveHelpLink} from './helpLinks';
it('accepts offline help and web URLs but rejects script/data and arbitrary vault paths',()=>{
 expect(resolveHelpLink('help:index')).toEqual({kind:'help',target:'index'});expect(resolveHelpLink('https://example.com/wiki').kind).toBe('web');
 for(const link of ['javascript:alert(1)','data:text/html,hi','help:../../secret','help:missing-topic','help:index#missing','file:///C:/secret','obsidian://open?vault=other'])expect(()=>resolveHelpLink(link)).toThrow();
});
