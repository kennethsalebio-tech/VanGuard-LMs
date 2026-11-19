import express from "express";
import {
  loginPage,
  loginUser,
  registerPage,
  registerUser,
  forgotPasswordPage,
  requestPasswordReset,
  resetPasswordPage,
  resetPassword,
  logoutUser,
  startGoogleAuth,
  googleCallback,
} from "../controllers/authController.js";
import { requireGuest } from "../middleware/auth.js";
import { loginRateLimit, passwordResetRateLimit } from "../middleware/security.js";
import { ah } from "../middleware/asyncHandler.js";

const router = express.Router();

router.get("/login", requireGuest, loginPage);
router.post("/login", requireGuest, loginRateLimit, ah(loginUser));
router.get("/auth/google", requireGuest, startGoogleAuth);
router.get("/auth/google/callback", requireGuest, ah(googleCallback));
router.get("/register", requireGuest, registerPage);
router.post("/register", requireGuest, ah(registerUser));
router.get("/forgot-password", requireGuest, forgotPasswordPage);
router.post(
  "/forgot-password",
  requireGuest,
  passwordResetRateLimit,
  ah(requestPasswordReset)
);
router.get("/reset-password", requireGuest, ah(resetPasswordPage));
router.post(
  "/reset-password",
  requireGuest,
  passwordResetRateLimit,
  ah(resetPassword)
);
router.get("/logout", logoutUser);

export default router;
