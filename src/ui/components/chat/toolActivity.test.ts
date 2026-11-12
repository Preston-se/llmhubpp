import { describe, expect, it, vi } from "vitest";
vi.mock("../MessageBubble", () => ({ default: () => null }));
import * as view from "../MessageList";

describe("tool activity events", () => {
  it("tracks multiple calls, correlates results, and cancels only unfinished work", () => {
    const api = view as unknown as {
      applyToolActivityEvent?: (state: any, owner: any, chunk: any) => any;
      cancelToolActivities?: (state: any, owner: any) => any;
    };
    const owner = { sessionId: 1, turnId: 2 };
    let state = { ...owner, items: [] as any[] };
    state = api.applyToolActivityEvent?.(state, owner, { type: "tool_call", toolCall: { id: "a", name: "read_note", args: {} } });
    expect(state?.items).toMatchObject([{ callId: "a", status: "running" }]);
    state = api.applyToolActivityEvent?.(state, owner, { type: "tool_call", toolCall: { id: "b", name: "create_note", args: {} } });
    state = api.applyToolActivityEvent?.(state, owner, { type: "tool_result", toolResult: { toolCallId: "a", result: { success: true } } });
    state = api.applyToolActivityEvent?.(state, owner, { type: "tool_result", toolResult: { toolCallId: "b", result: { error: "denied" } } });
    state = api.applyToolActivityEvent?.(state, owner, { type: "tool_call", toolCall: { id: "c", name: "search_notes", args: {} } });
    state = api.cancelToolActivities?.(state, owner);
    expect(state.items.map((item: any) => item.status)).toEqual(["succeeded", "failed", "cancelled"]);
  });

  it("ignores other sessions or turns and does not treat an absent result as success", () => {
    const api = view as unknown as { applyToolActivityEvent?: (state: any, owner: any, chunk: any) => any };
    const owner = { sessionId: 1, turnId: 3 };
    const call = { type: "tool_call", toolCall: { id: "a", name: "read_note", args: {} } };
    let state = api.applyToolActivityEvent?.({ ...owner, items: [] }, owner, call);
    state = api.applyToolActivityEvent?.(state, { ...owner, sessionId: 2 }, { type: "tool_result", toolResult: { toolCallId: "a", result: { success: true } } });
    state = api.applyToolActivityEvent?.(state, { ...owner, turnId: 4 }, { type: "tool_result", toolResult: { toolCallId: "a", result: { success: true } } });
    state = api.applyToolActivityEvent?.(state, owner, { type: "tool_result", toolResult: { toolCallId: "a", result: undefined } });
    expect(state?.items).toMatchObject([{ callId: "a", status: "running" }]);
  });

  it("does not assert success for an opaque result without an explicit outcome", () => {
    const api = view as unknown as { applyToolActivityEvent?: (state: any, owner: any, chunk: any) => any };
    const owner = { sessionId: 1, turnId: 3 };
    let state = api.applyToolActivityEvent?.({ ...owner, items: [] }, owner,
      { type: "tool_call", toolCall: { id: "a", name: "create_note", args: {} } });
    state = api.applyToolActivityEvent?.(state, owner,
      { type: "tool_result", toolResult: { toolCallId: "a", result: { message: "unknown" } } });
    expect(state?.items).toMatchObject([{ callId: "a", status: "unconfirmed" }]);
  });
});
