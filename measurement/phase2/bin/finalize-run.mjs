import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { finalizeSealedTree } from "./sealed-tree.mjs";

const fail = (message) => { throw new Error(message); };
const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) fail(`--${name} is required`);
  return process.argv[index + 1];
};
const root = resolve(arg("dir"));
const side = arg("side");
const pairId = arg("pair-id");
const sealed = finalizeSealedTree({
  root,
  completionFields: {
    kind: side === "pair" ? "measurement-pair" : "measurement-side",
    completion_id: randomUUID(),
    pair_id: pairId,
    side,
    completed_at: new Date().toISOString(),
  },
});
console.log(JSON.stringify(sealed.completion));
