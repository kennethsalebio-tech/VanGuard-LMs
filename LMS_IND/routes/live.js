import express from "express";
import {
  learnerLivePage,
  leaveMeeting,
  listChatMessages,
  liveMeetingPage,
  liveRoomPage,
  meetingState,
  postChatMessage,
  postSignal,
  signalStream,
} from "../controllers/liveController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { ah } from "../middleware/asyncHandler.js";

const router = express.Router();

router.get("/", requireRole("learner", "instructor", "superadmin"), ah(learnerLivePage));
router.get("/:meetingId", requireAuth, ah(liveMeetingPage));
router.get("/:meetingId/room", requireAuth, ah(liveRoomPage));
router.get("/:meetingId/state", requireAuth, ah(meetingState));
router.get("/:meetingId/chat", requireAuth, ah(listChatMessages));
router.post("/:meetingId/chat", requireAuth, ah(postChatMessage));
router.get("/:meetingId/signals", requireAuth, ah(signalStream));
router.post("/:meetingId/signals", requireAuth, ah(postSignal));
router.post("/:meetingId/leave", requireAuth, ah(leaveMeeting));

export default router;
