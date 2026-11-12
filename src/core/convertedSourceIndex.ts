import { isSourcePath } from "./sourceDocuments";
export function readConvertedProvenance(filePath: string, text: string): { originalFilePath?: string; pageLabel?: string } {
  if (!filePath.includes("/_llmhub_generated/") || !/^---\r?\nllmhubpp_source: true\r?\n/.test(text)) return {};
  try {
    const original = JSON.parse(text.match(/^source_path: (.+)$/m)?.[1] ?? "null") as unknown;
    const page = JSON.parse(text.match(/^source_page: (.+)$/m)?.[1] ?? "null") as unknown;
    return typeof original === "string" && isSourcePath(original)
      ? { originalFilePath: original, ...(typeof page === "string" ? { pageLabel: page } : {}) } : {};
  } catch { return {}; }
}
