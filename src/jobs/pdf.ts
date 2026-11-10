// A one-font PDF from plain text (a cover letter to upload where a form wants a file). Written by
// hand so it needs no library and no browser tab: a Letter page, Helvetica 11 pt, wrapped at the
// margins, more pages when the text is long. Readable by every ATS and viewer.

const PAGE_W = 612, PAGE_H = 792, MARGIN = 72, SIZE = 11, LEADING = 15.5;
const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);
// Helvetica glyph widths (thousandths of an em) for ASCII 32–126, from the AFM file.
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const widthOf = (s: string) => [...s].reduce((a, ch) => { const c = ch.charCodeAt(0); return a + (c >= 32 && c <= 126 ? W[c - 32] : 556); }, 0) * SIZE / 1000;

// Characters outside Latin-1 become their plain lookalikes (the PDF uses WinAnsi encoding).
export function plainLatin(text: string): string {
  return String(text || "").replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/ /g, " ")
    .replace(/[•●]/g, "-").normalize("NFC").replace(/[^\u0009\u000a -~ -ÿ]/g, "?");
}

// Text → lines that fit between the margins; an empty line between paragraphs.
export function wrapText(text: string, maxWidth = PAGE_W - 2 * MARGIN): string[] {
  const lines: string[] = [];
  for (const para of plainLatin(text).replace(/\r/g, "").split("\n")) {
    if (!para.trim()) { lines.push(""); continue; }
    let line = "";
    for (const word of para.trim().split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next) <= maxWidth || !line) line = next;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const latin1 = (s: string) => Uint8Array.from(s, ch => ch.charCodeAt(0) & 0xff);

// The PDF's bytes, as a base64 string (what upload_file takes).
export function textPdf(text: string, { title = "Cover letter" } = {}): { base64: string; pages: number } {
  const lines = wrapText(text);
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, lines.length); i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalog = add(""), pagesObj = add(""), font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pageIds: number[] = [];
  for (const page of pages) {
    const content = `BT /F1 ${SIZE} Tf ${LEADING} TL ${MARGIN} ${PAGE_H - MARGIN - SIZE} Td\n${page.map(l => `(${esc(l)}) Tj T*`).join("\n")}\nET`;
    const stream = add(`<< /Length ${latin1(content).length} >>\nstream\n${content}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const info = add(`<< /Title (${esc(plainLatin(title))}) /Producer (Sidekick) >>`);
  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(latin1(out).length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = latin1(out).length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { base64: btoa(out), pages: pages.length };
}
