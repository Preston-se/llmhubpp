import { Modal, Setting, type App } from 'obsidian';
import type { ProtectionException } from 'src/core/requestProtectionChoices';

const explanations: Record<string, string> = {
  'delegated-service': 'OpenCode 服务可以自行调用远端模型、联网或使用工具。即使服务位于本机，插件也无法确认它后续的数据去向和最终费用。',
  'attachment-redaction': '文字规则可以处理文字，音视频、图片和文档附件仍会原样发送。',
  'hosted-search': '服务生成的联网查询词无法逐词检查，搜索费用上限也无法由插件保证。',
  'remote-history': '远端保存的会话历史长度未知，插件无法为输入费用可靠预留。',
  'output-bound': '此接口无法由插件可靠限制最大输出，因此无法保证这类请求的费用上限。',
  'unknown-payload': '此接口使用无法可靠检查的二进制或未知请求结构。',
};
const knowledgeExplanations: Record<string, string> = {
  'knowledge-index': '嵌入服务会收到此知识库范围内的笔记内容，以生成索引向量。',
  'knowledge-query': '嵌入服务会收到当前问题，以查找相关笔记。',
  'knowledge-rerank': '重排服务会收到当前问题和检索到的笔记摘录。',
  'knowledge-answer': '回答模型会收到当前问题和检索到的笔记摘录。',
};

export class RequestProtectionModal extends Modal {
  private resolve?: (choice: boolean | undefined) => void;
  constructor(app: App, private readonly exceptionScope: ProtectionException) { super(app); }
  openAndWait(): Promise<boolean | undefined> {
    return new Promise(resolve => { this.resolve = resolve; this.open(); });
  }
  onOpen(): void {
    const knowledge = knowledgeExplanations[this.exceptionScope.reason];
    this.setTitle(knowledge ? '允许向此服务发送知识库资料？' : '此调用的保护范围有限');
    this.contentEl.createEl('p', { text: this.exceptionScope.origin + ' · ' + this.exceptionScope.model });
    this.contentEl.createEl('p', { text: knowledge ?? explanations[this.exceptionScope.reason] ?? '插件无法完整保证当前选择的发送或费用保护。' });
    this.contentEl.createEl('p', { text: '允许后将沿用该服务、模型和当前保护设置下的选择。你可以在“用量、预算与发送隐私”中重置选择。' });
    this.contentEl.createEl('p', { text: knowledge ? '发送仍受当前的隐私和预算设置约束。' : this.exceptionScope.reason === 'attachment-redaction'
      ? '此选择仅允许附件原样发送，已有费用限制继续生效。费用范围另有限制时会单独说明。'
      : '此选择允许费用范围有限的调用，费用标为未知，单独列在硬预算管控范围之外。' });
    const decide = (choice: boolean) => { this.resolve?.(choice); this.resolve = undefined; this.close(); };
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText('阻止并记住').onClick(() => decide(false)))
      .addButton(button => button.setButtonText('允许并记住').onClick(() => decide(true)));
  }
  onClose(): void { this.resolve?.(undefined); this.resolve = undefined; this.contentEl.empty(); }
}
