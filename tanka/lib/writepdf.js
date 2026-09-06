// 当てた単価・金額を元の仕様書PDFの空欄に書き込む（pdf-lib）。_tools/write_pdf.py と同じ配置。
/* global PDFLib */
import { CREDIT } from './export.js';

const FS = 8;
// 数字の右端（元の設計書で右揃えになっている位置）
const U_PRICE_R = 385, U_AMT_R = 459, U_NOTE_X = 466;          // 内訳書
const D_QTY_R = 264, D_PRICE_R = 384, D_AMT_R = 458, D_NOTE_X = 462;   // 代価表

const fmt0 = v => Math.round(v).toLocaleString('ja-JP');
const fmt2 = v => Number(v).toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtq = v => (Math.abs(v - Math.round(v)) < 1e-9) ? fmt0(v) : Number(v).toLocaleString('ja-JP', { maximumFractionDigits: 3 });
const nkey = s => (s || '').replace(/[\s（）()【】]/g, '');
// 「令和08年07月」→「R8.07」（半角フォントで書ける形）
const ymShort = s => { const m = (s || '').match(/令和\s*(\d+)\s*年\s*(\d+)\s*月/); return m ? `R${+m[1]}.${String(+m[2]).padStart(2, '0')}` : ''; };

// 画面と同じ計算: 葉=数量×単価、親=子の合計、経費=率（同工種の平均、参考）
function computeAmounts(result) {
  const rows = result.uchiwake;
  rows.forEach(o => { o.amount = o.leaf ? ((o.qty != null && o.price != null) ? Math.round(o.qty * o.price) : null) : null; });
  for (let i = rows.length - 1; i >= 0; i--) {
    const o = rows[i]; if (o.leaf) continue;
    let s = 0, any = false;
    for (let j = i + 1; j < rows.length && rows[j].level > o.level && rows[j].section === o.section; j++) if (rows[j].level === o.level + 1 && rows[j].amount != null) { s += rows[j].amount; any = true; }
    o.amount = any ? s : null;
  }
  let direct = 0;
  rows.forEach(o => { if (o.level === 0 && o.section === '本体' && o.amount != null) direct += o.amount; });
  const ref = (result.keihi_ref || [])[0] || {};
  const k = ref.kasetsu || 0, g = ref.genkan || 0, ip = ref.ippan || 0;
  const named = new Map();
  rows.forEach(o => { if (o.section === '経費' && !named.has(nkey(o.name))) named.set(nkey(o.name), o); });
  const setv = (name, v, byRate) => { const o = named.get(nkey(name)); if (o) { o.amount = v; o.by_rate = !!byRate; } return v; };
  const rateRows = new Map();
  if (named.has('直接工事費')) {
    setv('直接工事費', direct);
    const ritsu = setv('共通仮設費(率分)', Math.round(direct * k / 100), true);
    const seki = (named.get('共通仮設費(積分)') || {}).amount || 0;
    const kei = setv('共通仮設費計', seki + ritsu);
    const jun = setv('純工事費', direct + kei);
    const genkan = setv('現場管理費', Math.round(jun * g / 100), true);
    const genka = setv('工事原価計', jun + genkan);
    const ippan = setv('一般管理費等', Math.round(genka * ip / 100), true);
    const kakaku = setv('工事価格', genka + ippan);
    const zei = setv('消費税相当額', Math.round(kakaku * 0.1));
    setv('工事費合計', kakaku + zei);
    rateRows.set('共通仮設費(率分)', k); rateRows.set('現場管理費', g); rateRows.set('一般管理費等', ip);
  }
  return { direct, rateRows };
}

