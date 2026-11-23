const BLOCKING_CONTAINERS = new Set([
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "pre",
  "code",
  "ul",
  "ol",
  "li",
  "blockquote",
  "figure",
  "figcaption",
]);

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const NAMED_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeEntities(value = "") {
  return String(value).replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/gi,
    (match, decimal, hexadecimal, named) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hexadecimal) return String.fromCodePoint(parseInt(hexadecimal, 16));
      return NAMED_ENTITIES[named.toLowerCase()] ?? match;
    }
  );
}

function textOnly(value = "") {
  return decodeEntities(String(value).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function hasVisibleContent(html = "") {
  return (
    /<(?:img|table|pre|ul|ol|figure|video|audio)\b/i.test(html) ||
    textOnly(html).length > 0
  );
}

function unwrapDocumentSection(html) {
  const source = String(html || "").trim();
  const opening = source.match(/^<section\b[^>]*>/i);
  if (opening && /<\/section>\s*$/i.test(source)) {
    return source.slice(opening[0].length, source.lastIndexOf("</section>"));
  }
  return source;
}

/**
 * Finds heading elements that are direct document-level sections. Heading
 * styles inside tables, lists, code samples, quotes, or figures must stay part
 * of their surrounding content rather than starting a new lesson.
 */
function findTopLevelHeadings(html) {
  const headings = [];
  let containerDepth = 0;
  const tagPattern = /<(\/?)\s*([a-z][a-z0-9:-]*)\b([^>]*)>/gi;
  let match;

  while ((match = tagPattern.exec(html))) {
    const closing = Boolean(match[1]);
    const tagName = String(match[2]).toLowerCase();
    const selfClosing = /\/\s*$/.test(match[3] || "") || VOID_ELEMENTS.has(tagName);

    if (/^h[1-6]$/.test(tagName)) {
      if (closing || containerDepth > 0) continue;

      const level = Number(tagName.slice(1));
      const contentStart = tagPattern.lastIndex;
      const closingPattern = new RegExp(`</${tagName}\\s*>`, "gi");
      closingPattern.lastIndex = contentStart;
      const closingMatch = closingPattern.exec(html);
      if (!closingMatch) continue;

      headings.push({
        level,
        start: match.index,
        contentStart,
        contentEnd: closingMatch.index,
        end: closingPattern.lastIndex,
      });
      tagPattern.lastIndex = closingPattern.lastIndex;
      continue;
    }

    if (!BLOCKING_CONTAINERS.has(tagName)) continue;
    if (closing) {
      if (containerDepth > 0) containerDepth -= 1;
    } else if (!selfClosing) {
      containerDepth += 1;
    }
  }

  return headings;
}

function sectionHtml(body) {
  return `<section class="lesson-section">${body.trim()}</section>`;
}

/**
 * Split converted DOCX HTML at its shallowest heading level. All content
 * between one main heading and the next becomes that lesson's body, including
 * nested headings, lists, tables, images, and formatted code blocks.
 *
 * @param {string} html Sanitized/converted DOCX HTML.
 * @param {{ fallbackTitle?: string }} [options]
 * @returns {Array<{title:string, html:string, plainText:string, level:number}>}
 */
export function splitDocumentIntoHeadings(html, { fallbackTitle = "" } = {}) {
  const source = unwrapDocumentSection(html);
  const headings = findTopLevelHeadings(source);
  if (!headings.length) return [];

  const mainLevel = Math.min(...headings.map((heading) => heading.level));
  const mainHeadings = headings.filter((heading) => heading.level === mainLevel);
  if (!mainHeadings.length) return [];

  const sections = [];
  for (let index = 0; index < mainHeadings.length; index += 1) {
    const heading = mainHeadings[index];
    const next = mainHeadings[index + 1];
    let body = source.slice(heading.end, next ? next.start : source.length);

    // Text before the first main heading is part of the opening section, not
    // a separate untitled lesson. This preserves covers, metadata, and intros.
    if (index === 0) {
      const preamble = source.slice(0, heading.start);
      if (hasVisibleContent(preamble)) body = `${preamble}${body}`;
    }

    const title =
      textOnly(source.slice(heading.contentStart, heading.contentEnd)).slice(0, 160) ||
      String(fallbackTitle || "").trim().slice(0, 160) ||
      `Section ${index + 1}`;
    const lessonHtml = sectionHtml(body);
    sections.push({
      title,
      html: lessonHtml,
      plainText: textOnly(lessonHtml),
      level: heading.level,
    });
  }

  return sections;
}
