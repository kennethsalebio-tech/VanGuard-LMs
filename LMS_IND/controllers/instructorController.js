import fs from "fs";
import path from "path";
import { Op } from "sequelize";
import {
  Course,
  CourseCategory,
  Module,
  Lesson,
  LessonContent,
  LearningResource,
  CourseEnrollment,
  LessonProgress,
  CourseProgress,
  QuestionBank,
  Question,
  QuestionOption,
  QuestionReview,
  Assessment,
  AssessmentAttempt,
  AttemptQuestion,
  User,
  Department,
  TrainingAssignment,
  Notification,
  sequelize,
} from "../models/index.js";
import {
  convertDocument,
  sanitizeLessonHtml,
} from "../services/documentConverter.js";
import { buildDocumentPreview } from "../services/documentPreview.js";
import {
  UploadError,
  cleanupPendingUploads,
  consumePendingUpload,
  createPendingUpload,
  extensionOf,
  getPendingUpload,
  isImageExtension,
  promoteFile,
  removePendingUpload,
  validateUploadedFile,
} from "../services/moduleUploadService.js";
import {
  generateQuestions,
  stripHtml,
} from "../services/questionGenerator.js";
import { getOrderedLessons, notify } from "../services/progressService.js";
import { canManageCourse, logActivity } from "../middleware/auth.js";
import { uploadDir } from "../middleware/upload.js";

const courseInclude = [
  { model: CourseCategory, as: "category" },
  { model: User, as: "instructor", attributes: ["id", "name"] },
];

function scopeFor(user) {
  return user.role === "superadmin" ? {} : { instructorId: user.id };
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadOwnedCourseForApi(req, res) {
  const course = await Course.findByPk(req.params.id);
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return null;
  }
  if (!canManageCourse(req.user, course)) {
    res.status(403).json({ error: "You can only upload to courses you manage." });
    return null;
  }
  return course;
}

async function loadResourceForPreview(req, res) {
  const resource = await LearningResource.findByPk(req.params.resourceId, {
    include: [
      {
        model: Lesson,
        as: "lesson",
        include: [{ model: Course, as: "course", include: courseInclude }],
      },
    ],
  });
  if (!resource) {
    res.status(404).render("error", {
      title: "Document not found",
      status: 404,
      message: "This uploaded document does not exist.",
    });
    return null;
  }
  if (!canManageCourse(req.user, resource.lesson?.course)) {
    res.status(403).render("error", {
      title: "Access denied",
      status: 403,
      message: "You can only preview documents in courses you manage.",
    });
    return null;
  }
  const absolutePath = path.resolve(process.cwd(), resource.filePath);
  const uploadsRoot = path.resolve(uploadDir);
  if (!absolutePath.startsWith(`${uploadsRoot}${path.sep}`) || !fs.existsSync(absolutePath)) {
    res.status(404).render("error", {
      title: "File missing",
      status: 404,
      message: "The uploaded document could not be found on the server.",
    });
    return null;
  }
  return { resource, absolutePath };
}

