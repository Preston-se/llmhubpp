// The message bubble lives in the shared library; this supplies what only this plugin
// knows: how a model id reads, and where its workflow panel is.
import { Notice, type App } from "obsidian";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChatAttachmentPreviews } from "./ChatAttachmentPreviews";
import { MessageBubbleView } from "obsidian-llm-hub-common/modals";
import { DELETE_VAULT_TOOL_NAMES, WRITE_VAULT_TOOL_NAMES, VAULT_TOOL_SCOPE_DENIED_MSG } from "obsidian-llm-hub-common/core";
import type { Message, LocalLlmConfig, ModelInfo } from "src/types";
import { isApiProviderModel, getApiProviderModelName, isLocalLlmModel, getLocalLlmId, getLocalLlmModelName, localLlmDisplayName } from "src/types";
import { ChatView, VIEW_TYPE_GEMINI_CHAT } from "src/ui/ChatView";
import { t, type TranslationKey } from "src/i18n";
import { readGroundedEvidence } from "src/core/groundedAnswer";
import { getAnswerCitations, type AnswerSource } from "src/core/answerCitations";
import { openCitationSource } from "./chat/sourceNavigation";
import { useCitationMarkup } from "./chat/useCitationMarkup";
import { CitationPopover } from "./CitationPopover";

const WRITE_TOOLS = new Set<string>([...WRITE_VAULT_TOOL_NAMES, ...DELETE_VAULT_TOOL_NAMES]);

function mcpFailureLabel(name: string, error: unknown): TranslationKey | undefined {
  if (!name.startsWith("mcp_")) return;
  const prefix = "MCP tool execution failed: ";
  if (typeof error !== "string" || !error.startsWith(prefix)) return "message.toolFailure.mcp";
  const detail = error.slice(prefix.length);
  if (detail.startsWith("MCP tool call denied by user:")) return "message.toolFailure.mcpDenied";
  if (detail === "MCP tool approval could not be saved" ||
      (name === "mcp_deepseek_search_deepseek_web_search" && detail === "invalid")) return "message.toolFailure.mcpApprovalSave";
  if (!name.endsWith("_deepseek_web_search")) return "message.toolFailure.mcp";
  if (detail.includes("DeepSeek returned an invalid search response")) return "message.toolFailure.mcpSearchInvalid";
  if (detail.includes("DeepSeek search could not verify the HTTPS certificate")) return "message.toolFailure.mcpSearchCertificate";
  if (detail.includes("Could not reach DeepSeek search") || detail.startsWith("MCP request timed out")) return "message.toolFailure.mcpSearchTimeout";
  if (detail.includes("Configure DEEPSEEK_API_KEY") || /DeepSeek search returned HTTP (401|403)\b/.test(detail)) return "message.toolFailure.mcpSearchAuthentication";
  if (detail.includes("DeepSeek search returned HTTP 402")) return "message.toolFailure.mcpSearchBalance";
  if (detail.includes("DeepSeek search returned HTTP 429")) return "message.toolFailure.mcpSearchRate";
  return "message.toolFailure.mcp";
}

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  sourceFileName?: string | null;
  onApplyEdit?: () => Promise<void>;
  onDiscardEdit?: () => void;
  app: App;
  localLlmConfigs?: LocalLlmConfig[];
  availableModels?: readonly ModelInfo[];
  skillsFolder?: string;
}

function formatModelName(model: string, localLlmConfigs?: LocalLlmConfig[]): string {
  // Strip "api:" prefix for display
  if (isApiProviderModel(model)) return getApiProviderModelName(model) || model.slice(4);
  // For "local-llm:<id>:<model>" resolve the saved config (incl. disabled ones, so history
  // of a config the user has since toggled off still renders with its real label) and
  // overlay the specific model name so each chat dropdown entry stays distinguishable.
  if (isLocalLlmModel(model)) {
    const id = getLocalLlmId(model);
    const modelName = getLocalLlmModelName(model);
    const config = id && localLlmConfigs ? localLlmConfigs.find(c => c.id === id) : null;
    if (config) return localLlmDisplayName(config, modelName);
    if (modelName) return `Local LLM (${modelName})`;
    return id ? `Local LLM (${id})` : "Local LLM";
  }
  return model;
}

