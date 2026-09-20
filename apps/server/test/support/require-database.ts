import { requireTestDatabaseUrl } from "../../../../scripts/test-database-config.mjs";

export default function requireDatabase(): void {
  requireTestDatabaseUrl(process.env);
}
