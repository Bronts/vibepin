# vibepin daemon 生命周期与 agent 侧投递方案

> 状态：**提案（未实现）**。第 1 节是实测证据，第 3 节是要做的事，第 4 节是**明确决定不做**的事及理由。
> 读者：vibepin 维护者 + 使用本工具的项目（agent 侧模板见 `adapters/omp/AGENTS.md` / `adapters/omp/SKILL.md`）。
> 相关文档：`docs/20260919-batch-ledger.md`（批账协议正文）、`docs/20260918-session-routing-design.md`（§4 路由）、`adapters/omp.md`（omp 接入与 Routing 小节）、`extension/README.md`。
> 文中 `文件:行` 基于写作当次的快照，**行号会漂，认代码形状不认行号**。实测数据来自 2026-09-30 的一次真实排障会话（talents-py / Windows / opencode）。

---

## 0. 结论先行

一个真实项目里"标注了但 agent 没反应"，排障下来是**四个独立问题**被混成了一个：

| # | 症状 | 原因（证据强度见 §1.1；§1.1 的免责声明对全表生效） | 方案 | 量级 |
| --- | --- | --- | --- | --- |
| 1 | daemon 起来一会儿就没了，页面 Send 直接失败 | **疑似**：daemon 的启动方式决定它能否活过 harness 的作业回收（**未坐实**） | `vibepin up`：探端口 → 复用或**脱离**启动（§3.1） | 小 |
| 2 | 注记进了队列但没人被唤醒 | **疑似**同一机制作用于 watcher 作业；**注记不丢**（这条已实测），只是延迟 | 每轮开工/收尾核对重挂（§3.2.1） | 小 |
| 3 | 空闲时无法"自发"响应 | ~~没有外部注入入口~~ **见 §1.6：入口存在**（`POST /api/session/:id/prompt`），只是要用上它得放弃 agent 无关性 | 推送驱动 + 队列兜底（§3.2.3） | 中 |
| 4 | ~~用了 MCP 记账就和批账对不上~~ **已修复**（§7.1） | MCP `resolve` 只写 `claims.jsonl` 不碰账本；`report` 读的是账本 | 新增 `ackByIds` 复用既有 `ackItems`（§7.1） | ✅ 完成 |

**前三条都不需要新架构。** 投递正确性（"发到正确的项目"）已经由构造保证（§2.1），MCP server 已经写好只是被关着（§2.3），而"推送"这条路 §1.6 已实测可用——**但 §7.4 发现外部进程拿不到凭据，所以 C 暂不可行**。

**本版修订（相对初稿）**：
1. 第 3 行原写"harness 没有外部注入入口 → 不追求自发"——**已被实验推翻**（§1.6）
2. 第 4 行原在"未决问题"里——**实际是缺陷，已修并加回归测试**（§7.1）
3. 新增 §7.4：C 的鉴权对外部进程**无路径**，C 降级为"未验证是否可行"

对应的**否决项**（§4）：

- ❌ 不做"中央 server 作为分发控制中心"——它会**削弱**项目定位（§4.1）
- ❌ 不重写 Rust——拿不到单一语言系统，收益与代价倒挂（§4.2）
- ❌ 不把 daemon 塞进**项目自己的启动脚本**——层次错误（§4.3）

唯一同意的结构性改动：**store 从 JSONL 换 SQLite**（§5），但那是替换一个接口，不是重写。

---

## 1. 实测证据

### 1.1 daemon 会掉，且方式和启动方式强相关

| 事实 | 证据（**历史观测，不可复现** —— 那台机器那个时刻的残留；复现方式见 §3.3 步 0） |
| --- | --- |
| harness 后台作业方式起的 daemon **死了**（多次） | 作业输出文件为**空**、无 stderr、无栈；`Get-CimInstance Win32_Process` 里已无该 node 进程 |
| 脱离方式（`Start-Process -WindowStyle Hidden`）起的 daemon **存活 279 分钟** | `PID 331444`（`vibepin.js daemon`）+ 子进程 `PID 400760`（`daemon/daemon.js`），`StartTime 2026-09-30 17:50:19`，检查时 `(Get-Date) - StartTime = 279 分钟` |
| **不是**项目启动脚本杀的 | `dev.ps1:383-385` 的 `$devPorts` 只含 `$FrontendPort`(4100) / `$BackendPort`(8200)；7331 不在其列 |
| 死亡是**静默**的 | 进程消失时 daemon 日志无任何错误行，最后一行仍是正常启动横幅 |

> ⚠️ **未证实**：本文档**不能**断言"harness 回收后台作业"就是死因。目前的证据是"1 个脱离进程存活 279 分钟 vs 3 个 harness 作业死亡"的对照，**是强证据不是证明**。
> 要坐实很简单：同一条命令，一个用 harness 后台作业起、一个用脱离起，跑 30 分钟看谁还在。**对象必须一致** —— 本节讲的是 **daemon 进程**（`node daemon/daemon.js`）；watcher 是另一个进程对象，§0 第 2 行才是它，两者不能混着验。
> **建议实现前先跑这个对照实验。**

### 1.2 注记**不会丢**，只会延迟——这是整个方案的地基

| 事实 | 证据 |
| --- | --- |
| watcher 死掉后注记留在队列里 | 杀掉 watcher 后 `sessions/probe-b.jsonl` 仍为 450 字节 |
| **带 `--queue`** 重挂会**立刻补投并退出** | 实测 stdout：`[vibepin] wake: queue already has 1 pending`，进程随即 `HasExited = True` |
| **只带 `--inbox`** 重挂**不会**补投 | 同条件测试下只打印 `watching ... (from 453 bytes)` 然后 park，不唤醒 |
| 机制在代码里 | `daemon/watch.js` 的启动段：只 `if (QUEUE) { count(QUEUE); if (>0) done(...) }`，**共享 inbox 的积压不触发启动唤醒** |

**推论**：watcher 被杀的最坏后果是"延迟到下次重挂"，不是丢失。**前提是挂载时必须带 `--queue --session <sid>`。**

### 1.3 目标 sid 没有租约时会**降级成广播**

