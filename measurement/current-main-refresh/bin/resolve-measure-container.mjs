import { spawnSync } from "node:child_process";
import { MEASURE_CONTAINER_DEFINITIONS, validateMeasureContainer } from "../lib/measure-container-identity.mjs";

const service = process.argv[2];
const expected = MEASURE_CONTAINER_DEFINITIONS[service];
if (!expected) throw new Error("usage: resolve-measure-container.mjs app|postgres|caddy|mailpit [--image-id sha256:HEX]");
const imageIndex = process.argv.indexOf("--image-id");
const expectedImage = imageIndex >= 0 ? process.argv[imageIndex + 1] : null;
if (service === "app" && !/^sha256:[a-f0-9]{64}$/.test(expectedImage ?? "")) throw new Error("app resolution requires an immutable --image-id");
if (service !== "app" && expectedImage !== null) throw new Error("--image-id is only valid for app resolution");

const inspect = (type, name) => {
  const result = spawnSync("docker", [type, "inspect", name], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) throw new Error(`cannot inspect expected measurement ${type}: ${name}`);
  const rows = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`expected exactly one ${type} inspection for ${name}`);
  return rows[0];
};
const container = inspect("container", expected.name);
const networkName = "tacbookings-measure_default";
const network = inspect("network", networkName);
process.stdout.write(`${validateMeasureContainer(service, container, network, expectedImage)}\n`);
