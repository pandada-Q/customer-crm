'use strict';
// 轻量后端（D15）：静态前端 + API + 单一口令鉴权 + 留痕撤销
// 启动前加载 项目根/.env（无第三方依赖）：配置 DEEPSEEK_API_KEY / LLM_PROVIDER 等。
(function loadDotEnv() {
  try {
    const fs = require('fs');
    const p = require('path').join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      const k = m[1], v = m[2].replace(/^["']|["']$/g, '');
      if (process.env[k] === undefined) process.env[k] = v;
    }
    console.log('[env] 已加载 .env：' + p);
  } catch (e) { console.warn('[env] .env 加载失败（忽略）: ' + e.message); }
})();
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const { processUpload, processUploadAsync } = require('./lib/merge');
const { toCSV } = require('./lib/csv');
const ai = require('./lib/ai');
const assistant = require('./lib/assistant'); // AI 数据小助手（系统内问答，悬浮右下角）

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DB_PATH = process.env.CRM_DB ? path.resolve(process.env.CRM_DB) : path.resolve(ROOT, 'data', 'db.json');
const PORT = process.env.PORT || 4173;
const PASSCODE = process.env.CRM_PASSCODE || 'crm2026';
const DEV_TOOLS = process.env.DEV_TOOLS === '1'; // 测试工具开关：=1 才注册 /api/dev/clear 并让前端显示「清空数据」按钮（提交/生产默认关闭）
const OPERATOR = 'owner'; // 单一口令，不分人级权限（D18①）

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((ok, err) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { err(e); } }); }); }
function authed(req) {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams.get('passcode');
  const h = req.headers['x-passcode'];
  return q === PASSCODE || h === PASSCODE;
}

// 把一次上传结果落库（应用更正 + 待确认 + 留痕），供同步与异步两条链路复用
function applyUpload(state, r, filename, mode) {
  for (const cor of r.corrections) {
    const c = state.contacts.find(x => x.id === cor.id);
    if (c) { const a = store.setContactField(state, c.id, cor.field, cor.new, OPERATOR, '更正清单修正'); if (a) a.pendingId = null; }
  }
  r.pending.forEach(pp => state.pending.push(pp));
  for (const td of r.todos || []) {
    if (!state.todos.some(x => x.text === td.text)) state.todos.push(td); // 按文本去重，跨批次重传不重复
  }
  store.recordAudit(state, { operator: OPERATOR, target: 'import', refId: '-', field: 'batch', oldValue: '', newValue: '上传:' + filename, note: '新批次上传(' + mode + ')' });
}

// 上传处理记录：每个文件一条，统计 + 处理过程明细，供右栏「上传处理记录」面板展示
function addUploadLog(state, r, filename, mode, provider) {
  const pendingByType = {};
  for (const pt of r.pending || []) pendingByType[pt.type] = (pendingByType[pt.type] || 0) + 1;
  const e = {
    id: store.newId('u'), ts: new Date().toISOString(), filename, mode, provider: provider || 'rule',
    added: (r.added || []).length,
    merged: (r.notes || []).filter(n => n.startsWith('已合并（无冲突）')).length,
    conflict: pendingByType.conflict || 0,
    intention: pendingByType.intention || 0,
    lowconf: pendingByType.lowconf || 0,
    corrections: (r.corrections || []).length,
    todos: (r.todos || []).length,
    skippedImage: !!r.skippedImage,
    notes: r.notes || []
  };
  state.uploads = state.uploads || [];
  state.uploads.push(e);
  if (state.uploads.length > 100) state.uploads.splice(0, state.uploads.length - 100); // 只保留最近 100 条
  return e;
}

