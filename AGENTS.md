# st-lite-agent 聚合仓

SillyTavern 前后端插件聚合仓(两子模块独立仓库)+ OpenAI 兼容 agent 服务。

## 项目地图

- `sillytavern-server-plugin/` — 服务端插件:OpenAI 兼容 **agent 服务**(端口 6789)。Vercel AI SDK(`ai@7` + `@ai-sdk/openai-compatible`)多段流水线;**agent-only,无直通转发**,失败即报错不降级。
- `sillytavern-frontend-plugin/` — 前端 ST 扩展:悬浮球 + 实时进度面板(轮询落盘文件)+ 扩展菜单(魔法棒)「Agent 控制台」全屏配置界面。

## 部署拓扑(本机 WSL)

- SillyTavern:`~/SillyTavern`(页面 http://127.0.0.1:8000),服务端插件随酒馆启动(`npm start`)。
- 安装目录(部署 = 在那里 `git pull`,用户自己控制重启时机):
  - 服务端:`~/SillyTavern/plugins/st-lite-agent-server`
  - 前端:`~/SillyTavern/public/scripts/extensions/third-party/st-lite-agent-frontend`
- agent 服务:手动进程,pid 在 `/tmp/st-plugin.pid`;健康检查 `http://127.0.0.1:6789/healthz`。
- **铁律:用户可能正在对话/生成中。任何重启服务的操作必须先征得同意或由用户自己执行**
  (`kill $(cat /tmp/st-plugin.pid)` → `nohup node src/server.js > /tmp/st-plugin-boot.log 2>&1 & echo $! > /tmp/st-plugin.pid`)。

## 数据源与约定

- **唯一世界书数据源:`~/lin/worldbook/碧蓝航线.json`(繁体)。酒馆 `data/default-user/worlds/` 下是落后副本,禁止读取。**
- 舰娘名单:`src/resources/azurlane-shipgirls.json`(804 名,保持世界书原文不做简繁转换);重新生成:`node src/resources/extract-shipgirls.js`。
- 配置严格化:`config.json` 唯一配置源,代码零默认值,缺项启动聚合报错;根节点 `builtins.<脚本名>` 为对应 builtin 的配置(如 roll_intrude 阈值/候选数)。
- 注册制:`src/tools/`(LLM 工具,契约 name/description/parameters/execute)与 `src/builtins/`(代码段,契约 name/run),一文件一单元,`_` 开头为辅助文件;启动扫描注册,引用未注册名启动报错。
- 失败语义:无兜底;流式段(output=stream)无绝对超时,中止只跟随客户端断开/面板停止。
- 提示词 `src/prompts/*` 每请求实时读取,改完即生效;**代码改动需重启服务**。

## 验证习惯

- `npm run check`(全量语法);改动用 /tmp 下 mock 上游回归(mock 9999 / 服务 6790,勿占 6789)。
- **mock 必须断言上游请求带 system 法则**(v0.2.0 曾因直连路径丢 system 出过事故)。
- 面板/接口问题先看:`logs/agent.log`、`logs/steps/<reqId>/*.{prompt,output,reasoning}.txt`、`curl /agent/requests`。
- 控制台「日志写入失败」= 落盘降级(不挡对话但丢审计),要查。

## MCP

- `chrome-devtools` 已配置:`--browserUrl=http://127.0.0.1:9222`,连 Windows Chrome 调试实例(独立 profile `C:\chrome-mcp-profile`)。
- 该 Chrome 窗口关闭后需重拉:`"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=C:\chrome-mcp-profile`
- 用途:实测酒馆页面与「Agent 控制台」配置界面。

## 当前状态(2026-09-01)

- v0.2.0:AI SDK 迁移完成;builtins/tools 注册制;前端轮询 + 全屏配置界面;乱入检定(804 名单);时间取系统时钟,Δt 由状态块「时间」计算(状态缺失退回进程内存)。
- 直连路径丢失 system 法则的事故已修复,mock 已加断言。
- 待验证:真实 glm-5.3/deepseek 全流水线各跑一轮,看 `settlement.reasoning.txt` 思维链落盘与 writer 真实 finish_reason。
- 若酒馆请求体带较小 `max_tokens` 会继承到 writer(可能截断,`finish_reason: length` 可见)。
