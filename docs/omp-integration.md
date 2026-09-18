# 配置说明：把 vibepin 用在我们的项目里（omp + 日常浏览器）

> 面向"用户只动手一次、之后由 agent 承担"的接法。本文里的**推荐组合**是结论，其余为备选。
> 事实来源：`daemon/daemon.js`、`adapters/vite.js`、`extension/*`、`bin/vibepin.js`（截至本分支未提交状态）。
> 标注 **[已实现]** 的是当前代码就有的能力；标 **[待做]** 的是本文建议但尚未落地的改动，不要按已生效使用。

---

## 1. 一句话原理

页面里出现这一行，右下角就有标记工具：

```html
<script src="http://127.0.0.1:<daemon端口>/annotate.js"></script>
```

浮层把「你点选的元素 + 你写的话」POST 给本机 daemon；daemon 把记录**追加**写到某个项目目录下的 `.vibepin/inbox.jsonl`（= 留言本）。**谁读那个留言本，就是"回给哪个 agent"。**

所以"要配的"只有三件事：**回哪个项目**（留言本位置）、**回哪个 agent**（谁读）、**端口**。同一项目并存多个会话时还多一个"投给哪个会话"的选择，但那是**发送时在面板上选的**（`targetSession`；不选就广播），不需要事先配置——见 §3.5。

---

## 2. 三种注入方式对比

| 方式 | 要改项目吗 | 覆盖面 | 心智负担 | 何时用 |
|---|---|---|---|---|
| **A. 浏览器扩展**（`extension/`）**[已实现]** | ❌ 不改 | 任意项目 / 任意端口 / 含别人的站（可选） | **一次性**（两个浏览器各加载一次） | **推荐默认** |
| B. Vite 插件（`vibepin()`）**[已实现]** | ✅ 改 2 处（`package.json` + `vite.config.ts`） | 只有它服务的那个 dev 页面 | 每个项目都要配一次 | 想要"精确到行号"、或团队统一走构建期注入时 |
| C. 书签(let) **[已实现]** | ❌ 不改 | 单页、每次导航都要再点 | 每次都要点一下 | 临时/应急；扩展没装时的兜底 |
| D. Next.js `withVibepin` + 一行 `<Script>` **[已实现]** | ✅ 改源码 | 那个 Next 应用 | 换栈时才遇到 | 以后换 Next 时 |
| E. Electron 主进程 `executeJavaScript` **[已实现]** | ❌（只改主进程） | 那个桌面应用 | 一次性 | 以后做桌面端时 |

**推荐：A（扩展）为默认；只有"要行号"时才在具体项目加 B。**

> 补充：精确到行号需要项目里额外装 `vite-plugin-vue-inspector`（dev-only，一行插件）**[已实现为可选依赖路径]**；不装则给到 **Vue 组件名 + `.vue` 文件绝对路径**。

---

## 3. 推荐组合：三层，各管一件事

```
① 注入层   = 浏览器扩展（两个浏览器各装一次，之后永不操心）
② 归属层   = 项目里的 .vibepin/config.json（提交进 git；谁是留言本、发给谁、端口）
③ 唤醒层   = 项目 AGENTS.md 的一节协议 + omp skill（agent 自己挂监听）
```

### 3.1 一次性：装载扩展（用户操作，两个浏览器各一次）

**Chrome**：`chrome://extensions` → 右上角 **开发者模式** → **加载已解压的扩展程序** → 选 `D:/Develops/vibepin/extension`（含 `manifest.json` 的那层）→ 建议在拼图菜单里 **固定**它。

**Edge**：`edge://extensions` → 左侧 **开发人员模式** → **加载解压缩的扩展** → 选同一目录。

扩展行为 **[已实现]**：

- 只匹配 `http://localhost/*` 与 `http://127.0.0.1/*`（默认**不碰生产站**）；
- 并行探测 `7331–7370/health`，**只认**返回里含字符串 `inbox` + 数字 `port` 的应答（同端口上的普通 dev server 会被拒绝），取**最小端口**；
- 注入 `<script id="__vibepin_overlay" …>`，**幂等**（与 Vite 插件同时存在也只注入一次）；
- 找不到 daemon：**不注入**，console 只打**一行**提示，不重试。

**确认生效**：console 出现 `[vibepin] overlay ready — floating panel; ⌥A toggle …`，或页面里 `typeof window.__vibepin === 'object'`。之后按 **Alt+A**（macOS ⌥A）。

### 3.2 每个项目一份：`.vibepin/config.json`（建议提交进 git）

