---
name: vibepin-annotations
description: "本项目的页面注记（vibepin）闭环：当用户说「看下注记 / 有注记 / vibepin」「我在页面上标了一个元素」，或你在本仓库开工需要挂页面注记监听，或 `.vibepin/inbox.jsonl` 里出现了新行时用它——含 daemon 的确认与启动、watch→claim 的确切命令（会话定向 `--queue`/`--session` 双队列监听）与不可颠倒的顺序、投递头（批号/总数/逐条 digest/`## 未结清` 块）怎么读、逐条 `vibepin ack`（`--note` 写 `file:line`）与收尾 `vibepin report`（欠债行 `!`、退出码 3）、`.vibepin/batches/` 账本、`GET /sessions` 会话表、注记载荷字段表（哪些字段可信/哪些不稳定）、按 source/component/chain/container/selector 的定位顺序与改动清单，以及「欠债不挡投递（v4）」「新增字段必须同步 daemon 落盘白名单」这两条坑。仅适用于已接入 vibepin 的本项目。"
---

<!-- vibepin:batch-ledger-v4 -->

# vibepin 页面注记（本项目接入件）

> 上游细节：`{{VIBEPIN_DIR}}/docs/omp-integration.md`（配置/排障全表）、`{{VIBEPIN_DIR}}/adapters/omp.md`（omp 侧 transport 与陷阱）。本 skill 是**可直接执行**的浓缩版。

## 0. 本项目已定死的接线

| 项 | 值 |
|---|---|
| 留言本（inbox） | `{{PROJECT_DIR}}/.vibepin/inbox.jsonl` |
| 项目级配置 | `{{PROJECT_DIR}}/.vibepin/config.json`（`agent: "omp"`、`inbox: ".vibepin/inbox.jsonl"`、`root: "."`、`port: 0`） |
| 已认领归档 | `{{PROJECT_DIR}}/.vibepin/processed.jsonl`（audit trail，**不是**队列） |
| 本会话队列（v2） | `{{PROJECT_DIR}}/.vibepin/sessions/<sid>.jsonl`——**只放发给本会话的注记**；广播仍走共享 inbox，两条都要 listen |
| 会话租约（v2） | `{{PROJECT_DIR}}/.vibepin/sessions/<sid>.json`——`watch.js` 在 park 期间每 ~20s 刷它的 mtime 当心跳；**判活只影响面板展示，绝不作为投递资格** |
| 认领/路由审计（v2） | `{{PROJECT_DIR}}/.vibepin/claims.jsonl` / `routed.jsonl`（append-only，只记元数据、无正文；**没有任何 watcher 监听它们**） |
| 批账本（v3） | `{{PROJECT_DIR}}/.vibepin/batches/<批号>.json`——**一次 claim 一个账本**，逐条状态（`open`/`done`/`wontfix`/`blocked`/`deferred`/`stale`）的唯一真相；只增不减，**已在 `.gitignore` 覆盖内**（`.vibepin/*`），不入库 |
| 账本命令 | `vibepin ack`（**唯一**能改条目状态）/ `vibepin report`（给用户看的对比表；有 `open`/`stale` 行时退出码 3）/ `vibepin batches`（批列表 + 未结清数）/ `vibepin show`（重打某批、或某条原始载荷） |
| daemon | `127.0.0.1:7331`（`config.json` 里 `port: 0` = 7331→7370 取第一个空闲） |
| vibepin 本体 | `{{VIBEPIN_DIR}}`（由 `vibepin init --agent omp` 写死；换 checkout 后重跑 init，或改本文件里的路径） |

覆盖优先级：**CLI 参数 / 环境变量 > `config.json` > 内置默认**。运行 daemon 时 **cwd = 项目根**，它才会读到 `.vibepin/config.json`。

## 1. 确认 daemon（没有就用受管进程起）

```bash
# 端口以 .vibepin/config.json 的 port 为准;0 = 7331–7370 里第一个空闲(以启动横幅为准,可能不是 7331)
curl -s http://127.0.0.1:<端口>/health
```

必须看到 `inbox` 指向本仓库（**这是"注记没被投到别的项目"的唯一依据**）：

