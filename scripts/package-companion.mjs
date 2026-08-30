import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "tar";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsRoot = join(sourceRoot, ".artifacts");
const packageJson = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
const outputPath = join(
  artifactsRoot,
  `obsidian-deepharness-bridge-${packageJson.version}.tgz`,
);
const deploymentFiles = [
  "LICENSE",
  "main.js",
  "manifest.json",
  "package.json",
  "README.md",
  "scripts/install-local.ps1",
  "styles.css",
  "versions.json",
];
const binaryFiles = new Set(["main.js"]);

await mkdir(artifactsRoot, { recursive: true });
const stageRoot = await mkdtemp(join(artifactsRoot, ".stage-"));
const packageRoot = join(stageRoot, "package");

try {
  for (const name of deploymentFiles) {
    const sourcePath = join(sourceRoot, name);
    const targetPath = join(packageRoot, name);
    await mkdir(dirname(targetPath), { recursive: true });
    const source = await readFile(sourcePath);
    const payload = binaryFiles.has(name)
      ? source
      : Buffer.from(source.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
    await writeFile(targetPath, payload);
  }

  await create(
    {
      cwd: stageRoot,
      file: outputPath,
      gzip: true,
      noMtime: true,
      portable: true,
    },
    ["package"],
  );

  process.stdout.write(`${relative(sourceRoot, outputPath).split(sep).join("/")}\n`);
} finally {
  const resolvedStage = resolve(stageRoot);
  const resolvedArtifacts = `${resolve(artifactsRoot)}${sep}`;
  if (!resolvedStage.startsWith(resolvedArtifacts)) {
    throw new Error(`refusing to clean unexpected staging directory: ${resolvedStage}`);
  }
  await rm(resolvedStage, { recursive: true, force: true });
}
