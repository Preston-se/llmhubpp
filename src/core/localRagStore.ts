import {DiskEmbeddingBatchCache} from './embeddingCache';
import { getRagDocumentStore, forgetRagDocumentStore, ragDocumentConfiguration } from './ragDocumentStore';
import { readConvertedProvenance } from "./convertedSourceIndex";
import { type App, TFile, Platform } from "obsidian";
import type { WorkControl } from "./taskManager";
import { cancellationError } from "./taskManager";
import { PDFDocument } from "pdf-lib";
import {
  generateEmbeddings,
  generateGeminiNativeEmbeddings,
  extensionToMimeType,
  extensionToContentType,
  MULTIMODAL_EXTENSIONS,
  MULTIMODAL_FILE_SIZE_LIMITS,
} from "./embeddingProvider";
import {
  type LocalRagIndex,
  type LocalRagChunkMeta,
  type RagContentType,
  loadRagSnapshot,
  saveRagSnapshot,
  ragDigest,
  ragEmbeddingFingerprint,
  deleteRagIndex,
  createEmptyIndex,
  getRagDirectory,
  loadExternalRagSnapshot,
} from "./localRagStorage";
import { DEFAULT_GEMINI_EMBEDDING_MODEL, DEFAULT_RAG_SETTING, type LlmHubSettings, type RagSetting } from "../types";
import { filterRagResultsWithJev, getOpenRouterApiKey, OPENROUTER_DECISIONS_URL, TYPESAFE_DECISIONS_URL } from "./jevRagFilter";
import { OFFICIAL_GEMINI_EMBEDDING_ORIGIN, resolveEmbeddingConnection } from "./embeddingCredentials";

export type AuthorizeRagDestination = (purpose: 'query' | 'rerank', endpoint: string, index: string, model: string) => Promise<boolean>;
// PDF text extraction and page-label mapping are shared.
import { extractPdfTextWithOffsets, computePdfPageLabel } from "obsidian-llm-hub-common/vault";

const MAX_CHANGED_FILES_PER_SYNC = 50;
const SCAN_YIELD_INTERVAL = 25;

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>(resolve => window.setTimeout(resolve, 0));
}

function parseExternalIndexPaths(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(path => path.trim())
    .filter(path => path.length > 0);
}

function mergeLoadedIndexes(items: { index: LocalRagIndex; vectors: Float32Array }[]): {
  index: LocalRagIndex | null;
  vectors: Float32Array | null;
} {
  const compatible = items.filter(({ index, vectors }) =>
    index.dimension > 0 &&
    index.meta.length > 0 &&
    vectors.length >= index.meta.length * index.dimension
  );
  if (compatible.length === 0) return { index: null, vectors: null };

  if (compatible.some(item => item.index.dimension !== compatible[0].index.dimension || item.index.embeddingModel !== compatible[0].index.embeddingModel || item.index.embeddingSpace !== compatible[0].index.embeddingSpace)) {
    throw new RagVectorSpaceError('changed');
  }

  const dimension = compatible[0].index.dimension;
  const sameDimension = compatible.filter(({ index }) => index.dimension === dimension);
  if (sameDimension.length === 0) return { index: null, vectors: null };

  const meta = sameDimension.flatMap(({ index }) => index.meta);
  const mergedVectors = new Float32Array(meta.length * dimension);
  let offset = 0;
  for (const { index, vectors } of sameDimension) {
    const length = index.meta.length * dimension;
    mergedVectors.set(vectors.subarray(0, length), offset);
    offset += length;
  }

  return {
    index: {
      ...sameDimension[0].index,
      meta,
      dimension,
      fileChecksums: sameDimension.reduce<Record<string, string>>(
        (checksums, { index }) => ({ ...checksums, ...index.fileChecksums }),
        {},
      ),
    },
    vectors: mergedVectors,
  };
}

interface LocalRagEntry {
  index: LocalRagIndex | null;
  vectors: Float32Array | null;
}

export interface FilterConfig {
  includeFolders: string[];
  excludePatterns: string[];
  /** Complete, verified collection for a separately owned conversion index. */
  filePaths?: string[];
}

/** Gemini native embedding models that accept multimodal inputs. */
export function isGeminiMultimodalEmbeddingModel(model: string): boolean {
  const modelId = model.split("/").pop() ?? model;
  return /^gemini-embedding-/i.test(modelId);
}

function shouldIncludeFile(filePath: string, config: FilterConfig): boolean {
  // Check include folders (if empty, include all)
  if (config.includeFolders.length > 0) {
    let isInIncludedFolder = false;
    for (const folder of config.includeFolders) {
      const normalizedFolder = folder.replace(/\/$/, "");
      if (
        filePath.startsWith(normalizedFolder + "/") ||
        filePath === normalizedFolder
      ) {
        isInIncludedFolder = true;
        break;
      }
    }
    if (!isInIncludedFolder) {
      return false;
    }
  }

  // Check regex pattern exclusions
  for (const pattern of config.excludePatterns) {
    try {
      const regex = new RegExp(pattern);
      if (regex.test(filePath)) {
        return false;
      }
    } catch {
      // Invalid regex pattern, skip
    }
  }

  return true;
}

export interface LocalRagSearchResult {
  documentRevision?: string;
  documentId?: string;
  chunkId?: string;
  documentOffset?: number;
  heading?: string;
  indexSetting?: string;
  filePath: string;
  originalFilePath?: string;
  text: string;
  score: number;
  chunkIndex: number;
  contentType?: RagContentType;
  pageLabel?: string;
  sourceStatus?: "available" | "missing" | "unknown";
}

export class RagEmbeddingError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "RagEmbeddingError";
  }
}
export class RagVectorSpaceError extends Error {
  constructor(readonly kind: 'unverified'|'changed') {
    super(kind==='unverified'?'旧索引向量空间无法验证，请强制重建整个索引；关键词检索和来源导航仍可使用':'索引向量空间已变化，请强制重建整个索引');
    this.name='RagVectorSpaceError';
  }
}

export interface LocalRagStatus {
  chunkCount: number;
  fileCount: number;
  dimension: number;
  embeddingModel: string;
  spaceIdentity?: string;
  vectorSpaceStatus?: 'verified' | 'changed' | 'unverified';
}

// Convert ArrayBuffer to base64 (chunk-based to avoid O(n^2) string concatenation)
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

// Checksum for binary files using stat info
function binaryChecksum(mtime: number, size: number): string {
  return `${mtime}:${size}`;
}

export async function legacyRagFileChecksum(app: App, file: TFile, control?: WorkControl): Promise<string | undefined> {
  if (file.extension === 'md') return simpleChecksumAsync(await app.vault.read(file), control);
  const stat = await app.vault.adapter.stat(file.path);
  return stat ? binaryChecksum(stat.mtime, stat.size) : undefined;
}

class LocalRagStore {
  private app: App | null = null;
  private entries = new Map<string, LocalRagEntry>();
  private externalPaths = new Map<string, string>();
  private sourceRagSettings = new Map<string, string[]>();
  private settings?: Record<string, RagSetting>;

  setSettings(settings: Record<string, RagSetting>): void { this.settings = settings; }
  workspaceFolder = "LLMHub";

  /** Configuration status never loads vector files or calls an embedding service. */
  peekConfigurationStatus(name:string):Record<string,unknown>{
    const index=this.entries.get(name)?.index;
    return {indexReady:'unknown',evidence:index?'cached-legacy-metadata':'not-loaded',
      ...(index?{cached:{chunkCount:index.meta.length,dimension:index.dimension,embeddingModel:index.embeddingModel,chunkSize:index.chunkSize,chunkOverlap:index.chunkOverlap}}:{})};
  }

  private readable(app: App, name: string, path: string): boolean {
    if (this.externalPaths.has(name)) return true;
    const setting = this.settings?.[name];
    if (!setting) return true;
    if(!setting.sourceCollection&&!setting.indexMultimodal&&!path.toLowerCase().endsWith('.md'))return false;
    if (typeof app.vault.getAbstractFileByPath === 'function' && !(app.vault.getAbstractFileByPath(path) instanceof TFile)) return false;
    return setting.sourceCollection || shouldIncludeFile(path, { includeFolders: setting.targetFolders, excludePatterns: setting.excludePatterns });
  }

