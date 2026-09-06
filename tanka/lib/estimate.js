// 入札書類に過去単価を当てる本体（_tools/estimate.py の移植）
import { toNum } from './pdfread.js';
import { readPackage, readSuryoHints } from './parsers.js';
import { Matcher, norm, normUnit, sim, kindOfRow, ymKey } from './match.js';

const TOP = 8;
const stripParen = s => norm(s).replace(/[（(].*?[)）]/g, '');

function sugOut(s) {
  if (!s) return null;
  const p = s.pick;
  return { price: s.price, conf: s.conf, score: s.score, n: s.n, min: s.min, median: s.median, max: s.max,
           adopt_ym: p.tanka_ym, no: p.no, kenmei: p.kenmei, hacchu: p.hacchu, name: p.name, kikaku: p.kikaku,
           unit: p.unit, source: p.source, why: p.why };
}

export class Estimator {
  constructor(matcher) { this.m = matcher; }

  _direct(row, ym, hacchu) {
    const cands = this.m.searchUchiwake(row.name, row.unit, ym, hacchu, TOP);
    return [sugOut(Matcher.suggest(cands, 'latest', ym)), cands];
  }

  _rowPrice(name, kikaku, unit, ym, hacchu, code, subprices) {
    const key = norm(name);
    if (subprices.has(key)) {
      const sp = subprices.get(key);
      return [{ price: sp.unit_price, conf: sp.conf, score: 1, n: 1, min: sp.unit_price, median: sp.unit_price, max: sp.unit_price,
                adopt_ym: '（積上げ）', no: '', kenmei: '別紙代価表 ' + sp.title, hacchu: '', name, kikaku: '', unit, source: '積上げ', why: '別紙代価表の積上げ' }, []];
    }
    const kind = kindOfRow(name, unit);
    let cands = this.m.searchDaika(name, kikaku, unit, ym, hacchu, code, TOP);
    if (kind === '材料・その他' && (!cands.length || cands[0].score < 0.8)) {
      const c2 = this.m.searchMaterial(name, kikaku, unit, ym, hacchu, TOP);
      cands = [...cands, ...c2].sort((a, b) => (b.score - a.score) || (b.ym - a.ym)).slice(0, TOP);
    }
    const mode = (kind === '労務' || kind === '機械') ? 'closest' : 'latest';
    return [sugOut(Matcher.suggest(cands, mode, ym)), cands];
  }

  _buildup(rows, perQty, ym, hacchu, codes, hkRows, subprices) {
    const hkByName = new Map();
    for (const r of hkRows) { const k = norm(r.name); if (!hkByName.has(k)) hkByName.set(k, r); }
    const outRows = [], missing = [];
    let total = 0, zatsuRate = null, zatsuBase = 0, laborSum = 0, flagged = false;
    for (const r of rows) {
      const kind = kindOfRow(r.name, r.unit);
      let hk = hkByName.get(norm(r.name)) || null;
      if (!hk) {
        let best = null;
        for (const [k, v] of hkByName) { const sc = sim(norm(r.name), k); if (sc >= 0.8 && (!best || sc > best[0])) best = [sc, v]; }
        hk = best ? best[1] : null;
      }
      let qty = r.qty ?? null, qtySrc = '仕様書';
      if (kind === '諸雑費') {
        zatsuRate = (hk && ['%', '％'].includes((hk.unit || '').trim())) ? hk.qty : null;
        outRows.push({ seq: r.seq, name: r.name, kikaku: r.kikaku || '', unit: r.unit, qty: null, qty_src: '', kind, sug: null,
                       price: null, amount: null, zatsu_target: false, cands: [], rate: zatsuRate, pos: r.pos || null });
        continue;
      }
      if (qty === null && hk) { qty = hk.qty ?? null; qtySrc = '歩掛'; }
      if (qty === null) qtySrc = '';
      const code = codes.get(norm(r.name)) || '';
      const [sug, cands] = this._rowPrice(r.name, r.kikaku || '', r.unit, ym, hacchu, code, subprices);
      const price = sug ? sug.price : null;
      const amount = (qty !== null && price !== null) ? Math.round(qty * price) : null;
      const zt = !!(hk && (hk.note || '').includes('諸雑費対象'));
      flagged = flagged || zt;
      if (amount !== null) { total += amount; if (zt) zatsuBase += amount; if (kind === '労務') laborSum += amount; }
      else missing.push(r.name);
      outRows.push({ seq: r.seq, name: r.name, kikaku: r.kikaku || '', unit: r.unit, qty, qty_src: qtySrc, kind, sug, price, amount,
                     zatsu_target: zt, cands: cands.slice(0, TOP), pos: r.pos || null });
    }
    let zatsu = null;
    if (zatsuRate !== null) {
      const base = flagged ? zatsuBase : laborSum;
      zatsu = { rate: zatsuRate, base: Math.round(base), amount: Math.round(base * zatsuRate / 100) };
      total += zatsu.amount;
      for (const o of outRows) if (o.kind === '諸雑費') { o.amount = zatsu.amount; o.price = null; }
    }
    const complete = missing.length === 0;
    const unitPrice = (perQty && complete) ? total / perQty : null;
    return { rows: outRows, zatsu, total: complete ? Math.round(total) : null,
             unit_price: unitPrice !== null ? Math.round(unitPrice * 100) / 100 : null, complete, missing };
  }

