// Tiny, safe markdown renderer (escapes HTML first, then applies a few patterns).

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function md(src) {
  if (!src) return "";
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
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
  return html;
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
