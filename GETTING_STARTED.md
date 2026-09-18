# 上手指南 · vibepin

> 在浏览器或 Electron 里**点一下 / 拖个框**给界面写反馈,Claude Code **自动收到并改代码** —— 不用再截图、复制、回聊天框打字描述"改哪里"。

适用对象:第一次接触本工具的人。跟着走一遍,大约 5 分钟跑通。

---

## 它解决什么

平时让 AI 改 UI,你得:截图 → 说"左上角那个标题太小" → AI 猜是哪个元素 → 改。
用了 vibepin:你在页面上**点中那个标题**(或**拖框圈一片区域**)→ 写一句"大一点" → 点 Send → Claude Code 直接定位到对应元素/组件文件去改。

它对 **普通网页 / React 应用 / Electron 应用** 都适用,因为它们底层都是 Chromium 页面。

---

## 0. 准备

- 装了 **Node 18+**(`node -v` 看一下)。
- 拿到 `vibepin` 这个文件夹(下面假设它在 `~/Desktop/workspace/vibepin`)。
- 第一次先装依赖(为了用 Claude Code 的 MCP 模式):

```bash
cd ~/Desktop/workspace/vibepin
npm install
```

---

## 1. 30 秒先跑通(不需要你自己的项目)

工具自带一个 demo 页,先用它感受一下:

```bash
node daemon/daemon.js
```

浏览器打开 **http://127.0.0.1:7331/** ,然后:

1. 按 **⌥A**(Option+A;Windows/Linux 是 Alt+A)→ 右下角弹出 vibepin 面板。
2. **点**任意一个元素(标题 / 按钮 / 卡片)→ 弹出小框,写一句中文 → **添加**。
3. 或者 **按住拖一个框** 圈住一片区域 → 同样写备注 → **添加**。
4. 点面板里的 **Send** → 看到 "Sent N" 就说明发出去了。

> 这一步只是体验交互。demo 页没有真实源文件,所以这里的标注**不会真的改代码**。
> 要真的改代码,看第 2 步把它接到一个真项目上。

按 **Esc** 退出标注模式。

---

## 2. 接到你自己的项目

核心(`core/annotate.js` 那段覆盖层)到哪都一样,只是**怎么把它注入页面**因项目而异。

### A. 普通网页 / React(Vite 项目)—— 最简单

把插件加进 `vite.config.js`:

```js
import vibepin from 'vibepin/vite';

export default defineConfig({
  plugins: [vibepin()],   // React 项目就放在 react() 后面
});
```

(真实项目里先 `npm i -D vibepin`;本仓库的示例用的是本地路径。)

然后正常 `npm run dev`。插件会在 dev 模式**自动帮你把 daemon 起起来、把覆盖层注入页面**,你什么都不用多做。打开 dev 地址,⌥A 就能用。

> **React 福利**:在 React 开发模式下,标注会自动带上**组件名 + 源文件:行号**
> (例如 `<Hero> src/components/Hero.jsx:7`),Claude Code 直接打开那个组件文件改,不靠猜。

想直接看效果,跑仓库里的现成示例:

```bash
cd examples/react-vite && npm install && npm run dev   # React,带组件定位
# 或
cd examples/web-vite  && npm install && npm run dev   # 纯 HTML
```

### B. Electron 应用

在 main 进程 dev 模式下注入覆盖层,并暴露像素级截图能力。完整代码见
[adapters/electron.md](adapters/electron.md),示例见 `examples/electron/`(`npm install && npm start`)。

### C. 任意页面(不是你的项目、线上站等)

daemon 跑着的时候,在页面里加一行即可:

```html
<script src="http://127.0.0.1:7331/annotate.js"></script>
```

或做成书签(bookmarklet)一键注入。

---

## 3. 接上 Claude Code(重点 —— 让它自动改)

到这里你能"点 + 写 + Send",标注会进到项目里的 `.vibepin/inbox.jsonl`。
最后一步是让 Claude Code **自动收取并实现**。

### 推荐:`/vpin` 一键启动(省 token)

先安装斜杠命令(只做一次)。`/vpin` 是 Claude Code 的命令配置,**npm 不会帮你装**,
所以提供一条 CLI 把它写到 `~/.claude/commands/`:

```bash
npx vibepin init
```

(装完**重启一次 Claude Code** 让它加载命令。)之后在**任意项目**的会话里,直接输:

```
/vpin
```

它会用**后台文件 watcher** 挂起监听(同时盯着**本会话队列**与**共享留言本**),然后**把输入权还给你**:

- 你在浏览器点 / 拖 + Send → watcher 醒来 → Claude 自动改对应文件,循环。
- 等待期间**不花 token**(等待发生在 shell 进程里,不经过模型),
  而且窗口空闲可输入 —— 你可以随时打字提别的(Node/utils/任何)需求,**一个窗口、共享上下文**。

停止:让它杀掉后台 watch.js 任务,或直接 Esc / 关窗口。

> **为什么不用 MCP 的 `watch_annotations`?** 那是"模型轮询":每隔几十秒模型被重新唤起、
> 重读上下文再查一次,**空闲也持续烧 token**。`/vpin` 的文件 watcher 把"等待"放在模型外面,空闲零成本。
> (MCP 模式仍可用,见 [README.md](README.md);适合只想 hands-free、不在乎 token 的场景。)

