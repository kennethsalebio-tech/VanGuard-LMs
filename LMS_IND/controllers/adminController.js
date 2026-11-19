import bcrypt from "bcrypt";
import crypto from "crypto";
import { Op } from "sequelize";
import {
  User,
  Department,
  Position,
  TrainingAssignment,
  Course,
  CourseCategory,
  CourseEnrollment,
  CourseProgress,
  Lesson,
  AssessmentAttempt,
  Certificate,
  ActivityLog,
  PasswordReset,
  Session,
} from "../models/index.js";
import { autoAssignTraining } from "../services/hrService.js";
import { notify } from "../services/progressService.js";
import { logActivity } from "../middleware/auth.js";
import { mailConfigured, sendPasswordReset } from "../services/mailer.js";

const courseInclude = [
  { model: User, as: "instructor", attributes: ["id", "name"] },
  { model: CourseCategory, as: "category" },
];

function monthKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function complianceData() {
  const employees = await User.findAll({
    where: { employeeId: { [Op.ne]: null } },
    include: [
      { model: Department, as: "department" },
      { model: Position, as: "position" },
    ],
    order: [["name", "ASC"]],
  });
  const employeeIds = employees.map((employee) => employee.id);

  const [assignments, progresses] = await Promise.all([
    employeeIds.length
      ? TrainingAssignment.findAll({
          where: { userId: { [Op.in]: employeeIds } },
          include: [{ model: Course, as: "course" }],
        })
      : [],
    employeeIds.length
      ? CourseProgress.findAll({ where: { userId: { [Op.in]: employeeIds } } })
      : [],
  ]);

  const progressBy = new Map(
    progresses.map((row) => [`${row.userId}-${row.courseId}`, row])
  );
  const today = new Date().toISOString().slice(0, 10);

  const rows = employees.map((employee) => {
    const employeeAssignments = assignments.filter(
      (assignment) => assignment.userId === employee.id
    );
    let completed = 0;
    let overdue = 0;
    for (const assignment of employeeAssignments) {
      const progress = progressBy.get(`${employee.id}-${assignment.courseId}`);
      const isComplete =
        assignment.status === "completed" || (progress && progress.percent >= 100);
      if (isComplete) completed += 1;
      else if (assignment.dueDate && assignment.dueDate < today) overdue += 1;
    }
    const assigned = employeeAssignments.length;
    return {
      employee,
      assigned,
      completed,
      pending: assigned - completed,
      overdue,
      compliance: assigned ? Math.round((completed / assigned) * 100) : null,
      assignments: employeeAssignments,
    };
  });

  const departmentMap = new Map();
  for (const row of rows) {
    const name = row.employee.department?.name || "Unassigned";
    if (!departmentMap.has(name)) {
      departmentMap.set(name, { name, employees: 0, scored: 0, total: 0 });
    }
    const entry = departmentMap.get(name);
    entry.employees += 1;
    if (row.compliance !== null) {
      entry.scored += 1;
      entry.total += row.compliance;
    }
  }
  const departments = [...departmentMap.values()].map((entry) => ({
    name: entry.name,
    employees: entry.employees,
    compliance: entry.scored ? Math.round(entry.total / entry.scored) : 0,
  }));

  const scored = rows.filter((row) => row.compliance !== null);
  const stats = {
    employees: rows.length,
    enrolled: new Set(assignments.map((assignment) => assignment.userId)).size,
    completedAssignments: rows.reduce((sum, row) => sum + row.completed, 0),
    pendingAssignments: rows.reduce((sum, row) => sum + row.pending, 0),
    overdueAssignments: rows.reduce((sum, row) => sum + row.overdue, 0),
    compliance: scored.length
      ? Math.round(scored.reduce((sum, row) => sum + row.compliance, 0) / scored.length)
      : 0,
  };

  return { rows, assignments, departments, stats };
}

/* ------------------------------------------------------------- dashboards */

