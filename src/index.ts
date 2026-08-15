import { loadConfig } from "./config";
import { createPool } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { buildServer } from "./server";
import { startWorker } from "./worker";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);

  // Runs on every boot (idempotent, tracked in schema_migrations) since cloud
  // platforms give no SSH access to run this manually before starting the app.
  await runMigrations(pool);

  const app = buildServer(pool, config);
  // Undefined (not an empty-string key) when ANTHROPIC_API_KEY isn't set —
  // the service must still boot and serve the (scored) mock provider with
  // no LLM credentials configured at all; requesting provider: "llm" then
  // fails gracefully instead (see src/providers/llm).
  const llmConfig = config.ANTHROPIC_API_KEY
    ? { apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL }
    : undefined;
  const worker = startWorker(pool, llmConfig);

  const shutdown = async (): Promise<void> => {
    await worker.stop();
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
