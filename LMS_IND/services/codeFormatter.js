/*
 * Detects programming code inside HTML produced from a Word document and
 * formats only those paragraphs as code blocks.
 *
 * The input is the HTML mammoth generates from the DOCX (not the flattened
 * plain text), so ordinary paragraphs, headings, tables, lists, and inline
 * formatting are left exactly as they were. Consecutive code paragraphs are
 * merged into one <pre> block so line breaks and indentation survive.
 *
 * Detection is deliberately structural. Mentioning XML, SOAP, HTML, API, or
 * another technology in a sentence is not evidence of code; actual markup,
 * statements, declarations, and data structures are.
 */

const CODE_INLINE_STYLE = [
  "font-family:'Courier New',Courier,monospace",
  "background:#f1f3f5",
  "color:#1f2937",
  "font-size:0.875rem",
  "line-height:1.5",
  "margin:0.9rem 0",
  "padding:0.85rem 1rem",
  "border:1px solid #e2e8f0",
  "border-left:3px solid #94a3b8",
  "border-radius:0.5rem",
  "white-space:pre",
  "overflow-x:auto",
  "tab-size:4",
].join(";");

const CODE_TAG_STYLE = [
  "font-family:inherit",
  "font-size:inherit",
  "line-height:inherit",
  "background:transparent",
  "color:inherit",
  "margin:0",
  "padding:0",
  "white-space:pre",
].join(";");

