import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import MessageList from "./MessageList";

vi.mock("src/i18n", () => ({ t: (key: string) => key }));
vi.mock("./MessageBubble", () => ({ default: () => null }));

describe("live tool activity", () => {
  it("is visible while the first tool runs before any answer text", () => {
    const props = { messages: [], streamingContent: "", streamingThinking: "", isLoading: true,
      app: {}, toolActivities: [{ id: "turn-1-call-1", callId: "call-1", name: "read_note", status: "running" }],
    } as unknown as ComponentProps<typeof MessageList>;
    const markup = renderToStaticMarkup(createElement(MessageList, props));
    expect(markup).toContain("chat.toolActivity.running");
    expect(markup).toContain("read_note");
  });
});
