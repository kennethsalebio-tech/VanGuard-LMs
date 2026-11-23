import express from "express";
import {
  dashboardPage,
  coursesPage,
  newCoursePage,
  createCourse,
  editCoursePage,
  updateCourse,
  archiveCourse,
  builderPage,
  uploadModulePreview,
  pendingUploadPreview,
  pendingUploadFile,
  removeModuleUpload,
  resourcePreviewPage,
  resourceFile,
  createModule,
  publishModule,
  unpublishModule,
  deleteModule,
  createLesson,
  lessonEditPage,
  updateLesson,
  deleteLesson,
  questionsPage,
  generateQuestionsAction,
  approveQuestion,
  rejectQuestion,
  deleteQuestion,
  approveAllQuestions,
  createManualQuestion,
  editQuestionPage,
  updateQuestion,
  learnersPage,
  courseLearnersPage,
} from "../controllers/instructorController.js";
import {
  cancelLiveMeeting,
  createLiveMeeting,
  endLiveMeeting,
  instructorLivePage,
  newLiveMeetingPage,
  removeMeetingParticipant,
  startLiveMeeting,
} from "../controllers/liveController.js";
import { requireRole } from "../middleware/auth.js";
import { uploadModule } from "../middleware/upload.js";
import { verifyCsrfNow } from "../middleware/security.js";
import { ah } from "../middleware/asyncHandler.js";

const router = express.Router();
router.use(requireRole("instructor", "superadmin"));

const uploadLesson = (req, res, next) => {
  uploadModule.single("module_file")(req, res, (error) => {
    if (error) {
      req.flash("error_msg", error.message || "The upload failed.");
      return res.redirect(`/instructor/courses/${req.params.id}/builder`);
    }
    next();
  });
};

const uploadPreview = (req, res, next) => {
  uploadModule.single("file")(req, res, (error) => {
    if (error) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge
          ? "This file is larger than the 25 MB limit."
          : error.message || "The upload failed.",
        retryable: true,
      });
    }
    next();
  });
};

router.get("/", ah(dashboardPage));
router.get("/courses", ah(coursesPage));
router.get("/courses/new", ah(newCoursePage));
router.post("/courses", ah(createCourse));
router.get("/courses/:id/edit", ah(editCoursePage));
router.post("/courses/:id", ah(updateCourse));
router.post("/courses/:id/archive", ah(archiveCourse));
router.get("/courses/:id/builder", ah(builderPage));
router.post(
  "/courses/:id/upload-preview",
  verifyCsrfNow,
  uploadPreview,
  ah(uploadModulePreview)
);
router.get(
  "/courses/:id/uploads/:token/preview",
  ah(pendingUploadPreview)
);
router.get("/courses/:id/uploads/:token/file", ah(pendingUploadFile));
router.delete("/courses/:id/uploads/:token", ah(removeModuleUpload));
router.get("/resources/:resourceId/preview", ah(resourcePreviewPage));
router.get("/resources/:resourceId/file", ah(resourceFile));
router.post("/courses/:id/modules", ah(createModule));
router.post("/courses/:id/modules/:moduleId/publish", ah(publishModule));
router.post("/courses/:id/modules/:moduleId/unpublish", ah(unpublishModule));
router.post("/courses/:id/modules/:moduleId/delete", ah(deleteModule));
router.post(
  "/courses/:id/lessons",
  uploadLesson,
  verifyCsrfNow,
  ah(createLesson)
);

router.get("/lessons/:lessonId/edit", ah(lessonEditPage));
router.post("/lessons/:lessonId", ah(updateLesson));
router.post("/lessons/:lessonId/delete", ah(deleteLesson));

router.get("/lessons/:lessonId/questions", ah(questionsPage));
router.post("/lessons/:lessonId/questions/generate", ah(generateQuestionsAction));
router.post("/lessons/:lessonId/questions/approve-all", ah(approveAllQuestions));
router.post("/lessons/:lessonId/questions/manual", ah(createManualQuestion));

router.post("/questions/:questionId/approve", ah(approveQuestion));
router.post("/questions/:questionId/reject", ah(rejectQuestion));
router.post("/questions/:questionId/delete", ah(deleteQuestion));
router.get("/questions/:questionId/edit", ah(editQuestionPage));
router.post("/questions/:questionId/edit", ah(updateQuestion));

router.get("/learners", ah(learnersPage));
router.get("/courses/:id/learners", ah(courseLearnersPage));

/* --------------------------------------------------------- live classroom */

router.get("/live", ah(instructorLivePage));
router.get("/live/new", ah(newLiveMeetingPage));
router.post("/live", ah(createLiveMeeting));
router.post("/live/:meetingId/start", ah(startLiveMeeting));
router.post("/live/:meetingId/end", ah(endLiveMeeting));
router.post("/live/:meetingId/cancel", ah(cancelLiveMeeting));
router.post(
  "/live/:meetingId/participants/:userId/remove",
  ah(removeMeetingParticipant)
);

export default router;
