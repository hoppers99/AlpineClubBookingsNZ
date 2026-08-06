import { lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalRelative, sha256File } from "./correctness-contract.mjs";

const fail = (message) => { throw new Error(message); };
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) fail(`${label} has an invalid schema`);
};
const hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const imageId = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const utc = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && value.endsWith("Z");
const expectedLeafPaths = (stage) => {
  const directory = stage === "before" ? "inputs" : "postcondition-evidence";
  return {
    app: `${directory}/app-container-inspect.json`,
    postgres: `${directory}/postgres-container-inspect.json`,
    postgres_server: `${directory}/postgres-server-version.json`,
    database: `${directory}/database-fingerprint.json`,
    aggregate: `${directory}/stack-identity-${stage}.json`,
  };
};
const readBoundJson = (root, relativePath, checksum, label) => {
  const path = join(root, ...relativePath.split("/"));
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || !hex(checksum) || sha256File(path) !== checksum) fail(`${label} checksum/file binding failed`);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { fail(`${label} is not valid JSON`); }
};
const validateContainer = (value, service, composeProject, selectedImage) => {
  exactKeys(value, ["schema_version", "service", "container_id", "image_id", "compose_project", "compose_service", "network_mode", "networks", "ports"], `${service} projected inspect`);
  const network = `${composeProject}_default`;
  if (value.schema_version !== 1 || value.service !== service || !hex(value.container_id) || !imageId(value.image_id) || value.compose_project !== composeProject || value.compose_service !== service || value.network_mode !== network || (service === "app" && value.image_id !== selectedImage)) fail(`${service} projected inspect identity is invalid`);
  if (!value.networks || Array.isArray(value.networks) || JSON.stringify(Object.keys(value.networks)) !== JSON.stringify([network])) fail(`${service} projected inspect has the wrong network census`);
  const attachment = value.networks[network];
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment) || !hex(attachment.NetworkID) || typeof attachment.IPAddress !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(attachment.IPAddress)) fail(`${service} projected inspect is not attached to the isolated network`);
  const [containerPort, hostPort] = service === "app" ? ["3000/tcp", "3003"] : ["5432/tcp", "5435"];
  if (!value.ports || Array.isArray(value.ports) || JSON.stringify(Object.keys(value.ports)) !== JSON.stringify([containerPort])) fail(`${service} projected inspect has the wrong published-port census`);
  const bindings = value.ports[containerPort];
  if (!Array.isArray(bindings) || bindings.length !== 1 || bindings[0]?.HostIp !== "127.0.0.1" || bindings[0]?.HostPort !== hostPort || JSON.stringify(Object.keys(bindings[0]).sort()) !== JSON.stringify(["HostIp", "HostPort"])) fail(`${service} is not bound to the exact loopback measurement port`);
  return { container_id: value.container_id, image_id: value.image_id, network_id: attachment.NetworkID, ip_address: attachment.IPAddress, port: `${bindings[0].HostIp}:${bindings[0].HostPort}` };
};

export function verifyStackIdentity(root, aggregateRelativePath, { stage, imageId: selectedImage, composeProject, databaseFingerprint }) {
  const paths = expectedLeafPaths(stage);
  if (canonicalRelative(aggregateRelativePath, "stack identity aggregate") !== paths.aggregate) fail(`${stage} stack identity aggregate path is not exact`);
  const aggregatePath = join(root, ...paths.aggregate.split("/"));
  if (lstatSync(aggregatePath).isSymbolicLink() || !statSync(aggregatePath).isFile()) fail(`${stage} stack identity aggregate is not a regular file`);
  const aggregate = JSON.parse(readFileSync(aggregatePath, "utf8"));
  exactKeys(aggregate, ["schema_version", "stage", "compose_project", "image_id", "app", "postgres", "postgres_server", "database", "verified", "captured_at"], `${stage} stack identity`);
  for (const key of ["app", "postgres", "postgres_server", "database"]) {
    const expected = key === "postgres_server" ? ["path", "sha256", "version", "version_num", "database", "user"] : key === "postgres" ? ["path", "sha256", "container_id", "image_id"] : key === "app" ? ["path", "sha256", "container_id"] : ["path", "sha256", "logical_fingerprint"];
    exactKeys(aggregate[key], expected, `${stage} stack identity ${key}`);
    if (canonicalRelative(aggregate[key].path, `${stage} ${key} path`) !== paths[key]) fail(`${stage} stack identity ${key} path is not exact`);
  }
  if (aggregate.schema_version !== 1 || aggregate.stage !== stage || aggregate.compose_project !== composeProject || aggregate.image_id !== selectedImage || aggregate.verified !== true || !utc(aggregate.captured_at)) fail(`${stage} stack identity aggregate is invalid`);
  const app = readBoundJson(root, aggregate.app.path, aggregate.app.sha256, `${stage} app inspect`);
  const postgres = readBoundJson(root, aggregate.postgres.path, aggregate.postgres.sha256, `${stage} Postgres inspect`);
  const server = readBoundJson(root, aggregate.postgres_server.path, aggregate.postgres_server.sha256, `${stage} Postgres server`);
  const database = readBoundJson(root, aggregate.database.path, aggregate.database.sha256, `${stage} database fingerprint`);
  const appIdentity = validateContainer(app, "app", composeProject, selectedImage);
  const postgresIdentity = validateContainer(postgres, "postgres", composeProject, selectedImage);
  exactKeys(server, ["schema_version", "version", "version_num", "database", "user"], `${stage} Postgres server`);
  if (server.schema_version !== 1 || typeof server.version !== "string" || !/^16(?:\.|$)/.test(server.version) || !/^16\d{4}$/.test(server.version_num ?? "") || server.database !== "tacbookings" || server.user !== "tac") fail(`${stage} Postgres server is not the reviewed v16 isolated database`);
  exactKeys(database, ["schema_version", "logical_fingerprint"], `${stage} database fingerprint`);
  if (database.schema_version !== 1 || database.logical_fingerprint !== databaseFingerprint || !hex(database.logical_fingerprint)) fail(`${stage} database fingerprint is unbound`);
  if (aggregate.app.container_id !== appIdentity.container_id || aggregate.postgres.container_id !== postgresIdentity.container_id || aggregate.postgres.image_id !== postgresIdentity.image_id || aggregate.postgres_server.version !== server.version || aggregate.postgres_server.version_num !== server.version_num || aggregate.postgres_server.database !== server.database || aggregate.postgres_server.user !== server.user || aggregate.database.logical_fingerprint !== database.logical_fingerprint) fail(`${stage} stack identity claims differ from the independently parsed leaves`);
  return { aggregate, aggregate_sha256: sha256File(aggregatePath), app: appIdentity, postgres: postgresIdentity, postgres_server: server, database };
}

export function compareStackIdentities(before, after) {
  if (before.aggregate.compose_project !== after.aggregate.compose_project || before.aggregate.image_id !== after.aggregate.image_id || before.app.image_id !== after.app.image_id || before.postgres.image_id !== after.postgres.image_id || before.postgres.container_id !== after.postgres.container_id || before.postgres_server.version !== after.postgres_server.version || before.postgres_server.version_num !== after.postgres_server.version_num || before.database.logical_fingerprint !== after.database.logical_fingerprint) fail("before/after correctness stack identities differ semantically");
  return true;
}
