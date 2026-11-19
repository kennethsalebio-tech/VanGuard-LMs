import bcrypt from "bcrypt";
import path from "path";
import fs from "fs";
import { Op } from "sequelize";
import {
  Course,
  CourseCategory,
  Module,
  Lesson,
  LessonContent,
  LearningResource,
  CourseEnrollment,
  CoursePurchase,
  LessonProgress,
  CourseProgress,
  Certificate,
  Notification,
  Question,
  QuestionOption,
  Assessment,
  AssessmentAttempt,
  AttemptQuestion,
  TrainingAssignment,
  User,
  Department,
  Position,
} from "../models/index.js";
import {
  ensureEnrollment,
  ensureProgressRows,
  getOrderedLessons,
  isLessonUnlocked,
  recalcCourseProgress,
  getNextLesson,
  notify,
  shuffle,
} from "../services/progressService.js";
import { canManageCourse, logActivity } from "../middleware/auth.js";
import { formatPercent, percentOf } from "../services/scoring.js";
import { resolveNotificationDestination } from "../services/notificationService.js";
import {
  courseIsPaid,
  findPaidPurchase,
  paymentBadgeFor,
  reconcileLearnerPayments,
  selectPaymentPurchase,
} from "../services/financeService.js";

const courseInclude = [
  { model: User, as: "instructor", attributes: ["id", "name"] },
  { model: CourseCategory, as: "category" },
];

