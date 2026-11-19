import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";
import {
  User,
  Department,
  Position,
  TrainingAssignment,
} from "./userModel.js";
import {
  CourseCategory,
  Course,
  Module,
  Lesson,
  LessonContent,
  LearningResource,
  CourseEnrollment,
  CoursePurchase,
  LessonProgress,
  CourseProgress,
} from "./courseModel.js";
import {
  QuestionBank,
  Question,
  QuestionOption,
  QuestionReview,
  Assessment,
  AssessmentAttempt,
  AttemptQuestion,
} from "./assessmentModel.js";
import {
  Certificate,
  Notification,
  ActivityLog,
} from "./platformModel.js";
import {
  LiveMeeting,
  MeetingParticipant,
  MeetingAttendance,
  MeetingChatMessage,
} from "./liveModel.js";
import { Session } from "./sessionModel.js";
import { PasswordReset } from "./passwordResetModel.js";
import {
  SimulatedInvoice,
  SimulatedTransaction,
} from "./simulatedPaymentModel.js";

/* ---------------------------------------------------------------- relations */

Department.hasMany(User, { foreignKey: "departmentId", as: "members" });
User.belongsTo(Department, { foreignKey: "departmentId", as: "department" });

Department.hasMany(Position, { foreignKey: "departmentId", as: "positions" });
Position.belongsTo(Department, { foreignKey: "departmentId", as: "department" });
Position.hasMany(User, { foreignKey: "positionId", as: "holders" });
User.belongsTo(Position, { foreignKey: "positionId", as: "position" });

TrainingAssignment.belongsTo(User, { foreignKey: "userId", as: "user" });
TrainingAssignment.belongsTo(Course, { foreignKey: "courseId", as: "course" });
User.hasMany(TrainingAssignment, { foreignKey: "userId", as: "trainingAssignments" });
Course.hasMany(TrainingAssignment, { foreignKey: "courseId", as: "trainingAssignments" });

CourseCategory.hasMany(Course, { foreignKey: "categoryId", as: "courses" });
Course.belongsTo(CourseCategory, { foreignKey: "categoryId", as: "category" });

User.hasMany(Course, { foreignKey: "instructorId", as: "authoredCourses" });
Course.belongsTo(User, { foreignKey: "instructorId", as: "instructor" });

Course.hasMany(Module, { foreignKey: "courseId", as: "modules" });
Module.belongsTo(Course, { foreignKey: "courseId", as: "course" });
Module.hasMany(Lesson, { foreignKey: "moduleId", as: "lessons" });
Lesson.belongsTo(Module, { foreignKey: "moduleId", as: "module" });
Lesson.belongsTo(Course, { foreignKey: "courseId", as: "course" });
Course.hasMany(Lesson, { foreignKey: "courseId", as: "lessons" });

Lesson.hasOne(LessonContent, { foreignKey: "lessonId", as: "content" });
LessonContent.belongsTo(Lesson, { foreignKey: "lessonId", as: "lesson" });

Lesson.hasMany(LearningResource, { foreignKey: "lessonId", as: "resources" });
LearningResource.belongsTo(Lesson, { foreignKey: "lessonId", as: "lesson" });

Course.hasMany(CourseEnrollment, { foreignKey: "courseId", as: "enrollments" });
CourseEnrollment.belongsTo(Course, { foreignKey: "courseId", as: "course" });
CourseEnrollment.belongsTo(User, { foreignKey: "userId", as: "user" });
User.hasMany(CourseEnrollment, { foreignKey: "userId", as: "enrollments" });

Course.hasMany(CoursePurchase, { foreignKey: "courseId", as: "purchases" });
CoursePurchase.belongsTo(Course, { foreignKey: "courseId", as: "course" });
CoursePurchase.belongsTo(User, { foreignKey: "userId", as: "user" });
User.hasMany(CoursePurchase, { foreignKey: "userId", as: "purchases" });

