import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { correctnessCensus } from "./correctness-contract.mjs";

const outIndex = process.argv.indexOf("--out");
if (outIndex < 0 || !process.argv[outIndex + 1]) throw new Error("usage: write-correctness-census.mjs --out <path>");
writeFileSync(resolve(process.argv[outIndex + 1]), `${JSON.stringify(correctnessCensus(), null, 2)}\n`, { flag: "wx" });
