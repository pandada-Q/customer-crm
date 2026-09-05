'use strict';
// 运行首批量规整管线并将结果导入应用数据库（03 入库数据源）
// 用法: node run-firstbatch.js [--force]  （--force 覆盖已有数据重新导入）
const path = require('path');
const store = require('./lib/store');
const { buildNormalization } = require('./lib/pipeline');

const ROOT = __dirname;
const INPUT_DIR = path.resolve(ROOT, '..', 'input');
const DB_PATH = path.resolve(ROOT, 'data', 'db.json');
const force = process.argv.includes('--force');

const pkg = buildNormalization(INPUT_DIR);
const state = store.load(DB_PATH);

if (state.contacts.length > 0 && !force) {
  console.log('[跳过] 数据库已有 ' + state.contacts.length + ' 条联系人，未执行导入。如需重新导入请加 --force。');
  console.log('规整包预览（未写入）: 联系人 ' + pkg.stats.contactCount + ' / 冲突 ' + pkg.stats.conflictCount + ' / 意向 ' + pkg.stats.intentionCount + ' / 低置信 ' + pkg.stats.lowconfCount + ' / 待办 ' + pkg.stats.todoCount + ' / 剔除 ' + pkg.stats.removedCount);
  process.exit(0);
}

// 记录剔除留痕（D5③）
for (const r of pkg.removed) {
  store.recordAudit(state, { operator: 'pipeline', target: 'remove', refId: '-', field: 'contact', oldValue: r.sample, newValue: '', note: '剔除:' + r.reason });
}
// 导入
state.contacts = pkg.contacts;
state.pending = pkg.pending;
state.todos = pkg.todos;
state.meta.importedAt = pkg.generatedAt;
state.meta.passcodeConfigured = !!process.env.CRM_PASSCODE;
store.recordAudit(state, { operator: 'pipeline', target: 'import', refId: '-', field: 'batch', oldValue: '', newValue: '首批 ' + pkg.stats.contactCount + ' 联系人', note: '首批量规整导入' });

store.save(DB_PATH, state);
console.log('[完成] 首批量导入:');
console.log('  联系人      : ' + pkg.stats.contactCount);
console.log('  冲突待确认  : ' + pkg.stats.conflictCount);
console.log('  意向初判    : ' + pkg.stats.intentionCount);
console.log('  低置信      : ' + pkg.stats.lowconfCount);
console.log('  待办        : ' + pkg.stats.todoCount);
console.log('  剔除(留痕) : ' + pkg.stats.removedCount);
console.log('  跳过素材    : ' + pkg.skipped.map(s => s.file + '(' + s.reason + ')').join('; '));
console.log('DB -> ' + DB_PATH);
