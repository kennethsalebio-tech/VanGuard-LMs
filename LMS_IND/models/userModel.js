import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const Department = sequelize.define("Department", {
  name: { type: DataTypes.STRING, allowNull: false, unique: true },
  code: { type: DataTypes.STRING, allowNull: false },
  description: { type: DataTypes.TEXT },
});

export const Position = sequelize.define("Position", {
  title: { type: DataTypes.STRING, allowNull: false },
  departmentId: { type: DataTypes.INTEGER },
  // Course ids that are automatically assigned to employees holding this position.
  requiredCourseIds: { type: DataTypes.TEXT, defaultValue: "[]" },
});

export const User = sequelize.define("User", {
  employeeId: { type: DataTypes.STRING, unique: true },
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  // Google subjects are stable across email changes; nullable for password-only users.
  googleId: { type: DataTypes.STRING(255), unique: true },
  emailVerified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  authProvider: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "password" },
  password: { type: DataTypes.STRING, allowNull: false },
  role: {
    type: DataTypes.ENUM("superadmin", "hr", "instructor", "learner"),
    allowNull: false,
    defaultValue: "learner",
  },
  departmentId: { type: DataTypes.INTEGER },
  positionId: { type: DataTypes.INTEGER },
  employmentStatus: {
    type: DataTypes.ENUM("active", "probation", "on_leave", "inactive"),
    defaultValue: "active",
  },
  dateHired: { type: DataTypes.DATEONLY },
  avatarColor: { type: DataTypes.STRING, defaultValue: "#1e3a8a" },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  lastLoginAt: { type: DataTypes.DATE },
});

export const TrainingAssignment = sequelize.define("TrainingAssignment", {
  userId: { type: DataTypes.INTEGER, allowNull: false },
  courseId: { type: DataTypes.INTEGER, allowNull: false },
  assignedBy: { type: DataTypes.INTEGER },
  dueDate: { type: DataTypes.DATEONLY },
  source: { type: DataTypes.STRING, defaultValue: "hr" },
  status: {
    type: DataTypes.ENUM("assigned", "completed", "overdue"),
    defaultValue: "assigned",
  },
});
