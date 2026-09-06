// 入札書類（工事仕様書・積算参考資料・数量計算書）を読む。
// _tools/build_db.py, parse_daika.py, read_package.py, estimate.py の移植。
import { z2h, NUM, toNum, join } from './pdfread.js';

const SERIAL = /^[0-9A-Za-z][0-9A-Za-z\-]{10,}$/;

// ------------------------------------------------------------ 表紙・経費・年月

export function parseCover(pdf) {
  const lines = pdf.pages[0].text.split('\n').map(z2h).filter(Boolean);
  const info = { basho: '', rosen: '', taiyou: '' };
  for (const x of lines) {
    if (!info.basho && /(地内|地先)/.test(x)) info.basho = x.replace(/^.*?(工 事 場 所|工事場所)\s*/, '');
    if (!info.rosen && /(国道|県道|線|川|河川|市道)/.test(x) && x.length <= 40 &&
        !/(地内|地先|工事|設計書|埼玉県)/.test(x)) info.rosen = x.replace(/^.*?(路 河 川 名 称|路河川名称)\s*/, '');
  }
  const tai = lines.filter(x => /(発注|L=|Ｌ=|W=|ｗ=|w=|一式|㎡|ｍ2|m2)/.test(x) && !/工 事 大 要/.test(x));
  info.taiyou = tai.slice(0, 8).join(' / ').slice(0, 400);
  return info;
}

export function koujiMei(pdf) {
  const lines = pdf.pages[0].text.split('\n').map(z2h).filter(Boolean);
  const cands = lines
    .map(x => x.replace(/^(事 業 名|工 事 名|路 河 川 名 称|工 事 場 所|工 事 大 要)\s*/, ''))
    .filter(x => x.endsWith('工事') && !x.includes('仕様書') && !x.includes('設計書') && x.length >= 6);
  return cands.length ? cands.reduce((a, b) => (b.length > a.length ? b : a)) : '';
}

export function nendo(pdf) {
  const m = pdf.pages[0].textZ.match(/(令和\s*\d+\s*年度)/);
  return m ? m[1].replace(/\s/g, '') : '';
}

export function parseKeihiPage(pdf) {
  const out = { keihi_ym: '', shu_koushu: '', chiiki: '', hosei_kyoutsu: null, hosei_genba: null };
  const n = Math.min(pdf.pages.length, 40);
  for (let p = 0; p < n; p++) {
    const t = pdf.pages[p].textZ;
    if (!(t.includes('経') && t.includes('根') && t.includes('拠'))) continue;
    if (!t.includes('経費適用年月')) continue;
    const lines = pdf.pages[p].text.split('\n').map(z2h);
    const pick = (label, i) => {
      const x = lines[i];
      const idx = x.indexOf(label);
      if (idx < 0) return null;
      const rest = x.slice(idx + label.length).trim();
      return rest || (lines[i + 1] || '').trim();
    };
    for (let i = 0; i < lines.length; i++) {
      let v;
      if (!out.keihi_ym && (v = pick('経費適用年月', i))) out.keihi_ym = v;
      else if (!out.shu_koushu && (v = pick('主たる工種', i))) out.shu_koushu = v;
      else if (!out.chiiki && (v = pick('施工地域', i))) out.chiiki = v;
      else if (out.hosei_kyoutsu === null && (v = pick('共通仮設費率補正', i))) out.hosei_kyoutsu = toNum(v);
      else if (out.hosei_genba === null && (v = pick('現場管理費率補正', i))) out.hosei_genba = toNum(v);
    }
    break;
  }
  return out;
}

export function parseTankaYm(pdf) {
  const n = Math.min(pdf.pages.length, 6);
  for (let p = 0; p < n; p++) {
    const t = pdf.pages[p].textZ;
    if (!t.includes('単価適用年月')) continue;
    let m = t.match(/令和(\d{1,2})年(\d{1,2})月/);
    if (m) return `令和${String(+m[1]).padStart(2, '0')}年${String(+m[2]).padStart(2, '0')}月`;
    m = t.match(/\(R(\d{2})(\d{2})\)/);
    if (m) return `令和${m[1]}年${m[2]}月`;
  }
  return '';
}

