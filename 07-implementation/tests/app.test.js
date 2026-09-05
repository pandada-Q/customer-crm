'use strict';
// 应用行为测试：口令 / 拍板即时生效+留痕撤销 / 待办状态流转 / 上传 D17 分流 / 更正清单路径B / 上传处理记录
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 在 require server 前设置隔离 DB 与口令
const TMP_DB = path.join(os.tmpdir(), 'crm-test-' + Date.now() + '.json');
process.env.CRM_DB = TMP_DB;
process.env.CRM_PASSCODE = 'test123';
process.env.PORT = '0';
process.env.LLM_PROVIDER = 'rule'; // 测试一律走本地 rule（抽取/助手问答均不真实调用大模型）

const { buildNormalization } = require('../lib/pipeline');
const store = require('../lib/store');
const { server } = require('../server');
const INPUT_DIR = path.resolve(__dirname, '..', '..', 'input');

let baseURL, PC = 'test123';

function seed() {
  const pkg = buildNormalization(INPUT_DIR);
  const state = store.load(TMP_DB);
  state.contacts = pkg.contacts; state.pending = pkg.pending; state.todos = pkg.todos;
  store.save(TMP_DB, state);
}
async function api(method, p, body) {
  const r = await fetch(baseURL + p + (p.includes('?') ? '&' : '?') + 'passcode=' + PC, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

test.before(async () => {
  seed();
  await new Promise(res => server.listen(0, res));
  baseURL = 'http://localhost:' + server.address().port;
});

test('健康与口令鉴权（D18①）', async () => {
  let r = await fetch(baseURL + '/api/health'); assert.equal(r.status, 200);
  r = await fetch(baseURL + '/api/contacts'); assert.equal(r.status, 401, '无口令应拒绝');
  const login = await fetch(baseURL + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: 'wrong' }) });
  assert.equal(login.status, 401, '错误口令拒绝');
  const ok = await fetch(baseURL + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: PC }) });
  assert.equal(ok.status, 200, '正确口令放行');
});

test('总表只读展示 + 搜索（D2/D10）', async () => {
  let r = await api('GET', '/api/contacts');
  assert.ok(r.json.contacts.length >= 22, '总表有联系人');
  r = await api('GET', '/api/contacts?q=' + encodeURIComponent('张伟'));
  assert.ok(r.json.contacts.some(c => c.name === '张伟'), '搜索张伟命中');
});

test('冲突拍板即时生效 + 留痕可撤销（D16/D18②）', async () => {
  const pend = (await api('GET', '/api/pending')).json.pending;
  const zhang = (await api('GET', '/api/contacts?q=' + encodeURIComponent('张伟'))).json.contacts.find(c => c.name === '张伟');
  const cf = pend.find(p => p.contactId === zhang.id && p.field === 'mobile');
  assert.ok(cf, '张伟手机冲突在待确认区');
  // 采纳推荐
  let r = await api('POST', '/api/pending/' + cf.id + '/resolve', { choice: 'recommended' });
  assert.ok(r.json.ok);
  let after = (await api('GET', '/api/contacts?q=' + encodeURIComponent('张伟'))).json.contacts.find(c => c.name === '张伟');
  assert.equal(after.mobile, cf.recommended, '拍板后总表即时见推荐值');
  // 撤销
  const au = (await api('GET', '/api/audit')).json.audit;
  const last = au.find(a => a.field === 'mobile' && a.refId === zhang.id);
  assert.ok(last, '应有手机字段留痕');
  r = await api('POST', '/api/audit/' + last.id + '/undo');
  assert.ok(r.json.ok, '撤销成功');
  const reverted = (await api('GET', '/api/contacts?q=' + encodeURIComponent('张伟'))).json.contacts.find(c => c.name === '张伟');
  assert.notEqual(reverted.mobile, cf.recommended, '撤销后回到拍板前值');
});

