/*
 * Automatic badges for module/topic headers.
 *
 * The badge is derived from the topic title and id only, so it is stable across
 * edits and republishes and can never create duplicate badge records. The same
 * function feeds the instructor builder and the learner course/lesson views.
 */

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "your",
]);

const TONES = [
  "bg-sky-50 text-sky-700 ring-sky-200",
  "bg-emerald-50 text-emerald-700 ring-emerald-200",
  "bg-violet-50 text-violet-700 ring-violet-200",
  "bg-amber-50 text-amber-700 ring-amber-200",
  "bg-rose-50 text-rose-700 ring-rose-200",
  "bg-cyan-50 text-cyan-700 ring-cyan-200",
  "bg-indigo-50 text-indigo-700 ring-indigo-200",
  "bg-teal-50 text-teal-700 ring-teal-200",
];

function hash(value) {
  let result = 0;
  for (const character of String(value)) {
    result = (result * 31 + character.charCodeAt(0)) >>> 0;
  }
  return result;
}

function significantWords(title = "") {
  return String(title)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word && !STOP_WORDS.has(word.toLowerCase()));
}

function badgeLabel(title = "") {
  const words = significantWords(title);
  if (!words.length) return "TOPIC";
  if (words.length >= 2) {
    return words
      .slice(0, 3)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
  }
  return words[0].slice(0, 4).toUpperCase();
}

/**
 * @param {string} title module/topic title
 * @param {number|string} seed stable module id (falls back to the title)
 * @returns {{label: string, className: string, tone: number}}
 */
export function topicBadge(title = "", seed = "") {
  const key = `${seed || title}:${title}`;
  const tone = hash(key) % TONES.length;
  return {
    label: badgeLabel(title),
    className: TONES[tone],
    tone,
  };
}

/**
 * Attach a badge to plain module objects without mutating the originals.
 * @param {Array<object>} modules
 */
export function withTopicBadges(modules = []) {
  return modules.map((module) => ({
    ...module,
    badge: topicBadge(module.title || module.name, module.id),
  }));
}
