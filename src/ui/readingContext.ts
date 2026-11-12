import type { App, Editor, EditorPosition, MarkdownView, Menu, TFile } from "obsidian";
import type { LocalRagSearchResult } from "src/core/localRagStore";
import { t } from "src/i18n";
import {resolveReadingMenu,type ReadingMenuPreferences} from './readingMenuPolicy';

/** An in-memory bookmark belongs to one open editor and one exact document version. */
export interface ReadingContext {
  filePath: string;
  selection: string;
  insertAt?: EditorPosition;
  documentText?: string;
  file?: TFile;
  editor?: Editor;
  view?: MarkdownView;
  sourceView?: { file?: TFile | null };
  scope?: "selection" | "document";
  truncated?: boolean;
  question?: string;
}

export function captureReadingContext(editor: Editor, view: MarkdownView): ReadingContext | null {
  if (!view.file || view.file.extension !== "md" || view.editor !== editor) return null;
  return { filePath: view.file.path, selection: editor.getSelection(), insertAt: { ...editor.getCursor("to") },
    documentText: editor.getValue(), file: view.file, editor, view };
}

export function registerReadingMenuItems(menu: Menu, editor: Editor, view: MarkdownView,
  actions: { search: (context: ReadingContext) => void; current: (context: ReadingContext) => void; knowledge: (context: ReadingContext) => void }, preferences?:ReadingMenuPreferences): void {
  const context = captureReadingContext(editor, view);
  if (!context) return;
  const items = [
    { id:'search',title: t("reading.search"), icon: "search", action: actions.search },
    { id:'current',title: t("reading.askCurrent"), icon: "message-square", action: actions.current },
    { id:'knowledge',title: t("reading.askKnowledge"), icon: "library", action: actions.knowledge },
  ];
  const visible=resolveReadingMenu('editor',items,preferences);if(!visible.length)return;
  let target=menu;if(preferences?.presentation==='submenu')menu.addItem(entry=>{entry.setTitle('Llmhub++');target=(entry as unknown as {setSubmenu?:()=>Menu}).setSubmenu?.()??menu;});
  for (const item of visible) target.addItem(entry => entry.setTitle(item.title).setIcon(item.icon).onClick(() => item.action(context)));
}

/** Never replace the selection or write into a different/stale editor buffer. */
export function insertReadingResults(app: App, context: ReadingContext, results: LocalRagSearchResult[]): "inserted" | "target-changed" | "unreadable" {
  if (!context.view || !context.editor || !context.file || !context.insertAt) return "target-changed";
  const open = app.workspace.getLeavesOfType("markdown").some(leaf => leaf.view === context.view);
  if (!open || context.view.editor !== context.editor || context.view.file !== context.file
    || context.view.file?.path !== context.filePath || app.vault.getAbstractFileByPath(context.filePath) !== context.file
    || context.editor.getValue() !== context.documentText) return "target-changed";
  if (!results.length || results.some(result => !result.text.trim() || /^\[(?:pdf|image|audio|video):[^\]]*\]$/i.test(result.text.trim()))) return "unreadable";
  const blocks = results.map(result => {
    const path = (result.originalFilePath ?? result.filePath).replace(/[\r\n]/g, " ");
    const link = path.includes("[") || path.includes("]") || path.includes("|") || /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path) ? path : `[[${path}]]`;
    const quote = result.text.split(/\r?\n/).map(line => `> ${line}`).join("\n");
    const availability = result.sourceStatus === "missing" ? ` (${t("reading.sourceMissing")})`
      : result.sourceStatus === "unknown" ? ` (${t("reading.sourceUnknown")})` : "";
    return `${quote}\n> — ${link}${result.pageLabel ? ` (${result.pageLabel.replace(/[\r\n]/g, " ")})` : ""}${availability}`;
  });
  context.editor.replaceRange(`\n\n${blocks.join("\n\n")}\n`, context.insertAt);
  return "inserted";
}