function sendInlineFile(res, next, { absolutePath, mimeType, fileName }) {
  const asciiName = String(fileName || "document")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(
      String(fileName || "document")
    )}`
  );
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
  res.type(mimeType || "application/octet-stream");
  return res.sendFile(absolutePath, (error) => {
    if (error && !res.headersSent) next(error);
  });
}

async function loadOwnedCourse(req, res) {
  const course = await Course.findByPk(req.params.id, {
    include: courseInclude,
  });
  if (!course) {
    res.status(404).render("error", {
      title: "Course not found",
      status: 404,
      message: "This course does not exist.",
    });
    return null;
  }
  if (!canManageCourse(req.user, course)) {
    res.status(403).render("error", {
      title: "Access denied",
      status: 403,
      message: "You can only manage courses that you created.",
    });
    return null;
  }
  return course;
}

async function refreshBankStatus(bankId, reviewerId = null) {
  const bank = await QuestionBank.findByPk(bankId);
  if (!bank) return null;

  const [approved, pending] = await Promise.all([
    Question.count({ where: { bankId, status: "approved" } }),
    Question.count({ where: { bankId, status: "pending" } }),
  ]);

  await bank.update({
    status: approved > 0 ? "approved" : "draft",
    reviewStatus:
      pending > 0 ? "pending_review" : approved > 0 ? "reviewed" : "none",
    lastReviewedAt: reviewerId ? new Date() : bank.lastReviewedAt,
    lastReviewedBy: reviewerId || bank.lastReviewedBy,
  });
  return { approved, pending };
}

/* -------------------------------------------------- question review records */

function normalizePrompt(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function recordQuestionReview(question, reviewerId, action, note = null) {
  // Never stack identical review records for the same reviewer/question.
  if (action !== "edited") {
    const last = await QuestionReview.findOne({
      where: { questionId: question.id },
      order: [["createdAt", "DESC"], ["id", "DESC"]],
    });
    if (last && last.action === action && last.reviewerId === reviewerId) return last;
  }
  return QuestionReview.create({
    questionId: question.id,
    questionBankId: question.bankId,
    reviewerId,
    action,
    note,
  });
}

async function notifyQuestionBankReview(lesson, pendingCount) {
  const link = `/instructor/lessons/${lesson.id}/questions`;
  const message = `${pendingCount} AI-assisted question(s) were generated for ${lesson.title}. Review and approve them before publishing.`;
  const existing = await Notification.findOne({
    where: {
      userId: lesson.course.instructorId,
      type: "question_bank",
      title: "Question bank ready for review",
      link,
      isRead: false,
    },
  });
  if (existing) {
    await existing.update({ message });
    return existing;
  }
  return notify(lesson.course.instructorId, {
    title: "Question bank ready for review",
    message,
    type: "question_bank",
    link,
  });
}

/* ------------------------------------------------------------- dashboard */

export async function dashboardPage(req, res) {
  const courses = await Course.findAll({
    where: scopeFor(req.user),
    include: courseInclude,
    order: [["createdAt", "DESC"]],
  });
  const courseIds = courses.map((course) => course.id);

  const [enrollments, attempts, assignments, pendingQuestions] = await Promise.all([
    courseIds.length
      ? CourseEnrollment.findAll({
          where: { courseId: { [Op.in]: courseIds } },
          include: [{ model: User, as: "user", attributes: ["id", "name", "lastLoginAt"] }],
        })
      : [],
    courseIds.length
      ? AssessmentAttempt.findAll({
          where: {
            courseId: { [Op.in]: courseIds },
            status: "submitted",
          },
          include: [{ model: Lesson, as: "lesson", attributes: ["id", "title"] }],
        })
      : [],
    courseIds.length
      ? TrainingAssignment.findAll({
          where: { courseId: { [Op.in]: courseIds } },
        })
      : [],
    courseIds.length
      ? Question.count({
          where: {
            status: "pending",
            lessonId: {
              [Op.in]: (
                await Lesson.findAll({
                  where: { courseId: { [Op.in]: courseIds } },
                  attributes: ["id"],
                })
              ).map((lesson) => lesson.id),
            },
          },
        })
      : 0,
  ]);

  const learners = new Map();
  for (const enrollment of enrollments) {
    if (enrollment.user) learners.set(enrollment.user.id, enrollment.user);
  }
  const avgScore = attempts.length
    ? Math.round(
        attempts.reduce(
          (sum, attempt) =>
            sum + (attempt.totalQuestions ? attempt.score / attempt.totalQuestions : 0) * 100,
          0
        ) / attempts.length
      )
    : 0;

  const progressRows = courseIds.length
    ? await CourseProgress.findAll({
        where: { courseId: { [Op.in]: courseIds } },
      })
    : [];
  const completionRate = progressRows.length
    ? Math.round(
        (progressRows.filter((row) => row.percent >= 100).length / progressRows.length) * 100
      )
    : 0;

  const courseStats = courses.map((course) => ({
    course,
    enrolled: enrollments.filter((row) => row.courseId === course.id).length,
    completed: progressRows.filter(
      (row) => row.courseId === course.id && row.percent >= 100
    ).length,
    avg: Math.round(
      progressRows
        .filter((row) => row.courseId === course.id)
        .reduce((sum, row) => sum + row.percent, 0) /
        Math.max(1, progressRows.filter((row) => row.courseId === course.id).length)
    ),
  }));

  const attemptsByLesson = new Map();
  for (const attempt of attempts) {
    if (!attemptsByLesson.has(attempt.lessonId)) attemptsByLesson.set(attempt.lessonId, []);
    attemptsByLesson.get(attempt.lessonId).push(attempt);
  }
  const struggling = progressRows
    .filter((row) => row.percent < 40)
    .slice(0, 6)
    .map((row) => ({
      ...row.toJSON(),
      learner: learners.get(row.userId),
      course: courses.find((course) => course.id === row.courseId),
    }));

  const pendingLesson = await Question.findOne({
    where: {
      status: "pending",
      lessonId: {
        [Op.in]: courseIds.length
          ? (
              await Lesson.findAll({
                where: { courseId: { [Op.in]: courseIds } },
                attributes: ["id"],
              })
            ).map((lesson) => lesson.id)
          : [-1],
      },
    },
    order: [["createdAt", "ASC"]],
  });

  res.render("instructor/dashboard", {
    title: "Instructor dashboard",
    stats: {
      courses: courses.length,
      learners: learners.size,
      activeLearners: [...learners.values()].filter(
        (learner) =>
          learner.lastLoginAt &&
          Date.now() - new Date(learner.lastLoginAt).getTime() < 30 * 24 * 60 * 60 * 1000
      ).length,
      completedCourses: progressRows.filter((row) => row.percent >= 100).length,
      avgScore,
      failedAttempts: attempts.filter((attempt) => !attempt.passed).length,
      completionRate,
      pendingQuestions,
    },
    courses: courseStats,
    struggling,
    assignments,
    pendingReviewLink: pendingLesson
      ? `/instructor/lessons/${pendingLesson.lessonId}/questions`
      : "/instructor/courses",
  });
}

/* ---------------------------------------------------------------- courses */

export async function coursesPage(req, res) {
  const courses = await Course.findAll({
    where: scopeFor(req.user),
    include: courseInclude,
    order: [["createdAt", "DESC"]],
  });
  const courseIds = courses.map((course) => course.id);
  const [modules, lessons, enrollments, progressRows] = await Promise.all([
    courseIds.length
      ? Module.findAll({ where: { courseId: { [Op.in]: courseIds } } })
      : [],
    courseIds.length
      ? Lesson.findAll({ where: { courseId: { [Op.in]: courseIds } } })
      : [],
    courseIds.length
      ? CourseEnrollment.findAll({ where: { courseId: { [Op.in]: courseIds } } })
      : [],
    courseIds.length
      ? CourseProgress.findAll({ where: { courseId: { [Op.in]: courseIds } } })
      : [],
  ]);

  const questionCounts = lessons.length
    ? await Question.findAll({
        where: {
          lessonId: { [Op.in]: lessons.map((lesson) => lesson.id) },
          status: "approved",
        },
        attributes: ["lessonId"],
      })
    : [];

  const view = courses.map((course) => ({
    ...course.toJSON(),
    moduleCount: modules.filter((mod) => mod.courseId === course.id).length,
    lessonCount: lessons.filter((lesson) => lesson.courseId === course.id).length,
    learnerCount: enrollments.filter((row) => row.courseId === course.id).length,
    approvedQuestions: questionCounts.filter(
      (q) => lessons.find((l) => l.id === q.lessonId)?.courseId === course.id
    ).length,
    avgProgress: Math.round(
      progressRows
        .filter((row) => row.courseId === course.id)
        .reduce((sum, row) => sum + row.percent, 0) /
        Math.max(1, progressRows.filter((row) => row.courseId === course.id).length)
    ),
  }));

  res.render("instructor/courses", {
    title: "My courses",
    courses: view,
  });
}

export async function newCoursePage(req, res) {
  const categories = await CourseCategory.findAll({ order: [["name", "ASC"]] });
  res.render("instructor/course-form", {
    title: "Create course",
    course: null,
    categories,
  });
}

export async function createCourse(req, res) {
  const categories = await CourseCategory.findAll({ order: [["name", "ASC"]] });
  const title = String(req.body.title || "").trim();
  if (title.length < 3) {
    req.flash("error_msg", "Enter a course title.");
    return res.redirect("/instructor/courses/new");
  }

  const questionCount = Math.max(1, Math.min(10, Number(req.body.questionCount) || 5));
  const passScore = Math.max(1, Math.min(questionCount, Number(req.body.passScore) || 4));

  const course = await Course.create({
    title,
    description: String(req.body.description || "").trim(),
    categoryId: req.body.categoryId ? Number(req.body.categoryId) : null,
    instructorId: req.user.id,
    objectives: String(req.body.objectives || "").trim(),
    durationHours: Number(req.body.durationHours) || 1,
    level: ["beginner", "intermediate", "advanced"].includes(req.body.level)
      ? req.body.level
      : "beginner",
    accent: /^#[0-9a-f]{6}$/i.test(req.body.accent || "") ? req.body.accent : "#1d4ed8",
    status: "draft",
    questionCount,
    passScore,
    maxAttempts: Math.max(0, Number(req.body.maxAttempts) || 0),
    allowRetakes: req.body.allowRetakes === "on",
    showExplanations: req.body.showExplanations === "on",
    certificateEnabled: req.body.certificateEnabled === "on",
  });

  await logActivity(req, "Created course", {
    entityType: "course",
    entityId: course.id,
    detail: course.title,
  });
  req.flash("success_msg", "Course created. Add a module, then upload your first lesson.");
  res.redirect(`/instructor/courses/${course.id}/builder`);
}

export async function editCoursePage(req, res) {
  const course = await loadOwnedCourse(req, res);
  if (!course) return;
  const categories = await CourseCategory.findAll({ order: [["name", "ASC"]] });
  res.render("instructor/course-form", {
    title: `Edit ${course.title}`,
    course,
    categories,
  });
}

export async function updateCourse(req, res) {
  const course = await loadOwnedCourse(req, res);
  if (!course) return;

  const questionCount = Math.max(1, Math.min(10, Number(req.body.questionCount) || 5));
  const passScore = Math.max(1, Math.min(questionCount, Number(req.body.passScore) || 4));
  const status = ["draft", "published", "archived"].includes(req.body.status)
    ? req.body.status
    : course.status;

  await course.update({
    title: String(req.body.title || course.title).trim(),
    description: String(req.body.description ?? "").trim(),
    categoryId: req.body.categoryId ? Number(req.body.categoryId) : null,
    objectives: String(req.body.objectives ?? "").trim(),
    durationHours: Number(req.body.durationHours) || course.durationHours,
    level: ["beginner", "intermediate", "advanced"].includes(req.body.level)
      ? req.body.level
      : course.level,
    accent: /^#[0-9a-f]{6}$/i.test(req.body.accent || "") ? req.body.accent : course.accent,
    questionCount,
    passScore,
    maxAttempts: Math.max(0, Number(req.body.maxAttempts) || 0),
    allowRetakes: req.body.allowRetakes === "on",
    showExplanations: req.body.showExplanations === "on",
    certificateEnabled: req.body.certificateEnabled === "on",
    status,
  });

  await Assessment.update(
    {
      questionCount,
      passScore,
      maxAttempts: course.maxAttempts,
      showExplanations: course.showExplanations,
    },
    { where: { courseId: course.id, type: "lesson_gate" } }
  );

  await logActivity(req, "Updated course settings", {
    entityType: "course",
    entityId: course.id,
    detail: course.title,
  });
  req.flash("success_msg", "Course settings saved.");
  res.redirect(`/instructor/courses/${course.id}/builder`);
}

export async function archiveCourse(req, res) {
  const course = await loadOwnedCourse(req, res);
  if (!course) return;
  const next = course.status === "archived" ? "draft" : "archived";
  await course.update({ status: next });
  req.flash("success_msg", `Course ${next === "archived" ? "archived" : "restored to draft"}.`);
  res.redirect("/instructor/courses");
}

/* ----------------------------------------------------------------- builder */

export async function builderPage(req, res) {
  const course = await loadOwnedCourse(req, res);
  if (!course) return;
  await cleanupPendingUploads().catch(() => {});

  const modules = await Module.findAll({
    where: { courseId: course.id },
    order: [["orderIndex", "ASC"]],
  });
  const lessons = await Lesson.findAll({
    where: { courseId: course.id },
    order: [["orderIndex", "ASC"]],
  });
  const lessonIds = lessons.map((lesson) => lesson.id);

  const [banks, questions, enrollments, contents] = await Promise.all([
    lessonIds.length
      ? QuestionBank.findAll({ where: { lessonId: { [Op.in]: lessonIds } } })
      : [],
    lessonIds.length
      ? Question.findAll({ where: { lessonId: { [Op.in]: lessonIds } } })
      : [],
    CourseEnrollment.count({ where: { courseId: course.id } }),
    lessonIds.length
      ? LessonContent.findAll({ where: { lessonId: { [Op.in]: lessonIds } } })
      : [],
  ]);

  const moduleList = modules.map((mod) => ({
    ...mod.toJSON(),
    lessons: lessons
      .filter((lesson) => lesson.moduleId === mod.id)
      .map((lesson) => {
        const lessonQuestions = questions.filter((q) => q.lessonId === lesson.id);
        return {
          ...lesson.toJSON(),
          bank: banks.find((bank) => bank.lessonId === lesson.id) || null,
          approved: lessonQuestions.filter((q) => q.status === "approved").length,
          pending: lessonQuestions.filter((q) => q.status === "pending").length,
          hasContent:
            (contents.find((content) => content.lessonId === lesson.id)?.html || "").length > 0,
        };
      }),
  }));

  res.render("instructor/builder", {
    title: `Builder — ${course.title}`,
    course,
    modules: moduleList,
    learnerCount: enrollments,
    requiredQuestions: course.questionCount,
  });
}

/* -------------------------------------------------------- module uploads */

export async function uploadModulePreview(req, res) {
  const course = await loadOwnedCourseForApi(req, res);
  if (!course) return;
  if (!req.file) {
    return res.status(400).json({ error: "Choose a document to upload." });
  }

  let token = null;
  try {
    const metadata = await createPendingUpload({
      file: req.file,
      userId: req.user.id,
      courseId: course.id,
    });
    token = metadata.token;
    const fileUrl = `/instructor/courses/${course.id}/uploads/${token}/file`;
    const preview = await buildDocumentPreview({
      filePath: req.file.path,
      fileName: metadata.originalName,
      mimeType: metadata.mimeType,
      fileUrl,
      downloadUrl: fileUrl,
    });
    return res.json({
      token,
      file: {
        name: metadata.originalName,
        size: metadata.sizeBytes,
        mimeType: metadata.mimeType,
        extension: extensionOf(metadata.originalName),
      },
      preview,
      expiresInHours: 24,
    });
  } catch (error) {
    if (token) {
      await removePendingUpload(token, {
        userId: req.user.id,
        courseId: course.id,
      }).catch(() => {});
    } else {
      await fs.promises.unlink(req.file.path).catch(() => {});
    }
    console.error("Module preview failed:", error);
    return res.status(error.status || 422).json({
      error:
        error.status && error.status < 500
          ? error.message
          : "The document could not be processed. Check that it is not damaged, then try again.",
      retryable: true,
    });
  }
}

export async function pendingUploadPreview(req, res) {
  const course = await loadOwnedCourseForApi(req, res);
  if (!course) return;
  try {
    const upload = await getPendingUpload(req.params.token, {
      userId: req.user.id,
      courseId: course.id,
    });
    const fileUrl = `/instructor/courses/${course.id}/uploads/${upload.token}/file`;
    const preview = await buildDocumentPreview({
      filePath: upload.filePath,
      fileName: upload.originalName,
      mimeType: upload.mimeType,
      fileUrl,
      downloadUrl: fileUrl,
    });
    res.json({ preview });
  } catch (error) {
    console.error("Pending preview failed:", error);
    res.status(error.status || 422).json({ error: error.message });
  }
}

export async function pendingUploadFile(req, res, next) {
  const course = await loadOwnedCourseForApi(req, res);
  if (!course) return;
  try {
    const upload = await getPendingUpload(req.params.token, {
      userId: req.user.id,
      courseId: course.id,
    });
    return sendInlineFile(res, next, {
      absolutePath: upload.filePath,
      mimeType: upload.mimeType,
      fileName: upload.originalName,
    });
  } catch (error) {
    return res.status(error.status || 404).json({ error: error.message });
  }
}

export async function removeModuleUpload(req, res) {
  const course = await loadOwnedCourseForApi(req, res);
  if (!course) return;
  try {
    await removePendingUpload(req.params.token, {
      userId: req.user.id,
      courseId: course.id,
    });
    return res.status(204).end();
  } catch (error) {
    return res.status(error.status || 404).json({ error: error.message });
  }
}

export async function resourcePreviewPage(req, res) {
  const loaded = await loadResourceForPreview(req, res);
  if (!loaded) return;
  const { resource, absolutePath } = loaded;
  const preview = await buildDocumentPreview({
    filePath: absolutePath,
    fileName: resource.fileName,
    mimeType: resource.mimeType,
    fileUrl: `/instructor/resources/${resource.id}/file`,
    downloadUrl: `/resources/${resource.id}/download`,
  });
  res.render("instructor/resource-preview", {
    title: `Document preview — ${resource.fileName}`,
    lesson: resource.lesson,
    resource,
    preview,
  });
}

export async function resourceFile(req, res, next) {
  const loaded = await loadResourceForPreview(req, res);
  if (!loaded) return;
  return sendInlineFile(res, next, {
    absolutePath: loaded.absolutePath,
    mimeType: loaded.resource.mimeType,
    fileName: loaded.resource.fileName,
  });
}

export async function createModule(req, res) {
  const course = await loadOwnedCourse(req, res);
  if (!course) return;
  const title = String(req.body.title || "").trim();
  if (title.length < 2) {
    req.flash("error_msg", "Enter a module title.");
    return res.redirect(`/instructor/courses/${course.id}/builder`);
  }
  const count = await Module.count({ where: { courseId: course.id } });
  await Module.create({
    courseId: course.id,
    title,
    description: String(req.body.description || "").trim(),
    orderIndex: count,
  });
  req.flash("success_msg", "Module added.");
  res.redirect(`/instructor/courses/${course.id}/builder`);
}

export async function deleteModule(req, res) {
  const course = await loadOwnedCourse(req, res);
  if (!course) return;
  const mod = await Module.findOne({
    where: { id: req.params.moduleId, courseId: course.id },
  });
  if (!mod) {
    req.flash("error_msg", "Module not found.");
    return res.redirect(`/instructor/courses/${course.id}/builder`);
  }
  const lessons = await Lesson.findAll({ where: { moduleId: mod.id } });
  if (lessons.length) {
    req.flash("error_msg", "Move or delete the lessons in this module first.");
    return res.redirect(`/instructor/courses/${course.id}/builder`);
  }
  await mod.destroy();
  req.flash("success_msg", "Module deleted.");
  res.redirect(`/instructor/courses/${course.id}/builder`);
}

/* ------------------------------------------------------------------ lessons */

export async function createLesson(req, res) {
  const course = await loadOwnedCourse(req, res);
  if (!course) return;

  const moduleId = Number(req.body.moduleId);
  const mod = await Module.findOne({ where: { id: moduleId, courseId: course.id } });
  if (!mod) {
    req.flash("error_msg", "Choose a module for this lesson.");
    return res.redirect(`/instructor/courses/${course.id}/builder`);
  }

  let source = null;
  let cleanupPath = req.file?.path || null;

  try {
    // A successful AJAX upload already owns the file. If a browser also submits
    // the old multipart field, keep the previewed token and discard the extra copy.
    if (req.body.upload_token && req.file) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      req.file = null;
      cleanupPath = null;
    }

    if (req.body.upload_token) {
      source = await consumePendingUpload(req.body.upload_token, {
        userId: req.user.id,
        courseId: course.id,
      });
      cleanupPath = source.absolutePath;
    } else if (req.file) {
      const validated = await validateUploadedFile(
        req.file.path,
        req.file.originalname,
        req.file.mimetype
      );
      const relativePath = await promoteFile(req.file.path);
      source = {
        originalName: path.basename(req.file.originalname).slice(0, 180),
        mimeType: validated.mimeType,
        size: validated.sizeBytes,
        path: relativePath,
        absolutePath: path.resolve(process.cwd(), relativePath),
      };
      cleanupPath = source.absolutePath;
    }

    const sourceBaseName = source
      ? path.basename(source.originalName, path.extname(source.originalName))
      : "";
    const title = String(req.body.title || "").trim() || sourceBaseName;
    if (!title) {
      if (source) await fs.promises.unlink(source.absolutePath).catch(() => {});
      req.flash("error_msg", "Enter a lesson title.");
      return res.redirect(`/instructor/courses/${course.id}/builder`);
    }

    let contentHtml = "";
    let plainText = "";
    let conversionNotes = [];
    const imageSource = source && isImageExtension(extensionOf(source.originalName));

    if (source && !imageSource) {
      const buffer = await fs.promises.readFile(source.absolutePath);
      const converted = await convertDocument({
        buffer,
        fileName: source.originalName,
        mimeType: source.mimeType,
      });
      contentHtml = sanitizeLessonHtml(converted.html);
      plainText = converted.plainText;
      conversionNotes = converted.notes || [];
    } else if (!source && req.body.content_html) {
      contentHtml = sanitizeLessonHtml(req.body.content_html);
      plainText = stripHtml(contentHtml);
    }

    if (!contentHtml.trim() && !imageSource) {
      if (source) await fs.promises.unlink(source.absolutePath).catch(() => {});
      req.flash(
        "error_msg",
        "Upload a module or paste lesson content. The lesson needs readable content."
      );
      return res.redirect(`/instructor/courses/${course.id}/builder`);
    }

    const count = await Lesson.count({ where: { moduleId: mod.id } });
    let lesson = null;
    await sequelize.transaction(async (transaction) => {
      lesson = await Lesson.create(
        {
          courseId: course.id,
          moduleId: mod.id,
          title: title.slice(0, 160),
          summary: String(req.body.summary || "").trim().slice(0, 400),
          orderIndex: count,
          durationMinutes: Number(req.body.durationMinutes) || 15,
          status: "draft",
          sourceFile: source ? source.path : null,
          sourceMime: source ? source.mimeType : null,
          sourceName: source ? source.originalName : null,
        },
        { transaction }
      );

      let resource = null;
      if (source) {
        resource = await LearningResource.create(
          {
            lessonId: lesson.id,
            title: source.originalName,
            fileName: source.originalName,
            filePath: source.path,
            mimeType: source.mimeType,
            sizeBytes: source.size,
            isDownloadable: true,
          },
          { transaction }
        );
      }

      if (imageSource && resource) {
        contentHtml = sanitizeLessonHtml(
          `<figure class="lesson-image-document">
            <img src="/resources/${resource.id}/file" alt="${escapeHtml(title)}" />
            <figcaption>${escapeHtml(source.originalName)}</figcaption>
          </figure>`
        );
        plainText = `Image document: ${source.originalName}`;
      }

      await LessonContent.create(
        {
          lessonId: lesson.id,
          html: contentHtml,
          plainText,
          sections: JSON.stringify([]),
          conversionNotes: conversionNotes.join(" ").slice(0, 1000),
        },
        { transaction }
      );

      await QuestionBank.create(
        {
          lessonId: lesson.id,
          courseId: course.id,
          title: `${lesson.title} — Question Bank`,
          status: "draft",
          generator: process.env.LLM_API_KEY ? "ai_llm" : "ai_local",
        },
        { transaction }
      );
    });

    await logActivity(req, "Converted module to lesson", {
      entityType: "lesson",
      entityId: lesson.id,
      detail: lesson.title,
    });
    req.flash(
      "success_msg",
      "Module converted into a webpage lesson. Review the document preview and content, then generate and approve questions."
    );
    return res.redirect(`/instructor/lessons/${lesson.id}/edit`);
  } catch (error) {
    if (cleanupPath) await fs.promises.unlink(cleanupPath).catch(() => {});
    console.error("Lesson conversion failed:", error);
    req.flash("error_msg", `Could not convert the module: ${error.message}`);
    return res.redirect(`/instructor/courses/${course.id}/builder`);
  }
}

export async function lessonEditPage(req, res) {
  const lesson = await Lesson.findByPk(req.params.lessonId, {
    include: [
      { model: Course, as: "course", include: courseInclude },
      { model: LessonContent, as: "content" },
      { model: LearningResource, as: "resources" },
      { model: Module, as: "module" },
    ],
  });
  if (!lesson) {
    return res.status(404).render("error", {
      title: "Lesson not found",
      status: 404,
      message: "This lesson does not exist.",
    });
  }
  if (!canManageCourse(req.user, lesson.course)) {
    return res.status(403).render("error", {
      title: "Access denied",
      status: 403,
      message: "You can only edit lessons in courses you created.",
    });
  }

  const questions = await Question.findAll({
    where: { lessonId: lesson.id },
    include: [{ model: QuestionOption, as: "options" }],
    order: [["orderIndex", "ASC"]],
  });

  res.render("instructor/lesson-edit", {
    title: `Edit lesson — ${lesson.title}`,
    lesson,
    approved: questions.filter((q) => q.status === "approved").length,
    pending: questions.filter((q) => q.status === "pending").length,
    requiredQuestions: lesson.course.questionCount,
  });
}

export async function updateLesson(req, res) {
  const lesson = await Lesson.findByPk(req.params.lessonId, {
    include: [{ model: Course, as: "course" }, { model: LessonContent, as: "content" }],
  });
  if (!lesson) {
    return res.status(404).render("error", {
      title: "Lesson not found",
      status: 404,
      message: "This lesson does not exist.",
    });
  }
  if (!canManageCourse(req.user, lesson.course)) {
    return res.status(403).render("error", {
      title: "Access denied",
      status: 403,
      message: "You can only edit lessons in courses you created.",
    });
  }

  const html = sanitizeLessonHtml(String(req.body.content_html || ""));
  if (!html.trim() && req.body.status === "published") {
    req.flash("error_msg", "A lesson needs webpage content before it can be published.");
    return res.redirect(`/instructor/lessons/${lesson.id}/edit`);
  }

  const approved = await Question.count({
    where: { lessonId: lesson.id, status: "approved" },
  });
  const wantsPublish = req.body.status === "published";
  if (wantsPublish && approved < lesson.course.questionCount) {
    req.flash(
      "error_msg",
      `Publish blocked: ${lesson.course.questionCount} approved questions are required, but only ${approved} are approved. Generate and approve the question bank first.`
    );
    return res.redirect(`/instructor/lessons/${lesson.id}/questions`);
  }

  await lesson.update({
    title: String(req.body.title || lesson.title).trim().slice(0, 160),
    summary: String(req.body.summary ?? "").trim().slice(0, 400),
    durationMinutes: Number(req.body.durationMinutes) || lesson.durationMinutes,
    status: wantsPublish ? "published" : "draft",
  });

  if (lesson.content) {
    await lesson.content.update({
      html,
      plainText: stripHtml(html),
    });
  } else {
    await LessonContent.create({
      lessonId: lesson.id,
      html,
      plainText: stripHtml(html),
    });
  }

  if (wantsPublish) {
    const enrollments = await CourseEnrollment.findAll({
      where: { courseId: lesson.courseId },
    });
    for (const enrollment of enrollments) {
      await notify(enrollment.userId, {
        title: "New lesson published",
        message: `${lesson.title} is now available in ${lesson.course.title}.`,
        type: "lesson",
        link: `/learn/${lesson.id}`,
      });
    }
  }

  await logActivity(req, wantsPublish ? "Published lesson" : "Updated lesson", {
    entityType: "lesson",
    entityId: lesson.id,
    detail: lesson.title,
  });
  req.flash(
    "success_msg",
    wantsPublish
      ? "Lesson published. Learners who have unlocked it can now study it."
      : "Lesson saved as draft."
  );
  res.redirect(`/instructor/lessons/${lesson.id}/edit`);
}

export async function deleteLesson(req, res) {
  const lesson = await Lesson.findByPk(req.params.lessonId, {
    include: [{ model: Course, as: "course" }],
  });
  if (!lesson || !canManageCourse(req.user, lesson.course)) {
    req.flash("error_msg", "Lesson not found or not editable.");
    return res.redirect("/instructor/courses");
  }
  const attempts = await AssessmentAttempt.count({ where: { lessonId: lesson.id } });
  if (attempts > 0) {
    req.flash(
      "error_msg",
      "This lesson already has assessment attempts and cannot be deleted. Unpublish it instead."
    );
    return res.redirect(`/instructor/lessons/${lesson.id}/edit`);
  }
  const courseId = lesson.courseId;
  await AttemptQuestion.destroy({
    where: {
      questionId: {
        [Op.in]: (
          await Question.findAll({ where: { lessonId: lesson.id }, attributes: ["id"] })
        ).map((q) => q.id),
      },
    },
  });
  await QuestionOption.destroy({
    where: {
      questionId: {
        [Op.in]: (
          await Question.findAll({ where: { lessonId: lesson.id }, attributes: ["id"] })
        ).map((q) => q.id),
      },
    },
  });
  await Question.destroy({ where: { lessonId: lesson.id } });
  await QuestionBank.destroy({ where: { lessonId: lesson.id } });
  await LessonProgress.destroy({ where: { lessonId: lesson.id } });
  await LearningResource.destroy({ where: { lessonId: lesson.id } });
  await LessonContent.destroy({ where: { lessonId: lesson.id } });
  await Assessment.destroy({ where: { lessonId: lesson.id } });
  const sourceFile = lesson.sourceFile;
  await lesson.destroy();
  if (sourceFile) fs.unlink(path.resolve(process.cwd(), sourceFile), () => {});
  req.flash("success_msg", "Lesson deleted.");
  res.redirect(`/instructor/courses/${courseId}/builder`);
}

/* ------------------------------------------------------------ question bank */

export async function questionsPage(req, res) {
  const lesson = await Lesson.findByPk(req.params.lessonId, {
    include: [
      { model: Course, as: "course", include: courseInclude },
      { model: LessonContent, as: "content" },
      { model: QuestionBank, as: "questionBank" },
    ],
  });
  if (!lesson) {
    return res.status(404).render("error", {
      title: "Lesson not found",
      status: 404,
      message: "This lesson does not exist.",
    });
  }
  if (!canManageCourse(req.user, lesson.course)) {
    return res.status(403).render("error", {
      title: "Access denied",
      status: 403,
      message: "You can only manage question banks for your own courses.",
    });
  }

  const questions = await Question.findAll({
    where: { lessonId: lesson.id },
    include: [{ model: QuestionOption, as: "options" }],
    order: [["orderIndex", "ASC"]],
  });

  res.render("instructor/questions", {
    title: `Question bank — ${lesson.title}`,
    lesson,
    bank: lesson.questionBank,
    questions,
    approved: questions.filter((q) => q.status === "approved").length,
    pending: questions.filter((q) => q.status === "pending").length,
    rejected: questions.filter((q) => q.status === "rejected").length,
    requiredQuestions: lesson.course.questionCount,
    engine: lesson.questionBank?.generator || null,
  });
}

export async function generateQuestionsAction(req, res) {
  const lesson = await Lesson.findByPk(req.params.lessonId, {
    include: [
      { model: Course, as: "course" },
      { model: LessonContent, as: "content" },
      { model: QuestionBank, as: "questionBank" },
    ],
  });
  if (!lesson || !canManageCourse(req.user, lesson.course)) {
    req.flash("error_msg", "Lesson not found or not editable.");
    return res.redirect("/instructor/courses");
  }
  if (!lesson.content?.plainText) {
    req.flash("error_msg", "Add lesson content before generating questions.");
    return res.redirect(`/instructor/lessons/${lesson.id}/edit`);
  }

  const count = Math.max(20, Math.min(50, Number(req.body.count) || 25));
  const result = await generateQuestions({
    text: lesson.content.plainText,
    count,
  });

  if (!result.questions.length) {
    req.flash(
      "error_msg",
      result.reason || "No questions could be generated from this module."
    );
    return res.redirect(`/instructor/lessons/${lesson.id}/questions`);
  }

  // Skip prompts that already exist in this lesson (in any status) so an
  // instructor can re-run generation without duplicating the bank.
  const existingPrompts = new Set(
    (
      await Question.findAll({
        where: { lessonId: lesson.id },
        attributes: ["prompt"],
      })
    ).map((question) => normalizePrompt(question.prompt))
  );
  const candidates = [];
  for (const question of result.questions) {
    const key = normalizePrompt(question.prompt);
    if (!key || existingPrompts.has(key)) continue;
    existingPrompts.add(key);
    candidates.push(question);
  }
  if (!candidates.length) {
    req.flash(
      "success_msg",
      "Every generated question already exists in this bank. No duplicates were saved."
    );
    return res.redirect(`/instructor/lessons/${lesson.id}/questions`);
  }

  let bank = lesson.questionBank;
  if (!bank) {
    bank = await QuestionBank.create({
      lessonId: lesson.id,
      courseId: lesson.courseId,
      title: `${lesson.title} — Question Bank`,
      status: "draft",
      generator: result.engine === "llm" ? "ai_llm" : "ai_local",
    });
  } else {
    await bank.update({
      generator: result.engine === "llm" ? "ai_llm" : "ai_local",
    });
  }

  const offset = await Question.count({
    where: { lessonId: lesson.id, generatedBy: "ai" },
  });

  for (let i = 0; i < candidates.length; i += 1) {
    const q = candidates[i];
    const question = await Question.create({
      bankId: bank.id,
      lessonId: lesson.id,
      type: q.type,
      prompt: q.prompt,
      explanation: q.explanation,
      sourceRef: q.sourceRef,
      difficulty: q.difficulty,
      status: "pending",
      generatedBy: "ai",
      orderIndex: offset + i,
    });
    await QuestionOption.bulkCreate(
      q.options.map((option, index) => ({
        questionId: question.id,
        text: option.text,
        isCorrect: option.isCorrect,
        orderIndex: index,
      }))
    );
  }
  await refreshBankStatus(bank.id, req.user.id);
  await notifyQuestionBankReview(lesson, candidates.length);

  await logActivity(req, "Generated AI-assisted questions", {
    entityType: "lesson",
    entityId: lesson.id,
    detail: `${candidates.length} pending questions (${result.engine})`,
  });

  const engineLabel = result.engine === "llm" ? "LLM" : "local NLP";
  const skipped = result.questions.length - candidates.length;
  req.flash(
    "success_msg",
    `${candidates.length} questions generated with the ${engineLabel} engine and saved as pending. Review each question before approving it.${skipped > 0 ? ` ${skipped} duplicate question(s) were skipped.` : ""}${result.reason ? ` ${result.reason}` : ""}`
  );
  res.redirect(`/instructor/lessons/${lesson.id}/questions`);
}

export async function approveQuestion(req, res) {
  const question = await Question.findByPk(req.params.questionId, {
    include: [{ model: QuestionBank, as: "bank" }],
  });
  if (!question) {
    req.flash("error_msg", "Question not found.");
    return res.redirect("/instructor/courses");
  }
  const lesson = await Lesson.findByPk(question.lessonId, {
    include: [{ model: Course, as: "course" }],
  });
  if (!canManageCourse(req.user, lesson.course)) {
    req.flash("error_msg", "You cannot approve questions for this course.");
    return res.redirect("/instructor/courses");
  }
  if (question.status === "approved") {
    req.flash("success_msg", "This question is already approved.");
    return res.redirect(`/instructor/lessons/${question.lessonId}/questions`);
  }

  await question.update({ status: "approved" });
  await recordQuestionReview(question, req.user.id, "approved");
  const counts = await refreshBankStatus(question.bankId, req.user.id);
  req.flash(
    "success_msg",
    `Question approved. ${counts?.approved || 0} question(s) in this bank are approved.`
  );
  res.redirect(`/instructor/lessons/${question.lessonId}/questions`);
}

export async function rejectQuestion(req, res) {
  const question = await Question.findByPk(req.params.questionId);
  if (!question) {
    req.flash("error_msg", "Question not found.");
    return res.redirect("/instructor/courses");
  }
  const lesson = await Lesson.findByPk(question.lessonId, {
    include: [{ model: Course, as: "course" }],
  });
  if (!canManageCourse(req.user, lesson.course)) {
    req.flash("error_msg", "You cannot reject questions for this course.");
    return res.redirect("/instructor/courses");
  }
  await question.update({ status: "rejected" });
  await recordQuestionReview(question, req.user.id, "rejected");
  await refreshBankStatus(question.bankId, req.user.id);
  req.flash("success_msg", "Question rejected. It will not appear in assessments.");
  res.redirect(`/instructor/lessons/${question.lessonId}/questions`);
}

export async function deleteQuestion(req, res) {
  const question = await Question.findByPk(req.params.questionId);
  if (!question) {
    req.flash("error_msg", "Question not found.");
    return res.redirect("/instructor/courses");
  }
  const lesson = await Lesson.findByPk(question.lessonId, {
    include: [{ model: Course, as: "course" }],
  });
  if (!canManageCourse(req.user, lesson.course)) {
    req.flash("error_msg", "You cannot delete questions for this course.");
    return res.redirect("/instructor/courses");
  }
  const lessonId = question.lessonId;
  const bankId = question.bankId;
  await QuestionOption.destroy({ where: { questionId: question.id } });
  await QuestionReview.destroy({ where: { questionId: question.id } });
  await question.destroy();
  await refreshBankStatus(bankId, req.user.id);
  req.flash("success_msg", "Question deleted.");
  res.redirect(`/instructor/lessons/${lessonId}/questions`);
}

export async function approveAllQuestions(req, res) {
  const lesson = await Lesson.findByPk(req.params.lessonId, {
    include: [
      { model: Course, as: "course" },
      { model: QuestionBank, as: "questionBank" },
    ],
  });
  if (!lesson || !canManageCourse(req.user, lesson.course) || !lesson.questionBank) {
    req.flash("error_msg", "Question bank not found.");
    return res.redirect("/instructor/courses");
  }
  const pendingRows = await Question.findAll({
    where: { lessonId: lesson.id, status: "pending" },
  });
  if (!pendingRows.length) {
    req.flash("success_msg", "There are no pending questions to approve.");
    return res.redirect(`/instructor/lessons/${lesson.id}/questions`);
  }

  let count = 0;
  await sequelize.transaction(async (transaction) => {
    const [updated] = await Question.update(
      { status: "approved" },
      {
        where: { id: { [Op.in]: pendingRows.map((row) => row.id) } },
        transaction,
      }
    );
    count = updated;
    await QuestionReview.bulkCreate(
      pendingRows.map((row) => ({
        questionId: row.id,
        questionBankId: row.bankId,
        reviewerId: req.user.id,
        action: "approved",
        note: "Approved in bulk review",
      })),
      { transaction }
    );
  });

  const counts = await refreshBankStatus(lesson.questionBank.id, req.user.id);
  await notify(req.user.id, {
    title: "Question bank approved",
    message: `${count} question(s) for ${lesson.title} were approved. ${counts?.approved || 0} question(s) are ready for the randomized knowledge check.`,
    type: "question_bank",
    link: `/instructor/lessons/${lesson.id}/questions`,
  });
  req.flash("success_msg", `${count} question(s) approved and added to the randomized pool.`);
  res.redirect(`/instructor/lessons/${lesson.id}/questions`);
}

export async function createManualQuestion(req, res) {
  const lesson = await Lesson.findByPk(req.params.lessonId, {
    include: [
      { model: Course, as: "course" },
      { model: QuestionBank, as: "questionBank" },
    ],
  });
  if (!lesson || !canManageCourse(req.user, lesson.course)) {
    req.flash("error_msg", "Lesson not found or not editable.");
    return res.redirect("/instructor/courses");
  }

  const prompt = String(req.body.prompt || "").trim();
  const options = [1, 2, 3, 4].map((n) => String(req.body[`option${n}`] || "").trim());
  const correctIndex = Number(req.body.correct);
  if (!prompt || options.some((option) => !option) || !(correctIndex >= 0 && correctIndex < 4)) {
    req.flash("error_msg", "Provide a question, four options, and select the correct answer.");
    return res.redirect(`/instructor/lessons/${lesson.id}/questions`);
  }

  let bank = lesson.questionBank;
  if (!bank) {
    bank = await QuestionBank.create({
      lessonId: lesson.id,
      courseId: lesson.courseId,
      title: `${lesson.title} — Question Bank`,
      status: "approved",
      generator: "instructor",
    });
  }
  const orderIndex = await Question.count({ where: { lessonId: lesson.id } });
  const question = await Question.create({
    bankId: bank.id,
    lessonId: lesson.id,
    type: "mcq",
    prompt,
    explanation: String(req.body.explanation || "").trim(),
    sourceRef: "Instructor-authored",
    difficulty: ["easy", "medium", "hard"].includes(req.body.difficulty)
      ? req.body.difficulty
      : "medium",
    status: "approved",
    generatedBy: "instructor",
    orderIndex,
  });
  await QuestionOption.bulkCreate(
    options.map((text, index) => ({
      questionId: question.id,
      text,
      isCorrect: index === correctIndex,
      orderIndex: index,
    }))
  );
  await refreshBankStatus(bank.id);

  req.flash("success_msg", "Manual question added and approved.");
  res.redirect(`/instructor/lessons/${lesson.id}/questions`);
}

export async function editQuestionPage(req, res) {
  const question = await Question.findByPk(req.params.questionId, {
    include: [
      { model: QuestionOption, as: "options" },
      { model: QuestionBank, as: "bank" },
    ],
  });
  if (!question) {
    return res.status(404).render("error", {
      title: "Question not found",
      status: 404,
      message: "This question does not exist.",
    });
  }
  const lesson = await Lesson.findByPk(question.lessonId, {
    include: [{ model: Course, as: "course" }],
  });
  if (!canManageCourse(req.user, lesson.course)) {
    return res.status(403).render("error", {
      title: "Access denied",
      status: 403,
      message: "You can only edit questions for your own courses.",
    });
  }
  const options = question.options.slice().sort((a, b) => a.orderIndex - b.orderIndex);
  res.render("instructor/question-edit", {
    title: "Edit question",
    question,
    options,
    lesson,
  });
}

export async function updateQuestion(req, res) {
  const question = await Question.findByPk(req.params.questionId, {
    include: [{ model: QuestionOption, as: "options" }],
  });
  if (!question) {
    req.flash("error_msg", "Question not found.");
    return res.redirect("/instructor/courses");
  }
  const lesson = await Lesson.findByPk(question.lessonId, {
    include: [{ model: Course, as: "course" }],
  });
  if (!canManageCourse(req.user, lesson.course)) {
    req.flash("error_msg", "You cannot edit questions for this course.");
    return res.redirect("/instructor/courses");
  }

  const prompt = String(req.body.prompt || "").trim();
  const explanation = String(req.body.explanation || "").trim();
  const correctId = Number(req.body.correct_option);
  if (!prompt) {
    req.flash("error_msg", "Question text is required.");
    return res.redirect(`/instructor/questions/${question.id}/edit`);
  }

  const options = question.options.slice().sort((a, b) => a.orderIndex - b.orderIndex);
  let hasCorrect = false;
  for (const option of options) {
    const text = String(req.body[`option_${option.id}`] ?? option.text).trim();
    const isCorrect = option.id === correctId;
    if (isCorrect) hasCorrect = true;
    await option.update({ text, isCorrect });
  }
  if (!hasCorrect) {
    req.flash("error_msg", "Select the correct answer.");
    return res.redirect(`/instructor/questions/${question.id}/edit`);
  }

  await question.update({
    prompt,
    explanation,
    difficulty: ["easy", "medium", "hard"].includes(req.body.difficulty)
      ? req.body.difficulty
      : question.difficulty,
  });
  await recordQuestionReview(
    question,
    req.user.id,
    "edited",
    "Question text or answer choices updated"
  );
  req.flash("success_msg", "Question updated.");
  res.redirect(`/instructor/lessons/${question.lessonId}/questions`);
}

/* -------------------------------------------------------------- monitoring */

export async function learnersPage(req, res) {
  const courses = await Course.findAll({
    where: scopeFor(req.user),
    include: courseInclude,
    order: [["createdAt", "DESC"]],
  });
  const courseIds = courses.map((course) => course.id);

  const enrollments = courseIds.length
    ? await CourseEnrollment.findAll({
        where: { courseId: { [Op.in]: courseIds } },
        include: [
          {
            model: User,
            as: "user",
            attributes: ["id", "name", "email", "employeeId", "lastLoginAt"],
            include: [{ model: Department, as: "department" }],
          },
          { model: Course, as: "course" },
        ],
        order: [["createdAt", "DESC"]],
      })
    : [];

  const [progressRows, attempts] = await Promise.all([
    courseIds.length
      ? CourseProgress.findAll({ where: { courseId: { [Op.in]: courseIds } } })
      : [],
    courseIds.length
      ? AssessmentAttempt.findAll({
          where: { courseId: { [Op.in]: courseIds }, status: "submitted" },
        })
      : [],
  ]);

  const progressMap = new Map(
    progressRows.map((row) => [`${row.userId}-${row.courseId}`, row])
  );
  const learners = enrollments.map((enrollment) => {
    const learnerAttempts = attempts.filter(
      (attempt) =>
        attempt.userId === enrollment.userId && attempt.courseId === enrollment.courseId
    );
    const passed = learnerAttempts.filter((attempt) => attempt.passed).length;
    return {
      ...enrollment.toJSON(),
      progress: progressMap.get(`${enrollment.userId}-${enrollment.courseId}`) || null,
      attempts: learnerAttempts.length,
      passed,
      struggling: (progressMap.get(`${enrollment.userId}-${enrollment.courseId}`)?.percent || 0) < 40,
    };
  });

  res.render("instructor/learners", {
    title: "Learner monitoring",
    learners,
    courses,
  });
}

export async function courseLearnersPage(req, res) {
  const course = await loadOwnedCourse(req, res);
  if (!course) return;

  const [enrollments, progressRows, lessons] = await Promise.all([
    CourseEnrollment.findAll({
      where: { courseId: course.id },
      include: [
        {
          model: User,
          as: "user",
          include: [{ model: Department, as: "department" }],
        },
      ],
      order: [["createdAt", "DESC"]],
    }),
    CourseProgress.findAll({ where: { courseId: course.id } }),
    getOrderedLessons(course.id),
  ]);
  const attempts = await AssessmentAttempt.findAll({
    where: { courseId: course.id, status: "submitted" },
    include: [{ model: Lesson, as: "lesson", attributes: ["id", "title"] }],
    order: [["submittedAt", "DESC"]],
  });

  const progressMap = new Map(progressRows.map((row) => [row.userId, row]));
  const rows = enrollments.map((enrollment) => {
    const learnerAttempts = attempts.filter(
      (attempt) => attempt.userId === enrollment.userId
    );
    return {
      ...enrollment.toJSON(),
      progress: progressMap.get(enrollment.userId) || null,
      attempts: learnerAttempts,
      average: learnerAttempts.length
        ? Math.round(
            learnerAttempts.reduce(
              (sum, attempt) =>
                sum + (attempt.totalQuestions ? attempt.score / attempt.totalQuestions : 0) * 100,
              0
            ) / learnerAttempts.length
          )
        : null,
    };
  });

  res.render("instructor/course-learners", {
    title: `Learners — ${course.title}`,
    course,
    rows,
    lessons,
  });
}
