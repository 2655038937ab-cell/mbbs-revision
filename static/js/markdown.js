// Tiny, safe markdown renderer (escapes HTML first, then applies a few patterns).
// LaTeX formulas written by the AI are handed to KaTeX *before* escaping (see
// extractMath) so their backslashes and braces survive intact.

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------------- Math (KaTeX) ------------------------------------------
 * Formulas must be pulled out BEFORE the HTML escaping below: escaping would
 * turn `\frac` into `\\frac` and `<` into `&lt;`, after which KaTeX can no
 * longer parse the source. Each formula is stashed behind an inert placeholder
 * (NUL characters survive escaping untouched) and swapped back for KaTeX's HTML
 * once the markdown pass is done.
 */
const MATH_TOKEN = "\u0000MATH:";

// CJK text inside $...$ without a single LaTeX command means it is prose that
// happened to sit between two dollar signs (a price, a range), not a formula.
// KaTeX's lenient parsing would otherwise "render" it and mangle the sentence.
function looksLikeProse(tex) {
  return /[\u3400-\u9fff\uff00-\uffef]/.test(tex) && !/\\[a-zA-Z]/.test(tex);
}

function renderTex(tex, displayMode) {
  const katex = (typeof window !== "undefined") ? window.katex : null;
  if (!katex || typeof katex.renderToString !== "function") return null;
  if (looksLikeProse(tex)) return null;
  try {
    const html = katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "html",
    });
    // A parse failure comes back as a `katex-error` node. Treat that as "this
    // was not a formula": a stray pair of `$` (a price, a page range like
    // "p.$50 到 $80") then falls back to plain text instead of painting the note
    // red, and a genuinely typo'd formula still shows its own source.
    if (html.indexOf("katex-error") !== -1) return null;
    return html;
  } catch {
    return null;
  }
}

function extractMath(src) {
  const stash = [];
  const keep = (tex, displayMode) => {
    const html = renderTex(tex, displayMode);
    if (html == null) return null; // KaTeX unavailable -> leave the source text alone
    stash.push(html);
    return MATH_TOKEN + (stash.length - 1) + "\u0000";
  };
  let s = String(src == null ? "" : src);
  // Display math first, so `$$` is never eaten by the inline rule.
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => keep(tex, true) ?? m);
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => keep(tex, true) ?? m);
  // Inline math: same line only, so a lone `$` (a price, a stray symbol) cannot
  // swallow the rest of the paragraph.
  s = s.replace(/\$([^$\n]+?)\$/g, (m, tex) => keep(tex, false) ?? m);
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => keep(tex, false) ?? m);
  return { text: s, math: stash };
}

function restoreMath(html, math) {
  if (!math || !math.length) return html;
  return html.replace(/\u0000MATH:(\d+)\u0000/g, (m, i) => math[Number(i)] ?? m);
}

function inline(text) {
  return text
    .replace(/==([^=\n]+)==/g, '<mark class="hl">$1</mark>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function md(src) {
  if (!src) return "";
  const { text: source, math } = extractMath(src);
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let listType = null; // 'ul' | 'ol' | null
  let inPara = false;

  const closeList = () => {
    if (listType) { html += `</${listType}>`; listType = null; }
  };
  const closePara = () => {
    if (inPara) { html += "</p>"; inPara = false; }
  };

  for (const raw of lines) {
    const line = escapeHtml(raw);
    const trimmed = raw.trim();

    if (!trimmed) {
      closePara(); closeList();
      continue;
    }

    // A display formula standing alone on its line gets no <p> wrapper, so the
    // KaTeX block keeps its own centering and horizontal scroll.
    if (trimmed.indexOf(MATH_TOKEN) === 0) {
      const leftovers = trimmed.replace(/\u0000MATH:\d+\u0000/g, "").trim();
      if (!leftovers) { closePara(); closeList(); html += trimmed; continue; }
    }

    // fenced code is handled by caller (we split blocks before)
    if (/^#{1,3}\s+/.test(trimmed)) {
      closePara(); closeList();
      const level = trimmed.match(/^#+/)[0].length;
      const tag = level === 1 ? "h3" : level === 2 ? "h4" : "h5";
      html += `<${tag}>${inline(line.replace(/^#{1,3}\s+/, ""))}</${tag}>`;
      continue;
    }

    const ulMatch = trimmed.match(/^[-*•]\s+(.*)/);
    const olMatch = trimmed.match(/^\d+[.)]\s+(.*)/);
    if (ulMatch || olMatch) {
      closePara();
      const want = ulMatch ? "ul" : "ol";
      if (listType !== want) { closeList(); html += `<${want}>`; listType = want; }
      const content = ulMatch ? ulMatch[1] : olMatch[1];
      html += `<li>${inline(content)}</li>`;
      continue;
    }

    closeList();
    if (!inPara) { html += "<p>"; inPara = true; }
    else html += "<br>";
    html += inline(line);
  }
  closePara(); closeList();
  return restoreMath(html, math);
}

// Inline-only rendering: math + bold/italic/code, with no <p>/<ul> wrappers.
// Used where a block layout would break the surrounding markup — quiz option
// buttons, answer recap lines, chips, titles.
export function mdInline(src) {
  if (src == null || src === "") return "";
  const { text, math } = extractMath(src);
  return restoreMath(inline(escapeHtml(text)), math);
}

// Split text into fenced code blocks + prose for rendering.
export function mdFull(src) {
  if (!src) return "";
  const parts = String(src).split(/(```[\s\S]*?```)/g);
  return parts
    .map((part) => {
      if (part.startsWith("```")) {
        const code = part.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "");
        return `<pre><code>${escapeHtml(code)}</code></pre>`;
      }
      return md(part);
    })
    .join("");
}
