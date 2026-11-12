import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { TFile, TFolder } from "obsidian";
import { memoryVault } from "src/core/testSupport/memoryVault";
import { saveRagSnapshot, loadRagSnapshot, ragEmbeddingFingerprint, type LocalRagIndex } from "src/core/localRagStorage";
import { DEFAULT_RAG_SETTING, DEFAULT_SETTINGS, DEFAULT_WORKSPACE_STATE } from "src/types";

const harness = vi.hoisted(() => ({ slots: [] as Array<{ value: any }>, cursor: 0,
  currentChatId: null as string | null,
  embed: vi.fn(), create: vi.fn(), anthropic: vi.fn(), gemini: vi.fn(), local: vi.fn(), nativeLocal: vi.fn(),
  confirm: vi.fn(), choose: vi.fn(), save: vi.fn(), clients: [] as any[] }));

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = harness.cursor++;
      if (!harness.slots[index]) harness.slots[index] = { value: typeof initial === "function" ? (initial as () => unknown)() : initial };
      return [harness.slots[index].value, (next: unknown) => {
        const old = harness.slots[index].value;
        harness.slots[index].value = typeof next === "function" ? (next as (old: unknown) => unknown)(old) : next;
      }];
    },
    useRef: (value: unknown) => {
      const index = harness.cursor++;
      if (!harness.slots[index]) harness.slots[index] = { value: { current: value } };
      return harness.slots[index].value;
    },
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
    useEffect: () => undefined,
    useImperativeHandle: (ref: { current: unknown } | null, create: () => unknown) => { if (ref) ref.current = create(); },
  };
});

vi.mock("obsidian-llm-hub-common/chat", async importOriginal => {
  const actual = await importOriginal<typeof import("obsidian-llm-hub-common/chat")>();
  return { ...actual, useChatHistories: () => ({
    chatHistories: [], currentChatId: harness.currentChatId, setCurrentChatId: (id: string | null) => { harness.currentChatId = id; }, saveNoteState: "idle",
    loadChatHistories: vi.fn(), saveChatToDisk: harness.save, saveCurrentChat: harness.save,
    deleteChat: vi.fn(), saveAsNote: vi.fn(), decryptChat: vi.fn(),
  }), useAutoReadAloud: vi.fn(), useReadAloudRate: vi.fn(), useVoiceConversation: () => ({ active: false }) };
});
vi.mock("src/i18n", async original => {
  const actual = await original<typeof import('src/i18n')>();
  return { ...actual, t: (key: string) => key.startsWith('chat.grounded.vectorSpace') ? actual.t(key as any) : key };
});
vi.mock("./CliTerminalPanel", () => ({ default: () => null, isTerminalProvider: () => false }));
vi.mock('./GroundedRestrictionModal', () => ({ chooseGroundedRestriction: (...args: unknown[]) => harness.choose(...args) }));
vi.mock('src/core/localLlmProvider', async original => ({ ...await original<typeof import('src/core/localLlmProvider')>(),
  localLlmChatStream: (...args: unknown[]) => (args[0] as { framework: string }).framework === 'opencode'
    ? harness.local(...args) : harness.nativeLocal(...args),
}));
vi.mock("src/core/embeddingProvider", () => ({ generateEmbeddings: (...args: unknown[]) => harness.embed(...args),
  generateGeminiNativeEmbeddings: vi.fn(), MULTIMODAL_EXTENSIONS: new Set(), MULTIMODAL_FILE_SIZE_LIMITS: {} }));
vi.mock("src/core/jevRagFilter", () => ({ filterRagResultsWithJev: vi.fn(), getOpenRouterApiKey: () => "" }));
vi.mock("openai", () => ({ default: class {
  constructor(options: unknown) { harness.clients.push(options); }
  responses = { stream: vi.fn() }; chat = { completions: { create: harness.create } }; images = { generate: vi.fn() };
} }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { stream: harness.anthropic }; } }));
vi.mock("@google/genai", async importOriginal => ({ ...await importOriginal<typeof import("@google/genai")>(),
  GoogleGenAI: class { interactions = { create: harness.gemini, getClient: () => ({ _httpClient: { request: vi.fn() } }) }; models = {}; chats = {}; },
}));
vi.mock("src/core/proxyFetch", () => ({ createProxyFetch: vi.fn(), createNodeFetch: () => vi.fn() }));
vi.mock("src/core/opencodeLocalProvider", () => ({ opencodeLocalChatStream: (...args: unknown[]) => harness.local(...args), verifyOpencodeLocal: vi.fn() }));
vi.mock("src/core/codexVaultMcpBridge", () => ({ CodexVaultMcpBridge: class {
  setTools() {} setExecutor() {} setToolActivityObserver() {} setToolCallObserver() {}
  start() { return Promise.resolve('http://127.0.0.1:1/synthetic-only'); } stop() { return Promise.resolve(); }
} }));

