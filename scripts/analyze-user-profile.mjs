#!/usr/bin/env node
/**
 * analyze-user-profile.mjs —— 修的人物画像自动分析(第二个脚本,独立自包含)
 *
 * 数据源 : 数据目录下 *.jsonl(默认 ~/lin/messages),只取 role=user 的发言
 * 逻辑   : 串行分批(默认 100 层/批,前 100 层正好一批)。草稿按「## 维度」分节,每批把
 *          "上一批更新后的画像草稿"连同本批消息一起交给 LLM,模型只输出【有变化的维度】
 *          (changed: 维度名 → 该维度合并新事实后的完整内容)+ 本批新提取的事实;
 *          代码负责把 changed 合并进草稿(命中维度整节替换/新维度追加),草稿不再整份重输出。
 *          —— 输出长度只随"本批变化量"增长,不会随画像变大而膨胀(旧版全量重输出会撞
 *          max_tokens 截断,并因生成过久触发 180s 超时 abort)。
 * 规则   : 忽略一切 AI 推演/元叙事/创作者视角的发言(不提取、不写进画像)。
 * 产物   :
 *   user-profile.md        修的人物画像(markdown,最终草稿)
 *   user-facts.jsonl       剧情内事实条目(floor/date/fact/category/basis)
 * 模型   : deepseek-v4-flash(config.json + .env 与脚本同目录)
 *
 * 用法   :
 *   node scripts/analyze-user-profile.mjs             全量分析(串行,链式累积)
 *   node scripts/analyze-user-profile.mjs --limit 100 只跑前 100 层(验证用)
 *   node scripts/analyze-user-profile.mjs --batch 200 每批 200 层
 *   node scripts/analyze-user-profile.mjs --dry-run   只组装提示词不调模型
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  dir: path.join(os.homedir(), 'lin', 'messages'),
  out: path.join(SCRIPT_DIR, 'user-profile.md'),
  facts: path.join(SCRIPT_DIR, 'user-facts.jsonl'),
  batch: 100,         // 每批楼层数(前 100 层正好一批)
  retry: 2,           // 批内格式错误重试次数
  stream: true,       // 流式输出(可 --no-stream 关闭)
  model: 'deepseek-v4-flash',
  config: path.join(SCRIPT_DIR, 'config.json'),
  env: path.join(SCRIPT_DIR, '.env'),
  prompt: path.join(SCRIPT_DIR, 'prompt-profile.txt'),
  state: path.join(SCRIPT_DIR, 'user-profile.state.json'),
  userChars: 400,     // 用户原话截断字数
  temperature: 0,
  maxTokens: 32768,   // deepseek-v4-flash 输出上限 384K;思考模式下思维链+正文共用此预算,留足余量防截断
  timeoutMs: 300000,
  thinking: '',       // ''=不传,跟随模型默认(思考模式);确需省 token 可 --thinking disabled
};

/* ==================== M1 参数解析 ==================== */
function parseArgs(argv) {
  const a = { ...DEFAULTS, dryRun: false, limit: 0, force: false, help: false };
  const next = (i, k) => { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) throw new Error(k + ' 缺参数值'); return [v, i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    let v;
    switch (k) {
      case '--dir':       [v, i] = next(i, k); a.dir = v; break;
      case '--out':       [v, i] = next(i, k); a.out = v; break;
      case '--facts':     [v, i] = next(i, k); a.facts = v; break;
      case '--batch':     [v, i] = next(i, k); a.batch = Number(v); break;
      case '--retry':     [v, i] = next(i, k); a.retry = Number(v); break;
      case '--limit':     [v, i] = next(i, k); a.limit = Number(v); break;
      case '--model':     [v, i] = next(i, k); a.model = v; break;
      case '--config':    [v, i] = next(i, k); a.config = v; break;
      case '--env':       [v, i] = next(i, k); a.env = v; break;
      case '--prompt':    [v, i] = next(i, k); a.prompt = v; break;
      case '--state':     [v, i] = next(i, k); a.state = v; break;
      case '--user-chars': [v, i] = next(i, k); a.userChars = Number(v); break;
      case '--temperature': [v, i] = next(i, k); a.temperature = Number(v); break;
      case '--max-tokens':  [v, i] = next(i, k); a.maxTokens = Number(v); break;
      case '--timeout-ms':  [v, i] = next(i, k); a.timeoutMs = Number(v); break;
      case '--thinking': {
        [v, i] = next(i, k);
        if (v !== 'enabled' && v !== 'disabled') throw new Error('--thinking 只接受 enabled 或 disabled');
        a.thinking = v; break;
      }
      case '--dry-run': a.dryRun = true; break;
      case '--force': a.force = true; break;
      case '--no-stream': a.stream = false; break;
      case '--help': a.help = true; break;
      default: throw new Error('未知参数: ' + k + '(用 --help 查看)');
    }
  }
  if (!Number.isInteger(a.batch) || a.batch < 1) throw new Error('--batch 必须是正整数');
  return a;
}

