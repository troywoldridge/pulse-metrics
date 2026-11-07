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
  strict: true,
  verbose: true,
});