**[已实现]** daemon 启动时读 `<cwd>/.vibepin/config.json`（`--config <path>` 可换位置），把它当**默认值来源**：`--port` / `--root` / `--inbox`（等价 `ANNOTATE_PORT` / `ANNOTATE_ROOT` / `ANNOTATE_INBOX`）与 Vite 插件的 `vibepin({ enabled, inbox, port, target })` 都**优先于**这个文件。**相对路径（`inbox`、`root`）一律相对项目根**：项目根 = 存放 `.vibepin/` 的那个目录（config.json 不在 `.vibepin/` 下时，就是它自己所在的目录）。文件不存在 = 用内置默认；**JSON 畸形或字段类型错 = 拒绝启动**并报 `[vibepin] bad config <path>: <原因>`（不静默回退——静默回退就是静默错投）。`port: 0` = 自动取 7331–7370 里第一个空闲端口。`watch.js`/`claim.js` **不读**这个文件，仍只认 `--inbox`/cwd 默认，所以 §3.3 的命令显式带 `--inbox`。

```json
{
  "agent": "omp",
  "inbox": ".vibepin/inbox.jsonl",
  "root": ".",
  "port": 0
}
```

| 字段 | 含义 | 说明 |
|---|---|---|
| `agent` | **显示名**（= 插件选项 `target`，面板上"发给谁"的文案）——**不是路由依据**：v2 的路由键是发送时带的 `targetSession`（不带就广播），daemon 不读这个字段 | `"omp"` / `"claude"` / `"codex"` / `"cursor"` / 任意字符串 |
| `inbox` | **回哪个项目**：留言本路径 | 相对路径以**项目根**（`.vibepin/` 的父目录）为基准；换成绝对路径即可把注记投到别的仓库 |
| `root` | daemon 盖章进每条注记的项目根，浮层据此把 `.vue` 路径补成绝对路径 | 相对路径同样以项目根为基准；不写 = daemon 启动时的 cwd（从项目根启动即项目根） |
| `port` | daemon 端口；`0` = 自动（7331→7370 取第一个空闲） | **多项目同时开时留 `0`**，别都写 7331：第二个项目会因"端口被不同留言本占用"而显式拒绝启动（`daemon.js:301` 附近有明确报错），这是**故意的**，避免静默错投 |

`.gitignore` 两行（留言本不提交、配置提交）：

```gitignore
.vibepin/*
!.vibepin/config.json
```

> 扩展的**端口/仅本地页**设置存在浏览器本地（扩展 storage），**不在这个文件里**——扩展读不到你磁盘上的文件；面板与扩展弹窗都会把"当前连到哪个项目的哪个留言本"显示出来，**错投是可见的**。

### 3.3 唤醒层：AGENTS.md 协议 + omp skill（`init --agent omp` 已实现）

`vibepin init --agent omp` **[已实现]** 一次写好四处：`.vibepin/config.json`（缺则写、存在只校验）、`.gitignore` 两行、`.omp/skills/vibepin-annotations/SKILL.md`、`AGENTS.md` 的「## 注记（vibepin）」节。模板就是 `adapters/omp/SKILL.md` 与 `adapters/omp/AGENTS.md`，其中的 `{{VIBEPIN_DIR}}` / `{{PROJECT_DIR}}` 由 init 填成绝对路径；`--root <目录>` 指向别的项目，`--dry-run` 只打印计划，`--vibepin-dir <目录>` 让生成的命令指向指定 checkout。omp 的原生机制就是「AGENTS.md 常驻 + skill 按需加载」，不需要新机制。

已接入的项目**重跑 init 不会自动升级**：SKILL.md 与 AGENTS.md 注记节里没有版本标记 `<!-- vibepin:session-routing-v2 -->` 时 init **只报告**，加 `--upgrade` 才重写这两处（`config.json` 仍只校验、不重写）。逐文件清单、改前/改后命令与「未迁移的后果」见 [20260918-session-routing-migration.md](20260918-session-routing-migration.md)。

手动接线（不跑 init）时，AGENTS.md 那节的完整内容直接抄 `adapters/omp/AGENTS.md`；核心是**双文件**命令（[设计规格 §8.1](20260918-session-routing-design.md)）：

```bash
# <sid>：本会话的短 id，形如 omp-2f9c1a（^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$），定了就一直复用
node <vibepin>/daemon/watch.js --inbox <项目>/.vibepin/inbox.jsonl --queue <项目>/.vibepin/sessions/<sid>.jsonl --session <sid> && node <vibepin>/daemon/claim.js --inbox <项目>/.vibepin/inbox.jsonl --queue <项目>/.vibepin/sessions/<sid>.jsonl --session <sid>
```

