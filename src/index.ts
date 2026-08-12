import { loadConfig } from "./config";
import { createPool } from "./db/pool";
import { buildServer } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);

  // Fail fast if Postgres isn't reachable rather than binding HTTP first.
  await pool.query("SELECT 1");

  const app = buildServer(pool);

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
