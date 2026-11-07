import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL?.trim();

if (!migrationDatabaseUrl) {
  throw new Error(
    "MIGRATION_DATABASE_URL is required for Drizzle commands. " +
      "Use a dedicated migration role; do not point migrations at the API runtime role.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: migrationDatabaseUrl,
  },
  // Keep Drizzle's migration ledger in the existing public schema. This avoids
  // creating a separate default "drizzle" schema during migration bootstrap.
  // The migration role owns this ledger; default privileges keep it private
  // from PUBLIC and the ordinary application runtime role.
  migrations: {
    schema: "public",
    table: "__drizzle_migrations",
  },
  strict: true,
  verbose: true,
});