// 日本語は標準フォントに無いので、canvas で描いて画像として貼る
function jpImage(text, px, color) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `${px * 2}px "Yu Gothic","Meiryo",sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 4;
  c.width = w; c.height = px * 2 + 6;
  const ctx2 = c.getContext('2d');
  ctx2.font = font; ctx2.fillStyle = color; ctx2.textBaseline = 'top';
  ctx2.fillText(text, 2, 2);
  return { data: c.toDataURL('image/png'), w: w / 2, h: (px * 2 + 6) / 2 };
}

export async function writeShiyousho(result, srcBuf) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.load(srcBuf, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const BLUE = rgb(0, 0, 0.55), GRAY = rgb(0.35, 0.35, 0.35), RED = rgb(0.75, 0, 0);
  const putRight = (page, xr, yb, text, size = FS, color = BLUE) => {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: xr - w, y: yb, size, font, color });
  };
  const putSmall = (page, x, yb, text, color = GRAY) => page.drawText(text, { x, y: yb, size: 6, font, color });
  const putJp = async (page, x, yb, text, px = 6, color = '#595959') => {
    const im = jpImage(text, px, color);
    const png = await doc.embedPng(im.data);
    page.drawImage(png, { x, y: yb - 1.5, width: im.w, height: im.h });
  };
  const info = computeAmounts(result);
  const srcLabel = s => s === '積上げ' ? 'build' : s === '過去単価' ? 'past' : s === 'ヒント積算' ? 'hint' : s === '手入力' ? 'manual' : '';

  // ---- 内訳書
  for (const o of result.uchiwake) {
    const pos = o.pos; if (!pos || pos.pno == null) continue;
    const page = pages[pos.pno];
    const yb = pos.ybVal != null ? pos.ybVal : (pos.ybUnit != null ? pos.ybUnit : pos.ybName) - 24;
    if (o.leaf) {
      if (o.price != null) putRight(page, U_PRICE_R, yb, fmt2(o.price));
      if (o.amount != null) putRight(page, U_AMT_R, yb, fmt0(o.amount));
      const note = [srcLabel(o.price_src), ymShort(o.adopt_ym), o.conf === '△' ? 'check!' : ''].filter(Boolean).join(' ');
      if (note) putSmall(page, U_NOTE_X, yb, note);
    } else if (o.amount != null) {
      putRight(page, U_AMT_R, yb, fmt0(o.amount));
      if (o.by_rate) putSmall(page, U_NOTE_X, yb, `ref. rate ${info.rateRows.get(nkey(o.name))}%`, RED);
    }
  }
  // ---- 代価表
  for (const d of result.daika) {
    for (const row of d.rows) {
      const pos = row.pos; if (!pos || pos.pno == null) continue;
      const page = pages[pos.pno];
      const yb = pos.ybVal != null ? pos.ybVal : (pos.ybUnit != null ? pos.ybUnit : pos.ybName - 13) - 21;
      if (row.kind === '諸雑費') {
        if (row.rate != null) putRight(page, D_PRICE_R, yb, `${row.rate}%`);
        if (row.amount != null) putRight(page, D_AMT_R, yb, fmt0(row.amount));
        continue;
      }
      if (row.qty != null && pos.ybVal == null) putRight(page, D_QTY_R, yb, fmtq(row.qty));
      if (row.price != null) putRight(page, D_PRICE_R, yb, fmt2(row.price));
      if (row.amount != null) putRight(page, D_AMT_R, yb, fmt0(row.amount));
      const s = row.sug || {};
      const note = [ymShort(s.adopt_ym), s.conf === '△' ? 'check!' : ''].filter(Boolean).join(' ');
      if (note) putSmall(page, D_NOTE_X, yb, note);
    }
    const tp = d.total_pos;
    if (tp && tp.pno != null) {
      const page = pages[tp.pno];
      const yb = tp.ybTotal - 16;                       // 合計欄の下段
      if (d.unit_price != null) putRight(page, D_PRICE_R, yb, fmt2(d.unit_price));
      if (d.total != null) putRight(page, D_AMT_R, yb, fmt0(d.total));
      if (d.missing && d.missing.length) await putJp(page, D_NOTE_X, yb, '未完成: ' + d.missing.join('、').slice(0, 14), 6, '#bf0000');
    }
  }
  // ---- 1ページ目の注記
  const meta = result.meta || {};
  const p1 = pages[0];
  const H = p1.getHeight();
  const d = new Date();
  const dateS = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const lines = ['※ 青字の単価・金額は過去の県設計書（令和3〜8年度）からの参考値。経費率は同工種の平均。',
                 `作成 ${dateS}　過去設計書 単価当てアプリ（${CREDIT}）`,
                 `単価適用年月 ${meta.tanka_ym || ''} ／ 直接工事費（概算） ${fmt0(info.direct)} 円`];
  for (let i = 0; i < lines.length; i++) await putJp(p1, 36, H - 22 - 9 * i, lines[i], 6.5, '#bf0000');
  return await doc.save();
}

export function defaultPdfName(result) {
  const name = ((result.meta || {}).kouji_mei || '仕様書').replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${name}_単価記入_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.pdf`;
}
