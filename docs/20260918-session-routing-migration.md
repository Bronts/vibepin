# 会话路由 v2：迁移与升级清单（2026-09-18）

> 配套规格：[`docs/20260918-session-routing-design.md`](20260918-session-routing-design.md)（v2 定稿）。
> 本文只回答两件事：**已接入的项目怎么升级**、**不升级会怎样**。
> 适用对象：用 `vibepin init` 接入过的项目（例：`D:/Develops/talents-py`）、以及所有消费 vibepin 模板的 agent 侧文件。

> 🔴 **前置（先读）：`npx vibepin …` 只在 vibepin 可解析时能用。**
> 本页命令统一写作 `npx vibepin …`，它要求**本项目**满足下面任意一条：
> 1. `<proj>/node_modules/vibepin/` 存在（`npm i -D vibepin`，devDependency）；或
> 2. 全局装过（`npm i -g vibepin`）。
>
> **没有 `package.json`／没有 `node_modules/vibepin`／也没全局装**的项目（本文的实例 `D:/Develops/talents-py` 正是这种），`npx` 会**去 registry 下载**一份再执行：离线或被沙箱挡住时直接失败，网络通时也可能装出一个不是你本地 checkout 的版本。这类项目请**一律改用 checkout 形式**——本页每一条 `npx vibepin <cmd>` 都可以这样替换：
>
> | 本页的 `npx` 形式 | checkout 形式（`<vibepin-dir>` = vibepin 仓库，例 `D:/Develops/vibepin`） |
> |---|---|
> | `npx vibepin doctor` | `node <vibepin-dir>/bin/vibepin.js doctor --root <proj>` |
> | `npx vibepin sessions [--json]` | `node <vibepin-dir>/bin/vibepin.js sessions --root <proj> [--json]` |
> | `npx vibepin init --agent omp …` | `node <vibepin-dir>/bin/vibepin.js init --agent omp --root <proj> …` |
> | `npx vibepin watch …` / `npx vibepin claim …` | `node <vibepin-dir>/daemon/watch.js …` / `node <vibepin-dir>/daemon/claim.js …`（见 §3.1；**必须带 `--inbox <proj>/.vibepin/inbox.jsonl`**，这两个脚本不认 `--root`，见 §9） |
>
> **恢复通道同样适用**：§6/§7 的 `npx vibepin sessions` / `npx vibepin claim --queue …` 恰好是"没有 `npx` 时最需要"的命令——那里保留 npx 写法只为行文统一，替代形式见上表。`--root` 只有 `init --agent omp` / `sessions` / `doctor` 三个命令认（`bin/vibepin.js --help`）。

---

## 0. 一句话

v2 把「一个项目一个留言本，谁先 `claim` 谁得」改成「**每会话一个私有队列 + 共享广播**」：

- 注记带**显式目标**（`targetSession`）且该目标有租约 → 只落 `.vibepin/sessions/<sid>.jsonl`；
- 注记**不带目标**（老 overlay / 老扩展） → 落 `.vibepin/inbox.jsonl`，**逐字等于今天**。

升级只需要改 **agent 侧那条挂载命令**：让 watcher 同时 watch 自己的队列和共享 inbox，并用 `--session <sid>` 表明自己是谁。

**不用改**：`.vibepin/config.json`（`agent` 仍是面板显示名）、`.gitignore`、MCP 配置（`sessionId` 只是可选新参数）。

---

## 1. 判定：我迁移了没有？

判据是 AGENTS.md 注记节 / omp skill 里有没有 v2 版本标记 `<!-- vibepin:session-routing-v2 -->`：

```bash
npx vibepin doctor            # 有这条就先用它：一键列出会话目录、死 watcher、旧命令、daemon 版本
```

> `npx vibepin` 不可解析时（见文首的前置表）用 checkout 形式：`node <vibepin-dir>/bin/vibepin.js doctor --root <proj>`。

`doctor` 不可用时，用 node 直接看标记（零依赖、跨平台）：

