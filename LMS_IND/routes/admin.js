import express from "express";
import {
  dashboardPage,
  usersPage,
  createUser,
  updateUserRole,
  toggleUser,
  resetUserPassword,
  coursesPage,
  reportsPage,
  exportReport,
  logsPage,
} from "../controllers/adminController.js";
import {
  financeDashboardPage,
  financeTransactionsPage,
  financeReceiptPage,
  financeRefundAction,
  updateCoursePrice,
} from "../controllers/financeController.js";
import {
  adminDemoPaymentDetailPage,
  adminDemoPaymentsExport,
  adminDemoPaymentsPage,
} from "../controllers/simulatedPaymentController.js";
import { requireRole } from "../middleware/auth.js";
import { ah } from "../middleware/asyncHandler.js";

const router = express.Router();
const adminOnly = requireRole("superadmin");

router.get("/", adminOnly, ah(dashboardPage));

router.get("/users", adminOnly, ah(usersPage));
router.post("/users", adminOnly, ah(createUser));
router.post("/users/:id/role", adminOnly, ah(updateUserRole));
router.post("/users/:id/toggle", adminOnly, ah(toggleUser));
router.post("/users/:id/reset-password", adminOnly, ah(resetUserPassword));

router.get("/courses", adminOnly, ah(coursesPage));
router.post("/courses/:id/price", adminOnly, ah(updateCoursePrice));

/* Finance & Billing — data served by the VanguardLMS billing API. */
router.get("/finance", adminOnly, ah(financeDashboardPage));
router.get("/finance/transactions", adminOnly, ah(financeTransactionsPage));
/* Demo ledger: intentionally separate from live revenue and receipts. */
router.get("/finance/simulated", adminOnly, ah(adminDemoPaymentsPage));
router.get("/finance/simulated/export", adminOnly, ah(adminDemoPaymentsExport));
router.get(
  "/finance/simulated/:reference",
  adminOnly,
  ah(adminDemoPaymentDetailPage)
);
router.get("/finance/receipts/:reference", adminOnly, ah(financeReceiptPage));
router.post("/finance/refunds/:reference", adminOnly, ah(financeRefundAction));

router.get("/reports", adminOnly, ah(reportsPage));
router.get("/reports/export/:type", adminOnly, ah(exportReport));

router.get("/logs", adminOnly, ah(logsPage));

export default router;
