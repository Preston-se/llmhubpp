import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
const h = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, convert: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: any) => { const i=h.cursor++; h.slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [h.slots[i].value, (next: any) => { h.slots[i].value=typeof next==='function' ? next(h.slots[i].value) : next; }]; },
  useRef: (value: any) => { const i=h.cursor++; h.slots[i] ??= { value: {current:value} }; return h.slots[i].value; },
  useEffect() {}, useImperativeHandle() {},
}));
vi.mock('obsidian-llm-hub-common/chat', async original => ({ ...await original<typeof import('obsidian-llm-hub-common/chat')>(), fileToAttachment: h.convert }));
vi.mock('src/i18n', () => ({t: (key: string) => key}));
import InputArea from './InputArea';
import { Composer, Autocomplete, InputButtons } from 'obsidian-llm-hub-common';
import { ChatAttachmentPreviews } from './ChatAttachmentPreviews';
function find(node: any, type: any): ReactElement<any> | undefined {
  if(Array.isArray(node)) { for(const child of node) {const result=find(child,type);if(result)return result;} return; }
  if(!node?.props)return; return node.type===type ? node : find(node.props.children,type) ?? Object.values(node.props).filter(value=>value && typeof value==='object').map(value=>find(value,type)).find(Boolean);
}
beforeEach(()=>{h.slots=[];h.cursor=0;h.convert.mockReset();vi.stubGlobal('window',{setTimeout});vi.stubGlobal('activeDocument',{});});
function fixture(overrides: Record<string, unknown> = {}) {
  const props = { conversationKey: 'A', onSend: vi.fn(), isLoading: false, model: 'test', availableModels: [], codexModels: [], reasoningEffortOptions: [],
    ragSettings: [], vaultToolMode: 'readOnly', vaultToolDiagnostics: { desiredMode: 'readOnly', effectiveMode: 'readOnly', allowedFolders: [] }, inputHistory: [], onInputHistoryAdd: vi.fn(),
    voiceChatSettings: { submitOnPaste: true }, voiceConversation: { active: false }, mcpServers: [], slashCommands: [], availableSkills: [], activeSkillPaths: [], okfBundles: [], activeOkfBundleIds: [], vaultFiles: [], app: {}, ...overrides } as any;
  const render = () => { h.cursor = 0; return (InputArea as any).render(props, null); };
  const composer = () => find(render(), Composer)!.props;
  const type = (value: string) => composer().textarea.onChange({ target: { value, selectionStart: value.length } });
  const drop = () => composer().textarea.onDrop({ dataTransfer: { files: [{ name: 'scan.png' }] }, preventDefault() {} });
  const attachments = () => find(render(), ChatAttachmentPreviews)?.props.attachments ?? [];
  return { props, render, composer, type, drop, attachments };
}
const image = { name: 'scan.png', type: 'image', mimeType: 'image/png', data: 'cGlj' };
function matching(node: any, predicate: (value: any) => boolean): any {
  if (Array.isArray(node)) return node.map(child => matching(child, predicate)).find(Boolean);
  if (!node?.props) return;
  return predicate(node) ? node : Object.values(node.props).filter(value => value && typeof value === 'object')
    .map(value => matching(value, predicate)).find(Boolean);
}
it('opens the controls when the composer background is clicked and lets the toggle close them', () => {
  const f = fixture();
  const toggle = () => matching(f.render(), el => el.props.className === 'llm-hub-input-detail-toggle')?.props;
  expect(toggle()['aria-expanded']).toBe(false);
  const root = matching(f.render(), el => el.props.onPointerDownCapture)?.props;
  expect(root?.onPointerDownCapture).toBeTypeOf('function');
  root.onPointerDownCapture({ nativeEvent: {}, target: {}, currentTarget: { contains: () => true } });
  expect(toggle()['aria-expanded']).toBe(true);
  toggle().onClick();
  expect(toggle()['aria-expanded']).toBe(false);
});