```bash
node -e "const fs=require('fs');for(const f of ['AGENTS.md','.omp/skills/vibepin-annotations/SKILL.md']){let t='';try{t=fs.readFileSync(f,'utf8')}catch{console.log(f+': (missing)');continue}console.log(f+': '+(t.includes('vibepin:session-routing-v2')?'v2 (已迁移)':'legacy (旧协议，需迁移)'))}"
```

旧协议的特征（肉眼可辨）：挂载命令里 `watch.js` / `claim.js` **只带 `--inbox`**，同一条命令里没有 `--queue`、没有 `--session`。

---

## 2. 逐文件迁移表

| 文件 | 谁负责 | 动作 | 命令 |
|---|---|---|---|
| `<proj>/AGENTS.md` 的 `## 注记（vibepin）` 节 | 每个已接入项目 | 换成 §3 的 v2 命令块（**重跑 `init` 不会自动改**） | 手工替换，或删掉该节后 `npx vibepin init --agent omp --upgrade` |
| `<proj>/.omp/skills/vibepin-annotations/SKILL.md` | 每个已接入项目 | 同上（含新命令、租约、双文件 claim 顺序） | 同上（同批重写） |
| `~/.claude/commands/vpin.md` | vibepin 发布方 | 重跑 `init` **会覆盖**该文件 | `npx vibepin init` |
| `~/.codex/prompts/vpin.md` | vibepin 发布方 | 重跑 `init --agent codex` **会覆盖** | `npx vibepin init --agent codex` |
| `<proj>/.cursor/commands/vpin.md` | 项目（Cursor 命令是项目级的） | 在项目根重跑 `init --agent cursor` **会覆盖** | `npx vibepin init --agent cursor` |
| Antigravity | 发布方 | **没有可迁移的命令文件**：它**只有 MCP 一条唤醒路径**（没有客户端进程可以 park watcher，租约由 daemon 服务端 upsert），升级 = 调 `watch_annotations` / `list_annotations` / `resolve_annotation` 时带上 `sessionId` | 无需重跑 `init`（`init --agent antigravity` 只打印 MCP 配置片段）；见 [adapters/antigravity.md](../adapters/antigravity.md) |
| MCP 配置（`~/.omp/mcp.json`、`.cursor/mcp.json`、`~/.codex/config.toml`、Antigravity 的 `mcpServers`） | — | **无需改**（`sessionId` 是可选新增参数；不带它就逐字等于今天） | — |
| `.vibepin/config.json` | — | **无需改**（`agent` 仍是显示名，不是路由依据） | — |
| `.gitignore` | — | **无需改**（`.vibepin/*` + `!.vibepin/config.json` 已覆盖 `sessions/`、`routed.jsonl`、`claims.jsonl`） | — |

> ⚠️ **`init` 的两种语义要分清（这是 v2 一并修正的文档矛盾）**：
> - `--agent omp` 分支**只报告、绝不重写**已有文件（`skip` / `exists — kept`）——所以**已接入项目永远需要人工迁移**，这正是本文存在的原因；
> - `--agent claude | codex | cursor` 分支是 `install()` 的 **`copyFileSync` 覆盖**——这三家**重跑即升级**。
> 旧版 README 把这句幂等承诺说成普适，与 `install()` 的实际行为不符；v2 起文档按上面两条分别陈述。

---

## 3. 改前 / 改后命令

### 3.1 文件路径（omp / Codex / Cursor / 手动）

**改前（旧协议，只收广播）**

```bash
node <vibepin>/daemon/watch.js --inbox <proj>/.vibepin/inbox.jsonl \
  && node <vibepin>/daemon/claim.js --inbox <proj>/.vibepin/inbox.jsonl
```

**改后（v2：私有队列 + 共享 inbox 双监听）**

```bash
node <vibepin>/daemon/watch.js --inbox <proj>/.vibepin/inbox.jsonl --queue <proj>/.vibepin/sessions/<sid>.jsonl --session <sid> && node <vibepin>/daemon/claim.js --inbox <proj>/.vibepin/inbox.jsonl --queue <proj>/.vibepin/sessions/<sid>.jsonl --session <sid>
```

