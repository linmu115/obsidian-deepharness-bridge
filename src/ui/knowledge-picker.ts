import { Modal, Notice, type App } from 'obsidian';

type Item = { id: string; title: string; logicalSessionId?: string };
export class KnowledgeSessionPicker extends Modal {
  private workspace: Item | undefined;
  private cursor: string | undefined;
  private loading = false;
  private disposed = false;
  private operationId = crypto.randomUUID();
  constructor(app: App, private readonly request: <T>(operation: string, input?: Record<string, unknown>) => Promise<T>, private readonly attach: (session: { logicalSessionId: string; nativeSessionId: string; title: string }) => Promise<void>) { super(app); }
  onOpen(): void { this.setTitle('关联到 DSH 会话'); void this.load(); }
  onClose(): void { this.disposed = true; }
  private async load(after?: string): Promise<void> {
    if (this.loading || this.disposed) return;
    this.loading = true;
    try {
      const page = await this.request<{ items: Item[]; nextCursor?: string }>('directory', { ...(this.workspace ? { workspaceId: this.workspace.id } : {}), ...(after ? { after } : {}) });
      if (this.disposed) return;
      this.cursor = page.nextCursor;
      if (!after) {
        this.contentEl.empty();
        this.contentEl.createEl('p', { text: this.workspace?.title ?? '先选择工作区，再选择会话。链接只建立关系，笔记正文不会自动带入对话。' });
        if (this.workspace) this.contentEl.createEl('button', { text: '← 返回工作区' }).onclick = () => { this.workspace = undefined; void this.load(); };
        const list = this.contentEl.createDiv({ cls: 'dsh-knowledge-picker-list' });
        list.style.cssText = 'max-height:45vh;overflow:auto;display:grid;gap:8px;margin:12px 0';
        list.onscroll = () => { if (this.cursor && list.scrollTop + list.clientHeight >= list.scrollHeight - 60) void this.load(this.cursor); };
        this.contentEl.createEl('button', { text: '新建独立会话并关联', cls: 'mod-cta' }).onclick = () => { void this.choose(); };
      }
      const list = this.contentEl.querySelector<HTMLElement>('.dsh-knowledge-picker-list')!;
      list.querySelector('[data-more]')?.remove();
      for (const item of page.items) list.createEl('button', { text: item.title || '未命名会话' }).onclick = () => {
        if (this.loading) return;
        if (!this.workspace) { this.workspace = item; void this.load(); }
        else void this.choose(item);
      };
      if (this.cursor) { const button = list.createEl('button', { text: '加载更多' }); button.dataset.more = ''; button.onclick = () => { void this.load(this.cursor); }; }
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    finally { this.loading = false; }
  }
  private async choose(item?: Item): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const target = await this.request<{ logicalSessionId: string; nativeSessionId: string; title: string }>(item ? 'resolve' : 'create-session', item ? { logicalSessionId: item.logicalSessionId ?? item.id } : { operationId: this.operationId });
      await this.attach(target); this.close(); new Notice('笔记和会话已关联');
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    finally { this.loading = false; }
  }
}