test('待办状态机：完成/搁置/移除 + 状态筛选（替代勾选）', async () => {
  const todos = (await api('GET', '/api/todos')).json.todos;
  assert.ok(todos.length >= 1);
  const t = todos[0];
  // 非法状态 400
  let r = await api('POST', '/api/todos/' + t.id + '/status', { status: 'xx' });
  assert.equal(r.status, 400, '非法状态应拒绝');
  // 完成
  r = await api('POST', '/api/todos/' + t.id + '/status', { status: 'done' });
  assert.ok(r.json.ok);
  let got = (await api('GET', '/api/todos?status=done')).json;
  assert.ok(got.todos.some(x => x.id === t.id), 'done 筛选命中');
  assert.equal(got.counts.done >= 1, true);
  // 搁置
  await api('POST', '/api/todos/' + t.id + '/status', { status: 'shelved' });
  got = (await api('GET', '/api/todos?status=shelved')).json;
  assert.ok(got.todos.some(x => x.id === t.id), 'shelved 筛选命中');
  assert.ok(!(await api('GET', '/api/todos?status=done')).json.todos.some(x => x.id === t.id), '改状态后不再出现在 done');
  // 移除（留在 removed 筛选，供恢复）
  await api('POST', '/api/todos/' + t.id + '/status', { status: 'removed' });
  got = (await api('GET', '/api/todos?status=removed')).json;
  assert.ok(got.todos.some(x => x.id === t.id), 'removed 筛选命中');
  // 恢复
  await api('POST', '/api/todos/' + t.id + '/status', { status: 'open' });
  got = (await api('GET', '/api/todos?status=open')).json;
  assert.equal(got.todos.some(x => x.id === t.id), true, '恢复后回到待处理');
  // 待办状态变更留痕，撤销可回滚
  const au = (await api('GET', '/api/audit')).json.audit;
  const rec = au.find(a => a.target === 'todo' && a.field === 'status' && a.refId === t.id);
  assert.ok(rec, '状态变更应有留痕');
  r = await api('POST', '/api/audit/' + rec.id + '/undo');
  assert.ok(r.json.ok, '撤销状态变更成功');
});

test('上传新批次 D17 分流：不冲突直入（D17）', async () => {
  const before = (await api('GET', '/api/contacts')).json.total;
  const csv = '姓名,公司,手机,城市\n新客户,新测试公司,13900001111,北京';
  let r = await api('POST', '/api/upload', { filename: '新批次.csv', content: csv, mode: 'batch' });
  assert.equal(r.status, 200);
  const after = (await api('GET', '/api/contacts')).json.total;
  assert.equal(after, before + 1, '不冲突新联系人应直入');
  const found = (await api('GET', '/api/contacts?q=' + encodeURIComponent('新客户'))).json.contacts.find(c => c.name === '新客户');
  assert.ok(found && found.sources.includes('新批次.csv'), '新联系人带来源标注');
});

test('更正清单(路径B)识别为修正指令，修正既有联系人而非新增（D20-B）', async () => {
  const before = (await api('GET', '/api/contacts')).json.total;
  const csv = '姓名,公司,手机,城市\n李娜,华信科技,13900135566,广州天河';
  let r = await api('POST', '/api/upload', { filename: '更正清单.txt', content: csv, mode: 'correction' });
  assert.equal(r.status, 200);
  assert.ok(r.json.corrections.length >= 1, '应识别为修正指令并修正李娜');
  const after = (await api('GET', '/api/contacts')).json.total;
  assert.equal(after, before, '更正清单不应新增联系人');
});