// ------------------------------------------------------------ 本工事費内訳書

const COL_NAME = [50, 232], COL_QTY = [232, 280], COL_UNIT = [280, 318],
      COL_PRICE = [318, 378], COL_AMOUNT = [378, 442], COL_NOTE = [442, 600];

export function parseBreakdown(pdf) {
  const rows = [];
  for (let pno = 0; pno < pdf.pages.length; pno++) {
    const pg = pdf.pages[pno];
    const flat = pg.textZ;
    if (!(flat.includes('本 工 事 費 内 訳 書') || flat.includes('本工事費内訳書'))) continue;
    const lines = pg.lines;
    // 見出し行（本工事費内訳書／工事区分…）は語がばらけて名称列に落ちることがあるので行全体で除く
    const isHeaderLine = l => { const f = join(l.ws).replace(/ /g, ''); return ['工事区分', '内訳書', '摘要'].some(k => f.includes(k)) && !/[0-9]/.test(f); };
    const anchors = [];
    lines.forEach((l, idx) => {
      if (isHeaderLine(l)) return;
      const nm = join(l.ws, ...COL_NAME);
      if (!nm) return;
      if (/^[_\s]*$/.test(nm)) return;
      if (NUM.test(nm.replace(/ /g, ''))) return;
      if (['工事区分', '内 訳 書', '内訳書', '摘 要', '摘要'].some(k => nm.includes(k))) return;
      if (SERIAL.test(nm.replace(/ /g, ''))) return;
      anchors.push(idx);
    });
    anchors.forEach((idx, ai) => {
      const end = ai + 1 < anchors.length ? anchors[ai + 1] : lines.length;
      const nmRaw = join(lines[idx].ws, ...COL_NAME);
      const lead = nmRaw.match(/^[_\s]*/)[0];
      const level = (lead.match(/_/g) || []).length;
      let name = nmRaw.replace(/^[_\s]+/, '');
      let unit = null, qty = null, price = null, amount = null;
      let ybUnit = null, ybVal = null;
      const note = [];
      for (let j = idx; j < end; j++) {
        if (j > idx && isHeaderLine(lines[j])) continue;
        const ws = lines[j].ws;
        const u = join(ws, ...COL_UNIT), q = join(ws, ...COL_QTY), p = join(ws, ...COL_PRICE),
              m = join(ws, ...COL_AMOUNT), n = join(ws, ...COL_NOTE);
        if (j > idx) {
          const extra = join(ws, ...COL_NAME);
          const sq = extra.replace(/ /g, '');
          if (extra && !NUM.test(sq) && !SERIAL.test(sq) && !extra.includes('埼玉県')) name += extra;
        }
        if (u && unit === null) { unit = u; ybUnit = lines[j].yb; }
        if (q && qty === null) { qty = toNum(q); ybVal = lines[j].yb; }
        if (p && price === null) price = toNum(p);
        if (m && amount === null) amount = toNum(m);
        if (n) note.push(n);
      }
      name = name.replace(/\s+/g, '');
      rows.push({ level, name, unit, qty, price, amount, note: note.join(' ').slice(0, 80),
                  pos: { pno, ybName: lines[idx].yb, ybUnit, ybVal } });
    });
  }
  return rows;
}

// ------------------------------------------------------------ 一位代価表

const D_NAME = [55, 235], D_QTY = [235, 285], D_UNIT = [285, 330], D_PRICE = [330, 400],
      D_AMOUNT = [400, 458], D_NOTE = [458, 600];
const HEAD = /^第\s*(\d+)\s*号\s*(一位)?代価表\s*(.*)$/;
const PER = /^([0-9.,]+)\s*(\S+)\s*当り$/;

function isDaikaPage(pg) {
  // 「一位代価表(施工Ｐ構成表)」は施工パッケージの構成比の表で、代価表の行ではない
  if (pg.textZ.includes('構成表')) return false;
  return /第\s*\d+\s*号\s*(一位)?代価表/.test(pg.textZ) && pg.textZ.includes('名 称 / 規 格');
}

