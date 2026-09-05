'use strict';
// 首批量规整管线（02）：解析 8 份素材 → D1 统一 schema，合并/冲突/清洗/溯源/待办/意向初判
// 纯函数 + 文件系统读取；产出可被 03 直接导入的规整包。
const fs = require('fs');
const path = require('path');
const { parseCSV } = require('./csv');
const clean = require('./clean');
const ai = require('./ai');
const intent = require('./intent');
const { newId } = require('./store');
const { TextDecoder } = require('util');

// 按 BOM/内容自动判定编码（素材混合 UTF-8 / UTF-16 / GBK，需鲁棒读取）
function readText(p) {
  const buf = fs.readFileSync(p);
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return new TextDecoder('utf-8').decode(buf);
  const asUtf8 = new TextDecoder('utf-8').decode(buf);
  if (!asUtf8.includes('�')) return asUtf8;           // 无替换符 → 合法 UTF-8
  try { return new TextDecoder('gbk').decode(buf); }   // 退回 GBK（如 合作伙伴名单）
  catch (e) { return asUtf8; }
}

const FIELDS = ['name', 'company', 'mobile', 'landline', 'email', 'city', 'note', 'cooperationStatus', '录入人'];

function longest(arr) { return arr.reduce((a, b) => (b.length > a.length ? b : a), ''); }

// 单份素材 → 贡献列表（每个贡献带 source 与字段值）
function mapCsvRow(row, file, prevCompany) {
  const src = file;
  if (/备份0812/.test(file)) {
    return { source: src, f: {
      name: (row.姓名 || '').trim(), company: (row.公司 || '').trim(),
      mobile: clean.mobileSlot(row.手机), landline: clean.extractLandline(row.手机) || '',
      email: '', city: clean.normalizeCity(row.城市), note: row.最近联系 ? ('最近联系:' + row.最近联系) : '',
      cooperationStatus: '', 录入人: (row.录入人 || '').trim(), tags: []
    }};
  }
  if (/市场部/.test(file)) {
    let company = (row.公司 || '').trim();
    if (company === '同上' && prevCompany) company = prevCompany;
    return { source: src, f: {
      name: (row.姓名 || '').trim(), company,
      mobile: clean.mobileSlot(row.手机), landline: clean.extractLandline(row.手机) || '',
      email: (row.邮箱 || '').trim(), city: clean.normalizeCity(row.城市), note: (row.备注 || '').trim(),
      cooperationStatus: '', 录入人: '', tags: clean.normalizeTagList(row.标签)
    }};
  }
  if (/合作伙伴/.test(file)) {
    return { source: src, f: {
      name: (row.联系人 || '').trim(), company: (row.公司名称 || '').trim(),
      mobile: clean.mobileSlot(row.电话), landline: clean.extractLandline(row.电话) || '',
      email: '', city: clean.normalizeCity(row.所在地), note: '',
      cooperationStatus: (row.合作状态 || '').trim(), 录入人: '', tags: []
    }};
  }
  // 通用 CSV（新批次/更正清单等任意标准表头）：按 姓名/公司/手机/座机/邮箱/城市/备注/合作状态/标签 映射（D17/D20）
  if ('姓名' in row || 'name' in row) {
    const phone = row.手机 || row.mobile || '';
    return { source: src, f: {
      name: (row.姓名 || row.name || '').trim(),
      company: (row.公司 || row.company || '').trim(),
      mobile: clean.mobileSlot(phone),
      landline: clean.extractLandline(row.座机 || row.landline || phone) || '',
      email: (row.邮箱 || row.email || '').trim(),
      city: clean.normalizeCity(row.城市 || row.city),
      note: (row.备注 || row.note || '').trim(),
      cooperationStatus: (row.合作状态 || row.cooperationStatus || '').trim(),
      录入人: (row.录入人 || row.录入人 || '').trim(),
      tags: clean.normalizeTagList(row.标签 || row.tags)
    }};
  }
  return null;
}

