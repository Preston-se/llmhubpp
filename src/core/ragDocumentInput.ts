import { TFile, type App } from 'obsidian';
import { PDFDocument } from 'pdf-lib';
import { computePdfPageLabel } from 'obsidian-llm-hub-common/vault';
import type { RagSetting } from 'src/types';
import { DEFAULT_GEMINI_EMBEDDING_MODEL } from 'src/types';
import { chunkTextWithOffsets, isGeminiMultimodalEmbeddingModel } from './localRagStore';
import { readSourceDocument, type SourceQuality } from './sourceDocuments';
import { extensionToMimeType, MULTIMODAL_EXTENSIONS, MULTIMODAL_FILE_SIZE_LIMITS } from './embeddingProvider';
import { ragDigest } from './localRagStorage';
import type { WorkControl } from './taskManager';
import type { DocumentChunk } from './ragDocumentStore';
import { readConvertedProvenance } from './convertedSourceIndex';

export type RagEmbeddingInput = string | { mimeType: string; data: string };
export function supportsLifecycleFile(file: TFile, setting: RagSetting): boolean {
  const native = !setting.embeddingBaseUrl && isGeminiMultimodalEmbeddingModel(setting.embeddingModel || DEFAULT_GEMINI_EMBEDDING_MODEL);
  const extension=file.extension.toLowerCase();
  return extension==='md'||(setting.indexMultimodal&&(extension==='pdf'||(native&&MULTIMODAL_EXTENSIONS.has(extension))));
}
export async function sourceFingerprint(app: App, file: TFile): Promise<string> {
  return ragDigest(file.extension === 'md' ? await app.vault.read(file) : await app.vault.readBinary(file));
}
export async function markdownDependencies(app: App, file: TFile, savedText?: string): Promise<Record<string, string>> {
  if (file.extension !== 'md') return {};
  const text = savedText ?? await app.vault.read(file);
  const dependencies = new Map<string, string>();
  const links = [...text.matchAll(/!\[\[([^\]|#]+)(?:[^\]]*)\]\]|!\[[^\]]*\]\(([^)]+)\)/g)];
  for (const match of links) {
    const target = (match[1] || match[2] || '').replace(/^<|>$/g, '');
    if (/^(?:https?:|data:)/i.test(target)) continue;
    const resolved = app.metadataCache?.getFirstLinkpathDest?.(target, file.path)
      ?? app.vault.getAbstractFileByPath(target);
    if (resolved instanceof TFile) dependencies.set(resolved.path, await sourceFingerprint(app, resolved));
    else if (target) dependencies.set(target, 'missing');
  }
  return Object.fromEntries(dependencies);
}
export function documentRevisionKey(sourceHash: string, dependencies: Record<string, string> = {}): string {
  return JSON.stringify([sourceHash, Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right))]);
}
export async function readDocumentRevision(app: App, file: TFile) {
  const text = file.extension === 'md' ? await app.vault.read(file) : undefined;
  const sourceHash = text === undefined ? await sourceFingerprint(app, file) : await ragDigest(text);
  const dependencies = await markdownDependencies(app, file, text);
  return { sourceHash, dependencies, key: documentRevisionKey(sourceHash, dependencies), empty: text?.trim() === '' };
}
export async function prepareDocumentInput(app: App, file: TFile, setting: RagSetting, control: WorkControl): Promise<{ chunks: DocumentChunk[]; inputs: RagEmbeddingInput[]; extractedHash: string; quality?: SourceQuality }> {
  await control.checkpoint();
  const model = setting.embeddingModel || DEFAULT_GEMINI_EMBEDDING_MODEL;
  const native = !setting.embeddingBaseUrl && isGeminiMultimodalEmbeddingModel(model);
  const extension = file.extension.toLowerCase();
  const chunks: DocumentChunk[] = [], inputs: RagEmbeddingInput[] = [];
  if (native && (extension === 'pdf' || MULTIMODAL_EXTENSIONS.has(extension))) {
    const limit = MULTIMODAL_FILE_SIZE_LIMITS[extension];
    if (limit && file.stat.size > limit) throw new Error('文件超过原生嵌入大小限制');
    const bytes = await app.vault.readBinary(file);
    if (extension === 'pdf') {
      const pdf = await PDFDocument.load(bytes);
      const group = Math.max(1, Math.min(6, setting.pdfChunkPages));
      for (let start = 0; start < pdf.getPageCount(); start += group) {
        await control.checkpoint();
        const part = await PDFDocument.create();
        const pages = await part.copyPages(pdf, Array.from({length:Math.min(group,pdf.getPageCount()-start)},(_,index)=>start+index));
        pages.forEach(page=>part.addPage(page));
        const data = Buffer.from(await part.save()).toString('base64');
        inputs.push({mimeType:'application/pdf',data});
        const pageLabel = `pages ${start+1}-${Math.min(start+group,pdf.getPageCount())} of ${pdf.getPageCount()}`;
        chunks.push({chunkIndex:start,text:`[Pdf: ${file.name} (${pageLabel})]`,contentType:'pdf',pageLabel,inputHash:await ragDigest(data)});
      }
    } else {
      const mimeType = extensionToMimeType(extension);
      if (!mimeType) throw new Error('文件类型不支持原生嵌入');
      inputs.push({mimeType,data:Buffer.from(bytes).toString('base64')});
      chunks.push({chunkIndex:0,text:`[${extension}: ${file.name}]`,contentType:mimeType.split('/')[0] as 'image'|'audio'|'video',inputHash:await ragDigest(bytes)});
    }
    return { chunks, inputs, extractedHash: await ragDigest(JSON.stringify(chunks.map(chunk=>chunk.inputHash))) };
  }
  const result = extension === 'md' ? {text:await app.vault.read(file),pageOffsets:undefined,numPages:undefined}
    : await readSourceDocument(app, file.path, {maxChars:Number.MAX_SAFE_INTEGER,signal:control.signal});
  const headings = [...result.text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match=>({at:match.index,text:match[1] ?? ''}));
  const provenance = extension === 'md' ? readConvertedProvenance(file.path,result.text) : {};
  let headingIndex = -1;
  for (const item of chunkTextWithOffsets(result.text, setting.chunkSize, setting.chunkOverlap)) {
    while (headingIndex+1<headings.length && headings[headingIndex+1].at<=item.startOffset) headingIndex++;
    chunks.push({text:item.text,chunkIndex:chunks.length,startOffset:item.startOffset,heading:headings[headingIndex]?.text,
      inputHash:await ragDigest(item.text),contentType:'text',
      pageLabel:result.pageOffsets && result.numPages ? computePdfPageLabel(item.startOffset,item.startOffset+item.text.length,result.pageOffsets,result.numPages) : undefined,...provenance});
    inputs.push(item.text);
    if (chunks.length % 50 === 0) await control.checkpoint();
  }
  return { chunks, inputs, extractedHash: await ragDigest(result.text), quality:'quality' in result ? result.quality : undefined };
}
