import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readGitTarArchive } from "../lib/git-tar.mjs";
import { selectProducerSourceMembers, verifyLiveProducerSource } from "../lib/producer-source-set.mjs";

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`--${name} is required`);
  return process.argv[index + 1];
};
const revision = arg("producer-source-commit");
const archive = readGitTarArchive(arg("producer-source-archive"), revision);
const selected = selectProducerSourceMembers(archive);
const outIndex = process.argv.indexOf("--out");
const verifyIndex = process.argv.indexOf("--verify-live-root");
if ((outIndex >= 0) === (verifyIndex >= 0)) throw new Error("exactly one of --out or --verify-live-root is required");
if (verifyIndex >= 0) {
  const root = process.argv[verifyIndex + 1];
  if (!root) throw new Error("--verify-live-root is required");
  process.stdout.write(`${JSON.stringify(verifyLiveProducerSource(archive, root))}\n`);
} else {
  writeFileSync(resolve(arg("out")), [
    "# schema_version=1",
    `# producer_source_archive_sha256=${archive.archive_sha256}`,
    `# producer_source_commit=${archive.revision}`,
    ...selected.map((row) => `${row.sha256}  ${row.path}`),
  ].join("\n") + "\n", { flag: "wx" });
}
