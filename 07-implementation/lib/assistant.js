'use strict';
// AI 数据小助手：悬浮右下角的系统内问答助手
// 边界：只回答本系统内已有数据（客户总表 / 意向客户 / 待确认 / 待办 / 上传记录），不联网、不外搜、不编造。
// 实现：① 本地确定性检索（关键词/实体匹配 + 数据概况）→ ② 把「用户问题 + 检索快照」注入 DeepSeek/llm
//       ③ 无大模型 key（provider=rule）时降级为本地关键词答复（可离线、可测试）。
// 注：检索只是"候选圈定"，回答/推荐由大模型基于快照生成，命中为空的答案由模型明确告知"系统内未找到"。

const MAX_CONTACTS = 12; // 注入模型的联系人候选上限（控制 token）

function detectProvider() {
  return (process.env.LLM_PROVIDER || (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'rule')).toLowerCase();
}

function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ''); }
function trimN(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
function phoneOf(c) { return c.mobile || c.landline || ''; }
function statusOf(c) { return c.cooperationStatus || '未标注'; }
function tagStr(c) { return (c.tags || []).join('/') || '—'; }
function isIntent(c) { return !!(c.intentionConfirmed || c.cooperationStatus === '待定'); }
function dShort(ts) { return ts ? String(ts).slice(5, 16).replace('T', ' ') : ''; }

// 单个联系人的「一行描述」：姓名｜公司｜电话｜城市｜状态｜标签｜意向/跟进/来源/备注
function cLine(c) {
  const bits = [c.name || '?', c.company || '—', phoneOf(c) || '—', c.city || '—', statusOf(c), '标签:' + tagStr(c)];
  if (isIntent(c)) bits.push('意向客户');
  if (c.followupBy) bits.push('已跟进:' + c.followupBy + (c.followupAt ? '(' + String(c.followupAt).slice(5, 10) + ')' : ''));
  const src = (c.sources || [])[0];
  if (src) bits.push('来源:' + trimN(src, 20));
  if (c.note) bits.push('备注:' + trimN(c.note, 40));
  return bits.join('｜');
}

// 数据概况（统计型问题的基础；总量级小，直接全量算）
function summarize(state) {
  const cs = state.contacts || [], ps = state.pending || [], ts = state.todos || [], us = state.uploads || [];
  const coop = {};
  for (const c of cs) { const k = statusOf(c); coop[k] = (coop[k] || 0) + 1; }
  const openP = ps.filter(p => p.status === 'open'); const pType = {};
  for (const p of openP) pType[p.type] = (pType[p.type] || 0) + 1;
  const tc = { open: 0, done: 0, shelved: 0, removed: 0 };
  for (const t of ts) { const k = t.status || 'open'; if (tc[k] !== undefined) tc[k]++; }
  return {
    contacts: cs.length,
    intention: cs.filter(isIntent).length,
    coop, pendingOpen: openP.length, pType,
    todos: tc, uploads: us.length,
    lastUpload: us[us.length - 1] || null
  };
}

function statsText(st) {
  const coopTxt = Object.entries(st.coop).map(([k, v]) => `${k} ${v}`).join('、') || '无';
  const pTxt = Object.entries(st.pType).map(([k, v]) => `${k} ${v}`).join('、') || '无';
  return `联系人共 ${st.contacts} 位（其中意向客户 ${st.intention} 位；合作状态：${coopTxt}）；` +
    `待确认区待处理 ${st.pendingOpen} 条（${pTxt}）；` +
    `待办 ${st.todos.open} 待处理 / ${st.todos.done} 完成 / ${st.todos.shelved} 搁置 / ${st.todos.removed} 已移除；` +
    `上传处理记录共 ${st.uploads} 条。`;
}

// —— 确定性检索：按用户问题圈定候选联系人 ——
function tokenize(q) { return q.split(/[\s,，。.!！?？;；:：、/\\|()（）【】]+/).filter(Boolean); }

function scoreContact(c, q, toks) {
  let s = 0;
  const fields = [['name', 5], ['company', 4], ['mobile', 6], ['landline', 3], ['city', 3], ['note', 1]];
  const cn = norm(c.name), qn = norm(q);
  if (q.length >= 2 && cn && qn.includes(cn)) s += 6; // 问句含完整姓名
  if (qn.includes('意向') && isIntent(c)) s += 5; // 意向类问题，意向客户优先入候选
  for (const [k, w] of fields) {
    const v = norm(c[k]);
    if (!v) continue;
    if (qn.includes(v) && (v.length >= 2 || /^\d+$/.test(v))) s += w;
  }
  for (const tk of toks) {
    if (!tk) continue;
    if (tk.length < 2 && !/\d/.test(tk)) continue;
    if (norm(c.name).includes(tk)) s += 3;
    if (norm(c.company).includes(tk)) s += 3;
    if (norm(c.city).includes(tk)) s += 2;
    if ((c.tags || []).some(t => t.includes(tk) || tk.includes(t))) s += 2;
    if (statusOf(c).includes(tk)) s += 2;
    if (/^\d{7,}$/.test(tk) && (c.mobile || '').includes(tk)) s += 6;
    if (tk.length >= 3 && (c.note || '').includes(tk)) s += 1;
  }
  return s;
}

function selectContacts(cs, q) {
  const toks = tokenize(norm(q));
  const scored = cs.map(c => ({ c, s: scoreContact(c, q, toks) })).filter(x => x.s > 0);
  scored.sort((a, b) => b.s - a.s);
  let hit = scored.length;
  // 泛化问句（"客户有哪些/全部名单/盘点"）且无强命中时：按业务优先级列前 MAX 条
  const broad = /客户|名单|全部|所有|有哪些|盘点|列表/.test(q);
  const askIntent = q.includes('意向');
  let pool;
  if (scored.length > 0) {
    pool = scored.map(x => x.c);
  } else if (askIntent) {
    pool = cs.filter(isIntent);
  } else if (broad) {
    pool = cs.slice();
  } else {
    pool = [];
  }
  // 通用排序：有效/待定（意向）优先、已跟进优先
  const pri = c => (statusOf(c) === '有效' ? 0 : isIntent(c) ? 1 : 2) + (c.followupBy ? 0 : 0.5);
  pool = pool.filter((c, i, a) => a.findIndex(x => x.id === c.id) === i);
  if (askIntent) { // 意向类问题：意向客户排最前（不再按 pri 重排，避免打乱）
    pool = [...pool.filter(isIntent), ...pool.filter(c => !isIntent(c))];
  } else {
    pool = pool.sort((a, b) => pri(a) - pri(b) || String(a.name).localeCompare(String(b.name), 'zh'));
  }
  return { pool: pool.slice(0, MAX_CONTACTS), hit };
}

// 组装「用户问题 + 检索快照」注入大模型
function buildContext(state, q) {
  const cs = state.contacts || [];
  const st = summarize(state);
  const { pool, hit } = selectContacts(cs, q);
  const sec = [];
  sec.push('【数据概况】' + statsText(st));
  if (pool.length) {
    sec.push('【匹配联系人】共命中 ' + hit + ' 条，已列前 ' + pool.length + ' 条（格式：姓名｜公司｜电话｜城市｜合作状态｜标签｜其他）：');
    pool.forEach((c, i) => sec.push((i + 1) + '. ' + cLine(c)));
  } else {
    sec.push('【匹配联系人】系统内未检索到与问题相关的联系人。');
  }
  if (/待办|提醒|约饭|todo/i.test(q)) {
    const items = (state.todos || []).filter(t => (t.status || 'open') !== 'removed').slice(0, 10);
    sec.push(items.length ? '【待办】' + items.map(t => `· ${trimN(t.text, 80)}（${t.source || ''}｜${t.status === 'done' ? '完成' : t.status === 'shelved' ? '搁置' : '待处理'}）`).join('\n') : '【待办】当前无未移除的待办。');
  }
  if (/待确认|冲突|低置信|拍板|intention|意向初判/i.test(q)) {
    const items = (state.pending || []).filter(p => p.status === 'open').slice(0, 10);
    sec.push(items.length ? '【待确认区】' + items.map(p => `· [${p.type}] ${trimN(p.rawSnippet || (p.type === 'conflict' ? p.field + ' 冲突' : p.reason || ''), 60)}${p.reason ? '｜' + trimN(p.reason, 40) : ''}`).join('\n') : '【待确认区】无待处理项。');
  }
  if (/上传|导入|处理记录|记录/i.test(q)) {
    const items = (state.uploads || []).slice(-8).reverse();
    sec.push(items.length ? '【上传记录】' + items.map(u => `· ${dShort(u.ts)} ${u.filename} → 新增${u.added} 合并${u.merged} 冲突${u.conflict} 意向${u.intention} 低置信${u.lowconf} 待办${u.todos}${u.error ? '｜失败:' + trimN(u.error, 40) : ''}`).join('\n') : '【上传记录】暂无。');
  }
  return { stats: st, text: sec.join('\n\n'), hit, pool };
}

const ASSISTANT_SYS = '你是「客户资料管理助手」内置的 AI 数据小助手。你只能基于用户消息中给出的【数据概况】与【匹配联系人】等【系统内数据】回答查询，用于在系统内查找、推荐、汇总客户与业务数据。';
const ASSISTANT_INSTR = `回答要求：
1. 只回答系统内数据相关问题；绝不编造库中不存在的联系人、号码、字段；无法回答的明确说"系统内未找到/无法回答"。
2. 若问题与系统内数据无关（天气、新闻、闲聊等），礼貌说明你只能查本系统的客户数据。
3. 推荐/查找类问题：从【匹配联系人】中挑选并推荐，优先 合作状态=有效、意向客户、已跟进 的，逐条给出姓名、公司、电话、城市、合作状态，可附一句推荐理由（所在城市/标签/是否跟进/备注）；一次最多列 10 条。
4. 统计类问题（多少/几个/分别）依据【数据概况】给数字。
5. 用简体中文，简洁分点，不要输出除回答外的解释。`;

function extractJson(content) {
  let txt = String(content || '').trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) txt = fence[1].trim();
  const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
  if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
  return txt;
}

