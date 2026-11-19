import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";
import { pendingDir, uploadDir, MIME_BY_EXTENSION } from "../middleware/upload.js";

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function extensionOf(fileName = "") {
  return path.extname(fileName).toLowerCase();
}

function startsWith(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function isTextExtension(ext) {
  return [".txt", ".md", ".markdown", ".html", ".htm"].includes(ext);
}

function isImageExtension(ext) {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext);
}

async function validateZipDocument(buffer, ext) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new UploadError("The uploaded file is not a valid Office document.");
  }

  const required = {
    ".docx": "word/document.xml",
    ".pptx": "ppt/presentation.xml",
    ".xlsx": "xl/workbook.xml",
  }[ext];
  if (!zip.file(required)) {
    throw new UploadError(
      `The file contents do not match the ${ext.slice(1).toUpperCase()} format.`
    );
  }
  return zip;
}

/**
 * Validate beyond the extension supplied by the browser. Multer already
 * sanitizes the stored name; this verifies the bytes belong to the claimed
 * document/image type before the file can be previewed or promoted.
 */
export async function validateUploadedFile(filePath, originalName, suppliedMime = "") {
  const ext = extensionOf(originalName);
  const buffer = await fs.readFile(filePath);

  if (!buffer.length) throw new UploadError("The uploaded file is empty.");

  if (ext === ".pdf") {
    if (!buffer.subarray(0, 8).toString("latin1").startsWith("%PDF-")) {
      throw new UploadError("The file contents do not match the PDF format.");
    }
  } else if ([".docx", ".pptx", ".xlsx"].includes(ext)) {
    await validateZipDocument(buffer, ext);
  } else if (ext === ".png") {
    if (!startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      throw new UploadError("The file contents do not match the PNG format.");
    }
  } else if (ext === ".jpg" || ext === ".jpeg") {
    if (!startsWith(buffer, [0xff, 0xd8, 0xff])) {
      throw new UploadError("The file contents do not match the JPEG format.");
    }
  } else if (ext === ".gif") {
    const header = buffer.subarray(0, 6).toString("latin1");
    if (header !== "GIF87a" && header !== "GIF89a") {
      throw new UploadError("The file contents do not match the GIF format.");
    }
  } else if (ext === ".webp") {
    if (
      buffer.subarray(0, 4).toString("latin1") !== "RIFF" ||
      buffer.subarray(8, 12).toString("latin1") !== "WEBP"
    ) {
      throw new UploadError("The file contents do not match the WebP format.");
    }
  } else if (isTextExtension(ext)) {
    if (buffer.includes(0)) {
      throw new UploadError("The uploaded text file contains binary data.");
    }
  } else {
    throw new UploadError("Unsupported file type.");
  }

  return {
    ext,
    mimeType: MIME_BY_EXTENSION[ext] || suppliedMime || "application/octet-stream",
    sizeBytes: buffer.length,
  };
}

function metaPath(token) {
  return path.join(pendingDir, `${token}.meta.json`);
}

function safePendingPath(token, storedName) {
  const resolved = path.resolve(pendingDir, storedName);
  if (!resolved.startsWith(`${path.resolve(pendingDir)}${path.sep}`)) {
    throw new UploadError("Invalid upload path.", 400);
  }
  return resolved;
}

export async function createPendingUpload({ file, userId, courseId }) {
  const token = path.basename(file.filename, path.extname(file.filename));
  if (!TOKEN_PATTERN.test(token)) {
    await fs.unlink(file.path).catch(() => {});
    throw new UploadError("The upload could not be stored safely.");
  }

  const validated = await validateUploadedFile(
    file.path,
    file.originalname,
    file.mimetype
  );
  const metadata = {
    token,
    storedName: file.filename,
    originalName: path.basename(file.originalname || `module${validated.ext}`).slice(0, 180),
    mimeType: validated.mimeType,
    sizeBytes: validated.sizeBytes,
    ownerId: Number(userId),
    courseId: Number(courseId),
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(metaPath(token), JSON.stringify(metadata), "utf8");
  return metadata;
}

export async function getPendingUpload(token, { userId, courseId }) {
  if (!TOKEN_PATTERN.test(String(token || ""))) {
    throw new UploadError("The upload reference is invalid.", 404);
  }
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(metaPath(token), "utf8"));
  } catch {
    throw new UploadError("This upload is no longer available. Please upload the file again.", 404);
  }
  if (metadata.ownerId !== Number(userId) || metadata.courseId !== Number(courseId)) {
    throw new UploadError("You cannot access this upload.", 403);
  }
  const filePath = safePendingPath(token, metadata.storedName);
  try {
    await fs.access(filePath);
  } catch {
    throw new UploadError("The uploaded file is missing. Please upload it again.", 404);
  }
  return { ...metadata, filePath };
}

export async function removePendingUpload(token, { userId, courseId }) {
  const upload = await getPendingUpload(token, { userId, courseId });
  await Promise.all([
    fs.unlink(upload.filePath).catch(() => {}),
    fs.unlink(metaPath(token)).catch(() => {}),
  ]);
}

export async function promoteFile(filePath) {
  const resolved = path.resolve(filePath);
  const pendingRoot = path.resolve(pendingDir);
  if (!resolved.startsWith(`${pendingRoot}${path.sep}`)) {
    throw new UploadError("Invalid upload source.");
  }
  const target = path.join(uploadDir, path.basename(resolved));
  await fs.rename(resolved, target);
  return path.relative(process.cwd(), target).split(path.sep).join("/");
}

export async function consumePendingUpload(token, { userId, courseId }) {
  const upload = await getPendingUpload(token, { userId, courseId });
  const filePath = await promoteFile(upload.filePath);
  await fs.unlink(metaPath(token)).catch(() => {});
  return {
    originalName: upload.originalName,
    mimeType: upload.mimeType,
    size: upload.sizeBytes,
    path: filePath,
    absolutePath: path.resolve(process.cwd(), filePath),
  };
}

export async function cleanupPendingUploads(maxAgeMs = PENDING_MAX_AGE_MS) {
  const cutoff = Date.now() - maxAgeMs;
  let entries = [];
  try {
    entries = await fs.readdir(pendingDir);
  } catch {
    return;
  }

  const knownFiles = new Set();
  for (const entry of entries) {
    if (!entry.endsWith(".meta.json")) continue;
    const token = entry.slice(0, -".meta.json".length);
    const metadataPath = path.join(pendingDir, entry);
    let storedName = null;
    let expired = true;
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
      storedName = metadata.storedName;
      if (new Date(metadata.createdAt).getTime() >= cutoff) {
        knownFiles.add(metadata.storedName);
        expired = false;
      }
    } catch {
      // Remove unreadable sidecars below.
    }
    if (!expired) continue;
    await fs.unlink(metadataPath).catch(() => {});
    if (storedName) {
      await fs.unlink(safePendingPath(token, storedName)).catch(() => {});
    } else if (TOKEN_PATTERN.test(token)) {
      const match = entries.find(
        (name) => !name.endsWith(".meta.json") && name.startsWith(`${token}.`)
      );
      if (match) await fs.unlink(path.join(pendingDir, match)).catch(() => {});
    }
  }

  // Orphaned files (for example from an interrupted request) expire too.
  for (const entry of entries) {
    if (entry.endsWith(".meta.json") || knownFiles.has(entry)) continue;
    const filePath = path.join(pendingDir, entry);
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoff) await fs.unlink(filePath);
    } catch {
      // Ignore files already removed by another request.
    }
  }
}

export { isImageExtension, isTextExtension, extensionOf };
