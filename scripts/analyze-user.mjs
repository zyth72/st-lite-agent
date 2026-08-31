#!/usr/bin/env node
/**
 * analyze-user.mjs —— 用户聊天记录场景分析(逐条打标)
 *
 * 数据源 : 数据目录下 *.jsonl({floor, role, name, time, kind, text, scene}),默认 ~/lin/messages
 * 逻辑   : 按楼层切批(默认 30 层/批),批内挑出用户消息,每条带上"场景"(前一条角色正文)
 *          交给 LLM 逐条打标(类别/标签/重要度/原因/摘要);代码只校验返回格式,失败重试。
 * 产物   :
 *   user-input-index.jsonl          逐条索引(floor/date/myTime/category/tags/importance/reason/summary/text/...)
 *   user-input-index.batches.jsonl  分割点记录(每批楼层范围/条数/耗时/token)
 *   user-input-index.errors.jsonl   失败记录(floor + 原因)
 * 模型   : deepseek-v4-flash(config.json + .env 与脚本同目录)
 *
 * 用法   :
 *   node scripts/analyze-user.mjs                    全量分析(自动跳过已完成楼层)
 *   node scripts/analyze-user.mjs --floors 90-120    只重跑 90~120 楼层(覆盖该范围旧结果)
 *   node scripts/analyze-user.mjs --parallel 4       4 个并发批
 *   node scripts/analyze-user.mjs --dry-run          只组装提示词,不调模型(验证用)
 *   node scripts/analyze-user.mjs --help             全部参数
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  dir: path.join(os.homedir(), 'lin', 'messages'),
  out: path.join(SCRIPT_DIR, 'user-input-index.jsonl'),
  batch: 30,          // 每批楼层数(偶数层=用户输入,30 层约 15 条用户消息)
  parallel: 0,        // 并发批数,0=串行
  retry: 2,           // 批内格式错误重试次数
  model: 'deepseek-v4-flash',
  config: path.join(SCRIPT_DIR, 'config.json'),
  env: path.join(SCRIPT_DIR, '.env'),
  prompt: path.join(SCRIPT_DIR, 'prompt.txt'),
  sceneChars: 500,    // 场景正文截断字数
  userChars: 400,     // 用户原话截断字数
  prevChars: 200,     // 上一条用户发言截断字数
  temperature: 0,
  maxTokens: 128000,
  timeoutMs: 120000,
};

/* ==================== M1 参数解析 ==================== */
function parseArgs(argv) {
  const a = { ...DEFAULTS, floors: null, force: false, dryRun: false, limit: 0, help: false };
  const next = (i, k) => { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) throw new Error(k + ' 缺参数值'); return [v, i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    let v;
    switch (k) {
      case '--dir':       [v, i] = next(i, k); a.dir = v; break;
      case '--out':       [v, i] = next(i, k); a.out = v; break;
      case '--batch':     [v, i] = next(i, k); a.batch = Number(v); break;
      case '--parallel':  [v, i] = next(i, k); a.parallel = Number(v); break;
      case '--retry':     [v, i] = next(i, k); a.retry = Number(v); break;
      case '--floors': {
        [v, i] = next(i, k);
        const m = v.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) throw new Error('--floors 格式应为 90-120 或 95,收到: ' + v);
        a.floors = [Number(m[1]), Number(m[2] || m[1])];
        break;
      }
      case '--force':     a.force = true; break;
      case '--dry-run':   a.dryRun = true; break;
      case '--limit':     [v, i] = next(i, k); a.limit = Number(v); break;
      case '--model':     [v, i] = next(i, k); a.model = v; break;
      case '--config':    [v, i] = next(i, k); a.config = v; break;
      case '--env':       [v, i] = next(i, k); a.env = v; break;
      case '--scene-chars': [v, i] = next(i, k); a.sceneChars = Number(v); break;
      case '--user-chars':  [v, i] = next(i, k); a.userChars = Number(v); break;
      case '--prev-chars':  [v, i] = next(i, k); a.prevChars = Number(v); break;
      case '--temperature': [v, i] = next(i, k); a.temperature = Number(v); break;
      case '--max-tokens':  [v, i] = next(i, k); a.maxTokens = Number(v); break;
      case '--timeout-ms':  [v, i] = next(i, k); a.timeoutMs = Number(v); break;
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

/* ==================== M3 配置加载(config.json + .env) ==================== */
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
    temperature: args.temperature, maxTokens: args.maxTokens, timeoutMs: args.timeoutMs,
  };
  log('CONFIG', '上游=' + cfg.name + ' base=' + (up.baseurl || '?') + ' model=' + model + ' key=' + (key ? '已配置' : '缺失'));
  return cfg;
}

