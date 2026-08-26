# 迁移到 Pi 的可复用资产清单与路径

> 适用:把当前 `st-lite-agent`(ST 服务端插件 + 前端悬浮窗)迁到 [earendil-works/pi](https://github.com/earendil-works/pi)(AI agent toolkit:统一 LLM API / agent loop / TUI / CLI)。
> 结论先行:**框架层是重复的,内容层与流水线设计是可平移资产。** 迁移 = 把现有 `prompts/` + `agent.json` + 内置代码逻辑转成 pi 的 agent/skill/tool 配置,不是重写。
> 注:pi 具体字段以官方文档为准,本文给出的是角色/职责层面的映射。

---

## 1. 资产盘点

### 1.1 可平移到 pi 的(内容 + 设计)

| 现有资产 | 作用 | Pi 对应物 |
|---|---|---|
| `prompts/windows.txt` | 窗口规划(主/副窗口清单) | skill / agent 的 system prompt 或子任务 |
| `prompts/settlement.txt` | 空间结算 JSON(场景/在场/离场/offstage/parallelGroups) | skill,输出走 JSON schema 校验 |
| `prompts/relationships.txt` | 关系矢量(长期时间线变化之和) | skill(文本输出) |
| `prompts/facts.txt` | 事实纪律(唯一可用素材边界) | skill(JSON 输出) |
| `prompts/reply.txt` | 点名回路 / 回复义务(duty=否 免回) | skill(JSON 输出) |
| `prompts/parallel.txt` | 并行场景(B/C 组素材,与主线无交集) | skill(文本输出) |
| `prompts/writer.txt` | 元叙事 + 写作(最大,十二节规则) | skill(流式输出,或 agent 主任务) |
| `agent.json` stages | 多段流水线 = 顺序/并行编排 | pi 的 agent 步骤 / 子 agent / 并行 |
| builtin:`parse/state/split/detect_ping` | 纯代码:时间计算、状态解析、裁剪、分拣、点名识别 | pi 的 **tool/function**(确定性,不进提示词) |
| 结算/窗口/事实/回复 JSON schema | 程序 ↔ 模型交接(结构化) | pi skill 的 input/output schema(JSON mode) |
| `docs/agent-design.md` | 架构设计文档 | 迁移后的架构说明(内容更新指向 pi) |
| `凛.json` 等业务数据 | 世界观/角色/事件/大事记 | 数据文件原样迁移 |

### 1.2 丢掉/替换(pi 原生更强)

| 现有 | 处理 |
|---|---|
| 自研 HTTP 转发 / 上游路由 / 模型发现 | 改用 pi 统一 LLM API |
| 多段 HTTP 编排 + SSE 推送(pipeline 服务端) | 改用 pi agent loop + 子 agent |
| 日志/审计文件(logs/steps) | 用 pi 的 workspace/session 记录(本地) |
| 前端悬浮窗 | 若仍要在 ST 用,保留前端、后端推理换 pi;否则直接用 pi 的 TUI/CLI |

---

## 2. 迁移路径(建议分阶段)

### 阶段 0 —— 可行性确认
先验证 pi 满足你真正的约束:
- ST 停靠/通信位(消息通道、角色切换)
- 多模型路由(deepseek / 火山 glm-5.3 / GLM / kimi)
- 前端/移动端接入(如果还留前端)

### 阶段 1 —— 提示词转 skill
把每个 `prompts/*.txt` 转成 pi 的 skill / agent 定义,保持统一结构:
1. **角色定位**
2. **【优先级(强制)】**(writer 必须保留整段;其它段若有同样前置)
3. **规则**
4. **输入(数据)**:小字段在前、大块参考(state/lore)在后
5. **输出格式**(json/text/stream)

### 阶段 2 —— 代码转 tool
把 builtin 逻辑用 pi 的 tool/function 实现(纯函数,模型零计算):
- `parse_signal_and_time`:解析「我的时间」→ timeContext(真实时间 +7 天、Δt 分级、时段、乱入豁免)
- `parse_state` + `split`:【当前状态信息】解析/裁剪/分拣(lore/history/brief/rag)
- `detect_ping`:点名识别
> 时间脚本化规则(§3.5)原样搬,提示词里不放时间换算。

### 阶段 3 —— 流水线编排
把多段流水线映射为 pi 的 agent 步骤:
- 串行:windows → settlement → relationships → {facts ∥ reply} → {parallel ∥ writer}
- 并行对:facts∥reply、parallel∥writer(pi 原生支持子 agent/并行)
- 段间交接沿用「JSON/MD 双通道」:程序吃结构(JSON),模型读文本(MD)。

### 阶段 4 —— ST 对接
- writer 结果回 ST(messages / 流式);
- 前端若保留,只做展示层(SSE 或轮询 pi 输出)。

---

## 3. 关键映射细节

| 关注点 | 处理 |
|---|---|
| json/md 双通道 | skill 输出 JSON(程序),注入下游前渲染 MD——延续现有约定 |
| 乱入检定 | ST 前端掷骰宏 → 移到 pi 后由 tool 自掷(候选名单从世界书/配置取) |
| 每段模型 | pi 的 per-agent model 路由;writer 沿用酒馆采样(inherit_sampling) |
| 键/上游 | 用 pi 的统一配置/密钥管理,不再自研 config.json/.env 路由 |
| 并行段串写等各种坑 | pi 的 agent 原生隔离,不再有共享 RequestLog 的 stageId 串写问题 |

---

## 4. 迁移后仓库建议

```
st-lite-agent-pi/
├── skills/                    # 每个提示词 → 一个 skill 定义
│   ├── windows.json / settlement.json / relationships.json /
│   ├── facts.json / reply.json / parallel.json / writer.json
├── tools/                     # 确定性代码 → pi tool
│   ├── time.js                # 时间脚本化(§3.5)
│   ├── state.js               # 状态解析/裁剪/分拣
│   └── ping.js                # 点名识别
├── pipeline.agent.json        # 多段流水线编排(串行+并行)
├── data/                      # 凛.json 等世界观/角色数据
└── docs/
    ├── agent-design.md        # 更新指向 pi
    └── MIGRATE_TO_PI.md       # 本文
```

---

## 5. 一句话

**别把 st-lite-agent 当"要重做的旧代码",把它当"已经验证过的提示词工程 + 时间/状态脚本化 + 多段结算设计"。** 迁 pi = 把这些资产装进 pi 的 agent/skill/tool 容器,框架层交给 pi。