// 后台异步上传任务：逐文件处理（自由文本经 DeepSeek/llm 抽取），处理中不阻塞其他请求。
const jobs = new Map();
async function runUploadJob(job, files, mode) {
  job.status = 'processing';
  job.provider = ai.getProvider().name; // 动态判定（rule/deepseek/llm），而非常量快照
  try {
    for (let i = 0; i < files.length; i++) {
      // 清空数据（测试工具）会置 canceled：立即停止，防止在跑任务把已清空的库重新写回
      if (job.canceled) { job.status = 'canceled'; job.notes.push('⚠ 已被「清空数据」取消'); job.finishedAt = Date.now(); return; }
      const f = files[i];
      job.lastFile = f.filename; // 供失败时定位出错文件
      job.notes.push('▶ 处理文件：' + f.filename);
      const state = store.load(DB_PATH); // 每文件重新载入，捕获并发编辑并让结果渐进可见
      const r = await processUploadAsync(f.filename, f.content, state.contacts, mode);
      if (job.canceled) { job.status = 'canceled'; job.notes.push('⚠ 已被「清空数据」取消'); job.finishedAt = Date.now(); return; }
      applyUpload(state, r, f.filename, mode);
      addUploadLog(state, r, f.filename, mode, job.provider); // 与落库同一次保存：处理记录渐进可见
      store.save(DB_PATH, state);
      job.notes.push(...r.notes);
      if (r.skippedImage) job.notes.push('⚠ 已跳过图片：' + f.filename);
      job.done = i + 1;
      job.progress = Math.round((job.done / files.length) * 100);
    }
    job.status = 'done';
    job.finishedAt = Date.now();
  } catch (e) {
    job.status = 'error';
    job.error = String(e && e.message || e);
    job.finishedAt = Date.now();
    try { // 记录失败条目，便于用户在该文件中定位问题
      const state = store.load(DB_PATH);
      addUploadLog(state, { added: [], pending: [], corrections: [], todos: [], skippedImage: false, notes: ['❌ 处理失败：' + job.error] }, job.lastFile || files[0] && files[0].filename || '未知文件', job.mode, job.provider || ai.PROVIDER);
      store.save(DB_PATH, state);
    } catch (e2) { /* 忽略：日志失败不影响任务状态 */ }
  }
}

