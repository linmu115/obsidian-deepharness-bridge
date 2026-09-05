export type MarkdownLookupKind = "reference" | "sticker" | "block";

/** Rebuildable candidate index. Callers still validate markers in the latest note. */
export class MarkdownLookupIndex {
  private readonly files = new Map<string, Set<string>>();
  private readonly pathsByKey = new Map<string, Set<string>>();
  private readonly dirty = new Set<string>();
  private generation = 0;
  private rebuilding: Promise<void> | undefined;
  private reads = 0;

  constructor(
    private readonly listPaths: () => Promise<readonly string[]>,
    private readonly read: (path: string) => Promise<string | null>,
  ) {}

  invalidate(path?: string): void {
    this.generation += 1;
    if (path === undefined) for (const known of this.files.keys()) this.dirty.add(known);
    else this.dirty.add(path);
  }

  get diagnostics() { return { indexedFiles: this.files.size, dirtyFiles: this.dirty.size, filesRead: this.reads }; }

  private replace(path: string, source: string | null): void {
    for (const key of this.files.get(path) ?? []) {
      const paths = this.pathsByKey.get(key);
      paths?.delete(path);
      if (paths?.size === 0) this.pathsByKey.delete(key);
    }
    this.files.delete(path);
    if (source === null) return;
    const keys = new Set<string>();
    for (const match of source.matchAll(/"(referenceId|citationId|stickerId)"\s*:\s*("(?:\\.|[^"\\])*")/g)) {
      try {
        const id: unknown = JSON.parse(match[2]!);
        if (typeof id === "string") keys.add(`${match[1] === "stickerId" ? "sticker" : "reference"}:${id}`);
      } catch { /* Damaged metadata remains a candidate for explicit repair scans. */ }
    }
    for (const match of source.matchAll(/(?:^|\s)\^([A-Za-z0-9-]+)(?=\s|$)/g)) keys.add(`block:${match[1]}`);
    for (const match of source.matchAll(/obsidian:\/\/deepharness\?[^\s)>\]]+/g)) {
      try {
        const id = new URL(match[0]).searchParams.get("sticker");
        if (id) keys.add(`sticker:${id}`);
      } catch { /* Ignore malformed user links. */ }
    }
    this.files.set(path, keys);
    for (const key of keys) {
      const paths = this.pathsByKey.get(key) ?? new Set<string>();
      paths.add(path);
      this.pathsByKey.set(key, paths);
    }
  }

  private async rebuild(): Promise<void> {
    let started: number;
    let attempts = 0;
    do {
      if (attempts++ === 2) throw new Error("Vault changed continuously during index rebuild");
      started = this.generation;
      const paths = new Set(await this.listPaths());
      for (const path of this.files.keys()) if (!paths.has(path)) this.replace(path, null);
      for (const path of paths) {
        if (this.files.has(path) && !this.dirty.has(path)) continue;
        const beforeRead = this.generation;
        this.reads += 1;
        this.replace(path, await this.read(path));
        if (beforeRead === this.generation) this.dirty.delete(path);
      }
      for (const path of this.dirty) if (!paths.has(path)) this.dirty.delete(path);
    } while (started !== this.generation);
  }

  async find(kind: MarkdownLookupKind, id: string): Promise<readonly string[]> {
    if (!this.rebuilding) {
      const rebuilding = this.rebuild();
      this.rebuilding = rebuilding;
      void rebuilding.finally(() => { if (this.rebuilding === rebuilding) this.rebuilding = undefined; }).catch(() => undefined);
    }
    try {
      await this.rebuilding;
      return [...(this.pathsByKey.get(`${kind}:${id}`) ?? [])];
    } catch {
      // An unavailable/incomplete index must never suppress durable cleanup work.
      return this.listPaths();
    }
  }
}
