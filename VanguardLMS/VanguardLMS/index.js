/*
    MIT License
    
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */
    
import "dotenv/config";
import express from "express";
import path from "path";
import session from "express-session";
import flash from "connect-flash";
import router from "./routes/index.js";
import fs from "fs/promises";
import hbs from "hbs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname } from "path";
import { dbReady } from "./models/index.js";
import { validateRuntimeConfig, isProduction } from "./config.js";
import { SequelizeSessionStore } from "./services/sessionStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

validateRuntimeConfig();

const app = express();
// The billing API runs beside LMS_IND, so it defaults to 4000 instead of 3000.
const PORT = process.env.PORT || 4000;
const production = isProduction();

app.disable("x-powered-by");
if (production) app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (production) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// Keep the exact bytes of each body: webhook signatures are verified over them.
app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buffer) => {
      req.rawBody = buffer;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

const sessionStore = new SequelizeSessionStore();
if (production) {
  setInterval(() => sessionStore.clearExpired(), 60 * 60 * 1000).unref();
}

app.use(session({
  name: "vanguard.billing.sid",
  secret: process.env.SESSION_SECRET || "vanguard-billing-dev-secret",
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: production,
    maxAge: 8 * 60 * 60 * 1000,
  },
}));
app.use(flash());

app.engine("xian", (filePath, options, callback) => {
  hbs.__express(filePath, options, callback);
});
app.use((req, res, next) => {
  res.locals.success_msg = req.flash("success_msg");
  res.locals.error_msg = req.flash("error_msg");
  next();
});


/* View helpers used by the billing/sandbox pages. */
hbs.registerHelper("eq", (a, b) => a === b || String(a) === String(b));
hbs.registerHelper("formatDate", (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
});

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "xian");
const partialsDir = path.join(__dirname, "views/partials");
const partialFiles = await fs.readdir(partialsDir);
await Promise.all(
  partialFiles
    .filter((file) => file.endsWith(".xian"))
    .map(async (file) => {
      const partialName = file.replace(".xian", "");
      const content = await fs.readFile(path.join(partialsDir, file), "utf8");
      hbs.registerPartial(partialName, content);
    }),
);

app.use("/", router);

export default app;

// Start the HTTP server; resolves once the server is listening.
// Exported so the Electron main process can control startup itself.
export const startServer = async (port = PORT) => {
  await dbReady;

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`🔥 XianFire running at http://localhost:${port}`);
      resolve(server);
    });
    server.on("error", reject);
  });
};

// Auto-start only when executed directly (node index.js).
// When imported by electron/main.js, Electron manages the server lifecycle.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun && !process.env.XIAN_ELECTRON) {
  startServer();
}