| 事实 | 证据 |
| --- | --- |
| 向不存在的 sid 投递 | `POST /annotations` 返回 `{"ok":true,"received":1,"routed":"broadcast","pending":1,"target":"probe-durability","degraded":true,"reason":"unknown-session"}` |
| 定向队列为 0 字节，注记进了共享 inbox | `sessions/probe-durability.jsonl` = 0 字节；`inbox.jsonl` = 453 字节 |
| 机制在代码里 | `daemon/daemon.js` — "The only degraded path…"：目标租约不存在时改写共享 inbox 并回报 `degraded:true` |

**推论**：面板上的候选列表来自 `GET /sessions`（磁盘租约派生）。**一个从未挂过的 agent，在面板上不存在，发给它的定向注记会落到公共 inbox 被任意会话认领。**

### 1.4 这不是"omp 能跑、opencode 不能跑"

| 事实 | 证据 |
| --- | --- |
| 本仓库这个 sid 上**跑通过** | `vibepin batches` 显示 12 个真实批，全部 `omp-talents`，最后一个是 `b-20260922-184809-68d6`（2026-09-22T10:48:09Z） |
| 之后断了 8 天 | 期间无任何批 |
| 断的原因很俗 | daemon 入口文件写成了 `server.js`；实际是 `daemon/daemon.js`，因此**从未启动成功** |
| omp 与 opencode 的机制相同 | 两者都是"后台作业退出 → 会话被唤回"；本方案第 1 节的实测就是在 opencode 里跑通的（`b-20260930-114755-dc43`） |

### 1.5 harness 能力盘点（opencode）

| 能力 | 状态 | 命令/证据 |
| --- | --- | --- |
| **唤醒运行中会话（外部注入）** | ✅ **有 —— 本节最早写作时判断为"不存在"，已被实验推翻** | `POST /api/session/:id/prompt`，实测见 §1.6 |
| 后台作业完成 → 投递结果进会话 | ✅ 有 | 本会话实测两次 |
| 非交互（headless）跑一轮 | ✅ 有 | `opencode run [--session <id>] [--model] [--agent]` |
| 常驻服务 + HTTP API | ✅ 有 | `opencode service start`；`opencode api <method> <path>`（服务实测在 `127.0.0.1:49374`，API 在 `/api/*` 前缀下） |

> ⚠️ **更正记录**：本节初稿把"外部注入轮次"判为 ❌ 不存在，理由是"MCP 是 client-initiated，不能反向推轮次"。**这个推理没错但结论错了** —— MCP 确实不能推，但 opencode 的 **HTTP 会话 API** 可以。§1.6 是推翻它的实验。凡是引用过早期结论的地方（§0、§3.2、§7.4）都已随之修订。
>
> 注意：`opencode run` 属于**冷启动**，明确**不在**本方案范围内（用户口径：agent 本来就是活着的，要的是它与 server 通信，不是重开一个）。但下面 §1.6 的 `prompt` 端点**不是冷启动**——它投给一个已存在的会话。

### 1.6 实验：HTTP 能唤醒一个**空闲**会话（推翻 §1.5 初稿）

**问题**：vibepin 的 daemon 能否把注记**直接推**进一个已存在的、空闲的 agent 会话，从而完全不需要 watcher？

端点来自 opencode Web 客户端自身的 bundle（服务端不暴露 OpenAPI：`/openapi.json`、`/api/doc` 裸取均 401/404）：

```js
prompt: (e,t) => a({ method:`POST`,
  path:`/api/session/${encodeURIComponent(e.sessionID)}/prompt`,
  body:{ id:e.id, text:e.text, files:e.files, agents:e.agents, skills:e.skills,
         metadata:e.metadata, delivery:e.delivery, resume:e.resume },
  successStatus:200, declaredStatuses:[400,401,404,409] })
```

**方法**：建一个一次性会话（`location` 指向临时目录，不碰任何仓库），投一轮纯文本，读回消息，然后删除。

**结果**：

| 观察 | 值 |
| --- | --- |
| `POST .../prompt` 返回 | HTTP 200，**469 ms** |
| 返回体 | **user 消息对象**（异步受理，不是助手回复）：`{"type":"user","delivery":"steer"}` |
| 会话随后产出 | `{"type":"assistant","agent":"build","content":[{"type":"text","text":"PONG."}],"finish":"stop","cost":0.0013,"tokens":{"input":8730,"output":4}}` |
| 终态 | `{"type":"idle","outcome":"succeeded"}` |
| 投稿→完成 | **约 4.5 秒**（几乎全是模型延迟） |
| 鉴权 | **必需**。裸 `fetch` 对 `/api/*` 一律 401；客户端带 `x-opencode-ticket`，凭据来自配对流程（`POST /api/pair` → `GET /auth/connect/<code>`） |

**结论：空闲会话被 HTTP 投递唤醒并完成了一轮。** "只能在人说话时检查"这个缺口**可以直接关掉**。

**代价（必须一起读，别只读结论）**：

1. **这是 opencode 私有 API**，不是公开契约。`/api/*` 随版本可能变；vibepin 若依赖它，就**不再 agent-agnostic** —— 而 `adapters/` 覆盖 10 个 agent 正是本工具的核心价值。
2. **鉴权是 opencode 特有的**（ticket + 配对）。别的 agent 没有这套。
3. **`delivery` 语义未查清**。默认 `steer`；未知还有哪些模式、哪个才是"注记应当排队"的正确选择。
4. **会话正在跑时的行为未验**。本次投的是**空闲**会话。进行中的轮次会怎样（排队？插入？丢？）没测。
5. **权限未验**。本次 prompt 不触发任何工具，所以不涉及审批。真注解会让 agent 改代码——是否会卡在权限上、`session.permissions`（创建体的一个字段）能否预授权，均未查。
6. **在 `type:"idle"` 的空会话上验的**，不是"用过一阵、当前空闲"的会话。机制应当相同，但没证。

---

## 2. 现状盘点：已经能用的部分

### 2.1 投递正确性已由**构造**保证，不靠约定