// 解析单份文件内容为贡献列表 + 待办 + 低置信（被 parseInputFiles 与新批次上传复用）
function parseContent(file, text) {
  const lower = file.toLowerCase();
  const out = { raw: [], todos: [], lowconf: [], skipped: null };
  if (/\.(jpg|jpeg|png|gif)$/.test(lower)) { out.skipped = '图片/扫描件本版不处理（D9，损坏跳过）'; return out; }
  if (file === '初步需求和背景.txt') { out.skipped = '需求说明文档，非联系人素材'; return out; }

  if (lower.endsWith('.json')) {
    let arr; try { arr = JSON.parse(text); } catch { out.skipped = 'JSON 解析失败'; return out; }
    arr.forEach(o => {
      const cf = { source: file, f: {
        name: (o.name || '').trim(), company: (o.company || '').trim(),
        mobile: clean.mobileSlot(o.mobile), landline: clean.extractLandline(o.mobile) || '',
        email: (o.email || '').trim(), city: '', note: '', cooperationStatus: o.cooperationStatus || o.合作状态 || '', 录入人: '',
        tags: clean.normalizeTagList(o.tags)
      }};
      const fx = clean.repairFieldFormat(cf.f);
      if (fx.length) cf._fix = fx;
      out.raw.push(cf);
    });
    return out;
  }
  if (lower.endsWith('.csv')) {
    const { rows, unresolved } = parseCSV(text);
    let prevCompany = '';
    rows.forEach(r => { const c = mapCsvRow(r, file, prevCompany); if (c) { const fx = clean.repairFieldFormat(c.f); if (fx.length) c._fix = fx; out.raw.push(c); if (c.f.company) prevCompany = c.f.company; } });
    // 列数溢出且无法自动对齐的行：不静默错位入库，转待确认由人工核对（11 轮 ④ 兜底）
    for (const u of unresolved) {
      out.lowconf.push({ name: '', company: '', city: '', rawSnippet: u.line, note: '该行字段数多于表头且无法自动对齐（疑似字段内含未加引号的逗号或行格式有误），已跳过导入，请人工核对' });
    }
    return out;
  }
  if (lower.endsWith('.txt')) {
    // 同步入口固定用确定性 rule（离线/可测试）；大模型（DeepSeek）仅在异步上传链路 parseContentAsync 走，
    // 避免同步调用拿到 Promise 崩（provider 为 async 时）。
    const r = ai.extractFromFreeTextRule(text, file);
    r.records.forEach(rec => {
      const cf = { source: file, f: {
        name: rec.name, company: rec.company, mobile: clean.extractMobile(rec.mobile) || '',
        landline: clean.extractLandline(rec.landline) || '', email: (rec.email || '').trim(),
        city: rec.city, note: rec.note, cooperationStatus: rec.cooperationStatus || clean.normalizeCooperationStatus(rec.note || ''), 录入人: '', tags: clean.normalizeTagList(rec.tags)
      }};
      const fx = clean.repairFieldFormat(cf.f);
      if (fx.length) cf._fix = fx;
      out.raw.push(cf);
    });
    r.todos.forEach(t => out.todos.push(t));
    r.lowconf.forEach(l => out.lowconf.push(l));
    return out;
  }
  out.skipped = '未识别格式，跳过';
  return out;
}

// 异步版解析：自由文本（.txt）经大模型（DeepSeek/llm）抽取；结构化的 CSV/JSON 仍走确定性解析。
// 用于上传批处理的异步链路，不阻塞事件循环。
async function parseContentAsync(file, text) {
  const lower = file.toLowerCase();
  const out = { raw: [], todos: [], lowconf: [], skipped: null };
  if (/\.(jpg|jpeg|png|gif)$/.test(lower)) { out.skipped = '图片/扫描件本版不处理（D9，损坏跳过）'; return out; }
  if (file === '初步需求和背景.txt') { out.skipped = '需求说明文档，非联系人素材'; return out; }

  if (lower.endsWith('.json')) {
    let arr; try { arr = JSON.parse(text); } catch { out.skipped = 'JSON 解析失败'; return out; }
    arr.forEach(o => {
      const cf = { source: file, f: {
        name: (o.name || '').trim(), company: (o.company || '').trim(),
        mobile: clean.mobileSlot(o.mobile), landline: clean.extractLandline(o.mobile) || '',
        email: (o.email || '').trim(), city: '', note: '', cooperationStatus: o.cooperationStatus || o.合作状态 || '', 录入人: '',
        tags: clean.normalizeTagList(o.tags)
      }};
      const fx = clean.repairFieldFormat(cf.f);
      if (fx.length) cf._fix = fx;
      out.raw.push(cf);
    });
    return out;
  }
  if (lower.endsWith('.csv')) {
    const { rows, unresolved } = parseCSV(text);
    let prevCompany = '';
    rows.forEach(r => { const c = mapCsvRow(r, file, prevCompany); if (c) { const fx = clean.repairFieldFormat(c.f); if (fx.length) c._fix = fx; out.raw.push(c); if (c.f.company) prevCompany = c.f.company; } });
    // 列数溢出且无法自动对齐的行：不静默错位入库，转待确认由人工核对（11 轮 ④ 兜底）
    for (const u of unresolved) {
      out.lowconf.push({ name: '', company: '', city: '', rawSnippet: u.line, note: '该行字段数多于表头且无法自动对齐（疑似字段内含未加引号的逗号或行格式有误），已跳过导入，请人工核对' });
    }
    return out;
  }
  if (lower.endsWith('.txt')) {
    const r = await ai.extractFromFreeTextAsync(text, file);
    r.records.forEach(rec => {
      const cf = { source: file, f: {
        name: rec.name, company: rec.company, mobile: clean.extractMobile(rec.mobile) || '',
        landline: clean.extractLandline(rec.landline) || '', email: (rec.email || '').trim(),
        city: rec.city, note: rec.note, cooperationStatus: rec.cooperationStatus || clean.normalizeCooperationStatus(rec.note || ''), 录入人: '', tags: clean.normalizeTagList(rec.tags)
      }};
      const fx = clean.repairFieldFormat(cf.f);
      if (fx.length) cf._fix = fx;
      out.raw.push(cf);
    });
    r.todos.forEach(t => out.todos.push(t));
    r.lowconf.forEach(l => out.lowconf.push(l));
    return out;
  }
  out.skipped = '未识别格式，跳过';
  return out;
}