// OpenAI 兼容 chat（deepseek / llm 提供方共用）
async function chatCompletion(provider, system, user) {
  const isDs = provider === 'deepseek';
  const base = (process.env[isDs ? 'DEEPSEEK_BASE_URL' : 'LLM_BASE_URL'] || (isDs ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1')).replace(/\/$/, '');
  const key = process.env[isDs ? 'DEEPSEEK_API_KEY' : 'LLM_API_KEY'];
  const model = process.env[isDs ? 'DEEPSEEK_MODEL' : 'LLM_MODEL'] || (isDs ? 'deepseek-chat' : 'gpt-4o-mini');
  if (!key) throw new Error(provider + ' 未配置 API Key');
  console.log('[assistant] 大模型问答中 provider=' + provider + ' model=' + model);
  const resp = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.3 })
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(provider + ' 调用失败: ' + resp.status + ' ' + body.slice(0, 200));
  }
  const data = await resp.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  if (!msg || !msg.content) throw new Error('大模型返回为空');
  return msg.content;
}

// 离线/本地降级答复：直接展示检索快照各段（无大模型 key 时也能用，供测试）
function offlineAnswer(ctx, q) {
  const lines = [];
  lines.push('（本地模式：未配置大模型 Key，仅做系统内关键词检索）');
  lines.push(ctx.text);
  lines.push('提示：该小助手只查系统内数据。可试试问「佛山有哪些客户」「推荐几个有效客户」「有多少待办」。');
  return lines.join('\n');
}

