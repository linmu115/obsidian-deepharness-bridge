import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OPENING_MARKER = "<!-- dsh-reference:";
const ORPHAN_CLOSING_LINE = /^[ \t]*<!-- \/dsh-reference -->[ \t]*(?:\r?\n|$)/gm;

export function removeSingleOrphanReferenceClosingMarker(source) {
  if (source.includes(OPENING_MARKER)) {
    throw new Error("refusing repair because the note contains a dsh-reference opening marker");
  }
  const matches = [...source.matchAll(ORPHAN_CLOSING_LINE)];
  if (matches.length !== 1 || matches[0]?.index === undefined) {
    throw new Error(`expected exactly one orphan dsh-reference closing marker, found ${matches.length}`);
  }
  const match = matches[0];
  return `${source.slice(0, match.index)}${source.slice(match.index + match[0].length)}`;
}

export async function repairOrphanReferenceClosingMarker(notePath, backupRoot) {
  const resolvedNotePath = resolve(notePath);
  const before = await readFile(resolvedNotePath, "utf8");
  const after = removeSingleOrphanReferenceClosingMarker(before);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDirectory = join(resolve(backupRoot), `obsidian-deepharness-bridge-${timestamp}`);
  const backupPath = join(backupDirectory, basename(resolvedNotePath));
  await mkdir(backupDirectory, { recursive: true });
  await copyFile(resolvedNotePath, backupPath);
  try {
    await writeFile(resolvedNotePath, after, "utf8");
    const verified = await readFile(resolvedNotePath, "utf8");
    if (verified !== after) throw new Error("repaired note verification failed");
  } catch (error) {
    await copyFile(backupPath, resolvedNotePath);
    throw error;
  }
  return { notePath: resolvedNotePath, backupPath, removedMarkers: 1 };
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entryPath === import.meta.url) {
  const notePath = process.argv[2];
  const backupRoot = process.argv[3] ?? join(dirname(notePath ?? "."), ".dsh-reference-repair-backups");
  if (!notePath) throw new Error("usage: node repair-orphan-reference-marker.mjs <note-path> [backup-root]");
  const result = await repairOrphanReferenceClosingMarker(notePath, backupRoot);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
