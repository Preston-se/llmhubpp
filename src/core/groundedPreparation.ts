import { extractPdfText } from "obsidian-llm-hub-common/vault";
import { retrieveGroundedContext, type GroundedRetrieval, type GroundedRetrievalRequest } from "./groundedRetrieval";
import { buildGroundedPrompt, type GroundedPrompt } from "./groundedAnswer";

export type GroundedPreparation =
  | { status: "ready"; prompt: GroundedPrompt }
  | Exclude<GroundedRetrieval, { status: "success" }>
  | { status: "not-ready"; settingName: string; query: string; reason: "no-readable-text" };

async function waitForPdf(operation: Promise<string | null>, signal?: AbortSignal): Promise<string | null> {
  if (!signal) return operation;
  return await new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener("abort", cancel); reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })); };
    signal.addEventListener("abort", cancel, { once: true });
    operation.then(value => { signal.removeEventListener("abort", cancel); resolve(value); }, error => {
      signal.removeEventListener("abort", cancel); reject(error instanceof Error ? error : new Error(String(error)));
    });
    if (signal.aborted) cancel();
  });
}

export async function prepareGroundedAnswer(request: GroundedRetrievalRequest): Promise<GroundedPreparation> {
  const retrieval = await retrieveGroundedContext(request);
  if (retrieval.status !== "success") return retrieval;
  const results = [...retrieval.results];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.contentType !== "pdf" || !/^\[pdf:[^\]]*\]$/i.test(result.text.trim()) || result.sourceStatus === "missing") continue;
    const pages = result.pageLabel?.match(/pages?\s+(\d+)(?:\s*-\s*(\d+))?/i);
    try {
      const extracted = await waitForPdf(extractPdfText(request.app, result.filePath,
        pages ? Number(pages[1]) : undefined, pages?.[2] ? Number(pages[2]) : undefined), request.signal);
      if (extracted?.trim()) results[index] = { ...result, text: extracted };
    } catch (error) {
      if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        return { status: "cancelled", settingName: retrieval.settingName, query: retrieval.query };
      }
      // A single unreadable PDF does not hide readable excerpts from other sources.
    }
  }
  if (request.signal?.aborted) return { status: "cancelled", settingName: retrieval.settingName, query: retrieval.query };
  try {
    return { status: "ready", prompt: buildGroundedPrompt(request.query, { ...retrieval, results }) };
  } catch {
    return { status: "not-ready", settingName: retrieval.settingName, query: retrieval.query, reason: "no-readable-text" };
  }
}
