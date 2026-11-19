import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const QuestionBank = sequelize.define("QuestionBank", {
  lessonId: { type: DataTypes.INTEGER, allowNull: false },
  courseId: { type: DataTypes.INTEGER, allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  status: {
    type: DataTypes.ENUM("draft", "approved"),
    defaultValue: "draft",
  },
  // Review state for AI-assisted banks. Stored as a string so existing
  // databases can be extended with a safe additive migration.
  reviewStatus: {
    type: DataTypes.STRING,
    defaultValue: "none", // none | pending_review | reviewed
  },
  lastReviewedAt: { type: DataTypes.DATE },
  lastReviewedBy: { type: DataTypes.INTEGER },
  generator: { type: DataTypes.STRING, defaultValue: "ai_local" },
});

export const QuestionReview = sequelize.define("QuestionReview", {
  questionId: { type: DataTypes.INTEGER, allowNull: false },
  questionBankId: { type: DataTypes.INTEGER },
  reviewerId: { type: DataTypes.INTEGER, allowNull: false },
  action: {
    type: DataTypes.ENUM("approved", "rejected", "edited"),
    allowNull: false,
  },
  note: { type: DataTypes.STRING },
});

export const Question = sequelize.define("Question", {
  bankId: { type: DataTypes.INTEGER, allowNull: false },
  lessonId: { type: DataTypes.INTEGER, allowNull: false },
  type: {
    type: DataTypes.ENUM("mcq", "true_false"),
    defaultValue: "mcq",
  },
  prompt: { type: DataTypes.TEXT, allowNull: false },
  explanation: { type: DataTypes.TEXT },
  sourceRef: { type: DataTypes.STRING },
  difficulty: {
    type: DataTypes.ENUM("easy", "medium", "hard"),
    defaultValue: "medium",
  },
  status: {
    type: DataTypes.ENUM("pending", "approved", "rejected"),
    defaultValue: "pending",
  },
  generatedBy: { type: DataTypes.STRING, defaultValue: "ai" },
  orderIndex: { type: DataTypes.INTEGER, defaultValue: 0 },
});

export const QuestionOption = sequelize.define("QuestionOption", {
  questionId: { type: DataTypes.INTEGER, allowNull: false },
  text: { type: DataTypes.TEXT, allowNull: false },
  isCorrect: { type: DataTypes.BOOLEAN, defaultValue: false },
  orderIndex: { type: DataTypes.INTEGER, defaultValue: 0 },
});

export const Assessment = sequelize.define("Assessment", {
  courseId: { type: DataTypes.INTEGER, allowNull: false },
  lessonId: { type: DataTypes.INTEGER, allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  type: {
    type: DataTypes.ENUM("lesson_gate", "exam"),
    defaultValue: "lesson_gate",
  },
  questionCount: { type: DataTypes.INTEGER, defaultValue: 5 },
  passScore: { type: DataTypes.INTEGER, defaultValue: 4 },
  maxAttempts: { type: DataTypes.INTEGER, defaultValue: 0 },
  showExplanations: { type: DataTypes.BOOLEAN, defaultValue: true },
});

export const AssessmentAttempt = sequelize.define("AssessmentAttempt", {
  assessmentId: { type: DataTypes.INTEGER, allowNull: false },
  lessonId: { type: DataTypes.INTEGER, allowNull: false },
  courseId: { type: DataTypes.INTEGER, allowNull: false },
  userId: { type: DataTypes.INTEGER, allowNull: false },
  attemptNumber: { type: DataTypes.INTEGER, allowNull: false },
  status: {
    type: DataTypes.ENUM("in_progress", "submitted"),
    defaultValue: "in_progress",
  },
  score: { type: DataTypes.INTEGER, defaultValue: 0 },
  totalQuestions: { type: DataTypes.INTEGER, defaultValue: 0 },
  passed: { type: DataTypes.BOOLEAN, defaultValue: false },
  startedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  submittedAt: { type: DataTypes.DATE },
});

export const AttemptQuestion = sequelize.define("AttemptQuestion", {
  attemptId: { type: DataTypes.INTEGER, allowNull: false },
  questionId: { type: DataTypes.INTEGER, allowNull: false },
  optionOrder: { type: DataTypes.TEXT, defaultValue: "[]" },
  selectedOptionId: { type: DataTypes.INTEGER },
  isCorrect: { type: DataTypes.BOOLEAN, defaultValue: false },
  orderIndex: { type: DataTypes.INTEGER, defaultValue: 0 },
});
