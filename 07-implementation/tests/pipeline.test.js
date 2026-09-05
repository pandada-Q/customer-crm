'use strict';
// 数据规整管线测试（验证先行）：以真实 input/ 素材为输入，断言 spec §7 验收事实
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildNormalization, parseContent } = require('../lib/pipeline');
const clean = require('../lib/clean');
const { RULE_SECTION } = require('../lib/rules');

const INPUT_DIR = path.resolve(__dirname, '..', '..', 'input');
const pkg = buildNormalization(INPUT_DIR);
const byName = {};
pkg.contacts.forEach(c => { byName[c.name] = c; });
const conflicts = pkg.pending.filter(p => p.type === 'conflict');
const intentions = pkg.pending.filter(p => p.type === 'intention');
const lowconf = pkg.pending.filter(p => p.type === 'lowconfidence');

test('刘洋/蓝天贸易 合并为 1 个联系人并保留全部来源（D3）', () => {
  const c = byName['刘洋'];
  assert.ok(c, '应有刘洋');
  assert.equal(c.company, '蓝天贸易');
  // 来源应含 备份0812 与 市场部（正本）
  assert.ok(c.sources.some(s => s.includes('备份0812')), '来源含备份0812');
  assert.ok(c.sources.some(s => s.includes('市场部')), '来源含市场部名单');
});

test('两份相同的市场部名单（正本+副本）不产生重复联系人（D3）', () => {
  const liuyang = pkg.contacts.filter(c => c.name === '刘洋' && c.company === '蓝天贸易');
  assert.equal(liuyang.length, 1, '刘洋只应 1 个');
  // 全量联系人数量合理（~24），不应因副本翻倍
  assert.ok(pkg.contacts.length >= 22 && pkg.contacts.length <= 28, '联系人数应在 22-28 之间，实际 ' + pkg.contacts.length);
});

test('张伟 手机冲突：13812345678 vs 13912340001（D3/D16）', () => {
  const zhang = byName['张伟'];
  assert.ok(zhang, '应有张伟');
  const cf = conflicts.find(p => p.contactId === zhang.id && p.field === 'mobile');
  assert.ok(cf, '应有手机冲突待确认项');
  assert.ok(cf.valueA === '13812345678' && cf.valueB === '13912340001' || cf.valueA === '13912340001' && cf.valueB === '13812345678', '冲突两值正确');
});

test('吴敏 城市冲突：长沙 vs 武汉（D3/D16）', () => {
  const wu = byName['吴敏'];
  assert.ok(wu, '应有吴敏');
  const cf = conflicts.find(p => p.contactId === wu.id && p.field === 'city');
  assert.ok(cf, '应有城市冲突待确认项');
  assert.ok([cf.valueA, cf.valueB].includes('长沙') && [cf.valueA, cf.valueB].includes('武汉'), '冲突两值含长沙与武汉');
});

test('郑浩 两源均为"众合机械"，无公司名冲突（不臆造不存在的冲突）', () => {
  const zheng = byName['郑浩'];
  assert.ok(zheng, '应有郑浩');
  assert.equal(zheng.company, '众合机械');
  const cf = conflicts.find(p => p.contactId === zheng.id && p.field === 'company');
  assert.equal(cf, undefined, '郑浩不应有公司名冲突（真实素材两源一致）');
});

test('手机归一：139 0013 5566 → 13900135566；+86 13711112222 → 13711112222（D1/D5）', () => {
  assert.equal(byName['李娜'].mobile, '13900135566');
  assert.equal(byName['王强'].mobile, '13711112222');
});

test('座机分离：冯军 0755-88881234 入座机字段（D1）', () => {
  const feng = byName['冯军'];
  assert.equal(feng.mobile, '13012340000');
  assert.equal(feng.landline, '0755-88881234');
});

test('城市口语归一：王芳「苏州那边的」→ 苏州（D5）', () => {
  assert.equal(byName['王芳'].city, '深圳' === byName['王芳'].city ? byName['王芳'].city : byName['王芳'].city); // 占位
  assert.equal(byName['王芳'].city, '苏州', '王芳城市应归一到苏州');
});

test('测试号与占位行剔除并留痕（D5③）', () => {
  assert.equal(pkg.contacts.some(c => c.mobile === '13800000000' || c.email === 'test@test.com' || c.name === '测试'), false, '测试号不应入库');
  assert.equal(pkg.contacts.some(c => c.name === '' && c.company === '待补充'), false, '占位行不应入库');
  assert.ok(pkg.removed.length >= 2, '应有至少 2 条剔除留痕');
});

test('待办抽离：约饭提醒 + 回头找电话（D5④/D7）', () => {
  const texts = pkg.todos.map(t => t.text).join(' || ');
  assert.ok(texts.includes('张伟总监说下周约饭 记得提醒'), '应含约饭提醒');
  assert.ok(texts.includes('高工 精工机械 具体电话回头找一下'), '应含回头找电话');
  for (const t of pkg.todos) assert.equal(t.status, 'open', '新待办默认状态为待处理 open');
});

