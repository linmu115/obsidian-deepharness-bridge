import { Modal, Notice, type App } from "obsidian";

export interface ReferenceDetail {
  text: string;
  status: string;
  session: string | undefined;
  source: (() => Promise<void>) | undefined;
}

/** Details are text-only; opening source uses the note editor rather than rewriting reference metadata. */
export class ReferenceDetailsModal extends Modal {
  constructor(app: App, private readonly items: readonly ReferenceDetail[]) { super(app); }
  onOpen(): void {
    this.setTitle("引用详情");
    this.contentEl.addClass("dsh-reference-details");
    if (!this.items.length) this.contentEl.createEl("p", { text: "未找到这段正文对应的引用记录。" });
    for (const item of this.items) {
      const section = this.contentEl.createEl("section");
      section.createEl("p", { text: item.status });
      section.createEl("blockquote", { text: item.text });
      if (item.session) section.createEl("p", { text: `DSH 会话：${item.session}` });
      if (item.source) {
        const button = section.createEl("button", { text: "查看／编辑引用源码" });
        button.onclick = () => { void item.source!().then(() => this.close()).catch(error => new Notice(error instanceof Error ? error.message : String(error))); };
      }
    }
  }
  onClose(): void { this.contentEl.empty(); }
}