| 机制 | 位置 | 效果 |
| --- | --- | --- |
| overlay 的 ENDPOINT = **它自己 `<script src>` 的 origin** | `core/annotate.js`：`const ENDPOINT = (document.currentScript && new URL(document.currentScript.src).origin) \|\| 'http://127.0.0.1:7331'` | 页面**无权选择**投给谁 |
| daemon 自己盖 `inbox` / `projectRoot` | `daemon/daemon.js` 的 POST 白名单 | 客户端**伪造不了** |
| 端口已被**别的** inbox 占用时拒绝启动 | `daemon/daemon.js`：`EADDRINUSE` → `probeHealth` → 同 inbox 复用 `exit 0`，异 inbox 打印两条路径 `exit 1` | 不会静默错投 |

这三条合起来 = **一个页面在物理上无法写进另一个项目的 inbox**。这是**能力约束**，不是数据字段约定 —— 参见 §4.1 为什么这一点决定了不该搞中央 server。

### 2.2 唤醒机制已在 opencode 里跑通（本会话实测）

闭环：`POST /annotations` → daemon 路由到 `sessions/<sid>.jsonl` → watcher 的 `fs.watchFile` 触发 → watch.js `exit 0` → **harness 把作业完成结果投递进会话** → `claim.js` 打印投递头 → agent 干活。

延迟 = `fs.watchFile` 轮询（400ms）+ claim，**秒级以内**。空闲时 **0 token**（模型未运行）。

### 2.3 MCP server **已经存在**，只是被关着

| 事实 | 证据 |
| --- | --- |
| 三个工具已实现 | `daemon/mcp.js`：`list_annotations` / `watch_annotations` / `resolve_annotation` |
| 关闭原因 | `daemon/mcp.js`：`const sdk = await loadSdk(); } catch { return null; // no node_modules: the daemon stays in plain file mode }` |
| 依赖已声明、只是没装 | `package.json`：`@modelcontextprotocol/sdk ^1.29.0`、`zod ^4.4.3` |
| 关掉时的横幅 | 启动输出 `[vibepin] MCP     off — run \`npm install\` in vibepin to enable /mcp` |
| 装依赖不脏仓库 | `.gitignore` 含 `node_modules/` |

> ⚠️ `watch_annotations` 是**长轮询**，`adapters/omp.md` 写明"while parked there, the turn stays open and keeps spending tokens on an empty inbox"。**它在交互式会话里是反模式**，本方案只用 `list_annotations`。参见 §3.2.2。

---

## 3. 方案

### 3.1 ✅ 已实现：`vibepin up` / `down` —— daemon 的脱离启动

**要解决**：daemon 是**共享设施**，它的生命周期不该由任何一次 agent 会话或任何项目脚本决定（§4.3）。

实现后的语义（与初稿有三处偏差，见下）：

1. 探 `127.0.0.1:7331-7370` 的 `/health`，**按 `inbox` 过滤**——认的是"服务本项目的那个 daemon"，不是"随便一个 vibepin daemon"（`doctor` 故意取第一个，`up` 不能）
2. 找到本项目的 → 打印端口，**复用并 `exit 0`**
3. 没有 → `spawn` **detached + `unref`**，stdout/stderr 追加到 `.vibepin/daemon.log`，然后**轮询 `/health` 直到应答（15s 上限）**——不信 spawn 成功就等于起来了
4. `down` 读 `.vibepin/daemon.json`（`{pid, port, inbox, startedAt}`，daemon 启动时写、退出时删），发信号并等它真的停

**与初稿的三处偏差**（都是实现时发现的）：

| 初稿 | 实际 | 为什么 |
| --- | --- | --- |
| "找到别的项目的 daemon → `exit 1`" | **不拒绝，换端口起自己的** | 初稿照抄了 `daemon.js` 的端口冲突语义，但 `up` 是**扫一段端口**而不是只试一个。别的项目占 7331 不构成障碍——`daemon.js` 自己会在真正绑定时做它那套安全判定 |
| PID 从 `/health` 拿 | 用 `child.pid` | `/health` **按设计**不暴露 PID。spawn 路径下我们知道答案，不该显示 `?` |
| — | `down` 对**没有 pidfile** 的 daemon **拒绝猜 PID** | 一个手工起的 daemon（或别的启动脚本起的）没有 pidfile，而 `/health` 不给 PID。此时唯一诚实的答案是"这个不是 `vibepin up` 起的"，并指出怎么把它变成可管理的 |

**硬约束**：必须 `detached`，**不能**用独立控制台窗口——窗口一关进程即死。这是 §1.1 里**唯一有实测支撑的约束**（但 §1.1 的对照未坐实"谁杀的"，见那里的免责声明）。

> **与"将来可能做单一 server 管多项目"的关系**：若真走到那一步，`up` 的语义会从 per-project 变为全局服务。**现在不要提前设计**（§4.1）。`up` 的接口（`--root` / `--inbox`，默认 cwd）在两种语义下都成立。

**验证**（真跑）：

| 项 | 结果 |
| --- | --- |
| 脱离存活 | `up` 的进程退出后，daemon 仍存活（32s 后复查仍在） |
| `down` | 停进程 + 清 pidfile + 释放 7331，三者都验 |
| `up` 幂等 | 第二次 `up` 复用，不重复起 |
| `down` 对无 pidfile 的 daemon | 拒绝猜 PID 并解释，退出码 1 |
| 回归 | 5 个测试文件全过（见附录 B 的完整基线） |

> **`up` 的位置**：项目自己的启动脚本**可以**调 `vibepin up`（§4.3）——但探端口/脱离/pidfile 的逻辑住在这里，不是每个项目各写一遍。

### 3.2 agent 侧：队列是**账**，推送是**醒**，两者都要

| 通路 | 职责 | 空闲成本 | 依赖 | 失败后的后果 |
| --- | --- | --- | --- | --- |
| **A. 队列 + watcher 后台作业** | 投递的**系统记录**；唤醒（真实时） | 0 token | harness 后台作业 | 延迟（**不丢**，§1.2） |
| **B. MCP `list_annotations`** | 兜底拉取 | 0（不调用就没成本） | 无进程 | 需要有人正在说话 |
| C. HTTP 推送**（§1.6）** | 唤醒，**不需要 harness 配合** | 0（daemon 一次 POST） | **opencode 私有 API + ticket 鉴权 —— §7.4 证明外部拿不到票据，当前不可行** | 退回 A |

