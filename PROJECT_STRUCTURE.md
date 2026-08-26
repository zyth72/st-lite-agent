# st-lite-agent 项目结构与文件清单

> 目的:当前项目文件较多且分散(聚合仓库 + 前后端两个子模块 + 文档 + 数据 + Pi 迁移),本文梳理每类文件的职责与目录,避免混着放、找不到。
> 更新时间:与当前 main 一致。

---

## 1. 仓库拓扑

```
zyth72/st-lite-agent (聚合仓库,git submodule 管理)
├── sillytavern-server-plugin   → zyth72/st-lite-agent-server   (ST 服务端插件 / proxy + agent 流水线)
└── sillytavern-frontend-plugin → zyth72/st-lite-agent-frontend (ST 前端悬浮窗插件, Vue 3)
```

- 聚合仓库负责:submodule 指针 + 项目级文档 + 角色/世界观数据。
- 两个子模块各自独立 git 仓库,分别推送。

---

## 2. 聚合仓库根

| 路径 | 职责 |
|---|---|
| `sillytavern-server-plugin/` | 服务端子模块 |
| `sillytavern-frontend-plugin/` | 前端子模块 |
| `MIGRATE_TO_PI.md` | **Pi 迁移指南**:现有资产 → pi 的 skill/tool 映射与路径 |
| `PROJECT_STRUCTURE.md` | 本文 |
| `README.md` | 项目简介 |
| `凛.json` / `碧蓝航线.json` / `123.json` 等 | 角色/世界观数据(业务资产,不入 git 的 .env 之外) |
| `strip-chat.py` / `strip-npcact.py` | 数据处理小脚本 |
| `*.jpg` | 参考图/头像等资源 |

---

## 3. 服务端插件 `sillytavern-server-plugin/`

### 3.1 根目录

| 文件 | 职责 |
|---|---|
| `proxy.js` | **入口**:Express 应用。启动、CORS、JSON body、全部 /v1 与 /agent/* 路由、404/错误中间件 |
| `index.js` | ST 插件入口(挂载 proxy,随 ST 启停) |
| `agent.json` | **agent 流水线声明**:stages 数组(顺序/并行),`enabled` 开关 |
| `config.json` | 上游列表:`[{name, baseurl, models[]}]`(被 .gitignore,不入库) |
| `config.example.json` | config.json 示例 |
| `.env` | 上游密钥 `name=key`(被 .gitignore,不入库) |
| `package.json` / `package-lock.json` | 依赖(openai / express / cors) |
| `README.md` | 服务端说明 |
| `logs/` | 运行日志(agent.log / prompts.log / steps/**)(gitignore) |
| `node_modules/` | 依赖(不提交,部署需 `npm install`) |

### 3.2 `src/`(转发与 API)

| 文件 | 职责 |
|---|---|
| `config.js` | 环境变量/CONFIG_PATH/ENV_FILE/读取 config.json/.env |
| `upstream.js` | 上游路由:providers 注册、client 缓存、模型发现(`/v1/models`)、resolveTarget、热重载 reload |
| `forward.js` | 请求处理:`/v1/chat/completions`(直通 + agent 流水线接入)、`sendJson/sendError` |
| `api.js` | 面板 API + SSE 推送:`/agent/stream`(SSE)、requests、config GET/POST、render-md、load-models、steps |

### 3.3 `agent/`(流水线核心)

| 文件 | 职责 |
|---|---|
| `executor.js` | **执行器**:读 agent.json、按序/并行跑段、context 交接;内置 `parseJsonContent/settlementMd/toMarkdown`;LLM 段默认 `response_format:json_object` |
| `builtins.js` | 内置代码段:parse(信号/时间)、state(状态解析/裁剪)、split(分拣)、detect_ping(点名) |
| `logger.js` | 日志:agent.log 摘要 + steps/<req>/<stage>.{prompt,reasoning,output}.txt;SSE chunk 广播(stageId 显式,防并行串写) |
| `stream-hub.js` | SSE 事件总线(reset / stage / chunk),`getLastReset` |

### 3.4 `prompts/`(提示词,按段,git 管理)

| 文件 | 作用 |
|---|---|
| `settlement.txt` | 空间结算(场景/在场/离场/offstage 副窗口/parallelGroups),已并入窗口规划 |
| `relationships.txt` | 关系矢量 |
| `facts.txt` | 事实纪律 |
| `reply.txt` | 点名回路/回复义务 |
| `parallel.txt` | 并行场景素材 |
| `writer.txt` | 元叙事 + 写作(最大,十二节) |
| `backstage.txt` | 旧文件,已弃用(可删) |

### 3.5 `docs/`

| 文件 | 职责 |
|---|---|
| `agent-design.md` | 设计稿(v1 蓝图;现状已远超) |
| `PROGRESS.md` | 项目进度/接续点/已知坑(推荐新会话先读) |

---

## 4. 前端插件 `sillytavern-frontend-plugin/`

### 4.1 根目录

| 文件 | 职责 |
|---|---|
| `index.js` | **入口**:环境探测、注入样式、挂载 Vue、连 SSE、注册全局组件 |
| `app.js` | Vue 根组件 + `StageCard`(步骤卡)+ `SettingsView`(API 配置/段配置) |
| `store.js` | 响应式状态 + SSE 连接(事件写 store,组件只读/调 action) |
| `hooks.js` | VueUse 同名小实现(useLocalStorage/useToggle/useEventListener) |
| `styles.js` | M3 深色样式注入(面板固定宽高、滚动、控件覆盖) |
| `manifest.json` | ST 扩展加载清单(js=index.js) |
| `README.md` | 安装/结构说明 |

### 4.2 `components/`(基础组件,全局注册)

| 文件 | 职责 |
|---|---|
| `LaInput.js` | 文本/密码/数字输入(v-model + class 透传) |
| `LaSelect.js` | 下拉选择(含继承外层空项) |
| `LaToggleItem.js` | checkbox + 文字标签 |
| `LaButton.js` | 按钮 |

### 4.3 `lib/`(vendored,不随 git 变)

| 文件 | 职责 |
|---|---|
| `vue.esm-browser.prod.js` | Vue 3(含模板编译器),171KB |
| `marked.esm.js` | marked v12 |

---

## 5. Pi 迁移相关内容

| 位置 | 说明 |
|---|---|
| `MIGRATE_TO_PI.md`(聚合根) | 迁移指南:提示词→skill、builtin→tool、流水线→pi 编排 |
| 本地探索(临时,不入仓库) | `/tmp/pi`(clone 的 pi 源码)、`/tmp/pi-bin`(npm 装的 pi)、`/tmp/pi-home`(pi 配置 HOME) |

Pi 载体已最小验证:可装、`models.json` 接 deepseek、`pi -p` 非交互 + `--system-prompt` 跑通正文。

---

## 6. 建议(避免再混)

- **文档**统一放各自仓库的 `docs/`,项目级放聚合根;
- **数据/资源**(*.json 角色卡、*.jpg、strip 脚本)聚合根已混着;可考虑收进 `assets/`、`data/`、`scripts/`;
- **临时 Pi 探索**放 `/tmp`,不进仓库;
- **敏感文件**(`.env`/`config.json`/`logs`/`node_modules`)已被 gitignore,**切勿提交**。
