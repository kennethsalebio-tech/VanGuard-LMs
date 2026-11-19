/*
 * Remove test/demo transactions created for @lms.test or @example.test
 * learners. Real customer transactions and all paid external-learner records
 * are preserved.
 *
 *   node scripts/remove-test-billing.mjs          # dry run
 *   node scripts/remove-test-billing.mjs --apply  # delete
 */
import "dotenv/config";
import { Op } from "sequelize";
import { dbReady, sequelize, BillingTransaction, BillingEvent } from "../models/index.js";

await dbReady;
const apply = process.argv.includes("--apply");

const rows = await BillingTransaction.findAll({
  where: {
    [Op.or]: [
      { learnerEmail: { [Op.like]: "%@lms.test" } },
      { learnerEmail: { [Op.like]: "%@example.test" } },
    ],
  },
  order: [["id", "ASC"]],
});

if (!rows.length) {
  console.log("No test billing transactions found.");
  await sequelize.close();
  process.exit(0);
}

console.log(`${apply ? "Deleting" : "Would delete"} ${rows.length} test transaction(s):`);
for (const row of rows) {
  console.log(`  ${row.reference}\t${row.status}\t${row.learnerEmail}\t${row.currency} ${row.amount}`);
}

if (!apply) {
  console.log("\nDry run only. Re-run with --apply to delete these transactions.");
  await sequelize.close();
  process.exit(0);
}

const references = rows.map((row) => row.reference);
await sequelize.transaction(async (transaction) => {
  await BillingEvent.destroy({ where: { reference: references }, transaction });
  await BillingTransaction.destroy({ where: { reference: references }, transaction });
});

console.log(`\nDeleted ${rows.length} test billing transactions and their events.`);
await sequelize.close();
