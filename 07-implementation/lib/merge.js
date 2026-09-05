'use strict';
// 新批次上传与合并（06，D17 分流）+ 更正清单修正指令识别（07 路径 B）
const clean = require('./clean');
const intent = require('./intent');
const { newId } = require('./store');

function findExisting(contact, existing) {
  for (const c of existing) {
    if (c.name && contact.name && c.name === contact.name && clean.sameCompany(c.company, contact.company)) return c;
    if (contact.mobile && c.mobile && contact.mobile === c.mobile) return c;
  }
  return null;
}

function buildContactFromContrib(c, source) {
  const f = c.f;
  return {
    id: newId('c'), name: f.name, company: f.company, mobile: f.mobile, landline: f.landline,
    email: f.email, city: f.city, note: f.note, cooperationStatus: f.cooperationStatus, 录入人: f.录入人,
    tags: f.tags || [], sources: [source], sourceDetails: [], conflicts: [], intentionConfirmed: false,
    createdAt: new Date().toISOString()
  };
}

function initResult() { return { added: [], pending: [], corrections: [], todos: [], notes: [], skippedImage: false }; }

// 把一次解析结果按模式（batch / correction）分流进 result，并就地修改 existing。
function route(parsed, filename, existing, mode, result) {
  if (parsed.skipped && /\.(jpg|jpeg|png|gif)$/.test(filename.toLowerCase())) {
    result.skippedImage = true;
    result.notes.push('图片/扫描件已跳过，请先转文字/表格后上传（D9）');
    return result;
  }
  if (parsed.skipped) { result.notes.push('跳过：' + parsed.skipped); return result; }

  // 格式修复说明（parse 阶段字段格式规则：手机号误入城市/邮箱等），写入处理日志
  for (const c of parsed.raw) {
    if (c._fix && c._fix.length) { result.notes.push(...c._fix.map(s => '格式修复：' + s)); delete c._fix; }
  }

  // 素材中的非联系人事项（约饭/回头找电话/记得提醒等）→ 待办列表（D7）。batch 与 correction 通用。
  for (const t of parsed.todos || []) {
    const text = String(t.text || '').trim();
    if (!text) continue;
    if (!result.todos.some(x => x.text === text)) {
      result.todos.push({ id: newId('t'), text, source: filename, status: 'open' });
      result.notes.push('新增待办：' + text);
    }
  }

  // 路径 B：更正清单 → 仅修正既有联系人，不新增
  if (mode === 'correction') {
    for (const c of parsed.raw) {
      const cand = buildContactFromContrib(c, filename);
      const ex = existing.find(e => e.name && cand.name && e.name === cand.name && clean.sameCompany(e.company, cand.company))
            || existing.find(e => cand.mobile && e.mobile && cand.mobile === e.mobile);
      if (!ex) { result.notes.push('更正清单未匹配既有联系人，跳过：' + cand.name); continue; }
      for (const fld of ['mobile', 'landline', 'email', 'city', 'company', 'cooperationStatus', 'note']) {
        const nv = cand[fld];
        if (nv && nv !== ex[fld]) { result.corrections.push({ id: ex.id, name: ex.name, field: fld, old: ex[fld] || '', new: nv }); }
      }
    }
    return result;
  }

  // 路径 batch：D17 分流
  for (const c of parsed.raw) {
    const cand = buildContactFromContrib(c, filename);
    if (clean.isTestContact(cand.f || cand)) { result.notes.push('剔除测试号：' + (cand.name || cand.mobile)); continue; }
    if (clean.isPlaceholder(cand)) { result.notes.push('剔除占位行：' + cand.name); continue; }

    const ex = findExisting(cand, existing);
    if (ex) {
      // 疑似重复：检查字段冲突
      const conflictFields = [];
      for (const fld of ['mobile', 'landline', 'email', 'city', 'cooperationStatus']) {
        if (cand[fld] && ex[fld] && cand[fld] !== ex[fld]) conflictFields.push(fld);
      }
      if (!clean.sameCompany(cand.company, ex.company) && cand.company && ex.company) conflictFields.push('company');
      if (conflictFields.length > 0) {
        for (const fld of conflictFields) {
          result.pending.push({
            id: newId('p'), type: 'conflict', contactId: ex.id, field: fld,
            valueA: ex[fld] || '', sourceA: (ex.sources || []).join('/'),
            valueB: cand[fld], sourceB: filename,
            recommended: ex[fld] || cand[fld], recommendedNote: '建议人工拍板（不静默取一）',
            status: 'open', resolution: null, batch: true, source: filename // 来源文件：本次上传批次
          });
        }
        result.notes.push('疑似重复/冲突进待确认区：' + cand.name + ' (' + conflictFields.join(',') + ')');
      } else {
        // 无冲突：合并来源、补全空缺字段
        if (!ex.sources.includes(filename)) ex.sources.push(filename);
        for (const fld of ['mobile', 'landline', 'email', 'city', 'company', 'cooperationStatus', 'note', '录入人']) {
          if (cand[fld] && !ex[fld]) ex[fld] = cand[fld];
        }
        // 标签并入（去重后合并，与 normalizeTagList 规则一致；避免重传同一名单时覆盖既有标签）
        const exTags = new Set(ex.tags || []);
        let tagAdded = false;
        for (const t of cand.tags || []) { if (t && !exTags.has(t)) { exTags.add(t); tagAdded = true; } }
        if (tagAdded) { ex.tags = [...exTags]; result.notes.push('补充标签：' + cand.name); }
        result.notes.push('已合并（无冲突）：' + cand.name);
      }
    } else {
      // 全新联系人：直接入库（D17 直入）
      existing.push(cand);
      result.added.push(cand);
      const lc = intent.isLowConfidenceContact(cand);
      if (lc.low) result.pending.push({ id: newId('p'), type: 'lowconfidence', contactId: cand.id, rawSnippet: cand.name + '/' + cand.company, candidate: { mobile: null }, reason: lc.reason, status: 'open', resolution: null, batch: true, source: filename });
      const it = intent.judgeIntention(cand);
      if (it.candidate) result.pending.push({ id: newId('p'), type: 'intention', contactId: cand.id, signals: it.signals, status: 'open', resolution: null, batch: true, source: filename });
      result.notes.push('新增直入：' + cand.name);
    }
  }
  // 自由文本低置信（如 高工 电话待补）
  for (const l of parsed.lowconf) result.pending.push({ id: newId('p'), type: 'lowconfidence', contactId: null, rawSnippet: l.rawSnippet, candidate: { name: l.name, company: l.company, city: l.city }, reason: l.note, status: 'open', resolution: null, batch: true, source: filename });
  return result;
}

// 处理一次上传（同步）。mode: 'batch'（D17 分流）| 'correction'（路径 B 更正清单）
// 返回 { added:[contacts], pending:[...], corrections:[{name,field,old,new}], skippedImage?, notes:[] }
function processUpload(filename, content, existing, mode) {
  const { parseContent } = require('./pipeline');
  const parsed = parseContent(filename, content);
  const result = initResult();
  route(parsed, filename, existing, mode, result);
  return result;
}

// 异步版上传处理：自由文本经大模型（DeepSeek/llm）抽取后再走 D17 分流，不阻塞事件循环。
async function processUploadAsync(filename, content, existing, mode) {
  const { parseContentAsync } = require('./pipeline');
  const parsed = await parseContentAsync(filename, content);
  const result = initResult();
  route(parsed, filename, existing, mode, result);
  return result;
}

module.exports = { processUpload, processUploadAsync, findExisting };