```json
{"ok":true,"inbox":"{{PROJECT_DIR}}/.vibepin/inbox.jsonl","pending":0,"port":7331,"projectRoot":"{{PROJECT_DIR}}","sessions":1,"pendingTotal":0}
```

- `pending` 是**共享 inbox** 的条数（语义与今天一致）；`sessions` 是本项目会话数，`pendingTotal` = 共享 inbox + 所有会话队列的未认领条数——多会话下只看 `pending` 会**系统性少报**。
- 看会话表：`curl -s http://127.0.0.1:<端口>/sessions` → `{"sessions":[{"sessionId":"omp-2f9c1a","agent":"omp","label":"…","lastSeenAt":12,"pending":2,"mode":"file"}]}`。`lastSeenAt` 是**相对秒**（越大越旧；`>900` 只代表"最后活动 15 分钟前"，**不代表不能投**）。该响应**不含** `cwd`/`pid`/绝对路径（daemon 的 CORS 是 `*`，任何本地页面都读得到，所以字段是最小化的）。

没有 daemon（curl 失败 / 面板 console 报 `no daemon found … 7331-7370`）时，用**受管进程**起，不要裸 `&`：

```bash
# cwd = {{PROJECT_DIR}}，让它读 .vibepin/config.json
node {{VIBEPIN_DIR}}/daemon/daemon.js
# 需要显式覆盖时（CLI 优先于 config.json）
node {{VIBEPIN_DIR}}/daemon/daemon.js --port 7331 \
  --inbox {{PROJECT_DIR}}/.vibepin/inbox.jsonl --root {{PROJECT_DIR}}
```

omp 里用 `hub op:"start"`：`name:"vibepin"`、`application:"node"`、`args:["{{VIBEPIN_DIR}}/daemon/daemon.js"]`、`cwd:"{{PROJECT_DIR}}"`、`ready:{log:"\\[vibepin\\] daemon\\s+http://", timeout:30}`。**`ready` 只断言日志**（`port:0` 时端口可能不是 7331，别把它写进 `ready.port`）；实际端口从横幅读。用完 `hub op:"stop"`。

- 启动横幅给出真相：`[vibepin] daemon http://127.0.0.1:7331` / `inbox <abs>` / `root <abs>`。
- 端口已被**同一个** inbox 的 daemon 占用 → `daemon already running … reusing it`，直接复用（exit 0）。
- 端口被**别的项目**占用 → `FATAL … already serves a different project`（打印两个 inbox）并**拒绝启动**，这是故意的；换端口或由 dev server 的 Vite 插件自行顺延。
- 畸形 `config.json` 必须报错退出，**不要**当默认值用（静默回退=错投）。

## 2. 闭环：park → wake → claim → 改 → **逐条 ack** → **report** → 再 park

挂**一个后台作业**，把 watch 和 claim 串起来（等待在 shell 进程里，**空闲 0 token**；omp 里 `async: true` + `timeout: 0`，否则默认死线会杀掉 park）。v2 起同时监听**本会话队列**与**共享 inbox**，并用 `--session` 登记本会话身份：

```bash
# <sid>：本会话的短 id，形如 omp-2f9c1a（^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$）。
# 定了就一直复用（每轮 re-arm 用同一个）——每轮换新 id 会让面板上出现一堆孤儿会话，用户也没法定向。
node {{VIBEPIN_DIR}}/daemon/watch.js --inbox {{PROJECT_DIR}}/.vibepin/inbox.jsonl --queue {{PROJECT_DIR}}/.vibepin/sessions/<sid>.jsonl --session <sid> && node {{VIBEPIN_DIR}}/daemon/claim.js --inbox {{PROJECT_DIR}}/.vibepin/inbox.jsonl --queue {{PROJECT_DIR}}/.vibepin/sessions/<sid>.jsonl --session <sid>
```

作业退出即唤醒本会话，其输出 = **投递头（指令层）**——v4.1 起默认**不再内联完整 JSON**（整段 ≤3000 字符，不会再被消费端 4000 字符上限截断）：