function resolvePending(state, item, body) {
  const contact = state.contacts.find(c => c.id === item.contactId);
  if (item.type === 'conflict') {
    const choice = body.choice;
    const value = choice === 'A' ? item.valueA : choice === 'B' ? item.valueB : item.recommended;
    if (contact) {
      const other = (value === item.valueA) ? item.valueB : item.valueA; // 拍板前的另一候选，用于撤销回退
      const prev = contact[item.field];
      contact[item.field] = value;
      // 拍板完成后，字段不再处于待确认 → 从 contacts 的 conflicts 标记中移除（联系人回归总表）
      if (Array.isArray(contact.conflicts)) {
        const ci = contact.conflicts.indexOf(item.field);
        if (ci >= 0) contact.conflicts.splice(ci, 1);
      }
      // 始终留痕（D18②）：即便推荐值恰为当前值也记录，使撤销可回退到另一候选
      store.recordAudit(state, { operator: OPERATOR, target: 'contact', refId: contact.id, field: item.field, oldValue: (prev === value ? other : prev), newValue: value, pendingId: item.id, note: '拍板:' + choice });
    }
    item.status = 'resolved'; item.resolution = { choice, value };
    return { ok: true, value };
  }
  if (item.type === 'intention') {
    const choice = body.choice; // confirm | reject
    if (contact) {
      contact.intentionConfirmed = (choice === 'confirm');
      if (choice === 'confirm' && !contact.intentionNote) {
        // 记录“判断为意向客户的原因”，供意向客户页展示
        contact.intentionNote = (item.signals || []).map(s => s.type + '：' + s.value).join('；');
      }
      store.recordAudit(state, { operator: OPERATOR, target: 'contact', refId: contact.id, field: 'intentionConfirmed', oldValue: !contact.intentionConfirmed, newValue: contact.intentionConfirmed, pendingId: item.id, note: '意向' + choice });
    }
    item.status = 'resolved'; item.resolution = { choice };
    return { ok: true, choice };
  }
  if (item.type === 'lowconfidence') {
    const choice = body.choice; // keep | supplement | remove
    if (choice === 'supplement' && body.fields) {
      // 字段白名单：一次性提交整份资料（含合作状态）；显式传入空串 = 清空该字段
      const ALLOW = ['name', 'company', 'mobile', 'landline', 'email', 'city', 'cooperationStatus', 'note'];
      const norm = fld => (fld === 'cooperationStatus' ? require('./lib/clean').normalizeCooperationStatus(body.fields[fld]) : String(body.fields[fld] == null ? '' : body.fields[fld]).trim());
      if (contact) {
        for (const fld of ALLOW) {
          if (Object.prototype.hasOwnProperty.call(body.fields, fld)) {
            const a = store.setContactField(state, contact.id, fld, norm(fld), OPERATOR, '待确认修改');
            if (a) a.pendingId = item.id;
          }
        }
      } else {
        // 无既有联系人：补全新联系人（须至少提供姓名或公司）
        const f = {}; for (const fld of ALLOW) f[fld] = norm(fld);
        if (!f.name && !f.company) return { ok: false, error: '请至少填写姓名或公司' };
        const nc = Object.assign({ id: store.newId('c'), sources: ['人工补录'], sourceDetails: [], conflicts: [], intentionConfirmed: false, createdAt: new Date().toISOString() }, f);
        state.contacts.push(nc);
        store.recordAudit(state, { operator: OPERATOR, target: 'contact', refId: nc.id, field: 'create', oldValue: '', newValue: nc.name, pendingId: item.id, note: '低置信补全新联系人' });
      }
    } else if (choice === 'remove' && contact) {
      const idx = state.contacts.findIndex(c => c.id === contact.id);
      if (idx >= 0) { state.contacts.splice(idx, 1); store.recordAudit(state, { operator: OPERATOR, target: 'contact', refId: contact.id, field: 'remove', oldValue: contact.name, newValue: '', pendingId: item.id, note: '低置信剔除' }); }
    }
    item.status = 'resolved'; item.resolution = { choice };
    return { ok: true, choice };
  }
  return { ok: false, error: '未知待确认类型' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // 静态资源
    if (req.method === 'GET' && (p === '/' || p.startsWith('/static') || (p === '/index.html'))) {
      const f = p === '/' ? 'index.html' : p.replace(/^\/static\//, '');
      const fp = path.join(PUBLIC, f);
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) { res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); fs.createReadStream(fp).pipe(res); return; }
      res.writeHead(404); res.end('not found'); return;
    }

    if (p === '/api/health') return send(res, 200, { ok: true });
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, b.passcode === PASSCODE ? 200 : 401, b.passcode === PASSCODE ? { ok: true, operator: OPERATOR } : { ok: false, error: '口令错误' });
    }

    // 前端启动配置（无需口令）：开发工具开关 / 版本号，供前端决定是否展示「清空数据」测试按钮
    if (p === '/api/config' && req.method === 'GET') {
      let ver = '0.1.0';
      try { ver = require('./package.json').version || ver; } catch (e) { /* 忽略 */ }
      return send(res, 200, { ok: true, app: '客户资料管理助手', version: ver, devTools: DEV_TOOLS });
    }

    if (!authed(req)) return send(res, 401, { ok: false, error: '口令错误' });
    const state = store.load(DB_PATH);

    // ─── DEV-ONLY 测试工具：清空全部业务数据（仅 DEV_TOOLS=1 启动时开放；配套 public/index.html「清空数据」按钮 + app.js handler）───
    if (DEV_TOOLS && p === '/api/dev/clear' && req.method === 'POST') {
      const cleared = { contacts: state.contacts.length, pending: state.pending.length, todos: state.todos.length, audit: state.audit.length, uploads: state.uploads.length };
      for (const job of jobs.values()) if (job.status === 'queued' || job.status === 'processing') job.canceled = true; // 取消后台任务，防止写回
      state.contacts = [];
      state.pending = [];
      state.todos = [];
      state.audit = [];
      state.uploads = [];
      state.meta = Object.assign({}, store.defaultState().meta, state.meta || {}, { cleared: (state.meta && state.meta.cleared || 0) + 1, lastClearAt: new Date().toISOString() });
      store.save(DB_PATH, state);
      return send(res, 200, { ok: true, cleared, meta: state.meta, note: '测试专用：联系人/待确认/待办/留痕/上传记录已全部清空（不可恢复）' });
    }

    if (p === '/api/contacts' && req.method === 'GET') {
      let list = state.contacts.slice();
      const q = (url.searchParams.get('q') || '').trim();
      const city = url.searchParams.get('city'); const coop = url.searchParams.get('cooperationStatus'); const tag = url.searchParams.get('tag'); const intention = url.searchParams.get('intention');
      if (q) list = list.filter(c => [c.name, c.company, c.mobile, c.email, c.city, c.note].some(v => (v || '').includes(q)));
      if (city) list = list.filter(c => c.city === city);
      if (coop) list = list.filter(c => c.cooperationStatus === coop);
      if (tag) list = list.filter(c => (c.tags || []).includes(tag));
      if (intention === '1') list = list.filter(c => c.intentionConfirmed || c.cooperationStatus === '待定');
      // 总表页传 hidePending=1：有未决冲突的联系人移出总表（只进待确认区，D16）
      let hidden = 0;
      if (url.searchParams.get('hidePending') === '1') {
        const conflicted = new Set(state.pending.filter(x => x.type === 'conflict' && x.status === 'open' && x.contactId).map(x => x.contactId));
        const before = list.length;
        list = list.filter(c => !conflicted.has(c.id));
        hidden = before - list.length;
      }
      // 分页：pageSize<=0 表示不分页（兼容旧调用）
      const matched = list.length;
      const rawTotal = state.contacts.length;
      const pageSize = parseInt(url.searchParams.get('pageSize') || '0', 10);
      const pages = pageSize > 0 ? Math.max(1, Math.ceil(matched / pageSize)) : 1;
      let page = parseInt(url.searchParams.get('page') || '1', 10);
      if (pageSize > 0) { if (page < 1) page = 1; if (page > pages) page = pages; list = list.slice((page - 1) * pageSize, page * pageSize); }
      else page = 1;
      return send(res, 200, { contacts: list, total: matched, rawTotal, hidden, page, pageSize, pages });
    }
    if (p === '/api/filters' && req.method === 'GET') {
      const cities = [...new Set(state.contacts.map(c => c.city).filter(Boolean))].sort();
      const tags = [...new Set(state.contacts.flatMap(c => c.tags || []).filter(Boolean))].sort();
      const statuses = [...new Set(state.contacts.map(c => c.cooperationStatus).filter(Boolean))].sort();
      return send(res, 200, { cities, tags, statuses });
    }
    if (/^\/api\/contact\/[^\/]+$/.test(p) && req.method === 'GET') {
      const id = p.split('/').pop();
      const c = state.contacts.find(x => x.id === id);
      return c ? send(res, 200, { contact: c }) : send(res, 404, { ok: false });
    }
    // 意向客户操作：跟进（记录跟进人 + 时间） / 移出意向列表（均留痕，可撤销）
    const followM = p.match(/^\/api\/contact\/([^/]+)\/followup$/);
    if (followM && req.method === 'POST') {
      const c = state.contacts.find(x => x.id === followM[1]);
      if (!c) return send(res, 404, { ok: false, error: '联系人不存在' });
      const b = await readBody(req);
      const by = String(b.by || '').trim();
      if (!by) return send(res, 400, { ok: false, error: '请填写跟进人员' });
      const at = new Date().toISOString();
      const oldBy = c.followupBy || '';
      c.followups = c.followups || [];
      c.followups.push({ by, at });
      c.followupBy = by;
      c.followupAt = at;
      store.recordAudit(state, { operator: OPERATOR, target: 'contact', refId: c.id, field: 'followupBy', oldValue: oldBy, newValue: by, note: '意向跟进' });
      store.save(DB_PATH, state);
      return send(res, 200, { ok: true, followupBy: by, followupAt: at, count: c.followups.length });
    }
    const rmM = p.match(/^\/api\/contact\/([^/]+)\/intent-remove$/);
    if (rmM && req.method === 'POST') {
      const c = state.contacts.find(x => x.id === rmM[1]);
      if (!c) return send(res, 404, { ok: false, error: '联系人不存在' });
      const wasStatus = c.cooperationStatus || '';
      const wasIntent = !!c.intentionConfirmed;
      c.intentionConfirmed = false;
      if (c.cooperationStatus === '待定') c.cooperationStatus = ''; // 若因「待定」进列表，一并清状态
      store.recordAudit(state, { operator: OPERATOR, target: 'contact', refId: c.id, field: 'intentionConfirmed', oldValue: wasIntent, newValue: false, note: '意向移除' });
      if (wasStatus === '待定') store.recordAudit(state, { operator: OPERATOR, target: 'contact', refId: c.id, field: 'cooperationStatus', oldValue: wasStatus, newValue: '', note: '意向移除（待定→空）' });
      store.save(DB_PATH, state);
      return send(res, 200, { ok: true, removed: { intentionConfirmed: wasIntent, cooperationStatus: wasStatus } });
    }
    if (p === '/api/todos' && req.method === 'GET') {
      // status 筛选（open 待处理/done 完成/shelved 搁置/removed 已移除；缺省返回全部）；counts 供前端筛选 chips 计数
      const st = url.searchParams.get('status');
      const counts = { open: 0, done: 0, shelved: 0, removed: 0 };
      for (const t of state.todos) { const k = t.status || 'open'; if (counts[k] !== undefined) counts[k]++; }
      let list = state.todos.slice();
      if (st && st !== 'all') list = list.filter(t => (t.status || 'open') === st);
      return send(res, 200, { todos: list, counts });
    }
    if (p === '/api/uploads' && req.method === 'GET') {
      // 上传处理记录（最新在前，最多 20 条）
      return send(res, 200, { uploads: state.uploads.slice(-20).reverse() });
    }
    // AI 数据小助手：只基于系统内数据问答（检索+大模型推荐；offline:true 可强制本地关键词模式，供测试/省调用）
    if (p === '/api/assistant/query' && req.method === 'POST') {
      const b = await readBody(req);
      const q = String(b.question || '').trim();
      if (!q) return send(res, 400, { ok: false, error: '请输入要查询的问题' });
      if (q.length > 300) return send(res, 400, { ok: false, error: '问题过长（最多 300 字）' });
      const r = await assistant.ask(state, q, { provider: b.offline === true ? 'rule' : undefined });
      return send(res, 200, { ok: true, question: q, provider: r.provider, offline: !!r.offline, degraded: !!r.degraded, answer: r.answer, hit: r.hit, stats: r.stats });
    }
    if (p === '/api/audit' && req.method === 'GET') {
      const recent = state.audit.filter(a => !a.undone && a.target !== 'undo').slice(-30).reverse();
      return send(res, 200, { audit: recent });
    }
    if (p === '/api/pending' && req.method === 'GET') {
      return send(res, 200, { pending: state.pending.filter(x => x.status === 'open'), all: state.pending });
    }
    if (p === '/api/pending/count' && req.method === 'GET') {
      return send(res, 200, { open: state.pending.filter(x => x.status === 'open').length, total: state.pending.length });
    }
    let m = p.match(/^\/api\/pending\/([^/]+)\/resolve$/);
    if (m && req.method === 'POST') {
      const item = state.pending.find(x => x.id === m[1]);
      if (!item || item.status !== 'open') return send(res, 404, { ok: false, error: '待确认项不存在或已处理' });
      const b = await readBody(req);
      const r = resolvePending(state, item, b);
      store.save(DB_PATH, state);
      return send(res, 200, r);
    }
    m = p.match(/^\/api\/todos\/([^/]+)\/status$/);
    if (m && req.method === 'POST') {
      const t = state.todos.find(x => x.id === m[1]);
      if (!t) return send(res, 404, { ok: false, error: '待办不存在' });
      const b = await readBody(req);
      const st = String(b.status || '').trim();
      if (!store.TODO_STATUS.includes(st)) return send(res, 400, { ok: false, error: '非法状态（open/done/shelved/removed）' });
      const a = store.setTodoStatus(state, m[1], st, OPERATOR);
      store.save(DB_PATH, state);
      return send(res, 200, { ok: true, status: st, audited: !!a });
    }
    m = p.match(/^\/api\/audit\/([^/]+)\/undo$/);
    if (m && req.method === 'POST') {
      const a = store.undoAudit(state, m[1], OPERATOR);
      store.save(DB_PATH, state);
      return send(res, 200, { ok: !!a });
    }
    if (p === '/api/upload' && req.method === 'POST') {
      const b = await readBody(req);
      const mode = b.mode === 'correction' ? 'correction' : 'batch';
      const r = processUpload(b.filename || 'upload.txt', b.content || '', state.contacts, mode);
      applyUpload(state, r, b.filename || 'upload.txt', mode);
      addUploadLog(state, r, b.filename || 'upload.txt', mode, ai.getProvider().name);
      store.save(DB_PATH, state);
      return send(res, 200, { added: r.added.length, pending: r.pending.length, corrections: r.corrections, notes: r.notes, skippedImage: r.skippedImage });
    }
    // 异步上传：接受批量文件 {files:[{filename,content}], mode}，后台处理（可调用 DeepSeek），立即返回任务 ID
    if (p === '/api/upload/async' && req.method === 'POST') {
      const b = await readBody(req);
      const files = Array.isArray(b.files) ? b.files : (b.filename ? [{ filename: b.filename, content: b.content || '' }] : []);
      if (files.length === 0) return send(res, 400, { ok: false, error: '未收到文件' });
      const mode = b.mode === 'correction' ? 'correction' : 'batch';
      const id = store.newId('job');
      const job = { id, status: 'queued', mode, provider: ai.PROVIDER, total: files.length, done: 0, progress: 0, notes: [], error: null, startedAt: Date.now(), finishedAt: null };
      jobs.set(id, job);
      runUploadJob(job, files, mode); // 不 await：后台执行，处理期间不阻塞本请求与其他查询
      return send(res, 200, { jobId: id, queued: true });
    }
    m = p.match(/^\/api\/upload\/job\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { ok: false, error: '任务不存在' });
      return send(res, 200, job);
    }
    if (p === '/api/export' && req.method === 'GET') {
      const cols = ['name', 'company', 'mobile', 'landline', 'email', 'city', 'note', 'cooperationStatus', '录入人', 'tags', 'sources'];
      const rows = state.contacts.map(c => ({ ...c, tags: (c.tags || []).join('/'), sources: (c.sources || []).join('/') }));
      const csv = toCSV(rows, cols);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="contacts-normalized.csv"' });
      return res.end('﻿' + csv);
    }
    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('[ai] 当前抽取提供方 = ' + ai.getProvider().name + '（txt 自由文本上传经此抽取；设 .env 中 DEEPSEEK_API_KEY 可切 deepseek）');
    console.log('客户资料管理助手 running: http://localhost:' + PORT + '  (口令: ' + PASSCODE + ')');
  });
}
module.exports = { server, PASSCODE };
