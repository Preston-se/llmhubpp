import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESIRED_VAULT_TOOL_MODE,
  resolveVaultToolModePolicy,
} from "./vaultToolModePolicy";

describe("vaultToolModePolicy", () => {
  it("defaults new chat safety intent to readOnly", () => {
    expect(DEFAULT_DESIRED_VAULT_TOOL_MODE).toBe("readOnly");
  });

  it("keeps readOnly for a normal tools-capable model", () => {
    expect(
      resolveVaultToolModePolicy({
        desiredMode: "readOnly",
        restrictedByModel: false,
        gemmaSearchConflict: false,
      }),
    ).toEqual({
      effectiveMode: "readOnly",
      noneReason: null,
    });
  });

  it("preserves an explicit All preference for a normal model", () => {
    expect(
      resolveVaultToolModePolicy({
        desiredMode: "all",
        restrictedByModel: false,
        gemmaSearchConflict: false,
      }),
    ).toEqual({
      effectiveMode: "all",
      noneReason: null,
    });
  });

  it("preserves noSearch for a normal model", () => {
    expect(
      resolveVaultToolModePolicy({
        desiredMode: "noSearch",
        restrictedByModel: false,
        gemmaSearchConflict: false,
      }),
    ).toEqual({
      effectiveMode: "noSearch",
      noneReason: null,
    });
  });

  it("preserves an explicit Off preference for a normal model", () => {
    expect(
      resolveVaultToolModePolicy({
        desiredMode: "none",
        restrictedByModel: false,
        gemmaSearchConflict: false,
      }),
    ).toEqual({
      effectiveMode: "none",
      noneReason: "manual",
    });
  });

  it("forces Off without destroying desired Read Only when model is restricted", () => {
    expect(
      resolveVaultToolModePolicy({
        desiredMode: "readOnly",
        restrictedByModel: true,
        gemmaSearchConflict: false,
      }),
    ).toEqual({
      effectiveMode: "none",
      noneReason: "cli",
    });
  });

  it("forces Off for Gemma search conflict", () => {
    expect(
      resolveVaultToolModePolicy({
        desiredMode: "readOnly",
        restrictedByModel: false,
        gemmaSearchConflict: true,
      }),
    ).toEqual({
      effectiveMode: "none",
      noneReason: "manual",
    });
  });

  it("model capability restriction takes priority over Gemma conflict", () => {
    expect(
      resolveVaultToolModePolicy({
        desiredMode: "all",
        restrictedByModel: true,
        gemmaSearchConflict: true,
      }),
    ).toEqual({
      effectiveMode: "none",
      noneReason: "cli",
    });
  });
});