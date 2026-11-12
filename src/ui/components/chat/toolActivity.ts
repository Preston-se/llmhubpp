import type { StreamChunk } from "src/types";

export interface ToolActivityOwner { sessionId: number; turnId: number }
export interface ToolActivity {
  id: string;
  callId: string;
  name: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "unconfirmed";
}
export interface ToolActivityState extends ToolActivityOwner { items: ToolActivity[] }

function owns(state: ToolActivityState | null, owner: ToolActivityOwner): state is ToolActivityState {
  return state !== null && state.sessionId === owner.sessionId && state.turnId === owner.turnId;
}

export function applyToolActivityEvent(state: ToolActivityState | null, owner: ToolActivityOwner, chunk: StreamChunk): ToolActivityState | null {
  if (!owns(state, owner)) return state;
  if (chunk.type === "tool_call" && chunk.toolCall) {
    const call = chunk.toolCall;
    return { ...state, items: [...state.items, {
      id: `${owner.turnId}:${state.items.length}:${call.id}`,
      callId: call.id, name: call.name, status: "running",
    }] };
  }
  if (chunk.type !== "tool_result" || !chunk.toolResult || chunk.toolResult.result == null) return state;
  const result = chunk.toolResult.result;
  const failed = result === false || (typeof result === "object" && ("success" in result && result.success === false || "error" in result && Boolean(result.error)));
  const succeeded = result === true || (typeof result === "object" && "success" in result && result.success === true);
  const index = state.items.findIndex(item => item.callId === chunk.toolResult!.toolCallId && item.status === "running");
  if (index < 0) return state;
  return { ...state, items: state.items.map((item, i) => i === index ? { ...item, status: failed ? "failed" : succeeded ? "succeeded" : "unconfirmed" } : item) };
}

export function cancelToolActivities(state: ToolActivityState | null, owner: ToolActivityOwner): ToolActivityState | null {
  if (!owns(state, owner)) return state;
  return { ...state, items: state.items.map(item => item.status === "running" ? { ...item, status: "cancelled" } : item) };
}