/* ==================== M2 日志 ==================== */
function log(level, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write('[' + ts + '] [' + level + '] ' + msg + '\n');
}

/* ==================== M3 配置加载 ==================== */
function parseEnvFile(p) {
  const keys = {};
  if (!fs.existsSync(p)) return keys;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq > 0) keys[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
  }
  return keys;
}
function loadConfig(args) {
  if (!fs.existsSync(args.config)) throw new Error('找不到 config.json: ' + args.config);
  const upstreams = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  if (!Array.isArray(upstreams) || upstreams.length === 0) throw new Error('config.json 必须是上游数组');
  const envKeys = parseEnvFile(args.env);
  const model = args.model || process.env.DEEPSEEK_MODEL || DEFAULTS.model;
  const up = upstreams.find(u => (u.models || []).includes(model)) || upstreams[0];
  let key = envKeys[up.name] || process.env.DEEPSEEK_API_KEY || '';
  if (key && /请替换|placeholder|your[-_]?key/i.test(key)) { log('WARN', '.env 里的密钥看起来是占位符,请替换为真实密钥'); key = ''; }
  const cfg = {
    url: String(up.baseurl || '').replace(/\/+$/, '') + '/chat/completions',
    model, key, name: up.name,
    stream: args.stream, temperature: args.temperature, maxTokens: args.maxTokens, timeoutMs: args.timeoutMs,
    thinking: args.thinking,
  };
  log('CONFIG', '上游=' + cfg.name + ' base=' + (up.baseurl || '?') + ' model=' + model + ' key=' + (key ? '已配置' : '缺失'));
  return cfg;
}

/* ==================== M4 消息加载(只取用户消息) ==================== */
function extractMyTime(text) {
  const m = String(text || '').match(/我的时间[:：]\s*(\d{4})[年\/.\-](\d{1,2})[月\/.\-](\d{1,2})/);
  if (!m) return null;
  const rawLine = String(text).match(/我的时间[:：].*$/m);
  return {
    date: m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0'),
    raw: rawLine ? rawLine[0].trim() : m[0],
  };
}
function loadUserMessages(dir, opts) {
  if (!fs.existsSync(dir)) throw new Error('数据目录不存在: ' + dir);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
  if (files.length === 0) throw new Error('数据目录下没有 .jsonl 文件: ' + dir);
  const units = [];
  let bad = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch (e) { bad++; continue; }
      if (o.role !== 'user' || typeof o.floor !== 'number') continue;
      const mt = extractMyTime(o.text);
      const full = String(o.text || '');
      units.push({
        floor: o.floor,
        time: String(o.time || ''),
        date: mt ? mt.date : String(o.time || '').slice(0, 10),
        myTime: mt ? mt.raw : '',
        text: full.slice(0, opts.userChars),
      });
    }
  }
  if (bad) log('WARN', '共 ' + bad + ' 行解析失败已跳过');
  units.sort((x, y) => x.floor - y.floor);
  log('LOAD', '共 ' + files.length + ' 个文件, ' + units.length + ' 条用户消息(楼层 ' + units[0].floor + '~' + units[units.length - 1].floor + ')');
  return units;
}

