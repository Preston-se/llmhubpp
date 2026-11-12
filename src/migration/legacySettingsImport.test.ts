import { describe, expect, it } from "vitest";
import { prepareLegacySettingsImport } from "./legacySettingsImport";

const source = JSON.stringify({
  workspaceFolder: "CustomWorkspace", credentialStorage: "secretStorage",
  apiProviders: [{ id: "ds", apiKey: "synthetic-private-key" }],
  enabledWorkflowEventTriggers: [{ workflowPath: "workflows/custom.md" }],
  enabledWorkflowHotkeys: ["workflows/custom.md"],
  slashCommands: [{ name: "custom", prompt: "keep exact" }],
  unknownFutureOption: { custom: true },
});
describe("legacy settings import preparation", () => {
  it("preserves all settings, workflows and unknown fields exactly", () => {
    const result = prepareLegacySettingsImport(source, null).confirm(source, null);
    expect(result.settingsText).toBe(source);
    expect(result.previousSettingsText).toBeNull();
    expect(result.requiresRestart).toBe(true);
  });
  it("retains the exact previous destination for backup or rollback", () => {
    const target = '{ "workspaceFolder": "NewWorkspace", "custom": 123 }';
    expect(prepareLegacySettingsImport(source, target).confirm(source, target).previousSettingsText).toBe(target);
  });
  it("exposes a credential-free summary without serializing private settings", () => {
    const plan = prepareLegacySettingsImport(source, null);
    expect(plan.summary).toMatchObject({ apiProviders: 1, workflowTriggers: 1, workflowHotkeys: 1, slashCommands: 1, destinationExists: false, reusesWorkspace: true, usesDeviceSecrets: true });
    expect(JSON.stringify(plan)).not.toContain("synthetic-private-key");
    expect(JSON.stringify(plan)).not.toContain("unknownFutureOption");
  });
  it("allows cancellation with no payload or writes", () => {
    const plan = prepareLegacySettingsImport(source, null);
    expect(Object.keys(plan).sort()).toEqual(["confirm", "summary"]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.summary)).toBe(true);
  });
  it("refuses confirmation after the source changes", () => {
    expect(() => prepareLegacySettingsImport(source, null).confirm("{}", null)).toThrow(/changed/);
  });
  it("refuses confirmation after the destination changes", () => {
    expect(() => prepareLegacySettingsImport(source, null).confirm(source, "{}")).toThrow(/changed/);
  });
  it.each(["[]", "null", '"text"', "123", "not-json"])("rejects invalid source root %s with a redacted error", (raw) => {
    expect(() => prepareLegacySettingsImport(raw, null)).toThrow("Invalid legacy settings JSON object");
  });
  it("retains even a corrupt destination for backup without parsing it", () => {
    const target = "corrupt-destination-synthetic";
    expect(prepareLegacySettingsImport(source, target).confirm(source, target).previousSettingsText).toBe(target);
  });
});
