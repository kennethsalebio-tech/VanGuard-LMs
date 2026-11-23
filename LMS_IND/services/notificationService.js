import { Op } from "sequelize";
import {
  AssessmentAttempt,
  Certificate,
  Course,
  CourseEnrollment,
  Lesson,
  LiveMeeting,
  Question,
  User,
} from "../models/index.js";
import { canManageCourse } from "../middleware/auth.js";

/*
 * Notification destination mapping.
 *
 * Stored notification links are treated as hints, never as trusted redirects.
 * Each destination is resolved against the signed-in user's role and records,
 * so a stale or hand-edited link can never open another user's private page.
 */

function isInternalPath(link) {
  return typeof link === "string" && link.startsWith("/") && !link.startsWith("//");
}

function roleAllowsPath(user, path) {
  if (!user) return false;
  if (path.startsWith("/instructor")) {
    return user.role === "instructor" || user.role === "superadmin";
  }
  if (path.startsWith("/admin")) {
    return user.role === "superadmin";
  }
  return true;
}

async function resolveQuestionBank(user, storedLink) {
  if (!["instructor", "superadmin"].includes(user.role)) return null;

  const direct = /^\/instructor\/lessons\/(\d+)\/questions/.exec(storedLink || "");
  if (direct) {
    const lesson = await Lesson.findByPk(Number(direct[1]), {
      include: [{ model: Course, as: "course" }],
    });
    if (lesson && canManageCourse(user, lesson.course)) {
      return `/instructor/lessons/${lesson.id}/questions`;
    }
  }

  // Legacy notifications (including the seeded demo data) pointed at the
  // course list. Resolve the instructor's bank with the most pending review work.
  const courses = await Course.findAll({
    where: user.role === "superadmin" ? {} : { instructorId: user.id },
    attributes: ["id"],
  });
  if (!courses.length) return "/instructor/courses";

  const courseIds = courses.map((course) => course.id);
  const lessonIds = (
    await Lesson.findAll({
      where: { courseId: { [Op.in]: courseIds } },
      attributes: ["id"],
      order: [["createdAt", "ASC"]],
    })
  ).map((lesson) => lesson.id);
  if (!lessonIds.length) return "/instructor/courses";

  const pending = await Question.findOne({
    where: { lessonId: { [Op.in]: lessonIds }, status: "pending" },
    order: [["createdAt", "ASC"]],
  });
  if (pending) return `/instructor/lessons/${pending.lessonId}/questions`;

  const lesson = await Lesson.findOne({
    where: { id: { [Op.in]: lessonIds } },
    order: [["createdAt", "ASC"]],
  });
  return lesson ? `/instructor/lessons/${lesson.id}/questions` : "/instructor/courses";
}

async function resolveAssessmentResult(user, storedLink) {
  const match = /^\/learn\/(\d+)\/quiz\/result\/(\d+)/.exec(storedLink || "");
  if (!match) {
    const lessonMatch = /^\/learn\/(\d+)/.exec(storedLink || "");
    return lessonMatch ? storedLink : "/assessments";
  }
  const attempt = await AssessmentAttempt.findByPk(Number(match[2]));
  if (!attempt) return "/assessments";
  if (attempt.userId !== user.id && user.role !== "superadmin") return "/assessments";
  return `/learn/${attempt.lessonId}/quiz/result/${attempt.id}`;
}

async function resolveCertificate(user, storedLink) {
  const match = /^\/certificates\/(\d+)/.exec(storedLink || "");
  if (!match) return "/certificates";
  const certificate = await Certificate.findByPk(Number(match[1]));
  if (!certificate) return "/certificates";
  if (certificate.userId !== user.id && user.role !== "superadmin") {
    return "/certificates";
  }
  return `/certificates/${certificate.id}`;
}

async function resolveLiveMeeting(user, storedLink) {
  const match = /^\/live\/(\d+)/.exec(storedLink || "");
  if (!match) return "/live";
  const meeting = await LiveMeeting.findByPk(Number(match[1]), {
    include: [{ model: Course, as: "course" }],
  });
  if (!meeting || !meeting.course) return "/live";
  const owner =
    meeting.instructorId === user.id || user.role === "superadmin";
  if (owner) return `/live/${meeting.id}`;
  const enrolled = await CourseEnrollment.findOne({
    where: { courseId: meeting.courseId, userId: user.id },
  });
  return enrolled ? `/live/${meeting.id}` : "/live";
}

async function resolveCourseDestination(user, storedLink) {
  const match = /^\/courses\/(\d+)/.exec(storedLink || "");
  if (!match) return null;
  const course = await Course.findByPk(Number(match[1]));
  if (!course) return "/courses";
  if (course.status === "published") return `/courses/${course.id}`;
  if (canManageCourse(user, course)) return `/courses/${course.id}`;
  return "/courses";
}

export async function resolveNotificationDestination(notification, user) {
  const storedLink = isInternalPath(notification.link) ? notification.link : null;
  const type = String(notification.type || "info").toLowerCase();

  if (type === "question_bank") {
    return (await resolveQuestionBank(user, storedLink)) || "/notifications";
  }
  if (type === "assessment") {
    return resolveAssessmentResult(user, storedLink);
  }
  if (type === "certificate") {
    return resolveCertificate(user, storedLink);
  }
  if (type === "live_class" || type === "live_meeting") {
    return resolveLiveMeeting(user, storedLink);
  }
  if (type === "lesson") {
    if (/^\/learn\/\d+/.test(storedLink || "")) return storedLink;
    const course = await resolveCourseDestination(user, storedLink);
    return course || "/courses";
  }
  if (["course", "assignment", "deadline", "announcement"].includes(type)) {
    const course = await resolveCourseDestination(user, storedLink);
    return course || (storedLink && roleAllowsPath(user, storedLink) ? storedLink : "/notifications");
  }

  if (storedLink && roleAllowsPath(user, storedLink)) return storedLink;
  return "/notifications";
}

export async function notificationRecipient(notification) {
  return User.findByPk(notification.userId, { attributes: ["id", "name", "role"] });
}