分开看：`--inbox` = 共享留言本（广播），`--queue` = 本会话队列（定向），`--session` = 本会话身份（写租约、claim 时记 `claims.jsonl`）。**不带 `--queue`/`--session` 就逐字退回旧行为**：只收广播、也收不到定向注记（这是有意的兼容承诺，见迁移文档 §6）。

### 3.4 日常流程（用户 3 步，agent 4 步）

用户：**Alt+A → 点元素/框区域 → 写一句 → Send**。

agent：被唤醒 → `claim`（原子取走本批）→ 按组件名/文件路径定位并改 → 复验（构建/类型/页面）→ **再挂监听**（同一个 `<sid>`）。

### 3.5 会话路由（v2）：多个会话怎么不串台

一个项目里可以同时挂着多个会话（两个 Claude Code 窗口、一个 omp、一个 Codex…）。v2 用**显式目标 + 每会话一个队列 + 判活只影响 UI** 把它们分开：

- **两种投递，只有两种**：注记带 `targetSession` 且该 sid 有租约记录 → 只 append 到 `.vibepin/sessions/<sid>.jsonl`；不带目标 → 共享 `.vibepin/inbox.jsonl`（**逐字等于旧行为**）。服务端**不猜**：目标没有租约记录时降级成广播，响应 `routed:"broadcast", degraded:true`，并在 `.vibepin/routed.jsonl` 留痕。
- **定向注记不做副本**：共享 inbox 与 `processed.jsonl` 里都没有影子条目 —— `claim.js` 是整文件 rename，副本会被别的会话先抢走并真的去改代码，还会白唤醒项目里每个会话。
- **判活只影响展示**：`.vibepin/sessions/<sid>.json` 由 `watch.js` 在 park 期间每 ~20s 刷 mtime（MCP 会话由 daemon 写，`mode:"mcp"`）；`GET /sessions` 返回 `{sessionId, agent, label, lastSeenAt, pending, mode}`（**不含** `cwd`/`pid`/绝对路径）。`lastSeenAt > 900s` 只让面板写"最后活动 N 分钟前"，**绝不改变投递给谁**。
- **本会话怎么出现在面板里**：只有跑过带 `--session` 的 v2 命令（或调用过带 `sessionId` 的 MCP 工具）的会话才会登记；`<sid>` 定了就每轮复用，别每轮换新。
- **恢复通道**：旧命令（只带 `--inbox`）只收广播，发给它的定向注记会堆在队列里、面板 `pending` 看得见但没人被唤醒。取回：

  ```bash
  npx vibepin sessions                                      # 列会话：sid · agent · label · 最后活动 · pending
  npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl    # 手工排空某会话队列
  npx vibepin doctor                                        # 诊断：sessions/ 是否存在、死 watcherPid、旧命令、daemon 版本
  ```

  逐文件升级清单与"未迁移当天的后果"见 [20260918-session-routing-migration.md](20260918-session-routing-migration.md)。

---

## 4. 备选：不改项目的零安装路径（应急 / 别的仓库）

```bash
# 1) 起 daemon（明确"回到哪个项目"）
node D:/Develops/vibepin/daemon/daemon.js --port 7331 \
  --inbox D:/Develops/<repo>/.vibepin/inbox.jsonl \
  --root  D:/Develops/<repo>
# 2) 页面上注入那一行（二选一）
#    a. 书签(let)：新建书签，URL 粘下面这串，用时点一下
javascript:(()=>{const s=document.createElement('script');s.src='http://127.0.0.1:7331/annotate.js';document.body.appendChild(s)})()
#    b. 打开扩展 → 固定端口填 7331
```

书签的限制：端口写死（须与 daemon 实际端口一致，看启动横幅或 `/health`）；页面 CSP 严格时会被拦；**每次导航都要重点一次**。

---

## 5. agent 侧：谁读留言本

| 你想要的 | 怎么配 | 代价 |
|---|---|---|
| **omp（推荐）** | `watch → claim` 循环挂在会话里；用 `AGENTS.md` 让它每次会话自动挂 | **空闲 0 token**（阻塞等待，靠作业退出唤醒会话） |
| Claude Code | `npx vibepin init --agent claude` → `/vpin` | 会话内一次性 |
| Codex | `npx vibepin init --agent codex` → `/vpin` | 同上 |
| Cursor | `npx vibepin init --agent cursor` → `/vpin` | 同上 |
| 任意 MCP 客户端 | 先在 vibepin 仓库 `npm install` 打开 `/mcp`，再把 `http://127.0.0.1:<port>/mcp` 写进它的 MCP 配置 | **轮询，持续耗 token** |
| 只想先看 | 直接打开 `.vibepin/inbox.jsonl`（纯文本 JSONL） | 无 |

