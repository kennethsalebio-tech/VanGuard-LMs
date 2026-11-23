import {
  Course,
  CourseCategory,
  Department,
  Position,
  TrainingAssignment,
} from "../models/index.js";
import { ensureEnrollment, ensureProgressRows, notify } from "./progressService.js";

const DEPARTMENT_CATEGORIES = {
  IT: ["IT & Networking"],
  HR: ["HR Essentials", "Compliance"],
  OPS: ["Compliance", "Leadership"],
};

/**
 * Assign required courses from the employee's position plus department and
 * onboarding rules. Idempotent: existing enrollments are not duplicated.
 */
export async function autoAssignTraining(user, actorId = null) {
  if (!user || !["learner", "instructor"].includes(user.role)) return [];

  const [position, department] = await Promise.all([
    user.positionId ? Position.findByPk(user.positionId) : null,
    user.departmentId ? Department.findByPk(user.departmentId) : null,
  ]);

  let positionCourseIds = [];
  try {
    positionCourseIds = JSON.parse(position?.requiredCourseIds || "[]");
  } catch {
    positionCourseIds = [];
  }

  const requiredCategories = new Set(["Onboarding"]);
  for (const category of DEPARTMENT_CATEGORIES[department?.code] || []) {
    requiredCategories.add(category);
  }

  const courses = await Course.findAll({
    where: { status: "published" },
    include: [{ model: CourseCategory, as: "category" }],
  });

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);
  const assigned = [];

  for (const course of courses) {
    const isRequired =
      positionCourseIds.includes(course.id) ||
      requiredCategories.has(course.category?.name);
    if (!isRequired) continue;

    await ensureEnrollment(user.id, course.id, "auto");
    await ensureProgressRows(user.id, course.id);
    const [assignment, created] = await TrainingAssignment.findOrCreate({
      where: { userId: user.id, courseId: course.id },
      defaults: {
        assignedBy: actorId,
        dueDate: dueDate.toISOString().slice(0, 10),
        source: positionCourseIds.includes(course.id) ? "position" : "auto",
        status: "assigned",
      },
    });
    if (created) {
      assigned.push(course);
      await notify(user.id, {
        title: "New training assigned",
        message: `${course.title} has been assigned to you. Complete it by ${assignment.dueDate}.`,
        type: "assignment",
        link: `/courses/${course.id}`,
      });
    }
  }

  return assigned;
}
