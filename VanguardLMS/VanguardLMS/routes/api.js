/*
 * Billing API — consumed only by LMS_IND over signed server-to-server calls.
 */
import express from "express";
import { requireApiAuth } from "../middleware/apiAuth.js";
import {
  health,
  dashboardHandler,
  transactionsHandler,
  revenueHandler,
  reportsHandler,
  coursesHandler,
  createCourseHandler,
  updateCourseHandler,
  deleteCourseHandler,
  checkoutHandler,
  paymentHandler,
  verifyPaymentHandler,
  webhookHandler,
  refundHandler,
  receiptsHandler,
  receiptHandler,
} from "../controllers/billingController.js";

const router = express.Router();
const ah = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

/* Provider callbacks authenticate with the provider secret, not the API key. */
router.post("/webhooks/:provider", ah(webhookHandler));

/* Everything below requires a valid HMAC signed request. */
router.use(requireApiAuth);

router.get("/health", health);

router.get("/dashboard", ah(dashboardHandler));
router.get("/transactions", ah(transactionsHandler));
router.get("/revenue", ah(revenueHandler));
router.get("/reports", ah(reportsHandler));

router.get("/courses", ah(coursesHandler));
router.post("/courses", ah(createCourseHandler));
router.put("/courses/:courseId", ah(updateCourseHandler));
router.delete("/courses/:courseId", ah(deleteCourseHandler));

router.post("/checkout", ah(checkoutHandler));
router.get("/payments/:reference", ah(paymentHandler));
router.post("/payments/verify", ah(verifyPaymentHandler));
router.post("/payments/:reference/refund", ah(refundHandler));
router.post("/refunds", ah(refundHandler));

router.get("/receipts", ah(receiptsHandler));
router.get("/receipts/:reference", ah(receiptHandler));

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error("[billing api]", error);
  return res.status(error.status || 500).json({
    error: error.code || "billing_error",
    message:
      (error.status || 500) >= 500 ? "The billing service could not complete the request." : error.message,
  });
});

export default router;
