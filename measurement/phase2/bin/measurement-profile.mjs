export const FINAL_SIDE_PARAMETERS = Object.freeze({
  runs: 200,
  warmup: 20,
  cold_runs: 5,
  idle_cycles: 3,
  idle_seconds: 120,
  revalidation_seconds: 305,
  concurrency: 10,
  duration_seconds: 30,
  request_timeout_seconds: 10,
});

export const FINAL_ORCHESTRATION_PROFILE = Object.freeze({
  pair_count: 4,
  maximum_inter_side_gap_seconds: 600,
  maximum_inter_pair_gap_seconds: 600,
  quiet_monitor_interval_seconds: 10,
  pair_quiet_cpu_limit_percent: 20,
  pair_quiet_samples: 5,
  allowed_running_containers: Object.freeze([
    "tacbookings-measure-app-1",
    "tacbookings-measure-caddy-1",
    "tacbookings-measure-mailpit-1",
    "tacbookings-measure-postgres-1",
  ]),
});

export const PROFILE_FINAL = "final-decision";
export const PROFILE_NONFINAL = "nonfinal-test";

const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());
const exactObject = (actual, expected) => canonical(actual) === canonical(expected);

export function classifySideProfile(parameters) {
  return exactObject(parameters, FINAL_SIDE_PARAMETERS) ? PROFILE_FINAL : PROFILE_NONFINAL;
}

export function classifyOrchestrationProfile(profile) {
  const normalized = {
    ...profile,
    allowed_running_containers: [...(profile?.allowed_running_containers ?? [])].sort(),
  };
  return exactObject(normalized, FINAL_ORCHESTRATION_PROFILE) ? PROFILE_FINAL : PROFILE_NONFINAL;
}

export function requireKnownProfile(value) {
  if (![PROFILE_FINAL, PROFILE_NONFINAL].includes(value)) throw new Error(`unknown measurement profile: ${value}`);
  return value;
}

export function assertDeclaredProfile(declared, derived, context) {
  requireKnownProfile(declared);
  if (declared === PROFILE_FINAL && derived !== PROFILE_FINAL) {
    throw new Error(`${context} weakens or changes the reviewed final-decision profile`);
  }
  // A caller may deliberately run the exact numeric shape as a rehearsal. Its
  // explicit nonfinal declaration remains preliminary and can never be
  // upgraded merely because the values happen to match the final profile.
  return declared;
}