> 上表所有**文件 watcher** 路径都走 v2 的双文件命令（`--queue` + `--session`，见 §3.3）：watcher 同时监听**本会话队列**与**共享留言本**，并在租约里登记自己。**不带 `--queue`/`--session` = 只收广播**——定向注记会堆在队列里没人唤醒（恢复通道见 §3.5）。MCP 路径的会话身份来自工具参数 `sessionId`（可选），`mcp-session-id` **不可**当会话用。

---

## 6. daemon 生命周期：谁负责起它

| 情形 | 谁起 | 说明 |
|---|---|---|
| 项目走了 Vite 插件 | **dev server 自己** | 插件在 dev 时起 daemon 并在退出时回收 **[已实现]**；端口被别的东西占用时**显式 FATAL + 顺延**，不会静默换项目 |
| 只走扩展（推荐组合） | **agent**（受管进程） | 用户不手动跑命令；omp 里用 `hub start`（可加 `persist` 让它在 omp 全退后仍活着） |
| 机器重启后 | 同上（需要时再起） | 若希望开机常驻：Windows 计划任务/启动项跑同一个 `node daemon.js` 命令；**不建议**在"只在需要时用"的阶段就上常驻 |

---

## 7. 排障表

| 症状 | 原因 | 处理 |
|---|---|---|
| 页面右下角没有浮层 | 该页不是 `localhost`/`127.0.0.1`；或扩展没装/没启用 | 看 console：无 `[vibepin]` 行 = 扩展没跑（检查扩展页是否启用、是否被"仅在本地页"挡住） |
| console 说 `no daemon found … 7331-7370` | 没有任何 daemon 在跑 | 起 daemon（或让 dev server 的插件起），然后**刷新页面** |
| console 说连上了，但面板去向不是你的项目 | 多个 daemon 同时在跑，扩展取了**最小端口** | 在扩展里**固定端口**填对的那个；或关掉另一个项目的 dev server（**这是当前唯一会导致"错投"的路径，且面板可见**） |
| Send 了但 agent 没反应 | 会话里没挂监听作业 | 对 agent 说"看下注记"（注记**没丢**，安全失败）；根治靠 §3.3 的 AGENTS.md 协议 |
| 端口被占，daemon 报错退出 | 该端口上已有**不同留言本**的 daemon | 按报错提示换端口，或把两个项目指向**同一个**留言本（`inbox` 相同则复用） |
| 注记里只有组件名没有行号 | 没装 `vite-plugin-vue-inspector` | 需要行号就在该项目加装（dev-only） |
| 生产构建被影响？ | — | 不会：扩展只注入你自己的浏览器；Vite 插件是 `serve` 期；两条路都不进构建产物 |

---

## 8. 已知未验证 / 未做

- 扩展的 **"所有站点"可选权限路径**未端到端验证（`chrome.permissions.request` 需要真人点授权弹窗）；默认"仅本地页"路径已在 **Chrome 150 + 真机 Edge 151** 全程验证。
- 扩展的**"按站点锁定 daemon"**尚未实现 **[待做]**：当前多项目并存时按"最小端口"选，靠 UI 可见性防错，未做硬绑定。
- `vibepin init --agent omp` **[已实现]**：写 `.vibepin/config.json`（存在只校验）、`.gitignore` 两行、`.omp/skills/vibepin-annotations/SKILL.md`、`AGENTS.md` 注记节；已接入项目需 `--upgrade` 才重写后两者（见 §3.3）。
- daemon 的 `/mcp` 需要先在本仓库 `npm install`（当前环境未装该依赖）。
- 书签路径受页面 CSP 限制，未在严格 CSP 站点上验证。

---

## 9. 注记载荷字段（agent 可依赖的契约）

每条注记（JSONL 一行）的字段，来自 `core/annotate.js` 采集 + `daemon/daemon.js:195-216` 落盘：

