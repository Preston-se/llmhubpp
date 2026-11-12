import {
  acceptedAttachmentTypes,
  detectComposerTrigger,
  fileToAttachment,
  isAttachmentRejection,
} from "obsidian-llm-hub-common/chat";
import type { VoiceChatSettings, VoiceConversationSession } from "obsidian-llm-hub-common/chat";
import { clampReadAloudRate, MAX_READ_ALOUD_RATE, MIN_READ_ALOUD_RATE } from "obsidian-llm-hub-common/chat";
import { CollapsedInput } from "obsidian-llm-hub-common";
import { InputArea as SharedInputArea } from "obsidian-llm-hub-common";
import { Composer, Autocomplete, VaultToolControl, EnabledMcpServers, ChipRow, ReadAloudChip, VoiceConversationChip, InputButtons, SearchSelector, ModelRow, ModelDropdown } from "obsidian-llm-hub-common";
import { useState, useRef, useEffect, type SyntheticEvent, type KeyboardEvent as ReactKeyboardEvent, ChangeEvent, forwardRef, useImperativeHandle } from "react";


import Eye from "lucide-react/dist/esm/icons/eye";

import { Notice, Platform, type App } from "obsidian";
import { isImageGenerationModel, type ModelInfo, type ModelType, type Attachment, type SlashCommand, type McpServerConfig, type SearchSelection, type VaultToolMode, type CodexReasoningEffort, type ReasoningEffort } from "src/types";
import type { CodexModelOption } from "src/core/cliProvider";

import type { SkillMetadata } from "src/core/skillsLoader";
import type { OkfBundle } from "src/core/okfLoader";
import SkillSelector from "./SkillSelector";
import OkfSelector from "./OkfSelector";
import { t } from "src/i18n";
import { isCaretOnFirstLine, isCaretOnLastLine } from "./chat/chatUtils";
import { useComposerDraft } from "./chat/useComposerDraft";
import type { VaultToolDiagnostics } from "./chat/vaultToolDiagnostics";
import ModelSelector from "./ModelSelector";
import { ChatAttachmentPreviews } from "./ChatAttachmentPreviews";

// Built-in command definition (not user-configurable)
interface BuiltInCommand {
  id: string;
  name: string;
  description: string;
  isBuiltIn: true;
}

interface InputAreaProps {
  conversationKey?: string;
  onSend: (content: string, attachments?: Attachment[], skillPath?: string, accept?: () => void) => void | boolean | Promise<void | boolean>;
  onStop?: () => void;
  isLoading: boolean;
  model: ModelType;
  onModelChange: (model: ModelType) => void;
  availableModels: ModelInfo[];
  codexModels: CodexModelOption[];
  codexModel?: string;
  codexReasoningEffort: CodexReasoningEffort;
  onCodexConfigChange: (model: string | undefined, reasoningEffort: CodexReasoningEffort) => void;
  reasoningEffort: ReasoningEffort;
  reasoningEffortOptions: ReasoningEffort[];
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  allowWebSearch: boolean;
  webSearchEnabled: boolean;
  ragEnabled: boolean;
  ragSettings: string[];
  selectedRagSetting: string | null;
  onSearchSelectionChange: (selection: SearchSelection) => void;
  vaultToolMode: VaultToolMode;
  onVaultToolModeChange: (mode: VaultToolMode) => void;
  vaultToolModeOnlyNone: boolean; // When true, only "none" option is available
  vaultToolDiagnostics: VaultToolDiagnostics;
  groundedMode?: boolean;
  groundedAvailable?: boolean;
  groundedStatus?: string;
  onGroundedModeChange?: (enabled: boolean) => void;
  onRecallGroundedQuestion?: () => void;
  maxPreviousMessages: number;
  onMaxPreviousMessagesChange: (count: number) => void;
  inputHistory: string[];
  onInputHistoryAdd: (prompt: string) => void;
  voiceChatSettings: VoiceChatSettings;
  voiceConversation: VoiceConversationSession;
  onAutoReadAloudChange: (enabled: boolean) => void;
  onReadAloudRateChange: (rate: number) => void;
  mcpServers: McpServerConfig[]; // MCP server configurations
  onMcpServerToggle: (serverName: string, enabled: boolean) => void; // Per-server toggle handler
  slashCommands: SlashCommand[];
  onSlashCommand: (command: SlashCommand) => string;
  availableSkills: SkillMetadata[];
  activeSkillPaths: string[];
  onToggleSkill: (folderPath: string) => void;
  okfBundles: OkfBundle[];
  activeOkfBundleIds: string[];
  onToggleOkfBundle: (bundleId: string) => void;
  onCompact?: () => void; // Built-in /compact command handler
  messageCount?: number; // Number of messages (to enable/disable /compact)
  isCompacting?: boolean; // Whether compact is in progress
  vaultFiles: string[];
  hasSelection: boolean;
  app: App;
}

