import { describe, expect, it, vi, beforeEach } from "vitest";
import { runGroundedRequest } from "./groundedRequest";

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("./groundedPreparation", () => ({ prepareGroundedAnswer: mocks.prepare }));

describe("grounded request gate", () => {
  beforeEach(() => mocks.prepare.mockReset());

  it("sends the exact prepared evidence to the provider only after retrieval", async () => {
    let finish!: (value: unknown) => void;
    mocks.prepare.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const provider = vi.fn(async () => "answer");
    const pending = runGroundedRequest({ query: "question" } as never, provider);
    expect(provider).not.toHaveBeenCalled();
    const prompt = { systemContext: "source [1]", evidence: { sources: [{ text: "source" }] } };
    finish({ status: "ready", prompt });
    await expect(pending).resolves.toEqual({ status: "answered", value: "answer" });
    expect(provider).toHaveBeenCalledWith(prompt);
  });

  it.each([
    { status: "empty", settingName: "A", query: "question" },
    { status: "not-ready", reason: "index-empty", settingName: "A", query: "question" },
    { status: "error", reason: "embedding-unavailable", settingName: "A", query: "question" },
    { status: "cancelled", settingName: "A", query: "question" },
  ] as const)("does not call the provider for $status", async failure => {
    mocks.prepare.mockResolvedValue(failure);
    const provider = vi.fn();
    await expect(runGroundedRequest({} as never, provider)).resolves.toEqual(failure);
    expect(provider).not.toHaveBeenCalled();
  });

  it("does not send after cancellation races with ready evidence", async () => {
    const controller = new AbortController();
    mocks.prepare.mockImplementation(async () => {
      controller.abort();
      return { status: "ready", prompt: {} };
    });
    const provider = vi.fn();
    const result = await runGroundedRequest({ signal: controller.signal, settingName: "A", query: "q" } as never, provider);
    expect(result).toMatchObject({ status: "cancelled" });
    expect(provider).not.toHaveBeenCalled();
  });
});
