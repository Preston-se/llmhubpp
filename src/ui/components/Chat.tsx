import { CHAT_SCROLL_LATEST_EVENT } from "./chat/useChatScroll";
import { Trash2 } from "lucide-react";
import type { MouseEvent } from "react";
import {
	resolveMessageVariables as resolveMessageVariablesShared,
	useChatHistories,
	useChatStreamSessions,
	generateChatId,
	chatFilePath,
	type ChatStorageHost,
	type CommandVariableSources,
} from "obsidian-llm-hub-common/chat";
import { ChatHeader } from "obsidian-llm-hub-common";
import { ChatLayout, HistoryList, HeaderButton, SidebarWidthButton, SaveNoteButton } from "obsidian-llm-hub-common";
import {
	useState,
	useEffect,
	useRef,
	useImperativeHandle,
	forwardRef,
	useCallback,
	useMemo,
} from "react";
import { TFile, Notice, Platform } from "obsidian";
import Plus from "lucide-react/dist/esm/icons/plus";
import History from "lucide-react/dist/esm/icons/history";

import Lock from "lucide-react/dist/esm/icons/lock";
import type { LlmHubPlugin } from "src/plugin";
import { localLlmToolEndpoint } from "src/core/localLlmEndpoint";
import { getStoragePaths } from "src/core/storagePaths";
import {
	DEFAULT_CLI_CONFIG,
	CLI_MODEL,
	CLAUDE_CLI_MODEL,
	CODEX_CLI_MODEL,
	isApiProviderModel,
	getApiProviderId,
	getApiProviderModelName,
	isLocalLlmModel,
	getLocalLlmConfig,
	localLlmDisplayName,
	isLocalLlmToolsEnabled,
	getGeminiApiKey,
	type Message,
	type ApiProviderConfig,
	type ModelType,
	type Attachment,
	type KnowledgeSource,
	type SlashCommand,
	type ChatProvider,
	type StreamChunk,
	type VaultToolNoneReason,
	type VaultToolMode,
	type McpServerConfig,
	type McpAppInfo,
	type ReasoningEffort,
	isImageGenerationModel,
	SKILLS_FOLDER,
} from "src/types";
import { getGeminiClient } from "src/core/gemini";
import { tracing } from "src/core/tracingHooks";
import {
	buildVaultToolPayload,
	filterToolBundleForVaultMode,
	getHostVaultTools,
	getVaultToolExecutionBlock,
} from "src/core/vaultToolAccessPolicy";
import { readSkillTool, skillWorkflowTool, skillScriptTool, executeReadSkillTool, READ_SKILL_TOOL_NAME } from "src/core/skillTools";
import { handleExecuteJavascriptTool, EXECUTE_JAVASCRIPT_TOOL } from "src/core/sandboxExecutor";
import { GET_WORKFLOW_SPEC_TOOL, GET_WORKFLOW_SPEC_TOOL_NAME, handleGetWorkflowSpec } from "src/workflow/workflowSpec";
import { fetchMcpTools, createMcpToolExecutor, type McpToolDefinition, type McpToolExecutor } from "src/core/mcpTools";
import { listCodexModels, PersistentCliSession, type CodexModelOption } from "src/core/cliProvider";
import { CodexVaultMcpBridge } from "src/core/codexVaultMcpBridge";
import { localLlmChatStream } from "src/core/localLlmProvider";
import { openaiChatWithToolsStream, openaiGenerateImageStream, isOpenAiImageModel } from "src/core/openaiProvider";
import { anthropicChatWithToolsStream } from "src/core/anthropicProvider";
import { formatWebSearchCitations, getSearchSelectionForModel, providerSupportsWebSearch } from "src/core/webSearch";
import { searchLocalRag, searchLocalRagResults, loadRagMediaAttachments, buildRagPdfTextContext } from "src/core/localRagStore";
import { resolveApiProviderPdfInputMode, resolveLocalLlmPdfInputMode } from "src/core/pdfInputMode";
import { createRagSearchRunner, RAG_SEARCH_TOOL, RAG_SEARCH_TOOL_NAME, type RagSearchRunner } from "src/core/ragSearchTool";
import { runGroundedRequest } from "src/core/groundedRequest";
import { OFFICIAL_GEMINI_EMBEDDING_ORIGIN } from "src/core/embeddingCredentials";
import { chooseGroundedRestriction } from './GroundedRestrictionModal';
import { attachGroundedEvidence, type GroundedPrompt } from "src/core/groundedAnswer";
import { persistChatDisplayData, restoreChatDisplayData } from "src/core/chatDisplayData";
import { buildNoDiscoverySystemPrompt } from "./chat/noDiscoveryPrompt";
import {
  DEFAULT_DESIRED_VAULT_TOOL_MODE,
  getVaultToolDiagnostics,
  localToolRestrictionDetail,
  readProxyReadOnlyStatus,
  resolveVaultToolModePolicy,
} from "./chat/vaultToolModePolicy";
import { createToolExecutor, withToolFailureResult } from "src/vault/toolExecutor";
import { extractPdfText } from "obsidian-llm-hub-common/vault";
import {
	applyEdit,
	discardEdit,
	getOpenFileAfterApplyPreference,
} from "src/vault/notes";
import MessageList from "./MessageList";
import InputArea, { type InputAreaHandle } from "./InputArea";
import CliTerminalPanel, { isTerminalProvider } from "./CliTerminalPanel";
import {
	isEncryptedFile,
} from "obsidian-llm-hub-common/core";
import { cryptoCache } from "src/core/cryptoCache";
import { formatError } from "obsidian-llm-hub-common/core";
import {
	accumulateStreamChunk,
	createConfirmingToolExecutor,
	createStreamAccumulation,
	pendingStatusFields,
	runChatTurn,
	withRateLimitRetry,
	useAutoReadAloud,
	useReadAloudRate,
	clampReadAloudRate,
	useVoiceConversation,
	buildReadAloudSystemPrompt,
	type ChatTurnOutcome,
	type ChatTurnUi,
	type ChatTurn,
} from "obsidian-llm-hub-common/chat";
import { runSkillWorkflow } from "obsidian-llm-hub-common/workflow";
import { discoverSkills, loadSkill, readSkillBody, buildSkillSystemPrompt, collectSkillWorkflows, collectSkillScripts, type SkillMetadata, type LoadedSkill, type SkillScriptRef } from "src/core/skillsLoader";
import { DEFAULT_BUILTIN_SKILL_IDS, builtinFolderPath, restoredSkillPaths, prunedSkillPaths, getBuiltinSkillMetadata, fileSkillFor, type FileSkill } from "src/core/builtinSkills";
import { buildBuiltinOkfSystemPrompt, buildOkfSystemPrompt, discoverOkfBundles, getBuiltinOkfBundle, isBuiltinOkfBundleId, type OkfBundle } from "src/core/okfLoader";
import { executeReadOkfDocumentTool, READ_OKF_DOCUMENT_TOOL, READ_OKF_DOCUMENT_TOOL_NAME } from "src/core/okfDocumentTool";
import { getInterpreter, runScript } from "src/core/scriptRunner";
import { promptForValue } from "./workflow/ValuePromptModal";
import { t } from "src/i18n";
import { applyToolActivityEvent, cancelToolActivities, type ToolActivityState } from "./chat/toolActivity";
import {
	shouldUseImageModel,
	PAID_RATE_LIMIT_RETRY_DELAYS_MS,
	buildErrorMessage,
	limitConversationHistory,
	type CliSessionInfo,
	type ChatHistory,
} from "./chat/chatUtils";
import {
	parseMarkdownToMessages,
	formatHistoryDate,
} from "./chat/chatHistory";
import { withRequestedSkillPath, useSkillPathPersistence } from "./chat/contextSkills";
import { resolveAgentPluginMcpServers } from "src/core/agentPlugins";
import { useComposerConversationKey } from "./chat/useComposerDraft";
import { buildLocalLlmAttachmentContext } from "./chat/localAttachmentContext";

export interface ChatRef {
	getActiveChat: () => TFile | null;
	setActiveChat: (chat: TFile | null) => void;
	addAttachments: (attachments: Attachment[]) => void;
	clearRagSetting: () => void;
	askSelection: (selection: { text: string; sourcePath?: string }) => void;
	setDraft: (content: string) => void;
	prepareReadingQuestion: (context: { filePath: string; selection: string; scope?: "selection" | "document"; truncated?: boolean; question?: string }, grounded: boolean) => void;
}

/**
 * Heuristic: does this error message indicate the local LLM (or its gateway)
 * rejected a tools / function-calling payload? Used to decide whether to
 * auto-disable tools for that model and fall back to the marker-based skill
 * flow. Matches phrases seen across LM Studio, vLLM, llama.cpp, and OpenAI-
 * compatible gateways.
 *
 * Conservative: requires both a "request was rejected" cue (4xx / schema
 * / "unsupported") AND a tools/function keyword, so a generic 400 caused by
 * a malformed user prompt — or a network error that happens to mention
 * "tools" — won't disable tools for the whole model.
 */
function looksLikeToolsRejection(msg: string): boolean {
	if (!msg) return false;
	const lower = msg.toLowerCase();
	// Match "tool", "tools", "tool_call", "tool_calls", "function call",
	// "function_call". Underscore-suffixed forms need an explicit branch
	// because \b can't span an underscore boundary.
	const mentionsTools = /\btools?\b|\btool_calls?\b|\bfunction[_ ]?calls?\b/.test(lower);
	if (!mentionsTools) return false;
	// Rejection cues: HTTP status, request-shape complaints. Avoided generic
	// words like "cannot" that match transient network failures (e.g.
	// "cannot connect to host while loading tools").
	return /\b4\d\d\b|invalid|unsupported|not supported|don'?t support|unknown|missing|rejected|schema|expected/.test(lower);
}

/**
 * Heuristic: is this an authentication failure (401/403)? Used to skip the
 * tools auto-disable path on auth errors that would otherwise false-match
 * `looksLikeToolsRejection` (e.g. "Bearer no-key" responses that mention
 * "function calling not allowed for this key").
 */
function looksLikeAuthError(msg: string): boolean {
	if (!msg) return false;
	return /\b401\b|\b403\b|unauthorized|forbidden|authentication|invalid api[_ ]?key/i.test(msg);
}

// File mentions stay as bare vault paths whenever the model has Vault tools
// (see resolveMessageVariables), so it has to fetch their contents itself.
const FILE_MENTION_TOOL_PROMPT = "\n\nA bare vault-relative path in the user's message (for example `folder/note.md` or `folder/document.pdf`) is a file the user referenced by mention, not a literal string. Its content is not inlined into the message. Call read_note with that exact path before answering anything that depends on it.";

const AUTOMATIC_RAG_RETRIEVAL = false;
function withSearchEvidence(message: Message, runner: RagSearchRunner | null): Message {
  const evidence = runner?.getEvidence();
  return evidence ? attachGroundedEvidence(message, evidence) : message;
}

const CODEX_VAULT_TOOLS = new Set([
	"read_timeline",
	"read_note",
	"search_notes",
	"list_notes",
	"list_folders",
	"get_active_note_info",
	"create_note",
	"propose_edit",
	"propose_delete",
	"rename_note",
	"bulk_propose_edit",
	"bulk_propose_delete",
	"bulk_propose_rename",
]);

function shouldLimitLlmVaultTools(model: ModelType): boolean {
	return model !== "antigravity-cli"
		&& model !== "claude-cli"
		&& model !== "codex-cli";
}

// Gemma 4 cannot combine Google Search with Function Calling in one request.
function isGemma4(model: string): boolean {
	if (isApiProviderModel(model)) return getApiProviderModelName(model).toLowerCase().includes("gemma-4");
	return model.toLowerCase().includes("gemma-4");
}

function readVaultToolRuntimeState(plugin: LlmHubPlugin) {
	const guard = (plugin as LlmHubPlugin & {
		safeGuard?: { server?: { listening?: boolean } | null; shouldEnforceProxyReadOnly?: () => boolean };
	}).safeGuard;
	return {
		proxyReadOnly: readProxyReadOnlyStatus(guard),
		allowedFolders: [...(plugin.settings.cloudVaultToolAllowedFolders ?? [])],
	};
}

interface ChatProps {
	plugin: LlmHubPlugin;
	onToggleSidebarWidth: () => boolean;
}