export default function MessageBubble({ localLlmConfigs, availableModels, ...props }: MessageBubbleProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<{ anchor: HTMLElement; source: AnswerSource } | null>(null);
  const [imageHost, setImageHost] = useState<HTMLElement | null>(null);
  const hasImages = props.message.attachments?.some(item => item.type === "image") ?? false;
  useEffect(() => {
    if (!hasImages) { setImageHost(null); return; }
    const message = containerRef.current?.querySelector(".llm-hub-message");
    if (!message) return;
    const host = message.ownerDocument.adoptNode(createDiv());
    host.className = "llm-hub-message-image-host";
    message.insertBefore(host, message.querySelector(".llm-hub-message-content"));
    setImageHost(host);
    return () => { host.remove(); };
  }, [hasImages]);
  const thinkingSeen = useRef(new WeakSet<HTMLDetailsElement>());
  useEffect(() => {
    const root = containerRef.current;
    const thinking = root?.querySelector<HTMLDetailsElement>(".llm-hub-thinking");
    if (thinking && !thinkingSeen.current.has(thinking)) {
      thinking.open = false;
      thinkingSeen.current.add(thinking);
    }
    const role = root?.querySelector<HTMLElement>(".llm-hub-message-role");
    if (role) {
      const message = props.message;
      const usage = message.usage;
      role.title = [message.model, new Date(message.timestamp).toLocaleString(),
        message.elapsedMs === undefined ? "" : (message.elapsedMs / 1000).toFixed(1) + "s",
        usage ? JSON.stringify(usage) : ""].filter(Boolean).join("\n");
      role.tabIndex = 0;
    }
  }, [props.message]);
  const evidence = useMemo(() => readGroundedEvidence(props.message), [props.message]);
  const citations = useMemo(() => getAnswerCitations(props.message), [props.message]);
  const close = useCallback(() => setSelected(null), []);
  useEffect(close, [props.message, close]);
  const openSource = async (source: AnswerSource) => {
    const result = await openCitationSource(props.app, source);
    if (result === "located") close();
    if (result === "missing") new Notice(t("message.grounded.missing"));
    if (result === "failed") new Notice(t("message.grounded.openFailed"));
    if (result === "opened") new Notice(t("chat.excerptNotLocated"));
  };
  const historicalSources: AnswerSource[] = props.message.ragCitations?.length
    ? props.message.ragCitations.map((item, index) => ({ id: index + 1, filePath: item.filePath, text: item.snippet ?? "",
      heading: item.heading, documentOffset: item.startOffset, pageLabel: item.pageLabel }))
    : (props.message.ragContexts?.length ? props.message.ragContexts : (props.message.ragSources ?? []).map(source => ({ source, text: "" })))
      .map((item, index) => ({ id: index + 1, filePath: item.source, text: item.text }));
  useCitationMarkup({ containerRef, message: props.message,
    onSelect: (anchor, source) => setSelected(previous => previous?.anchor === anchor ? null : { anchor, source }),
    onOpen: openSource });
  const issues = (props.message.toolCalls ?? []).flatMap(call => {
    const entry = props.message.toolResults?.find(result => result.toolCallId === call.id);
    const result = entry?.result && typeof entry.result === "object"
      ? entry.result as Record<string, unknown> : null;
    const failed = result?.success === false || Boolean(result?.error);
    const unconfirmed = WRITE_TOOLS.has(call.name) && !failed && result?.success !== true;
    if (!failed && !unconfirmed) return [];
    const scopeDenied = result?.error === VAULT_TOOL_SCOPE_DENIED_MSG;
    const folders = Array.isArray(result?.allowedFolders)
      ? result.allowedFolders.filter((folder): folder is string => typeof folder === "string") : [];
    const label = unconfirmed ? "message.toolFailure.unconfirmed" : scopeDenied ? "message.toolFailure.scope"
      : mcpFailureLabel(call.name, result?.error) ?? "message.toolFailure.generic";
    const name = call.name.startsWith("mcp_") && call.name.endsWith("_deepseek_web_search")
      ? t("message.toolFailure.mcpSearchName") : call.name;
    return [{ id: call.id, name, scopeDenied, label, folders }];
  });
  const issueIds = new Set(issues.map(issue => issue.id));
  const displayMessage = {
    ...props.message,
    toolCalls: props.message.toolCalls?.filter(call => !issueIds.has(call.id)),
    attachments: props.message.attachments?.filter(item => item.type !== "image"),
    ragUsed: false,
    modelDisplayName: props.message.modelDisplayName || availableModels?.find(model => model.name === props.message.model)?.displayName || (props.message.model ? formatModelName(props.message.model, localLlmConfigs) : undefined),
  };
  return (
    <div className="llm-hub-message-frame" ref={containerRef}>
    {citations.status === "cited" && <span className="llm-hub-citation-meta" title={props.message.model}>{t("message.grounded.sources")}{evidence ? " · " + evidence.settingName : ""} · {citations.sources.length}</span>}
    <MessageBubbleView
      {...props}
      message={displayMessage}
      classPrefix="llm-hub"
      formatModelName={(model) => formatModelName(model, localLlmConfigs)}
      onOpenWorkflow={() => revealWorkflowTab(props.app, "")}
    />
    {issues.map(issue => <div className="llm-hub-tool-failure" role="alert" key={issue.id}>
      <strong>{issue.name}</strong>: {t(issue.label)}
      {issue.scopeDenied && <div>{issue.folders.length
        ? `${t("input.vaultStatus.scope")}: ${issue.folders.join(", ")}`
        : t("message.toolFailure.scopeSeeSettings")}</div>}
    </div>)}
    {citations.status === "uncited" && <div className="llm-hub-citation-status" role="status">{t("message.grounded.noCitation")}</div>}
    {citations.unknownIds.length > 0 && <div className="llm-hub-citation-status" role="status">{t("message.grounded.unknownCitation")}: {citations.unknownIds.map(id => "[" + id + "]").join(", ")}</div>}
    {evidence?.truncated && <div className="llm-hub-citation-status">{t("message.grounded.shortened")} ({evidence.omittedCount})</div>}
    {citations.status === "legacy-unmapped" && <details className="llm-hub-legacy-evidence"><summary>{t("chat.historicalSources")}</summary>
      {historicalSources.map((item, index) => <div key={index}>
        <button type="button" onClick={() => { void openSource(item); }}>{item.filePath}</button>
        {item.heading && <small>{item.heading}</small>}
        {item.text && <pre>{item.text}</pre>}
      </div>)}
    </details>}
    {imageHost && <>{createPortal(<ChatAttachmentPreviews attachments={(props.message.attachments ?? []).filter(item => item.type === "image")} app={props.app}/>, imageHost)}</>}
    {selected && <CitationPopover anchor={selected.anchor} source={selected.source} sources={citations.sources} onClose={close} onOpen={openSource}/>}
    </div>
  );
}

/** Reveals a workflow file in this plugin's own workflow panel. */
function revealWorkflowTab(app: App, _path: string): void {
  for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_GEMINI_CHAT)) {
    const view = leaf.view;
    if (view instanceof ChatView) {
      view.setActiveTab("workflow");
      void app.workspace.revealLeaf(leaf);
    }
  }
}
