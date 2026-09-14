import { open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export function knowledgeFile(path: string) {
  return {
    async readState(): Promise<unknown | null> {
      try { return JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    async writeState(value: unknown): Promise<void> {
      const temporary = path + '.' + randomUUID() + '.tmp';
      const file = await open(temporary, 'wx');
      try { await file.writeFile(JSON.stringify(value) + '\n', 'utf8'); await file.sync(); }
      finally { await file.close(); }
      try { await rename(temporary, path); }
      catch (error) { await rm(temporary, { force: true }); throw error; }
    },
  };
}