function classify(lines) {
  return lines.map(l => {
    const ws = l.ws;
    const full = join(ws);
    const name = join(ws, ...D_NAME), unit = join(ws, ...D_UNIT);
    const qty = toNum(join(ws, ...D_QTY)), price = toNum(join(ws, ...D_PRICE)), amount = toNum(join(ws, ...D_AMOUNT));
    const note = join(ws, ...D_NOTE);
    let kind = 'text';
    const m = full.match(HEAD);
    if (m) kind = 'head';
    else if (name.startsWith('名 称') || name.startsWith('名称')) kind = 'colhead';
    else if (/^合\s*計/.test(name)) kind = 'total';
    else if (SERIAL.test(name.replace(/ /g, '')) || full.includes('埼玉県')) kind = 'footer';
    else if (PER.test(join(ws, 440))) kind = 'per';
    else if (unit && !name && toNum(unit) === null) kind = 'unit';
    else if (!name && (qty !== null || price !== null || amount !== null)) kind = 'vals';
    else if (!name && note && !unit) kind = 'note';
    else if (name) kind = 'name';
    return { y: l.y, yb: l.yb, name, unit, qty, price, amount, note, kind, m, ws };
  });
}

export function parseDaika(pdf) {
  const rows = [], totals = [];
  for (let pno = 0; pno < pdf.pages.length; pno++) {
    const pg = pdf.pages[pno];
    if (!isDaikaPage(pg)) continue;
    const L = classify(pg.lines);
    const n = L.length;
    const heads = [];
    L.forEach((l, i) => {
      if (l.kind !== 'head') return;
      let perQty = null, perUnit = '';
      for (let j = i; j < Math.min(i + 3, n); j++) {
        const pm = join(L[j].ws, 440).match(PER);
        if (pm) { perQty = toNum(pm[1]); perUnit = pm[2]; break; }
      }
      heads.push({ i, dno: +l.m[1], title: (l.m[3] || '').trim(), perQty, perUnit });
    });
    const headFor = i => { let h = null; for (const hh of heads) if (hh.i <= i) h = hh; return h; };
    const starts = [];
    L.forEach((l, k) => {
      if (l.kind !== 'unit') return;
      let j = k - 1;
      if (j < 0 || L[j].kind !== 'name' || L[k].y - L[j].y > 18) return;
      let s = j;
      while (s - 1 >= 0 && L[s - 1].kind === 'name' && L[s].y - L[s - 1].y <= 12) s--;
      starts.push([s, k]);
    });
    const seqByHead = new Map();
    starts.forEach(([s, k], ri) => {
      let end = ri + 1 < starts.length ? starts[ri + 1][0] : n;
      for (let j = k + 1; j < end; j++) {
        if (['head', 'total', 'footer', 'colhead', 'per'].includes(L[j].kind)) { end = j; break; }
      }
      const h = headFor(s);
      if (!h) return;
      let bodyEnd = end;
      if (bodyEnd - 1 > k && L[bodyEnd - 1].kind === 'note' && ri + 1 < starts.length && bodyEnd === starts[ri + 1][0]) bodyEnd--;
      let name = '';
      for (let j = s; j < k; j++) name += L[j].name;
      name = name.replace(/ /g, '');
      const unit = L[k].unit;
      const kikaku = [], note = [];
      let qty = null, price = null, amount = null, ybVal = null;
      if (s - 1 >= 0 && L[s - 1].kind === 'note') note.push(L[s - 1].note);
      for (let j = s; j < bodyEnd; j++) {
        const l = L[j];
        if (j > k && l.name) kikaku.push(l.name);
        if (l.qty !== null && qty === null) qty = l.qty;
        if (ybVal === null && (l.qty !== null || l.price !== null || l.amount !== null)) ybVal = l.yb;
        if (l.price !== null && price === null) price = l.price;
        if (l.amount !== null && amount === null) amount = l.amount;
        if (l.note && !/^[0-9.,]+$/.test(l.note) && !note.includes(l.note)) note.push(l.note);
      }
      const seq = (seqByHead.get(h.i) || 0) + 1;
      seqByHead.set(h.i, seq);
      rows.push({ dno: h.dno, title: h.title, per_qty: h.perQty, per_unit: h.perUnit, seq, name,
                  kikaku: kikaku.join(' ').trim(), unit, qty, price, amount, note: note.join(' ').slice(0, 60),
                  pos: { pno, ybName: L[s].yb, ybUnit: L[k].yb, ybVal } });
    });
    L.forEach((l, i) => {
      if (l.kind !== 'total') return;
      const h = headFor(i);
      if (!h) return;
      let total = null;
      for (let j = i; j < Math.min(i + 3, n); j++) {
        const v = L[j].amount !== null ? L[j].amount : L[j].price;
        if (v !== null) { total = v; break; }
      }
      totals.push({ dno: h.dno, title: h.title, per_qty: h.perQty, per_unit: h.perUnit, total,
                    pos: { pno, ybTotal: l.yb } });
    });
  }
  return { rows, totals };
}

