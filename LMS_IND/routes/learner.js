import express from "express";
import {
  dashboardPage,
  coursesPage,
  courseDetailPage,
  enrollCourse,
  learnPage,
  startQuiz,
  submitQuiz,
  quizResultPage,
  assessmentsPage,
  certificatesPage,
  certificatePage,
  verifyPage,
  notificationsPage,
  openNotification,
  readNotification,
  readAllNotifications,
  profilePage,
  updateProfile,
  changePassword,
  downloadResource,
  viewResourceFile,
} from "../controllers/learnerController.js";
import {
  purchaseCourse,
  purchaseStatusPage,
} from "../controllers/financeController.js";
import {
  billingDashboardPage,
  cancelPaymentAction,
  createDemoInvoiceAction,
  failPaymentAction,
  paymentMethodPage,
  paymentMethodsPage,
  paymentResultPage,
  simulatePaymentAction,
} from "../controllers/simulatedPaymentController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { ah } from "../middleware/asyncHandler.js";

const router = express.Router();

router.get("/dashboard", requireAuth, ah(dashboardPage));
router.get("/courses", requireAuth, ah(coursesPage));
router.get("/courses/:id", requireAuth, ah(courseDetailPage));
router.post("/courses/:id/enroll", requireRole("learner"), ah(enrollCourse));

/* Paid courses: Purchase creates or reuses a pending demo invoice and opens
 * the demo method chooser directly. Real billing verification remains in the
 * finance service for existing verified purchases. */
router.post("/courses/:id/purchase", requireRole("learner"), ah(purchaseCourse));
router.get(
  "/courses/:id/purchase/:reference",
  requireRole("learner"),
  ah(purchaseStatusPage)
);

/* Clearly labeled simulation-only billing. It never calls the real billing
 * service, never creates a CoursePurchase, and never unlocks a course. */
router.get("/billing", requireRole("learner"), ah(billingDashboardPage));
router.post("/billing/invoices", requireRole("learner"), ah(createDemoInvoiceAction));
router.get(
  "/billing/invoices/:reference",
  requireRole("learner"),
  ah(paymentMethodsPage)
);
router.get(
  "/billing/invoices/:reference/pay/:method",
  requireRole("learner"),
  ah(paymentMethodPage)
);
router.post(
  "/billing/invoices/:reference/pay/:method",
  requireRole("learner"),
  ah(simulatePaymentAction)
);
router.post(
  "/billing/invoices/:reference/cancel",
  requireRole("learner"),
  ah(cancelPaymentAction)
);
router.post(
  "/billing/invoices/:reference/fail",
  requireRole("learner"),
  ah(failPaymentAction)
);
router.get(
  "/billing/transactions/:reference",
  requireRole("learner"),
  ah(paymentResultPage)
);

router.get("/learn/:lessonId", requireAuth, ah(learnPage));
router.get("/learn/:lessonId/quiz", requireRole("learner"), ah(startQuiz));
router.post("/learn/:lessonId/quiz", requireRole("learner"), ah(submitQuiz));
router.get("/learn/:lessonId/quiz/result/:attemptId", requireAuth, ah(quizResultPage));

router.get("/assessments", requireRole("learner"), ah(assessmentsPage));
router.get("/certificates", requireRole("learner"), ah(certificatesPage));
router.get("/certificates/:id", requireAuth, ah(certificatePage));
router.get("/verify", ah(verifyPage));

router.get("/notifications", requireAuth, ah(notificationsPage));
router.get("/notifications/:id/open", requireAuth, ah(openNotification));
router.post("/notifications/read-all", requireAuth, ah(readAllNotifications));
router.post("/notifications/:id/read", requireAuth, ah(readNotification));

router.get("/profile", requireAuth, ah(profilePage));
router.post("/profile", requireAuth, ah(updateProfile));
router.post("/profile/password", requireAuth, ah(changePassword));

router.get("/resources/:id/download", requireAuth, ah(downloadResource));
router.get("/resources/:id/file", requireAuth, ah(viewResourceFile));

export default router;
