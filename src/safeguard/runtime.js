const { Component, PluginSettingTab, Setting, Modal, Notice, normalizePath } = require("obsidian");
const http = require("http");
const https = require("https");
const pathUtil = require("path").posix;

const DEFAULT_SETTINGS = {
  enabled: true,
  listenHost: "127.0.0.1",
  listenPort: 11435,
  upstreamBaseUrl: "http://127.0.0.1:11434",
  warningEstimatedTokens: 8000,
  blockEstimatedTokens: 11000,
  warningSingleMessageChars: 9000,
  blockSingleMessageChars: 18000,
  contextWindowTokens: 16384,
  warningTotalContextRatio: 0.82,
  blockTotalContextRatio: 0.95,
  warningActualImages: 4,
  blockActualImages: 8,
  hardTimeoutSeconds: 240,
  maxRequestBodyMB: 64,
  showLowRiskNotices: false,
  defaultReadOnlyEnabled: true,
  syncLlmHubUi: true,
  enforceProxyReadOnly: true,
  routerEnabled: true,
  autoRouteImages: true,
  visionModel: "qwen3-vl:4b-instruct",
  advancedRouteEnabled: true,
  advancedProviderHint: "DeepSeek",
  advancedModelHint: "deepseek-flash",
  showRoutingNotices: true,

  // v0.6 Markdown Vision Bridge
  markdownVisionEnabled: true,
  markdownVisionDirectProviderHook: true,
  markdownVisionMaxImageMB: 16,
  markdownVisionShowNotices: true,
  markdownVisionRenderChatImages: true,
  markdownVisionRecognizeBarePaths: true,

  // v0.5 Context Manager
  contextManagerEnabled: true,
  defaultCompressionModel: "local:qwen3.5:4b",
  compressionChunkTokens: 3200,
  compressionTargetTokens: 1200,
  compressionKeepRecentMessages: 2,
  contextHealthyRatio: 0.60,
  contextWarningRatio: 0.75,
  contextDangerRatio: 0.85,
  deepSeekContextTokens: 1000000,
  deepSeekOutputReserveTokens: 64000,
  contextMemories: {}
};


const MUTATING_VAULT_TOOLS = new Set([
  "create_note",
  "propose_edit",
  "propose_delete",
  "bulk_propose_edit",
  "bulk_propose_delete",
  "rename_note",
  "bulk_propose_rename",
  "create_folder"
]);

function getToolName(tool) {
  if (!tool || typeof tool !== "object") return "";
  if (typeof tool.name === "string") return tool.name;
  if (tool.function && typeof tool.function.name === "string") return tool.function.name;
  return "";
}

function appendReadOnlySystemNotice(payload) {
  if (!Array.isArray(payload?.messages)) return;
  const note = "[LLM Hub Safe Guard] This chat is currently in Vault read-only mode. Vault write/create/edit/delete/rename tools are unavailable. Answer in chat and use only read/search/list tools.";
  const existing = payload.messages.find(m => m && m.role === "system" && typeof m.content === "string");
  if (existing) {
    if (!existing.content.includes("[LLM Hub Safe Guard]")) existing.content += `\n\n${note}`;
  } else {
    payload.messages.unshift({ role: "system", content: note });
  }
}

function applyReadOnlyToolFilter(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.tools)) {
    return { removed: [] };
  }
  const removed = [];
  payload.tools = payload.tools.filter(tool => {
    const name = getToolName(tool);
    if (MUTATING_VAULT_TOOLS.has(name)) {
      removed.push(name);
      return false;
    }
    return true;
  });
  if (removed.length > 0) appendReadOnlySystemNotice(payload);
  return { removed };
}

function countCjk(s) {
  const m = s.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g);
  return m ? m.length : 0;
}

function estimateTokens(text) {
  if (!text) return 0;
  const cjk = countCjk(text);
  const other = Math.max(0, text.length - cjk);
  return Math.ceil(cjk * 1.05 + other / 4);
}

function extractRequestMetrics(payload) {
  let textChars = 0;
  let estimatedTokens = 0;
  let systemTextChars = 0;
  let systemEstimatedTokens = 0;
  let conversationTextChars = 0;
  let conversationEstimatedTokens = 0;
  let toolsEstimatedTokens = 0;
  let actualImages = 0;
  let markdownImageRefs = 0;
  let latestUserText = "";
  let lastMessageRole = "";
  let maxDynamicMessageChars = 0;

  const countMarkdownImageRefs = (text) => {
    if (typeof text !== "string" || !text) return 0;
    return extractMarkdownVisionRefs(text).length;
  };

  const addText = (text, role) => {
    if (typeof text !== "string" || !text) return;
    const tokens = estimateTokens(text);
    textChars += text.length;
    estimatedTokens += tokens;
    if (role === "system") {
      systemTextChars += text.length;
      systemEstimatedTokens += tokens;
    } else {
      conversationTextChars += text.length;
      conversationEstimatedTokens += tokens;
      // Only user-provided/context messages should generate the "Markdown image"
      // warning. System prompts may contain Markdown examples and must not be
      // mistaken for images the user expected the model to see.
      if (role === "user") markdownImageRefs += countMarkdownImageRefs(text);
    }
  };

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (const msg of messages) {
    const role = typeof msg?.role === "string" ? msg.role : "unknown";
    lastMessageRole = role;
    let thisMessageChars = 0;
    const content = msg?.content;
    if (typeof content === "string") {
      addText(content, role);
      thisMessageChars += content.length;
      if (role === "user") latestUserText = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text") {
          addText(part.text || "", role);
          if (typeof part.text === "string") thisMessageChars += part.text.length;
          if (role === "user" && typeof part.text === "string") latestUserText += (latestUserText ? "\n" : "") + part.text;
        }
        if (role !== "system" && (part.type === "image_url" || part.type === "input_image" || part.image_url || part.image)) {
          actualImages += 1;
        }
      }
    }
    // Ollama-native compatible image arrays, if ever routed here.
    if (role !== "system" && Array.isArray(msg?.images)) actualImages += msg.images.length;
    if (role !== "system") maxDynamicMessageChars = Math.max(maxDynamicMessageChars, thisMessageChars);
  }

  if (Array.isArray(payload?.tools)) {
    const toolText = JSON.stringify(payload.tools);
    toolsEstimatedTokens = Math.ceil(toolText.length / 4);
    estimatedTokens += toolsEstimatedTokens;
  }

  return {
    model: String(payload?.model || "unknown"),
    messageCount: messages.length,
    textChars,
    estimatedTokens,
    systemTextChars,
    systemEstimatedTokens,
    conversationTextChars,
    conversationEstimatedTokens,
    toolsEstimatedTokens,
    actualImages,
    markdownImageRefs,
    latestUserText,
    lastMessageRole,
    maxDynamicMessageChars
  };
}


function applyContextMemoryWindow(payload, state, defaultKeep = 2, domVisibleCount = null) {
  if (!state?.summary || !Array.isArray(payload?.messages)) {
    const count = Array.isArray(payload?.messages) ? payload.messages.length : 0;
    return { applied: false, rawMessageCount: count, effectiveMessageCount: count, removed: 0, keepRecent: 0 };
  }

  const messages = payload.messages;
  const rawMessageCount = messages.length;
  const keepRecent = Math.max(0, Number.isInteger(state.keepRecentMessages)
    ? state.keepRecentMessages
    : (Number.isFinite(Number(defaultKeep)) ? Math.round(Number(defaultKeep)) : 2));
  const summarizedVisibleCount = Math.max(0, Math.round(Number(state.summaryCoveredCount) || 0));

  // v0.5.7 semantics: keepRecent applies only at the instant compression is
  // created. New user/assistant messages after that boundary accumulate normally
  // until the next manual compression. This avoids a permanent N-message sliding
  // window that could both lose recent dialogue and make context % fall after a
  // short turn replaces an older long turn.
  const visibleIndices = [];
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === "user" || role === "assistant") visibleIndices.push(i);
  }
  const rawVisibleCount = visibleIndices.length;

  // LLM Hub may have already applied its own Previous messages suffix before the
  // request reaches 11435. The full DOM count lets us infer how many earliest
  // visible messages are absent from this payload. Those omitted messages are
  // necessarily before the remaining suffix, so subtract them from the absolute
  // compression boundary instead of deleting the suffix again.
  const fullVisibleCount = Number.isFinite(Number(domVisibleCount))
    ? Math.max(rawVisibleCount, Math.round(Number(domVisibleCount)))
    : rawVisibleCount;
  const omittedVisiblePrefix = Math.max(0, fullVisibleCount - rawVisibleCount);
  const coveredInPayload = Math.max(0, Math.min(rawVisibleCount, summarizedVisibleCount - omittedVisiblePrefix));

  let currentTurnStart = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      currentTurnStart = i;
      break;
    }
  }

  let boundaryIndex = 0;
  if (coveredInPayload > 0) {
    boundaryIndex = coveredInPayload < visibleIndices.length ? visibleIndices[coveredInPayload] : messages.length;
  }
  // Never trim away the newest user turn even if the DOM had not committed yet
  // and the omitted-prefix estimate was temporarily off by one.
  if (currentTurnStart >= 0 && boundaryIndex > 0) boundaryIndex = Math.min(boundaryIndex, currentTurnStart);

  const kept = [];
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === "system" || role === "developer" || i >= boundaryIndex) kept.push(messages[i]);
  }

  payload.messages = kept;
  return {
    applied: true,
    rawMessageCount,
    effectiveMessageCount: kept.length,
    removed: Math.max(0, rawMessageCount - kept.length),
    keepRecent,
    summarizedVisibleCount,
    rawVisibleCount,
    fullVisibleCount,
    omittedVisiblePrefix,
    coveredInPayload,
    boundaryIndex
  };
}


function simpleFingerprint(text) {
  const s = String(text || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${s.length}:${(h >>> 0).toString(16)}`;
}

function isLikelyVisionModel(model) {
  return /(?:qwen[^:]*vl|vision|vl[:_-]|llava|minicpm-v|gemma[^:]*3n)/i.test(String(model || ""));
}


const SAFE_GUARD_VISION_MARKER = "[LLM Hub Safe Guard Markdown Vision]";
const SUPPORTED_VISION_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function decodeHtmlEntities(text) {
  const value = String(text || "");
  if (!value || !/[&]/.test(value) || typeof document === "undefined") return value;
  try {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = value;
    return textarea.value;
  } catch (_) {
    return value
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
  }
}

function cleanVisionTarget(target) {
  let value = decodeHtmlEntities(String(target || "")).trim();
  if (!value) return "";
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
  // Markdown links may append an optional quoted title after the path.
  value = value.replace(/\s+["'][^"']*["']\s*$/, "").trim();
  try { value = decodeURIComponent(value); } catch (_) {}
  value = value.replace(/^file:\/\//i, "");
  return value;
}

function extractMarkdownVisionRefs(text) {
  const source = String(text || "");
  const refs = [];
  const add = (target, raw, kind) => {
    const cleaned = cleanVisionTarget(target);
    if (!cleaned || /^(?:https?:|data:|blob:)/i.test(cleaned)) return;
    refs.push({ target: cleaned, raw: String(raw || cleaned), kind });
  };

  // HTML generated by the Office ingestion pipeline.
  const htmlQuoted = /<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  let match;
  while ((match = htmlQuoted.exec(source))) add(match[2], match[0], "html");
  const htmlBare = /<img\b[^>]*?\bsrc\s*=\s*([^\s>"']+)[^>]*>/gi;
  while ((match = htmlBare.exec(source))) add(match[1], match[0], "html");

  // Obsidian wiki embeds: ![[folder/image.png|300]]
  const wiki = /!\[\[([^\]]+)\]\]/g;
  while ((match = wiki.exec(source))) {
    const target = String(match[1] || "").split("|")[0].split("#")[0].trim();
    add(target, match[0], "wiki");
  }

  // Markdown embeds: ![alt](path/image.png "title") or ![alt](<path with spaces.png>)
  const markdown = /!\[[^\]]*\]\((<[^>]+>|[^\)]+)\)/g;
  while ((match = markdown.exec(source))) add(match[1], match[0], "markdown");

  const seen = new Set();
  return refs.filter(ref => {
    const key = ref.target.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


function extractBareVisionRefs(text) {
  const source = String(text || "");
  const refs = [];
  const add = (target, raw, kind = "path") => {
    const cleaned = cleanVisionTarget(target);
    if (!cleaned) return;
    refs.push({ target: cleaned, raw: String(raw || cleaned), kind });
  };

  // Obsidian's "Copy Obsidian URL" form. The file query parameter is the
  // vault-relative resource we actually need.
  const obsidianUrl = /obsidian:\/\/open\?[^\s<>"']+/gi;
  let match;
  while ((match = obsidianUrl.exec(source))) {
    try {
      const u = new URL(match[0]);
      const file = u.searchParams.get("file");
      if (file && /\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i.test(file)) add(file, match[0], "obsidian-url");
    } catch (_) {}
  }

  // file:///... URLs copied by some Windows shells / plugins.
  const fileUrl = /file:\/{2,3}[^\r\n<>"']+?\.(?:png|jpe?g|gif|webp)(?=$|[\s"')\]])/gi;
  while ((match = fileUrl.exec(source))) add(match[0], match[0], "file-url");

  // Quoted absolute or vault-relative paths can contain spaces.
  const quoted = /(["'])([^"'\r\n]+?\.(?:png|jpe?g|gif|webp))\1/gi;
  while ((match = quoted.exec(source))) add(match[2], match[0], "quoted-path");

  // Common pasted path form: the line starts with a Windows absolute path or a
  // vault-relative path and natural-language text follows after the extension.
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*>\s]+/, "");
    if (!line || /^(?:!\[|!\[\[|<img\b)/i.test(line)) continue;
    const ext = line.match(/\.(?:png|jpe?g|gif|webp)\b/i);
    if (!ext || ext.index == null) continue;
    const candidate = line.slice(0, ext.index + ext[0].length).trim();
    const pathLike = /^(?:[A-Za-z]:[\\/]|\\\\|\.\.?[\\/]|[^:<>]+[\\/])/i.test(candidate);
    if (pathLike) add(candidate, candidate, "bare-path");
  }

  const seen = new Set();
  return refs.filter(ref => {
    const key = ref.target.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractAllVisionRefs(text, allowBare = true) {
  const refs = [...extractMarkdownVisionRefs(text)];
  if (allowBare) refs.push(...extractBareVisionRefs(text));
  const seen = new Set();
  return refs.filter(ref => {
    const key = cleanVisionTarget(ref.target).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractMarkdownSourcePath(text) {
  const source = String(text || "");
  const patterns = [
    /From\s+["']([^"']+?\.(?:md|markdown))["'](?:\s*\([^\)]*\))?\s*:/i,
    /source_path\s*:\s*["']?([^"'\n\r]+?\.(?:md|markdown))["']?\s*$/im,
    /source\s*:\s*['"]?\[\[([^\]]+?\.(?:md|markdown))\]\]/im,
  ];
  for (const re of patterns) {
    const match = source.match(re);
    if (match?.[1]) return normalizePath(decodeHtmlEntities(match[1].trim()));
  }
  return "";
}

function getMessageTextForVision(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(part => part && typeof part === "object" && (part.type === "text" || part.type === "input_text"))
    .map(part => String(part.text || ""))
    .join("\n");
}

function mimeTypeForVisionPath(filePath) {
  const ext = String(filePath || "").split(".").pop()?.toLowerCase() || "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

function ensureUserContentArray(message) {
  if (!message || typeof message !== "object") return null;
  if (Array.isArray(message.content)) return message.content;
  const original = typeof message.content === "string" ? message.content : "";
  message.content = [{ type: "text", text: original }];
  return message.content;
}

function stripImagesForTextOnlyRoute(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) return 0;
  let removed = 0;
  const marker = "[LLM Hub Safe Guard：本次已改用高级文本模型；原请求中的图片附件已省略。若答案依赖图片，请改用视觉模型。]";

  for (const msg of payload.messages) {
    if (!msg || typeof msg !== "object") continue;

    if (Array.isArray(msg.content)) {
      const next = [];
      let removedFromMessage = 0;
      for (const part of msg.content) {
        if (!part || typeof part !== "object") {
          next.push(part);
          continue;
        }
        const isImage = part.type === "image_url" || part.type === "input_image" || part.image_url || part.image;
        if (isImage) {
          removed += 1;
          removedFromMessage += 1;
          continue;
        }
        next.push(part);
      }
      if (removedFromMessage > 0) next.push({ type: "text", text: marker });
      msg.content = next;
    }

    if (Array.isArray(msg.images) && msg.images.length > 0) {
      removed += msg.images.length;
      delete msg.images;
      if (typeof msg.content === "string") msg.content += `\n\n${marker}`;
      else if (!Array.isArray(msg.content)) msg.content = marker;
    }
  }
  return removed;
}

function joinOpenAiChatUrl(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  if (/\/v1\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function joinOllamaChatUrl(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  if (/\/api\/chat$/i.test(base)) return base;
  const root = base.replace(/\/v1(?:\/chat\/completions)?$/i, "");
  return `${root}/api/chat`;
}


function cloneJson(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return value; }
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part.type === "image_url" || part.type === "input_image" || part.image_url || part.image) parts.push("[图片附件]");
    else if (part.type === "file" || part.type === "input_file") parts.push(`[文件附件${part.filename ? `：${part.filename}` : ""}]`);
  }
  return parts.join("\n");
}

function messageFingerprint(message) {
  if (!message || typeof message !== "object") return "";
  return `${message.role || "unknown"}|${simpleFingerprint(contentToText(message.content))}`;
}

function serializeMessageForSummary(message) {
  if (!message || typeof message !== "object") return "";
  const roleMap = { user: "用户", assistant: "助手", tool: "工具", system: "系统" };
  const role = roleMap[message.role] || String(message.role || "消息");
  const text = contentToText(message.content).trim();
  if (!text) return "";
  return `### ${role}\n${text}`;
}

function splitTextByApproxTokens(text, maxTokens) {
  const limit = Math.max(500, Number(maxTokens) || 3200);
  const chunks = [];
  let current = "";
  const blocks = String(text || "").split(/\n{2,}/);
  const push = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = "";
  };
  for (const block of blocks) {
    if (!block) continue;
    if (estimateTokens(block) > limit) {
      push();
      const chars = Math.max(800, Math.floor(limit * 3.1));
      for (let i = 0; i < block.length; i += chars) chunks.push(block.slice(i, i + chars));
      continue;
    }
    const next = current ? `${current}\n\n${block}` : block;
    if (estimateTokens(next) > limit) push();
    current = current ? `${current}\n\n${block}` : block;
  }
  push();
  return chunks.length ? chunks : [String(text || "")];
}

function isDeepSeekModelLabel(label) {
  return /deepseek/i.test(String(label || ""));
}

class GuardDecisionModal extends Modal {
  constructor(app, info, level, options = {}) {
    super(app);
    this.info = info;
    this.level = level;
    this.result = "cancel";
    this.options = options;
  }

  waitForDecision() {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this.open();
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("llm-hub-safe-guard-modal");
    contentEl.createEl("h2", { text: this.level === "block" ? "LLM Hub Safe Guard：高风险请求" : "LLM Hub Safe Guard：资源提醒" });

    const summary = contentEl.createDiv({ cls: "llm-hub-safe-guard-summary" });
    summary.createEl("p", { text: `模型：${this.info.model}` });
    summary.createEl("p", { text: `估算总上下文：约 ${this.info.estimatedTokens.toLocaleString()} tokens` });
    summary.createEl("p", { text: `其中：系统/固定指令约 ${this.info.systemEstimatedTokens.toLocaleString()}；对话/用户内容约 ${this.info.conversationEstimatedTokens.toLocaleString()}；工具定义约 ${this.info.toolsEstimatedTokens.toLocaleString()} tokens` });
    summary.createEl("p", { text: `消息：${this.info.messageCount} 条；文本合计：${this.info.textChars.toLocaleString()} 字符；最大单条动态内容：${this.info.maxDynamicMessageChars.toLocaleString()} 字符` });
    summary.createEl("p", { text: `实际发送图片：${this.info.actualImages} 张；用户内容中的 Markdown 图片引用：${this.info.markdownImageRefs} 处` });
    summary.createEl("p", { text: `资源判定：优先按对话/文档约 ${this.info.conversationEstimatedTokens.toLocaleString()} tokens；系统提示与工具定义只在总上下文接近模型容量时触发保护。` });

    if (this.info.markdownImageRefs > 0 && this.info.actualImages === 0) {
      contentEl.createEl("p", {
        text: "注意：你的消息/文档内容中检测到 Markdown 图片引用，但当前请求没有实际发送这些图片；模型只能看到图片路径/标记。",
        cls: "llm-hub-safe-guard-warning"
      });
    }

    contentEl.createEl("p", {
      text: "Safe Guard 按最终发往模型的完整请求计量，因此包含 LLM Hub 的系统指令和 Vault 工具定义，不只统计输入框里的文字。",
      cls: "llm-hub-safe-guard-hint"
    });

    contentEl.createEl("p", {
      text: this.level === "block"
        ? "该请求已在真正发出之前暂停。优先建议改用高级模型、缩小范围或分段处理。"
        : "该请求预计会明显增加本地 GPU/显存负载。你可以继续本地，也可以只把这一次请求路由到更合适的模型。"
    });

    if (this.options?.advancedRoute) {
      contentEl.createEl("p", {
        text: this.info.actualImages > 0
          ? (this.options.advancedVisionCapable
            ? `高级路由可用：${this.options.advancedRoute.displayName}。该模型支持视觉输入，本次 ${this.info.actualImages} 张实际图片会一并发送。API 密钥只从 LLM Hub 运行时内存读取。`
            : `高级路由可用：${this.options.advancedRoute.displayName}。该模型未标记为视觉模型；若选择它，Safe Guard 会省略本次请求中的 ${this.info.actualImages} 张实际图片。`)
          : `高级路由可用：${this.options.advancedRoute.displayName}。API 密钥只从 LLM Hub 运行时内存读取，Safe Guard 不保存也不显示密钥。`,
        cls: "llm-hub-safe-guard-hint"
      });
    }
    if (this.options?.visionModel && this.info.actualImages > 0) {
      contentEl.createEl("p", {
        text: `视觉路由可用：${this.options.visionModel}。只改变本次请求，不修改 LLM Hub 的默认模型选择。`,
        cls: "llm-hub-safe-guard-hint"
      });
    }

    const buttons = contentEl.createDiv({ cls: "llm-hub-safe-guard-buttons" });
    const cancel = buttons.createEl("button", { text: this.level === "block" ? "取消（推荐）" : "取消" });
    cancel.addEventListener("click", () => this.finish("cancel"));
    if (this.options?.advancedRoute) {
      const advancedLabel = this.info.actualImages > 0
        ? `本次改用 ${this.options.advancedRoute.shortName || "高级模型"}${this.options.advancedVisionCapable ? "（含图片）" : "（仅文本）"}`
        : `本次改用 ${this.options.advancedRoute.shortName || "高级模型"}`;
      const advanced = buttons.createEl("button", { text: advancedLabel, cls: "mod-cta" });
      advanced.addEventListener("click", () => this.finish("advanced"));
    }
    if (this.options?.visionModel && this.info.actualImages > 0) {
      const vision = buttons.createEl("button", { text: "本次改用视觉模型", cls: "mod-cta" });
      vision.addEventListener("click", () => this.finish("vision"));
    }
    const proceed = buttons.createEl("button", { text: "继续当前本地模型（承担风险）", cls: "mod-warning" });
    proceed.addEventListener("click", () => this.finish("local"));
  }

  finish(value) {
    this.result = value;
    const resolve = this._resolve;
    this._resolve = null;
    this.close();
    if (resolve) resolve(value);
  }

  onClose() {
    this.contentEl.empty();
    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve("cancel");
    }
  }
}


class ContextCompressionModal extends Modal {
  constructor(app, plugin, health, options) {
    super(app);
    this.plugin = plugin;
    this.health = health;
    this.options = options;
    this.selected = plugin.settings.defaultCompressionModel;
    if (!options.some(o => o.value === this.selected)) this.selected = options[0]?.value || "";
    this.totalMessages = plugin.getCompressionMessageCount();
    const savedDefault = Number(plugin.settings.compressionKeepRecentMessages);
    this.keepRecent = Math.max(0, Math.min(this.totalMessages, Number.isFinite(savedDefault) ? Math.round(savedDefault) : 2));
  }