test('意向初判候选：韩雪/钱进(待定) + 郑浩/李莉(备注语义)', () => {
  const names = intentions.map(p => byId(pkg, p.contactId).name);
  for (const n of ['韩雪', '钱进', '郑浩', '李莉']) assert.ok(names.includes(n), '意向候选应含 ' + n);
});

test('低置信：周杰 短号保留原号码且提示精确 + 高工 电话待补（D21）', () => {
  const zhou = byName['周杰'];
  assert.ok(zhou, '应有周杰');
  assert.equal(zhou.mobile, '1391234567', '10 位短号应保留在手机字段，不静默丢弃');
  const lp = lowconf.find(p => p.contactId === zhou.id);
  assert.ok(lp, '周杰短号应进低置信');
  assert.ok(lp.reason.includes('1391234567') && lp.reason.includes('位数不足'), '低置信原因应精确提示位数不足并带原号码，实际: ' + lp.reason);
  assert.ok(lowconf.some(p => p.contactId === null && p.rawSnippet && p.rawSnippet.includes('高工')), '高工应进低置信(无联系人id)');
});

test('标签去重：相同标签（数组/分隔串）只保留一个', () => {
  assert.deepEqual(clean.normalizeTagList(['客户', '客户', '供应商']), ['客户', '供应商']);
  assert.deepEqual(clean.normalizeTagList('客户/客户、供应商,供应商'), ['客户', '供应商']);
  assert.deepEqual(clean.normalizeTagList(['客户', '老客户']), ['客户'], '老客户归一为客户并去重');
});

test('待确认条目携带来源文件（来源提示用）', () => {
  for (const p of intentions) assert.ok(p.source, 'intention 待确认应有 source 字段（缺:' + p.id + '）');
  const wu = byName['吴敏'];
  const cf = conflicts.find(p => p.contactId === wu.id && p.field === 'city');
  assert.ok(cf && cf.sourceB, '冲突待确认应含本次冲突来源文件 sourceB');
});

test('错位逗号自动对齐：秦岚公司还原为完整名且各列归位（备份0812 实样）', () => {
  const csv = 'ID,姓名,公司,手机,城市,最近联系,录入人\n1005,秦岚,深圳市创新,科技有限公司,13699887766,深圳,2026/07/30,小陈';
  const p = parseContent('备份0812.csv', csv);
  assert.equal(p.raw.length, 1, '应正常导入 1 条');
  assert.equal(p.lowconf.length, 0, '可自动修复的行不进待确认');
  const f = p.raw[0].f;
  assert.equal(f.company, '深圳市创新科技有限公司', '公司名应合并还原完整');
  assert.equal(f.mobile, '13699887766', '手机列归位');
  assert.equal(f.city, '深圳', '城市列归位');
  assert.equal(f.note, '最近联系:2026/07/30', '最近联系日期归位到备注');
  assert.equal(f['录入人'], '小陈', '录入人归位');
});

test('多段错位无法自动对齐：跳过导入并转低置信人工核对（11轮④兜底）', () => {
  const csv = 'ID,姓名,公司,手机,城市,最近联系,录入人\n1005,秦岚,深圳市,创新,科技,13699887766,深圳,2026/07/30,小陈';
  const p = parseContent('备份0812.csv', csv);
  assert.equal(p.raw.length, 0, '无法置信修复的行不得静默错位导入');
  assert.equal(p.lowconf.length, 1, '应生成一条低置信待确认');
  assert.ok(p.lowconf[0].rawSnippet.includes('深圳市,创新,科技'), '低置信附原始行');
  assert.ok(p.lowconf[0].note.includes('无法自动对齐'), '低置信说明原因');
});

test('引号包裹含逗号字段解析不受对齐逻辑影响', () => {
  const csv = '姓名,公司,手机\n张三,"深圳市创新,科技有限公司",13911112222';
  const p = parseContent('t.csv', csv);
  assert.equal(p.raw[0].f.company, '深圳市创新,科技有限公司', '合法引号字段保持原样');
});

test('数据清洗规则手册存在且覆盖历史脏数据（注入大模型用）', () => {
  assert.ok(RULE_SECTION.includes('深圳市创新,科技有限公司'), 'R1 公司名误拆规则在册');
  assert.ok(RULE_SECTION.includes('1391234567'), 'R2 短号保留规则在册');
  assert.ok(RULE_SECTION.includes('有效'), 'R3 合作状态三枚举在册');
  assert.ok(RULE_SECTION.includes('lowconf'), 'R10 低置信分流规则在册');
});

function byId(pkg, id) { return pkg.contacts.find(c => c.id === id); }
