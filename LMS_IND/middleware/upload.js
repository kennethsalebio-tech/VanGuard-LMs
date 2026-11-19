import fs from "fs";
import path from "path";
import crypto from "crypto";
import multer from "multer";

const uploadDir = path.resolve(process.cwd(), "uploads");
const pendingDir = path.join(uploadDir, "pending");
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(pendingDir, { recursive: true });

export const MAX_FILE_SIZE = 25 * 1024 * 1024;

export const ALLOWED = new Set([
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".txt",
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

export const MIME_BY_EXTENSION = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const storage = multer.diskStorage({
  destination: (req, file, callback) => callback(null, pendingDir),
  filename: (req, file, callback) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    callback(null, `${crypto.randomUUID()}${ext}`);
  },
});

export const uploadModule = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED.has(ext)) {
      return callback(
        new Error(
          "Unsupported file type. Upload PDF, DOCX, PPTX, XLSX, TXT, Markdown, HTML, PNG, JPG, GIF, or WebP."
        )
      );
    }
    callback(null, true);
  },
});

export { uploadDir, pendingDir };