function parseInputFiles(inputDir) {
  const files = fs.readdirSync(inputDir).filter(f => !f.startsWith('.')).sort();
  const raw = [];
  const todos = [];
  const lowconf = [];
  const skipped = [];

  for (const f of files) {
    const p = path.join(inputDir, f);
    const text = readText(p);
    const r = parseContent(f, text);
    if (r.skipped) { skipped.push({ file: f, reason: r.skipped }); continue; }
    r.raw.forEach(c => raw.push(c));
    r.todos.forEach(t => todos.push(t));
    r.lowconf.forEach(l => lowconf.push(l));
  }
  return { raw, todos, lowconf, skipped, sourceFiles: files };
}

// union-find 合并：姓名+公司 相同 或 共享合法手机 → 同一人
function buildGroups(raw) {
  const n = raw.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { parent[find(a)] = find(b); };

  const personKey = i => {
    const f = raw[i].f;
    return (f.name || '').trim() + '|' + clean.companyKey(f.company);
  };
  const mobileOf = i => raw[i].f.mobile;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = raw[i].f, b = raw[j].f;
      // 同姓名 + 可确证同一家（处理 远大装饰↔远大装饰工程有限公司 等短全称）→ 同一人
      // 或同姓名且至少一方公司为空（如 冯军：备份0812 有公司+手机，王总微信仅座机无公司）→ 同一人
      if (a.name && b.name && a.name === b.name && (clean.sameCompany(a.company, b.company) || !a.company || !b.company)) { union(i, j); continue; }
      if (personKey(i) === personKey(j) && personKey(i) !== '|') { union(i, j); continue; }
      const mi = mobileOf(i), mj = mobileOf(j);
      if (mi && mj && mi === mj) union(i, j); // 共享合法手机 → 同一人（老周/周建国）
    }
  }
  const comps = {};
  for (let i = 0; i < n; i++) { const r = find(i); (comps[r] = comps[r] || []).push(i); }
  return Object.values(comps);
}

function conflictItem(contactId, field, entries) {
  const a = entries[0], b = entries[entries.length - 1];
  return {
    id: newId('p'), type: 'conflict', contactId, field,
    valueA: a.value, sourceA: a.sources.join('/'),
    valueB: b.value, sourceB: b.sources.join('/'),
    recommended: a.value, recommendedNote: '建议人工拍板（不静默取一）',
    status: 'open', resolution: null
  };
}

// 公司归一选值：sameCompany 多写法时取最常见来源写法，并列取最短（最规范）
// 例：众合机械(2 源) vs 众合机械设备有限公司(1 源) → 选众合机械，且不臆造冲突
function chooseCompany(compVals, fieldSrc) {
  let best = compVals[0], bestCount = -1;
  for (const v of compVals) {
    const cnt = (fieldSrc.company[v] instanceof Set) ? fieldSrc.company[v].size : 1;
    if (cnt > bestCount || (cnt === bestCount && v.length < best.length)) { best = v; bestCount = cnt; }
  }
  return best;
}

