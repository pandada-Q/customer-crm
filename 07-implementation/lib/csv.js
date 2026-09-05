'use strict';
// 容错 CSV 解析：支持引号字段（字段内逗号/换行）；
// 行字段数多于表头时，优先做「智能错位列对齐」——尝试把相邻两格合并还原（修复未加引号的误拆，
// 如 备份0812 秦岚「深圳市创新,科技有限公司」），并做列类型校验；
// 无法置信对齐的行进入 unresolved，由上层转人工待确认（不静默错位入库）。

// 按表头名推断该列的值类型校验器；返回 null 表示该列不校验
function headerValidator(headerName) {
  const h = String(headerName || '').trim().toLowerCase();
  const mobRe = /^1[3-9]\d{9}$/;
  const landRe = /^0\d{2,3}-?\d{7,8}$/;
  if (/手机|mobile|电话|phone|号码/.test(h)) return v => mobRe.test(v) || landRe.test(v);
  if (/城市|city|地区|所在地/.test(h)) return v => !/^\d+$/.test(v) && !mobRe.test(v);
  if (/日期|时间|date|最近联系|联系时间/.test(h)) {
    return v => /^(\d{4}[-/年.]\d{1,2}([-/月.]\d{1,2}日?)?|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4,5})$/.test(v);
  }
  if (/^(id|编号|序号|工号|编码)$/.test(h)) return v => /^\d+$/.test(v);
  if (/录入人|操作员|负责人/.test(h)) return v => /^[\u4e00-\u9fa5A-Za-z·]{1,6}$/.test(v);
  if (/姓名|^name$|联系人/.test(h)) return v => /^[\u4e00-\u9fa5·]{1,8}$/.test(v) || /^[A-Za-z][A-Za-z .'-]{0,30}$/.test(v);
  if (/公司|company|单位/.test(h)) return v => !/^\d+$/.test(v) && !mobRe.test(v) && !/^\d{4}[-/年]/.test(v);
  if (/邮箱|email/.test(h)) return v => /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(v);
  return null;
}

// 错位修复：cells.length = header.length + 1（恰好多 1 格 = 某字段被一个未加引号逗号拆开）。
// 逐位尝试把相邻两格合并，按列类型校验，选「零冲突」的合并位；命中公司类列优先。
// 返回对齐后的 cells（长度 = header.length）；无法置信修复返回 null。
function smartAlign(header, cells) {
  if (cells.length !== header.length + 1) return null;
  const validators = header.map(headerValidator);
  if (validators.filter(Boolean).length < 2) return null; // 类型线索太少，不冒险猜测

  const build = k => {
    const out = [];
    for (let j = 0; j < cells.length; j++) {
      if (j === k) out.push((cells[j] + cells[j + 1]).trim()); // 合并还原（不保留误插的逗号）
      else if (j !== k + 1) out.push(cells[j]);
    }
    return out;
  };

  const candidates = [];
  for (let k = 0; k < cells.length - 1; k++) {
    const aligned = build(k);
    let violations = 0, checked = 0;
    for (let c = 0; c < header.length; c++) {
      const val = (aligned[c] || '').trim();
      if (!val) continue;
      if (validators[c]) { checked++; if (!validators[c](val)) violations++; }
    }
    if (checked === 0) continue;
    candidates.push({ k, violations });
  }
  const zero = candidates.filter(x => x.violations === 0);
  if (zero.length === 0) return null;
  const companyish = idx => /公司|company|单位/.test(String(header[idx] || ''));
  zero.sort((a, b) => (companyish(b.k) - companyish(a.k)) || (a.k - b.k));
  return build(zero[0].k);
}

function parseCSV(text) {
  const rows = [];
  const unresolved = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { pushField(); i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { pushRow(); i++; continue; }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) pushRow();

  if (rows.length === 0) return { rows: [], unresolved };
  const header = rows[0].map(h => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    let cells = rows[r];
    if (cells.length === 1 && cells[0].trim() === '') continue; // 空行
    if (cells.length > header.length) {
      const fixed = smartAlign(header, cells);
      if (fixed) cells = fixed;
      else { unresolved.push({ line: cells.join(','), index: r }); continue; } // 无法置信 → 交人工
    }
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (cells[idx] !== undefined ? cells[idx] : '').trim(); });
    out.push(obj);
  }
  return { rows: out, unresolved };
}

// 简易 CSV 序列化（用于规整数据导出，交付物①）
function toCSV(rows, columns) {
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = columns.map(esc).join(',');
  const body = rows.map(r => columns.map(c => esc(r[c])).join(',')).join('\n');
  return head + '\n' + body + '\n';
}

module.exports = { parseCSV, toCSV, smartAlign, headerValidator };
