import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const Session = sequelize.define(
  "Session",
  {
    sid: { type: DataTypes.STRING(128), primaryKey: true },
    data: { type: DataTypes.TEXT, allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
  },
  { timestamps: false, indexes: [{ fields: ["expiresAt"] }] }
);
