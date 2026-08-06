import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const localHost = (value) => value === "127.0.0.1" || value === "localhost";

export function validateLocalOrigin(value, label, exact = null) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} is not a valid URL`); }
  if (parsed.protocol !== "http:" || !localHost(parsed.hostname) || parsed.username || parsed.password || parsed.origin !== value) {
    throw new Error(`${label} must be an exact credential-free loopback HTTP origin`);
  }
  if (exact !== null && value !== exact) throw new Error(`${label} must equal ${exact}`);
  return parsed;
}

export function validateLocalAuthState(inputPath) {
  if (!isAbsolute(inputPath)) throw new Error("auth state must be an absolute path");
  const path = resolve(inputPath);
  const stat = lstatSync(path);
  const real = realpathSync(path);
  const same = process.platform === "win32" ? real.toLowerCase() === path.toLowerCase() : real === path;
  if (!stat.isFile() || stat.isSymbolicLink() || !same) throw new Error("auth state must be a canonical regular file");
  const document = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(document?.cookies) || !Array.isArray(document?.origins)) throw new Error("auth state is not a Playwright storage-state object");
  for (const cookie of document.cookies) {
    const domain = typeof cookie?.domain === "string" ? cookie.domain.replace(/^\./, "") : "";
    if (!localHost(domain)) throw new Error(`auth state cookie has a non-loopback domain: ${cookie?.domain ?? "<missing>"}`);
  }
  for (const origin of document.origins) validateLocalOrigin(origin?.origin, "auth state origin");
  return { path, document };
}