  waitForDecision() {
    return new Promise(resolve => {
      this._resolve = resolve;
      this.open();
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("llm-hub-safe-guard-modal");
    contentEl.createEl("h2", { text: "上下文压缩" });
    const box = contentEl.createDiv({ cls: "llm-hub-safe-guard-summary" });
    box.createEl("p", { text: `当前手动模型：${this.health.modelLabel}` });
    box.createEl("p", { text: `预计有效上下文：约 ${this.health.usedTokens.toLocaleString()} / ${this.health.budgetTokens.toLocaleString()} tokens（${Math.round(this.health.ratio * 100)}%）` });
    this.keepTextEl = box.createEl("p");
    this.updateKeepText();

    new Setting(contentEl)
      .setName("本次压缩模型")
      .setDesc("本地模型会分块压缩；远程模型只在你明确选择时调用。")
      .addDropdown(drop => {
        for (const opt of this.options) drop.addOption(opt.value, opt.label);
        drop.setValue(this.selected);
        drop.onChange(v => { this.selected = v; });
      });

    new Setting(contentEl)
      .setName("本次保留最近消息")
      .setDesc(`可选 0–${this.totalMessages} 条。这里只决定“压缩完成这一刻”保留多少条原文；之后的新消息会正常累计，直到你下一次压缩。0 表示现有旧消息全部进入压缩记忆；${this.totalMessages} 表示本次实际上不压缩历史。`)
      .addSlider(slider => {
        slider.setLimits(0, Math.max(0, this.totalMessages), 1)
          .setValue(this.keepRecent)
          .setDynamicTooltip()
          .onChange(v => {
            this.keepRecent = Math.max(0, Math.min(this.totalMessages, Math.round(v)));
            this.updateKeepText();
          });
      });

    const buttons = contentEl.createDiv({ cls: "llm-hub-safe-guard-buttons" });
    const cancel = buttons.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.finish(null));
    if (this.plugin.getContextState().summary) {
      const clear = buttons.createEl("button", { text: "清除压缩记忆" });
      clear.addEventListener("click", () => this.finish("__clear__"));
    }
    const start = buttons.createEl("button", { text: "开始压缩", cls: "mod-cta" });
    start.addEventListener("click", () => this.finish({ model: this.selected, keepRecent: this.keepRecent }));
  }

  updateKeepText() {
    if (!this.keepTextEl) return;
    const compressCount = Math.max(0, this.totalMessages - this.keepRecent);
    this.keepTextEl.setText(`当前聊天共 ${this.totalMessages} 条可见消息；本次保留最近 ${this.keepRecent} 条原始消息，约 ${compressCount} 条进入滚动摘要。之后的新消息继续正常累计，直到下次压缩；聊天界面历史不会删除。`);
  }

  finish(value) {
    const resolve = this._resolve;
    this._resolve = null;
    this.close();
    if (resolve) resolve(value);
  }

  onClose() {
    this.contentEl.empty();
    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve(null);
    }
  }
}

class SafeGuardSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.statusEl = null;
  }

  async persist(label = "已自动保存") {
    try {
      await this.plugin.saveSettings();
      if (this.statusEl) {
        const now = new Date();
        this.statusEl.setText(`${label} · ${now.toLocaleTimeString()}`);
        this.statusEl.removeClass("llm-hub-safe-guard-save-error");
      }
      return true;
    } catch (err) {
      console.error("[LLM Hub Safe Guard] save settings failed", err);
      if (this.statusEl) {
        this.statusEl.setText(`保存失败：${err?.message || err}`);
        this.statusEl.addClass("llm-hub-safe-guard-save-error");
      }
      new Notice(`LLM Hub Safe Guard 设置保存失败：${err?.message || err}`);
      return false;
    }
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "LLM Hub Safe Guard" });
    containerEl.createEl("p", { text: "安全代理只保护经由 Safe Guard 地址发送的本地 LLM 请求。RAG embedding 和其他直接使用 11434 的软件不受影响。设置会在有效输入后自动保存；下方也提供“保存并应用”按钮。" });

    const statusRow = containerEl.createDiv({ cls: "llm-hub-safe-guard-save-status" });
    statusRow.createEl("strong", { text: "设置状态：" });
    this.statusEl = statusRow.createSpan({ text: "已加载当前设置" });

    new Setting(containerEl)
      .setName("启用安全检查")
      .setDesc("关闭后仍保持代理转发，但不弹出风险确认。")
      .addToggle(t => t.setValue(this.plugin.settings.enabled).onChange(async v => {
        this.plugin.settings.enabled = v;
        await this.persist();
      }));

    new Setting(containerEl)
      .setName("Safe Guard 监听端口")
      .setDesc("修改后点击“保存并应用”即可重启代理。推荐保持 11435。")
      .addText(t => t.setValue(String(this.plugin.settings.listenPort)).onChange(async v => {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0 && n < 65536) {
          this.plugin.settings.listenPort = n;
          await this.persist("端口已保存，待应用");
        } else if (this.statusEl) {
          this.statusEl.setText("端口无效，未保存");
        }
      }));

    new Setting(containerEl)
      .setName("Ollama 上游地址")
      .setDesc("你的真实 Ollama 服务仍保持 11434。")
      .addText(t => t.setValue(this.plugin.settings.upstreamBaseUrl).onChange(async v => {
        const next = v.trim().replace(/\/+$/, "");
        if (next) {
          this.plugin.settings.upstreamBaseUrl = next;
          await this.persist();
        }
      }));

    new Setting(containerEl)
      .setName("对话/文档警告阈值（估算 tokens）")
      .setDesc("只按对话历史、用户内容、读取到的文档/工具结果计算；不再因为固定系统提示和工具定义过大而仅发送‘你好’就提醒。16K context 建议 8000。")
      .addText(t => t.setValue(String(this.plugin.settings.warningEstimatedTokens)).onChange(async v => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 100) {
          this.plugin.settings.warningEstimatedTokens = Math.round(n);
          await this.persist();
        } else if (this.statusEl) {
          this.statusEl.setText("警告阈值至少为 100，当前输入未保存");
        }
      }));

    new Setting(containerEl)
      .setName("对话/文档阻止阈值（估算 tokens）")
      .setDesc("同样只按动态对话/文档内容计算。正式使用建议 11000；接近上下文硬上限时还会由总上下文保护兜底。")
      .addText(t => t.setValue(String(this.plugin.settings.blockEstimatedTokens)).onChange(async v => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 200) {
          this.plugin.settings.blockEstimatedTokens = Math.round(n);
          await this.persist();
        } else if (this.statusEl) {
          this.statusEl.setText("阻止阈值至少为 200，当前输入未保存");
        }
      }));

    new Setting(containerEl)
      .setName("本地模型上下文容量")
      .setDesc("用于总上下文兜底保护。你的 Ollama 当前按 16K 使用时保持 16384；完整请求达到约 82% 时警告、95% 时高风险。")
      .addText(t => t.setValue(String(this.plugin.settings.contextWindowTokens)).onChange(async v => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 2048) {
          this.plugin.settings.contextWindowTokens = Math.round(n);
          await this.persist();
        } else if (this.statusEl) {
          this.statusEl.setText("上下文容量无效，未保存");
        }
      }));

    new Setting(containerEl)
      .setName("图片警告/阻止")
      .setDesc("针对真正随请求发送给视觉模型的图片数量。格式：警告,阻止，例如 4,8。")
      .addText(t => t.setValue(`${this.plugin.settings.warningActualImages},${this.plugin.settings.blockActualImages}`).onChange(async v => {
        const [a,b] = v.split(",").map(x => Number(x.trim()));
        if (Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a) {
          this.plugin.settings.warningActualImages = a;
          this.plugin.settings.blockActualImages = b;
          await this.persist();
        } else if (this.statusEl) {
          this.statusEl.setText("图片阈值格式无效，应为“警告,阻止”，且阻止值更大");
        }
      }));

    containerEl.createEl("h3", { text: "Markdown Vision Bridge（v0.6）" });
    containerEl.createEl("p", { text: "把聊天/选中文本里的 Markdown、Wiki 和 HTML 图片引用解析为 Vault 中的真实图片，并作为多模态图片随请求发送。支持本地 11435 路径和手工选择 DeepSeek 的直连 API Provider。" });

    new Setting(containerEl)
      .setName("启用 Markdown 图片桥接")
      .setDesc("推荐开启。支持 ![](path)、![[path]] 和 <img src=...>；仅解析 Vault 内本地图片，不下载外部 URL。")
      .addToggle(t => t.setValue(this.plugin.settings.markdownVisionEnabled !== false).onChange(async v => {
        this.plugin.settings.markdownVisionEnabled = v;
        await this.persist();
        this.plugin.ensureAutoPanelControls();
      }));

    new Setting(containerEl)
      .setName("手工 API Provider 图片桥接")
      .setDesc("为 LLM Hub 中手工选择的 DeepSeek/视觉 API Provider 安装一个严格限定的 fetch 钩子。只在当前请求含本地 Markdown 图片引用且模型支持视觉时改写请求；卸载插件时自动恢复。")
      .addToggle(t => t.setValue(this.plugin.settings.markdownVisionDirectProviderHook !== false).onChange(async v => {
        this.plugin.settings.markdownVisionDirectProviderHook = v;
        await this.persist();
        if (v) this.plugin.installDirectProviderVisionHook();
        else this.plugin.uninstallDirectProviderVisionHook();
      }));

    new Setting(containerEl)
      .setName("单张 Markdown 图片上限（MB）")
      .setDesc("超过该大小不会静默发送，会在状态/Notice 中明确标记。默认 16 MB，避免 base64 请求体过大。")
      .addText(t => t.setValue(String(this.plugin.settings.markdownVisionMaxImageMB || 16)).onChange(async v => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 1 && n <= 32) {
          this.plugin.settings.markdownVisionMaxImageMB = Math.round(n);
          await this.persist();
        } else if (this.statusEl) {
          this.statusEl.setText("单张图片上限应为 1-32 MB");
        }
      }));

    new Setting(containerEl)
      .setName("单次本地请求硬超时")
      .setDesc("超过该时间会中止 Safe Guard 与 Ollama 的连接，避免单次任务长时间占用。默认 240 秒（4 分钟）。")
      .addText(t => t.setValue(String(this.plugin.settings.hardTimeoutSeconds)).onChange(async v => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 30) {
          this.plugin.settings.hardTimeoutSeconds = Math.round(n);
          await this.persist();
        } else if (this.statusEl) {
          this.statusEl.setText("硬超时至少为 30 秒，当前输入未保存");
        }
      }));

    containerEl.createEl("h3", { text: "Vault 默认权限（B2）" });
    containerEl.createEl("p", { text: "新聊天默认 Read Only；当前聊天中如果你主动切到 All / No Search，则本聊天保持写权限。下一次新聊天会自动恢复 Read Only。Safe Guard 同时在代理层移除写入类 Vault tools，作为 UI 同步失败时的保底。" });

    new Setting(containerEl)
      .setName("新聊天默认 Read Only")
      .setDesc("推荐开启。不会在当前聊天中反复强制覆盖你的手动选择。")
      .addToggle(t => t.setValue(this.plugin.settings.defaultReadOnlyEnabled).onChange(async v => {
        this.plugin.settings.defaultReadOnlyEnabled = v;
        await this.persist();
        if (v) this.plugin.resetSessionReadOnly("设置启用");
      }));

    new Setting(containerEl)
      .setName("同步 LLM Hub 界面")
      .setDesc("尝试把 LLM Hub 的 Vault 模式按钮同步成 Read Only。即使未来 LLM Hub UI 改版导致同步失败，下面的代理层只读保护仍可继续工作。")
      .addToggle(t => t.setValue(this.plugin.settings.syncLlmHubUi).onChange(async v => {
        this.plugin.settings.syncLlmHubUi = v;
        await this.persist();
        if (v && this.plugin.settings.defaultReadOnlyEnabled) this.plugin.resetSessionReadOnly("UI同步启用");
      }));

    new Setting(containerEl)
      .setName("代理层强制 Read Only")
      .setDesc("推荐开启。只读会移除 create/edit/delete/rename/create_folder 等写工具；当你在当前聊天主动选择 All / No Search 时临时解锁。")
      .addToggle(t => t.setValue(this.plugin.settings.enforceProxyReadOnly).onChange(async v => {
        this.plugin.settings.enforceProxyReadOnly = v;
        await this.persist();
      }));

    new Setting(containerEl)
      .setName("当前聊天权限")
      .setDesc(this.plugin.sessionWriteUnlocked ? "当前聊天：写入已解锁（All / No Search）" : "当前聊天：Read Only")
      .addButton(btn => btn.setButtonText("恢复 Read Only").onClick(async () => {
        await this.plugin.lockCurrentChat(true);
        this.display();
      }))
      .addButton(btn => btn.setButtonText("允许 All").setWarning().onClick(async () => {
        await this.plugin.unlockCurrentChat(true);
        this.display();
      }));


    containerEl.createEl("h3", { text: "智能路由（v0.5）" });
    containerEl.createEl("p", { text: "Auto 可在设置页和 Chat 面板随时开关。风险弹窗中手动选择 DeepSeek 后，会把当前连续对话锁定在该路由；面板会显示持续路由状态，点击 × 即恢复普通 Auto 判定。新聊天自动回到普通 Auto。" });

    new Setting(containerEl)
      .setName("启用智能路由")
      .setDesc("关闭后仍保留资源守卫和 Read Only，但所有允许请求都继续走当前本地模型。")
      .addToggle(t => t.setValue(this.plugin.settings.routerEnabled).onChange(async v => {
        await this.plugin.setRouterEnabled(v, false);
        if (this.statusEl) this.statusEl.setText(`Auto 路由已${v ? "开启" : "关闭"} · ${new Date().toLocaleTimeString()}`);
      }));

    new Setting(containerEl)
      .setName("低风险图片自动走视觉模型")
      .setDesc("实际随请求发送了图片且未达到资源警告阈值时，自动把本次请求模型改为下面的视觉模型。不会处理仅存在 Markdown 图片路径、但图片没有实际附加到请求的情况。")
      .addToggle(t => t.setValue(this.plugin.settings.autoRouteImages).onChange(async v => {
        this.plugin.settings.autoRouteImages = v;
        await this.persist();
      }));

    new Setting(containerEl)
      .setName("视觉模型 ID")
      .setDesc("Ollama 中的真实模型 ID。当前建议 qwen3-vl:4b-instruct。")
      .addText(t => t.setValue(this.plugin.settings.visionModel).onChange(async v => {
        const next = v.trim();
        if (next) {
          this.plugin.settings.visionModel = next;
          await this.persist();
        }
      }));

    new Setting(containerEl)
      .setName("允许本次请求路由到高级模型")
      .setDesc("仅在风险弹窗中由你手动确认。Safe Guard 会复用 LLM Hub 已加载到内存中的 API 配置和密钥，不复制密钥到自己的 data.json。")
      .addToggle(t => t.setValue(this.plugin.settings.advancedRouteEnabled).onChange(async v => {
        this.plugin.settings.advancedRouteEnabled = v;
        await this.persist();
      }));

    new Setting(containerEl)
      .setName("高级模型提供方关键词")
      .setDesc("用于从 LLM Hub 已启用 API Provider 中自动定位目标。默认 DeepSeek。")
      .addText(t => t.setValue(this.plugin.settings.advancedProviderHint).onChange(async v => {
        this.plugin.settings.advancedProviderHint = v.trim();
        await this.persist();
      }));

    new Setting(containerEl)
      .setName("高级模型关键词")
      .setDesc("默认 deepseek-flash；如果模型名称调整，可在此修改关键词。")
      .addText(t => t.setValue(this.plugin.settings.advancedModelHint).onChange(async v => {
        this.plugin.settings.advancedModelHint = v.trim();
        await this.persist();
      }));

    const route = this.plugin.getAdvancedRoute();
    const routerStatus = containerEl.createDiv({ cls: "llm-hub-safe-guard-status" });
    routerStatus.createEl("strong", { text: "视觉路由：" });
    routerStatus.createSpan({ text: this.plugin.settings.visionModel || "未配置" });
    routerStatus.createEl("br");
    routerStatus.createEl("strong", { text: "高级路由：" });
    routerStatus.createSpan({ text: route ? `已检测 ${route.displayName}` : "未检测到可用 DeepSeek/API Provider（不会读取或显示密钥）" });
    routerStatus.createEl("br");
    routerStatus.createEl("strong", { text: "最近一次路由：" });
    routerStatus.createSpan({ text: this.plugin.lastRouteLabel || "尚无" });
    routerStatus.createEl("br");
    routerStatus.createEl("strong", { text: "当前连续路由：" });
    routerStatus.createSpan({ text: this.plugin.conversationPinnedRoute ? `持续 ${this.plugin.routeDisplayName(this.plugin.conversationPinnedRoute)}（可在 Chat 面板点击 × 取消）` : "无，按 Auto 正常判定" });


    containerEl.createEl("h3", { text: "上下文管理（v0.5）" });
    containerEl.createEl("p", { text: "使用 Rolling Summary：聊天界面保留完整历史，真正发送给模型时仅保留压缩记忆 + 你为该次压缩选择的最近 N 条原始消息 + 新问题。状态颜色按 LLM Hub 当前手动选择的模型计算，不受 Auto 路由或持续路由影响。" });

    new Setting(containerEl)
      .setName("启用上下文管理")
      .setDesc("开启彩色上下文状态、手动压缩、取消消息隔离和压缩记忆。")
      .addToggle(t => t.setValue(this.plugin.settings.contextManagerEnabled).onChange(async v => {
        this.plugin.settings.contextManagerEnabled = v;
        await this.persist();
        this.plugin.ensureAutoPanelControls();
      }));

    const compressionOptions = this.plugin.getCompressionModelOptions();
    new Setting(containerEl)
      .setName("默认压缩模型")
      .setDesc("点击上下文状态后仍可为单次压缩临时改选。远程模型不会被静默调用。")
      .addDropdown(drop => {
        for (const opt of compressionOptions) drop.addOption(opt.value, opt.label);
        if (this.plugin.settings.defaultCompressionModel && !compressionOptions.some(o => o.value === this.plugin.settings.defaultCompressionModel)) {
          drop.addOption(this.plugin.settings.defaultCompressionModel, this.plugin.settings.defaultCompressionModel);
        }
        drop.setValue(this.plugin.settings.defaultCompressionModel);
        drop.onChange(async v => {
          this.plugin.settings.defaultCompressionModel = v;
          await this.persist();
        });
      });

    new Setting(containerEl)
      .setName("本地压缩分块大小")
      .setDesc("估算 token。默认 3200，避免让本地 4B 模型为了压缩上下文本身先进入高负载。")
      .addText(t => t.setValue(String(this.plugin.settings.compressionChunkTokens)).onChange(async v => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 1000 && n <= 12000) {
          this.plugin.settings.compressionChunkTokens = Math.round(n);
          await this.persist();
        }
      }));

    new Setting(containerEl)
      .setName("目标摘要大小")
      .setDesc("估算 token。默认约 1200，用于长期滚动记忆。")
      .addText(t => t.setValue(String(this.plugin.settings.compressionTargetTokens)).onChange(async v => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 400 && n <= 4000) {
          this.plugin.settings.compressionTargetTokens = Math.round(n);
          await this.persist();
        }
      }));

    new Setting(containerEl)
      .setName("默认保留最近消息")
      .setDesc("作为每次打开压缩窗口的默认值；单次压缩可在 0–当前聊天全部消息数之间临时选择。0 表示全部旧消息进入摘要。")
      .addText(t => t.setValue(String(this.plugin.settings.compressionKeepRecentMessages)).onChange(async v => {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 0 && n <= 99) {
          this.plugin.settings.compressionKeepRecentMessages = n;
          await this.persist();
        }
      }));

    new Setting(containerEl)
      .setName("DeepSeek 上下文 / 输出预留")
      .setDesc("默认按官方当前 1M Context；思考模式默认输出预留 64K。格式：上下文,预留，例如 1000000,64000。")
      .addText(t => t.setValue(`${this.plugin.settings.deepSeekContextTokens},${this.plugin.settings.deepSeekOutputReserveTokens}`).onChange(async v => {
        const [a,b] = v.split(",").map(x => Number(x.trim()));
        if (Number.isFinite(a) && Number.isFinite(b) && a >= 100000 && b >= 1000 && b < a) {
          this.plugin.settings.deepSeekContextTokens = Math.round(a);
          this.plugin.settings.deepSeekOutputReserveTokens = Math.round(b);
          await this.persist();
        }
      }));

    const ctxState = this.plugin.getContextState();
    const ctxHealth = this.plugin.getContextHealth();
    const ctxStatus = containerEl.createDiv({ cls: "llm-hub-safe-guard-status" });
    ctxStatus.createEl("strong", { text: "当前上下文：" });
    ctxStatus.createSpan({ text: `${ctxHealth.modelLabel} · ${Math.round(ctxHealth.ratio * 100)}% · ${ctxHealth.level}` });
    ctxStatus.createEl("br");
    ctxStatus.createEl("strong", { text: "压缩记忆：" });
    ctxStatus.createSpan({ text: ctxState.summary ? `已启用，约 ${estimateTokens(ctxState.summary).toLocaleString()} tokens；覆盖到第 ${ctxState.summaryCoveredCount || 0} 条可见消息` : "未建立" });
    ctxStatus.createEl("br");
    ctxStatus.createEl("strong", { text: "最近压缩：" });
    ctxStatus.createSpan({ text: ctxState.lastCompressedAt ? new Date(ctxState.lastCompressedAt).toLocaleString() : "尚无" });

    new Setting(containerEl)
      .setName("保存设置")
      .setDesc("通常无需手动保存；此按钮用于明确保存并重启安全代理，使监听端口等变化立即生效。")
      .addButton(btn => btn
        .setButtonText("保存并应用")
        .setCta()
        .onClick(async () => {
          const ok = await this.persist("已保存，正在应用");
          if (!ok) return;
          await this.plugin.restartProxy();
          if (this.statusEl) this.statusEl.setText(`已保存并应用 · ${new Date().toLocaleTimeString()}`);
          new Notice("LLM Hub Safe Guard 设置已保存并应用");
        }))
      .addButton(btn => btn
        .setButtonText("恢复默认")
        .onClick(async () => {
          this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
          await this.persist("已恢复默认");
          await this.plugin.restartProxy();
          this.display();
          new Notice("LLM Hub Safe Guard 已恢复默认设置");
        }));

    const status = containerEl.createDiv({ cls: "llm-hub-safe-guard-status" });
    status.createEl("strong", { text: "代理地址：" });
    status.createSpan({ text: `http://${this.plugin.settings.listenHost}:${this.plugin.settings.listenPort}` });
    status.createEl("br");
    status.createEl("strong", { text: "健康检查：" });
    status.createSpan({ text: `http://${this.plugin.settings.listenHost}:${this.plugin.settings.listenPort}/health` });
    status.createEl("br");
    status.createEl("strong", { text: "LLM Hub 版本：" });
    status.createSpan({ text: this.plugin.getLlmHubVersion() });
    status.createEl("br");
    status.createEl("strong", { text: "Vault Guard：" });
    status.createSpan({ text: this.plugin.sessionWriteUnlocked ? "当前聊天允许写入" : "当前聊天 Read Only" });
    status.createEl("br");
    status.createEl("strong", { text: "UI 同步：" });
    status.createSpan({ text: this.plugin.uiBridgeStatus });
  }
}

