import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const PasswordReset = sequelize.define(
  "PasswordReset",
  {
    userId: { type: DataTypes.INTEGER, allowNull: false },
    tokenHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    usedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    indexes: [
      { unique: true, fields: ["tokenHash"] },
      { fields: ["userId", "expiresAt"] },
    ],
  }
);
