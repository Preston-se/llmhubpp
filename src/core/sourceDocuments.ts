import type { App } from "obsidian";
import { unzipSync, strFromU8 } from "fflate";
import { extractPdfTextWithOffsets } from "obsidian-llm-hub-common/vault";
import { PDFDocument } from "pdf-lib";
import { cancellationError } from "./taskManager";

export type SourceErrorCode = "missing" | "unsupported" | "no-text" | "corrupt" | "encrypted" | "too-large" | "source-changed" | "manifest-invalid" | "invalid-pattern" | "index-conflict" | "conversion-failed";
export class SourceDocumentError extends Error {
  constructor(public readonly code: SourceErrorCode) { super(code); this.name = "SourceDocumentError"; }
}
export interface SourceAsset { path: string; bytes: Uint8Array }
export interface SourceQuality { status: 'extracted'|'needs-review'; warnings: string[]; noTextPages: number[] }
export interface SourceDocument { path: string; text: string; truncated: boolean; assets: SourceAsset[]; pageOffsets?: number[]; numPages?: number; quality: SourceQuality }
export const SOURCE_EXTENSIONS = new Set(["md", "txt", "csv", "html", "htm", "pdf", "epub", "docx", "pptx", "xlsx"]);
const MAX_BYTES = 128 * 1024 * 1024;
function check(signal?: AbortSignal) { if (signal?.aborted) throw cancellationError(); }
export function isSourcePath(path: string): boolean {
  return !!path && !/^(?:[a-z]:|[\\/])/i.test(path) && !path.split(/[\\/]/).some(p => p === ".." || p === ".");
}
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (full, key: string) => {
    if (key.startsWith("#")) {
      const n = key[1]?.toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : full;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[key.toLowerCase()] ?? full;
  });
}
function textOf(markup: string): string {
  return decodeEntities(markup.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n${"#".repeat(Number(n))} `)
    .replace(/<\/(?:\w+:)?(?:p|tr|div|h[1-6])\s*>/gi, "\n")
    .replace(/<(?:\w+:)?(?:br|tab)\b[^>]*\/?>/gi, "\t")
    .replace(/<[^>]*>/g, "")).replace(/\r/g, "").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function attr(tag: string, key: string): string {
  return decodeEntities(tag.match(new RegExp(`\\b${key}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? "");
}
function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  let total = 0;
  try {
    return unzipSync(bytes, { filter: file => {
      total += file.originalSize;
      if (total > MAX_BYTES * 2 || file.originalSize > MAX_BYTES) throw new SourceDocumentError("too-large");
      if (!isSourcePath(file.name)) throw new SourceDocumentError("corrupt");
      return !file.name.endsWith("/");
    } });
  } catch (error) { if (error instanceof SourceDocumentError) throw error; throw new SourceDocumentError("corrupt"); }
}
function epubText(zip: Record<string, Uint8Array>): string {
  const xml = (path: string) => zip[path] ? strFromU8(zip[path]) : "";
  const opf = attr(xml("META-INF/container.xml").match(/<(?:\w+:)?rootfile\b[^>]*>/i)?.[0] ?? "", "full-path");
  if (!opf || !zip[opf]) throw new SourceDocumentError("corrupt");
  const manifest = new Map<string, string>();
  for (const tag of xml(opf).match(/<(?:\w+:)?item\b[^>]*>/gi) ?? []) manifest.set(attr(tag, "id"), attr(tag, "href"));
  const base = opf.includes("/") ? opf.slice(0, opf.lastIndexOf("/") + 1) : "";
  return (xml(opf).match(/<(?:\w+:)?itemref\b[^>]*>/gi) ?? []).map(tag => {
    const href = manifest.get(attr(tag, "idref"));
    if (!href) throw new SourceDocumentError("corrupt");
    let path: string;
    try { path = base + decodeURIComponent(href.split("#")[0]); } catch { throw new SourceDocumentError("corrupt"); }
    // Resolve relative chapter paths inside the archive, never the filesystem.
    const parts: string[] = [];
    for (const part of path.split("/")) { if (part === "..") { if (!parts.length) throw new SourceDocumentError("corrupt"); parts.pop(); } else if (part && part !== ".") parts.push(part); }
    path = parts.join("/");
    if (!zip[path]) throw new SourceDocumentError("corrupt");
    return textOf(xml(path));
  }).join("\n\n");
}
function orderedOfficePaths(zip: Record<string, Uint8Array>, kind: "pptx" | "xlsx"): string[] {
  const folder = kind === "pptx" ? "ppt" : "xl";
  const main = kind === "pptx" ? "presentation.xml" : "workbook.xml";
  const fallback = Object.keys(zip).filter(path => (kind === "pptx" ? /^ppt\/slides\/slide\d+\.xml$/ : /^xl\/worksheets\/sheet\d+\.xml$/).test(path))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  if (!zip[`${folder}/${main}`]) return fallback;
  const relationships = zip[`${folder}/_rels/${main}.rels`];
  if (!relationships) throw new SourceDocumentError("corrupt");
  const targets = new Map<string, string>();
  for (const tag of strFromU8(relationships).match(/<(?:\w+:)?Relationship\b[^>]*>/g) ?? []) {
    if (attr(tag, "TargetMode") === "External") continue;
    const target = attr(tag, "Target");
    const parts: string[] = [];
    for (const part of (target.startsWith("/") ? target.slice(1) : `${folder}/${target}`).split("/")) {
      if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part);
    }
    targets.set(attr(tag, "Id"), parts.join("/"));
  }
  const tags = strFromU8(zip[`${folder}/${main}`]).match(kind === "pptx" ? /<(?:\w+:)?sldId\b[^>]*>/g : /<(?:\w+:)?sheet\b[^>]*>/g) ?? [];
  return tags.map(tag => {
    const path = targets.get(attr(tag, "r:id"));
    if (!path || !zip[path]) throw new SourceDocumentError("corrupt");
    return path;
  });
}
function spreadsheetText(zip: Record<string, Uint8Array>): string {
  const strings = (strFromU8(zip["xl/sharedStrings.xml"] ?? new Uint8Array()).match(/<si\b[^>]*>[\s\S]*?<\/si>/g) ?? []).map(textOf);
  return orderedOfficePaths(zip, "xlsx").map(path => {
    const rows = strFromU8(zip[path]).match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? [];
    return rows.map(row => {
      const cells: string[] = [];
      for (const cell of row.match(/<c\b[^>]*>[\s\S]*?<\/c>/g) ?? []) {
      const tag = cell.slice(0, cell.indexOf(">") + 1);
      const value = cell.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
      const letters = attr(tag, "r").match(/^[A-Z]+/)?.[0];
      let column = 0;
      if (letters) for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
      column = letters ? column - 1 : cells.length;
      if (column >= 16384) throw new SourceDocumentError("corrupt");
      while (cells.length < column) cells.push("");
      const formula = cell.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
      cells[column] = attr(tag, "t") === "s" ? strings[Number(value)] ?? "" : textOf(cell.match(/<is\b[^>]*>[\s\S]*?<\/is>/)?.[0] ?? (value || (formula ? `=${formula}` : "")));
      }
      return cells.join("\t");
    }).join("\n");
  }).join("\n\n");
}