```
[vibepin] watching {{PROJECT_DIR}}/.vibepin/inbox.jsonl (from 0 bytes) …
[vibepin] watching {{PROJECT_DIR}}/.vibepin/sessions/<sid>.jsonl (0 pending) …
[vibepin] session <sid> (lease {{PROJECT_DIR}}/.vibepin/sessions/<sid>.json) …
[vibepin] wake: <哪个文件变了 + 变化前后的 {size,mtime,ino} 签名>
[vibepin] 批 b-20260919-153012-7f3a · 3 条 · 2 个页面 · 会话 <sid>
[vibepin] 来源 queue 2 · inbox 1 · recovered 0 · 写入批 2 个（w-20260919-152955-1a2b×2 · 无批号×1）
[vibepin] 账本 {{PROJECT_DIR}}/.vibepin/batches/b-20260919-153012-7f3a.json
[vibepin] 页面 /resume-parse ×2 · /settings ×1
[vibepin] 协议 ①逐条处理 ②每条 vibepin ack --batch b-20260919-153012-7f3a --seq <n> --status done --note "<file:line>" ③收尾 vibepin report --batch b-20260919-153012-7f3a
[vibepin] 载荷 本批只投递"指令层"（页面 · 组件 · source:line · 原话）。某条的完整证据（selector/html/styles/rect/chain）按需取：
[vibepin]   vibepin show --batch b-20260919-153012-7f3a --seq <n> --evidence   # 该条完整记录（= processed.jsonl:<行号>）
[vibepin]   vibepin show --batch b-20260919-153012-7f3a --json                 # 整批账本
1. /resume-parse · <ResumeUpload> Upload.vue:120 — 按钮太窄，点不到  [e:412/w:1a2b]
2. /resume-parse · FilterBar.vue:44 — 这块整体要和上面那条一样窄  [e:413/w:1a2b]
3. /settings · div.el-dialog__header — 弹窗标题字号偏小  [e:414/-]
```

（`watching …` 每个被 watch 的文件一行；少了第二行 = 没带 `--queue`，少了第三行 = sid 没解析出来。有更早批次的未结清项时，`## 未结清` 块插在载荷提示之后、digest 之前；没有就整块不出现。头之后**没有** JSON——载荷在账本里，按需取。）

- **默认就是指令层（v4.1）**：头（5 行）+ 载荷提示（3 行）+ digest，整段 **≤3000 字符**（`DELIVERY_CHAR_MAX`；digest 行目标 ≤120 字符、最多 25 行，超出打 `… 其余 N 条见 vibepin show --batch <批号>`，**账本仍完整**）——不会再被截断。digest/债行的**定位是压缩形**（`Upload.vue:120`；组件名与文件主名相同只留文件），但要保原话：原话不会被压到 40 字符以下（不足 40 则全留）。`--full` = 头 + digest + 完整 JSON（调试用，= v4.1 前的默认形态）；`--json` = 只打 JSON（机器面，逐字等于协议前）。
- `[e:412]` = 该条在 `processed.jsonl` 的**行号指针**（1-based、append-only）；`w:1a2b` = 写入批短号，`-` = 老记录无批号。**需要精确证据（selector/html/styles/rect/chain/container/elements）时才取回**：`vibepin show --batch <批号> --seq <n> --evidence`（该行逐字，= `processed.jsonl:<行号>`）；整批账本 `vibepin show --batch <批号> --json`。默认头够定位时**不要**取整批。
- 账本永远是完整的（stdout 只是视图）：`vibepin show --batch <批号>`（重打 digest + 状态）、`vibepin show --batch <批号> --json`（账本原文）。

参数：`--inbox` = 共享 inbox；`--queue` = 本会话队列；`--session` = 本会话 id（写租约、`claim` 时记 `claims.jsonl`）。三者都可省略：**不传 `--queue` 就逐字退回旧行为**（只收广播、收不到定向注记）。`claim` 另有 `--ledger`（无会话也建账本）、`--full`（头 + digest + 完整 JSON，调试用；`--brief` 在 v4.1 已删，给了会报错）、`--json`（只打 JSON）、`--recover`（只恢复中断的认领）与 `--open-ttl <ms>`（**报表**里 open→stale 的展示阈值，默认 8h；**不影响投递**，见 §2.6）。

