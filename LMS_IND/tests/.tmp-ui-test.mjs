import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import sqlite3 from "sqlite3";

const LMS = "http://localhost:3000";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9222;
const PROFILE = path.resolve(".tmp-chrome-ui-profile");
const sample = "tests/.tmp-upload/sample.pdf";
const publicSample = "public/tmp-ui-sample.pdf";
const cookies = new Map();
let chrome = null;
let db = null;
let courseId = null;
let lessonId = null;
let failures = 0;
let passed = 0;

function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cookieHeader = () =>
  [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
function absorb(response) {
  for (const line of response.headers.getSetCookie?.() || []) {
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1));
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
  return { response, text: await response.text() };
}
const csrf = (html) => html.match(/name="_csrf" value="([^"]+)"/)?.[1];
function all(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (e, r) => (e ? reject(e) : resolve(r)))
  );
}
function run(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (e) {
      if (e) reject(e);
      else resolve(this.changes);
    })
  );
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.pending = new Map();
    this.id = 0;
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          "Evaluation failed"
      );
    }
    return result.result.value;
  }
  close() {
    this.ws.close();
  }
}

try {
  const basePdf = await fs.readFile(sample);
  await fs.writeFile(
    publicSample,
    Buffer.concat([basePdf, Buffer.alloc(8 * 1024 * 1024, 0x20)])
  );
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
  check("Instructor signed in for browser flow", login.response.status === 302);
  const sessionCookie = [...cookies].find(([name]) => name === "vanguard.sid");
  if (!sessionCookie) throw new Error("No instructor session cookie");

  const newPage = await request("/instructor/courses/new");
  const created = await request("/instructor/courses", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      title: `Browser upload QA ${Date.now()}`,
      description: "Temporary drag-and-drop test",
      _csrf: csrf(newPage.text),
    }),
  });
  courseId = Number(created.response.headers.get("location")?.match(/courses\/(\d+)\/builder/)?.[1]);
  if (!courseId) throw new Error("No test course id");
  let builder = await request(`/instructor/courses/${courseId}/builder`);
  const moduleToken = csrf(builder.text);
  await request(`/instructor/courses/${courseId}/modules`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title: "Browser test module", _csrf: moduleToken }),
  });
  builder = await request(`/instructor/courses/${courseId}/builder`);
  const moduleId = builder.text.match(/name="moduleId" value="(\d+)"/)?.[1];
  if (!moduleId) throw new Error("No test module id");

  await fs.rm(PROFILE, { recursive: true, force: true });
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true }
  );

  let version = null;
  for (let i = 0; i < 30; i += 1) {
    try {
      version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
      break;
    } catch {
      await sleep(300);
    }
  }
  if (!version) throw new Error("Chrome debug endpoint unavailable");

  const target = await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(LMS + "/login")}`,
    { method: "PUT" }
  ).then((r) => r.json());
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.setCookie", {
    name: sessionCookie[0],
    value: sessionCookie[1],
    url: LMS,
    path: "/",
    httpOnly: true,
  });
  await cdp.send("Page.navigate", {
    url: `${LMS}/instructor/courses/${courseId}/builder`,
  });

  let ready = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(300);
    const state = await cdp.evaluate(`({
      title:document.title,
      ready:document.readyState,
      forms:document.querySelectorAll('.module-upload-form').length,
      zone:Boolean(document.querySelector('[data-dropzone]'))
    })`);
    if (String(state?.title).includes("Builder") && state.ready === "complete" && state.forms > 0 && state.zone) {
      ready = true;
      break;
    }
  }
  check("Builder page loaded in browser", ready);

  await cdp.evaluate(`(function(){
    window.__uploadStates=[];
    const observer=new MutationObserver(function(){
      const status=document.querySelector('[data-progress-status]');
      const percent=document.querySelector('[data-progress-percent]');
      if(status) window.__uploadStates.push({status:status.textContent,percent:percent?percent.textContent:''});
    });
    observer.observe(document.body,{subtree:true,childList:true,characterData:true});
    window.__uploadObserver=observer;
  })()`);

  const dragResult = await cdp.evaluate(`(function(){
    try {
      const zone=document.querySelector('[data-dropzone]');
      if(!zone) return {error:'dropzone missing',html:document.body.innerText.slice(0,300)};
      const file=new File(['x'],'probe.pdf',{type:'application/pdf'});
      const dt=new DataTransfer(); dt.items.add(file);
      let fired=false;
      zone.addEventListener('dragenter',function(){ fired=true; },{once:true});
      zone.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:dt}));
      const active=zone.classList.contains('is-dragging');
      const className=zone.className;
      zone.dispatchEvent(new DragEvent('dragleave',{bubbles:true,cancelable:true,dataTransfer:dt}));
      return {active,fired,className};
    } catch (error) { return {error:error.message,stack:error.stack}; }
  })()`);
  check(
    "Dragging a file highlights the dropzone",
    dragResult?.active === true && dragResult?.fired === true,
    JSON.stringify(dragResult)
  );

  const dropResult = await cdp.evaluate(`(async function(){
    const response=await fetch('/tmp-ui-sample.pdf');
    const bytes=await response.arrayBuffer();
    const file=new File([bytes],'Browser PDF.pdf',{type:'application/pdf'});
    const dt=new DataTransfer(); dt.items.add(file);
    const zone=document.querySelector('[data-dropzone]');
    zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
    return {name:file.name,size:file.size,dragging:zone.classList.contains('is-dragging')};
  })()`);
  check(
    "PDF was dropped into the real upload control",
    dropResult?.name === "Browser PDF.pdf" && dropResult.size > 100 && dropResult.dragging === false,
    JSON.stringify(dropResult)
  );

  let ui = null;
  let uploadStates = [];
  for (let i = 0; i < 40; i += 1) {
    await sleep(350);
    ui = await cdp.evaluate(`(function(){
      const progress=document.querySelector('[data-progress]');
      const result=document.querySelector('[data-upload-result]');
      const token=document.querySelector('[data-upload-token]');
      return {
        progressVisible:progress && !progress.hidden,
        status:document.querySelector('[data-progress-status]')?.textContent||'',
        percent:document.querySelector('[data-progress-percent]')?.textContent||'',
        resultVisible:result && !result.hidden,
        token:token?.value||'',
        fileName:document.querySelector('[data-file-name]')?.textContent||'',
        canvases:document.querySelectorAll('.dv-pdf-page canvas').length,
        pageCounter:document.querySelector('.dv-counter')?.textContent||'',
        error:document.querySelector('[data-upload-error]')?.hidden===false
          ? document.querySelector('[data-error-message]')?.textContent||''
          : ''
      };
    })()`);
    if (ui.resultVisible && ui.canvases > 0) break;
    if (ui.error) break;
  }
  uploadStates = await cdp.evaluate("window.__uploadStates || []");
  const sawProgress = uploadStates.some((entry) =>
    String(entry.status || "").startsWith("Uploading")
  );
  const progressPercent = uploadStates
    .map((entry) => entry.percent)
    .find((value) => /^[1-9]\d*%$/.test(value || ""));
  check(
    "Upload progress UI is used during the transfer",
    sawProgress,
    JSON.stringify(uploadStates.slice(0, 8))
  );
  check(
    "Actual upload percentage is displayed",
    Boolean(progressPercent),
    progressPercent || "not observed"
  );
  check("Uploaded PDF preview rendered a page", (ui?.canvases || 0) > 0, JSON.stringify(ui));
  check(
    "Completion state exposes the single-use upload token",
    Boolean(ui?.token) && ui?.fileName === "Browser PDF.pdf",
    ui?.token
  );
  check("Preview shows a page counter", String(ui?.pageCounter || "").includes("1 / 1"), ui?.pageCounter);

  await cdp.evaluate(`(function(){
    const form=document.querySelector('.module-upload-form');
    form.querySelector('input[name="title"]').value='Browser drag test lesson';
    form.querySelector('input[name="durationMinutes"]').value='20';
    form.querySelector('form')?.requestSubmit?.();
    form.requestSubmit();
  })()`);

  let navigated = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(350);
    const href = await cdp.evaluate("location.href");
    if (/\/instructor\/lessons\/\d+\/edit/.test(href)) {
      navigated = true;
      lessonId = Number(href.match(/lessons\/(\d+)\/edit/)?.[1]);
      break;
    }
  }
  check("Form saves the lesson and redirects to the editor", navigated);
  if (lessonId) {
    const editPage = await request(`/instructor/lessons/${lessonId}/edit`);
    check(
      "Saved lesson shows the document preview action",
      editPage.text.includes(`/instructor/resources/`) &&
        editPage.text.includes("/preview") &&
        editPage.text.includes("View document")
    );
  }
  cdp.close();
} catch (error) {
  failures += 1;
  console.error("UI TEST ERROR", error);
} finally {
  try {
    if (chrome) chrome.kill();
    await fs.unlink(path.resolve(publicSample)).catch(() => {});
    await sleep(400);
    await fs.rm(PROFILE, { recursive: true, force: true }).catch(() => {});
    db = await new Promise((resolve, reject) => {
      const database = new sqlite3.Database("data/lms.sqlite", (e) =>
        e ? reject(e) : resolve(database)
      );
    });
    if (courseId) {
      const resources = await all(
        "select * from LearningResources where lessonId in (select id from Lessons where courseId=?)",
        [courseId]
      );
      for (const resource of resources) {
        await fs.unlink(path.resolve(resource.filePath)).catch(() => {});
      }
      await run("delete from LearningResources where lessonId in (select id from Lessons where courseId=?)", [courseId]);
      await run("delete from LessonContents where lessonId in (select id from Lessons where courseId=?)", [courseId]);
      await run("delete from QuestionBanks where courseId=?", [courseId]);
      await run("delete from LessonProgresses where courseId=?", [courseId]);
      await run("delete from CourseProgresses where courseId=?", [courseId]);
      await run("delete from Lessons where courseId=?", [courseId]);
      await run("delete from Modules where courseId=?", [courseId]);
      await run("delete from Courses where id=?", [courseId]);
    }
  } catch (error) {
    console.error("UI CLEANUP ERROR", error);
  } finally {
    if (db) db.close();
  }
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}
