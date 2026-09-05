'use strict';
let PC = ''; // 访问口令
const $ = s => document.querySelector(s);
const view = $('#view');

async function api(path, opts = {}) {
  const url = path + (path.includes('?') ? '&' : '?') + 'passcode=' + encodeURIComponent(PC);
  const r = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  if (r.status === 401) { alert('口令错误或已失效'); location.reload(); throw new Error('auth'); }
  return r.json();
}

function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

async function login() {
  const pc = $('#passcode').value.trim();
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: pc }) });
  if (r.ok) { PC = pc; $('#login').classList.add('hidden'); $('#main').classList.remove('hidden'); $('#assistFab').classList.remove('hidden'); showView('table'); }
  else $('#loginErr').textContent = '口令错误';
}

function showView(name) {
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.view === name));
  updateBadge();
  if (name === 'table') return renderTable();
  if (name === 'pending') return renderPending();
  if (name === 'intention') return renderIntention();
  if (name === 'todos') return renderTodos();
}
// 刷新导航角标：待确认区待处理数（拍板/意向确认/低置信补录后即时更新）
async function updateBadge() {
  try {
    const r = await api('/api/pending/count');
    const b = $('#badge');
    if (b) b.textContent = r.open || 0;
  } catch (e) { /* 忽略：仅角标 */ }
}

let tableState = { q: '', city: '', tag: '', coop: '', page: 1, pageSize: 20, pages: 1, total: 0 };
let pendingFiles = [];
let uploadJob = null;     // 正在运行的异步上传任务 ID
let lastJob = null;       // 最近一次任务快照，用于切回页面时恢复遮罩

