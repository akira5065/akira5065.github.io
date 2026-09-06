// 過去設計書データ（data.bin を復号した JSON）から、名称・規格・単位に近い単価を探す。
// _tools/match_tanka.py の移植。スコアの付け方は同じ。

const YM = /令和\s*(\d+)\s*年\s*(\d+)\s*月/;
export function ymKey(s) { const m = (s || '').match(YM); return m ? (2018 + +m[1]) * 100 + +m[2] : 0; }
export function ymMonths(k) { return k ? Math.floor(k / 100) * 12 + (k % 100) : 0; }

const UNIT_ALIAS = {
  '㎡': 'm2', 'm²': 'm2', '平米': 'm2', 'm^2': 'm2', '㎥': 'm3', 'm³': 'm3', '立米': 'm3', 'm^3': 'm3',
  'ヶ所': '箇所', 'か所': '箇所', 'カ所': '箇所', 'ケ所': '箇所', '人・日': '人日', '人日': '人日', '人/日': '人日',
  'm2・日': 'm2日', 'm2日': 'm2日', '組': '組', '%': '%', '％': '%', 'l': 'L', 'ℓ': 'L', 'リットル': 'L',
};
export function normUnit(u) {
  u = (u || '').normalize('NFKC').trim().replace(/ /g, '');
  if (!u) return '';
  return UNIT_ALIAS[u] || UNIT_ALIAS[u.toLowerCase()] || u;
}

export function norm(s) {
  s = (s || '').normalize('NFKC').toLowerCase();
  s = s.replace(/[\s_　]+/g, '');
  s = s.replace(/[φф]/g, 'φ').replace(/ﾌｧｲ/g, 'φ').replace(/径/g, 'φ');
  s = s.replace(/[〜～]/g, '~').replace(/[－―]/g, '-');
  s = s.replace(/･/g, '・').replace(/[，、]/g, ',');
  s = s.replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, '');
  return s;
}

const SPEC_TOKEN = /t=\d+(?:\.\d+)?(?:cm|mm)?|φ\d+(?:\.\d+)?|\d+(?:\.\d+)?(?:mm|cm|m|t|kw|kg|型|号|本|層|吊)|町道|県道|国道|市道|車道|歩道|路肩|昼|夜間|夜|以下|以上|未満|超|再生|改質|密粒|粗粒|細粒|as|co|rc-\d+|rm-\d+|m-\d+|[a-z]{1,3}-\d+|有筋|無筋|小規模|標準|土砂|軟岩|[a-z]\b/g;

function normSpec(tok) {
  const m = tok.match(/^t=(\d+(?:\.\d+)?)(cm|mm)?$/);
  if (m) { let v = parseFloat(m[1]); if (m[2] === 'cm') v *= 10; return 't=' + v; }
  return tok;
}
export function specs(...parts) {
  const s = norm(parts.filter(Boolean).join(' '));
  return new Set((s.match(SPEC_TOKEN) || []).map(normSpec));
}
export function core(s) {
  let n = norm(s);
  n = n.replace(/[（(].*?[)）]/g, '').replace(/[\[【].*?[\]】]/g, '');
  n = n.replace(/t=\d+(?:\.\d+)?(?:cm|mm)?/g, '').replace(/φ\d+(?:\.\d+)?/g, '');
  n = n.replace(/\d+(?:\.\d+)?(?:mm|cm|m3|m2|m|t|kw|kg)?/g, '');
  n = n.replace(/[()（）\[\]【】,・/~\-]+$/, '').replace(/^[()（）\[\]【】,・/~\-]+/, '');
  return n || norm(s);
}