import Chat from "./Chat";
import InputArea from "./InputArea";
import MessageList from "./MessageList";
import { initLocalRagStore, resetLocalRagStore } from "src/core/localRagStore";
import { readGroundedEvidence } from "src/core/groundedAnswer";
import { getAnswerCitations } from "src/core/answerCitations";
import { restoreChatDisplayData } from "src/core/chatDisplayData";
import { messagesToMarkdown, parseMarkdownToMessages } from "obsidian-llm-hub-common/chat";
import { HeaderButton, HistoryList } from 'obsidian-llm-hub-common';
import { setLocale } from 'src/i18n';

function find(node: unknown, type: unknown): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, type); if (result) return result; } return; }
  if (!node || typeof node !== "object" || !("props" in node)) return;
  const element = node as ReactElement<Record<string, any>>;
  return element.type === type ? element : find(element.props.children, type);
}
function elements(node: any): any[] { return Array.isArray(node) ? node.flatMap(elements) : !node?.props ? [] : [node, ...elements(node.props.children)]; }

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function waitForSave(count=1) { await vi.waitFor(()=>expect(harness.save).toHaveBeenCalledTimes(count),{timeout:3000,interval:10});await flush(); }

async function fixture(providerType: "openai" | "anthropic" | "gemini" = "openai", model = "mock-model", vectorSpace: 'verified' | 'unverified' | 'changed' = 'verified') {
  const memory = memoryVault();
  const setting = { ...DEFAULT_RAG_SETTING, embeddingBaseUrl: "http://127.0.0.1:1", embeddingModel: "mock", topK: 2, scoreThreshold: 0, searchFileExtensions: [] };
  const meta = ["第一段真实资料", "第二段真实资料"].map((text, chunkIndex) => ({ filePath: `A/${chunkIndex}.md`, chunkIndex, text }));
  const index: LocalRagIndex = { meta, dimension: 2, fileChecksums: {}, embeddingModel: "mock", embeddingSpace: vectorSpace === 'unverified' ? undefined : await ragEmbeddingFingerprint('mock', vectorSpace === 'changed' ? 'http://127.0.0.1:2' : 'http://127.0.0.1:1'), chunkSize: 500, chunkOverlap: 100 };
  await saveRagSnapshot(memory.app, "A", index, new Float32Array([1, 0, 1, 0]), "LLMHub");
  await saveRagSnapshot(memory.app, "B", { ...index, meta: [{ filePath: "B/private.md", chunkIndex: 0, text: "另一知识库资料" }] }, new Float32Array([1, 0]), "LLMHub");
  const vault = memory.app.vault as any;
  vault.getAbstractFileByPath = (path: string) => Object.assign(new TFile(), { path });
  vault.getFiles = () => [];
  (memory.app as any).workspace = { getActiveFile: () => null };
  resetLocalRagStore(); await initLocalRagStore().load(memory.app, ["A", "B"]);
  const provider = { id: "remote", name: "Remote", type: providerType, baseUrl: "https://example.invalid", apiKey: "dummy",
    enabled: true, verified: true, enabledModels: [model], availableModels: [model] };
  const settings = { ...DEFAULT_SETTINGS, groundedAnswersByDefault: false, apiProviders: [provider], activeSkillPaths: [], cliConfig: { ...DEFAULT_SETTINGS.cliConfig } };
  const plugin = { app: memory.app, settings, workspaceState: { ...DEFAULT_WORKSPACE_STATE, selectedRagSetting: "A" },
    manifest: { version: "test" }, getSelectedModel: () => `api:remote:${model}`, getRagSettingNames: () => ["A", "B"],
    getRagSearchSetting: () => setting, getLastSelection: () => "", getSelectionLocation: () => null,
    confirmKnowledgeDestination: harness.confirm,
    saveSettings: vi.fn(), saveWorkspaceState: vi.fn(), selectSearchSelection: vi.fn(), settingsEmitter: { on: vi.fn(), off: vi.fn() } };
  const ref = { current: null as any };
  const render = () => { harness.cursor = 0; return (Chat as any).render({ plugin, onToggleSidebarWidth: () => false }, ref); };
  return { render, plugin, ref };
}

