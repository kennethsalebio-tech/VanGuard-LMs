/*
 * Database initialization.
 *
 * Creates/updates every table from the Sequelize models and seeds the initial
 * staff accounts and course catalogue when the database is empty. Safe to run
 * repeatedly: seeding only happens when there are no users.
 *
 *   npm run migrate      (or: npm run seed)
 */
import "dotenv/config";
import { dbReady, sequelize } from "./models/index.js";

try {
  await dbReady;
  console.log("✅ Database connected, tables synced, and initial data ready.");
} catch (error) {
  console.error("❌ Database initialization failed:", error);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
