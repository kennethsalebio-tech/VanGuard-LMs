import { Op } from "sequelize";
import {
  Course,
  CourseCategory,
  CourseEnrollment,
  LiveMeeting,
  MeetingAttendance,
  MeetingChatMessage,
  MeetingParticipant,
  User,
} from "../models/index.js";
import {
  buildRtcConfig,
  createRoomName,
  finalizeAttendance,
  heartbeat,
  inviteEnrolledLearners,
  loadMeetingForUser,
  meetingChat,
  notifyEnrolledLearners,
  postMeetingMessage,
  recordJoin,
  recordLeave,
  signMeetingToken,
  verifyMeetingToken,
} from "../services/liveClassroomService.js";
import { canManageCourse, logActivity } from "../middleware/auth.js";
import {
  attachSignalStream,
  closeMeetingSignals,
  disconnectParticipant,
  relaySignal,
} from "../services/rtcSignaling.js";



function scopeFor(user) {
  return user.role === "superadmin" ? {} : { instructorId: user.id };
}

function formatMeetingTime(value) {
  if (!value) return "an unscheduled time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "an unscheduled time";
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function events(meetings, statuses) {
  const allowed = Array.isArray(statuses) ? statuses : [statuses];
  return meetings.filter((meeting) => allowed.includes(meeting.status));
}

function summarizeParticipants(rows) {
  const learners = rows.filter((row) => row.role === "learner");
  return {
    invited: learners.length,
    joined: learners.filter((row) => row.status === "joined").length,
    totalJoined: rows.filter((row) => row.status === "joined").length,
  };
}

async function decorateMeetings(meetings) {
  if (!meetings.length) return [];
  const rows = await MeetingParticipant.findAll({
    where: { meetingId: { [Op.in]: meetings.map((meeting) => meeting.id) } },
    include: [{ model: User, as: "user", attributes: ["id", "name", "email"] }],
    order: [["invitedAt", "ASC"]],
  });
  return meetings.map((meeting) => ({
    ...meeting.toJSON(),
    counts: summarizeParticipants(rows.filter((row) => row.meetingId === meeting.id)),
    participants: rows.filter(
      (row) => row.meetingId === meeting.id && row.status === "joined"
    ),
  }));
}

async function ownedMeeting(req, res) {
  const { meeting, canManage } = await loadMeetingForUser(
    req.params.meetingId,
    req.user
  );
  if (!meeting) {
    res.status(404).render("error", {
      title: "Live class not found",
      status: 404,
      message: "This live classroom session does not exist.",
    });
    return null;
  }
  if (!canManage) {
    res.status(403).render("error", {
      title: "Access denied",
      status: 403,
      message: "You can only manage live classes for the courses you teach.",
    });
    return null;
  }
  return meeting;
}

/* ------------------------------------------------------- instructor pages */

export async function instructorLivePage(req, res) {
  const courses = await Course.findAll({
    where: scopeFor(req.user),
    include: [
      { model: CourseCategory, as: "category" },
      { model: User, as: "instructor", attributes: ["id", "name"] },
    ],
    order: [["createdAt", "DESC"]],
  });
  const courseIds = courses.map((course) => course.id);

  const meetings = courseIds.length
    ? await decorateMeetings(
        await LiveMeeting.findAll({
          where: { courseId: { [Op.in]: courseIds } },
          include: [
            { model: Course, as: "course" },
            {
              model: User,
              as: "instructor",
              attributes: ["id", "name", "avatarColor"],
            },
          ],
          order: [["scheduledStart", "DESC"]],
          limit: 60,
        })
      )
    : [];

  const liveNow = meetings.filter((meeting) => meeting.status === "live");
  const upcoming = meetings
    .filter((meeting) => meeting.status === "scheduled")
    .sort((a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart));
  const past = meetings.filter((meeting) =>
    ["ended", "cancelled"].includes(meeting.status)
  );

  res.render("instructor/live", {
    title: "Live classroom",
    courses,
    liveNow,
    upcoming,
    past,
  });
}

export async function newLiveMeetingPage(req, res) {
  const courses = await Course.findAll({
    where: scopeFor(req.user),
    order: [["title", "ASC"]],
  });
  const defaultStart = new Date(Date.now() + 60 * 60 * 1000);
  const localStart = new Date(
    defaultStart.getTime() - defaultStart.getTimezoneOffset() * 60000
  )
    .toISOString()
    .slice(0, 16);
  res.render("instructor/live-form", {
    title: "Schedule a live class",
    courses,
    selectedCourseId: Number(req.query.courseId) || null,
    defaultStart,
    defaultStartValue: localStart,
    defaultMode: req.query.mode === "schedule" ? "schedule" : "instant",
  });
}

export async function createLiveMeeting(req, res) {
  const course = await Course.findByPk(req.body.courseId);
  if (!course || !canManageCourse(req.user, course)) {
    req.flash("error_msg", "Choose a course that you are allowed to teach.");
    return res.redirect("/instructor/live");
  }

  const mode = req.body.mode === "schedule" ? "scheduled" : "instant";
  const title =
    String(req.body.title || "").trim().slice(0, 160) ||
    `${course.title} live class`;
  const durationMinutes = Math.max(
    5,
    Math.min(480, Number(req.body.durationMinutes) || 60)
  );

  let scheduledStart = new Date();
  if (mode === "scheduled") {
    scheduledStart = new Date(String(req.body.scheduledStart || ""));
    if (Number.isNaN(scheduledStart.getTime())) {
      req.flash("error_msg", "Enter a valid date and time for the live class.");
      return res.redirect(`/instructor/live/new?courseId=${course.id}`);
    }
    if (scheduledStart.getTime() < Date.now() - 60 * 1000) {
      req.flash("error_msg", "Choose a start time in the future.");
      return res.redirect(`/instructor/live/new?courseId=${course.id}`);
    }
  }

  const meeting = await LiveMeeting.create({
    courseId: course.id,
    instructorId: course.instructorId,
    title,
    agenda: String(req.body.agenda || "").trim().slice(0, 2000),
    roomName: createRoomName(course.id),
    status: mode === "instant" ? "live" : "scheduled",
    scheduledStart,
    scheduledEnd: new Date(scheduledStart.getTime() + durationMinutes * 60 * 1000),
    durationMinutes,
    startedAt: mode === "instant" ? new Date() : null,
    startedBy: mode === "instant" ? req.user.id : null,
    allowScreenShare: req.body.allowScreenShare === "on",
    allowChat: req.body.allowChat === "on",
  });

  const invited = await inviteEnrolledLearners(meeting);

  if (mode === "instant") {
    await notifyEnrolledLearners(meeting, {
      title: "Live class started",
      message: `Your instructor has started a live video session for ${course.title}. Join now.`,
    });
  } else {
    await notifyEnrolledLearners(meeting, {
      title: "Live class scheduled",
      message: `Your instructor scheduled a live class for ${course.title} on ${formatMeetingTime(
        scheduledStart
      )}.`,
    });
  }

  await logActivity(
    req,
    mode === "instant" ? "Started live class" : "Scheduled live class",
    { entityType: "live_meeting", entityId: meeting.id, detail: course.title }
  );

  req.flash(
    "success_msg",
    mode === "instant"
      ? `Live classroom started. ${invited.length} enrolled learner(s) were notified.`
      : `Live class scheduled. ${invited.length} enrolled learner(s) were notified.`
  );
  return res.redirect(
    mode === "instant" ? `/live/${meeting.id}/room` : `/live/${meeting.id}`
  );
}

export async function startLiveMeeting(req, res) {
  const meeting = await ownedMeeting(req, res);
  if (!meeting) return;

  if (meeting.status === "ended" || meeting.status === "cancelled") {
    req.flash("error_msg", "This live class has already finished.");
    return res.redirect(`/live/${meeting.id}`);
  }
  if (meeting.status === "live") {
    return res.redirect(`/live/${meeting.id}/room`);
  }

  const now = new Date();
  await meeting.update({
    status: "live",
    startedAt: now,
    scheduledStart: meeting.scheduledStart || now,
    scheduledEnd:
      meeting.scheduledEnd ||
      new Date(now.getTime() + (meeting.durationMinutes || 60) * 60 * 1000),
    startedBy: req.user.id,
  });

  await inviteEnrolledLearners(meeting);
  await notifyEnrolledLearners(meeting, {
    title: "Live class started",
    message: `Your instructor has started a live classroom session for ${meeting.course.title}. Join now.`,
  });
  await logActivity(req, "Started live class", {
    entityType: "live_meeting",
    entityId: meeting.id,
    detail: meeting.title,
  });

  req.flash("success_msg", "Live classroom is open. Enrolled learners were notified.");
  return res.redirect(`/live/${meeting.id}/room`);
}

export async function endLiveMeeting(req, res) {
  const meeting = await ownedMeeting(req, res);
  if (!meeting) return;
  const wantsJson = (req.get("accept") || "").includes("application/json");

  if (meeting.status !== "ended") {
    const endedAt = new Date();
    await finalizeAttendance(meeting, endedAt);
    await meeting.update({ status: "ended", endedAt, endedBy: req.user.id });
    closeMeetingSignals(meeting.id);
    await notifyEnrolledLearners(meeting, {
      title: "Live class ended",
      message: `The live classroom session for ${meeting.course.title} has ended. Attendance has been recorded.`,
    });
    await logActivity(req, "Ended live class", {
      entityType: "live_meeting",
      entityId: meeting.id,
      detail: meeting.title,
    });
  }

  if (wantsJson) {
    return res.json({ ok: true, redirect: `/live/${meeting.id}` });
  }
  req.flash("success_msg", "Live classroom ended and attendance saved.");
  return res.redirect(`/live/${meeting.id}`);
}

export async function cancelLiveMeeting(req, res) {
  const meeting = await ownedMeeting(req, res);
  if (!meeting) return;
  if (meeting.status !== "scheduled") {
    req.flash("error_msg", "Only a scheduled class can be cancelled.");
    return res.redirect(`/live/${meeting.id}`);
  }

  await meeting.update({ status: "cancelled" });
  await notifyEnrolledLearners(meeting, {
    title: "Live class cancelled",
    message: `Your instructor cancelled the scheduled live class for ${meeting.course.title}.`,
  });
  await logActivity(req, "Cancelled live class", {
    entityType: "live_meeting",
    entityId: meeting.id,
    detail: meeting.title,
  });
  req.flash("success_msg", "Live class cancelled and learners were notified.");
  return res.redirect(`/live/${meeting.id}`);
}

export async function removeMeetingParticipant(req, res) {
  const meeting = await ownedMeeting(req, res);
  if (!meeting) return;

  const userId = Number(req.params.userId);
  const participant = await MeetingParticipant.findOne({
    where: { meetingId: meeting.id, userId },
  });
  if (!participant) {
    req.flash("error_msg", "That participant is not part of this meeting.");
    return res.redirect(`/live/${meeting.id}`);
  }
  if (participant.role === "instructor") {
    req.flash("error_msg", "The host cannot be removed from the meeting.");
    return res.redirect(`/live/${meeting.id}`);
  }

  await recordLeave(meeting, { id: userId }, { removed: true });
  disconnectParticipant(meeting.id, userId);
  await logActivity(req, "Removed live class participant", {
    entityType: "live_meeting",
    entityId: meeting.id,
    detail: `Learner #${userId}`,
  });
  req.flash("success_msg", "Participant removed from the live classroom.");
  return res.redirect(`/live/${meeting.id}`);
}

/* ---------------------------------------------------------- learner pages */

export async function learnerLivePage(req, res) {
  if (req.user.role === "instructor" || req.user.role === "superadmin") {
    return res.redirect("/instructor/live");
  }
  if (req.user.role === "hr") {
    return res.redirect("/admin/hr");
  }

  const enrollments = await CourseEnrollment.findAll({
    where: { userId: req.user.id },
    attributes: ["courseId"],
  });
  const courseIds = enrollments.map((row) => row.courseId);

  const meetings = courseIds.length
    ? await decorateMeetings(
        await LiveMeeting.findAll({
          where: { courseId: { [Op.in]: courseIds } },
          include: [
            { model: Course, as: "course" },
            {
              model: User,
              as: "instructor",
              attributes: ["id", "name", "avatarColor"],
            },
          ],
          order: [["scheduledStart", "DESC"]],
          limit: 50,
        })
      )
    : [];

  const attendance = await MeetingAttendance.findAll({
    where: { userId: req.user.id },
    attributes: ["meetingId", "joinedAt", "leftAt", "durationSeconds"],
    order: [["joinedAt", "DESC"]],
  });
  const attendanceByMeeting = new Map();
  for (const row of attendance) {
    const entry = attendanceByMeeting.get(row.meetingId) || {
      sessions: 0,
      seconds: 0,
      lastJoinedAt: null,
    };
    entry.sessions += 1;
    entry.seconds += row.durationSeconds || 0;
    entry.lastJoinedAt = entry.lastJoinedAt || row.joinedAt;
    attendanceByMeeting.set(row.meetingId, entry);
  }

  const withAttendance = (meeting) => ({
    ...meeting,
    myAttendance: attendanceByMeeting.get(meeting.id) || null,
  });

  res.render("live", {
    title: "Live classes",
    liveNow: events(meetings, "live").map(withAttendance),
    upcoming: events(meetings, "scheduled")
      .sort((a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart))
      .map(withAttendance),
    past: events(meetings, ["ended", "cancelled"])
      .slice(0, 12)
      .map(withAttendance),
  });
}

export async function liveMeetingPage(req, res) {
  const { meeting, canManage, allowed } = await loadMeetingForUser(
    req.params.meetingId,
    req.user
  );
  if (!meeting) {
    return res.status(404).render("error", {
      title: "Live class not found",
      status: 404,
      message: "This live classroom session does not exist.",
    });
  }
  if (!allowed) {
    return res.status(403).render("error", {
      title: "Not enrolled in this class",
      status: 403,
      message:
        "Only learners enrolled in this course and its instructor can open this live class.",
    });
  }

  const participantRows = await MeetingParticipant.findAll({
    where: { meetingId: meeting.id },
    include: [
      { model: User, as: "user", attributes: ["id", "name", "email", "avatarColor"] },
    ],
    order: [["invitedAt", "ASC"]],
  });

  const attendance = canManage
    ? await MeetingAttendance.findAll({
        where: { meetingId: meeting.id },
        include: [
          { model: User, as: "user", attributes: ["id", "name", "email", "avatarColor"] },
        ],
        order: [["joinedAt", "ASC"]],
      })
    : [];

  const mine = participantRows.find((row) => row.userId === req.user.id);

  res.render("live-meeting", {
    title: meeting.title,
    meeting,
    canManage,
    counts: summarizeParticipants(participantRows),
    participants: participantRows,
    attendance,
    myParticipant: mine || null,
  });
}

export async function liveRoomPage(req, res) {
  const { meeting, canManage, allowed } = await loadMeetingForUser(
    req.params.meetingId,
    req.user
  );
  if (!meeting) {
    return res.status(404).render("error", {
      title: "Live class not found",
      status: 404,
      message: "This live classroom session does not exist.",
    });
  }
  if (!allowed) {
    return res.status(403).render("error", {
      title: "Not enrolled in this class",
      status: 403,
      message:
        "Only learners enrolled in this course and its instructor can join this live class.",
    });
  }
  if (meeting.status === "scheduled") {
    req.flash("error_msg", "This live class has not started yet.");
    return res.redirect(`/live/${meeting.id}`);
  }
  if (["ended", "cancelled"].includes(meeting.status)) {
    req.flash("error_msg", "This live class is no longer running.");
    return res.redirect(`/live/${meeting.id}`);
  }

  const role = canManage ? "instructor" : "learner";
  const join = await recordJoin(meeting, req.user, role);
  if (join.blocked) {
    req.flash("error_msg", "The host removed you from this live classroom.");
    return res.redirect(`/live/${meeting.id}`);
  }

  const token = signMeetingToken(meeting, req.user);
  const rtc = buildRtcConfig({
    meeting,
    user: req.user,
    moderator: canManage,
  });

  const joinedRows = await MeetingParticipant.findAll({
    where: { meetingId: meeting.id, status: "joined" },
    include: [
      { model: User, as: "user", attributes: ["id", "name", "avatarColor", "role"] },
    ],
    order: [["joinedAt", "ASC"]],
  });
  const allRows = await MeetingParticipant.findAll({
    where: { meetingId: meeting.id },
  });

  res.render("live-room", {
    title: `Live — ${meeting.title}`,
    meeting,
    rtc,
    token,
    userId: req.user.id,
    isModerator: canManage,
    canShareScreen: canManage || meeting.allowScreenShare,
    counts: summarizeParticipants(allRows),
    participants: joinedRows.map((row) => ({
      id: row.userId,
      name: row.user?.name || `Learner #${row.userId}`,
      role: row.role,
      isHost: row.role === "instructor",
    })),
    chatEnabled: meeting.allowChat,
  });
}

/* -------------------------------------------------------------- room APIs */

async function authorizedRoomRequest(req, res) {
  const { meeting, allowed } = await loadMeetingForUser(
    req.params.meetingId,
    req.user
  );
  if (!meeting) {
    res.status(404).json({ ok: false, error: "Live class not found." });
    return null;
  }
  if (!allowed) {
    res.status(403).json({ ok: false, error: "You are not enrolled in this class." });
    return null;
  }
  const token = req.query.token || req.body?.token;
  if (token) {
    const claims = verifyMeetingToken(token);
    if (
      !claims ||
      claims.meetingId !== meeting.id ||
      claims.userId !== req.user.id
    ) {
      res.status(403).json({ ok: false, error: "Your meeting token is invalid or expired." });
      return null;
    }
  }
  return meeting;
}

export async function meetingState(req, res) {
  const meeting = await authorizedRoomRequest(req, res);
  if (!meeting) return;

  const participant = await heartbeat(meeting, req.user);
  const rows = await MeetingParticipant.findAll({
    where: { meetingId: meeting.id },
    include: [{ model: User, as: "user", attributes: ["id", "name", "role"] }],
    order: [["joinedAt", "ASC"]],
  });
  const allRows = rows;
  const joined = rows.filter((row) => row.status === "joined");

  res.json({
    ok: true,
    status: meeting.status,
    live: meeting.status === "live",
    removed: participant?.status === "removed",
    counts: {
      invited: allRows.filter((row) => row.role === "learner").length,
      joined: joined.filter((row) => row.role === "learner").length,
      totalJoined: joined.length,
    },
    participants: joined.map((row) => ({
      id: row.userId,
      name: row.user?.name || `Learner #${row.userId}`,
      role: row.role,
      isHost: row.role === "instructor",
    })),
  });
}

export async function listChatMessages(req, res) {
  const meeting = await authorizedRoomRequest(req, res);
  if (!meeting) return;
  if (!meeting.allowChat) {
    return res.status(403).json({ ok: false, error: "Chat is disabled for this meeting." });
  }
  const messages = await meetingChat(meeting.id);
  res.json({
    ok: true,
    messages: messages.map((message) => ({
      id: message.id,
      body: message.body,
      userId: message.userId,
      author: message.user?.name || "Participant",
      createdAt: message.createdAt,
    })),
  });
}

export async function postChatMessage(req, res) {
  const meeting = await authorizedRoomRequest(req, res);
  if (!meeting) return;
  if (!meeting.allowChat) {
    return res.status(403).json({ ok: false, error: "Chat is disabled for this meeting." });
  }
  if (meeting.status !== "live") {
    return res.status(409).json({ ok: false, error: "The live class has ended." });
  }

  const body = String(req.body?.body || "").trim().slice(0, 800);
  if (!body) {
    return res.status(400).json({ ok: false, error: "Write a message first." });
  }
  const message = await postMeetingMessage(meeting, req.user, body);
  res.json({
    ok: true,
    message: {
      id: message.id,
      body: message.body,
      userId: message.userId,
      author: req.user.name,
      createdAt: message.createdAt,
    },
  });
}

export async function leaveMeeting(req, res) {
  const meeting = await authorizedRoomRequest(req, res);
  if (!meeting) return;
  await recordLeave(meeting, req.user);
  res.json({ ok: true });
}

const SIGNAL_TYPES = new Set(["offer", "answer", "ice", "media", "command"]);

/**
 * Server-sent event stream carrying WebRTC offers, answers, ICE candidates and
 * lightweight media-state messages. Enrollment and the signed meeting token
 * are checked before the stream is attached, and only joined participants may
 * open it.
 */
export async function signalStream(req, res) {
  const meeting = await authorizedRoomRequest(req, res);
  if (!meeting) return;
  if (meeting.status !== "live") {
    return res.status(409).json({ ok: false, error: "The live class is not running." });
  }
  const participant = await MeetingParticipant.findOne({
    where: { meetingId: meeting.id, userId: req.user.id, status: "joined" },
  });
  if (!participant) {
    return res.status(403).json({ ok: false, error: "Join the meeting room first." });
  }

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  attachSignalStream({
    meetingId: meeting.id,
    userId: req.user.id,
    name: req.user.name,
    role: participant.role,
    res,
  });
}

/** Upstream WebRTC signaling. CSRF-protected like every other state change. */
export async function postSignal(req, res) {
  const meeting = await authorizedRoomRequest(req, res);
  if (!meeting) return;
  if (meeting.status !== "live") {
    return res.status(409).json({ ok: false, error: "The live class is not running." });
  }

  const type = String(req.body?.type || "");
  if (!SIGNAL_TYPES.has(type)) {
    return res.status(400).json({ ok: false, error: "Unsupported signaling message." });
  }
  if (req.body?.data && JSON.stringify(req.body.data).length > 120000) {
    return res.status(413).json({ ok: false, error: "Signaling payload too large." });
  }

  const isHost =
    meeting.instructorId === req.user.id || req.user.role === "superadmin";
  if (type === "command" && !isHost) {
    return res.status(403).json({ ok: false, error: "Only the host can send room commands." });
  }

  const participant = await MeetingParticipant.findOne({
    where: { meetingId: meeting.id, userId: req.user.id, status: "joined" },
  });
  if (!participant) {
    return res.status(403).json({ ok: false, error: "You are not in this meeting." });
  }

  const delivered = relaySignal(meeting.id, req.user.id, {
    target: Number(req.body?.target) || null,
    type,
    data: req.body?.data ?? null,
    broadcast: Boolean(req.body?.broadcast),
  });
  if (!delivered) {
    return res
      .status(409)
      .json({ ok: false, error: "That participant is no longer connected." });
  }
  return res.json({ ok: true });
}