function mergeGroups(groups, raw) {
  const contacts = [];
  const pending = [];
  const removed = [];

  for (const comp of groups) {
    const contribs = comp.map(i => raw[i]);
    // 测试号 / 占位行 剔除（D5③）
    const anyTest = contribs.some(c => clean.isTestContact(c.f));
    const anyPlaceholder = contribs.every(c => clean.isPlaceholder(c.f)) && contribs.length > 0;
    if (anyTest) { removed.push({ reason: '测试号/测试邮箱', sample: contribs.map(c => c.f.name || c.f.email || c.f.mobile).join(',') }); continue; }
    if (anyPlaceholder) { removed.push({ reason: '占位行（空姓名+待补充公司）', sample: 'contacts_export.json 末行' }); continue; }

    const name = longest(contribs.map(c => c.f.name).filter(Boolean)) || contribs[0].f.name;
    const contact = {
      id: newId('c'), name, company: '', mobile: '', landline: '', email: '', city: '', note: '',
      cooperationStatus: '', 录入人: '', tags: [], sources: [], sourceDetails: [], conflicts: [],
      intentionConfirmed: false, createdAt: new Date().toISOString()
    };
    // 字段级来源收集
    const fieldSrc = {};
    const add = (fld, v, src) => { if (!v) return; fieldSrc[fld] = fieldSrc[fld] || {}; fieldSrc[fld][v] = fieldSrc[fld][v] || new Set(); fieldSrc[fld][v].add(src); };
    for (const c of contribs) for (const fld of FIELDS) add(fld, c.f[fld], c.source);
    const srcSet = new Set(contribs.map(c => c.source));
    contact.sources = [...srcSet];

    // 公司：sameCompany → 归一取最常见写法（并列取最短，最规范）；否则冲突
    const compVals = fieldSrc.company ? Object.keys(fieldSrc.company) : [];
    if (compVals.length === 1) contact.company = compVals[0];
    else if (compVals.length > 1) {
      if (compVals.every(v => clean.sameCompany(v, compVals[0]))) contact.company = chooseCompany(compVals, fieldSrc);
      else { contact.company = compVals[0]; contact.conflicts.push('company'); pending.push(conflictItem(contact.id, 'company', compVals.map(v => ({ value: v, sources: [...fieldSrc.company[v]] })))); }
    }

    // 其余字段
    for (const fld of ['mobile', 'landline', 'email', 'city', 'cooperationStatus', '录入人']) {
      const vals = fieldSrc[fld] ? Object.keys(fieldSrc[fld]) : [];
      if (vals.length === 0) continue;
      if (vals.length === 1) contact[fld] = vals[0];
      else {
        contact[fld] = vals[0];
        contact.conflicts.push(fld);
        pending.push(conflictItem(contact.id, fld, vals.map(v => ({ value: v, sources: [...fieldSrc[fld][v]] }))));
      }
    }
    // tags 合并去重
    const tagSet = new Set();
    for (const c of contribs) (c.f.tags || []).forEach(t => t && tagSet.add(t));
    contact.tags = [...tagSet];
    // note 合并去重
    const noteSet = new Set();
    for (const c of contribs) if (c.f.note) noteSet.add(c.f.note);
    contact.note = [...noteSet].join('；');

    // 溯源明细
    for (const fld of FIELDS) {
      if (fieldSrc[fld]) for (const v of Object.keys(fieldSrc[fld])) contact.sourceDetails.push({ field: fld, value: v, sources: [...fieldSrc[fld][v]] });
    }

    contacts.push(contact);
  }
  return { contacts, pending, removed };
}

// 主入口：读 input 目录 → 规整包
function buildNormalization(inputDir) {
  const { raw, todos, lowconf, skipped, sourceFiles } = parseInputFiles(inputDir);
  const groups = buildGroups(raw);
  const { contacts, pending, removed } = mergeGroups(groups, raw);

  // 低置信（结构化记录手机号非法/缺失）
  for (const c of contacts) {
    const src = (c.sources || []).join('/');
    const lc = intent.isLowConfidenceContact(c);
    if (lc.low) pending.push({ id: newId('p'), type: 'lowconfidence', contactId: c.id, rawSnippet: (c.name + '/' + c.company), candidate: { mobile: null }, reason: lc.reason, status: 'open', resolution: null, source: src });
    const it = intent.judgeIntention(c);
    if (it.candidate) pending.push({ id: newId('p'), type: 'intention', contactId: c.id, signals: it.signals, status: 'open', resolution: null, source: src });
  }
  // 自由文本低置信（高工 等，无联系人 id，待补录）
  for (const l of lowconf) pending.push({ id: newId('p'), type: 'lowconfidence', contactId: null, rawSnippet: l.rawSnippet, candidate: { name: l.name, company: l.company, city: l.city }, reason: l.note, status: 'open', resolution: null });

  const todoItems = todos.map(t => ({ id: newId('t'), text: t.text, source: t.source, status: 'open' }));

  const stats = {
    rawContributions: raw.length,
    contactCount: contacts.length,
    conflictCount: pending.filter(p => p.type === 'conflict').length,
    intentionCount: pending.filter(p => p.type === 'intention').length,
    lowconfCount: pending.filter(p => p.type === 'lowconfidence').length,
    todoCount: todoItems.length,
    removedCount: removed.length
  };
  return { contacts, pending, todos: todoItems, removed, skipped, sourceFiles, stats, generatedAt: new Date().toISOString() };
}

module.exports = { buildNormalization, parseInputFiles, parseContent, parseContentAsync };
