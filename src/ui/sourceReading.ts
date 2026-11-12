import { FuzzySuggestModal, MarkdownView, Menu, TFile, type App, type Plugin } from "obsidian";
import { captureReadingContext, type ReadingContext } from "./readingContext";
import { readSourceDocument, SourceDocumentError, SOURCE_EXTENSIONS } from "src/core/sourceDocuments";
import { t } from "src/i18n";
import {resolveReadingMenu,type ReadingMenuContext,type ReadingMenuPreferences} from './readingMenuPolicy';

export type ReadingAction = "search" | "current" | "knowledge" | "explain" | "example" | "compare" | "quiz";
interface SourceView { file?: TFile | null; containerEl: HTMLElement }
export function captureSourceReadingContext(view: SourceView): ReadingContext | null {
  const file = view.file;
  if (!file || !SOURCE_EXTENSIONS.has(file.extension.toLowerCase())) return null;
  let selection = "";
  const readSelection = (document: Document, boundary: HTMLElement) => {
    const value = document.getSelection();
    if (value?.anchorNode && value.focusNode && boundary.contains(value.anchorNode) && boundary.contains(value.focusNode)) selection = value.toString();
  };
  readSelection(view.containerEl.ownerDocument, view.containerEl);
  // Some EPUB readers render in same-origin iframes. Cross-origin frames are left to the command/paste fallback.
  for (const frame of Array.from(view.containerEl.querySelectorAll("iframe"))) {
    try { if (frame.contentDocument?.body) readSelection(frame.contentDocument, frame.contentDocument.body); } catch { /* isolated reader */ }
  }
  return { filePath: file.path, selection, file, sourceView: view, scope: "selection" };
}

export async function prepareSourceReading(app: App, context: ReadingContext, action: ReadingAction): Promise<ReadingContext> {
  const validate = () => {
    if ((context.sourceView && context.sourceView.file?.path !== context.filePath)
      || (context.file && context.file.path !== context.filePath)
      || (context.editor && context.editor.getValue() !== context.documentText)) throw new SourceDocumentError("source-changed");
  };
  validate();
  if (action === "search" || action === "knowledge" || context.selection.trim()) return context;
  const result = context.documentText !== undefined
    ? { text: context.documentText.slice(0, 60000), truncated: context.documentText.length > 60000 }
    : await readSourceDocument(app, context.filePath, { maxChars: 60000 });
  validate();
  if (!result.text.trim()) throw new SourceDocumentError("no-text");
  return { ...context, selection: result.text, scope: "document", truncated: result.truncated };
}

export function addSourceReadingMenu(menu: Menu, context: ReadingContext, run: (context: ReadingContext, action: ReadingAction) => void, preferences?:ReadingMenuPreferences,scene?:ReadingMenuContext): number {
  const items = [
    ["reading.search", "search", "search"], ["reading.askCurrent", "message-square", "current"],
    ["reading.askKnowledge", "library", "knowledge"], ["reading.explain", "book-open", "explain"],
    ["reading.example", "lightbulb", "example"], ["reading.compare", "columns-2", "compare"], ["reading.quiz", "list-checks", "quiz"],
  ] as const;
  const visible=resolveReadingMenu(scene??(context.file?.extension==='pdf'?'pdf':context.file?.extension==='epub'?'epub':'preview'),items.map(([label,icon,action])=>({id:action,title:t(label),icon,action})),preferences);
  if(!visible.length)return 0;let target=menu;if(preferences?.presentation==='submenu')menu.addItem(entry=>{entry.setTitle('Llmhub++');target=(entry as unknown as {setSubmenu?:()=>Menu}).setSubmenu?.()??menu;});
  for(const item of visible)target.addItem(entry=>entry.setTitle(item.title).setIcon(item.icon).onClick(()=>run(context,item.action)));
  return visible.length;
}

class ReadingTargetModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly picked: (context: ReadingContext) => void) { super(app); this.setPlaceholder(t("reading.chooseTarget")); }
  getItems(): TFile[] { return this.app.vault.getMarkdownFiles(); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void {
    void (async () => {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
      if (!(leaf.view instanceof MarkdownView)) return;
      const context = captureReadingContext(leaf.view.editor, leaf.view);
      if (context) this.picked(context);
    })();
  }
}
export function chooseReadingTarget(app: App, picked: (context: ReadingContext) => void): void { new ReadingTargetModal(app, picked).open(); }

/** Document events cover the built-in PDF reader, Markdown preview and same-origin reader frames. */
export function installSourceReading(plugin: Plugin, run: (context: ReadingContext, action: ReadingAction) => void, preferences?:()=>ReadingMenuPreferences|undefined): void {
  const { workspace } = plugin.app;
  const bound = new WeakSet<Document>();
  const show = (event: MouseEvent, view: SourceView) => {
    if (view instanceof MarkdownView && view.getMode() !== "preview") return;
    const context = captureSourceReadingContext(view);
    if (!context) return;
    const menu = new Menu();if(!addSourceReadingMenu(menu, context, run,preferences?.()))return;
    event.preventDefault(); event.stopPropagation();menu.showAtMouseEvent(event);
  };
  plugin.registerDomEvent(document, "contextmenu", event => {
    workspace.iterateAllLeaves(leaf => {
      const view = leaf.view as unknown as SourceView;
      if (view.file && event.target instanceof Node && view.containerEl.contains(event.target)) show(event, view);
    });
  });
  const bindFrames = () => workspace.iterateAllLeaves(leaf => {
    const view = leaf.view as unknown as SourceView;
    if (!view.file || !SOURCE_EXTENSIONS.has(view.file.extension)) return;
    for (const frame of Array.from(view.containerEl.querySelectorAll("iframe"))) {
      const bind = () => {
        try {
          const doc = frame.contentDocument;
          if (doc && !bound.has(doc)) { bound.add(doc); plugin.registerDomEvent(doc, "contextmenu", event => show(event, view)); }
        } catch { /* Other-origin readers retain the commands below. */ }
      };
      bind(); plugin.registerDomEvent(frame, "load", bind, { once: true });
    }
  });
  plugin.registerEvent(workspace.on("active-leaf-change", bindFrames));
  plugin.registerEvent(workspace.on("file-menu", (menu, file) => {
    if (file instanceof TFile && SOURCE_EXTENSIONS.has(file.extension)) addSourceReadingMenu(menu, { filePath: file.path, selection: "", file }, run,preferences?.(),'file');
  }));
  for (const [id, label, action] of [["reading-search", "reading.search", "search"], ["reading-current", "reading.askCurrent", "current"],
    ["reading-knowledge", "reading.askKnowledge", "knowledge"], ["reading-explain", "reading.explain", "explain"],
    ["reading-example", "reading.example", "example"], ["reading-compare", "reading.compare", "compare"], ["reading-quiz", "reading.quiz", "quiz"]] as const) {
    plugin.addCommand({ id, name: t(label), checkCallback: checking => {
      const view = workspace.getMostRecentLeaf()?.view as unknown as SourceView | undefined;
      const context = view?.file ? captureSourceReadingContext(view) : null;
      if (!context) return false;
      if (!checking) run(context, action);
      return true;
    } });
  }
  bindFrames();
}

export function sourceErrorText(error: unknown): string {
  if (!(error instanceof SourceDocumentError)) return t("reading.sourceError");
  const keys = { missing: "reading.sourceMissing", unsupported: "reading.formatUnsupported", "no-text": "reading.noText",
    corrupt: "reading.corrupt", encrypted: "reading.encrypted", "too-large": "reading.tooLarge", "source-changed": "reading.sourceChanged",
    "manifest-invalid": "reading.manifestInvalid", "invalid-pattern": "reading.patternInvalid", "index-conflict": "reading.indexConflict", "conversion-failed": "reading.conversionFailed" } as const;
  return t(keys[error.code]);
}