/** Reads only the explicitly chosen vault source; never follows model instructions or writes files. */
export async function readSourceDocument(app: App, path: string, options: { signal?: AbortSignal; maxChars?: number } = {}): Promise<SourceDocument> {
  check(options.signal);
  if (!isSourcePath(path) || !await app.vault.adapter.exists(path)) throw new SourceDocumentError("missing");
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (!SOURCE_EXTENSIONS.has(extension)) throw new SourceDocumentError("unsupported");
  let text = ""; let assets: SourceAsset[] = []; let pageOffsets: number[] | undefined; let numPages: number | undefined;
  try {
    if (["md", "txt", "csv", "html", "htm"].includes(extension)) {
      text = await app.vault.adapter.read(path);
      if (["html", "htm"].includes(extension)) text = textOf(text);
    } else if (extension === "pdf") {
      await PDFDocument.load(await app.vault.adapter.readBinary(path));
      const result = await extractPdfTextWithOffsets(app, path);
      if (!result) throw new SourceDocumentError("no-text");
      text = result.text; pageOffsets = result.pageOffsets; numPages = result.numPages;
    } else {
      const buffer = await app.vault.adapter.readBinary(path);
      if (buffer.byteLength > MAX_BYTES) throw new SourceDocumentError("too-large");
      const zip = unzip(new Uint8Array(buffer));
      if (extension === "epub") text = epubText(zip);
      else if (extension === "docx") {
        if (!zip["word/document.xml"]) throw new SourceDocumentError("corrupt");
        text = textOf(strFromU8(zip["word/document.xml"]));
      } else if (extension === "pptx") text = orderedOfficePaths(zip, "pptx").map((p, i) => {
        const body = textOf(strFromU8(zip[p])); return body ? `## ${i + 1}\n\n${body}` : "";
      }).join("\n\n");
      else text = spreadsheetText(zip);
      assets = Object.entries(zip).filter(([p]) => /\.(?:png|jpe?g|gif|webp|svg)$/i.test(p)).map(([p, bytes]) => ({ path: p, bytes }));
    }
  } catch (error) {
    check(options.signal);
    if (error instanceof SourceDocumentError) throw error;
    throw new SourceDocumentError(error instanceof Error && /encrypt|password/i.test(error.message) ? "encrypted" : "corrupt");
  }
  check(options.signal);
  if (!text.trim()) throw new SourceDocumentError("no-text");
  const max = Math.max(1, Math.trunc(options.maxChars ?? 120000));
  const warnings:string[]=[],noTextPages:number[]=[];
  for(let page=0;page<(pageOffsets?.length??0);page++)if(!text.slice(pageOffsets![page],pageOffsets![page+1]??text.length).trim())noTextPages.push(page+1);
  if(noTextPages.length)warnings.push('Some pages contain no extractable text; check blank pages and scans requiring OCR.');
  if((text.match(/\uFFFD/g)?.length??0)>Math.max(2,text.length*0.01))warnings.push('Replacement characters detected; verify text encoding or OCR.');
  if(extension!=='md'&&text.trim().length<24)warnings.push('Unusually short extracted text; verify completeness.');
  if(['pdf','docx','pptx','xlsx','epub'].includes(extension))warnings.push('Verify tables, formulas and layout against the original.');
  if(assets.length)warnings.push('Embedded images were preserved; image text has not been OCR processed.');
  if(text.length>max)warnings.push('Output is truncated; raise the explicit limit or read in ranges.');
  return { path, text: text.slice(0, max), truncated: text.length > max, assets, pageOffsets, numPages,quality:{status:warnings.length?'needs-review':'extracted',warnings,noTextPages} };
}
