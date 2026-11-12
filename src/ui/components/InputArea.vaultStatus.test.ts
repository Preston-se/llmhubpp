import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import InputArea from "./InputArea";

vi.mock("src/i18n", () => ({ t: (key: string) => key }));

describe("vault tool status in the chat input", () => {
  it("shows the active mode and allowed folders beside the tool controls", () => {
    vi.stubGlobal("activeDocument", {});
    const props = {
      onSend() {}, isLoading: false, model: "test-model", onModelChange() {},
      availableModels: [], codexModels: [], codexReasoningEffort: "low", onCodexConfigChange() {},
      reasoningEffort: "default", reasoningEffortOptions: [], onReasoningEffortChange() {},
      allowWebSearch: false, webSearchEnabled: false, ragEnabled: false, ragSettings: [],
      selectedRagSetting: null, onSearchSelectionChange() {}, vaultToolMode: "all",
      onVaultToolModeChange() {}, vaultToolModeOnlyNone: false, maxPreviousMessages: 10,
      onMaxPreviousMessagesChange() {}, inputHistory: [], onInputHistoryAdd() {},
      voiceChatSettings: { autoReadAloud: false }, voiceConversation: { active: false },
      onAutoReadAloudChange() {}, onReadAloudRateChange() {}, mcpServers: [], onMcpServerToggle() {},
      slashCommands: [], onSlashCommand() { return ""; }, availableSkills: [], activeSkillPaths: [],
      onToggleSkill() {}, okfBundles: [], activeOkfBundleIds: [], onToggleOkfBundle() {},
      vaultFiles: [], hasSelection: false, app: {},
      vaultToolDiagnostics: {
        desiredMode: "all", effectiveMode: "all", reason: null, proxyReadOnly: false,
        scope: "folders", allowedFolders: ["Study"],
      },
      groundedMode: true, groundedAvailable: true, onGroundedModeChange() {},
    } as unknown as ComponentProps<typeof InputArea>;

    const markup = renderToStaticMarkup(createElement(InputArea, props));
    expect(markup).toContain("input.vaultStatus.title");
    expect(markup).toContain("Study");
    expect(markup).toContain("input.grounded.title");
    expect(markup).toContain("input.grounded.toolsDisabled");
  });
});