- `watch.js` 对每个被 watch 的文件各持一份 **`{size, mtimeMs, ino}` 三元组基线**：**任一不同即唤醒**（覆盖排空、变小、被替换、rename 换 inode）；挂载时若某文件**已有未认领行 → 立刻退出**，把积压直接交给 `claim`，不 park。
- `claim.js` 对队列与共享 inbox **各自独立** rename（`<file>.claiming`）→ 归档到 **`{{PROJECT_DIR}}/.vibepin/processed.jsonl`**（归档目录恒取**共享 inbox** 的 dirname）→ 合并输出；某文件 `ENOENT` 只是"这个文件没东西"，另一个照常排空。崩溃遗留的 `.claiming` 会在下次 claim 前**先恢复归档**并打一行警告。
- **顺序仍不可颠倒**：`park → wake → claim → 改 → 逐条 ack → report → park`。先 re-arm 再 claim，基线会落在"即将被删除的字节"上；wake 后不 claim 就 re-arm，旧字节会被当成新注记再送一遍。（v2 的多信号基线让踩错**不再永久致盲**，但顺序仍是纪律。）
- **一个队列只挂一个 watcher**；共享 inbox 的广播仍是"先 claim 者得"（未定向注记在多会话下可能被别的会话先取走——**要确定给谁就定向**，见 §2.5）。
- 可选安全网：`ANNOTATE_WATCH_TIMEOUT=600000`（10 分钟后 exit 0 并提示 `(re-arm)`，不会永久 park）。
- **每轮收尾顺手 `claim` 一次**：接住「没挂监听时」发来的注记（注记不会丢——安全失败；只是没人唤醒你）。

## 2.5 会话定向（v2）：这条注记给谁

- **谁决定**：面板（overlay）。服务端**不猜**——有显式目标就写目标队列，没有就写共享 inbox；判活**不参与**投递。
- **本会话怎么被选中**：面板的会话表来自 `GET /sessions`，也就是 `.vibepin/sessions/*.json` 租约文件。所以**只有跑过带 `--session` 的 v2 命令的会话**会出现在面板里；旧命令（只带 `--inbox`）既不登记、也收不到定向注记。
- **定向注记不做副本**：只写目标队列；共享 inbox 与 `processed.jsonl` 里都没有影子条目（副本会串台 + 白唤醒项目内每个会话）。留痕只在无 watcher 监听的 `routed.jsonl`。
- **降级只有一个条件**：目标 `<sid>.json` 租约记录**不存在**（会话退出/`sessions/` 被清）→ 注记改写共享 inbox，响应 `routed:"broadcast", degraded:true`，`routed.jsonl` 留痕。「很久没心跳」**不降级**（stale 只让面板显示"最后活动 N 分钟前"）。
- **未迁移的老命令**：只收广播。发给它的定向注记会**堆在 `sessions/<sid>.jsonl` 里**，面板的 `pending` 看得见但没人被唤醒。恢复通道：

  ```bash
  npx vibepin sessions                                        # 列会话：sid · agent · label · 最后活动 · pending
  npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl      # 手工排空某会话队列
  ```

## 2.6 账本（`batches/`）：逐条 ack + 收尾 report

投递头字段（`n.` 就是 ack 的 `--seq`）：

| 头里的位置 | 含义 |
|---|---|
| `批 b-<日期>-<时间>-<hex>` | **认领批号**（**一次 claim = 一批**）；账本文件名 = 它 |
| `N 条 · M 个页面 · 会话 <sid>` | 本批总数（= `report` 的行数）/ 跨页数 / 归属会话 |
| `来源 queue … · inbox … · recovered … · 写入批 …` | 定向队列 / 共享 inbox / 崩溃恢复 的条数；`w-…` = daemon 烙在**记录**上的**写入批**号（一次 POST = 一批），`无批号` = 批协议之前的老记录 |
| `账本 <路径>` | `.vibepin/batches/<批号>.json`（已 gitignore） |
| `n. 页面 · <定位> — 原话 [e:行/w:短号]` | 逐条：`n` = ack 的 seq；`<定位>` 是**压缩后**的首选定位（路径只留 basename：`src/…/Upload.vue:120` → `Upload.vue:120`；组件名与文件主名相同则只留文件：`<Upload> Upload.vue:12` → `Upload.vue:12`）；原话优先——每行原话不少于 40 字符（不足则全留），被压掉的完整路径/selector 用 `--evidence` 取回；`[e:行]` = `processed.jsonl` 行号 |
| `## 未结清` 块 | **上一次认领遗留**、还没结清的项：`open` = 还没交代；`blocked`/`deferred` = 已交代但**不重复投递**。不是本批要改的东西，但块里给了每条的 `vibepin ack` 命令，顺手结清。**没有这个块 = 没有欠债** |

