# st-lite-agent 服务端插件

SillyTavern 服务端插件:随酒馆启动/关闭一个 OpenAI 兼容的轻量转发服务。纯 Node 实现,不依赖 Python/LiteLLM。

## 结构

- `index.js` — 酒馆插件入口(CommonJS):酒馆启动时拉起 proxy,退出时停掉
- `proxy.js` — 转发服务本体:零框架(node:http)+ `openai` 官方 SDK

请求链路:

```
酒馆 -> http://127.0.0.1:7890/v1 -> proxy -> 上游(默认本地 Ollama http://127.0.0.1:11434/v1)
```

## 安装

1. 把本目录拷贝到酒馆的 plugins 目录,如 `<SillyTavern>/plugins/st-lite-agent/`
2. 进入该目录执行 `npm install --omit=dev`
3. 重启酒馆(控制台应看到 `[st-lite-agent] proxy 已启动`)

## 酒馆里配置

1. 扩展 API → Chat Completion → 来源选 Custom(OpenAI 兼容)
2. 地址填 `http://127.0.0.1:7890/v1`,密钥随意
3. 模型列表从上游自动拉取(或手动填上游的模型名)

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LITE_AGENT_PORT` | `7890` | 代理监听端口 |
| `LITE_AGENT_HOST` | `127.0.0.1` | 代理监听地址 |
| `LITE_AGENT_UPSTREAM_URL` | `http://127.0.0.1:11434/v1` | 上游 OpenAI 兼容地址 |
| `LITE_AGENT_API_KEY` | `ollama` | 上游 API Key(Ollama 可随意填) |

在启动酒馆的 shell 里设置即可(会透传给 proxy 进程)。

## 单独运行(不经过酒馆)

```bash
npm start
curl http://127.0.0.1:7890/healthz
```

## 后续

在这一层拦截请求,即可加入 prompt 改写、Agent 编排等逻辑。

