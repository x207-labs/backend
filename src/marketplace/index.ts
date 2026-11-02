import type Database from "better-sqlite3";
import { migrate } from "../db/migrate.js";
import type { Route } from "../api/router.js";
import { intentRoutes } from "./intents.js";
import { listingRoutes } from "./listings.js";
import { MARKETPLACE_MIGRATIONS } from "./migrations.js";

/** Terapkan tabel M11 lalu kembalikan route marketplace; dipasang lewat `extraRoutes` server. */
export function marketplaceRoutes(db: Database.Database): Route[] {
  migrate(db, MARKETPLACE_MIGRATIONS);
  return [...intentRoutes, ...listingRoutes()];
}