逐条 **ack**（`ack` 是账本状态的**唯一**写入口，改完一条就记一条）：

```bash
vibepin ack --batch <批号> --seq <n> --note "改了什么（file:line）"                   # 默认 --status done
vibepin ack --batch <批号> --seq <n> --status wontfix --reason "为什么不改"
vibepin ack --batch <批号> --seq <n> --status blocked --reason "外部原因"
vibepin ack --batch <批号> --seq <n> --status deferred --reason "以后做"
vibepin ack --batch <批号> --seq <n> --status open --note "为什么重开"               # 重开已结的条目
vibepin ack --batch <批号> --all-done --note "整批说明"                             # 该批所有 open 一次标 done
```

- `--note` **写 `file:line`**（例 `min-width 96px（frontend/src/views/resume/Upload.vue:131）`）：它原样进 `report` 的「证据」列，是用户核对改动的唯一凭据。`done` 必须带 `--note`；`wontfix`/`blocked`/`deferred` 必须带 `--reason`。
- 幂等：同一条重复 `--status done` → `0 项更新`、退出码 0，不重复写历史。错 seq / 缺 `--note`/`--reason` → 退出码 1，账本一字不改。
- **`--seq` 是投递头里的 `n.`**（认领批 1..N），**不是**记录 JSON 里的 `batch.seq`（那是写入批内部序号；一次 claim 可以合并多个写入批）。拿不准用 `vibepin show --batch <批号>`（逐条带状态）或 `vibepin batches`。

收尾 **report**（给用户看的对比表）：

```bash
vibepin report --batch <批号>          # 行数 == 本批总数；未结清 seq 带 !；有 open/stale 时退出码 3
vibepin report --all                   # 每批一张表
vibepin report --batch <批号> --json   # {batch,total,rollup,rows}，rows.length === total
```

- 退出码 `0` = 全表无 `open`/`stale`；`3` = 还有 `open`/`stale` 行；`1` = 未知批/账本读不动。`done`/`wontfix`/`blocked`/`deferred` **不**改退出码（它们是有交代的）。
- `batches`：`vibepin batches [--open] [--session <sid>] [--json]`（按时间倒序；`open` 列 = **未过 TTL** 的 open 计数；页脚给未结清批数与最新批号）。
- `show`：`vibepin show --batch <批号> [--seq <n[,n]>] [--json] [--evidence] [--group] [--record <行号>]`；`--evidence` 逐字打 `processed.jsonl` 那一行（= `[e:<行号>]` 指针的目标），`--json`（无 `--seq`）打账本原文。digest 的 `[e:…]` 指针恒在。
- `--rebuild`（`report`/`show`/`ack`）：账本文件丢了也能从 `claims.jsonl` + `processed.jsonl` 重建；重建的条目**全记 `stale`**（不猜 open、也不假装 done），stdout 打一行警告。`show --batch <批号>` 发现账本缺失时**自动**重建；`report`/`ack` 不自动（exit 1 并在提示里给出 `--rebuild` 命令），这是故意的——只读命令不偷偷写盘。
- **欠债不挡投递（v4）**：`watch`/`claim` **永不**因"有未结清"而拒绝投递（`watch` 恒 exit 0）。欠债只是**可见**：`report` 的 `!` + 退出码 3、`batches` 的未结清数、`doctor` 的 `批账本` 警告。它不是门禁，也不替你做纪律——纪律是"改完一条就 ack 一条"。

## 3. 注记载荷字段（agent 可依赖的契约）

一条注记 = JSONL 一行，来自 `core/annotate.js` 采集 + `daemon/daemon.js` 落盘：

