import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const Certificate = sequelize.define("Certificate", {
  certificateId: { type: DataTypes.STRING, allowNull: false, unique: true },
  userId: { type: DataTypes.INTEGER, allowNull: false },
  courseId: { type: DataTypes.INTEGER, allowNull: false },
  learnerName: { type: DataTypes.STRING, allowNull: false },
  courseTitle: { type: DataTypes.STRING, allowNull: false },
  instructorName: { type: DataTypes.STRING },
  verificationCode: { type: DataTypes.STRING, allowNull: false },
  issuedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
});

export const Notification = sequelize.define("Notification", {
  userId: { type: DataTypes.INTEGER, allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  message: { type: DataTypes.TEXT },
  type: { type: DataTypes.STRING, defaultValue: "info" },
  link: { type: DataTypes.STRING },
  isRead: { type: DataTypes.BOOLEAN, defaultValue: false },
});

export const ActivityLog = sequelize.define("ActivityLog", {
  userId: { type: DataTypes.INTEGER },
  action: { type: DataTypes.STRING, allowNull: false },
  entityType: { type: DataTypes.STRING },
  entityId: { type: DataTypes.INTEGER },
  detail: { type: DataTypes.TEXT },
  ip: { type: DataTypes.STRING },
});
