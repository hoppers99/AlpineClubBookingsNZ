export const MEASURE_CONTAINER_DEFINITIONS = {
  app: { name: "tacbookings-measure-app-1", containerPort: "3000/tcp", hostPort: "3003", memory: 1073741824, nanoCpus: 1000000000 },
  postgres: { name: "tacbookings-measure-postgres-1", containerPort: "5432/tcp", hostPort: "5435", configImage: "postgres:16-alpine", memory: 805306368, nanoCpus: 500000000 },
  caddy: { name: "tacbookings-measure-caddy-1", containerPort: "8027/tcp", hostPort: "8027", configImage: "caddy:2-alpine", memory: 134217728, nanoCpus: 200000000 },
  mailpit: { name: "tacbookings-measure-mailpit-1", containerPort: "8025/tcp", hostPort: "8127", configImage: "axllent/mailpit:v1.30.3", memory: 134217728, nanoCpus: 200000000 },
};

export function validateMeasureContainer(service, container, network, expectedImage = null) {
  const expected = MEASURE_CONTAINER_DEFINITIONS[service];
  if (!expected) throw new Error(`unknown measurement service: ${service}`);
  const labels = container?.Config?.Labels ?? {};
  const networkName = "tacbookings-measure_default";
  const networks = container?.NetworkSettings?.Networks ?? {};
  if (container?.Name !== `/${expected.name}` || !/^[a-f0-9]{64}$/.test(container?.Id ?? "") || container?.State?.Running !== true) throw new Error(`${service} is not the exact running measurement container`);
  if (container?.State?.Health && container.State.Health.Status !== "healthy") throw new Error(`${service} is not healthy`);
  if (labels["com.docker.compose.project"] !== "tacbookings-measure" || labels["com.docker.compose.service"] !== service) throw new Error(`${service} Compose identity is invalid`);
  if (container?.HostConfig?.NetworkMode !== networkName || JSON.stringify(Object.keys(networks).sort()) !== JSON.stringify([networkName])) throw new Error(`${service} network set is invalid`);
  if (expected.configImage && container?.Config?.Image !== expected.configImage) throw new Error(`${service} does not use the reviewed fixed image reference`);
  if (container?.HostConfig?.Memory !== expected.memory || container?.HostConfig?.NanoCpus !== expected.nanoCpus) throw new Error(`${service} resource limits differ from the reviewed measurement stack`);
  if (service === "app" && !/^sha256:[a-f0-9]{64}$/.test(expectedImage ?? "")) throw new Error("app validation requires the selected immutable image ID");
  if (service !== "app" && expectedImage !== null) throw new Error("only app validation accepts an image ID");
  if (expectedImage !== null && container?.Image !== expectedImage) throw new Error("app container does not run the selected immutable image");
  const activeBindings = [];
  for (const [containerPort, bindings] of Object.entries(container?.NetworkSettings?.Ports ?? {})) {
    if (bindings === null) continue;
    if (!Array.isArray(bindings)) throw new Error(`${service} port bindings are invalid`);
    for (const binding of bindings) activeBindings.push({ containerPort, hostIp: binding?.HostIp, hostPort: binding?.HostPort });
  }
  if (activeBindings.length !== 1 || activeBindings[0].containerPort !== expected.containerPort || activeBindings[0].hostIp !== "127.0.0.1" || activeBindings[0].hostPort !== expected.hostPort) {
    throw new Error(`${service} does not have the exact loopback-only measurement port binding`);
  }
  if (!/^[a-f0-9]{64}$/.test(network?.Id ?? "") || network?.Labels?.["com.docker.compose.project"] !== "tacbookings-measure" || networks[networkName]?.NetworkID !== network.Id) {
    throw new Error(`${service} is not attached to the exact measurement network identity`);
  }
  return container.Id;
}
