import { describe, expect, it } from "vitest";
import { shouldApplySearchResponse } from "./searchSession";

describe("search request ownership", () => {
  it("accepts only the currently owned library, query, and request", () => {
    const a = { requestId: 1, settingName: "A", query: "term" };
    const b = { requestId: 2, settingName: "B", query: "term" };
    expect(shouldApplySearchResponse(b, a)).toBe(false);
    expect(shouldApplySearchResponse(b, b)).toBe(true);
    expect(shouldApplySearchResponse(null, b)).toBe(false);
    expect(shouldApplySearchResponse({ ...b, query: "other" }, b)).toBe(false);
    expect(shouldApplySearchResponse({ ...b, settingName: "other" }, b)).toBe(false);
  });
});