| 字段 | 含义 | 稳定性 |
|---|---|---|
| `note` | 用户原话 | — |
| `url` | 采集时页面 URL | — |
| `kind` | `element` / `region` | — |
| `component` / `source` | 最内层组件名 + 源码位置。装了 source 插件时 `source` = **项目相对**路径 + `行:列`（`sourcePos` 非空）；没装则走运行时通道：`.vue`/`.jsx` **绝对路径**、无行号。相对路径用 `projectRoot` 拼成绝对 | 稳定（**定位首选**） |
| `sourcePos` | `{ line, column }`（与 `source` 尾部 `:line:col` 同源）；**仅属性通道非空** | 装了插件时非空 |
| `chain` | 组件层级链，**最内层→最外层**（如 `<AISettingsModelListPanel> <tab-pane> <ElTabs> <PageContainer>`）；`source: null` = 依赖内的组件（组件库内部） | 稳定 |
| `selector` | CSS 路径；**已修**：不再优先采用自动 id（`#el-id-*`、`:r0:`、`rc-*` 等被跳过），并自证 `document.querySelector(sel) === 元素` | 较稳定（改模板后仍可能失效） |
| `container` | **被标注元素的父容器**：selector + rect + `display/flexDirection/gap/justify/align` + `childCount` | 稳定 |
| `viewport` | `{ w, h, dpr, theme }`（采集时窗口/主题） | — |
| `rect` / `pin` | 元素视口坐标 / 页面锚点坐标 | — |
| `html` | `outerHTML`（截断 4000 字符） | — |
| `styles` | 计算样式快照 | — |
| `elements` | **区域标注**（`kind: "region"`）采样到的元素数组（≤8，含 selector/component/source）；元素标注为 `null` | — |
| `screenshot` | 仅 Electron 适配器提供 `__vibepinCapture` 时才有；浏览器里**恒为 `null`** | — |
| `id` / `ts` | 注记 id / 时间戳 | — |
| `inbox` / `projectRoot` / `daemonPort` | **由 daemon 盖章**（不信任页面），用于自证来源 | **可信** |

两条必须记住的性质：

- **`source` 的位置信息取决于项目装了哪条通道**（Vue 项目：`vite-plugin-vue-inspector`）：
  - 装了 **6.x** → 走 **DOM 属性通道**（`data-v-inspector`）→ `source` 形如 `src/components/Foo.vue:9:9`（**项目相对** + `行:列`）、`sourcePos` = `{line, column}`。**版本锁：必须 6.x** —— 7.x 会把 `data-v-inspector` 从 DOM 删掉、只留非枚举的 `__v_inspector`，而组件库渲染的内部节点自身 vnode 没有该属性 → **行号直接消失**；升级前必须复测 `sourcePos` 非空。
  - 没装该插件 → 走 Vue 运行时 `__file` 通道：只有 `.vue` **绝对路径**、无行号、`sourcePos` 为 `null` —— 这时靠 `component` + `chain` 定位，**不要**假装有行号。
  - React 项目 → fiber 的 `_debugSource`（开发构建）给出 `文件:行`。
- **`selector` 已不再优先采用自动 id**：`#el-id-*`、`:r0:`、`rc-*` 等被跳过，返回值自证 `document.querySelector(sel) === 元素`（必要时补 `body >` 前缀，避免命中同形的"孪生"节点）。但仍然**脆弱**：改模板/结构后可能失效 —— 用前先自证，失效就退回 `source` / `component` + `chain` / `container`。

**动手前先自证来源**：`item.inbox` / `item.projectRoot` / `item.daemonPort` 必须等于本项目的值，否则**不要改文件**（注记来自别的项目/别的 daemon）。

## 4. 定位与改动清单

按这个顺序定位（前者能定住就不要往下走）：

