import { describe, expect, it, vi } from "vitest";
import * as store from "./localRagStore";
import { TaskManager } from "./taskManager";

describe("RAG sync preconditions", () => {
  it.each([
    [{ storeReady: false, setting: null, embeddingKey: "" }, "store-unavailable"],
    [{ storeReady: true, setting: null, embeddingKey: "" }, "setting-not-found"],
    [{ storeReady: true, setting: { externalIndexPath: "outside", sourceRagSettings: [], embeddingBaseUrl: "" }, embeddingKey: "key" }, "index-not-syncable"],
    [{ storeReady: true, setting: { externalIndexPath: "", sourceRagSettings: ["other"], embeddingBaseUrl: "" }, embeddingKey: "key" }, "index-not-syncable"],
    [{ storeReady: true, setting: { externalIndexPath: "", sourceRagSettings: [], embeddingBaseUrl: "" }, embeddingKey: "" }, "embedding-missing"],
  ])("fails the task before indexing when the precondition is %s", async (input, code) => {
    const validate = (store as unknown as { assertRagSyncReady?: (value: unknown) => void }).assertRagSyncReady;
    const tasks = new TaskManager(); const indexWork = vi.fn();
    await expect(tasks.run("sync", async () => { validate?.(input); indexWork(); })).rejects.toMatchObject({ code });
    expect(indexWork).not.toHaveBeenCalled();
    expect(tasks.list()[0].snapshot.status).toBe("failed");
  });

  it("allows a configured custom embedding endpoint without a key", () => {
    const validate = (store as unknown as { assertRagSyncReady?: (value: unknown) => void }).assertRagSyncReady;
    expect(validate).toBeTypeOf("function");
    expect(() => validate?.({ storeReady: true, setting: { externalIndexPath: "", sourceRagSettings: [], embeddingBaseUrl: "http://127.0.0.1" }, embeddingKey: "" })).not.toThrow();
  });
});