function letter(index) {
  return String.fromCharCode(65 + index);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ home */

export const homePage = (req, res) => {
  if (req.user) return res.redirect("/dashboard");
  res.render("home", { title: "Vanguard Learning" });
};

/* ------------------------------------------------------------- dashboard */

export async function dashboardPage(req, res) {
  if (req.user.role !== "learner") {
    const map = {
      superadmin: "/admin",
      hr: "/admin/hr",
      instructor: "/instructor",
    };
    return res.redirect(map[req.user.role] || "/dashboard");
  }

  const userId = req.user.id;
  const [enrollments, progressRows, lessonRows, certificates, notifications, assignments] =
    await Promise.all([
      CourseEnrollment.findAll({
        where: { userId },
        include: [{ model: Course, as: "course", include: courseInclude }],
        order: [["createdAt", "DESC"]],
      }),
      CourseProgress.findAll({ where: { userId } }),
      LessonProgress.findAll({
        where: { userId },
        include: [
          {
            model: Lesson,
            as: "lesson",
            required: true,
            where: { status: "published" },
            include: [{ model: Course, as: "course", include: courseInclude }],
          },
        ],
        order: [["updatedAt", "DESC"]],
      }),
      Certificate.findAll({ where: { userId }, include: [{ model: Course, as: "course" }] }),
      Notification.findAll({
        where: { userId },
        order: [["createdAt", "DESC"]],
        limit: 5,
      }),
      TrainingAssignment.findAll({
        where: { userId, status: { [Op.ne]: "completed" } },
        include: [{ model: Course, as: "course" }],
        order: [["dueDate", "ASC"]],
        limit: 4,
      }),
    ]);

  const progressByCourse = new Map(progressRows.map((row) => [row.courseId, row]));
  const completedLessons = lessonRows.filter((row) => row.status === "completed");
  const scored = completedLessons.filter((row) => row.totalQuestions > 0);
  const averageScore = scored.length
    ? Math.round(
        scored.reduce((sum, row) => sum + (row.bestScore / row.totalQuestions) * 100, 0) /
          scored.length
      )
    : 0;

  const continueRow = lessonRows.find(
    (row) =>
      ["unlocked", "in_progress"].includes(row.status) &&
      (progressByCourse.get(row.courseId)?.percent ?? 0) < 100
  );
  const continueLesson = continueRow
    ? {
        ...continueRow.lesson.toJSON(),
        status: continueRow.status,
        course: continueRow.lesson.course,
        progress: progressByCourse.get(continueRow.courseId) || { percent: 0 },
      }
    : null;

  const myCourses = enrollments
    .filter((enrollment) => enrollment.course)
    .map((enrollment) => ({
      ...enrollment.course.toJSON(),
      enrollment,
      progress: progressByCourse.get(enrollment.courseId) || {
        percent: 0,
        completedLessons: 0,
        totalLessons: 0,
      },
    }));

  const pendingAssessments = lessonRows.filter((row) =>
    ["unlocked", "in_progress"].includes(row.status)
  );

  res.render("dashboard", {
    title: "Learner dashboard",
    myCourses,
    continueLesson,
    stats: {
      enrolled: enrollments.length,
      completedCourses: enrollments.filter((e) => e.status === "completed").length,
      completedLessons: completedLessons.length,
      averageScore,
      pending: pendingAssessments.length,
      certificates: certificates.length,
    },
    notifications,
    assignments,
    certificates: certificates.slice(0, 2),
  });
}

/* ---------------------------------------------------------------- courses */

export async function coursesPage(req, res) {
  // Apply a provider-verified result before rendering, so a missed webhook
  // cannot leave the catalog showing an outdated pending payment.
  await reconcileLearnerPayments(req.user.id);

  const [courses, enrollments, progressRows, categories, purchases] = await Promise.all([
    Course.findAll({
      where: { status: "published" },
      include: courseInclude,
      order: [["createdAt", "ASC"]],
    }),
    CourseEnrollment.findAll({ where: { userId: req.user.id } }),
    CourseProgress.findAll({ where: { userId: req.user.id } }),
    CourseCategory.findAll({ order: [["name", "ASC"]] }),
    CoursePurchase.findAll({
      where: { userId: req.user.id },
      order: [["createdAt", "DESC"]],
    }),
  ]);

  const enrollmentMap = new Map(enrollments.map((row) => [row.courseId, row]));
  const progressMap = new Map(progressRows.map((row) => [row.courseId, row]));
  const purchasesByCourse = new Map();
  for (const purchase of purchases) {
    const rows = purchasesByCourse.get(purchase.courseId) || [];
    rows.push(purchase);
    purchasesByCourse.set(purchase.courseId, rows);
  }
  const catalog = courses.map((course) => {
    const purchase = selectPaymentPurchase(purchasesByCourse.get(course.id) || []);
    return {
      ...course.toJSON(),
      enrollment: enrollmentMap.get(course.id) || null,
      progress: progressMap.get(course.id) || null,
      purchase,
      paymentBadge: paymentBadgeFor(purchase),
      isPaid: courseIsPaid(course),
    };
  });

  res.render("courses", {
    title: "Course catalog",
    catalog,
    categories,
    myCourses: catalog.filter((course) => course.enrollment),
  });
}

export async function courseDetailPage(req, res) {
  const requestedCourseId = Number(req.params.id);
  if (Number.isInteger(requestedCourseId)) {
    await reconcileLearnerPayments(req.user.id, { courseId: requestedCourseId });
  }

  const course = await Course.findOne({
    where: { id: req.params.id },
    include: courseInclude,
  });
  if (!course || (course.status !== "published" && !canManageCourse(req.user, course))) {
    return res.status(404).render("error", {
      title: "Course not found",
      status: 404,
      message: "This course does not exist or is not published yet.",
    });
  }

  const enrollment = await CourseEnrollment.findOne({
    where: { courseId: course.id, userId: req.user.id },
  });
  const purchases = await CoursePurchase.findAll({
    where: { courseId: course.id, userId: req.user.id },
    order: [["createdAt", "DESC"]],
  });
  const purchase = selectPaymentPurchase(purchases);
  const lessons = await getOrderedLessons(course.id);
  const [modules, progressRows, approvedQuestions, certificate, assignment] =
    await Promise.all([
      Module.findAll({ where: { courseId: course.id }, order: [["orderIndex", "ASC"]] }),
      LessonProgress.findAll({ where: { courseId: course.id, userId: req.user.id } }),
      Question.findAll({
        where: { lessonId: { [Op.in]: lessons.map((lesson) => lesson.id) }, status: "approved" },
        attributes: ["lessonId"],
      }),
      Certificate.findOne({ where: { courseId: course.id, userId: req.user.id } }),
      TrainingAssignment.findOne({ where: { courseId: course.id, userId: req.user.id } }),
    ]);

  const progressMap = new Map(progressRows.map((row) => [row.lessonId, row]));
  const approvedCount = new Map();
  for (const question of approvedQuestions) {
    approvedCount.set(question.lessonId, (approvedCount.get(question.lessonId) || 0) + 1);
  }

  const moduleList = modules.map((mod) => ({
    ...mod.toJSON(),
    lessons: lessons
      .filter((lesson) => lesson.moduleId === mod.id)
      .map((lesson) => ({
        ...lesson.toJSON(),
        progress: progressMap.get(lesson.id) || null,
        approvedQuestions: approvedCount.get(lesson.id) || 0,
      })),
  }));

  const courseProgress = await CourseProgress.findOne({
    where: { courseId: course.id, userId: req.user.id },
  });

  res.render("course-detail", {
    title: course.title,
    course,
    enrollment,
    modules: moduleList,
    progress: courseProgress,
    certificate,
    assignment,
    isPreview: canManageCourse(req.user, course),
    purchase,
    paymentBadge: paymentBadgeFor(purchase),
    isPaid: courseIsPaid(course),
  });
}

export async function enrollCourse(req, res) {
  const course = await Course.findOne({ where: { id: req.params.id, status: "published" } });
  if (!course) {
    req.flash("error_msg", "That course is not available for enrollment.");
    return res.redirect("/courses");
  }
  if (req.user.role !== "learner") {
    req.flash("error_msg", "Only learner accounts can enroll in courses.");
    return res.redirect(`/courses/${course.id}`);
  }

  // Paid courses require a verified purchase. Clicking Enroll (or editing the
  // request) can never grant access on its own.
  if (courseIsPaid(course)) {
    const paidPurchase = await findPaidPurchase(req.user.id, course.id);
    if (!paidPurchase) {
      req.flash(
        "error_msg",
        "This is a paid course. Complete the purchase and wait for payment verification to enroll."
      );
      return res.redirect(`/courses/${course.id}`);
    }
  }

  await ensureEnrollment(req.user.id, course.id);
  await ensureProgressRows(req.user.id, course.id);
  await recalcCourseProgress(req.user.id, course.id);

  const lessons = await getOrderedLessons(course.id);
  await notify(req.user.id, {
    title: "Enrollment confirmed",
    message: `You are enrolled in ${course.title}. Start with ${lessons[0]?.title || "the first lesson"}.`,
    type: "course",
    link: `/courses/${course.id}`,
  });
  await logActivity(req, "Enrolled in course", {
    entityType: "course",
    entityId: course.id,
    detail: course.title,
  });

  req.flash("success_msg", `You are enrolled in ${course.title}.`);
  return res.redirect(`/courses/${course.id}`);
}

/* ---------------------------------------------------------------- learning */

export async function learnPage(req, res) {
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

  const preview = canManageCourse(req.user, lesson.course);
  const enrollment = await CourseEnrollment.findOne({
    where: { courseId: lesson.courseId, userId: req.user.id },
  });
  if (!preview && (!enrollment || lesson.status !== "published")) {
    req.flash("error_msg", "You need to enroll in this course to open the lesson.");
    return res.redirect(`/courses/${lesson.courseId}`);
  }

  const progressMap = await ensureProgressRows(req.user.id, lesson.courseId);
  const unlocked = preview || (await isLessonUnlocked(req.user.id, lesson));
  if (!unlocked) {
    req.flash("error_msg", "This lesson is locked. Pass the previous lesson's knowledge check to unlock it.");
    return res.redirect(`/courses/${lesson.courseId}`);
  }

  let currentProgress = progressMap.get(lesson.id);
  if (!preview && currentProgress?.status === "unlocked") {
    await currentProgress.update({ status: "in_progress" });
  }

  const [lessons, modules, approvedCount, assessment] = await Promise.all([
    getOrderedLessons(lesson.courseId),
    Module.findAll({ where: { courseId: lesson.courseId }, order: [["orderIndex", "ASC"]] }),
    Question.count({ where: { lessonId: lesson.id, status: "approved" } }),
    Assessment.findOne({ where: { lessonId: lesson.id, type: "lesson_gate" } }),
  ]);

  const index = lessons.findIndex((item) => item.id === lesson.id);
  const freshProgress = await LessonProgress.findOne({
    where: { lessonId: lesson.id, userId: req.user.id },
  });

  const nav = modules.map((mod) => ({
    ...mod.toJSON(),
    lessons: lessons
      .filter((item) => item.moduleId === mod.id)
      .map((item) => ({
        ...item.toJSON(),
        progress: null,
      })),
  }));
  // Attach progress in one query and keep locked/completed indicators accurate.
  const allProgress = await LessonProgress.findAll({
    where: { courseId: lesson.courseId, userId: req.user.id },
  });
  const allProgressMap = new Map(allProgress.map((row) => [row.lessonId, row]));
  for (const mod of nav) {
    for (const item of mod.lessons) {
      item.progress = allProgressMap.get(item.id) || null;
    }
  }

  res.render("learn", {
    title: lesson.title,
    lesson,
    modules: nav,
    prevLesson: index > 0 ? lessons[index - 1] : null,
    nextLesson: index >= 0 && index < lessons.length - 1 ? lessons[index + 1] : null,
    progress: freshProgress,
    approvedCount,
    requiredQuestions: assessment?.questionCount || lesson.course.questionCount || 5,
    preview,
    isLastLesson: index === lessons.length - 1,
  });
}

async function renderQuiz(req, res, attempt) {
  const items = await AttemptQuestion.findAll({
    where: { attemptId: attempt.id },
    include: [
      {
        model: Question,
        as: "question",
        include: [{ model: QuestionOption, as: "options" }],
      },
    ],
    order: [["orderIndex", "ASC"]],
  });

  const viewItems = items.map((item) => {
    const order = parseJson(item.optionOrder, []);
    const byId = new Map(item.question.options.map((option) => [option.id, option]));
    const options = order
      .map((id, index) => {
        const option = byId.get(id);
        return option
          ? { id: option.id, text: option.text, letter: letter(index) }
          : null;
      })
      .filter(Boolean);
    return {
      questionId: item.questionId,
      prompt: item.question.prompt,
      type: item.question.type,
      options,
    };
  });

  const lesson = await Lesson.findByPk(attempt.lessonId, {
    include: [{ model: Course, as: "course" }],
  });
  const assessment = await Assessment.findByPk(attempt.assessmentId);

  res.render("quiz", {
    title: "Knowledge check",
    attempt,
    lesson,
    assessment,
    items: viewItems,
  });
}

export async function startQuiz(req, res) {
  const lesson = await Lesson.findByPk(req.params.lessonId, {
    include: [{ model: Course, as: "course" }],
  });
  if (!lesson) {
    return res.status(404).render("error", {
      title: "Lesson not found",
      status: 404,
      message: "This lesson does not exist.",
    });
  }
  if (req.user.role !== "learner") {
    req.flash("error_msg", "Knowledge checks are available to learner accounts.");
    return res.redirect(`/learn/${lesson.id}`);
  }

  const enrollment = await CourseEnrollment.findOne({
    where: { courseId: lesson.courseId, userId: req.user.id },
  });
  if (!enrollment) {
    return res.status(403).render("error", {
      title: "Enrollment required",
      status: 403,
      message: "Enroll in the course before taking its knowledge checks.",
    });
  }
  if (!(await isLessonUnlocked(req.user.id, lesson))) {
    return res.status(403).render("error", {
      title: "Lesson locked",
      status: 403,
      message: "Pass the previous lesson to unlock this knowledge check.",
    });
  }

  const existing = await AssessmentAttempt.findOne({
    where: {
      lessonId: lesson.id,
      userId: req.user.id,
      status: "in_progress",
    },
  });
  if (existing) return renderQuiz(req, res, existing);

  const submittedCount = await AssessmentAttempt.count({
    where: { lessonId: lesson.id, userId: req.user.id, status: "submitted" },
  });
  if (!lesson.course.allowRetakes && submittedCount > 0) {
    req.flash("error_msg", "Retakes are disabled for this course.");
    return res.redirect(`/learn/${lesson.id}`);
  }
  if (lesson.course.maxAttempts > 0 && submittedCount >= lesson.course.maxAttempts) {
    req.flash("error_msg", "You have used all available attempts for this knowledge check.");
    return res.redirect(`/learn/${lesson.id}`);
  }

  const approved = await Question.findAll({
    where: { lessonId: lesson.id, status: "approved" },
    include: [{ model: QuestionOption, as: "options" }],
  });
  const required = lesson.course.questionCount || 5;
  if (approved.length < required) {
    req.flash(
      "error_msg",
      `This knowledge check needs at least ${required} approved questions. The instructor is still preparing the question bank.`
    );
    return res.redirect(`/learn/${lesson.id}`);
  }

  const [assessment] = await Assessment.findOrCreate({
    where: { lessonId: lesson.id, type: "lesson_gate" },
    defaults: {
      courseId: lesson.courseId,
      title: `${lesson.title} — Knowledge Check`,
      questionCount: required,
      passScore: lesson.course.passScore || 4,
      maxAttempts: lesson.course.maxAttempts || 0,
      showExplanations: lesson.course.showExplanations,
    },
  });

  const selected = shuffle(approved).slice(0, required);
  const attempt = await AssessmentAttempt.create({
    assessmentId: assessment.id,
    lessonId: lesson.id,
    courseId: lesson.courseId,
    userId: req.user.id,
    attemptNumber: submittedCount + 1,
    totalQuestions: selected.length,
  });

  for (let i = 0; i < selected.length; i += 1) {
    const question = selected[i];
    const optionOrder = shuffle(question.options.map((option) => option.id));
    await AttemptQuestion.create({
      attemptId: attempt.id,
      questionId: question.id,
      optionOrder: JSON.stringify(optionOrder),
      orderIndex: i,
    });
  }

  await logActivity(req, "Started knowledge check", {
    entityType: "lesson",
    entityId: lesson.id,
    detail: `${selected.length} randomized questions`,
  });
  return renderQuiz(req, res, attempt);
}

export async function submitQuiz(req, res) {
  const attempt = await AssessmentAttempt.findByPk(req.params.attemptId || req.body.attemptId, {
    include: [
      { model: Assessment, as: "assessment" },
      { model: Lesson, as: "lesson", include: [{ model: Course, as: "course" }] },
    ],
  });

  if (!attempt || attempt.userId !== req.user.id) {
    return res.status(403).render("error", {
      title: "Attempt not found",
      status: 403,
      message: "This assessment attempt does not belong to your account.",
    });
  }
  if (attempt.status === "submitted") {
    return res.redirect(`/learn/${attempt.lessonId}/quiz/result/${attempt.id}`);
  }

  const items = await AttemptQuestion.findAll({
    where: { attemptId: attempt.id },
    include: [
      {
        model: Question,
        as: "question",
        include: [{ model: QuestionOption, as: "options" }],
      },
    ],
  });

  let score = 0;
  for (const item of items) {
    const submitted = Number(req.body[`answer_${item.questionId}`] || 0);
    const option = item.question.options.find((candidate) => candidate.id === submitted);
    const correct = Boolean(option?.isCorrect);
    if (correct) score += 1;
    await item.update({
      selectedOptionId: option ? option.id : null,
      isCorrect: correct,
    });
  }

  const total = items.length;
  const passScore = attempt.assessment.passScore || 4;
  const passed = score >= passScore;

  await attempt.update({
    status: "submitted",
    score,
    totalQuestions: total,
    passed,
    submittedAt: new Date(),
  });

  const [progress] = await LessonProgress.findOrCreate({
    where: { lessonId: attempt.lessonId, userId: req.user.id },
    defaults: { courseId: attempt.courseId, status: "unlocked" },
  });
  await progress.update({
    attempts: progress.attempts + 1,
    totalQuestions: total,
    bestScore: Math.max(progress.bestScore, score),
    status: passed ? "completed" : progress.status === "completed" ? "completed" : "in_progress",
    completedAt: passed ? progress.completedAt || new Date() : progress.completedAt,
  });

  let nextLesson = null;
  let courseResult = null;

  if (passed) {
    nextLesson = await getNextLesson(attempt.courseId, attempt.lessonId);
    if (nextLesson) {
      const [nextProgress] = await LessonProgress.findOrCreate({
        where: { lessonId: nextLesson.id, userId: req.user.id },
        defaults: { courseId: attempt.courseId, status: "unlocked" },
      });
      if (nextProgress.status === "locked") {
        await nextProgress.update({ status: "unlocked" });
      }
    }
    courseResult = await recalcCourseProgress(req.user.id, attempt.courseId);
    const percentLabel = formatPercent(score, total);
    await notify(req.user.id, {
      title: "Knowledge check passed",
      message: `You scored ${score}/${total} (${percentLabel}%) on ${attempt.lesson.title}. ${
        nextLesson ? `${nextLesson.title} is now unlocked.` : "You completed the final lesson."
      }`,
      type: "assessment",
      link: `/learn/${attempt.lessonId}/quiz/result/${attempt.id}`,
    });
    if (courseResult.percent >= 100) {
      await notify(req.user.id, {
        title: "Course completed",
        message: `You completed ${attempt.lesson.course.title}. Your certificate is ready if enabled.`,
        type: "certificate",
        link: `/courses/${attempt.courseId}`,
      });
    }
  } else {
    await notify(req.user.id, {
      title: "Knowledge check not passed",
      message: `You scored ${score}/${total} (${formatPercent(score, total)}%) on ${attempt.lesson.title}. Review the lesson and try again.`,
      type: "assessment",
      link: `/learn/${attempt.lessonId}`,
    });
  }

  await logActivity(req, passed ? "Passed knowledge check" : "Failed knowledge check", {
    entityType: "lesson",
    entityId: attempt.lessonId,
    detail: `${score}/${total}`,
  });

  return res.redirect(`/learn/${attempt.lessonId}/quiz/result/${attempt.id}`);
}

export async function quizResultPage(req, res) {
  const attempt = await AssessmentAttempt.findByPk(req.params.attemptId, {
    include: [
      { model: Assessment, as: "assessment" },
      {
        model: Lesson,
        as: "lesson",
        include: [{ model: Course, as: "course", include: courseInclude }],
      },
      {
        model: AttemptQuestion,
        as: "items",
        include: [
          {
            model: Question,
            as: "question",
            include: [{ model: QuestionOption, as: "options" }],
          },
        ],
      },
    ],
  });

  if (!attempt || (attempt.userId !== req.user.id && req.user.role !== "superadmin")) {
    return res.status(403).render("error", {
      title: "Result not found",
      status: 403,
      message: "This assessment result is not available to your account.",
    });
  }

  const review = attempt.items
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((item) => {
      const order = parseJson(item.optionOrder, []);
      const byId = new Map(item.question.options.map((option) => [option.id, option]));
      const options = order
        .map((id, index) => {
          const option = byId.get(id);
          return option
            ? {
                id: option.id,
                text: option.text,
                letter: letter(index),
                isCorrect: option.isCorrect,
                isSelected: option.id === item.selectedOptionId,
              }
            : null;
        })
        .filter(Boolean);
      const correct = item.question.options.find((option) => option.isCorrect);
      return {
        prompt: item.question.prompt,
        explanation: item.question.explanation,
        sourceRef: item.question.sourceRef,
        isCorrect: item.isCorrect,
        selectedOptionId: item.selectedOptionId,
        options,
        correctText: correct?.text || "",
      };
    });

  const totalQuestions = attempt.totalQuestions || attempt.items.length;
  const submittedCount = await AssessmentAttempt.count({
    where: { lessonId: attempt.lessonId, userId: attempt.userId, status: "submitted" },
  });
  const maxAttempts = attempt.lesson.course.maxAttempts || 0;
  const canRetake =
    attempt.lesson.course.allowRetakes &&
    (maxAttempts === 0 || submittedCount < maxAttempts);
  const nextLesson = attempt.passed
    ? await getNextLesson(attempt.courseId, attempt.lessonId)
    : null;

  res.render("quiz-result", {
    title: "Knowledge check result",
    attempt,
    lesson: attempt.lesson,
    review,
    score: attempt.score,
    total: totalQuestions,
    percent: percentOf(attempt.score, totalQuestions),
    percentLabel: formatPercent(attempt.score, totalQuestions),
    passed: attempt.passed,
    showExplanations: attempt.assessment.showExplanations,
    canRetake,
    nextLesson,
    attemptsUsed: submittedCount,
    maxAttempts,
  });
}

/* ------------------------------------------------------------ assessments */

export async function assessmentsPage(req, res) {
  const attempts = await AssessmentAttempt.findAll({
    where: { userId: req.user.id },
    include: [
      {
        model: Lesson,
        as: "lesson",
        include: [{ model: Course, as: "course", include: courseInclude }],
      },
    ],
    order: [["startedAt", "DESC"]],
    limit: 30,
  });

  const progress = await LessonProgress.findAll({
    where: { userId: req.user.id },
    include: [
      {
        model: Lesson,
        as: "lesson",
        where: { status: "published" },
        include: [{ model: Course, as: "course" }],
      },
    ],
    order: [["updatedAt", "DESC"]],
  });

  const pending = progress.filter((row) =>
    ["unlocked", "in_progress"].includes(row.status)
  );

  res.render("assessments", {
    title: "Assessments",
    attempts,
    pending,
  });
}

/* ----------------------------------------------------------- certificates */

export async function certificatesPage(req, res) {
  const certificates = await Certificate.findAll({
    where: { userId: req.user.id },
    include: [{ model: Course, as: "course", include: courseInclude }],
    order: [["issuedAt", "DESC"]],
  });
  const completedCourses = await CourseEnrollment.findAll({
    where: { userId: req.user.id, status: "completed" },
    include: [{ model: Course, as: "course" }],
  });
  res.render("certificates", {
    title: "Certificates",
    certificates,
    completedCourses,
  });
}

export async function certificatePage(req, res) {
  const certificate = await Certificate.findByPk(req.params.id, {
    include: [
      { model: Course, as: "course", include: courseInclude },
      { model: User, as: "user", attributes: ["id", "name"] },
    ],
  });
  if (!certificate) {
    return res.status(404).render("error", {
      title: "Certificate not found",
      status: 404,
      message: "We could not find that certificate.",
    });
  }
  if (certificate.userId !== req.user.id && !["superadmin", "hr"].includes(req.user.role)) {
    return res.status(403).render("error", {
      title: "Certificate not available",
      status: 403,
      message: "This certificate belongs to another learner.",
    });
  }
  res.render("certificate", {
    title: `Certificate — ${certificate.courseTitle}`,
    certificate,
    autoPrint: req.query.print === "1",
  });
}

export async function verifyPage(req, res) {
  const query = String(req.query.code || "").trim();
  let certificate = null;
  let searched = false;
  if (query) {
    searched = true;
    certificate = await Certificate.findOne({
      where: {
        [Op.or]: [
          { certificateId: query.toUpperCase() },
          { verificationCode: query.toUpperCase() },
        ],
      },
      include: [{ model: User, as: "user", attributes: ["name"] }],
    });
  }
  res.render("verify", {
    title: "Verify a certificate",
    query,
    searched,
    certificate,
  });
}

/* --------------------------------------------------------- notifications */

export async function notificationsPage(req, res) {
  const notifications = await Notification.findAll({
    where: { userId: req.user.id },
    order: [["createdAt", "DESC"]],
    limit: 100,
  });
  res.render("notifications", { title: "Notifications", notifications });
}

export async function openNotification(req, res) {
  const notification = await Notification.findOne({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!notification) {
    req.flash("error_msg", "That notification is not available in your inbox.");
    return res.redirect("/notifications");
  }

  if (!notification.isRead) {
    await notification.update({ isRead: true });
  }

  const destination = await resolveNotificationDestination(notification, req.user);
  return res.redirect(destination || "/notifications");
}

export async function readNotification(req, res) {
  await Notification.update(
    { isRead: true },
    { where: { id: req.params.id, userId: req.user.id } }
  );
  return res.redirect("/notifications");
}

export async function readAllNotifications(req, res) {
  await Notification.update({ isRead: true }, { where: { userId: req.user.id } });
  req.flash("success_msg", "All notifications marked as read.");
  res.redirect("/notifications");
}

/* -------------------------------------------------------------- profile */

export async function profilePage(req, res) {
  const user = await User.findByPk(req.user.id, {
    include: [
      { model: Department, as: "department" },
      { model: Position, as: "position" },
    ],
  });
  res.render("profile", { title: "Profile & settings", profile: user });
}

export async function updateProfile(req, res) {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const avatarColor = String(req.body.avatarColor || "#1e3a8a");
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.flash("error_msg", "Enter a valid name and email address.");
    return res.redirect("/profile");
  }
  const duplicate = await User.findOne({ where: { email, id: { [Op.ne]: req.user.id } } });
  if (duplicate) {
    req.flash("error_msg", "That email address is already used by another account.");
    return res.redirect("/profile");
  }
  await req.user.update({ name, email, avatarColor });
  req.flash("success_msg", "Profile updated.");
  res.redirect("/profile");
}

export async function changePassword(req, res) {
  const current = String(req.body.current_password || "");
  const next = String(req.body.new_password || "");
  const confirm = String(req.body.confirm_password || "");
  const valid = await bcrypt.compare(current, req.user.password);
  if (!valid) {
    req.flash("error_msg", "Your current password is incorrect.");
    return res.redirect("/profile");
  }
  if (next.length < 8 || next !== confirm) {
    req.flash("error_msg", "New passwords must match and be at least 8 characters.");
    return res.redirect("/profile");
  }
  await req.user.update({ password: await bcrypt.hash(next, 10) });
  await logActivity(req, "Changed password", { entityType: "user", entityId: req.user.id });
  req.flash("success_msg", "Password changed.");
  res.redirect("/profile");
}

/* ------------------------------------------------------------- resources */

export async function downloadResource(req, res) {
  const resource = await LearningResource.findByPk(req.params.id, {
    include: [
      {
        model: Lesson,
        as: "lesson",
        include: [{ model: Course, as: "course" }],
      },
    ],
  });
  if (!resource || !resource.isDownloadable) {
    return res.status(404).render("error", {
      title: "Resource unavailable",
      status: 404,
      message: "This resource is not available for download.",
    });
  }

  const lesson = resource.lesson;
  const enrolled = await CourseEnrollment.findOne({
    where: { courseId: lesson.courseId, userId: req.user.id },
  });
  const staff = canManageCourse(req.user, lesson.course);
  if (!enrolled && !staff) {
    return res.status(403).render("error", {
      title: "Download not allowed",
      status: 403,
      message: "Enroll in the course to download its learning resources.",
    });
  }

  const uploadsRoot = path.resolve(process.cwd(), "uploads");
  const filePath = path.resolve(process.cwd(), resource.filePath);
  if (!filePath.startsWith(uploadsRoot) || !fs.existsSync(filePath)) {
    return res.status(404).render("error", {
      title: "File missing",
      status: 404,
      message: "The uploaded file could not be found on the server.",
    });
  }
  return res.download(filePath, resource.fileName);
}

export async function viewResourceFile(req, res) {
  const resource = await LearningResource.findByPk(req.params.id, {
    include: [
      {
        model: Lesson,
        as: "lesson",
        include: [{ model: Course, as: "course" }],
      },
    ],
  });
  if (!resource) {
    return res.status(404).render("error", {
      title: "Resource unavailable",
      status: 404,
      message: "This learning resource does not exist.",
    });
  }

  const lesson = resource.lesson;
  const enrolled = await CourseEnrollment.findOne({
    where: { courseId: lesson.courseId, userId: req.user.id },
  });
  const staff = canManageCourse(req.user, lesson.course);
  if (!enrolled && !staff) {
    return res.status(403).render("error", {
      title: "Document not available",
      status: 403,
      message: "Enroll in the course to view its learning resources.",
    });
  }

  const uploadsRoot = path.resolve(process.cwd(), "uploads");
  const filePath = path.resolve(process.cwd(), resource.filePath);
  if (!filePath.startsWith(`${uploadsRoot}${path.sep}`) || !fs.existsSync(filePath)) {
    return res.status(404).render("error", {
      title: "File missing",
      status: 404,
      message: "The uploaded file could not be found on the server.",
    });
  }

  const asciiName = String(resource.fileName || "document")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(
      resource.fileName || "document"
    )}`
  );
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
  res.type(resource.mimeType || "application/octet-stream");
  return res.sendFile(filePath);
}
