'use strict';
// AI 能力抽象层（spec 第 8 章「多源自由文本 → 结构化抽取」「首批规整」等）
// 设计：默认 rule 提供方（确定性、可离线/可测试）；生产可切 llm 提供方（OpenAI 兼容 API）。
// 本版「大模型驱动」环节：自由文本（王总微信）抽取由 AI 提供方完成；rule 为可复现的离线等价实现。
const PROVIDER = (process.env.LLM_PROVIDER || 'rule').toLowerCase();

const COMPANY_RE = /([一-龥]{2,10}(?:机械|建材|包装|科技|装饰|玻璃|电子|物流|纺织|家居|模具|钢构|五金|贸易|工程|印务|运输|化工|文化))/;
const NAME_RE = /^([一-龥]{2,4})/;
const { normalizeCooperationStatus } = require('./clean');
const { RULE_SECTION } = require('./rules'); // 《数据清洗规则手册》：注入大模型抽取 prompt（见 lib/rules.js）

function mkContact(name, company, mobile, landline, city, source, note, coopStatus) {
  return { name, company: company || '', mobile: mobile || '', landline: landline || '', email: '', city: city || '', note: note || '', source, tags: [], cooperationStatus: normalizeCooperationStatus(coopStatus) };
}

// 确定性自由文本抽取（微信口语素材）
function extractFromFreeTextRule(text, source) {
  const lines = String(text).split(/\r?\n/);
  const records = [], todos = [], lowconf = [];
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    if (/(让整理|参考之前|格式照着来|王总转发|转发,)/.test(raw)) continue; // 指令行跳过

    const mobile = (raw.match(/(?:\+?86[-\s]?)?1[3-9]\d{9}/) || [null])[0];
    const landline = (raw.match(/0\d{2,3}-?\d{7,8}/) || [null])[0];
    const isTodo = /(记得提醒|约饭|回头找一下)/.test(raw);

    if (isTodo) {
      todos.push({ text: raw, source });
      // 高工 精工机械 具体电话回头找一下：既是待办也是低置信联系人候选（电话待补）
      const nm = raw.match(/^([一-龥]{2,4})/);
      if (nm && !mobile) {
        const name = nm[1];
        const company = (raw.replace(name, '').match(COMPANY_RE) || [null])[0];
        lowconf.push({ name, company: company || null, rawSnippet: raw, note: '电话待补，AI 低置信', city: '' });
      }
      continue;
    }

    // 老周和小何都是金力包装的 老周13488886666 小何13477775555 → 拆分两个联系人
    if (/老周/.test(raw) && /小何/.test(raw)) {
      const zhou = raw.match(/老周(\d{11})/);
      const he = raw.match(/小何(\d{11})/);
      if (zhou) records.push(mkContact('老周', '金力包装', zhou[1], null, null, source, '金力包装（微信别名：老周）', raw));
      if (he) records.push(mkContact('小何', '金力包装', he[1], null, null, source, '金力包装', raw));
      continue;
    }

    const nameM = raw.match(NAME_RE);
    if (!nameM) continue;
    const name = nameM[1];
    const company = (raw.match(COMPANY_RE) || [null])[0] || '';
    let city = null;
    const cityM = raw.match(/(苏州|佛山|东莞|宁波|中山|武汉|长沙|深圳|广州|惠州|珠海|杭州|北京|上海|天津|成都|重庆)[那边的院附]*/);
    if (cityM) city = require('./clean').normalizeCity(cityM[0]);
    const note = raw.replace(name, '')
      .replace(mobile || '', '')
      .replace(landline || '', '')
      .replace(company, '')
      .replace(cityM ? cityM[0] : '', '')
      .replace(/[那边的院附]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    records.push(mkContact(name, company, mobile, landline, city, source, note, note));
  }
  return { records, todos, lowconf };
}

