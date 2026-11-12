import { beforeEach, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({set:vi.fn(),options:null as any,open:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:(value:any)=>({current:value}),useState:(value:any)=>[value,h.set],useEffect(){},useMemo:(fn:any)=>fn(),useCallback:(fn:any)=>fn}));
vi.mock('./chat/useCitationMarkup',()=>({useCitationMarkup:(options:any)=>{h.options=options;}}));
vi.mock('./chat/sourceNavigation',()=>({openCitationSource:h.open}));
vi.mock('src/i18n',()=>({t:(key:string)=>key}));
vi.mock('src/ui/ChatView',()=>({ChatView:class{},VIEW_TYPE_GEMINI_CHAT:'chat'}));
import MessageBubble from './MessageBubble';
beforeEach(()=>{h.set.mockReset();h.open.mockReset();});
it.each(['opened','missing','failed'])('keeps the source excerpt visible when opening returns %s',async result=>{
  h.open.mockResolvedValue(result);
  MessageBubble({message:{role:'assistant',content:'answer',timestamp:1},app:{} as any});
  await h.options.onOpen({id:1,filePath:'book.md',text:'Original saved excerpt'});
  expect(h.set).not.toHaveBeenCalled();
});
it('closes the popover after successful excerpt navigation',async()=>{
  h.open.mockResolvedValue('located');
  MessageBubble({message:{role:'assistant',content:'answer',timestamp:1},app:{} as any});
  await h.options.onOpen({id:1,filePath:'book.md',text:'excerpt'});
  expect(h.set).toHaveBeenCalledWith(null);
});

