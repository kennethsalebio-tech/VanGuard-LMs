/*
 * Billing service boot helpers.
 *
 * `sequelize.sync()` only creates missing tables; never drops or rewrites
 * existing VanguardLMS tables. Additive column checks run before sync so new
 * indexes can reference the new HitPay columns on an existing database.
 */
import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";
import { User } from "./userModel.js";
import {
  BillingCourse,
  BillingTransaction,
  BillingEvent,
} from "./billingModel.js";
import { Session } from "./sessionModel.js";

export { sequelize, User, BillingCourse, BillingTransaction, BillingEvent, Session };

async function ensureColumn(table, column, definition) {
  const queryInterface = sequelize.getQueryInterface();
  let description;
  try {
    description = await queryInterface.describeTable(table);
  } catch {
    return;
  }
  if (!description[column]) {
    await queryInterface.addColumn(table, column, definition);
  }
}

async function addBillingColumnsIfTableExists() {
  const queryInterface = sequelize.getQueryInterface();
  try {
    await queryInterface.describeTable("BillingTransactions");
  } catch {
    return;
  }

  await ensureColumn("BillingTransactions", "providerPaymentId", {
    type: DataTypes.STRING,
    allowNull: true,
  });
  await ensureColumn("BillingTransactions", "providerCheckoutUrl", {
    type: DataTypes.TEXT,
    allowNull: true,
  });
  await ensureColumn("BillingTransactions", "providerStatus", {
    type: DataTypes.STRING(32),
    allowNull: true,
  });
  await ensureColumn("BillingTransactions", "providerExpiresAt", {
    type: DataTypes.DATE,
    allowNull: true,
  });
  await ensureColumn("BillingTransactions", "failureReason", {
    type: DataTypes.STRING(255),
    allowNull: true,
  });

  // MySQL ENUMs must be widened explicitly; SQLite stores them as text.
  if (sequelize.getDialect() === "mysql") {
    try {
      await sequelize.query(
        "ALTER TABLE BillingTransactions MODIFY provider ENUM('sandbox','hitpay','paypal','gcash','card') NOT NULL DEFAULT 'sandbox'"
      );
    } catch (error) {
      console.warn("Could not widen BillingTransactions.provider:", error.message);
    }
  }
}

export const dbReady = (async () => {
  await sequelize.authenticate();
  await addBillingColumnsIfTableExists();
  await sequelize.sync();
  // A fresh database gets the columns from sync; this covers additive safety.
  await addBillingColumnsIfTableExists();
})();