用 devDependency 的写法 —— **claude / codex / cursor 的命令文件模板用的就是这条**（本仓库源文件：`.claude/commands/vpin.md`、`adapters/commands/vpin.codex.md`、`adapters/commands/vpin.cursor.md`；`init` 会把它们复制到 `~/.claude/commands/vpin.md`、`~/.codex/prompts/vpin.md`、`<proj>/.cursor/commands/vpin.md`）：

```bash
npx vibepin watch --queue .vibepin/sessions/<sid>.jsonl --session <sid> \
  && npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl --session <sid>
```

> **`--agent omp` 不是这条。** `init --agent omp` 写出的 `.omp/skills/vibepin-annotations/SKILL.md` 与 `AGENTS.md` 的 `## 注记（vibepin）` 节用的是**仓库 checkout 形式**（`node {{VIBEPIN_DIR}}/daemon/watch.js …`，`{{VIBEPIN_DIR}}` 取 `--vibepin-dir`，缺省 = 本仓库）——因为 omp 侧没有"vibepin 已装成依赖"这个前提（见文首前置表）。
> 前提再强调一次：上面这段 `npx` 形式**只在 vibepin 可解析时**（devDependency 或全局安装）能直接执行；否则用**上面那条 checkout 形式**（`node <vibepin>/daemon/watch.js … && node <vibepin>/daemon/claim.js …`，文首前置表也有对照）。

改对了的话，watcher 的头三行长这样（每个被监听的文件一行 + 一行会话信息）：

```
[vibepin] watching <proj>/.vibepin/inbox.jsonl (from 0 bytes) …
[vibepin] watching <proj>/.vibepin/sessions/omp-2f9c1a.jsonl (0 pending) …
[vibepin] session omp-2f9c1a (lease <proj>/.vibepin/sessions/omp-2f9c1a.json) …
```

- 没有第二行 = 你没带 `--queue`（或写错了路径）→ 只收广播。
- 没有第三行 = sid 没解析出来 → 定向注记不会认到你。
- 队列里已有未认领注记时，watcher 不 park，直接以 `wake: queue already has N pending` 退出，把积压交给 `claim`。
- 文件读不到（权限/沙箱）**不会**伪装成"还没有注记"：stderr 打印 `[vibepin] cannot stat <file>: <CODE>` 并以退出码 2 结束。
- 路径传成了**目录**（例如 `--inbox .vibepin`）会在动盘之前直接拒绝：`… (--inbox) is not a file — it is a directory; pass the inbox/queue path, e.g. <proj>/.vibepin/inbox.jsonl`，退出 1（不会把目录改名搬走）。

参数（与 `daemon/watch.js` / `daemon/claim.js` 实现一致）：

| 参数 | 语义 |
|---|---|
| `--inbox <path>` | **共享 inbox**（与今天同义；可省略 = `<cwd>/.vibepin/inbox.jsonl`，或用 `ANNOTATE_INBOX`） |
| `--queue <path>` | **本会话的队列**；缺省 ⇒ 只 watch 共享 inbox = **逐字等于今天**（老用法零回归，但也收不到定向注记）。也接受裸 `<sid>`（等价于 `<dirname(--inbox)>/sessions/<sid>.jsonl`）；文档统一写路径 |
| `--session <sid>` | 本会话的 id：写/刷新租约 `sessions/<sid>.json`；`claim` 时往 `claims.jsonl` 记一行。 |
| `--label <文本>` / `--agent <名字>`（**仅 `watch.js`**） | 只影响面板显示（`agent` 也可用 `VPIN_AGENT`，默认 `cli`）。`claim.js` 不认这两个参数（传了被忽略，不报错） |

