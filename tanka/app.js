// 過去設計書 単価当てアプリ（ホームページ版）　株式会社新井設備工業 開発
// すべてブラウザの中で動く。単価データ（data.bin）は合言葉で復号する。
import { loadPdf } from './lib/pdfread.js';
import { Matcher, kindOfRow } from './lib/match.js';
import { Estimator } from './lib/estimate.js';
import { buildXlsx, defaultName } from './lib/export.js';
import { writeShiyousho, defaultPdfName } from './lib/writepdf.js';

let R = null, M = null, EST = null, DATA = null;
const SRC = new Map();     // ファイル名 -> 元PDFのバイト列（仕様書への書き込み用）
const $ = s => document.querySelector(s);
const fmt = (v, d = 0) => (v == null || v === '') ? '' : Number(v).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtP = v => (v == null || v === '') ? '' : (Math.abs(v - Math.round(v)) < 1e-9 ? fmt(v) : fmt(v, 2));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const confCls = c => c === '◎' ? 'a' : c === '○' ? 'b' : c === '△' ? 'c' : 'x';
const confTag = c => `<span class="conf ${confCls(c)}">${c || '—'}</span>`;

// ------------------------------------------------------------ 合言葉とデータ
async function deriveKey(pw, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function gunzip(buf) {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}
let dataBin = null;
async function fetchData() {
  if (dataBin) return dataBin;
  $('#gate-msg').textContent = '単価データを読み込んでいます…';
  const r = await fetch('data.bin', { cache: 'no-cache' });
  if (!r.ok) throw new Error('data.bin が見つかりません');
  dataBin = await r.arrayBuffer();
  $('#gate-msg').textContent = '';
  return dataBin;
}
async function unlock(pw) {
  const buf = await fetchData();
  const u8 = new Uint8Array(buf);
  const magic = new TextDecoder().decode(u8.slice(0, 4));
  if (magic !== 'TNK1') throw new Error('データ形式が違います');
  const salt = u8.slice(4, 20), iv = u8.slice(20, 32), ct = u8.slice(32);
  const key = await deriveKey(pw, salt);
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('TNK1') }, key, ct); }
  catch (e) { throw new Error('合言葉が違います'); }
  const json = await gunzip(plain);
  DATA = JSON.parse(json);
  M = new Matcher(DATA);
  EST = new Estimator(M);
  const st = DATA.stat || {};
  $('#dbinfo').textContent = `単価データ: 設計書 ${st.works || '?'}件（数値化 ${st.textable || '?'}件）／内訳書 ${fmt(st.brk)}行／代価表 ${fmt(st.daika)}行／資材 ${fmt(st.mat)}行　更新 ${st.built || ''}`;
}

$('#gate-go').onclick = async () => {
  const pw = $('#gate-pw').value;
  if (!pw) return;
  $('#gate-go').disabled = true; $('#gate-err').textContent = '';
  try {
    await unlock(pw);
    try { sessionStorage.setItem('tanka_pw', pw); } catch (e) { /* ignore */ }
    $('#gate').style.display = 'none'; $('#main').style.display = '';
    if (location.search.includes('test=')) runTest();
  } catch (e) { $('#gate-err').textContent = e.message || String(e); }
  finally { $('#gate-go').disabled = false; }
};
$('#gate-pw').addEventListener('keydown', e => { if (e.key === 'Enter') $('#gate-go').click(); });
(async () => {
  let pw = '';
  try { pw = sessionStorage.getItem('tanka_pw') || ''; } catch (e) { /* ignore */ }
  if (pw) { $('#gate-pw').value = pw; $('#gate-go').click(); }
})();

