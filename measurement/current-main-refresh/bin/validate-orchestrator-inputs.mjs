import { validateLocalAuthState, validateLocalOrigin } from "../lib/local-auth-state.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index], value = process.argv[index + 1];
  if (!name?.startsWith("--") || !value || args.has(name)) throw new Error("orchestrator safety arguments are malformed or duplicated");
  args.set(name, value);
}
const required = (name) => {
  const value = args.get(`--${name}`); if (!value) throw new Error(`--${name} is required`); return value;
};
const exact = (name, expected) => {
  const value = required(name); if (value !== expected) throw new Error(`${name} must equal ${expected}`);
};
const expectedNames = new Set(["--compose-project", "--app-container", "--postgres-container", "--base-url", "--mailpit-url", "--auth-state"]);
if (args.size !== expectedNames.size || [...args.keys()].some((name) => !expectedNames.has(name))) throw new Error("orchestrator safety arguments are not the exact reviewed set");

exact("compose-project", "tacbookings-measure");
exact("app-container", "tacbookings-measure-app-1");
exact("postgres-container", "tacbookings-measure-postgres-1");
validateLocalOrigin(required("base-url"), "base URL", "http://127.0.0.1:8027");
validateLocalOrigin(required("mailpit-url"), "Mailpit URL", "http://127.0.0.1:8127");
validateLocalAuthState(required("auth-state"));