// 统一入口：state=store.load 的数据对象；opts.provider 可强制（测试用 'rule'）
async function ask(state, question, opts = {}) {
  const provider = (opts.provider || detectProvider()).toLowerCase();
  const ctx = buildContext(state, String(question || '').trim());
  if (provider === 'rule') return { provider: 'rule', offline: true, answer: offlineAnswer(ctx, question), hit: ctx.hit, stats: ctx.stats };
  try {
    const content = await chatCompletion(provider, ASSISTANT_SYS, ASSISTANT_INSTR + '\n\n【用户问题】' + question + '\n\n【系统内数据快照】\n' + ctx.text);
    let answer = '';
    try { answer = JSON.parse(extractJson(content)).answer || ''; } catch (e) { answer = content; } // 容错：未按 JSON 包就整段当答案
    if (!String(answer).trim()) throw new Error('答案为空');
    return { provider, answer: String(answer).trim(), hit: ctx.hit, stats: ctx.stats };
  } catch (e) {
    return { provider, error: String(e && e.message || e), answer: offlineAnswer(ctx, question) + '\n\n（大模型调用失败，已降级为本地检索结果）', hit: ctx.hit, stats: ctx.stats, degraded: true };
  }
}

module.exports = { ask, buildContext, summarize, statsText, detectProvider };
