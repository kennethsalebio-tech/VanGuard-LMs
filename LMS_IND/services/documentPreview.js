import path from "path";
import mammoth from "mammoth";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { sanitizeLessonHtml } from "./documentConverter.js";

const SLIDE_CANVAS_WIDTH = 960;

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeXmlText(value = "") {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function xmlAttribute(source = "", name) {
  const match = String(source).match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : null;
}

function stripSpaces(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function imageMime(fileName = "") {
  return {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
  }[path.extname(fileName).toLowerCase()] || null;
}

async function previewDocx(buffer, warnings) {
  const result = await mammoth.convertToHtml({ buffer });
  for (const message of (result.messages || []).slice(0, 4)) {
    if (message?.message) warnings.push(message.message);
  }
  return {
    kind: "html",
    html: sanitizeLessonHtml(result.value || ""),
  };
}

/* --------------------------------------------------------------- spreadsheets */

function previewXlsx(buffer) {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    cellNF: false,
    cellText: true,
  });
  const notes = [];
  const maxRows = 1000;
  const maxCols = 60;
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const range = sheet?.["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null;
    if (!range) {
      return { name, rows: [], truncated: false, totalRows: 0, totalColumns: 0 };
    }
    const totalRows = range.e.r - range.s.r + 1;
    const totalColumns = range.e.c - range.s.c + 1;
    const rowCount = Math.min(totalRows, maxRows);
    const columnCount = Math.min(totalColumns, maxCols);
    const rows = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row = [];
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const cell = sheet[
          XLSX.utils.encode_cell({
            r: range.s.r + rowIndex,
            c: range.s.c + columnIndex,
          })
        ];
        row.push(cell ? XLSX.utils.format_cell(cell) : "");
      }
      rows.push(row);
    }
    if (totalRows > maxRows || totalColumns > maxCols) {
      notes.push(
        `The “${name}” sheet shows the first ${rowCount} rows and ${columnCount} columns. Download the file to see every cell.`
      );
    }
    return {
      name,
      rows,
      truncated: totalRows > maxRows || totalColumns > maxCols,
      totalRows,
      totalColumns,
    };
  });
  return { kind: "sheets", sheets, warnings: notes };
}

/* ------------------------------------------------------------------ pptx */

function canvasFactor(slideWidth, slideHeight) {
  return {
    width: SLIDE_CANVAS_WIDTH,
    height: Math.round((SLIDE_CANVAS_WIDTH * slideHeight) / slideWidth),
    position: SLIDE_CANVAS_WIDTH / slideWidth,
    font: SLIDE_CANVAS_WIDTH / ((slideWidth / 914400) * 72),
  };
}

function shapePosition(block, factor, fallbackY = 48) {
  const xfrm = block.match(/<a:xfrm\b[\s\S]*?<\/a:xfrm>/);
  const source = xfrm ? xfrm[0] : block;
  const offset = source.match(/<a:off\b([^>]*)\/?>/);
  const extent = source.match(/<a:ext\b([^>]*)\/?>/);
  const x = Number(xmlAttribute(offset?.[1], "x"));
  const y = Number(xmlAttribute(offset?.[1], "y"));
  const cx = Number(xmlAttribute(extent?.[1], "cx"));
  const cy = Number(xmlAttribute(extent?.[1], "cy"));
  if ([x, y, cx, cy].every(Number.isFinite) && cx > 0 && cy > 0) {
    return {
      positioned: true,
      left: Math.round(x * factor.position),
      top: Math.round(y * factor.position),
      width: Math.max(18, Math.round(cx * factor.position)),
      height: Math.max(18, Math.round(cy * factor.position)),
      fallbackY,
    };
  }
  return {
    positioned: false,
    left: Math.round(48 * factor.position),
    top: Math.round(fallbackY * factor.position),
    width: Math.round((SLIDE_CANVAS_WIDTH - 96) * 0.94),
    height: 70,
    fallbackY,
  };
}

