import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/*
 * Demo-only billing ledger.
 *
 * These tables are deliberately separate from CoursePurchases and from the
 * VanguardLMS billing database. A simulated invoice never becomes a real
 * invoice, and a simulated transaction is never counted as collected revenue.
 */
export const SimulatedInvoice = sequelize.define(
  "SimulatedInvoice",
  {
    userId: { type: DataTypes.INTEGER, allowNull: false },
    courseId: { type: DataTypes.INTEGER, allowNull: false },
    reference: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    description: { type: DataTypes.STRING(255), allowNull: false },
    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    currency: { type: DataTypes.STRING, allowNull: false, defaultValue: "PHP" },
    status: {
      type: DataTypes.ENUM("open", "simulated", "cancelled", "failed"),
      allowNull: false,
      defaultValue: "open",
    },
    simulatedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    indexes: [
      { unique: true, fields: ["reference"] },
      { fields: ["userId", "status"] },
      { fields: ["courseId"] },
    ],
  }
);

export const SimulatedTransaction = sequelize.define(
  "SimulatedTransaction",
  {
    userId: { type: DataTypes.INTEGER, allowNull: false },
    // One demo transaction per invoice. The unique index is the final guard
    // against double-clicks and concurrent submissions.
    invoiceId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    reference: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    paymentMethod: {
      type: DataTypes.ENUM("gcash", "maya", "maribank"),
      allowNull: false,
    },
    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    currency: { type: DataTypes.STRING, allowNull: false, defaultValue: "PHP" },
    status: {
      type: DataTypes.ENUM("simulated", "failed", "cancelled"),
      allowNull: false,
      defaultValue: "simulated",
    },
    paymentMode: {
      type: DataTypes.ENUM("demo"),
      allowNull: false,
      defaultValue: "demo",
    },
    failureReason: { type: DataTypes.STRING(255), allowNull: true },
  },
  {
    indexes: [
      { unique: true, fields: ["invoiceId"] },
      { unique: true, fields: ["reference"] },
      { fields: ["userId", "status"] },
      { fields: ["paymentMethod", "status"] },
    ],
  }
);