**`<sid>` 的解析顺序（确定性的，没有"猜"）**：`--session` → `VPIN_SESSION_ID` → `--queue` 的 basename（去掉 `.jsonl`）。
不合 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$` 的值**直接退出 1、不写盘**。
本期**没有**自动铸新/租约继承：路径上的 sid 只来自上面三者 —— 所以**命令里必须带一个稳定的 `<sid>`**（推荐形状 `<agent>-<6位hex>`，例 `omp-2f9c1a`）。
同一个会话的每一轮 re-arm **必须复用同一个 `<sid>`**：面板按这个 id 列会话，每轮换新 id 会留下一堆孤儿条目，用户也挑不中目标。

> `--queue` 与 `--session` 都不给时，行为与旧版**逐字相同**：只收广播。这是有意的兼容承诺，不是 bug。
> 租约、队列、`claims.jsonl` 的目录**恒由 `dirname(--inbox)` 派生**（不跟着 `--queue` 走），所以 `--queue` 指到别处也不会把会话表写散。

### 3.2 MCP 路径

MCP 配置**不用改**。变化只在工具参数与语义上：

```text
list_annotations({ sessionId? })
watch_annotations({ timeoutMs?, sessionId? })
resolve_annotation({ ids, sessionId? })
```

| 情形 | 读 | 写（resolve） |
|---|---|---|
| **带 `sessionId`** | 该会话队列 **+** 共享 inbox（定向 + 广播） | 只 append `claims.jsonl`，不重写队列 |
| **不带 `sessionId`** | **仅**共享 inbox——**逐字等于今天** | 同今天语义（落到 append-only 的 `claims.jsonl`） |

🔴 **MCP 连接自带的 `mcp-session-id` 不是会话标识，也不能拿来当路由键**：它是连接级、`randomUUID()` 生成、存在 daemon 内存里、`onclose` 即删（`daemon/mcp.js`）——daemon 重启或客户端重连就变，绑它的路由目标会**静默失效**。
路由键只能来自**工具参数 `sessionId`**，且 MCP 会话的租约由 **daemon 服务端 upsert**（`mode:"mcp"`），客户端不需要写文件（Antigravity 路径没有客户端进程可写）。

---

## 4. 自动升级：`vibepin init --upgrade`

| 目标 | 行为 |
|---|---|
| `--agent omp` | 检测 `.omp/skills/vibepin-annotations/SKILL.md` 与 `AGENTS.md` 的 `## 注记（vibepin）` 节里是否含版本标记 `<!-- vibepin:session-routing-v2 -->`。缺标记 → **默认只报告**（列出目标路径 + "是旧协议，未自动升级"）；加 `--upgrade` 才重写这两处。`config.json` **仍只校验、不重写** |
| `--agent claude / codex / cursor` | 等价于重跑 `install()`（`copyFileSync` **覆盖**）。**绝对路径是结果行的一部分**：`✓ Codex: <verb> /vpin prompt → <dest>`（目标原本不存在 = `installed`；已存在被换掉 = `overwrote`）。只有在**同时带 `--upgrade` 且目标已存在**时，才会在结果行**之前**多打印一行 `  replacing <dest>`（`bin/vibepin.js` 的 `install()`）；**不带 `--upgrade` 时没有这一行**，也没有"先预告将被覆盖的绝对路径"这一步 |
| `--dry-run` | 输出完整计划，不写盘（对**所有** agent 都可用） |

> 标记是**字面量**，两条检查范围不同：`SKILL.md` 查整篇；`AGENTS.md` 只查 `## 注记（vibepin）` 节内部。
> 标记在 → `init` 报 "up to date"、`--upgrade` **不会**重写；标记不在 → 报 "旧协议" 并拒绝改写。

推荐流程（已接入项目，例如 talents-py）：

```bash
cd <proj>
npx vibepin init --agent omp --dry-run --upgrade    # 先看计划：哪两个文件是旧协议、会被写成什么
npx vibepin init --agent omp --upgrade              # 确认后执行（config.json 不动）
```

若你的 AGENTS.md 注记节被手改过、不想被模板覆盖，就按 §3.1 **手工替换命令块**（模板重写会把整节恢复成 bundled 版本）。

---

## 5. 诊断：`vibepin doctor`

四项检查，任一项异常都说明"协议不匹配"（`doctor` **只在真有缺陷时**退出码非 0，单纯"会话很久没动"不算缺陷）：