// ------------------------------------------------------------ 読み込み
async function readFiles(fileList) {
  const files = [];
  for (const f of fileList) {
    if (!/\.pdf$/i.test(f.name)) continue;
    const name = f.name;
    $('#busy').textContent = `読み込み中… ${name}`;
    const buf = await f.arrayBuffer();
    SRC.set(name, buf.slice(0));          // pdf.js に渡すと中身が移されるので複製を残す
    files.push({ name, pdf: await loadPdf(buf) });
  }
  return files;
}
async function run(fileList, folderName) {
  $('#err').textContent = ''; $('#busy').style.display = ''; $('#busy').textContent = '読み込み中…';
  try {
    const files = await readFiles(fileList);
    if (!files.length) throw new Error('PDF がありません');
    $('#busy').textContent = '過去の単価を当てています…';
    await new Promise(r => setTimeout(r, 30));
    R = EST.run(files, { folder: folderName || '' });
    window.__R = R;      // 動作確認用
    render();
  } catch (e) { console.error(e); $('#err').textContent = '読み込みに失敗しました: ' + (e.message || e); }
  finally { $('#busy').style.display = 'none'; }
}
$('#folder').onchange = e => { const fl = [...e.target.files]; if (!fl.length) return; const folder = (fl[0].webkitRelativePath || '').split('/')[0]; run(fl, folder); };
$('#files').onchange = e => { const fl = [...e.target.files]; if (fl.length) run(fl, ''); };
const drop = $('#drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async e => {
  e.preventDefault(); drop.classList.remove('over');
  const items = [...e.dataTransfer.items];
  const out = [];
  const walk = async entry => {
    if (entry.isFile) await new Promise(res => entry.file(f => { out.push(f); res(); }));
    else if (entry.isDirectory) { const reader = entry.createReader(); const ents = await new Promise(res => reader.readEntries(res)); for (const en of ents) await walk(en); }
  };
  for (const it of items) { const en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; if (en) await walk(en); else if (it.getAsFile()) out.push(it.getAsFile()); }
  if (out.length) run(out, '');
});
// 動作確認用（手元のサーバーだけ）: ?test=フォルダ名 で ../_test/<フォルダ>/files.json のPDFを読む
async function runTest() {
  const name = new URLSearchParams(location.search).get('test');
  const list = await (await fetch(`../_test/${name}/files.json`)).json();
  const files = [];
  for (const fn of list) { const b = await (await fetch(`../_test/${name}/${encodeURIComponent(fn)}`)).blob(); files.push(new File([b], fn)); }
  run(files, name);
}

// ------------------------------------------------------------ 表示
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  ['uchiwake', 'daika', 'shizai', 'search', 'keihi'].forEach(t => { $('#tab-' + t).style.display = (t === b.dataset.tab) ? '' : 'none'; });
});