1. **`source`(+`sourcePos`)** —— 源码位置：**项目相对 + `行:列`**（装了 source 插件时）或**绝对路径**；前者用 `projectRoot` 拼绝对后直接开文件，并跳到那一行。
2. **`component` + `chain`** —— `chain` 是**最内层→最外层**的组件层级，用它在文件里找模板位置，并判断"该改的是这个组件还是它的容器/外层壳"（`chain` 里出现组件库内部节点即依赖内部，别去改依赖）。
3. **`container`** —— 父盒子的 selector + rect + `display/flexDirection/gap/justify/align` + `childCount`：布局类注记（间距、对齐、换行、子元素个数）靠它落点。
4. **`selector`** —— 最后手段；先用 `document.querySelector(sel) === 元素` 自证，失效就回到 1–3。
5. `kind: "region"` 的注记 → 用 `rect` + `elements`（框内采样到的组件），逐项按上面 1–2 步定位。

改动时（本项目口径）：先读该项目的 UI/代码约定（若有 `skill://`、`AGENTS.md`、规范文档，以它为准）；按项目已有模式改，**不要引入第二套写法**；模板文案走项目的 i18n/常量；优先复用项目自有的公共组件与依赖官方 props（写 props 前查依赖文档）；不要手搓样式。改完**复验**（定向：类型检查 / 相关页面刷新看效果，**不要**全量构建），然后**回去挂监听**。

## 5. 四个坑

- **新增字段必须同时加进 daemon 落盘白名单**：白名单在 `{{VIBEPIN_DIR}}/daemon/daemon.js` 里构造落盘 item 的那段 `JSON.stringify({ id, ts, url, note, … })`（契约引用写作 `daemon/daemon.js:116-135`；**行号会漂，认那段代码不认行号**）。落盘是**白名单**：只改 `core/annotate.js` 不会被投递。而且**只看浮层的 `window.__vibepin.pending` 会漏掉这类问题**（那是发送前载荷，不是落盘结果）——必须走「真发一条 → 读 inbox」验证。
- **overlay 每次从磁盘读**（`Cache-Control: no-store`）：改 `{{VIBEPIN_DIR}}/core/annotate.js` 后**刷新页面**即生效，不需要重启 daemon。
- **别拿 MCP 连接 id 当会话**：MCP 的 `mcp-session-id` 是**连接级、随机、内存态**（daemon 重启/客户端重连就变），把它当路由目标会**静默失效**。MCP 侧的会话身份只能来自工具参数 `sessionId`，且租约由 daemon 服务端 upsert（`mode:"mcp"`）——客户端不写文件，也不需要写。
- **ack 的 `--seq` 不是记录里的 `batch.seq`**：记录上的 `batch:{id,seq,total}` 是**写入批**（一次 POST = 一批）的内部编号；`ack`/`report`/`show` 用的是**认领批**（一次 claim，可能合并多个写入批）的 `1..N`。用错会 ack 到别的条目 —— 一律以投递头 / `vibepin show --batch <批号>` 打印的 `n.` 为准。

手动/无扩展验证路径（headless 标签页没有扩展）：把 `http://127.0.0.1:<端口>/annotate.js` 作为 `<script>` 注入页面（= 书签(let)路径），或直接开 `http://127.0.0.1:<端口>/` 的 demo 页。

## 6. 收尾自检

- [ ] 动手前 `/health` 的 `inbox` == 本仓库 `.vibepin/inbox.jsonl`？注记的 `projectRoot` == `{{PROJECT_DIR}}`？
- [ ] 本会话的 watcher 带上了 `--queue` + `--session`（否则只收广播、收不到定向注记）？`GET /sessions` 里能看到本会话的 `<sid>`？
- [ ] 定位用的是 `source` / `component`+`chain` / `container`，而不是过期的 `#el-id-*`？
- [ ] 本批注记是否**逐条**落实（改代码 → 复验），并且**逐条 `vibepin ack`**（`--note` 带 `file:line`），而不是只回一句"看到了"？
- [ ] 投递头里的 `## 未结清` 块（上一批遗留）是否顺手结清了？
- [ ] 收尾是否跑了 `vibepin report --batch <批号>`、退出码已到 0（或把剩余 `open`/`stale` 行明确交代给用户）？
- [ ] 改完是否**重新挂了同一个后台作业**（park → wake → claim → 改 → ack → report → park），且用的是同一个 `<sid>`？
- [ ] 本轮收尾是否顺手 `claim` 了一次（接住没挂监听时的注记）？