const Chat = forwardRef<ChatRef, ChatProps>(({ plugin, onToggleSidebarWidth }, ref) => {
	const [messages, setMessages] = useState<Message[]>([]);
	const latestMessagesRef = useRef(messages);
	latestMessagesRef.current = messages;
	const [maxPreviousMessages, setMaxPreviousMessages] = useState(() => {
		const saved = plugin.workspaceState.maxPreviousMessages;
		return typeof saved === "number" ? Math.max(0, Math.min(99, Math.trunc(saved))) : 99;
	});
	const [sentPromptHistory, setSentPromptHistory] = useState<string[]>(() => {
		const saved = plugin.workspaceState.sentPromptHistory;
		return Array.isArray(saved) ? saved.filter(prompt => typeof prompt === "string" && prompt.trim()).slice(-100) : [];
	});
	const [activeChat, setActiveChat] = useState<TFile | null>(null);
	// Where this plugin keeps its chats. Everything that reads or writes them is shared.
	const chatStorageHost: ChatStorageHost = {
		app: plugin.app,
		getChatHistoryFolder: () => getStoragePaths(plugin.settings, plugin.app.vault.configDir).chats,
		getManualChatSaveFolder: () => plugin.settings.manualChatSaveFolder,
		isHistoryEnabled: () => plugin.settings.saveChatHistory,
		getMaxSavedChatHistories: () => plugin.settings.maxSavedChatHistories,
		getEncryption: () => plugin.settings.encryption,
	};
	const {
		chatHistories,
		currentChatId,
		setCurrentChatId,
		saveNoteState,
		loadChatHistories,
		saveChatToDisk: saveRawChatToDisk,
		saveCurrentChat: saveRawCurrentChat,
		deleteChat: deleteChatFromHistory,
		saveAsNote,
		decryptChat,
	} = useChatHistories(chatStorageHost);
	const saveChatToDisk: typeof saveRawChatToDisk = (msgs, ...args) => saveRawChatToDisk(msgs.map(persistChatDisplayData), ...args);
	const saveCurrentChat: typeof saveRawCurrentChat = (msgs, ...args) => saveRawCurrentChat(msgs.map(persistChatDisplayData), ...args);
	const { key: composerConversationKey, selectHistory: selectComposerHistory,
		startNewDraft, rememberChat: rememberComposerChat } = useComposerConversationKey(currentChatId);
	const [cliSession, setCliSession] = useState<CliSessionInfo | null>(null);  // CLI session for resumption
	const [showHistory, setShowHistory] = useState(false);
	const [isSidebarWide, setIsSidebarWide] = useState(false);
	const [isCompacting, setIsCompacting] = useState(false);
	const [currentModel, setCurrentModel] = useState<ModelType>(plugin.getSelectedModel());
	const [codexModels, setCodexModels] = useState<CodexModelOption[]>([]);
	const ragEnabledState = true;  // RAG is always available; individual stores managed in settings
	const [ragSettingNames, setRagSettingNames] = useState<string[]>(plugin.getRagSettingNames());
	const [selectedRagSetting, setSelectedRagSetting] = useState<string | null>(
		plugin.workspaceState.selectedRagSetting
	);
	const [groundedOverride, setGroundedMode] = useState<boolean | null>(null);
	const [groundedSearchSession, setGroundedSearchSession] = useState<number | null>(null);
	const [groundedProblem, setGroundedProblem] = useState<{ session: number; message: string } | null>(null);
	const groundedRetrievalRef = useRef<AbortController | null>(null);
	const [webSearchEnabled, setWebSearchEnabled] = useState(plugin.workspaceState.webSearchEnabled === true);
	const groundedMode = groundedOverride ?? (plugin.settings.groundedAnswersByDefault !== false && !webSearchEnabled);
	const groundedPreflight = useRef(new Set<number>());

	// Vault tool safety has two layers:
	// - desired mode: the user's per-chat safety preference
	// - effective mode: what the current model/provider can actually expose
	//
	// Every independent chat starts from Read Only. Temporary model capability
	// restrictions must never silently turn that preference into All.
	const initialModel = plugin.getSelectedModel();

	const initialLocalLlmConfig = isLocalLlmModel(initialModel)
		? getLocalLlmConfig(initialModel, plugin.settings)
		: null;

	const initialLocalLlmToolsCapable = !!(
		initialLocalLlmConfig
		&& isLocalLlmToolsEnabled(
			initialLocalLlmConfig,
			initialLocalLlmConfig.model,
		)
	);

	const isInitialVaultRestrictedCli =
		initialModel === "antigravity-cli"
		|| initialModel === "claude-cli"
		|| (
			isLocalLlmModel(initialModel)
			&& !initialLocalLlmToolsCapable
		);

	const initialGemma4Rag =
		initialModel.toLowerCase().includes("gemma-4")
		&& (
			plugin.workspaceState.selectedRagSetting != null
			|| plugin.workspaceState.webSearchEnabled === true
		);

	const desiredVaultToolModeRef = useRef<VaultToolMode>(
		DEFAULT_DESIRED_VAULT_TOOL_MODE,
	);

	const initialVaultToolPolicy = resolveVaultToolModePolicy({
		desiredMode: desiredVaultToolModeRef.current,
		restrictedByModel: isInitialVaultRestrictedCli,
		gemmaSearchConflict: initialGemma4Rag,
	});

	const [vaultToolMode, setVaultToolMode] = useState<VaultToolMode>(
		initialVaultToolPolicy.effectiveMode,
	);

	const [vaultToolNoneReason, setVaultToolNoneReason] =
		useState<VaultToolNoneReason | null>(
			initialVaultToolPolicy.noneReason,
		);
	// MCP servers state: local copy with per-server enabled state (for chat session)
	const [mcpServers, setMcpServers] = useState(() =>
		(isInitialVaultRestrictedCli || initialGemma4Rag)
			? plugin.settings.mcpServers.map(s => ({ ...s, enabled: false }))
			: [...plugin.settings.mcpServers]
	);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const {
		isLoading,
		setIsLoading,
		streamingContent,
		setStreamingContent,
		streamingThinking,
		setStreamingThinking,
		abortControllerRef,
		activeSessionIdRef,
		createStreamSession: createRawStreamSession,
		leaveCurrentChat,
	} = useChatStreamSessions({
		setMessages,
		saveChatToDisk,
		currentChatId,
		// A backgrounded stream owns the executor it is still using; just let go of it.
		onDetachStream: () => { mcpExecutorRef.current = null; },
		onLeaveIdle: () => {
			if (mcpExecutorRef.current) {
				void mcpExecutorRef.current.cleanup();
				mcpExecutorRef.current = null;
			}
		},
	});
	const createStreamSession = () => {
		const session = createRawStreamSession();
		// A first turn may finish in the background, without ever assigning its
		// generated ID to currentChatId. Remember its draft before detaching.
		rememberComposerChat(session.myChatId);
		return session;
	};
	const [toolActivityState, setToolActivityState] = useState<ToolActivityState | null>(null);
	const toolActivityTurnRef = useRef(0);
	const beginToolActivity = (turn: ChatTurn) => {
		const owner = { sessionId: turn.session.mySessionId, turnId: ++toolActivityTurnRef.current };
		if (turn.isActive()) setToolActivityState({ ...owner, items: [] });
		return (chunk: StreamChunk) => {
			if (!turn.isActive() || turn.abortController.signal.aborted) return;
			if (chunk.type === "tool_call" || chunk.type === "tool_result") {
				setToolActivityState(previous => applyToolActivityEvent(previous, owner, chunk));
			}
		};
	};
	const inputAreaRef = useRef<InputAreaHandle>(null);
	const [voiceChatSettings, setVoiceChatSettings] = useState(() => ({ ...plugin.settings.voiceChat }));
	useAutoReadAloud(messages, isLoading, voiceChatSettings.autoReadAloud);
	useReadAloudRate(voiceChatSettings.readAloudRate);
	const handleAutoReadAloudChange = useCallback((enabled: boolean) => {
		setVoiceChatSettings((previous) => {
			const next = { ...previous, autoReadAloud: enabled };
			plugin.settings.voiceChat = next;
			void plugin.saveSettings();
			return next;
		});
	}, [plugin]);
	const handleReadAloudRateChange = useCallback((rate: number) => {
		setVoiceChatSettings((previous) => {
			const next = { ...previous, readAloudRate: clampReadAloudRate(rate) };
			plugin.settings.voiceChat = next;
			void plugin.saveSettings();
			return next;
		});
	}, [plugin]);
	// The transcript arrives as a paste from speech-popup, so the session only
	// has to open the popup again once each answer lands.
	const voiceConversation = useVoiceConversation(messages, isLoading, {
		command: voiceChatSettings.speechPopupCommand,
		chatId: currentChatId,
		readAloud: voiceChatSettings.autoReadAloud,
		onError: (message: string) => { new Notice(message); },
		onOpened: () => inputAreaRef.current?.focus(),
		onStarted: () => handleAutoReadAloudChange(true),
	});
	const pendingExternalSelectionRef = useRef<{ text: string; sourcePath?: string } | null>(null);
	const pendingReadingLiteralsRef = useRef<string[]>([]);
	const currentSlashCommandRef = useRef<SlashCommand | null>(null);
	// A slash command with confirmEdits off writes without asking.
	const autoApplyEdits = () => currentSlashCommandRef.current?.confirmEdits === false;
	const preSlashSettingsRef = useRef<{
		model: ModelType;
		ragSetting: string | null;
		webSearch: boolean;
		vaultToolMode: VaultToolMode;
		vaultToolNoneReason: VaultToolNoneReason | null;
		mcpServers: McpServerConfig[];
	} | null>(null);
	const mcpExecutorRef = useRef<McpToolExecutor | null>(null);
	// Chat IDs that have been deleted — background streams check this to avoid
	// resurrecting a deleted chat when they complete.
	// Preserve the plugin-level last active chat across the component's first render
	// so the mount-time restore effect can read it before sync-back starts.
	const initialLastActiveChatIdRef = useRef<string | null>(plugin.lastActiveChatId);
	const hasCompletedInitialRestoreRef = useRef(false);
	const persistentCliRef = useRef<PersistentCliSession | null>(null);
	const codexVaultMcpBridgeRef = useRef<CodexVaultMcpBridge | null>(null);
	const openCodeVaultMcpBridgeRef = useRef<CodexVaultMcpBridge | null>(null);
	const codexRuntimeConfigRef = useRef({
		model: plugin.settings.cliConfig?.codexCliModel,
		path: plugin.settings.cliConfig?.codexCliPath,
		reasoningEffort: plugin.settings.cliConfig?.codexCliReasoningEffort,
	});
	const previousNonTerminalModelRef = useRef<ModelType | null>(
		isTerminalProvider(initialModel) ? null : initialModel
	);
	const [vaultFiles, setVaultFiles] = useState<string[]>([]);
	const [currentDashboard, setCurrentDashboard] = useState<TFile | null>(null);
	// The file open in the editor and the skill that fits it. The skill is only
	// offered on the empty chat; opening a file never switches it on.
	const [editorFile, setEditorFile] = useState<{ file: TFile; skill: FileSkill } | null>(null);
	const [hasSelection, setHasSelection] = useState(false);
	const [cliConfig, setCliConfig] = useState(plugin.settings.cliConfig || DEFAULT_CLI_CONFIG);
	const [decryptingChatId, setDecryptingChatId] = useState<string | null>(null);
	const [decryptPassword, setDecryptPassword] = useState("");
	// Pending feedback for edit rejection (to be sent after state update)
	const [pendingEditFeedback, setPendingEditFeedback] = useState<{ filePath: string; request: string } | null>(null);
	const [reasoningEffortByModel, setReasoningEffortByModel] = useState<Record<string, ReasoningEffort>>(
		() => ({ ...(plugin.workspaceState.reasoningEffortByModel ?? {}) }),
	);

	// Agent Skills state (initialise with built-in skills so they are available synchronously)
	const [availableSkills, setAvailableSkills] = useState<SkillMetadata[]>(getBuiltinSkillMetadata);
	// Chats carry over the previous skill selection, even an empty one; only a
	// user who never touched the list starts from the shipped defaults.
	const [activeSkillPaths, setActiveSkillPaths] = useState<string[]>(
		() => restoredSkillPaths(plugin.settings.activeSkillPaths, DEFAULT_BUILTIN_SKILL_IDS.map(builtinFolderPath)),
	);
	useSkillPathPersistence(activeSkillPaths, (paths) => {
		plugin.settings.activeSkillPaths = [...paths];
		void plugin.saveSettings();
	});
	const getEffectiveSkillPathsForSend = useCallback((skillPath?: string) =>
		withRequestedSkillPath(activeSkillPaths, skillPath), [activeSkillPaths]);
	const handleEnableSkill = useCallback((folderPath: string) => {
		setActiveSkillPaths(prev => prev.includes(folderPath) ? prev : [...prev, folderPath]);
	}, []);
	const editorFileSkill = useMemo(() => {
		if (!editorFile) return null;
		const skill = availableSkills.find(s => s.folderPath === editorFile.skill.skillPath);
		if (!skill) return null;
		return {
			fileName: editorFile.file.name,
			kind: editorFile.skill.kind,
			skillName: skill.name,
			enabled: activeSkillPaths.includes(skill.folderPath),
			onEnable: () => handleEnableSkill(skill.folderPath),
		};
	}, [editorFile, availableSkills, activeSkillPaths, handleEnableSkill]);
	const [okfBundles, setOkfBundles] = useState<OkfBundle[]>([]);
	const [activeOkfBundleIds, setActiveOkfBundleIds] = useState<string[]>([]);

	// CLI provider state (CLI not available on mobile)
	const antigravityCliVerified = !Platform.isMobile && cliConfig.cliVerified === true;
	const claudeCliVerified = !Platform.isMobile && cliConfig.claudeCliVerified === true;
	const codexCliVerified = !Platform.isMobile && cliConfig.codexCliVerified === true;
	useEffect(() => {
		if (!codexCliVerified) {
			setCodexModels([]);
			return;
		}
		let cancelled = false;
		void listCodexModels(cliConfig.codexCliPath)
			.then((models) => { if (!cancelled) setCodexModels(models); })
			.catch(() => { if (!cancelled) setCodexModels([]); });
		return () => { cancelled = true; };
	}, [codexCliVerified, cliConfig.codexCliPath]);
	const activeLocalLlmConfigs = !Platform.isMobile
		? (plugin.settings.localLlmConfigs ?? []).filter(c => c.verified && c.enabled !== false)
		: [];
	const localLlmVerified = activeLocalLlmConfigs.length > 0;
	const enabledApiProviders = !Platform.isMobile ? plugin.settings.apiProviders.filter(p => p.enabled && p.verified) : [];
	const hasEnabledApiProvider = enabledApiProviders.length > 0;
	const anyCliVerified = antigravityCliVerified || claudeCliVerified || codexCliVerified || localLlmVerified;
	const isAntigravityCliMode = !Platform.isMobile && currentModel === "antigravity-cli";
	const isClaudeCliMode = !Platform.isMobile && currentModel === "claude-cli";
	const isCodexCliMode = !Platform.isMobile && currentModel === "codex-cli";
	const isNativeCliTerminalMode = isTerminalProvider(currentModel);
	const isLocalLlmMode = !Platform.isMobile && isLocalLlmModel(currentModel);
	const isApiProviderMode = !Platform.isMobile && isApiProviderModel(currentModel);
	// Local LLMs with an OpenAI-compatible framework + a tools-capable model
	// can use vault tools just like API providers. Exclude them from the
	// "CLI mode" lockdown that forces vaultToolMode to "none" and hides MCP.
	const currentLocalLlmConfig = isLocalLlmMode ? getLocalLlmConfig(currentModel, plugin.settings) : null;
	const isLocalLlmToolsCapable = !!(currentLocalLlmConfig
		&& isLocalLlmToolsEnabled(currentLocalLlmConfig, currentLocalLlmConfig.model));
	const isCliMode = isAntigravityCliMode || isClaudeCliMode || isCodexCliMode
		|| (isLocalLlmMode && !isLocalLlmToolsCapable);
	const isVaultToolRestrictedCliMode = isAntigravityCliMode || isClaudeCliMode
		|| (isLocalLlmMode && !isLocalLlmToolsCapable);
	const [vaultToolRuntimeState, setVaultToolRuntimeState] = useState(() => readVaultToolRuntimeState(plugin));
	useEffect(() => {
		const refresh = () => {
			const next = readVaultToolRuntimeState(plugin);
			setVaultToolRuntimeState(previous => previous.proxyReadOnly === next.proxyReadOnly
				&& previous.allowedFolders.length === next.allowedFolders.length
				&& previous.allowedFolders.every((folder, index) => folder === next.allowedFolders[index])
				? previous : next);
		};
		refresh();
		const timer = window.setInterval(refresh, 500);
		return () => window.clearInterval(timer);
	}, [plugin]);
	const vaultToolDiagnostics = getVaultToolDiagnostics({
		desiredMode: desiredVaultToolModeRef.current,
		effectiveMode: vaultToolMode,
		modelRestricted: isVaultToolRestrictedCliMode,
		modelDetail: localToolRestrictionDetail(currentLocalLlmConfig),
		searchConflict: isGemma4(currentModel) && Boolean(selectedRagSetting || webSearchEnabled),
		proxyReadOnly: vaultToolRuntimeState.proxyReadOnly,
		scopeEnforced: shouldLimitLlmVaultTools(currentModel),
		allowedFolders: vaultToolRuntimeState.allowedFolders,
	});

	// Resolve API provider config from current model name ("api:{providerId}")
	const getActiveApiProvider = (): ApiProviderConfig | null => {
		if (!isApiProviderModel(currentModel)) return null;
		const providerId = getApiProviderId(currentModel);
		return plugin.settings.apiProviders.find(p => p.id === providerId && p.enabled && p.verified) ?? null;
	};

	// Check if configuration is ready (any CLI verified OR API provider configured)
	const isConfigReady = anyCliVerified || hasEnabledApiProvider;

	// Native web search is available on Gemini plus official OpenAI, Anthropic, and xAI endpoints.
	const activeSearchProvider = getActiveApiProvider();
	const allowWebSearch = !isCliMode && !!activeSearchProvider
		&& providerSupportsWebSearch(activeSearchProvider, getApiProviderModelName(currentModel) || "");
	// Server RAG needs API mode; local RAG works everywhere
	const allowRag = ragEnabledState;
	const resolvedApiModelName = getApiProviderModelName(currentModel) || "";
	const groundedModelAvailable = (isApiProviderMode && !!activeSearchProvider
		&& !(activeSearchProvider.type === "openai" && isOpenAiImageModel(resolvedApiModelName))
		|| !!currentLocalLlmConfig && currentLocalLlmConfig.framework !== 'opencode')
		&& !isImageGenerationModel(currentModel);
	const reasoningEffortOptions: ReasoningEffort[] = (() => {
		if (!activeSearchProvider || isImageGenerationModel(currentModel)) return [];
		const modelName = resolvedApiModelName.toLowerCase();
		if (activeSearchProvider.type === "openai" && /^(?:gpt-5\.6(?:-|$)|gpt-6-astra(?:-|$))/.test(modelName)) {
			return ["default", "none", "low", "medium", "high", "xhigh", "max"];
		}
		if (activeSearchProvider.type !== "gemini" || modelName.includes("gemma-4")) return [];
		if (modelName.includes("flash-lite-image")) return ["default", "minimal", "high"];
		if (modelName.includes("3.1-pro") || modelName.includes("3-pro") || modelName.includes("3.7-flash")) {
			return ["default", "low", "medium", "high"];
		}
		if (modelName.includes("gemini-3")) {
			return ["default", "minimal", "low", "medium", "high"];
		}
		return [];
	})();
	const savedReasoningEffort = reasoningEffortByModel[currentModel] ?? "default";
	const selectedReasoningEffort = reasoningEffortOptions.includes(savedReasoningEffort)
		? savedReasoningEffort
		: "default";

	// Reasoning is controlled only by the selected effort.
	const getThinkingToggle = (): boolean | undefined => {
		if (selectedReasoningEffort !== "default") return selectedReasoningEffort !== "none";
		return undefined;
	};

	// Build available models list (API providers + CLI options)
	const availableModels = [
		...enabledApiProviders.flatMap(p =>
			p.enabledModels.map(m => ({
				name: `api:${p.id}:${m}` as ModelType,
				displayName: `${p.name} (${m})`,
				description: `${p.type} API provider`,
				isCliModel: false,
				providerName: p.name,
			}))
		),
		...(antigravityCliVerified ? [CLI_MODEL] : []),
		...(claudeCliVerified ? [CLAUDE_CLI_MODEL] : []),
		...(codexCliVerified ? [CODEX_CLI_MODEL] : []),
		...activeLocalLlmConfigs.flatMap(c => {
			const models = (c.enabledModels && c.enabledModels.length > 0)
				? c.enabledModels
				: (c.model ? [c.model] : []);
			return models.map(m => ({
				name: `local-llm:${c.id}:${m}` as ModelType,
				displayName: localLlmDisplayName(c, m),
				description: `Local LLM (${c.framework})`,
				isCliModel: true,
			}));
		}),
	];

	useEffect(() => {
		if (!isTerminalProvider(currentModel)) {
			previousNonTerminalModelRef.current = currentModel;
		}
	}, [currentModel]);

	const handleBackToChat = () => {
		const fallbackModel = availableModels.find(model => !isTerminalProvider(model.name))?.name;
		const targetModel = previousNonTerminalModelRef.current ?? fallbackModel;
		if (targetModel) {
			handleModelChange(targetModel);
		}
	};

	useImperativeHandle(ref, () => ({
		getActiveChat: () => activeChat,
		setActiveChat: (chat: TFile | null) => setActiveChat(chat),
		addAttachments: (attachments: Attachment[]) => inputAreaRef.current?.addAttachments(attachments),
		clearRagSetting: () => {
			setGroundedMode(false);
			setSelectedRagSetting(null);
			void plugin.selectSearchSelection({ ragSetting: null, webSearch: webSearchEnabled });
		},
		askSelection: (selection: { text: string; sourcePath?: string }) => {
			const text = selection.text.trim();
			if (!text) return;
			pendingExternalSelectionRef.current = { text, sourcePath: selection.sourcePath };
			inputAreaRef.current?.setInputValue("{selection}");
			inputAreaRef.current?.focus();
		},
		setDraft: (content: string) => {
			inputAreaRef.current?.setInputValue(content);
			inputAreaRef.current?.focus();
		},
		prepareReadingQuestion: (context, grounded) => {
			const previous = inputAreaRef.current?.getInputValue() ?? "";
			const selection = context.selection.trim();
			const introduction = `${t(grounded ? "reading.knowledgePrompt" : "reading.currentPrompt")}: “${context.filePath}”`;
			const excerpt = selection ? `\n${selection.split("\n").map(line => `> ${line}`).join("\n")}` : "";
			if (selection) pendingReadingLiteralsRef.current.push(selection.split("\n").map(line => `> ${line}`).join("\n"));
			const scope = context.scope === "document" ? `\n${t("reading.fullMaterial")}${context.truncated ? ` — ${t("reading.materialTruncated")}` : ""}` : "";
			const draft = `${introduction}${scope}${excerpt}\n\n${t("reading.questionLabel")}${context.question ?? ""}`;
			inputAreaRef.current?.setInputValue(previous.trim() ? `${previous}\n\n${draft}` : draft);
			inputAreaRef.current?.focus();
			setGroundedMode(grounded);
			if (!selection) new Notice(t("reading.noSelection"));
		},
	}));

	// Load chat histories on mount, and restore last active chat if available
	useEffect(() => {
		// Capture session ID at mount time so we can detect if the user
		// navigated elsewhere before the async restore completes.
		const mountSessionId = activeSessionIdRef.current;
		void loadChatHistories().then(async () => {
			try {
				// Skip restore if the user already started a new chat or loaded one
				if (activeSessionIdRef.current !== mountSessionId) return;

				const lastId = initialLastActiveChatIdRef.current;
				if (!lastId) return;

				const basePath = chatFilePath(chatStorageHost, lastId);
				let filePath = basePath;
				let exists = await plugin.app.vault.adapter.exists(filePath);
				if (!exists) {
					filePath = basePath + ".encrypted";
					exists = await plugin.app.vault.adapter.exists(filePath);
				}
				if (!exists) return;
				// Re-check after async gap
				if (activeSessionIdRef.current !== mountSessionId) return;

				const content = await plugin.app.vault.adapter.read(filePath);
				if (isEncryptedFile(content)) return;

				const parsed = parseMarkdownToMessages(content);
				if (parsed?.messages && parsed.messages.length > 0) {
					// Final check before touching state
					if (activeSessionIdRef.current !== mountSessionId) return;
					setMessages(parsed.messages.map(restoreChatDisplayData));
					setCurrentChatId(lastId);
					setCliSession(parsed.cliSession || null);
				}
			} catch (e) {
				console.warn("Failed to restore last active chat:", e);
			} finally {
				hasCompletedInitialRestoreRef.current = true;
			}
		});
	}, [loadChatHistories]);

	// Sync currentChatId → plugin.lastActiveChatId (in-memory, cleared on restart)
	useEffect(() => {
		if (!hasCompletedInitialRestoreRef.current) return;
		plugin.lastActiveChatId = currentChatId;
	}, [currentChatId, plugin]);

	// Discover skills (on mount + when skills-changed is emitted)
	const refreshSkills = useCallback(() => {
		void discoverSkills(plugin.app, plugin.settings.skillsFolder || SKILLS_FOLDER).then((skills) => {
			setAvailableSkills(skills);
			// A saved selection outlives the folders it names: a skill can be
			// renamed, deleted, or belong to an agent plugin that is now off.
			setActiveSkillPaths((previous) => {
				const pruned = prunedSkillPaths(previous, skills);
				return pruned.length === previous.length ? previous : pruned;
			});
		});
	}, [plugin]);

	useEffect(() => {
		refreshSkills();
		plugin.settingsEmitter.on("skills-changed", refreshSkills);
		return () => {
			plugin.settingsEmitter.off("skills-changed", refreshSkills);
		};
	}, [plugin, refreshSkills]);

	const getOkfSource = useCallback((): KnowledgeSource | null => {
		const source = (plugin.settings.knowledgeSources || []).find(s => s.enabled && s.type === "okf" && s.path.trim());
		return source ?? null;
	}, [plugin]);

	const getOkfRoot = useCallback((): string | null => {
		return getOkfSource()?.path.trim() || null;
	}, [getOkfSource]);

	const saveActiveOkfBundleIds = useCallback((activeBundleIds: string[]) => {
		const source = getOkfSource();
		if (!source) return;
		const externalBundleIds = activeBundleIds.filter(id => !isBuiltinOkfBundleId(id));
		plugin.settings.knowledgeSources = plugin.settings.knowledgeSources.map(item =>
			item.id === source.id ? { ...item, activeBundleIds: externalBundleIds } : item
		);
		void plugin.saveSettings();
	}, [getOkfSource, plugin]);

	const refreshOkfBundles = useCallback(() => {
		const builtinBundle = getBuiltinOkfBundle();
		const source = getOkfSource();
		if (!source) {
			setOkfBundles([builtinBundle]);
			setActiveOkfBundleIds(prev => prev.filter(id => isBuiltinOkfBundleId(id)));
			return;
		}
		const root = source.path.trim();
		const savedActiveBundleIds = source.activeBundleIds;
		void discoverOkfBundles(plugin.app, root)
			.then((bundles) => {
				const allBundles = [builtinBundle, ...bundles];
				setOkfBundles(allBundles);
				setActiveOkfBundleIds(prev => {
					const validIds = new Set(allBundles.map(bundle => bundle.id));
					if (savedActiveBundleIds) {
						const builtinSelection = prev.filter(id => isBuiltinOkfBundleId(id));
						return [...builtinSelection, ...savedActiveBundleIds.filter(id => validIds.has(id))];
					}
					return prev.filter(id => validIds.has(id));
				});
			})
			.catch((e) => {
				console.warn("Failed to discover OKF bundles:", e);
				setOkfBundles([builtinBundle]);
				setActiveOkfBundleIds(prev => prev.filter(id => isBuiltinOkfBundleId(id)));
			});
	}, [getOkfSource, plugin]);

	useEffect(() => {
		refreshOkfBundles();
		plugin.settingsEmitter.on("settings-updated", refreshOkfBundles);
		return () => {
			plugin.settingsEmitter.off("settings-updated", refreshOkfBundles);
		};
	}, [plugin, refreshOkfBundles]);

	useEffect(() => {
		const readLeafFile = (leaf: { view?: unknown }): TFile | null => {
			const file = (leaf.view as { file?: TFile | null } | undefined)?.file;
			return file instanceof TFile ? file : null;
		};

		const findContext = (): { dashboardFile: TFile | null; editorFile: TFile | null } => {
			let dashboardFile: TFile | null = null;

			// The chat lives in a sidebar, so the editor file is the one in the most
			// recent leaf of the main area, not whatever leaf has focus.
			const recentLeaf = plugin.app.workspace.getMostRecentLeaf();
			const activeFile = recentLeaf ? readLeafFile(recentLeaf) : null;

			const considerDashboardFile = (file: TFile | null) => {
				if (!file) return;
				if (file.extension === "dashboard" && !dashboardFile) {
					dashboardFile = file;
				}
			};

			considerDashboardFile(activeFile);
			plugin.app.workspace.iterateAllLeaves((leaf) => {
				considerDashboardFile(readLeafFile(leaf));
			});

			if (!dashboardFile) {
				const dashboards = plugin.app.vault
					.getFiles()
					.filter(file => file.extension === "dashboard")
					.sort((a, b) => b.stat.mtime - a.stat.mtime);
				dashboardFile = dashboards[0] ?? null;
			}

			return { dashboardFile, editorFile: activeFile };
		};

		const refreshContext = () => {
			const context = findContext();
			setCurrentDashboard(context.dashboardFile);
			const skill = fileSkillFor(context.editorFile?.extension);
			setEditorFile(context.editorFile && skill ? { file: context.editorFile, skill } : null);
		};

		refreshContext();

		plugin.app.vault.on("create", refreshContext);
		plugin.app.vault.on("delete", refreshContext);
		plugin.app.vault.on("rename", refreshContext);
		plugin.app.workspace.on("active-leaf-change", refreshContext);
		plugin.app.workspace.on("file-open", refreshContext);

		return () => {
			plugin.app.vault.off("create", refreshContext);
			plugin.app.vault.off("delete", refreshContext);
			plugin.app.vault.off("rename", refreshContext);
			plugin.app.workspace.off("active-leaf-change", refreshContext);
			plugin.app.workspace.off("file-open", refreshContext);
		};
	}, [plugin]);

	const handleToggleOkfBundle = useCallback((bundleId: string) => {
		setActiveOkfBundleIds(prev => {
			const next = prev.includes(bundleId)
				? prev.filter(id => id !== bundleId)
				: [...prev, bundleId];
			saveActiveOkfBundleIds(next);
			return next;
		});
	}, [saveActiveOkfBundleIds]);

	const appendOkfSystemPrompt = useCallback(async (systemPrompt: string): Promise<string> => {
		if (activeOkfBundleIds.some(id => isBuiltinOkfBundleId(id))) {
			systemPrompt += buildBuiltinOkfSystemPrompt();
		}
		const okfRoot = getOkfRoot();
		const externalOkfBundleIds = activeOkfBundleIds.filter(id => !isBuiltinOkfBundleId(id));
		if (!okfRoot || externalOkfBundleIds.length === 0) return systemPrompt;
		return systemPrompt + await buildOkfSystemPrompt(plugin.app, okfRoot, externalOkfBundleIds);
	}, [activeOkfBundleIds, getOkfRoot, plugin]);

	// Cleanup MCP executor and persistent CLI session on unmount
	useEffect(() => {
		return () => {
			if (mcpExecutorRef.current) {
				void mcpExecutorRef.current.cleanup();
				mcpExecutorRef.current = null;
			}
			if (persistentCliRef.current) {
				persistentCliRef.current.terminate();
				persistentCliRef.current = null;
			}
			if (codexVaultMcpBridgeRef.current) {
				void codexVaultMcpBridgeRef.current.stop();
				codexVaultMcpBridgeRef.current = null;
			}
			if (openCodeVaultMcpBridgeRef.current) {
				void openCodeVaultMcpBridgeRef.current.stop();
				openCodeVaultMcpBridgeRef.current = null;
			}
		};
	}, []);

	// Load vault files for @ mention suggestions
	useEffect(() => {
		const updateVaultFiles = () => {
			const files = plugin.app.vault.getFiles()
				.filter(file => file.extension === "md" || file.extension === "pdf")
				.map(file => file.path);
			setVaultFiles(files.sort());
		};
		updateVaultFiles();

		// Update on vault changes
		const onVaultChange = () => updateVaultFiles();
		plugin.app.vault.on("create", onVaultChange);
		plugin.app.vault.on("delete", onVaultChange);
		plugin.app.vault.on("rename", onVaultChange);

		return () => {
			plugin.app.vault.off("create", onVaultChange);
			plugin.app.vault.off("delete", onVaultChange);
			plugin.app.vault.off("rename", onVaultChange);
		};
	}, [plugin]);

	// Opening a chat tab can change the available note selection.
	useEffect(() => {
		const handleLeafChange = () => {
			setHasSelection(!!plugin.getLastSelection());
		};

		plugin.settingsEmitter.on("chat-activated", handleLeafChange);
		return () => {
			plugin.settingsEmitter.off("chat-activated", handleLeafChange);
		};
	}, [plugin]);

	// Handle iOS keyboard visibility using focus events
	const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
	const [isDecryptInputFocused, setIsDecryptInputFocused] = useState(false);
	useEffect(() => {
		if (!Platform.isMobile) return;

		const handleFocusIn = (e: FocusEvent) => {
			const target = e.target as HTMLElement;
			// Track focus on textarea within our chat input area
			if (target.tagName === "TEXTAREA" && target.closest(".llm-hub-input-container")) {
				setIsKeyboardVisible(true);
				setIsDecryptInputFocused(false);
			}
			// Track focus on decrypt form password input
			if (target.tagName === "INPUT" && target.closest(".llm-hub-decrypt-form")) {
				setIsKeyboardVisible(true);
				setIsDecryptInputFocused(true);
			}
		};

		const handleFocusOut = (e: FocusEvent) => {
			const target = e.target as HTMLElement;
			// Track focusout from textarea within our chat input area
			if (target.tagName === "TEXTAREA" && target.closest(".llm-hub-input-container")) {
				// Small delay to avoid flickering
				window.setTimeout(() => {
					const active = document.activeElement as HTMLElement | null;
					const isStillInInput = active?.tagName === "TEXTAREA" && active?.closest(".llm-hub-input-container");
					const isInDecryptForm = active?.tagName === "INPUT" && active?.closest(".llm-hub-decrypt-form");
					if (!isStillInInput && !isInDecryptForm) {
						setIsKeyboardVisible(false);
					}
				}, 100);
			}
			// Track focusout from decrypt form password input
			if (target.tagName === "INPUT" && target.closest(".llm-hub-decrypt-form")) {
				window.setTimeout(() => {
					const active = document.activeElement as HTMLElement | null;
					const isStillInDecrypt = active?.tagName === "INPUT" && active?.closest(".llm-hub-decrypt-form");
					const isInChatInput = active?.tagName === "TEXTAREA" && active?.closest(".llm-hub-input-container");
					if (!isStillInDecrypt && !isInChatInput) {
						setIsKeyboardVisible(false);
						setIsDecryptInputFocused(false);
					} else if (isInChatInput) {
						setIsDecryptInputFocused(false);
					}
				}, 100);
			}
		};

		// A popped-out chat has its own document; `document` is the main window's,
		// so these never fired there and the keyboard tracking stayed stuck.
		activeDocument.addEventListener("focusin", handleFocusIn);
		activeDocument.addEventListener("focusout", handleFocusOut);

		return () => {
			activeDocument.removeEventListener("focusin", handleFocusIn);
			activeDocument.removeEventListener("focusout", handleFocusOut);
		};
	}, []);

	// Listen for workspace state changes
	useEffect(() => {
		const handleWorkspaceStateLoaded = () => {
			setRagSettingNames(plugin.getRagSettingNames());
			setSelectedRagSetting(plugin.workspaceState.selectedRagSetting);
			setWebSearchEnabled(plugin.workspaceState.webSearchEnabled === true);
		};

		const handleRagSettingChanged = (name: string | null) => {
			setSelectedRagSetting(name);
		};
		const handleSearchSelectionChanged = (selection: import("src/types").SearchSelection) => {
			setSelectedRagSetting(selection.ragSetting);
			setWebSearchEnabled(selection.webSearch);
		};

		plugin.settingsEmitter.on("workspace-state-loaded", handleWorkspaceStateLoaded);
		plugin.settingsEmitter.on("rag-setting-changed", handleRagSettingChanged);
		plugin.settingsEmitter.on("search-selection-changed", handleSearchSelectionChanged);

		return () => {
			plugin.settingsEmitter.off("workspace-state-loaded", handleWorkspaceStateLoaded);
			plugin.settingsEmitter.off("rag-setting-changed", handleRagSettingChanged);
			plugin.settingsEmitter.off("search-selection-changed", handleSearchSelectionChanged);
		};
	}, [plugin]);

	useEffect(() => {
		const handleSettingsUpdated = () => {
			const nextCliConfig = plugin.settings.cliConfig || DEFAULT_CLI_CONFIG;
			const codexConfigChanged =
				codexRuntimeConfigRef.current.model !== nextCliConfig.codexCliModel ||
				codexRuntimeConfigRef.current.path !== nextCliConfig.codexCliPath ||
				codexRuntimeConfigRef.current.reasoningEffort !== nextCliConfig.codexCliReasoningEffort;
			codexRuntimeConfigRef.current = {
				model: nextCliConfig.codexCliModel,
				path: nextCliConfig.codexCliPath,
				reasoningEffort: nextCliConfig.codexCliReasoningEffort,
			};
			setCurrentModel(plugin.getSelectedModel());
			setCliConfig(nextCliConfig);
			// A Codex thread keeps the model it was created with. Do not resume an
			// existing thread after changing the configured model or executable.
			if (codexConfigChanged) {
				setCliSession((session) => session?.provider === "codex-cli" ? null : session);
			}
			// Terminate persistent CLI session when settings change (model may have changed)
			if (persistentCliRef.current) {
				persistentCliRef.current.terminate();
				persistentCliRef.current = null;
			}
			// Sync MCP servers from settings
			setMcpServers([...plugin.settings.mcpServers]);
			setVoiceChatSettings({ ...plugin.settings.voiceChat });
		};
		plugin.settingsEmitter.on("settings-updated", handleSettingsUpdated);
		return () => {
			plugin.settingsEmitter.off("settings-updated", handleSettingsUpdated);
		};
	}, [plugin, selectedRagSetting]);

	// Model validation is now handled by getSelectedModel() in WorkspaceStateManager

	// Handle pending edit feedback (send after state update to avoid closure issues)
	useEffect(() => {
		if (pendingEditFeedback && !isLoading) {
			const { filePath, request } = pendingEditFeedback;
			setPendingEditFeedback(null);

			// Build simple feedback message (chat already shows the original request and AI's proposal)
			const feedbackMessage = request.trim()
				? `${t("message.editFeedbackHeader", { filePath })}\n\n${t("message.editFeedbackUserRequest")}\n\n${request}`
				: `${t("message.editFeedbackHeader", { filePath })}\n\n${t("message.editFeedbackRetry")}`;

			void sendMessage(feedbackMessage);
		}
	}, [pendingEditFeedback, isLoading]);

	const handleSearchSelectionChange = (
		selection: import("src/types").SearchSelection,
		persist = true,
		model = currentModel,
	) => {
		const effectiveSelection = getSearchSelectionForModel(selection, model);
		setSelectedRagSetting(effectiveSelection.ragSetting);
		setWebSearchEnabled(effectiveSelection.webSearch);
		if (persist) void plugin.selectSearchSelection(effectiveSelection);
		// Gemma 4: RAG or Web Search selected → disable function calling tools
		if (isGemma4(model) && (effectiveSelection.ragSetting || effectiveSelection.webSearch)) {
			setVaultToolMode("none");
			setVaultToolNoneReason("manual");
			setMcpServers(servers => servers.map(s => ({ ...s, enabled: false })));
		}
	};

	// Handle vault tool mode change from UI
	const handleVaultToolModeChange = (mode: VaultToolMode) => {
		desiredVaultToolModeRef.current = mode;

		setVaultToolMode(mode);
		setVaultToolNoneReason(mode === "none" ? "manual" : null);

		// Gemma 4: vault tools enabled → clear RAG/Web Search
		if (
			isGemma4(currentModel)
			&& mode !== "none"
			&& (selectedRagSetting || webSearchEnabled)
		) {
			handleSearchSelectionChange({
				ragSetting: null,
				webSearch: false,
			});
		}
	};

	// Handle per-server MCP toggle from UI
	const handleMcpServerToggle = (serverName: string, enabled: boolean) => {
		setMcpServers(servers => {
			const updated = servers.map(s => s.name === serverName ? { ...s, enabled } : s);
			plugin.settings.mcpServers = updated;
			void plugin.saveSettings();
			// Gemma 4: MCP server enabled → clear RAG/Web Search
			if (isGemma4(currentModel) && enabled && (selectedRagSetting || webSearchEnabled)) {
				handleSearchSelectionChange({ ragSetting: null, webSearch: false });
			}
			return updated;
		});
	};

	// Handle model change from UI
	const handleModelChange = (model: ModelType) => {
		setCurrentModel(model);
		const imageSearchSelection = isImageGenerationModel(model) && selectedRagSetting
			? getSearchSelectionForModel(
				{ ragSetting: selectedRagSetting, webSearch: webSearchEnabled },
				model,
			)
			: null;
		if (imageSearchSelection) {
			handleSearchSelectionChange(imageSearchSelection, false, model);
			// Serialize both workspace-state writes so an older model-only snapshot
			// cannot restore the RAG selection after it has been cleared.
			void plugin.selectModel(model)
				.then(() => plugin.selectSearchSelection(imageSearchSelection));
		} else {
			void plugin.selectModel(model);
		}

		// Terminate persistent CLI session when switching away from CLI model
		if (persistentCliRef.current) {
			persistentCliRef.current.terminate();
			persistentCliRef.current = null;
		}

		// Local LLMs with tools-capable framework + model behave like API
		// providers for vault tool / MCP availability — not like CLIs.
		const newLocalLlmConfig = isLocalLlmModel(model) ? getLocalLlmConfig(model, plugin.settings) : null;
		const isNewLocalLlmToolsCapable = !!(newLocalLlmConfig
			&& isLocalLlmToolsEnabled(newLocalLlmConfig, newLocalLlmConfig.model));
		const isNewModelVaultRestrictedCli = model === "antigravity-cli" || model === "claude-cli"
			|| (isLocalLlmModel(model) && !isNewLocalLlmToolsCapable);
		// Auto-adjust search setting and vault tool mode for CLI mode and special models
		// Resolve the effective Vault mode without destroying the user's desired
		// safety preference. A restricted provider temporarily exposes Off, then
		// restores the desired mode when returning to a capable provider.
		const gemmaSearchConflict =
			isGemma4(model)
			&& Boolean(selectedRagSetting || webSearchEnabled);

		const nextVaultPolicy = resolveVaultToolModePolicy({
			desiredMode: desiredVaultToolModeRef.current,
			restrictedByModel: isNewModelVaultRestrictedCli,
			gemmaSearchConflict,
		});

		setVaultToolMode(nextVaultPolicy.effectiveMode);
		setVaultToolNoneReason(nextVaultPolicy.noneReason);

		// MCP availability keeps the upstream capability rules.
		// Codex uses the plugin's dedicated Vault MCP bridge rather than the ordinary
		// configured MCP-server selection.
		if (
			isNewModelVaultRestrictedCli
			|| model === "codex-cli"
			|| gemmaSearchConflict
		) {
			setMcpServers((servers) =>
				servers.map((server) => ({
					...server,
					enabled: false,
				})),
			);
		}
	};

	const resetVaultSafetyForChatContext = () => {
		desiredVaultToolModeRef.current =
			DEFAULT_DESIRED_VAULT_TOOL_MODE;

		const nextPolicy = resolveVaultToolModePolicy({
			desiredMode: DEFAULT_DESIRED_VAULT_TOOL_MODE,
			restrictedByModel: isVaultToolRestrictedCliMode,
			gemmaSearchConflict:
				isGemma4(currentModel)
				&& Boolean(selectedRagSetting || webSearchEnabled),
		});

		setVaultToolMode(nextPolicy.effectiveMode);
		setVaultToolNoneReason(nextPolicy.noneReason);
	};


	const handleCodexConfigChange = (model: string | undefined, reasoningEffort: import("src/types").CodexReasoningEffort) => {
		const nextCliConfig = {
			...plugin.settings.cliConfig,
			codexCliModel: model,
			codexCliReasoningEffort: reasoningEffort,
		};
		plugin.settings.cliConfig = nextCliConfig;
		setCliConfig(nextCliConfig);
		codexRuntimeConfigRef.current = {
			model,
			path: nextCliConfig.codexCliPath,
			reasoningEffort,
		};
		persistentCliRef.current?.terminate();
		persistentCliRef.current = null;
		setCliSession((session) => session?.provider === "codex-cli" ? null : session);
		void plugin.saveSettings();
	};

	// Both resolvers live in the shared library; the host only supplies its selection
	// sources, PDF extraction and vault-tool scope.
	const commandVariableSources = (): CommandVariableSources => ({
		takeExternalSelection: () => {
			const pending = pendingExternalSelectionRef.current;
			pendingExternalSelectionRef.current = null;
			return pending;
		},
		getLastSelection: () => plugin.getLastSelection(),
		getSelectionLocation: () => plugin.getSelectionLocation(),
	});

	const resolveMessageVariables = async (content: string): Promise<string> => {
		const literals = [...new Set(pendingReadingLiteralsRef.current)].sort((a, b) => b.length - a.length);
		pendingReadingLiteralsRef.current = [];
		const readingQuestion = groundedMode || literals.length > 0 || [t("reading.currentPrompt"), t("reading.knowledgePrompt")]
			.some(label => content.includes(`${label}: “`));
		const protectedParts: Array<{ marker: string; literal: string }> = [];
		let protectedContent = content;
		for (const [index, literal] of literals.entries()) {
			if (!protectedContent.includes(literal)) continue;
			let marker = `\uE000LLMHUB_READING_${index}\uE001`;
			while (protectedContent.includes(marker)) marker += "_";
			protectedContent = protectedContent.split(literal).join(marker);
			protectedParts.push({ marker, literal });
		}
		// A reader may edit the quoted passage before sending it. Keep quoted
		// lines literal too, so an edited {content} cannot expand the active note.
		if (readingQuestion) protectedContent = protectedContent.replace(/^>[^\r\n]*$/gm, literal => {
			let marker = `\uE000LLMHUB_READING_LINE_${protectedParts.length}\uE001`;
			while (protectedContent.includes(marker)) marker += "_";
			protectedParts.push({ marker, literal });
			return marker;
		});
		let resolved = await resolveMessageVariablesShared(plugin.app, protectedContent, {
			...commandVariableSources(),
			inlineFileMentions: vaultToolMode === "none" || isVaultToolRestrictedCliMode,
			vaultToolAllowedFolders: plugin.settings.cloudVaultToolAllowedFolders,
			maxNoteChars: plugin.settings.maxNoteChars,
			readMentionText: (file) => file.extension.toLowerCase() === "pdf"
				? extractPdfText(plugin.app, file.path)
				: plugin.app.vault.read(file),
		});
		for (const { marker, literal } of protectedParts) resolved = resolved.split(marker).join(literal);
		return resolved;
	};

	// Handle slash command selection
	const handleSlashCommand = (command: SlashCommand): string => {
		// Track the current slash command for auto-apply logic
		currentSlashCommandRef.current = command;

		// Save current settings before applying overrides (restored after message processing)
		preSlashSettingsRef.current = {
			model: currentModel,
			ragSetting: selectedRagSetting,
			webSearch: webSearchEnabled,
			vaultToolMode,
			vaultToolNoneReason,
			mcpServers: mcpServers.map(s => ({ ...s })),
		};

		// Optionally change model
		const nextModel = command.model ? command.model : currentModel;
		if (nextModel !== currentModel) {
			setCurrentModel(nextModel);
			if (isImageGenerationModel(nextModel) && selectedRagSetting && command.searchSelection == null) {
				handleSearchSelectionChange(
					{ ragSetting: null, webSearch: webSearchEnabled },
					false,
					nextModel,
				);
			}
			// Terminate persistent CLI session when model changes via slash command
			if (persistentCliRef.current) {
				persistentCliRef.current.terminate();
				persistentCliRef.current = null;
			}
		}

		// Slash overrides are temporary and must not overwrite workspace preferences.
		if (command.searchSelection !== null && command.searchSelection !== undefined) {
			handleSearchSelectionChange(command.searchSelection, false, nextModel);
		}

		// Optionally change vault tool mode (null = keep current)
		// Slash commands are input helpers, so vaultToolMode="none" uses "manual" reason (MCP unchanged)
		if (command.vaultToolMode !== null && command.vaultToolMode !== undefined) {
			setVaultToolMode(command.vaultToolMode);
			setVaultToolNoneReason(command.vaultToolMode === "none" ? "manual" : null);
		}

		// A command may add one skill to the current chat selection.
		if (command.skillPath) {
			setActiveSkillPaths(paths => paths.includes(command.skillPath!) ? paths : [...paths, command.skillPath!]);
		}

		// Optionally change MCP server enabled state (null = keep current)
		if (command.enabledMcpServers !== null && command.enabledMcpServers !== undefined) {
			const enabledSet = new Set(command.enabledMcpServers);
			setMcpServers(servers => servers.map(s => ({
				...s,
				enabled: enabledSet.has(s.name)
			})));
		}

		// Return template as-is, variables will be resolved on send
		return command.promptTemplate;
	};

	// Start new chat (works even while a stream is running – the old stream
	// continues in the background and saves its result to history when done).
	const startNewChat = () => {
		leaveCurrentChat();
		startNewDraft();
		setGroundedMode(null);
		resetVaultSafetyForChatContext();

		setMessages([]);
		setCurrentChatId(null);
		// Keep the user's currently selected skills when starting a new chat.
		// Skills are a session-level selection, not per-chat state.
		setCliSession(null);
		setShowHistory(false);
		// Cleanup persistent CLI session
		if (persistentCliRef.current) {
			persistentCliRef.current.terminate();
			persistentCliRef.current = null;
		}
	};

	// Decrypt and load encrypted chat
	const decryptAndLoadChat = async (chatId: string, password: string) => {
		leaveCurrentChat();
		try {
			const parsed = await decryptChat(chatId, password);

			resetVaultSafetyForChatContext();
			setGroundedMode(null);

			setMessages(parsed.messages.map(restoreChatDisplayData));
			setCurrentChatId(chatId);
			selectComposerHistory(chatId);
			setCliSession(parsed.cliSession || null);
			// Terminate persistent CLI session when loading a different chat
			if (persistentCliRef.current) {
				persistentCliRef.current.terminate();
				persistentCliRef.current = null;
			}
			setStreamingContent("");
			setStreamingThinking("");
			setDecryptingChatId(null);
			setDecryptPassword("");
			setShowHistory(false);
			new Notice(t("chat.decrypted"));
		} catch (error) {
			console.error("Decryption failed:", formatError(error));
			new Notice(t("chat.decryptFailed"));
		}
	};

	// Load a chat from history
	const loadChat = (history: ChatHistory) => {
		leaveCurrentChat();
		if (history.isEncrypted) {
			// If password is cached, try to decrypt automatically
			const cachedPassword = cryptoCache.getPassword();
			if (cachedPassword) {
				void decryptAndLoadChat(history.id, cachedPassword);
				return;
			}
			// Show decryption UI
			setDecryptingChatId(history.id);
			setDecryptPassword("");
			return;
		}
		resetVaultSafetyForChatContext();
		setGroundedMode(null);
		setMessages(history.messages.map(restoreChatDisplayData));
		setCurrentChatId(history.id);
		selectComposerHistory(history.id);
		setCliSession(history.cliSession || null);  // Restore CLI session
		// Terminate persistent CLI session when switching chats (will be recreated on next message)
		if (persistentCliRef.current) {
			persistentCliRef.current.terminate();
			persistentCliRef.current = null;
		}
		setStreamingContent("");
		setStreamingThinking("");
		setShowHistory(false);
	};

	// Delete a chat from history
	const deleteChat = async (chatId: string, e: MouseEvent) => {
		e.stopPropagation();

		await deleteChatFromHistory(chatId);

		if (currentChatId === chatId) {
			startNewChat();
		}
		new Notice(t("chat.chatDeleted"));
	};

	// Send message via CLI provider
	/**
	 * The view state every send path hands to the shared turn. A function, not a
	 * value: `messages` has to be the history as it stands when the send begins.
	 */
	const chatTurnUi = (grounded = false): ChatTurnUi => ({
		messages, setMessages, setIsLoading, setStreamingContent, setStreamingThinking,
		abortControllerRef, createStreamSession,
		describeError: grounded ? () => t("chat.grounded.modelFailed") : buildErrorMessage,
	});

	const runGroundedTurn = async (
		turn: ChatTurn,
		query: string,
		send: (prompt: GroundedPrompt) => Promise<ChatTurnOutcome>,
		accept?: () => void,
		destination?: { endpoint: string; model: string },
	): Promise<ChatTurnOutcome> => {
		const controller = turn.abortController;
		const sessionId = turn.session.mySessionId;
		groundedRetrievalRef.current = controller;
		if (turn.isActive()) setGroundedSearchSession(sessionId);
		try {
			if (turn.isActive()) setGroundedProblem(null);
			const result = await runGroundedRequest({
				app: plugin.app, settingName: selectedRagSetting ?? "", query,
				setting: selectedRagSetting ? plugin.getRagSearchSetting(selectedRagSetting) : null,
				fallbackApiKey: '', settings: plugin.settings, signal: controller.signal,
				authorize: (purpose, endpoint, name, model) => plugin.confirmKnowledgeDestination(purpose, endpoint, name, model),
			}, async prompt => {
				if (destination && selectedRagSetting && !await plugin.confirmKnowledgeDestination('answer', destination.endpoint, selectedRagSetting, destination.model)) {
					return { message: { role: 'assistant' as const, content: t('chat.grounded.sendPaused'), timestamp: Date.now() }, status: { value: 0, comment: 'sending declined' } };
				}
				if (controller.signal.aborted) return { message: { role: 'assistant' as const, content: t('chat.grounded.cancelled'), timestamp: Date.now() }, status: { value: 0, comment: 'cancelled' } };
				if (groundedRetrievalRef.current === controller) groundedRetrievalRef.current = null;
				if (turn.isActive()) setGroundedSearchSession(null);
				accept?.();
				return send(prompt);
			});
			if (result.status === "answered") return result.value;
			const key = result.status === "empty" ? "chat.grounded.empty"
				: result.status === "cancelled" ? "chat.grounded.cancelled"
				: result.status === "error" ? "chat.grounded.failed"
				: result.status === "not-ready" && result.reason === "vector-space-unverified" ? "chat.grounded.vectorSpaceUnverified"
				: result.status === "not-ready" && result.reason === "vector-space-changed" ? "chat.grounded.vectorSpaceChanged"
				: result.status === "not-ready" && result.reason === "no-readable-text" ? "chat.grounded.unreadable" : "chat.grounded.notReady";
			if (result.status !== 'cancelled' && turn.isActive()) setGroundedProblem({ session: sessionId, message: t(key) });
			return { message: { role: "assistant", content: t(key), timestamp: Date.now() },
				status: { value: 0, comment: result.status } };
		} finally {
			if (groundedRetrievalRef.current === controller) groundedRetrievalRef.current = null;
			if (turn.isActive()) setGroundedSearchSession(null);
		}
	};

	/** What the CLI turn works out before it starts. */
	interface CliTurnContext {
		isClaudeCli: boolean;
		isCodexCli: boolean;
		effectiveSkillPaths: string[];
		resolvedContent: string;
	}

	/** What the Gemini turn works out before it starts. */
	interface GeminiTurnContext {
		client: InstanceType<Awaited<typeof import("src/core/gemini")>["GeminiClient"]>;
		allowedModel: ModelType;
		resolvedContent: string;
	}

	/** What the local LLM turn works out before it starts. */
	interface LocalLlmTurnContext {
		llmConfig: NonNullable<ReturnType<typeof getLocalLlmConfig>>;
		effectiveSkillPaths: string[];
		resolvedContent: string;
		imageAttachments: Attachment[];
	}

	/** What the API provider turn works out before it starts. */
	interface ApiProviderTurnContext {
		providerConfig: ApiProviderConfig;
		resolvedModelName: string;
		resolvedContent: string;
	}

	const sendMessageViaCli = async (content: string, attachments?: Attachment[], skillPath?: string) => {
		await runChatTurn<CliTurnContext>(chatTurnUi(), {
			prepare: async () => {

				const isClaudeCli = currentModel === "claude-cli";
				const isCodexCli = currentModel === "codex-cli";

				// Activate skill if invoked via slash command
				const effectiveSkillPaths = getEffectiveSkillPathsForSend(skillPath);
				if (skillPath && !activeSkillPaths.includes(skillPath)) {
					setActiveSkillPaths(prev => prev.includes(skillPath) ? prev : [...prev, skillPath]);
				}

				// Resolve variables in the content
				const resolvedContent = await resolveMessageVariables(content);

				// When skill is invoked without message, use skill name as trigger
				let displayContent = resolvedContent.trim();
				if (!displayContent && skillPath) {
					const skillMeta = availableSkills.find(s => s.folderPath === skillPath);
					displayContent = skillMeta ? `/${skillMeta.name}` : "/skill";
				}

				// Add user message
				const userMessage: Message = {
					role: "user",
					content: displayContent || (attachments ? `[${attachments.length} file(s) attached]` : ""),
					timestamp: Date.now(),
					attachments,
				};

				return {
					userMessage,
					trace: {
						name: "chat-message",
						sessionId: currentChatId ?? undefined,
						input: resolvedContent,
						metadata: {
							model: currentModel,
							isCli: true,
							pluginVersion: plugin.manifest.version,
						},
					},
					context: { isClaudeCli, isCodexCli, effectiveSkillPaths, resolvedContent },
				};
			},

			run: async (turn, { isClaudeCli, isCodexCli, effectiveSkillPaths, resolvedContent }) => {
				const { isActive, abortController, userMessage } = turn;
				const recordToolActivity = beginToolActivity(turn);
				let codexMutationTracking: ReturnType<typeof createConfirmingToolExecutor> | null = null;
				let fullContent = "";
				let localRagSources: string[] = [];
        let ragSearchRunner: RagSearchRunner | null = null;

				try {
					const allMessages = limitConversationHistory([...messages, userMessage], maxPreviousMessages);
					let codexMcpUrl: string | undefined;

					// Build system prompt for CLI. Codex's direct filesystem access stays
					// read-only; Vault writes go through the plugin MCP bridge.
					const cliName = isClaudeCli ? "Claude CLI" : isCodexCli ? "Codex CLI" : "Antigravity CLI";
					let systemPrompt = "You are a helpful AI assistant integrated with Obsidian.";
					if (isCodexCli) {
						systemPrompt += "\n\nYou can read Vault files directly, but the filesystem is read-only. Never attempt to modify, delete, rename, or create Vault files directly.";
						if (vaultToolMode !== "none") {
							systemPrompt += " The llm_hub_vault MCP also provides Obsidian-aware read tools. When the user refers to the open, active, or current file without naming it, call read_note with activeNote=true (or get_active_note_info when only its metadata is needed).";
							if (vaultToolMode === "noSearch") {
								systemPrompt += " Vault search and note-listing tools are disabled for this chat.";
							}
							systemPrompt += vaultToolMode === "readOnly"
								? "\n\nVault tools are read-only. Answer in chat; do not create or change Vault files."
								: "\n\nFor a new Vault file, use the llm_hub_vault MCP create_note tool; it creates the file immediately, including text-based formats such as .canvas and .base. For changes to existing files, use propose_edit, bulk_propose_edit, propose_delete, bulk_propose_delete, rename_note, or bulk_propose_rename. Existing-file mutations show a diff or confirmation and apply only after approval. Do not claim a change was applied unless the tool result says it was applied.";
						}
					} else {
						systemPrompt += `\n\nNote: You are running in ${cliName} mode with limited capabilities. You can read and search vault files, but cannot modify them.`;
						systemPrompt += "\n\nIMPORTANT: File writing operations may fail in this environment. Always output results directly to standard output instead of attempting to write to files.";
					}
					if (vaultToolMode !== "none" && !isVaultToolRestrictedCliMode) {
						systemPrompt += FILE_MENTION_TOOL_PROMPT;
					}
					systemPrompt += `\n\nVault location: ${(plugin.app.vault.adapter as unknown as { basePath?: string }).basePath || "."}`;

					if (plugin.settings.systemPrompt) {
						systemPrompt += `\n\nAdditional instructions: ${plugin.settings.systemPrompt}`;
					}

					// Inject active agent skills into system prompt
					let cliLoadedSkills: LoadedSkill[] = [];
					if (effectiveSkillPaths.length > 0) {
						const activeMetadata = availableSkills.filter(s => effectiveSkillPaths.includes(s.folderPath));
						if (activeMetadata.length > 0) {
							cliLoadedSkills = activeMetadata.map(m => loadSkill(plugin.app, m));
							const skillPrompt = buildSkillSystemPrompt(cliLoadedSkills, { cliMode: !isCodexCli });
							if (skillPrompt) {
								systemPrompt += skillPrompt;
							}
						}
					}

					// The bridge is wired before the automatic RAG search runs, so the runner
					// has to exist by now; its budget is charged when that search completes.
					
					let ragSearchToolOffered = false;
					const cliRagSetting = selectedRagSetting ? plugin.getRagSearchSetting(selectedRagSetting) : null;
					if (selectedRagSetting && cliRagSetting) {
						ragSearchRunner = createRagSearchRunner(
							(query, topK) => searchLocalRagResults(
								selectedRagSetting, query, cliRagSetting, getGeminiApiKey(plugin.settings),
								plugin.settings.proxyUrl, plugin.settings.proxyBypass, topK, plugin.settings,
							),
							(filePaths) => { for (const path of filePaths) if (!localRagSources.includes(path)) localRagSources.push(path); },
							{ topK: cliRagSetting.topK, settingName: selectedRagSetting, query: resolvedContent },
						);
					}

					if (isCodexCli) {
						const codexTools = buildVaultToolPayload(
							vaultToolMode,
						).filter((tool) =>
							CODEX_VAULT_TOOLS.has(tool.name)
						);
						const skillWorkflowMap = collectSkillWorkflows(cliLoadedSkills);
						const skillScriptMap = collectSkillScripts(cliLoadedSkills);
						if (cliLoadedSkills.some(s => !s.instructions)) codexTools.push(readSkillTool);
						if (activeOkfBundleIds.length > 0) codexTools.push(READ_OKF_DOCUMENT_TOOL);
						if (skillWorkflowMap.size > 0) codexTools.push(skillWorkflowTool);
						if (skillScriptMap.size > 0) codexTools.push(skillScriptTool);
						// RAG has its own toggle, so it is offered regardless of vaultToolMode.
						if (ragSearchRunner) {
							codexTools.push(RAG_SEARCH_TOOL);
							ragSearchToolOffered = true;
						}

						const vaultExecutor = createToolExecutor(plugin.app);
						const codexToolExecutor = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
							const blockedVaultTool = getVaultToolExecutionBlock(name, vaultToolMode);
							if (blockedVaultTool) return blockedVaultTool;

							if (name === RAG_SEARCH_TOOL_NAME && ragSearchRunner) return ragSearchRunner.run(args);
							if (name === READ_SKILL_TOOL_NAME) return executeReadSkillTool(plugin.app, cliLoadedSkills, args.skillName as string);
							if (name === READ_OKF_DOCUMENT_TOOL_NAME) return executeReadOkfDocumentTool(plugin.app, getOkfRoot(), activeOkfBundleIds, args.bundleId as string, args.path as string, args.startLine as number | undefined, args.endLine as number | undefined);
							if (name === "run_skill_workflow" && skillWorkflowMap.size > 0) {
								return runSkillWorkflow(
									plugin.app,
									args.workflowId as string,
									args.variables as string | undefined,
									skillWorkflowMap,
									// A CLI provider already runs with the user's own permissions.
									{ vaultToolAllowedFolders: undefined },
								);
							}
							if (name === "run_skill_script" && skillScriptMap.size > 0) {
								return executeSkillScript(
									plugin,
									args.scriptId as string,
									args.args as string | undefined,
									skillScriptMap,
								);
							}
							return vaultExecutor(name, args);
						};
						codexMutationTracking = createConfirmingToolExecutor(
							codexToolExecutor,
							plugin.app,
							autoApplyEdits,
							() => abortController.abort(),
						);
						if (!codexVaultMcpBridgeRef.current) {
							codexVaultMcpBridgeRef.current = new CodexVaultMcpBridge(
								codexTools,
								codexMutationTracking.executeToolCall,
							);
						} else {
							codexVaultMcpBridgeRef.current.setTools(codexTools);
							codexVaultMcpBridgeRef.current.setExecutor(codexMutationTracking.executeToolCall);
						}
						codexVaultMcpBridgeRef.current.setToolActivityObserver(recordToolActivity);
						codexMcpUrl = await codexVaultMcpBridgeRef.current.start();
					}

					systemPrompt = await appendOkfSystemPrompt(systemPrompt);

					// Local RAG: search and inject context into system prompt
					if (AUTOMATIC_RAG_RETRIEVAL && selectedRagSetting) {
						const ragSettingObj = plugin.getRagSearchSetting(selectedRagSetting);
						if (ragSettingObj) {
							try {
								const localRag = await searchLocalRag(
									selectedRagSetting, resolvedContent,
									ragSettingObj, getGeminiApiKey(plugin.settings),
									plugin.settings.proxyUrl, plugin.settings.proxyBypass, plugin.settings
								);
								// A search that threw never reached the index, so it must not consume
								// the turn budget the model is told it has.
								if (localRag.sources.length > 0) {
									systemPrompt += localRag.context;
									localRagSources = localRag.sources;
									// Attach multimodal RAG files so the LLM can see actual content
									if (localRag.mediaReferences.length > 0) {
										const ragAttachments = (await loadRagMediaAttachments(plugin.app, localRag.mediaReferences))
											.filter(attachment => attachment.type !== "pdf");
										// A dropped PDF leaves only its label in the indexed chunk text,
										// so its pages go into the prompt as extracted text instead.
										systemPrompt += await buildRagPdfTextContext(plugin.app, localRag.mediaReferences);
										if (ragAttachments.length > 0) {
											const existing = userMessage.attachments || [];
											(userMessage as { attachments?: import("src/types").Attachment[] }).attachments = [...existing, ...ragAttachments];
										}
									}
								}
							} catch (e) {
								console.error("Local RAG search failed:", formatError(e));
							}
						}
					}

					if (vaultToolMode === "noSearch") {
						systemPrompt += buildNoDiscoverySystemPrompt({
							ragRequested: Boolean(ragSearchRunner),
							hasRagContext: localRagSources.length > 0,
						});
					}
					if (plugin.settings.voiceChat.autoReadAloud) systemPrompt += buildReadAloudSystemPrompt();

					if (ragSearchToolOffered && ragSearchRunner) {
						systemPrompt += ragSearchRunner.systemPrompt;
					}

					let stopped = false;
					let receivedSessionId: string | null = null;

					// Get vault base path for working directory
					const vaultBasePath = (plugin.app.vault.adapter as unknown as { basePath?: string }).basePath || ".";

					// Determine current provider name
					const currentProvider: ChatProvider = isClaudeCli ? "claude-cli" : isCodexCli ? "codex-cli" : "antigravity-cli";

					// Get or create persistent CLI session
					const existingSession = persistentCliRef.current;
					let session: PersistentCliSession;
					if (existingSession && existingSession.isAlive && existingSession.provider === currentProvider) {
						// Reuse existing persistent session
						session = existingSession;
					} else {
						// Terminate old session if provider changed or session died
						existingSession?.terminate();
						// Create new persistent session, passing stored session ID for CLI resume.
						const storedSessionId = cliSession?.provider === currentProvider
							? cliSession.sessionId
							: undefined;
						const customCliPath = currentProvider === "antigravity-cli"
							? cliConfig.geminiCliPath
							: currentProvider === "claude-cli"
								? cliConfig.claudeCliPath
								: cliConfig.codexCliPath;
						session = new PersistentCliSession(
							currentProvider, vaultBasePath,
							customCliPath, storedSessionId,
							cliConfig.codexCliModel,
							codexMcpUrl,
							cliConfig.codexCliReasoningEffort
						);
						session.start();
						persistentCliRef.current = session;
					}

					// === Agent loop ===
					// Each iteration: stream CLI → detect skill markers → execute → feed
					// results back as a follow-up user message → loop until no markers
					// or MAX_MARKER_AGENT_ITERATIONS reached. Uses the persistent /
					// resume session so the CLI preserves context across iterations.
					let processedContent = "";
					let conversationHistory: Message[] = allMessages;
					let iterationUserContent = allMessages[allMessages.length - 1]?.role === "user"
						? allMessages[allMessages.length - 1].content
						: "";

					for (let iteration = 0; iteration < MAX_MARKER_AGENT_ITERATIONS; iteration++) {
						let iterationContent = "";
						const streamSep = fullContent ? "\n\n" : "";

						for await (const chunk of session.sendMessage(
							iterationUserContent,
							conversationHistory,
							systemPrompt,
							abortController.signal
						)) {
							if (abortController.signal.aborted) {
								stopped = true;
								break;
							}

							switch (chunk.type) {
								case "text":
									iterationContent += chunk.content || "";
									if (isActive()) setStreamingContent(fullContent + streamSep + iterationContent);
									break;

								case "session_id":
									if (chunk.sessionId) {
										receivedSessionId = chunk.sessionId;
									}
									break;

								case "error":
									throw new Error(chunk.error || "Unknown error");

								case "done":
									break;
							}
						}

						if (stopped) break;

						// Execute any skill markers in this iteration's output
						const markerResult = !isCodexCli && cliLoadedSkills.length > 0
							? await processSkillMarkers(plugin, iterationContent, cliLoadedSkills, abortController.signal)
							: { processedContent: iterationContent, followUpMessage: undefined, aborted: false };

						// Append this iteration's processed content to accumulated display
						fullContent += (fullContent && markerResult.processedContent ? "\n\n" : "") + markerResult.processedContent;
						processedContent = fullContent;
						if (isActive()) setStreamingContent(fullContent);

						// User cancelled mid-marker execution — stop the agent loop.
						if (markerResult.aborted) { stopped = true; break; }

						// If no markers were executed, the turn is complete
						if (!markerResult.followUpMessage) break;

						// Feed results back to the CLI on the next iteration
						conversationHistory = [
							...conversationHistory,
								{ role: "assistant", content: iterationContent, timestamp: Date.now() },
								{ role: "user", content: markerResult.followUpMessage, timestamp: Date.now() },
						];
						iterationUserContent = markerResult.followUpMessage;
					}

					if (stopped && fullContent) {
						fullContent += `\n\n${t("chat.generationStopped")}`;
						processedContent = fullContent;
					}

					// Update session state from persistent session
					const effectiveSessionId = receivedSessionId || session.currentSessionId;
					const newSession: CliSessionInfo | null = effectiveSessionId
						? { provider: currentProvider, sessionId: effectiveSessionId }
						: (cliSession?.provider === currentProvider ? cliSession : null);

					if (isActive() && (effectiveSessionId || cliSession?.provider !== currentProvider)) {
						setCliSession(newSession);
					}

					// Add assistant message with CLI model info
					const assistantMessage: Message = {
						role: "assistant",
						content: processedContent,
						timestamp: Date.now(),
						model: currentProvider,
						modelDisplayName: isCodexCli
							? ["Codex CLI", cliConfig.codexCliModel, cliConfig.codexCliReasoningEffort || "low"].filter(Boolean).join(" · ")
							: undefined,
						...pendingStatusFields({
							edits: codexMutationTracking?.processedEdits ?? [],
							deletes: codexMutationTracking?.processedDeletes ?? [],
							renames: codexMutationTracking?.processedRenames ?? [],
						}),
						...(localRagSources.length > 0 ? { ragUsed: true, ragSources: localRagSources } : {}),
					};

					return {
						message: withSearchEvidence(assistantMessage, ragSearchRunner),
						output: processedContent,
						cliSession: newSession || undefined,
						status: {
							value: stopped ? 0.5 : 1,
							comment: stopped ? "stopped by user" : "completed",
						},
					};
				} catch (error) {
					if (abortController.signal.aborted) {
						const stoppedContent = fullContent
							? `${fullContent}\n\n${t("chat.generationStopped")}`
							: "";
						const assistantMessage: Message = {
							role: "assistant",
							content: stoppedContent,
							timestamp: Date.now(),
							model: isClaudeCli ? "claude-cli" : isCodexCli ? "codex-cli" : "antigravity-cli",
							...pendingStatusFields({
								edits: codexMutationTracking?.processedEdits ?? [],
								deletes: codexMutationTracking?.processedDeletes ?? [],
								renames: codexMutationTracking?.processedRenames ?? [],
							}),
							...(localRagSources.length > 0 ? { ragUsed: true, ragSources: localRagSources } : {}),
						};
						return {
							message: withSearchEvidence(assistantMessage, ragSearchRunner),
							output: stoppedContent,
							metadata: { status: "aborted" },
							status: { value: 0.5, comment: "stopped by user" },
						};
					}
					// Anything else is a failure: the envelope words it and saves it.
					throw error;
				}
			},
		});
	};

	// Send message via Local LLM provider
	const sendMessageViaLocalLlm = async (content: string, attachments?: Attachment[], skillPath?: string, grounded = false, accept?: () => void) => {
		// The confirming tool executor is built once the turn is running; this is
		// how the feedback it collected gets back out to the finished turn.
		let takeEditFeedback: (() => { filePath: string; request: string } | null) | null = null;
		let openCodeMcpToolExecutor: McpToolExecutor | null = null;

		await runChatTurn<LocalLlmTurnContext>(chatTurnUi(grounded), {
			prepare: async () => {

				const llmConfig = getLocalLlmConfig(currentModel, plugin.settings);
				if (!llmConfig) {
					new Notice(t("chat.localLlmNotConfigured"));
					return null;
				}

				// Activate skill if invoked via slash command
				const effectiveSkillPaths = getEffectiveSkillPathsForSend(skillPath);
				if (skillPath && !activeSkillPaths.includes(skillPath)) {
					setActiveSkillPaths(prev => prev.includes(skillPath) ? prev : [...prev, skillPath]);
				}

				// Resolve variables in the content
				const resolvedContent = await resolveMessageVariables(content);
				// Separate image attachments (sent as multimodal) from non-image (text fallback)
				const imageAttachments = attachments?.filter(a => a.type === "image") ?? [];
				const nonImageAttachments = attachments?.filter(a => a.type !== "image") ?? [];
				const localLlmContent = `${resolvedContent}${buildLocalLlmAttachmentContext(nonImageAttachments.length > 0 ? nonImageAttachments : undefined)}`.trim();

				// When skill is invoked without message, use skill name as trigger
				let displayContent = resolvedContent.trim();
				if (!displayContent && skillPath) {
					const skillMeta = availableSkills.find(s => s.folderPath === skillPath);
					displayContent = skillMeta ? `/${skillMeta.name}` : "/skill";
				}

				// Add user message
				const userMessage: Message = {
					role: "user",
					content: displayContent || (attachments ? `[${attachments.length} file(s) attached]` : ""),
					llmContent: localLlmContent || undefined,
					timestamp: Date.now(),
					attachments,
				};

				return {
					userMessage,
					trace: {
						name: "chat-message",
						sessionId: currentChatId ?? undefined,
						input: localLlmContent,
						metadata: {
							model: `local-llm:${llmConfig.id}:${llmConfig.model}`,
							isLocalLlm: true,
							pluginVersion: plugin.manifest.version,
						},
					},
					context: { llmConfig, effectiveSkillPaths, resolvedContent, imageAttachments },
				};
			},

			run: async (turn, { llmConfig, effectiveSkillPaths, resolvedContent, imageAttachments }) => {
				const { isActive, abortController, traceId: llmTraceId, userMessage } = turn;
				if (grounded) return runGroundedTurn(turn, resolvedContent, async prompt => {
					const system = [plugin.settings.systemPrompt, prompt.systemContext].filter(Boolean).join('\n\n');
					const history = limitConversationHistory([...messages, userMessage], maxPreviousMessages);
					let answer = '', thinking = '';
					for await (const chunk of localLlmChatStream(llmConfig, history, system, abortController.signal, imageAttachments)) {
						if (abortController.signal.aborted) break;
						if (chunk.type === 'error') throw new Error('Local model request failed');
						if (chunk.type === 'text') { answer += chunk.content ?? ''; if (isActive()) setStreamingContent(answer); }
						if (chunk.type === 'thinking') { thinking += chunk.content ?? ''; if (isActive()) setStreamingThinking(thinking); }
					}
					if (isActive()) setCliSession(null);
					return { message: attachGroundedEvidence({ role: 'assistant', content: answer, timestamp: Date.now(), model: currentModel,
						...(thinking ? { thinking } : {}) }, prompt.evidence), output: answer, cliSession: null,
						status: { value: abortController.signal.aborted ? 0.5 : 1, comment: abortController.signal.aborted ? 'stopped by user' : 'completed' } };
				}, accept, { endpoint: llmConfig.baseUrl, model: llmConfig.model });
				const recordToolActivity = beginToolActivity(turn);
				// Whether to try the model's tool transport at all. This is a provider/model
				// capability decision, not a Vault access decision: Vault "none" removes
				// only built-in Vault tools, while sandbox/workflow/MCP/skill/RAG tools may
				// still be available and must keep function calling enabled.
				const wantsTools = isLocalLlmToolsEnabled(llmConfig, llmConfig.model);
				const allMessages = limitConversationHistory([...messages, userMessage], maxPreviousMessages);

				// Build system prompt for local LLM. Tools-mode and marker-mode
				// have different framing — tools-mode tells the model to use
				// function calling; marker-mode tells it to use text markers and
				// warns it has no direct vault access.
				let systemPrompt = "You are a helpful AI assistant integrated with Obsidian.";
				if (wantsTools) {
					systemPrompt += `\n\nYou have access to the function-calling tools listed for this chat. Prefer calling an available tool over describing what you would do.`;
					if (vaultToolMode !== "none") {
						systemPrompt += FILE_MENTION_TOOL_PROMPT;
					} else {
						systemPrompt += `\n\nBuilt-in Vault tools are disabled for this chat. Only the non-Vault tools explicitly listed for this chat remain available.`;
					}
				} else {
					systemPrompt += `\n\nNote: You are running in Local LLM mode with limited capabilities. You do not have direct vault tool access in this mode.`;
					systemPrompt += `\n\nUse only information already present in the conversation, text attachments inlined into the prompt, and any local RAG context that may be added below.`;
					systemPrompt += `\n\nIMPORTANT: Do not claim that you can open, search, or modify vault files unless their contents are already included in the prompt.`;
				}
				systemPrompt += `\n\nVault location: ${(plugin.app.vault.adapter as unknown as { basePath?: string }).basePath || "."}`;

				if (plugin.settings.systemPrompt) {
					systemPrompt += `\n\nAdditional instructions: ${plugin.settings.systemPrompt}`;
				}

				// Inject active agent skills into system prompt
				let llmLoadedSkills: LoadedSkill[] = [];
				if (effectiveSkillPaths.length > 0) {
					const activeMetadata = availableSkills.filter(s => effectiveSkillPaths.includes(s.folderPath));
					if (activeMetadata.length > 0) {
						llmLoadedSkills = activeMetadata.map(m => loadSkill(plugin.app, m));
						const skillPrompt = buildSkillSystemPrompt(llmLoadedSkills, { cliMode: true });
						if (skillPrompt) {
							systemPrompt += skillPrompt;
						}
					}
				}

				systemPrompt = await appendOkfSystemPrompt(systemPrompt);

				// Local RAG: search and inject context into system prompt
				let localRagSources: string[] = [];
				let ragSearchRunner: RagSearchRunner | null = null;
				const ragSettingObj = selectedRagSetting ? plugin.getRagSearchSetting(selectedRagSetting) : null;
				if (selectedRagSetting && ragSettingObj) {
					ragSearchRunner = createRagSearchRunner(
						(query, topK) => searchLocalRagResults(
							selectedRagSetting, query, ragSettingObj, getGeminiApiKey(plugin.settings),
							plugin.settings.proxyUrl, plugin.settings.proxyBypass, topK, plugin.settings,
						),
						(filePaths) => { for (const p of filePaths) if (!localRagSources.includes(p)) localRagSources.push(p); },
						{ topK: ragSettingObj.topK, settingName: selectedRagSetting, query: resolvedContent },
					);
					if (AUTOMATIC_RAG_RETRIEVAL) try {
						const localRag = await searchLocalRag(
							selectedRagSetting, resolvedContent,
							ragSettingObj, getGeminiApiKey(plugin.settings),
							plugin.settings.proxyUrl, plugin.settings.proxyBypass, plugin.settings
						);
						// A search that threw never reached the index, so it must not consume
						// the turn budget the model is told it has.
						if (localRag.sources.length > 0) {
							systemPrompt += localRag.context;
							localRagSources = localRag.sources;
							// Attach multimodal RAG files so the LLM can see actual content
							if (localRag.mediaReferences.length > 0) {
								const pdfMode = resolveLocalLlmPdfInputMode(llmConfig);
								const ragAttachments = (await loadRagMediaAttachments(plugin.app, localRag.mediaReferences))
									.filter(attachment => attachment.type !== "pdf" || pdfMode === "native");
								// A dropped PDF leaves only its label in the indexed chunk text,
								// so its pages go into the prompt as extracted text instead.
								if (pdfMode !== "native") {
									systemPrompt += await buildRagPdfTextContext(plugin.app, localRag.mediaReferences);
								}
								if (ragAttachments.length > 0) {
									const existing = userMessage.attachments || [];
									(userMessage as { attachments?: import("src/types").Attachment[] }).attachments = [...existing, ...ragAttachments];
								}
							}
						}
					} catch (e) {
						console.error("Local RAG search failed:", formatError(e));
					}
				}
				if (vaultToolMode === "noSearch") {
					systemPrompt += buildNoDiscoverySystemPrompt({
						ragRequested: Boolean(ragSearchRunner),
						hasRagContext: localRagSources.length > 0,
					});
				}
				if (plugin.settings.voiceChat.autoReadAloud) systemPrompt += buildReadAloudSystemPrompt();

				let fullContent = "";
				let fullThinking = "";
				let stopped = false;
				const llmMcpApps: McpAppInfo[] = [];
				let openCodeMcpUrl: string | undefined;
				let openCodeMutationTracking: ReturnType<typeof createConfirmingToolExecutor> | null = null;
				const openCodeToolsUsed: string[] = [];
				const openCodeToolCalls: NonNullable<Message["toolCalls"]> = [];
				const openCodeToolResults: NonNullable<Message["toolResults"]> = [];
				let openCodeToolCallSequence = 0;

				// OpenCode uses its own session API, but can consume the same tool
				// bundle as the other agent paths through a dynamically registered MCP
				// server hosted by the plugin.
				if (wantsTools && llmConfig.framework === "opencode") {
					const openCodeTools =
						buildVaultToolPayload(vaultToolMode);
					if (ragSearchRunner) openCodeTools.push(RAG_SEARCH_TOOL);
					openCodeTools.push(EXECUTE_JAVASCRIPT_TOOL, GET_WORKFLOW_SPEC_TOOL);
					if (activeOkfBundleIds.length > 0) openCodeTools.push(READ_OKF_DOCUMENT_TOOL);

					const openCodeSkillWorkflowMap = collectSkillWorkflows(llmLoadedSkills);
					const openCodeSkillScriptMap = collectSkillScripts(llmLoadedSkills);
					if (llmLoadedSkills.some(s => !s.instructions)) openCodeTools.push(readSkillTool);
					if (openCodeSkillWorkflowMap.size > 0) openCodeTools.push(skillWorkflowTool);
					if (openCodeSkillScriptMap.size > 0) openCodeTools.push(skillScriptTool);

					const enabledMcpServers = resolveAgentPluginMcpServers(
						plugin.settings.mcpServers,
						effectiveSkillPaths,
						plugin.settings.agentPlugins,
					).filter(server => server.enabled);
					if (enabledMcpServers.length > 0) {
						try {
							const mcpTools = await fetchMcpTools(enabledMcpServers);
							openCodeTools.push(...mcpTools);
							openCodeMcpToolExecutor = createMcpToolExecutor(mcpTools, llmTraceId);
						} catch (error) {
							console.error("Failed to fetch MCP tools for OpenCode:", error);
						}
					}

					const vaultExecutor = createToolExecutor(plugin.app, {
						listNotesLimit: plugin.settings.listNotesLimit,
						maxNoteChars: plugin.settings.maxNoteChars,
						limitVaultToolScope: shouldLimitLlmVaultTools(currentModel),
						vaultToolAllowedFolders: plugin.settings.cloudVaultToolAllowedFolders,
						pdfInputMode: resolveLocalLlmPdfInputMode(llmConfig),
					});
					const executeOpenCodeTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
						const blockedVaultTool = getVaultToolExecutionBlock(name, vaultToolMode);
						if (blockedVaultTool) return blockedVaultTool;

						if (name === RAG_SEARCH_TOOL_NAME && ragSearchRunner) return ragSearchRunner.run(args);
						if (name.startsWith("mcp_") && openCodeMcpToolExecutor) {
							const mcpResult = await openCodeMcpToolExecutor.execute(name, args);
							if (mcpResult.mcpApp) llmMcpApps.push(mcpResult.mcpApp);
							if (mcpResult.error) return { error: mcpResult.error };
							return { result: mcpResult.result };
						}
						if (name === "run_skill_workflow" && openCodeSkillWorkflowMap.size > 0) {
							return runSkillWorkflow(
								plugin.app,
								args.workflowId as string,
								args.variables as string | undefined,
								openCodeSkillWorkflowMap,
								{ vaultToolAllowedFolders: plugin.settings.cloudVaultToolAllowedFolders },
							);
						}
						if (name === "run_skill_script" && openCodeSkillScriptMap.size > 0) {
							return executeSkillScript(
								plugin,
								args.scriptId as string,
								args.args as string | undefined,
								openCodeSkillScriptMap,
							);
						}
						if (name === "execute_javascript") return handleExecuteJavascriptTool(args);
						if (name === GET_WORKFLOW_SPEC_TOOL_NAME) return handleGetWorkflowSpec(args, plugin);
						if (name === READ_OKF_DOCUMENT_TOOL_NAME) {
							return executeReadOkfDocumentTool(
								plugin.app,
								getOkfRoot(),
								activeOkfBundleIds,
								typeof args.bundleId === "string" ? args.bundleId : "",
								typeof args.path === "string" ? args.path : "",
							);
						}
						if (name === READ_SKILL_TOOL_NAME) return executeReadSkillTool(plugin.app, llmLoadedSkills, args.skillName as string);
						return vaultExecutor(name, args);
					};
					openCodeMutationTracking = createConfirmingToolExecutor(
						executeOpenCodeTool,
						plugin.app,
						autoApplyEdits,
						() => abortController.abort(),
					);
					if (!openCodeVaultMcpBridgeRef.current) {
						openCodeVaultMcpBridgeRef.current = new CodexVaultMcpBridge(
							openCodeTools,
							openCodeMutationTracking.executeToolCall,
						);
					} else {
						openCodeVaultMcpBridgeRef.current.setTools(openCodeTools);
						openCodeVaultMcpBridgeRef.current.setExecutor(openCodeMutationTracking.executeToolCall);
					}
					openCodeVaultMcpBridgeRef.current.setToolActivityObserver(recordToolActivity);
					openCodeVaultMcpBridgeRef.current.setToolCallObserver((name, args, result) => {
						const id = `opencode-mcp-${Date.now()}-${openCodeToolCallSequence++}`;
						openCodeToolCalls.push({ id, name, args });
						openCodeToolResults.push({ toolCallId: id, result });
						if (!openCodeToolsUsed.includes(name)) openCodeToolsUsed.push(name);
					});
					openCodeMcpUrl = await openCodeVaultMcpBridgeRef.current.start();
					if (ragSearchRunner) systemPrompt += ragSearchRunner.systemPrompt;
					if (vaultToolMode !== "none") {
						systemPrompt += `\n\nThe Obsidian Vault tools are available through the obsidian-llm-hub-vault MCP server. Use them when the request requires vault access.`;
					} else {
						systemPrompt += `\n\nThe obsidian-llm-hub-vault MCP server exposes only the non-Vault tools selected for this chat; built-in Vault tools are disabled.`;
					}
				}

				// === Tools-enabled flow (OpenAI-compat function calling) ===
				// Modern Local LLMs (LM Studio / vLLM / AnythingLLM with recent
				// models) speak the OpenAI tools API. Try that first; on a
				// tools-related rejection mark the model unsupported, persist,
				// and fall through to the marker-based flow below for this turn.
				if (wantsTools && llmConfig.framework !== "opencode") {
					const settings = plugin.settings;

					// Build vault tools (same shape as API provider path: always
					// include write/delete; vaultToolMode-based name filtering happens
					// after MCP merge so the modal toggle stays a UI-only affordance
					// and doesn't accidentally drop propose_edit etc. in noSearch mode).
					const vaultTools = getHostVaultTools();
					const obsidianToolExecutor = createToolExecutor(plugin.app, {
						listNotesLimit: settings.listNotesLimit,
						maxNoteChars: settings.maxNoteChars,
						limitVaultToolScope: shouldLimitLlmVaultTools(currentModel),
						vaultToolAllowedFolders: settings.cloudVaultToolAllowedFolders,
						pdfInputMode: resolveLocalLlmPdfInputMode(llmConfig),
					});

					// Fetch MCP tools if any servers are enabled
					let toolsBundle = [...vaultTools];
					let mcpToolExecutor: McpToolExecutor | null = null;
					const enabledMcpServers = resolveAgentPluginMcpServers(settings.mcpServers, effectiveSkillPaths, settings.agentPlugins).filter(s => s.enabled);
					if (enabledMcpServers.length > 0) {
						try {
							const mcpTools = await fetchMcpTools(enabledMcpServers);
							toolsBundle = [...toolsBundle, ...mcpTools];
							mcpToolExecutor = createMcpToolExecutor(mcpTools, llmTraceId);
						} catch (e) {
							console.error("Failed to fetch MCP tools:", e);
						}
					}
					toolsBundle.push(EXECUTE_JAVASCRIPT_TOOL);
					toolsBundle.push(GET_WORKFLOW_SPEC_TOOL);
					if (activeOkfBundleIds.length > 0) toolsBundle.push(READ_OKF_DOCUMENT_TOOL);

					// Skill workflow / script tools
					const llmSkillWorkflowMap = collectSkillWorkflows(llmLoadedSkills);
					const llmSkillScriptMap = collectSkillScripts(llmLoadedSkills);
					if (llmLoadedSkills.some(s => !s.instructions)) toolsBundle.push(readSkillTool);
					if (llmLoadedSkills.some(s => s.workflows.length > 0)) toolsBundle.push(skillWorkflowTool);
					if (llmLoadedSkills.some(s => s.scripts.length > 0)) toolsBundle.push(skillScriptTool);

					// Apply the Vault tool policy; external MCP and skill tools are preserved.
					toolsBundle = filterToolBundleForVaultMode(
						toolsBundle,
						vaultToolMode,
					);

					// Let the model search the selected index on demand.
					// Kept out of `systemPrompt` itself: a tools rejection falls through to
					// the marker flow below, which has no tool to offer.
					if (ragSearchRunner) toolsBundle.push(RAG_SEARCH_TOOL);
					const toolsSystemPrompt = ragSearchRunner ? systemPrompt + ragSearchRunner.systemPrompt : systemPrompt;
					const baseExecuteToolCall = async (name: string, args: Record<string, unknown>) => {
						const blockedVaultTool = getVaultToolExecutionBlock(name, vaultToolMode);
						if (blockedVaultTool) return blockedVaultTool;

						if (name === RAG_SEARCH_TOOL_NAME && ragSearchRunner) return await ragSearchRunner.run(args);
						if (name === READ_SKILL_TOOL_NAME) return await executeReadSkillTool(plugin.app, llmLoadedSkills, args.skillName as string);
						if (name.startsWith("mcp_") && mcpToolExecutor) {
							const mcpResult = await mcpToolExecutor.execute(name, args);
							if (mcpResult.mcpApp) llmMcpApps.push(mcpResult.mcpApp);
							if (mcpResult.error) return { error: mcpResult.error };
							return { result: mcpResult.result };
						}
						if (name === "run_skill_workflow" && llmSkillWorkflowMap.size > 0) {
							return await runSkillWorkflow(plugin.app, args.workflowId as string, args.variables as string | undefined, llmSkillWorkflowMap, {
								vaultToolAllowedFolders: settings.cloudVaultToolAllowedFolders,
							});
						}
						if (name === "run_skill_script" && llmSkillScriptMap.size > 0) {
							return await executeSkillScript(plugin, args.scriptId as string, args.args as string | undefined, llmSkillScriptMap);
						}
						if (name === "execute_javascript") {
							return await handleExecuteJavascriptTool(args);
						}
						if (name === GET_WORKFLOW_SPEC_TOOL_NAME) {
							return handleGetWorkflowSpec(args, plugin);
						}
						if (name === READ_OKF_DOCUMENT_TOOL_NAME) {
							return await executeReadOkfDocumentTool(plugin.app, getOkfRoot(), activeOkfBundleIds,
								typeof args.bundleId === "string" ? args.bundleId : "",
								typeof args.path === "string" ? args.path : "");
						}
						return await obsidianToolExecutor(name, args);
					};

					const { executeToolCall, processedEdits, processedDeletes, processedRenames, pendingAdditionalRequest } =
						createConfirmingToolExecutor(baseExecuteToolCall, plugin.app, autoApplyEdits, () => abortController.abort());
					takeEditFeedback = () => {
						const requestInfo = pendingAdditionalRequest.current;
						pendingAdditionalRequest.current = null;
						return requestInfo;
					};

					const stream = createStreamAccumulation();
					let toolsFlowError: string | null = null;
					let toolsFlowAborted = false;

					try {
						for await (const chunk of openaiChatWithToolsStream(
							localLlmToolEndpoint(llmConfig),
							llmConfig.apiKey || "no-key",
							llmConfig.model,
							allMessages, toolsBundle,
							toolsSystemPrompt, executeToolCall, abortController.signal,
							false, // local LLMs: don't request reasoning_effort
							undefined, undefined, // proxy already handled by createNodeFetch
							undefined, undefined, // no native web search, no reasoning effort
							true, // recover tool calls a small local model writes as text
						)) {
							if (abortController.signal.aborted) { toolsFlowAborted = true; break; }
							// An "error" chunk throws out of here into the catch below,
							// which is where toolsFlowError is set.
							accumulateStreamChunk(stream, chunk);
							recordToolActivity(chunk);
							if (isActive()) {
								if (chunk.type === "text") setStreamingContent(stream.text);
								else if (chunk.type === "thinking") setStreamingThinking(stream.thinking);
							}
						}
					} catch (err) {
						toolsFlowError = err instanceof Error ? err.message : String(err);
					} finally {
						if (mcpToolExecutor) {
							try { await mcpToolExecutor.cleanup(); } catch (e) { console.warn("MCP cleanup failed:", e); }
						}
					}

					let toolsFullContent = stream.text;

					// User-stop has priority over everything else: don't auto-disable,
					// don't throw, just finalize whatever buffered content we have.
					const wasAborted = toolsFlowAborted || abortController.signal.aborted;
					// Don't fall through to marker mode if the tools attempt already
					// mutated vault state (edits/deletes/renames committed via user
					// confirmation). Marker mode would generate a fresh assistant
					// turn that doesn't reference those mutations, leaving the user
					// confused about what happened. Surface the error and keep the
					// pending* badges instead.
					const hasMutations = processedEdits.length > 0
						|| processedDeletes.length > 0
						|| processedRenames.length > 0;

					const shouldAutoDisable = !wasAborted
						&& !!toolsFlowError
						&& !toolsFullContent
						&& !hasMutations
						&& looksLikeToolsRejection(toolsFlowError)
						&& !looksLikeAuthError(toolsFlowError);

					if (shouldAutoDisable && toolsFlowError) {
						const idx = plugin.settings.localLlmConfigs.findIndex(c => c.id === llmConfig.id);
						if (idx >= 0) {
							const cfg = plugin.settings.localLlmConfigs[idx];
							const list = cfg.toolsUnsupportedModels ?? [];
							if (!list.includes(llmConfig.model)) {
								plugin.settings.localLlmConfigs[idx] = {
									...cfg,
									toolsUnsupportedModels: [...list, llmConfig.model],
								};
								await plugin.saveSettings();
							}
						}
						if (isActive()) {
							setVaultToolMode("none");
							setVaultToolNoneReason("cli");
						}
						new Notice(t("input.vaultStatus.autoDisabledNotice", { model: llmConfig.model }));
						// Reset streaming UI so the marker flow starts clean
						setStreamingContent("");
						setStreamingThinking("");
						// Fall through to marker loop below
					} else if (!wasAborted && toolsFlowError && !toolsFullContent && !hasMutations) {
						// Non-tools error with no output and no committed changes →
						// surface to user via outer catch.
						throw new Error(toolsFlowError);
					} else {
						// Tools flow produced output, OR was aborted by the user, OR
						// already mutated vault state. Finalize and return without
						// running marker loop. Append an error notice inline only when
						// the failure isn't an aborted stop (which has its own marker)
						// — we don't want to overwrite "stopped" with a confusing
						// "AbortError" message.
						if (toolsFlowError && !wasAborted) {
							toolsFullContent += `\n\n${t("chat.errorOccurred", { message: toolsFlowError })}`;
						}
						if (wasAborted && toolsFullContent) toolsFullContent += `\n\n${t("chat.generationStopped")}`;

						const assistantMessage: Message = {
							role: "assistant",
							content: toolsFullContent,
							timestamp: Date.now(),
							model: `local-llm:${llmConfig.id}:${llmConfig.model}` as ModelType,
							toolsUsed: stream.toolsUsed.length > 0 ? stream.toolsUsed : undefined,
							toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
							toolResults: stream.toolResults.length > 0 ? stream.toolResults : undefined,
							thinking: stream.thinking || undefined,
							...pendingStatusFields({ edits: processedEdits, deletes: processedDeletes, renames: processedRenames }),
							ragUsed: localRagSources.length > 0,
							ragSources: localRagSources.length > 0 ? localRagSources : undefined,
						};
						return {
							message: withSearchEvidence(assistantMessage, ragSearchRunner),
							output: toolsFullContent,
							cliSession: null,
							status: {
								value: wasAborted ? 0.5 : (toolsFlowError ? 0 : 1),
								comment: wasAborted ? "stopped by user" : (toolsFlowError ?? "completed"),
							},
						};
					}
				}

				// === Marker-based agent loop (fallback for tools-incompatible models) ===
				// Local LLMs rely on text markers rather than function calls for skill
				// workflow/script invocation. Each iteration streams → detects markers
				// → executes → feeds results back as a follow-up user message. The
				// local LLM is re-prompted with updated history so it can continue
				// reasoning on tool outputs. Bounded by MAX_MARKER_AGENT_ITERATIONS.
				let processedContent = "";
				let conversationHistory: Message[] = allMessages;

				for (let iteration = 0; iteration < MAX_MARKER_AGENT_ITERATIONS; iteration++) {
					let iterationContent = "";
					const streamSep = fullContent ? "\n\n" : "";

					for await (const chunk of localLlmChatStream(
						llmConfig,
						conversationHistory,
						systemPrompt,
						abortController.signal,
						imageAttachments.length > 0 ? imageAttachments : undefined,
						openCodeMcpUrl,
					)) {
						if (abortController.signal.aborted) {
							stopped = true;
							break;
						}

						switch (chunk.type) {
							case "text":
								iterationContent += chunk.content || "";
								if (isActive()) setStreamingContent(fullContent + streamSep + iterationContent);
								break;

							case "thinking":
								fullThinking += chunk.content || "";
								if (isActive()) setStreamingThinking(fullThinking);
								break;

							case "error":
								throw new Error(chunk.error || "Unknown error");

							case "done":
								break;
						}
					}

					if (stopped) break;

					const markerResult = llmLoadedSkills.length > 0
						? await processSkillMarkers(plugin, iterationContent, llmLoadedSkills, abortController.signal, {
							vaultToolAllowedFolders: plugin.settings.cloudVaultToolAllowedFolders,
						})
						: { processedContent: iterationContent, followUpMessage: undefined, aborted: false };

					fullContent += (fullContent && markerResult.processedContent ? "\n\n" : "") + markerResult.processedContent;
					processedContent = fullContent;
					if (isActive()) setStreamingContent(fullContent);

					if (markerResult.aborted) { stopped = true; break; }
					if (!markerResult.followUpMessage) break;

					conversationHistory = [
						...conversationHistory,
							{ role: "assistant", content: iterationContent, timestamp: Date.now() },
							{ role: "user", content: markerResult.followUpMessage, timestamp: Date.now() },
					];
				}

				if (stopped && fullContent) {
					fullContent += `\n\n${t("chat.generationStopped")}`;
					processedContent = fullContent;
				}

				// Add assistant message
				const assistantMessage: Message = {
					role: "assistant",
					content: processedContent,
					timestamp: Date.now(),
					model: `local-llm:${llmConfig.id}:${llmConfig.model}` as ModelType,
					...(fullThinking ? { thinking: fullThinking } : {}),
					...(localRagSources.length > 0 ? { ragUsed: true, ragSources: localRagSources } : {}),
					...(llmMcpApps.length > 0 ? { mcpApps: llmMcpApps } : {}),
					...(openCodeToolsUsed.length > 0 ? { toolsUsed: openCodeToolsUsed } : {}),
					...(openCodeToolCalls.length > 0 ? { toolCalls: openCodeToolCalls } : {}),
					...(openCodeToolResults.length > 0 ? { toolResults: openCodeToolResults } : {}),
					...pendingStatusFields({
						edits: openCodeMutationTracking?.processedEdits ?? [],
						deletes: openCodeMutationTracking?.processedDeletes ?? [],
						renames: openCodeMutationTracking?.processedRenames ?? [],
					}),
				};

				if (isActive()) setCliSession(null);
				return {
					message: withSearchEvidence(assistantMessage, ragSearchRunner),
					output: processedContent,
					cliSession: null,
					status: {
						value: stopped ? 0.5 : 1,
						comment: stopped ? "stopped by user" : "completed",
					},
				};
			},

			// "Request changes" in the edit confirmation modal: send the feedback
			// back to the model now that this turn is saved.
			onSaved: () => {
				const requestInfo = takeEditFeedback?.();
				if (requestInfo) setPendingEditFeedback(requestInfo);
			},

			onSettled: async () => {
				if (!openCodeMcpToolExecutor) return;
				try {
					await openCodeMcpToolExecutor.cleanup();
				} catch (error) {
					console.warn("OpenCode MCP cleanup failed:", error);
				}
			},
		});
	};

	// Send message via API provider (OpenAI-compatible)
	const sendMessageViaApiProvider = async (content: string, attachments?: Attachment[], skillPath?: string, grounded = false, accept?: () => void) => {
		// The confirming tool executor is built once the turn is running; this is
		// how the feedback it collected gets back out to the finished turn.
		let takeEditFeedback: (() => { filePath: string; request: string } | null) | null = null;

		await runChatTurn<ApiProviderTurnContext>(chatTurnUi(grounded), {
			prepare: async () => {

				const providerConfig = getActiveApiProvider();
				const resolvedModelName = getApiProviderModelName(currentModel) || providerConfig?.enabledModels[0] || "";
				if (!providerConfig) {
					new Notice(t("chat.noApiProvider"));
					return null;
				}

				const resolvedContent = await resolveMessageVariables(content);

				let displayContent = resolvedContent.trim();
				if (!displayContent && skillPath) {
					const skillMeta = availableSkills.find(s => s.folderPath === skillPath);
					displayContent = skillMeta ? `/${skillMeta.name}` : "/skill";
				}

				const userMessage: Message = {
					role: "user",
					content: displayContent || (attachments ? `[${attachments.length} file(s) attached]` : ""),
					timestamp: Date.now(),
					attachments: attachments && attachments.length > 0 ? attachments : undefined,
				};

				return {
					userMessage,
					trace: {
						name: "api-provider-chat",
						input: resolvedContent,
						metadata: {
							provider: providerConfig.name,
							model: resolvedModelName,
							webSearchEnabled: allowWebSearch && webSearchEnabled,
						},
					},
					context: { providerConfig, resolvedModelName, resolvedContent },
				};
			},

			run: async (turn, { providerConfig, resolvedModelName, resolvedContent }) => {
				const runWithPrompt = async (groundedPrompt?: GroundedPrompt): Promise<ChatTurnOutcome> => {
				const { isActive, abortController, traceId: apiTraceId, userMessage } = turn;
				const recordToolActivity = beginToolActivity(turn);
				const settings = plugin.settings;
				let systemPrompt = `You are a helpful AI assistant in an Obsidian vault.
	Always be helpful and provide clear, concise responses. When working with notes, confirm actions and provide relevant feedback.`;

				if (!groundedPrompt && vaultToolMode !== "none") {
					systemPrompt += FILE_MENTION_TOOL_PROMPT;
				}

				if (settings.systemPrompt) {
					systemPrompt += `\n\nAdditional instructions: ${settings.systemPrompt}`;
				}

				systemPrompt = await appendOkfSystemPrompt(systemPrompt);

				// Local RAG: search and inject context into system prompt
				let localRagSources: string[] = groundedPrompt?.evidence.sources.map(source => source.filePath) ?? [];
				let ragSearchRunner: RagSearchRunner | null = null;
				const ragSettingObj = !groundedPrompt && selectedRagSetting && !isImageGenerationModel(currentModel) ? plugin.getRagSearchSetting(selectedRagSetting) : null;
				if (selectedRagSetting && ragSettingObj) {
					ragSearchRunner = createRagSearchRunner(
						(query, topK) => searchLocalRagResults(
							selectedRagSetting, query, ragSettingObj, getGeminiApiKey(plugin.settings),
							plugin.settings.proxyUrl, plugin.settings.proxyBypass, topK, plugin.settings,
						),
						(filePaths) => { for (const p of filePaths) if (!localRagSources.includes(p)) localRagSources.push(p); },
						{ topK: ragSettingObj.topK, settingName: selectedRagSetting, query: resolvedContent },
					);
					if (AUTOMATIC_RAG_RETRIEVAL) try {
						const localRag = await searchLocalRag(
							selectedRagSetting, resolvedContent,
							ragSettingObj, getGeminiApiKey(plugin.settings),
							plugin.settings.proxyUrl, plugin.settings.proxyBypass, plugin.settings
						);
						// A search that threw never reached the index, so it must not consume
						// the turn budget the model is told it has.
						if (localRag.sources.length > 0) {
							systemPrompt += localRag.context;
							localRagSources = localRag.sources;
							// Attach multimodal RAG files so the LLM can see actual content
							if (localRag.mediaReferences.length > 0) {
								const pdfMode = resolveApiProviderPdfInputMode(providerConfig);
								const ragAttachments = (await loadRagMediaAttachments(plugin.app, localRag.mediaReferences))
									.filter(attachment => attachment.type !== "pdf" || pdfMode === "native");
								// A dropped PDF leaves only its label in the indexed chunk text,
								// so its pages go into the prompt as extracted text instead.
								if (pdfMode !== "native") {
									systemPrompt += await buildRagPdfTextContext(plugin.app, localRag.mediaReferences);
								}
								if (ragAttachments.length > 0) {
									const existing = userMessage.attachments || [];
									(userMessage as { attachments?: import("src/types").Attachment[] }).attachments = [...existing, ...ragAttachments];
								}
							}
						}
					} catch (e) {
						console.error("Local RAG search failed:", formatError(e));
					}
				}
				if (vaultToolMode === "noSearch") {
					systemPrompt += buildNoDiscoverySystemPrompt({
						ragRequested: Boolean(ragSearchRunner),
						hasRagContext: localRagSources.length > 0,
					});
				}
				if (plugin.settings.voiceChat.autoReadAloud) systemPrompt += buildReadAloudSystemPrompt();

				// Build vault tools (same as Gemini path)
				const allMessages = limitConversationHistory([...messages, userMessage], maxPreviousMessages);
				let tools = buildVaultToolPayload(
					vaultToolMode,
				);
				const obsidianToolExecutor = createToolExecutor(plugin.app, {
					listNotesLimit: settings.listNotesLimit,
					maxNoteChars: settings.maxNoteChars,
					limitVaultToolScope: shouldLimitLlmVaultTools(currentModel),
					vaultToolAllowedFolders: settings.cloudVaultToolAllowedFolders,
					pdfInputMode: resolveApiProviderPdfInputMode(providerConfig),
				});

				// Fetch MCP tools
				let mcpToolExecutor: McpToolExecutor | null = null;
				const enabledMcpServers = resolveAgentPluginMcpServers(settings.mcpServers, getEffectiveSkillPathsForSend(skillPath), settings.agentPlugins).filter(s => s.enabled);
				if (!groundedPrompt && enabledMcpServers.length > 0) {
					try {
						const mcpTools = await fetchMcpTools(enabledMcpServers);
						tools = [...tools, ...mcpTools];
						mcpToolExecutor = createMcpToolExecutor(mcpTools, apiTraceId);
					} catch (e) {
						console.error("Failed to fetch MCP tools:", e);
					}
				}

				// Add JavaScript sandbox tool
				tools.push(EXECUTE_JAVASCRIPT_TOOL);
				tools.push(GET_WORKFLOW_SPEC_TOOL);
				if (activeOkfBundleIds.length > 0) tools.push(READ_OKF_DOCUMENT_TOOL);

				// Load skills for API provider mode
				let apiLoadedSkills: LoadedSkill[] = [];
				{
					const effectiveSkillPaths = getEffectiveSkillPathsForSend(skillPath);
					if (effectiveSkillPaths.length > 0) {
						const activeMetadata = availableSkills.filter(s => effectiveSkillPaths.includes(s.folderPath));
						if (activeMetadata.length > 0) {
							apiLoadedSkills = activeMetadata.map(m => loadSkill(plugin.app, m));
						}
					}
				}
				if (apiLoadedSkills.length > 0) {
					systemPrompt += buildSkillSystemPrompt(apiLoadedSkills);
				}
				if (apiLoadedSkills.some(s => !s.instructions)) tools.push(readSkillTool);
				if (apiLoadedSkills.some(s => s.workflows.length > 0)) {
					tools.push(skillWorkflowTool);
				}
				if (apiLoadedSkills.some(s => s.scripts.length > 0)) {
					tools.push(skillScriptTool);
				}

				// Let the model search the selected index on demand.
				if (ragSearchRunner) {
					tools.push(RAG_SEARCH_TOOL);
					systemPrompt += ragSearchRunner.systemPrompt;
				}

				const apiSkillWorkflowMap = collectSkillWorkflows(apiLoadedSkills);
				const apiSkillScriptMap = collectSkillScripts(apiLoadedSkills);
				const apiMcpApps: McpAppInfo[] = [];
				const baseExecuteToolCall = async (name: string, args: Record<string, unknown>) => {
					const blockedVaultTool = getVaultToolExecutionBlock(name, vaultToolMode);
					if (blockedVaultTool) return blockedVaultTool;

					if (name === RAG_SEARCH_TOOL_NAME && ragSearchRunner) return await ragSearchRunner.run(args);
					if (name === READ_SKILL_TOOL_NAME) return await executeReadSkillTool(plugin.app, apiLoadedSkills, args.skillName as string);
					if (name.startsWith("mcp_") && mcpToolExecutor) {
						const mcpResult = await mcpToolExecutor.execute(name, args);
						if (mcpResult.mcpApp) apiMcpApps.push(mcpResult.mcpApp);
						if (mcpResult.error) return { error: mcpResult.error };
						return { result: mcpResult.result };
					}
					if (name === "run_skill_workflow" && apiSkillWorkflowMap.size > 0) {
						return await runSkillWorkflow(plugin.app, args.workflowId as string, args.variables as string | undefined, apiSkillWorkflowMap, {
							vaultToolAllowedFolders: settings.cloudVaultToolAllowedFolders,
						});
					}
					if (name === "run_skill_script" && apiSkillScriptMap.size > 0) {
						return await executeSkillScript(plugin, args.scriptId as string, args.args as string | undefined, apiSkillScriptMap);
					}
					if (name === "execute_javascript") {
						return await handleExecuteJavascriptTool(args);
					}
					if (name === GET_WORKFLOW_SPEC_TOOL_NAME) {
						return handleGetWorkflowSpec(args, plugin);
					}
					if (name === READ_OKF_DOCUMENT_TOOL_NAME) {
						return await executeReadOkfDocumentTool(plugin.app, getOkfRoot(), activeOkfBundleIds,
							typeof args.bundleId === "string" ? args.bundleId : "",
							typeof args.path === "string" ? args.path : "");
					}
					return await obsidianToolExecutor(name, args);
				};

				const { executeToolCall, processedEdits, processedDeletes, processedRenames, pendingAdditionalRequest } =
					createConfirmingToolExecutor(baseExecuteToolCall, plugin.app, autoApplyEdits, () => abortController.abort());
				takeEditFeedback = () => {
					const requestInfo = pendingAdditionalRequest.current;
					pendingAdditionalRequest.current = null;
					return requestInfo;
				};

				// toolCalls/toolResults drive the tool badges in MessageBubble; toolsUsed
				// alone only reaches the saved Markdown history.
				const stream = createStreamAccumulation();
				let stopped = false;
				const startTime = Date.now();

				// Route to correct provider implementation
				const apiEnableThinking = getThinkingToggle();
				if (groundedPrompt) {
					systemPrompt += `\n\n${groundedPrompt.systemContext}`;
					tools = [];
				}
				const isWebSearch = !groundedPrompt && providerSupportsWebSearch(providerConfig, resolvedModelName)
					&& webSearchEnabled;
				const isImageGen = providerConfig.type === "openai" && isOpenAiImageModel(resolvedModelName);
				const streamFn = isImageGen
					? openaiGenerateImageStream(
						providerConfig.baseUrl, providerConfig.apiKey,
						resolvedModelName, resolvedContent,
						abortController.signal,
						plugin.settings.proxyUrl, plugin.settings.proxyBypass,
					)
					: providerConfig.type === "anthropic"
						? anthropicChatWithToolsStream(
							providerConfig.baseUrl, providerConfig.apiKey,
							resolvedModelName, allMessages, tools,
							systemPrompt, executeToolCall, abortController.signal,
							apiEnableThinking,
							plugin.settings.proxyUrl, plugin.settings.proxyBypass,
							isWebSearch,
						)
						: openaiChatWithToolsStream(
							providerConfig.baseUrl, providerConfig.apiKey,
							resolvedModelName, allMessages, tools,
							systemPrompt, executeToolCall, abortController.signal,
							apiEnableThinking,
							plugin.settings.proxyUrl, plugin.settings.proxyBypass,
							isWebSearch, selectedReasoningEffort,
						);

				for await (const chunk of streamFn) {
					if (abortController.signal.aborted) {
						stopped = true;
						break;
					}

					accumulateStreamChunk(stream, chunk);
					recordToolActivity(chunk);
					if (isActive()) {
						if (chunk.type === "text") setStreamingContent(stream.text);
						else if (chunk.type === "thinking") setStreamingThinking(stream.thinking);
					}
				}

				let fullContent = stream.text;
				let webSearchSources: Message["webSearchSources"] =
					stream.webSearchSources.length > 0 ? stream.webSearchSources : undefined;

				if (stopped && fullContent) {
					fullContent += `\n\n${t("chat.generationStopped")}`;
				} else if (!webSearchSources && stream.webSearchCitations.length > 0) {
					const formatted = formatWebSearchCitations(fullContent, stream.webSearchCitations);
					fullContent = formatted.content;
					webSearchSources = formatted.sources;
					if (isActive()) setStreamingContent(fullContent);
				}

				// Cleanup MCP
				if (mcpToolExecutor) {
					try { await mcpToolExecutor.cleanup(); } catch (e) { console.warn("MCP cleanup failed:", e); }
				}

				const elapsedMs = Date.now() - startTime;
				const baseAssistantMessage: Message = {
					role: "assistant",
					content: fullContent,
					timestamp: Date.now(),
					model: currentModel,
					toolsUsed: stream.toolsUsed.length > 0 ? stream.toolsUsed : undefined,
					toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
					toolResults: stream.toolResults.length > 0 ? stream.toolResults : undefined,
					thinking: stream.thinking || undefined,
					// Processed edit/delete/rename info from the tool executor.
					...pendingStatusFields({ edits: processedEdits, deletes: processedDeletes, renames: processedRenames }),
					ragUsed: localRagSources.length > 0,
					ragSources: localRagSources.length > 0 ? localRagSources : undefined,
					generatedImages: stream.generatedImages.length > 0 ? stream.generatedImages : undefined,
					imageGenerationUsed: stream.generatedImages.length > 0 || undefined,
					webSearchUsed: stream.webSearchUsed || undefined,
					webSearchSources,
					providerContinuation: stream.providerContinuation,
					usage: stream.usage,
					elapsedMs,
					mcpApps: apiMcpApps.length > 0 ? apiMcpApps : undefined,
				};
				return {
					message: groundedPrompt ? attachGroundedEvidence(baseAssistantMessage, groundedPrompt.evidence) : withSearchEvidence(baseAssistantMessage, ragSearchRunner),
					output: fullContent,
					status: {
						value: stopped ? 0.5 : 1,
						comment: stopped ? "stopped by user" : "completed",
					},
				};
				};
				return grounded ? runGroundedTurn(turn, resolvedContent, runWithPrompt, accept,
					{ endpoint: providerConfig.baseUrl, model: resolvedModelName }) : runWithPrompt();
			},

			// "Request changes" in the edit confirmation modal: send the feedback
			// back to the model now that this turn is saved.
			onSaved: () => {
				const requestInfo = takeEditFeedback?.();
				if (requestInfo) setPendingEditFeedback(requestInfo);
			},
		});
	};

	// Send message to Gemini
	const sendMessage = async (content: string, attachments?: Attachment[], skillPath?: string, onAccepted?: () => void): Promise<boolean> => {
		if ((!content.trim() && !skillPath && (!attachments || attachments.length === 0)) || isLoading) return false;
		const ownerSession = activeSessionIdRef.current;
		if (groundedPreflight.current.has(ownerSession)) return false;
		const slashSettings = preSlashSettingsRef.current;
		const explicitOrdinaryAction = !!(skillPath || currentSlashCommandRef.current || !content.trim() && attachments?.length || shouldUseImageModel(content));
		let grounded = groundedMode && !(groundedOverride === null && explicitOrdinaryAction);
		let accepted = false;
		const accept = () => { accepted = true; onAccepted?.(); };
    const container = messagesContainerRef.current;
    const win = container?.ownerDocument.defaultView;
		try {
			if (grounded) {
				groundedPreflight.current.add(ownerSession);
				const reason = !groundedModelAvailable ? 'input.grounded.remoteRequired' : !selectedRagSetting ? 'input.grounded.selectIndex'
					: !content.trim() ? 'input.grounded.questionRequired' : webSearchEnabled ? 'chat.grounded.searchConflict' : undefined;
				if (reason) {
					const restriction = `${reason}:${selectedRagSetting ?? ''}`;
					const remembered = groundedOverride !== true && await plugin.ordinaryGroundedCondition?.(restriction, currentModel);
					if (activeSessionIdRef.current !== ownerSession) return false;
					const choice = remembered ? 'condition' : await chooseGroundedRestriction(plugin.app, t(reason), reason === 'chat.grounded.searchConflict');
					if (choice === 'keep' || activeSessionIdRef.current !== ownerSession) return false;
					if (choice === 'off') {
						plugin.settings.groundedAnswersByDefault = false;
						setGroundedMode(false);
						await plugin.saveSettings();
					}
					if (choice === 'condition' && !remembered) await plugin.ordinaryGroundedCondition?.(restriction, currentModel, true);
					grounded = choice === 'knowledge';
				}
				if (grounded && selectedRagSetting) {
					const endpoint = activeSearchProvider?.type === 'gemini' ? activeSearchProvider.baseUrl || OFFICIAL_GEMINI_EMBEDDING_ORIGIN
						: activeSearchProvider?.baseUrl ?? currentLocalLlmConfig?.baseUrl;
					const model = activeSearchProvider ? resolvedApiModelName || activeSearchProvider.enabledModels[0] : currentLocalLlmConfig?.model;
					if (!endpoint || !await plugin.confirmKnowledgeDestination('answer', endpoint, selectedRagSetting, model)) {
						new Notice(t('chat.grounded.sendPaused'));
						return false;
					}
					if (activeSessionIdRef.current !== ownerSession) return false;
				}
			}
			// Saving an ordinary-answer choice may finish after the user switches chats.
			if (activeSessionIdRef.current !== ownerSession) return false;
			if (container && win) container.dispatchEvent(new win.Event(CHAT_SCROLL_LATEST_EVENT));
			if (!grounded) { setGroundedProblem(null); accept(); }
			// Use API provider if in api-provider mode
			if (isApiProviderMode) {
				// Check if this is a Gemini provider → route to Gemini path
				const provider = getActiveApiProvider();
				if (provider?.type === "gemini") {
					await sendMessageViaGemini(content, attachments, skillPath, provider, grounded, accept);
					return accepted;
				}
				await sendMessageViaApiProvider(content, attachments, skillPath, grounded, accept);
				return accepted;
			}

			if (isLocalLlmMode) {
				await sendMessageViaLocalLlm(content, attachments, skillPath, grounded, accept);
				return accepted;
			}

			if (isCliMode) {
				await sendMessageViaCli(content, attachments, skillPath);
				return accepted;
			}

			throw new Error("unavailable-provider");
		} catch {
			// Preparation happens before the shared turn appends the question. Preserve it here,
			// without copying a raw service/file error into the conversation or a different chat.
			if (activeSessionIdRef.current === ownerSession) {
				if (latestMessagesRef.current.length === messages.length) {
					const recovered: Message[] = [...messages,
						{ role: "user", content, attachments, timestamp: Date.now() },
						{ role: "assistant", content: t("chat.preparationFailed"), timestamp: Date.now() }];
					setMessages(recovered);
					try { await saveCurrentChat(recovered); } catch { new Notice(t("chat.preparationFailed")); }
				} else new Notice(t("chat.preparationFailed"));
			}
			return accepted;
		} finally {
			groundedPreflight.current.delete(ownerSession);
			// Only consume the overrides that belonged to this send.
			if (preSlashSettingsRef.current === slashSettings) {
				currentSlashCommandRef.current = null;
				preSlashSettingsRef.current = null;
				if (slashSettings) {
					setCurrentModel(slashSettings.model);
					if (persistentCliRef.current) {
						persistentCliRef.current.terminate();
						persistentCliRef.current = null;
					}
					handleSearchSelectionChange({ ragSetting: slashSettings.ragSetting, webSearch: slashSettings.webSearch }, false);
					setVaultToolMode(slashSettings.vaultToolMode);
					setVaultToolNoneReason(slashSettings.vaultToolNoneReason);
					setMcpServers(slashSettings.mcpServers);
				}
			}
		}
	};

	// Send message via Gemini provider (uses @google/genai SDK)
	const sendMessageViaGemini = async (content: string, attachments?: Attachment[], skillPath?: string, providerConfig?: ApiProviderConfig, grounded = false, accept?: () => void) => {
		// The confirming tool executor is built once the turn is running; this is
		// how the feedback it collected gets back out to the finished turn.
		let takeEditFeedback: (() => { filePath: string; request: string } | null) | null = null;
		// Track MCP executor for background-stream cleanup: the turn creates it
		// inside `run`, and the teardown still has to reach it.
		const mcpCleanupRef = { executor: null as McpToolExecutor | null };

		await runChatTurn<GeminiTurnContext>(chatTurnUi(grounded), {
			prepare: async () => {

				const apiKey = providerConfig ? providerConfig.apiKey : getGeminiApiKey(plugin.settings);
				if (!apiKey) {
					new Notice(t("chat.clientNotInitialized"));
					return null;
				}

				// Initialize a GeminiClient with this provider's API key
				const { GeminiClient } = await import("src/core/gemini");
				const modelName = getApiProviderModelName(currentModel) || providerConfig?.enabledModels[0] || "gemini-3.8-flash";
				const client = new GeminiClient(apiKey, modelName as ModelType, plugin.settings.proxyUrl, plugin.settings.proxyBypass, providerConfig?.baseUrl);

				let allowedModel = modelName as ModelType;

				// Auto-switch to image model when image generation keywords detected
				if (!grounded && !isImageGenerationModel(allowedModel) && shouldUseImageModel(content)) {
					// Check provider's availableModels for an image model
					const imageModel = providerConfig?.availableModels?.find(m => isImageGenerationModel(m));
					if (imageModel) {
						allowedModel = imageModel as ModelType;
					}
				}

				client.setModel(allowedModel);

				// Resolve variables in the content ({selection}, {content}, file paths)
				const resolvedContent = await resolveMessageVariables(content);

				// When skill is invoked without message, use skill name as trigger
				let displayContent = resolvedContent.trim();
				if (!displayContent && skillPath) {
					const skillMeta = availableSkills.find(s => s.folderPath === skillPath);
					displayContent = skillMeta ? `/${skillMeta.name}` : "/skill";
				}

				// Add user message
				const userMessage: Message = {
					role: "user",
					content: displayContent || (attachments ? `[${attachments.length} file(s) attached]` : ""),
					timestamp: Date.now(),
					attachments,
				};

				return {
					userMessage,
					trace: {
						name: "chat-message",
						sessionId: currentChatId ?? undefined,
						input: resolvedContent,
						metadata: {
							model: allowedModel,
							ragEnabled: allowRag,
							webSearchEnabled: allowWebSearch && webSearchEnabled,
							toolsEnabled: !isImageGenerationModel(allowedModel),
							isImageGeneration: isImageGenerationModel(allowedModel),
							pluginVersion: plugin.manifest.version,
						},
					},
					context: { client, allowedModel, resolvedContent },
				};
			},

			run: async (turn, { client, allowedModel, resolvedContent }) => {
				const runWithPrompt = async (groundedPrompt?: GroundedPrompt): Promise<ChatTurnOutcome> => {
				const { isActive, abortController, traceId, userMessage } = turn;
				const recordToolActivity = beginToolActivity(turn);
				let result: ChatTurnOutcome | undefined;
				const runStreamOnce = async () => {
					const { settings } = plugin;
					const toolsEnabled = !groundedPrompt && !isImageGenerationModel(allowedModel);
					const obsidianTools = toolsEnabled ? getHostVaultTools() : [];

					// Activate skill if invoked via slash command
					const effectiveSkillPaths = getEffectiveSkillPathsForSend(skillPath);
					if (skillPath && !activeSkillPaths.includes(skillPath)) {
						setActiveSkillPaths(prev => prev.includes(skillPath) ? prev : [...prev, skillPath]);
					}

					// Load active skills (needed for both workflow tools and system prompt)
					let loadedSkillsList: LoadedSkill[] = [];
					if (effectiveSkillPaths.length > 0) {
						const activeMetadata = availableSkills.filter(s => effectiveSkillPaths.includes(s.folderPath));
						if (activeMetadata.length > 0) {
							loadedSkillsList = activeMetadata.map(m => loadSkill(plugin.app, m));
						}
					}

					// Fetch MCP tools from enabled servers only
					const enabledMcpServers = resolveAgentPluginMcpServers(mcpServers, effectiveSkillPaths, settings.agentPlugins).filter(s => s.enabled);
					const mcpTools: McpToolDefinition[] = toolsEnabled && enabledMcpServers.length > 0
						? await fetchMcpTools(enabledMcpServers)
						: [];

					// Cleanup previous MCP executor if exists
					if (mcpExecutorRef.current) {
						void mcpExecutorRef.current.cleanup();
						mcpExecutorRef.current = null;
					}

					// Create MCP tool executor
					const mcpToolExecutor = mcpTools.length > 0
						? createMcpToolExecutor(mcpTools, traceId)
						: undefined;

					// Store for session reuse and track for background-stream cleanup
					mcpExecutorRef.current = mcpToolExecutor ?? null;
					mcpCleanupRef.executor = mcpToolExecutor ?? null;

					// Merge Obsidian tools and MCP tools
					const allTools = [...obsidianTools, ...mcpTools];

					// Filter Obsidian tools based on vaultToolMode (MCP tools are not affected).
					// The names come from the shared definitions: the list kept here had
					// drifted and let read_timeline, get_active_note_info and the bulk_*
					// tools through with Vault access switched off.
					// Vault skills use a dedicated active-skill reader, so Vault: none can
					// remove every general Vault tool without making the skill unreachable.
					const hasActiveVaultSkill = loadedSkillsList.some(s => !s.instructions);
					const tools = filterToolBundleForVaultMode(
						allTools,
						vaultToolMode,
					);
					if (toolsEnabled && hasActiveVaultSkill) tools.push(readSkillTool);

					// Add run_skill_workflow tool if any active skill has workflows
					if (toolsEnabled && loadedSkillsList.some(s => s.workflows.length > 0)) {
						tools.push(skillWorkflowTool);
					}

					// Add run_skill_script tool if any active skill has scripts
					if (toolsEnabled && loadedSkillsList.some(s => s.scripts.length > 0)) {
						tools.push(skillScriptTool);
					}

					// Add execute_javascript tool
					if (toolsEnabled) {
						tools.push(EXECUTE_JAVASCRIPT_TOOL);
						tools.push(GET_WORKFLOW_SPEC_TOOL);
						if (activeOkfBundleIds.length > 0) tools.push(READ_OKF_DOCUMENT_TOOL);
					}

					// Create context for tools (Obsidian tools only)
					const obsidianToolExecutor = toolsEnabled
						? createToolExecutor(plugin.app, {
							listNotesLimit: settings.listNotesLimit,
							maxNoteChars: settings.maxNoteChars,
							limitVaultToolScope: shouldLimitLlmVaultTools(allowedModel),
							vaultToolAllowedFolders: settings.cloudVaultToolAllowedFolders,
							pdfInputMode: providerConfig ? resolveApiProviderPdfInputMode(providerConfig) : "native",
						})
						: undefined;

					// Filled in by the confirming executor below.
					// Track MCP Apps with UI for message display
					const collectedMcpApps: McpAppInfo[] = [];

					// Build skill workflow/script maps for tool execution
					const skillWorkflowMap = collectSkillWorkflows(loadedSkillsList);
					const skillScriptMap = collectSkillScripts(loadedSkillsList);

					// Combined tool executor that routes to Obsidian, MCP, or Skill Workflow/Script based on tool name
					const baseToolExecutor = (obsidianToolExecutor || mcpToolExecutor || skillWorkflowMap.size > 0 || skillScriptMap.size > 0)
						? async (name: string, args: Record<string, unknown>) => {
							const blockedVaultTool = getVaultToolExecutionBlock(name, vaultToolMode);
							if (blockedVaultTool) return blockedVaultTool;

							if (name === RAG_SEARCH_TOOL_NAME && ragSearchRunner) return await ragSearchRunner.run(args);
							if (name === READ_SKILL_TOOL_NAME) return await executeReadSkillTool(plugin.app, loadedSkillsList, args.skillName as string);
							// MCP tools start with "mcp_"
							if (name.startsWith("mcp_") && mcpToolExecutor) {
								const mcpResult = await mcpToolExecutor.execute(name, args);
								// Collect MCP App info if available
								if (mcpResult.mcpApp) {
									collectedMcpApps.push(mcpResult.mcpApp);
								}
								// Return result in expected format for compatibility
								if (mcpResult.error) {
									return { error: mcpResult.error };
								}
								return { result: mcpResult.result };
							}
							// Skill workflow tool
							if (name === "run_skill_workflow" && skillWorkflowMap.size > 0) {
								return await runSkillWorkflow(
									plugin.app,
									args.workflowId as string,
									args.variables as string | undefined,
									skillWorkflowMap,
									{
										vaultToolAllowedFolders: shouldLimitLlmVaultTools(allowedModel)
											? settings.cloudVaultToolAllowedFolders
											: undefined,
									},
								);
							}
							// Skill script tool
							if (name === "run_skill_script" && skillScriptMap.size > 0) {
								return await executeSkillScript(
									plugin,
									args.scriptId as string,
									args.args as string | undefined,
									skillScriptMap,
								);
							}
							// JavaScript sandbox tool
							if (name === "execute_javascript") {
								return await handleExecuteJavascriptTool(args);
							}
							if (name === GET_WORKFLOW_SPEC_TOOL_NAME) {
								return handleGetWorkflowSpec(args, plugin);
							}
							if (name === READ_OKF_DOCUMENT_TOOL_NAME) {
								return await executeReadOkfDocumentTool(plugin.app, getOkfRoot(), activeOkfBundleIds,
									typeof args.bundleId === "string" ? args.bundleId : "",
									typeof args.path === "string" ? args.path : "");
							}
							// Otherwise use Obsidian tool executor
							if (obsidianToolExecutor) {
								return await obsidianToolExecutor(name, args);
							}
							return { error: `Unknown tool: ${name}` };
						}
						: undefined;

					// The propose_* and bulk_* tools need the user's confirmation before
					// anything is written; the shared wrapper drives it and records what
					// happened for the badges on the finished message.
					const confirming = baseToolExecutor
						? createConfirmingToolExecutor(baseToolExecutor, plugin.app, autoApplyEdits, () => abortController.abort())
						: null;
					const toolExecutor = confirming?.executeToolCall
						? withToolFailureResult(confirming.executeToolCall, abortController.signal) : undefined;
					const processedEdits = confirming?.processedEdits ?? [];
					const processedDeletes = confirming?.processedDeletes ?? [];
					const processedRenames = confirming?.processedRenames ?? [];
					const pendingAdditionalRequestRef = confirming?.pendingAdditionalRequest ?? { current: null };
					takeEditFeedback = () => {
						const requestInfo = pendingAdditionalRequestRef.current;
						pendingAdditionalRequestRef.current = null;
						return requestInfo;
					};

						// Check if Web Search or Image Generation model is selected
					const isWebSearch = !groundedPrompt && allowWebSearch && webSearchEnabled
						&& (toolsEnabled || isImageGenerationModel(allowedModel));
					const isImageGeneration = isImageGenerationModel(allowedModel);

					let systemPrompt = "You are a helpful AI assistant integrated with Obsidian.";

					if (toolsEnabled) {
						systemPrompt += FILE_MENTION_TOOL_PROMPT;
						systemPrompt += `

	Available tools allow you to:
	- Read notes from the vault
	- Create new notes
	- Update existing notes
	- Search for notes by name or content
	- List notes and folders
	- Get information about the active note`;
					}

					systemPrompt += `

	Always be helpful and provide clear, concise responses. When working with notes, confirm actions and provide relevant feedback.`;

					if (settings.systemPrompt) {
						systemPrompt += `\n\nAdditional instructions: ${settings.systemPrompt}`;
					}

					// Inject active agent skills into system prompt
					let skillsUsedNames: string[] = [];
					if (loadedSkillsList.length > 0) {
						const skillPrompt = buildSkillSystemPrompt(loadedSkillsList);
						if (skillPrompt) {
							systemPrompt += skillPrompt;
							skillsUsedNames = loadedSkillsList.map(s => s.name);
						}
					}

					systemPrompt = await appendOkfSystemPrompt(systemPrompt);

					// Local RAG: search and inject context into system prompt
					let localRagSources: string[] = groundedPrompt?.evidence.sources.map(source => source.filePath) ?? [];
					let ragSearchRunner: RagSearchRunner | null = null;
					const ragSettingObj = !groundedPrompt && selectedRagSetting && !isImageGenerationModel(allowedModel) ? plugin.getRagSearchSetting(selectedRagSetting) : null;
					if (selectedRagSetting && ragSettingObj) {
						ragSearchRunner = createRagSearchRunner(
							(query, topK) => searchLocalRagResults(
								selectedRagSetting, query, ragSettingObj, getGeminiApiKey(plugin.settings),
								plugin.settings.proxyUrl, plugin.settings.proxyBypass, topK, plugin.settings,
							),
							(filePaths) => { for (const p of filePaths) if (!localRagSources.includes(p)) localRagSources.push(p); },
							{ topK: ragSettingObj.topK, settingName: selectedRagSetting, query: resolvedContent },
						);
						if (AUTOMATIC_RAG_RETRIEVAL) try {
							const localRag = await searchLocalRag(
								selectedRagSetting, resolvedContent,
								ragSettingObj, getGeminiApiKey(plugin.settings),
								plugin.settings.proxyUrl, plugin.settings.proxyBypass, plugin.settings
							);
							// A search that threw never reached the index, so it must not consume
							// the turn budget the model is told it has.
							if (localRag.sources.length > 0) {
								systemPrompt += localRag.context;
								localRagSources = localRag.sources;
								// Attach multimodal RAG files so the LLM can see actual content
								if (localRag.mediaReferences.length > 0) {
									const pdfMode = providerConfig ? resolveApiProviderPdfInputMode(providerConfig) : "native";
									const ragAttachments = (await loadRagMediaAttachments(plugin.app, localRag.mediaReferences))
										.filter(attachment => attachment.type !== "pdf" || pdfMode === "native");
									// A dropped PDF leaves only its label in the indexed chunk text,
									// so its pages go into the prompt as extracted text instead.
									if (pdfMode !== "native") {
										systemPrompt += await buildRagPdfTextContext(plugin.app, localRag.mediaReferences);
									}
									if (ragAttachments.length > 0) {
										const existing = userMessage.attachments || [];
										(userMessage as { attachments?: import("src/types").Attachment[] }).attachments = [...existing, ...ragAttachments];
									}
								}
							}
						} catch (e) {
							console.error("Local RAG search failed:", formatError(e));
						}
					}
					if (vaultToolMode === "noSearch") {
						systemPrompt += buildNoDiscoverySystemPrompt({
							ragRequested: Boolean(ragSearchRunner),
							hasRagContext: localRagSources.length > 0,
						});
					}
					if (plugin.settings.voiceChat.autoReadAloud) systemPrompt += buildReadAloudSystemPrompt();

					// Let the model search the selected index on demand.
					if (toolsEnabled && ragSearchRunner) tools.push(RAG_SEARCH_TOOL);

					const allMessages = limitConversationHistory([...messages, userMessage], maxPreviousMessages);

					// Use streaming with tools
					const stream = createStreamAccumulation();
					// Local RAG ran before the stream, so its hits belong to this turn
					// too; rag_search may append more to localRagSources mid-stream,
					// which is merged in once the stream is done.
					stream.ragSources.push(...localRagSources);
					stream.ragUsed = localRagSources.length > 0;
					const startTime = Date.now();

					// Resolve previous interaction ID for Interactions API conversation chaining.
					// Only chain when the most recent assistant message (array tail) carries an
					// interactionId.  If it doesn't (old chat history, image generation response,
					// CLI response, etc.) we fall back to local history replay in gemini.ts.
					const previousInteractionId = (() => {
						if (groundedPrompt) return undefined;
						// Server-side chaining would bypass the configured local history limit.
						if (messages.length > maxPreviousMessages) return undefined;
						for (let i = messages.length - 1; i >= 0; i--) {
							if (messages[i].role === "assistant") {
								return messages[i].interactionId;  // undefined if absent → fallback
							}
						}
						return undefined;
					})();

					let stopped = false;

					// Gemma 4: RAG/Web Search and function calling are mutually exclusive
					const effectiveTools = groundedPrompt || (isGemma4(allowedModel) && (isWebSearch || localRagSources.length > 0)) ? [] : tools;
					if (groundedPrompt) systemPrompt += `\n\n${groundedPrompt.systemContext}`;
					// Gemma 4 drops every tool when RAG or web search is on, so only describe
					// rag_search when it actually survives into the request.
					if (ragSearchRunner && effectiveTools.some(tool => tool.name === RAG_SEARCH_TOOL_NAME)) {
						systemPrompt += ragSearchRunner.systemPrompt;
					}

					// Use image generation stream or regular chat stream
					const chunkStream = isImageGeneration
						? client.generateImageStream(allMessages, allowedModel, systemPrompt, isWebSearch, undefined, traceId)
						: client.chatWithToolsStream(
							allMessages,
							effectiveTools,
							systemPrompt,
							toolsEnabled ? toolExecutor : undefined,
							undefined,
							isWebSearch,
							{
								functionCallLimits: {
									maxFunctionCalls: settings.maxFunctionCalls,
									functionCallWarningThreshold: settings.functionCallWarningThreshold,
								},
								disableTools: !toolsEnabled,
								enableThinking: getThinkingToggle(),
								reasoningEffort: selectedReasoningEffort,
								traceId,
								previousInteractionId,
							}
						);

					for await (const chunk of chunkStream) {
						// Check if stopped
						if (abortController.signal.aborted) {
							stopped = true;
							break;
						}

						accumulateStreamChunk(stream, chunk);
						recordToolActivity(chunk);
						if (isActive()) {
							if (chunk.type === "text") setStreamingContent(stream.text);
							else if (chunk.type === "thinking") setStreamingThinking(stream.thinking);
						}
					}

					// rag_search runs as a tool mid-stream and appends its hits here.
					for (const source of localRagSources) {
						if (!stream.ragSources.includes(source)) stream.ragSources.push(source);
					}
					let fullContent = stream.text;

					// If stopped, add partial message if any content was received
					if (stopped && fullContent) {
						fullContent += `\n\n${t("chat.generationStopped")}`;
					}

					// Add assistant message
					const baseAssistantMessage: Message = {
						role: "assistant",
						content: fullContent,
						timestamp: Date.now(),
						model: allowedModel,
						toolsUsed: stream.toolsUsed.length > 0 ? stream.toolsUsed : undefined,
						skillsUsed: skillsUsedNames.length > 0 ? skillsUsedNames : undefined,
						// Processed edit/delete/rename info from the tool executor
						// (already confirmed during tool execution).
						...pendingStatusFields({ edits: processedEdits, deletes: processedDeletes, renames: processedRenames }),
						toolCalls: stream.toolCalls.length > 0 ? stream.toolCalls : undefined,
						toolResults: stream.toolResults.length > 0 ? stream.toolResults : undefined,
						ragUsed: stream.ragUsed || undefined,
						ragSources: stream.ragSources.length > 0 ? stream.ragSources : undefined,
						webSearchUsed: stream.webSearchUsed || undefined,
						webSearchSources: stream.webSearchSources.length > 0 ? stream.webSearchSources : undefined,
						imageGenerationUsed: stream.imageGenerationUsed || undefined,
						generatedImages: stream.generatedImages.length > 0 ? stream.generatedImages : undefined,
						thinking: stream.thinking || undefined,
						mcpApps: collectedMcpApps.length > 0 ? collectedMcpApps : undefined,
						usage: stream.usage,
						interactionId: stream.interactionId,
						elapsedMs: Date.now() - startTime,
					};

					result = {
						message: groundedPrompt ? attachGroundedEvidence(baseAssistantMessage, groundedPrompt.evidence) : withSearchEvidence(baseAssistantMessage, ragSearchRunner),
						output: fullContent,
						metadata: {
							toolsUsed: stream.toolsUsed.length > 0 ? stream.toolsUsed : undefined,
							ragUsed: stream.ragUsed,
							ragSources: stream.ragSources.length > 0 ? stream.ragSources : undefined,
							webSearchUsed: stream.webSearchUsed,
							imageGenerationUsed: stream.imageGenerationUsed,
							stopped,
						},
						status: {
							value: stopped ? 0.5 : 1,
							comment: stopped ? "stopped by user" : "completed",
						},
					};
				};

				const outcome = await withRateLimitRetry(runStreamOnce, {
					delays: PAID_RATE_LIMIT_RETRY_DELAYS_MS,
					isAborted: () => abortController.signal.aborted,
					onRetry: ({ attempt, total, delayMs }) => {
						// The failed attempt left partial output on screen.
						if (isActive()) {
							setStreamingContent("");
							setStreamingThinking("");
						}
						new Notice(t("chat.rateLimitRetrying", {
							seconds: String(Math.ceil(delayMs / 1000)),
							attempt: String(attempt),
							max: String(total),
						}));
					},
				});
				if (outcome === "aborted") {
					// The abandoned attempt left partial output on screen.
					if (isActive()) {
						setStreamingContent("");
						setStreamingThinking("");
					}
					return {
						message: null,
						metadata: { status: "aborted" },
						status: { value: 0.5, comment: "aborted during retry" },
					};
				}
				return result ?? { message: null };
				};
				return grounded ? runGroundedTurn(turn, resolvedContent, runWithPrompt, accept,
					{ endpoint: providerConfig?.baseUrl || OFFICIAL_GEMINI_EMBEDDING_ORIGIN, model: allowedModel }) : runWithPrompt();
			},

			// "Request changes" in the edit confirmation modal: send the feedback
			// back to the model now that this turn is saved.
			onSaved: () => {
				const requestInfo = takeEditFeedback?.();
				if (requestInfo) setPendingEditFeedback(requestInfo);
			},

			onSettled: async (turn) => {
				// The stream owns the executor once it is backgrounded.
				if (turn.isActive() || !mcpCleanupRef.executor) return;
				try {
					await mcpCleanupRef.executor.cleanup();
				} catch (e) {
					console.warn("Background MCP cleanup failed:", e);
				}
			},
		});
	};

	// Stop message generation
	const stopMessage = () => {
		setToolActivityState(previous => previous && previous.sessionId === activeSessionIdRef.current
			? cancelToolActivities(previous, previous) : previous);
		if (abortControllerRef.current) {
			abortControllerRef.current.abort();
		}
		if (groundedRetrievalRef.current === abortControllerRef.current && groundedRetrievalRef.current) return;
		// Always reset loading state to ensure user can continue
		// even if abort signal is not properly handled by the stream
		setIsLoading(false);
		abortControllerRef.current = null;
	};

	// Compact/compress conversation history
	// Saves current chat as-is, then starts a new chat with the summary as context
	const handleCompact = async () => {
		if (messages.length < 2 || isLoading || isCompacting) return;

		// CLI mode and Local LLM mode do not support compact (requires Gemini).
		// `isCliMode` excludes tools-capable Local LLMs now, so check the
		// underlying mode flags directly to keep compact blocked for them too.
		if (isCliMode || isLocalLlmMode) {
			new Notice(t("chat.compactNotAvailable"));
			return;
		}

		const client = getGeminiClient();
		if (!client) {
			new Notice(t("chat.clientNotInitialized"));
			return;
		}

		setIsCompacting(true);

		try {
			// Save current chat first (preserves full history)
			await saveCurrentChat(messages, { session: cliSession });

			// Build conversation text for summarization
			const conversationText = messages.map(msg => {
				const role = msg.role === "user" ? "User" : "Assistant";
				return `${role}: ${msg.content}`;
			}).join("\n\n");

			// Create summarization request
			const summaryPrompt: Message = {
				role: "user",
				content: `Summarize the following conversation concisely. Preserve key information, decisions, file paths, and context that would be needed to continue the conversation. Output the summary in the same language as the conversation.\n\n---\n${conversationText}\n---`,
				timestamp: Date.now(),
			};

			const compactTraceId = tracing.traceStart("chat-compact", {
				sessionId: currentChatId ?? undefined,
				input: `Compacting ${messages.length} messages`,
				metadata: { messageCount: messages.length, pluginVersion: plugin.manifest.version },
			});
			const summary = await client.chat([summaryPrompt], "You are a conversation summarizer. Output only the summary without any preamble.", compactTraceId);

			if (!summary.trim()) {
				tracing.traceEnd(compactTraceId, { metadata: { error: "empty summary" } });
				tracing.score(compactTraceId, { name: "status", value: 0, comment: "empty summary" });
				new Notice(t("chat.compactFailed"));
				return;
			}

			tracing.traceEnd(compactTraceId, { output: summary });
			tracing.score(compactTraceId, { name: "status", value: 1, comment: "completed" });

			// Start a new chat with user's compact request and AI's summary
			const now = Date.now();
			const userMessage: Message = {
				role: "user",
				content: "/compact",
				timestamp: now,
			};
			const compactedMessage: Message = {
				role: "assistant",
				content: `[${t("chat.compactedContext")}]\n\n${summary}`,
				timestamp: now + 1,
			};

			const newMessages = [userMessage, compactedMessage];
			const newChatId = generateChatId();
			setCurrentChatId(newChatId);
			selectComposerHistory(newChatId);
			setCliSession(null);
			// Terminate persistent CLI session on compact (new chat context)
			if (persistentCliRef.current) {
				persistentCliRef.current.terminate();
				persistentCliRef.current = null;
			}
			setMessages(newMessages);

			// Save as a new chat with explicit new ID (avoids stale closure of currentChatId)
			await saveCurrentChat(newMessages, { chatId: newChatId });

			new Notice(t("chat.compacted", { before: String(messages.length), after: "2" }));
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : t("chat.unknownError");
			new Notice(t("chat.compactFailed") + ": " + errorMsg);
		} finally {
			setIsCompacting(false);
		}
	};

	// Handle apply edit button click
	const handleApplyEdit = async (messageIndex: number) => {
		try {
			const result = await applyEdit(plugin.app, { openFile: getOpenFileAfterApplyPreference(plugin.app) });

			if (result.success) {
				// Update message status
				setMessages((prev) => {
					const newMessages = [...prev];
					const pendingEdit = newMessages[messageIndex].pendingEdit;
					if (pendingEdit) {
						newMessages[messageIndex] = {
							...newMessages[messageIndex],
							pendingEdit: {
								...pendingEdit,
								status: "applied",
							},
						};
					}
					return newMessages;
				});
				new Notice(result.message || t("message.appliedChanges"));
			} else {
				new Notice(result.error || t("message.applyChanges"));
			}
		} catch {
			new Notice(t("message.applyChanges"));
		}
	};

	// Handle discard edit button click
	const handleDiscardEdit = (messageIndex: number) => {
		try {
			const result = discardEdit(plugin.app);

			if (result.success) {
				// Update message status
				setMessages((prev) => {
					const newMessages = [...prev];
					const pendingEdit = newMessages[messageIndex].pendingEdit;
					if (pendingEdit) {
						newMessages[messageIndex] = {
							...newMessages[messageIndex],
							pendingEdit: {
								...pendingEdit,
								status: "discarded",
							},
						};
					}
					return newMessages;
				});
				new Notice(result.message || t("message.discardedChanges"));
			} else {
				new Notice(result.error || t("message.discardChanges"));
			}
		} catch {
			new Notice(t("message.discardChanges"));
		}
	};

	const handleOpenDashboard = useCallback(() => {
		if (!currentDashboard) return;
		void plugin.app.workspace.getLeaf(true).openFile(currentDashboard);
	}, [plugin, currentDashboard]);

	const handleCreateDashboard = useCallback(() => {
		void promptForValue(plugin.app, t("chat.dashboardCreateNamePrompt"), "Dashboard", false).then((name) => {
			if (name === null) return;
			void plugin.createDashboard(name).then((file) => {
				if (file) {
					setCurrentDashboard(file);
					return;
				}
				window.setTimeout(() => {
					const activeFile = plugin.app.workspace.getActiveFile();
					if (activeFile?.extension === "dashboard") {
						setCurrentDashboard(activeFile);
					}
				}, 100);
			});
		});
	}, [plugin]);

	const handleAskLlmHubHelp = useCallback(() => {
		const builtinOkfBundle = getBuiltinOkfBundle();
		setActiveOkfBundleIds(prev =>
			prev.includes(builtinOkfBundle.id) ? prev : [...prev, builtinOkfBundle.id]
		);
		inputAreaRef.current?.setInputValue(t("chat.helpQuestionDraft"));
		inputAreaRef.current?.focus();
	}, []);

	return (
		<ChatLayout classPrefix="llm-hub" modifiers={[isKeyboardVisible && "keyboard-visible", isDecryptInputFocused && "decrypt-input-focused"]}>
			<ChatHeader classPrefix="llm-hub">
					<SidebarWidthButton
						classPrefix="llm-hub"
						wide={isSidebarWide}
						title={isSidebarWide ? t("chat.narrowSidebar") : t("chat.widenSidebar")}
						onClick={() => setIsSidebarWide(onToggleSidebarWidth())}
					/>
					<SaveNoteButton
						classPrefix="llm-hub"
						state={saveNoteState}
						disabled={messages.length === 0}
						title={saveNoteState === "saved" ? t("chat.savedAsNote", { path: "" }) : t("chat.saveAsNote")}
						onClick={() => { void saveAsNote(messages); }}
					/>
					<HeaderButton classPrefix="llm-hub" title={t("chat.newChat")} onClick={startNewChat}>
						<Plus size={16} />
					</HeaderButton>
					<HeaderButton classPrefix="llm-hub" title={t("chat.chatHistory")} onClick={() => setShowHistory(!showHistory)}>
						<History size={16} />
					</HeaderButton>
				</ChatHeader>

			{showHistory && <HistoryList classPrefix="llm-hub"
        entries={chatHistories.map(history => ({ ...history, dateLabel: formatHistoryDate(history.updatedAt), encrypted: history.isEncrypted }))}
        currentId={currentChatId} emptyLabel={t("chat.noChatHistory")} deleteLabel={t("common.delete")}
        onSelect={history => { void loadChat(history); }}
        onDelete={(history, event) => { void deleteChat(history.id, event); }}
        panel deleteIcon={<Trash2 size={12} />} lockIcon={<Lock size={14} className="llm-hub-lock-icon" />}
        renderExtra={history => (decryptingChatId === history.id && (
								<div className="llm-hub-decrypt-form">
									<input
										type="password"
										placeholder={t("chat.decryptPassword.placeholder")}
										value={decryptPassword}
										onChange={(e) => setDecryptPassword(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && decryptPassword) {
												void decryptAndLoadChat(history.id, decryptPassword);
											}
										}}
									/>
									<button
										onClick={() => {
											if (decryptPassword) {
												void decryptAndLoadChat(history.id, decryptPassword);
											}
										}}
									>
										{t("chat.decrypt")}
									</button>
									<button
										onClick={() => {
											setDecryptingChatId(null);
											setDecryptPassword("");
										}}
										title={t("common.cancel")}
										className="llm-hub-decrypt-cancel"
									>
										×
									</button>
								</div>
							))}
      />}

			{isConfigReady ? (
				<>
					{isNativeCliTerminalMode ? (
						<CliTerminalPanel
							plugin={plugin}
							provider="claude-cli"
							availableModels={availableModels}
							onModelChange={handleModelChange}
							onBackToChat={handleBackToChat}
						/>
					) : (
						<>
							<MessageList
								ref={messagesContainerRef}
                conversationKey={currentChatId ?? String(activeSessionIdRef.current)}
                conversationTitle={chatHistories.find(history => history.id === currentChatId)?.title}
								messages={messages}
								streamingContent={streamingContent}
								streamingThinking={streamingThinking}
								isLoading={isLoading}
								groundedSearching={isLoading && groundedSearchSession === activeSessionIdRef.current}
								toolActivities={toolActivityState?.sessionId === activeSessionIdRef.current
									&& (isLoading || toolActivityState.items.some(item => item.status === "cancelled"))
									? toolActivityState.items : []}
								onApplyEdit={handleApplyEdit}
							onDiscardEdit={handleDiscardEdit}
							app={plugin.app}
							localLlmConfigs={plugin.settings.localLlmConfigs}
                availableModels={availableModels}
							skillsFolder={plugin.settings.skillsFolder}
							currentDashboard={currentDashboard ? {
								basename: currentDashboard.basename,
								path: currentDashboard.path,
							} : null}
							onOpenDashboard={currentDashboard ? handleOpenDashboard : undefined}
							onCreateDashboard={handleCreateDashboard}
							onAskLlmHubHelp={handleAskLlmHubHelp}
							fileSkill={editorFileSkill}
						/>

							<InputArea
								conversationKey={composerConversationKey}
								ref={inputAreaRef}
								onSend={sendMessage}
								onStop={stopMessage}
								isLoading={isLoading}
								model={currentModel}
								onModelChange={handleModelChange}
								availableModels={availableModels}
								codexModels={codexModels}
								codexModel={cliConfig.codexCliModel}
								codexReasoningEffort={cliConfig.codexCliReasoningEffort || "low"}
								onCodexConfigChange={handleCodexConfigChange}
								reasoningEffort={selectedReasoningEffort}
								reasoningEffortOptions={reasoningEffortOptions}
								onReasoningEffortChange={(effort) => {
									setReasoningEffortByModel(previous => {
										const next = { ...previous };
										if (effort === "default") delete next[currentModel];
										else next[currentModel] = effort;
										plugin.workspaceState.reasoningEffortByModel = next;
										void plugin.saveWorkspaceState();
										return next;
									});
								}}
								allowWebSearch={allowWebSearch}
								webSearchEnabled={webSearchEnabled}
								ragEnabled={allowRag}
								ragSettings={allowRag ? ragSettingNames : []}
								selectedRagSetting={selectedRagSetting}
								groundedMode={groundedMode}
								groundedAvailable={groundedModelAvailable}
								groundedStatus={groundedMode && webSearchEnabled ? t('chat.grounded.searchConflict')
									: groundedProblem?.session === activeSessionIdRef.current ? groundedProblem.message : undefined}
								onGroundedModeChange={setGroundedMode}
								onRecallGroundedQuestion={messages.some(message => message.role === "user") ? () => {
									const previous = [...messages].reverse().find(message => message.role === "user");
									if (inputAreaRef.current?.getInputValue().trim()) { new Notice(t("input.grounded.draftNotEmpty")); return; }
									if (previous) { inputAreaRef.current?.setInputValue(previous.content); if (previous.attachments?.length) inputAreaRef.current?.addAttachments(previous.attachments); inputAreaRef.current?.focus(); }
								} : undefined}
								onSearchSelectionChange={handleSearchSelectionChange}
								vaultToolMode={vaultToolMode}
								onVaultToolModeChange={handleVaultToolModeChange}
								vaultToolModeOnlyNone={isVaultToolRestrictedCliMode}
								vaultToolDiagnostics={vaultToolDiagnostics}
								maxPreviousMessages={maxPreviousMessages}
								onMaxPreviousMessagesChange={(count) => {
									setMaxPreviousMessages(count);
									plugin.workspaceState.maxPreviousMessages = count;
									void plugin.saveWorkspaceState();
								}}
								inputHistory={sentPromptHistory}
								onInputHistoryAdd={(prompt) => {
									setSentPromptHistory(previous => {
										const next = [...previous, prompt].slice(-100);
										plugin.workspaceState.sentPromptHistory = next;
										void plugin.saveWorkspaceState();
										return next;
									});
								}}
								voiceChatSettings={voiceChatSettings}
								voiceConversation={voiceConversation}
								onAutoReadAloudChange={handleAutoReadAloudChange}
								onReadAloudRateChange={handleReadAloudRateChange}
								mcpServers={mcpServers}
								onMcpServerToggle={handleMcpServerToggle}
								slashCommands={plugin.settings.slashCommands}
								onSlashCommand={handleSlashCommand}
								availableSkills={availableSkills}
								activeSkillPaths={activeSkillPaths}
								onToggleSkill={(folderPath) => {
									setActiveSkillPaths(prev =>
										prev.includes(folderPath)
											? prev.filter(p => p !== folderPath)
											: [...prev, folderPath]
									);
								}}
								okfBundles={okfBundles}
								activeOkfBundleIds={activeOkfBundleIds}
								onToggleOkfBundle={handleToggleOkfBundle}
								onCompact={() => { void handleCompact(); }}
								messageCount={messages.length}
								isCompacting={isCompacting}
								vaultFiles={vaultFiles}
								hasSelection={hasSelection}
								app={plugin.app}
							/>
						</>
					)}
				</>
			) : (
				<div className="llm-hub-config-required">
					<div className="llm-hub-config-message">
						<h4>{t("chat.configRequired")}</h4>
						<p>{t("chat.configRequiredDesc")}</p>
						<ul>
							<li><strong>{t("chat.configApiKey")}</strong> - {t("chat.configApiKeyDesc")}</li>
							<li><strong>{t("chat.configGeminiCli")}</strong> - {t("chat.configGeminiCliDesc")}</li>
							<li><strong>{t("chat.configClaudeCli")}</strong> - {t("chat.configClaudeCliDesc")}</li>
							<li><strong>{t("chat.configLocalLlm")}</strong> - {t("chat.configLocalLlmDesc")}</li>
						</ul>
						<p>{t("chat.openSettings")}</p>
					</div>
				</div>
			)}
		</ChatLayout>
	);
});

