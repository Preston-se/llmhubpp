import { Modal, Setting, type App } from "obsidian";
import { t } from "src/i18n";

export type GroundedRestrictionChoice = "keep" | "once" | "condition" | "off" | "knowledge";

export function chooseGroundedRestriction(app: App, reason: string, conflict = false): Promise<GroundedRestrictionChoice> {
  return new Promise(resolve => {
    new class extends Modal {
      private choice: GroundedRestrictionChoice = "keep";

      onOpen() {
        this.setTitle(t("chat.grounded.restrictionTitle"));
        this.contentEl.createEl("p", { text: reason });
        this.contentEl.createEl("p", { text: t("chat.grounded.draftKept") });
        const actions = new Setting(this.contentEl);
        const add = (choice: GroundedRestrictionChoice, label: Parameters<typeof t>[0]) => {
          actions.addButton(button => button.setButtonText(t(label)).onClick(() => {
            this.choice = choice;
            this.close();
          }));
        };
        if (conflict) add("knowledge", "chat.grounded.useKnowledge");
        add("keep", "chat.grounded.adjust");
        add("once", "chat.grounded.ordinaryOnce");
        if (!conflict) {
          add("condition", "chat.grounded.ordinaryCondition");
          add("off", "chat.grounded.turnOffDefault");
        }
      }

      onClose() {
        this.contentEl.empty();
        resolve(this.choice);
      }
    }(app).open();
  });
}
