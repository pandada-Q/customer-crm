'use strict';
// 合作意向初判（D6/D11）+ 低置信识别（D21）。规则化、确定性、可测试。
// 信号三类：合作状态三值映射 / 标签 / 备注语义。AI 初判后必须经人工确认（D6）。
const { isMalformedMobile } = require('./clean');

const INTENT_KEYWORDS = ['有意向', '意向', '展会认识', '待合作', '潜在', '下半年有意向'];

// 返回 { candidate:boolean, signals:[{type,value,weight}] }
function judgeIntention(contact) {
  const signals = [];
  // 1) 合作状态三值映射（D11）：有效=已合作 / 暂停=暂停合作 / 待定=有合作意向
  const status = (contact.cooperationStatus || '').trim();
  if (status === '待定') {
    signals.push({ type: '合作状态', value: '待定→有合作意向', weight: 'strong' });
  } else if (status === '有效') {
    signals.push({ type: '合作状态', value: '有效→已合作', weight: 'info' });
  } else if (status === '暂停') {
    signals.push({ type: '合作状态', value: '暂停→暂停合作', weight: 'info' });
  }
  // 2) 标签信号
  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  if (tags.includes('合作伙伴') || tags.includes('客户')) {
    signals.push({ type: '标签', value: tags.join('/'), weight: 'weak' });
  }
  // 3) 备注语义
  const note = (contact.note || '');
  const hit = INTENT_KEYWORDS.find(k => note.includes(k));
  if (hit) signals.push({ type: '备注语义', value: '含「' + hit + '」', weight: 'strong' });
  // 判定：待定 或 含意向关键词 → 候选意向
  const candidate = status === '待定' || !!hit;
  return { candidate, signals };
}

// 判断联系人是否低置信（需进待确认区补录/剔除，D21）
function isLowConfidenceContact(contact) {
  const hasName = (contact.name || '').trim().length > 0;
  const hasCompany = (contact.company || '').trim().length > 0;
  if (!hasName && !hasCompany) return { low: false };
  // 手机非法或缺失但具备姓名+公司 → 低置信（如 周杰 短号、高工 电话待补）
  if (isMalformedMobile(contact.mobile)) {
    return { low: true, reason: '手机号位数不足（' + contact.mobile + '），AI 低置信' };
  }
  if (!contact.mobile && !contact.landline && hasName && hasCompany) {
    return { low: true, reason: '缺少任何电话，AI 低置信' };
  }
  return { low: false };
}

module.exports = { judgeIntention, isLowConfidenceContact, INTENT_KEYWORDS };