Chat.displayName = "Chat";

/**
 * Maximum number of marker-driven agent iterations for CLI / Local-LLM paths.
 * Protects against infinite loops where the model keeps emitting markers.
 */
const MAX_MARKER_AGENT_ITERATIONS = 5;

/**
 * Detect [RUN_WORKFLOW] / [RUN_SCRIPT] markers in an LLM response, execute
 * each matched workflow/script, and return both:
 *   - processedContent: the response with markers replaced by result blocks
 *     (for display in the assistant message), and
 *   - followUpMessage: a user-style message containing the results that can
 *     be fed back to the LLM so it can continue based on tool outputs.
 *     Undefined when no markers were matched — the agent loop should then
 *     terminate.
 */
async function processSkillMarkers(
	plugin: LlmHubPlugin,
	content: string,
	skills: LoadedSkill[],
	signal?: AbortSignal,
	options?: {
		vaultToolAllowedFolders?: string[];
	},
): Promise<{ processedContent: string; followUpMessage?: string; aborted?: boolean }> {
	if (skills.length === 0) return { processedContent: content };

	let processedContent = content;
	const resultSections: string[] = [];

	const readSkillMarkerRegex = /\[READ_SKILL:\s*(.+?)\]/g;
	const readSkillMatches: RegExpExecArray[] = [];
	let rsm: RegExpExecArray | null;
	while ((rsm = readSkillMarkerRegex.exec(content)) !== null) {
		readSkillMatches.push(rsm);
	}
	for (const match of readSkillMatches) {
		if (signal?.aborted) return { processedContent, aborted: true };
		const skillName = match[1].trim();
		const skill = skills.find(s => s.name === skillName);
		if (!skill) {
			const available = skills.map(s => s.name).join(", ");
			const errMsg = `Unknown skill: ${skillName}. Available: ${available}`;
			processedContent = processedContent.replace(match[0], `**Skill read failed: ${skillName}** — ${errMsg}`);
			resultSections.push(`Skill "${skillName}" read error:\n${errMsg}`);
			continue;
		}
		const loaded = await readSkillBody(plugin.app, skill);
		const body = loaded.instructions
			+ (loaded.references.length > 0 ? `\n\n### References\n\n${loaded.references.join("\n\n")}` : "");
		processedContent = processedContent.replace(match[0], `**Skill loaded: ${skillName}**`);
		resultSections.push(`Skill "${skillName}" SKILL.md:\n${body}`);
	}

	const workflowMarkerRegex = /\[RUN_WORKFLOW:\s*(.+?)\](?:\((\{[\s\S]*?\})\))?/g;
	const skillWorkflowMap = collectSkillWorkflows(skills);
	const workflowMatches: RegExpExecArray[] = [];
	let wm: RegExpExecArray | null;
	while ((wm = workflowMarkerRegex.exec(content)) !== null) {
		workflowMatches.push(wm);
	}
	for (const match of workflowMatches) {
		if (signal?.aborted) return { processedContent, aborted: true };
		const workflowId = match[1].trim();
		const variablesJson = match[2] || undefined;
		const result = await runSkillWorkflow(plugin.app, workflowId, variablesJson, skillWorkflowMap,
			{ vaultToolAllowedFolders: options?.vaultToolAllowedFolders });
		const resultText = JSON.stringify(result, null, 2);
		processedContent = processedContent.replace(match[0],
			`**Workflow executed: ${workflowId}**\n\`\`\`json\n${resultText}\n\`\`\``
		);
		resultSections.push(`Workflow "${workflowId}" result:\n\`\`\`json\n${resultText}\n\`\`\``);
	}

	const scriptMarkerRegex = /\[RUN_SCRIPT:\s*(.+?)\](?:\(([\s\S]*?)\))?/g;
	const skillScriptMap = collectSkillScripts(skills);
	const scriptMatches: RegExpExecArray[] = [];
	let sm: RegExpExecArray | null;
	while ((sm = scriptMarkerRegex.exec(content)) !== null) {
		scriptMatches.push(sm);
	}
	for (const match of scriptMatches) {
		if (signal?.aborted) return { processedContent, aborted: true };
		const scriptId = match[1].trim();
		const argsJson = match[2] || undefined;
		const result = await executeSkillScript(plugin, scriptId, argsJson, skillScriptMap);
		const resultText = JSON.stringify(result, null, 2);
		processedContent = processedContent.replace(match[0],
			`**Script executed: ${scriptId}**\n\`\`\`json\n${resultText}\n\`\`\``
		);
		resultSections.push(`Script "${scriptId}" result:\n\`\`\`json\n${resultText}\n\`\`\``);
	}

	if (resultSections.length === 0) return { processedContent };

	const followUpMessage = `Tool execution results:\n\n${resultSections.join("\n\n")}\n\nPlease continue based on these results. You may call more tools if needed, or give the user your final answer.`;
	return { processedContent, followUpMessage };
}

