/**
 * The name of the build-time seed for the public website's fixed CSP nonce
 * (#2352 slice-1 review, F3/F9).
 *
 * Its own module so `next.config.ts` and `src/lib/release-nonce.ts` can share the
 * one name without the config file importing anything that reaches Prisma, the
 * logger or `next/server`.
 *
 * The VALUE is produced in `next.config.ts` and substituted into every bundle by
 * Next's DefinePlugin, which is the whole point — see that file for why a build
 * literal is the only fallback that two separately-compiled bundles can agree on.
 * Do not read it through a computed key: a bundler can only replace the literal
 * `process.env.PUBLIC_WEBSITE_NONCE_SEED` form.
 */
export const PUBLIC_WEBSITE_NONCE_SEED_ENV_VAR = "PUBLIC_WEBSITE_NONCE_SEED";