/* ==================== M5 提示词 ==================== */
const DEFAULT_PROMPT = [
  '你是人物画像分析员。从角色扮演聊天的玩家「修」的发言中,持续提炼修的人物画像。',
  '',
  '规则:',
  '- 只提取修在剧情内发言中透露的关于他本人的事实:身份、工作、家庭、居住、作息、饮食、健康、爱好、性格、与聊天对象的关系、经历等。',
  '- 忽略一切「AI 推演、元叙事、创作者视角」的内容(如自称创造了世界/角色、讨论扮演指令、跳出剧情的发言)。这类内容一律不提取、不写进画像、不引用。',
  '- 事实要具体写实、有据可查;不推测、不脑补。',
  '',
  '输入:',
  '- 目前的画像草稿(按「## 维度名」分节,之前批次累计的结果,可能为空)',
  '- 本批新的用户消息(楼层/时间/原文)',
  '',
  '输出 JSON 对象(增量更新,只输出有变化的部分):',
  '{"changed": {"维度名": "该维度合并新事实后的完整内容"}, "newFacts": [{"floor": 楼层号, "fact": "本批新提取的事实", "category": "类别", "basis": "依据原文(简短引述)"}]}',
  '',
  'changed 要求(最重要):',
  '- 只输出本批需要新增或修正的维度;没有变化的维度一律不要输出;本批完全没有画像级变化则 changed 为 {}。',
  '- 每个维度的值 = 把本批新事实并入旧草稿该维度后,该维度的【完整】新内容(markdown 无序列表):',
  '  原有条目必须全部保留,新条目插到合适位置,同类合并;相互冲突的改写或并列注明;不确定的标(推测)。',
  '- 维度名必须与旧草稿里的维度标题完全一致(如:身份与工作/家庭/居住与作息/饮食与健康/爱好/性格/关系/经历);只有全新维度才允许新起名。',
  '- 内容里不要写「##」标题行(标题由程序添加),不要出现楼层号(楼层只出现在 newFacts 的 basis 里可简短提及)。',
  '',
  'newFacts 要求:',
  '- newFacts 是本批新事实的流水记录,放本批所有值得记录的新事实:一次性琐事(某天吃了什么、某次聊天内容)只进 newFacts;稳定事实除并入 changed 外,也在 newFacts 里记一条。',
  '- 不要重复旧草稿已有内容;本批无新事实则为空数组。',
  '- 不要「近期经历/事件流水」这样的画像维度——近期具体事件只进 newFacts,由后续分析处理。',
  '',
  '- 只输出 JSON 对象本身,不要代码围栏,不要任何解释。',
].join('\n');
function loadPromptFile(p) {
  if (fs.existsSync(p)) {
    const s = fs.readFileSync(p, 'utf8').trim();
    if (s) { log('PROMPT', '从 ' + p + ' 加载提示词(' + s.length + ' 字)'); return s; }
  }
  fs.writeFileSync(p, DEFAULT_PROMPT + '\n');
  log('PROMPT', '已生成默认提示词文件 ' + p + ',可直接编辑,下次运行生效');
  return DEFAULT_PROMPT;
}

/* ==================== M5.5 草稿分节与合并(增量更新核心) ==================== */
/* 草稿按「## 维度」分节;模型只回传有变化的维度,代码整节替换/追加,未提及的原样保留。 */
const normHeading = s => String(s || '').replace(/[##\s、,，。.::;;/\\()()【】[\]—\-_*]+/g, '');

function parseSections(draft) {
  const pre = [];
  const sections = [];
  let cur = null;
  for (const line of String(draft || '').split('\n')) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) { cur = { level: m[1].length, title: m[2], body: [] }; sections.push(cur); }
    else if (cur) cur.body.push(line);
    else pre.push(line);
  }
  return { pre: pre.join('\n'), sections };
}