// ------------------------------------------------------------ 積算条件一覧表

const J_NO = [60, 140], J_NAME = [140, 325], J_UNIT = [325, 365], J_NOTE = [440, 600];
const JOKEN_NO = /^第\s*(\d+)\s*号\s*(施工表|施工P|施工Ｐ|市場単価|.*)$/;
const CODE = /^[A-Z]{2}[0-9A-Z]{5,9}$/;

export function readJoken(pdf) {
  const out = [];
  for (const pg of pdf.pages) {
    const t = pg.textZ;
    if (!t.includes('積 算 条 件') || !t.includes('単価表番号')) continue;
    const lines = pg.lines;
    const recs = [];
    lines.forEach((l, i) => { if (JOKEN_NO.test(join(l.ws, ...J_NO))) recs.push(i); });
    recs.forEach((i, k) => {
      const hasNameAbove = idx => idx - 1 >= 0 && join(lines[idx - 1].ws, ...J_NAME) && lines[idx].y - lines[idx - 1].y <= 6;
      const s = hasNameAbove(i) ? i - 1 : i;
      let e = k + 1 < recs.length ? recs[k + 1] : lines.length;
      if (k + 1 < recs.length && hasNameAbove(recs[k + 1])) e = recs[k + 1] - 1;
      let name = '', unit = '', code = '';
      const kikaku = [];
      for (let j = s; j < e; j++) {
        const ws = lines[j].ws;
        const nm = join(ws, ...J_NAME), u = join(ws, ...J_UNIT), nt = join(ws, ...J_NOTE);
        if (nm) { if (!name) name = nm; else kikaku.push(nm); }
        if (u && !unit && toNum(u) === null) unit = u;
        if (nt && CODE.test(nt.replace(/ /g, ''))) code = nt.replace(/ /g, '');
      }
      if (!name || name.includes('使用機械の機種')) return;
      out.push({ no: join(lines[i].ws, ...J_NO), code, name, kikaku: kikaku.join(' ').replace(/\s\d{1,3}$/, '').trim(), unit });
    });
  }
  return out;
}

// ------------------------------------------------------------ 積算参考資料

const S_ROW = [40, 60], S_NAME = [60, 150], S_KIKAKU = [150, 265], S_UNIT = [265, 296], S_NOTE = [470, 600];