export async function dashboardPage(req, res) {
  const [
    totalUsers,
    instructors,
    learners,
    employees,
    courses,
    activeCourses,
    enrollments,
    completedEnrollments,
    progressRows,
    attempts,
  ] = await Promise.all([
    User.count(),
    User.count({ where: { role: "instructor" } }),
    User.count({ where: { role: "learner" } }),
    User.count({ where: { employeeId: { [Op.ne]: null } } }),
    Course.count(),
    Course.count({ where: { status: "published" } }),
    CourseEnrollment.findAll({ include: [{ model: Course, as: "course" }] }),
    CourseEnrollment.count({ where: { status: "completed" } }),
    CourseProgress.findAll({
      include: [
        {
          model: User,
          as: "user",
          include: [{ model: Department, as: "department" }],
        },
      ],
    }),
    AssessmentAttempt.findAll({
      where: { status: "submitted" },
      include: [{ model: Course, as: "course", attributes: ["id", "title"] }],
    }),
  ]);

  const overallCompletion = enrollments.length
    ? Math.round((completedEnrollments / enrollments.length) * 100)
    : 0;

  const departmentMap = new Map();
  for (const row of progressRows) {
    const name = row.user?.department?.name || "Unassigned";
    if (!departmentMap.has(name)) departmentMap.set(name, { total: 0, learners: new Set() });
    const entry = departmentMap.get(name);
    entry.total += row.percent;
    entry.learners.add(row.userId);
  }
  const departmentChart = [...departmentMap.entries()].map(([name, entry]) => ({
    name,
    percent: entry.learners.size ? Math.round(entry.total / entry.learners.size) : 0,
    learners: entry.learners.size,
  }));

  const months = [];
  const labels = [];
  for (let i = 5; i >= 0; i -= 1) {
    const date = new Date();
    date.setMonth(date.getMonth() - i, 1);
    months.push(monthKey(date));
    labels.push(date.toLocaleString("en-US", { month: "short" }));
  }
  const enrollmentSeries = months.map(
    (key) =>
      enrollments.filter((row) => monthKey(row.createdAt) === key).length
  );
  const completionSeries = months.map(
    (key) =>
      enrollments.filter(
        (row) => row.completedAt && monthKey(row.completedAt) === key
      ).length
  );
  const assessmentSeries = months.map(
    (key) =>
      attempts.filter((row) => row.submittedAt && monthKey(row.submittedAt) === key).length
  );

  const courseEnrollment = new Map();
  for (const enrollment of enrollments) {
    const key = enrollment.courseId;
    if (!courseEnrollment.has(key)) {
      courseEnrollment.set(key, {
        title: enrollment.course?.title || "Unknown course",
        enrolled: 0,
        completed: 0,
      });
    }
    courseEnrollment.get(key).enrolled += 1;
    if (enrollment.status === "completed") courseEnrollment.get(key).completed += 1;
  }
  const courseChart = [...courseEnrollment.values()].slice(0, 6);

  const assessmentByCourse = new Map();
  for (const attempt of attempts) {
    const key = attempt.courseId;
    if (!assessmentByCourse.has(key)) {
      assessmentByCourse.set(key, {
        title: attempt.course?.title || "Course",
        attempts: 0,
        passed: 0,
        percentTotal: 0,
      });
    }
    const entry = assessmentByCourse.get(key);
    entry.attempts += 1;
    if (attempt.passed) entry.passed += 1;
    entry.percentTotal += attempt.totalQuestions
      ? (attempt.score / attempt.totalQuestions) * 100
      : 0;
  }
  const assessmentChart = [...assessmentByCourse.values()].map((entry) => ({
    title: entry.title,
    attempts: entry.attempts,
    passRate: Math.round((entry.passed / entry.attempts) * 100),
    avgScore: Math.round(entry.percentTotal / entry.attempts),
  }));

  const recentActivity = await ActivityLog.findAll({
    include: [{ model: User, as: "user", attributes: ["id", "name", "role"] }],
    order: [["createdAt", "DESC"]],
    limit: 8,
  });

  res.render("admin/dashboard", {
    title: "Administrator dashboard",
    stats: {
      totalUsers,
      instructors,
      learners,
      employees,
      courses,
      activeCourses,
      completedEnrollments,
      overallCompletion,
      certificates: await Certificate.count(),
    },
    chart: {
      departments: departmentChart,
      monthly: { labels, enrollments: enrollmentSeries, completions: completionSeries, assessments: assessmentSeries },
      courses: courseChart,
      assessments: assessmentChart,
    },
    recentActivity,
  });
}

/* ------------------------------------------------------------------ users */

