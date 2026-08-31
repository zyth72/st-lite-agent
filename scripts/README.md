# scripts/ —— 聊天记录分析脚本

对 `~/lin/messages`(清洗后的聊天分片,jsonl)做模型分析,产出结构化索引与人物画像,为后续「聚合规律」「检索工具」提供数据层。

## 目录清单

| 文件 | 说明 |
|---|---|
| `analyze-user.mjs` | **脚本一**:逐条分析用户消息(打标:类别/标签/重要度/原因/摘要) |
| `analyze-user-profile.mjs` | **脚本二**:从用户发言链式提炼修的人物画像 + 剧情内事实 |
| `config.json` | 上游配置(deepseek / 火山),模型列表可加 |
| `.env` | 密钥(每行 `name=key`,name 对应 config.json 上游名) |
| `prompt.txt` | 脚本一的提示词,**可直接编辑**,下次运行生效 |
| `prompt-profile.txt` | 脚本二的提示词,同上 |
| `user-input-index.jsonl` | 脚本一产物:逐条索引 |
| `user-input-index.batches.jsonl` | 脚本一产物:分割点记录(每批楼层范围/耗时/token) |
| `user-input-index.errors.jsonl` | 脚本一产物:失败记录 |
| `user-profile.md` | 脚本二产物:修的人物画像(完整版,事实底档) |
| `user-profile.compact.md` | 画像精简版(人工精简,约1/4长度,用于酒馆日常注入控 token) |
| `user-facts.jsonl` | 脚本二产物:剧情内事实条目 |

## 数据流

```
~/lin/messages(原文,不动)
   │
   ├─ 脚本一(30层/批,可并行,断点续跑)
   │    └─> user-input-index.jsonl   每层:floor/date/myTime/category/tags/importance/reason/summary/text
   │
   └─ 脚本二(100层/批,串行增量,忽略AI/元叙事)
        ├─> user-facts.jsonl         事实:floor/date/fact/category/basis
        └─> user-profile.md          画像:身份/家庭/习惯/性格/关系/经历
```

> 剧情设定:修是港区指挥官「凛」的养父(在 `prompt.txt` 里声明)。
> 后续计划:聚合脚本(规律+异常,按天)→ 模型检索工具(function call)。

## 脚本一:analyze-user.mjs

逐条分析用户消息,结合场景(前一条角色正文)打标。偶数楼层=用户输入,30 层/批 ≈ 15 条用户消息。

```bash
node scripts/analyze-user.mjs                     # 全量,自动跳过已完成楼层
node scripts/analyze-user.mjs --floors 90-120     # 只重跑 90~120 层(覆盖旧结果)
node scripts/analyze-user.mjs --parallel 4        # 4 批并发(默认串行)
node scripts/analyze-user.mjs --force             # 忽略已有结果全量重跑
node scripts/analyze-user.mjs --dry-run           # 只组装提示词(验证)
node scripts/analyze-user.mjs --limit 60          # 只跑前 60 条(试跑)
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--dir` | `~/lin/messages` | 数据目录 |
| `--out` | `scripts/user-input-index.jsonl` | 索引输出 |
| `--batch` | `30` | 每批楼层数 |
| `--parallel` | `0` | 并发批数(0=串行) |
| `--retry` | `2` | 批格式错误重试次数,耗尽后拆单条再试 1 次 |
| `--floors 90-120` | 无 | 楼层范围重跑(覆盖该范围旧结果) |
| `--force` | 关 | 全量重跑 |
| `--model` | `deepseek-v4-flash` | 模型名(config.json 里有即可用) |
| `--scene-chars` | `500` | 场景正文截断字数 |
| `--user-chars` | `400` | 用户原话截断字数 |

索引每行字段:`floor`(楼层) `date`/`myTime`(「我的时间」) `category`(类别) `tags`(检索标签) `importance`(1-5) `reason`(来由) `summary`(具体内容) `text`(原话) `sceneLine`(场景行)。

## 脚本二:analyze-user-profile.mjs

只分析用户发言,提炼修的人物画像。**串行**,草稿按「## 维度」分节;每批模型只输出**有变化的维度**(`changed`:维度名 → 该维度合并新事实后的完整内容)与新事实 `newFacts`,**代码负责合并进草稿**(命中维度整节替换/新维度追加,未提及维度原样保留)——输出量只随本批变化量增长,不会因草稿变大而撞 max_tokens 截断或超时(旧版全量重输出草稿正是因此总截断/总 `[FATAL] This operation was aborted`)。**忽略一切 AI/元叙事发言**。**断点续跑**:进度(`state` 文件:最后楼层+草稿)每批落盘,中断后直接重跑即续传。

```bash
node scripts/analyze-user-profile.mjs              # 全量(自动从断点续跑)
node scripts/analyze-user-profile.mjs --limit 100  # 只跑前 100 层(1 批,验证用;与断点取交集)
node scripts/analyze-user-profile.mjs --batch 200  # 每批 200 层
node scripts/analyze-user-profile.mjs --dry-run    # 只组装提示词
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--dir` | `~/lin/messages` | 数据目录 |
| `--out` | `scripts/user-profile.md` | 画像输出 |
| `--facts` | `scripts/user-facts.jsonl` | 事实条目输出 |
| `--state` | `scripts/user-profile.state.json` | 进度文件(最后楼层+草稿) |
| `--batch` | `100` | 每批楼层数(前 100 层正好一批) |
| `--retry` | `2` | 格式错误/超时/网络失败的重试次数 |
| `--limit` | 全量 | 只处理前 N 层 |
| `--model` | `deepseek-v4-flash` | 模型名 |
| `--prompt` | `scripts/prompt-profile.txt` | 提示词文件 |
| `--max-tokens` | `32768` | 单次输出上限(思考链+正文共用;模型上限 384K) |
| `--timeout-ms` | `300000` | 单次调用超时(超时会带原因报错并重试,而非直接 FATAL) |
| `--thinking` | 不传=思考模式 | `--thinking disabled` 关思考省输出预算(合并任务不建议) |

**注意**:串行链式,中断后需重跑(无断点续跑);某批重试耗尽会终止并提示。

> 精简版 `user-profile.compact.md` 由人工从完整版精简(约 1/4 长度):合并重复条目、删一次性琐事(具体某天吃了什么、每日流水),保留硬信息(数字/名称/稳定关系/长期规律/健康作息/态度偏好)。完整版是事实底档,精简版用于酒馆每次请求注入(控 token);画像更新后可对照完整版重新精简。

## 常见操作

```bash
# 填密钥(一次性)
# 编辑 .env:deepseek=sk-真实密钥

# 试跑 → 检查 → 全量
node scripts/analyze-user.mjs --limit 60
node scripts/analyze-user.mjs

# 某段输出不满意,单独重跑
node scripts/analyze-user.mjs --floors 90-120

# 失败清单
cat scripts/user-input-index.errors.jsonl

# 改提示词后重跑(改动只对新跑的楼层生效,旧楼层用 --floors 补)
node scripts/analyze-user.mjs --force
```

## 说明

- 两个脚本均零依赖(仅 Node 内置),强制 JSON 输出(`response_format: json_object`)
- 代码只负责:数据读写、切批、调模型、**校验格式**、重试、写文件;分析与结论全部由模型产出
- `.env` 含密钥,**勿提交 git**
