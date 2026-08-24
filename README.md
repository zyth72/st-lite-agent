# st-lite-agent

SillyTavern 轻量 Agent 项目(聚合仓)。

两个插件各自是独立 git 仓库,本仓以 submodule 形式引用:

- `sillytavern-server-plugin/` — 酒馆服务端插件:随酒馆启停 OpenAI 兼容轻量转发服务(纯 Node,无 Python/LiteLLM)→ https://github.com/zyth72/st-lite-agent-server
- `sillytavern-frontend-plugin/` — 酒馆前端插件:占位斜杠命令 `/lite-agent` → https://github.com/zyth72/st-lite-agent-frontend

## 克隆

```bash
git clone https://github.com/zyth72/st-lite-agent.git --recurse-submodules
```

## 更新子模块

```bash
git submodule update --remote
```
