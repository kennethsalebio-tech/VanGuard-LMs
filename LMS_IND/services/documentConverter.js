import path from "path";
import mammoth from "mammoth";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { PDFParse } from "pdf-parse";
import { stripHtml } from "./questionGenerator.js";
import { formatCodeInHtml } from "./codeFormatter.js";

const SUPPORTED = [
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
];

export function isSupportedDocument(fileName = "") {
  return SUPPORTED.includes(path.extname(fileName).toLowerCase());
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sanitizeLessonHtml(html = "") {
  return String(html)
    .replace(
      /<(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta)[\s\S]*?<\/\1>/gi,
      ""
    )
    .replace(
      /<(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta)\b[^>]*\/?>/gi,
      ""
    )
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, "")
    .replace(/\s(href|src)\s*=\s*javascript:[^\s>]+/gi, "");
}

function looksLikeHeading(line) {
  const text = line.trim();
  if (!text || text.length > 90) return false;
  if (/^\d+(\.\d+)*[.)]?\s+\S/.test(text)) return true;
  if (/[.!?,;:]$/.test(text)) return false;
  const words = text.split(/\s+/);
  if (words.length > 9) return false;
  const caps = words.filter((w) => /^[A-Z0-9]/.test(w)).length;
  return (
    text === text.toUpperCase() ||
    caps >= Math.ceil(words.length * 0.7) ||
    words.length <= 6
  );
}

function plainTextToSections(plainText) {
  const lines = String(plainText)
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim());

  const sections = [];
  let current = { heading: "", paragraphs: [] };
  let buffer = [];

  const flushParagraph = () => {
    if (buffer.length) {
      current.paragraphs.push(buffer.join(" "));
      buffer = [];
    }
  };

  for (const line of lines) {
    if (!line) {
      flushParagraph();
      continue;
    }
    if (looksLikeHeading(line)) {
      flushParagraph();
      if (current.heading || current.paragraphs.length) sections.push(current);
      current = { heading: line, paragraphs: [] };
    } else {
      buffer.push(line);
      // PDF text often arrives as visually wrapped lines with no blank lines.
      if (buffer.join(" ").length > 320) flushParagraph();
    }
  }
  flushParagraph();
  if (current.heading || current.paragraphs.length) sections.push(current);

  return sections.filter((s) => s.heading || s.paragraphs.length);
}

function sectionsToHtml(sections) {
  if (!sections.length) {
    return `<section class="lesson-section"><p class="text-slate-600">No readable text could be extracted from this document.</p></section>`;
  }
  return sections
    .map(
      (section, index) => `
    <section class="lesson-section" id="section-${index + 1}">
      ${section.heading ? `<h2>${escapeHtml(section.heading)}</h2>` : ""}
      ${section.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n")}
    </section>`
    )
    .join("\n");
}

async function extractPdf(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.text || "";
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractDocx(buffer) {
  const [htmlResult, textResult] = await Promise.all([
    mammoth.convertToHtml({ buffer }),
    mammoth.extractRawText({ buffer }),
  ]);
  const detectedHtml = formatCodeInHtml(htmlResult.value || "");
  return {
    html: sanitizeLessonHtml(detectedHtml),
    plainText: textResult.value || stripHtml(detectedHtml),
    notes: (htmlResult.messages || [])
      .map((m) => m.message)
      .filter(Boolean),
  };
}

function extractXlsx(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sections = [];
  const textParts = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const table = XLSX.utils.sheet_to_html(sheet, {
      header: "",
      footer: "",
      id: `sheet-${sections.length + 1}`,
    });
    const csv = XLSX.utils.sheet_to_csv(sheet);
    textParts.push(`${name}\n${csv}`);
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
    sections.push({
      heading: name,
      paragraphs: rows.slice(0, 2).map((row) => row.join(" · ")),
      table,
    });
  }
  return {
    sections,
    plainText: textParts.join("\n\n"),
    html: sections
      .map(
        (section, index) => `
      <section class="lesson-section" id="sheet-section-${index + 1}">
        <h2>${escapeHtml(section.heading)}</h2>
        <div class="lesson-table-wrap">${section.table}</div>
      </section>`
      )
      .join("\n"),
  };
}

async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/)[1]);
      const nb = Number(b.match(/slide(\d+)\.xml/)[1]);
      return na - nb;
    });

  const sections = [];
  for (const file of slideFiles) {
    const xml = await zip.file(file).async("string");
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((m) =>
        m[1]
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim()
      )
      .filter(Boolean);
    if (!texts.length) continue;
    sections.push({
      heading: texts[0],
      paragraphs: texts.slice(1).map((t) => `• ${t}`),
    });
  }

  const plainText = sections
    .map((s) => `${s.heading}\n${s.paragraphs.join("\n")}`)
    .join("\n\n");

  return { sections, plainText };
}

/**
 * Convert an uploaded module into a structured webpage lesson.
 * @returns {Promise<{title:string, html:string, plainText:string, sections:Array, notes:string[]}>}
 */
export async function convertDocument({ buffer, fileName, mimeType }) {
  const ext = path.extname(fileName || "").toLowerCase();
  const notes = [];
  let html = "";
  let plainText = "";
  let sections = [];

  if (ext === ".pdf" || mimeType === "application/pdf") {
    plainText = await extractPdf(buffer);
    if (plainText.replace(/\s/g, "").length < 100) {
      notes.push(
        "The PDF contained very little machine-readable text. It may be a scanned document; OCR is not enabled on this server."
      );
    }
    sections = plainTextToSections(plainText);
    html = sectionsToHtml(sections);
  } else if (
    ext === ".docx" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const result = await extractDocx(buffer);
    html = `<section class="lesson-section">${result.html}</section>`;
    plainText = result.plainText;
    notes.push(...result.notes.slice(0, 3));
    sections = plainTextToSections(plainText);
  } else if (
    ext === ".pptx" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    const result = await extractPptx(buffer);
    sections = result.sections;
    plainText = result.plainText;
    html = sectionsToHtml(
      sections.map((s) => ({
        heading: s.heading,
        paragraphs: s.paragraphs.map((p) => p.replace(/^•\s*/, "")),
      }))
    );
  } else if (ext === ".xlsx") {
    const result = extractXlsx(buffer);
    sections = result.sections;
    plainText = result.plainText;
    html = result.html;
  } else if (ext === ".html" || ext === ".htm") {
    html = sanitizeLessonHtml(buffer.toString("utf8"));
    plainText = stripHtml(html);
    sections = plainTextToSections(plainText);
  } else if ([".txt", ".md", ".markdown"].includes(ext) || mimeType === "text/plain") {
    plainText = buffer.toString("utf8");
    sections = plainTextToSections(plainText);
    html = sectionsToHtml(sections);
  } else {
    throw new Error(
      `Unsupported file type${ext ? ` (${ext})` : ""}. Upload PDF, DOCX, PPTX, TXT, Markdown, or HTML.`
    );
  }

  if (!plainText.trim()) {
    throw new Error(
      "No readable text was found in this file. If it is a scanned PDF, OCR must be enabled before it can be converted."
    );
  }

  if (!html.trim()) html = sectionsToHtml(sections);

  const firstHeading =
    sections.find((s) => s.heading)?.heading ||
    path.basename(fileName || "Lesson", path.extname(fileName || ""));

  return {
    title: firstHeading.slice(0, 140),
    html,
    plainText,
    sections,
    notes,
  };
}

export { SUPPORTED };
