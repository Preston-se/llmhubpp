import { isSourcePath, SOURCE_EXTENSIONS } from "./sourceDocuments";
export interface SourceWatchPolicy {
  enabled: boolean;
  mode: "include" | "exclude";
  folderPatterns: string[];
  indexName: string;
  attachmentFolder: string;
  maxMarkdownChars: number;
}
export const DEFAULT_SOURCE_WATCH: SourceWatchPolicy = {
  enabled: false, mode: "include", folderPatterns: [".*"], indexName: "Converted-Sources", attachmentFolder: "", maxMarkdownChars: 120000,
};
export const GENERATED_FOLDER = "_llmhub_generated";
export function validateSourcePatterns(policy: SourceWatchPolicy): RegExp[] {
  return policy.folderPatterns.filter(value => value.trim()).map(value => new RegExp(value));
}
export function matchSourceDirectory(path: string, policy: SourceWatchPolicy, workspace: string, configDir?: string, managedDirectories: readonly string[] = []): boolean {
  const patterns = validateSourcePatterns(policy);
  if (!isSourcePath(path) || !SOURCE_EXTENSIONS.has(path.split(".").pop()?.toLowerCase() ?? "")) return false;
  const parts = path.split("/");
  if (parts.some(part => part === GENERATED_FOLDER || part.startsWith(".") || /(?:\.tmp|\.part|~)$/.test(part))
    || [workspace, configDir, ...managedDirectories, ".llm-hub"].some(directory => {
      const normalized = directory?.replace(/\\/g, "/").replace(/\/+$/, "");
      return !!normalized && (path === normalized || path.startsWith(normalized + "/"));
    })) return false;
  const folder = parts.slice(0, -1).join("/");
  const matches = patterns.some(pattern => pattern.test(folder));
  return policy.mode === "include" ? matches : !matches;
}
