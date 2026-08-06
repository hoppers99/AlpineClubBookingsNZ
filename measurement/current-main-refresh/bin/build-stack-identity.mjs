import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const arg = (name) => {
  const value = args.get(`--${name}`);
  if (!value) throw new Error(`--${name} is required`);
  return value;
};
const runRoot = resolve(arg("run-root"));
const checked = (name) => {
  const path = resolve(arg(name));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} is not a regular file`);
  const rel = relative(runRoot, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${name} escapes run root`);
  return { path: rel.split(sep).join("/"), absolute: path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
};
const parse = (entry, label) => {
  try { return JSON.parse(readFileSync(entry.absolute, "utf8")); }
  catch { throw new Error(`${label} is not valid JSON`); }
};
const stage = arg("stage");
if (!new Set(["before", "after"]).has(stage)) throw new Error("stage must be before or after");
const composeProject = arg("compose-project");
const imageId = arg("image-id");
const expectedFingerprint = arg("database-fingerprint");
if (!/^[a-z0-9][a-z0-9_-]+$/.test(composeProject) || !/^sha256:[a-f0-9]{64}$/.test(imageId) || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new Error("expected stack identity is invalid");
const appFile = checked("app");
const postgresFile = checked("postgres");
const serverFile = checked("postgres-server");
const databaseFile = checked("database");
const app = parse(appFile, "app inspect");
const postgres = parse(postgresFile, "Postgres inspect");
const server = parse(serverFile, "Postgres server identity");
const database = parse(databaseFile, "database fingerprint");
const verifyContainer = (value, service) => {
  if (value?.schema_version !== 1 || value.service !== service || !/^[a-f0-9]{64}$/.test(value.container_id ?? "") || !/^sha256:[a-f0-9]{64}$/.test(value.image_id ?? "") || value.compose_project !== composeProject || value.compose_service !== service) throw new Error(`${service} inspect identity is invalid`);
  const network = `${composeProject}_default`;
  if (value.network_mode !== network || !value.networks || !value.networks[network] || typeof value.networks[network].NetworkID !== "string" || !value.networks[network].NetworkID || typeof value.networks[network].IPAddress !== "string" || !value.networks[network].IPAddress) throw new Error(`${service} is not attached to the isolated measurement network`);
};
verifyContainer(app, "app");
verifyContainer(postgres, "postgres");
if (app.image_id !== imageId) throw new Error("app inspect does not match selected immutable image");
const exactPort = (value, containerPort, hostPort) => {
  const bindings = value.ports?.[`${containerPort}/tcp`];
  return Array.isArray(bindings) && bindings.length === 1 && bindings[0]?.HostIp === "127.0.0.1" && bindings[0]?.HostPort === String(hostPort);
};
if (!exactPort(app, 3000, 3003) || !exactPort(postgres, 5432, 5435)) throw new Error("stack ports are not exact loopback measurement bindings");
if (server?.schema_version !== 1 || typeof server.version !== "string" || !server.version || !/^\d+$/.test(server.version_num ?? "") || server.database !== "tacbookings" || server.user !== "tac") throw new Error("Postgres server identity is invalid");
if (database?.schema_version !== 1 || database.logical_fingerprint !== expectedFingerprint) throw new Error("database fingerprint identity is invalid");
writeFileSync(resolve(arg("out")), JSON.stringify({
  schema_version: 1,
  stage,
  compose_project: composeProject,
  image_id: imageId,
  app: { path: appFile.path, sha256: appFile.sha256, container_id: app.container_id },
  postgres: { path: postgresFile.path, sha256: postgresFile.sha256, container_id: postgres.container_id, image_id: postgres.image_id },
  postgres_server: { path: serverFile.path, sha256: serverFile.sha256, version: server.version, version_num: server.version_num, database: server.database, user: server.user },
  database: { path: databaseFile.path, sha256: databaseFile.sha256, logical_fingerprint: database.logical_fingerprint },
  verified: true,
  captured_at: new Date().toISOString(),
}, null, 2) + "\n", { flag: "wx" });
