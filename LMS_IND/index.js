/*
    MIT License

    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/

import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import session from "express-session";
import flash from "connect-flash";
import hbs from "hbs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname } from "path";

import router from "./routes/index.js";
import { dbReady } from "./models/index.js";
import { attachUser } from "./middleware/auth.js";
import {
  securityHeaders,
  csrfToken,
  verifyCsrf,
} from "./middleware/security.js";
import { validateRuntimeConfig, isProduction } from "./config.js";
import { SequelizeSessionStore } from "./services/sessionStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

validateRuntimeConfig();
await dbReady;

const app = express();
const PORT = process.env.PORT || 3000;
const production = isProduction();

app.disable("x-powered-by");
if (production) app.set("trust proxy", 1);
app.use(securityHeaders);
// Keep the exact request bytes so the billing webhook HMAC can be verified.
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

app.use(
  session({
    name: "vanguard.sid",
    secret: process.env.SESSION_SECRET || "vanguard-learning-dev-secret",
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: production,
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);
app.use(flash());

/* ------------------------------------------------------------ view helpers */

hbs.registerHelper("eq", (a, b) => a === b || String(a) === String(b));
hbs.registerHelper("ne", (a, b) => !(a === b || String(a) === String(b)));
hbs.registerHelper("gt", (a, b) => Number(a) > Number(b));
hbs.registerHelper("gte", (a, b) => Number(a) >= Number(b));
hbs.registerHelper("lt", (a, b) => Number(a) < Number(b));
hbs.registerHelper("lte", (a, b) => Number(a) <= Number(b));
hbs.registerHelper("and", (...args) => args.slice(0, -1).every(Boolean));
hbs.registerHelper("or", (...args) => args.slice(0, -1).some(Boolean));
hbs.registerHelper("not", (value) => !value);
hbs.registerHelper("add", (a, b) => Number(a) + Number(b));
hbs.registerHelper("sub", (a, b) => Number(a) - Number(b));
hbs.registerHelper("includes", (list, value) =>
  Array.isArray(list) ? list.includes(value) : false
);
hbs.registerHelper("json", (value) => {
  const json = JSON.stringify(value ?? null).replace(/</g, "\\u003c");
  return new hbs.SafeString(json);
});
hbs.registerHelper("formatDate", (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
});
hbs.registerHelper("peso", (value, currency) => {
  // Handlebars appends its options object when the helper is called with a
  // single argument, so only treat a real string as the currency.
  const code = typeof currency === "string" && currency ? currency : "PHP";
  const amount = Number(value || 0);
  return `${code} ${amount.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
});
hbs.registerHelper("number", (value) =>
  Number(value || 0).toLocaleString("en-PH")
);
hbs.registerHelper("formatDateTime", (value) => {
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
hbs.registerHelper("initials", (name = "") =>
  String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("")
);
hbs.registerHelper("optionLetter", (index) => String.fromCharCode(65 + Number(index)));
hbs.registerHelper("isActive", (current = "", prefix = "") => {
  const isMatch =
    current === prefix ||
    (prefix !== "/" && current.startsWith(`${prefix}/`));
  return isMatch
    ? "bg-brand-50 font-semibold !text-brand-700"
    : "text-slate-600 hover:bg-slate-50 hover:text-navy-900";
});
// Named "percentText" so it never shadows a page variable called "percent".
hbs.registerHelper("percentText", (value) => `${Math.round(Number(value) || 0)}%`);
hbs.registerHelper("durationText", (value) => {
  const seconds = Math.max(0, Number(value) || 0);
  if (seconds < 60) return seconds ? `${seconds}s` : "—";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
});

/* --------------------------------------------------------------- partials */

const partialsDir = path.join(__dirname, "views/partials");
for (const file of fs.readdirSync(partialsDir)) {
  if (!file.endsWith(".xian")) continue;
  const name = file.replace(".xian", "");
  hbs.registerPartial(name, fs.readFileSync(path.join(partialsDir, file), "utf8"));
}

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "xian");
app.engine("xian", hbs.__express);

/* ------------------------------------------------------------- middleware */

app.use((req, res, next) => {
  res.locals.success_msg = req.flash("success_msg");
  res.locals.error_msg = req.flash("error_msg");
  res.locals.info_msg = req.flash("info_msg");
  res.locals.currentPath = req.path;
  next();
});
app.use(csrfToken);
app.use(attachUser);
app.use(verifyCsrf);

app.use("/", router);

/* ------------------------------------------------------------ error pages */

app.use((req, res) => {
  res.status(404).render("error", {
    title: "Page not found",
    status: 404,
    message: "The page you requested does not exist or has moved.",
  });
});

app.use((error, req, res, next) => {
  console.error("Request failed:", error);
  if (res.headersSent) return next(error);
  res.status(error.status || 500).render("error", {
    title: "Something went wrong",
    status: error.status || 500,
    message:
      process.env.NODE_ENV === "production"
        ? "An unexpected error occurred. Please try again."
        : error.message,
  });
});

export default app;

export const startServer = (port = PORT) => {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`🔥 Vanguard Learning running at http://localhost:${port}`);
      resolve(server);
    });
    server.on("error", reject);
  });
};

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun && !process.env.XIAN_ELECTRON) {
  startServer();
}
