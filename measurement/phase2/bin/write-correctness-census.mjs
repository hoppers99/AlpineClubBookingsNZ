import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { correctnessCensus } from "./correctness-contract.mjs";

const runIndex = process.argv.indexOf("--run-id");
const outIndex = process.argv.indexOf("--out");
if (runIndex < 0 || outIndex < 0 || !process.argv[runIndex + 1] || !process.argv[outIndex + 1]) throw new Error("usage: write-correctness-census.mjs --run-id <id> --out <path>");
writeFileSync(resolve(process.argv[outIndex + 1]), `${JSON.stringify(correctnessCensus(process.argv[runIndex + 1]), null, 2)}\n`, { flag: "wx" });
