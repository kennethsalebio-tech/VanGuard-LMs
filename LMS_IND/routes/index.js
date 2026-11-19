import express from "express";
import authRoutes from "./auth.js";
import learnerRoutes from "./learner.js";
import instructorRoutes from "./instructor.js";
import adminRoutes from "./admin.js";
import liveRoutes from "./live.js";
import { homePage } from "../controllers/learnerController.js";
import { billingWebhook } from "../controllers/financeController.js";
import { ah } from "../middleware/asyncHandler.js";

const router = express.Router();

/*
 * Signed server-to-server notifications from the VanguardLMS billing service.
 * Authenticated by HMAC (see middleware/security.js for the CSRF exemption);
 * no browser session is involved.
 */
router.post("/api/billing/webhook", ah(billingWebhook));

router.get("/", homePage);
router.use(authRoutes);
router.use(learnerRoutes);
router.use("/instructor", instructorRoutes);
router.use("/admin", adminRoutes);
router.use("/live", liveRoutes);

export default router;
