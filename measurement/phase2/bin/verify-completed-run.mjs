import { resolve } from "node:path";
import { verifySealedTree } from "./sealed-tree.mjs";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: verify-completed-run.mjs <run-dir>");
const sealed = verifySealedTree(root);
if (!["measurement-side", "measurement-pair"].includes(sealed.completion.kind)) throw new Error("sealed measurement kind is invalid");
console.log(JSON.stringify(sealed.completion));