module.exports = class SafeGuardRuntime extends Component {
  constructor(host) {
    super();
    this.disposed = false;
    this.host = host;
    this.app = host.app;
    this.manifest = { ...host.manifest, id: 'llmhubpp-safe-guard', name: 'LLM Hub Safe Guard', version: '0.6.2' };
    this.ready = Promise.resolve();
    this.saveQueue = Promise.resolve();
    this.configurationActiveRequests = 0;
    this.configurationReloading = false;
  }
  onload() { this.ready = this.initialize(); }
  addCommand(command) { return this.host.addCommand(command); }
  addSettingTab(tab) { return this.host.addSettingTab(tab); }
  async loadData() {
    const file = `${this.host.manifest.dir}/safe-guard.json`;
    return await this.app.vault.adapter.exists(file) ? JSON.parse(await this.app.vault.adapter.read(file)) : null;
  }
  saveData(data) {
    const text = JSON.stringify(data, null, 2);
    const next = this.saveQueue.catch(() => {}).then(() => this.app.vault.adapter.write(`${this.host.manifest.dir}/safe-guard.json`, text));
    this.saveQueue = next;
    return next;
  }
  async initialize() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (this.disposed) return;
    this.server = null;
    this.proxyStartPromise = null;
    this.isUnloading = false;
    this.sessionWriteUnlocked = false;
    // B2 session policy: remember the user's explicit Vault mode for the current
    // chat. New chats start at readOnly, but manual All / No Search / Off choices
    // survive model switches within the same chat.
    this.sessionDesiredVaultMode = "readOnly";
    this.lastSeenChatId = undefined;
    this.uiBridgeStatus = "等待 LLM Hub Chat";
    this.uiBridgeSyncedForLock = false;
    this.uiSyncInFlight = false;
    this.lastRemovedWriteTools = [];
    this.activeTurnRoute = null;
    this.lastRouteLabel = "";
    this.recentRouteDecisions = new Map();
    this.routeUiState = null;
    this.routeUiObserver = null;
    this.routeUiRefreshScheduled = false;
    this.contextHealthCache = null;
    this.conversationPinnedRoute = null;
    // v0.5.4: models such as Ollama native deliberately do not expose Vault
    // function-calling in LLM Hub. Track that capability separately from the
    // user's desired per-chat mode so we never fight LLM Hub with a DOM loop.
    this.vaultCapabilityRestricted = false;
    this.vaultCapabilityModelKey = "";

    // v0.5 Context Manager runtime state. v0.5.9 persists compressed memory
    // twice: plugin data.json for fast lookup and a per-chat sidecar next to the
    // LLM Hub workspace so closing/reopening a history cannot silently drop memory.
    this.contextStates = new Map();
    this.contextDraftSerial = 1;
    this.currentContextKey = `draft:${Date.now()}:${this.contextDraftSerial++}`;
    this.compressionInProgress = false;
    this.compressionProgress = { stage: "idle", current: 0, total: 0 };
    this.historySyncInFlight = false;
    this.baseHistoryLimit = null;
    this.baseLlmHubSystemPrompt = null;
    this.contextRuntimeMemoryApplied = false;
    // v0.5.8 compression provenance / export-marker bridge. These markers are
    // Safe Guard metadata only; they are not ordinary user messages.
    this.manualSaveMarkerUntil = 0;
    this.manualSaveMarkerContextKey = null;
    this.manualExportPatchInFlight = new Set();
    this.historyLoadPending = false;
    this.historyLoadPendingAt = 0;
    this.contextPersistenceSource = "none";
    this.contextSidecarPath = null;
    // v0.5.10: proxy-level guarantee that the compressed-memory prompt is
    // present even immediately after history/model switches.
    this.contextMemoryPromptEnsured = false;

    // v0.6 Markdown Vision Bridge diagnostics and a narrowly-scoped direct
    // provider fetch hook. The hook is needed because a manually selected
    // DeepSeek API Provider bypasses the local 11435 proxy entirely.
    this.lastMarkdownVision = { refs: 0, resolved: 0, attached: 0, missing: [], unsupported: [], tooLarge: [], sourcePaths: [], channel: "none", at: 0 };
    this.markdownVisionNoticeKey = "";
    this.originalGlobalFetch = null;
    this.directProviderFetchWrapper = null;
    this.directProviderVisionHookInstalled = false;
    // v0.6.1: OpenAI SDK clients inside LLM Hub may capture their own fetch
    // implementation before Safe Guard can wrap globalThis.fetch.  For manual
    // visual API providers, bridge Markdown images one layer earlier by feeding
    // them into LLM Hub's native pending-attachment input before the send event.
    this.nativeVisionAttachmentBridgeEnabled = true;
    this.nativeVisionAttachmentBridgeInFlight = false;
    this.nativeVisionResendBypassUntil = 0;
    this.nativeVisionFetchBypassUntil = 0;
    // v0.6.2 unified image-input bridge.  Keep lightweight preview URLs for
    // native attachments so user-image bubbles can render the actual picture,
    // not only the filename chip.  Vault-backed references use getResourcePath
    // and therefore remain renderable without storing base64 in chat text.
    this.visionPreviewByName = new Map();
    this.visionPreviewObjectUrls = new Set();
    this.visionPreviewRenderedCount = 0;
    this.visionPendingConfirmed = false;
    this.visionLastInputMode = "none";
    this.visionAutoAttachInFlight = false;

    this.addSettingTab(new SafeGuardSettingTab(this.app, this));
    await this.startProxy();
    if (this.disposed || this.isUnloading) return;
    this.setupVaultModeGuard();
    if (this.settings.markdownVisionEnabled !== false && this.settings.markdownVisionDirectProviderHook !== false) {
      this.installDirectProviderVisionHook();
    }
  }

  getLlmHubPlugin() {
    return this.host;
  }

  getLlmHubVersion() {
    return this.getLlmHubPlugin()?.manifest?.version || "未检测到";
  }

  getSelectedLlmHubModelInfo() {
    const hub = this.getLlmHubPlugin();
    if (!hub) return { model: "", restriction: null };
    let model = "";
    try { model = String(typeof hub.getSelectedModel === "function" ? hub.getSelectedModel() : (hub.workspaceState?.selectedModel || "")); } catch (_) {}
    if (!model) return { model, restriction: null };

    // LLM Hub 0.36.6 treats Antigravity / Claude CLI and local LLM entries
    // without native tool support as Vault-restricted. Ollama's native
    // framework is intentionally in this category: LLM Hub routes it through
    // /api/chat and does not expose its Vault function-calling tools there.
    if (model === "antigravity-cli" || model === "claude-cli") {
      return { model, restriction: { forcedMode: "none", reason: "当前 CLI 模式不提供 LLM Hub Vault Tools" } };
    }

    if (model === "local-llm" || model.startsWith("local-llm:")) {
      const rest = model.startsWith("local-llm:") ? model.slice("local-llm:".length) : "";
      const colon = rest.indexOf(":");
      const configId = colon >= 0 ? rest.slice(0, colon) : rest;
      const explicitModel = colon >= 0 ? rest.slice(colon + 1) : "";
      const configs = Array.isArray(hub.settings?.localLlmConfigs) ? hub.settings.localLlmConfigs : [];
      const cfg = configId ? configs.find(c => c?.id === configId) : configs.find(c => c?.verified === true && c?.enabled !== false);
      if (cfg) {
        const framework = String(cfg.framework || "");
        const modelName = explicitModel || cfg.model || (Array.isArray(cfg.enabledModels) ? cfg.enabledModels[0] : "") || "";
        const frameworkTools = framework === "lm-studio" || framework === "anythingllm" || framework === "vllm" || framework === "opencode";
        const explicitlyUnsupported = Array.isArray(cfg.toolsUnsupportedModels) && cfg.toolsUnsupportedModels.includes(modelName);
        if (!frameworkTools || explicitlyUnsupported) {
          const reason = framework === "ollama"
            ? "Ollama Native 在 LLM Hub 0.36.6 中不提供 Vault Tools"
            : `当前本地配置（${framework || "unknown"}）不提供 Vault Tools`;
          return { model, restriction: { forcedMode: "none", reason, framework, modelName } };
        }
      }
    }
    return { model, restriction: null };
  }

  refreshVaultCapabilityRestriction() {
    const info = this.getSelectedLlmHubModelInfo();
    const key = `${info.model}|${info.restriction?.forcedMode || "normal"}`;
    const changed = key !== this.vaultCapabilityModelKey;
    this.vaultCapabilityModelKey = key;

    if (info.restriction) {
      this.vaultCapabilityRestricted = true;
      // This is stricter than Read Only: there are no Vault tools to call at all.
      // Keep sessionDesiredVaultMode untouched so it can be restored as soon as
      // the user switches back to a tools-capable model.
      this.uiBridgeSyncedForLock = true;
      this.uiBridgeStatus = `当前模型：Vault Off（${info.restriction.reason}）`;
      return { restricted: true, ...info };
    }

    if (this.vaultCapabilityRestricted || changed) {
      this.vaultCapabilityRestricted = false;
      // We are back on a model that can expose Vault modes. Re-apply the user's
      // desired per-chat mode once; do not reset it to All.
      this.uiBridgeSyncedForLock = false;
    }
    return { restricted: false, ...info };
  }

  setupVaultModeGuard() {
    this.addCommand({
      id: "lock-current-chat-read-only",
      name: "当前聊天恢复 Vault Read Only",
      callback: () => { void this.lockCurrentChat(true); }
    });
    this.addCommand({
      id: "unlock-current-chat-all",
      name: "当前聊天允许 Vault All",
      callback: () => { void this.unlockCurrentChat(true); }
    });
    this.addCommand({
      id: "toggle-auto-router",
      name: "切换 Auto 智能路由",
      callback: () => { void this.setRouterEnabled(!this.settings.routerEnabled, true); }
    });
    this.addCommand({
      id: "cancel-pinned-route",
      name: "取消当前连续模型路由，恢复 Auto",
      callback: () => this.clearConversationPinnedRoute(true)
    });
    this.addCommand({
      id: "resync-vault-read-only-ui",
      name: "重新同步 LLM Hub Vault Read Only",
      callback: () => { void this.ensureLlmHubUiMode("readOnly", true); }
    });
    this.addCommand({
      id: "compress-current-context",
      name: "压缩当前聊天上下文",
      callback: () => { void this.startCompressionFlow(false); }
    });
    this.addCommand({
      id: "rebuild-context-memory-from-full-history",
      name: "从完整聊天历史重建压缩记忆",
      callback: () => { void this.startCompressionFlow(true); }
    });
    this.addCommand({
      id: "clear-context-memory",
      name: "清除当前聊天压缩记忆",
      callback: () => { void this.clearCurrentContextMemory(true); }
    });

    this.registerDomEvent(document, "click", (evt) => this.handleLlmHubClick(evt), true);
    this.registerDomEvent(document, "paste", (evt) => { void this.handleVisionPaste(evt); }, true);
    this.registerDomEvent(document, "change", (evt) => this.handleVisionAttachmentInputChange(evt), true);
    // Manual "Save as note" exports are produced by LLM Hub from its React
    // message state. Because Safe Guard's compression divider is intentionally
    // UI metadata (not a fake chat message), patch the exported Markdown with a
    // small compression log immediately after LLM Hub writes it.
    this.registerEvent(this.app.vault.on("create", (file) => { void this.maybePatchManualChatExport(file); }));
    this.registerEvent(this.app.vault.on("modify", (file) => { void this.maybePatchManualChatExport(file); }));
    this.registerDomEvent(document, "keydown", (evt) => {
      const target = evt.target instanceof Element ? evt.target : null;

      // Keyboard model selection (Enter in the model popover) goes through the
      // same B2 preservation path as a mouse click. LLM Hub itself resets normal
      // models to Vault: all in handleModelChange(), so re-apply the current
      // chat's desired mode after React commits the model switch.
      if (target?.closest(".llm-hub-model-picker-popover") && evt.key === "Enter") {
        this.scheduleVaultModeRestoreAfterModelSwitch();
      }

      if (evt.key === "Enter" && !evt.shiftKey && target?.closest(".llm-hub-composer")) {
        if (this.tryInterceptNativeProviderVisionSend(evt, null)) return;
      }

      if (!this.compressionInProgress) return;
      if (!target || !target.closest(".llm-hub-composer")) return;
      if (evt.key === "Enter" && !evt.shiftKey) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        new Notice("LLM Hub Safe Guard：上下文压缩进行中，请等待完成后再发送。", 1800);
      }
    }, true);

    // Observe LLM Hub mounting/rendering without reacting to our own controls.
    // v0.5.0 observed every text mutation and then rewrote the context-button text,
    // which could create a self-triggering MutationObserver loop and peg the UI thread.
    this.routeUiObserver = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) => {
        const node = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
        if (!node) return true;
        return !node.closest?.(".llm-hub-safe-guard-auto-controls, .llm-hub-safe-guard-modal, .llm-hub-safe-guard-compression-marker");
      });
      if (!relevant) return;

      // When the Chat UI mounts for the first time after Obsidian starts, first
      // honor model capability restrictions (e.g. Ollama Native = Vault Off).
      // Only tools-capable models should be driven back to the user's desired B2 mode.
      this.refreshVaultCapabilityRestriction();
      this.trySyncDesiredVaultMode();

      if (this.routeUiRefreshScheduled) return;
      this.routeUiRefreshScheduled = true;
      window.requestAnimationFrame(() => {
        this.routeUiRefreshScheduled = false;
        this.applyActualRouteUi();
        this.ensureAutoPanelControls();
        this.applyCompressionMarkers();
        this.applyVisionAttachmentPreviews();
      });
    });
    // childList is enough to detect LLM Hub mount/message rows; do not observe
    // characterData, because streaming/token text is far too noisy.
    this.routeUiObserver.observe(document.body, { childList: true, subtree: true });

    const pollId = window.setInterval(() => this.pollLlmHubChatState(), 500);
    this.registerInterval(pollId);

    this.app.workspace.onLayoutReady(() => {
      const hub = this.getLlmHubPlugin();
      if (hub) {
        this.baseLlmHubSystemPrompt = String(hub.settings?.systemPrompt || "");
        this.baseHistoryLimit = Number(hub.workspaceState?.maxPreviousMessages ?? 99);
      }
      if (this.settings.defaultReadOnlyEnabled) this.resetSessionReadOnly("Obsidian启动");
      this.applyRuntimeMemoryForCurrentChat();
      this.ensureAutoPanelControls();
    });
  }

  handleLlmHubClick(evt) {
    const target = evt.target instanceof Element ? evt.target : null;
    if (!target) return;

    // v0.6.1 manual DeepSeek / visual-provider bridge.  LLM Hub's API-provider
    // SDK path does not necessarily call the current globalThis.fetch, so the
    // v0.6.0 network hook can be bypassed.  Intercept the user's send before
    // React handles it, inject the resolved Markdown image as a normal LLM Hub
    // attachment, then replay the same send once the attachment chip exists.
    const sendButton = target.closest(".llm-hub-send-btn");
    if (sendButton && this.tryInterceptNativeProviderVisionSend(evt, sendButton)) return;

    const headerButton = target.closest(".llm-hub-chat-header button");
    if (headerButton) {
      const label = `${headerButton.getAttribute("title") || ""} ${headerButton.getAttribute("aria-label") || ""} ${headerButton.textContent || ""}`;
      if (/(?:save\s+as\s+note|saved\s+as|保存为?笔记|已保存)/i.test(label)) {
        this.armManualSaveMarkerPatch();
      }
    }

    const modeItem = target.closest(".llm-hub-vault-tool-item");
    if (modeItem) {
      const visibleItems = Array.from(document.querySelectorAll(".llm-hub-vault-tool-item"))
        .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
      const idx = visibleItems.indexOf(modeItem);
      if (idx === 0 || idx === 1) {
        this.sessionWriteUnlocked = true;
        this.sessionDesiredVaultMode = idx === 0 ? "all" : "noSearch";
        this.uiBridgeSyncedForLock = false;
        this.uiBridgeStatus = idx === 0 ? "当前聊天：All" : "当前聊天：No Search";
      } else if (idx === 2 || idx === 3) {
        this.sessionWriteUnlocked = false;
        this.sessionDesiredVaultMode = idx === 2 ? "readOnly" : "none";
        this.uiBridgeSyncedForLock = idx === 2;
        this.uiBridgeStatus = idx === 2 ? "当前聊天：Read Only" : "当前聊天：Off";
      }
      return;
    }

    // LLM Hub 0.36.6 intentionally resets normal models to Vault: all inside
    // handleModelChange(). Preserve the current chat's explicit B2 mode instead.
    if (target.closest(".llm-hub-model-picker-option")) {
      this.scheduleVaultModeRestoreAfterModelSwitch();
    }

    const button = target.closest("button");
    if (button && button.closest(".llm-hub-chat-header") && button.querySelector("svg.lucide-plus")) {
      this.beginNewContext("新聊天");
      this.resetRouterConversation("新聊天");
      window.setTimeout(() => this.resetSessionReadOnly("新聊天"), 20);
      return;
    }

    if (target.closest(".llm-hub-history-item")) {
      this.historyLoadPending = true;
      this.historyLoadPendingAt = Date.now();
      this.currentContextKey = `switch:${Date.now()}`;
      this.contextHealthCache = null;
      this.resetRouterConversation("切换聊天");
      window.setTimeout(() => this.resetSessionReadOnly("切换聊天"), 20);
      window.setTimeout(() => { void this.reconcileHistoryLoad(); }, 180);
    }
  }

  pollLlmHubChatState() {
    const hub = this.getLlmHubPlugin();
    this.ensureAutoPanelControls();
    if (!hub) return;

    if (this.baseLlmHubSystemPrompt === null) this.baseLlmHubSystemPrompt = String(hub.settings?.systemPrompt || "");
    if (this.baseHistoryLimit === null) this.baseHistoryLimit = Number(hub.workspaceState?.maxPreviousMessages ?? 99);

    const capability = this.refreshVaultCapabilityRestriction();

    const current = hub.lastActiveChatId ?? null;
    if (this.lastSeenChatId === undefined) {
      this.lastSeenChatId = current;
      if (current !== null) this.currentContextKey = `id:${current}`;
      this.applyRuntimeMemoryForCurrentChat();
      return;
    }

    if (current !== this.lastSeenChatId) {
      const previous = this.lastSeenChatId;
      this.lastSeenChatId = current;

      if (previous === null && current !== null) {
        const oldKey = this.currentContextKey;
        const newKey = `id:${current}`;
        const loadingHistory = this.historyLoadPending || String(oldKey || "").startsWith("switch:");
        if (loadingHistory) {
          this.currentContextKey = newKey;
          this.historyLoadPending = false;
          this.contextHealthCache = null;
          if (!this.contextStates.get(newKey)?.summary) this.contextStates.delete(newKey);
          void this.hydrateContextMemoryForKey(newKey, true);
        } else {
          if (oldKey && oldKey !== newKey && this.contextStates.has(oldKey)) {
            this.contextStates.set(newKey, this.contextStates.get(oldKey));
            this.contextStates.delete(oldKey);
          }
          this.currentContextKey = newKey;
          if (this.contextStates.get(newKey)?.summary) void this.persistContextMemory();
        }
      } else if (current === null) {
        this.beginNewContext("新聊天");
        this.resetRouterConversation("新聊天");
      } else if (previous !== null && previous !== undefined) {
        const newKey = `id:${current}`;
        this.currentContextKey = newKey;
        this.historyLoadPending = false;
        this.contextHealthCache = null;
        this.resetRouterConversation("切换聊天");
        void this.hydrateContextMemoryForKey(newKey, true);
      }
    }

    // If no compressed memory is active, track the user's own history-limit
    // preference so it can be restored after leaving a compressed conversation.
    const state = this.getContextState();
    if (!state.summary && !this.historySyncInFlight && Number.isFinite(Number(hub.workspaceState?.maxPreviousMessages))) {
      this.baseHistoryLimit = Number(hub.workspaceState.maxPreviousMessages);
    }

    if (!capability.restricted && this.settings.defaultReadOnlyEnabled && this.settings.syncLlmHubUi
        && !this.sessionWriteUnlocked && !this.uiBridgeSyncedForLock) {
      const visibleButton = Array.from(document.querySelectorAll(".llm-hub-vault-tool-btn"))
        .some(el => el instanceof HTMLElement && el.offsetParent !== null && !el.disabled);
      if (visibleButton) {
        // Do NOT mark the UI as synced before the sync actually runs. v0.5.1 did
        // so here, which short-circuited ensureLlmHubUiMode() on first Chat mount.
        void this.ensureLlmHubUiMode("readOnly", false).then(ok => {
          if (!ok) this.uiBridgeSyncedForLock = false;
        });
      }
    }
  }

  resetSessionReadOnly(reason = "新聊天") {
    if (!this.settings.defaultReadOnlyEnabled) return;
    this.sessionWriteUnlocked = false;
    this.sessionDesiredVaultMode = "readOnly";
    this.uiBridgeSyncedForLock = false;
    this.uiBridgeStatus = `${reason}：Read Only`;
    if (this.settings.syncLlmHubUi) {
      // One deliberate attempt is enough in normal UI. The 500 ms poll below is
      // the fallback if Chat has not mounted yet. Repeated delayed clicks were
      // the source of the flashing Vault menu in v0.2.0.
      window.setTimeout(() => {
        if (!this.sessionWriteUnlocked && !this.uiBridgeSyncedForLock && !this.uiSyncInFlight) {
          void this.ensureLlmHubUiMode("readOnly", false);
        }
      }, 120);
    }
  }

  async lockCurrentChat(syncUi = true) {
    this.sessionWriteUnlocked = false;
    this.sessionDesiredVaultMode = "readOnly";
    this.uiBridgeSyncedForLock = false;
    this.uiBridgeStatus = "当前聊天：Read Only";
    if (syncUi && this.settings.syncLlmHubUi) await this.ensureLlmHubUiMode("readOnly", true);
    new Notice("LLM Hub Safe Guard：当前聊天已恢复 Read Only");
  }

  async unlockCurrentChat(syncUi = true) {
    this.sessionWriteUnlocked = true;
    this.sessionDesiredVaultMode = "all";
    this.uiBridgeSyncedForLock = false;
    this.uiBridgeStatus = "当前聊天：All（写入已解锁）";
    if (syncUi && this.settings.syncLlmHubUi) await this.ensureLlmHubUiMode("all", true);
    new Notice("LLM Hub Safe Guard：当前聊天已允许 Vault All；新聊天会恢复 Read Only");
  }

  trySyncDesiredVaultMode() {
    if (!this.settings.defaultReadOnlyEnabled || !this.settings.syncLlmHubUi) return false;
    if (this.uiSyncInFlight) return false;
    const capability = this.refreshVaultCapabilityRestriction();
    if (capability.restricted) return true;
    const desired = this.sessionDesiredVaultMode || (this.sessionWriteUnlocked ? "all" : "readOnly");

    // Startup/new-chat eager sync is only needed for readOnly. Other modes are
    // explicit user choices and are restored after model switches.
    if (desired !== "readOnly" || this.sessionWriteUnlocked || this.uiBridgeSyncedForLock) return false;

    const visibleButton = Array.from(document.querySelectorAll(".llm-hub-vault-tool-btn"))
      .some(el => el instanceof HTMLElement && el.offsetParent !== null && !el.disabled);
    if (!visibleButton) return false;

    void this.ensureLlmHubUiMode("readOnly", false);
    return true;
  }

  scheduleVaultModeRestoreAfterModelSwitch() {
    if (!this.settings.syncLlmHubUi) return;
    const desired = this.sessionDesiredVaultMode || (this.sessionWriteUnlocked ? "all" : "readOnly");

    // The model option click happens before LLM Hub's React state commit. Invalidate
    // our cached read-only state now, then restore the current chat's selected
    // mode in the next task after LLM Hub has applied handleModelChange().
    this.uiBridgeSyncedForLock = false;
    const label = desired === "readOnly" ? "Read Only" : desired === "noSearch" ? "No Search" : desired === "none" ? "Off" : "All";
    this.uiBridgeStatus = `模型切换：等待恢复 ${label}`;

    window.setTimeout(() => {
      if (!this.settings.syncLlmHubUi || this.uiSyncInFlight) return;
      const capability = this.refreshVaultCapabilityRestriction();
      if (capability.restricted) return;
      void this.ensureLlmHubUiMode(desired, false);
    }, 50);
  }

  async ensureLlmHubUiMode(mode, notifyOnFailure = false) {
    if (!this.settings.syncLlmHubUi) return false;
    const capability = this.refreshVaultCapabilityRestriction();
    if (capability.restricted) {
      // LLM Hub forces these models to Vault Off. Off is safer than Read Only,
      // so treat it as a satisfied safety state instead of repeatedly opening
      // and closing the Vault menu trying to select an unavailable item.
      if (notifyOnFailure) new Notice(`Safe Guard：${capability.restriction.reason}，当前保持 Vault Off；切回支持工具的模型后会恢复 ${this.sessionDesiredVaultMode === "readOnly" ? "Read Only" : this.sessionDesiredVaultMode}。`, 2600);
      return true;
    }
    if (mode === "readOnly" && this.uiBridgeSyncedForLock && !notifyOnFailure) return true;
    if (this.uiSyncInFlight) return false;

    const indexByMode = { all: 0, noSearch: 1, readOnly: 2, none: 3 };
    const wanted = indexByMode[mode];
    if (wanted === undefined) return false;

    const buttons = Array.from(document.querySelectorAll(".llm-hub-vault-tool-btn"))
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null && !el.disabled);
    const button = buttons[buttons.length - 1];
    if (!button) {
      this.uiBridgeStatus = "UI同步等待：未找到 Vault 按钮";
      if (notifyOnFailure) new Notice("Safe Guard：未找到 LLM Hub Vault 工具按钮，请先打开 Chat 面板后重试");
      return false;
    }

    this.uiSyncInFlight = true;
    try {
      const pickVisibleItem = () => {
        const items = Array.from(document.querySelectorAll(".llm-hub-vault-tool-item"))
          .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
        return items[wanted] || null;
      };

      let item = pickVisibleItem();
      if (!item) {
        // Observe the menu DOM and click the target as soon as React mounts it.
        // MutationObserver runs before the next paint, which avoids the repeated
        // visible open/close flash caused by sleep-and-click loops.
        item = await new Promise(resolve => {
          let settled = false;
          const finish = (value) => {
            if (settled) return;
            settled = true;
            observer.disconnect();
            window.clearTimeout(timer);
            resolve(value);
          };
          const observer = new MutationObserver(() => {
            const found = pickVisibleItem();
            if (found) finish(found);
          });
          observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
          const timer = window.setTimeout(() => finish(pickVisibleItem()), 350);
          button.click();
        });
      }

      if (!item || item.classList.contains("disabled")) {
        // If the menu is open, close it once. No retry loop here.
        try { if (pickVisibleItem()) button.click(); } catch (_) {}
        this.uiBridgeStatus = "UI同步不可用：模式项未找到或被禁用";
        if (notifyOnFailure) new Notice("Safe Guard：当前模型/界面无法切换到目标 Vault 模式；代理层保护仍然有效");
        return false;
      }

      item.click();
      this.uiBridgeSyncedForLock = mode === "readOnly";
      const label = mode === "readOnly" ? "Read Only" : mode === "noSearch" ? "No Search" : mode === "none" ? "Off" : "All";
      this.uiBridgeStatus = `当前聊天：${label}（UI已同步）`;
      return true;
    } catch (err) {
      this.uiBridgeStatus = `UI同步失败：${err?.message || err}`;
      if (notifyOnFailure) new Notice(`Safe Guard UI同步失败：${err?.message || err}`);
      return false;
    } finally {
      this.uiSyncInFlight = false;
    }
  }



  beginNewContext(reason = "新聊天") {
    this.currentContextKey = `draft:${Date.now()}:${this.contextDraftSerial++}`;
    this.getContextState();
    this.applyRuntimeMemoryForCurrentChat();
    this.ensureAutoPanelControls();
    return this.currentContextKey;
  }

  getCurrentContextKey() {
    const hub = this.getLlmHubPlugin();
    const id = hub?.lastActiveChatId ?? null;
    if (this.historyLoadPending && String(this.currentContextKey || "").startsWith("switch:")) return this.currentContextKey;
    if (id !== null) {
      const key = `id:${id}`;
      if (!this.currentContextKey || this.currentContextKey.startsWith("id:")) this.currentContextKey = key;
    }
    if (!this.currentContextKey) this.beginNewContext("初始化");
    return this.currentContextKey;
  }

  getContextState() {
    const key = this.getCurrentContextKey();
    if (!this.contextStates.has(key)) {
      const saved = key.startsWith("id:") ? (this.settings.contextMemories?.[key] || null) : null;
      let compressionEvents = Array.isArray(saved?.compressionEvents)
        ? saved.compressionEvents.filter(e => e && Number(e.at) > 0).map(e => ({
            at: Number(e.at),
            model: String(e.model || ""),
            keepRecent: Math.max(0, Math.round(Number(e.keepRecent) || 0)),
            coveredCount: Math.max(0, Math.round(Number(e.coveredCount) || 0)),
            summaryTokens: Math.max(0, Math.round(Number(e.summaryTokens) || 0))
          })).slice(-24)
        : [];
      // Migration for conversations compressed by v0.5.0-v0.5.7: preserve the
      // known latest compression as one provenance event so the UI/model can
      // immediately say "已压缩" after upgrading.
      if (compressionEvents.length === 0 && saved?.summary && Number(saved?.lastCompressedAt) > 0) {
        compressionEvents = [{
          at: Number(saved.lastCompressedAt),
          model: String(saved.lastCompressionModel || ""),
          keepRecent: Math.max(0, Math.round(Number(saved.keepRecentMessages) || 0)),
          coveredCount: Math.max(0, Math.round(Number(saved.summaryCoveredCount) || 0)),
          summaryTokens: estimateTokens(saved.summary || "")
        }];
      }
      this.contextStates.set(key, {
        summary: saved?.summary || "",
        summaryCoveredCount: Number(saved?.summaryCoveredCount || 0),
        lastCompressedAt: Number(saved?.lastCompressedAt || 0),
        lastCompressionModel: saved?.lastCompressionModel || "",
        keepRecentMessages: Number.isInteger(saved?.keepRecentMessages) ? Math.max(0, saved.keepRecentMessages) : null,
        compressionEvents,
        memoryLedger: Array.isArray(saved?.memoryLedger) ? saved.memoryLedger.filter(e => e && e.digest).map(e => ({
          at: Number(e.at) || 0,
          from: Math.max(0, Math.round(Number(e.from) || 0)),
          to: Math.max(0, Math.round(Number(e.to) || 0)),
          digest: String(e.digest || "").trim().slice(0, 1200)
        })).slice(-48) : [],
        persistenceSource: saved ? "data.json" : "none",
        lastRawMessages: [],
        lastEffectiveMetrics: null,
        cancelled: [],
        cancelledHistory: [],
        healthHighWaterByModel: {}
      });
    }
    return this.contextStates.get(key);
  }

  getChatIdFromContextKey(key = this.getCurrentContextKey()) {
    return String(key || "").startsWith("id:") ? String(key).slice(3) : "";
  }

  getChatHistoryPathForKey(key = this.getCurrentContextKey()) {
    const chatId = this.getChatIdFromContextKey(key);
    if (!chatId) return "";
    const hub = this.getLlmHubPlugin();
    const root = String(hub?.settings?.workspaceFolder || "LLMHub").replace(/\\/g, "/").replace(/\/+$/, "");
    return `${root}/${chatId}.md`;
  }

  getContextSidecarPathForKey(key = this.getCurrentContextKey()) {
    const chatId = this.getChatIdFromContextKey(key);
    if (!chatId) return "";
    const hub = this.getLlmHubPlugin();
    const root = String(hub?.settings?.workspaceFolder || "LLMHub").replace(/\\/g, "/").replace(/\/+$/, "");
    const safe = chatId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 96) || "chat";
    const fp = simpleFingerprint(chatId).replace(":", "-");
    return `${root}/.safe-guard/${safe}-${fp}.context.json`;
  }

  async ensureAdapterFolder(path) {
    const adapter = this.app?.vault?.adapter;
    if (!adapter || !path) return;
    const parts = String(path).split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      try { if (!(await adapter.exists(cur))) await adapter.mkdir(cur); } catch (_) {}
    }
  }

  serializeContextStateForPersistence(key, state) {
    return {
      schema: 2,
      chatId: this.getChatIdFromContextKey(key),
      chatHistoryPath: this.getChatHistoryPathForKey(key),
      updatedAt: Date.now(),
      summary: String(state?.summary || ""),
      summaryCoveredCount: Math.max(0, Math.round(Number(state?.summaryCoveredCount) || 0)),
      lastCompressedAt: Number(state?.lastCompressedAt || 0),
      lastCompressionModel: String(state?.lastCompressionModel || ""),
      keepRecentMessages: Number.isInteger(state?.keepRecentMessages) ? Math.max(0, state.keepRecentMessages) : null,
      compressionEvents: this.getCompressionEvents(state).slice(-48),
      memoryLedger: Array.isArray(state?.memoryLedger) ? state.memoryLedger.slice(-48) : []
    };
  }

  mergePersistedContextIntoState(state, saved, source = "persistent") {
    if (!state || !saved || typeof saved !== "object") return false;
    const incomingAt = Number(saved.lastCompressedAt || 0);
    const currentAt = Number(state.lastCompressedAt || 0);
    if (incomingAt < currentAt) return false;
    if (incomingAt === currentAt && state.summary && !saved.summary) return false;
    state.summary = String(saved.summary || "");
    state.summaryCoveredCount = Math.max(0, Math.round(Number(saved.summaryCoveredCount) || 0));
    state.lastCompressedAt = incomingAt;
    state.lastCompressionModel = String(saved.lastCompressionModel || "");
    state.keepRecentMessages = Number.isInteger(saved.keepRecentMessages) ? Math.max(0, saved.keepRecentMessages) : null;
    state.compressionEvents = Array.isArray(saved.compressionEvents) ? saved.compressionEvents.filter(e => e && Number(e.at) > 0).map(e => ({
      at: Number(e.at), model: String(e.model || ""), keepRecent: Math.max(0, Math.round(Number(e.keepRecent) || 0)),
      coveredCount: Math.max(0, Math.round(Number(e.coveredCount) || 0)), summaryTokens: Math.max(0, Math.round(Number(e.summaryTokens) || 0)),
      checkpoint: String(e.checkpoint || "")
    })).slice(-48) : (state.compressionEvents || []);
    state.memoryLedger = Array.isArray(saved.memoryLedger) ? saved.memoryLedger.filter(e => e && e.digest).map(e => ({
      at: Number(e.at) || 0, from: Math.max(0, Math.round(Number(e.from) || 0)), to: Math.max(0, Math.round(Number(e.to) || 0)),
      digest: String(e.digest || "").trim().slice(0, 1200)
    })).slice(-48) : (state.memoryLedger || []);
    state.persistenceSource = source;
    state.healthHighWaterByModel = {};
    this.contextHealthCache = null;
    return true;
  }

  async writeContextSidecar(key, state) {
    const path = this.getContextSidecarPathForKey(key);
    if (!path || !String(key).startsWith("id:")) return false;
    try {
      const dir = path.slice(0, path.lastIndexOf("/"));
      await this.ensureAdapterFolder(dir);
      await this.app.vault.adapter.write(path, JSON.stringify(this.serializeContextStateForPersistence(key, state), null, 2));
      this.contextSidecarPath = path;
      return true;
    } catch (err) {
      console.warn("[LLM Hub Safe Guard] context sidecar write failed", err);
      return false;
    }
  }

  async readContextSidecar(key) {
    const path = this.getContextSidecarPathForKey(key);
    if (!path) return null;
    try {
      if (!(await this.app.vault.adapter.exists(path))) return null;
      const text = await this.app.vault.adapter.read(path);
      const data = JSON.parse(text);
      if (data && data.chatId === this.getChatIdFromContextKey(key)) {
        this.contextSidecarPath = path;
        return data;
      }
    } catch (err) {
      console.warn("[LLM Hub Safe Guard] context sidecar read failed", err);
    }
    return null;
  }

  async hydrateContextMemoryForKey(key, apply = false) {
    if (!String(key || "").startsWith("id:")) return false;
    this.currentContextKey = key;
    if (!this.contextStates.has(key)) this.getContextState();
    const state = this.contextStates.get(key);
    let source = state?.summary ? (state.persistenceSource || "data.json") : "none";
    const sidecar = await this.readContextSidecar(key);
    if (sidecar && this.mergePersistedContextIntoState(state, sidecar, "sidecar")) source = "sidecar";
    if (state?.summary && (!Array.isArray(state.memoryLedger) || state.memoryLedger.length === 0)) {
      state.memoryLedger = [{
        at: Number(state.lastCompressedAt || Date.now()), from: 0,
        to: Math.max(0, Number(state.summaryCoveredCount || 0)),
        digest: this.makeCheckpointDigest([], state.summary, "旧版压缩记忆")
      }];
      await this.persistContextMemory();
    }
    this.contextPersistenceSource = source;
    this.historyLoadPending = false;
    this.contextHealthCache = null;
    if (apply) await this.applyRuntimeMemoryForCurrentChat(true);
    return Boolean(state?.summary);
  }

  async reconcileHistoryLoad() {
    if (!this.historyLoadPending) return;
    const id = this.getLlmHubPlugin()?.lastActiveChatId ?? null;
    if (!id) {
      if (Date.now() - this.historyLoadPendingAt < 1500) window.setTimeout(() => { void this.reconcileHistoryLoad(); }, 180);
      return;
    }
    // At 180 ms React may still expose the chat that was active before the
    // history click. Give it a short grace period unless the id actually changed.
    if (id === this.lastSeenChatId && Date.now() - this.historyLoadPendingAt < 800) {
      window.setTimeout(() => { void this.reconcileHistoryLoad(); }, 180);
      return;
    }
    const key = `id:${id}`;
    this.lastSeenChatId = id;
    this.currentContextKey = key;
    this.historyLoadPending = false;
    this.contextHealthCache = null;
    await this.hydrateContextMemoryForKey(key, true);
  }

  getMemoryLedger(state = this.getContextState()) {
    if (!Array.isArray(state?.memoryLedger)) state.memoryLedger = [];
    return state.memoryLedger;
  }

  makeCheckpointDigest(messages, summary, prefix = "本次压缩") {
    const userTexts = (Array.isArray(messages) ? messages : [])
      .filter(m => m?.role === "user")
      .map(m => contentToText(m.content).replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const clip = (x, n = 110) => x.length > n ? `${x.slice(0, n - 1)}…` : x;
    if (userTexts.length > 0) {
      const first = clip(userTexts[0]);
      const last = clip(userTexts[userTexts.length - 1]);
      return userTexts.length === 1
        ? `${prefix}覆盖的主要用户话题：“${first}”。`
        : `${prefix}覆盖 ${userTexts.length} 条用户消息；起始话题：“${first}”；阶段末话题：“${last}”。`;
    }
    const plain = String(summary || "").replace(/[#>*_`\[\]]/g, " ").replace(/\s+/g, " ").trim();
    return plain ? `${prefix}摘要：${clip(plain, 220)}` : `${prefix}已完成，但该阶段没有可提取的用户文本。`;
  }

  recordMemoryLedgerCheckpoint(state, source, summaryBeforeUpdate = "", semanticCapsule = "") {
    if (!state || !source || source.targetCovered <= 0) return null;
    const ledger = this.getMemoryLedger(state);
    const from = source.requiresRebuild ? 0 : Math.max(0, Number(state.summaryCoveredCount || 0));
    const to = Math.max(from, Number(source.targetCovered || 0));
    const anchor = this.makeCheckpointDigest(source.newlyCoverable, summaryBeforeUpdate || state.summary, "压缩检查点");
    const capsule = String(semanticCapsule || "").replace(/\s+/g, " ").trim().slice(0, 420);
    const digest = capsule ? `${capsule}｜${anchor}` : anchor;
    const item = { at: Date.now(), from, to, digest };
    ledger.push(item);
    if (ledger.length > 48) ledger.splice(0, ledger.length - 48);
    return item;
  }

  buildMemoryCapsulePrompt(summary) {
    return `你是长期对话记忆的“语义胶囊”生成器。\n请把下面的滚动压缩摘要提炼成一条可长期保留的中文记忆，目标 80~180 个汉字，最多 220 个汉字。\n必须尽量包含：主要讨论主题、关键结论/决定、重要文件或路径、仍未完成的事项。\n不要只写“已压缩/讨论了很多内容”，不要解释任务，不要使用表格，只输出一段紧凑文本。\n\n滚动摘要：\n${summary}`;
  }

  async generateMemoryCapsule(modelValue, summary) {
    const choice = this.resolveCompressionModel(modelValue);
    if (!choice || !String(summary || "").trim()) return "";
    const prompt = this.buildMemoryCapsulePrompt(summary);
    const maxTokens = 260;
    try {
      if (choice.type === "advanced") {
        const route = this.getAdvancedRoute(true);
        if (!route) return "";
        const isDeepSeek = /deepseek/i.test(`${route.providerName || ""} ${route.baseUrl || ""} ${route.model || ""}`);
        const text = await this.postOpenAiCompression(route.url, route.apiKey, route.model, prompt, maxTokens, { disableThinking: isDeepSeek });
        return String(text || "").replace(/\s+/g, " ").trim().slice(0, 420);
      }
      const url = joinOllamaChatUrl(this.settings.upstreamBaseUrl);
      if (!url) return "";
      const text = await this.postOllamaCompression(url, choice.model, prompt, maxTokens);
      return String(text || "").replace(/\s+/g, " ").trim().slice(0, 420);
    } catch (err) {
      console.warn("[LLM Hub Safe Guard] memory capsule generation failed; using anchor fallback", err);
      return "";
    }
  }

  getDomConversationMessages() {
    const nodes = Array.from(document.querySelectorAll(".llm-hub-message-user, .llm-hub-message-assistant"))
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
    const out = [];
    for (const el of nodes) {
      const role = el.classList.contains("llm-hub-message-user") ? "user" : "assistant";
      const contentEl = el.querySelector(".llm-hub-message-content");
      let text = contentEl ? contentEl.innerText : el.innerText;
      if (!text) continue;
      // Remove the role/time header if a theme merges it into the content node.
      const roleEl = el.querySelector(".llm-hub-message-role");
      const timeEl = el.querySelector(".llm-hub-message-time");
      if (!contentEl && roleEl?.textContent) text = text.replace(roleEl.textContent, "");
      if (!contentEl && timeEl?.textContent) text = text.replace(timeEl.textContent, "");
      text = text.trim();
      if (text) out.push({ role, content: text });
    }
    return out;
  }

  getCompressionEvents(state = this.getContextState()) {
    if (!Array.isArray(state?.compressionEvents)) state.compressionEvents = [];
    return state.compressionEvents;
  }

  recordCompressionEvent(state, source, modelValue) {
    if (!state || !source || source.targetCovered <= 0 || !state.summary) return null;
    const event = {
      at: Date.now(),
      model: String(modelValue || ""),
      keepRecent: Math.max(0, Math.round(Number(source.keep) || 0)),
      coveredCount: Math.max(0, Math.round(Number(source.targetCovered) || 0)),
      summaryTokens: estimateTokens(state.summary || ""),
      checkpoint: this.getMemoryLedger(state).slice(-1)[0]?.digest || ""
    };
    const events = this.getCompressionEvents(state);
    events.push(event);
    if (events.length > 24) events.splice(0, events.length - 24);
    return event;
  }

  formatCompressionEvent(event, concise = false) {
    if (!event) return "";
    const time = new Date(Number(event.at) || Date.now()).toLocaleString();
    const model = String(event.model || "未记录模型").replace(/^local:/, "");
    if (concise) return `已压缩 · ${time} · 保留 ${event.keepRecent} 条`;
    return `已压缩 · ${time} · 压缩模型 ${model} · 摘要覆盖前 ${event.coveredCount} 条消息 · 压缩时保留 ${event.keepRecent} 条 · 摘要约 ${event.summaryTokens || 0} tokens`;
  }

  applyCompressionMarkers() {
    const state = this.getContextState();
    const events = this.getCompressionEvents(state);
    const nodes = Array.from(document.querySelectorAll(".llm-hub-message-user, .llm-hub-message-assistant"))
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null);

    // Remove markers from a previous chat/event set. The mutation observer ignores
    // these nodes so this cleanup cannot recreate the v0.5.0 render loop.
    const wantedIds = new Set(events.map(e => String(Number(e.at) || 0)));
    for (const marker of document.querySelectorAll(".llm-hub-safe-guard-compression-marker")) {
      if (!wantedIds.has(String(marker.getAttribute("data-sg-compression-at") || ""))) marker.remove();
    }
    if (nodes.length === 0 || events.length === 0) return;

    for (const event of events) {
      const at = String(Number(event.at) || 0);
      if (!at || at === "0") continue;
      let marker = document.querySelector(`.llm-hub-safe-guard-compression-marker[data-sg-compression-at="${at}"]`);
      if (!marker) {
        marker = document.createElement("div");
        marker.className = "llm-hub-safe-guard-compression-marker";
        marker.setAttribute("data-sg-compression-at", at);
        const line1 = document.createElement("span");
        line1.className = "llm-hub-safe-guard-compression-marker-label";
        line1.textContent = "已压缩";
        const line2 = document.createElement("span");
        line2.className = "llm-hub-safe-guard-compression-marker-detail";
        marker.append(line1, line2);
      }
      const detail = marker.querySelector(".llm-hub-safe-guard-compression-marker-detail");
      if (detail) detail.textContent = `${new Date(Number(event.at)).toLocaleString()} · 保留 ${event.keepRecent} 条 · 摘要约 ${event.summaryTokens || 0} tokens`;

      // coveredCount is the number of visible user/assistant messages absorbed by
      // the rolling summary. Put the divider exactly between that prefix and the
      // raw messages retained after compression.
      const covered = Math.max(0, Math.round(Number(event.coveredCount) || 0));
      if (covered < nodes.length) {
        const target = nodes[covered];
        if (target?.parentElement && marker.nextElementSibling !== target) target.parentElement.insertBefore(marker, target);
      } else if (covered === nodes.length && nodes.length > 0) {
        const target = nodes[nodes.length - 1];
        if (target?.parentElement && target.nextElementSibling !== marker) target.insertAdjacentElement("afterend", marker);
      }
    }
  }

  armManualSaveMarkerPatch() {
    const state = this.getContextState();
    if (!this.getCompressionEvents(state).length) return;
    this.manualSaveMarkerUntil = Date.now() + 15000;
    this.manualSaveMarkerContextKey = this.getCurrentContextKey();
  }

  buildManualExportCompressionLog(events) {
    const begin = "<!-- LLM-HUB-SAFE-GUARD-COMPRESSION-LOG:BEGIN -->";
    const end = "<!-- LLM-HUB-SAFE-GUARD-COMPRESSION-LOG:END -->";
    const lines = [begin, "", "---", "", "## LLM Hub Safe Guard · 压缩记录", ""];
    for (const event of events) lines.push(`- **${this.formatCompressionEvent(event, false)}**`);
    lines.push("", "> 这些记录是 Safe Guard 的上下文管理元数据；聊天正文仍保留完整显示，但模型后续收到的是滚动摘要与未压缩的新消息。", "", end);
    return lines.join("\n");
  }

  async maybePatchManualChatExport(file) {
    if (!file || file.extension !== "md") return;
    if (Date.now() > Number(this.manualSaveMarkerUntil || 0)) return;
    const contextKey = this.manualSaveMarkerContextKey;
    if (!contextKey) return;
    const state = this.contextStates.get(contextKey) || this.getContextState();
    const events = this.getCompressionEvents(state);
    if (!events.length) return;
    const hub = this.getLlmHubPlugin();
    const folder = String(hub?.settings?.manualChatSaveFolder || "").replace(/^\/+|\/+$/g, "");
    if (folder && !(file.path === folder || file.path.startsWith(`${folder}/`))) return;
    if (this.manualExportPatchInFlight.has(file.path)) return;

    // Give LLM Hub's own save a moment to finish. The modify listener stays armed
    // for 15 s, so an overwrite of the same exported note is patched again.
    await new Promise(resolve => window.setTimeout(resolve, 80));
    this.manualExportPatchInFlight.add(file.path);
    try {
      let content = await this.app.vault.read(file);
      if (!/^(?:---[\s\S]*?---\s*)?##\s+You\b/m.test(content)) return;
      const firstUser = this.getDomConversationMessages().find(m => m.role === "user")?.content || "";
      const probe = firstUser.replace(/\s+/g, " ").trim().slice(0, 48);
      if (probe && !content.replace(/\s+/g, " ").includes(probe)) return;
      const re = /\n?<!-- LLM-HUB-SAFE-GUARD-COMPRESSION-LOG:BEGIN -->[\s\S]*?<!-- LLM-HUB-SAFE-GUARD-COMPRESSION-LOG:END -->\s*$/m;
      content = content.replace(re, "").trimEnd();
      const next = `${content}\n\n${this.buildManualExportCompressionLog(events)}\n`;
      if (next !== content) await this.app.vault.modify(file, next);
    } catch (err) {
      console.warn("[LLM Hub Safe Guard] manual export compression log patch failed", err);
    } finally {
      this.manualExportPatchInFlight.delete(file.path);
    }
  }

  getCompressionModelOptions() {
    const hub = this.getLlmHubPlugin();
    const options = [];
    const seen = new Set();
    const configs = Array.isArray(hub?.settings?.localLlmConfigs) ? hub.settings.localLlmConfigs : [];
    for (const cfg of configs) {
      if (!cfg || cfg.enabled === false) continue;
      const models = Array.isArray(cfg.enabledModels) && cfg.enabledModels.length ? cfg.enabledModels : (cfg.model ? [cfg.model] : []);
      for (const model of models) {
        if (!model) continue;
        const value = `local:${model}`;
        if (seen.has(value)) continue;
        seen.add(value);
        options.push({ value, label: `${cfg.name || "Local"} (${model})`, type: "local", model: String(model) });
      }
    }
    const advanced = this.getAdvancedRoute(true);
    if (advanced) {
      const value = `advanced:${advanced.providerId || advanced.providerName}:${advanced.model}`;
      options.push({ value, label: `${advanced.displayName}（远程）`, type: "advanced", route: advanced });
    }
    if (options.length === 0) options.push({ value: "local:qwen3.5:4b", label: "Local (qwen3.5:4b)", type: "local", model: "qwen3.5:4b" });
    return options;
  }

  getManualSelectedModelLabel() {
    const pickers = Array.from(document.querySelectorAll(".llm-hub-model-picker"))
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
    const picker = pickers[pickers.length - 1];
    const text = String(picker?.textContent || "").trim();
    if (text) return text;
    return "本地模型";
  }

  getModelTokenBudget(modelLabel) {
    const label = String(modelLabel || "");
    if (isDeepSeekModelLabel(label)) {
      const context = Math.max(100000, Number(this.settings.deepSeekContextTokens) || 1000000);
      const reserve = Math.max(1000, Math.min(context - 1000, Number(this.settings.deepSeekOutputReserveTokens) || 64000));
      return { contextTokens: context, reserveTokens: reserve, budgetTokens: context - reserve, remote: true };
    }
    const context = Math.max(2048, Number(this.settings.contextWindowTokens) || 16384);
    return { contextTokens: context, reserveTokens: 0, budgetTokens: context, remote: false };
  }

  estimateVisibleConversationTokens() {
    const state = this.getContextState();
    const dom = this.getDomConversationMessages();
    if (state.summary) {
      const covered = Math.max(0, Math.min(dom.length, Math.round(Number(state.summaryCoveredCount) || 0)));
      // v0.5.7: the retained N messages are only the raw boundary at compression
      // time. Every later turn stays in the unsummarized tail until the next
      // compression, so effective context grows naturally instead of sliding.
      const tail = dom.slice(covered);
      const tailText = tail.map(serializeMessageForSummary).join("\n\n");
      const fixed = state.lastEffectiveMetrics
        ? (state.lastEffectiveMetrics.systemEstimatedTokens || 0) + (state.lastEffectiveMetrics.toolsEstimatedTokens || 0)
        : 1800;
      return estimateTokens(state.summary) + estimateTokens(tailText) + fixed;
    }
    const text = dom.map(serializeMessageForSummary).join("\n\n");
    const domEstimate = estimateTokens(text) + 1800;
    const proxyEstimate = Number(state.lastEffectiveMetrics?.estimatedTokens || 0);
    return Math.max(domEstimate, proxyEstimate);
  }

  getContextHealth(force = false) {
    const modelLabel = this.getManualSelectedModelLabel();
    if (this.historyLoadPending && String(this.currentContextKey || "").startsWith("switch:")) {
      const budget = this.getModelTokenBudget(modelLabel);
      return { modelLabel, usedTokens: 0, ...budget, ratio: 0, level: "载入历史压缩记忆", color: "green", loading: true };
    }
    const now = Date.now();
    if (!force && this.contextHealthCache
        && this.contextHealthCache.modelLabel === modelLabel
        && now - this.contextHealthCache.at < 1500) {
      return this.contextHealthCache.value;
    }
    const budget = this.getModelTokenBudget(modelLabel);
    const state = this.getContextState();
    if (!state.healthHighWaterByModel || typeof state.healthHighWaterByModel !== "object") state.healthHighWaterByModel = {};
    const rawUsedTokens = Math.max(0, this.estimateVisibleConversationTokens());
    const previousHighWater = Math.max(0, Number(state.healthHighWaterByModel[modelLabel]) || 0);
    const usedTokens = Math.max(rawUsedTokens, previousHighWater);
    state.healthHighWaterByModel[modelLabel] = usedTokens;
    const ratio = budget.budgetTokens > 0 ? usedTokens / budget.budgetTokens : 0;
    let level = "健康";
    let color = "green";
    if (ratio >= Number(this.settings.contextDangerRatio || 0.85)) { level = "需要压缩"; color = "red"; }
    else if (ratio >= Number(this.settings.contextWarningRatio || 0.75)) { level = "偏高"; color = "orange"; }
    else if (ratio >= Number(this.settings.contextHealthyRatio || 0.60)) { level = "注意"; color = "yellow"; }
    const value = { modelLabel, usedTokens, ...budget, ratio, level, color };
    this.contextHealthCache = { modelLabel, at: now, value };
    return value;
  }

  setCompressionProgress(stage, current = 0, total = 0) {
    this.compressionProgress = { stage, current, total };
    this.ensureAutoPanelControls();
  }

  isLlmHubBusy() {
    if (Array.from(document.querySelectorAll(".llm-hub-message-streaming")).some(el => el instanceof HTMLElement && el.offsetParent !== null)) return true;
    const buttons = Array.from(document.querySelectorAll(".llm-hub-composer button, .llm-hub-input-area button"))
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
    return buttons.some(btn => /(?:stop|停止|中止|cancel generation)/i.test(`${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""} ${btn.textContent || ""}`));
  }

  async waitUntilLlmHubIdle() {
    let ticks = 0;
    while (this.isLlmHubBusy()) {
      this.setCompressionProgress("等待当前回答完成", 0, 0);
      await new Promise(resolve => window.setTimeout(resolve, 350));
      if (++ticks > 1800) throw new Error("等待当前回答结束超时");
    }
  }

  setComposerLocked(locked) {
    const textareas = Array.from(document.querySelectorAll(".llm-hub-composer textarea"));
    for (const el of textareas) {
      if (!(el instanceof HTMLTextAreaElement)) continue;
      if (locked) {
        if (!el.hasAttribute("data-sg-prev-disabled")) el.setAttribute("data-sg-prev-disabled", el.disabled ? "1" : "0");
        el.disabled = true;
      } else {
        const prev = el.getAttribute("data-sg-prev-disabled");
        if (prev !== null) {
          el.disabled = prev === "1";
          el.removeAttribute("data-sg-prev-disabled");
        }
      }
    }
    document.body.classList.toggle("llm-hub-safe-guard-compressing", locked);
  }

  async startCompressionFlow(forceRebuild = false) {
    if (!this.settings.contextManagerEnabled) {
      new Notice("LLM Hub Safe Guard：上下文管理已关闭");
      return;
    }
    if (this.compressionInProgress) {
      new Notice("LLM Hub Safe Guard：上下文压缩正在进行中");
      return;
    }
    const options = this.getCompressionModelOptions();
    const decision = await new ContextCompressionModal(this.app, this, this.getContextHealth(), options).waitForDecision();
    if (!decision) return;
    if (decision === "__clear__") {
      await this.clearCurrentContextMemory(true);
      return;
    }
    if (typeof decision !== "object") return;
    void this.runContextCompression(decision.model, decision.keepRecent, forceRebuild);
  }

  getCompressionMessageCount() {
    const state = this.getContextState();
    const cancelledSet = new Set(Array.isArray(state.cancelledHistory) ? state.cancelledHistory : []);
    const dom = this.getDomConversationMessages()
      .filter(m => !(m.role === "user" && cancelledSet.has(simpleFingerprint(contentToText(m.content)))));
    if (dom.length > 0) return dom.length;
    if (Array.isArray(state.lastRawMessages)) {
      return state.lastRawMessages
        .filter(m => m && m.role !== "system")
        .map(m => ({ role: m.role, content: contentToText(m.content) }))
        .filter(m => m.content)
        .filter(m => !(m.role === "user" && cancelledSet.has(simpleFingerprint(m.content))))
        .length;
    }
    return 0;
  }

  collectCompressionMessages(state, keepRecent, forceRebuild = false) {
    const dom = this.getDomConversationMessages();
    const cancelledSet = new Set(Array.isArray(state.cancelledHistory) ? state.cancelledHistory : []);
    let messages = dom.filter(m => !(m.role === "user" && cancelledSet.has(simpleFingerprint(contentToText(m.content)))));
    if (messages.length === 0 && Array.isArray(state.lastRawMessages)) {
      messages = state.lastRawMessages
        .filter(m => m && m.role !== "system")
        .map(m => ({ role: m.role, content: contentToText(m.content) }))
        .filter(m => m.content)
        .filter(m => !(m.role === "user" && cancelledSet.has(simpleFingerprint(m.content))));
    }
    const requestedKeep = Number(keepRecent);
    const fallbackKeep = Number(this.settings.compressionKeepRecentMessages);
    const keep = Math.max(0, Math.min(messages.length,
      Number.isFinite(requestedKeep) ? Math.round(requestedKeep)
        : (Number.isFinite(fallbackKeep) ? Math.round(fallbackKeep) : 2)));
    const covered = Math.max(0, Number(state.summaryCoveredCount) || 0);
    const targetCovered = Math.max(0, messages.length - keep);
    // If the user increases the number of raw messages to retain, the old summary
    // may already contain some of them. Rebuild from visible history instead of
    // keeping a summary that duplicates those messages.
    const requiresRebuild = Boolean(forceRebuild) || (Boolean(state.summary) && targetCovered < covered);
    const startIndex = requiresRebuild ? 0 : Math.min(covered, targetCovered);
    const newlyCoverable = messages.slice(startIndex, targetCovered);
    const recent = keep > 0 ? messages.slice(targetCovered) : [];
    return { all: messages, newlyCoverable, recent, targetCovered, keep, requiresRebuild };
  }

  async runContextCompression(modelValue, keepRecent, forceRebuild = false) {
    const state = this.getContextState();
    this.compressionInProgress = true;
    this.setCompressionProgress("准备压缩", 0, 0);
    this.ensureAutoPanelControls();
    try {
      await this.waitUntilLlmHubIdle();
      this.setComposerLocked(true);
      const source = this.collectCompressionMessages(state, keepRecent, forceRebuild);
      if (forceRebuild) new Notice("LLM Hub Safe Guard：正在从当前完整可见聊天历史重建压缩记忆。", 2200);
      if (source.all.length === 0) {
        new Notice("LLM Hub Safe Guard：当前没有可压缩的聊天历史");
        return;
      }

      // keep == total messages means the user explicitly chose not to summarize
      // any existing message. If a previous rolling memory exists, clear it so
      // the visible/raw history becomes authoritative again.
      if (source.targetCovered === 0) {
        state.summary = "";
        state.summaryCoveredCount = 0;
        state.keepRecentMessages = source.keep;
        state.lastCompressedAt = Date.now();
        state.lastCompressionModel = modelValue;
        state.healthHighWaterByModel = {};
        this.contextHealthCache = null;
        await this.persistContextMemory();
        await this.applyRuntimeMemoryForCurrentChat(true);
        new Notice(`LLM Hub Safe Guard：本次保留全部 ${source.keep} 条消息，无需生成摘要。`);
        return;
      }

      if (source.newlyCoverable.length === 0 && state.summary && !source.requiresRebuild) {
        state.keepRecentMessages = source.keep;
        state.healthHighWaterByModel = {};
        this.contextHealthCache = null;
        await this.persistContextMemory();
        await this.applyRuntimeMemoryForCurrentChat(true);
        new Notice(`LLM Hub Safe Guard：没有新的旧历史需要摘要；已保留最近 ${source.keep} 条原始消息。`);
        return;
      }

      const existingMemory = state.summary && !source.requiresRebuild
        ? `## 既有滚动记忆\n${state.summary}\n\n`
        : "";
      const newHistory = source.newlyCoverable.map(serializeMessageForSummary).filter(Boolean).join("\n\n");
      const material = `${existingMemory}${newHistory}`.trim();
      if (!material) {
        new Notice("LLM Hub Safe Guard：没有可压缩的有效文本");
        return;
      }

      const chunks = splitTextByApproxTokens(material, this.settings.compressionChunkTokens);
      const partials = [];
      for (let i = 0; i < chunks.length; i++) {
        this.setCompressionProgress("分块摘要", i + 1, chunks.length);
        partials.push(await this.callCompressionModel(modelValue, chunks[i], false));
      }

      let merged = partials.join("\n\n");
      if (partials.length > 1 || estimateTokens(merged) > Number(this.settings.compressionTargetTokens) * 1.35) {
        this.setCompressionProgress("合并摘要", 1, 1);
        merged = await this.callCompressionModel(modelValue, merged, true);
      }

      this.setCompressionProgress("生成长期记忆", 1, 1);
      const semanticCapsule = await this.generateMemoryCapsule(modelValue, merged.trim());
      this.recordMemoryLedgerCheckpoint(state, source, state.summary || "", semanticCapsule);
      state.summary = merged.trim();
      state.summaryCoveredCount = source.targetCovered;
      state.lastCompressedAt = Date.now();
      state.lastCompressionModel = modelValue;
      state.keepRecentMessages = source.keep;
      state.healthHighWaterByModel = {};
      this.contextHealthCache = null;
      this.recordCompressionEvent(state, source, modelValue);
      await this.persistContextMemory();
      this.setCompressionProgress("写入上下文", 1, 1);
      await this.applyRuntimeMemoryForCurrentChat(true);
      new Notice(`LLM Hub Safe Guard：上下文压缩完成，已保留最近 ${source.keep} 条原始消息。`);
    } catch (err) {
      console.error("[LLM Hub Safe Guard] context compression failed", err);
      this.setCompressionProgress("压缩失败", 0, 0);
      new Notice(`LLM Hub Safe Guard：上下文压缩失败：${err?.message || err}`, 7000);
      return;
    } finally {
      this.compressionInProgress = false;
      this.setComposerLocked(false);
      window.setTimeout(() => this.setCompressionProgress("idle", 0, 0), 600);
      this.ensureAutoPanelControls();
    }
  }

  buildCompressionPrompt(material, finalMerge) {
    const target = Math.max(400, Number(this.settings.compressionTargetTokens) || 1200);
    return `你是 Obsidian 学习对话的“滚动记忆压缩器”。不要回答原问题，只压缩未来继续对话必须保留的信息。\n\n必须优先保留：\n- 用户当前目标、问题和明确偏好/约束\n- 用户曾明确要求总结/分析/解释过哪些文档或内容，以及这些任务的重要结果\n- 已确认事实、定义、结论和用户纠正\n- 已做出的决定及其理由\n- 重要代码、命令、配置值、文件路径、WikiLink、模型/参数名称\n- 对文档内容的关键理解、引用来源与仍需核实的点\n- 尚未解决的问题、后续行动和对连续对话有用的上下文\n\n压缩规则：\n1. 删除寒暄、重复表达、失败/取消的请求以及已被后续结论替代的过程性内容。\n2. 不虚构，不补充材料中没有的信息。\n3. 对代码/数字/路径/专有名词尽量保持精确。\n4. 用紧凑 Markdown，目标约 ${target} tokens。\n5. ${finalMerge ? "这是多段摘要的最终合并；去重并统一结构。" : "这是一个分块摘要；保留对最终合并有价值的信息。"}\n\n6. 如果材料中包含“既有滚动记忆”，它代表更早且已经有损压缩的历史；不得把其中仍然明确的主题、决定、约束和未完成事项无故删除。\n\n待压缩内容：\n${material}`;
  }

  resolveCompressionModel(value) {
    const options = this.getCompressionModelOptions();
    return options.find(o => o.value === value) || options[0];
  }

  async callCompressionModel(modelValue, material, finalMerge) {
    const choice = this.resolveCompressionModel(modelValue);
    if (!choice) throw new Error("未找到可用压缩模型");
    const prompt = this.buildCompressionPrompt(material, finalMerge);
    const maxTokens = Math.max(600, Math.min(4000, Number(this.settings.compressionTargetTokens) + 500));
    if (choice.type === "advanced") {
      const route = this.getAdvancedRoute(true);
      if (!route) throw new Error("高级压缩模型当前不可用");
      const isDeepSeek = /deepseek/i.test(`${route.providerName || ""} ${route.baseUrl || ""} ${route.model || ""}`);
      return await this.postOpenAiCompression(route.url, route.apiKey, route.model, prompt, maxTokens, { disableThinking: isDeepSeek });
    }

    // Local compression talks directly to Ollama native /api/chat rather than
    // the OpenAI compatibility endpoint. Thinking-capable models such as Qwen
    // can otherwise spend the whole output budget in reasoning_content and
    // leave message.content empty. Ollama officially supports `think:false`.
    const url = joinOllamaChatUrl(this.settings.upstreamBaseUrl);
    if (!url) throw new Error("Ollama 上游地址无效");
    return await this.postOllamaCompression(url, choice.model, prompt, maxTokens);
  }

  async requestJson(url, headers, payload, timeoutMs) {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const requestHeaders = { "content-type": "application/json", "content-length": String(body.length), ...(headers || {}) };
    return await new Promise((resolve, reject) => {
      const req = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        method: "POST",
        path: `${target.pathname}${target.search}`,
        headers: requestHeaders
      }, res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode || 500) >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 700)}`));
          try { resolve(JSON.parse(text)); }
          catch (e) { reject(new Error(`无法解析压缩模型响应：${e?.message || e}；原始响应：${text.slice(0, 300)}`)); }
        });
      });
      const timer = setTimeout(() => req.destroy(new Error("压缩请求超时")), timeoutMs);
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  async postOllamaCompression(url, model, prompt, maxTokens) {
    const timeoutMs = Math.max(60, Number(this.settings.hardTimeoutSeconds) || 240) * 1000;
    const payload = {
      model,
      messages: [
        { role: "system", content: "You compress conversation memory. Return only the compressed memory in Markdown." },
        { role: "user", content: prompt }
      ],
      stream: false,
      think: false,
      options: { temperature: 0.2, num_predict: maxTokens }
    };
    let json;
    try {
      json = await this.requestJson(url, null, payload, timeoutMs);
    } catch (err) {
      // Fallback for an older Ollama/model pair that does not understand the
      // `think` switch. We do not silently use thinking as the summary.
      if (/think|thinking|unsupported|unknown field|invalid/i.test(String(err?.message || err))) {
        const retryPayload = { ...payload };
        delete retryPayload.think;
        json = await this.requestJson(url, null, retryPayload, timeoutMs);
      } else {
        throw err;
      }
    }
    const content = json?.message?.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    const thinking = typeof json?.message?.thinking === "string" ? json.message.thinking.trim() : "";
    const reason = json?.done_reason || json?.doneReason || "unknown";
    if (thinking) throw new Error(`本地压缩模型只返回了思考内容，没有最终正文（done_reason=${reason}）。Safe Guard 已请求关闭 think。`);
    throw new Error(`本地压缩模型未返回正文（done_reason=${reason}）`);
  }

  async postOpenAiCompression(url, apiKey, model, prompt, maxTokens, options = {}) {
    const payload = {
      model,
      messages: [
        { role: "system", content: "You compress conversation memory. Return only the compressed memory in Markdown." },
        { role: "user", content: prompt }
      ],
      stream: false,
      max_tokens: maxTokens
    };
    if (options.disableThinking) {
      payload.thinking = { type: "disabled" };
      payload.reasoning_effort = "none";
    } else {
      payload.temperature = 0.2;
    }
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const timeoutMs = Math.max(60, Number(this.settings.hardTimeoutSeconds) || 240) * 1000;
    const json = await this.requestJson(url, headers, payload, timeoutMs);
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content.map(part => typeof part === "string" ? part : (part?.text || part?.content || "")).join("\n").trim();
      if (text) return text;
    }
    const reasoning = json?.choices?.[0]?.message?.reasoning_content;
    if (reasoning) throw new Error("远程压缩模型只返回了 reasoning_content，没有最终正文；本次压缩未写入。");
    throw new Error("远程压缩模型未返回正文");
  }


  ensureContextMemoryPromptInPayload(payload, state) {
    this.contextMemoryPromptEnsured = false;
    if (!this.settings.contextManagerEnabled || !state?.summary || !Array.isArray(payload?.messages)) return false;
    const memory = this.getMemorySystemPrompt(state);
    if (!memory) return false;
    const marker = "[LLM Hub Safe Guard Conversation Memory]";
    const systems = payload.messages.filter(m => m && m.role === "system");
    for (const msg of systems) {
      if (typeof msg.content === "string" && msg.content.includes(marker)) {
        this.contextMemoryPromptEnsured = true;
        return true;
      }
      if (Array.isArray(msg.content) && msg.content.some(part => part?.type === "text" && String(part.text || "").includes(marker))) {
        this.contextMemoryPromptEnsured = true;
        return true;
      }
    }
    const firstSystem = systems.find(m => typeof m.content === "string");
    if (firstSystem) firstSystem.content += `\n\n${memory}`;
    else payload.messages.unshift({ role: "system", content: memory });
    this.contextMemoryPromptEnsured = true;
    return true;
  }

  getMemorySystemPrompt(state) {
    if (!state?.summary) return "";
    const keep = Math.max(0, Number.isInteger(state.keepRecentMessages) ? state.keepRecentMessages : (Number(this.settings.compressionKeepRecentMessages) || 0));
    const recentRule = keep > 0
      ? `若与压缩边界后保留的原始消息冲突，以原始消息为准。压缩发生时保留了最近 ${keep} 条原始消息；之后的新消息继续正常累计。`
      : "压缩发生时未额外保留旧原始消息；之后的新消息继续正常累计。";
    const events = this.getCompressionEvents(state);
    const latest = events[events.length - 1] || null;
    const status = latest
      ? `当前聊天已经由 LLM Hub Safe Guard 执行过上下文压缩。最近一次：${this.formatCompressionEvent(latest, false)}。`
      : `当前聊天已经由 LLM Hub Safe Guard 执行过上下文压缩。最近压缩时间：${state.lastCompressedAt ? new Date(state.lastCompressedAt).toLocaleString() : "未知"}。`;
    const ledger = this.getMemoryLedger(state);
    let liveLedger = ledger;
    if (ledger.length > 14) liveLedger = [...ledger.slice(0, 4), ...ledger.slice(-10)];
    const ledgerText = liveLedger.length > 0
      ? `\n\n以下“长期记忆时间线/压缩检查点”是持久化的语义记忆。若用户询问被压缩前“讨论过什么、做过什么、有哪些结论”，必须优先依据这些检查点与滚动摘要回答；不要仅因为原始逐字消息已被压缩就声称“没有更早记忆”。只有用户要求逐字原文时，才需要读取完整聊天历史文件：\n${liveLedger.map((e, i) => `- ${i + 1}. ${e.digest}`).join("\n")}`
      : "";
    const historyPath = this.getChatHistoryPathForKey();
    const exactRule = historyPath
      ? `完整原始聊天历史仍保存在 Vault：${historyPath}。如果用户明确要求逐字恢复已经被摘要覆盖的旧回复，而当前 Vault Read Only 工具可用，应优先读取/搜索这个历史文件；若工具不可用或内容被截断，再明确说明无法保证逐字还原。`
      : "如用户要求逐字恢复已经被摘要覆盖的旧回复，必须说明压缩摘要本身不能保证逐字还原。";
    return `[LLM Hub Safe Guard Conversation Memory]\n${status}\n如果用户询问“当前聊天是否压缩过/何时压缩/是否还能逐字回忆旧消息”，必须明确说明已经压缩过；摘要是有损记忆，不能把重构内容冒充成原始逐字聊天记录。\n重要：有损压缩不等于“没有记忆”。对于主题、结论、任务、文件和决定等语义回忆，只要下方长期记忆时间线或滚动摘要中存在信息，就应直接据此回答；不得仅因为原始逐字消息已被压缩而回答“无法访问/没有更早对话”。只有逐字引用、精确措辞或摘要未覆盖的细节才需要回查历史文件。\n${exactRule}\n${recentRule}${ledgerText}\n\n以下是此前对话的滚动压缩记忆（语义记忆，优先用于回答更早讨论主题）：\n${state.summary}`;
  }

  async applyRuntimeMemoryForCurrentChat(forceHistorySync = false) {
    const hub = this.getLlmHubPlugin();
    if (!hub) return false;
    if (this.baseLlmHubSystemPrompt === null) this.baseLlmHubSystemPrompt = String(hub.settings?.systemPrompt || "");
    if (this.baseHistoryLimit === null) this.baseHistoryLimit = Number(hub.workspaceState?.maxPreviousMessages ?? 99);
    const state = this.getContextState();
    const memory = this.settings.contextManagerEnabled ? this.getMemorySystemPrompt(state) : "";
    hub.settings.systemPrompt = memory ? `${this.baseLlmHubSystemPrompt}${this.baseLlmHubSystemPrompt ? "\n\n" : ""}${memory}` : this.baseLlmHubSystemPrompt;
    this.contextRuntimeMemoryApplied = Boolean(memory);
    // While compressed memory is active, keep LLM Hub's own history window wide.
    // Safe Guard trims only the already-summarized prefix at the proxy boundary.
    // This lets every NEW turn after compression accumulate normally and avoids
    // losing it merely because the compression-time retain count was small.
    const desiredHistory = memory ? 99 : Math.max(0, Number(this.baseHistoryLimit ?? 99));
    if (forceHistorySync || Number(hub.workspaceState?.maxPreviousMessages) !== desiredHistory) {
      await this.setLlmHubHistoryLimit(desiredHistory);
    }
    this.ensureAutoPanelControls();
    this.applyCompressionMarkers();
    return true;
  }

  async setLlmHubHistoryLimit(value) {
    const hub = this.getLlmHubPlugin();
    if (!hub || this.historySyncInFlight) return false;
    const wanted = Math.max(0, Math.min(99, Number(value) || 0));
    this.historySyncInFlight = true;
    try {
      if (hub.workspaceState) hub.workspaceState.maxPreviousMessages = wanted;
      const buttons = Array.from(document.querySelectorAll(".llm-hub-vault-tool-btn"))
        .filter(el => el instanceof HTMLElement && el.offsetParent !== null && !el.disabled);
      const button = buttons[buttons.length - 1];
      if (!button) return false;

      const findInput = () => {
        const visible = Array.from(document.querySelectorAll('input[type="number"]'))
          .filter(el => el instanceof HTMLInputElement && el.offsetParent !== null);
        return visible.find(el => Number(el.max || 99) === 99 && Number(el.min || 0) === 0) || null;
      };
      let input = findInput();
      if (!input) {
        input = await new Promise(resolve => {
          let settled = false;
          const finish = value => {
            if (settled) return;
            settled = true;
            observer.disconnect();
            window.clearTimeout(timer);
            resolve(value);
          };
          const observer = new MutationObserver(() => {
            const found = findInput();
            if (found) finish(found);
          });
          observer.observe(document.body, { childList: true, subtree: true });
          const timer = window.setTimeout(() => finish(findInput()), 300);
          button.click();
        });
      }
      if (!(input instanceof HTMLInputElement)) return false;
      const commitHistoryValue = () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, String(wanted)); else input.value = String(wanted);
        try {
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(wanted) }));
        } catch (_) {
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      commitHistoryValue();

      // React's controlled number input occasionally restores the pre-compression
      // value before our synthetic input event reaches its state setter. As a
      // version-scoped fallback, call the input's React onChange prop directly.
      await new Promise(resolve => window.setTimeout(resolve, 25));
      if (Number(input.value) !== wanted) {
        try {
          const propKey = Object.keys(input).find(k => k.startsWith("__reactProps$"));
          const onChange = propKey ? input[propKey]?.onChange : null;
          if (typeof onChange === "function") {
            onChange({ target: { value: String(wanted), valueAsNumber: wanted }, currentTarget: input });
          }
        } catch (err) {
          console.debug("[LLM Hub Safe Guard] React history-limit fallback unavailable", err);
        }
        commitHistoryValue();
      }
      try { if (typeof hub.saveWorkspaceState === "function") await hub.saveWorkspaceState(); } catch (_) {}

      const menuVisible = () => Array.from(document.querySelectorAll(".llm-hub-vault-tool-menu, .llm-hub-vault-tool-item"))
        .some(el => el instanceof HTMLElement && el.offsetParent !== null);
      const closeMenu = () => {
        if (!menuVisible()) return true;
        const outside = Array.from(document.querySelectorAll(".llm-hub-chat-header, .llm-hub-message-list, .llm-hub-composer textarea"))
          .find(el => el instanceof HTMLElement && el.offsetParent !== null) || document.body;
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          try { outside.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window })); } catch (_) {}
        }
        try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); } catch (_) {}
        return !menuVisible();
      };
      closeMenu();
      window.requestAnimationFrame(() => {
        if (closeMenu()) return;
        window.setTimeout(() => {
          if (closeMenu()) return;
          // Last-resort toggle: only click while the menu is definitely visible.
          if (menuVisible()) { try { button.click(); } catch (_) {} }
        }, 100);
      });
      return true;
    } catch (err) {
      console.warn("[LLM Hub Safe Guard] history limit sync failed", err);
      return false;
    } finally {
      this.historySyncInFlight = false;
    }
  }

  async persistContextMemory() {
    const key = this.getCurrentContextKey();
    if (!key.startsWith("id:")) return;
    if (!this.settings.contextMemories || typeof this.settings.contextMemories !== "object") this.settings.contextMemories = {};
    const state = this.getContextState();
    if (state.summary) {
      this.settings.contextMemories[key] = {
        summary: state.summary,
        summaryCoveredCount: state.summaryCoveredCount,
        lastCompressedAt: state.lastCompressedAt,
        lastCompressionModel: state.lastCompressionModel,
        keepRecentMessages: Math.max(0, Number.isInteger(state.keepRecentMessages) ? state.keepRecentMessages : (Number(this.settings.compressionKeepRecentMessages) || 0)),
        compressionEvents: this.getCompressionEvents(state).slice(-48),
        memoryLedger: this.getMemoryLedger(state).slice(-48)
      };
    } else if (this.getCompressionEvents(state).length > 0) {
      // Clearing active memory should not erase the audit trail that compression
      // happened. The model no longer receives the summary, but the user can
      // still see/export the historical "已压缩" markers.
      this.settings.contextMemories[key] = {
        summary: "",
        summaryCoveredCount: 0,
        lastCompressedAt: state.lastCompressedAt,
        lastCompressionModel: state.lastCompressionModel,
        keepRecentMessages: null,
        compressionEvents: this.getCompressionEvents(state).slice(-48),
        memoryLedger: this.getMemoryLedger(state).slice(-48)
      };
    } else {
      delete this.settings.contextMemories[key];
    }
    // Keep the persistent store bounded.
    const entries = Object.entries(this.settings.contextMemories);
    if (entries.length > 30) {
      entries.sort((a,b) => Number(b[1]?.lastCompressedAt || 0) - Number(a[1]?.lastCompressedAt || 0));
      this.settings.contextMemories = Object.fromEntries(entries.slice(0, 30));
    }
    await this.saveSettings();
    const wroteSidecar = await this.writeContextSidecar(key, state);
    if (wroteSidecar) {
      state.persistenceSource = "data.json+sidecar";
      this.contextPersistenceSource = "data.json+sidecar";
    } else {
      state.persistenceSource = "data.json";
      this.contextPersistenceSource = "data.json";
    }
  }

  async clearCurrentContextMemory(notify = false) {
    const state = this.getContextState();
    state.summary = "";
    state.summaryCoveredCount = 0;
    state.lastCompressedAt = 0;
    state.lastCompressionModel = "";
    state.keepRecentMessages = null;
    state.memoryLedger = [];
    state.healthHighWaterByModel = {};
    this.contextHealthCache = null;
    await this.persistContextMemory();
    await this.applyRuntimeMemoryForCurrentChat(true);
    if (notify) new Notice("LLM Hub Safe Guard：已清除当前聊天压缩记忆，恢复正常历史窗口。", 2500);
  }

  quarantineCancelledMessage(state, payload, metrics) {
    if (!state || !metrics?.latestUserText) return;
    const fp = simpleFingerprint(metrics.latestUserText);
    state.cancelled.push({ fingerprint: fp, createdAt: Date.now(), consumed: false });
    if (!Array.isArray(state.cancelledHistory)) state.cancelledHistory = [];
    if (!state.cancelledHistory.includes(fp)) state.cancelledHistory.push(fp);
    // Do not let a later manual compression accidentally absorb a cancelled message.
    if (Array.isArray(state.lastRawMessages)) {
      for (let i = state.lastRawMessages.length - 1; i >= 0; i--) {
        const m = state.lastRawMessages[i];
        if (m?.role === "user" && simpleFingerprint(contentToText(m.content)) === fp) {
          state.lastRawMessages.splice(i, 1);
          break;
        }
      }
    }
  }

  applyCancellationQuarantine(payload, state) {
    if (!state || !Array.isArray(payload?.messages) || !Array.isArray(state.cancelled) || state.cancelled.length === 0) return 0;
    const messages = payload.messages;
    let removed = 0;
    const lastUserIndex = (() => {
      for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return i;
      return -1;
    })();
    for (const entry of state.cancelled) {
      if (entry.consumed) continue;
      let idx = -1;
      for (let i = Math.max(0, lastUserIndex - 1); i >= 0; i--) {
        const m = messages[i];
        if (m?.role === "user" && simpleFingerprint(contentToText(m.content)) === entry.fingerprint) { idx = i; break; }
      }
      if (idx >= 0) {
        messages.splice(idx, 1);
        removed++;
        const next = messages[idx];
        if (next?.role === "assistant" && /Request cancelled by LLM Hub Safe Guard|请求.*Safe Guard.*取消/i.test(contentToText(next.content))) {
          messages.splice(idx, 1);
          removed++;
        }
        entry.consumed = true;
      }
    }
    state.cancelled = state.cancelled.filter(e => !e.consumed && Date.now() - e.createdAt < 60 * 60 * 1000);
    return removed;
  }

  getAdvancedRoute(ignoreRouterEnabled = false) {
    if ((!ignoreRouterEnabled && !this.settings.routerEnabled) || !this.settings.advancedRouteEnabled) return null;
    const hub = this.getLlmHubPlugin();
    const providers = Array.isArray(hub?.settings?.apiProviders) ? hub.settings.apiProviders : [];
    const providerHint = String(this.settings.advancedProviderHint || "").trim().toLowerCase();
    const modelHint = String(this.settings.advancedModelHint || "").trim().toLowerCase();
    const candidates = [];
    for (const provider of providers) {
      if (!provider || provider.enabled === false || provider.verified === false) continue;
      if (!provider.baseUrl || !provider.apiKey || !Array.isArray(provider.enabledModels)) continue;
      if (provider.type === "gemini" || provider.type === "anthropic") continue; // v0.3 only OpenAI-compatible pass-through
      for (const model of provider.enabledModels) {
        if (!model) continue;
        const pName = String(provider.name || "");
        const hay = `${pName} ${provider.type || ""} ${provider.baseUrl || ""} ${model}`.toLowerCase();
        let score = 0;
        if (providerHint && hay.includes(providerHint)) score += 10;
        if (modelHint && String(model).toLowerCase().includes(modelHint)) score += 14;
        if (hay.includes("deepseek")) score += 6;
        if (String(model).toLowerCase().includes("flash")) score += 3;
        candidates.push({ provider, model: String(model), score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best || (best.score <= 0 && (providerHint || modelHint))) return null;
    const url = joinOpenAiChatUrl(best.provider.baseUrl);
    if (!url) return null;
    return {
      type: "advanced",
      providerId: best.provider.id,
      providerName: best.provider.name || "API Provider",
      providerType: best.provider.type || "custom",
      baseUrl: best.provider.baseUrl,
      url,
      apiKey: best.provider.apiKey,
      model: best.model,
      shortName: best.provider.name || "DeepSeek",
      displayName: `${best.provider.name || "API Provider"} (${best.model})`
    };
  }

  getStickyRoute(metrics) {
    const active = this.activeTurnRoute;
    if (!active || active.expiresAt < Date.now()) {
      this.activeTurnRoute = null;
      return null;
    }
    const fp = simpleFingerprint(metrics.latestUserText);
    const isToolContinuation = metrics.lastMessageRole === "tool" || metrics.lastMessageRole === "assistant";
    if (isToolContinuation && fp === active.userFingerprint) return active.route;
    return null;
  }

  rememberTurnRoute(metrics, route) {
    this.activeTurnRoute = {
      userFingerprint: simpleFingerprint(metrics.latestUserText),
      route,
      expiresAt: Date.now() + 3 * 60 * 1000
    };
  }

  noteRoute(label, route = null) {
    this.lastRouteLabel = label;
    if (route) this.activateActualRouteUi(route);
    if (this.settings.showRoutingNotices) new Notice(`LLM Hub Safe Guard：${label}`);
  }

  getLocalRouteDisplayName(model) {
    const hub = this.getLlmHubPlugin();
    const configs = Array.isArray(hub?.settings?.localLlmConfigs) ? hub.settings.localLlmConfigs : [];
    const hit = configs.find(cfg => Array.isArray(cfg?.enabledModels) && cfg.enabledModels.includes(model));
    if (hit?.name) return `${hit.name} (${model})`;
    return model;
  }

  routeDisplayName(route) {
    if (!route) return "";
    if (route.type === "advanced") return route.displayName || route.model || "高级模型";
    if (route.type === "vision") return this.getLocalRouteDisplayName(route.model || this.settings.visionModel);
    return route.model || "";
  }

  async setRouterEnabled(enabled, notify = false) {
    this.settings.routerEnabled = Boolean(enabled);
    if (!this.settings.routerEnabled) {
      this.clearConversationPinnedRoute(false);
      this.routeUiState = null;
      this.clearActualRouteChip();
    }
    await this.saveSettings();
    this.ensureAutoPanelControls();
    if (notify) new Notice(`LLM Hub Safe Guard：Auto 智能路由已${this.settings.routerEnabled ? "开启" : "关闭"}`);
  }

  resetRouterConversation(reason = "新聊天") {
    this.activeTurnRoute = null;
    this.recentRouteDecisions.clear();
    this.conversationPinnedRoute = null;
    this.routeUiState = null;
    this.lastRouteLabel = `${reason}：Auto ${this.settings.routerEnabled ? "开启" : "关闭"}`;
    this.clearActualRouteChip();
    this.ensureAutoPanelControls();
  }

  pinConversationRoute(route) {
    if (!route || route.type !== "advanced") return;
    this.conversationPinnedRoute = { ...route, pinnedAt: Date.now() };
    this.lastRouteLabel = `当前连续对话持续使用 ${this.routeDisplayName(route)}`;
    this.activateActualRouteUi(route);
    this.ensureAutoPanelControls();
  }

  clearConversationPinnedRoute(notify = false) {
    const had = Boolean(this.conversationPinnedRoute);
    this.conversationPinnedRoute = null;
    this.activeTurnRoute = null;
    this.routeUiState = null;
    this.clearActualRouteChip();
    this.lastRouteLabel = `已恢复普通 Auto 判定`;
    this.ensureAutoPanelControls();
    if (notify && had) new Notice("LLM Hub Safe Guard：已取消持续模型路由，下一次发送恢复普通 Auto 判定");
  }

  ensureAutoPanelControls() {
    const pickers = Array.from(document.querySelectorAll(".llm-hub-model-picker"))
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
    const picker = pickers[pickers.length - 1];
    if (!picker || !picker.parentElement) return;

    // v0.5 removes the old redundant "AUTO → model" chip. Actual routed model
    // is still reflected in the assistant message title.
    this.clearActualRouteChip();

    let wrap = picker.parentElement.querySelector(":scope > .llm-hub-safe-guard-auto-controls");
    if (!wrap) {
      wrap = document.createElement("span");
      wrap.className = "llm-hub-safe-guard-auto-controls";
      picker.insertAdjacentElement("afterend", wrap);
    }

    let toggle = wrap.querySelector(".llm-hub-safe-guard-auto-toggle");
    if (!toggle) {
      toggle = document.createElement("button");
      toggle.className = "llm-hub-safe-guard-auto-toggle";
      toggle.title = "点击随时开启/关闭 Safe Guard Auto 智能路由；资源守卫、Read Only 和上下文管理不受影响";
      toggle.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        void this.setRouterEnabled(!this.settings.routerEnabled, true);
      });
      wrap.appendChild(toggle);
    }
    const toggleText = this.settings.routerEnabled ? "AUTO 开" : "AUTO 关";
    if (toggle.textContent !== toggleText) toggle.textContent = toggleText;
    toggle.classList.toggle("is-on", this.settings.routerEnabled);
    toggle.classList.toggle("is-off", !this.settings.routerEnabled);

    let pinned = wrap.querySelector(".llm-hub-safe-guard-pinned-route");
    if (this.conversationPinnedRoute) {
      if (!pinned) {
        pinned = document.createElement("button");
        pinned.className = "llm-hub-safe-guard-pinned-route";
        pinned.title = "当前连续对话会直接发送到此模型。点击取消持续路由，下一次发送恢复普通 Auto 判定。";
        pinned.addEventListener("click", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          this.clearConversationPinnedRoute(true);
        });
        wrap.appendChild(pinned);
      }
      const text = `持续 → ${this.routeDisplayName(this.conversationPinnedRoute)}  ×`;
      if (pinned.textContent !== text) pinned.textContent = text;
    } else if (pinned) {
      pinned.remove();
    }

    const contextState = this.getContextState();
    let compressedChip = wrap.querySelector(".llm-hub-safe-guard-compressed-chip");
    if (contextState.summary) {
      if (!compressedChip) {
        compressedChip = document.createElement("span");
        compressedChip.className = "llm-hub-safe-guard-compressed-chip";
        wrap.appendChild(compressedChip);
      }
      const latest = this.getCompressionEvents(contextState).slice(-1)[0];
      const compressedText = latest ? `已压缩 · 保留${latest.keepRecent}条` : "已压缩";
      if (compressedChip.textContent !== compressedText) compressedChip.textContent = compressedText;
      compressedChip.title = latest ? this.formatCompressionEvent(latest, false) : "当前聊天已启用 Safe Guard 滚动压缩记忆";
    } else if (compressedChip) {
      compressedChip.remove();
    }

    let visionChip = wrap.querySelector(".llm-hub-safe-guard-vision-chip");
    const vision = this.lastMarkdownVision || {};
    const visionFresh = Number(vision.at || 0) > 0 && Date.now() - Number(vision.at || 0) < 10 * 60 * 1000 && Number(vision.refs || 0) > 0;
    if (visionFresh) {
      if (!visionChip) {
        visionChip = document.createElement("span");
        visionChip.className = "llm-hub-safe-guard-vision-chip";
        wrap.appendChild(visionChip);
      }
      const failed = Number(vision.refs || 0) - Number(vision.attached || 0);
      const text = failed > 0 ? `🖼 MD图像 ${vision.attached}/${vision.refs}` : `🖼 MD图像 ${vision.attached}`;
      if (visionChip.textContent !== text) visionChip.textContent = text;
      visionChip.classList.toggle("has-error", failed > 0);
      const missing = Array.isArray(vision.missing) && vision.missing.length ? `\n未找到：${vision.missing.map(x => x.target).join("；")}` : "";
      const unsupported = Array.isArray(vision.unsupported) && vision.unsupported.length ? `\n不支持：${vision.unsupported.map(x => x.target).join("；")}` : "";
      const large = Array.isArray(vision.tooLarge) && vision.tooLarge.length ? `\n过大：${vision.tooLarge.map(x => x.path).join("；")}` : "";
      visionChip.title = `Markdown Vision Bridge\n渠道：${vision.channel || "unknown"}\n引用 ${vision.refs || 0} · 解析 ${vision.resolved || 0} · 实际发送 ${vision.attached || 0}${missing}${unsupported}${large}`;
    } else if (visionChip) {
      visionChip.remove();
    }

    let contextButton = wrap.querySelector(".llm-hub-safe-guard-context-button");
    if (!this.settings.contextManagerEnabled) {
      if (contextButton) contextButton.remove();
      return;
    }
    if (!contextButton) {
      contextButton = document.createElement("button");
      contextButton.className = "llm-hub-safe-guard-context-button";
      contextButton.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        void this.startCompressionFlow();
      });
      wrap.appendChild(contextButton);
    }

    contextButton.classList.remove("is-green", "is-yellow", "is-orange", "is-red", "is-busy");
    if (this.compressionInProgress) {
      const p = this.compressionProgress || { stage: "压缩中", current: 0, total: 0 };
      const suffix = p.total > 1 ? ` · ${p.current}/${p.total}` : "";
      const busyText = `🔵 ${p.stage}${suffix}  ⟳`;
      if (contextButton.textContent !== busyText) contextButton.textContent = busyText;
      contextButton.classList.add("is-busy");
      contextButton.disabled = true;
      contextButton.title = "上下文压缩进行中；完成前 Safe Guard 会阻止发送下一条消息。";
    } else {
      const health = this.getContextHealth();
      const icon = health.color === "red" ? "🔴" : health.color === "orange" ? "🟠" : health.color === "yellow" ? "🟡" : "🟢";
      const healthText = health.loading ? "🔵 上下文载入中 ⟳" : `${icon} 上下文 ${Math.max(0, Math.round(health.ratio * 100))}%`;
      if (contextButton.textContent !== healthText) contextButton.textContent = healthText;
      contextButton.classList.add(`is-${health.color}`);
      contextButton.disabled = false;
      contextButton.title = `${health.modelLabel}\n约 ${health.usedTokens.toLocaleString()} / ${health.budgetTokens.toLocaleString()} tokens\n状态：${health.level}\n点击选择模型并压缩上下文。`;
    }
    this.applyCompressionMarkers();
  }

  activateActualRouteUi(route) {
    const displayName = this.routeDisplayName(route);
    if (!displayName) return;
    const users = Array.from(document.querySelectorAll(".llm-hub-message-user"))
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
    this.routeUiState = {
      displayName,
      routeType: route.type,
      userOrdinal: Math.max(0, users.length - 1),
      expiresAt: Date.now() + 10 * 60 * 1000
    };
    this.applyActualRouteUi();
  }

  clearActualRouteChip() {
    for (const chip of document.querySelectorAll(".llm-hub-safe-guard-route-chip")) chip.remove();
  }

  applyActualRouteUi() {
    const state = this.routeUiState;
    if (!state || state.expiresAt < Date.now()) {
      this.routeUiState = null;
      this.clearActualRouteChip();
      return;
    }

    this.clearActualRouteChip();

    const users = Array.from(document.querySelectorAll(".llm-hub-message-user"))
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
    const user = users[state.userOrdinal] || users[users.length - 1];
    if (!user) return;

    const assistants = Array.from(document.querySelectorAll(".llm-hub-message-assistant"))
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
    const target = assistants.find(el => Boolean(user.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (!target) return;
    const role = target.querySelector(".llm-hub-message-role");
    if (role) {
      if (role.textContent !== state.displayName) role.textContent = state.displayName;
      role.setAttribute("data-safe-guard-route", state.routeType);
      role.setAttribute("title", `实际执行模型：${state.displayName}`);
    }
  }


  routeSupportsVision(route) {
    if (!route) return false;
    const hay = `${route.model || ""} ${route.displayName || ""} ${route.providerName || ""} ${route.baseUrl || ""}`;
    return /deepseek[-_]?flash|vision|vl(?:\b|[:_-])/i.test(hay);
  }

  getVisionFallbackSourcePath() {
    try {
      const file = this.app.workspace.getActiveFile();
      if (file?.path && /\.(?:md|markdown)$/i.test(file.path)) return normalizePath(file.path);
    } catch (_) {}
    return "";
  }

  resolveVaultVisionFile(target, sourcePath = "") {
    let cleaned = cleanVisionTarget(target).replace(/[?#].*$/, "");
    if (!cleaned) return null;

    // Normalize Obsidian/file URLs and Windows separators before checking the
    // vault.  An absolute path is accepted only when it is inside this vault.
    if (/^obsidian:\/\/open\?/i.test(cleaned)) {
      try {
        const u = new URL(cleaned);
        cleaned = u.searchParams.get("file") || "";
      } catch (_) {}
    }
    cleaned = decodeHtmlEntities(cleaned);
    try { cleaned = decodeURIComponent(cleaned); } catch (_) {}
    cleaned = cleaned.replace(/^file:\/{2,3}/i, "").replace(/\\/g, "/");
    if (/^\/[A-Za-z]:\//.test(cleaned)) cleaned = cleaned.slice(1);

    if (/^[A-Za-z]:\//.test(cleaned) || cleaned.startsWith("//")) {
      let base = "";
      try { base = String(this.app.vault.adapter?.getBasePath?.() || "").replace(/\\/g, "/").replace(/\/+$/, ""); } catch (_) {}
      const candidate = cleaned.replace(/\/+$/, "");
      if (!base || !candidate.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
        return { missing: true, target: cleaned, sourcePath: sourcePath || "", outsideVault: true };
      }
      cleaned = candidate.slice(base.length + 1);
    }
    cleaned = cleaned.replace(/^\/+/, "");
    const ext = cleaned.split(".").pop()?.toLowerCase() || "";
    if (!SUPPORTED_VISION_EXTENSIONS.has(ext)) return { unsupported: true, target: cleaned, ext };

    const source = sourcePath ? normalizePath(sourcePath) : "";
    try {
      const linked = this.app.metadataCache?.getFirstLinkpathDest?.(cleaned, source || "");
      if (linked?.path && linked.extension) return { file: linked, target: cleaned };
    } catch (_) {}

    const candidates = [];
    candidates.push(normalizePath(cleaned));
    if (source) candidates.push(normalizePath(pathUtil.join(pathUtil.dirname(source), cleaned)));
    for (const candidate of candidates) {
      try {
        const file = this.app.vault.getAbstractFileByPath(candidate);
        if (file?.path && file.extension) return { file, target: cleaned };
      } catch (_) {}
    }
    return { missing: true, target: cleaned, sourcePath: source };
  }

  async applyMarkdownVisionBridge(payload, options = {}) {
    const channel = String(options.channel || "proxy");
    const diagnostics = {
      refs: 0, resolved: 0, attached: 0,
      missing: [], unsupported: [], tooLarge: [],
      sourcePaths: [], channel, at: Date.now(),
      directProvider: channel === "direct-provider"
    };
    if (this.settings.markdownVisionEnabled === false || !Array.isArray(payload?.messages)) {
      this.lastMarkdownVision = diagnostics;
      return diagnostics;
    }

    const fallbackSource = this.getVisionFallbackSourcePath();
    const seenResolvedPaths = new Set();
    const maxBytes = Math.max(1, Number(this.settings.markdownVisionMaxImageMB) || 16) * 1024 * 1024;

    // Walk newest → oldest so duplicate references stay associated with the most
    // recent user turn. This prevents the same embedded image being base64'd
    // repeatedly when it appears in both an old excerpt and the current question.
    for (let i = payload.messages.length - 1; i >= 0; i--) {
      const msg = payload.messages[i];
      if (!msg || msg.role !== "user") continue;
      const text = getMessageTextForVision(msg);
      const refs = extractAllVisionRefs(text, this.settings.markdownVisionRecognizeBarePaths !== false);
      if (!refs.length) continue;
      diagnostics.refs += refs.length;
      const sourcePath = extractMarkdownSourcePath(text) || fallbackSource;
      if (sourcePath && !diagnostics.sourcePaths.includes(sourcePath)) diagnostics.sourcePaths.push(sourcePath);

      const toAttach = [];
      for (const ref of refs) {
        const resolved = this.resolveVaultVisionFile(ref.target, sourcePath);
        if (!resolved) continue;
        if (resolved.unsupported) {
          diagnostics.unsupported.push({ target: ref.target, reason: `不支持 .${resolved.ext || "unknown"}` });
          continue;
        }
        if (resolved.missing || !resolved.file) {
          diagnostics.missing.push({ target: ref.target, sourcePath: sourcePath || "" });
          continue;
        }
        const vaultPath = normalizePath(resolved.file.path);
        if (seenResolvedPaths.has(vaultPath.toLowerCase())) continue;
        seenResolvedPaths.add(vaultPath.toLowerCase());
        diagnostics.resolved += 1;

        const size = Number(resolved.file.stat?.size || 0);
        if (size > maxBytes) {
          diagnostics.tooLarge.push({ path: vaultPath, bytes: size });
          continue;
        }
        try {
          const binary = await this.app.vault.readBinary(resolved.file);
          const bytes = Buffer.from(binary);
          if (bytes.length > maxBytes) {
            diagnostics.tooLarge.push({ path: vaultPath, bytes: bytes.length });
            continue;
          }
          const mime = mimeTypeForVisionPath(vaultPath);
          const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
          toAttach.push({ path: vaultPath, target: ref.target, dataUrl });
        } catch (err) {
          diagnostics.missing.push({ target: ref.target, sourcePath: sourcePath || "", error: err?.message || String(err) });
        }
      }

      if (toAttach.length) {
        const parts = ensureUserContentArray(msg);
        if (!parts) continue;
        for (const item of toAttach) {
          // Keep a tiny path label so the model can associate an image with the
          // source reference without having to infer which embed it belonged to.
          parts.push({ type: "text", text: `${SAFE_GUARD_VISION_MARKER} 已解析本地图片：${item.path}` });
          parts.push({ type: "image_url", image_url: { url: item.dataUrl, detail: "auto" } });
          diagnostics.attached += 1;
        }
      }
    }

    if (diagnostics.refs > 0) this.lastMarkdownVision = diagnostics;
    this.ensureAutoPanelControls();

    if (diagnostics.refs > 0 && this.settings.markdownVisionShowNotices !== false) {
      const key = `${channel}|${diagnostics.refs}|${diagnostics.attached}|${diagnostics.missing.map(x => x.target).join("|")}|${diagnostics.tooLarge.map(x => x.path).join("|")}`;
      if (this.markdownVisionNoticeKey !== key) {
        this.markdownVisionNoticeKey = key;
        if (diagnostics.attached > 0) {
          new Notice(`LLM Hub Safe Guard：Markdown 图片 ${diagnostics.attached}/${diagnostics.refs} 已解析并作为真实图片附加。`, 2600);
        }
        if (diagnostics.missing.length > 0) {
          new Notice(`LLM Hub Safe Guard：有 ${diagnostics.missing.length} 个 Markdown 图片路径无法解析；请检查相对路径/源文档位置。`, 4200);
        }
        if (diagnostics.unsupported.length > 0) {
          new Notice(`LLM Hub Safe Guard：有 ${diagnostics.unsupported.length} 张图片格式不受 v0.6 Vision Bridge 支持（仅 PNG/JPEG/GIF/WebP）。`, 4200);
        }
        if (diagnostics.tooLarge.length > 0) {
          new Notice(`LLM Hub Safe Guard：有 ${diagnostics.tooLarge.length} 张图片超过 ${this.settings.markdownVisionMaxImageMB || 16} MB，未静默发送。`, 4200);
        }
      }
    }
    return diagnostics;
  }

  getNativeProviderVisionCandidate() {
    if (!this.nativeVisionAttachmentBridgeEnabled) return null;
    if (Date.now() < Number(this.nativeVisionResendBypassUntil || 0)) return null;

    const label = this.getManualSelectedModelLabel();
    const isDeepSeek = isDeepSeekModelLabel(label) || /deepseek[-_]?flash/i.test(label);
    const isLocal = /(?:ollama|local|qwen|lm\s*studio)/i.test(label);
    // Local references are auto-attached when AUTO can hand real images to the
    // configured vision model, or when a visual local model is selected.  The
    // known DeepSeek Flash provider accepts native image attachments directly.
    if (!isDeepSeek && !(isLocal && (this.settings.routerEnabled || isLikelyVisionModel(label)))) return null;

    const composers = Array.from(document.querySelectorAll(".llm-hub-composer"))
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
    const composer = composers[composers.length - 1];
    if (!composer) return null;
    const textarea = composer.querySelector("textarea");
    const typed = String(textarea?.value || "");

    const hub = this.getLlmHubPlugin();
    let selection = "";
    let selectionSource = "";
    try { selection = String(typeof hub?.getLastSelection === "function" ? (hub.getLastSelection() || "") : ""); } catch (_) {}
    try {
      const loc = typeof hub?.getSelectionLocation === "function" ? hub.getSelectionLocation() : null;
      selectionSource = String(loc?.sourcePath || "");
    } catch (_) {}

    // @ Section may keep the selected source in SelectionManager rather than in
    // the visible textarea.  Always consider both sources; dedupe later.
    const combined = [typed, selection].filter(Boolean).join("\n");
    if (!combined.trim()) return null;
    const refs = extractAllVisionRefs(combined, this.settings.markdownVisionRecognizeBarePaths !== false);
    if (!refs.length) return null;
    const sourcePath = extractMarkdownSourcePath(combined) || selectionSource || this.getVisionFallbackSourcePath();
    return {
      label, isDeepSeek, isLocal, composer, textarea, typed, selection, combined, refs,
      sourcePath: sourcePath ? normalizePath(sourcePath) : "",
      inputMode: selection && extractAllVisionRefs(selection, this.settings.markdownVisionRecognizeBarePaths !== false).length ? "section" : "text-reference"
    };
  }

  getNativeVisionFileInput(composer) {
    const panel = composer?.closest?.(".llm-hub-tab-panel") || composer?.closest?.(".llm-hub-chat-view") || document;
    const inputs = Array.from(panel.querySelectorAll?.('input[type="file"]') || []);
    return inputs[inputs.length - 1] || null;
  }

  async buildNativeVisionFiles(candidate) {
    const diagnostics = {
      refs: candidate.refs.length, resolved: 0, attached: 0,
      missing: [], unsupported: [], tooLarge: [],
      sourcePaths: candidate.sourcePath ? [candidate.sourcePath] : [],
      channel: "native-attachment", at: Date.now(), directProvider: Boolean(candidate.isDeepSeek),
      existingAttached: 0, inputMode: candidate.inputMode || "text-reference"
    };
    const maxBytes = Math.max(1, Number(this.settings.markdownVisionMaxImageMB) || 16) * 1024 * 1024;
    const seen = new Set();
    const pendingText = Array.from(document.querySelectorAll(".llm-hub-pending-attachment"))
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null)
      .map(el => String(el.textContent || "").toLowerCase())
      .join("\n");
    const files = [];

    for (const ref of candidate.refs) {
      const resolved = this.resolveVaultVisionFile(ref.target, candidate.sourcePath);
      if (!resolved) continue;
      if (resolved.unsupported) {
        diagnostics.unsupported.push({ target: ref.target, reason: `不支持 .${resolved.ext || "unknown"}` });
        continue;
      }
      if (resolved.missing || !resolved.file) {
        diagnostics.missing.push({ target: ref.target, sourcePath: candidate.sourcePath || "" });
        continue;
      }
      const vaultPath = normalizePath(resolved.file.path);
      const key = vaultPath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.resolved += 1;

      const fileName = pathUtil.basename(vaultPath);
      // If the user already attached this exact file manually, do not add a
      // second copy merely because the Markdown excerpt still contains <img>.
      if (pendingText.includes(fileName.toLowerCase())) {
        diagnostics.existingAttached += 1;
        continue;
      }

      const statSize = Number(resolved.file.stat?.size || 0);
      if (statSize > maxBytes) {
        diagnostics.tooLarge.push({ path: vaultPath, bytes: statSize });
        continue;
      }
      try {
        const binary = await this.app.vault.readBinary(resolved.file);
        const bytes = binary instanceof ArrayBuffer ? binary : Buffer.from(binary).buffer;
        const actualSize = Number(binary?.byteLength || binary?.length || statSize || 0);
        if (actualSize > maxBytes) {
          diagnostics.tooLarge.push({ path: vaultPath, bytes: actualSize });
          continue;
        }
        if (typeof File !== "function") throw new Error("当前 Obsidian WebView 不提供 File API");
        const mime = mimeTypeForVisionPath(vaultPath);
        const fileObj = new File([bytes], fileName, { type: mime, lastModified: Number(resolved.file.stat?.mtime || Date.now()) });
        files.push(fileObj);
        try {
          const resource = this.app.vault.getResourcePath?.(resolved.file);
          if (resource) this.visionPreviewByName.set(fileName.toLowerCase(), { url: resource, mime, vaultPath, at: Date.now() });
        } catch (_) {}
      } catch (err) {
        diagnostics.missing.push({ target: ref.target, sourcePath: candidate.sourcePath || "", error: err?.message || String(err) });
      }
    }
    return { files, diagnostics };
  }

  async waitForPendingAttachmentCount(expectedMin, timeoutMs = 1800) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const count = Array.from(document.querySelectorAll(".llm-hub-pending-attachment"))
        .filter(el => el instanceof HTMLElement && el.offsetParent !== null).length;
      if (count >= expectedMin) return true;
      await new Promise(resolve => window.setTimeout(resolve, 35));
    }
    return false;
  }

  tryInterceptNativeProviderVisionSend(evt, originalButton) {
    if (this.nativeVisionAttachmentBridgeInFlight) {
      try { evt.preventDefault(); evt.stopPropagation(); evt.stopImmediatePropagation(); } catch (_) {}
      return true;
    }
    const candidate = this.getNativeProviderVisionCandidate();
    if (!candidate) return false;

    try { evt.preventDefault(); evt.stopPropagation(); evt.stopImmediatePropagation(); } catch (_) {}
    this.nativeVisionAttachmentBridgeInFlight = true;
    void this.prepareNativeProviderVisionAndResend(candidate, originalButton)
      .catch(err => {
        console.error("[LLM Hub Safe Guard] native provider Vision Bridge failed", err);
        new Notice(`LLM Hub Safe Guard：DeepSeek 图片桥接失败：${err?.message || err}`, 4500);
      })
      .finally(() => { this.nativeVisionAttachmentBridgeInFlight = false; });
    return true;
  }

  async prepareNativeProviderVisionAndResend(candidate, originalButton) {
    const input = this.getNativeVisionFileInput(candidate.composer);
    if (!input) throw new Error("未找到 LLM Hub 附件输入控件");
    if (typeof DataTransfer !== "function") throw new Error("当前 Obsidian WebView 不提供 DataTransfer API");

    const before = Array.from(document.querySelectorAll(".llm-hub-pending-attachment"))
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null).length;
    const { files, diagnostics } = await this.buildNativeVisionFiles(candidate);
    this.lastMarkdownVision = diagnostics;
    this.ensureAutoPanelControls();

    if (!files.length) {
      if (diagnostics.existingAttached > 0 && !diagnostics.missing.length && !diagnostics.tooLarge.length && !diagnostics.unsupported.length) {
        diagnostics.attached = diagnostics.existingAttached;
        diagnostics.channel = "native-attachment-existing";
        this.lastMarkdownVision = diagnostics;
        this.visionPendingConfirmed = true;
        this.visionLastInputMode = candidate.inputMode || "text-reference";
        this.nativeVisionResendBypassUntil = Date.now() + 1500;
        await new Promise(resolve => window.setTimeout(resolve, 0));
        const button = originalButton instanceof HTMLButtonElement
          ? originalButton
          : Array.from(document.querySelectorAll(".llm-hub-send-btn"))
              .filter(el => el instanceof HTMLButtonElement && el.offsetParent !== null && !el.disabled)
              .slice(-1)[0];
        if (button && !button.disabled) button.click();
        return;
      }
      if (diagnostics.missing.length) new Notice(`LLM Hub Safe Guard：有 ${diagnostics.missing.length} 个图片路径无法解析；本次未自动附加。`, 4500);
      else if (diagnostics.tooLarge.length) new Notice(`LLM Hub Safe Guard：图片超过 ${this.settings.markdownVisionMaxImageMB || 16} MB；本次未自动附加。`, 4500);
      else if (diagnostics.unsupported.length) new Notice("LLM Hub Safe Guard：图片格式不受支持；本次未自动附加。", 4500);
      else new Notice("LLM Hub Safe Guard：未能生成可发送的图片附件。", 3500);
      return;
    }

    const dt = new DataTransfer();
    for (const file of files) dt.items.add(file);
    try {
      input.files = dt.files;
    } catch (_) {
      try { Object.defineProperty(input, "files", { configurable: true, value: dt.files }); } catch (err) { throw new Error(`无法写入附件选择：${err?.message || err}`); }
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const ready = await this.waitForPendingAttachmentCount(before + files.length);
    if (!ready) throw new Error("LLM Hub 未在超时前确认图片附件");

    diagnostics.attached = files.length + Number(diagnostics.existingAttached || 0);
    diagnostics.at = Date.now();
    this.lastMarkdownVision = diagnostics;
    this.visionPendingConfirmed = true;
    this.visionLastInputMode = candidate.inputMode || "text-reference";
    this.markdownVisionNoticeKey = `native-attachment|${diagnostics.refs}|${diagnostics.attached}|${diagnostics.sourcePaths.join("|")}`;
    new Notice(`LLM Hub Safe Guard：图片 ${diagnostics.attached}/${diagnostics.refs} 已转为原生视觉附件，正在发送。`, 2200);
    this.ensureAutoPanelControls();

    // Prevent the v0.6.0 fetch fallback from adding a duplicate if this particular
    // OpenAI SDK build happens to consult globalThis.fetch after all.
    this.nativeVisionFetchBypassUntil = Date.now() + 15000;
    this.nativeVisionResendBypassUntil = Date.now() + 1500;
    await new Promise(resolve => window.setTimeout(resolve, 0));

    const button = originalButton instanceof HTMLButtonElement
      ? originalButton
      : Array.from(document.querySelectorAll(".llm-hub-send-btn"))
          .filter(el => el instanceof HTMLButtonElement && el.offsetParent !== null && !el.disabled)
          .slice(-1)[0];
    if (!button || button.disabled) throw new Error("图片已附加，但未找到可用的发送按钮；请手动点击发送一次");
    button.click();
  }


  getActiveLlmHubComposer() {
    const composers = Array.from(document.querySelectorAll(".llm-hub-composer"))
      .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
    return composers[composers.length - 1] || null;
  }

  rememberVisionPreviewFile(file, mode = "manual-attachment") {
    if (!file || !/^image\/(?:png|jpeg|gif|webp)$/i.test(String(file.type || ""))) return;
    const key = String(file.name || "image").toLowerCase();
    try {
      const url = URL.createObjectURL(file);
      const old = this.visionPreviewByName.get(key);
      if (old?.objectUrl && old.url) { try { URL.revokeObjectURL(old.url); } catch (_) {} }
      this.visionPreviewByName.set(key, { url, objectUrl: true, mime: file.type, at: Date.now(), mode });
      this.visionPreviewObjectUrls.add(url);
    } catch (_) {}
  }

  handleVisionAttachmentInputChange(evt) {
    if (this.settings.markdownVisionEnabled === false) return;
    const input = evt.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
    if (!input.closest(".llm-hub-chat-view, .llm-hub-tab-panel, .llm-hub-chat-container")) return;
    const files = Array.from(input.files || []).filter(file => /^image\/(?:png|jpeg|gif|webp)$/i.test(String(file.type || "")));
    if (!files.length) return;
    const mode = this.nativeVisionAttachmentBridgeInFlight ? "auto-reference" : "manual-attachment";
    for (const file of files) this.rememberVisionPreviewFile(file, mode);
    if (!this.nativeVisionAttachmentBridgeInFlight) {
      this.visionLastInputMode = mode;
      this.visionPendingConfirmed = true;
      this.lastMarkdownVision = {
        refs: 0, resolved: files.length, attached: files.length,
        missing: [], unsupported: [], tooLarge: [], sourcePaths: [],
        channel: "manual-attachment", inputMode: mode, at: Date.now(), directProvider: false
      };
      this.ensureAutoPanelControls();
    }
    window.setTimeout(() => this.applyVisionAttachmentPreviews(), 50);
  }

  async handleVisionPaste(evt) {
    if (this.settings.markdownVisionEnabled === false) return;
    const target = evt.target instanceof Element ? evt.target : null;
    const composer = target?.closest?.(".llm-hub-composer");
    if (!composer) return;
    const clipboard = evt.clipboardData;
    if (!clipboard) return;
    const files = Array.from(clipboard.files || []).filter(file => /^image\/(?:png|jpeg|gif|webp)$/i.test(String(file.type || "")));
    if (!files.length) return;
    const input = this.getNativeVisionFileInput(composer);
    if (!input || typeof DataTransfer !== "function") {
      new Notice("LLM Hub Safe Guard：检测到剪贴板图片，但未找到 LLM Hub 附件输入控件。", 3500);
      return;
    }
    evt.preventDefault();
    evt.stopPropagation();
    const dt = new DataTransfer();
    for (const file of files) {
      dt.items.add(file);
      this.rememberVisionPreviewFile(file, "clipboard");
    }
    try { input.files = dt.files; }
    catch (_) { try { Object.defineProperty(input, "files", { configurable: true, value: dt.files }); } catch (_) {} }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    this.visionLastInputMode = "clipboard";
    this.visionPendingConfirmed = true;
    this.lastMarkdownVision = {
      refs: 0, resolved: files.length, attached: files.length,
      missing: [], unsupported: [], tooLarge: [], sourcePaths: [],
      channel: "clipboard-attachment", inputMode: "clipboard", at: Date.now(), directProvider: false
    };
    this.ensureAutoPanelControls();
    new Notice(`LLM Hub Safe Guard：已把剪贴板中的 ${files.length} 张图片加入视觉附件。`, 1800);
  }

  findVaultImageByName(name) {
    const lower = String(name || "").toLowerCase();
    if (!lower) return null;
    try {
      const matches = this.app.vault.getFiles().filter(file => String(file.name || "").toLowerCase() === lower && SUPPORTED_VISION_EXTENSIONS.has(String(file.extension || "").toLowerCase()));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return matches[0];
    } catch (_) {}
    return null;
  }

  getVisionPreviewUrlForName(name) {
    const key = String(name || "").trim().toLowerCase();
    if (!key) return "";
    const remembered = this.visionPreviewByName.get(key);
    if (remembered?.url) return remembered.url;
    const file = this.findVaultImageByName(name);
    if (file) {
      try {
        const url = this.app.vault.getResourcePath?.(file) || "";
        if (url) {
          this.visionPreviewByName.set(key, { url, vaultPath: file.path, at: Date.now() });
          return url;
        }
      } catch (_) {}
    }
    return "";
  }

  applyVisionAttachmentPreviews() {
    if (this.settings.markdownVisionRenderChatImages === false) return;
    let rendered = 0;
    const users = Array.from(document.querySelectorAll(".llm-hub-message-user"));
    for (const user of users) {
      if (!(user instanceof HTMLElement)) continue;
      const attachments = Array.from(user.querySelectorAll(".llm-hub-attachment"));
      if (!attachments.length) continue;
      // A Markdown/HTML reference may already be rendered by Obsidian. Don't
      // duplicate it merely because Safe Guard also attached the same pixels.
      const existingContentImage = Array.from(user.querySelectorAll("img"))
        .some(img => !img.classList.contains("llm-hub-safe-guard-chat-image-preview"));
      for (const attachment of attachments) {
        if (!(attachment instanceof HTMLElement)) continue;
        const text = String(attachment.textContent || "").trim();
        const nameMatch = text.match(/([^\\/\n]+\.(?:png|jpe?g|gif|webp))\b/i);
        if (!nameMatch) continue;
        const fileName = nameMatch[1];
        const token = fileName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
        if (user.querySelector(`.llm-hub-safe-guard-chat-image-preview[data-sg-image-key="${CSS.escape(token)}"]`)) continue;
        if (existingContentImage) continue;
        const url = this.getVisionPreviewUrlForName(fileName);
        if (!url) continue;
        const wrap = document.createElement("div");
        wrap.className = "llm-hub-safe-guard-chat-image-preview-wrap";
        const img = document.createElement("img");
        img.className = "llm-hub-safe-guard-chat-image-preview";
        img.setAttribute("data-sg-image-key", token);
        img.src = url;
        img.alt = fileName;
        img.title = fileName;
        wrap.appendChild(img);
        const group = attachment.closest(".llm-hub-attachments") || attachment.parentElement;
        if (group?.parentElement) group.parentElement.insertBefore(wrap, group);
        else user.appendChild(wrap);
        rendered += 1;
      }
    }
    if (rendered > 0) this.visionPreviewRenderedCount += rendered;

    // Pending attachment chips get a compact thumbnail as well, so clipboard
    // paste / file picker gives visible confirmation before Send.
    const pending = Array.from(document.querySelectorAll(".llm-hub-pending-attachment"));
    for (const chip of pending) {
      if (!(chip instanceof HTMLElement) || chip.querySelector(".llm-hub-safe-guard-pending-thumb")) continue;
      const text = String(chip.textContent || "").trim();
      const match = text.match(/([^\\/\n]+\.(?:png|jpe?g|gif|webp))\b/i);
      if (!match) continue;
      const url = this.getVisionPreviewUrlForName(match[1]);
      if (!url) continue;
      const img = document.createElement("img");
      img.className = "llm-hub-safe-guard-pending-thumb";
      img.src = url;
      img.alt = match[1];
      chip.prepend(img);
    }
  }

  isDirectVisionProviderRequest(url, payload) {
    if (!payload || !Array.isArray(payload.messages)) return false;
    const urlText = String(url || "");
    if (/127\.0\.0\.1:(?:11434|11435)\b|localhost:(?:11434|11435)\b/i.test(urlText)) return false;
    const model = String(payload.model || "");
    if (/deepseek[-_]?flash|vision/i.test(model)) return true;

    const hub = this.getLlmHubPlugin();
    const providers = Array.isArray(hub?.settings?.apiProviders) ? hub.settings.apiProviders : [];
    for (const provider of providers) {
      if (!provider?.enabled) continue;
      const base = String(provider.baseUrl || "").replace(/\/+$/, "");
      const models = Array.isArray(provider.enabledModels) ? provider.enabledModels.map(String) : [];
      if (base && urlText.startsWith(base) && models.includes(model)) {
        const hay = `${provider.name || ""} ${provider.type || ""} ${base} ${model}`;
        if (/deepseek[-_]?flash|vision/i.test(hay)) return true;
      }
    }
    return false;
  }

  async transformDirectProviderFetch(input, init) {
    if (Date.now() < Number(this.nativeVisionFetchBypassUntil || 0)) return null;
    let url = "";
    try { url = typeof input === "string" ? input : (input?.url || String(input || "")); } catch (_) { return null; }
    if (!/\/chat\/completions(?:\?|$)/i.test(url)) return null;

    let bodyText = "";
    let fromRequest = false;
    if (typeof init?.body === "string") bodyText = init.body;
    else if (typeof Buffer !== "undefined" && Buffer.isBuffer(init?.body)) bodyText = init.body.toString("utf8");
    else if (typeof Request !== "undefined" && input instanceof Request) {
      try { bodyText = await input.clone().text(); fromRequest = true; } catch (_) { return null; }
    }
    if (!bodyText) return null;

    let payload;
    try { payload = JSON.parse(bodyText); } catch (_) { return null; }
    if (!this.isDirectVisionProviderRequest(url, payload)) return null;
    const refCount = payload.messages.reduce((n, msg) => n + (msg?.role === "user" ? extractAllVisionRefs(getMessageTextForVision(msg), this.settings.markdownVisionRecognizeBarePaths !== false).length : 0), 0);
    if (!refCount) return null;

    const result = await this.applyMarkdownVisionBridge(payload, { channel: "direct-provider" });
    if (!result.attached) return null;
    const newBody = JSON.stringify(payload);

    if (fromRequest && typeof Request !== "undefined" && input instanceof Request) {
      try {
        const headers = new Headers(input.headers);
        headers.delete("content-length");
        return { input: new Request(input, { body: newBody, headers }), init: undefined };
      } catch (_) {}
    }
    const nextInit = Object.assign({}, init || {}, { body: newBody });
    if (nextInit.headers && typeof Headers !== "undefined") {
      const headers = new Headers(nextInit.headers);
      headers.delete("content-length");
      nextInit.headers = headers;
    }
    return { input, init: nextInit };
  }

  installDirectProviderVisionHook() {
    if (this.directProviderVisionHookInstalled || this.settings.markdownVisionDirectProviderHook === false) return;
    if (typeof globalThis.fetch !== "function") return;
    const original = globalThis.fetch;
    const plugin = this;
    const wrapper = async function(input, init) {
      try {
        if (plugin.settings.markdownVisionEnabled !== false && plugin.settings.markdownVisionDirectProviderHook !== false) {
          const transformed = await plugin.transformDirectProviderFetch(input, init);
          if (transformed) return await original.call(this, transformed.input, transformed.init);
        }
      } catch (err) {
        console.error("[LLM Hub Safe Guard] direct-provider Vision Bridge failed", err);
        new Notice(`LLM Hub Safe Guard：手工 API Provider 图片桥接失败：${err?.message || err}`, 4200);
      }
      return await original.call(this, input, init);
    };
    this.originalGlobalFetch = original;
    this.directProviderFetchWrapper = wrapper;
    globalThis.fetch = wrapper;
    this.directProviderVisionHookInstalled = true;
  }

  uninstallDirectProviderVisionHook() {
    if (this.directProviderVisionHookInstalled && this.directProviderFetchWrapper && globalThis.fetch === this.directProviderFetchWrapper && this.originalGlobalFetch) {
      globalThis.fetch = this.originalGlobalFetch;
    }
    this.directProviderVisionHookInstalled = false;
    this.directProviderFetchWrapper = null;
    this.originalGlobalFetch = null;
  }

  decisionKey(metrics) {
    return `${metrics.model}|${simpleFingerprint(metrics.latestUserText)}|${metrics.messageCount}|${metrics.textChars}|${metrics.actualImages}`;
  }

  getRecentRouteDecision(metrics) {
    if (metrics.lastMessageRole !== "user") return null;
    const now = Date.now();
    for (const [key, entry] of this.recentRouteDecisions.entries()) {
      if (!entry || entry.expiresAt <= now) this.recentRouteDecisions.delete(key);
    }
    return this.recentRouteDecisions.get(this.decisionKey(metrics))?.action || null;
  }

  rememberRouteDecision(metrics, action) {
    if (metrics.lastMessageRole !== "user") return;
    this.recentRouteDecisions.set(this.decisionKey(metrics), {
      action,
      expiresAt: Date.now() + 15000
    });
  }

  shouldEnforceProxyReadOnly() {
    return this.settings.defaultReadOnlyEnabled
      && this.settings.enforceProxyReadOnly
      && !this.sessionWriteUnlocked;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getConfigurationRuntimeStatus() {
    const address = this.server?.listening ? this.server.address() : null;
    return { runtime: address && typeof address === "object" ? "listening" : "stopped",
      host: address && typeof address === "object" ? address.address : null,
      port: address && typeof address === "object" ? address.port : null,
      activeRequests: this.configurationActiveRequests || 0, reloading: this.configurationReloading,
      readOnlyEnforced: this.shouldEnforceProxyReadOnly() };
  }

  async reloadConfigurationProxy() {
    if (this.configurationActiveRequests || this.configurationReloading || this.proxyStartPromise || this.disposed || this.isUnloading)
      return { applied: false, reason: "busy" };
    this.configurationReloading = true;
    try {
      this.server?.closeIdleConnections?.();
      await this.restartProxy();
      const state = this.getConfigurationRuntimeStatus();
      return { ...state, applied: state.runtime === "listening" && state.host === this.settings.listenHost && state.port === this.settings.listenPort };
    } finally { this.configurationReloading = false; }
  }

  async restartProxy() {
    if (this.server) {
      const s = this.server;
      this.server = null;
      await new Promise(resolve => s.close(() => resolve())).catch(() => null);
    }
    await this.startProxy();
  }

  async startProxy() {
    if (this.server?.listening) return true;
    if (this.proxyStartPromise) return await this.proxyStartPromise;

    const start = async () => {
      const maxAttempts = 8;
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (this.isUnloading) return false;

        // A previous plugin instance can still be finishing server.close() while
        // Obsidian enables the replacement build. Always create a fresh server
        // for each listen attempt; a Node Server that emitted EADDRINUSE is not
        // reliable to reuse later.
        if (this.server) {
          try { this.server.close(); } catch (_) {}
          this.server = null;
        }

        const server = http.createServer((req, res) => {
          if (this.configurationReloading) { res.writeHead(503); res.end(); return; }
          this.configurationActiveRequests++;
          let counted = true;
          const finished = () => { if (counted) { counted = false; this.configurationActiveRequests--; } };
          res.once("finish", finished); res.once("close", finished);
          void this.handleRequest(req, res).catch(err => {
            console.error("[LLM Hub Safe Guard] proxy error", err);
            if (!res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: { message: `Safe Guard proxy error: ${err?.message || err}` } }));
            } else {
              try { res.destroy(err); } catch (_) {}
            }
          });
        });
        this.server = server;

        try {
          await new Promise((resolve, reject) => {
            const onError = (e) => {
              server.off("listening", onListen);
              reject(e);
            };
            const onListen = () => {
              server.off("error", onError);
              if (this.disposed || this.isUnloading) {
                server.close();
                if (this.server === server) this.server = null;
              }
              resolve();
            };
            server.once("error", onError);
            server.once("listening", onListen);
            server.listen(this.settings.listenPort, this.settings.listenHost);
          });

          if (this.disposed || this.isUnloading) return false;

          // Runtime errors after a successful listen should still be visible,
          // but they must not recursively trigger startup retries.
          server.on("error", (err) => {
            console.error("[LLM Hub Safe Guard] server runtime error", err);
          });
          console.log(`[LLM Hub Safe Guard] listening on http://${this.settings.listenHost}:${this.settings.listenPort}`);
          return true;
        } catch (err) {
          lastError = err;
          try { server.close(); } catch (_) {}
          if (this.server === server) this.server = null;

          const code = err?.code || "";
          // EADDRINUSE is commonly transient during plugin hot-upgrade because
          // the old instance is still closing 11435. Retry with a small backoff.
          if (code !== "EADDRINUSE" || attempt === maxAttempts) break;
          await new Promise(resolve => setTimeout(resolve, Math.min(1500, 200 + attempt * 200)));
        }
      }

      const message = lastError?.message || String(lastError || "unknown listen error");
      console.error("[LLM Hub Safe Guard] failed to start proxy", lastError);
      if (!this.isUnloading) {
        const diagnostic = { at: new Date().toISOString(), stage: "proxy-listen", code: String(lastError?.code || "UNKNOWN"), host: this.settings.listenHost, port: this.settings.listenPort };
        try {
          await this.app.vault.adapter.write(`${this.host.manifest.dir}/proxy-startup-error.json`, JSON.stringify(diagnostic, null, 2));
        } catch (error) {
          console.warn("[LLM Hub Safe Guard] cannot save startup diagnostic", error?.code || "UNKNOWN");
        }
        const hint = lastError?.code === "EADDRINUSE" ? "\n端口已被其他库或程序占用。请关闭不使用的测试库，或为同时使用的库配置不同的保护端口及对应代理地址。" : "";
        new Notice(`LLM Hub Safe Guard 无法监听 ${this.settings.listenHost}:${this.settings.listenPort}：${message}${hint}`, 10000);
      }
      return false;
    };

    this.proxyStartPromise = start().finally(() => { this.proxyStartPromise = null; });
    return await this.proxyStartPromise;
  }

  async readBody(req) {
    const maxBytes = Math.max(1, this.settings.maxRequestBodyMB) * 1024 * 1024;
    return await new Promise((resolve, reject) => {
      const chunks = []; let total = 0;
      req.on("data", chunk => {
        total += chunk.length;
        if (total > maxBytes) {
          reject(new Error(`Request body exceeds ${this.settings.maxRequestBodyMB} MB`));
          try { req.destroy(); } catch (_) {}
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  classify(metrics) {
    const s = this.settings;
    const contextWindow = Math.max(2048, Number(s.contextWindowTokens) || 16384);
    const totalWarnAt = Math.floor(contextWindow * (Number(s.warningTotalContextRatio) || 0.82));
    const totalBlockAt = Math.floor(contextWindow * (Number(s.blockTotalContextRatio) || 0.95));

    // v0.4: fixed system prompts + tool schemas no longer consume the ordinary
    // user-facing threshold. They still count toward the real context window
    // and trigger the ratio-based fallback near the model's hard capacity.
    const dynamicHard = metrics.conversationEstimatedTokens >= s.blockEstimatedTokens
      || metrics.maxDynamicMessageChars >= (Number(s.blockSingleMessageChars) || 18000);
    const dynamicWarn = metrics.conversationEstimatedTokens >= s.warningEstimatedTokens
      || metrics.maxDynamicMessageChars >= (Number(s.warningSingleMessageChars) || 9000);
    const totalHard = metrics.estimatedTokens >= totalBlockAt;
    const totalWarn = metrics.estimatedTokens >= totalWarnAt;
    const imageHard = metrics.actualImages >= s.blockActualImages;
    const imageWarn = metrics.actualImages >= s.warningActualImages;

    const hard = dynamicHard || totalHard || imageHard;
    const warn = dynamicWarn || totalWarn || imageWarn;
    return hard ? "block" : warn ? "warning" : "safe";
  }

  async guardChatPayload(buffer) {
    let payload;
    try { payload = JSON.parse(buffer.toString("utf8")); }
    catch { return { allowed: true, body: buffer, route: { type: "local" } }; }

    const contextState = this.getContextState();
    const quarantinedRemoved = this.settings.contextManagerEnabled ? this.applyCancellationQuarantine(payload, contextState) : 0;
    contextState.lastRawMessages = Array.isArray(payload.messages) ? cloneJson(payload.messages) : [];

    let removedWriteTools = [];
    if (this.shouldEnforceProxyReadOnly()) {
      const filtered = applyReadOnlyToolFilter(payload);
      removedWriteTools = filtered.removed;
      this.lastRemovedWriteTools = removedWriteTools;
    } else {
      this.lastRemovedWriteTools = [];
    }

    // v0.5.7: enforce rolling-memory trimming at the HTTP proxy boundary.
    // LLM Hub keeps maxPreviousMessages in React state, so changing only its
    // workspaceState can leave an already-mounted Chat sending the full history.
    // Once a compressed memory exists, remove older raw messages before both
    // resource classification and forwarding to the model.
    const domVisibleCount = this.settings.contextManagerEnabled ? this.getDomConversationMessages().length : null;
    const contextWindowResult = this.settings.contextManagerEnabled
      ? applyContextMemoryWindow(payload, contextState, this.settings.compressionKeepRecentMessages, domVisibleCount)
      : {
          applied: false,
          rawMessageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
          effectiveMessageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
          removed: 0,
          keepRecent: 0
        };
    contextState.lastContextWindowResult = contextWindowResult;

    // v0.5.10: guarantee that every routed model receives the same compressed
    // memory, even immediately after model/history switching. Do not duplicate it
    // if LLM Hub already folded the marker into its system prompt.
    if (this.settings.contextManagerEnabled) this.ensureContextMemoryPromptInPayload(payload, contextState);

    // v0.6: resolve Markdown/Wiki/HTML local image embeds into real multimodal
    // image_url parts before resource accounting and routing decisions.
    await this.applyMarkdownVisionBridge(payload, { channel: "proxy" });

    const metrics = extractRequestMetrics(payload);
    contextState.lastEffectiveMetrics = metrics;
    contextState.lastQuarantineRemoved = quarantinedRemoved;
    this.ensureAutoPanelControls();

    // A user-confirmed DeepSeek route can be pinned for the current continuous
    // conversation. While pinned, subsequent turns bypass repeated guard prompts
    // and go straight to the same provider until the user clicks × in the panel.
    if (this.settings.enabled && this.settings.routerEnabled && this.conversationPinnedRoute?.type === "advanced") {
      const currentAdvanced = this.getAdvancedRoute();
      if (currentAdvanced) {
        if (metrics.actualImages > 0 && !this.routeSupportsVision(currentAdvanced)) stripImagesForTextOnlyRoute(payload);
        payload.model = currentAdvanced.model;
        this.lastRouteLabel = `持续路由：${currentAdvanced.displayName}`;
        this.activateActualRouteUi(currentAdvanced);
        this.ensureAutoPanelControls();
        return { allowed: true, body: Buffer.from(JSON.stringify(payload), "utf8"), metrics, removedWriteTools, route: currentAdvanced };
      } else {
        this.clearConversationPinnedRoute(false);
      }
    }

    const sticky = this.getStickyRoute(metrics);
    if (sticky?.type === "advanced") {
      const currentAdvanced = this.getAdvancedRoute();
      if (currentAdvanced) {
        payload.model = currentAdvanced.model;
        this.lastRouteLabel = `工具续轮继续使用 ${currentAdvanced.displayName}`;
        this.activateActualRouteUi(currentAdvanced);
        return { allowed: true, body: Buffer.from(JSON.stringify(payload), "utf8"), metrics, removedWriteTools, route: currentAdvanced };
      }
    }
    if (sticky?.type === "vision") {
      payload.model = this.settings.visionModel;
      this.lastRouteLabel = `工具续轮继续使用视觉模型 ${this.settings.visionModel}`;
      this.activateActualRouteUi({ type: "vision", model: this.settings.visionModel });
      return { allowed: true, body: Buffer.from(JSON.stringify(payload), "utf8"), metrics, removedWriteTools, route: { type: "vision", model: this.settings.visionModel } };
    }

    if (!this.settings.enabled) {
      return { allowed: true, body: Buffer.from(JSON.stringify(payload), "utf8"), metrics, removedWriteTools, route: { type: "local" } };
    }

    const level = this.classify(metrics);
    // Resource fallback stays available even when AUTO is off. AUTO controls
    // proactive routing/pinning; the guard modal may still offer a one-shot
    // remote escape hatch when compressed local context remains too large.
    const advancedRoute = this.getAdvancedRoute(true);
    const visionModel = (this.settings.routerEnabled && this.settings.visionModel) ? this.settings.visionModel : null;

    // Low-risk real image requests can use the dedicated local vision model automatically.
    if (level === "safe" && this.settings.routerEnabled && this.settings.autoRouteImages
        && metrics.actualImages > 0 && visionModel && !isLikelyVisionModel(metrics.model)) {
      payload.model = visionModel;
      const route = { type: "vision", model: visionModel };
      this.rememberTurnRoute(metrics, route);
      this.noteRoute(`本次图片请求自动路由到 ${visionModel}`, route);
      return { allowed: true, body: Buffer.from(JSON.stringify(payload), "utf8"), metrics, removedWriteTools, route };
    }

    if (level === "safe") {
      this.lastRouteLabel = `本次使用当前本地模型 ${metrics.model}`;
      this.routeUiState = null;
      this.clearActualRouteChip();
      this.ensureAutoPanelControls();
      if (this.settings.showLowRiskNotices) new Notice(`Safe Guard：约 ${metrics.estimatedTokens} tokens，允许本地执行`);
      return { allowed: true, body: Buffer.from(JSON.stringify(payload), "utf8"), metrics, removedWriteTools, route: { type: "local" } };
    }

    const cachedAction = this.getRecentRouteDecision(metrics);
    if (cachedAction === "cancel") {
      return { allowed: false, body: Buffer.from(JSON.stringify(payload), "utf8"), metrics, removedWriteTools, route: { type: "cancel", repeated: true } };
    }
    if (cachedAction === "advanced" && advancedRoute) {
      if (metrics.actualImages > 0 && !this.routeSupportsVision(advancedRoute)) stripImagesForTextOnlyRoute(payload);
      payload.model = advancedRoute.model;
      this.rememberTurnRoute(metrics, advancedRoute);
      this.lastRouteLabel = `重试沿用高级路由 ${advancedRoute.displayName}`;
      this.activateActualRouteUi(advancedRoute);
      return { allowed: true, body: Buffer.from(JSON.stringify(payload), "utf8"), metrics, removedWriteTools, route: advancedRoute };
    }
    if (cachedAction === "vision" && visionModel) {
      payload.model = visionModel;
      const route = { type: "vision", model: visionModel };
      this.rememberTurnRoute(metrics, route);
      this.lastRouteLabel = `重试沿用视觉模型 ${visionModel}`;
      this.activateActualRouteUi(route);
      return { allowed: true, body: Buffer.from(JSON.stringify(payload), "utf8"), metrics, removedWriteTools, route };
    }
    if (cachedAction === "local") {
      this.lastRouteLabel = `重试沿用当前本地模型 ${metrics.model}`;
      return { allowed: true, body: Buffer.from(JSON.stringify(payload), "utf8"), metrics, removedWriteTools, route: { type: "local", repeated: true } };
    }

    const action = await new GuardDecisionModal(this.app, metrics, level, {
      advancedRoute,
      advancedVisionCapable: Boolean(advancedRoute && this.routeSupportsVision(advancedRoute)),
      visionModel: metrics.actualImages > 0 ? visionModel : null
    }).waitForDecision();
    this.rememberRouteDecision(metrics, action);

    if (action === "cancel") {
      if (this.settings.contextManagerEnabled) this.quarantineCancelledMessage(contextState, payload, metrics);
      return { allowed: false, body: Buffer.from(JSON.stringify(payload), "utf8"), metrics, removedWriteTools, route: { type: "cancel" } };
    }

    if (action === "advanced" && advancedRoute) {
      const advancedVisionCapable = this.routeSupportsVision(advancedRoute);
      const removedImages = metrics.actualImages > 0 && !advancedVisionCapable ? stripImagesForTextOnlyRoute(payload) : 0;
      payload.model = advancedRoute.model;
      this.rememberTurnRoute(metrics, advancedRoute);
      if (this.settings.routerEnabled) this.pinConversationRoute(advancedRoute);
      this.noteRoute(removedImages > 0
        ? `${this.settings.routerEnabled ? "当前连续对话已持续路由到" : "本次资源保护改用"} ${advancedRoute.displayName}（该模型不支持本轮图片，已省略 ${removedImages} 张）`
        : (this.settings.routerEnabled
          ? `当前连续对话已持续路由到 ${advancedRoute.displayName}${metrics.actualImages > 0 && advancedVisionCapable ? "（包含真实图片）" : ""}；后续发送不再重复确认`
          : `本次资源保护改用 ${advancedRoute.displayName}${metrics.actualImages > 0 && advancedVisionCapable ? "（包含真实图片）" : ""}；AUTO 当前关闭，因此不会建立持续路由`), advancedRoute);
      return { allowed: true, body: Buffer.from(JSON.stringify(payload), "utf8"), metrics, removedWriteTools, route: advancedRoute };
    }

    if (action === "vision" && visionModel) {
      payload.model = visionModel;
      const route = { type: "vision", model: visionModel };
      this.rememberTurnRoute(metrics, route);
      this.noteRoute(`本次请求路由到视觉模型 ${visionModel}`, route);
      return { allowed: true, body: Buffer.from(JSON.stringify(payload), "utf8"), metrics, removedWriteTools, route };
    }

    this.lastRouteLabel = `用户确认继续当前本地模型 ${metrics.model}`;
    this.routeUiState = null;
    this.clearActualRouteChip();
    return { allowed: true, body: Buffer.from(JSON.stringify(payload), "utf8"), metrics, removedWriteTools, route: { type: "local" } };
  }

  async handleRequest(req, res) {
    const base = new URL(this.settings.upstreamBaseUrl);
    const path = req.url || "/";

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        enabled: this.settings.enabled,
        upstream: this.settings.upstreamBaseUrl,
        version: this.manifest.version,
        llmHubVersion: this.getLlmHubVersion(),
        vaultDefaultReadOnly: this.settings.defaultReadOnlyEnabled,
        currentChatWriteUnlocked: this.sessionWriteUnlocked && !this.refreshVaultCapabilityRestriction().restricted,
        desiredVaultMode: this.sessionDesiredVaultMode,
        effectiveVaultMode: this.vaultCapabilityRestricted ? "none" : this.sessionDesiredVaultMode,
        vaultModeRestrictedByModel: this.vaultCapabilityRestricted,
        proxyReadOnlyEnforced: this.shouldEnforceProxyReadOnly(),
        uiBridgeStatus: this.uiBridgeStatus,
        lastRemovedWriteTools: this.lastRemovedWriteTools,
        routerEnabled: this.settings.routerEnabled,
        routerPanelControl: true,
        classificationMode: "dynamic-conversation-plus-context-window-fallback",
        contextWindowTokens: this.settings.contextWindowTokens,
        singleMessageWarningChars: this.settings.warningSingleMessageChars,
        conversationPinnedRoute: this.conversationPinnedRoute ? this.routeDisplayName(this.conversationPinnedRoute) : null,
        visionModel: this.settings.visionModel,
        markdownVisionEnabled: this.settings.markdownVisionEnabled !== false,
        markdownVisionDirectProviderHook: this.settings.markdownVisionDirectProviderHook !== false,
        markdownVisionDirectProviderHookInstalled: this.directProviderVisionHookInstalled,
        markdownVisionNativeAttachmentBridge: Boolean(this.nativeVisionAttachmentBridgeEnabled),
        markdownVisionNativeAttachmentBridgeInFlight: Boolean(this.nativeVisionAttachmentBridgeInFlight),
        markdownVisionInputMode: this.visionLastInputMode || this.lastMarkdownVision?.inputMode || "none",
        markdownVisionPendingConfirmed: Boolean(this.visionPendingConfirmed),
        markdownVisionPreviewRenderedCount: Number(this.visionPreviewRenderedCount || 0),
        markdownVisionRefs: Number(this.lastMarkdownVision?.refs || 0),
        markdownVisionResolved: Number(this.lastMarkdownVision?.resolved || 0),
        markdownVisionAttached: Number(this.lastMarkdownVision?.attached || 0),
        markdownVisionMissingCount: Array.isArray(this.lastMarkdownVision?.missing) ? this.lastMarkdownVision.missing.length : 0,
        markdownVisionMissing: Array.isArray(this.lastMarkdownVision?.missing) ? this.lastMarkdownVision.missing : [],
        markdownVisionUnsupportedCount: Array.isArray(this.lastMarkdownVision?.unsupported) ? this.lastMarkdownVision.unsupported.length : 0,
        markdownVisionTooLargeCount: Array.isArray(this.lastMarkdownVision?.tooLarge) ? this.lastMarkdownVision.tooLarge.length : 0,
        markdownVisionChannel: this.lastMarkdownVision?.channel || null,
        markdownVisionSourcePaths: Array.isArray(this.lastMarkdownVision?.sourcePaths) ? this.lastMarkdownVision.sourcePaths : [],
        advancedRouteAvailable: Boolean(this.getAdvancedRoute()),
        advancedRouteDisplay: this.getAdvancedRoute()?.displayName || null,
        advancedFallbackAvailable: Boolean(this.getAdvancedRoute(true)),
        advancedFallbackDisplay: this.getAdvancedRoute(true)?.displayName || null,
        lastRoute: this.lastRouteLabel || null,
        routeUiDisplay: this.routeUiState?.displayName || null,
        retryPromptSuppressionSeconds: 15,
        cancelStatusCode: 400,
        contextManagerEnabled: this.settings.contextManagerEnabled,
        contextHealth: this.getContextHealth(),
        compressionInProgress: this.compressionInProgress,
        compressionProgress: this.compressionProgress,
        contextMemoryActive: Boolean(this.getContextState().summary),
        contextMemoryTokens: estimateTokens(this.getContextState().summary || ""),
        contextWindowApplied: Boolean(this.getContextState().lastContextWindowResult?.applied),
        contextRawMessageCount: Number(this.getContextState().lastContextWindowResult?.rawMessageCount || 0),
        contextEffectiveMessageCount: Number(this.getContextState().lastContextWindowResult?.effectiveMessageCount || 0),
        contextWindowRemovedMessages: Number(this.getContextState().lastContextWindowResult?.removed || 0),
        contextSummaryCoveredMessages: Number(this.getContextState().summaryCoveredCount || 0),
        contextCompressionRetainedMessages: Number.isInteger(this.getContextState().keepRecentMessages) ? this.getContextState().keepRecentMessages : null,
        contextUnsummarizedTailMessages: Math.max(0, this.getDomConversationMessages().length - Number(this.getContextState().summaryCoveredCount || 0)),
        contextHealthHighWater: true,
        compressionEventCount: this.getCompressionEvents(this.getContextState()).length,
        lastCompressionEvent: this.getCompressionEvents(this.getContextState()).slice(-1)[0] || null,
        memoryLedgerCount: this.getMemoryLedger(this.getContextState()).length,
        contextMemoryPromptEnsured: Boolean(this.contextMemoryPromptEnsured),
        contextPersistenceSource: this.getContextState().persistenceSource || this.contextPersistenceSource || "none",
        contextSidecarPath: this.getContextSidecarPathForKey() || null,
        contextHistoryLoadPending: this.historyLoadPending,
        defaultCompressionModel: this.settings.defaultCompressionModel,
        currentHistoryLimit: this.getLlmHubPlugin()?.workspaceState?.maxPreviousMessages ?? null
      }));
      return;
    }

    let body = Buffer.alloc(0);
    const method = (req.method || "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(method)) body = await this.readBody(req);

    const isChat = /\/v1\/chat\/completions(?:\?|$)/.test(path) || /\/api\/chat(?:\?|$)/.test(path);
    if (isChat && this.compressionInProgress) {
      res.writeHead(423, { "Content-Type": "application/json; charset=utf-8", "X-LLM-Hub-Safe-Guard": "context-compressing" });
      res.end(JSON.stringify({ error: { message: "Context compression is in progress. Wait for LLM Hub Safe Guard to finish before sending." } }));
      return;
    }
    if (isChat && body.length > 0) {
      const guarded = await this.guardChatPayload(body);
      if (!guarded.allowed) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "X-LLM-Hub-Safe-Guard": "blocked" });
        res.end(JSON.stringify({ error: { message: "Request cancelled by LLM Hub Safe Guard before reaching Ollama." } }));
        return;
      }
      body = guarded.body;
      if (guarded.route?.type === "advanced") {
        await this.forwardAdvanced(req, res, guarded.route, body);
        return;
      }
    }

    await this.forward(req, res, base, path, body);
  }


  async forwardAdvanced(clientReq, clientRes, route, body) {
    const target = new URL(route.url);
    const transport = target.protocol === "https:" ? https : http;
    const headers = {
      "content-type": "application/json",
      "authorization": `Bearer ${route.apiKey}`,
      "accept": clientReq.headers.accept || "text/event-stream",
      "user-agent": "obsidian-llm-hub-safe-guard/0.5"
    };
    headers["content-length"] = String(body.length);

    await new Promise((resolve) => {
      let timedOut = false;
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(hardTimer); resolve(); } };
      const upstreamReq = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        method: "POST",
        path: `${target.pathname}${target.search}`,
        headers
      }, upstreamRes => {
        const responseHeaders = { ...upstreamRes.headers, "x-llm-hub-safe-guard-route": "advanced" };
        clientRes.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        upstreamRes.on("data", chunk => { if (!clientRes.destroyed) clientRes.write(chunk); });
        upstreamRes.on("end", () => { if (!clientRes.writableEnded) clientRes.end(); finish(); });
        upstreamRes.on("error", err => { if (!clientRes.destroyed) clientRes.destroy(err); finish(); });
      });

      const timeoutMs = Math.max(30, this.settings.hardTimeoutSeconds) * 1000;
      const hardTimer = setTimeout(() => {
        timedOut = true;
        upstreamReq.destroy(new Error(`Safe Guard advanced-route timeout after ${this.settings.hardTimeoutSeconds}s`));
        new Notice(`LLM Hub Safe Guard：高级模型请求超过 ${this.settings.hardTimeoutSeconds} 秒，已中止连接。`);
      }, timeoutMs);

      upstreamReq.on("error", err => {
        console.error("[LLM Hub Safe Guard] advanced route failed", err);
        if (!clientRes.headersSent) {
          clientRes.writeHead(timedOut ? 504 : 502, { "Content-Type": "application/json; charset=utf-8" });
          clientRes.end(JSON.stringify({ error: { message: `Safe Guard advanced route failed: ${err.message}` } }));
          finish();
        } else {
          try { clientRes.destroy(err); } catch (_) {}
          finish();
        }
      });

      clientRes.on("close", () => {
        if (!clientRes.writableEnded && !upstreamReq.destroyed) upstreamReq.destroy();
        if (!clientRes.writableEnded) finish();
      });

      upstreamReq.write(body);
      upstreamReq.end();
    });
  }

  async forward(clientReq, clientRes, base, path, body) {
    const transport = base.protocol === "https:" ? https : http;
    const headers = { ...clientReq.headers };
    headers.host = base.host;
    for (const h of ["connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade"]) delete headers[h];
    if (body.length > 0) headers["content-length"] = String(body.length);

    await new Promise((resolve, reject) => {
      let timedOut = false;
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(hardTimer); resolve(); } };
      const upstreamReq = transport.request({
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (base.protocol === "https:" ? 443 : 80),
        method: clientReq.method,
        path,
        headers
      }, upstreamRes => {
        clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.on("data", chunk => { if (!clientRes.destroyed) clientRes.write(chunk); });
        upstreamRes.on("end", () => { if (!clientRes.writableEnded) clientRes.end(); finish(); });
        upstreamRes.on("error", err => { if (!clientRes.destroyed) clientRes.destroy(err); finish(); });
      });

      const timeoutMs = Math.max(30, this.settings.hardTimeoutSeconds) * 1000;
      const hardTimer = setTimeout(() => {
        timedOut = true;
        upstreamReq.destroy(new Error(`Safe Guard hard timeout after ${this.settings.hardTimeoutSeconds}s`));
        new Notice(`LLM Hub Safe Guard：本地请求超过 ${this.settings.hardTimeoutSeconds} 秒，已中止连接。`);
      }, timeoutMs);

      upstreamReq.on("error", err => {
        if (!clientRes.headersSent) {
          clientRes.writeHead(timedOut ? 504 : 502, { "Content-Type": "application/json; charset=utf-8" });
          clientRes.end(JSON.stringify({ error: { message: err.message } }));
          finish();
        } else {
          try { clientRes.destroy(err); } catch (_) {}
          finish();
        }
      });

      clientRes.on("close", () => {
        if (!clientRes.writableEnded && !upstreamReq.destroyed) upstreamReq.destroy();
        if (!clientRes.writableEnded) finish();
      });

      if (body.length > 0) upstreamReq.write(body);
      upstreamReq.end();
    });
  }

  async onunload() {
    this.disposed = true;
    this.isUnloading = true;
    try { this.uninstallDirectProviderVisionHook(); } catch (_) {}
    try {
      for (const url of this.visionPreviewObjectUrls || []) { try { URL.revokeObjectURL(url); } catch (_) {} }
      this.visionPreviewObjectUrls?.clear?.();
    } catch (_) {}
    try { this.routeUiObserver?.disconnect(); } catch (_) {}
    this.routeUiObserver = null;
    try { this.setComposerLocked(false); } catch (_) {}
    try {
      const hub = this.getLlmHubPlugin();
      if (hub && this.baseLlmHubSystemPrompt !== null) hub.settings.systemPrompt = this.baseLlmHubSystemPrompt;
      if (hub?.workspaceState && this.baseHistoryLimit !== null) hub.workspaceState.maxPreviousMessages = this.baseHistoryLimit;
    } catch (_) {}
    if (this.server) {
      const s = this.server;
      this.server = null;
      await new Promise(resolve => s.close(() => resolve())).catch(() => null);
    }
  }
};