/**
 * Execute a skill script via child_process.spawn and return results.
 * Desktop only — returns error on mobile.
 */
async function executeSkillScript(
	plugin: LlmHubPlugin,
	scriptId: string,
	argsJson: string | undefined,
	skillScriptMap: Map<string, {
		skill: LoadedSkill;
		scriptRef: SkillScriptRef;
		vaultPath: string;
	}>,
): Promise<Record<string, unknown>> {
	const entry = skillScriptMap.get(scriptId);
	if (!entry) {
		const available = [...skillScriptMap.keys()].join(", ");
		return { error: `Unknown script ID: ${scriptId}. Available: ${available}` };
	}

	// Restrict execution to files under the skill's scripts/ directory
	if (
		!entry.scriptRef.path.startsWith("scripts/") ||
		entry.scriptRef.path.startsWith("/") ||
		entry.scriptRef.path.includes("\\") ||
		entry.scriptRef.path.split("/").includes("..")
	) {
		return { error: "Skill scripts must be located under the scripts/ directory" };
	}

	// Parse args
	let scriptArgs: string[] = [];
	if (argsJson) {
		try {
			const parsed = JSON.parse(argsJson) as unknown;
			if (Array.isArray(parsed)) {
				scriptArgs = parsed.map(String);
			}
		} catch {
			return { error: `Invalid args JSON: ${argsJson}` };
		}
	}

	// Resolve absolute paths
	const vaultBasePath = (plugin.app.vault.adapter as { basePath?: string }).basePath || ".";
	const absoluteScriptPath = `${vaultBasePath}/${entry.vaultPath}`;
	const skillDir = `${vaultBasePath}/${entry.skill.folderPath}`;
	const scriptFile = plugin.app.vault.getAbstractFileByPath(entry.vaultPath);
	if (!(scriptFile instanceof TFile)) {
		return { error: `Script file not found: ${entry.vaultPath}` };
	}

	// Determine interpreter from file extension
	const interpreter = getInterpreter(absoluteScriptPath);
	let command: string;
	let commandArgs: string[];
	if (interpreter) {
		command = interpreter.command;
		commandArgs = [...interpreter.args, ...scriptArgs];
	} else {
		command = absoluteScriptPath;
		commandArgs = scriptArgs;
	}

	const result = await runScript({
		command,
		args: commandArgs,
		cwd: skillDir,
		env: {
			SKILL_DIR: skillDir,
			VAULT_PATH: vaultBasePath,
		},
	});
	return { ...result };
}

export default Chat;