function renderTextRuns(paragraph, factor) {
  const runs = [...paragraph.matchAll(/<a:r\b[^>]*>([\s\S]*?)<\/a:r>/g)];
  const parts = [];
  const addRun = (runXml, text, runProperties) => {
    if (!text) return;
    const styles = [];
    if (/\bb="(1|true)"/i.test(runProperties)) styles.push("font-weight:700");
    if (/\bi="(1|true)"/i.test(runProperties)) styles.push("font-style:italic");
    if (/\bu="(sng|dbl|heavy|dotted|dash)"/i.test(runProperties)) {
      styles.push("text-decoration:underline");
    }
    const size = Number(xmlAttribute(runProperties, "sz"));
    if (Number.isFinite(size) && size > 0) {
      styles.push(`font-size:${Math.max(8, (size / 100) * factor.font).toFixed(1)}px`);
    }
    const color = runProperties.match(/<a:srgbClr\b[^>]*val="([0-9a-f]{6})"/i);
    if (color) styles.push(`color:#${color[1]}`);
    const typeface = runProperties.match(/<a:latin\b[^>]*typeface="([^"]+)"/i);
    if (typeface) styles.push(`font-family:${escapeHtml(typeface[1])}`);
    parts.push(
      `<span${styles.length ? ` style="${styles.join(";")}"` : ""}>${escapeHtml(
        decodeXmlText(text)
      ).replace(/\n/g, "<br>")}</span>`
    );
  };

  for (const run of runs) {
    const runXml = run[1];
    const runProperties = runXml.match(/<a:rPr\b[^>]*>/)?.[0] || "";
    const text = [...runXml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
      .map((match) => match[1])
      .join("");
    addRun(runXml, text, runProperties);
  }

  if (!parts.length) {
    const text = [...paragraph.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
      .map((match) => match[1])
      .join("");
    if (text) addRun("", text, paragraph.match(/<a:rPr\b[^>]*>/)?.[0] || "");
  }
  return parts.join("").replace(/<a:br\b[^>]*\/>/g, "<br>");
}

function renderShapeText(block, factor) {
  const paragraphs = [...block.matchAll(/<a:p\b([^>]*)>([\s\S]*?)<\/a:p>/g)];
  if (!paragraphs.length) return "";
  const html = paragraphs
    .map((match) => {
      const paragraphXml = match[0];
      const paragraphProperties =
        paragraphXml.match(/<a:pPr\b[^>]*>/)?.[0] || "";
      const runs = renderTextRuns(paragraphXml, factor);
      if (!runs) return "";
      const level = Math.max(0, Number(xmlAttribute(paragraphProperties, "lvl")) || 0);
      const isBullet =
        level > 0 ||
        /<a:bu(Char|AutoNum)\b/.test(paragraphXml) ||
        /<a:pPr\b[^>]*\bbullet="1"/i.test(paragraphProperties);
      const align = xmlAttribute(paragraphProperties, "algn");
      const alignment =
        align === "ctr"
          ? "center"
          : align === "r"
            ? "right"
            : align === "just"
              ? "justify"
              : "left";
      return `<p style="margin:0 0 .35em;text-align:${alignment};padding-left:${
        isBullet ? 22 + level * 18 : 0
      }px;${
        isBullet
          ? "position:relative"
          : ""
      }">${
        isBullet
          ? `<span style="position:absolute;left:${6 + level * 18}px;top:0">•</span>`
          : ""
      }${runs}</p>`;
    })
    .join("");
  return html;
}

function renderSlideTable(block, factor, position) {
  const table = block.match(/<a:tbl\b[\s\S]*?<\/a:tbl>/)?.[0];
  if (!table) return "";
  const rows = [...table.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)];
  const htmlRows = rows
    .map((row, rowIndex) => {
      const cells = [...row[1].matchAll(/<a:tc\b([^>]*)>([\s\S]*?)<\/a:tc>/g)];
      return `<tr>${cells
        .map((cell) => {
          const text = [...cell[2].matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
            .map((paragraph) => {
              return [...paragraph[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
                .map((match) => escapeHtml(decodeXmlText(match[1])))
                .join("");
            })
            .filter(Boolean)
            .join("<br>");
          const columnSpan = Number(xmlAttribute(cell[1], "gridSpan")) || 1;
          const rowSpan = Number(xmlAttribute(cell[1], "rowSpan")) || 1;
          return `<t${rowIndex === 0 ? "h" : "d"}${
            columnSpan > 1 ? ` colspan="${Math.min(columnSpan, 30)}"` : ""
          }${rowSpan > 1 ? ` rowspan="${Math.min(rowSpan, 30)}"` : ""}>${text}</t${
            rowIndex === 0 ? "h" : "d"
          }>`;
        })
        .join("")}</tr>`;
    })
    .join("");
  return `<table class="pptx-table" style="left:${position.left}px;top:${position.top}px;width:${position.width}px">${htmlRows}</table>`;
}

