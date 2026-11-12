import { describe, expect, it, vi } from "vitest";

const root = vi.hoisted(() => ({ render: vi.fn(), unmount: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: () => root }));
vi.mock("./components/TabContainer", () => ({ default: () => null }));
import { ChatView } from "./ChatView";

describe("reading actions while the panel mounts", () => {
  it("delivers actions queued before the React tab container is ready", async () => {
    const searchReading = vi.fn(); const askReading = vi.fn();
    root.render.mockImplementation(element => element.ref({ searchReading, askReading }));
    const view = new ChatView({} as never, { clearSelectionHighlight: vi.fn() } as never);
    (view as any).containerEl = { addClass: vi.fn(), children: [null, { empty: vi.fn(), addClass: vi.fn() }] };
    const context = { filePath: "学习/笔记.md", selection: "选区" } as never;
    view.searchReading(context); view.askReading(context, true);
    expect(searchReading).not.toHaveBeenCalled();
    await view.onOpen();
    expect(searchReading).toHaveBeenCalledWith(context);
    expect(askReading).toHaveBeenCalledWith(context, true);
    view.askReading(context, false);
    expect(askReading).toHaveBeenLastCalledWith(context, false);
  });
});