beforeEach(() => {
  setLocale('en');
  harness.currentChatId = null;
  harness.clients = [];
  harness.slots = []; harness.cursor = 0; harness.embed.mockReset().mockResolvedValue([[1, 0]]); harness.save.mockReset();
  harness.create.mockReset().mockResolvedValue({ async *[Symbol.asyncIterator]() { yield { choices: [{ delta: { content: "答案 [1]" }, finish_reason: "stop" }] }; } });
  harness.anthropic.mockReset().mockReturnValue({ async *[Symbol.asyncIterator]() {
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "答案 [1]" } };
  }, finalMessage: async () => ({ content: [{ type: "text", text: "答案 [1]" }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }) });
  harness.gemini.mockReset().mockResolvedValue({ async *[Symbol.asyncIterator]() {
    yield { event_type: "step.delta", delta: { type: "text", text: "答案 [1]" } };
    yield { event_type: "interaction.completed", interaction: { status: "completed" } };
  } });
  harness.local.mockReset().mockReturnValue({ async *[Symbol.asyncIterator]() { yield { type: 'text', content: 'answer' }; yield { type: 'done' }; } });
  harness.nativeLocal.mockReset().mockReturnValue({ async *[Symbol.asyncIterator]() { yield { type: 'text', content: 'Local answer [1]' }; } });
  harness.confirm.mockReset().mockResolvedValue(true);
  harness.choose.mockReset().mockResolvedValue('keep');
});