export async function usersPage(req, res) {
  const search = String(req.query.q || "").trim();
  const role = String(req.query.role || "").trim();
  const where = {};
  if (search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${search}%` } },
      { email: { [Op.like]: `%${search}%` } },
      { employeeId: { [Op.like]: `%${search}%` } },
    ];
  }
  if (["learner", "instructor", "hr", "superadmin"].includes(role)) where.role = role;

  const [users, departments, positions] = await Promise.all([
    User.findAll({
      where,
      include: [
        { model: Department, as: "department" },
        { model: Position, as: "position" },
      ],
      order: [["createdAt", "DESC"]],
    }),
    Department.findAll({ order: [["name", "ASC"]] }),
    Position.findAll({ order: [["title", "ASC"]] }),
  ]);

  res.render("admin/users", {
    title: "User management",
    users,
    departments,
    positions,
    search,
    role,
  });
}

export async function createUser(req, res) {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const role = ["learner", "instructor", "hr", "superadmin"].includes(req.body.role)
    ? req.body.role
    : "learner";
  const password = String(req.body.password || "");
  const employeeId = String(req.body.employeeId || "").trim() || null;

  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.flash("error_msg", "Enter a valid name and email address.");
    return res.redirect("/admin/users");
  }
  if (password.length < 8) {
    req.flash("error_msg", "The initial password must be at least 8 characters.");
    return res.redirect("/admin/users");
  }
  if (await User.findOne({ where: { email } })) {
    req.flash("error_msg", "That email address is already registered.");
    return res.redirect("/admin/users");
  }
  if (employeeId && (await User.findOne({ where: { employeeId } }))) {
    req.flash("error_msg", "That employee ID is already in use.");
    return res.redirect("/admin/users");
  }

  const user = await User.create({
    name,
    email,
    role,
    password: await bcrypt.hash(password, 10),
    employeeId,
    departmentId: req.body.departmentId ? Number(req.body.departmentId) : null,
    positionId: req.body.positionId ? Number(req.body.positionId) : null,
    employmentStatus: "active",
    dateHired: req.body.dateHired || null,
  });

  if (role === "learner") await autoAssignTraining(user, req.user.id);
  await notify(user.id, {
    title: "Your account is ready",
    message: "An administrator created your Vanguard Learning account. Please sign in and review your assigned training.",
    type: "info",
    link: "/dashboard",
  });
  await logActivity(req, "Created user", {
    entityType: "user",
    entityId: user.id,
    detail: `${user.name} (${user.role})`,
  });

  req.flash("success_msg", `${user.name} created.`);
  res.redirect("/admin/users");
}

export async function updateUserRole(req, res) {
  const user = await User.findByPk(req.params.id);
  const role = req.body.role;
  if (!user || !["learner", "instructor", "hr", "superadmin"].includes(role)) {
    req.flash("error_msg", "Invalid user or role.");
    return res.redirect("/admin/users");
  }
  if (user.role === "superadmin" && role !== "superadmin") {
    const remaining = await User.count({
      where: { role: "superadmin", id: { [Op.ne]: user.id } },
    });
    if (remaining === 0) {
      req.flash("error_msg", "The system must keep at least one super administrator.");
      return res.redirect("/admin/users");
    }
  }
  const previous = user.role;
  await user.update({ role });
  if (role === "learner" && previous !== "learner") {
    await autoAssignTraining(user, req.user.id);
  }
  await logActivity(req, "Changed user role", {
    entityType: "user",
    entityId: user.id,
    detail: `${previous} → ${role}`,
  });
  req.flash("success_msg", "User role updated.");
  res.redirect("/admin/users");
}

export async function toggleUser(req, res) {
  const user = await User.findByPk(req.params.id);
  if (!user) {
    req.flash("error_msg", "User not found.");
    return res.redirect("/admin/users");
  }
  if (user.id === req.user.id) {
    req.flash("error_msg", "You cannot deactivate your own account.");
    return res.redirect("/admin/users");
  }
  await user.update({ isActive: !user.isActive });
  await logActivity(req, user.isActive ? "Activated user" : "Deactivated user", {
    entityType: "user",
    entityId: user.id,
    detail: user.email,
  });
  req.flash("success_msg", `${user.name} ${user.isActive ? "activated" : "deactivated"}.`);
  res.redirect("/admin/users");
}

export async function resetUserPassword(req, res) {
  const user = await User.findByPk(req.params.id);
  if (!user) {
    req.flash("error_msg", "User not found.");
    return res.redirect("/admin/users");
  }
  if (!mailConfigured()) {
    req.flash(
      "error_msg",
      "Email delivery is not configured, so no reset link could be sent. Configure MAIL_HOST and MAIL_FROM_ADDRESS, or ask the user to use Forgot password."
    );
    return res.redirect("/admin/users");
  }

  const token = crypto.randomBytes(32).toString("base64url");
  await PasswordReset.update(
    { usedAt: new Date() },
    { where: { userId: user.id, usedAt: null } }
  );
  const resetRecord = await PasswordReset.create({
    userId: user.id,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
  try {
    await sendPasswordReset({ to: user.email, name: user.name, token });
  } catch (error) {
    await resetRecord.update({ usedAt: new Date() }).catch(() => {});
    console.error("[admin] Password reset email failed:", error.message);
    req.flash("error_msg", "The reset email could not be sent. Check the SMTP configuration.");
    return res.redirect("/admin/users");
  }

  // A forced reset also revokes existing sessions; the link is single-use.
  await Session.destroy({
    where: {
      [Op.or]: [
        { data: { [Op.like]: `%"userId":${user.id},%` } },
        { data: { [Op.like]: `%"userId":${user.id}}%` } },
      ],
    },
  });

  await logActivity(req, "Emailed password reset link", {
    entityType: "user",
    entityId: user.id,
    detail: user.email,
  });
  req.flash("success_msg", `A password reset link was emailed to ${user.email}.`);
  res.redirect("/admin/users");
}

/* ----------------------------------------------------------------- courses */

export async function coursesPage(req, res) {
  const courses = await Course.findAll({
    include: courseInclude,
    order: [["createdAt", "DESC"]],
  });
  const enrollments = await CourseEnrollment.findAll();
  const progress = await CourseProgress.findAll();
  const rows = courses.map((course) => {
    const courseProgress = progress.filter((row) => row.courseId === course.id);
    return {
      ...course.toJSON(),
      enrolled: enrollments.filter((row) => row.courseId === course.id).length,
      completed: courseProgress.filter((row) => row.percent >= 100).length,
      avgProgress: courseProgress.length
        ? Math.round(
            courseProgress.reduce((sum, row) => sum + row.percent, 0) /
              courseProgress.length
          )
        : 0,
    };
  });
  res.render("admin/courses", { title: "Course management", courses: rows });
}

/* --------------------------------------------------------------------- HR */

export async function hrPage(req, res) {
  const [{ rows, stats, departments: departmentPerformance }, departments, positions, courses] =
    await Promise.all([
      complianceData(),
      Department.findAll({
        include: [
          { model: Position, as: "positions" },
          { model: User, as: "members", attributes: ["id"] },
        ],
        order: [["name", "ASC"]],
      }),
      Position.findAll({
        include: [{ model: Department, as: "department" }],
        order: [["title", "ASC"]],
      }),
      Course.findAll({
        where: { status: "published" },
        attributes: ["id", "title"],
        order: [["title", "ASC"]],
      }),
    ]);

  res.render("admin/hr", {
    title: "HRMS & training compliance",
    rows,
    stats,
    departmentPerformance,
    departments,
    positions,
    courses,
  });
}

export async function createEmployee(req, res) {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const employeeId = String(req.body.employeeId || "").trim();
  const password = String(req.body.password || "") || "Welcome@123";

  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.flash("error_msg", "Enter a valid employee name and email.");
    return res.redirect("/admin/hr");
  }
  if (!employeeId) {
    req.flash("error_msg", "Employee ID is required.");
    return res.redirect("/admin/hr");
  }
  if (await User.findOne({ where: { [Op.or]: [{ email }, { employeeId }] } })) {
    req.flash("error_msg", "That email address or employee ID already exists.");
    return res.redirect("/admin/hr");
  }

  const employee = await User.create({
    name,
    email,
    employeeId,
    role: "learner",
    password: await bcrypt.hash(password, 10),
    departmentId: req.body.departmentId ? Number(req.body.departmentId) : null,
    positionId: req.body.positionId ? Number(req.body.positionId) : null,
    employmentStatus: ["active", "probation", "on_leave", "inactive"].includes(
      req.body.employmentStatus
    )
      ? req.body.employmentStatus
      : "active",
    dateHired: req.body.dateHired || null,
  });

  const assigned = await autoAssignTraining(employee, req.user.id);
  await logActivity(req, "Created employee profile", {
    entityType: "user",
    entityId: employee.id,
    detail: `${employee.name} (${employee.employeeId})`,
  });
  req.flash(
    "success_msg",
    `${employee.name} added. ${assigned.length} required course(s) assigned automatically. Temporary password: ${password}`
  );
  res.redirect("/admin/hr");
}

export async function updateEmployee(req, res) {
  const employee = await User.findByPk(req.params.id);
  if (!employee) {
    req.flash("error_msg", "Employee not found.");
    return res.redirect("/admin/hr");
  }
  const previousDepartment = employee.departmentId;
  const previousPosition = employee.positionId;
  await employee.update({
    departmentId: req.body.departmentId ? Number(req.body.departmentId) : null,
    positionId: req.body.positionId ? Number(req.body.positionId) : null,
    employmentStatus: ["active", "probation", "on_leave", "inactive"].includes(
      req.body.employmentStatus
    )
      ? req.body.employmentStatus
      : employee.employmentStatus,
    dateHired: req.body.dateHired || employee.dateHired,
    isActive: req.body.isActive === "on",
  });

  let assigned = [];
  if (
    previousDepartment !== employee.departmentId ||
    previousPosition !== employee.positionId
  ) {
    assigned = await autoAssignTraining(employee, req.user.id);
  }

  await logActivity(req, "Updated employee profile", {
    entityType: "user",
    entityId: employee.id,
    detail: employee.name,
  });
  req.flash(
    "success_msg",
    `Employee updated.${assigned.length ? ` ${assigned.length} new course(s) auto-assigned.` : ""}`
  );
  res.redirect("/admin/hr");
}

export async function createDepartment(req, res) {
  const name = String(req.body.name || "").trim();
  if (name.length < 2) {
    req.flash("error_msg", "Enter a department name.");
    return res.redirect("/admin/hr");
  }
  await Department.findOrCreate({
    where: { name },
    defaults: {
      code: String(req.body.code || name.slice(0, 4)).toUpperCase().slice(0, 10),
      description: String(req.body.description || "").trim(),
    },
  });
  req.flash("success_msg", "Department saved.");
  res.redirect("/admin/hr");
}

export async function createPosition(req, res) {
  const title = String(req.body.title || "").trim();
  if (title.length < 2) {
    req.flash("error_msg", "Enter a position title.");
    return res.redirect("/admin/hr");
  }
  const requiredCourseIds = []
    .concat(req.body.requiredCourseIds || [])
    .map(Number)
    .filter(Boolean);
  await Position.create({
    title,
    departmentId: req.body.departmentId ? Number(req.body.departmentId) : null,
    requiredCourseIds: JSON.stringify(requiredCourseIds),
  });
  req.flash("success_msg", "Position created with training requirements.");
  res.redirect("/admin/hr");
}

/* ----------------------------------------------------------------- reports */

export async function reportsPage(req, res) {
  const [{ rows, stats, departments }, courses, enrollments, attempts, certificates] =
    await Promise.all([
      complianceData(),
      Course.findAll({ include: courseInclude }),
      CourseEnrollment.findAll({
        include: [
          { model: User, as: "user", attributes: ["id", "name", "email"] },
          { model: Course, as: "course" },
        ],
        order: [["createdAt", "DESC"]],
        limit: 50,
      }),
      AssessmentAttempt.findAll({
        where: { status: "submitted" },
        include: [
          { model: User, as: "user", attributes: ["id", "name"] },
          { model: Course, as: "course", attributes: ["id", "title"] },
          { model: Lesson, as: "lesson", attributes: ["id", "title"] },
        ],
        order: [["submittedAt", "DESC"]],
        limit: 50,
      }),
      Certificate.findAll({ include: [{ model: Course, as: "course" }] }),
    ]);

  const progress = await CourseProgress.findAll();
  const courseRows = courses.map((course) => {
    const rowsForCourse = progress.filter((row) => row.courseId === course.id);
    const completed = rowsForCourse.filter((row) => row.percent >= 100).length;
    return {
      course,
      enrolled: rowsForCourse.length,
      completed,
      rate: rowsForCourse.length
        ? Math.round((completed / rowsForCourse.length) * 100)
        : 0,
      avgProgress: rowsForCourse.length
        ? Math.round(
            rowsForCourse.reduce((sum, row) => sum + row.percent, 0) /
              rowsForCourse.length
          )
        : 0,
    };
  });

  res.render("admin/reports", {
    title: "Reports & analytics",
    compliance: { rows, stats, departments },
    courseRows,
    enrollments,
    attempts,
    certificates,
    exportTypes: ["compliance", "completion", "assessments", "enrollments"],
  });
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(headers, rows) {
  return [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => row.map(csvEscape).join(",")),
  ].join("\r\n");
}

export async function exportReport(req, res) {
  const type = req.params.type;
  let filename = `vanguard-${type}-${new Date().toISOString().slice(0, 10)}.csv`;
  let csv = "";

  if (type === "compliance") {
    const { rows } = await complianceData();
    csv = toCsv(
      [
        "Employee ID",
        "Name",
        "Email",
        "Department",
        "Position",
        "Assigned",
        "Completed",
        "Pending",
        "Overdue",
        "Compliance %",
      ],
      rows.map((row) => [
        row.employee.employeeId,
        row.employee.name,
        row.employee.email,
        row.employee.department?.name || "",
        row.employee.position?.title || "",
        row.assigned,
        row.completed,
        row.pending,
        row.overdue,
        row.compliance ?? "",
      ])
    );
  } else if (type === "completion") {
    const [courses, progress] = await Promise.all([
      Course.findAll({ include: courseInclude }),
      CourseProgress.findAll(),
    ]);
    csv = toCsv(
      ["Course", "Instructor", "Assigned learners", "Completed", "Completion %"],
      courses.map((course) => {
        const rows = progress.filter((row) => row.courseId === course.id);
        const completed = rows.filter((row) => row.percent >= 100).length;
        return [
          course.title,
          course.instructor?.name || "",
          rows.length,
          completed,
          rows.length ? Math.round((completed / rows.length) * 100) : 0,
        ];
      })
    );
  } else if (type === "assessments") {
    const attempts = await AssessmentAttempt.findAll({
      where: { status: "submitted" },
      include: [
        { model: User, as: "user" },
        { model: Course, as: "course" },
        { model: Lesson, as: "lesson" },
      ],
      order: [["submittedAt", "DESC"]],
    });
    csv = toCsv(
      ["Learner", "Email", "Course", "Lesson", "Attempt", "Score", "Total", "Passed", "Submitted"],
      attempts.map((attempt) => [
        attempt.user?.name || "",
        attempt.user?.email || "",
        attempt.course?.title || "",
        attempt.lesson?.title || "",
        attempt.attemptNumber,
        attempt.score,
        attempt.totalQuestions,
        attempt.passed ? "Yes" : "No",
        attempt.submittedAt?.toISOString() || "",
      ])
    );
  } else if (type === "enrollments") {
    const enrollments = await CourseEnrollment.findAll({
      include: [
        { model: User, as: "user" },
        { model: Course, as: "course" },
      ],
      order: [["createdAt", "DESC"]],
    });
    const progress = await CourseProgress.findAll();
    const map = new Map(progress.map((row) => [`${row.userId}-${row.courseId}`, row]));
    csv = toCsv(
      ["Learner", "Email", "Course", "Source", "Progress %", "Status", "Enrolled"],
      enrollments.map((enrollment) => [
        enrollment.user?.name || "",
        enrollment.user?.email || "",
        enrollment.course?.title || "",
        enrollment.source,
        map.get(`${enrollment.userId}-${enrollment.courseId}`)?.percent ?? 0,
        enrollment.status,
        enrollment.createdAt?.toISOString() || "",
      ])
    );
  } else {
    req.flash("error_msg", "Unknown report type.");
    return res.redirect("/admin/reports");
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(`\uFEFF${csv}`);
}

/* -------------------------------------------------------------------- logs */

export async function logsPage(req, res) {
  const logs = await ActivityLog.findAll({
    include: [{ model: User, as: "user", attributes: ["id", "name", "role"] }],
    order: [["createdAt", "DESC"]],
    limit: 200,
  });
  res.render("admin/logs", { title: "Audit logs", logs });
}