  _adopt(o, price, src, conf, ym, from) { o.price = price; o.price_src = src; o.conf = conf; o.adopt_ym = ym; o.adopt_from = from; }

  _hintPrice(o, ym, hacchu) {
    const h = o.hint || '';
    const m = h.match(/([0-9][0-9.,]*)\s*人[・･]?日/);
    if (m && normUnit(o.unit) === '式') {
      const n = parseFloat(m[1].replace(/,/g, ''));
      const base = o.name.replace(/[（(].*?[)）]/g, '');
      const cands = this.m.searchDaika(base, '', '人日', ym, hacchu, '', TOP);
      const s = Matcher.suggest(cands, 'closest', ym);
      if (s) {
        const p = s.pick;
        return { price: Math.round(n * s.price), conf: s.conf, adopt_ym: p.tanka_ym, unit_rate: s.price, days: n,
                 from: `${m[1]}人日 × ${Math.round(s.price).toLocaleString()}円（${p.no} ${p.kenmei.slice(0, 20)}）` };
      }
    }
    return null;
  }

  _keihiRef(shu) {
    const base = (shu || '').replace(/[（(].*/, '').trim();
    let rows = base ? this.m.d.keihi.filter(k => (k.shu_koushu || '').includes(base)) : [];
    if (!rows.length) rows = this.m.d.keihi;
    return rows.slice(0, 6);
  }

  run(files, opts = {}) {
    const pkg = readPackage(files);
    const meta = {};
    for (const k of ['kouji_mei', 'nendo', 'basho', 'rosen', 'taiyou', 'tanka_ym', 'keihi_ym', 'shu_koushu', 'chiiki', 'hosei_kyoutsu', 'hosei_genba', 'file'])
      meta[k] = pkg[k] ?? '';
    meta.folder = opts.folder || '';
    const ym = meta.tanka_ym || meta.keihi_ym;
    const text0 = [meta.kouji_mei, meta.rosen, meta.shu_koushu, meta.basho].join(' ');
    meta.hacchu = (/下水道|流域|幹線/.test(text0)) ? '下水道事務所' : '県土整備事務所';
    meta.made_at = new Date().toLocaleString('ja-JP', { hour12: false }).replace(/:\d+$/, '');
    const hacchu = meta.hacchu;
    const codes = new Map((pkg.joken || []).map(j => [norm(j.name), j.code]));
    const hokkake = pkg.hokkake || [];

    const subprices = new Map(), subBlocks = [];
    for (const b of hokkake) {
      if (!b.sub) continue;
      const name = b.title.replace(/^代価表\s*\d+\s*/, '').trim();
      const per = toNum(b.per.replace(/[^\d.]/g, '')) || 1;
      const bu = this._buildup(b.rows.map((r, i) => ({ seq: i + 1, name: r.name, kikaku: r.kikaku || '', unit: r.unit, qty: r.qty })), per, ym, hacchu, codes, b.rows, new Map());
      const blk = { dno: null, title: name, per_qty: per, per_unit: b.per.replace(/^[0-9.]+/, ''), hokkake_title: b.title, sub: true, ...bu };
      subBlocks.push(blk);
      if (bu.unit_price !== null) subprices.set(norm(name), { unit_price: bu.unit_price, title: name, conf: bu.complete ? '○' : '△' });
    }
    const daikaOut = [];
    const hkMain = hokkake.filter(b => !b.sub);
    for (const d of pkg.daika || []) {
      let hk = null, best = 0;
      for (const b of hkMain) { const sc = sim(stripParen(d.title), stripParen(b.title)); if (sc > best) { best = sc; hk = b; } }
      if (best < 0.7) hk = null;
      const bu = this._buildup(d.rows, d.per_qty || 1, ym, hacchu, codes, hk ? hk.rows : [], subprices);
      daikaOut.push({ dno: d.dno, title: d.title, per_qty: d.per_qty, per_unit: d.per_unit || '', hokkake_title: hk ? hk.title : '', sub: false, total_pos: d.total_pos || null, ...bu });
    }
    daikaOut.push(...subBlocks);
    const byDno = new Map(daikaOut.filter(d => d.dno !== null).map(d => [d.dno, d]));

    const hintMap = new Map();
    const f = pkg.files;
    const hintFiles = [...(f.suryo ? [f.suryo] : []), ...f.sankou, ...f.others];
    for (const hf of hintFiles) for (const h of readSuryoHints(hf.pdf)) {
      if (!h.hint) continue;
      hintMap.set(stripParen(h.name + h.kikaku), h.hint);
      if (!hintMap.has(stripParen(h.name))) hintMap.set(stripParen(h.name), h.hint);
    }

    const uchi = [];
    let nLeaf = 0, nPriced = 0, directSum = 0;
    pkg.uchiwake.forEach((r, i) => {
      const o = { idx: i, level: r.level, name: r.name, unit: r.unit, qty: r.qty, dno: r.dno, leaf: !!(r.leaf || r.dno), section: r.section,
                  hint: hintMap.get(stripParen(r.name)) || '', pos: r.pos || null, direct: null, buildup: null, price: null, price_src: '', conf: '',
                  adopt_ym: '', adopt_from: '', amount: null, cands: [] };
      if (o.leaf) {
        nLeaf++;
        const [sug, cands] = this._direct(r, ym, hacchu);
        o.direct = sug; o.cands = cands.slice(0, TOP);
        const bu = byDno.get(r.dno);
        if (bu) o.buildup = { price: bu.unit_price, complete: bu.complete, missing: bu.missing, dno: bu.dno };
        const hb = this._hintPrice(o, ym, hacchu);
        if (hb) o.hintcalc = hb;
        if (sug && normUnit(r.unit) === '式') sug.conf = '△';
        if (bu && bu.unit_price !== null) {
          const yms = [...new Set(bu.rows.filter(rr => rr.sug && ymKey(rr.sug.adopt_ym)).map(rr => rr.sug.adopt_ym))].sort();
          const ymtxt = yms.length ? (yms.length === 1 ? yms[0] : `${yms[0]}〜${yms[yms.length - 1]}`) : '';
          this._adopt(o, bu.unit_price, '積上げ', '○', ymtxt, `第${bu.dno}号代価表の積上げ（${bu.rows.length}行）`);
        } else if (sug && (sug.conf === '◎' || sug.conf === '○')) {
          this._adopt(o, sug.price, '過去単価', sug.conf, sug.adopt_ym, `${sug.no} ${sug.kenmei}（${sug.hacchu}）`);
        } else if (hb) {
          this._adopt(o, hb.price, 'ヒント積算', hb.conf, hb.adopt_ym, hb.from);
        } else if (sug) {
          this._adopt(o, sug.price, '過去単価', sug.conf, sug.adopt_ym, `${sug.no} ${sug.kenmei}（${sug.hacchu}）`);
        }
        if (o.price !== null) {
          nPriced++;
          if (o.qty !== null) { o.amount = Math.round(o.qty * o.price); if (o.section === '本体') directSum += o.amount; }
        }
      }
      uchi.push(o);
    });

    const shizai = [];
    for (const s of pkg.shizai || []) {
      const c1 = this.m.searchMaterial(s.name, s.kikaku, s.unit, ym, hacchu, TOP);
      const c2 = this.m.searchDaika(s.name, s.kikaku, s.unit, ym, hacchu, '', TOP);
      const cands = [...c1, ...c2].sort((a, b) => (b.score - a.score) || (b.ym - a.ym)).slice(0, TOP);
      const sug = sugOut(Matcher.suggest(cands, 'latest', ym));
      shizai.push({ row: s.row, name: s.name, kikaku: s.kikaku, unit: s.unit, src: s.src, note: s.note, sug,
                    price: sug ? sug.price : null, adopt_ym: sug ? sug.adopt_ym : '', cands });
    }

    return { meta, uchiwake: uchi, daika: daikaOut, shizai, keihi_ref: this._keihiRef(meta.shu_koushu),
             summary: { direct_kouji: Math.round(directSum), n_leaf: nLeaf, n_priced: nPriced, n_daika: daikaOut.length,
                        n_daika_complete: daikaOut.filter(d => d.complete).length } };
  }
}