test('意向客户：跟进记录跟进人 + 可移出意向列表（均留痕）', async () => {
  // 制造一个 合作状态=待定 的意向客户（batch 直入即进意向列表）
  const csv = '姓名,公司,手机,城市,合作状态\n跟进甲,测试跟进公司,13900002222,上海,待定';
  await api('POST', '/api/upload', { filename: '跟进批次.csv', content: csv, mode: 'batch' });
  let list = (await api('GET', '/api/contacts?intention=1')).json.contacts;
  const t = list.find(c => c.name === '跟进甲');
  assert.ok(t, '待定新客户应出现在意向列表');
  assert.ok(t.sources.includes('跟进批次.csv'), '新联系人带来源标注');

  // 跟进：缺人 400，合法入库 followupBy/followups
  let r = await api('POST', '/api/contact/' + t.id + '/followup', { by: '   ' });
  assert.equal(r.status, 400, '空跟进人应拒绝');
  r = await api('POST', '/api/contact/' + t.id + '/followup', { by: '市场部王五' });
  assert.equal(r.status, 200); assert.ok(r.json.ok);
  let got = (await api('GET', '/api/contact/' + t.id)).json.contact;
  assert.equal(got.followupBy, '市场部王五');
  assert.equal((got.followups || []).length, 1, '跟进历史记录 1 条');
  await api('POST', '/api/contact/' + t.id + '/followup', { by: '张三' });
  got = (await api('GET', '/api/contact/' + t.id)).json.contact;
  assert.equal((got.followups || []).length, 2, '二次跟进追加历史');

  // 移除：不在意向列表，intentionConfirmed=false、待定状态清空，联系人仍在总表
  r = await api('POST', '/api/contact/' + t.id + '/intent-remove');
  assert.equal(r.status, 200); assert.ok(r.json.ok);
  list = (await api('GET', '/api/contacts?intention=1')).json.contacts;
  assert.ok(!list.some(c => c.id === t.id), '移除后不在意向列表');
  const after = (await api('GET', '/api/contact/' + t.id)).json.contact;
  assert.equal(after.intentionConfirmed, false);
  assert.notEqual(after.cooperationStatus, '待定', '因待定进列表的移除后清空待定');
  const still = (await api('GET', '/api/contacts?q=' + encodeURIComponent('跟进甲'))).json.contacts;
  assert.ok(still.some(c => c.id === t.id), '联系人数据不被删除，仅移出意向');
});

test('上传处理记录：每次上传落 uploads 日志（统计+过程明细）', async () => {
  const csv = '姓名,公司,手机,城市,合作状态\n日志甲,记录测试公司,13900003333,北京,待定';
  const r = await api('POST', '/api/upload', { filename: '记录测试.csv', content: csv, mode: 'batch' });
  assert.equal(r.status, 200);
  const up = (await api('GET', '/api/uploads')).json.uploads;
  assert.ok(up.length >= 1, '应有上传记录');
  const rec = up.find(e => e.filename === '记录测试.csv');
  assert.ok(rec, '记录含该文件名');
  assert.equal(rec.mode, 'batch');
  assert.equal(rec.added, 1, '统计新增 1');
  assert.ok(Array.isArray(rec.notes) && rec.notes.some(n => n.includes('新增直入：日志甲')), '明细含处理过程');
  assert.ok(rec.ts && rec.id, '记录带时间戳与 id');
});

test('跟进人在意向列表可查询（供页面「跟进人」列）', async () => {
  const csv = '姓名,公司,手机,城市,合作状态\n跟乙,意向跟进乙公司,13900004444,广州,待定';
  await api('POST', '/api/upload', { filename: '跟进乙.csv', content: csv, mode: 'batch' });
  const t = (await api('GET', '/api/contacts?intention=1')).json.contacts.find(c => c.name === '跟乙');
  assert.ok(t, '待定新客户在意向列表');
  await api('POST', '/api/contact/' + t.id + '/followup', { by: '李经理' });
  const c = (await api('GET', '/api/contact/' + t.id)).json.contact;
  assert.equal(c.followupBy, '李经理', '跟进人字段可查（页面跟进人列数据源）');
});

test('AI 数据小助手端点：鉴权/校验/本地检索答复（rule）', async () => {
  // 无口令 → 401
  let r = await fetch(baseURL + '/api/assistant/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '佛山有哪些客户' }) });
  assert.equal(r.status, 401, '未带口令应拒绝');
  // 空问题 → 400
  r = await api('POST', '/api/assistant/query', { question: '   ' });
  assert.equal(r.status, 400, '空问题应拒绝');
  // 正常问题 → rule 本地答复，含检索/概况
  r = await api('POST', '/api/assistant/query', { question: '佛山有哪些客户' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.provider, 'rule');
  assert.ok(r.json.answer && r.json.answer.length > 0, '有答复内容');
  assert.ok(/匹配联系人|数据概况/.test(r.json.answer), '答复含检索结果或数据概况');
  assert.ok(r.json.stats && r.json.stats.contacts >= 1, '返回数据概况统计');
});

test.after(() => { try { fs.unlinkSync(TMP_DB); } catch {} server.close(); });
