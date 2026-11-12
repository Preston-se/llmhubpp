import { expect, it } from "vitest";
import { captureSettingsViewState, restoreSettingsViewState } from "./settingsViewState";

it("restores expansion, focus, selection and scroll after a settings control triggers a rerender", () => {
  let focused = false;
  const before = { open: true, dataset: {}, selectionStart: 2, selectionEnd: 4 };
  const after = { open: false, dataset: {}, selectionStart: 0, selectionEnd: 0, focus: () => { focused = true; }, setSelectionRange: (a: number, b: number) => { after.selectionStart = a; after.selectionEnd = b; } };
  const root = (node: object, scroll: number) => ({ scrollTop: scroll, ownerDocument: { activeElement: node },
    querySelectorAll: (selector: string) => selector === "details" ? [node] : [node] });
  const saved = captureSettingsViewState(root(before, 126) as never);
  const next = root(after, 0); restoreSettingsViewState(next as never, saved);
  expect(after.open).toBe(true); expect(focused).toBe(true); expect(after.selectionStart).toBe(2); expect(next.scrollTop).toBe(126);
});
it("restores the actual settings page scroller rather than only the inner control container", () => {
  const scroll = { scrollTop: 222 };
  const root = { scrollTop: 0, ownerDocument: { activeElement: null }, querySelectorAll: () => [], closest: () => scroll };
  const saved = captureSettingsViewState(root as never); scroll.scrollTop = 0;
  restoreSettingsViewState(root as never, saved); expect(scroll.scrollTop).toBe(222);
});