export function readShizai(pdf) {
  const out = [];
  for (const pg of pdf.pages) {
    if (!pg.textZ.includes('資材単価一覧表')) continue;
    const lines = pg.lines;
    const anchors = [];
    lines.forEach((l, i) => { if (/^\d{1,3}$/.test(join(l.ws, ...S_ROW))) anchors.push(i); });
    anchors.forEach((i, k) => {
      const e = k + 1 < anchors.length ? anchors[k + 1] : lines.length;
      let name = '', unit = '';
      const kikaku = [], note = [], src = [];
      for (let j = i; j < e; j++) {
        const ws = lines[j].ws;
        if (j > i && join(ws, 60, 100).startsWith('※')) break;
        const nm = join(ws, ...S_NAME), kk = join(ws, ...S_KIKAKU), u = join(ws, ...S_UNIT), nt = join(ws, ...S_NOTE);
        if (nm && !name) name = nm; else if (nm) kikaku.push(nm);
        if (kk) kikaku.push(kk);
        if (u && !unit) unit = u;
        if (nt && nt !== '-' && nt !== '─') note.push(nt);
        for (const [x0, , tx] of ws) if (tx === '●') src.push(x0 < 330 ? '建設物価' : x0 < 370 ? '積算資料' : '見積');
      }
      if (!name) return;
      out.push({ row: +join(lines[i].ws, ...S_ROW), name, kikaku: kikaku.join(' ').trim(), unit,
                 src: [...new Set(src)].join('/'), note: note.join(' ') });
    });
  }
  return out;
}

const H_NAME = [60, 245], H_UNIT = [245, 285], H_QTY = [285, 330], H_NOTE = [400, 600];
const PER2 = /^(\S+?)\s*当り$/;

export function readHokkake(pdf) {
  const blocks = [];
  for (const pg of pdf.pages) {
    const t = pg.textZ;
    if (!t.includes('採用歩掛') && !t.includes('当り')) continue;
    let cur = null, pendingName = '', pendingNote = [], lastRow = null;
    for (const l of pg.lines) {
      const ws = l.ws;
      const nm = join(ws, ...H_NAME), u = join(ws, ...H_UNIT), q = toNum(join(ws, ...H_QTY)), nt = join(ws, ...H_NOTE);
      const pm = nt ? nt.match(PER2) : null;
      if (pm && nm) {
        cur = { title: nm.trim(), per: pm[1], rows: [], sub: nm.startsWith('代価表') };
        blocks.push(cur);
        pendingName = ''; pendingNote = []; lastRow = null;
        continue;
      }
      if (!cur || nm.startsWith('【') || nm.startsWith('名称')) continue;
      if (nm === '計') { lastRow = null; continue; }
      if (u || q !== null) {
        const name = pendingName || nm;
        const kikaku = (pendingName && nm) ? nm : '';
        const row = { name: name.replace(/ /g, ''), kikaku, unit: u, qty: q, note: [...pendingNote, ...(nt ? [nt] : [])].join(' ') };
        cur.rows.push(row);
        lastRow = [row, l.y];
        pendingName = ''; pendingNote = [];
        continue;
      }
      if (nm && !u) {
        if (lastRow && l.y - lastRow[1] <= 6) {
          const r = lastRow[0];
          if (r.kikaku) r.kikaku += nm; else r.name += nm.replace(/ /g, '');
        } else {
          pendingName = pendingName ? pendingName + nm : nm;
        }
        continue;
      }
      if (nt && !nm) pendingNote.push(nt);
    }
  }
  return blocks;
}

// ------------------------------------------------------------ 数量総括表の摘要

const SU_NAME = [205, 300], SU_KIKAKU = [300, 370], SU_UNIT = [370, 392], SU_HINT = [488, 600];

export function readSuryoHints(pdf) {
  const out = [];
  for (const pg of pdf.pages) {
    const t = pg.textZ;
    if (!t.includes('数 量 総 括 表') && !t.includes('数量総括表')) continue;
    const lines = pg.lines;
    lines.forEach((l, i) => {
      const name = join(l.ws, ...SU_NAME);
      if (!name || name.startsWith('細') || name.includes('LEVEL')) return;
      const kikaku = join(l.ws, ...SU_KIKAKU), unit = join(l.ws, ...SU_UNIT);
      let hint = join(l.ws, ...SU_HINT);
      if (!hint && i - 1 >= 0 && l.y - lines[i - 1].y <= 4) hint = join(lines[i - 1].ws, ...SU_HINT);
      if (!hint && i + 1 < lines.length && lines[i + 1].y - l.y <= 4) hint = join(lines[i + 1].ws, ...SU_HINT);
      hint = hint.replace(/^\d+\s+/, '').trim();
      if (/^[0-9.,]+$/.test(hint)) hint = '';
      out.push({ name, kikaku, unit, hint });
    });
  }
  return out;
}

