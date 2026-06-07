const URL_OR_EMAIL_RE =
  /\b(?:(?:https?:\/\/|mailto:|www\.)[^\s<>"']+|[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+)/gi;
const TRAILING_PUNCT_RE = /[.,;:!?，。；：！？、）)\]}]+$/;
const NUMERIC_TLD_RE = /\.\d+$/;

export interface PdfTextLink {
  href: string;
  start: number;
  end: number;
}

export function findPdfTextLinks(text: string): PdfTextLink[] {
  const links: PdfTextLink[] = [];
  for (const m of text.matchAll(URL_OR_EMAIL_RE)) {
    const start = m.index;
    let raw = m[0] ?? "";
    if (start == null || raw.length === 0) continue;
    raw = raw.replace(TRAILING_PUNCT_RE, "");
    if (raw.length === 0) continue;

    const href = hrefForPdfTextLink(raw);
    if (!href) continue;
    links.push({ href, start, end: start + raw.length });
  }
  return links;
}

function hrefForPdfTextLink(raw: string): string | null {
  if (raw.startsWith("mailto:")) return safeUrl(raw)?.href ?? null;
  if (raw.startsWith("www.")) return safeUrl(`https://${raw}`)?.href ?? null;
  if (/^https?:\/\//i.test(raw)) return safeUrl(raw)?.href ?? null;
  const domain = raw.slice(raw.indexOf("@") + 1);
  const host = safeUrl(`http://${domain}`)?.hostname;
  if (!host || NUMERIC_TLD_RE.test(host)) return null;
  return safeUrl(`mailto:${raw}`)?.href ?? null;
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}
