import { getFrontMatterInfo, parseYaml, TFile, type App } from 'obsidian';
const field = 'dsh-note-id';
const valid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(value);
export function vaultNoteIdentity(app: App) {
  const fileAt = (path: string) => { const file = app.vault.getAbstractFileByPath(path); if (!(file instanceof TFile)) throw new Error('笔记不存在'); return file; };
  return {
    async readNoteId(path: string): Promise<string | undefined> {
      const file = fileAt(path), source = await app.vault.cachedRead(file), info = getFrontMatterInfo(source);
      if (!info.exists) return undefined;
      const value = (parseYaml(info.frontmatter) as Record<string, unknown> | undefined)?.[field];
      if (value !== undefined && !valid(value)) throw new Error('笔记中的 dsh-note-id 无效，请核对该属性');
      return value as string | undefined;
    },
    async assignNoteId(path: string, proposed: string): Promise<string> {
      let result = proposed;
      await app.fileManager.processFrontMatter(fileAt(path), frontmatter => {
        if (frontmatter[field] !== undefined) {
          if (!valid(frontmatter[field])) throw new Error('笔记的 dsh-note-id 属性无效');
          result = frontmatter[field];
        } else frontmatter[field] = proposed;
      });
      return result;
    },
    pathsForNoteId(noteId: string): string[] {
      // Native metadata index only: never scan or copy every note's body.
      return app.vault.getMarkdownFiles().filter(file => app.metadataCache.getFileCache(file)?.frontmatter?.[field] === noteId).map(file => file.path);
    },
  };
}