// ------------------------------------------------------------ まとめ

const DAIKA_REF = /第\s*(\d+)\s*号\s*(一位)?代価表/;
export const key = s => z2h(s || '').replace(/[\s（）()【】\[\]・,，、]/g, '');

// files: [{name, pdf}] （pdf は loadPdf の結果）
export function findFiles(files) {
  const out = { shiyousho: null, sankou: [], suryo: null, others: [] };
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name, 'ja'))) {
    const b = f.name;
    if (b.includes('特記')) out.others.push(f);
    else if (b.includes('仕様書') || b.includes('設計書')) out.shiyousho = out.shiyousho || f;
    else if (b.includes('積算参考')) out.sankou.push(f);
    else if (b.includes('数量')) out.suryo = f;
    else out.others.push(f);
  }
  if (!out.shiyousho) {
    for (const f of files) {
      if (f.pdf.pages.slice(0, 8).some(pg => pg.textZ.includes('内 訳 書'))) { out.shiyousho = f; break; }
    }
  }
  return out;
}

export function readShiyousho(f) {
  const pdf = f.pdf;
  const meta = { file: f.name, kouji_mei: koujiMei(pdf), nendo: nendo(pdf) };
  Object.assign(meta, parseCover(pdf), parseKeihiPage(pdf));
  meta.tanka_ym = parseTankaYm(pdf) || meta.keihi_ym || '';

  const rows = [];
  let section = '本体';
  for (const r of parseBreakdown(pdf)) {
    if (r.unit === null && r.qty === null) continue;
    if (r.name === '直接工事費' && r.level <= 1) section = '経費';
    const m = (r.note || '').replace(/ /g, '').match(DAIKA_REF);   // 「第9502号一位代価 表」の折返し対策
    rows.push({ level: r.level, name: r.name, unit: r.unit || '', qty: r.qty, note: r.note || '',
                dno: m ? +m[1] : null, section, pos: r.pos || null });
  }
  meta.uchiwake = rows;

  const { rows: drows, totals } = parseDaika(pdf);
  const daika = new Map();
  for (const r of drows) {
    if (!daika.has(r.dno)) daika.set(r.dno, { dno: r.dno, title: r.title, per_qty: r.per_qty, per_unit: r.per_unit, rows: [] });
    daika.get(r.dno).rows.push({ seq: r.seq, name: r.name, kikaku: r.kikaku, unit: r.unit || '', qty: r.qty, price: r.price, amount: r.amount, note: r.note, pos: r.pos || null });
  }
  for (const t of totals) {
    if (!daika.has(t.dno)) daika.set(t.dno, { dno: t.dno, title: t.title, per_qty: t.per_qty, per_unit: t.per_unit, rows: [] });
    daika.get(t.dno).total = t.total;
    daika.get(t.dno).total_pos = t.pos || null;
  }
  meta.daika = [...daika.keys()].sort((a, b) => a - b).map(k => daika.get(k));
  const titles = new Map(meta.daika.map(d => [key(d.title), d.dno]));
  for (const r of rows) if (r.dno === null) r.dno = titles.get(key(r.name)) ?? null;
  // 葉（単価を当てる行）: 代価表があるか、下位行を持たない本体行
  rows.forEach((r, i) => {
    const nxt = rows[i + 1];
    const hasChild = !!(nxt && nxt.level > r.level);
    r.leaf = (r.dno !== null) || (r.section === '本体' && !hasChild);
  });
  meta.joken = readJoken(pdf);
  return meta;
}

export function readPackage(files) {
  const found = findFiles(files);
  if (!found.shiyousho) throw new Error('仕様書（内訳書のあるPDF）が見つかりません。ファイル名に「仕様書」を含むPDFを入れてください。');
  const pkg = readShiyousho(found.shiyousho);
  pkg.shizai = []; pkg.hokkake = [];
  for (const f of found.sankou) { pkg.shizai.push(...readShizai(f.pdf)); pkg.hokkake.push(...readHokkake(f.pdf)); }
  pkg.files = found;
  return pkg;
}