/* Any XML, SOAP, HTML, or similar markup line, including namespaced tags. */
const MARKUP_LINE =
  /^\s*(?:<\?[\w:-]+[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE\b[^>]*>|<\/?[A-Za-z][\w:.-]*(?:\s+[^<>]*?)?\/?>)/i;

const HTML_COMMENT = /^\s*<!--[\s\S]*-->\s*$/;
const BLOCK_COMMENT = /^\s*\/\*[\s\S]*\*\/\s*$/;
const LINE_COMMENT = /^\s*(?:\/\/|--\s|#(?!include\b|import\b|define\b|pragma\b))/;

const JSON_BRACE = /^\s*[{}[\]]\s*$/;
const JSON_PROPERTY =
  /^\s*"[^"\\]*(?:\\.[^"\\]*)*"\s*:\s*(?:"|'|[-+]?\d|true\b|false\b|null\b|\{|\[)/;
const JSON_VALUE =
  /^\s*(?:"[^"\\]*(?:\\.[^"\\]*)*"|[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)\s*,?\s*$/;
const JSON_DOCUMENT =
  /^\s*(?:\{[\s\S]*"[^"\\]+"\s*:[\s\S]*\}|\[[\s\S]*(?:"[^"]*"|true|false|null|-?\d)[\s\S]*\])\s*$/;

const HTTP_REQUEST =
  /^\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(?:\/|https?:\/\/)\S*(?:\s+HTTP\/\d+(?:\.\d+)?)?\s*$/i;
const HTTP_HEADER =
  /^\s*(?:Accept(?:-Encoding|-Language)?|Authorization|Cache-Control|Connection|Content-Length|Content-Type|Cookie|Host|Origin|Referer|SOAPAction|User-Agent)\s*:\s*\S+/i;

const SQL_START =
  /^\s*(?:SELECT\s*(?:$|\*|[\w."`]+\s*(?:,\s*[\w."`]+\s*)*(?:\bFROM\b|$))|INSERT\s+INTO\b|UPDATE\s+[\w."`]+\s+SET\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|DATABASE|INDEX|VIEW|PROCEDURE|FUNCTION)\b|ALTER\s+TABLE\b|DROP\s+(?:TABLE|DATABASE|INDEX|VIEW)\b|WITH\s+[\w"`]+\s+AS\s*\()/i;

const SQL_CONTINUATION =
  /^\s*(?:FROM|WHERE|JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|INNER\s+JOIN|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|VALUES|SET|AND|OR|ON|UNION(?:\s+ALL)?|INSERT\s+INTO|DELETE\s+FROM)\b/i;

const CSS_DECLARATION =
  /^\s*(?:color|background(?:-color|-image|-size|-position|-repeat)?|font(?:-family|-size|-weight|-style)?|margin(?:-\w+)?|padding(?:-\w+)?|border(?:-\w+)?|display|position|width|height|max-\w+|min-\w+|flex(?:-\w+)?|grid(?:-\w+)?|text-\w+|line-height|letter-spacing|box-shadow|border-radius|opacity|z-index|overflow(?:-[xy])?|gap|align-\w+|justify-\w+|transform|transition|top|right|bottom|left|content|cursor|list-style(?:-\w+)?|white-space|word-break|vertical-align|visibility)\s*:\s*[^;{}]+;/i;

const CSS_SELECTOR =
  /^\s*(?:[.#][\w-]+|[a-z][\w-]*)(?:[\s>+~,:.#[\]="'\w-]*)\{\s*$/i;

const KEYWORD_STATEMENT =
  /^\s*(?:return|throw|yield|break|continue|pass|raise|goto|delete|await|yield\s+from)\b[^.!?]*[;)}\] ]\s*$/;

const STRONG_PATTERNS = [
  /^\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:class|interface|enum|struct|record)\s+[A-Za-z_$][\w$]*/,
  /^\s*def\s+[A-Za-z_]\w*\s*\(/,
  /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|virtual|override|synchronized|async|extern|unsafe)\s+)+[\w<>[\],.?]+\s+[A-Za-z_$][\w$]*\s*\([^;]*\)\s*\{?\s*$/,
  /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=/,
  /^\s*(?:import|export)\s+(?:.*\bfrom\s+['"]|[{*]|['"]|.*;\s*$)/,
  /^\s*from\s+[\w.]+\s+import\s+/,
  /^\s*#\s*(?:include|import|define|pragma)\b/,
  /^\s*using\s+[\w.]+\s*;/,
  /^\s*namespace\s+[\w.]+\s*[;{]/,
  /^\s*package\s+[\w.]+\s*;/,
  /^\s*(?:SELECT\s*(?:$|\*|[\w."`]+\s*(?:,\s*[\w."`]+\s*)*(?:\bFROM\b|$))|INSERT\s+INTO\b|UPDATE\s+[\w."`]+\s+SET\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|DATABASE|INDEX|VIEW|PROCEDURE|FUNCTION)\b|ALTER\s+TABLE\b|DROP\s+(?:TABLE|DATABASE|INDEX|VIEW)\b)/i,
  /^\s*echo\s+[$\"']/,
  /^\s*(?:print|printf|print_r|var_dump|console\.(?:log|error|warn|info|debug)|System\.out\.print(?:ln|f)?|Console\.Write(?:Line)?|document\.(?:getElementById|querySelector|write)|window\.\w+)\s*[.(]/,
  /^\s*return(?:\s+(?:[A-Za-z_$][\w$.]*(?:\([^)]*\))?|["'][^"']*["'])|\s*)$/,
  /^\s*(?:pass|break|continue)\s*$/,
  /^\s*@(?:media|import|keyframes|font-face|supports)\b/,
  /^\s*<\?(?:php|=)?\b/i,
  /^\s*\?>\s*$/,
  /^\s*\[[A-Za-z][\w.]*(?:\([^)]*\))?\]\s*$/,
  /^\s*@[A-Z][A-Za-z0-9_]*\s*$/,
  /^\s*(?:int|float|double|char|boolean|bool|string|String|long|short|byte|object|dynamic|auto|var)\s+[A-Za-z_$][\w$]*(?:\s*=|;|,|\))/,
];

function decodeEntities(value = "") {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, code) => {
      const point = Number(code);
      return Number.isFinite(point) ? String.fromCodePoint(point) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const point = parseInt(code, 16);
      return Number.isFinite(point) ? String.fromCodePoint(point) : "";
    })
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&");
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Turn one mammoth paragraph into text lines. <br> and soft line breaks become
 * \n, tags are removed, entities decoded, and leading indentation is kept.
 */
function paragraphLines(paragraphHtml = "") {
  let inner = paragraphHtml
    .replace(/^<p\b[^>]*>/i, "")
    .replace(/<\/p>\s*$/i, "");
  inner = inner.replace(/<br\s*\/?>/gi, "\n");
  inner = inner.replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n");
  inner = inner.replace(/<[^>]+>/g, "");
  inner = decodeEntities(inner);
  return inner
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\u00a0/g, " ").replace(/\s+$/, ""));
}

function isProseSentence(text) {
  const words = text.split(/\s+/).filter(Boolean);
  return (
    words.length >= 6 &&
    /[.!?]["')\]]?\s*$/.test(text) &&
    !/[;{}]/.test(text) &&
    !/^\s*</.test(text)
  );
}

function isCallLine(line) {
  const match = line.match(
    /^\s*([A-Za-z_$][\w$]*(?:(?:\.|->|::)[A-Za-z_$][\w$]*)*)\s*\(([^()]*)\)\s*([;{]?)\s*$/
  );
  if (!match) return false;

  const [, callee, args, terminator] = match;
  const base = callee.split(/(?:\.|->|::)/).filter(Boolean).pop() || callee;
  const reserved =
    /^(?:if|for|foreach|while|switch|catch|function|return|print|echo|new|typeof|sizeof|defined|isset)$/i;

  if (reserved.test(callee)) return false;
  // An all-caps acronym followed by a definition is prose, not a function call.
  if (/^[A-Z][A-Z0-9_]*$/.test(base) && !terminator) return false;

  if (terminator) return true;
  if (/[.$>_:]/.test(callee)) return true;
  if (!args.trim()) return true;
  if (/["'`\\[\\]{};=]|^-?\d/.test(args)) return true;
  return /^[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*$/.test(args.trim());
}

function classifyLine(line) {
  const text = line.trim();
  if (!text) return "blank";

  if (HTML_COMMENT.test(line) || BLOCK_COMMENT.test(line)) return "code";
  if (LINE_COMMENT.test(line)) return "comment";

  // XML, SOAP, HTML, and other markup is code based on its structure, not on
  // the words inside it.
  if (MARKUP_LINE.test(line)) return "code";

  // Long sentences with normal prose punctuation are text even when they
  // mention technical terms or contain parentheses.
  if (isProseSentence(text)) return "text";

  if (
    JSON_BRACE.test(line) ||
    JSON_PROPERTY.test(line) ||
    JSON_VALUE.test(line) ||
    JSON_DOCUMENT.test(line)
  ) {
    return "code";
  }

  if (HTTP_REQUEST.test(line) || HTTP_HEADER.test(line)) return "code";
  if (SQL_START.test(line)) return "code";
  if (CSS_DECLARATION.test(line) || CSS_SELECTOR.test(line)) return "code";

  if (STRONG_PATTERNS.some((pattern) => pattern.test(line))) return "code";

  if (isCallLine(line)) return "code";

  // Assignment statements: $total = 0; / count += 1; / x = 1
  if (
    /^\s*[$@]?[A-Za-z_$][\w$.[\]'"]*\s*(?:\+|-|\*|\/|%|\.|\?\?|\|\||&&)?=\s*[^=].*;\s*$/.test(
      line
    )
  ) {
    return "code";
  }
  if (
    /^\s*[A-Za-z_$][\w$.[\]]*\s*=\s*(?:[-+]?\d+(?:\.\d+)?|["'][^"']*["']|[A-Za-z_$][\w$.]*(?:\([^)]*\))?)\s*$/.test(
      line
    )
  ) {
    return "code";
  }

  // Control statements and Python blocks.
  if (
    /^\s*(?:if|elif|else\s+if|for|foreach|while|switch|catch)\b[^{;]*[({:]\s*$/.test(
      line
    )
  ) {
    return "code";
  }
  if (
    /^\s{2,}(?:def|class|return|if|elif|else|for|while|try|except|finally|with|print|raise|pass|import|from)\b/.test(
      line
    ) &&
    /[:=(]/.test(line)
  ) {
    return "code";
  }

  if (KEYWORD_STATEMENT.test(line) && /[;(){}.]/.test(text)) return "code";

  return "text";
}

function isContinuation(line) {
  const text = line.trim();
  if (!text) return true;
  if (/^[}\])]+[;,]?$/.test(text)) return true;
  if (/^[{([]$/.test(text)) return true;
  if (/^(?:else|try|finally|catch|do)\b/.test(text)) return true;
  if (LINE_COMMENT.test(line) || HTML_COMMENT.test(line) || BLOCK_COMMENT.test(line)) {
    return true;
  }
  if (HTTP_HEADER.test(line) || HTTP_REQUEST.test(line)) return true;
  if (/^\s*[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*')/.test(line)) return true;
  if (JSON_PROPERTY.test(line) || JSON_VALUE.test(line)) return true;
  if (CSS_DECLARATION.test(line)) return true;
  if (SQL_CONTINUATION.test(text) && !/[.!?]\s*$/.test(text)) return true;
  if (/^(?:and|or)\s*\(/i.test(text)) return true;
  return false;
}

function paragraphIsCode(lines) {
  const nonEmpty = lines.filter((line) => line.trim());
  if (!nonEmpty.length) return false;
  const classes = nonEmpty.map((line) => classifyLine(line));
  if (!classes.some((value) => value === "code")) return false;
  return classes.every(
    (value) => value === "code" || value === "comment" || value === "blank"
  );
}

function paragraphIsOnlyContinuation(lines) {
  const nonEmpty = lines.filter((line) => line.trim());
  if (!nonEmpty.length) return true;
  return nonEmpty.every((line) => isContinuation(line));
}

function codeBlockHtml(lines) {
  const text = lines.join("\n").replace(/^\n+|\n+$/g, "");
  return `<pre class="lesson-code" style="${CODE_INLINE_STYLE}"><code style="${CODE_TAG_STYLE}">${escapeHtml(
    text
  )}</code></pre>`;
}

function tokenize(html) {
  const tokens = [];
  const pattern = /<table\b[\s\S]*?<\/table>|<p\b[^>]*>[\s\S]*?<\/p>/gi;
  let lastIndex = 0;
  for (const match of html.matchAll(pattern)) {
    if (match.index > lastIndex) {
      tokens.push({ type: "raw", html: html.slice(lastIndex, match.index) });
    }
    tokens.push({
      type: /^<table/i.test(match[0]) ? "raw" : "paragraph",
      html: match[0],
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < html.length) {
    tokens.push({ type: "raw", html: html.slice(lastIndex) });
  }
  return tokens;
}

/**
 * Format detected code paragraphs in DOCX-derived HTML.
 * @param {string} html mammoth HTML
 * @returns {string} HTML with only code paragraphs replaced by <pre> blocks
 */
export function formatCodeInHtml(html = "") {
  const source = String(html);
  if (!source.trim()) return source;

  const tokens = tokenize(source);
  let output = "";
  let run = null;
  let pendingBlank = [];

  const flushRun = () => {
    if (run && run.length) {
      const text = run.join("\n").replace(/^\n+|\n+$/g, "");
      if (text.trim()) output += codeBlockHtml(run);
    }
    run = null;
    pendingBlank = [];
  };

  for (const token of tokens) {
    if (token.type === "raw") {
      flushRun();
      output += token.html;
      continue;
    }

    const lines = paragraphLines(token.html);
    if (!lines.some((line) => line.trim())) {
      if (run) pendingBlank.push("");
      else output += token.html;
      continue;
    }

    if (paragraphIsCode(lines)) {
      if (!run) run = [];
      else if (pendingBlank.length) run.push(...pendingBlank);
      pendingBlank = [];
      run.push(...lines);
      continue;
    }

    if (run && paragraphIsOnlyContinuation(lines)) {
      run.push(...lines);
      pendingBlank = [];
      continue;
    }

    flushRun();
    output += token.html;
  }

  flushRun();
  return output;
}

export { CODE_INLINE_STYLE, CODE_TAG_STYLE };
