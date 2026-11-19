import crypto from "crypto";

/*
 * Question generation.
 *
 * Two engines are supported:
 *  - "llm": uses any OpenAI-compatible chat completion endpoint when
 *    LLM_API_KEY / LLM_BASE_URL are configured.
 *  - "local": a deterministic extractive NLP generator that needs no API key.
 *    It builds cloze and true/false questions from key terms and sentences.
 *
 * Every generated question is returned as a draft. The caller stores it as
 * PENDING so an instructor must review and approve it before it can be used
 * in a knowledge check.
 */

const STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both but by can cannot could did do does doing down during each else few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves`.split(
    /\s+/
  )
);

const MIN_TERM_LENGTH = 6;

function stripHtml(value = "") {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text) {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(
      (s) =>
        s.length >= 55 &&
        s.length <= 320 &&
        s.split(" ").length >= 8 &&
        /[a-z]/.test(s) &&
        !/^(figure|table|source|references?)\b/i.test(s)
    );
}

function collectTerms(text) {
  const counts = new Map();
  const display = new Map();
  const bump = (raw) => {
    const term = raw.replace(/[^A-Za-z0-9\- ]/g, "").trim();
    if (term.length < MIN_TERM_LENGTH) return;
    const key = term.toLowerCase();
    if (STOPWORDS.has(key)) return;
    if (/^\d+$/.test(term)) return;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!display.has(key)) display.set(key, term);
  };

  // Acronyms (OSI, TCP, MFA...) and capitalised multi-word phrases.
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]{1,6}\b/g)) bump(m[0]);
  for (const m of text.matchAll(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2}\b/g))
    bump(m[0]);
  // Recurring domain words.
  for (const m of text.matchAll(/\b[a-zA-Z]{6,}\b/g)) {
    const word = m[0];
    if (!STOPWORDS.has(word.toLowerCase())) bump(word);
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({
      key,
      term: display.get(key),
      count,
      weight: count + (/\s/.test(display.get(key)) ? 1 : 0),
    }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sentenceHasTerm(sentence, term) {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(sentence);
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function uniqueTerms(terms) {
  const seen = new Set();
  return terms.filter((t) => {
    const key = t.key;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function localGenerate(text, count) {
  const clean = stripHtml(text);
  const sentences = splitSentences(clean);
  const terms = uniqueTerms(collectTerms(clean)).filter((t) => t.count >= 2);

  if (terms.length < 4 || sentences.length < 2) {
    return {
      questions: [],
      reason:
        "The module does not contain enough distinct concepts to build a reliable question bank. Add more text or use manual questions.",
      engine: "local",
    };
  }

  // Prefer recurring terms, but fall back to all detected terms.
  let pool = terms;
  if (pool.length < 6) {
    pool = uniqueTerms(collectTerms(clean));
  }

  const candidates = [];
  const seenPrompts = new Set();
  const push = (question) => {
    const key = question.prompt.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (seenPrompts.has(key)) return;
    seenPrompts.add(key);
    candidates.push(question);
  };

  for (const sentence of shuffle(sentences)) {
    const sentenceTerms = pool
      .filter((t) => sentenceHasTerm(sentence, t.term))
      .slice(0, 3);
    if (!sentenceTerms.length) continue;

    // True statement.
    push({
      type: "true_false",
      prompt: `True or False: ${sentence}`,
      explanation: `The module states: “${sentence}”`,
      difficulty: "easy",
      sourceRef: "Module text",
      options: [
        { text: "True", isCorrect: true },
        { text: "False", isCorrect: false },
      ],
    });

    for (const target of sentenceTerms) {
      const distractors = pool
        .filter(
          (t) =>
            t.key !== target.key &&
            !sentenceHasTerm(sentence, t.term)
        )
        .slice(0, 4);

      // Cloze / term-completion question.
      if (distractors.length >= 3) {
        const blanked = sentence.replace(
          new RegExp(`\\b${escapeRegExp(target.term)}\\b`, "i"),
          "________"
        );
        const options = shuffle([
          { text: target.term, isCorrect: true },
          ...distractors.slice(0, 3).map((t) => ({ text: t.term, isCorrect: false })),
        ]);
        push({
          type: "mcq",
          prompt: `Which term correctly completes this statement from the module?\n\n“${blanked}”`,
          explanation: `The module states: “${sentence}”`,
          difficulty: "medium",
          sourceRef: "Module text",
          options,
        });
      }

      // False statement built by swapping a term.
      const swap = pool.find(
        (t) =>
          t.key !== target.key &&
          !sentenceHasTerm(sentence, t.term) &&
          sentenceHasTerm(sentence, target.term)
      );
      if (swap) {
        const altered = sentence.replace(
          new RegExp(`\\b${escapeRegExp(target.term)}\\b`, "i"),
          swap.term
        );
        push({
          type: "true_false",
          prompt: `True or False: ${altered}`,
          explanation: `This is false. The module states: “${sentence}”`,
          difficulty: "medium",
          sourceRef: "Module text",
          options: [
            { text: "True", isCorrect: false },
            { text: "False", isCorrect: true },
          ],
        });
      }
    }
  }

  const selected = shuffle(candidates).slice(0, count);
  return {
    questions: selected,
    engine: "local",
    reason:
      selected.length < count
        ? `Only ${selected.length} distinct questions could be derived from this module.`
        : null,
  };
}

async function llmGenerate(text, count) {
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.LLM_MODEL;
  if (!apiKey || !model) return null;

  const prompt = `You are an instructional designer. Create ${count} multiple-choice questions and true/false questions from the lesson text below.
