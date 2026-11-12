import { prepareGroundedAnswer, type GroundedPreparation } from "./groundedPreparation";
import type { GroundedRetrievalRequest } from "./groundedRetrieval";
import type { GroundedPrompt } from "./groundedAnswer";

/** The provider callback cannot run until this turn has actual readable evidence. */
export async function runGroundedRequest<T>(
  request: GroundedRetrievalRequest,
  send: (prompt: GroundedPrompt) => Promise<T>,
): Promise<{ status: "answered"; value: T } | Exclude<GroundedPreparation, { status: "ready" }>> {
  const prepared = await prepareGroundedAnswer(request);
  if (prepared.status !== "ready") return prepared;
  if (request.signal?.aborted) return { status: "cancelled", settingName: request.settingName, query: request.query };
  return { status: "answered", value: await send(prepared.prompt) };
}
