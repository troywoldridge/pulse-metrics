import "dotenv/config";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type PulseDatabase = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let database: PulseDatabase | undefined;

function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();

  if (!value) {
    throw new Error(
      "DATABASE_URL is required before Pulse Metrics can access PostgreSQL. " +
        "Copy .env.example to .env and configure a dedicated database role.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres:// or postgresql:// scheme.");
  }

  if (process.env.NODE_ENV === "production") {
    const sslMode = parsed.searchParams.get("sslmode");
    if (sslMode !== "verify-full") {
      throw new Error(
        "Production DATABASE_URL must include sslmode=verify-full. " +
          "Use a trusted database certificate and hostname.",
      );
    }
  }

  return value;
}

/**
 * Create the pool only when a database operation is first requested. This
 * lets frontend-only development and build commands run without PostgreSQL.
 */
export function getDatabase(): PulseDatabase {
  if (database) return database;

  const connectionString = requiredDatabaseUrl();

  pool = new Pool({
    connectionString,
    max: Number.parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    application_name: "pulse-metrics-api",
  });

  pool.on("error", (error: Error) => {
    // Never log connection strings or credentials.
    console.error("[database] Unexpected idle client error:", error.message);
  });

  database = drizzle(pool, { schema });
  return database;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    const activePool = pool;
    pool = undefined;
    database = undefined;
    await activePool.end();
  }
}
