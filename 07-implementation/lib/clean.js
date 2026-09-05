'use strict';
// 清洗归一工具（D1/D5）：手机/座机分列、城市口语归一、tag 枚、测试号/占位行识别

// 从任意字符串中抽取规范手机（11 位，1 开头）；返回 null 表示无手机或非法
function extractMobile(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/\s+/g, '');
  s = s.replace(/^\+?86/, '');           // 去国际前缀 +86 / 86
  s = s.replace(/[^\d]/g, '');           // 仅留数字
  if (/^1[3-9]\d{9}$/.test(s)) return s; // 合法 11 位手机
  return null;
}

// 从任意字符串中抽取座机（0 开头的区号+号码）
function extractLandline(raw) {
  if (!raw) return null;
  const m = String(raw).match(/0\d{2,3}-?\d{7,8}/);
  return m ? m[0] : null;
}

// 合作状态归一（D11 三值 + 口语推断）：有效=已合作/合作中，暂停=暂停合作，待定=有合作意向
const COOP_ENUM = ['有效', '暂停', '待定'];
function normalizeCooperationStatus(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s) return '';
  if (COOP_ENUM.includes(s)) return s;
  if (/(暂停|暂缓|暂不合作|先不合作)/.test(s)) return '暂停';
  if (/(已合作|合作中|正在合作|长期合作|合作过|一直合作|在合作|老客户)/.test(s)) return '有效';
  if (/(展会认识|可跟进|有意向|待合作|想合作|潜在|可做|在谈|约见|下半年)/.test(s)) return '待定';
  return ''; // 无法识别 → 不入库，避免污染状态枚举
}

// 手机是否「看似合法但位数不足」——用于低置信判定（如 1391234567 仅 10 位）
function isMalformedMobile(raw) {
  if (!raw) return false;
  const s = String(raw).replace(/\s+/g, '').replace(/^\+?86/, '').replace(/[^\d]/g, '');
  return s.length > 0 && s.length < 11 && /^1\d+$/.test(s);
}

// 手机槽归一：合法 11 位 → 规范化手机号；
// 1 开头但位数不足（7~10 位，如 1391234567 仅 10 位）→ 保留原数字串，不静默丢弃——
// 否则号码在解析期被清空、低置信会误报为「缺少任何电话」且看不到原号码；
// 0 开头座机 / 非号码 → 空串（座机走 landline 槽单独处理）
function mobileSlot(raw) {
  const m = extractMobile(raw);
  if (m) return m;
  const s = String(raw == null ? '' : raw).replace(/\s+/g, '').replace(/^\+?86/, '').replace(/[^\d]/g, '');
  if (s && s.length < 11 && /^1[3-9]\d{6,9}$/.test(s)) return s;
  return '';
}

// 城市口语归一到地级市
const CITY_MAP = {
  '深圳那边的': '深圳', '深圳那边': '深圳', '苏州那边的': '苏州', '苏州那边': '苏州',
  '佛山那边的': '佛山', '东莞那边的': '东莞', '广州那边的': '广州', '武汉那边的': '武汉',
  '长沙那边的': '长沙', '宁波那边的': '宁波', '中山那边的': '中山', '惠州那边的': '惠州',
  '珠海那边的': '珠海', '杭州那边的': '杭州', '北京那边的': '北京', '上海那边的': '上海'
};
function normalizeCity(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (CITY_MAP[s]) return CITY_MAP[s];
  return s.replace(/(那边的|那边|院附|附院)$/, '').trim();
}

// tag 归一枚举（D5②）：客户 / 供应商 / 合作伙伴 / 内部 / 待定
const TAG_ENUM = { '客户': '客户', '老客户': '客户', '供应商': '供应商', '合作伙伴': '合作伙伴', '内部': '内部', '新增': '待定', '待定': '待定', '': '' };
// 标签列表清洗：分割/归一后按集合去重——同一来源重复（如 JSON 里 tags:["客户","客户"]）或分隔重复均只保留一个
function normalizeTagList(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(/[,\/、]/).map(t => t.trim()).filter(Boolean);
  return [...new Set(arr.map(t => TAG_ENUM[t] !== undefined ? TAG_ENUM[t] : t).filter(Boolean))];
}

