// PDF を読んで「ページ内の行と語（x 座標つき）」にする。
// Python 版（_tools/pdfutil.py）と同じ考え方で、列は x の範囲、行は y のまとまりで見る。
import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

// 全角英数記号→半角、全角空白→半角、連続空白→1つ（Python の z2h と同じ）
export function z2h(s) {
  if (!s) return '';
  let out = '';
  for (const ch of s) {
    const o = ch.codePointAt(0);
    if (o >= 0xFF01 && o <= 0xFF5E) out += String.fromCodePoint(o - 0xFEE0);
    else if (ch === '　' || ch === ' ') out += ' ';
    else out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export const NUM = /^[0-9,]+(?:\.[0-9]+)?$/;

export function toNum(s) {
  if (s == null) return null;
  s = String(s).trim().replace(/,/g, '');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return parseFloat(s);
}

// 語を y でまとめて [{y, ws:[[x0,x1,text],...]}] にする
export function pageLines(words) {
  const rows = new Map();
  for (const w of words) {
    const key = Math.round(w.y0 * 2) / 2;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push([w.x0, w.x1, w.text, w.yb]);
  }
  const keys = [...rows.keys()].sort((a, b) => a - b);
  const merged = [];
  for (const y of keys) {
    const ws = rows.get(y).sort((a, b) => a[0] - b[0]);
    if (merged.length && y - merged[merged.length - 1].y <= 1.2) {
      const m = merged[merged.length - 1];
      m.ws.push(...ws);
      m.ws.sort((a, b) => a[0] - b[0]);
    } else {
      merged.push({ y, yb: ws[0][3], ws: [...ws] });
    }
  }
  // pdf.js は「土|木|一般|世話役」のように字送りごとに断片を返すことがあるので、
  // 隣とほぼ隙間なく続く断片は1語につなぐ（PyMuPDF の words に寄せる）
  for (const m of merged) {
    const out = [];
    for (const w of m.ws) {
      const p = out[out.length - 1];
      if (p && w[0] - p[1] <= 1.5 && w[0] >= p[0]) { p[1] = Math.max(p[1], w[1]); p[2] += w[2]; }
      else out.push([w[0], w[1], w[2]]);
    }
    m.ws = out;
  }
  return merged;
}

export function join(ws, lo = null, hi = null) {
  const sel = [];
  for (const [x0, , t] of ws) {
    if ((lo === null || x0 >= lo) && (hi === null || x0 < hi)) sel.push(t);
  }
  return z2h(sel.join(' '));
}

// pdf.js の text item を「語」に割る。1 item に空白区切りで複数語が入っていたら
// 幅を文字数で按分して x を推定する（PyMuPDF の words に寄せる）。
function itemsToWords(items, height) {
  const words = [];
  for (const it of items) {
    const str = it.str || '';
    if (!str.trim()) continue;
    const x = it.transform[4];
    const yBase = it.transform[5];
    const h = it.height || 10;
    const y0 = height - yBase - h * 0.8;   // だいたい文字の上端
    const width = it.width || (str.length * h * 0.5);
    // 半角空白だけで区切る（全角空白入りの見出しは PyMuPDF と同じく1語のまま）
    const re = /[^ \t\r\n]+/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      const start = m.index, end = m.index + m[0].length;
      const x0 = x + width * (start / str.length);
      const x1 = x + width * (end / str.length);
      words.push({ x0, x1, y0, text: m[0], yb: yBase });   // yb: PDF座標のベースライン（書き込み用）
    }
  }
  words.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
  return words;
}

// ArrayBuffer -> {pages:[{height, words, lines, text}]}
export async function loadPdf(buf) {
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const words = itemsToWords(tc.items, vp.height);
    const lines = pageLines(words);
    const text = lines.map(l => l.ws.map(w => w[2]).join(' ')).join('\n');
    pages.push({ height: vp.height, words, lines, text, textZ: z2h(text) });
  }
  const nchars = pages.reduce((s, pg) => s + pg.text.replace(/\s/g, '').length, 0);
  return { pages, numPages: doc.numPages, nchars };
}