---

### 其他 agent（Codex / Cursor / Antigravity / omp）

同一个循环，只是接线不同 —— `init` 还认这些目标：

```bash
npx vibepin init --agent codex        # ~/.codex/prompts/vpin.md
npx vibepin init --agent cursor       # .cursor/commands/vpin.md（在项目里跑）
npx vibepin init --agent antigravity  # 只印 MCP 注册片段
npx vibepin init --agent omp --root . # 写项目接线（见下）
npx vibepin init --agent all          # 以上全部 + Claude Code
```

唤醒路径不是每家都一样：**Antigravity 只有 MCP 一条**（它没有客户端进程能挂后台 watcher，会话租约由 daemon 代写），其余四家既能挂文件 watcher、也能走 MCP；Codex 的 shell 被网络沙箱掐掉，所以心跳一律只走文件写。各适配器细节见 `adapters/`（每家第一段都标了自己的唤醒路径）。

**omp（oh-my-pi）** 没有 agent 侧的命令文件 —— 它自己会读 `AGENTS.md`，所以
`init --agent omp` 接的是**项目**：`.vibepin/config.json`、`.gitignore` 规则、
`.omp/skills/vibepin-annotations/SKILL.md`、以及 `AGENTS.md` 里的「## 注记（vibepin）」节
（内含可直接挂后台作业的 `watch → claim` 命令）。默认 cwd，`--root <目录>` 可指向别的项目；
已有文件一律**只报告、不重写**（幂等）—— 所以协议升级要显式加 `--upgrade`
（只重写 SKILL.md 与 AGENTS.md 注记节，`config.json` 仍旧只校验）；
`--dry-run` 只打印计划、不落盘，
`--vibepin-dir <目录>` 把生成的命令指向指定的 vibepin checkout（默认指向本包）。
（`claude` / `codex` / `cursor` 三家相反：`init` 会**覆盖**它们的命令文件，重跑即升级。）

---

## 多会话路由（同一项目开着多个会话时）

一句话：**目标显式、队列隔离、判活只影响 UI。**

- **目标显式**：面板发注记时要么指定某个会话（写 `.vibepin/sessions/<sid>.jsonl`），要么不指定（写共享 `.vibepin/inbox.jsonl`，所有人都会收到）。服务端**不猜** —— 目标没有租约记录时只会降级成广播并如实告诉你，不会自己挑一个会话。
- **队列隔离**：每个会话一个队列文件，互不串台；定向注记**不做副本**（副本会被别的会话抢走，还会白唤醒项目里每个会话）。只有不带目标的注记才走共享留言本。
- **判活只影响 UI**：`.vibepin/sessions/<sid>.json` 是会话租约，`GET /sessions` 让面板显示"最后活动 N 分钟前"和待办条数；**它绝不决定注记投给谁** —— 会话很久没动，注记照样进它的队列。

面板的行为：只开着**一个**会话时自动预填它（去向行写着发给谁）；开着**多个**时不预填，列出来让你选，选过的记住；**零个**会话就是广播。

升级：已经接过的项目要换成带 `--queue`/`--session` 的新命令（omp 还要 `npx vibepin init --agent omp --upgrade`），
**没迁移的后果**、逐文件清单与改前/改后命令见
[docs/20260918-session-routing-migration.md](docs/20260918-session-routing-migration.md)。

---

## 4. 日常三步

1. 起项目 dev(daemon 会自动跟着起)。
2. Claude Code 里输 **`/vpin`**(一次)—— 挂上监听,窗口照常可用。
3. 浏览器/app 里:**⌥A → 点元素或拖框 → 写中文 → Send** —— 自动改,空闲不花 token。

---

## 操作速查

| 操作 | 结果 |
|---|---|
| **⌥A** / Alt+A | 开/关标注模式 |
| **点击**元素 | 元素标注(带 CSS selector;React 还带组件名+源文件) |
| **拖拽**一个框(>5px) | 区域标注(框 + 框内元素列表) |
| **Esc** | 退出标注模式 |
| 面板 **Send** | 把这一批标注发给 Claude Code |

每条标注都带上:你的备注、元素 selector(或区域 rect)、outerHTML、关键计算样式、
页面 URL、React 组件名+源文件(若有)、像素截图(Electron 下)。

---

## 排错

- **按 ⌥A 没反应**:刷新页面(daemon 实时吐最新脚本);确认控制台有 `[vibepin] overlay ready`。
- **`EADDRINUSE: 7331`**(端口被占):`lsof -ti tcp:7331 | xargs kill` 然后重来。
- **Claude Code 连不上 MCP / 提示 MCP off**:在 `vibepin` 目录跑过 `npm install` 没有?MCP 模式需要它。
- **Send 失败**:daemon 没在跑,或端口不是 7331。看 dev 日志里的 `[vibepin] daemon ...` 那几行。
- **显示已发送但会话没反应**:该会话可能还在跑旧命令(只收广播)。定向注记会堆在
  `.vibepin/sessions/<sid>.jsonl`:用 `npx vibepin sessions` 看 sid 与待办,`npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl` 取回;
  迁移步骤见 [docs/20260918-session-routing-migration.md](docs/20260918-session-routing-migration.md)。

---

更深入的架构、MCP 工具清单、各种注入方式见 [README.md](README.md)。
