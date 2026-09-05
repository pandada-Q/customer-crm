'use strict';
// JSON 文件数据库 + 统一留痕 / 撤销底层（D18②）
// 单一文件存储，原子写。作为「轻量后端 + 数据库」的本地可运行实现。
const fs = require('fs');
const path = require('path');

// 待办状态机：open 待处理 / done 完成 / shelved 搁置 / removed 移除
const TODO_STATUS = ['open', 'done', 'shelved', 'removed'];

function defaultState() {
  return {
    contacts: [],   // 统一 schema 主数据（D1/D10）
    pending: [],    // 待确认条目：conflict / intention / lowconfidence（D3/D6/D21）
    todos: [],      // 非联系人事项（D7）
    audit: [],      // 修改留痕（D18②）
    uploads: [],    // 上传处理记录（每文件一条：过程明细+结果统计，供右栏「上传处理记录」面板）
    meta: { importedAt: null, passcodeConfigured: false, version: 1 }
  };
}

function load(dbPath) {
  if (!fs.existsSync(dbPath)) return defaultState();
  try {
    const s = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    // 容错补全字段
    const state = Object.assign(defaultState(), s);
    // 旧版待办迁移：无 status 时按 done 推导（done:true→done，其余→open）
    if (Array.isArray(state.todos)) {
      for (const t of state.todos) {
        if (t && !t.status) t.status = t.done ? 'done' : 'open';
      }
    }
    if (!Array.isArray(state.uploads)) state.uploads = [];
    return state;
  } catch (e) {
    return defaultState();
  }
}

function save(dbPath, state) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = dbPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, dbPath);
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 写一条留痕。entry: { operator, target, refId, field, oldValue, newValue, pendingId?, note }
function recordAudit(state, entry) {
  const rec = Object.assign({ id: newId('a'), ts: new Date().toISOString(), undone: false }, entry);
  state.audit.push(rec);
  return rec;
}

// 对联系人字段做受审计的变更；返回 audit 记录
function setContactField(state, contactId, field, newValue, operator, note) {
  const c = state.contacts.find(x => x.id === contactId);
  if (!c) return null;
  const oldValue = c[field];
  if (oldValue === newValue) return null; // 无变化不记
  c[field] = newValue;
  return recordAudit(state, { operator, target: 'contact', refId: contactId, field, oldValue, newValue, note: note || '' });
}

// 待办状态变更（受审计）。status ∈ TODO_STATUS；返回 audit 记录
function setTodoStatus(state, todoId, status, operator) {
  const t = state.todos.find(x => x.id === todoId);
  if (!t) return null;
  const old = t.status || (t.done ? 'done' : 'open');
  if (old === status) return null;
  t.status = status;
  t.done = (status === 'done'); // 与旧版 done 字段保持同步（兼容遗留读取）
  const labels = { open: '重新打开', done: '完成', shelved: '搁置', removed: '移除' };
  return recordAudit(state, { operator, target: 'todo', refId: todoId, field: 'status', oldValue: old, newValue: status, note: '待办' + (labels[status] || status) });
}

// 撤销某条 audit 记录（D18②）。返回被撤销的记录或 null
function undoAudit(state, auditId, operator) {
  const idx = state.audit.findIndex(a => a.id === auditId);
  if (idx < 0) return null;
  const a = state.audit[idx];
  if (a.undone) return null;
  if (a.target === 'contact') {
    const c = state.contacts.find(x => x.id === a.refId);
    if (c) c[a.field] = a.oldValue;
    // 若这条 audit 是某待确认项的拍板，撤销时重开该待确认项
    if (a.pendingId) {
      const p = state.pending.find(x => x.id === a.pendingId);
      if (p) { p.status = 'open'; p.resolution = null; }
    }
  } else if (a.target === 'todo') {
    const t = state.todos.find(x => x.id === a.refId);
    if (t) {
      if (a.field === 'done') { // 旧版勾选留痕：回滚 done 并推导 status
        t.done = a.oldValue;
        t.status = a.oldValue ? 'done' : 'open';
      } else if (a.field === 'status') {
        t.status = a.oldValue || 'open';
        t.done = (t.status === 'done');
      }
    }
  } else if (a.target === 'pending') {
    // 直接对待确认项的处置（如低置信补录写入新联系人）
    if (a.pendingId) {
      const p = state.pending.find(x => x.id === a.pendingId);
      if (p) { p.status = 'open'; p.resolution = null; }
    }
  }
  a.undone = true;
  recordAudit(state, { operator: operator || 'system', target: 'undo', refId: a.id, field: a.field, oldValue: a.newValue, newValue: a.oldValue, note: '撤销' });
  return a;
}

module.exports = { defaultState, load, save, newId, recordAudit, setContactField, setTodoStatus, undoAudit, TODO_STATUS };