**设计取向：A 保留为唯一真相，C 作为唤醒加速，B 作为保底。** 理由：

- **A 必须留**。它是**跨 agent 通用**的那条（`adapters/` 覆盖 10 个 agent），也是"注记不丢"的物理保证——注记先落队列，之后无论谁怎么醒，重挂都能补投（§1.2 实测）。
- **C 用来消除 A 的两个弱点**：不必等 harness 作业退出、不必担心作业被回收（§1.1）。§1.6 实测 469ms 受理、约 4.5s 完成。
- **C 不能取代 A**，因为它是 **opencode 特有的私有 API**（§1.6 代价 1、2）。依赖它 = 放弃 agent 无关性。**因此 C 是"驱动"，不是"通路"** —— 与 `adapters/` 同构：每个 agent 一个 driver，没有 driver 就退回 A。

```
页面 → POST → vibepin daemon ──┬─ 落队列（A：真相、可补投、跨 agent）
                              ├─ 推送 driver（C：有 driver 才有）
                              └─ MCP list_annotations（B：人/轮次触发时拉）
```

**必须先做的前置**：C 会改动"谁在记账"，而 §7.1 的 MCP 记账缺陷说明这条边界很脆。**先修 §7.1，再上 C。**

#### 3.2.1 挂载义务（写进项目 AGENTS.md 的口径）

现有 `adapters/omp/AGENTS.md` 已经写对了，**不需要新口径**，只需明确**每轮两个检查点**：

```bash
# 开工 / 收尾各一次
node <vibepin>/daemon/watch.js --inbox <repo>/.vibepin/inbox.jsonl \
     --queue <repo>/.vibepin/sessions/<sid>.jsonl --session <sid> \
  && node <vibepin>/daemon/claim.js （同参数）
```

- **必须带 `--queue --session`**（§1.2：只带 `--inbox` 的话，积压不会在重挂时补投）
- `<sid>` 唯一（一个队列一个读者，两个 watcher 会互相偷注记）、会话内不变（换 id 会在面板留孤儿）
- 判断自己是否还活着：`vibepin doctor` 会直接报 `watcher pid N is gone`

#### 3.2.2 MCP 的用法边界

- ✅ 用 `list_annotations`：一次性拉取，人说话/每轮开头调一次
- ❌ **不要**用 `watch_annotations`：长轮询会把轮次挂住烧 token（§2.3）

#### 3.2.3 推送 driver（C）—— **当前阻塞，不要开工**

**§7.4 证明外部进程拿不到 opencode 的 ticket**（`POST /api/pair` 自身要鉴权，磁盘无凭据文件）。所以 C 的门槛不是"写 driver"，是**opencode 没有对外暴露这个集成面**。在鉴权有答案之前不写任何代码。

若将来可达，以下是必须先补齐的未知（否则会在真实使用中撞上）：

| 未知 | 为什么致命 |
| --- | --- |
| `delivery` 全部取值与语义（默认 `steer`） | 选错会让注记插入正在进行的轮次（打断）或被丢弃。注解不是闲聊，插队是有害的 |
| 会话**正在跑**时的行为 | 用户一边和 agent 说话一边标注是常态；此时推送会不会打断正在生成的回答？ |
| 权限 | 真注解会让 agent 改代码，必然触发工具调用；若卡在审批，推送就等于没发生 |
| 在"用过一阵、当前空闲"的会话上是否同样成立 | §1.6 用的是全新空会话。**这条最容易被忽略但最可能出问题** |

**driver 的最小契约**（与 `adapters/` 同构）：

1. `canDeliver(sessionRef)` —— 这个 agent 是否支持推送、凭据是否可用；不可用就**静默退回 A**
2. `deliver(batchHeader)` —— 把**投递头**（不是全量载荷，见 `docs/20260919-batch-ledger.md` §0.4 字节预算）推给会话
3. **失败必须降级到 A，不得吞掉** —— 推送失败时注记必须仍在队列里等着

#### 3.2.4 可选：有界 park（默认关闭）

`daemon/watch.js` 支持 `ANNOTATE_WATCH_TIMEOUT`（0 = 无限）；超时后 `exit 0` 并打印 `(re-arm)`。

开启后 watcher 会**定期自己醒一次**，让"作业被回收"能在 N 分钟内自愈，不必等人说话。**代价**：每 N 分钟消耗一轮 token，且这是启动参数不是默认值。

**默认关闭**，留给需要的人按需打开。理由：它把"空闲零成本"这个设计原点换成了"可自愈"，是个真实的权衡，**该由使用者选而不是默认替他选**。

### 3.3 实现顺序（互相独立，可分别验收）

| 步 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| 0 | 跑 §1.1 的对照实验，坐实/推翻"回收"假说 | 无 | 30 分钟后哪个进程还在 |
| ~~1~~ | ~~`vibepin up` / `down` + daemon pidfile~~ **✅ 已完成** | 无 | 关掉终端、重启 dev 环境后 `/health` 仍通；`down` 能停；`up` 幂等 |
| ~~2a~~ | ~~修 §7.1 的 MCP 记账缺陷~~ **✅ 已完成**（新增 `ackByIds` 复用 `ackItems`；未加 `batchId`，理由见 §7.1） | — | `report` 退出码 0 + T19/T19b/T19c 回归 |
| 2b | MCP 打开：`npm install` + 在 agent 配置里注册 `/mcp` | 2a ✅、1（daemon 得先耐活） | `list_annotations` 能被 agent 调到并返回真实数据 |
| 3 | AGENTS.md 写"每轮先 `list_annotations`" | 2b | 人只说话不标注，agent 也不报错 |
| ~~4~~ | ~~推送 driver（C）~~ **⛔ 阻塞**：§7.4 证明外部进程拿不到 opencode 凭据 | 外部可达性 | 不要开工，直到鉴权有答案 |
| 5 | store → SQLite（§5） | 独立 | 见 §5 |

> **顺序上的一条硬约束**：2a 已修复——它必须**先于** 2b 的原因现在更清楚了：MCP 一旦被 agent 用起来，只要它调过 `resolve_annotation`，那批的账本就再也结不清了（§7.1）；而账本的价值恰恰是"用户唯一能核对的凭据"。

---

## 4. 明确决定**不做**的事

