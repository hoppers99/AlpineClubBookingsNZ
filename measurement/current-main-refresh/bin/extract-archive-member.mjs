import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readGitTarArchive } from "../lib/git-tar.mjs";

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`--${name} is required`);
  return process.argv[index + 1];
};
const archive = readGitTarArchive(arg("archive"), arg("commit"));
const memberPath = arg("member");
const member = archive.members.get(memberPath);
if (!member) throw new Error(`archive member is missing: ${memberPath}`);
writeFileSync(resolve(arg("out")), member.bytes, { flag: "wx" });
