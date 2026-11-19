import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/*
 * Server-side session storage. Keeping sessions out of process memory is
 * required for restarts and multi-instance deployments.
 */
export const Session = sequelize.define(
  "Session",
  {
    sid: { type: DataTypes.STRING(128), primaryKey: true },
    data: { type: DataTypes.TEXT, allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
  },
  { timestamps: false, indexes: [{ fields: ["expiresAt"] }] }
);
