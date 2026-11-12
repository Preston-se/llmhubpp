import { forwardRef, useRef, useImperativeHandle } from "react";
import { MessageList as SharedMessageList, Welcome, type WelcomeProps } from "obsidian-llm-hub-common";
import type { App } from "obsidian";
import type { Message, LocalLlmConfig, ModelInfo } from "src/types";
import MessageBubble from "./MessageBubble";
import { ConversationNavigator } from "./ConversationNavigator";
import { useChatScroll } from "./chat/useChatScroll";
import { t } from "src/i18n";
import type { ToolActivity } from "./chat/toolActivity";
export { applyToolActivityEvent, cancelToolActivities } from "./chat/toolActivity";

interface DashboardLink {
  basename: string;
  path: string;
}

interface MessageListProps {
  conversationKey?: string;
  conversationTitle?: string;
  messages: Message[];
  streamingContent: string;
  streamingThinking: string;
  isLoading: boolean;
  groundedSearching?: boolean;
  toolActivities?: ToolActivity[];
  onApplyEdit?: (messageIndex: number) => Promise<void>;
  onDiscardEdit?: (messageIndex: number) => void;
  app: App;
  localLlmConfigs?: LocalLlmConfig[];
  availableModels?: readonly ModelInfo[];
  skillsFolder?: string;
  currentDashboard?: DashboardLink | null;
  onOpenDashboard?: () => void;
  onCreateDashboard?: () => void;
  onAskLlmHubHelp?: () => void;
  fileSkill?: WelcomeProps["fileSkill"];
}

const MessageList = forwardRef<HTMLDivElement, MessageListProps>((props, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => containerRef.current!, []);
  const conversationKey = props.conversationKey ?? "current";
  const scroll = useChatScroll({ containerRef, conversationKey, messages: props.messages,
    streamingContent: props.streamingContent, streamingThinking: props.streamingThinking });
  return <div className="llm-hub-transcript-region">
  {props.messages.length > 0 && <div className="llm-hub-conversation-topic" title={props.conversationTitle || props.messages.find(message => message.role === "user")?.content}>{props.conversationTitle || props.messages.find(message => message.role === "user")?.content.slice(0, 100)}</div>}
  <SharedMessageList
    classPrefix="llm-hub"
    containerRef={containerRef}
    messages={props.messages}
    streamingContent={props.streamingContent}
    streamingThinking={props.streamingThinking}
    isLoading={props.isLoading}
    emptyState={<Welcome
      classPrefix="llm-hub"
      cardStyle="dashboard"
      title={t("chat.welcomeTitle")} hint={t("chat.welcomeHint")}
      help={{ title: t("chat.helpTitle"), description: t("chat.helpDescription"), label: t("chat.askLlmHubHelp"), onClick: props.onAskLlmHubHelp }}
      dashboard={{ title: t("chat.dashboardTitle"), description: t("chat.dashboardDescription"), openLabel: t("chat.openCurrentDashboard"), createLabel: t("chat.createDashboard"), current: props.currentDashboard, onOpen: props.onOpenDashboard, onCreate: props.onCreateDashboard }}
      fileSkill={props.fileSkill}
      tips={[{ text: t("chat.welcomeImage") }, { text: t("chat.welcomeCompact") }, { text: t("chat.welcomeNewChat") }]}
    />}
    renderMessage={(message, index, sourceFileName) => <div data-chat-turn={message.role === "user" ? index : undefined}><MessageBubble
      message={message} availableModels={props.availableModels} app={props.app} localLlmConfigs={props.localLlmConfigs} skillsFolder={props.skillsFolder}
      sourceFileName={sourceFileName}
      onApplyEdit={props.onApplyEdit ? () => props.onApplyEdit!(index) : undefined}
      onDiscardEdit={props.onDiscardEdit ? () => props.onDiscardEdit!(index) : undefined}
    /></div>}
    renderStreamingMessage={message => <MessageBubble message={message} availableModels={props.availableModels} isStreaming app={props.app} localLlmConfigs={props.localLlmConfigs} skillsFolder={props.skillsFolder} />}
  />
  {props.groundedSearching && <div className="llm-hub-grounded-searching" role="status">{t("chat.grounded.searching")}</div>}
  {props.toolActivities && props.toolActivities.length > 0 && <div className="llm-hub-tool-activity" aria-live="polite">
    {props.toolActivities.map(activity => <div key={activity.id}>
      <span>{activity.name}</span>: {t({
        running: "chat.toolActivity.running", succeeded: "chat.toolActivity.succeeded",
        failed: "chat.toolActivity.failed", cancelled: "chat.toolActivity.cancelled", unconfirmed: "chat.toolActivity.unconfirmed",
      }[activity.status] as Parameters<typeof t>[0])}
    </div>)}
  </div>}
  <ConversationNavigator messages={props.messages} containerRef={containerRef} conversationKey={conversationKey} onNavigate={scroll.holdPosition}/>
  {!scroll.following && <button type="button" className="llm-hub-back-to-latest" onClick={scroll.scrollToLatest}>{t("chat.latest")}</button>}
  </div>;
});
export default MessageList;