| 字段 | 含义 | 稳定性 |
|---|---|---|
| `note` | 用户原话 | — |
| `url` | 采集时页面 URL | — |
| `kind` | `element` / `region` | — |
| `component` / `source` | 最内层组件名 + 源码位置。**两条通道**：装了 `vite-plugin-vue-inspector` 时走 DOM 属性通道 → `source` 形如 `src/views/…vue:9:9`（**项目相对** + 行:列，`sourcePos` 非空）；未装时走 Vue 运行时 `__file` 通道 → `.vue` **绝对路径**、无行号、`sourcePos: null`。相对路径用 daemon 盖章的 `projectRoot` 拼成绝对 | 稳定（定位首选） |
| `sourcePos` | `{ line, column }`，与 `source` 尾部的 `:line:col` 同源；**仅 DOM 属性通道（装了 inspector）时非空** | 有插件才非空 |
| `chain` | 组件层级链，**最内层→最外层**（如 `<AISettingsModelListPanel> <tab-pane> <ElTabs> <PageContainer>`）；`source: null` = 依赖内的组件（Element Plus 内部） | 稳定 |
| `selector` | CSS 路径。已修：**不再优先采用自动 id**（`#el-id-*`、`:r0:`、`rc-*` 等被跳过），并保证 `document.querySelector(sel) === 元素`（必要时补 `body >` 前缀） | 较稳定（改模板后仍可能失效） |
| `container` | **被标注元素的父容器**：selector + rect + `display/flexDirection/gap/justify/align` + `childCount` | 稳定 |
| `viewport` | `{ w, h, dpr, theme }`（采集时窗口/主题） | — |
| `rect` / `pin` | 元素视口坐标 / 页面锚点坐标 | — |
| `html` | `outerHTML`（截断 4000 字符） | — |
| `styles` | 计算样式快照 | — |
| `elements` | **区域标注**时采样到的元素数组（≤8，含 selector/component/source）；元素标注为 `null` | — |
| `screenshot` | 仅 Electron 适配器提供 `__vibepinCapture` 时才有；浏览器里恒为 `null` | — |
| `inbox` / `projectRoot` / `daemonPort` | **由 daemon 盖章**（不信任页面），用于自证来源 | 可信 |

**写字段时的坑（已踩）**：daemon 落盘是**白名单**（`daemon.js:116-135` 显式列举），只改 `core/annotate.js` 不会被投递——**新增字段必须同时**加进 `core/annotate.js` 的 item 与 daemon 的白名单，并用"发送→读 inbox"验证（只读浮层 `window.__vibepin.pending` 会漏掉这类问题）。

**定位优先级建议**：`source`(+`sourcePos`) → `component` + `chain` → `container` → `selector`（最后才用，且先用 `document.querySelector(sel) === 元素` 自证）。

**行号通道的版本锁（重要）**：`vite-plugin-vue-inspector` **必须用 6.x**。7.x 会把 `data-v-inspector` 从 DOM 删除、只留非枚举的 `__v_inspector`，而目标元素常是 Element Plus 渲染的内部节点（其自身 vnode 无该属性）→ **行号直接消失**（升级前必须复测 `sourcePos` 非空）。6.x 要配 `cleanHtml: false` 才保留 DOM 属性通道；插件自带的浮层/快捷键/切换按钮建议全关，只留数据注入。

**通道优先级（实测）**：DOM 属性通道（inspector）优先于 Vue 运行时 `__file` 通道；两者给出的**组件名一致**，差别只在路径形态（项目相对 + 行:列 vs 绝对路径）与有无行号。


---

## 10. 落地清单（agent 执行，用户只说一句"给这个项目接上 vibepin"）

1. 检查扩展是否已装（用户侧一次性；没装则给加载步骤）
2. 写 `.vibepin/config.json`（`agent` / `inbox` / `root` / `port`）
3. `.gitignore` 加两行（`.vibepin/*` + `!.vibepin/config.json`）
4. `AGENTS.md` 追加 §3.3 那一节 —— 或直接跑 `npx vibepin init --agent omp [--root <目录>]`：它一次写 config（缺则写）/`.gitignore`/skill/AGENTS.md 四处
5. 确认 omp skill（`skill://vibepin-annotations`，init 会写到 `.omp/skills/vibepin-annotations/SKILL.md`）
6. 起 daemon（受管进程），`/health` 断言 `inbox` 指向本项目
7. 自检：在页面 console 确认 `[vibepin] overlay ready … endpoint: http://127.0.0.1:<port>`，面板去向行 == `/health` 的 `inbox`；`GET /sessions` 里能看到本会话的 `<sid>`
8. 挂 **v2** 监听作业（`--queue` + `--session`，同一个 `<sid>`），并在本会话回复里声明"已就绪"