### 4.1 ❌ **倾向**不做"中央 server 作为分发控制中心"

> 措辞修正：初稿写的是"**它会让**投递变弱"，把一个**依赖具体实现**的判断写成了技术必然。改成"倾向不做"并说明它依赖什么。

**现状是能力约束**：overlay 只能投到"把它加载进来的那个 origin"（§2.1），页面无法选择、客户端无法伪造。集中成一个 server 之后，"哪个项目"通常要从这个约束退化成**客户端填的字段 + 服务端必须信任它**。

**但这个推论有前提，不是必然**：集中实现若仍从**连接本身**推导项目（`Origin`/`Referer`/来源端口/每项目一条 listener），能力约束可以保留。也就是说本条论证成立与否取决于**集中怎么实现**，而不是"集中"本身。**这个中间态（集中索引 + 保留 per-project 路由）初稿完全没考虑，也未经评估。**

另外三个代价：

- **失败半径**：现在一个项目的 daemon 挂了只影响它自己；集中后 = 全挂
- **schema 迁移**：per-project 的 `.vibepin/*` 变成多租户表，"root/inbox" 要变成数据列（**未评估**；注意 §5 同意的 store→SQLite 只是替换一个接口，与这里的多租户化不是一回事）
- **收益尚未成立**：唯一"只有一个项目"的用户（当前口径）拿不到任何好处

**什么情况下这条会被推翻**（届时重新评估，不要提前设计）：

1. 需要**跨项目/跨月检索**标注历史
2. 一台机器**多项目同时在线**，要统一查看
3. 要**非开发者**（设计师）标注，需要账号/权限/多人协作

**注意区分两件事**：中央化**项目路由**（否决）与用 MCP 改善**agent 定位**（赞成，§3.2）。后者才是当前真正的缺口 —— 现在"投给哪个 agent"依赖租约文件存在（§1.3），MCP 让 daemon 直接知道谁注册了、claim 变成服务端原子操作。

### 4.2 ❌ 不重写 Rust

**核心原因：拿不到单一语言系统。** overlay 与扩展必须活在浏览器里 → 永远是 JS。MCP SDK 是 TS-first。三层要共享同一份标注结构，Rust 默认要**手写维护**一份对齐的 schema —— 丢掉的正是**主要**的编译期防错来源。（`wasm-bindgen` / `tsify` / `specta` 这类从 Rust 单向生成 TS 类型的路线**未评估**，所以这里说"默认要手写"，不说"只能"。）

**"单文件分发"这个 Rust 的真优势，可能可以由 Bun 覆盖**（实测 `bun 1.3.14` 已安装）。**未实际编译验证** —— 支撑结论的那一步没做，见附录 B。

**代价侧**：会扔掉 Chrome 套件（`tests/s3-client-visibility.test.mjs`，含真浏览器加载扩展，实测 6/6）、CLI 套件（见附录 B 的完整基线），以及 `adapters/` 下 10 个适配文件（6 个 agent + 4 个框架）。

**负载侧**：每小时几条注记。GC / 吞吐不是瓶颈。

### 4.3 ❌ 不把 daemon 塞进项目自己的启动脚本

vibepin 是**故意项目无关**的：`adapters/` 有 10 个适配文件（6 个 agent + 4 个框架）；`vibepin init` 往任意项目写模板；daemon 由 `--root`/`--inbox` 参数化；README 有 `## Standalone daemon (no project)`；扩展要在 7331-7370 扫端口**正是因为每个项目各有自己的 daemon**。

把它的生命周期交给某个项目的 `dev.ps1`，**最强的理由是"只能有一份实现"**（不是"不许动项目脚本"——初稿那版是拿"项目无关"的哲学当技术结论，被两位审查员独立指出，见 §7.5）：`vibepin up` 无论如何都要存在（其它项目要用）；`dev.ps1` 若自己再实现一套探端口+脱离启动，就有了两个真相源。

**正确落点**是 `vibepin up`（§3.1）。`dev.ps1` **可以**调它——但逻辑必须住在 vibepin 里。项目侧只保留 AGENTS.md 那句"开工确认 daemon 在跑"。

---

## 5. 唯一同意的结构性改动：store → SQLite

现状 `store.js` 背后是只增不减的 JSONL：

| 问题 | 后果 |
| --- | --- |
| 无索引 | 无法按 selector / 页面 / 时间检索 |
| 无保留策略 | `processed.jsonl` 只涨（本仓库已 58KB，仅 21 条记录） |
| 并发写靠原子 rename | 当前够用，但认领/租约/账本已经在用"文件即锁"的模式，边界会越来越薄 |

**这是替换 `store.js` 一个接口，不是重写。** 对外契约（`claim` / `ack` / `report` / 批账 schema）**不变**。列为独立步骤（§3.3 步 5），**不阻塞前 4 步**。

> 提醒：批账协议文档 `docs/20260919-batch-ledger.md` 明确"账本只增不减、不入库"。改 store 时要分清**投递队列**（可换 SQLite）与**账本**（append-only 审计，其语义是协议的一部分）。

---

## 6. 验收标准

| # | 标准 | 怎么验 |
| --- | --- | --- |
| 1 | 关掉所有终端、重启 dev 环境后 daemon 仍在 | `curl 127.0.0.1:<port>/health` 的 `inbox` 指向本仓库 |
| 2 | 页面 Send **不因 daemon 缺失而失败** | 停掉 daemon → Send 报错；`vibepin up` 后 Send 成功 |
| 3 | 注记到达后秒级被处理 | 标注 → 计时到 agent 收到投递头 |
| 4 | watcher 被杀后**不丢** | 杀 watcher → 投注记 → 重挂 → 观察到 `wake: queue already has N pending` |
| 5 | 只说话不标注时不误报 | 连续几轮对话，`list_annotations` 返回空且 agent 不啰嗦 |
| 6 | 不装扩展也能用 | 纯 vite 注入路径下右下角迷你钮可见、可切换 |
| 7 | MCP 认领后账本能结清（§7.1 的回归） | 走 `resolve_annotation` 结清一批 → `vibepin report` **退出码 0**（T19 已覆盖，实现为 `daemon/batches.js` 的 `ackByIds`） |
| 8 | 推送失败必须退回队列（§3.2.3 契约 3） | 阻塞中：§7.4 未解决前 C 不实现，此条暂不适用 |

