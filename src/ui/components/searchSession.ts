export interface SearchOwner {
  requestId: number;
  settingName: string;
  query: string;
}

export type SearchStatus = "idle" | "searching" | "results" | "empty" | "not-ready" | "error";

export function shouldApplySearchResponse(current: SearchOwner | null, response: SearchOwner): boolean {
  return current !== null && current.requestId === response.requestId
    && current.settingName === response.settingName && current.query === response.query;
}