describe("chat reading mode through the real send handler", () => {
  it('uses the product default for new questions and respects an existing disabled preference', async () => {
    const f = await fixture();
    const settings = f.plugin.settings as Partial<typeof f.plugin.settings>;
    delete settings.groundedAnswersByDefault;
    expect(DEFAULT_SETTINGS.groundedAnswersByDefault).toBe(true);
    expect(find(f.render(), InputArea)!.props.groundedMode).toBe(true);
    settings.groundedAnswersByDefault = false;
    expect(find(f.render(), InputArea)!.props.groundedMode).toBe(false);
    await find(f.render(), InputArea)!.props.onSend('普通问题');
    expect(harness.embed).not.toHaveBeenCalled();
  });

  it.each(['ollama', 'lm-studio'])('uses current evidence through %s even with tools disabled', async framework => {
    const f = await fixture();
    const p = f.plugin as any;
    p.settings.groundedAnswersByDefault = true;
    p.settings.localLlmConfigs = [{ id: 'local', framework, model: 'text-model', enabledModels: ['text-model'], enabled: true,
      verified: true, baseUrl: 'http://127.0.0.1:11434', toolSupportMode: 'disabled' }];
    p.getSelectedModel = () => 'local-llm:local:text-model';
    const composer = find(f.render(), InputArea)!.props;
    expect(composer.groundedAvailable).toBe(true);
    await composer.onSend('合成问题'); await waitForSave();
    expect(harness.nativeLocal).toHaveBeenCalledOnce();
    expect(harness.nativeLocal.mock.calls[0][2]).toContain('第一段真实资料');
    expect(harness.nativeLocal.mock.calls[0][5]).toBeUndefined();
    expect(harness.create).not.toHaveBeenCalled();
    expect(getAnswerCitations(harness.save.mock.calls[0][0].at(-1)).sources.map(source => source.id)).toEqual([1]);
  });

  it('leaves an unsent question intact until a missing-index restriction is resolved', async () => {
    const f = await fixture();
    f.plugin.settings.groundedAnswersByDefault = true;
    f.plugin.workspaceState.selectedRagSetting = null;
    const composer = find(f.render(), InputArea)!.props;
    const accepted = vi.fn();
    expect(await composer.onSend('未发送', undefined, undefined, accepted)).toBe(false);
    expect(accepted).not.toHaveBeenCalled();
    expect(harness.choose).toHaveBeenCalledOnce();
    expect(harness.create).not.toHaveBeenCalled();
    harness.choose.mockResolvedValueOnce('once');
    await composer.onSend('本次普通回答', undefined, undefined, accepted);
    expect(accepted).toHaveBeenCalledOnce();
    expect(harness.embed).not.toHaveBeenCalled();
    expect(harness.create).toHaveBeenCalledOnce();
  });

  it.each(['off', 'condition'])('keeps the original draft unsent if the chat changes while saving %s', async choice => {
    const f = await fixture();
    f.plugin.settings.groundedAnswersByDefault = true;
    f.plugin.workspaceState.selectedRagSetting = null;
    let finishSaving!: () => void;
    const pending = new Promise<void>(resolve => { finishSaving = resolve; });
    const saving = vi.fn(() => pending);
    f.plugin.saveSettings.mockImplementation(saving);
    Object.assign(f.plugin, {
      ordinaryGroundedCondition: (_reason: string, _model: string, remember = false) =>
        remember ? saving() : Promise.resolve(false),
    });
    harness.choose.mockResolvedValueOnce(choice);
    const accepted = vi.fn();
    const sending = find(f.render(), InputArea)!.props.onSend('A 的待发问题', undefined, undefined, accepted);
    await vi.waitFor(() => expect(saving).toHaveBeenCalledOnce());

    elements(f.render()).find(node => node.type === HeaderButton && node.props.title === 'chat.newChat').props.onClick();
    find(f.render(), InputArea)!.props.onSlashCommand({
      id: 'lookup', name: 'lookup', promptTemplate: 'B 的问题',
      vaultToolMode: 'none', searchSelection: { ragSetting: 'B', webSearch: false },
    });
    finishSaving();

    expect(await sending).toBe(false);
    expect(accepted).not.toHaveBeenCalled();
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
    const nextComposer = find(f.render(), InputArea)!.props;
    expect(nextComposer.selectedRagSetting).toBe('B');
    expect(nextComposer.vaultToolMode).toBe('none');
  });

  it('waits for answer authorization before forwarding evidence and stops on denial', async () => {
    const f = await fixture();
    f.plugin.settings.groundedAnswersByDefault = true;
    let decide!: (allowed: boolean) => void;
    harness.confirm.mockImplementation((purpose: string) => purpose === 'answer'
      ? new Promise<boolean>(resolve => { decide = resolve; }) : Promise.resolve(true));
    const accepted = vi.fn();
    const sending = find(f.render(), InputArea)!.props.onSend('合成问题', undefined, undefined, accepted);
    await vi.waitFor(() => expect(harness.confirm).toHaveBeenCalledWith('answer', 'https://example.invalid', 'A', 'mock-model'));
    expect(harness.create).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
    decide(false);
    expect(await sending).toBe(false);
    expect(harness.create).not.toHaveBeenCalled();
  });

  it('keeps a draft identity through the first save and restores it on history return', async () => {
    const f = await fixture(); const initial = find(f.render(), InputArea)!.props.conversationKey;
    expect(initial).toBeTypeOf('string');
    harness.currentChatId = 'A'; const saved = f.render();
    expect(find(saved, InputArea)!.props.conversationKey).toBe(initial);
    elements(saved).find(node => node.type === HeaderButton && node.props.title === 'chat.newChat').props.onClick();
    const fresh = f.render(); expect(find(fresh, InputArea)!.props.conversationKey).not.toBe(initial);
    elements(fresh).find(node => node.type === HeaderButton && node.props.title === 'chat.chatHistory').props.onClick();
    find(f.render(), HistoryList)!.props.onSelect({ id: 'A', messages: [] });
    expect(find(f.render(), InputArea)!.props.conversationKey).toBe(initial);
  });
  it('restores the draft identity of a new chat whose first turn saved in the background', async () => {
    const f = await fixture(); const initial = find(f.render(), InputArea)!.props.conversationKey;
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    harness.create.mockResolvedValueOnce({ async *[Symbol.asyncIterator]() { await pending; yield { choices: [{ delta: { content: '合成回答' }, finish_reason: 'stop' }] }; } });
    const sending = find(f.render(), InputArea)!.props.onSend('第一轮');
    await vi.waitFor(() => expect(harness.create).toHaveBeenCalledOnce());
    elements(f.render()).find(node => node.type === HeaderButton && node.props.title === 'chat.newChat').props.onClick();
    f.render(); release(); await sending; await waitForSave();
    const historyId = harness.save.mock.calls[0][1]; expect(historyId).toBeTypeOf('string');
    elements(f.render()).find(node => node.type === HeaderButton && node.props.title === 'chat.chatHistory').props.onClick();
    find(f.render(), HistoryList)!.props.onSelect({ id: historyId, messages: [] });
    expect(find(f.render(), InputArea)!.props.conversationKey).toBe(initial);
  });
  it("saves sent image bytes so shared Markdown history can restore the preview", async () => {
    const f = await fixture();
    const attachments = [{ name: 'scan.png', type: 'image' as const, mimeType: 'image/png', data: 'aW1hZ2U=' }];
    await find(f.render(), InputArea)!.props.onSend('解释图片', attachments); await waitForSave();
    const markdown = await messagesToMarkdown(harness.save.mock.calls[0][0], '图片历史', 1);
    const restored = parseMarkdownToMessages(markdown).messages.map(restoreChatDisplayData);
    expect(restored.find(message => message.role === 'user')?.attachments).toEqual(attachments);
  });
  it("gives OpenCode the same source-numbering instructions as other RAG tool routes", async () => {
    const f = await fixture(); const p = f.plugin as any;
    p.settings.localLlmConfigs = [{ id: 'opencode', framework: 'opencode', model: 'test-model', enabledModels: ['test-model'], enabled: true, verified: true, baseUrl: 'http://127.0.0.1:1' }];
    p.getSelectedModel = () => 'local-llm:opencode:test-model';
    await find(f.render(), InputArea)!.props.onSend('查找资料'); await waitForSave();
    expect(harness.local, JSON.stringify(harness.save.mock.calls.at(-1)?.[0].at(-1))).toHaveBeenCalled();
    expect(harness.local.mock.calls[0][2]).toContain('Cite supported statements with the id from each readable result');
  });
  it("preserves per-turn evidence and selects cited chunks when ordinary chat calls rag_search", async () => {
    const f = await fixture();
    harness.create.mockReset().mockResolvedValueOnce({ async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'search-1', type: 'function', function: { name: 'rag_search', arguments: '{"query":"focused query"}' } }] }, finish_reason: 'tool_calls' }] };
    } }).mockResolvedValueOnce({ async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: 'Supported by the first chunk [1]' }, finish_reason: 'stop' }] };
    } });
    await find(f.render(), InputArea)!.props.onSend('普通模式下查询资料');
    await waitForSave();
    const saved = harness.save.mock.calls[0][0].at(-1);
    expect(readGroundedEvidence(saved)?.sources).toHaveLength(2);
    expect(getAnswerCitations(saved).sources.map(source => source.id)).toEqual([1]);
    expect(JSON.stringify(harness.create.mock.calls[1][0])).toContain('第一段真实资料');
  });
  it("retains the question and attachments when variable preparation fails before a turn starts", async () => {
    const f = await fixture(); const file = Object.assign(new TFile(), { path: "课程.md", extension: "md" });
    (f.plugin.app.workspace as any).getActiveFile = () => file;
    (f.plugin.app.vault as any).read = async () => { throw new Error("private endpoint detail"); };
    const tree = f.render(); const attachments = [{ name: "讲义.txt", type: "text", content: "附加资料", mimeType: "text/plain" }];
    await find(tree, InputArea)!.props.onSend("结合 {content} 解释", attachments); await waitForSave();
    const messages = find(f.render(), MessageList)!.props.messages;
    expect(messages.find((m: any) => m.role === "user")).toMatchObject({ content: "结合 {content} 解释", attachments });
    expect(JSON.stringify(messages)).not.toContain("private endpoint detail");
    expect(harness.create).not.toHaveBeenCalled();
  });
  it('recalls a failed question with its image for an explicit retry', async () => {
    const f = await fixture();
    const image = { name: 'scan.png', type: 'image', mimeType: 'image/png', data: 'cGlj' };
    harness.create.mockRejectedValueOnce(new Error('synthetic offline'));
    await find(f.render(), InputArea)!.props.onSend('重试图片', [image]); await waitForSave();
    const draft = { text: '', attachments: [] as any[] };
    const tree = f.render();
    (find(tree, InputArea)! as any).ref.current = {
      getInputValue: () => draft.text, setInputValue: (value: string) => { draft.text = value; },
      addAttachments: (attachments: any[]) => { draft.attachments.push(...attachments); }, focus() {},
    };
    find(tree, InputArea)!.props.onRecallGroundedQuestion();
    expect(draft).toEqual({ text: '重试图片', attachments: [image] });
    await find(f.render(), InputArea)!.props.onSend(draft.text, draft.attachments); await waitForSave(2);
    expect(JSON.stringify(harness.create.mock.calls[1][0])).toContain('data:image/png;base64,cGlj');
  });
  it("runs an allowed file creation through the saved Ollama config and compatible tool route", async () => {
    const f = await fixture(); const p = f.plugin as any;
    p.settings.localLlmConfigs = [{ id: "local", framework: "ollama", model: "tool-model", enabledModels: ["tool-model"], availableModels: ["tool-model"], baseUrl: "http://127.0.0.1:11434", enabled: true, verified: true }];
    p.settings.cloudVaultToolAllowedFolders = ["Study"];
    p.getSelectedModel = () => "local-llm:local:tool-model"; p.workspaceState.selectedRagSetting = null;
    const created = new Map<string, string>();
    const folder = Object.assign(new TFolder(), { path: "Study", name: "Study", children: [] });
    p.app.vault.getAllLoadedFiles = () => [folder];
    p.app.vault.getAbstractFileByPath = (path: string) => path === "Study" ? folder : null;
    p.app.vault.create = async (path: string, text: string) => { created.set(path, text); return Object.assign(new TFile(), { path }); };
    harness.create.mockReset().mockResolvedValueOnce({ async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "make", function: { name: "create_note", arguments: JSON.stringify({ name: "练习", folder: "Study", content: "合成练习" }) } }] }, finish_reason: "tool_calls" }] };
    } }).mockResolvedValueOnce({ async *[Symbol.asyncIterator]() { yield { choices: [{ delta: { content: "已创建" }, finish_reason: "stop" }] }; } });
    let tree = f.render(); find(tree, InputArea)!.props.onVaultToolModeChange("all"); tree = f.render();
    await find(tree, InputArea)!.props.onSend("创建练习"); await waitForSave();
    expect(harness.clients, JSON.stringify(harness.save.mock.calls.at(-1)?.[0].at(-1))).toEqual(expect.arrayContaining([expect.objectContaining({ baseURL: "http://127.0.0.1:11434/v1" })]));
    expect(harness.create.mock.calls[0][0].tools.some((tool: any) => tool.function.name === "create_note")).toBe(true);
    expect(created.get("Study/练习.md")).toContain("合成练习");
    expect(harness.save.mock.calls.at(-1)?.[0].at(-1).toolResults).toEqual(expect.arrayContaining([expect.objectContaining({ toolCallId: "make", result: expect.objectContaining({ success: true }) })]));
  });
  it("leaves knowledge mode when search-result attachments are explicitly sent to chat", async () => {
    const f = await fixture(); let tree = f.render();
    find(tree, InputArea)!.props.onGroundedModeChange(true);
    f.render(); f.ref.current.clearRagSetting(); tree = f.render();
    expect(find(tree, InputArea)!.props.groundedMode).toBe(false);
  });
  it("prepares a reading question from the captured selection without replacing an existing draft", async () => {
    const f = await fixture(); let tree = f.render();
    const draft = { current: "已经写下的问题" };
    const input = find(tree, InputArea)! as any;
    input.ref.current = { getInputValue: () => draft.current, setInputValue: (value: string) => { draft.current = value; }, focus: vi.fn() };
    f.ref.current.prepareReadingQuestion({ filePath: "阅读/笔记.md", selection: "具体段落" }, true);
    tree = f.render();
    expect(find(tree, InputArea)!.props.groundedMode).toBe(true);
    expect(draft.current).toContain("已经写下的问题");
    expect(draft.current).toContain("具体段落");
    expect(draft.current).toContain("阅读/笔记.md");
    expect(harness.create).not.toHaveBeenCalled();
  });

  it("does not expand the source path or special text inside a reading selection into the whole note", async () => {
    const f = await fixture();
    const file = Object.assign(new TFile(), { path: "阅读/笔记.md", extension: "md" });
    const read = vi.fn().mockResolvedValue("整个笔记中的私人内容");
    (f.plugin.app.vault as any).getFiles = () => [file];
    (f.plugin.app.vault as any).read = read;
    (f.plugin.app.workspace as any).getActiveFile = () => file;
    f.plugin.settings.cloudVaultToolAllowedFolders = ["其他目录"];
    let tree = f.render(); const draft = { current: "" };
    (find(tree, InputArea)! as any).ref.current = { getInputValue: () => draft.current, setInputValue: (value: string) => { draft.current = value; }, focus: vi.fn() };
    f.ref.current.prepareReadingQuestion({ filePath: file.path, selection: "原文里的 {content} 标记" }, true);
    tree = f.render(); await find(tree, InputArea)!.props.onSend(draft.current); await waitForSave();
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.create.mock.calls[0][0])).toContain("原文里的 {content} 标记");
    expect(JSON.stringify(harness.create.mock.calls[0][0])).not.toContain("整个笔记中的私人内容");
  });

  it("keeps an edited quoted passage literal instead of expanding its variables", async () => {
    const f = await fixture(); const file = Object.assign(new TFile(), { path: "阅读/笔记.md", extension: "md" });
    const read = vi.fn().mockResolvedValue("整篇笔记");
    (f.plugin.app.vault as any).getFiles = () => [file]; (f.plugin.app.vault as any).read = read;
    (f.plugin.app.workspace as any).getActiveFile = () => file;
    let tree = f.render(); const draft = { current: "" };
    (find(tree, InputArea)! as any).ref.current = { getInputValue: () => draft.current, setInputValue: (value: string) => { draft.current = value; }, focus: vi.fn() };
    f.ref.current.prepareReadingQuestion({ filePath: file.path, selection: "原有 {content}" }, true);
    draft.current = draft.current.replace("原有", "编辑后的");
    tree = f.render(); await find(tree, InputArea)!.props.onSend(draft.current); await waitForSave();
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.create.mock.calls[0][0])).toContain("编辑后的 {content}");
  });

  it("does not expand a reading selection when restoring and retrying a failed question", async () => {
    const f = await fixture(); const file = Object.assign(new TFile(), { path: "阅读/笔记.md", extension: "md" });
    const read = vi.fn().mockResolvedValue("不应发送的整篇笔记");
    (f.plugin.app.vault as any).getFiles = () => [file]; (f.plugin.app.vault as any).read = read;
    (f.plugin.app.workspace as any).getActiveFile = () => file;
    let tree = f.render(); const draft = { current: "" };
    (find(tree, InputArea)! as any).ref.current = { getInputValue: () => draft.current, setInputValue: (value: string) => { draft.current = value; }, focus: vi.fn() };
    f.ref.current.prepareReadingQuestion({ filePath: file.path, selection: "摘录 {content}" }, true);
    tree = f.render(); harness.create.mockRejectedValueOnce(new Error("offline"));
    await find(tree, InputArea)!.props.onSend(draft.current); await waitForSave();
    draft.current = ""; tree = f.render(); find(tree, InputArea)!.props.onRecallGroundedQuestion();
    tree = f.render(); await find(tree, InputArea)!.props.onSend(draft.current);
    await waitForSave(2);
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.create.mock.calls[1][0])).toContain("摘录 {content}");
    expect(JSON.stringify(harness.create.mock.calls[1][0])).not.toContain("不应发送的整篇笔记");
  });

  it("keeps a manually copied current-material question literal in ordinary chat", async () => {
    const f = await fixture(); const file = Object.assign(new TFile(), { path: "阅读/笔记.md", extension: "md" });
    const read = vi.fn().mockResolvedValue("整篇笔记");
    (f.plugin.app.vault as any).getFiles = () => [file]; (f.plugin.app.vault as any).read = read;
    (f.plugin.app.workspace as any).getActiveFile = () => file;
    let tree = f.render(); const draft = { current: "" };
    (find(tree, InputArea)! as any).ref.current = { getInputValue: () => draft.current, setInputValue: (value: string) => { draft.current = value; }, focus: vi.fn() };
    f.ref.current.prepareReadingQuestion({ filePath: file.path, selection: "摘录 {content}" }, false);
    tree = f.render(); await find(tree, InputArea)!.props.onSend(draft.current); await waitForSave();
    draft.current = harness.save.mock.calls[0][0][0].content;
    tree = f.render(); await find(tree, InputArea)!.props.onSend(draft.current);
    await waitForSave(2);
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.create.mock.calls[1][0])).toContain("摘录 {content}");
  });
  it("sends the current question and real A index excerpts through the OpenAI provider", async () => {
    const f = await fixture(); let tree = f.render();
    find(tree, InputArea)!.props.onGroundedModeChange(true); tree = f.render();
    expect(find(tree, InputArea)!.props.groundedAvailable).toBe(true);
    await find(tree, InputArea)!.props.onSend("请解释资料"); await waitForSave();
    expect(harness.create).toHaveBeenCalledOnce();
    const body = harness.create.mock.calls[0][0];
    const request = JSON.stringify(body);
    expect(request).toContain("请解释资料");
    expect(request).toContain("第一段真实资料");
    expect(request).not.toContain("B/private.md");
    expect(body.tools ?? []).toHaveLength(0);
    const saved = harness.save.mock.calls[0][0];
    expect(readGroundedEvidence(saved.at(-1))?.sources.map(source => source.text)).toEqual(["第一段真实资料", "第二段真实资料"]);
    tree = f.render(); expect(find(tree, MessageList)!.props.messages.at(-1).content).toContain("答案 [1]");
  });

  it.each(["anthropic", "gemini"] as const)("passes current evidence and no tools through the real %s provider", async provider => {
    const f = await fixture(provider); let tree = f.render(); find(tree, InputArea)!.props.onGroundedModeChange(true); tree = f.render();
    await find(tree, InputArea)!.props.onSend("解释当前资料"); await waitForSave();
    const sdk = provider === "anthropic" ? harness.anthropic : harness.gemini;
    expect(sdk).toHaveBeenCalledOnce();
    const request = sdk.mock.calls[0][0];
    expect(JSON.stringify(request)).toContain("第一段真实资料");
    expect(JSON.stringify(request)).toContain("解释当前资料");
    expect(request.tools ?? []).toHaveLength(0);
    expect(readGroundedEvidence(harness.save.mock.calls[0][0].at(-1))?.settingName).toBe("A");
  });

  it("keeps the question and shows a failure without sending when embeddings fail", async () => {
    const f = await fixture(); let tree = f.render(); find(tree, InputArea)!.props.onGroundedModeChange(true); tree = f.render();
    harness.embed.mockRejectedValueOnce(new Error("503 SECRET"));
    await find(tree, InputArea)!.props.onSend("保留这个问题"); await waitForSave();
    expect(harness.create).not.toHaveBeenCalled();
    const saved = harness.save.mock.calls[0][0];
    expect(saved[0].content).toBe("保留这个问题");
    expect(saved[1].content).toBe("chat.grounded.failed");
    expect(JSON.stringify(saved)).not.toContain("SECRET");
  });
  it.each(['unverified', 'changed'] as const)('shows actionable %s vector-space guidance in chat while preserving the index', async vectorSpace => {
    const f = await fixture('openai', 'mock-model', vectorSpace);
    const before = await loadRagSnapshot(f.plugin.app, 'A', 'LLMHub');
    find(f.render(), InputArea)!.props.onGroundedModeChange(true);
    await find(f.render(), InputArea)!.props.onSend('解释资料'); await waitForSave();
    const message = find(f.render(), MessageList)!.props.messages.at(-1).content as string;
    expect(message).toContain(vectorSpace === 'unverified' ? 'lacks a verifiable embedding model/service identity' : 'embedding model or service differs');
    expect(message).toContain('preserved');
    expect(message).toContain('embedding configuration');
    expect(message).toContain('explicitly rebuild');
    expect(harness.embed).not.toHaveBeenCalled(); expect(harness.create).not.toHaveBeenCalled();
    expect(await loadRagSnapshot(f.plugin.app, 'A', 'LLMHub')).toEqual(before);
  });

  it("does not persist provider error messages containing a key or private address", async () => {
    const f = await fixture(); let tree = f.render(); find(tree, InputArea)!.props.onGroundedModeChange(true); tree = f.render();
    harness.create.mockRejectedValueOnce(new Error("503 https://private.example/?key=SECRET"));
    await find(tree, InputArea)!.props.onSend("问题仍在"); await waitForSave();
    const saved = harness.save.mock.calls[0][0];
    expect(saved[0].content).toBe("问题仍在");
    expect(saved[1].content).toBe("chat.grounded.modelFailed");
    expect(JSON.stringify(saved)).not.toContain("SECRET");
    expect(JSON.stringify(saved)).not.toContain("private.example");
  });

  it("retrieves again on follow-up and never presents old A excerpts as B evidence", async () => {
    const f = await fixture(); let tree = f.render(); find(tree, InputArea)!.props.onGroundedModeChange(true); tree = f.render();
    await find(tree, InputArea)!.props.onSend("第一个问题"); await waitForSave(); tree = f.render();
    find(tree, InputArea)!.props.onSearchSelectionChange({ ragSetting: "B", webSearch: false }); tree = f.render();
    await find(tree, InputArea)!.props.onSend("追问");
    await waitForSave(2);
    expect(harness.create).toHaveBeenCalledTimes(2);
    const second = JSON.stringify(harness.create.mock.calls[1][0]);
    expect(second).toContain("另一知识库资料");
    expect(second).toContain("第一个问题");
    expect(second).not.toContain("第一段真实资料");
    expect(readGroundedEvidence(harness.save.mock.calls[1][0].at(-1))?.settingName).toBe("B");
  });

  it.each(["anthropic", "gemini"] as const)("keeps previous evidence out of a %s follow-up in another knowledge base", async provider => {
    const f = await fixture(provider); let tree = f.render(); find(tree, InputArea)!.props.onGroundedModeChange(true); tree = f.render();
    await find(tree, InputArea)!.props.onSend("第一个问题"); await waitForSave(); tree = f.render();
    find(tree, InputArea)!.props.onSearchSelectionChange({ ragSetting: "B", webSearch: false }); tree = f.render();
    await find(tree, InputArea)!.props.onSend("追问");
    await waitForSave(2);
    const sdk = provider === "anthropic" ? harness.anthropic : harness.gemini;
    expect(sdk).toHaveBeenCalledTimes(2);
    const request = JSON.stringify(sdk.mock.calls[1][0]);
    expect(request).toContain("另一知识库资料");
    expect(request).toContain("第一个问题");
    expect(request).not.toContain("第一段真实资料");
    expect(request).not.toContain("__llmhubpp_grounded_evidence");
  });

  it("cancels a pending retrieval without sending an answer request", async () => {
    const f = await fixture(); let tree = f.render(); find(tree, InputArea)!.props.onGroundedModeChange(true); tree = f.render();
    harness.embed.mockImplementation(() => new Promise(() => {}));
    const sending = find(tree, InputArea)!.props.onSend("取消这次检索");
    await vi.waitFor(() => expect(harness.embed).toHaveBeenCalledOnce());
    tree = f.render(); expect(find(tree, InputArea)!.props.isLoading).toBe(true);
    expect(find(tree, MessageList)!.props.groundedSearching).toBe(true);
    find(tree, InputArea)!.props.onStop(); await sending; await waitForSave();
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.save.mock.calls[0][0].at(-1).content).toBe("chat.grounded.cancelled");
    tree = f.render(); expect(find(tree, InputArea)!.props.isLoading).toBe(false);
  });

  it("keeps ordinary chat tools available when reading mode is off", async () => {
    const f = await fixture(); const tree = f.render();
    await find(tree, InputArea)!.props.onSend("普通聊天"); await waitForSave();
    expect(harness.create.mock.calls[0][0].tools.length).toBeGreaterThan(0);
    expect(harness.embed).not.toHaveBeenCalled();
  });

  it("does not offer grounded answers on image models recognized by the actual provider", async () => {
    const f = await fixture("openai", "dall-e-3-preview"); let tree = f.render();
    expect(find(tree, InputArea)!.props.groundedAvailable).toBe(false);
    find(tree, InputArea)!.props.onGroundedModeChange(true); tree = f.render();
    await find(tree, InputArea)!.props.onSend("解释资料"); await flush();
    expect(harness.embed).not.toHaveBeenCalled();
    expect(harness.create).not.toHaveBeenCalled();
  });
});