---

## 7. 已定位缺陷与未决问题

### 7.1 ✅ 已修复：MCP `resolve_annotation` 破坏批账可见性

**缺陷**：

不是"两套记账"——`claims.jsonl` 是权威、账本是它的投影（`batches.js`："The ledger is a **projection**, so it can be re-derived: claims.jsonl says which…"）。真正的缺陷是 **MCP `resolve` 只做了一半**：它写 `claims.jsonl`（止住重复投递），但**不碰账本**。而 `report` 的 open/stale 读的是**账本里的 `item.status`**（`batches.js` 的 `openCount` 与报表口径），所以 MCP 认领过的注记**永远 `open`** ⇒ `vibepin report` 该批**永远退出码 3**，对比表**说谎**——正打在 v4 的命根子上："机械性来自可见性"。

（初稿这里还有第 3 条"账本若需重建时 MCP 认领过的项归不到任何批"。**那条不是独立缺陷且与本修复的理由冲突**：唯一会缺 `batchId` 的 claims 行只出现在 MCP-only 场景，而那时**根本没有批**可归属。删。）

**修法**：`daemon/batches.js` 新增 `ackByIds`，`daemon/mcp.js` 的 `resolve` 调用它。`ackItems` 是 settle 账本的**唯一**实现，但它讲的是 batch seq；MCP 客户端只有 annotation id。所以新增的只是**一次映射**，不新增第二套 ack 实现。

**三道刻意的设计约束**（都不是"顺手"，且都是审查逼出来的）：

| 约束 | 理由 |
| --- | --- |
| **只 settle `open` 条目；`owner` 必须是 claim 过该批的会话** | 初版**没有**这两条，是本次修复引入的**真回归**：实测一条人类明确判的 `wontfix`（reason: "by design, not a bug"）被 agent 的 resolve **静默改写成了 `done`**，历史里留下 `from: wontfix, to: done`。而 `wontfix`/`deferred`/`blocked` 带 `reason` 的全部意义就是"别装成完成了" |
| **`owner` 用账本的 `sessionId` 判定，不用"是否还在我的读集里"** | 我第一版用了读集，**跑挂了 T19**：watcher 路径下 `claim.js` 早已抽干队列，那些 id 不再"可见"，但账本仍记着归谁。这也是既有测试早就写明的契约（`mcp.sessions.test.mjs`："it can only resolve ids that are in its own read set"） |
| **`note` 的校验完全交给 `ackItems`** | 不在 `ackByIds` 里复写规则（重复实现正是本 bug 的成因）。`note` 与"settle 哪个批"无关，第一次调用就替所有批校验了 |

**顺手修掉的一处并发缺陷（同进程）**：`ackItems` 是整文件 read-modify-write。`writeJsonAtomic` 让**单次写**原子，但**读**不是——两个 settle 可以都读到 `open`、都写回，后者**静默丢弃**前者，而**双方都报成功**。实测注入 2000 条后并发：10 轮里 **7 轮丢失**。已按账本路径串行化（`batches.js` 的 `serialized`）。

**验证**：

| 层 | 证据 | 可复跑？ |
| --- | --- | --- |
| 缺陷可复现 | 只调 `store.resolveByIds`（旧路径的全部所作所为）→ `report` 退出码 **3**，账本仍 `open` | 一次性脚本，**未入库** |
| 修复生效 | `ackByIds` → 退出码 **0**、账本 `done` + `closedAt` | 一次性脚本，**未入库** |
| 回归测试 | `tests/p3-batch-protocol.test.mjs` 的 **T19 / T19b / T19c / T19d / T19e / T19f / T19g**，7/7 | ✅ 入库 |

**这 7 条测试的牙齿是验证过的**（在仓库临时副本里注入 mutation 后复跑）：

| Mutation | 被谁抓住 |
| --- | --- |
| M1 `seqs` 加宽成"整批全结"（= 协议明令禁止的**假完成**） | **T19d** |
| M2 跨批只结第一个 | **T19g** |
| M3 先写 claims 后 settle | 全组 7 条 |
| M4b `note` 不落账本（证据列退化成时间戳） | **T19e** |

> **首版测试是不够的**：审查用 8 个 mutation 复验第一版的 T19/T19b/T19c，**7 个能同时骗过它们和整个 p3 套件**——包括 M1。T19d–T19g 就是为补这些缺口而加。

**我修红过一个既有测试**：`daemon/mcp.sessions.test.mjs` 对返回体做**整对象深比较**，`resolve` 一加字段就碎（2/5 → 4/5）。已改成断言它真正在意的字段（§7.4 数的是**条数**不是字节 / 幂等 / 受读集约束），并补了一条跨会话断言。现在 5/5。**这个文件不在我首版的"基线"里，是审查发现的。**

顺带**澄清**（不是"修掉"）一个容易误判的事实：旧路径实测 `resolved=0` —— watcher 路径里 `claim.js` 早就写过 claims 行了，所以 MCP 那次 claims 写入本就是空操作。**缺的自始至终只有账本那一半。**

→ 即 §3.3 步 **2a**，已完成；2b（启用 MCP）可以进行了。

### 7.2 旋钮（不是未决事项）

`ANNOTATE_WATCH_TIMEOUT` 默认关闭（§3.2.4）。它只在有人主动打开时才需要一个值，那是使用者的偏好，不是设计决策。

### 7.3 正确延期（条件未成立）

| # | 事项 | 为什么现在不用决 |
| --- | --- | --- |
| 1 | 多 agent 并发时的 sid 命名约定 | 只在第二个 agent 出现时才成立。成本一行，可以懒到撞了再定 |
| 2 | 扩展的跨项目 discovery | `discover.js` 的"最低端口胜出"在两项目同时在线时会误连（`adapters/omp.md` 已承认）。本项目走 vite 注入**不经过**这条路径；只有扩展成为主通路时才成立 |

### 7.4 C（HTTP 推送）的可达性：**外部进程拿不到凭据**

§1.6 证明了"能唤醒空闲会话"，但后续追查鉴权时发现一个更硬的约束：