export interface InputAreaHandle {
  setInputValue: (value: string) => void;
  getInputValue: () => string;
  focus: () => void;
  addAttachments: (attachments: Attachment[]) => void;
}

// Mention candidates (special variables + vault files)
interface MentionItem {
  value: string;
  description: string;
  kind: "variable" | "mention" | "wikilink";
}

// 対応ファイル形式

/** Least restricted first: the Vault tool button reads as inactive only on the first. */
const VAULT_TOOL_MODES = [
  { id: "all" as VaultToolMode, label: t("input.vaultToolAll"), description: t("input.vaultToolAllDesc") },
  { id: "noSearch" as VaultToolMode, label: t("input.vaultToolNoSearch"), description: t("input.vaultToolNoSearchDesc") },
  { id: "readOnly" as VaultToolMode, label: t("input.vaultToolReadOnly"), description: t("input.vaultToolReadOnlyDesc") },
  { id: "none" as VaultToolMode, label: t("input.vaultToolNone"), description: t("input.vaultToolNoneDesc") },
];

const InputArea = forwardRef<InputAreaHandle, InputAreaProps>(function InputArea({
  conversationKey = "default",
  onSend,
  onStop,
  isLoading,
  model,
  onModelChange,
  availableModels,
  codexModels,
  codexModel,
  codexReasoningEffort,
  onCodexConfigChange,
  reasoningEffort,
  reasoningEffortOptions,
  onReasoningEffortChange,
  allowWebSearch,
  webSearchEnabled,
  ragEnabled,
  ragSettings,
  selectedRagSetting,
  onSearchSelectionChange,
  vaultToolMode,
  onVaultToolModeChange,
  vaultToolModeOnlyNone,
  vaultToolDiagnostics,
  groundedMode = false,
  groundedAvailable = false,
  groundedStatus,
  onGroundedModeChange,
  onRecallGroundedQuestion,
  maxPreviousMessages,
  onMaxPreviousMessagesChange,
  inputHistory,
  onInputHistoryAdd,
  voiceChatSettings,
  voiceConversation,
  onAutoReadAloudChange,
  onReadAloudRateChange,
  mcpServers,
  onMcpServerToggle,
  slashCommands,
  onSlashCommand,
  availableSkills,
  activeSkillPaths,
  onToggleSkill,
  okfBundles,
  activeOkfBundleIds,
  onToggleOkfBundle,
  onCompact,
  messageCount = 0,
  isCompacting = false,
  vaultFiles,
  hasSelection,
  app,
}, ref) {
  const { input, setInput, pendingAttachments, addAttachments, removeAttachment,
    processingAttachments, hasActiveAttachmentRead, readAttachments, clearAcceptedDraft } = useComposerDraft(conversationKey);
  const [controlsExpanded, setControlsExpanded] = useState(false);
  const activeConversationRef = useRef(conversationKey);
  activeConversationRef.current = conversationKey;
  const boundaryRef = useRef<HTMLDivElement>(null);
  const internalEvents = useRef(new WeakSet<Event>());
  const chipTrigger = useRef<HTMLButtonElement | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isContextHidden, setIsContextHidden] = useState(false);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [filteredCommands, setFilteredCommands] = useState<(SlashCommand | BuiltInCommand)[]>([]);
  // Mention autocomplete state
  const [showMentionAutocomplete, setShowMentionAutocomplete] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [filteredMentions, setFilteredMentions] = useState<MentionItem[]>([]);
  const [mentionStartPos, setMentionStartPos] = useState(0);
  const [showVaultToolMenu, setShowVaultToolMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filePickerOwner = useRef<string | null>(null);
  const mentionAutocompleteRef = useRef<HTMLDivElement>(null);
  const vaultToolMenuRef = useRef<HTMLDivElement>(null);
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef("");

  useEffect(() => {
    historyIndexRef.current = null;
    historyDraftRef.current = "";
    setShowAutocomplete(false);
    setShowMentionAutocomplete(false);
    setShowVaultToolMenu(false);
    setControlsExpanded(false);
  }, [conversationKey]);

  useEffect(() => {
    const boundary = boundaryRef.current;
    if (!boundary) return;
    const doc = boundary.ownerDocument;
    const closeOnOutside = (event: Event) => {
      if (internalEvents.current.has(event) || event.composedPath().includes(boundary)) return;
      setControlsExpanded(false);
      setShowVaultToolMenu(false);
    };
    for (const type of ['pointerdown', 'click', 'focusin']) doc.addEventListener(type, closeOnOutside);
    return () => { for (const type of ['pointerdown', 'click', 'focusin']) doc.removeEventListener(type, closeOnOutside); };
  }, []);

  const expandInside = (event: SyntheticEvent) => {
    // React forwards events from skill and OKF portals through their owning composer.
    internalEvents.current.add(event.nativeEvent);
    const target = event.target as Element;
    if (event.type === 'click') {
      const trigger = target.closest?.<HTMLButtonElement>('.llm-hub-skill-add-btn');
      if (trigger) chipTrigger.current = trigger;
    }
    if (!target.closest?.('.llm-hub-input-detail-toggle')) setControlsExpanded(true);
  };

  const closeWithEscape = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const trigger = chipTrigger.current;
    if (trigger?.isConnected && trigger.ownerDocument.querySelector('.llm-hub-skill-dropdown')) {
      event.preventDefault();
      trigger.click();
      trigger.focus();
      return;
    }
    if (showVaultToolMenu) { setShowVaultToolMenu(false); return; }
    setControlsExpanded(false);
    if (event.target !== textareaRef.current) boundaryRef.current?.querySelector<HTMLButtonElement>('.llm-hub-input-detail-toggle')?.focus();
  };

  // Scroll to selected mention item
  useEffect(() => {
    if (showMentionAutocomplete && mentionAutocompleteRef.current) {
      const container = mentionAutocompleteRef.current;
      const activeItem = container.children[mentionIndex] as HTMLElement;
      if (activeItem) {
        activeItem.scrollIntoView({ block: "nearest" });
      }
    }
  }, [mentionIndex, showMentionAutocomplete]);

  // Close vault tool menu when clicking outside
  useEffect(() => {
    if (!showVaultToolMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (vaultToolMenuRef.current && !vaultToolMenuRef.current.contains(e.target as Node)) {
        setShowVaultToolMenu(false);
      }
    };
    activeDocument.addEventListener("mousedown", handleClickOutside);
    return () => activeDocument.removeEventListener("mousedown", handleClickOutside);
  }, [showVaultToolMenu]);

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    setInputValue: (value: string) => setInput(value),
    getInputValue: () => input,
    focus: () => textareaRef.current?.focus(),
    addAttachments: (attachments: Attachment[]) => addAttachments(attachments),
  }));

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      // Use Obsidian's setCssProps for dynamic height adjustment
      textarea.setCssProps({ height: "auto" });
      const height = `${Math.min(textarea.scrollHeight, 200)}px`;
      textarea.setCssProps({ height });
    }
  }, [input]);

  // Build mention candidates
  const buildMentionCandidates = (query: string): MentionItem[] => {
    const hasActiveNote = !!app.workspace.getActiveFile();
    const variables: MentionItem[] = [
      // Only show {selection} if there's an active selection
      ...(hasSelection ? [{ value: "{selection}", description: t("input.selectionVariable"), kind: "variable" as const }] : []),
      // Only show {content} if there's an active note
      ...(hasActiveNote ? [{ value: "{content}", description: t("input.contentVariable"), kind: "variable" as const }] : []),
    ];
    const files: MentionItem[] = vaultFiles.map((f) => ({
      value: f,
      description: t("input.vaultFile"),
      kind: "mention",
    }));
    const all = [...variables, ...files];
    if (!query) return all.slice(0, 10);
    const lowerQuery = query.toLowerCase();
    return all.filter((item) => item.value.toLowerCase().includes(lowerQuery)).slice(0, 10);
  };

  const buildWikilinkCandidates = (query: string): MentionItem[] => {
    const lowerQuery = query.toLowerCase();
    return vaultFiles
      .filter((file) => !lowerQuery || file.toLowerCase().includes(lowerQuery))
      .slice(0, 10)
      .map((file) => ({
        value: file,
        description: t("input.vaultFile"),
        kind: "wikilink" as const,
      }));
  };

  const sendDraft = (content: string, historyText: string, skillPath?: string, submittedInput = input) => {
    if (hasActiveAttachmentRead()) return;
    let accepted = false;
    const accept = () => {
      if (accepted) return;
      accepted = true;
      if (historyText.trim()) onInputHistoryAdd(historyText);
      if (activeConversationRef.current === conversationKey) {
        historyIndexRef.current = null;
        historyDraftRef.current = "";
      }
      clearAcceptedDraft(submittedInput, pendingAttachments);
    };
    const outcome = onSend(content, pendingAttachments.length > 0 ? pendingAttachments : undefined, skillPath, accept);
    if (outcome && typeof outcome === "object") return outcome.then(result => { if (result !== false) accept(); });
    if (outcome !== false) accept();
  };

  const handleSubmit = () => {
    if (hasActiveAttachmentRead()) return;
    if ((input.trim() || pendingAttachments.length > 0) && !isLoading) {
      // Intercept /compact command
      if (input.trim() === "/compact" && onCompact) {
        if (messageCount >= 2) {
          setInput("");
          onCompact();
        }
        return;
      }
      // Intercept /skillFolder command — send with skill path as metadata
      if (input.trim().startsWith("/")) {
        const trimmed = input.trim();
        for (const skill of availableSkills) {
          const folderName = skill.folderPath.split("/").pop() || "";
          const prefix = `/${folderName}`;
          if (trimmed.toLowerCase().startsWith(prefix.toLowerCase()) &&
              (trimmed.length === prefix.length || trimmed[prefix.length] === " ")) {
            const userMessage = trimmed.slice(prefix.length).trim();
            return sendDraft(userMessage, input, skill.folderPath);
          }
        }
      }
      return sendDraft(input, input);
    }
  };

  // Text from a popup opened for a conversation that has since ended, or one
  // that answered while a turn was still running: keep the words at the caret
  // instead of sending them.
  const insertDictation = (text: string) => {
    const caret = textareaRef.current?.selectionStart ?? input.length;
    const end = textareaRef.current?.selectionEnd ?? caret;
    const before = input.slice(0, caret);
    const separator = before && !/\s$/.test(before) ? " " : "";
    const next = before + separator + text + input.slice(end);
    setInput(next);
    const position = before.length + separator.length + text.length;
    textareaRef.current?.setSelectionRange(position, position);
    return next;
  };

  const handleVoiceSubmit = (content: string) => {
    if (!content.trim() || isLoading) return;
    if (hasActiveAttachmentRead()) { insertDictation(content); return; }
    const submitted = input === content ? input : insertDictation(content);
    return sendDraft(content, content, undefined, submitted);
  };

  const handleInputChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;
    setInput(value);
    historyIndexRef.current = null;

    // Check for slash command trigger (only at start of input)
    if (value.startsWith("/")) {
      const query = value.slice(1).toLowerCase();

      // Build built-in commands list
      const builtInCommands: BuiltInCommand[] = [];
      if (onCompact && messageCount >= 2) {
        builtInCommands.push({
          id: "__compact__",
          name: "compact",
          description: t("command.compact"),
          isBuiltIn: true,
        });
      }

      // Add all skills as built-in commands (use folder name as command name)
      for (const skill of availableSkills) {
        const folderName = skill.folderPath.split("/").pop() || "";
        builtInCommands.push({
          id: `__skill__${skill.folderPath}`,
          name: folderName,
          description: `${skill.name}${skill.description ? ` - ${skill.description}` : ""}`,
          isBuiltIn: true,
        });
      }

      // Filter both user-defined and built-in commands
      const userMatches = slashCommands.filter((cmd) =>
        cmd.name.toLowerCase().startsWith(query)
      );
      const builtInMatches = builtInCommands.filter((cmd) =>
        cmd.name.toLowerCase().startsWith(query)
      );
      const matches: (SlashCommand | BuiltInCommand)[] = [...userMatches, ...builtInMatches];
      setFilteredCommands(matches);
      setShowAutocomplete(matches.length > 0);
      setAutocompleteIndex(0);
      setShowMentionAutocomplete(false);
      return;
    } else {
      setShowAutocomplete(false);
    }

    // Which menu the text calls for is decided in the shared library, so the
    // three plugins cannot disagree about when one opens.
    const trigger = detectComposerTrigger(value, cursorPos);
    if (trigger && trigger.kind !== "command") {
      const mentions = trigger.kind === "wikilink"
        ? buildWikilinkCandidates(trigger.query)
        : buildMentionCandidates(trigger.query);
      setFilteredMentions(mentions);
      setMentionStartPos(trigger.startPos);
      setShowMentionAutocomplete(mentions.length > 0);
      setMentionIndex(0);
      return;
    }
    setShowMentionAutocomplete(false);
  };

  const selectCommand = (command: SlashCommand | BuiltInCommand) => {
    setShowAutocomplete(false);
    if ("isBuiltIn" in command && command.isBuiltIn) {
      // Handle built-in commands
      if (command.id === "__compact__" && onCompact) {
        setInput("");
        onCompact();
      }
      // Handle skill — send immediately with skill path
      if (command.id.startsWith("__skill__")) {
        const folderPath = command.id.slice("__skill__".length);
        const userMessage = input.replace(/^\/\S*\s*/, "").trim();
        void sendDraft(userMessage, input, folderPath);
      }
      return;
    }
    const resolvedPrompt = onSlashCommand(command as SlashCommand);
    setInput(resolvedPrompt);
    textareaRef.current?.focus();
  };

  const selectMention = (mention: MentionItem) => {
    // Replace @query with the selected mention value
    const cursorPos = textareaRef.current?.selectionStart || input.length;
    const before = input.substring(0, mentionStartPos);
    const after = input.substring(cursorPos);
    const inserted = mention.kind === "wikilink" ? `[[${mention.value}]]` : `${mention.value} `;
    const newInput = before + inserted + after;
    setInput(newInput);
    setShowMentionAutocomplete(false);
    // Set cursor position after the inserted mention
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.ownerDocument.defaultView?.requestAnimationFrame(() => {
      const newPos = mentionStartPos + inserted.length;
      if (textarea.ownerDocument.activeElement === textarea && activeConversationRef.current === conversationKey) textarea.setSelectionRange(newPos, newPos);
    });
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Slash command autocomplete
    if (showAutocomplete) {
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        setAutocompleteIndex((prev) =>
          Math.min(prev + 1, filteredCommands.length - 1)
        );
        return;
      }
      if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        setAutocompleteIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.nativeEvent.isComposing && filteredCommands.length > 0) {
        e.preventDefault();
        selectCommand(filteredCommands[autocompleteIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        setShowAutocomplete(false);
        return;
      }
    }

    // Mention autocomplete
    if (showMentionAutocomplete) {
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        setMentionIndex((prev) =>
          Math.min(prev + 1, filteredMentions.length - 1)
        );
        return;
      }
      if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        setMentionIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      // Ctrl+Shift+O to preview (open) the selected file
      if (e.key === "O" && e.ctrlKey && e.shiftKey && filteredMentions.length > 0) {
        e.preventDefault();
        const mention = filteredMentions[mentionIndex];
        if (mention && mention.kind !== "variable") {
          void app.workspace.openLinkText(mention.value, "", true);
        }
        return;
      }
      if (e.key === "Enter" && !e.nativeEvent.isComposing && filteredMentions.length > 0) {
        e.preventDefault();
        selectMention(filteredMentions[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        setShowMentionAutocomplete(false);
        return;
      }
    }

    // Recall sent prompts without taking arrow keys away from multiline editing.
    // Up activates on the first line; Down activates on the last line.
    if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && inputHistory.length > 0
      && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
      const caret = e.currentTarget.selectionStart;
      if (e.key === "ArrowUp" && isCaretOnFirstLine(input, caret)) {
        e.preventDefault();
        const nextIndex = historyIndexRef.current === null
          ? inputHistory.length - 1
          : Math.max(0, historyIndexRef.current - 1);
        if (historyIndexRef.current === null) historyDraftRef.current = input;
        historyIndexRef.current = nextIndex;
        setInput(inputHistory[nextIndex]);
        return;
      }
      if (e.key === "ArrowDown" && historyIndexRef.current !== null && isCaretOnLastLine(input, caret)) {
        e.preventDefault();
        const nextIndex = historyIndexRef.current + 1;
        if (nextIndex >= inputHistory.length) {
          historyIndexRef.current = null;
          setInput(historyDraftRef.current);
        } else {
          historyIndexRef.current = nextIndex;
          setInput(inputHistory[nextIndex]);
        }
        return;
      }
    }

    // IME変換中はEnterで送信しない
    // モバイルではEnterで送信しない（Shift+Enterが難しいため）
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !Platform.isMobile) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const processFile = async (file: File): Promise<Attachment | null> => {
    const result = await fileToAttachment(file);
    if (isAttachmentRejection(result)) {
      if (result.reason === "too-large") new Notice(t("input.fileTooLarge", { name: file.name }));
      return null;
    }
    return result;
  };

  const appendFiles = (files: readonly File[]) => readAttachments(files, processFile);

  const openFilePicker = () => {
    const element = fileInputRef.current;
    if (!element) return;
    filePickerOwner.current = conversationKey;
    element.click();
  };

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    // The picker can outlive the chat that opened it.
    const owner = filePickerOwner.current ?? conversationKey;
    filePickerOwner.current = null;
    const element = event.currentTarget;
    const files = Array.from(element.files ?? []);
    element.value = "";
    if (files.length) void readAttachments(files, processFile, owner);
  };

  const getAllAcceptedTypes = () => {
    return acceptedAttachmentTypes();
  };

  return (
    <div className="llm-hub-composer-boundary" ref={boundaryRef} onPointerDownCapture={expandInside} onClickCapture={expandInside}
      onFocusCapture={expandInside} onKeyDown={closeWithEscape}>
    <SharedInputArea classPrefix="llm-hub" modifiers={[isCollapsed && "collapsed", controlsExpanded && "llm-hub-controls-expanded"]} collapsed={isCollapsed}
      beforeInput={<>
      <div className="llm-hub-input-details" aria-hidden={!controlsExpanded} ref={element => { if (element) element.inert = !controlsExpanded; }}>
      <div>
      {!isCollapsed && <div className="llm-hub-grounded-mode">
        <label><input type="checkbox" checked={groundedMode} disabled={isLoading}
          onChange={event => onGroundedModeChange?.(event.target.checked)} /> {t("input.grounded.title")}</label>
        {groundedMode && <div>
          <span>{selectedRagSetting || t("input.grounded.selectIndex")}</span> · {t("input.grounded.toolsDisabled")}
          {!groundedAvailable && <div>{t("input.grounded.remoteRequired")}</div>}
          {groundedStatus && <div>{groundedStatus}</div>}
          {onRecallGroundedQuestion && <button type="button" onClick={onRecallGroundedQuestion} disabled={isLoading}>{t("input.grounded.recallQuestion")}</button>}
        </div>}
      </div>}
      {!isCollapsed && <details className="llm-hub-vault-status">
        <summary>{t("input.vaultStatus.title")}: {t({
          all: "input.vaultToolAll",
          noSearch: "input.vaultToolNoSearch",
          readOnly: "input.vaultToolReadOnly",
          none: "input.vaultToolNone",
        }[vaultToolDiagnostics.effectiveMode] as Parameters<typeof t>[0])}</summary>
        <div>{t("input.vaultStatus.desired")}: {t({
          all: "input.vaultToolAll",
          noSearch: "input.vaultToolNoSearch",
          readOnly: "input.vaultToolReadOnly",
          none: "input.vaultToolNone",
        }[vaultToolDiagnostics.desiredMode] as Parameters<typeof t>[0])}</div>
        {vaultToolDiagnostics.reason === "model" && <div>{t("input.vaultStatus.modelRestricted")}</div>}
        {vaultToolDiagnostics.reason === "model" && vaultToolDiagnostics.modelDetail === "native-ollama" && <div>{t("input.vaultStatus.nativeOllama")}</div>}
        {vaultToolDiagnostics.reason === "model" && vaultToolDiagnostics.modelDetail === "auto-disabled" && <div>{t("input.vaultStatus.autoDisabled")}</div>}
        {vaultToolDiagnostics.reason === "search-conflict" && <div>{t("input.vaultStatus.searchConflict")}</div>}
        <div>{t("input.vaultStatus.scope")}: {vaultToolDiagnostics.scope === "folders"
          ? vaultToolDiagnostics.allowedFolders.join(", ")
          : t(vaultToolDiagnostics.scope === "whole-vault" ? "input.vaultStatus.wholeVault" : "input.vaultStatus.scopeNotEnforced")}</div>
        <div>{t(vaultToolDiagnostics.proxyReadOnly === null ? "input.vaultStatus.proxyUnavailable"
          : vaultToolDiagnostics.proxyReadOnly ? "input.vaultStatus.proxyReadOnly" : "input.vaultStatus.proxyNotReadOnly")}</div>
      </details>}
      </div>
      </div>
      <ChipRow classPrefix="llm-hub">
        {/* Reading aloud stays visible outside the transcript while it is on */}
        {!isCollapsed && !isContextHidden && voiceChatSettings.autoReadAloud && <ReadAloudChip
          classPrefix="llm-hub"
          label={t("input.readAloudChip")}
          removeTitle={t("input.readAloudChipOff")}
          onDisable={() => onAutoReadAloudChange(false)}
        />}

        {!isCollapsed && !isContextHidden && voiceConversation.active && <VoiceConversationChip
          classPrefix="llm-hub"
          label={t("input.voiceConversationChip")}
          removeTitle={t("input.voiceConversationEnd")}
          onEnd={voiceConversation.end}
        />}

        {/* MCP servers enabled for this chat */}
        {!isCollapsed && !isContextHidden && (
          <EnabledMcpServers
            classPrefix="llm-hub"
            disabled={isLoading || vaultToolModeOnlyNone}
            onDisable={(id) => onMcpServerToggle(id, false)}
            servers={mcpServers.filter((server) => server.enabled).map((server) => ({
              id: server.name,
              name: server.name,
              title: t("input.mcpServerEnabled", { name: server.name }),
              removeTitle: t("input.mcpServerDisable", { name: server.name }),
            }))}
          />
        )}
      </ChipRow>

      {/* Pending attachments display */}
      {!isCollapsed && pendingAttachments.length > 0 && (
        <ChatAttachmentPreviews attachments={pendingAttachments} app={app} onRemove={removeAttachment} />
      )}

      </>}
      accessories={<>
          {/* Slash command autocomplete */}
          {showAutocomplete && (
          <Autocomplete classPrefix="llm-hub"
            items={filteredCommands.map(cmd => ({ id: cmd.id, label: "id" in cmd && (cmd as BuiltInCommand).id?.startsWith("__skill__") ? `✨ /${cmd.name}` : `/${cmd.name}`, description: "description" in cmd ? cmd.description : undefined }))}
            activeIndex={autocompleteIndex} onSelect={index => selectCommand(filteredCommands[index])} onHover={setAutocompleteIndex} />
        )}

        {/* Mention autocomplete */}
        {showMentionAutocomplete && (
          <Autocomplete classPrefix="llm-hub" containerRef={mentionAutocompleteRef}
            items={filteredMentions.map(mention => ({ id: mention.value, label: mention.kind === "wikilink" ? `[[${mention.value}]]` : mention.value, description: mention.description, action: mention.kind !== "variable" ? (<button
                    className="llm-hub-preview-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      void app.workspace.openLinkText(mention.value, "", true);
                    }}
                    title={t("input.openFile")}
                  >
                    <Eye size={12} />
                  </button>) : undefined }))}
            activeIndex={mentionIndex} onSelect={index => selectMention(filteredMentions[index])} onHover={setMentionIndex} />
        )}

        <InputButtons
          classPrefix="llm-hub"
          attach={{
            title: t("input.attach"),
            accept: getAllAcceptedTypes(),
            inputRef: fileInputRef,
            disabled: isLoading,
            onOpenPicker: openFilePicker,
            onSelect: handleFileSelect,
          }}
        >

          <VaultToolControl<VaultToolMode>
            classPrefix="llm-hub"
            containerRef={vaultToolMenuRef}
            title={t("input.vaultToolTitle")}
            open={showVaultToolMenu}
            onToggle={setShowVaultToolMenu}
            disabled={isLoading || isImageGenerationModel(model)}
            modes={VAULT_TOOL_MODES}
            mode={vaultToolMode}
            onModeChange={onVaultToolModeChange}
            lockedTo={vaultToolModeOnlyNone ? "none" : undefined}
            mcp={{
              label: t("input.mcpServersLabel"),
              onToggle: onMcpServerToggle,
              servers: mcpServers.map((server) => {
                const toolCount = server.toolHints?.length || 0;
                return {
                  id: server.name,
                  name: server.name,
                  enabled: server.enabled,
                  hint: toolCount > 0
                    ? t("input.mcpToolHint", { count: String(toolCount), tools: server.toolHints?.slice(0, 3).join(", ") + (toolCount > 3 ? ", ..." : "") })
                    : "",
                  toolsTitle: server.toolHints?.join(", ") || "",
                };
              }),
            }}
            historyLimit={{
              label: t("input.historyLimit"),
              value: maxPreviousMessages,
              onChange: onMaxPreviousMessagesChange,
            }}
            autoReadAloud={{
              label: t("input.autoReadAloud"),
              enabled: voiceChatSettings.autoReadAloud,
              onChange: onAutoReadAloudChange,
              rate: {
                label: t("input.readAloudRate"),
                value: clampReadAloudRate(voiceChatSettings.readAloudRate),
                min: MIN_READ_ALOUD_RATE,
                max: MAX_READ_ALOUD_RATE,
                step: 0.1,
                onChange: onReadAloudRateChange,
              },
            }}
          />
        </InputButtons>

        </>}
      composer={<Composer classPrefix="llm-hub" textareaRef={textareaRef}
          textarea={{ value: input, rows: 1,
          onChange: handleInputChange,
          onKeyDown: handleKeyDown,
          onPaste: event => {
            if (event.defaultPrevented || !event.clipboardData.files.length) return;
            event.preventDefault();
            if (!isLoading && !isCompacting) void appendFiles(Array.from(event.clipboardData.files));
          },
          onDragOver: event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); },
          onDrop: event => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            if (!isLoading && !isCompacting) void appendFiles(Array.from(event.dataTransfer.files));
          },
          placeholder: isCompacting ? t("chat.compacting") : (Platform.isMobile ? t("input.placeholderMobile") : t("input.placeholder")),
          disabled: isCompacting }}
          isLoading={isLoading} isCompacting={isCompacting} compactingLabel={t("chat.compacting")}
          canSend={!processingAttachments && (!!input.trim() || pendingAttachments.length > 0)}
          voiceConversation={{
            available: voiceConversation.available,
            active: voiceConversation.active,
            label: t("input.voiceConversation"),
            onOpen: voiceConversation.open,
            onSubmit: content => { void handleVoiceSubmit(content); },
            onEnd: voiceConversation.end,
            onInsert: insertDictation,
          }}
          voiceSubmit={{
            enabled: voiceChatSettings.submitOnPaste && !isLoading,
            phrase: voiceChatSettings.submitPhrase,
            onSubmit: content => { void handleVoiceSubmit(content); },
          }}
          onSend={() => { void handleSubmit(); }} onStop={onStop}
          sendLabel={t("input.send")} stopLabel={t("input.stop")}
          contextToggle={Platform.isMobile ? { hidden: isContextHidden, onToggle: () => setIsContextHidden(hidden => !hidden), label: isContextHidden ? t("input.showContext") : t("input.hideContext") } : undefined}
          collapse={Platform.isMobile ? { collapsed: isCollapsed, onToggle: () => setIsCollapsed(!isCollapsed), label: isCollapsed ? t("input.expand") : t("input.collapse") } : undefined}
        />}
      footer={<>

      {/* Collapsed state: show only expand button */}
      {isCollapsed && Platform.isMobile && (
        <CollapsedInput classPrefix="llm-hub" label={t("input.expand")} onExpand={() => setIsCollapsed(false)} />
      )}

      {!isCollapsed && !isContextHidden && (
        <ModelRow classPrefix="llm-hub">
          <button type="button" className="llm-hub-input-detail-toggle" aria-expanded={controlsExpanded} title={t(controlsExpanded ? 'input.hideContext' : 'input.showContext')}
            onClick={() => setControlsExpanded(value => !value)}>⋯</button>
          <ModelSelector
            models={availableModels}
            value={model}
            onChange={onModelChange}
            disabled={isLoading}
          />
          {model === "codex-cli" && (
            <>
              <ModelDropdown
                classPrefix="llm-hub"
                value={codexModel || ""}
                onChange={(value) => onCodexConfigChange(value || undefined, codexReasoningEffort)}
                disabled={isLoading}
                title={t("settings.codexCliModel")}
                options={[
                  { value: "", label: t("settings.codexCliModel.default") },
                  ...codexModels.map((option) => ({ value: option.slug, label: `${option.displayName} (${option.slug})` })),
                  // Keep a configured model selectable even when it is missing from the list.
                  ...(codexModel && !codexModels.some((option) => option.slug === codexModel) ? [{ value: codexModel, label: codexModel }] : []),
                ]}
              />
              <ModelDropdown
                classPrefix="llm-hub"
                value={codexReasoningEffort}
                onChange={(value) => onCodexConfigChange(codexModel, value as CodexReasoningEffort)}
                disabled={isLoading}
                title={t("settings.codexCliReasoningEffort")}
                options={(["minimal", "low", "medium", "high", "xhigh", "max"] as CodexReasoningEffort[]).map((effort) => ({ value: effort, label: effort }))}
              />
            </>
          )}
          {reasoningEffortOptions.length > 0 && (
            <ModelDropdown
              classPrefix="llm-hub"
              value={reasoningEffort}
              onChange={(value) => onReasoningEffortChange(value as ReasoningEffort)}
              disabled={isLoading}
              title={t("input.reasoningEffort")}
              options={reasoningEffortOptions.map((effort) => ({ value: effort, label: effort }))}
            />
          )}
          <SearchSelector
            classPrefix="llm-hub"
            ownerDocument={activeDocument}
            disabled={isLoading}
            labels={{
              webSearch: t("input.webSearch"),
              rag: (name) => t("input.rag", { name }),
              ragNone: t("input.rag", { name: t("common.none") }),
              none: t("input.searchNone"),
            }}
            webSearch={{
              checked: webSearchEnabled,
              disabled: !allowWebSearch,
              combinable: true,
            }}
            rag={{
              settings: ragSettings,
              selected: selectedRagSetting,
              disabled: !ragEnabled || isImageGenerationModel(model),
            }}
            onChange={onSearchSelectionChange}
          />
        </ModelRow>
      )}
      <div className="llm-hub-input-details" aria-hidden={!controlsExpanded} ref={element => { if (element) element.inert = !controlsExpanded; }}>
      <div>
      {controlsExpanded && !isCollapsed && !isContextHidden && availableSkills.length > 0 && (
        <SkillSelector
          skills={availableSkills}
          activeSkillPaths={activeSkillPaths}
          onToggleSkill={onToggleSkill}
          disabled={isLoading}
          app={app}
        />
      )}
      {controlsExpanded && !isCollapsed && !isContextHidden && okfBundles.length > 0 && (
        <OkfSelector
          bundles={okfBundles}
          activeBundleIds={activeOkfBundleIds}
          onToggleBundle={onToggleOkfBundle}
          disabled={isLoading}
        />
      )}
      </div>
      </div>
    </>}
    />
    </div>
  );
});

export default InputArea;