function findSection(sections, key) {
  const nk = normHeading(key);
  if (!nk) return null;
  return sections.find(s => normHeading(s.title) === nk)
    || sections.find(s => normHeading(s.title).includes(nk) || nk.includes(normHeading(s.title)))
    || null;
}

function mergeSections(draft, changed) {
  const { pre, sections } = parseSections(draft);
  const replaced = [], added = [];
  for (const [key, content] of Object.entries(changed || {})) {
    const lines = String(content || '').replace(/\r/g, '').split('\n');
    // 模型若把「## 标题」也写了进来,去掉首行标题
    if (lines.length && /^\s*#{1,6}\s/.test(lines[0])) lines.shift();
    const text = lines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
    if (!text) continue;
    const hit = findSection(sections, key);
    if (hit) { hit.body = text.split('\n'); replaced.push(hit.title); }
    else { sections.push({ level: 2, title: key.trim(), body: text.split('\n') }); added.push(key.trim()); }
  }
  const out = (pre.trim() ? pre.trim() + '\n\n' : '')
    + sections.map(s => '#'.repeat(s.level) + ' ' + s.title + '\n' + s.body.join('\n').replace(/^\n+/, '').replace(/\s+$/, '')).join('\n\n');
  return { draft: out.trim() + '\n', replaced, added };
}

function unitBlock(u) {
  return '【floor=' + u.floor + '】时间: ' + (u.myTime || u.time || '未知') + '\n用户的话:\n' + (u.text || '(空)');
}
function buildBatchPrompt(units, batchNo, totalBatches, draft) {
  // 草稿放在末尾(紧跟输出要求),模型对照草稿决定哪些维度要更新;只输出有变化的维度
  return '本批用户消息(第 ' + batchNo + '/' + totalBatches + ' 批,共 ' + units.length + ' 条):\n\n' +
    units.map(unitBlock).join('\n\n---\n\n') +
    '\n\n=== 目前的画像草稿(按维度分节;只把有变化的维度放进 changed,无变化则 changed 为 {}) ===\n' + (draft ? draft : '(空)') +
    '\n\n---\n请输出 JSON 对象 {"changed": {"维度名": "该维度更新后的完整内容"}, "newFacts": [...]}。';
}

/* ==================== M6 LLM 调用 ==================== */
async function callLLM(cfg, messages, label) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  // 带原因 abort:超时时报错信息可读(而非笼统的 "This operation was aborted")
  const timer = setTimeout(() => ctrl.abort(new Error('等待模型输出超过 ' + cfg.timeoutMs + 'ms(可用 --timeout-ms 调大)')), cfg.timeoutMs);
  const payload = { model: cfg.model, messages, temperature: cfg.temperature, max_tokens: cfg.maxTokens, response_format: { type: 'json_object' } };
  if (cfg.thinking) payload.thinking = { type: cfg.thinking }; // 空值不传,跟随上游默认
  try {
    if (cfg.stream) {
      payload.stream = true;
      payload.stream_options = { include_usage: true };
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) { const t = await res.text(); throw new Error('HTTP ' + res.status + ' ' + t.slice(0, 200)); }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', content = '', reasoning = '', usage = {};
      let rHead = false, cHead = false;
      log('STREAM', label + ' 开始:');
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payloadStr = line.slice(5).trim();
          if (payloadStr === '[DONE]') continue;
          let j; try { j = JSON.parse(payloadStr); } catch (e) { continue; }
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (d) {
            if (d.reasoning_content) {
              if (!rHead) { process.stderr.write('\n[思考] '); rHead = true; }
              reasoning += d.reasoning_content;
              process.stderr.write(d.reasoning_content);
            }
            if (d.content) {
              if (!cHead) { process.stderr.write('\n[输出] '); cHead = true; }
              content += d.content;
              process.stderr.write(d.content);
            }
          }
          if (j.usage) usage = j.usage;
        }
      }
      process.stderr.write('\n');
      log('LLM', label + ' 完成 ' + (Date.now() - t0) + 'ms in=' + (usage.prompt_tokens ?? '?') + 'tk out=' + (usage.completion_tokens ?? '?') + 'tk');
      return { content, reasoning, usage };
    }
    // 非流式回退
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + body.slice(0, 200));
    let j; try { j = JSON.parse(body); } catch (e) { throw new Error('响应非 JSON: ' + body.slice(0, 120)); }
    const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    const usage = j.usage || {};
    log('LLM', label + ' 完成 ' + (Date.now() - t0) + 'ms in=' + (usage.prompt_tokens ?? '?') + 'tk out=' + (usage.completion_tokens ?? '?') + 'tk');
    return { content, usage };
  } finally { clearTimeout(timer); }
}
function extractJson(text) {
  let t = String(text || '').trim();
  const fence = t.match(new RegExp("`" + '{3}(?:json)?\\s*([\\s\\S]*?)' + "`" + '{3}', 'i'));
  if (fence) t = fence[1].trim();
  const sArr = t.indexOf('['), sObj = t.indexOf('{');
  let s = -1, e = -1;
  if (sArr !== -1) { s = sArr; e = t.lastIndexOf(']'); }
  if (sObj !== -1 && (s === -1 || sObj < s)) { s = sObj; e = t.lastIndexOf('}'); }
  if (s === -1 || e <= s) return null;
  return t.slice(s, e + 1);
}