| 测试 | 结果 |
| --- | --- |
| 裸 `fetch` 任意 `/api/*` | **401** |
| 带假 `x-opencode-ticket` | **401** |
| **`POST /api/pair`（配对入口本身）** | **401** ← 关键 |
| 磁盘上找 ticket | `auth.json` 只有模型厂商的 key；`storage/`、`~/.local/share/opencode/` 无凭据文件 |
| 服务进程 argv | `opencode.exe serve --service`，无 token |

**结论：没有免鉴权的引导路径。** 配对入口自己也需要鉴权，所以一个外部工具**无法自助获得 ticket** —— 要打通只能逆向 opencode 的凭据存储，或等它开放这个集成点。

**这把 C 的定位从"待实现的驱动"降级为"未验证是否可行"**：不是写个 driver 的事，是 opencode 尚未对外暴露这个集成面。**在鉴权问题有答案之前，不要为 C 写任何代码。**

→ 对应的实际结论：**A + B 就是当前的答案**，而它在今天就可以工作（daemon + watcher 都在跑）。C 若将来可行，它是一个"驱动"，不是"通路"（§3.2）。

### 7.5 已知遗留缺口（审查发现，本次**有意不修**）

四位审查员（`space-bunny-free` ×2、`deepseek-v4.1-flash`、`deepseek-v4-pro`）在本次修复上又挖出下面这些。**都留着，逐条写明为什么**——不修不等于不知道。

| # | 缺口 | 为什么这次不修 |
| --- | --- | --- |
| **G1** | **`claim.js` 的崩溃窗口**：`createBatch()`（账本原子落盘）→ **之后**才 `appendFile(CLAIMS)`。中间被杀 ⇒ 账本在、claims 无此行。后果：该批从"可重建为可见欠债"降级成 `unknown batch`（`rebuild` 从 `exit 3 / rows 1 / rebuilt:true` 变成 `exit 1 / rows 0`），**欠账从报表里静默消失** | **是既有缺陷**，不是本修复引入；需要**毫秒级窗口内被杀**（审查员自述"没能构造出不依赖故障的常规反例"）；且真正的修法在 `claim.js`（预写 claims 或启动时对账孤儿），是另一个量级的改动 |
| **G2** | **跨进程丢更新**（G1 的同族）：本修复加的是**同进程**串行化。另一个进程（`claim.js`、独立的 `vibepin ack`）仍可与 daemon 的 settle 交错，整份写回覆盖 | 修它需要**跨进程**互斥或乐观 CAS + 重试，是 `store.js` 的并发设计题。**在时间压力下手搓并发原语，很可能换出更糟的 bug**——这个判断我保留，也接受被质疑 |
| **G3** | **性能**：`ackByIds` 每次 `listBatches` **全量读并解析所有账本**。实测 3001 个账本 ≈ **1 秒/次**；且**没有任何代码删 `batches/*.json`**（`unlink`/prune 全仓零命中），`.vibepin/` 又被 gitignore，git 也不会帮收。成本随项目年龄**单调增长** | 当前 12 个账本 ≈ 几毫秒，不疼。但**保留策略本身就是缺的一环**，和"队列改 SQLite"（§5）是同一个问题域。注意：循环里那个 `if (located.size === want.size) break` 是**死代码**——`listBatches` 返回时已经全量物化了，break 只省 CPU 不省 I/O |
| **G4** | **一个 note 打给 N 行**：`resolve` 的 `note` 是**单个字符串**，批量 settle 时 N 行共享同一份"证据"。实测三行三个不同文件、全部声称证据是 `shared.ts:1`，**2/3 是假凭据** | **不是本修复引入**——`vibepin ack --all-done --note X` 一直是这个语义。但 MCP 让它更容易发生。协议要支持 per-item note 是更大的改动，**先用文档约束**（§3.2.2） |
| **G5** | **同一 id 落在两个账本时只结最新的**，旧的永久 `open` | 触发路径就是 G1（崩溃窗口 → 重新投递 → 同 id 入两个账本）。修 G1 才是根治；这里只处理最新是"对正在做的那一批"的正确选择，**但只处理最新不够**——旧批会一直进 `## 未结清` |
| **G6** | **跨会话越权**已由 `owner` 收紧（§7.1），但 **CLI 侧没有**：`vibepin ack --batch <任意 id>` 仍可结清任何批 | 这是**既有信任模型**（同机同用户），不是本修复打开的口子。要改是全局决定，不该由一次 bugfix 顺手定 |
| **G7** | **账本损坏时的静默零**：`listBatches` 读不动的账本会被跳过。已给 `ackByIds` 接上 `onWarn` 并把消息放进返回体的 `warnings`；但**`resolve` 本身不会因此失败** | 让它失败会因"别处某个损坏账本"而阻塞本次 resolve，代价更大。可见性优先 |

### 7.6 被驳回的审查意见（留痕，免得下一轮重新提一遍）

| 意见 | 来源 | 驳回理由 |
| --- | --- | --- |
| "让 **daemon 主动 spawn** 带 `--queue --session` 的 watcher，就能把重挂从 agent 纪律转给 daemon" | 架构侧写 | **混淆了"有个 watcher 进程"与"agent 被唤醒"**。唤醒原语是「**agent 自己的 harness 后台作业退出**」，daemon spawn 的 watcher 退出时没有任何东西通知 agent。而 daemon **早就在**触发唤醒了——它把注记写进队列，**agent 那个 park 着的 watcher** 就会退出。缺的从来不是"没人 spawn"，而是"**agent 的 watcher 没 park 着**"，也就是纪律问题本身 |
| "给 `writeJsonAtomic` 的 tmp 名加随机后缀，消掉并发踩踏" | 代码对抗 | **那样会让情况变坏**。现在是 pid-keyed tmp → 同进程并发写会**报 EPERM（响亮地失败）**。改成唯一 tmp 后两次写都成功、后者静默覆盖前者 ⇒ **把一次可见的失败变成一次静默的数据丢失**。F3 与 F1 是**同一个根因**（账本写入没有互斥），必须一起修：**只修 tmp 名等于把警报器拆了** |

---

## 附录 A：本次排障用到的命令