// 测试号 / 占位行识别（D5③）—— 命中则剔除
function isTestContact(rec) {
  const phone = rec.mobile || '';
  const email = (rec.email || '').toLowerCase();
  const name = (rec.name || '').trim();
  if (phone === '13800000000') return true;
  if (email === 'test@test.com') return true;
  if (name === '测试') return true;
  return false;
}
function isPlaceholder(rec) {
  const name = (rec.name || '').trim();
  const company = (rec.company || '').trim();
  if (name === '' && (company === '' || company === '待补充' || company === '待补充公司')) return true;
  return false;
}

// 公司名匹配键：去空格；若 A 包含 B 或 B 包含 A 视为同一家（处理 锦绣↔锦绣纺织、众合机械↔众合机械设备）
function companyKey(c) {
  return (c || '').replace(/\s+/g, '').trim();
}
function sameCompany(a, b) {
  const x = companyKey(a), y = companyKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.includes(y) || y.includes(x);
}

// ---- 字段格式规则（防错位入库，D5 强化）----
// 纯数字 / 只含数字分隔符的字符串（排除含中文的合法城市名）
function isNumericLike(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || !/\d/.test(s)) return false;
  return /^[0-9\-\s+()（）]+$/.test(s);
}

// 对单个联系人/贡献对象做格式校验与修复：手机号/座机混进 城市/邮箱 时搬回原字段，
// 非法纯数字城市直接清空。就地修改 f，返回修复说明（用于处理日志）。
function repairFieldFormat(f) {
  const notes = [];
  const name = (f.name || '').trim() || '';
  const tag = name ? '（' + name + '）' : '';
  let city = String(f.city || '').trim();

  // 1) 城市字段混入座机/手机号 → 搬回 landline / mobile
  const ll = extractLandline(city);
  const mob = extractMobile(city);
  if (ll && !mob) {
    if (!f.landline) { f.landline = ll; notes.push('城市字段混入座机 ' + ll + '，已移至座机字段' + tag); }
    else notes.push('城市字段含座机 ' + ll + '，已剔除' + tag);
    f.city = '';
    city = '';
  } else if (mob) {
    if (!f.mobile) { f.mobile = mob; notes.push('城市字段混入手机号 ' + mob + '，已移至手机字段' + tag); }
    else notes.push('城市字段含手机号 ' + mob + '（已存在手机，剔除误值）' + tag);
    f.city = '';
    city = '';
  }
  // 2) 城市字段是纯数字垃圾（非座机/手机形态，如日期串）→ 清空
  if (city && isNumericLike(city)) {
    notes.push('城市字段为纯数字「' + city + '」，非合法城市，已清空' + tag);
    f.city = '';
  }

  // 3) 手机字段被写成非法值：保留原始值但交给低置信判定；若为空则尝试从邮箱/备注找回
  if (!f.mobile) {
    const em = String(f.email || '').trim();
    const emm = extractMobile(em);
    if (emm) { f.mobile = emm; f.email = ''; notes.push('邮箱字段混入手机号 ' + emm + '，已移至手机字段' + tag); }
    else {
      const nm = extractMobile(f.note);
      if (nm) { f.mobile = nm; notes.push('备注字段含手机号 ' + nm + '，已提取至手机字段' + tag); }
    }
  }
  // 4) 邮箱显然非法（纯数字 / 无 @）
  const em2 = String(f.email || '').trim();
  if (em2 && !/@/.test(em2)) {
    if (isNumericLike(em2)) { f.email = ''; notes.push('邮箱字段为纯数字，已清空' + tag); }
    else { f.email = ''; notes.push('邮箱字段缺少 @，疑似误置，已清空（' + em2 + '）' + tag); }
  }

  // 合作状态归一：未提及/无法识别 → ''；口语表述映射到三值
  const rawStatus = String(f.cooperationStatus == null ? '' : f.cooperationStatus).trim();
  const normStatus = normalizeCooperationStatus(rawStatus);
  if (rawStatus && normStatus !== rawStatus) { notes.push('合作状态「' + rawStatus + '」归一到「' + normStatus + '」' + tag); }
  f.cooperationStatus = normStatus;

  // 归一空串，避免 null/undefined 入库
  for (const k of ['name', 'company', 'mobile', 'landline', 'email', 'city', 'note', 'cooperationStatus', '录入人']) {
    if (f[k] == null) f[k] = '';
  }
  return notes;
}

module.exports = {
  extractMobile, extractLandline, isMalformedMobile, mobileSlot, normalizeCity, normalizeTagList,
  isTestContact, isPlaceholder, companyKey, sameCompany, repairFieldFormat, isNumericLike,
  normalizeCooperationStatus, COOP_ENUM
};