Rules:
- Only use facts explicitly stated in the text.
- Every question needs exactly one correct answer.
- Multiple choice: exactly 4 options.
- True/false: options must be "True" and "False".
- Include a short explanation.
- Return strict JSON: {"questions":[{"type":"mcq|true_false","prompt":"...","explanation":"...","difficulty":"easy|medium|hard","options":[{"text":"...","isCorrect":true}]}]}

LESSON TEXT:
${text.slice(0, 12000)}`;

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`LLM request failed (${response.status})`);
  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content || "";
  const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(jsonText);
  const questions = Array.isArray(parsed) ? parsed : parsed.questions;
  if (!Array.isArray(questions)) throw new Error("LLM returned no questions");

  return questions
    .filter(
      (q) =>
        q &&
        typeof q.prompt === "string" &&
        Array.isArray(q.options) &&
        q.options.length >= 2 &&
        q.options.filter((o) => o.isCorrect).length === 1
    )
    .slice(0, count)
    .map((q) => ({
      type: q.type === "true_false" ? "true_false" : "mcq",
      prompt: q.prompt.trim(),
      explanation: String(q.explanation || "").trim(),
      difficulty: ["easy", "medium", "hard"].includes(q.difficulty)
        ? q.difficulty
        : "medium",
      sourceRef: "Module text (LLM)",
      options: q.options.map((o) => ({
        text: String(o.text).trim(),
        isCorrect: Boolean(o.isCorrect),
      })),
    }));
}

export async function generateQuestions({ text, count = 25 } = {}) {
  const wanted = Math.max(1, Math.min(50, Number(count) || 25));
  const clean = stripHtml(text);
  if (clean.length < 250) {
    return {
      questions: [],
      engine: "none",
      reason:
        "The module text is too short to generate a meaningful question bank. Upload a longer module or write questions manually.",
    };
  }

  try {
    const llm = await llmGenerate(clean, wanted);
    if (llm && llm.length) {
      return { questions: llm, engine: "llm", reason: null };
    }
  } catch (error) {
    console.warn("LLM question generation unavailable, using local engine:", error.message);
  }

  return localGenerate(clean, wanted);
}

export { stripHtml, splitSentences, collectTerms };