```bash
# daemon 是否活着、inbox 是不是本仓库（判活的唯一依据）
curl -s http://127.0.0.1:7331/health

# 面板上的会话候选从哪来
curl -s http://127.0.0.1:7331/sessions

# 接线 / 租约 / 端口归属 / 未结清
node <vibepin>/bin/vibepin.js doctor

# 批列表（open 列 = 未过 TTL 的未结清数）
node <vibepin>/bin/vibepin.js batches [--open]

# 测"重挂是否补投"：先投注记、杀 watcher、再同 sid 重挂
node <vibepin>/daemon/watch.js --inbox <repo>/.vibepin/inbox.jsonl \
     --queue <repo>/.vibepin/sessions/<sid>.jsonl --session <sid>

# §1.6 推送实验：建一次性会话 → 投一轮 → 读回 → 删除
# （location 指向临时目录，绝不指向真实仓库）
opencode api POST /api/session -d '{"title":"probe (delete me)","agent":"build",
  "model":{"providerID":"opencode-go","id":"deepseek-v4.1-flash","variant":"default"},
  "location":{"directory":"<tmp>"}}'
opencode api POST /api/session/<sid>/prompt -d '{"text":"Reply with exactly: PONG. No tools."}'
opencode api GET  /api/session/<sid>/message
opencode api DELETE /api/session/<sid>
```

## 附录 B：本文档中**未验证**的断言

诚实标注，避免被当成已验证结论。**本表由一位审查员逐节对照正文查漏后重写过**——初版只登记了自己想起来的那几处，漏了不少。

### B.1 证据强度

- §1.1 的"harness 回收后台作业"——**是强证据不是证明**，对照实验见 §3.3 步 0。**注意这条免责只写在 §1.1**：§0 与 §3.1 曾把它升格成"真正的原因"和"实测换来的硬约束"，已按审查意见改软；§3.3 步 0 的实验对象也从 watcher 改回了 **daemon**
- §1.1 的现场证据（PID、279 分钟、空输出文件、`dev.ps1` 端口范围）是**历史观测，不可复现**——那台机器那个时刻的残留
- §1.4 的"12 个真实批"、§5 的"58KB / 21 条"——**证据在写稿机器的 `.vibepin/`，已被 gitignore，仓库内不可复现**。这不是"假"，但对读者不可核对
- §2.2 的"空闲时 0 token"——**推断**，未测（还依赖一个未验证前提：harness 不会因后台作业的存在产生周期性开销）
- §2.2 的"秒级"——来自单次实测，未做多次计时统计
- §1.5 的"服务在 `127.0.0.1:49374`"——**一次性观测，端口每次不同**

### B.2 未做的事

- §4.2 的"Bun 可编译单文件"——仅确认 `bun 1.3.14` 存在，**未实际编译过**（支撑该结论的那一步没做）
- §4.1 的"schema 迁移代价"——**纯推测，未评估**
- §4.1 的"集中会削弱项目定位"——**依赖具体实现**，中间态（集中索引 + 保留 per-project 路由）**未评估**
- §5 的"SQLite 替换不破坏对外契约"——**未试过**，是基于 `store.js` 接口的判断
- §1.6 / §7.4 的鉴权路径——只确认"裸 fetch 401 + 客户端带 `x-opencode-ticket` + `POST /api/pair` 也 401 + 磁盘无凭据文件"，**未尝试逆向 opencode 的凭据存储**
- §1.6 的推送能力——**已验证"能唤醒空闲会话"**，但 §7.4 证明外部进程拿不到凭据，故**当前不可用**。以下四项仍未验证（若将来可达需先补，见 §3.2.3）：
  - `delivery` 的全部取值与语义（只知道默认是 `steer`）
  - 会话**正在跑**一轮时的行为
  - 触发工具调用时的权限/审批行为
  - 在"用过一阵、当前空闲"的会话上是否同样成立（本次是全新空会话）
- §7.1 的"同进程串行化"——修的是**同进程**。**跨进程（G2）未验证、未修**
- §7.5 的 G1/G3/G4/G5 —— 均为**读代码 + 构造等价磁盘状态**得出的，**没有真的去崩一个 `claim.js` 进程**；G3 的 1 秒/3000 账本是实测，但"多久累积到 3000"没做 soak

### B.3 测试基线（**完整**，改动前 vs 改动后）

| 文件 | 改动前 | 改动后 |
| --- | --- | --- |
| `tests/p0-session-routing.test.mjs` | 22/22 | 22/22 |
| `tests/p3-batch-protocol.test.mjs` | 22/20（2 个既有失败） | **29/27**（同 2 个既有失败） |
| `tests/s3-client-visibility.test.mjs` | 6/6 | 6/6 |
| `daemon/mcp.sessions.test.mjs` | 5/5 | **5/5**（本修复曾把它跑成 4/5，已修） |
| `daemon/daemon.sessions.test.mjs` | 9/9 | 9/9 |

- p3 那 2 个失败是**测试自身**抽旧版做对照时漏抽 `batches.js`（`ERR_MODULE_NOT_FOUND: vibepin-old-*/batches.js`），**与本次改动无关且改动前已存在**
- **初版的"基线"漏了 `daemon/*.sessions.test.mjs` 两个文件（14 个测试）**，而本修复恰把其中之一跑红。那份漏报已按审查意见补上——**漏报基线比报错基线更危险**
- 仓库里既没有 `npm test` 脚本、也没有跑测试的 CI workflow，"基线"指哪些文件本就该写明
- `s3` 会起真 Chrome：审查员按指令跳过了它，所以本文档的 6/6 **未被独立复核**

### B.4 审查过程本身的局限

- 四位审查员都在 **Windows / Node v24** 上跑；**POSIX 行为未测**（EPERM 是 Windows 特有语义，POSIX 上可能退化成静默覆盖）
- 他们**都没有起真 daemon、发真 HTTP 请求**：复现都是直接调 `createToolBindings`。所以"两个真实 MCP 客户端真的会在时间上重叠"是**推断**（依据：`transport.handleRequest` 直接 return，无串行化）
- 依赖 `@modelcontextprotocol/sdk` / `zod` **尚未 `npm install`**：真机上整条 MCP 路径目前**根本不存在**，因此上述并发结论都停留在库函数层面