  private assertAcyclic(name: string, visited: Set<string>): Set<string> {
    if (visited.has(name)) throw new Error('组合索引存在循环');
    return new Set(visited).add(name);
  }

  private async vectorSpace(app: App, name: string, entry: LocalRagEntry, model: string, endpoint?: string): Promise<Pick<LocalRagStatus,'spaceIdentity'|'vectorSpaceStatus'>> {
    const expected=await ragEmbeddingFingerprint(model,endpoint),identities:string[]=[];
    const documents=getRagDocumentStore(app.vault.adapter,this.workspaceFolder,name);
    const overlay=!this.externalPaths.has(name)&&await documents.isActive();
    let unverified=false,changed=false;
    if(overlay)for(const head of await documents.documents())if(head.count){
      if(head.space.embeddingSpace)identities.push(head.space.embeddingSpace);
      else {
        const config=this.settings?.[name];
        if(!config)unverified=true;
        else if(head.space.fingerprint===await ragDigest(ragDocumentConfiguration({...config,embeddingModel:model,embeddingBaseUrl:endpoint??''})))identities.push(expected);
        else changed=true;
      }
    }
    const base=entry.index;
    if(base?.meta.some(row=>this.readable(app,name,row.filePath)&&(!overlay||documents.rowVisible({...row,score:0})))){
      if(base.embeddingSpace)identities.push(base.embeddingSpace);else unverified=true;
    }
    if(unverified)return {vectorSpaceStatus:'unverified'};
    if(changed||identities.some(identity=>identity!==expected))return {vectorSpaceStatus:'changed'};
    return {spaceIdentity:expected,vectorSpaceStatus:'verified'};
  }
  private assertVectorSpace(status: Pick<LocalRagStatus,'vectorSpaceStatus'>): void {
    if(status.vectorSpaceStatus==='unverified')throw new RagVectorSpaceError('unverified');
    if(status.vectorSpaceStatus!=='verified')throw new RagVectorSpaceError('changed');
  }
  isResultCurrent(app:App,settingName:string,row:LocalRagSearchResult):boolean{
    const name=row.indexSetting??settingName;if(this.externalPaths.has(name))return true;
    return this.readable(app,name,row.filePath)&&getRagDocumentStore(app.vault.adapter,this.workspaceFolder,name).rowVisible(row);
  }
  private async visibleResults(app:App,results:LocalRagSearchResult[]):Promise<()=>LocalRagSearchResult[]>{
    await Promise.all([...new Set(results.map(row=>row.indexSetting).filter((name):name is string=>!!name&&!this.externalPaths.has(name)))].map(name=>getRagDocumentStore(app.vault.adapter,this.workspaceFolder,name).isActive()));
    return ()=>results.filter(row=>!row.indexSetting||this.isResultCurrent(app,row.indexSetting,row));
  }

  async load(app: App, _settingNames: string[], ragSettings?: Record<string, RagSetting>): Promise<void> {
    this.app = app;
    if (ragSettings) {
      this.settings = ragSettings;
      for (const [name, setting] of Object.entries(ragSettings)) {
        if (setting.externalIndexPath) {
          this.externalPaths.set(name, setting.externalIndexPath);
        }
        this.setSourceRagSettings(name, setting.sourceRagSettings);
      }
    }
    // Open legacy payloads only when that index is queried or explicitly reconciled.
  }

  setExternalPath(settingName: string, externalPath: string): void {
    if (externalPath) {
      this.externalPaths.set(settingName, externalPath);
    } else {
      this.externalPaths.delete(settingName);
    }
    // A changed source can affect combined indexes, so reload all cached entries.
    this.clearAll();
  }

  setSourceRagSettings(settingName: string, sourceNames: string[]): void {
    const filtered = [...new Set(sourceNames.filter(sourceName => sourceName && sourceName !== settingName))];
    if (filtered.length > 0) {
      this.sourceRagSettings.set(settingName, filtered);
    } else {
      this.sourceRagSettings.delete(settingName);
    }
    this.clearAll();
  }