LessonProgress.belongsTo(Lesson, { foreignKey: "lessonId", as: "lesson" });
LessonProgress.belongsTo(User, { foreignKey: "userId", as: "user" });
LessonProgress.belongsTo(Course, { foreignKey: "courseId", as: "course" });
Lesson.hasMany(LessonProgress, { foreignKey: "lessonId", as: "progress" });

CourseProgress.belongsTo(Course, { foreignKey: "courseId", as: "course" });
CourseProgress.belongsTo(User, { foreignKey: "userId", as: "user" });

Lesson.hasOne(QuestionBank, { foreignKey: "lessonId", as: "questionBank" });
QuestionBank.belongsTo(Lesson, { foreignKey: "lessonId", as: "lesson" });
QuestionBank.belongsTo(Course, { foreignKey: "courseId", as: "course" });
QuestionBank.hasMany(Question, { foreignKey: "bankId", as: "questions" });
Question.belongsTo(QuestionBank, { foreignKey: "bankId", as: "bank" });
Question.hasMany(QuestionOption, { foreignKey: "questionId", as: "options" });
QuestionOption.belongsTo(Question, { foreignKey: "questionId", as: "question" });

Question.hasMany(QuestionReview, { foreignKey: "questionId", as: "reviews" });
QuestionReview.belongsTo(Question, { foreignKey: "questionId", as: "question" });
QuestionReview.belongsTo(User, { foreignKey: "reviewerId", as: "reviewer" });

Assessment.belongsTo(Course, { foreignKey: "courseId", as: "course" });
Assessment.belongsTo(Lesson, { foreignKey: "lessonId", as: "lesson" });
Assessment.hasMany(AssessmentAttempt, { foreignKey: "assessmentId", as: "attempts" });

AssessmentAttempt.belongsTo(Assessment, { foreignKey: "assessmentId", as: "assessment" });
AssessmentAttempt.belongsTo(User, { foreignKey: "userId", as: "user" });
AssessmentAttempt.belongsTo(Lesson, { foreignKey: "lessonId", as: "lesson" });
AssessmentAttempt.belongsTo(Course, { foreignKey: "courseId", as: "course" });
Course.hasMany(AssessmentAttempt, { foreignKey: "courseId", as: "assessmentAttempts" });
AssessmentAttempt.hasMany(AttemptQuestion, { foreignKey: "attemptId", as: "items" });

AttemptQuestion.belongsTo(AssessmentAttempt, { foreignKey: "attemptId", as: "attempt" });
AttemptQuestion.belongsTo(Question, { foreignKey: "questionId", as: "question" });

Certificate.belongsTo(User, { foreignKey: "userId", as: "user" });
Certificate.belongsTo(Course, { foreignKey: "courseId", as: "course" });
Notification.belongsTo(User, { foreignKey: "userId", as: "user" });
ActivityLog.belongsTo(User, { foreignKey: "userId", as: "user" });

Course.hasMany(LiveMeeting, { foreignKey: "courseId", as: "liveMeetings" });
LiveMeeting.belongsTo(Course, { foreignKey: "courseId", as: "course" });
LiveMeeting.belongsTo(User, { foreignKey: "instructorId", as: "instructor" });
User.hasMany(LiveMeeting, { foreignKey: "instructorId", as: "hostedMeetings" });

LiveMeeting.hasMany(MeetingParticipant, { foreignKey: "meetingId", as: "participants" });
MeetingParticipant.belongsTo(LiveMeeting, { foreignKey: "meetingId", as: "meeting" });
MeetingParticipant.belongsTo(User, { foreignKey: "userId", as: "user" });

LiveMeeting.hasMany(MeetingAttendance, { foreignKey: "meetingId", as: "attendance" });
MeetingAttendance.belongsTo(LiveMeeting, { foreignKey: "meetingId", as: "meeting" });
MeetingAttendance.belongsTo(User, { foreignKey: "userId", as: "user" });

LiveMeeting.hasMany(MeetingChatMessage, { foreignKey: "meetingId", as: "messages" });
MeetingChatMessage.belongsTo(LiveMeeting, { foreignKey: "meetingId", as: "meeting" });
MeetingChatMessage.belongsTo(User, { foreignKey: "userId", as: "user" });

