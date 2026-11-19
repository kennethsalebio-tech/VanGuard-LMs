/*
 * Remove seeded/demo learner accounts (all @lms.test learners) and their
 * dependent learning records. Staff accounts and real external learner
 * accounts are never matched.
 *
 *   node scripts/remove-demo-learners.mjs          # dry run
 *   node scripts/remove-demo-learners.mjs --apply  # delete
 */
import "dotenv/config";
import { Op } from "sequelize";
import {
  dbReady,
  sequelize,
  User,
  TrainingAssignment,
  CourseEnrollment,
  CoursePurchase,
  LessonProgress,
  CourseProgress,
  AssessmentAttempt,
  AttemptQuestion,
  Certificate,
  Notification,
  ActivityLog,
  QuestionReview,
  LiveMeeting,
  MeetingParticipant,
  MeetingAttendance,
  MeetingChatMessage,
  PasswordReset,
  Session,
  SimulatedInvoice,
  SimulatedTransaction,
} from "../models/index.js";

await dbReady;
const apply = process.argv.includes("--apply");

const demoUsers = await User.findAll({
  where: {
    role: "learner",
    [Op.or]: [
      { email: { [Op.like]: "%@lms.test" } },
      { email: { [Op.like]: "%@example.test" } },
    ],
  },
  order: [["id", "ASC"]],
});

if (!demoUsers.length) {
  console.log("No demo learner accounts found.");
  await sequelize.close();
  process.exit(0);
}

console.log(`${apply ? "Deleting" : "Would delete"} ${demoUsers.length} demo learner account(s):`);
for (const user of demoUsers) {
  console.log(`  ${user.id}\t${user.email}`);
}

if (!apply) {
  console.log("\nDry run only. Re-run with --apply to delete these accounts.");
  await sequelize.close();
  process.exit(0);
}

const ids = demoUsers.map((user) => user.id);
const purchases = await CoursePurchase.findAll({ where: { userId: ids } });
const references = purchases.map((row) => row.reference);

await sequelize.transaction(async (transaction) => {
  const options = { where: { userId: ids }, transaction };

  const attempts = await AssessmentAttempt.findAll({
    where: { userId: ids },
    attributes: ["id"],
    transaction,
  });
  if (attempts.length) {
    await AttemptQuestion.destroy({
      where: { attemptId: attempts.map((row) => row.id) },
      transaction,
    });
  }

  const hosted = await LiveMeeting.findAll({
    where: { instructorId: ids },
    attributes: ["id"],
    transaction,
  });
  const meetingIds = hosted.map((row) => row.id);
  if (meetingIds.length) {
    await MeetingParticipant.destroy({ where: { meetingId: meetingIds }, transaction });
    await MeetingAttendance.destroy({ where: { meetingId: meetingIds }, transaction });
    await MeetingChatMessage.destroy({ where: { meetingId: meetingIds }, transaction });
    await LiveMeeting.destroy({ where: { id: meetingIds }, transaction });
  }
  await MeetingParticipant.destroy(options);
  await MeetingAttendance.destroy(options);
  await MeetingChatMessage.destroy(options);

  await AssessmentAttempt.destroy(options);
  await Certificate.destroy(options);
  await Notification.destroy(options);
  await ActivityLog.destroy(options);
  await QuestionReview.destroy({ where: { reviewerId: ids }, transaction });
  await TrainingAssignment.destroy(options);
  await SimulatedTransaction.destroy(options);
  await SimulatedInvoice.destroy(options);
  await CoursePurchase.destroy(options);
  await CourseEnrollment.destroy(options);
  await LessonProgress.destroy(options);
  await CourseProgress.destroy(options);
  await PasswordReset.destroy(options);
  await Session.destroy({
    where: {
      [Op.or]: ids.flatMap((id) => [
        { data: { [Op.like]: `%"userId":${id},%` } },
        { data: { [Op.like]: `%"userId":${id}}%` } },
      ]),
    },
    transaction,
  });
  await User.destroy({ where: { id: ids }, transaction });
});

console.log(`\nDeleted ${demoUsers.length} demo learners and their LMS records.`);
if (references.length) {
  console.log(`Billing references to remove in VanguardLMS: ${references.length}`);
  console.log(references.join("\n"));
}
await sequelize.close();
