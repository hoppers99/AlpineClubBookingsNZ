import "server-only";

/**
 * Server-guarded entry point for the image-library helpers (#731).
 *
 * The implementation lives in `@/lib/image-metadata`, which is pure byte
 * handling with no database access and therefore safe to load anywhere. This
 * module re-exports it behind `server-only` so application code keeps the
 * guard that stops ~700 lines of image parsing being pulled into a client
 * bundle.
 *
 * Import the leaf directly ONLY from code that also runs outside the Next
 * runtime — config transfer and the club-theme writer are reached by the E2E
 * seed scripts under `tsx`, where `server-only` throws on import (#2242).
 */
export * from "@/lib/image-metadata";