SimulatedInvoice.belongsTo(User, { foreignKey: "userId", as: "user" });
SimulatedInvoice.belongsTo(Course, { foreignKey: "courseId", as: "course" });
User.hasMany(SimulatedInvoice, { foreignKey: "userId", as: "simulatedInvoices" });
SimulatedInvoice.hasOne(SimulatedTransaction, {
  foreignKey: "invoiceId",
  as: "transaction",
});
SimulatedTransaction.belongsTo(SimulatedInvoice, {
  foreignKey: "invoiceId",
  as: "invoice",
});
SimulatedTransaction.belongsTo(User, { foreignKey: "userId", as: "user" });
User.hasMany(SimulatedTransaction, {
  foreignKey: "userId",
  as: "simulatedTransactions",
});

/* --------------------------------------------------- additive migrations */

/*
 * Safe, additive schema updates for databases created by an earlier build.
 * Runs after sequelize.sync(): sync() creates missing tables, while this adds
 * missing columns without dropping, renaming, or rewriting existing tables.
 */
async function applySafeSchemaUpdates() {
  const queryInterface = sequelize.getQueryInterface();

  const ensureColumn = async (table, column, definition) => {
    let described;
    try {
      described = await queryInterface.describeTable(table);
    } catch {
      return;
    }
    if (described[column]) return;
    await queryInterface.addColumn(table, column, definition);
    console.log(`✅ Added column ${table}.${column}`);
  };

  // OAuth identity fields for databases created before Google sign-in existed.
  await ensureColumn("Users", "googleId", {
    type: DataTypes.STRING(255),
    allowNull: true,
  });
  await ensureColumn("Users", "emailVerified", {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  });
  await ensureColumn("Users", "authProvider", {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: "password",
  });

  // Enforce one account per Google subject. The column is nullable, so SQLite
  // and MySQL both allow any number of password-only users.
  try {
    const indexes = await queryInterface.showIndex("Users");
    if (!indexes.some((index) => index.name === "users_google_id_unique")) {
      await queryInterface.addIndex("Users", ["googleId"], {
        name: "users_google_id_unique",
        unique: true,
      });
    }
  } catch (error) {
    console.warn("Could not add Users.googleId unique index:", error.message);
  }

  // Paid course support for databases created before pricing existed.
  await ensureColumn("Courses", "price", {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  });
  await ensureColumn("Courses", "currency", {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "PHP",
  });

  await ensureColumn("QuestionBanks", "reviewStatus", {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "none",
  });
  await ensureColumn("QuestionBanks", "lastReviewedAt", {
    type: DataTypes.DATE,
    allowNull: true,
  });
  await ensureColumn("QuestionBanks", "lastReviewedBy", {
    type: DataTypes.INTEGER,
    allowNull: true,
  });

  // Backfill review state for question banks created before the workflow.
  await QuestionBank.update(
    { reviewStatus: "reviewed" },
    { where: { status: "approved", reviewStatus: "none" } }
  );
}

/* -------------------------------------------------------------------- init */

export const dbReady = (async () => {
  await sequelize.sync();
  await applySafeSchemaUpdates();
  const { seedDatabase } = await import("./seed.js");
  await seedDatabase();
})();

export {
  sequelize,
  User,
  Department,
  Position,
  TrainingAssignment,
  CourseCategory,
  Course,
  Module,
  Lesson,
  LessonContent,
  LearningResource,
  CourseEnrollment,
  CoursePurchase,
  LessonProgress,
  CourseProgress,
  QuestionBank,
  Question,
  QuestionOption,
  QuestionReview,
  Assessment,
  AssessmentAttempt,
  AttemptQuestion,
  Certificate,
  Notification,
  ActivityLog,
  LiveMeeting,
  MeetingParticipant,
  MeetingAttendance,
  MeetingChatMessage,
  Session,
  PasswordReset,
  SimulatedInvoice,
  SimulatedTransaction,
};
