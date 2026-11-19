import crypto from "crypto";
import { Op } from "sequelize";
import {
  Course,
  CourseEnrollment,
  LiveMeeting,
  MeetingAttendance,
  MeetingChatMessage,
  MeetingParticipant,
  User,
} from "../models/index.js";
import { notify } from "./progressService.js";

/*
 * Live classroom support.
 *
 * Video runs as a native WebRTC mesh between the participants of a meeting.
 * The LMS owns authorization, room naming, meeting access tokens, ICE server
 * configuration, notifications, chat persistence, and attendance. ICE/TURN
 * credentials are read from the environment; the browser only receives the
 * short-lived meeting token, the unguessable room name, and the ICE servers it
 * needs to negotiate media.
 */

const MEETING_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

export function meetingSecret() {
  return process.env.SESSION_SECRET || "vanguard-learning-dev-secret";
}

/**
 * ICE servers used by the browser for peer-to-peer media. STUN is enough on
 * most home networks; a TURN relay is required for symmetric NATs, corporate
 * firewalls and some mobile carriers. All configuration stays server-side and
 * only the resulting (non-secret, browser-required) ICE list is sent to the
 * room page.
 */
export function iceServers() {
  const servers = [];
  const raw = String(process.env.WEBRTC_ICE_SERVERS || "").trim();

  if (raw) {
    try {
      const parsed = raw.startsWith("[")
        ? JSON.parse(raw)
        : raw
            .split(/[,;]/)
            .map((value) => value.trim())
            .filter(Boolean)
            .map((urls) => ({ urls }));
      for (const entry of Array.isArray(parsed) ? parsed : []) {
        if (!entry) continue;
        if (typeof entry === "string") servers.push({ urls: entry });
        else if (entry.urls) servers.push(entry);
      }
    } catch (error) {
      console.warn(
        "WEBRTC_ICE_SERVERS must be JSON or a comma-separated URL list; ignoring it."
      );
    }
  }

  if (process.env.TURN_URL) {
    const turn = {
      urls: process.env.TURN_URL.split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    };
    if (process.env.TURN_USERNAME) turn.username = process.env.TURN_USERNAME;
    if (process.env.TURN_CREDENTIAL) turn.credential = process.env.TURN_CREDENTIAL;
    servers.push(turn);
  }

  if (!servers.length) {
    servers.push({
      urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
    });
  }
  return servers;
}

export function createRoomName(courseId) {
  return `vanguard-${courseId}-${crypto.randomBytes(9).toString("hex")}`;
}

/* ------------------------------------------------------------- access token */

export function signMeetingToken(meeting, user) {
  const expiresAt = Date.now() + MEETING_TOKEN_TTL_MS;
  const payload = `${meeting.id}.${user.id}.${expiresAt}`;
  const signature = crypto
    .createHmac("sha256", meetingSecret())
    .update(payload)
    .digest("hex");
  return `${Buffer.from(payload).toString("base64url")}.${signature}`;
}

export function verifyMeetingToken(token) {
  if (!token || typeof token !== "string") return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  let payload;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = crypto
    .createHmac("sha256", meetingSecret())
    .update(payload)
    .digest("hex");
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }
  const [meetingId, userId, expiresAt] = payload.split(".");
  if (!meetingId || !userId || !expiresAt) return null;
  if (Date.now() > Number(expiresAt)) return null;
  return { meetingId: Number(meetingId), userId: Number(userId) };
}

/* --------------------------------------------------------- room media config */

export function buildRtcConfig({ meeting, user, moderator }) {
  return {
    roomName: meeting.roomName,
    iceServers: iceServers(),
    displayName: user.name,
    email: user.email,
    avatarColor: user.avatarColor || "#1e3a6e",
    isModerator: Boolean(moderator),
  };
}

/* ------------------------------------------------------------- access rules */

export async function loadMeetingForUser(meetingId, user) {
  const meeting = await LiveMeeting.findByPk(meetingId, {
    include: [
      { model: Course, as: "course" },
      { model: User, as: "instructor", attributes: ["id", "name", "email", "avatarColor"] },
    ],
  });
  if (!meeting) return { meeting: null, canManage: false, enrolled: false, allowed: false };

  const canManage =
    user.role === "superadmin" || meeting.instructorId === user.id;
  let enrolled = false;
  if (!canManage) {
    enrolled = Boolean(
      await CourseEnrollment.findOne({
        where: { courseId: meeting.courseId, userId: user.id },
      })
    );
  }
  return { meeting, canManage, enrolled, allowed: canManage || enrolled };
}

export async function enrolledLearnerIds(courseId, instructorId) {
  const rows = await CourseEnrollment.findAll({
    where: { courseId, status: { [Op.ne]: "dropped" } },
    attributes: ["userId"],
  });
  return [...new Set(rows.map((row) => row.userId))].filter(
    (userId) => userId !== instructorId
  );
}