it('keeps the entered text and image while a deferred send is declined', async () => {
  h.convert.mockResolvedValue(image);
  const f = fixture({ onSend: () => Promise.resolve(false) });
  f.type('保留'); f.drop(); await new Promise(resolve => setImmediate(resolve));
  await f.composer().onSend();
  expect(f.composer().textarea.value).toBe('保留');
  expect(f.attachments()).toEqual([image]);
});
it('keeps a synchronously rejected send available for retry with its image', async () => {
  h.convert.mockResolvedValue(image);
  const f = fixture(); f.type('重试问题'); f.drop(); await new Promise(resolve => setImmediate(resolve));
  f.props.onSend.mockImplementationOnce(() => { throw new Error('synthetic send failure'); });
  expect(() => f.composer().onSend()).toThrow('synthetic send failure');
  expect(f.composer().textarea.value).toBe('重试问题'); expect(f.attachments()).toEqual([image]);
  f.composer().onSend(); expect(f.props.onSend).toHaveBeenLastCalledWith('重试问题', [image], undefined, expect.any(Function));
  expect(f.composer().textarea.value).toBe(''); expect(f.attachments()).toEqual([]);
});
it.each(['typed', 'autocomplete'])('preserves the %s skill command metadata, history and attachments', async entry => {
  h.convert.mockResolvedValue(image);
  const f = fixture({ availableSkills: [{ folderPath: 'Skills/tutor', name: 'Tutor', description: '' }] });
  f.drop(); await new Promise(resolve => setImmediate(resolve));
  if (entry === 'typed') { f.type('/tutor 解释这页'); f.composer().onSend(); }
  else {
    f.type('/tutor');
    const autocomplete = find(f.render(), Autocomplete)!.props;
    autocomplete.onSelect(0);
  }
  expect(f.props.onSend).toHaveBeenCalledWith(entry === 'typed' ? '解释这页' : '', [image], 'Skills/tutor', expect.any(Function));
  expect(f.props.onInputHistoryAdd).toHaveBeenCalledWith(entry === 'typed' ? '/tutor 解释这页' : '/tutor');
  expect(f.composer().textarea.value).toBe(''); expect(f.attachments()).toEqual([]);
});
it('keeps the skill command editable when autocomplete is selected during an attachment read', async () => {
  let finishReading!: (value: unknown) => void;
  h.convert.mockReturnValue(new Promise(resolve => { finishReading = resolve; }));
  const f = fixture({ availableSkills: [{ folderPath: 'Skills/tutor', name: 'Tutor', description: '' }] });
  f.drop();
  f.type('/tutor');
  find(f.render(), Autocomplete)!.props.onSelect(0);
  expect(f.props.onSend).not.toHaveBeenCalled();
  expect(f.composer().textarea.value).toBe('/tutor');
  finishReading(image);
  await new Promise(resolve => setImmediate(resolve));
  f.composer().onSend();
  expect(f.props.onSend).toHaveBeenCalledWith('', [image], 'Skills/tutor', expect.any(Function));
});
it('resolves a user slash command into an editable draft without sending or removing images', async () => {
  h.convert.mockResolvedValue(image);
  const command = { id: 'summary', name: 'summary', promptTemplate: '解释 {selection}' };
  const f = fixture({ slashCommands: [command], onSlashCommand: () => '解释 {selection}' });
  f.drop(); await new Promise(resolve => setImmediate(resolve)); f.type('/summary');
  const autocomplete = find(f.render(), Autocomplete)!.props; autocomplete.onSelect(0);
  expect(f.props.onSend).not.toHaveBeenCalled(); expect(f.composer().textarea.value).toBe('解释 {selection}'); expect(f.attachments()).toEqual([image]);
});
it('runs compact without consuming attached images and preserves a draft on stop', async () => {
  h.convert.mockResolvedValue(image); const compact = vi.fn(); const stop = vi.fn();
  const f = fixture({ onCompact: compact, onStop: stop, messageCount: 2 });
  f.drop(); await new Promise(resolve => setImmediate(resolve)); f.type('/compact'); f.composer().onSend();
  expect(compact).toHaveBeenCalledOnce(); expect(f.props.onSend).not.toHaveBeenCalled(); expect(f.attachments()).toEqual([image]);
  f.type('下一轮问题'); f.props.isLoading = true; f.composer().onStop();
  expect(stop).toHaveBeenCalledOnce(); expect(f.composer().textarea.value).toBe('下一轮问题'); expect(f.attachments()).toEqual([image]);
});
it('restores the unsent text after traversing history and keeps IME Enter from sending', () => {
  const f = fixture({ inputHistory: ['上一轮'] }); f.type('未发送');
  const key = (name: string, composing = false) => f.composer().textarea.onKeyDown({ key: name, preventDefault() {}, nativeEvent: { isComposing: composing }, currentTarget: { selectionStart: f.composer().textarea.value.length, selectionEnd: f.composer().textarea.value.length } });
  key('ArrowUp'); expect(f.composer().textarea.value).toBe('上一轮');
  key('ArrowDown'); expect(f.composer().textarea.value).toBe('未发送');
  key('Enter', true); expect(f.props.onSend).not.toHaveBeenCalled();
  key('Enter'); expect(f.props.onSend).toHaveBeenCalledWith('未发送', undefined, undefined, expect.any(Function));
});
it('keeps text and ready attachments with their chat and restores them on return', async () => {
  h.convert.mockResolvedValue(image);
  const f = fixture(); f.type('A 的草稿'); f.drop(); await new Promise(resolve => setImmediate(resolve));
  f.props.conversationKey = 'B';
  expect(f.composer().textarea.value).toBe(''); expect(f.attachments()).toEqual([]);
  f.type('B 的问题'); f.composer().onSend();
  expect(f.props.onSend).toHaveBeenCalledWith('B 的问题', undefined, undefined, expect.any(Function));
  f.props.conversationKey = 'A';
  expect(f.composer().textarea.value).toBe('A 的草稿'); expect(f.attachments()).toEqual([image]);
  f.composer().onSend(); expect(f.props.onSend).toHaveBeenLastCalledWith('A 的草稿', [image], undefined, expect.any(Function));
  expect(f.composer().textarea.value).toBe(''); expect(f.attachments()).toEqual([]);
});
it.each([false, true])('finishes a delayed file read in A while B stays independent (return before read: %s)', async returnEarly => {
  let release!: (value: unknown) => void;
  h.convert.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const f = fixture(); f.type('等待中的 A'); f.drop(); f.props.conversationKey = 'B';
  f.type('独立的 B'); expect(f.composer().canSend).toBe(true); f.composer().onSend();
  expect(f.props.onSend).toHaveBeenCalledWith('独立的 B', undefined, undefined, expect.any(Function));
  if (returnEarly) { f.props.conversationKey = 'A'; expect(f.composer().canSend).toBe(false); }
  release(image); await new Promise(resolve => setImmediate(resolve));
  f.props.conversationKey = 'A'; expect(f.composer().canSend).toBe(true);
  expect(f.composer().textarea.value).toBe('等待中的 A'); expect(f.attachments()).toEqual([image]);
});
it('adds files to the chat that opened the file picker even if another chat is now visible', async () => {
  h.convert.mockResolvedValue(image);
  const f = fixture();
  const picker = () => find(f.render(), InputButtons)!.props.attach;
  const input = { click: vi.fn(), files: [{ name: 'scan.png' }], value: 'scan.png' };
  picker().inputRef.current = input;
  picker().onOpenPicker();
  expect(input.click).toHaveBeenCalledOnce();

  f.props.conversationKey = 'B';
  picker().onSelect({ target: input, currentTarget: input });
  await new Promise(resolve => setImmediate(resolve));

  expect(f.attachments()).toEqual([]);
  f.props.conversationKey = 'A';
  expect(f.attachments()).toEqual([image]);
});
it.each(['voiceSubmit','voiceConversation'])('retains %s text and waits for attachment conversion before sending', async channel => {
  let release!: (value: unknown)=>void;
  h.convert.mockReturnValue(new Promise(resolve=>{release=resolve;}));
  const onSend=vi.fn();
  const props={onSend,isLoading:false,model:'test',availableModels:[],codexModels:[],reasoningEffortOptions:[],
    ragSettings:[],vaultToolMode:'readOnly',vaultToolDiagnostics:{desiredMode:'readOnly',effectiveMode:'readOnly',allowedFolders:[]},inputHistory:[],onInputHistoryAdd(){},
    voiceChatSettings:{submitOnPaste:true},voiceConversation:{active:false},mcpServers:[],slashCommands:[],
    availableSkills:[],activeSkillPaths:[],okfBundles:[],activeOkfBundleIds:[],vaultFiles:[],app:{}} as any;
  const render=()=>{h.cursor=0;return (InputArea as any).render(props,null);};
  const composer=()=>find(render(),Composer)!.props;
  composer().textarea.onDrop({dataTransfer:{files:[{name:'scan.png'}]},preventDefault(){}});
  composer()[channel].onSubmit('语音中的问题');
  expect(onSend).not.toHaveBeenCalled();
  expect(composer().textarea.value).toBe('语音中的问题');
  release({name:'scan.png',type:'image',mimeType:'image/png',data:'cGlj'});
  await new Promise(resolve=>setImmediate(resolve));
  composer().onSend();
  expect(onSend).toHaveBeenCalledWith('语音中的问题', [expect.objectContaining({name:'scan.png'})], undefined, expect.any(Function));
});

