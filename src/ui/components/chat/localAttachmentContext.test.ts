import { expect, it } from "vitest";
import { buildLocalLlmAttachmentContext } from "./localAttachmentContext";

it("includes text attachments as Unicode and omits the bytes of non-text attachments", () => {
  const result = buildLocalLlmAttachmentContext([
    { name: "课文.txt", mimeType: "text/plain", type: "text", data: Buffer.from("课文 café", "utf8").toString("base64") },
    { name: "reference.pdf", mimeType: "application/pdf", type: "pdf", data: "YnluYXJ5LWZpeHR1cmU=" },
  ]);
  expect(result).toContain("Attachment: 课文.txt (text/plain)");
  expect(result).toContain("课文 café");
  expect(result).toContain("Attachment: reference.pdf (application/pdf)");
  expect(result).toContain("Binary attachment metadata only.");
  expect(result).not.toContain("YnluYXJ5LWZpeHR1cmU=");
});
