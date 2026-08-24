/**
 * st-lite-agent proxy —— OpenAI 兼容转发服务(纯 Node,零框架)
 * 酒馆把这里当作自定义 OpenAI 端点,所有请求原样转发到上游。
 */
const http = require('node:http');
const { OpenAI } = require('openai');

// 配置全部来自环境变量,默认指向本地 Ollama
const HOST = process.env.LITE_AGENT_HOST || '127.0.0.1';
const PORT = Number(process.env.LITE_AGENT_PORT || 7890);
const UPSTREAM_URL = process.env.LITE_AGENT_UPSTREAM_URL || 'http://127.0.0.1:11434/v1';
const API_KEY = process.env.LITE_AGENT_API_KEY || 'ollama';

const client = new OpenAI({ baseURL: UPSTREAM_URL, apiKey: API_KEY });

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message, type = 'proxy_error') {
  sendJson(res, status, { error: { message: String(message), type } });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function handleModels(res) {
  try {
    const list = await client.models.list();
    sendJson(res, 200, list);
  } catch (err) {
    sendError(res, 502, '上游不可达: ' + err.message, 'upstream_error');
  }
}

async function handleChatCompletions(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendError(res, 400, '请求体不是合法 JSON', 'invalid_request_error');
  }

  const stream = !!body.stream;
  try {
    if (stream) {
      const upstream = await client.chat.completions.create({ ...body, stream: true });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.on('error', () => {});
      for await (const chunk of upstream) {
        if (res.writableEnded || res.destroyed) break;
        res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      }
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } else {
      const completion = await client.chat.completions.create({ ...body, stream: false });
      sendJson(res, 200, completion);
    }
  } catch (err) {
    if (res.headersSent) return res.end();
    const status = Number.isInteger(err.status) ? err.status : 502;
    sendError(res, status, err.message || String(err), 'upstream_error');
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, upstream: UPSTREAM_URL });
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return handleModels(res);
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(req, res);
  }

  sendError(res, 404, '未知路由: ' + req.method + ' ' + url.pathname, 'not_found');
});

server.listen(PORT, HOST, () => {
  console.log('[st-lite-agent] proxy 已启动: http://' + HOST + ':' + PORT + '/v1 -> ' + UPSTREAM_URL);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