function render() {
  $('#result').style.display = '';
  const m = R.meta;
  $('#meta').innerHTML = [['工事名', m.kouji_mei], ['年度', m.nendo], ['工事場所', m.basho], ['路河川名', m.rosen],
    ['単価適用年月', m.tanka_ym], ['経費適用年月', m.keihi_ym], ['主たる工種', m.shu_koushu], ['施工地域', m.chiiki],
    ['発注機関（推定）', m.hacchu], ['読み込んだ仕様書', m.file]].map(([k, v]) => `<div><b>${k}</b>${esc(v)}</div>`).join('');
  recalc(); renderUchiwake(); renderDaika(); renderShizai(); renderKeihi();
}
function recalc() {
  const rows = R.uchiwake;
  let direct = 0, priced = 0, leaf = 0;
  rows.forEach(o => { if (o.leaf) { leaf++; o.amount = (o.qty != null && o.price != null) ? Math.round(o.qty * o.price) : null; if (o.price != null) priced++; } else o.amount = null; });
  for (let i = rows.length - 1; i >= 0; i--) {
    const o = rows[i]; if (o.leaf) continue;
    let s = 0, any = false;
    for (let j = i + 1; j < rows.length && rows[j].level > o.level && rows[j].section === o.section; j++) if (rows[j].level === o.level + 1 && rows[j].amount != null) { s += rows[j].amount; any = true; }
    o.amount = any ? s : null;
  }
  rows.forEach(o => { if (o.level === 0 && o.section === '本体' && o.amount != null) direct += o.amount; });
  R.summary.direct_kouji = direct; R.summary.n_priced = priced; R.summary.n_leaf = leaf;
  $('#total').textContent = '直接工事費（概算） ' + fmt(direct) + ' 円';
  $('#stat').textContent = `単価を当てた行 ${priced} / ${leaf}　積上げ完成 ${R.summary.n_daika_complete} / ${R.summary.n_daika} 代価表`;
}
function candTable(cands, onPick) {
  if (!cands || !cands.length) return '<div class="muted">候補なし</div>';
  const rows = cands.map((c, i) => `<tr><td class="c">${i + 1}</td><td>${esc(c.source)}</td><td>${esc(c.name)}</td><td>${esc(c.kikaku || '')}</td><td class="c">${esc(c.unit)}</td>
    <td class="r">${fmtP(c.price)}</td><td class="c">${esc(c.tanka_ym)}</td><td>${esc(c.no)} ${esc(c.kenmei)}</td><td>${esc(c.hacchu)}</td>
    <td class="c">${(c.score * 100).toFixed(0)}</td><td class="muted">${esc(c.why)}</td><td class="c">${onPick ? `<button class="small ghost" data-pick="${i}">これを採用</button>` : ''}</td></tr>`).join('');
  return `<table><tr><th>#</th><th>出どころ</th><th>名称</th><th>規格</th><th>単位</th><th>単価</th><th>採用年月</th><th>設計書番号・工事名</th><th>発注機関</th><th>近さ%</th><th>判定</th><th></th></tr>${rows}</table>`;
}
function renderUchiwake() {
  const rows = R.uchiwake;
  let h = `<table><tr><th>名称</th><th>単位</th><th>数量</th><th>単価</th><th>金額</th><th>出どころ</th><th>採用年月</th><th>信頼度</th><th>出典（設計書番号 工事名）</th><th>過去の同名単価（参考）</th><th>摘要・ヒント</th><th></th></tr>`;
  rows.forEach((o, i) => {
    const ind = '　'.repeat(o.level);
    if (!o.leaf) { h += `<tr class="${o.section === '経費' ? 'keihi' : 'parent'}"><td>${ind}${esc(o.name)}</td><td class="c">${esc(o.unit)}</td><td class="r">${fmtP(o.qty)}</td><td></td><td class="r">${fmt(o.amount)}</td><td colspan="7" class="muted">${o.section === '経費' ? '経費（率）はExcelで計算' : ''}</td></tr>`; return; }
    const d = o.direct;
    const ref = d ? `<b>${fmtP(d.price)}</b> ${confTag(d.conf)}<div class="src">採用年月 ${esc(d.adopt_ym)}　幅 ${fmtP(d.min)}〜${fmtP(d.max)}（${d.n}件）${o.price_src !== '過去単価' ? ` <button class="small ghost" data-dr="${i}">これを採用</button>` : ''}</div>` : '<span class="muted">なし</span>';
    const hint = (o.hint || '') + (o.hintcalc ? ' → ' + o.hintcalc.from : '');
    const bu = o.buildup && o.buildup.price != null && o.price_src !== '積上げ' ? `<div class="src">積上げ: ${fmtP(o.buildup.price)} <button class="small ghost" data-bu="${i}">積上げを採用</button></div>` : (o.buildup && o.buildup.price == null ? `<div class="src warn">積上げ未完成（${esc((o.buildup.missing || []).join('、'))}）</div>` : '');
    h += `<tr><td>${ind}${esc(o.name)}</td><td class="c">${esc(o.unit)}</td><td class="r">${fmtP(o.qty)}</td>
      <td class="r"><input class="num" data-i="${i}" value="${o.price != null ? o.price : ''}"></td>
      <td class="r">${fmt(o.amount)}</td><td>${esc(o.price_src)}${bu}</td><td class="c">${esc(o.adopt_ym)}</td><td class="c">${confTag(o.conf)}</td>
      <td class="src">${esc(o.adopt_from)}</td><td>${ref}</td><td class="src">${esc(hint)}</td>
      <td class="c"><button class="small ghost" data-tog="${i}">候補 ${o.cands ? o.cands.length : 0}</button></td></tr>
      <tr class="cands" id="cand-${i}" style="display:none"><td colspan="12">${candTable(o.cands, true)}</td></tr>`;
  });
  h += '</table>';
  const el = $('#tab-uchiwake'); el.innerHTML = h;
  el.querySelectorAll('input.num').forEach(inp => inp.onchange = () => { const o = R.uchiwake[+inp.dataset.i]; const v = parseFloat(inp.value.replace(/,/g, '')); o.price = isNaN(v) ? null : v; o.price_src = '手入力'; o.conf = '手'; o.adopt_ym = ''; o.adopt_from = ''; recalc(); renderUchiwake(); });
  el.querySelectorAll('button[data-tog]').forEach(b => b.onclick = () => { const t = $('#cand-' + b.dataset.tog); t.style.display = t.style.display === 'none' ? '' : 'none'; });
  el.querySelectorAll('tr.cands').forEach(tr => tr.querySelectorAll('button[data-pick]').forEach(b => b.onclick = () => {
    const i = +tr.id.split('-')[1]; const o = R.uchiwake[i]; const c = o.cands[+b.dataset.pick];
    o.price = c.price; o.price_src = '過去単価'; o.conf = c.score >= 0.9 ? '◎' : c.score >= 0.8 ? '○' : '△'; o.adopt_ym = c.tanka_ym; o.adopt_from = `${c.no} ${c.kenmei}（${c.hacchu}）`;
    recalc(); renderUchiwake();
  }));
  el.querySelectorAll('button[data-bu]').forEach(b => b.onclick = () => { const o = R.uchiwake[+b.dataset.bu]; o.price = o.buildup.price; o.price_src = '積上げ'; o.conf = '○'; o.adopt_ym = '（代価表の各行）'; o.adopt_from = `第${o.buildup.dno}号代価表の積上げ`; recalc(); renderUchiwake(); });
  el.querySelectorAll('button[data-dr]').forEach(b => b.onclick = () => { const o = R.uchiwake[+b.dataset.dr]; const d = o.direct; o.price = d.price; o.price_src = '過去単価'; o.conf = d.conf; o.adopt_ym = d.adopt_ym; o.adopt_from = `${d.no} ${d.kenmei}（${d.hacchu}）`; recalc(); renderUchiwake(); });
}
function daikaRecalc(d) {
  let total = 0, complete = true, base = 0, labor = 0, flagged = false, zr = null;
  d.rows.forEach(r => {
    if (r.kind === '諸雑費') { zr = r; return; }
    r.amount = (r.qty != null && r.price != null) ? Math.round(r.qty * r.price) : null;
    if (r.amount == null) complete = false; else { total += r.amount; if (r.zatsu_target) { base += r.amount; flagged = true; } if (r.kind === '労務') labor += r.amount; }
  });
  if (zr && zr.rate != null) { zr.amount = Math.round((flagged ? base : labor) * zr.rate / 100); total += zr.amount; }
  d.complete = complete; d.total = complete ? total : null; d.unit_price = (complete && d.per_qty) ? Math.round(total / d.per_qty * 100) / 100 : null;
}
function renderDaika() {
  const el = $('#tab-daika');
  let h = '<div class="muted">代価表の構成行（労務・材料・機械）に過去の単価を当て、合計から「単位当り単価」を出しています。労務・機械は対象年月に近い年度、その他は最新を選んでいます。</div>';
  R.daika.forEach((d, di) => {
    daikaRecalc(d);
    h += `<div class="block"><h3>${d.sub ? '別紙代価表 ' : '第' + d.dno + '号一位代価表　'}${esc(d.title)} <span class="muted">（${fmtP(d.per_qty)}${esc(d.per_unit)} 当り${d.hokkake_title ? '　歩掛: ' + esc(d.hokkake_title) : ''}）</span></h3>
      <table><tr><th>名称</th><th>規格</th><th>単位</th><th>数量</th><th>単価</th><th>金額</th><th>採用年月</th><th>出典（設計書番号 工事名）</th><th>信頼度</th><th>過去の幅（件数）</th><th>数量の出どころ</th><th></th></tr>`;
    d.rows.forEach((r, ri) => {
      const s = r.sug;
      if (r.kind === '諸雑費') { h += `<tr><td>${esc(r.name)}</td><td></td><td class="c">${esc(r.unit)}</td><td></td><td class="r">${r.rate != null ? r.rate + '%' : ''}</td><td class="r">${fmt(r.amount)}</td><td colspan="6" class="muted">${r.rate != null ? '率（歩掛より）' : '率が読めません'}</td></tr>`; return; }
      h += `<tr><td>${esc(r.name)}</td><td class="src">${esc(r.kikaku)}</td><td class="c">${esc(r.unit)}</td><td class="r">${fmtP(r.qty)}</td>
        <td class="r"><input class="num" data-d="${di}" data-r="${ri}" value="${r.price != null ? r.price : ''}"></td>
        <td class="r">${fmt(r.amount)}</td><td class="c">${esc(s ? s.adopt_ym : '')}</td><td class="src">${s ? esc(s.no + ' ' + s.kenmei) : ''}</td><td class="c">${confTag(s ? s.conf : '')}</td>
        <td class="r">${s ? `${fmtP(s.min)} 〜 ${fmtP(s.max)}（${s.n}件）` : ''}</td><td class="c">${esc(r.qty_src)}</td>
        <td class="c">${r.cands && r.cands.length ? `<button class="small ghost" data-tog="d-${di}-${ri}">候補 ${r.cands.length}</button>` : ''}</td></tr>
        <tr class="cands" id="cand-d-${di}-${ri}" style="display:none"><td colspan="12">${candTable(r.cands, true)}</td></tr>`;
    });
    h += `<tr class="parent"><td colspan="5">合計</td><td class="r">${fmt(d.total)}</td><td colspan="6" class="${d.complete ? '' : 'warn'}">${d.complete ? '' : '単価が見つからない行があるため未完成: ' + esc((d.missing || []).join('、'))}</td></tr>
      <tr class="parent"><td colspan="5">単位当り単価（${fmtP(d.per_qty)}${esc(d.per_unit)} 当り）</td><td class="r">${fmtP(d.unit_price)}</td><td colspan="6"></td></tr></table></div>`;
  });
  el.innerHTML = h;
  el.querySelectorAll('input.num').forEach(inp => inp.onchange = () => { const d = R.daika[+inp.dataset.d], r = d.rows[+inp.dataset.r]; const v = parseFloat(inp.value.replace(/,/g, '')); r.price = isNaN(v) ? null : v; r.sug = r.sug ? Object.assign({}, r.sug, { adopt_ym: '手入力', conf: '手' }) : { adopt_ym: '手入力', conf: '手', n: 0 }; syncBuildup(); renderDaika(); renderUchiwake(); });
  el.querySelectorAll('button[data-tog]').forEach(b => b.onclick = () => { const t = $('#cand-' + b.dataset.tog); t.style.display = t.style.display === 'none' ? '' : 'none'; });
  el.querySelectorAll('tr.cands').forEach(tr => tr.querySelectorAll('button[data-pick]').forEach(b => b.onclick = () => {
    const [, di, ri] = tr.id.split('-').slice(1).map(Number); const d = R.daika[di], r = d.rows[ri], c = r.cands[+b.dataset.pick];
    r.price = c.price; r.sug = Object.assign({}, r.sug || {}, { price: c.price, adopt_ym: c.tanka_ym, no: c.no, kenmei: c.kenmei, hacchu: c.hacchu, conf: c.score >= 0.9 ? '◎' : c.score >= 0.8 ? '○' : '△' });
    syncBuildup(); renderDaika(); renderUchiwake();
  }));
}
function syncBuildup() {
  R.daika.forEach(daikaRecalc);
  const by = {}; R.daika.forEach(d => { if (d.dno != null) by[d.dno] = d; });
  R.summary.n_daika_complete = R.daika.filter(d => d.complete).length;
  R.uchiwake.forEach(o => { if (o.leaf && o.buildup && by[o.dno]) { const d = by[o.dno]; o.buildup.price = d.unit_price; o.buildup.complete = d.complete; o.buildup.missing = d.missing; if (o.price_src === '積上げ') o.price = d.unit_price; } });
  recalc();
}
function renderShizai() {
  let h = `<table><tr><th>行</th><th>品名</th><th>規格・寸法</th><th>単位</th><th>県の出典</th><th>過去単価</th><th>採用年月</th><th>出典（設計書番号 工事名）</th><th>信頼度</th><th>過去の幅（件数）</th><th></th></tr>`;
  R.shizai.forEach((s, i) => {
    const g = s.sug;
    h += `<tr><td class="c">${s.row}</td><td>${esc(s.name)}</td><td class="src">${esc(s.kikaku)}</td><td class="c">${esc(s.unit)}</td><td class="c">${esc(s.src)}</td>
      <td class="r">${fmtP(s.price)}</td><td class="c">${esc(s.adopt_ym)}</td><td class="src">${g ? esc(g.no + ' ' + g.kenmei + '（' + g.hacchu + '）') : ''}</td><td class="c">${confTag(g ? g.conf : '')}</td>
      <td class="r">${g ? `${fmtP(g.min)} 〜 ${fmtP(g.max)}（${g.n}件）` : ''}</td><td class="c">${s.cands && s.cands.length ? `<button class="small ghost" data-tog="s-${i}">候補 ${s.cands.length}</button>` : ''}</td></tr>
      <tr class="cands" id="cand-s-${i}" style="display:none"><td colspan="11">${candTable(s.cands, false)}</td></tr>`;
  });
  h += '</table>';
  if (!R.shizai.length) h = '<div class="muted">積算参考資料の資材単価一覧表が見つかりませんでした。</div>';
  const el = $('#tab-shizai'); el.innerHTML = h;
  el.querySelectorAll('button[data-tog]').forEach(b => b.onclick = () => { const t = $('#cand-' + b.dataset.tog); t.style.display = t.style.display === 'none' ? '' : 'none'; });
}
function renderKeihi() {
  const m = R.meta;
  let h = `<div class="muted">同じ主たる工種の過去設計書の諸経費率（率分÷直接工事費 の平均）。県の率は率式で規模により変わるため参考値。Excelの「経費」シートで変えられます。</div>
    <div class="meta" style="margin:8px 0"><div><b>経費適用年月</b>${esc(m.keihi_ym)}</div><div><b>主たる工種</b>${esc(m.shu_koushu)}</div><div><b>施工地域</b>${esc(m.chiiki)}</div><div><b>共通仮設費率補正</b>${esc(m.hosei_kyoutsu)}</div><div><b>現場管理費率補正</b>${esc(m.hosei_genba)}</div></div>
    <table><tr><th>主たる工種</th><th>件数</th><th>共通仮設費率 %</th><th>現場管理費率 %</th><th>一般管理費率 %</th><th>直接工事費の平均</th></tr>`;
  R.keihi_ref.forEach(k => { h += `<tr><td>${esc(k.shu_koushu)}</td><td class="r">${k.n}</td><td class="r">${k.kasetsu}</td><td class="r">${k.genkan}</td><td class="r">${k.ippan}</td><td class="r">${fmt(k.chok)}</td></tr>`; });
  $('#tab-keihi').innerHTML = h + '</table>';
}