/* ==================== M7 格式校验 ==================== */
function validateOutput(parsed, floors) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, errors: ['输出不是 JSON 对象'] };
  if (typeof parsed.changed !== 'object' || parsed.changed === null || Array.isArray(parsed.changed)) errors.push('changed 需为对象 {"维度名": "该维度更新后的完整内容"}(无变化则为 {})');
  const cleanChanged = {};
  if (typeof parsed.changed === 'object' && parsed.changed !== null && !Array.isArray(parsed.changed)) {
    for (const [k, v] of Object.entries(parsed.changed)) {
      const key = String(k).trim();
      if (!key || key.length > 30) { errors.push('changed 维度名不合法(' + key.slice(0, 20) + ')'); continue; }
      if (typeof v !== 'string' || !v.trim()) { errors.push('changed.' + key + ' 内容为空'); continue; }
      cleanChanged[key] = v;
    }
  }
  if (!Array.isArray(parsed.newFacts)) errors.push('newFacts 数组');
  const cleanFacts = [];
  if (Array.isArray(parsed.newFacts)) {
    for (const f of parsed.newFacts) {
      if (!f || typeof f !== 'object') { errors.push('newFacts 存在非对象元素'); continue; }
      if (typeof f.floor !== 'number') errors.push('newFacts.floor 数字(' + JSON.stringify(f).slice(0, 60) + ')');
      if (typeof f.fact !== 'string' || !f.fact.trim()) errors.push('newFacts.fact 非空字符串');
      if (typeof f.category !== 'string' || !f.category.trim()) errors.push('newFacts.category 非空字符串');
      if (typeof f.basis !== 'string' || !f.basis.trim()) errors.push('newFacts.basis 非空字符串');
      if (typeof f.floor === 'number' && typeof f.fact === 'string' && typeof f.category === 'string') {
        cleanFacts.push({ floor: f.floor, fact: f.fact.trim(), category: f.category.trim(), basis: String(f.basis || '').trim() });
      }
    }
  }
  return { ok: errors.length === 0, errors, changed: cleanChanged, newFacts: cleanFacts };
}