async function pptxImageData(zip, slidePath, target) {
  const normalTarget = path.posix.normalize(path.posix.join(path.posix.dirname(slidePath), target));
  const media = zip.file(normalTarget);
  if (!media) return null;
  const mime = imageMime(normalTarget);
  if (!mime) return null;
  const data = await media.async("base64");
  return `data:${mime};base64,${data}`;
}

async function previewPptx(buffer, warnings) {
  const zip = await JSZip.loadAsync(buffer);
  const presentationFile = zip.file("ppt/presentation.xml");
  if (!presentationFile) throw new Error("This presentation has no readable slides.");
  const presentation = await presentationFile.async("string");
  const sizeMatch = presentation.match(/<p:sldSz\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
  const slideWidth = Number(sizeMatch?.[1]) || 12192000;
  const slideHeight = Number(sizeMatch?.[2]) || 6858000;
  const factor = canvasFactor(slideWidth, slideHeight);

  const presentationRelsFile = zip.file("ppt/_rels/presentation.xml.rels");
  const presentationRels = presentationRelsFile
    ? await presentationRelsFile.async("string")
    : "";
  const relTargets = new Map();
  for (const relationship of presentationRels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = xmlAttribute(relationship[1], "Id");
    const target = xmlAttribute(relationship[1], "Target");
    if (id && target) relTargets.set(id, path.posix.normalize(`ppt/${target}`));
  }

  const ordered = [...presentation.matchAll(/<p:sldId\b([^>]*)\/?>/g)]
    .map((match) => relTargets.get(xmlAttribute(match[1], "r:id")))
    .filter(Boolean);
  const fallback = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  const slidePaths = ordered.length ? ordered : fallback;

  const slides = [];
  for (let index = 0; index < slidePaths.length; index += 1) {
    const slidePath = slidePaths[index];
    const slideFile = zip.file(slidePath);
    if (!slideFile) continue;
    const xml = await slideFile.async("string");
    const relFile = zip.file(
      path.posix.join(path.posix.dirname(slidePath), "_rels", `${path.posix.basename(slidePath)}.rels`)
    );
    const relXml = relFile ? await relFile.async("string") : "";
    const imageRelations = new Map();
    for (const relationship of relXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = xmlAttribute(relationship[1], "Id");
      const target = xmlAttribute(relationship[1], "Target");
      if (id && target) {
        imageRelations.set(id, target);
      }
    }

    let background = "#ffffff";
    const bg = xml.match(/<p:bg\b[\s\S]*?<\/p:bg>/);
    if (bg) {
      const color = bg[0].match(/<a:srgbClr\b[^>]*val="([0-9a-f]{6})"/i);
      if (color) background = `#${color[1]}`;
    }

    const blocks = [];
    let fallbackY = 48;
    const shapeRegex = /<(p:sp|p:pic|p:graphicFrame)\b[^>]*>[\s\S]*?<\/\1>/g;
    for (const match of xml.matchAll(shapeRegex)) {
      const block = match[0];
      const type = match[1];
      const position = shapePosition(block, factor, fallbackY);
      fallbackY = position.top + Math.min(position.height, 90) + 18;
      const style = `left:${position.left}px;top:${position.top}px;width:${position.width}px;${
        position.positioned ? `height:${position.height}px;` : ""
      }`;

      if (type === "p:pic") {
        const embed = xmlAttribute(block.match(/<a:blip\b[^>]*>/)?.[0], "r:embed");
        const target = imageRelations.get(embed);
        if (target) {
          const dataUri = await pptxImageData(zip, slidePath, target);
          const alt = xmlAttribute(block.match(/<p:cNvPr\b[^>]*>/)?.[0], "descr") || "Slide image";
          if (dataUri) {
            blocks.push(
              `<div class="pptx-shape" style="${style}"><img src="${dataUri}" alt="${escapeHtml(
                decodeXmlText(alt)
              )}" style="width:100%;height:100%;object-fit:contain" /></div>`
            );
          } else {
            warnings.push(`Slide ${index + 1} contains an image format the browser cannot preview.`);
          }
        }
      } else if (type === "p:graphicFrame") {
        if (/<a:tbl\b/.test(block)) {
          blocks.push(renderSlideTable(block, factor, position));
        } else if (/<c:chart\b/.test(block)) {
          const title = [...block.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
            .map((m) => stripSpaces(decodeXmlText(m[1])))
            .filter(Boolean)
            .join(" ");
          blocks.push(
            `<div class="pptx-chart" style="${style}"><span>Chart</span>${
              title ? `<strong>${escapeHtml(title)}</strong>` : ""
            }<small>Open the original file to view the chart data.</small></div>`
          );
        }
      } else {
        const text = renderShapeText(block, factor);
        if (text) {
          blocks.push(`<div class="pptx-shape" style="${style}">${text}</div>`);
        }
      }
    }

    slides.push({
      number: index + 1,
      background,
      html: blocks.join(""),
    });
  }

  if (!slides.length) throw new Error("No readable slides were found in this presentation.");
  return { kind: "slides", slides, width: factor.width, height: factor.height, warnings };
}

/* ---------------------------------------------------------------- dispatch */

export async function buildDocumentPreview({
  filePath,
  fileName,
  mimeType,
  buffer,
  fileUrl,
  downloadUrl,
}) {
  const ext = path.extname(fileName || "").toLowerCase();
  const warnings = [];
  const bytes = buffer || (await import("fs/promises")).readFile(filePath);
  const data = Buffer.isBuffer(bytes) ? bytes : await bytes;

  if (ext === ".pdf") {
    return {
      kind: "pdf",
      fileName,
      mimeType: "application/pdf",
      fileUrl,
      downloadUrl: downloadUrl || fileUrl,
      warnings,
    };
  }

  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
    return {
      kind: "image",
      fileName,
      mimeType: mimeType || imageMime(fileName) || "application/octet-stream",
      fileUrl,
      downloadUrl: downloadUrl || fileUrl,
      warnings,
    };
  }

  let result;
  if (ext === ".docx") {
    result = await previewDocx(data, warnings);
  } else if (ext === ".pptx") {
    result = await previewPptx(data, warnings);
  } else if (ext === ".xlsx") {
    result = previewXlsx(data);
  } else if ([".html", ".htm"].includes(ext)) {
    result = {
      kind: "html",
      html: sanitizeLessonHtml(data.toString("utf8")),
    };
  } else if ([".txt", ".md", ".markdown"].includes(ext) || mimeType?.startsWith("text/")) {
    result = { kind: "text", text: data.toString("utf8") };
  } else {
    throw new Error("This file type cannot be previewed.");
  }

  return {
    ...result,
    fileName,
    mimeType: mimeType || null,
    warnings: [...warnings, ...(result.warnings || [])].filter(Boolean),
  };
}
