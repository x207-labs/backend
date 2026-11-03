import type Database from "better-sqlite3";
import { migrate } from "../db/migrate.js";
import type { ViewFunction } from "../settlement/intents.js";
import { openEpochResolver } from "./epoch.js";
import type { Route } from "../api/router.js";
import { assetClassCheck, assetClassRoutes } from "./asset-classes.js";
import { scopeCheck, type ScopeOptions } from "./listing-scope.js";
import { reputationRoutes } from "./reputation.js";
import { resourceCheck, resourceRoutes } from "./resource-listing.js";
import { bundleRoutes } from "./bundles.js";
import { deliveryRoutes } from "./delivery.js";
import { intentRoutes } from "./intents.js";
import { statsRoutes } from "./stats.js";
import { listingRoutes } from "./listings.js";
import { offerRoutes } from "./offers.js";
import { referralRoutes } from "./referrals.js";
import { MARKETPLACE_MIGRATIONS } from "./migrations.js";

/** Terapkan tabel M11 lalu kembalikan route marketplace; dipasang lewat `extraRoutes` server. */
export function marketplaceRoutes(db: Database.Database, options: { maxRounds?: number; chainView?: ViewFunction; maxReferrals?: number; confirmClasses?: readonly string[]; disputeWindowSeconds?: number } & ScopeOptions = {}): Route[] {
  migrate(db, MARKETPLACE_MIGRATIONS);
  return [...intentRoutes, ...listingRoutes([assetClassCheck, scopeCheck(options), resourceCheck]), ...assetClassRoutes, ...offerRoutes(options), ...bundleRoutes(openEpochResolver(options.chainView), options.confirmClasses === undefined ? {} : { confirmClasses: options.confirmClasses }), ...deliveryRoutes(options.disputeWindowSeconds === undefined ? {} : { disputeWindowSeconds: options.disputeWindowSeconds }), ...referralRoutes(options.maxReferrals === undefined ? {} : { maxPending: options.maxReferrals }), ...statsRoutes, ...resourceRoutes, ...reputationRoutes];
}
