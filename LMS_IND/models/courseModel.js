import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const CourseCategory = sequelize.define("CourseCategory", {
  name: { type: DataTypes.STRING, allowNull: false, unique: true },
  slug: { type: DataTypes.STRING, allowNull: false },
});

export const Course = sequelize.define("Course", {
  title: { type: DataTypes.STRING, allowNull: false },
  description: { type: DataTypes.TEXT },
  categoryId: { type: DataTypes.INTEGER },
  instructorId: { type: DataTypes.INTEGER, allowNull: false },
  objectives: { type: DataTypes.TEXT },
  durationHours: { type: DataTypes.FLOAT, defaultValue: 1 },
  level: {
    type: DataTypes.ENUM("beginner", "intermediate", "advanced"),
    defaultValue: "beginner",
  },
  status: {
    type: DataTypes.ENUM("draft", "published", "archived"),
    defaultValue: "draft",
  },
  accent: { type: DataTypes.STRING, defaultValue: "#1d4ed8" },
  // 0 (or less) keeps a course free. Prices are in Philippine pesos.
  price: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  currency: { type: DataTypes.STRING, allowNull: false, defaultValue: "PHP" },
  // Knowledge-check defaults. 5 questions, pass with 4 of 5 (80%).
  questionCount: { type: DataTypes.INTEGER, defaultValue: 5 },
  passScore: { type: DataTypes.INTEGER, defaultValue: 4 },
  maxAttempts: { type: DataTypes.INTEGER, defaultValue: 0 }, // 0 = unlimited
  allowRetakes: { type: DataTypes.BOOLEAN, defaultValue: true },
  showExplanations: { type: DataTypes.BOOLEAN, defaultValue: true },
  certificateEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
});

export const Module = sequelize.define("Module", {
  courseId: { type: DataTypes.INTEGER, allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  description: { type: DataTypes.TEXT },
  orderIndex: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: {
    type: DataTypes.ENUM("draft", "published"),
    defaultValue: "draft",
  },
});

export const Lesson = sequelize.define("Lesson", {
  courseId: { type: DataTypes.INTEGER, allowNull: false },
  moduleId: { type: DataTypes.INTEGER, allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  summary: { type: DataTypes.TEXT },
  orderIndex: { type: DataTypes.INTEGER, defaultValue: 0 },
  durationMinutes: { type: DataTypes.INTEGER, defaultValue: 15 },
  status: {
    type: DataTypes.ENUM("draft", "published"),
    defaultValue: "draft",
  },
  sourceFile: { type: DataTypes.STRING },
  sourceMime: { type: DataTypes.STRING },
  sourceName: { type: DataTypes.STRING },
});

export const LessonContent = sequelize.define("LessonContent", {
  lessonId: { type: DataTypes.INTEGER, allowNull: false },
  html: { type: DataTypes.TEXT },
  plainText: { type: DataTypes.TEXT },
  sections: { type: DataTypes.TEXT, defaultValue: "[]" },
  conversionNotes: { type: DataTypes.TEXT },
});

export const LearningResource = sequelize.define("LearningResource", {
  lessonId: { type: DataTypes.INTEGER, allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  fileName: { type: DataTypes.STRING, allowNull: false },
  filePath: { type: DataTypes.STRING, allowNull: false },
  mimeType: { type: DataTypes.STRING },
  sizeBytes: { type: DataTypes.BIGINT, defaultValue: 0 },
  isDownloadable: { type: DataTypes.BOOLEAN, defaultValue: true },
});

export const CourseEnrollment = sequelize.define(
  "CourseEnrollment",
  {
    courseId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    status: {
      type: DataTypes.ENUM("active", "completed", "dropped"),
      defaultValue: "active",
    },
    source: { type: DataTypes.STRING, defaultValue: "self" },
    dueDate: { type: DataTypes.DATEONLY },
    completedAt: { type: DataTypes.DATE },
  },
  { indexes: [{ unique: true, fields: ["courseId", "userId"] }] }
);

/*
 * Access ledger for paid courses. The financial truth (amounts, receipts,
 * verification) lives in the VanguardLMS billing service; this table only
 * records which learner holds a verified purchase of which LMS course, so the
 * LMS can grant access without trusting a browser redirect.
 */
export const CoursePurchase = sequelize.define(
  "CoursePurchase",
  {
    userId: { type: DataTypes.INTEGER, allowNull: false },
    courseId: { type: DataTypes.INTEGER, allowNull: false },
    // Billing service transaction reference (unguessable UUID).
    reference: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    currency: { type: DataTypes.STRING, allowNull: false, defaultValue: "PHP" },
    status: {
      type: DataTypes.ENUM("pending", "paid", "failed", "cancelled", "refunded"),
      allowNull: false,
      defaultValue: "pending",
    },
    provider: { type: DataTypes.STRING, defaultValue: "sandbox" },
    receiptNumber: { type: DataTypes.STRING(64) },
    paidAt: { type: DataTypes.DATE },
    verifiedAt: { type: DataTypes.DATE },
    refundedAt: { type: DataTypes.DATE },
  },
  {
    indexes: [
      { unique: true, fields: ["reference"] },
      { fields: ["userId", "courseId"] },
      { fields: ["status"] },
    ],
  }
);

export const LessonProgress = sequelize.define(
  "LessonProgress",
  {
    lessonId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    courseId: { type: DataTypes.INTEGER, allowNull: false },
    status: {
      type: DataTypes.ENUM("locked", "unlocked", "in_progress", "completed"),
      defaultValue: "locked",
    },
    bestScore: { type: DataTypes.INTEGER, defaultValue: 0 },
    totalQuestions: { type: DataTypes.INTEGER, defaultValue: 0 },
    attempts: { type: DataTypes.INTEGER, defaultValue: 0 },
    completedAt: { type: DataTypes.DATE },
  },
  { indexes: [{ unique: true, fields: ["lessonId", "userId"] }] }
);

export const CourseProgress = sequelize.define(
  "CourseProgress",
  {
    courseId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    percent: { type: DataTypes.INTEGER, defaultValue: 0 },
    completedLessons: { type: DataTypes.INTEGER, defaultValue: 0 },
    totalLessons: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  { indexes: [{ unique: true, fields: ["courseId", "userId"] }] }
);