/* ==================== M4 消息加载 ==================== */
function loadMessages(dir) {
  if (!fs.existsSync(dir)) throw new Error('数据目录不存在: ' + dir);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
  if (files.length === 0) throw new Error('数据目录下没有 .jsonl 文件: ' + dir);
  const msgs = [];
  let bad = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { msgs.push(JSON.parse(line)); }
      catch (e) { bad++; if (bad <= 3) log('WARN', '坏行跳过: ' + f + ' ' + e.message); }
    }
  }
  if (bad > 3) log('WARN', '共 ' + bad + ' 行解析失败已跳过');
  msgs.sort((x, y) => (x.floor || 0) - (y.floor || 0));
  log('LOAD', '共 ' + files.length + ' 个文件, ' + msgs.length + ' 条消息(楼层 ' + msgs[0].floor + '~' + msgs[msgs.length - 1].floor + ')');
  return msgs;
}

/* ==================== M5 我的时间提取 ==================== */
function extractMyTime(text) {
  const m = String(text || '').match(/我的时间[:：]\s*(\d{4})[年\/.\-](\d{1,2})[月\/.\-](\d{1,2})/);
  if (!m) return null;
  const rawLine = String(text).match(/我的时间[:：].*$/m);
  return {
    date: m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0'),
    raw: rawLine ? rawLine[0].trim() : m[0],
  };
}

/* ==================== M6 分析单元组装(用户消息 + 场景配对) ==================== */
function buildUnits(messages, opts) {
  const units = [];
  let lastAsst = null, prevUserText = '';
  for (const m of messages) {
    if (m.role === 'assistant') { lastAsst = m; continue; }
    if (m.role !== 'user') continue;
    if (typeof m.floor !== 'number') { log('WARN', 'user 消息缺 floor 跳过: ' + JSON.stringify(m).slice(0, 80)); continue; }
    const scene = lastAsst ? {
      kind: String(lastAsst.kind || ''),
      line: String(lastAsst.scene || String(lastAsst.text || '').split('\n')[0] || '').slice(0, 120),
      text: String(lastAsst.text || '').replace(/\s+/g, ' ').slice(0, opts.sceneChars),
    } : { kind: '', line: '', text: '' };
    const mt = extractMyTime(m.text);
    const full = String(m.text || '');
    units.push({
      floor: m.floor,
      time: String(m.time || ''),
      kind: String(m.kind || ''),
      date: mt ? mt.date : String(m.time || '').slice(0, 10),
      myTime: mt ? mt.raw : '',
      timeSource: mt ? 'myTime' : 'send',
      sceneKind: scene.kind,
      sceneLine: scene.line,
      sceneText: scene.text,
      prevUserText: prevUserText.slice(0, opts.prevChars),
      text: full.slice(0, opts.userChars),
      textFull: full,
    });
    prevUserText = full;
  }
  log('UNIT', '组装分析单元 ' + units.length + ' 条用户消息');
  return units;
}

/* ==================== M7 提示词 ==================== */
const DEFAULT_SYSTEM_PROMPT = [
  '你是聊天记录分析员,负责分析角色扮演聊天中玩家「修」(港区指挥官)的发言。',
  '',
  '输入:一批用户消息(按楼层排列),每条附带:',
  '- floor 楼层号、时间(「我的时间」为玩家自报的真实时间;无则为消息发送时间)',
  '- 场景:该条之前最近的剧情正文(kind=main 正常正文 / kind=dream 梦境推演,均为剧情语境;sceneLine 为剧情时间地点,正文开头为角色刚写的内容)',
  '- prevUser:该用户紧邻的上一条发言(可能为空),用于理解连续发言',
  '- 用户的话(原文,可能截断)',
  '',
  '任务:结合场景语境逐条分析,输出严格 JSON 对象 {"results": [...]},results 为数组,元素与输入一一对应(floor 必须一致):',
  '{"results":[{"floor":整数,"category":"类别","tags":["标签",...],"importance":整数1到5,"reason":"一句话原因","summary":"一句话摘要"}]}',
  '',
  '字段要求:',
  '- category:该发言的场景类别。优先从这些里选:上工/工作、吃饭/饮食、喝水、作息/睡眠、问候/招呼、分享日常、回答问题、提问/询问、情感表达、指令/元叙事、其他;都不贴切可自拟简短类别(不超过10字)。',
  '- tags:1到5个检索标签,每个2到10字,尽量具体可查(如"询问吃什么""报水账""上工""早安""聊游戏"),把这条发言里所有可查询的点都打上。',
  '- importance:1=口水/无信息;2=日常琐碎;3=日常但含信息(报备、闲聊内容);4=涉及约定、账目、状态变化或情绪明显;5=重要决定、承诺、冲突、剧烈情绪、剧情转折。',
  '- reason:结合场景,一句话说明这条发言的来由与分类依据——针对什么、回应什么、因为什么而说(不超过60字)。',
  '- summary:这条发言的具体内容,必须写实——报账就写报的什么账、提问就写问的什么问题、分享就写分享的什么事(不超过40字,供查询直读)。',
  '',
  '规则:只输出 JSON 对象本身,不要代码围栏,不要任何解释或评论。',
].join('\n');