// ------------------------------------------------------------ 単価を探す
$('#s-go').onclick = () => {
  if (!M) return;
  const kind = $('#s-kind').value, q = $('#s-q').value, kk = $('#s-kikaku').value, u = $('#s-unit').value;
  const ym = R ? R.meta.tanka_ym : $('#s-ym').value, hac = R ? R.meta.hacchu : '';
  let c;
  if (kind === 'uchiwake') c = M.searchUchiwake(q, u, ym, hac, 30);
  else if (kind === 'daika') c = M.searchDaika(q, kk, u, ym, hac, '', 30);
  else c = M.searchMaterial(q, kk, u, ym, hac, 30);
  const mode = ['労務', '機械'].includes(kindOfRow(q, u)) ? 'closest' : 'latest';
  const s = Matcher.suggest(c, mode, ym);
  $('#s-out').innerHTML = (s ? `<div style="margin-bottom:8px">採用案：<b>${fmtP(s.price)}</b> 円 ${confTag(s.conf)}　採用年月 ${esc(s.pick.tanka_ym)}　${esc(s.pick.no)} ${esc(s.pick.kenmei)}（${esc(s.pick.hacchu)}）　過去の幅 ${fmtP(s.min)} 〜 ${fmtP(s.max)}（${s.n}件）</div>` : '<div class="muted">採用できる候補がありません（下の一覧は近さ順）</div>') + candTable(c, false);
};
$('#s-q').addEventListener('keydown', e => { if (e.key === 'Enter') $('#s-go').click(); });

