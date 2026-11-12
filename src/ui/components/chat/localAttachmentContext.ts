import type { Attachment } from "src/types";

function decodeTextAttachment(attachment: Attachment): string | null {
  if (attachment.type !== "text") return null;
  let binary: string;
  try {
    binary = atob(attachment.data);
  } catch {
    return null;
  }
  try {
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Older attachments may have been saved as single-byte text.
    return binary;
  }
}

/** Local text chat gets decoded text, with names and types for unsupported binary files. */
export function buildLocalLlmAttachmentContext(attachments?: readonly Attachment[]): string {
  if (!attachments?.length) return "";
  const sections = attachments.map(attachment => {
    const header = `Attachment: ${attachment.name} (${attachment.mimeType || attachment.type})`;
    const decoded = decodeTextAttachment(attachment);
    if (decoded === null) {
      return `--- ${header} ---\nBinary attachment metadata only. The file contents are not directly available in Local LLM mode.\nType: ${attachment.type}\n--- End Attachment ---`;
    }
    const trimmed = decoded.trim();
    const content = trimmed.length > 12000 ? `${trimmed.slice(0, 12000)}\n[Truncated]` : trimmed;
    return `--- ${header} ---\n${content || "[Empty text attachment]"}\n--- End Attachment ---`;
  });
  return `\n\nAttached files:\n\n${sections.join("\n\n")}`;
}
