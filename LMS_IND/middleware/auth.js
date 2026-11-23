import { User, Notification, ActivityLog } from "../models/index.js";

export async function attachUser(req, res, next) {
  try {
    res.locals.currentUser = null;
    res.locals.unreadCount = 0;
    if (req.session?.userId) {
      const user = await User.findByPk(req.session.userId);
      if (user && user.isActive) {
        req.user = user;
        res.locals.currentUser = user;
        res.locals.unreadCount = await Notification.count({
          where: { userId: user.id, isRead: false },
        });
      } else {
        req.session.userId = null;
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    req.flash("error_msg", "Please sign in to continue.");
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      req.flash("error_msg", "Please sign in to continue.");
      return res.redirect("/login");
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).render("error", {
        title: "Access denied",
        status: 403,
        message: "Your role does not have permission to open this page.",
      });
    }
    next();
  };
}

export function requireGuest(req, res, next) {
  if (req.user) return res.redirect("/dashboard");
  next();
}

export function ownsCourse(user, course) {
  return Boolean(user && course && (course.instructorId === user.id || user.role === "superadmin"));
}

export function canManageCourse(user, course) {
  if (!user || !course) return false;
  if (user.role === "superadmin") return true;
  return user.role === "instructor" && course.instructorId === user.id;
}

export async function logActivity(req, action, { entityType, entityId, detail } = {}) {
  try {
    await ActivityLog.create({
      userId: req.user?.id || null,
      action,
      entityType: entityType || null,
      entityId: entityId || null,
      detail: detail || null,
      ip: req.ip,
    });
  } catch (error) {
    console.warn("Activity log failed:", error.message);
  }
}

export function landingFor(user) {
  if (!user) return "/login";
  if (user.role === "superadmin") return "/admin";
  if (user.role === "instructor") return "/instructor";
  return "/dashboard";
}