| # | 检查 | 异常含义 |
|---|---|---|
| ① | `.vibepin/sessions/` 是否存在 | 不存在 = 从没有会话写过租约（未迁移，或 watcher 没带 `--session`） |
| ② | 会话记录里的 `watcherPid` 是否还活着（`process.kill(pid, 0)`） | 死 pid = 陈旧记录；**只影响展示**，不影响投递（目标仍有记录 ⇒ 定向照投） |
| ③ | agent 侧文件里是否仍是旧命令（含 `claim.js --inbox` 而**没有** `--queue`） | 是 = 该 agent 只收得到广播，定向注记会在它自己的队列里堆积。该检查会把反斜杠续行的命令合成一条再判断，所以 §8.1 那种多行写法**不会**被误报 |
| ④ | daemon 可达且 `/health` 带 `sessions` 字段 | 没有该字段 = **混合版本**（新客户端 + 老 daemon）：带 `targetSession` 的请求会被老 daemon 当未知字段忽略 → 行为退化为广播。另外 `/health.inbox` 与本项目的 inbox 不一致也报 `✗`：说明页面连到的是**别的项目**的 daemon（§8.5 的前置缺口，与本设计无关但同样是"错投"） |

---

## 6. 🔴 未迁移项目的当天后果（release notes 必读）

- **定向注记不会唤醒老 watcher。** 老 watcher 只 watch 共享 `inbox.jsonl`；`sessions/<sid>.jsonl` 里的注记会**堆积**——`GET /sessions` 的 `pending` 会如实显示出来，但**没有任何通路自动叫醒 agent**（`claim.js` 只 rename 它被指到的那个文件）。
- **广播照旧工作。** 不带目标的注记 → 共享 inbox → 老循环照常被唤醒、照常认领。
- **面板不会骗你。** 这种情况下面板/扩展的会话列表会显示该会话的 `pending` 在涨、`lastSeenAt` 在变旧，toast 回执也会显示 `routed:"session"`（投递是成功的，问题在没人取）。
- **恢复通道**（与定向投递同批交付，缺了它"队列保留"就只是字节不丢、人找不回来）：

  ```bash
  npx vibepin sessions                                      # 列会话：sid · agent · label · 最后活动 · pending（--json 机器可读）
  npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl    # 手工排空某个会话队列（照常打印 JSON 数组）
  npx vibepin claim --recover                                # 只抢救崩溃遗留的 .claiming 批次，不排空在线队列
  ```

  > **`npx vibepin` 不可解析时**（本项目没有 `node_modules/vibepin`／没全局装——`npx` 会去 registry 装；见文首前置表），上面三条的等价 checkout 形式（在 `<proj>` 下跑，或显式给 `--inbox`）：
  > ```bash
  > node <vibepin-dir>/bin/vibepin.js sessions --root <proj> [--json]
  > node <vibepin-dir>/bin/vibepin.js claim --inbox <proj>/.vibepin/inbox.jsonl --queue <proj>/.vibepin/sessions/<sid>.jsonl --session <sid>
  > node <vibepin-dir>/daemon/claim.js --inbox <proj>/.vibepin/inbox.jsonl --queue <proj>/.vibepin/sessions/<sid>.jsonl --session <sid>
  > node <vibepin-dir>/bin/vibepin.js claim --inbox <proj>/.vibepin/inbox.jsonl --recover
  > ```
  > （最后两条分别是"手工排空某队列"与"`--recover`"；`claim` 不认 `--root`，所以用 `--inbox` 指项目。）

- **判定口径**：混合版本（新 daemon + 老客户端）与"未迁移项目"是同一个现象——**定向注记看得见、取不走**。

---

## 7. 迁移后自检

