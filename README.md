# st-lite-agent

SillyTavern 轻量 Agent 项目(聚合仓:前后端两个插件都在这里)。

- `sillytavern-server-plugin/` — 酒馆服务端插件:随酒馆启动/关闭一个 OpenAI 兼容的轻量转发服务(纯 Node + `openai` SDK,无 Python/LiteLLM)
- `sillytavern-frontend-plugin/` — 酒馆前端插件:骨架已就绪(占位斜杠命令 `/lite-agent`)

> 如果之后想把两个插件拆成独立仓库,只需给两个子目录分别 `git init` 并在本仓用 submodule 引用即可,目录结构不变。