/* 提示词从文件加载(不存在则生成默认文件,可编辑后重跑) */
function loadSystemPrompt(p) {
  if (fs.existsSync(p)) {
    const s = fs.readFileSync(p, 'utf8').trim();
    if (s) { log('PROMPT', '从 ' + p + ' 加载提示词(' + s.length + ' 字)'); return s; }
  }
  fs.writeFileSync(p, DEFAULT_SYSTEM_PROMPT + '\n');
  log('PROMPT', '已生成默认提示词文件 ' + p + ',可直接编辑,下次运行生效');
  return DEFAULT_SYSTEM_PROMPT;
}

function unitBlock(u) {
  const lines = [];
  lines.push('【floor=' + u.floor + '】时间: ' + (u.myTime || u.time || '未知'));
  lines.push('场景(kind=' + (u.sceneKind || '无') + '): ' + (u.sceneLine || '(无)'));
  if (u.sceneText) lines.push('(正文开头) ' + u.sceneText);
  if (u.prevUserText) lines.push('(上一条用户发言) ' + u.prevUserText);
  lines.push('用户的话:');
  lines.push(u.text || '(空)');
  return lines.join('\n');
}
function buildBatchPrompt(units, batchNo, totalBatches) {
  return '请分析第 ' + batchNo + '/' + totalBatches + ' 批共 ' + units.length + ' 条用户消息:\n\n' +
    units.map(unitBlock).join('\n\n---\n\n') + '\n\n---\n请输出 JSON 对象 {"results": [' + units.length + ' 个元素]}。';
}
function buildSinglePrompt(u) {
  return '请分析这一条用户消息,输出 JSON 对象(results 数组含 1 个元素):\n\n' + unitBlock(u);
}

/* ==================== M8 LLM 调用 ==================== */
async function callLLM(cfg, messages, label) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({ model: cfg.model, messages, temperature: cfg.temperature, max_tokens: cfg.maxTokens, response_format: { type: 'json_object' } }),
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

/* ==================== M9 格式校验(只校验格式) ==================== */
function validateBatch(records, units) {
  const errors = [];
  if (records && typeof records === 'object' && !Array.isArray(records) && Array.isArray(records.results)) records = records.results;
  if (!Array.isArray(records)) return { ok: false, errors: ['输出不是 JSON(需要 {\"results\":[...]})'] };
  if (records.length !== units.length) errors.push('数组长度 ' + records.length + ' 不等于输入 ' + units.length + ' 条');
  const floors = new Set(units.map(u => u.floor));
  const seen = new Set();
  const clean = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') { errors.push('存在非对象元素'); continue; }
    const e = [];
    if (typeof r.floor !== 'number' || !floors.has(r.floor)) e.push('floor 缺失或不在输入中(' + r.floor + ')');
    if (seen.has(r.floor)) e.push('floor 重复(' + r.floor + ')');
    else if (typeof r.floor === 'number') seen.add(r.floor);
    if (typeof r.category !== 'string' || !r.category.trim()) e.push('category 非空字符串');
    if (!Array.isArray(r.tags) || r.tags.length > 6 || r.tags.some(t => typeof t !== 'string' || !t.trim())) e.push('tags 为 0-6 个非空字符串');
    if (typeof r.importance !== 'number' || !Number.isInteger(r.importance) || r.importance < 1 || r.importance > 5) e.push('importance 为 1-5 整数');
    if (typeof r.reason !== 'string' || !r.reason.trim()) e.push('reason 非空字符串');
    if (typeof r.summary !== 'string' || !r.summary.trim()) e.push('summary 非空字符串');
    if (e.length) errors.push('floor=' + r.floor + ' ' + e.join(';'));
    else clean.push({ floor: r.floor, category: r.category.trim(), tags: r.tags.map(t => t.trim()).slice(0, 6), importance: r.importance, reason: r.reason.trim(), summary: r.summary.trim() });
  }
  return { ok: errors.length === 0, errors, clean };
}