export async function inviteEnrolledLearners(meeting) {
  const userIds = await enrolledLearnerIds(meeting.courseId, meeting.instructorId);
  for (const userId of userIds) {
    await MeetingParticipant.findOrCreate({
      where: { meetingId: meeting.id, userId },
      defaults: {
        role: "learner",
        status: "invited",
        invitedAt: new Date(),
      },
    });
  }
  return userIds;
}

export async function notifyEnrolledLearners(meeting, { title, message, includeInstructor = false }) {
  const userIds = includeInstructor
    ? [meeting.instructorId, ...(await enrolledLearnerIds(meeting.courseId, meeting.instructorId))]
    : await enrolledLearnerIds(meeting.courseId, meeting.instructorId);

  for (const userId of [...new Set(userIds)]) {
    await notify(userId, {
      title,
      message,
      type: "live_class",
      link: `/live/${meeting.id}`,
    });
  }
}

/* --------------------------------------------------------------- attendance */

async function attendanceTotal(meetingId, userId) {
  const rows = await MeetingAttendance.findAll({ where: { meetingId, userId } });
  return rows.reduce((sum, row) => sum + (Number(row.durationSeconds) || 0), 0);
}

export async function recordJoin(meeting, user, role) {
  const now = new Date();
  const [participant] = await MeetingParticipant.findOrCreate({
    where: { meetingId: meeting.id, userId: user.id },
    defaults: {
      role,
      status: "joined",
      invitedAt: now,
      joinedAt: now,
      lastSeenAt: now,
    },
  });

  if (participant.status === "removed") return { participant, blocked: true };

  await participant.update({
    role,
    status: "joined",
    joinedAt: participant.joinedAt || now,
    leftAt: null,
    lastSeenAt: now,
  });

  const open = await MeetingAttendance.findOne({
    where: { meetingId: meeting.id, userId: user.id, leftAt: null },
    order: [["joinedAt", "DESC"]],
  });
  if (!open) {
    await MeetingAttendance.create({
      meetingId: meeting.id,
      userId: user.id,
      joinedAt: now,
    });
  }
  return { participant, blocked: false };
}

export async function heartbeat(meeting, user) {
  const participant = await MeetingParticipant.findOne({
    where: { meetingId: meeting.id, userId: user.id },
  });
  if (!participant) return null;
  if (participant.status === "removed") return participant;
  await participant.update({ lastSeenAt: new Date() });
  return participant;
}

export async function recordLeave(meeting, user, { removed = false } = {}) {
  const now = new Date();
  const participant = await MeetingParticipant.findOne({
    where: { meetingId: meeting.id, userId: user.id },
  });
  if (!participant) return null;

  const open = await MeetingAttendance.findOne({
    where: { meetingId: meeting.id, userId: user.id, leftAt: null },
    order: [["joinedAt", "DESC"]],
  });
  if (open) {
    const seconds = Math.max(
      0,
      Math.round((now.getTime() - new Date(open.joinedAt).getTime()) / 1000)
    );
    await open.update({ leftAt: now, durationSeconds: seconds });
  }

  await participant.update({
    status: removed ? "removed" : "left",
    leftAt: now,
    lastSeenAt: now,
    attendanceSeconds: await attendanceTotal(meeting.id, user.id),
  });
  return participant;
}

export async function finalizeAttendance(meeting, endedAt = new Date()) {
  const openRows = await MeetingAttendance.findAll({
    where: { meetingId: meeting.id, leftAt: null },
  });
  for (const row of openRows) {
    const seconds = Math.max(
      0,
      Math.round((endedAt.getTime() - new Date(row.joinedAt).getTime()) / 1000)
    );
    await row.update({ leftAt: endedAt, durationSeconds: seconds });
  }

  await MeetingParticipant.update(
    { status: "left", leftAt: endedAt, lastSeenAt: endedAt },
    { where: { meetingId: meeting.id, status: "joined" } }
  );

  const rows = await MeetingAttendance.findAll({ where: { meetingId: meeting.id } });
  const totals = new Map();
  for (const row of rows) {
    totals.set(row.userId, (totals.get(row.userId) || 0) + (row.durationSeconds || 0));
  }
  for (const [userId, seconds] of totals) {
    await MeetingParticipant.update(
      { attendanceSeconds: seconds },
      { where: { meetingId: meeting.id, userId } }
    );
  }
}

/* ------------------------------------------------------------------- chat */

export async function meetingChat(meetingId, limit = 100) {
  return MeetingChatMessage.findAll({
    where: { meetingId },
    include: [{ model: User, as: "user", attributes: ["id", "name", "avatarColor"] }],
    order: [["createdAt", "ASC"]],
    limit,
  });
}

export async function postMeetingMessage(meeting, user, body) {
  return MeetingChatMessage.create({
    meetingId: meeting.id,
    userId: user.id,
    body,
  });
}