  async sync(
    app: App,
    settingName: string,
    apiKey: string,
    model: string,
    chunkSize: number,
    chunkOverlap: number,
    pdfChunkPages: number,
    filterConfig: FilterConfig,
    onProgress?: (current: number, total: number, fileName: string, action: "embed" | "skip" | "remove") => void,
    embeddingBaseUrl?: string,
    indexMultimodal = false,
    proxyUrl?: string,
    proxyBypass?: string,
    control?: WorkControl,
  ): Promise<{ embedded: number; skipped: number; removed: number; errors: string[]; deferredFiles?: number; failedFiles?: string[]; processed?:number }> {
    await control?.checkpoint();
    this.app = app;
    const result = { embedded: 0, skipped: 0, removed: 0, errors: [] as string[] };
    const entry = await this.ensureLoaded(app, settingName);
    let index = entry.index;
    let vectors = entry.vectors;
    const embeddingSpace=await ragEmbeddingFingerprint(model,embeddingBaseUrl);
    if(index?.meta.length){
      if(!index.embeddingSpace)throw new RagVectorSpaceError('unverified');
      if(index.embeddingSpace!==embeddingSpace)throw new RagVectorSpaceError('changed');
    }

    // Gemini native mode = no custom baseUrl (uses SDK directly)
    const isGeminiNative = !embeddingBaseUrl;

    // Check if we need full rebuild (model, chunk params, or multimodal setting changed)
    const normalizedPdfChunkPages = Math.min(6, Math.max(1, pdfChunkPages));
    const needsFullRebuild = index !== null && (
      index.embeddingModel !== model ||
      index.chunkSize !== chunkSize ||
      index.chunkOverlap !== chunkOverlap ||
      (index.pdfChunkPages ?? 6) !== normalizedPdfChunkPages ||
      (index.indexMultimodal ?? false) !== indexMultimodal
    );

    if (needsFullRebuild) {
      index = null;
      vectors = null;
    }

    if (!index) {
      index = createEmptyIndex();
    }

    // Determine eligible file extensions
    const isEligibleFile = (f: TFile) => {
      if (f.extension === "md") return true;
      // PDFs: Gemini native uses binary embedding; others use text extraction
      if (indexMultimodal && f.extension === "pdf") return true;
      if (indexMultimodal && isGeminiNative && MULTIMODAL_EXTENSIONS.has(f.extension)) return true;
      return false;
    };

    // Get all eligible files
    const explicitFiles = filterConfig.filePaths ? new Set(filterConfig.filePaths) : null;
    const allFiles = app.vault.getFiles().filter(
      (f: TFile) => isEligibleFile(f) && (!explicitFiles || (f.extension === "md" && explicitFiles.has(f.path))) && shouldIncludeFile(f.path, filterConfig)
    ).sort((a,b) => a.path.localeCompare(b.path, "en", {numeric:true}) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // Calculate checksums for current files
    const currentChecksums: Record<string, string> = {};
    const contentCache = new Map<string, string>();
    for (let i = 0; i < allFiles.length; i++) {
      await control?.checkpoint();
      const file = allFiles[i];
      control?.update("扫描RAG文档", i + 1, allFiles.length, file.path);
      const checksum = await legacyRagFileChecksum(app, file, control);
      if (checksum !== undefined) currentChecksums[file.path] = checksum;
      if ((i + 1) % SCAN_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    // Determine which files need updating
    let filesToEmbed: TFile[] = [];
    const filesToKeepSet = new Set<string>();
    const currentFilePaths = new Set(allFiles.map(f => f.path));

    for (const file of allFiles) {
      const existingChecksum = index.fileChecksums[file.path];
      if (existingChecksum && existingChecksum === currentChecksums[file.path]) {
        filesToKeepSet.add(file.path);
      } else {
        filesToEmbed.push(file);
      }
    }

    const deferredFiles = filesToEmbed.slice(MAX_CHANGED_FILES_PER_SYNC);
    filesToEmbed = filesToEmbed.slice(0, MAX_CHANGED_FILES_PER_SYNC);
    for (const file of deferredFiles) {
      if (index.fileChecksums[file.path]) {
        filesToKeepSet.add(file.path);
      }
    }

    // Remove chunks from deleted/changed files
    const filesToEmbedPaths = new Set(filesToEmbed.map(f => f.path));
    const filesToRemove = Object.keys(index.fileChecksums).filter(
      p => !currentFilePaths.has(p) || filesToEmbedPaths.has(p)
    );

    result.removed = filesToRemove.length;
    result.skipped = filesToKeepSet.size;

    const totalOps = filesToEmbed.length + filesToRemove.length + filesToKeepSet.size;

    // Report skipped/removed files
    const keptPaths = [...filesToKeepSet];
    for (let i = 0; i < keptPaths.length; i++) {
      onProgress?.(i + 1, totalOps, keptPaths[i], "skip");
    }
    for (let i = 0; i < filesToRemove.length; i++) {
      onProgress?.(filesToKeepSet.size + i + 1, totalOps, filesToRemove[i], "remove");
    }

    // Embed new/changed files
    const newMeta: LocalRagChunkMeta[] = [];
    const newVectorParts: Float32Array[] = [];
    const embeddedChecksums: Record<string, string> = {};
    const failedFiles: string[] = [];
    let dimension = index.dimension;
    let currentOp = filesToKeepSet.size + filesToRemove.length;
    const baseIndex=index,baseVectors=vectors;
    let dirty=filesToRemove.some(path=>!currentFilePaths.has(path));
    const commitProgress=async()=>{
      await control?.checkpoint();control?.update('保存RAG索引',currentOp,totalOps);
      await yieldToEventLoop();await control?.checkpoint();
      const meta:LocalRagChunkMeta[]=[],parts:Float32Array[]=[];
      const checksums:Record<string,string>={};
      for(let i=0;i<baseIndex.meta.length;i++){
        const item=baseIndex.meta[i];
        if(currentFilePaths.has(item.filePath)&&embeddedChecksums[item.filePath]===undefined&&baseVectors){
          meta.push(item);parts.push(baseVectors.slice(i*baseIndex.dimension,(i+1)*baseIndex.dimension));checksums[item.filePath]=baseIndex.fileChecksums[item.filePath];
        }
      }
      for(const [path,checksum] of Object.entries(baseIndex.fileChecksums))if(currentFilePaths.has(path)&&embeddedChecksums[path]===undefined)checksums[path]=checksum;
      meta.push(...newMeta);parts.push(...newVectorParts);Object.assign(checksums,embeddedChecksums);
      if(parts.some(part=>part.length!==dimension))throw new Error('RAG向量维度不一致，未发布新索引，请检查模型并重建');
      const binary=new Float32Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const part of parts){binary.set(part,offset);offset+=part.length;}
      const snapshot={meta,dimension,fileChecksums:checksums,embeddingModel:model,embeddingSpace,chunkSize,chunkOverlap,pdfChunkPages:normalizedPdfChunkPages,indexMultimodal};
      await saveRagSnapshot(app,settingName,snapshot,binary,this.workspaceFolder);
      this.clearAll();this.entries.set(settingName,{index:snapshot,vectors:binary});
      dirty=false;
    };


    for (const file of filesToEmbed) {
      await control?.checkpoint();
      control?.update("准备RAG分块", currentOp + 1, totalOps, file.path);
      const cacheDirectory = `${getRagDirectory(this.workspaceFolder)}/${settingName.replace(/[^a-zA-Z0-9_-]/g,'_')}/.batches/${await ragDigest(file.path)}`;
      const namespace=await ragDigest(JSON.stringify({path:file.path,checksum:currentChecksums[file.path],model,embeddingBaseUrl,chunkSize,chunkOverlap,pdfChunkPages:normalizedPdfChunkPages,indexMultimodal}));
      const fileControl: WorkControl | undefined = control ? {
        batchCache:new DiskEmbeddingBatchCache(app.vault.adapter,cacheDirectory,namespace),
        signal: control.signal,
        checkpoint: () => control.checkpoint(),
        update: (stage, current, total, detail) => control.update(stage, current, total, detail || file.path),
      } : undefined;
      await fileControl?.batchCache?.prune?.();
      currentOp++;
      onProgress?.(currentOp, totalOps, file.path, "embed");

      const metaStart=newMeta.length,vectorStart=newVectorParts.length;
      try {
        if (file.extension === "md") {
          // Text file: chunk and embed
          const content = contentCache.get(file.path) ?? await app.vault.read(file);
          contentCache.set(file.path, content);
          const chunks = content ? await chunkTextAsync(content, chunkSize, chunkOverlap, fileControl) : [];
          if (chunks.length === 0) {embeddedChecksums[file.path]=currentChecksums[file.path];}
          else {

          let embeddings: number[][];
          if (isGeminiNative) {
            embeddings = await generateGeminiNativeEmbeddings(
              chunks.map(text => ({ text })),
              apiKey, model, undefined, proxyUrl, proxyBypass, fileControl,
            );
          } else {
            embeddings = await generateEmbeddings(chunks, apiKey, model, embeddingBaseUrl, proxyUrl, proxyBypass, fileControl);
          }

          if (embeddings.length > 0 && embeddings[0].length > 0) {
            dimension = embeddings[0].length;
          }

          for (let i = 0; i < chunks.length; i++) {
            if (embeddings[i] && embeddings[i].length > 0) {
              newMeta.push({ filePath: file.path, chunkIndex: i, text: chunks[i], contentType: "text", ...readConvertedProvenance(file.path, content) });
              newVectorParts.push(new Float32Array(embeddings[i]));
            }
          }
          result.embedded++;
          embeddedChecksums[file.path] = currentChecksums[file.path];
          }
        } else if (file.extension === "pdf") {
          if (isGeminiNative) {
            // Gemini native: embed PDF binary chunks directly
            const sizeLimit = MULTIMODAL_FILE_SIZE_LIMITS[file.extension];
            const stat = await app.vault.adapter.stat(file.path);
            if (!stat || (sizeLimit && stat.size > sizeLimit)) {
              result.errors.push(`${file.path}: file too large (${stat?.size ?? 0} bytes, limit ${sizeLimit ?? 0})`);
              continue;
            }

            const buffer = await app.vault.readBinary(file);
            const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
            const totalPages = pdfDoc.getPageCount();
            const maxPages = normalizedPdfChunkPages;
            let embedded = 0;

            for (let start = 0; start < totalPages; start += maxPages) {
              const end = Math.min(start + maxPages, totalPages);
              const chunkDoc = await PDFDocument.create();
              const pages = await chunkDoc.copyPages(pdfDoc, Array.from({ length: end - start }, (_, i) => start + i));
              for (const page of pages) chunkDoc.addPage(page);
              const chunkBytes = await chunkDoc.save();
              const chunkBase64 = arrayBufferToBase64(chunkBytes.buffer as ArrayBuffer);

              const embeddings = await generateGeminiNativeEmbeddings(
                [{ inlineData: { mimeType: "application/pdf", data: chunkBase64 } }],
                apiKey, model, undefined, proxyUrl, proxyBypass, fileControl,
              );

              if (embeddings.length > 0 && embeddings[0].length > 0) {
                dimension = embeddings[0].length;
                const pageLabel = `pages ${start + 1}-${end} of ${totalPages}`;
                const label = `[Pdf: ${file.name} (${pageLabel})]`;
                newMeta.push({ filePath: file.path, chunkIndex: start, text: label, contentType: "pdf", pageLabel });
                newVectorParts.push(new Float32Array(embeddings[0]));
                embedded++;
              }
            }

            if (embedded > 0) {
              result.embedded++;
              embeddedChecksums[file.path] = currentChecksums[file.path];
            }
          } else {
            // Non-Gemini: extract text from PDF and embed as text chunks
            const pdfResult = await extractPdfTextWithOffsets(app, file.path);
            if (!pdfResult) {
              failedFiles.push(file.path);
              continue;
            }

            const chunks = await chunkOffsetsAsync(pdfResult.text, chunkSize, chunkOverlap, fileControl);
            if (chunks.length === 0) {
              failedFiles.push(file.path);
              continue;
            }

            const embeddings = await generateEmbeddings(
              chunks.map(c => c.text), apiKey, model, embeddingBaseUrl, proxyUrl, proxyBypass, fileControl,
            );

            if (embeddings.length > 0 && embeddings[0].length > 0) {
              dimension = embeddings[0].length;
            }

            for (let i = 0; i < chunks.length; i++) {
              if (embeddings[i] && embeddings[i].length > 0) {
                const pageLabel = computePdfPageLabel(
                  chunks[i].startOffset, chunks[i].startOffset + chunks[i].text.length,
                  pdfResult.pageOffsets, pdfResult.numPages,
                );
                newMeta.push({ filePath: file.path, chunkIndex: i, text: chunks[i].text, contentType: "pdf", pageLabel });
                newVectorParts.push(new Float32Array(embeddings[i]));
              }
            }
            result.embedded++;
            embeddedChecksums[file.path] = currentChecksums[file.path];
          }
        } else {
          // Other multimodal file (image, audio, video): embed as single chunk
          const sizeLimit = MULTIMODAL_FILE_SIZE_LIMITS[file.extension];
          const stat = await app.vault.adapter.stat(file.path);
          if (!stat || (sizeLimit && stat.size > sizeLimit)) {
            failedFiles.push(file.path);
            continue;
          }

          const mimeType = extensionToMimeType(file.extension);
          if (!mimeType) {
            failedFiles.push(file.path);
            continue;
          }

          const buffer = await app.vault.readBinary(file);
          const base64 = arrayBufferToBase64(buffer);
          const contentType = extensionToContentType(file.extension);

          const embeddings = await generateGeminiNativeEmbeddings(
            [{ inlineData: { mimeType, data: base64 } }],
            apiKey, model, undefined, proxyUrl, proxyBypass, fileControl,
          );

          if (embeddings.length > 0 && embeddings[0].length > 0) {
            dimension = embeddings[0].length;
            const label = `[${contentType.charAt(0).toUpperCase() + contentType.slice(1)}: ${file.name}]`;
            newMeta.push({ filePath: file.path, chunkIndex: 0, text: label, contentType });
            newVectorParts.push(new Float32Array(embeddings[0]));
            result.embedded++;
            embeddedChecksums[file.path] = currentChecksums[file.path];
          } else {
            failedFiles.push(file.path);
          }
        }
      } catch (error) {
        newMeta.length=metaStart;newVectorParts.length=vectorStart;delete embeddedChecksums[file.path];
        if (control?.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        if (file.extension === "pdf" || MULTIMODAL_EXTENSIONS.has(file.extension)) {
          failedFiles.push(file.path);
        } else {
          result.errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (embeddedChecksums[file.path] !== undefined) {
        dirty=true;
        await commitProgress();
        if(newMeta.length>metaStart){control?.saved?.(file.path);control?.update('已保存可检索',currentOp,totalOps,file.path);}
        else control?.update('已处理空文档',currentOp,totalOps,file.path+'（无正文可索引）');
        await fileControl?.batchCache?.clear?.();
      }
      if (currentOp % SCAN_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    if(dirty)await commitProgress();

    return { ...result, deferredFiles: deferredFiles.length, failedFiles, processed:Object.keys(embeddedChecksums).length };
  }

  async search(
    settingName: string,
    query: string,
    apiKey: string,
    model: string,
    topK: number,
    embeddingBaseUrl?: string,
    scoreThreshold?: number,
    searchFileExtensions?: string[],
    proxyUrl?: string,
    proxyBypass?: string,
    signal?: AbortSignal,
    visited = new Set<string>(),
    providers?: Pick<LlmHubSettings, "apiProviders">,
    authorize?: AuthorizeRagDestination,
  ): Promise<LocalRagSearchResult[]> {
    if (!this.app) {
      return [];
    }

    if (visited.has(settingName)) throw new Error('组合索引存在循环');
    const sources = this.sourceRagSettings.get(settingName) ?? [];
    if (sources.length) {
      const spaces = await Promise.all(sources.map(name => this.getStatus(this.app!, name)));
      const populated = spaces.filter(space => space.chunkCount > 0);
      for(const space of populated)this.assertVectorSpace(space);
      if (populated.some(space => space.dimension !== populated[0].dimension || space.embeddingModel !== populated[0].embeddingModel || space.spaceIdentity !== populated[0].spaceIdentity)) throw new RagVectorSpaceError('changed');
      const next = new Set(visited).add(settingName);
      const results: LocalRagSearchResult[] = [];
      for (const [position, source] of sources.entries()) {
        const config = this.settings?.[source];
        if (!config) continue;
        const connection = resolveEmbeddingConnection(config, providers);
        if (!config.sourceRagSettings.length && connection.status !== 'ready' && spaces[position].chunkCount) {
          throw new RagEmbeddingError(new Error('Embedding connection is unavailable'));
        }
        results.push(...(await this.search(source, query, connection.apiKey,
          config.embeddingModel || (connection.kind === 'gemini' ? DEFAULT_GEMINI_EMBEDDING_MODEL : ''),
          topK, config.embeddingBaseUrl || undefined, scoreThreshold, searchFileExtensions,
          proxyUrl, proxyBypass, signal, next, providers, authorize)).map(row=>({...row,indexSetting:row.indexSetting??source})));
      }
      return (await this.visibleResults(this.app,results))().sort((a, b) => b.score - a.score).slice(0, topK);
    }

    const entry = await this.ensureLoaded(this.app, settingName);
    const documentStore = this.externalPaths.has(settingName) ? undefined : getRagDocumentStore(this.app.vault.adapter, this.workspaceFolder, settingName);
    const space = await documentStore?.space();
    const index = space ? { ...createEmptyIndex(), dimension: space.dimension, embeddingModel: space.model } : entry.index;
    const vectors = entry.vectors;
    if (!index || (!space && (!vectors || index.meta.length === 0))) {
      return [];
    }

    // For external index, use the model stored in the index itself
    const isExternal = this.externalPaths.has(settingName);
    const effectiveModel = isExternal
      ? (index.embeddingModel || (embeddingBaseUrl ? model : DEFAULT_GEMINI_EMBEDDING_MODEL))
      : model;
    this.assertVectorSpace(await this.vectorSpace(this.app,settingName,entry,effectiveModel,embeddingBaseUrl));

    // Use Gemini native for query embedding when no custom baseUrl
    // Pass index dimension to match the dimensionality used during indexing
    const control: WorkControl | undefined = signal && !Platform.isMobile ? {
      signal,
      checkpoint: async () => { if (signal.aborted) throw cancellationError(); },
      update: () => {},
    } : undefined;
    let queryEmbedding: number[];
    try {
      if (authorize && !await authorize('query', embeddingBaseUrl || OFFICIAL_GEMINI_EMBEDDING_ORIGIN, settingName, effectiveModel)) {
        throw cancellationError();
      }
      if (signal?.aborted) throw cancellationError();
      if (!embeddingBaseUrl) {
        const results = await generateGeminiNativeEmbeddings([{ text: query }], apiKey, effectiveModel, index.dimension || undefined, proxyUrl, proxyBypass, control);
        queryEmbedding = results[0];
      } else {
        const results = await generateEmbeddings([query], apiKey, effectiveModel, embeddingBaseUrl, proxyUrl, proxyBypass, control);
        queryEmbedding = results[0];
      }
      if (signal?.aborted) throw cancellationError();
      if (!queryEmbedding || queryEmbedding.length !== index.dimension || queryEmbedding.some(value => !Number.isFinite(value))) {
        throw new Error("Query embedding dimensions do not match the index.");
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw cancellationError();
      throw new RagEmbeddingError(error);
    }

    const dim = index.dimension;
    // A rebuild may have activated another space while query embedding was in flight.
    this.assertVectorSpace(await this.vectorSpace(this.app,settingName,entry,effectiveModel,embeddingBaseUrl));
    if (documentStore && await documentStore.isActive()) {
      const rows = await documentStore.find(queryEmbedding, topK, entry.index && vectors ? { index: entry.index, vectors } : null, searchFileExtensions, scoreThreshold ?? 0, row=>this.readable(this.app!,settingName,row.filePath),signal);
      if (signal?.aborted) throw cancellationError();
      return rows.filter(row => documentStore.rowVisible(row) && this.readable(this.app!, settingName, row.filePath)).map(row=>({...row,indexSetting:settingName}));
    }
    const scores: Array<{ index: number; score: number }> = [];

    // Build extension filter set (normalized to lowercase without leading dot)
    const extFilter = searchFileExtensions && searchFileExtensions.length > 0
      ? new Set(searchFileExtensions.map(e => e.replace(/^\./, "").toLowerCase()))
      : null;

    for (let i = 0; i < index.meta.length; i++) {
      if (!this.readable(this.app, settingName, index.meta[i].filePath)) continue;
      // Skip entries that don't match the file extension filter
      if (extFilter) {
        const filePath = index.meta[i].filePath;
        const ext = filePath.substring(filePath.lastIndexOf(".") + 1).toLowerCase();
        if (!extFilter.has(ext)) continue;
      }

      const start = i * dim;
      const end = start + dim;
      if (end > vectors!.length) break;

      const docVec = vectors!.subarray(start, end);
      const score = cosineSimilarity(queryEmbedding, docVec);
      scores.push({ index: i, score });
    }

    scores.sort((a, b) => b.score - a.score);
    const topResults = scores.slice(0, topK);

    return topResults
      .filter(r => r.score > (scoreThreshold ?? 0))
      .map(r => ({
        filePath: index.meta[r.index].filePath,
        text: index.meta[r.index].text,
        score: r.score,
        chunkIndex: index.meta[r.index].chunkIndex,
        contentType: index.meta[r.index].contentType,
        pageLabel: index.meta[r.index].pageLabel,
        originalFilePath: index.meta[r.index].originalFilePath,
      }));
  }

  async clear(app: App, settingName: string): Promise<void> {
    this.app = app;
    this.clearAll();
    await deleteRagIndex(app, settingName, this.workspaceFolder);
    forgetRagDocumentStore(app.vault.adapter, this.workspaceFolder, settingName);
  }

  /** Invalidate all in-memory caches (e.g. after workspace folder change). */
  clearAll(): void {
    this.entries.clear();
  }

  async getStatus(app: App, settingName: string, visited = new Set<string>()): Promise<LocalRagStatus> {
    const next = this.assertAcyclic(settingName, visited);
    const sources = this.sourceRagSettings.get(settingName) ?? [];
    if (sources.length) {
      const statuses = await Promise.all(sources.map(source => this.getStatus(app, source, next)));
      const first = statuses.find(status => status.chunkCount > 0);
      const populated=statuses.filter(status=>status.chunkCount>0);
      const vectorSpaceStatus=populated.some(status=>status.vectorSpaceStatus==='unverified')?'unverified':populated.some(status=>status.vectorSpaceStatus!=='verified'||status.spaceIdentity!==first?.spaceIdentity||status.dimension!==first?.dimension)?'changed':'verified';
      return { chunkCount: statuses.reduce((sum, status) => sum + status.chunkCount, 0), fileCount: statuses.reduce((sum, status) => sum + status.fileCount, 0), dimension: first?.dimension ?? 0, embeddingModel: first?.embeddingModel ?? '', spaceIdentity: first?.spaceIdentity,vectorSpaceStatus };
    }
    const entry = await this.ensureLoaded(app, settingName);
    const documents = getRagDocumentStore(app.vault.adapter, this.workspaceFolder, settingName);
    if (!this.externalPaths.has(settingName) && await documents.isActive()) {
      const files = await this.getIndexedFiles(app, settingName), space = await documents.space();
      return { chunkCount: files.reduce((sum, file) => sum + file.chunks, 0), fileCount: files.length,
        dimension: space?.dimension ?? entry.index?.dimension ?? 0, embeddingModel: space?.model ?? entry.index?.embeddingModel ?? '',
        ...await this.vectorSpace(app,settingName,entry,this.settings?.[settingName]?.embeddingModel||space?.model||entry.index?.embeddingModel||'',this.settings?.[settingName]?.embeddingBaseUrl) };
    }
    if (!entry.index) {
      return { chunkCount: 0, fileCount: 0, dimension: 0, embeddingModel: "" };
    }
    return {
      chunkCount: entry.index.meta.length,
      fileCount: entry.index.fileChecksums ? Object.keys(entry.index.fileChecksums).length : 0,
      dimension: entry.index.dimension,
      embeddingModel: entry.index.embeddingModel || "",
      ...await this.vectorSpace(app,settingName,entry,this.settings?.[settingName]?.embeddingModel||entry.index.embeddingModel||'',this.settings?.[settingName]?.embeddingBaseUrl),
    };
  }

  /** Return indexed files with per-file chunk counts, sorted by file path. */
  async getIndexedFiles(app: App, settingName: string, visited = new Set<string>()): Promise<{ filePath: string; chunks: number }[]> {
    const next = this.assertAcyclic(settingName, visited);
    const sources = this.sourceRagSettings.get(settingName) ?? [];
    if (sources.length) return (await Promise.all(sources.map(source => this.getIndexedFiles(app, source, next)))).flat();
    const entry = await this.ensureLoaded(app, settingName);
    const documents = getRagDocumentStore(app.vault.adapter, this.workspaceFolder, settingName);
    const overlay = !this.externalPaths.has(settingName) && await documents.isActive();
    if (!entry.index && !overlay) return [];
    const counts = new Map<string, number>();
    for (const filePath of Object.keys(entry.index?.fileChecksums ?? {})) {
      if (overlay && await documents.shadows(filePath)) continue;
      counts.set(filePath, 0);
    }
    for (const m of entry.index?.meta ?? []) {
      if (overlay && await documents.shadows(m.filePath)) continue;
      counts.set(m.filePath, (counts.get(m.filePath) ?? 0) + 1);
    }
    if (overlay) for (const head of await documents.documents()) counts.set(head.path, head.count);
    return Array.from(counts.entries())
      .filter(([path]) => this.readable(app, settingName, path))
      .map(([filePath, chunks]) => ({ filePath, chunks }))
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  /** Keyword search across indexed chunks (no embedding API call needed). */
  async keywordSearch(
    app: App, settingName: string, query: string, topK: number,
    searchFileExtensions?: string[],
    visited = new Set<string>(),
  ): Promise<LocalRagSearchResult[]> {
    const next = this.assertAcyclic(settingName, visited);
    const sources = this.sourceRagSettings.get(settingName) ?? [];
    if (sources.length) {
      const results = (await Promise.all(sources.map(async source => (await this.keywordSearch(app, source, query, topK, searchFileExtensions, next)).map(row=>({...row,indexSetting:row.indexSetting??source}))))).flat();
      return (await this.visibleResults(app,results))().sort((a, b) => b.score - a.score).slice(0, topK);
    }
    const entry = await this.ensureLoaded(app, settingName);
    const documents = getRagDocumentStore(app.vault.adapter, this.workspaceFolder, settingName);
    if (!this.externalPaths.has(settingName) && await documents.isActive()) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean), best: LocalRagSearchResult[] = [];
      if (!terms.length) return [];
      for await (const { row } of documents.rows(entry.index && entry.vectors ? { index: entry.index, vectors: entry.vectors } : null)) {
        if (!this.readable(app, settingName, row.filePath)) continue;
        if (searchFileExtensions?.length && !searchFileExtensions.some(ext => row.filePath.toLowerCase().endsWith('.' + ext.replace(/^\./, '').toLowerCase()))) continue;
        const text = row.text.toLowerCase();
        const hits = terms.filter(term => text.includes(term)).length;
        if (!hits) continue;
        best.push({ ...row, score: hits / terms.length }); best.sort((a, b) => b.score - a.score);
        if (best.length > topK) best.pop();
      }
      return best.filter(row => documents.rowVisible(row) && this.readable(app, settingName, row.filePath)).map(row=>({...row,indexSetting:settingName}));
    }
    if (!entry.index) return [];

    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    if (terms.length === 0) return [];

    const extFilter = searchFileExtensions && searchFileExtensions.length > 0
      ? new Set(searchFileExtensions.map(e => e.replace(/^\./, "").toLowerCase()))
      : null;

    const scored: Array<{ index: number; score: number }> = [];

    for (let i = 0; i < entry.index.meta.length; i++) {
      const meta = entry.index.meta[i];
      if (!this.readable(app, settingName, meta.filePath)) continue;
      if (extFilter) {
        const ext = meta.filePath.substring(meta.filePath.lastIndexOf(".") + 1).toLowerCase();
        if (!extFilter.has(ext)) continue;
      }

      const textLower = meta.text.toLowerCase();
      let matchCount = 0;
      let totalOccurrences = 0;
      for (const term of terms) {
        let pos = 0;
        let found = false;
        while (true) {
          const idx = textLower.indexOf(term, pos);
          if (idx === -1) break;
          found = true;
          totalOccurrences++;
          pos = idx + term.length;
        }
        if (found) matchCount++;
      }

      if (matchCount === 0) continue;

      // Score: ratio of matched terms * total occurrences normalized by text length
      const termCoverage = matchCount / terms.length;
      const density = totalOccurrences / (textLower.length / 100);
      scored.push({ index: i, score: termCoverage * 0.7 + Math.min(density, 1) * 0.3 });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(r => ({
      filePath: entry.index!.meta[r.index].filePath,
      text: entry.index!.meta[r.index].text,
      score: r.score,
      chunkIndex: entry.index!.meta[r.index].chunkIndex,
      contentType: entry.index!.meta[r.index].contentType,
      pageLabel: entry.index!.meta[r.index].pageLabel,
      originalFilePath: entry.index!.meta[r.index].originalFilePath,
    }));
  }

  /** Get an adjacent chunk (prev/next) for a given file.
   *  Uses text matching to identify the current chunk (handles duplicate chunkIndex in external RAG). */
  async getAdjacentChunk(
    app: App, settingName: string, filePath: string, chunkText: string, direction: "prev" | "next",
    visited = new Set<string>(),
  ): Promise<LocalRagSearchResult | null> {
    const next = this.assertAcyclic(settingName, visited);
    const sources = this.sourceRagSettings.get(settingName) ?? [];
    for (const source of sources) {
      const result = await this.getAdjacentChunk(app, source, filePath, chunkText, direction, next);
      if (result) return result;
    }
    if (sources.length) return null;
    if (!this.readable(app, settingName, filePath)) return null;
    const documents = getRagDocumentStore(app.vault.adapter, this.workspaceFolder, settingName);
    if (!this.externalPaths.has(settingName) && await documents.isActive()) {
      if (!documents.visible(filePath)) return null;
      const head = await documents.head(filePath);
      if (head) {
        const { chunks } = await documents.payload(head);
        const index = chunks.findIndex(chunk => chunk.text === chunkText);
        const target = chunks[index + (direction === 'next' ? 1 : -1)];
        return index >= 0 && target && documents.rowVisible({ filePath, text: '', chunkIndex: 0, score: 0, documentId: head.id, documentRevision: head.revision }) ? { ...target, filePath, indexSetting:settingName, documentId: head.id, documentRevision: head.revision, chunkId: `${target.inputHash}:${target.chunkIndex}`, documentOffset: target.startOffset, score: 0 } : null;
      }
      if (await documents.shadows(filePath)) return null;
    }
    const entry = await this.ensureLoaded(app, settingName);
    if (!entry.index) return null;

    // Collect all chunks for this file in index order (natural insertion order)
    const fileChunks: { meta: LocalRagChunkMeta; metaIndex: number }[] = [];
    for (let i = 0; i < entry.index.meta.length; i++) {
      if (entry.index.meta[i].filePath === filePath) {
        fileChunks.push({ meta: entry.index.meta[i], metaIndex: i });
      }
    }

    // Find current chunk by text match
    const currentPos = fileChunks.findIndex(c => c.meta.text === chunkText);
    if (currentPos === -1) return null;

    const targetPos = direction === "prev" ? currentPos - 1 : currentPos + 1;
    if (targetPos < 0 || targetPos >= fileChunks.length) return null;

    const meta = fileChunks[targetPos].meta;
    return {
      filePath: meta.filePath,
      text: meta.text,
      score: 0,
      chunkIndex: meta.chunkIndex,
      contentType: meta.contentType,
      pageLabel: meta.pageLabel,
      originalFilePath: meta.originalFilePath,
    };
  }

  private async ensureLoaded(
    app: App,
    settingName: string
  ): Promise<LocalRagEntry> {
    const existing = this.entries.get(settingName);
    if (existing) {
      return existing;
    }

    const externalPath = this.externalPaths.get(settingName);
    const sourceNames = this.sourceRagSettings.get(settingName) ?? [];
    let index: LocalRagIndex | null;
    let vectors: Float32Array | null;
    if (sourceNames.length > 0) {
      // Combined queries read source indexes directly; never duplicate their vector buffers.
      index = null; vectors = null;
    } else if (externalPath) {
      const loadedIndexes: { index: LocalRagIndex; vectors: Float32Array }[] = [];
      for (const path of parseExternalIndexPaths(externalPath)) {
        const snapshot=await loadExternalRagSnapshot(path);
        if(snapshot&&snapshot.index.meta.length)loadedIndexes.push(snapshot);
      }
      ({ index, vectors } = mergeLoadedIndexes(loadedIndexes));
    } else {
      const usesBase=await getRagDocumentStore(app.vault.adapter,this.workspaceFolder,settingName).consumesLegacyBase();
      const snapshot=usesBase?await loadRagSnapshot(app,settingName,this.workspaceFolder):null;
      index=snapshot?.index ?? null;vectors=snapshot?.vectors ?? null;
    }
    const entry = { index, vectors };
    this.entries.set(settingName, entry);
    return entry;
  }

  async getSnapshot(app: App, settingName: string): Promise<{ index: LocalRagIndex; vectors: Float32Array } | null> {
    if (this.externalPaths.has(settingName) || this.sourceRagSettings.has(settingName)) return null;
    const entry = await this.ensureLoaded(app, settingName);
    return entry.index && entry.vectors ? { index: entry.index, vectors: entry.vectors } : null;
  }
  async resolveDocument(app: App, settingName: string, documentId: string): Promise<string|null> {
    if(this.externalPaths.has(settingName)||this.sourceRagSettings.has(settingName))return null;
    return getRagDocumentStore(app.vault.adapter,this.workspaceFolder,settingName).resolve(documentId);
  }
}

export function buildLocalRagContext(results: LocalRagSearchResult[]): string {
  if (results.length === 0) return "";

  let context = "\n\n--- Relevant context from vault (semantic search) ---\n";
  for (const r of results) {
    context += `\n[Source: ${r.filePath}] (relevance: ${r.score.toFixed(3)})\n${r.text}\n`;
  }
  context += "\n--- End of context ---\n";
  return context;
}

// Chunking: split text into chunks with overlap at paragraph/sentence boundaries.
// Returns offset information for each chunk.
function* textChunkIterator(text: string, chunkSize: number, chunkOverlap: number): Generator<{text: string; startOffset: number}> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || !Number.isFinite(chunkOverlap)) throw new Error("分块大小必须是正整数，重叠必须是有限数值");
  if (!text.trim()) return;
  const overlap = Math.max(0, Math.min(chunkOverlap, chunkSize - 1));
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    if (end < text.length) {
      // Bound both searches to this chunk. Searching the entire prefix for an
      // English sentence delimiter makes long Chinese documents quadratic.
      const windowText = text.slice(start, Math.min(text.length, end + 2));
      const paragraph = windowText.lastIndexOf("\n\n", end - start);
      if (paragraph > chunkSize * 0.5) end = start + paragraph + 2;
      else {
        const sentence = windowText.lastIndexOf(". ", end - start);
        if (sentence > chunkSize * 0.5) end = start + sentence + 2;
      }
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) yield {text: chunk, startOffset: start};
    const next = end - overlap;
    start = next <= start ? end : next;
  }
}
export function chunkTextWithOffsets(text: string, chunkSize: number, chunkOverlap: number): {text: string; startOffset: number}[] {
  return Array.from(textChunkIterator(text, chunkSize, chunkOverlap));
}
function chunkText(text: string, chunkSize: number, chunkOverlap: number): string[] {
  return chunkTextWithOffsets(text, chunkSize, chunkOverlap).map(c => c.text);
}
async function chunkOffsetsAsync(text: string, chunkSize: number, chunkOverlap: number, control?: WorkControl): Promise<{text: string; startOffset: number}[]> {
  await control?.checkpoint();
  const chunks: {text: string; startOffset: number}[] = [];
  for (const chunk of textChunkIterator(text, chunkSize, chunkOverlap)) {
    chunks.push(chunk);
    if (chunks.length % 128 === 0) { await yieldToEventLoop(); await control?.checkpoint(); }
  }
  return chunks;
}
async function chunkTextAsync(text: string, chunkSize: number, chunkOverlap: number, control?: WorkControl): Promise<string[]> {
  await control?.checkpoint();
  const chunks: string[] = [];
  for (const chunk of textChunkIterator(text, chunkSize, chunkOverlap)) {
    chunks.push(chunk.text);
    if (chunks.length % 128 === 0) { await yieldToEventLoop(); await control?.checkpoint(); }
  }
  return chunks;
}
async function simpleChecksumAsync(content: string, control?: WorkControl): Promise<string> {
  let hash = 0;
  for (let start = 0; start < content.length; start += 65536) {
    await control?.checkpoint();
    const end = Math.min(content.length, start + 65536);
    for (let i = start; i < end; i++) hash = (((hash << 5) - hash) + content.charCodeAt(i)) | 0;
    await yieldToEventLoop();
  }
  return hash.toString(36);
}

// Simple string checksum using hash
function simpleChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

// Cosine similarity between a number array and a Float32Array subarray
function cosineSimilarity(a: number[], b: Float32Array): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dotProduct / denom;
}

/** Multimodal file reference from RAG search (to be loaded by caller and passed to LLM) */
export interface RagMediaReference {
  filePath: string;
  contentType: RagContentType;
  pageLabel?: string;  // e.g. "pages 1-6 of 24" for PDF page extraction
  /** True when the indexed chunk is only a Gemini-native PDF label, not extracted text. */
  needsTextFallback?: boolean;
}

export interface LocalRagResult {
  context: string;
  sources: string[];
  /** Non-text files that should be attached to the LLM call for content-based answering */
  mediaReferences: RagMediaReference[];
}

/**
 * Raw chunk search against a local RAG index. `searchLocalRag` formats these
 * into a system-prompt block; the rag_search tool needs the chunks themselves.
 */
export async function searchLocalRagResults(
  settingName: string,
  query: string,
  ragSetting: import("src/types").RagSetting,
  _fallbackApiKey: string,
  proxyUrl?: string,
  proxyBypass?: string,
  topK?: number,
  settings?: Pick<LlmHubSettings, "apiProviders" | "proxyUrl" | "proxyBypass" | "jevRagFilterEnabled" | "jevApiKey" | "jevUseOpenRouter">,
  signal?: AbortSignal,
  authorize?: AuthorizeRagDestination,
): Promise<LocalRagSearchResult[]> {
  if (signal?.aborted) throw cancellationError();
  const store = getLocalRagStore();
  const connection = resolveEmbeddingConnection(ragSetting, settings);
  if (!store || (!ragSetting.sourceRagSettings.length && connection.status !== 'ready')) return [];
  const results = await store.search(
    settingName, query, connection.apiKey,
    ragSetting.embeddingModel || (ragSetting.embeddingBaseUrl ? "" : DEFAULT_GEMINI_EMBEDDING_MODEL),
    topK ?? ragSetting.topK,
    ragSetting.embeddingBaseUrl || undefined,
    ragSetting.scoreThreshold ?? DEFAULT_RAG_SETTING.scoreThreshold,
    ragSetting.searchFileExtensions,
    proxyUrl, proxyBypass, signal, undefined, settings, authorize,
  );
  if (!settings?.jevRagFilterEnabled) return results;
  const openRouterKey = getOpenRouterApiKey(settings.apiProviders);
  const useOpenRouter = settings.jevUseOpenRouter && openRouterKey.length > 0;
  const key = useOpenRouter ? openRouterKey : settings.jevApiKey;
  if (key && results.length && authorize && !await authorize('rerank', useOpenRouter ? OPENROUTER_DECISIONS_URL : TYPESAFE_DECISIONS_URL, settingName, 'JEV')) {
    throw cancellationError();
  }
  return filterRagResultsWithJev(
    query, results, key, settings.proxyUrl, settings.proxyBypass, undefined, useOpenRouter, signal,
  );
}

export async function searchLocalRag(
  settingName: string,
  query: string,
  ragSetting: import("src/types").RagSetting,
  fallbackApiKey: string,
  proxyUrl?: string,
  proxyBypass?: string,
  settings?: Pick<LlmHubSettings, "apiProviders" | "proxyUrl" | "proxyBypass" | "jevRagFilterEnabled" | "jevApiKey" | "jevUseOpenRouter">,
): Promise<LocalRagResult> {
  const results = await searchLocalRagResults(
    settingName, query, ragSetting, fallbackApiKey, proxyUrl, proxyBypass, undefined, settings,
  );
  if (results.length === 0) {
    return { context: "", sources: [], mediaReferences: [] };
  }

  // Collect non-text file references for multimodal attachment
  const mediaReferences: RagMediaReference[] = results
    .filter(r => r.contentType && r.contentType !== "text")
    .map(r => ({
      filePath: r.filePath,
      contentType: r.contentType!,
      pageLabel: r.pageLabel,
      needsTextFallback: r.contentType === "pdf" && /^\[Pdf:/i.test(r.text.trim()),
    }));

  return {
    context: buildLocalRagContext(results),
    sources: [...new Set(results.map(r => r.filePath))],
    mediaReferences,
  };
}

/**
 * Load RAG media references from vault and convert to Attachment objects.
 * Used by Chat.tsx and workflow command.ts to pass actual file data to the LLM.
 */
export async function loadRagMediaAttachments(
  app: App,
  mediaReferences: RagMediaReference[],
): Promise<import("src/types").Attachment[]> {
  const attachments: import("src/types").Attachment[] = [];

  for (const ref of mediaReferences) {
    try {
      const isAbsolute = ref.filePath.startsWith("/") || /^[A-Z]:\\/i.test(ref.filePath);
      let pdfBytes: Uint8Array | null = null;
      let fileName: string;
      let mimeType: string | null = null;

      if (isAbsolute) {
        // External RAG: read from filesystem using Node.js fs
        const fs = (window as { require?: (id: string) => { promises: { readFile: (p: string) => Promise<Buffer> } } }).require?.("fs");
        const nodePath = (window as { require?: (id: string) => { basename: (p: string) => string; extname: (p: string) => string } }).require?.("path");
        if (!fs || !nodePath) continue;

        const buffer = await fs.promises.readFile(ref.filePath);
        const ext = nodePath.extname(ref.filePath).slice(1).toLowerCase();
        mimeType = extensionToMimeType(ext);
        if (!mimeType) continue;
        fileName = nodePath.basename(ref.filePath);

        if (ref.contentType === "pdf" && ref.pageLabel) {
          pdfBytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        } else {
          attachments.push({
            name: fileName,
            type: ref.contentType,
            mimeType,
            data: arrayBufferToBase64(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer),
          });
          continue;
        }
      } else {
        // Vault-relative path: use Obsidian API
        const file = app.vault.getAbstractFileByPath(ref.filePath);
        if (!(file instanceof TFile)) continue;

        mimeType = extensionToMimeType(file.extension);
        if (!mimeType) continue;
        fileName = file.name;

        if (ref.contentType === "pdf" && ref.pageLabel) {
          const buffer = await app.vault.readBinary(file);
          pdfBytes = new Uint8Array(buffer);
        } else {
          const buffer = await app.vault.readBinary(file);
          attachments.push({
            name: file.name,
            type: ref.contentType,
            mimeType,
            data: arrayBufferToBase64(buffer),
          });
          continue;
        }
      }

      // Extract specific pages from PDF using pageLabel
      if (pdfBytes && ref.pageLabel) {
        const pageRange = parsePageLabel(ref.pageLabel);
        if (pageRange) {
          try {
            const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
            const chunkDoc = await PDFDocument.create();
            const indices = Array.from(
              { length: pageRange.endPage - pageRange.startPage + 1 },
              (_, i) => pageRange.startPage - 1 + i  // Convert 1-based to 0-based
            ).filter(i => i < pdfDoc.getPageCount());
            const pages = await chunkDoc.copyPages(pdfDoc, indices);
            for (const page of pages) chunkDoc.addPage(page);
            const extractedBytes = await chunkDoc.save();
            attachments.push({
              name: fileName,
              type: "pdf",
              mimeType: "application/pdf",
              data: arrayBufferToBase64(extractedBytes.buffer as ArrayBuffer),
            });
          } catch (pdfErr) {
            // PDF page extraction failed (e.g. encrypted PDF) — skip attachment
            // Text content from the index will still be used via buildLocalRagContext()
            console.warn(`PDF page extraction failed for ${ref.filePath}, using text fallback:`, pdfErr);
          }
        }
      }
    } catch (e) {
      console.error(`Failed to load RAG media attachment ${ref.filePath}:`, e);
    }
  }

  return attachments;
}

/**
 * Text fallback for RAG PDF hits on providers that cannot take a PDF attachment.
 * An index built with Gemini-native multimodal embeddings stores only a label
 * ("[Pdf: report.pdf (pages 1-6 of 24)]") as the chunk text, so dropping the
 * attachment without this would leave the model a filename and no content.
 */
export async function buildRagPdfTextContext(
  app: App,
  mediaReferences: RagMediaReference[],
  maxCharsPerFile = 20000,
): Promise<string> {
  const pdfReferences = mediaReferences.filter(
    ref => ref.contentType === "pdf" && ref.needsTextFallback === true,
  );
  if (pdfReferences.length === 0) return "";

  const { extractPdfText } = await import("obsidian-llm-hub-common/vault");
  let context = "";

  type PageRange = { startPage?: number; endPage?: number };
  const byFile = new Map<string, PageRange[]>();
  for (const ref of pdfReferences) {
    const range = ref.pageLabel ? parsePageLabel(ref.pageLabel) : null;
    const ranges = byFile.get(ref.filePath) ?? [];
    ranges.push(range ?? {});
    byFile.set(ref.filePath, ranges);
  }

  for (const [filePath, rawRanges] of byFile) {
    // A whole-document reference subsumes every ranged reference. Otherwise
    // merge overlapping/adjacent page ranges to avoid injecting pages twice.
    const ranges: PageRange[] = rawRanges.some(range => range.startPage == null || range.endPage == null)
      ? [{}]
      : rawRanges
        .map(range => ({ startPage: range.startPage!, endPage: range.endPage! }))
        .sort((a, b) => a.startPage - b.startPage)
        .reduce<Array<{ startPage: number; endPage: number }>>((merged, range) => {
          const previous = merged[merged.length - 1];
          if (previous && range.startPage <= previous.endPage + 1) {
            previous.endPage = Math.max(previous.endPage, range.endPage);
          } else {
            merged.push({ ...range });
          }
          return merged;
        }, []);

    let remaining = maxCharsPerFile;
    for (const range of ranges) {
      if (remaining <= 0) break;
      try {
        const text = await extractPdfText(app, filePath, range.startPage, range.endPage);
        if (!text?.trim()) continue;
        const truncated = text.length > remaining;
        const body = truncated ? text.slice(0, remaining) + "\n... [PDF text truncated]" : text;
        const label = range.startPage != null && range.endPage != null
          ? ` (pages ${range.startPage}-${range.endPage})`
          : "";
        context += `\n[Source: ${filePath}]${label}\n${body}\n`;
        remaining -= Math.min(text.length, remaining);
      } catch (e) {
        console.error(`Failed to extract RAG PDF text for ${filePath}:`, e);
      }
    }
  }

  if (!context) return "";
  return `\n\n--- Extracted PDF text from vault (semantic search) ---\n${context}\n--- End of PDF text ---\n`;
}

/**
 * Extract specific pages from a PDF file and return as an Attachment.
 * Reusable by RagSourceModal for "Attach as PDF" action.
 */
export async function extractPdfPages(
  app: App,
  filePath: string,
  pageLabel: string,
): Promise<import("src/types").Attachment | null> {
  const pageRange = parsePageLabel(pageLabel);
  if (!pageRange) return null;

  let pdfBytes: Uint8Array;
  let fileName: string;

  const isAbsolute = filePath.startsWith("/") || /^[A-Z]:\\/i.test(filePath);
  if (isAbsolute) {
    const fs = (window as { require?: (id: string) => { promises: { readFile: (p: string) => Promise<Buffer> } } }).require?.("fs");
    const nodePath = (window as { require?: (id: string) => { basename: (p: string) => string } }).require?.("path");
    if (!fs || !nodePath) return null;
    const buffer = await fs.promises.readFile(filePath);
    pdfBytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    fileName = nodePath.basename(filePath);
  } else {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return null;
    const buffer = await app.vault.readBinary(file);
    pdfBytes = new Uint8Array(buffer);
    fileName = file.name;
  }

  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const chunkDoc = await PDFDocument.create();
  const indices = Array.from(
    { length: pageRange.endPage - pageRange.startPage + 1 },
    (_, i) => pageRange.startPage - 1 + i,
  ).filter(i => i < pdfDoc.getPageCount());
  const pages = await chunkDoc.copyPages(pdfDoc, indices);
  for (const page of pages) chunkDoc.addPage(page);
  const extractedBytes = await chunkDoc.save();

  return {
    name: `${fileName} (${pageLabel})`,
    type: "pdf",
    mimeType: "application/pdf",
    data: arrayBufferToBase64(extractedBytes.buffer as ArrayBuffer),
  };
}

/** Parse page label like "pages 1-6 of 24" into structured data */
function parsePageLabel(label: string): { startPage: number; endPage: number; totalPages: number } | null {
  const match = label.match(/pages?\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i);
  if (!match) return null;
  return {
    startPage: parseInt(match[1], 10),
    endPage: parseInt(match[2], 10),
    totalPages: parseInt(match[3], 10),
  };
}

// Exported for testing
export { chunkText as _chunkText, chunkTextAsync as _chunkTextAsync, simpleChecksumAsync as _simpleChecksumAsync, cosineSimilarity as _cosineSimilarity, simpleChecksum as _simpleChecksum, shouldIncludeFile as _shouldIncludeFile };

// Singleton
let localRagStoreInstance: LocalRagStore | null = null;

export function getLocalRagStore(): LocalRagStore | null {
  return localRagStoreInstance;
}

export function initLocalRagStore(): LocalRagStore {
  if (!localRagStoreInstance) {
    localRagStoreInstance = new LocalRagStore();
  }
  return localRagStoreInstance;
}

export function resetLocalRagStore(): void {
  localRagStoreInstance = null;
}
export { assertRagSyncReady } from "./ragSyncPreconditions";
export { retrieveGroundedContext } from "./groundedRetrieval";
export { buildGroundedPrompt, attachGroundedEvidence, readGroundedEvidence, inspectGroundedCitations } from "./groundedAnswer";