/* ==================== M10 文件工具 ==================== */
function appendJsonl(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + '\n');
}
function readLinesIfExists(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim());
}
function normalize(out) {
  if (!fs.existsSync(out)) return 0;
  const map = new Map();
  let bad = 0;
  for (const line of readLinesIfExists(out)) {
    try { const o = JSON.parse(line); if (typeof o.floor === 'number') map.set(o.floor, o); else bad++; }
    catch (e) { bad++; }
  }
  const sorted = [...map.values()].sort((x, y) => x.floor - y.floor);
  fs.writeFileSync(out, sorted.map(o => JSON.stringify(o)).join('\n') + '\n');
  return bad;
}

/* ==================== M11 主流程 ==================== */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/analyze-user.mjs [选项]');
    console.log('  --dir <目录>      数据目录,默认 ~/lin/messages');
    console.log('  --out <文件>      索引输出,默认 <scripts>/user-input-index.jsonl');
    console.log('  --batch <N>       每批楼层数,默认 30');
    console.log('  --parallel <N>    并发批数,默认 0(串行)');
    console.log('  --retry <N>       批格式错误重试次数,默认 2');
    console.log('  --floors 90-120   只重跑指定楼层范围(覆盖旧结果)');
    console.log('  --force           忽略已有结果全量重跑');
    console.log('  --dry-run         只组装提示词不调模型');
    console.log('  --limit <N>       只处理前 N 条用户消息(调试)');
    console.log('  --model <名>      模型,默认 deepseek-v4-flash');
    console.log('  --config <文件>   config.json 路径(默认脚本同目录)');
    console.log('  --env <文件>      .env 路径(默认脚本同目录)');
    console.log('  --scene-chars/--user-chars/--prev-chars/--temperature/--max-tokens/--timeout-ms');
    return;
  }
  const base = args.out.replace(/\.jsonl$/i, '');
  const batchesPath = base + '.batches.jsonl';
  const errorsPath = base + '.errors.jsonl';
  const tStart = Date.now();

  log('START', '参数: batch=' + args.batch + ' parallel=' + args.parallel + ' floors=' + (args.floors ? args.floors.join('-') : '全部') + (args.dryRun ? ' DRY-RUN' : '') + (args.force ? ' FORCE' : ''));

  const systemPrompt = loadSystemPrompt(args.prompt);
  const cfg = loadConfig(args);
  if (!cfg.key && !args.dryRun) {
    log('ERROR', '没有 API 密钥:请在 scripts/.env 里填 deepseek=<key>,或设环境变量 DEEPSEEK_API_KEY');
    process.exit(1);
  }

  const messages = loadMessages(args.dir);
  let units = buildUnits(messages, args);
  if (args.limit > 0) { units = units.slice(0, args.limit); log('LIMIT', '只处理前 ' + units.length + ' 条'); }

  // 断点/范围过滤
  if (args.floors) {
    const [lo, hi] = args.floors;
    units = units.filter(u => u.floor >= lo && u.floor <= hi);
    log('RANGE', '仅重跑楼层 ' + lo + '~' + hi + ',共 ' + units.length + ' 条');
  } else if (!args.force) {
    const done = new Set();
    for (const line of readLinesIfExists(args.out)) {
      try { done.add(JSON.parse(line).floor); } catch (e) {}
    }
    const before = units.length;
    units = units.filter(u => !done.has(u.floor));
    if (before > units.length) log('RESUME', '跳过已完成 ' + (before - units.length) + ' 条,待分析 ' + units.length + ' 条');
  }

  if (units.length === 0) { log('DONE', '没有待分析的楼层'); return; }

  // 按楼层切批:每批覆盖 batch 个楼层,批内取 user 单元
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
    const dryPath = base + '.dryrun.txt';
    fs.writeFileSync(dryPath, batches.map((b, i) => buildBatchPrompt(b.units, i + 1, batches.length) + '\n\n================\n\n').join(''));
    log('DRYRUN', '提示词已写入 ' + dryPath + '(共 ' + batches.length + ' 批)');
    return;
  }

  // 批执行(支持并行)
  let okCount = 0, failCount = 0, retryCount = 0;
  async function worker(b, idx) {
    const label = '批' + (idx + 1) + '/' + batches.length + ' floors=' + b.lo + '-' + b.hi + ' 条数=' + b.units.length;
    const t0 = Date.now();
    let usage = {};
    let records = [];
    let batchOk = 0;
    // 批重试
    const msgs = [{ role: 'system', content: systemPrompt }, { role: 'user', content: buildBatchPrompt(b.units, idx + 1, batches.length) }];
    for (let attempt = 1; attempt <= args.retry + 1; attempt++) {
      const r = await callLLM(cfg, msgs, label + (attempt > 1 ? ' 重试' + (attempt - 1) : ''));
      usage = r.usage;
      let parsed = null;
      try { parsed = JSON.parse(extractJson(r.content) || ''); } catch (e) { parsed = null; }
      const v = validateBatch(parsed, b.units);
      if (v.ok) { records = v.clean; break; }
      retryCount++;
      if (attempt <= args.retry) {
        log('RETRY', label + ' 格式错误,重试 ' + attempt + '/' + args.retry + ': ' + v.errors.slice(0, 2).join(' | '));
        msgs.push({ role: 'assistant', content: r.content.slice(0, 2000) });
        msgs.push({ role: 'user', content: '你上次输出格式有误:' + v.errors.slice(0, 4).join(';') + '。请重新输出完整 JSON 对象 {\"results\": [...]}(元素与输入一一对应,floor 一致)。' });
      }
    }
    if (records.length) {
      for (const rec of records) {
        const u = b.units.find(x => x.floor === rec.floor);
        appendJsonl(args.out, { ...rec, date: u.date, myTime: u.myTime, timeSource: u.timeSource, kind: u.kind, sceneKind: u.sceneKind, sceneLine: u.sceneLine, text: u.textFull, analyzedAt: new Date().toISOString() });
        okCount++;
        batchOk++;
      }
      appendJsonl(batchesPath, { batch: idx + 1, floors: [b.lo, b.hi], userCount: b.units.length, okCount: batchOk, failCount: b.units.length - batchOk, ms: Date.now() - t0, inTokens: usage.prompt_tokens ?? 0, outTokens: usage.completion_tokens ?? 0, analyzedAt: new Date().toISOString() });
      log('OK', label + ' 成功 ' + records.length + '/' + b.units.length + ' 条,耗时 ' + (Date.now() - t0) + 'ms');
      return;
    }
    // 批重试耗尽:拆单条
    log('WARN', label + ' 批重试耗尽,拆单条逐条重试');
    for (const u of b.units) {
      try {
        const r = await callLLM(cfg, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: buildSinglePrompt(u) },
        ], '单条 floor=' + u.floor);
        let parsed = null;
        try { parsed = JSON.parse(extractJson(r.content) || ''); } catch (e) { parsed = null; }
        const v = validateBatch(parsed, [u]);
        if (v.ok) {
          const rec = v.clean[0];
          appendJsonl(args.out, { ...rec, date: u.date, myTime: u.myTime, timeSource: u.timeSource, kind: u.kind, sceneKind: u.sceneKind, sceneLine: u.sceneLine, text: u.textFull, analyzedAt: new Date().toISOString() });
          okCount++;
          batchOk++;
        } else {
          failCount++;
          appendJsonl(errorsPath, { floor: u.floor, error: (v.errors[0] || '格式校验失败').slice(0, 300), analyzedAt: new Date().toISOString() });
          log('ERROR', 'floor=' + u.floor + ' 单条失败: ' + v.errors[0]);
        }
      } catch (e) {
        failCount++;
        appendJsonl(errorsPath, { floor: u.floor, error: String(e.message || e).slice(0, 300), analyzedAt: new Date().toISOString() });
        log('ERROR', 'floor=' + u.floor + ' 调用失败: ' + e.message);
      }
    }
    appendJsonl(batchesPath, { batch: idx + 1, floors: [b.lo, b.hi], userCount: b.units.length, okCount: batchOk, failCount: b.units.length - batchOk, ms: Date.now() - t0, inTokens: usage.prompt_tokens ?? 0, outTokens: usage.completion_tokens ?? 0, analyzedAt: new Date().toISOString() });
  }

  if (args.parallel > 1) {
    let idx = 0;
    await Promise.all(Array.from({ length: Math.min(args.parallel, batches.length) }, async () => {
      while (idx < batches.length) { const i = idx++; await worker(batches[i], i); }
    }));
  } else {
    for (let i = 0; i < batches.length; i++) await worker(batches[i], i);
  }

  const bad = normalize(args.out);
  if (bad) log('WARN', '索引去重排序时清理 ' + bad + ' 行坏数据');
  log('DONE', '完成:成功 ' + okCount + ' 条,失败 ' + failCount + ' 条,批内重试 ' + retryCount + ' 次,总耗时 ' + ((Date.now() - tStart) / 1000).toFixed(1) + 's');
  console.log('索引: ' + args.out);
  console.log('分割点: ' + batchesPath);
  console.log('失败记录: ' + errorsPath + '(无失败则为空文件)');
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