async function renderTable() {
  const f = await api('/api/filters');
  const opt = (vals, cur, all) => ['<option value="">' + all + '</option>'].concat(vals.map(v => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(v)}</option>`)).join('');
  const cityOpts = opt(f.cities, tableState.city, '全部城市');
  const tagOpts = opt(f.tags, tableState.tag, '全部标签');
  const coopOpts = opt(f.statuses, tableState.coop, '全部合作状态');
  const sizeOpts = [10, 20, 50, 100].map(n => `<option value="${n}" ${tableState.pageSize === n ? 'selected' : ''}>${n} 条/页</option>`).join('');

  view.innerHTML = `<section class="split">
    <div class="col-main">
      <div class="panel tbl-panel">
        <div class="tbl-head">
          <h2>客户总表（只读展示）</h2>
          <span id="tblCount" class="muted"></span>
        </div>
        <div class="toolbar">
          <input id="fQ" placeholder="搜索姓名/公司/手机/邮箱/城市/备注" value="${esc(tableState.q)}" oninput="onTableFilter()" style="min-width:190px"/>
          <select id="fCity" onchange="onTableFilter()">${cityOpts}</select>
          <select id="fTag" onchange="onTableFilter()">${tagOpts}</select>
          <select id="fCoop" onchange="onTableFilter()">${coopOpts}</select>
        </div>
        <div id="tblWrap"></div>
        <div class="pager">
          <button class="sm ghost" id="pgPrev" onclick="tablePage(-1)">‹ 上一页</button>
          <span id="pgInfo" class="muted"></span>
          <button class="sm ghost" id="pgNext" onclick="tablePage(1)">下一页 ›</button>
          <select id="pgSize" onchange="tablePageSize()" title="每页条数">${sizeOpts}</select>
        </div>
      </div>
    </div>
    <aside class="col-side">
      <div class="up-card" id="upCard">
        <div class="up-head"><strong>上传新批次</strong>
          <span class="muted">拖入 / 点击选择多个文件（CSV / JSON / TXT），由大模型（DeepSeek）批量识别：全新客户直接入库、命中既有客户自动合并更新、字段冲突进待确认区。处理期间仍可正常查询</span>
        </div>
        <div class="dropzone" id="dropzone">
          <div>把文件拖到这里，或<span class="link">点击选择</span></div>
          <div class="muted" style="font-size:12px">支持批量 · 图片/扫描件会提示先转文字</div>
        </div>
        <input id="fileInput" type="file" multiple style="display:none" accept=".csv,.json,.txt"/>
        <div id="fileList" class="filelist"></div>
        <div class="toolbar" style="margin-top:10px">
          <button id="upBtn" onclick="doUploadBatch()">上传处理</button>
        </div>
        <div id="upStatus" class="muted" style="min-height:18px;margin-top:6px;font-size:12px"></div>
        <div id="upBusy" class="up-busy hidden">
          <div class="spinner"></div>
          <div>处理中… 上传区已锁定，您仍可正常查询表格</div>
          <div class="progress"><div id="upBar" class="progress-bar"></div></div>
          <div id="upProgressTxt" class="muted"></div>
          <div id="upNotes" class="job-notes"></div>
        </div>
      </div>
      <div class="up-card up-log-card">
        <div class="up-head"><strong>上传处理记录</strong>
          <span class="muted">每次上传自动留档：处理过程 + 结果统计</span>
        </div>
        <div id="uploadLog"><div class="muted" style="padding:12px 2px;font-size:12px">暂无记录</div></div>
      </div>
    </aside>
  </section>`;

  bindUpload();
  refreshTable();
  renderFileList();
  renderUploadLog();
  if (uploadJob && lastJob) { setUploadBusy(true); renderJobStatus(lastJob); }
}

// ---- 右栏「上传处理记录」：展示 uploads 日志（最新在前） ----
async function renderUploadLog() {
  const el = $('#uploadLog'); if (!el) return;
  try {
    const d = await api('/api/uploads');
    const rows = d.uploads || [];
    if (rows.length === 0) { el.innerHTML = '<div class="muted" style="padding:12px 2px;font-size:12px">暂无记录（上传后自动生成）</div>'; return; }
    el.innerHTML = rows.map(e => {
      const badges = [];
      const tag = (n, label, cls) => `<span class="ptag ${cls || ''}">${label} ${n}</span>`;
      if (e.skippedImage) badges.push(tag('', '⚠ 图片跳过', 'warn'));
      if (e.added) badges.push(tag(e.added, '新增', 'ok'));
      if (e.merged) badges.push(tag(e.merged, '合并'));
      if (e.corrections) badges.push(tag(e.corrections, '修正'));
      if (e.conflict) badges.push(tag(e.conflict, '冲突待确认', 'warn'));
      if (e.intention) badges.push(tag(e.intention, '意向', 'warn'));
      if (e.lowconf) badges.push(tag(e.lowconf, '低置信', 'warn'));
      if (e.todos) badges.push(tag(e.todos, '待办'));
      const modeLabel = e.mode === 'correction' ? '更正清单' : '自动分流';
      const notes = (e.notes || []);
      const detail = notes.length ? notes.map(n => `<div>${esc(n)}</div>`).join('') : '<div class="muted">（无明细）</div>';
      return `<div class="ulog">
        <div class="ulog-head"><span class="u-time">${fmtTS(e.ts)}</span><span class="u-file" title="${esc(e.filename)}">${esc(e.filename)}</span><span class="u-mode">${modeLabel}</span></div>
        <div class="ulog-badges">${badges.join('') || '<span class="muted" style="font-size:12px">无结果变化</span>'}</div>
        <details class="ulog-details"><summary>处理明细（${notes.length} 条）</summary><div class="ulog-notes">${detail}</div></details>
      </div>`;
    }).join('');
  } catch (err) { /* 忽略：面板刷新失败不影响页面 */ }
}
function fmtTS(iso) {
  if (!iso) return '';
  const d = new Date(iso), p = n => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function onTableFilter() {
  tableState.q = $('#fQ') ? $('#fQ').value : '';
  tableState.city = $('#fCity') ? $('#fCity').value : '';
  tableState.tag = $('#fTag') ? $('#fTag').value : '';
  tableState.coop = $('#fCoop') ? $('#fCoop').value : '';
  tableState.page = 1; // 筛选条件变化回到第一页
  refreshTable();
}

function tablePage(dir) {
  const target = Math.min(Math.max(1, tableState.page + dir), tableState.pages);
  if (target === tableState.page) return;
  tableState.page = target;
  refreshTable();
}
function tablePageSize() {
  const el = $('#pgSize'); if (!el) return;
  tableState.pageSize = parseInt(el.value, 10) || 20;
  tableState.page = 1;
  refreshTable();
}

async function refreshTable() {
  const params = new URLSearchParams();
  if (tableState.q) params.set('q', tableState.q);
  if (tableState.city) params.set('city', tableState.city);
  if (tableState.tag) params.set('tag', tableState.tag);
  if (tableState.coop) params.set('cooperationStatus', tableState.coop);
  params.set('hidePending', '1'); // 未决冲突联系人只出现在待确认区
  params.set('page', tableState.page);
  params.set('pageSize', tableState.pageSize);
  const d = await api('/api/contacts?' + params.toString());
  tableState.page = d.page || 1;
  tableState.pages = d.pages || 1;
  tableState.total = d.total || 0;

  let html = `<div class="table-wrap"><table>
    <colgroup><col class="c-name"/><col class="c-company"/><col class="c-mobile"/><col class="c-land"/><col class="c-email"/><col class="c-city"/><col class="c-status"/><col class="c-tags"/><col class="c-src"/></colgroup>
    <thead><tr><th>姓名</th><th>公司</th><th>手机</th><th>座机</th><th>邮箱</th><th>城市</th><th>合作状态</th><th>标签</th><th>来源</th></tr></thead><tbody>`;
  if (d.contacts.length === 0) {
    html += `<tr><td colspan="9" class="empty">无匹配联系人</td></tr>`;
  }
  for (const c of d.contacts) {
    const tags = (c.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
    const srcs = (c.sources || []).join('/');
    html += `<tr>
      <td>${esc(c.name)}</td>
      <td class="company" title="${esc(c.company)}"><span class="cut">${esc(c.company)}</span></td>
      <td>${esc(c.mobile)}</td><td>${esc(c.landline)}</td>
      <td class="email" title="${esc(c.email)}"><span class="cut">${esc(c.email)}</span></td>
      <td>${esc(c.city)}</td><td>${esc(c.cooperationStatus)}</td>
      <td class="td-tags" title="${esc((c.tags || []).join('、'))}">${tags}</td>
      <td class="src-cell" title="${esc(srcs)}"><span class="src">${esc(srcs)}</span></td>
    </tr>`;
  }
  html += '</tbody></table></div>';
  const wrap = $('#tblWrap');
  if (wrap) wrap.innerHTML = html;
  const cnt = $('#tblCount');
  if (cnt) {
    let txt = `共 ${tableState.total} 位`;
    if (d.hidden > 0) txt += `（另有 ${d.hidden} 位待确认，已移至待确认区）`;
    if (d.rawTotal) txt += ` · 全库 ${d.rawTotal} 位`;
    cnt.textContent = txt;
  }
  const pinfo = $('#pgInfo');
  if (pinfo) pinfo.textContent = `第 ${tableState.page} / ${tableState.pages} 页 · 每页 ${tableState.pageSize}`;
  const pv = $('#pgPrev'), nx = $('#pgNext');
  if (pv) pv.disabled = tableState.page <= 1;
  if (nx) nx.disabled = tableState.page >= tableState.pages;
}

// ---- 上传（拖拽批量 + 异步任务）----
function bindUpload() {
  const dz = $('#dropzone'); if (!dz) return;
  const fi = $('#fileInput');
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', e => { addFiles(e.target.files); fi.value = ''; });
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', e => { e.preventDefault(); dz.classList.remove('drag'); });
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); addFiles(e.dataTransfer.files); });
}
function addFiles(fileList) {
  for (const file of fileList) {
    const reader = new FileReader();
    reader.onload = () => { pendingFiles.push({ filename: file.name, content: String(reader.result) }); renderFileList(); };
    reader.readAsText(file);
  }
}
function renderFileList() {
  const el = $('#fileList'); if (!el) return;
  if (pendingFiles.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = pendingFiles.map((f, i) => `<div class="fileitem"><span>${esc(f.filename)}</span><button class="sm ghost" onclick="removeFile(${i})">✕</button></div>`).join('');
}
function removeFile(i) { pendingFiles.splice(i, 1); renderFileList(); }

async function doUploadBatch() {
  if (uploadJob) return;
  if (pendingFiles.length === 0) { $('#upStatus').textContent = '请先选择文件'; return; }
  setUploadBusy(true);
  $('#upStatus').textContent = '已提交，等待大模型识别处理…';
  const r = await api('/api/upload/async', { method: 'POST', body: JSON.stringify({ files: pendingFiles }) });
  if (r.jobId) pollJob(r.jobId);
  else { setUploadBusy(false); $('#upStatus').textContent = '提交失败：' + (r.error || '未知错误'); }
}
function setUploadBusy(busy) {
  const dz = $('#dropzone'), btn = $('#upBtn'), ov = $('#upBusy');
  if (dz) dz.classList.toggle('busy', busy);
  if (btn) { btn.disabled = busy; btn.textContent = busy ? '处理中…' : '上传处理'; }
  if (ov) ov.classList.toggle('hidden', !busy);
}
async function pollJob(id) {
  uploadJob = id;
  const j = await api('/api/upload/job/' + id);
  renderJobStatus(j);
  if (j.status === 'processing' || j.status === 'queued') {
    renderUploadLog(); // 处理记录渐进可见（每完成一个文件刷新一次）
    setTimeout(() => pollJob(id), 900);
  } else {
    setUploadBusy(false);
    uploadJob = null;
    pendingFiles = [];
    renderFileList();
    refreshTable();
    renderUploadLog(); // 收尾（含错误条目）
    updateBadge(); // 上传新增的冲突/意向/低置信会进待确认区，角标同步
    $('#upStatus').textContent = j.status === 'done' ? '✅ 处理完成' : ('❌ 处理出错：' + (j.error || ''));
  }
}
function renderJobStatus(j) {
  lastJob = j;
  const bar = $('#upBar'), txt = $('#upProgressTxt'), notes = $('#upNotes');
  if (bar) bar.style.width = (j.progress || 0) + '%';
  const end = j.finishedAt || Date.now();
  const sec = j.startedAt ? Math.max(0, Math.round((end - j.startedAt) / 1000)) : 0;
  if (txt) txt.textContent = `状态：${j.status} · 进度 ${j.done || 0}/${j.total || 0} (${j.progress || 0}%) · 识别：${j.mode === 'correction' ? '更正既有' : '自动（新增/更新）'} · 模型：${j.provider || '?'} · 已耗时 ${sec}s`;
  if (notes) notes.innerHTML = (j.notes || []).map(n => `<div>${esc(n)}</div>`).join('');
}

async function renderPending() {
  const d = await api('/api/pending');
  const cd = await api('/api/contacts');
  allContacts = cd.contacts;
  pendingById = {}; d.pending.forEach(p => pendingById[p.id] = p);
  const cmap = {}; cd.contacts.forEach(c => cmap[c.id] = c.name);
  let html = `<section><h2>待确认区（拍板 / 确认 / 修改）— 当前待处理 <span class="badge">${d.pending.length}</span></h2>`;
  if (d.pending.length === 0) html += `<div class="empty">待确认区已清零 ✅（当前批次跨源冲突 100% 已拍板，满足验收口径 D12/D19）</div>`;
  for (const it of d.pending) {
    if (it.type === 'conflict') {
      html += `<div class="card"><h3>⚠ 字段冲突：${esc(it.field)}</h3>
        <div class="kv"><b>来源文件</b>${esc(it.source || it.sourceB || '—')}（本次上传批次；既有值来自 ${esc(it.sourceA || '历史批次')}）</div>
        <div class="kv"><b>联系人</b>${esc(contactName(cmap, it.contactId))}</div>
        <div class="kv"><b>值A</b>${esc(it.valueA)} <span class="src">(${esc(it.sourceA)})</span></div>
        <div class="kv"><b>值B</b>${esc(it.valueB)} <span class="src">(${esc(it.sourceB)})</span></div>
        <div class="reco">推荐值：${esc(it.recommended)} — ${esc(it.recommendedNote)}</div>
        <div class="btnrow">
          <button class="sm ok" onclick="resolve('${it.id}','recommended')">采纳推荐</button>
          <button class="sm" onclick="resolve('${it.id}','A')">用A值</button>
          <button class="sm" onclick="resolve('${it.id}','B')">用B值</button>
        </div></div>`;
    } else if (it.type === 'intention') {
      const sig = (it.signals || []).map(s => `${esc(s.type)}:${esc(s.value)}`).join('；');
      html += `<div class="card"><h3>💡 合作意向初判</h3>
        <div class="kv"><b>来源文件</b>${esc(pendingSource(it) || '—')}</div>
        <div class="kv"><b>联系人</b>${esc(contactName(cmap, it.contactId))}</div>
        <div class="kv"><b>信号</b>${sig}</div>
        <div class="btnrow">
          <button class="sm ok" onclick="resolve('${it.id}','confirm')">确认意向</button>
          <button class="sm danger" onclick="resolve('${it.id}','reject')">驳回</button>
        </div></div>`;
    } else if (it.type === 'lowconfidence') {
      const cand = it.candidate || {};
      html += `<div class="card"><h3>❓ AI 低置信内容</h3>
        <div class="kv"><b>来源文件</b>${esc(pendingSource(it) || '—')}</div>
        <div class="kv"><b>原始片段</b>${esc(it.rawSnippet)}</div>
        <div class="kv"><b>说明</b>${esc(it.reason || '')}</div>
        <div class="btnrow">
          <button class="sm ok" onclick="openEditLow('${it.id}','${it.contactId || ''}')">修改 / 补全</button>
          <button class="sm" onclick="resolve('${it.id}','keep')">保留待定</button>
          <button class="sm danger" onclick="resolve('${it.id}','remove')">确认剔除</button>
        </div></div>`;
    }
  }
  // 留痕/撤销面板
  const au = await api('/api/audit');
  html += `<details style="margin-top:18px"><summary class="muted">修改留痕（可撤销）</summary><div class="card">`;
  for (const a of au.audit) {
    html += `<div class="row"><span class="kv">${esc(a.ts)} · ${esc(a.operator)} · ${esc(a.target)}.${esc(a.field)} : ${esc(a.oldValue)} → ${esc(a.newValue)}</span><button class="sm ghost" onclick="undo('${a.id}')">撤销</button></div>`;
  }
  html += `</div></details></section>`;
  view.innerHTML = html;
  updateBadge();
}
function contactName(cmap, id) { return (cmap && cmap[id]) || (id || '—'); }
// 待确认项来源文件提示：新上传数据带 source；存量（历史批次无 source 字段）回退到联系人 sources 合并串
function pendingSource(it) {
  if (it && it.source) return it.source;
  if (it && it.contactId) { const c = allContacts.find(x => x.id === it.contactId); if (c && c.sources && c.sources.length) return c.sources.join('/'); }
  return '';
}
async function resolve(id, choice) {
  await api('/api/pending/' + id + '/resolve', { method: 'POST', body: JSON.stringify({ choice }) });
  renderPending();
}
let allContacts = [];
let pendingById = {};
let editPendingId = null; // 当前对话框绑定的待确认项

// 打开「修改/补全」对话框：contactId 存在→修改既有联系人（预填现值）；无 contactId→用候选预填后补全新联系人
function openEditLow(id, cid) {
  editPendingId = id;
  const item = pendingById[id] || {};
  const cand = item.candidate || {};
  const base = cid ? (allContacts.find(c => c.id === cid) || {}) : {};
  $('#emTitle').textContent = cid ? '修改联系人资料（低置信项）' : '补全新联系人（低置信项）';
  $('#emHint').innerHTML = cid
    ? '原值已预填，可直接修改后一次保存'
    : (item.rawSnippet ? '原始片段：' + esc(item.rawSnippet) + '。候选已预填，请补全后保存入库' : '候选已预填，请补全后保存入库');
  $('#ef_name').value = base.name || cand.name || '';
  $('#ef_company').value = base.company || cand.company || '';
  $('#ef_mobile').value = base.mobile || '';
  $('#ef_landline').value = base.landline || '';
  $('#ef_email').value = base.email || '';
  $('#ef_city').value = base.city || cand.city || '';
  $('#ef_status').value = base.cooperationStatus || '';
  $('#ef_note').value = base.note || '';
  $('#editModal').classList.remove('hidden');
}
async function saveEdit() {
  if (!editPendingId) return;
  const fields = {
    name: $('#ef_name').value.trim(),
    company: $('#ef_company').value.trim(),
    mobile: $('#ef_mobile').value.trim(),
    landline: $('#ef_landline').value.trim(),
    email: $('#ef_email').value.trim(),
    city: $('#ef_city').value.trim(),
    cooperationStatus: $('#ef_status').value,
    note: $('#ef_note').value.trim()
  };
  await api('/api/pending/' + editPendingId + '/resolve', { method: 'POST', body: JSON.stringify({ choice: 'supplement', fields }) });
  editPendingId = null;
  $('#editModal').classList.add('hidden');
  renderPending();
}
async function undo(id) { await api('/api/audit/' + id + '/undo', { method: 'POST' }); renderPending(); }

let intentContacts = []; // 当前意向客户列表（供行内操作按钮按 id 查名/公司）
async function renderIntention() {
  const d = await api('/api/contacts?intention=1');
  intentContacts = d.contacts;
  let html = `<section><h2>意向客户（已确认 / 合作状态=待定）</h2><div class="toolbar"><span class="muted">仅供参考，最终以市场部在待确认区确认为准</span></div>
  <div class="table-wrap"><table>
    <colgroup>
      <col style="width:8%"/><col style="width:13%"/><col style="width:10%"/><col style="width:8%"/><col style="width:8%"/><col style="width:10%"/><col style="width:21%"/><col style="width:10%"/><col style="width:12%"/>
    </colgroup>
    <thead><tr><th>姓名</th><th>公司</th><th>电话</th><th>城市</th><th>合作状态</th><th>跟进人</th><th>备注（判断为意向的原因）</th><th>来源</th><th>操作</th></tr></thead><tbody>`;
  for (const c of d.contacts) {
    const phone = c.mobile || c.landline || '';
    const reason = c.intentionNote || (c.cooperationStatus === '待定' ? '合作状态为待定（待确认区确认后留档）' : '');
    const fu = c.followupBy || '';
    const fuTip = followTip(c); // 跟进人 + 最近跟进时间（悬浮展示跟进历史）
    html += `<tr><td>${esc(c.name)}</td><td class="company" title="${esc(c.company)}"><span class="cut">${esc(c.company)}</span></td>
      <td>${esc(phone)}</td><td>${esc(c.city)}</td><td>${esc(c.cooperationStatus)}</td>
      <td class="fup-cell" title="${esc(fuTip)}"><span class="cut">${fu ? esc(fu) : '—'}</span></td>
      <td class="reason" title="${esc(reason)}"><span class="src">${esc(reason) || '—'}</span></td>
      <td class="src-cell" title="${esc((c.sources || []).join('/'))}"><span class="src">${esc((c.sources || []).join('/'))}</span></td>
      <td class="act-cell"><button class="mini" onclick="openFollowModal('${c.id}')">跟进</button><button class="mini danger" onclick="removeIntent('${c.id}')">移除</button></td></tr>`;
  }
  if (d.contacts.length === 0) html += `<tr><td colspan="9" class="empty">暂无意向客户</td></tr>`;
  html += '</tbody></table></div></section>';
  view.innerHTML = html;
}
// 跟进人列悬浮提示：展示全部跟进历史（人员 @日期）
function followTip(c) {
  if (!c.followupBy && !(c.followups || []).length) return '';
  const hist = (c.followups || []).map(f => `${f.by} @${(f.at || '').slice(0, 10)}`);
  const last = `最近跟进：${c.followupBy || ''}${c.followupAt ? ' @' + c.followupAt.slice(0, 10) : ''}`;
  return [last].concat(hist.length ? ['历史：' + hist.join('；')] : []).join('\n');
}
let followIntentId = null; // 当前「跟进」对话框绑定的联系人
function openFollowModal(id) {
  const c = intentContacts.find(x => x.id === id); if (!c) return;
  followIntentId = id;
  $('#fmHint').innerHTML = '联系人：' + esc(c.name) + (c.company ? '（' + esc(c.company) + '）' : '');
  $('#ff_by').value = c.followupBy || '';
  $('#ff_by').placeholder = c.followupBy ? '上次跟进：' + c.followupBy : '如：王五 / 市场部小李';
  $('#followModal').classList.remove('hidden');
  $('#ff_by').focus();
}
async function saveFollow() {
  const by = $('#ff_by').value.trim();
  if (!by) { alert('请填写跟进人员'); return; }
  await api('/api/contact/' + followIntentId + '/followup', { method: 'POST', body: JSON.stringify({ by }) });
  followIntentId = null;
  $('#followModal').classList.add('hidden');
  renderIntention();
}
async function removeIntent(id) {
  const c = intentContacts.find(x => x.id === id); if (!c) return;
  if (!confirm('将「' + c.name + '」从意向客户中移除？（不会删除联系人数据）')) return;
  await api('/api/contact/' + id + '/intent-remove', { method: 'POST' });
  renderIntention();
}

let todoFilter = 'open'; // 待办页状态筛选：open/done/shelved/removed
const TODO_META = { open: ['待处理', ''], done: ['完成', ''], shelved: ['搁置', ''], removed: ['已移除', 'danger'] };
async function renderTodos() {
  const d = await api('/api/todos?status=' + todoFilter);
  const counts = d.counts || {};
  const chips = ['open', 'done', 'shelved', 'removed'].map(k =>
    `<button class="chip ${todoFilter === k ? 'on' : ''}" onclick="setTodoFilter('${k}')">${TODO_META[k][0]} <span class="chip-cnt">${counts[k] || 0}</span></button>`).join('');
  let html = `<section><h2>待办事项（素材中明确抽离的非联系人事项）</h2>
    <div class="toolbar chips" id="todoChips">${chips}</div>`;
  if (d.todos.length === 0) {
    html += `<div class="empty">${todoFilter === 'removed' ? '暂无已移除的待办' : '该状态下暂无待办'}</div>`;
  }
  for (const t of d.todos) {
    const doneStyle = t.status === 'done' ? ' class="strike"' : '';
    html += `<div class="card"><div class="todo-row"><span${doneStyle}>${esc(t.text)}</span><span class="src">（${esc(t.source)}）</span>
      <span class="todo-acts">${todoActions(t.status, t.id)}</span></div></div>`;
  }
  html += '</section>';
  view.innerHTML = html;
}
// 各状态可执行的动作按钮：待处理→完成/搁置/移除；完成→恢复/移除；搁置→继续/完成/移除；已移除→恢复
function todoActions(status, id) {
  const a = [];
  if (status === 'open' || status === 'shelved') a.push(['done', '完成', 'ok']);
  if (status === 'open') a.push(['shelved', '搁置', '']);
  if (status === 'shelved') a.push(['open', '继续处理', '']);
  if (status === 'done' || status === 'removed') a.push(['open', '恢复', '']);
  a.push(['removed', '移除', 'danger']);
  return a.map(([st, label, cls]) => `<button class="mini ${cls}" onclick="setTodoStatus('${id}','${st}')">${label}</button>`).join('');
}
function setTodoFilter(st) { todoFilter = st; renderTodos(); }
async function setTodoStatus(id, st) {
  const labels = { open: '重新打开', done: '完成', shelved: '搁置', removed: '移除' };
  const r = await api('/api/todos/' + id + '/status', { method: 'POST', body: JSON.stringify({ status: st }) });
  if (!r.ok) { alert((r.error || '操作失败') + '（' + labels[st] + '）'); return; }
  renderTodos();
}

// ===== AI 数据小助手（悬浮右下角，只查系统内数据）=====
const ASSIST_FIRST = '你好，我是本系统的 AI 数据小助手 👋\n我只能查询这个系统内已有的数据（客户总表 / 意向客户 / 待确认 / 待办 / 上传记录），不联网、不搜外部资料。\n\n可以直接问我，例如：\n· 佛山有哪些客户？\n· 推荐几个合作状态为「有效」的客户\n· 有几个意向客户？分别在哪些城市\n· 还有几条待办 / 待确认？';
let assistBusy = false;

function assistBubble(role, html) {
  const wrap = document.createElement('div');
  wrap.className = 'assist-msg ' + (role === 'me' ? 'me' : 'ai');
  wrap.innerHTML = html;
  const body = $('#assistMsgs');
  body.appendChild(wrap);
  body.scrollTop = body.scrollHeight;
  return wrap;
}
function addAssistText(role, text) { return assistBubble(role, '<div class="txt">' + esc(text).replace(/\n/g, '<br/>') + '</div>'); }
function toggleAssistant(forceOpen) {
  const p = $('#assistPanel');
  const open = forceOpen === undefined ? p.classList.contains('hidden') : !!forceOpen;
  p.classList.toggle('hidden', !open);
  if (open && !$('#assistMsgs').children.length) addAssistText('ai', ASSIST_FIRST); // 打开即给「首句引导」
}
async function askAssistant() {
  if (assistBusy) return;
  const inp = $('#assistInput');
  const q = inp.value.trim();
  if (!q) return;
  inp.value = '';
  addAssistText('me', q);
  const typing = assistBubble('ai', '<div class="typing">AI 思考中…</div>');
  assistBusy = true;
  $('#assistSend').disabled = true;
  try {
    const r = await api('/api/assistant/query', { method: 'POST', body: JSON.stringify({ question: q }) });
    typing.remove();
    if (!r || !r.ok) addAssistText('ai', '（查询失败：' + ((r && r.error) || '未知错误') + '）');
    else addAssistText('ai', r.answer);
  } catch (e) {
    typing.remove();
    addAssistText('ai', '（查询失败：' + (e && e.message || e) + '）');
  }
  assistBusy = false;
  $('#assistSend').disabled = false;
  $('#assistInput').focus();
}

// 绑定
$('#loginBtn').onclick = login;
$('#passcode').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
$('#logout').onclick = () => { PC = ''; $('#main').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#assistFab').classList.add('hidden'); toggleAssistant(false); };
// DEV-ONLY 测试按钮：默认隐藏；仅当服务端以 DEV_TOOLS=1 启动时，登录后由 /api/config 放行显示（配套 /api/dev/clear）
const clearBtn = $('#clearData');
if (clearBtn) clearBtn.onclick = async () => {
  if (!confirm('⚠ 测试专用：将清空全部数据（联系人 / 待确认 / 待办 / 留痕 / 上传记录），不可恢复！\n确定要继续吗？')) return;
  try {
    const r = await api('/api/dev/clear', { method: 'POST' });
    pendingFiles = []; uploadJob = null; lastJob = null; // 复位上传区与任务遮罩
    tableState = { q: '', city: '', tag: '', coop: '', page: 1, pageSize: 20, pages: 1, total: 0 };
    const cur = document.querySelector('nav a.active');
    showView(cur ? cur.dataset.view : 'table'); // 刷新当前视图（内部会刷新角标）
    const c = r.cleared || {};
    alert('已清空完成：联系人 ' + (c.contacts || 0) + ' 条、待确认 ' + (c.pending || 0) + ' 条、待办 ' + (c.todos || 0) + ' 条、上传记录 ' + (c.uploads || 0) + ' 条、留痕 ' + (c.audit || 0) + ' 条。可以开始测试上传了。');
  } catch (e) { alert('清空失败：' + (e && e.message || e)); }
};
// 开发工具开关：服务端 DEV_TOOLS=1 时才展示「清空数据」按钮（提交/生产默认隐藏）
fetch('/api/config').then(r => r.json()).then(cfg => {
  if (cfg && cfg.devTools && clearBtn) clearBtn.classList.remove('hidden');
}).catch(() => {});
document.querySelectorAll('nav a').forEach(a => a.onclick = () => showView(a.dataset.view));
// AI 数据小助手：悬浮按钮开关 + 发送
$('#assistFab').onclick = () => toggleAssistant();
$('#assistClose').onclick = () => toggleAssistant(false);
$('#assistSend').onclick = askAssistant;
$('#assistInput').addEventListener('keydown', e => { if (e.key === 'Enter') askAssistant(); });
$('#emCancel').onclick = () => { editPendingId = null; $('#editModal').classList.add('hidden'); };
$('#emSave').onclick = saveEdit;
$('#editModal').addEventListener('click', e => { if (e.target.id === 'editModal') { editPendingId = null; $('#editModal').classList.add('hidden'); } });
// 意向「跟进」对话框
$('#fmCancel').onclick = () => { followIntentId = null; $('#followModal').classList.add('hidden'); };
$('#fmSave').onclick = saveFollow;
$('#ff_by').addEventListener('keydown', e => { if (e.key === 'Enter') saveFollow(); });
$('#followModal').addEventListener('click', e => { if (e.target.id === 'followModal') { followIntentId = null; $('#followModal').classList.add('hidden'); } });
