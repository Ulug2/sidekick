// Text extraction for PDF, Word (.docx) and plain-text files. Libraries load only when needed.

type FileLike = { type: string; name: string };
// pdf.js, loaded from public/vendor at runtime (only the parts used here).
type PdfJs = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: { data: Uint8Array }): { promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }> }> }> };
};
export type PdfTextItem = { str?: string; transform?: number[]; hasEOL?: boolean };

export const DOC_TYPES = {
  pdf: (f: FileLike) => f.type === "application/pdf" || /\.pdf$/i.test(f.name),
  docx: (f: FileLike) => f.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || /\.docx$/i.test(f.name)
};

export function isDocFile(file: FileLike): boolean {
  return DOC_TYPES.pdf(file) || DOC_TYPES.docx(file);
}

export let pdfjsPromise: Promise<PdfJs> | null = null;
export function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ||= import(/* @vite-ignore */ chrome.runtime.getURL("vendor/pdf.min.mjs")).then((pdfjs: PdfJs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");
    return pdfjs;
  });
  return pdfjsPromise;
}

type Mammoth = NonNullable<Window["mammoth"]>;
export let mammothPromise: Promise<Mammoth> | null = null;
export function loadMammoth(): Promise<Mammoth> {
  mammothPromise ||= new Promise<Mammoth>((resolve, reject) => {
    if (window.mammoth) return resolve(window.mammoth);
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("vendor/mammoth.browser.min.js");
    s.onload = () => resolve(window.mammoth!);
    s.onerror = () => reject(new Error("Couldn't load the Word reader."));
    document.head.appendChild(s);
  });
  return mammothPromise;
}

// Rebuilds readable lines from PDF text items (which come as positioned fragments).
export function pdfItemsToText(items: PdfTextItem[]): string {
  let out = "";
  let lastY = null;
  for (const it of items) {
    if (!("str" in it)) continue;
    const y = it.transform ? Math.round(it.transform[5]) : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !out.endsWith("\n")) out += "\n";
    out += it.str;
    if (it.hasEOL && !out.endsWith("\n")) out += "\n";
    else if (it.str && !/\s$/.test(it.str)) out += " ";
    lastY = y;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ");
}

export async function extractDocText(file: File, { maxChars = 100_000 } = {}): Promise<{ text: string; truncated: boolean }> {
  let text: string;
  if (DOC_TYPES.pdf(file)) {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages && pages.join("").length < maxChars; i++) {
      const page = await doc.getPage(i);
      pages.push(pdfItemsToText((await page.getTextContent()).items));
    }
    text = pages.join("\n\n");
    if (!text.trim()) throw new Error(`${file.name} has no selectable text (it may be a scanned image). Try a screenshot instead.`);
  } else if (DOC_TYPES.docx(file)) {
    const mammoth = await loadMammoth();
    text = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  } else {
    text = await file.text();
  }
  text = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
}