1. `npx vibepin doctor` → 四项全绿（或 ② 的"陈旧 pid"能解释）；`npx` 不可解析时用 `node <vibepin-dir>/bin/vibepin.js doctor --root <proj>`（§1）。
2. 挂上 v2 命令，`GET /health` 能看到 `sessions` ≥ 1；`GET /sessions` 里出现本会话的 `<sid>`，且响应里**没有** `cwd` / `pid` / 绝对路径。
3. 页面只有一个会话时，overlay 预填该 `<sid>`（去向行 `→ <sid>（唯一会话）`）；Send 后 toast 显示 `已发送 N 条 → <sid>`。
4. 换一个不带目标的发送（或老 overlay）→ toast 显示"广播"，且**两个** watcher 都被唤醒一次（唤醒是广播语义；但 `claim` 是 first-claim-wins ⇒ 只有先到者真的取走那条注记，后到者拿到 `[]`）。
5. 定向发给 A → 只有 A 醒来并认领；B 的 watcher 不动，B 的队列**不留副本**（共享 inbox 也没有）。这就是"不串台"的定义。

---

## 8. 回滚

v2 是**加法**：老命令（只带 `--inbox`）今天仍然有效，只是从此只收广播。
所以回滚 = 把 agent 侧命令换回 §3.1 的"改前"版本；`.vibepin/sessions/` 下已堆积的注记可用 §6 的恢复通道人工取回，不需要回退 daemon。
**不要**在回滚时删除 `sessions/`（那些队列里可能还有没被认领的注记）。

---

## 9. CLI 参数速查（本页引用的全部参数）

| 参数 / 命令 | 来源 |
|---|---|
| `watch.js --inbox <path>`、`claim.js --inbox <path>`、`ANNOTATE_WATCH_TIMEOUT` | 现状（`daemon/watch.js`、`daemon/claim.js`），v2 保持 |
| `--queue <path\|sid>`、`--session <sid>`、`VPIN_SESSION_ID`（watch 与 claim 同款） | 规格 §8.1 参数表 + 实现口径（`daemon/store.js` 的 `resolveSessionId`/`resolveQueue`：`--session` > `VPIN_SESSION_ID` > queue basename；**本期无自动铸新/租约继承**，所以命令里必须带稳定的 `<sid>`） |
| `--label <text>`、`--agent <name>`、`VPIN_AGENT`（**仅 `watch.js`**） | 实现口径（`daemon/watch.js`；`claim.js` 不认这两个参数） |
| `vibepin init [--agent claude\|codex\|cursor\|antigravity\|omp\|all]`、`--dry-run` | 现状（`bin/vibepin.js --help`） |
| `--root <dir>`（`init --agent omp` / `sessions` / `doctor`）、`--vibepin-dir <dir>`（`init --agent omp` 专用）、`--upgrade` | 现状（`bin/vibepin.js --help`） |
| `vibepin init --agent omp --upgrade` | 规格 §11.3 + `bin/vibepin.js`（`--upgrade` / `--dry-run` 的实际语义） |
| `vibepin doctor`（仅真缺陷时非 0 退出）、`vibepin sessions [--json]`、`claim --recover`（只抢救 `.claiming`，不排空在线队列） | 规格 §11.3 / §11.4 / §7.2 + `bin/vibepin.js` / `daemon/claim.js` |
| MCP `sessionId?`（三个工具） | 规格 §8.2 + `daemon/mcp.js` |
| 版本标记 `<!-- vibepin:session-routing-v2 -->`（SKILL.md 全文 / AGENTS.md 注记节） | 规格 §11.3 + `bin/vibepin.js`（`MARKER`） |
| watcher 输出与退出码（`watching …` / `watching … (N pending)` / `session …` / `wake: …` / `cannot stat` ⇒ 退出 2 / 目录路径 ⇒ 退出 1） | 实现口径（`daemon/watch.js`、`daemon/claim.js`；本页所列命令均在临时项目里逐条跑过） |
| checkout 形式 `node <vibepin-dir>/bin/vibepin.js <cmd>` / `node <vibepin-dir>/daemon/{watch,claim}.js` | 本页 `npx vibepin <cmd>` 的等价替代（见文首前置表）：`bin/vibepin.js` 对 `watch`/`claim`/`daemon` 是 spawn 透传（`TARGETS`），所以 `--root` 只被 `init --agent omp`/`sessions`/`doctor` 认；`watch`/`claim` 必须用 `--inbox` 指项目，或先 `cd <proj>` |
