'use strict';
// AI 数据小助手（lib/assistant）单元测试：概况统计 / 检索圈定 / 离线答复（不依赖真实大模型）
const test = require('node:test');
const assert = require('node:assert');
const { ask, buildContext, summarize } = require('../lib/assistant');

function makeState() {
  return {
    contacts: [
      { id: 'c1', name: '王强', company: '宏图建材', mobile: '13711112222', landline: '', email: '', city: '佛山', note: '老客户，长期合作', tags: ['客户'], sources: ['名单A.csv'], cooperationStatus: '有效', intentionConfirmed: false, followupBy: '小王' },
      { id: 'c2', name: '李娜', company: '华信科技', mobile: '13900135566', landline: '', email: '', city: '广州', note: '展会认识，可跟进', tags: ['供应商'], sources: ['名单B.csv'], cooperationStatus: '待定', intentionConfirmed: true },
      { id: 'c3', name: '赵工', company: '精工机械', mobile: '', landline: '', email: '', city: '东莞', note: '电话待补', tags: ['客户'], sources: ['微信.txt'], cooperationStatus: '', intentionConfirmed: false }
    ],
    pending: [{ id: 'p1', type: 'lowconfidence', contactId: 'c3', status: 'open', rawSnippet: '赵工 精工机械', reason: '缺少电话，AI 低置信' }],
    todos: [{ id: 't1', text: '张伟总监说下周约饭 记得提醒', source: '微信.txt', status: 'open' }],
    uploads: [{ id: 'u1', filename: '名单A.csv', ts: new Date().toISOString(), added: 1, merged: 0, conflict: 0, intention: 0, lowconf: 0, todos: 0 }]
  };
}

test('助手：数据概况统计（总量/意向/状态/待办/上传）', () => {
  const st = summarize(makeState());
  assert.equal(st.contacts, 3);
  assert.equal(st.intention, 1, '待定/意向确认的计入意向');
  assert.equal(st.coop['有效'], 1);
  assert.equal(st.coop['待定'], 1);
  assert.equal(st.pendingOpen, 1);
  assert.equal(st.pType.lowconfidence, 1);
  assert.deepEqual(st.todos, { open: 1, done: 0, shelved: 0, removed: 0 });
  assert.equal(st.uploads, 1);
});

test('助手：检索圈定——按城市/状态/号码/意向命中', async () => {
  const state = makeState();
  // 城市
  let ctx = buildContext(state, '佛山有哪些客户');
  assert.ok(ctx.pool.some(c => c.name === '王强'), '佛山命中王强');
  assert.ok(!ctx.pool.some(c => c.name === '李娜'), '李娜不在佛山');
  // 意向
  ctx = buildContext(state, '有几个意向客户');
  assert.ok(ctx.pool.some(c => c.name === '李娜'), '意向问题应含李娜');
  // 号码
  ctx = buildContext(state, '查 13900135566');
  assert.ok(ctx.pool.some(c => c.name === '李娜'), '号码命中李娜');
  // 状态
  ctx = buildContext(state, '有效客户有哪些');
  assert.ok(ctx.pool.some(c => c.name === '王强'), '有效命中王强');
});

test('助手：离线答复——命中给明细、数据段随关键词出现', async () => {
  const state = makeState();
  let r = await ask(state, '佛山有哪些客户', { provider: 'rule' });
  assert.equal(r.provider, 'rule');
  assert.equal(r.offline, true);
  assert.ok(r.answer.includes('王强'), '答复含命中联系人');
  assert.ok(r.answer.includes('数据概况'), '答复含数据概况');
  r = await ask(state, '有什么待办', { provider: 'rule' });
  assert.ok(r.answer.includes('约饭'), '待办关键词带出待办明细');
  r = await ask(state, '不存在的路人甲是谁', { provider: 'rule' });
  assert.ok(/未检索到|系统内未找到/.test(r.answer), '无命中时明确告知未找到');
});

test('助手：注入快照包含数据概况与联系人一行描述（供大模型）', () => {
  const ctx = buildContext(makeState(), '佛山有哪些客户');
  assert.ok(ctx.text.includes('【数据概况】'));
  assert.ok(ctx.text.includes('王强｜宏图建材'), '一行描述含关键字段');
  assert.ok(ctx.stats && ctx.stats.contacts >= 1);
});
