import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Read at runtime (not a TS import) so this stays under `rootDir: src` for
// the build, same pattern as reading migrations/*.sql from dist/db/migrate.js.
function readVersion(): string {
  const pkgPath = join(__dirname, "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

export function registerHealthRoute(app: FastifyInstance): void {
  const version = readVersion();

  app.get("/health", async () => ({
    status: "ok",
    version,
    uptimeSeconds: Math.floor(process.uptime()),
  }));
}