/* ==================== M8 主流程 ==================== */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/analyze-user-profile.mjs [选项]');
    console.log('  --dir <目录>      数据目录,默认 ~/lin/messages');
    console.log('  --out <文件>      画像输出,默认 <scripts>/user-profile.md');
    console.log('  --facts <文件>    事实条目输出,默认 <scripts>/user-facts.jsonl');
    console.log('  --batch <N>       每批楼层数,默认 100(前 100 层正好一批)');
    console.log('  --retry <N>       批格式错误重试次数,默认 2');
    console.log('  --limit <N>       只处理前 N 层(调试)');
    console.log('  --dry-run         只组装提示词不调模型');
    console.log('  --force           忽略进度从头重跑');
    console.log('  --model <名>      模型,默认 deepseek-v4-flash');
    console.log('  --config/--env/--prompt/--state/--user-chars/--temperature/--max-tokens/--timeout-ms');
    return;
  }
  const tStart = Date.now();
  log('START', '参数: batch=' + args.batch + ' limit=' + (args.limit || '全量') + (args.dryRun ? ' DRY-RUN' : ''));

  const cfg = loadConfig(args);
  if (!cfg.key && !args.dryRun) {
    log('ERROR', '没有 API 密钥:请在 scripts/.env 里填 deepseek=<key>,或设环境变量 DEEPSEEK_API_KEY');
    process.exit(1);
  }
  const systemPrompt = loadPromptFile(args.prompt);

  let units = loadUserMessages(args.dir, args);
  if (args.limit > 0) {
    const maxFloor = Math.min(units[0].floor + args.limit - 1, units[units.length - 1].floor);
    units = units.filter(u => u.floor <= maxFloor);
    log('LIMIT', '只处理到楼层 ' + maxFloor + ',共 ' + units.length + ' 条');
  }

  // 断点续跑:读进度(最后楼层 + 草稿)
  let draft = '', factCount = 0, startBatch = 0;
  if (!args.force && fs.existsSync(args.state)) {
    try {
      const st = JSON.parse(fs.readFileSync(args.state, 'utf8'));
      if (st && typeof st.lastFloor === 'number' && typeof st.draft === 'string') {
        const before = units.length;
        units = units.filter(u => u.floor > st.lastFloor);
        draft = st.draft;
        factCount = st.factCount || 0;
        startBatch = st.batchIdx || 0;
        if (units.length === 0) { log('DONE', '进度显示已全部完成,画像已是最新: ' + args.out); return; }
        log('RESUME', '断点续跑:已完成到楼层 ' + st.lastFloor + '(累计事实 ' + factCount + ' 条),剩余 ' + units.length + ' 条');
      }
    } catch (e) { log('WARN', '进度文件解析失败,从头开始: ' + e.message); }
  }
  const header = '# 修 · 人物画像(自动分析)\n\n> 数据源: ' + args.dir + '(剧情内发言;AI/元叙事内容已忽略)\n> 更新于: ' + new Date().toISOString() + '\n> 事实条目: 见 ' + path.basename(args.facts) + '\n\n';
  // 切批(按楼层,默认 100 层/批;前 100 层正好一批)
  const batches = [];
  {
    const firstFloor = units[0].floor, lastFloor = units[units.length - 1].floor;
    for (let lo = firstFloor; lo <= lastFloor; lo += args.batch) {
      const hi = Math.min(lo + args.batch - 1, lastFloor);
      const bs = units.filter(u => u.floor >= lo && u.floor <= hi);
      if (bs.length) batches.push({ lo, hi, units: bs });
    }
  }
  log('BATCH', '切分 ' + batches.length + ' 批(每批 ' + args.batch + ' 层)');

  if (args.dryRun) {
    const dryPath = args.out.replace(/\.md$/i, '') + '.dryrun.txt';
    let draft = '';
    const parts = [];
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i];
      parts.push(buildBatchPrompt(b.units, i + 1, batches.length, draft || '(上一批草稿)') + '\n\n================\n\n');
      draft = '(第 ' + (i + 1) + ' 批后的草稿)';
    }
    fs.writeFileSync(dryPath, parts.join(''));
    log('DRYRUN', '提示词已写入 ' + dryPath + '(共 ' + batches.length + ' 批)');
    return;
  }

  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    const label = '批' + (i + 1) + '/' + batches.length + ' floors=' + b.lo + '-' + b.hi + ' 条数=' + b.units.length;
    const msgs = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildBatchPrompt(b.units, i + 1, batches.length, draft) },
    ];
    let parsed = null, errors = [];
    for (let attempt = 1; attempt <= args.retry + 1; attempt++) {
      let r;
      try {
        r = await callLLM(cfg, msgs, label + (attempt > 1 ? ' 重试' + (attempt - 1) : ''));
      } catch (e) {
        // 超时/网络失败不再直接 FATAL,耗尽重试次数才算失败
        errors = ['LLM 调用失败: ' + String(e && e.message || e)];
        if (attempt <= args.retry) { log('RETRY', label + ' ' + errors[0] + ',重试 ' + attempt + '/' + args.retry); continue; }
        break;
      }
      let p = null;
      try { p = JSON.parse(extractJson(r.content) || ''); } catch (e) { p = null; }
      const v = validateOutput(p, [b.lo, b.hi]);
      if (v.ok) { parsed = v; break; }
      errors = v.errors;
      if (attempt <= args.retry) {
        log('RETRY', label + ' 格式错误,重试 ' + attempt + '/' + args.retry + ': ' + v.errors.slice(0, 2).join(' | '));
        msgs.push({ role: 'assistant', content: r.content.slice(0, 2000) });
        msgs.push({ role: 'user', content: '你上次输出格式有误:' + v.errors.slice(0, 4).join(';') + '。请重新输出 JSON 对象 {"changed": {"维度名": "该维度更新后的完整内容"}, "newFacts": [...]}。' });
      }
    }
    if (!parsed) {
      log('FATAL', label + ' 重试耗尽,画像草稿链中断:' + errors.slice(0, 2).join(' | '));
      log('FATAL', '进度已保存到 ' + args.state + ',可直接重跑本脚本续传(也可调大 --timeout-ms / 减小 --batch)');
      process.exit(1);
    }
    // 代码侧合并:命中的维度整节替换,新维度追加,未提及的原样保留
    const merged = mergeSections(draft, parsed.changed);
    const changedDesc = merged.replaced.length + ' 更新[' + merged.replaced.join('、') + ']' + (merged.added.length ? ' + 新增[' + merged.added.join('、') + ']' : '');
    log('MERGE', label + ' 维度变更: ' + changedDesc);
    draft = merged.draft;
    for (const f of parsed.newFacts) {
      const u = b.units.find(x => x.floor === f.floor);
      fs.mkdirSync(path.dirname(args.facts), { recursive: true });
      fs.appendFileSync(args.facts, JSON.stringify({ ...f, date: u ? u.date : '', myTime: u ? u.myTime : '', analyzedAt: new Date().toISOString() }) + '\n');
      factCount++;
    }
    log('OK', label + ' 草稿 ' + draft.length + ' 字,新事实 ' + parsed.newFacts.length + ' 条(累计 ' + factCount + ')');
    fs.writeFileSync(args.state, JSON.stringify({ lastFloor: b.hi, batchIdx: startBatch + i + 1, draft, factCount, updatedAt: new Date().toISOString() }));
    fs.writeFileSync(args.out, header + draft + '\n');
    log('SAVE', label + ' 画像已更新: ' + args.out);
  }

  // 画像已在每批完成后写入 args.out;此处只提示
  log('DONE', '完成 ' + batches.length + ' 批,提取事实 ' + factCount + ' 条,总耗时 ' + ((Date.now() - tStart) / 1000).toFixed(1) + 's');
  console.log('画像: ' + args.out);
  console.log('事实: ' + args.facts);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
