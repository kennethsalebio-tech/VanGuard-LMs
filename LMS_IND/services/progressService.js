import crypto from "crypto";
import {
  Course,
  Module,
  Lesson,
  CourseEnrollment,
  LessonProgress,
  CourseProgress,
  Certificate,
  TrainingAssignment,
  Notification,
  User,
} from "../models/index.js";

export function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export async function getOrderedLessons(courseId, { includeDrafts = false } = {}) {
  const modules = await Module.findAll({
    where: { courseId },
    order: [
      ["orderIndex", "ASC"],
      ["id", "ASC"],
    ],
  });
  const where = { courseId };
  if (!includeDrafts) where.status = "published";
  const lessons = await Lesson.findAll({
    where,
    order: [
      ["orderIndex", "ASC"],
      ["id", "ASC"],
    ],
  });
  const order = new Map(modules.map((mod, index) => [mod.id, index]));
  return lessons
    .slice()
    .sort(
      (a, b) =>
        (order.get(a.moduleId) ?? 999) - (order.get(b.moduleId) ?? 999) ||
        a.orderIndex - b.orderIndex ||
        a.id - b.id
    );
}

export async function ensureEnrollment(userId, courseId, source = "self") {
  const [enrollment] = await CourseEnrollment.findOrCreate({
    where: { userId, courseId },
    defaults: { source, status: "active" },
  });
  return enrollment;
}

export async function ensureProgressRows(userId, courseId) {
  const lessons = await getOrderedLessons(courseId);
  const existing = await LessonProgress.findAll({ where: { userId, courseId } });
  const map = new Map(existing.map((row) => [row.lessonId, row]));

  for (let i = 0; i < lessons.length; i += 1) {
    if (!map.has(lessons[i].id)) {
      const [row] = await LessonProgress.findOrCreate({
        where: { lessonId: lessons[i].id, userId },
        defaults: {
          courseId,
          status: "locked",
        },
      });
      map.set(lessons[i].id, row);
    }
  }

  const hasAnyCompleted = [...map.values()].some((row) => row.status === "completed");
  if (!hasAnyCompleted && lessons.length && map.get(lessons[0].id)?.status === "locked") {
    await map.get(lessons[0].id).update({ status: "unlocked" });
  }
  return map;
}

export async function isLessonUnlocked(userId, lesson) {
  const lessons = await getOrderedLessons(lesson.courseId);
  const index = lessons.findIndex((item) => item.id === lesson.id);
  if (index <= 0) return true;
  const previous = lessons[index - 1];
  const progress = await LessonProgress.findOne({
    where: { lessonId: previous.id, userId },
  });
  return progress?.status === "completed";
}

export async function getNextLesson(courseId, lessonId) {
  const lessons = await getOrderedLessons(courseId);
  const index = lessons.findIndex((item) => item.id === lessonId);
  return index >= 0 ? lessons[index + 1] || null : null;
}

export async function recalcCourseProgress(userId, courseId) {
  const lessons = await getOrderedLessons(courseId);
  const progressRows = await LessonProgress.findAll({ where: { userId, courseId } });
  const completed = progressRows.filter((row) => row.status === "completed").length;
  const total = lessons.length;
  const percent = total ? Math.round((completed / total) * 100) : 0;

  const [courseProgress] = await CourseProgress.findOrCreate({
    where: { userId, courseId },
    defaults: { percent: 0, completedLessons: 0, totalLessons: total },
  });
  await courseProgress.update({
    percent,
    completedLessons: completed,
    totalLessons: total,
  });

  const enrollment = await CourseEnrollment.findOne({ where: { userId, courseId } });
  if (enrollment) {
    const complete = total > 0 && completed === total;
    await enrollment.update({
      status: complete ? "completed" : "active",
      completedAt: complete ? enrollment.completedAt || new Date() : null,
    });
  }

  if (percent >= 100) {
    await TrainingAssignment.update(
      { status: "completed" },
      { where: { userId, courseId } }
    );
    const course = await Course.findByPk(courseId);
    if (course?.certificateEnabled) {
      await issueCertificate(userId, courseId);
    }
  }

  return { percent, completed, total };
}

export async function issueCertificate(userId, courseId) {
  const existing = await Certificate.findOne({ where: { userId, courseId } });
  if (existing) return existing;

  const [user, course] = await Promise.all([
    User.findByPk(userId),
    Course.findByPk(courseId, {
      include: [{ association: "instructor" }],
    }),
  ]);
  if (!user || !course) return null;

  const certificateId = `VL-${new Date().getFullYear()}-${crypto
    .randomBytes(4)
    .toString("hex")
    .toUpperCase()}`;
  const certificate = await Certificate.create({
    certificateId,
    userId,
    courseId,
    learnerName: user.name,
    courseTitle: course.title,
    instructorName: course.instructor?.name || "Vanguard Learning & Development",
    verificationCode: crypto.randomBytes(8).toString("hex").toUpperCase(),
  });

  await notify(userId, {
    title: "Certificate available",
    message: `Your certificate for ${course.title} is ready to download.`,
    type: "certificate",
    link: `/certificates/${certificate.id}`,
  });
  return certificate;
}

export async function notify(userId, { title, message, type = "info", link = null }) {
  try {
    await Notification.create({ userId, title, message, type, link });
  } catch (error) {
    console.warn("Notification failed:", error.message);
  }
}

export function nextAttemptNumber(attempts = []) {
  return attempts.length + 1;
}