// ------------------------------------------------------------ 仕様書に書き込む（PDF）
$('#writepdf').onclick = async () => {
  if (!R) return;
  const buf = SRC.get(R.meta.file);
  if (!buf) { $('#saved').textContent = '元の仕様書PDFが見つかりません（読み込み直してください）'; return; }
  $('#writepdf').disabled = true; $('#saved').textContent = '仕様書に書き込み中…';
  try {
    const bytes = await writeShiyousho(R, buf);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const name = defaultPdfName(R);
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    $('#saved').textContent = 'ダウンロードしました: ' + name + '（元のPDFはそのまま。書き込んだ方が別ファイルです）';
  } catch (e) { console.error(e); $('#saved').textContent = '失敗: ' + (e.message || e); }
  finally { $('#writepdf').disabled = false; }
};

// ------------------------------------------------------------ Excel
$('#export').onclick = async () => {
  if (!R) return;
  $('#export').disabled = true; $('#saved').textContent = '作成中…';
  try {
    const buf = await buildXlsx(R);
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const name = defaultName(R);
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    $('#saved').textContent = 'ダウンロードしました: ' + name;
  } catch (e) { console.error(e); $('#saved').textContent = '失敗: ' + (e.message || e); }
  finally { $('#export').disabled = false; }
};