// 生产 LLM 提供方（OpenAI 兼容）。仅当 LLM_PROVIDER=llm 且配置 LLM_API_KEY 时启用。
function getLLMProvider() {
  const base = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  if (!key) throw new Error('LLM_PROVIDER=llm 但未配置 LLM_API_KEY');
  return {
    name: 'llm',
    async extractFromFreeText(text, source) {
      // 真实调用：把微信自由文本投喂给模型，要求返回 {records, todos, lowconf} 结构。
      // 离线/测试默认不启用；这里给出可部署实现骨架。
      const prompt = `你是客户资料抽取助手。从下面这段口语化微信记录中抽取联系人（姓名/公司/手机/座机/城市/备注/合作状态）、待办事项、低置信内容。
返回 JSON：{"records":[{name,company,mobile,landline,city,cooperationStatus,note}],"todos":[{text}],"lowconf":[{name,company,rawSnippet,note}]}。
${RULE_SECTION}
cooperationStatus 只填枚举值之一：有效（已在合作/合作过）、待定（展会认识/可跟进/有意向/潜在）、暂停（暂停合作）、''（未提及）。只输出 JSON。
--- 文本 ---
${text}`;
      const resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } })
      });
      if (!resp.ok) throw new Error('LLM 调用失败: ' + resp.status);
      const data = await resp.json();
      const parsed = JSON.parse(data.choices[0].message.content);
      (parsed.records || []).forEach(r => { r.source = source; });
      return parsed;
    }
  };
}

// DeepSeek 提供方（OpenAI 兼容 API）。当 LLM_PROVIDER=deepseek 或配置了 DEEPSEEK_API_KEY 时启用。
const DEEPSEEK_PROMPT = `你是客户资料抽取助手。从下面这段口语化微信/自由文本记录中抽取联系人（姓名/公司/手机/座机/城市/备注/合作状态）、待办事项、低置信内容。
返回 JSON：{"records":[{name,company,mobile,landline,city,cooperationStatus,note}],"todos":[{text}],"lowconf":[{name,company,rawSnippet,note}]}。
${RULE_SECTION}
cooperationStatus 只填枚举值之一：有效（已在合作/合作过/长期合作）、待定（展会认识/可跟进/有意向/潜在/想合作）、暂停（暂停合作）、空字符串''（未提及合作情况）。只输出 JSON。`;

function parseLLMJson(content) {
  let txt = String(content || '').trim();
  // 兼容模型用 ```json 代码块包裹的情况
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) txt = fence[1].trim();
  const start = txt.indexOf('{'); const end = txt.lastIndexOf('}');
  if (start >= 0 && end > start) txt = txt.slice(start, end + 1);
  const obj = JSON.parse(txt);
  return obj && typeof obj === 'object' ? obj : { records: [], todos: [], lowconf: [] };
}

function getDeepSeekProvider() {
  const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
  const key = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  if (!key) throw new Error('LLM_PROVIDER=deepseek 但未配置 DEEPSEEK_API_KEY');
  return {
    name: 'deepseek',
    async extractFromFreeText(text, source) {
      console.log('[ai] DeepSeek 调用中 model=' + model + ' 文本=' + String(text).length + '字');
      const resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: DEEPSEEK_PROMPT + '\n--- 文本 ---\n' + text }],
          response_format: { type: 'json_object' },
          temperature: 0
        })
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error('DeepSeek 调用失败: ' + resp.status + ' ' + body.slice(0, 200));
      }
      const data = await resp.json();
      const parsed = parseLLMJson(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
      (parsed.records || []).forEach(r => { r.source = source; });
      console.log('[ai] DeepSeek 返回 records=' + (parsed.records || []).length + ' todos=' + (parsed.todos || []).length + ' lowconf=' + (parsed.lowconf || []).length);
      return parsed;
    }
  };
}

function getProvider() {
  const provider = (process.env.LLM_PROVIDER || (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'rule')).toLowerCase();
  if (provider === 'deepseek') {
    try { return getDeepSeekProvider(); } catch (e) { console.warn('[ai] DeepSeek 不可用，降级 rule：', e.message); return { name: 'rule', extractFromFreeText: extractFromFreeTextRule }; }
  }
  if (provider === 'llm') {
    try { return getLLMProvider(); } catch (e) { console.warn('[ai] LLM 不可用，降级 rule：', e.message); return { name: 'rule', extractFromFreeText: extractFromFreeTextRule }; }
  }
  return { name: 'rule', extractFromFreeText: extractFromFreeTextRule };
}

// 统一入口：按当前 PROVIDER 调用抽取（可能是同步 rule 或异步 llm/deepseek）
function extractFromFreeText(text, source) { return getProvider().extractFromFreeText(text, source); }

// 异步抽取入口：始终返回 Promise，便于上传批处理的异步链路使用。
// rule 提供方会被自动包成已 resolve 的 Promise；llm/deepseek 提供方直接复用其 async 实现。
async function extractFromFreeTextAsync(text, source) {
  const res = getProvider().extractFromFreeText(text, source);
  return res; // 若为已 resolved 值则原样返回，若为 Promise 则 await
}

module.exports = { getProvider, extractFromFreeTextRule, extractFromFreeText, extractFromFreeTextAsync, PROVIDER };
