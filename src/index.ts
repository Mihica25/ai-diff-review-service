import { loadConfig } from "./config";
import { createPool } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { buildServer } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);

  // Runs on every boot (idempotent, tracked in schema_migrations) since cloud
  // platforms give no SSH access to run this manually before starting the app.
  await runMigrations(pool);

  const app = buildServer(pool, config);

  const shutdown = async (): Promise<void> => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
