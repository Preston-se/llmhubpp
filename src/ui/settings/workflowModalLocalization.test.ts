import { expect, it } from "vitest";
import { setLocale } from "src/i18n";
import { localizeWorkflowModal } from "./workflowModalLocalization";
it("localizes shared workflow event controls while retaining the user workflow name", () => {
  const nodes = ["Event Triggers: My custom workflow", "File Created", "File pattern (optional)", "Save", "Cancel"].map(textContent => ({ textContent }));
  const root = { querySelectorAll: () => nodes };
  setLocale("en"); localizeWorkflowModal(root as never); expect(nodes[0].textContent).toBe("Event Triggers: My custom workflow");
  setLocale("zh"); localizeWorkflowModal(root as never);
  expect(nodes.map(node => node.textContent)).toEqual(["事件触发：My custom workflow", "创建文件", "文件匹配规则（可选）", "保存", "取消"]);
  setLocale("en");
});