// difflib.SequenceMatcher.ratio() 相当
function longestMatch(a, b, alo, ahi, blo, bhi) {
  let besti = alo, bestj = blo, bestk = 0;
  let j2len = new Map();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map();
    const ch = a[i];
    for (let j = blo; j < bhi; j++) {
      if (b[j] !== ch) continue;
      const k = (j2len.get(j - 1) || 0) + 1;
      newj2len.set(j, k);
      if (k > bestk) { besti = i - k + 1; bestj = j - k + 1; bestk = k; }
    }
    j2len = newj2len;
  }
  return [besti, bestj, bestk];
}
export function sim(a, b) {
  if (!a || !b) return 0;
  const A = [...a], B = [...b];
  const queue = [[0, A.length, 0, B.length]];
  let matched = 0;
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longestMatch(A, B, alo, ahi, blo, bhi);
    if (k) {
      matched += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return 2 * matched / (A.length + B.length);
}

export function kindOfRow(name, unit) {
  const u = normUnit(unit), n = norm(name);
  if ((u === '人' || u === '人日')) return '労務';
  if (['日', 'hr', 'h', '時間'].includes(u) || n.includes('損料') || n.includes('運転')) return '機械';
  if (n.includes('諸雑費') || u === '%') return '諸雑費';
  return '材料・その他';
}

const RUN = /[一-龥々]{2,}|[ァ-ヶー]{3,}|[a-z][a-z0-9]{2,}/g;
const STOP = new Set(['設置', '撤去', '工事', '費用', '以下', '以上', '処分', '運搬', '設備']);

export class Matcher {
  constructor(data) {
    this.d = data;
    this.works = data.works;                                  // no -> [kenmei, hacchu, tanka_ym, koushu]
    this.workYm = {};
    for (const no in this.works) this.workYm[no] = ymKey(this.works[no][2]);
    // 検索用に正規化した名称を前もって作る
    this.brkN = data.brk.map(r => norm(r[1]));
    this.dkN = data.daika.map(r => norm(r[3]));
    this.dtN = data.dtot.map(r => norm(r[2]));
    this.matN = data.mat.map(r => norm(r[1]));
    this.dkNote = data.daika.map(r => r[8] || '');
  }
  _once(arr, t, limit) {
    const out = [];
    if (!t) return out;
    for (let i = 0; i < arr.length && out.length < limit; i++) if (arr[i].includes(t)) out.push(i);
    return out;
  }
  _find(arr, text, limit = 800) {
    const t = norm(text);
    if (!t) return [];
    let found = this._once(arr, t, limit);
    if (found.length) return found;
    const t2 = t.replace(/[工費材料類]+$/, '');
    if (t2 && t2 !== t) { found = this._once(arr, t2, limit); if (found.length) return found; }
    const runs = (t.match(RUN) || []).filter(r => !STOP.has(r));
    const keys = [];
    for (const r of runs.sort((a, b) => b.length - a.length)) {
      if (r.length >= 5) for (let i = 0; i < Math.min(r.length - 3, 4); i++) keys.push(r.slice(i, i + 4));
      keys.push(r);
    }
    const seen = new Set(), out = [];
    for (const k of keys.slice(0, 8)) {
      if (STOP.has(k)) continue;
      for (const idx of this._once(arr, k, 300)) if (!seen.has(idx)) { seen.add(idx); out.push(idx); }
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }
  _og(hacchu) { return (hacchu || '').includes('下水道') ? '下水道' : '県土整備'; }

  _score(qname, qkikaku, qunit, cname, ckikaku, cunit, cym, targetYm, sameOffice, codeHit = false) {
    const a = norm(qname), b = norm(cname);
    let s = sim(a, b);
    const ca = core(qname), cb = core(cname);
    if (ca && ca === cb) s = Math.max(s, 0.93);
    else if (ca && cb && (b.includes(ca) || a.includes(cb))) s = Math.max(s, 0.82);
    const why = [`名称${Math.round(s * 100)}%`];
    if (qkikaku || ckikaku) {
      const ks = (qkikaku && ckikaku) ? sim(norm(qkikaku), norm(ckikaku)) : 0;
      s = s * 0.75 + ks * 0.25;
      why.push(`規格${Math.round(ks * 100)}%`);
    }
    const sq = specs(qname, qkikaku), sc = specs(cname, ckikaku);
    if (sq.size) {
      let hit = 0; for (const x of sq) if (sc.has(x)) hit++;
      const ov = hit / sq.size;
      s += 0.15 * ov - 0.10 * (1 - ov);
      why.push(`仕様${hit}/${sq.size}`);
    }
    const uq = normUnit(qunit), uc = normUnit(cunit);
    if (uq && uc) { if (uq === uc) s += 0.08; else { s -= 0.30; why.push(`単位違い(${uq}≠${uc})`); } }
    const tk = targetYm ? ymKey(targetYm) : 0;
    if (tk && cym) { const diff = Math.abs(ymMonths(tk) - ymMonths(cym)); s += 0.05 * (1 - Math.min(diff, 36) / 36); }
    if (sameOffice) s += 0.02;
    if (codeHit) { s += 0.25; why.push('コード一致'); }
    return [Math.max(0, Math.min(1, s)), why.join(' ')];
  }

  _w(no) { return this.works[no] || ['', '', '', '']; }

  searchUchiwake(name, unit = '', targetYm = '', targetHacchu = '', limit = 15) {
    const og = this._og(targetHacchu);
    const out = new Map();
    const k = core(name) || norm(name);
    for (const i of this._find(this.brkN, k)) {
      const [no, nm, tani, tanka, suryo, note] = this.d.brk[i];
      const w = this._w(no);
      const [sc, why] = this._score(name, '', unit, nm, '', tani, this.workYm[no], targetYm, this._og(w[1]) === og);
      const key = `内訳書|${no}|${norm(nm)}|${Math.round(tanka)}`;
      if (!out.has(key) || out.get(key).score < sc)
        out.set(key, { source: '内訳書', no, kenmei: w[0], hacchu: w[1], tanka_ym: w[2], ym: this.workYm[no], name: nm, kikaku: '',
                       unit: tani, qty: suryo, price: tanka, score: Math.round(sc * 1000) / 1000, why, note });
    }
    for (const i of this._find(this.dtN, k)) {
      const [no, dno, title, perQty, perUnit, up] = this.d.dtot[i];
      const w = this._w(no);
      const [sc, why] = this._score(name, '', unit, title, '', perUnit, this.workYm[no], targetYm, this._og(w[1]) === og);
      const key = `代価表|${no}|${norm(title)}|${Math.round(up)}`;
      if (!out.has(key) || out.get(key).score < sc)
        out.set(key, { source: '代価表', no, kenmei: w[0], hacchu: w[1], tanka_ym: w[2], ym: this.workYm[no], name: title, kikaku: '',
                       unit: perUnit, qty: perQty, price: Math.round(up * 100) / 100, score: Math.round(sc * 1000) / 1000, why, note: `第${dno}号代価表` });
    }
    return [...out.values()].sort((a, b) => (b.score - a.score) || (b.ym - a.ym)).slice(0, limit);
  }

  searchDaika(name, kikaku = '', unit = '', targetYm = '', targetHacchu = '', code = '', limit = 15) {
    const og = this._og(targetHacchu);
    const out = new Map();
    const ids = new Set(this._find(this.dkN, core(name) || norm(name)));
    const codeIds = new Set();
    if (code) { for (let i = 0; i < this.dkNote.length && codeIds.size < 400; i++) if (this.dkNote[i].includes(code)) codeIds.add(i); for (const i of codeIds) ids.add(i); }
    for (const i of ids) {
      const [no, dno, title, nm, kk, tani, suryo, tanka, note] = this.d.daika[i];
      const w = this._w(no);
      const [sc, why] = this._score(name, kikaku, unit, nm, kk, tani, this.workYm[no], targetYm, this._og(w[1]) === og, codeIds.has(i));
      const key = `${no}|${norm(nm)}|${norm(kk)}|${Math.round(tanka * 10)}`;
      if (!out.has(key) || out.get(key).score < sc)
        out.set(key, { source: '代価表', no, kenmei: w[0], hacchu: w[1], tanka_ym: w[2], ym: this.workYm[no], name: nm, kikaku: kk,
                       unit: tani, qty: suryo, price: tanka, score: Math.round(sc * 1000) / 1000, why, note: `第${dno}号 ${title} / ${note}`.trim() });
    }
    return [...out.values()].sort((a, b) => (b.score - a.score) || (b.ym - a.ym)).slice(0, limit);
  }

  searchMaterial(name, kikaku = '', unit = '', targetYm = '', targetHacchu = '', limit = 15) {
    const og = this._og(targetHacchu);
    const out = new Map();
    for (const i of this._find(this.matN, core(name) || norm(name))) {
      const [no, nm, kk, tani, tanka, ym, kubun, code] = this.d.mat[i];
      const w = this._w(no);
      const [sc, why] = this._score(name, kikaku, unit, nm, kk, tani, ymKey(ym), targetYm, this._og(w[1]) === og);
      const key = `${norm(nm)}|${norm(kk)}|${ymKey(ym)}|${Math.round(tanka * 10)}`;
      if (!out.has(key) || out.get(key).score < sc)
        out.set(key, { source: '資材調書', no, kenmei: w[0], hacchu: w[1], tanka_ym: ym, ym: ymKey(ym), name: nm, kikaku: kk,
                       unit: tani, qty: null, price: tanka, score: Math.round(sc * 1000) / 1000, why, note: `${kubun} ${code}`.trim() });
    }
    return [...out.values()].sort((a, b) => (b.score - a.score) || (b.ym - a.ym)).slice(0, limit);
  }

  static suggest(cands, mode = 'latest', targetYm = '', threshold = 0.72) {
    const good = cands.filter(c => c.score >= threshold);
    if (!good.length) return null;
    const best = good[0].score;
    const band = good.filter(c => c.score >= best - (mode === 'closest' ? 0.06 : 0.02));
    const tk = targetYm ? ymKey(targetYm) : 0;
    let pick;
    if (mode === 'closest' && tk) {
      const before = band.filter(c => c.ym && c.ym <= tk);
      const pool = before.length ? before : band;
      const near = pool.reduce((a, c) => (Math.abs(ymMonths(c.ym) - ymMonths(tk)) < Math.abs(ymMonths(a.ym) - ymMonths(tk)) ? c : a));
      const same = pool.filter(c => c.ym === near.ym);
      const cnt = new Map();
      for (const c of same) { const p = Math.round(c.price * 10) / 10; cnt.set(p, (cnt.get(p) || 0) + 1); }
      const top = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
      pick = same.find(c => Math.round(c.price * 10) / 10 === top);
    } else {
      pick = band.reduce((a, c) => ((c.ym > a.ym) || (c.ym === a.ym && c.score > a.score) ? c : a));
    }
    const prices = good.map(c => c.price).sort((a, b) => a - b);
    let conf = pick.score >= 0.90 ? '◎' : pick.score >= 0.80 ? '○' : '△';
    const m = (pick.why || '').match(/仕様(\d+)\/(\d+)/);
    if (m && +m[2] > 0) { const hit = +m[1], tot = +m[2]; if (hit === 0) conf = '△'; else if (hit < tot && conf === '◎') conf = '○'; }
    return { price: pick.price, conf, score: pick.score, pick, n: good.length, min: prices[0], median: prices[Math.floor(prices.length / 2)], max: prices[prices.length - 1] };
  }
}
