import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/*
 * Vanguard Live Classroom.
 *
 * A meeting always belongs to one course (the "class") and its owning
 * instructor. Enrolled learners are invited when the meeting is created or
 * started, and their actual participation is recorded separately so that a
 * notification alone never counts as attendance.
 */

export const LiveMeeting = sequelize.define("LiveMeeting", {
  courseId: { type: DataTypes.INTEGER, allowNull: false },
  instructorId: { type: DataTypes.INTEGER, allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  agenda: { type: DataTypes.TEXT },
  // Unguessable room name; the conference provider never receives the course
  // id alone, and the LMS checks enrollment before showing this page.
  roomName: { type: DataTypes.STRING, allowNull: false, unique: true },
  status: {
    type: DataTypes.ENUM("scheduled", "live", "ended", "cancelled"),
    defaultValue: "scheduled",
  },
  scheduledStart: { type: DataTypes.DATE },
  scheduledEnd: { type: DataTypes.DATE },
  durationMinutes: { type: DataTypes.INTEGER, defaultValue: 60 },
  startedAt: { type: DataTypes.DATE },
  endedAt: { type: DataTypes.DATE },
  allowScreenShare: { type: DataTypes.BOOLEAN, defaultValue: true },
  allowChat: { type: DataTypes.BOOLEAN, defaultValue: true },
  startedBy: { type: DataTypes.INTEGER },
  endedBy: { type: DataTypes.INTEGER },
});

export const MeetingParticipant = sequelize.define(
  "MeetingParticipant",
  {
    meetingId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    role: {
      type: DataTypes.ENUM("instructor", "learner"),
      defaultValue: "learner",
    },
    status: {
      type: DataTypes.ENUM("invited", "joined", "left", "removed"),
      defaultValue: "invited",
    },
    invitedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    joinedAt: { type: DataTypes.DATE },
    lastSeenAt: { type: DataTypes.DATE },
    leftAt: { type: DataTypes.DATE },
    attendanceSeconds: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  { indexes: [{ unique: true, fields: ["meetingId", "userId"] }] }
);

export const MeetingAttendance = sequelize.define("MeetingAttendance", {
  meetingId: { type: DataTypes.INTEGER, allowNull: false },
  userId: { type: DataTypes.INTEGER, allowNull: false },
  joinedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  leftAt: { type: DataTypes.DATE },
  durationSeconds: { type: DataTypes.INTEGER, defaultValue: 0 },
});

export const MeetingChatMessage = sequelize.define("MeetingChatMessage", {
  meetingId: { type: DataTypes.INTEGER, allowNull: false },
  userId: { type: DataTypes.INTEGER, allowNull: false },
  body: { type: DataTypes.TEXT, allowNull: false },
});
