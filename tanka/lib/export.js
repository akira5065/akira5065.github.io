// 結果を仕様書と同じ並びの Excel にする（_tools/export_xlsx.py の移植、ExcelJS 使用）
/* global ExcelJS */
export const CREDIT = '株式会社新井設備工業 開発';

const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDE7F0' } };
const SUB_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6F9' } };
const CONF_FILL = {
  '◎': { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2F0D9' } },
  '○': { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDEEBF7' } },
  '△': { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } },
  '': { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7DA' } },
};
const THIN = { style: 'thin', color: { argb: 'FFBBBBBB' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const NUM0 = '#,##0', NUM2 = '#,##0.00', QTY = '#,##0.##';
const fillFor = c => CONF_FILL[c] || CONF_FILL[''];

function hdr(ws, row, labels, widths) {
  labels.forEach((t, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = t; c.font = { bold: true }; c.fill = HEAD_FILL; c.border = BORDER;
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  if (widths) widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}
const fmt1 = v => (Math.round(v * 10) / 10).toLocaleString('ja-JP');
const rng = s => (s && s.n) ? `${fmt1(s.min)} 〜 ${fmt1(s.max)}` : '';
const from = s => s ? `${s.no || ''} ${s.kenmei || ''}（${s.hacchu || ''}）` : '';
const nkey = s => (s || '').replace(/[\s（）()【】]/g, '');
const setNum = (c, v, f) => { c.value = v; c.numFmt = f; return c; };

export async function buildXlsx(result) {
  const wb = new ExcelJS.Workbook();
  wb.creator = CREDIT;
  const wsU = wb.addWorksheet('内訳書');
  const wsD = wb.addWorksheet('代価表');
  const wsS = wb.addWorksheet('資材');
  const wsC = wb.addWorksheet('候補一覧');
  const wsK = wb.addWorksheet('経費');
  const wsI = wb.addWorksheet('工事情報');
  const dcells = sheetDaika(wsD, result);
  const rate = sheetKeihi(wsK, result);
  sheetUchiwake(wsU, result, dcells, rate);
  sheetShizai(wsS, result);
  sheetCands(wsC, result);
  sheetInfo(wsI, result);
  return await wb.xlsx.writeBuffer();
}

function sheetUchiwake(ws, result, dcells, rate) {
  const meta = result.meta;
  ws.getCell('A1').value = meta.kouji_mei || '';
  ws.getCell('A1').font = { bold: true, size: 13 };
  ws.getCell('A2').value = `単価適用年月 ${meta.tanka_ym || ''} ／ 主たる工種 ${meta.shu_koushu || ''} ／ 施工地域 ${meta.chiiki || ''} ／ 作成 ${meta.made_at || ''} ／ 過去設計書 単価当てアプリ（${CREDIT}）`;
  ws.getCell('A3').value = '単価は過去の県設計書から当てた「参考値」。信頼度 ◎=名称と仕様が一致 ○=名称一致 △=近い名称のみ。黄色の単価は必ず確認してから使うこと。';
  ws.getCell('A3').font = { color: { argb: 'FFAA0000' } };
  const labels = ['階層', '名称', '単位', '数量', '単価', '金額', '単価の出どころ', '採用年月', '信頼度', '出典（設計書番号 工事名 発注機関）', '過去の同名単価（参考）', 'その採用年月', '過去の幅（最小〜最大・件数）', '摘要・ヒント'];
  const HR = 5;
  hdr(ws, HR, labels, [5, 44, 6, 10, 13, 15, 11, 22, 6, 48, 14, 13, 24, 18]);
  const rows = result.uchiwake;
  const rownum = new Map(rows.map((o, k) => [o.idx, HR + 1 + k]));
  const nameRow = new Map();
  for (const o of rows) if (!nameRow.has(nkey(o.name))) nameRow.set(nkey(o.name), rownum.get(o.idx));
  const children = o => {
    // 同じ区分（本体／経費）の中だけで子を探す。直接工事費(L1)を本体(L0)の子に数えると循環する
    const out = [];
    for (let i = rows.indexOf(o) + 1; i < rows.length && rows[i].level > o.level && rows[i].section === o.section; i++) if (rows[i].level === o.level + 1) out.push(rows[i]);
    return out;
  };
  const topMain = rows.filter(o => o.level === 0 && o.section === '本体');
  for (const o of rows) {
    const r = rownum.get(o.idx);
    ws.getCell(r, 1).value = o.level;
    const c = ws.getCell(r, 2); c.value = '　'.repeat(o.level) + o.name;
    ws.getCell(r, 3).value = o.unit;
    if (o.qty !== null && o.qty !== undefined) setNum(ws.getCell(r, 4), o.qty, QTY);
    if (o.leaf) {
      const pc = ws.getCell(r, 5);
      if (o.price !== null && o.price !== undefined) {
        if (o.price_src === '積上げ' && dcells.has(o.dno)) pc.value = { formula: `'代価表'!${dcells.get(o.dno)}` };
        else pc.value = o.price;
        pc.numFmt = NUM2; pc.fill = fillFor(o.conf);
      } else pc.fill = fillFor('');
      if (o.qty !== null && o.qty !== undefined) ws.getCell(r, 6).value = { formula: `IF(E${r}="","",ROUND(D${r}*E${r},0))` };
      ws.getCell(r, 7).value = o.price_src;
      ws.getCell(r, 8).value = o.adopt_ym;
      ws.getCell(r, 9).value = o.conf || '候補なし';
      ws.getCell(r, 10).value = o.adopt_from;
      const d = o.direct;
      if (d) { setNum(ws.getCell(r, 11), d.price, NUM2); ws.getCell(r, 12).value = d.adopt_ym; ws.getCell(r, 13).value = `${rng(d)}（${d.n}件）`; }
      let hint = o.hint || '';
      if (o.hintcalc) hint = (hint + ' → ' + o.hintcalc.from).trim();
      ws.getCell(r, 14).value = hint;
    } else {
      c.font = { bold: true };
      const kids = children(o);
      if (kids.length) ws.getCell(r, 6).value = { formula: `SUM(${kids.map(k => 'F' + rownum.get(k.idx)).join(',')})` };
    }
    ws.getCell(r, 6).numFmt = NUM0;
    for (let col = 1; col <= labels.length; col++) ws.getCell(r, col).border = BORDER;
  }
  const cell = name => { const rr = nameRow.get(nkey(name)); return rr ? 'F' + rr : null; };
  const put = (name, formula) => { const rr = nameRow.get(nkey(name)); if (rr && formula) { ws.getCell(rr, 6).value = { formula }; ws.getCell(rr, 6).numFmt = NUM0; ws.getCell(rr, 2).font = { bold: true }; } };
  if (topMain.length) put('直接工事費', `SUM(${topMain.map(o => 'F' + rownum.get(o.idx)).join(',')})`);
  if (cell('直接工事費')) {
    put('共通仮設費(率分)', `ROUND(${cell('直接工事費')}*${rate.kasetsu}/100,0)`);
    if (cell('共通仮設費(積分)')) put('共通仮設費計', `${cell('共通仮設費(積分)')}+${cell('共通仮設費(率分)')}`);
    else put('共通仮設費計', `${cell('共通仮設費(率分)')}`);
    put('純工事費', `${cell('直接工事費')}+${cell('共通仮設費計')}`);
    put('現場管理費', `ROUND(${cell('純工事費')}*${rate.genkan}/100,0)`);
    put('工事原価計', `${cell('純工事費')}+${cell('現場管理費')}`);
    put('一般管理費等', `ROUND(${cell('工事原価計')}*${rate.ippan}/100,0)`);
    put('工事価格', `${cell('工事原価計')}+${cell('一般管理費等')}`);
    put('消費税相当額', `ROUND(${cell('工事価格')}*0.1,0)`);
    put('工事費合計', `${cell('工事価格')}+${cell('消費税相当額')}`);
  }
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: HR }];
}

function sheetDaika(ws, result) {
  ws.getCell('A1').value = '一位代価表の積上げ（構成行の単価は過去設計書から。採用年月を必ず見ること）';
  ws.getCell('A1').font = { bold: true, size: 12 };
  const labels = ['名称', '規格', '単位', '数量', '単価', '金額', '採用年月', '出典（設計書番号 工事名）', '信頼度', '過去の幅', '数量の出どころ'];
  hdr(ws, 2, labels, [34, 36, 6, 9, 13, 14, 13, 44, 6, 20, 10]);
  let r = 4;
  const dcells = new Map(), subcells = new Map();
  const blocks = [...result.daika.filter(d => d.sub), ...result.daika.filter(d => !d.sub)];
  const per = d => `${(d.per_qty || 1).toLocaleString('ja-JP', { maximumFractionDigits: 3 })}${d.per_unit || ''}`;
  for (const d of blocks) {
    ws.getCell(r, 1).value = d.sub ? `別紙代価表 ${d.title}` : `第${d.dno}号一位代価表　${d.title}`;
    ws.getCell(r, 1).font = { bold: true };
    ws.getCell(r, 4).value = `${per(d)} 当り`;
    for (let col = 1; col <= labels.length; col++) ws.getCell(r, col).fill = SUB_FILL;
    r++;
    const amountCells = [], targetCells = [], laborCells = [];
    let zatsuRow = null;
    for (const row of d.rows) {
      ws.getCell(r, 1).value = row.name; ws.getCell(r, 2).value = row.kikaku || ''; ws.getCell(r, 3).value = row.unit;
      if (row.kind === '諸雑費') {
        zatsuRow = [r, row.rate];
        ws.getCell(r, 5).value = row.rate ?? null; ws.getCell(r, 5).numFmt = '0.0"%"'; ws.getCell(r, 11).value = '率';
      } else {
        if (row.qty !== null && row.qty !== undefined) setNum(ws.getCell(r, 4), row.qty, QTY);
        const sug = row.sug;
        const sp = subcells.get(nkey(row.name));
        const pc = ws.getCell(r, 5);
        if (sp) pc.value = { formula: sp }; else if (row.price !== null && row.price !== undefined) pc.value = row.price;
        pc.numFmt = NUM2; pc.fill = fillFor(sug ? sug.conf : '');
        if (row.qty !== null && row.qty !== undefined) {
          ws.getCell(r, 6).value = { formula: `IF(E${r}="","",ROUND(D${r}*E${r},0))` };
          amountCells.push('F' + r);
          if (row.zatsu_target) targetCells.push('F' + r);
          if (row.kind === '労務') laborCells.push('F' + r);
        }
        ws.getCell(r, 7).value = sug ? sug.adopt_ym : ''; ws.getCell(r, 8).value = from(sug);
        ws.getCell(r, 9).value = (sug && sug.conf) || '候補なし'; ws.getCell(r, 10).value = rng(sug); ws.getCell(r, 11).value = row.qty_src || '';
      }
      ws.getCell(r, 6).numFmt = NUM0;
      for (let col = 1; col <= labels.length; col++) ws.getCell(r, col).border = BORDER;
      r++;
    }
    if (zatsuRow) {
      const [zr, rate] = zatsuRow;
      const base = targetCells.length ? targetCells : laborCells;
      if (base.length && rate !== null && rate !== undefined) { ws.getCell(zr, 6).value = { formula: `ROUND(SUM(${base.join(',')})*E${zr}/100,0)` }; amountCells.push('F' + zr); }
      ws.getCell(zr, 6).numFmt = NUM0;
    }
    ws.getCell(r, 1).value = '合計'; ws.getCell(r, 1).font = { bold: true };
    if (amountCells.length) ws.getCell(r, 6).value = { formula: `SUM(${amountCells.join(',')})` };
    ws.getCell(r, 6).numFmt = NUM0;
    r++;
    ws.getCell(r, 1).value = `単位当り単価（合計 ÷ ${per(d)}）`; ws.getCell(r, 1).font = { bold: true };
    ws.getCell(r, 6).value = { formula: `IF(F${r - 1}="","",F${r - 1}/${d.per_qty || 1})` };
    ws.getCell(r, 6).numFmt = NUM2; ws.getCell(r, 6).font = { bold: true };
    if (d.missing && d.missing.length) { ws.getCell(r, 8).value = '単価が見つからない行: ' + d.missing.join('、'); ws.getCell(r, 8).font = { color: { argb: 'FFAA0000' } }; }
    if (d.sub) subcells.set(nkey(d.title), 'F' + r); else if (d.dno !== null) dcells.set(d.dno, 'F' + r);
    r += 2;
  }
  ws.views = [{ state: 'frozen', ySplit: 2 }];
  return dcells;
}

function sheetKeihi(ws, result) {
  ws.getCell('A1').value = '諸経費率（内訳書の率分がここを参照）'; ws.getCell('A1').font = { bold: true, size: 12 };
  ws.getCell('A2').value = '参考値。県の率は率式で工事規模により変わるので、必ず自分で決めること。'; ws.getCell('A2').font = { color: { argb: 'FFAA0000' } };
  const ref = result.keihi_ref || [];
  const top = ref[0] || {};
  const items = [['共通仮設費率(%)', top.kasetsu, 'kasetsu'], ['現場管理費率(%)', top.genkan, 'genkan'], ['一般管理費等率(%)', top.ippan, 'ippan']];
  const cells = {};
  items.forEach(([lab, val, key], i) => {
    const r = 4 + i;
    ws.getCell(r, 1).value = lab; ws.getCell(r, 1).font = { bold: true };
    ws.getCell(r, 2).value = (val === null || val === undefined) ? 0 : val; ws.getCell(r, 2).fill = CONF_FILL['△'];
    cells[key] = `'経費'!$B$${r}`;
  });
  ws.getCell('A8').value = '過去の設計書の実績（主たる工種ごとの平均）'; ws.getCell('A8').font = { bold: true };
  hdr(ws, 9, ['主たる工種', '件数', '共通仮設費率%', '現場管理費率%', '一般管理費率%', '直接工事費の平均'], [28, 8, 14, 14, 14, 18]);
  ref.forEach((k, i) => {
    const r = 10 + i;
    ws.getCell(r, 1).value = k.shu_koushu; ws.getCell(r, 2).value = k.n; ws.getCell(r, 3).value = k.kasetsu;
    ws.getCell(r, 4).value = k.genkan; ws.getCell(r, 5).value = k.ippan; setNum(ws.getCell(r, 6), k.chok, NUM0);
  });
  const meta = result.meta;
  ws.getCell('A18').value = '仕様書の経費条件'; ws.getCell('A18').font = { bold: true };
  [['経費適用年月', meta.keihi_ym], ['主たる工種', meta.shu_koushu], ['施工地域', meta.chiiki], ['共通仮設費率補正', meta.hosei_kyoutsu], ['現場管理費率補正', meta.hosei_genba]]
    .forEach(([k, v], i) => { ws.getCell(19 + i, 1).value = k; ws.getCell(19 + i, 2).value = v ?? ''; });
  return cells;
}

function sheetShizai(ws, result) {
  ws.getCell('A1').value = '資材単価一覧表（積算参考資料）に当てた過去単価'; ws.getCell('A1').font = { bold: true, size: 12 };
  hdr(ws, 3, ['行', '品名', '規格・寸法', '単位', '県の出典', '過去単価', '採用年月', '出典（設計書番号 工事名）', '信頼度', '過去の幅', '件数', '摘要'], [4, 26, 40, 8, 14, 12, 13, 44, 6, 20, 5, 20]);
  (result.shizai || []).forEach((s, i) => {
    const r = 4 + i, sug = s.sug;
    const vals = [s.row, s.name, s.kikaku, s.unit, s.src, s.price, s.adopt_ym, from(sug), (sug && sug.conf) || '候補なし', rng(sug), sug ? sug.n : '', s.note];
    vals.forEach((v, j) => { const c = ws.getCell(r, j + 1); c.value = v ?? null; c.border = BORDER; });
    ws.getCell(r, 6).numFmt = NUM2; ws.getCell(r, 6).fill = fillFor(sug ? sug.conf : '');
  });
}

function sheetCands(ws, result) {
  ws.getCell('A1').value = '見つかった候補（採用しなかったものも含む）。スコアは 1 に近いほど名称・規格・単位が近い'; ws.getCell('A1').font = { bold: true, size: 12 };
  hdr(ws, 3, ['区分', '当てたい行', '順位', '候補の出どころ', '候補の名称', '規格', '単位', '単価', '採用年月', '設計書番号', '工事名', '発注機関', 'スコア', '判定の内訳'], [8, 30, 5, 10, 34, 30, 6, 12, 13, 13, 40, 22, 7, 30]);
  let r = 4;
  const dump = (kind, label, cands) => {
    cands.forEach((c, k) => {
      [kind, label, k + 1, c.source, c.name, c.kikaku || '', c.unit, c.price, c.tanka_ym, c.no, c.kenmei, c.hacchu, c.score, c.why]
        .forEach((v, j) => { ws.getCell(r, j + 1).value = v ?? null; });
      ws.getCell(r, 8).numFmt = NUM2;
      r++;
    });
  };
  for (const o of result.uchiwake) if (o.leaf && o.cands && o.cands.length) dump('内訳書', o.name, o.cands);
  for (const d of result.daika) for (const row of d.rows) if (row.cands && row.cands.length) dump('代価表', `第${d.dno ?? '別紙'}号 ${d.title} / ${row.name}`, row.cands);
  for (const s of result.shizai || []) if (s.cands && s.cands.length) dump('資材', s.name, s.cands);
  ws.views = [{ state: 'frozen', ySplit: 3 }];
}

function sheetInfo(ws, result) {
  const meta = result.meta, sm = result.summary;
  const rows = [['工事名', meta.kouji_mei], ['年度', meta.nendo], ['工事場所', meta.basho], ['路河川名', meta.rosen], ['工事大要', meta.taiyou],
    ['単価適用年月', meta.tanka_ym], ['経費適用年月', meta.keihi_ym], ['主たる工種', meta.shu_koushu], ['施工地域', meta.chiiki],
    ['発注機関（推定）', meta.hacchu], ['元の仕様書', meta.file], ['作成日時', meta.made_at], ['作成ツール', '過去設計書 単価当てアプリ　' + CREDIT], ['', ''],
    ['直接工事費（当てた単価での概算）', sm.direct_kouji], ['単価を当てた行', `${sm.n_priced} / ${sm.n_leaf}`], ['積上げが完成した代価表', `${sm.n_daika_complete} / ${sm.n_daika}`], ['', ''],
    ['注意', 'ここにある単価は過去の県設計書に載っていた設計単価で、当社の見積単価ではない。'],
    ['', 'スキャンPDFの設計書（全体の約4割）は数値化されておらず、候補に出てこない。'],
    ['', '採用年月が古いものは労務単価・資材単価の改定を考慮すること。'],
    ['', '信頼度 △ と「候補なし」は必ず自分で単価を決めること。']];
  rows.forEach(([k, v], i) => {
    ws.getCell(i + 1, 1).value = k; ws.getCell(i + 1, 1).font = { bold: true };
    const c = ws.getCell(i + 1, 2); c.value = v ?? ''; if (k.startsWith('直接工事費')) c.numFmt = NUM0;
  });
  ws.getColumn(1).width = 30; ws.getColumn(2).width = 90;
}

export function defaultName(result) {
  const name = ((result.meta || {}).kouji_mei || '単価当て').replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${name}_単価当て_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.xlsx`;
}
