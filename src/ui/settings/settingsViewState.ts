export interface SettingsViewState { details: boolean[]; focusIndex: number; focusIdentity?: string; selection?: [number, number]; scrollTop: number }
const CONTROLS = "input, textarea, select, button";
function controlIdentity(element: HTMLElement): string {
  return `${element.tagName ?? ""}/${element.getAttribute?.("type") ?? ""}/${element.closest?.(".setting-item")?.querySelector(".setting-item-name")?.textContent ?? ""}`;
}
function pageScroller(root: HTMLElement): HTMLElement { return root.closest?.<HTMLElement>(".vertical-tab-content, .setting-tab-content, .settings-content") ?? root; }
export function captureSettingsViewState(root: HTMLElement): SettingsViewState {
  const controls = Array.from(root.querySelectorAll<HTMLElement>(CONTROLS));
  const active = root.ownerDocument.activeElement as HTMLInputElement | null;
  const focusIndex = controls.indexOf(active as HTMLElement);
  return { details: Array.from(root.querySelectorAll<HTMLDetailsElement>("details")).map(detail => detail.open), focusIndex,
    ...(focusIndex >= 0 && active ? { focusIdentity: controlIdentity(active) } : {}),
    ...(focusIndex >= 0 && active && typeof active.selectionStart === "number" && typeof active.selectionEnd === "number" ? { selection: [active.selectionStart, active.selectionEnd] as [number, number] } : {}), scrollTop: pageScroller(root).scrollTop };
}
export function restoreSettingsViewState(root: HTMLElement, state: SettingsViewState): void {
  Array.from(root.querySelectorAll<HTMLDetailsElement>("details")).forEach((detail, i) => { if (i < state.details.length) detail.open = state.details[i]; });
  const active = root.querySelectorAll<HTMLInputElement>(CONTROLS)[state.focusIndex];
  if (active && (!state.focusIdentity || state.focusIdentity === controlIdentity(active))) {
    active.focus({ preventScroll: true });
    if (state.selection) try { active.setSelectionRange(...state.selection); } catch { /* non-text control */ }
  }
  pageScroller(root).scrollTop = state.scrollTop;
}
