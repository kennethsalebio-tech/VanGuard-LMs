import fs from "fs/promises";
import path from "path";
import sqlite3 from "sqlite3";

const LMS = "http://localhost:3000";
const cookies = new Map();
let failures = 0;
let courseId = null;
let lessonRow = null;
let passed = 0;

function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function cookieHeader() {
  return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
}

function absorb(response) {
  for (const line of response.headers.getSetCookie?.() || []) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

async function request(url, options = {}) {
  const response = await fetch(`${LMS}${url}`, {
    ...options,
    redirect: "manual",
    headers: {
      ...(options.headers || {}),
      ...(cookies.size ? { cookie: cookieHeader() } : {}),
    },
  });
  absorb(response);
  const text = await response.text();
  return {
    status: response.status,
    location: response.headers.get("location"),
    text,
    headers: response.headers,
  };
}

const csrf = (html) => html.match(/name="_csrf" value="([^"]+)"/)?.[1];

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database("data/lms.sqlite", (error) =>
      error ? reject(error) : resolve(db)
    );
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)))
  );
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this.changes);
    })
  );
}

let db = null;
try {
  const loginPage = await request("/login");
  const login = await request("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: "instructor@lms.test",
      password: "Teach@123",
      _csrf: csrf(loginPage.text),
    }),
  });
  check("Instructor can sign in", login.status === 302, `${login.status} ${login.location}`);

  const newPage = await request("/instructor/courses/new");
  const created = await request("/instructor/courses", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      title: `Upload QA ${Date.now()}`,
      description: "Temporary upload test",
      _csrf: csrf(newPage.text),
    }),
  });
  check("Disposable course created", created.status === 302, `${created.status} ${created.location}`);
  courseId = Number(created.location?.match(/courses\/(\d+)\/builder/)?.[1]);
  if (!Number.isFinite(courseId)) throw new Error("Could not parse course id");

  let builder = await request(`/instructor/courses/${courseId}/builder`);
  const token = csrf(builder.text);
  const moduleCreated = await request(`/instructor/courses/${courseId}/modules`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      title: "Upload test module",
      description: "Temporary",
      _csrf: token,
    }),
  });
  check("Disposable module created", moduleCreated.status === 302, `${moduleCreated.status}`);

  builder = await request(`/instructor/courses/${courseId}/builder`);
  const moduleId = Number(builder.text.match(/name="moduleId" value="(\d+)"/)?.[1]);
  check("Builder renders the upload module", Number.isFinite(moduleId), String(moduleId));
  check(
    "Drag-and-drop control is present",
    builder.text.includes("doc-dropzone") &&
      builder.text.includes("Drag and drop your file") &&
      builder.text.includes("data-upload-url")
  );
  check(
    "Viewer scripts are loaded",
    builder.text.includes("/js/module-upload.js") &&
      builder.text.includes("/js/document-preview.js")
  );

  /* ---------------------------------------------------------- DOCX upload */
  const docxBytes = await fs.readFile("tests/.tmp-upload/sample.docx");
  const docxForm = new FormData();
  docxForm.append(
    "file",
    new Blob([docxBytes], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    "sample.docx"
  );
  const upload = await fetch(`${LMS}/instructor/courses/${courseId}/upload-preview`, {
    method: "POST",
    headers: { "x-csrf-token": token, cookie: cookieHeader() },
    body: docxForm,
    redirect: "manual",
  });
  const payload = await upload.json().catch(() => null);
  check("DOCX upload accepted", upload.status === 200, `${upload.status}`);
  check("DOCX preview is real HTML", payload?.preview?.kind === "html", payload?.preview?.kind);
  check(
    "DOCX headings/table content rendered",
    String(payload?.preview?.html || "").includes("Quarterly Report") &&
      String(payload?.preview?.html || "").includes("<table")
  );

  const pendingFile = await fetch(
    `${LMS}/instructor/courses/${courseId}/uploads/${payload.token}/file`,
    { headers: { cookie: cookieHeader() }, redirect: "manual" }
  );
  check(
    "Pending document file is served inline",
    pendingFile.status === 200 &&
      String(pendingFile.headers.get("content-disposition") || "").startsWith("inline"),
    `${pendingFile.status} ${pendingFile.headers.get("content-type")}`
  );

  /* --------------------------------------------------------- save lesson */
  const lessonForm = new FormData();
  lessonForm.append("_csrf", token);
  lessonForm.append("moduleId", String(moduleId));
  lessonForm.append("upload_token", payload.token);
  lessonForm.append("title", "Upload test lesson");
  lessonForm.append("durationMinutes", "15");
  lessonForm.append("summary", "Temporary document");
  const lesson = await fetch(`${LMS}/instructor/courses/${courseId}/lessons`, {
    method: "POST",
    headers: { cookie: cookieHeader() },
    body: lessonForm,
    redirect: "manual",
  });
  const lessonLocation = lesson.headers.get("location");
  await lesson.text();
  check(
    "Lesson saved from uploaded token",
    lesson.status === 302 && /lessons\/\d+\/edit/.test(lessonLocation || ""),
    `${lesson.status} ${lessonLocation}`
  );

  db = await openDb();
  lessonRow = (
    await all(db, "select * from Lessons where courseId=? and title='Upload test lesson'", [
      courseId,
    ])
  )[0];
  const resourceRow = lessonRow
    ? (await all(db, "select * from LearningResources where lessonId=?", [lessonRow.id]))[0]
    : null;
  check("Lesson has its source document", Boolean(lessonRow?.sourceFile), lessonRow?.sourceFile);
  check(
    "Resource promoted out of pending storage",
    Boolean(resourceRow?.filePath?.startsWith("uploads/")),
    resourceRow?.filePath
  );
  check(
    "Promoted file exists on disk",
    await fs
      .stat(path.resolve(resourceRow?.filePath || "missing"))
      .then(() => true)
      .catch(() => false)
  );

  const previewPage = await request(`/instructor/resources/${resourceRow.id}/preview`);
  check(
    "Saved document reopens with content",
    previewPage.status === 200 && previewPage.text.includes("Quarterly Report"),
    `${previewPage.status}`
  );
  const savedFile = await fetch(`${LMS}/instructor/resources/${resourceRow.id}/file`, {
    headers: { cookie: cookieHeader() },
    redirect: "manual",
  });
  check(
    "Saved document file is authorized and served",
    savedFile.status === 200,
    `${savedFile.status} ${savedFile.headers.get("content-type")}`
  );

  const beforeRepeat = (
    await all(db, "select count(*) c from Lessons where courseId=?", [courseId])
  )[0].c;
  const repeat = await fetch(`${LMS}/instructor/courses/${courseId}/lessons`, {
    method: "POST",
    headers: { cookie: cookieHeader() },
    body: lessonForm,
    redirect: "manual",
  });
  await repeat.text();
  const afterRepeat = (
    await all(db, "select count(*) c from Lessons where courseId=?", [courseId])
  )[0].c;
  check(
    "Consumed upload token does not duplicate the lesson",
    repeat.status === 302 && beforeRepeat === afterRepeat,
    `${beforeRepeat} → ${afterRepeat}`
  );

  /* --------------------------------------------------------- text/remove */
  const txtBytes = await fs.readFile("tests/.tmp-upload/sample.txt");
  const textForm = new FormData();
  textForm.append("file", new Blob([txtBytes], { type: "text/plain" }), "sample.txt");
  const textUpload = await fetch(`${LMS}/instructor/courses/${courseId}/upload-preview`, {
    method: "POST",
    headers: { "x-csrf-token": token, cookie: cookieHeader() },
    body: textForm,
    redirect: "manual",
  });
  const textPayload = await textUpload.json();
  check(
    "TXT preview shows actual text",
    textUpload.status === 200 &&
      textPayload.preview?.kind === "text" &&
      textPayload.preview.text.includes("Second Topic"),
    `${textUpload.status}`
  );

  const remove = await fetch(
    `${LMS}/instructor/courses/${courseId}/uploads/${textPayload.token}`,
    {
      method: "DELETE",
      headers: { "x-csrf-token": token, cookie: cookieHeader() },
      redirect: "manual",
    }
  );
  check("Uploaded document can be removed", remove.status === 204, `${remove.status}`);
  const removedFile = await fetch(
    `${LMS}/instructor/courses/${courseId}/uploads/${textPayload.token}/file`,
    { headers: { cookie: cookieHeader() }, redirect: "manual" }
  );
  check("Removed upload is no longer served", removedFile.status === 404, `${removedFile.status}`);

  /* ------------------------------------------------ remaining file types */
  const previewCases = [
    {
      name: "sample.pdf",
      type: "application/pdf",
      kind: "pdf",
      test: (preview) => Boolean(preview.fileUrl),
    },
    {
      name: "sample.pptx",
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      kind: "slides",
      test: (preview) =>
        preview.slides?.length === 1 &&
        preview.slides[0].html.includes("Module Orientation") &&
        preview.slides[0].html.includes("data:image/png"),
    },
    {
      name: "sample.xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      kind: "sheets",
      test: (preview) =>
        preview.sheets?.[0]?.rows?.some((row) => row.join(" ").includes("Maria Santos")),
    },
    {
      name: "sample.png",
      type: "image/png",
      kind: "image",
      test: (preview) => Boolean(preview.fileUrl),
    },
  ];
  for (const item of previewCases) {
    const bytes = await fs.readFile(`tests/.tmp-upload/${item.name}`);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: item.type }), item.name);
    const response = await fetch(`${LMS}/instructor/courses/${courseId}/upload-preview`, {
      method: "POST",
      headers: { "x-csrf-token": token, cookie: cookieHeader() },
      body: form,
      redirect: "manual",
    });
    const body = await response.json().catch(() => null);
    check(
      `${item.name} upload preview`,
      response.status === 200 && body?.preview?.kind === item.kind && item.test(body.preview || {}),
      `${response.status} ${body?.preview?.kind || body?.error || ""}`
    );
    if (body?.token) {
      const fileResponse = await fetch(
        `${LMS}/instructor/courses/${courseId}/uploads/${body.token}/file`,
        { headers: { cookie: cookieHeader() }, redirect: "manual" }
      );
      check(`${item.name} source file served`, fileResponse.status === 200, `${fileResponse.status}`);
      await fetch(`${LMS}/instructor/courses/${courseId}/uploads/${body.token}`, {
        method: "DELETE",
        headers: { "x-csrf-token": token, cookie: cookieHeader() },
        redirect: "manual",
      });
    }
  }

  /* -------------------------------------------------- image lesson save */
  const imageBytes = await fs.readFile("tests/.tmp-upload/sample.png");
  const imageForm = new FormData();
  imageForm.append("file", new Blob([imageBytes], { type: "image/png" }), "sample.png");
  const imageUpload = await fetch(`${LMS}/instructor/courses/${courseId}/upload-preview`, {
    method: "POST",
    headers: { "x-csrf-token": token, cookie: cookieHeader() },
    body: imageForm,
    redirect: "manual",
  });
  const imagePayload = await imageUpload.json();
  const imageLessonForm = new FormData();
  imageLessonForm.append("_csrf", token);
  imageLessonForm.append("moduleId", String(moduleId));
  imageLessonForm.append("upload_token", imagePayload.token);
  imageLessonForm.append("title", "Image test lesson");
  const imageLesson = await fetch(`${LMS}/instructor/courses/${courseId}/lessons`, {
    method: "POST",
    headers: { cookie: cookieHeader() },
    body: imageLessonForm,
    redirect: "manual",
  });
  await imageLesson.text();
  const imageLessonRow = (
    await all(db, "select * from Lessons where courseId=? and title='Image test lesson'", [courseId])
  )[0];
  const imageContent = imageLessonRow
    ? (await all(db, "select * from LessonContents where lessonId=?", [imageLessonRow.id]))[0]
    : null;
  check(
    "Image lesson saves an inline document preview",
    imageLesson.status === 302 &&
      String(imageContent?.html || "").includes("/resources/") &&
      String(imageContent?.html || "").includes("/file"),
    `${imageLesson.status}`
  );

  const pdfModule = await fetch(`${LMS}/vendor/pdfjs/pdf.mjs`, { redirect: "manual" });
  const pdfWorker = await fetch(`${LMS}/vendor/pdfjs/pdf.worker.mjs`, { redirect: "manual" });
  check(
    "PDF.js renderer and worker assets are available",
    pdfModule.status === 200 && pdfWorker.status === 200,
    `${pdfModule.status}/${pdfWorker.status}`
  );

  /* ---------------------------------------------------------- validation */
  const badForm = new FormData();
  badForm.append("file", new Blob(["hello"], { type: "text/plain" }), "bad.exe");
  const badUpload = await fetch(`${LMS}/instructor/courses/${courseId}/upload-preview`, {
    method: "POST",
    headers: { "x-csrf-token": token, cookie: cookieHeader() },
    body: badForm,
    redirect: "manual",
  });
  check("Unsupported extension is rejected", badUpload.status === 400, `${badUpload.status}`);

  const forgedForm = new FormData();
  forgedForm.append(
    "file",
    new Blob(["not a pdf"], { type: "application/pdf" }),
    "forged.pdf"
  );
  const forgedUpload = await fetch(`${LMS}/instructor/courses/${courseId}/upload-preview`, {
    method: "POST",
    headers: { "x-csrf-token": token, cookie: cookieHeader() },
    body: forgedForm,
    redirect: "manual",
  });
  check(
    "File signature is checked, not just the extension",
    forgedUpload.status === 400 || forgedUpload.status === 422,
    `${forgedUpload.status}`
  );

  const oversized = Buffer.alloc(25 * 1024 * 1024 + 1024, 0x61);
  const oversizedForm = new FormData();
  oversizedForm.append("file", new Blob([oversized], { type: "text/plain" }), "large.txt");
  const oversizedUpload = await fetch(`${LMS}/instructor/courses/${courseId}/upload-preview`, {
    method: "POST",
    headers: { "x-csrf-token": token, cookie: cookieHeader() },
    body: oversizedForm,
    redirect: "manual",
  });
  check("Oversized file is rejected", oversizedUpload.status === 413, `${oversizedUpload.status}`);
} catch (error) {
  failures += 1;
  console.error("TEST ERROR", error);
} finally {
  try {
    if (db && courseId) {
      const sourceLessons = await all(
        db,
        "select sourceFile from Lessons where courseId=? and sourceFile is not null",
        [courseId]
      );
      for (const sourceLesson of sourceLessons) {
        await fs.unlink(path.resolve(sourceLesson.sourceFile)).catch(() => {});
      }
      await run(db, "delete from LearningResources where lessonId in (select id from Lessons where courseId=?)", [courseId]);
      await run(db, "delete from LessonContents where lessonId in (select id from Lessons where courseId=?)", [courseId]);
      await run(db, "delete from QuestionBanks where courseId=?", [courseId]);
      await run(db, "delete from LessonProgresses where courseId=?", [courseId]);
      await run(db, "delete from CourseProgresses where courseId=?", [courseId]);
      await run(db, "delete from Lessons where courseId=?", [courseId]);
      await run(db, "delete from Modules where courseId=?", [courseId]);
      await run(db, "delete from Courses where id=?", [courseId]);
      db.close();
    }
  } catch (error) {
    console.error("CLEANUP ERROR", error);
  }
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}
