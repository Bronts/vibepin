## 注记（vibepin）

<!-- vibepin:batch-ledger-v4 -->

本项目已接入 vibepin：页面注记（Alt+A 标注元素/区域 + 原话）落到 `.vibepin/inbox.jsonl`（**广播**：所有挂着的会话都收到）或 `.vibepin/sessions/<sid>.jsonl`（**定向**给某一个会话）。

**每轮闭环四步：收到投递头 → 逐条改 → 逐条 `vibepin ack` → 收尾 `vibepin report`**（第 1 步是开工挂监听，之后「2–4 步 → 再挂」循环）。

1. **开工挂监听**：先确认 daemon 在跑——端口以本项目 `.vibepin/config.json` 的 `port` 为准（`0` = 7331–7370 里第一个空闲，可能不是 7331），用启动横幅或 `curl -s http://127.0.0.1:<端口>/health` 核对，其 `inbox` **必须指向本仓库**（这是"注记没被投到别的项目"的唯一依据）；没有 daemon 就用**受管进程**起（`cwd = 本仓库`，它才会读到 `.vibepin/config.json`）。然后把下面这条作为**后台作业**挂上——等待发生在 shell 进程里（**空闲 0 token**），作业退出即唤醒本会话：

   ```bash
   node {{VIBEPIN_DIR}}/daemon/watch.js --inbox {{PROJECT_DIR}}/.vibepin/inbox.jsonl --queue {{PROJECT_DIR}}/.vibepin/sessions/<sid>.jsonl --session <sid> && node {{VIBEPIN_DIR}}/daemon/claim.js --inbox {{PROJECT_DIR}}/.vibepin/inbox.jsonl --queue {{PROJECT_DIR}}/.vibepin/sessions/<sid>.jsonl --session <sid>
   ```

   `<sid>` = 本会话的短 id，形如 `omp-2f9c1a`（正则 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`）；**定了就一直复用**，每轮 re-arm 用同一个，否则面板上会出现一堆孤儿会话、用户也没法定向。

2. **读到的是「投递头（指令层）」，不是裸 JSON**：`claim` 打头（批号 / 总数 / 页面 / 来源 / 账本路径 / 协议 / 逐条一行 digest）。**v4.1 起默认不再内联完整 JSON**——投递头整段 ≤ 3000 字符，所以不会再被消费端的 4000 字符上限截断（旧形态上万字符，已两次造成"只看到第 1 条"）。头里每个 `n.` 就是这条在**本认领批**里的编号——也是 ack 的键。

   | 头里的位置 | 含义 |
   | --- | --- |
   | `批 b-<日期>-<时间>-<hex>` | **认领批号**（一次 claim = 一批）；账本文件名就是它 |
   | `N 条 · M 个页面 · 会话 <sid>` | 本批总数（= `report` 的行数）/ 跨页数 / 归属会话 |
   | `来源 queue … · inbox … · recovered … · 写入批 …` | 定向队列 / 共享 inbox / 崩溃恢复 的条数；`w-…` 是 daemon 烙在**记录**上的写入批号（一次 POST 一批），`无批号` = 批协议之前的老记录 |
   | `账本 <路径>` | `.vibepin/batches/<批号>.json`（已被 `.gitignore` 覆盖，不入库）——**全量真相在这里**，投递头默认不含载荷 |
   | `载荷 …`（3 行） | 取回入口：提示行 + 单条/整批两条命令（原样给在头里，直接抄） |
   | `n. 页面 · <定位> — 原话 [e:行/w:短号]` | 逐条：`n` = ack 用的 seq；`<定位>` = **压缩后**的首选定位（路径只留 basename `Upload.vue:120`；组件名与文件主名相同则只留文件 `<Upload> Upload.vue:12` → `Upload.vue:12`）；原话优先，每行原话不少于 40 字符（不足则全留）；`[e:<行>]` = 该条在 `processed.jsonl` 的**行号指针**（1-based、append-only），让路掉的完整路径从这里取回；`w:<短号>` = 写入批 id 后 4 位，`-` = 老记录无批号 |
   | `## 未结清` 块 | **上一次认领遗留**、还没结清的项（`open` = 还没交代；`blocked`/`deferred` = 已交代但不重复投递）。**不是本批要改的东西**，但要顺手结清——块里给了每条的 `vibepin ack` 命令。没有这个块 = 没有欠债 |

   - **精确证据按需取回，不默认内联**：需要 `selector` / `html` / `styles` / `rect` / `chain` / `container` / `elements` 这类原始载荷时才逐条取：
     ```bash
     npx vibepin show --batch <批号> --seq <n> --evidence   # 该条完整记录（= processed.jsonl:<行号>）
     npx vibepin show --batch <批号> --json                 # 整批账本
     ```
     `[e:<行>]` 就是 `processed.jsonl` 的行号指针；头里的「页面 · 压缩定位 · 原话」够定位时**不要**取整批（等于把上万字符重新灌回上下文）——定位里被压掉的完整路径就从这个指针取（`--seq <n> --evidence`）。调试要整包：`claim --full`（头 + digest + 完整 JSON；v4.1 前是默认形态）；机器面仍是 `claim --json`。
   - `watch && claim` 的顺序不可颠倒：**先 claim 再 re-arm**；`watch` 只在有活时退出，**永不**因为"有未结清"而失败。
   - **欠债不会挡住投递（v4）**：未 ack、崩溃、换会话，都不会让新注记领不到——投递活性永远优先。欠债只是**可见**：`report` 用 `!` 标出并以退出码 3 提醒，`vibepin batches` / `vibepin doctor` 也看得到。机械性是"账本可见"，不是"门禁"。

3. **逐条改，逐条记账**：改代码 → 验证 → **立刻 ack 这一条**（`ack` 是账本状态的唯一写入口）：

   ```bash
   npx vibepin ack --batch <批号> --seq <头里的 n> --note "改了什么（file:line）"
   ```

   - `--note` 里**写 `file:line`**（例：`min-width 96px（frontend/src/views/resume/Upload.vue:131）`）：它原样进 `report` 的「证据」列，是用户核对改动的唯一凭据。
   - 不改的：`--status wontfix --reason "为什么"`；被外部卡住 / 以后做：`--status blocked|deferred --reason "…"`（**必须带 `--reason`**；这两态不重复投递，但下一批的 `## 未结清` 会复认）。要重开：`--status open --note "为什么重开"`。
   - 拿不准 seq 用 `vibepin show --batch <批号>`（逐条带状态）或 `vibepin batches`（批列表 + 未结清数）。
   - **`--seq` 是投递头里的 `n.`**（认领批 1..N），**不是**记录 JSON 里的 `batch.seq`（那是写入批内部的序号；一次 claim 可以合并多个写入批）。

4. **收尾 `vibepin report --batch <批号>`**：这就是**给用户看的对比表**——行数恒等于本批总数，未结清的 seq 带 `!`；**只要还有 `open`/`stale` 行，命令退出码就是 3**（`done`/`wontfix`/`blocked`/`deferred` 不影响退出码）。收尾 = 把表跑干净（退出码 0）、把结论回给用户，然后**再挂一次**（同一个 `<sid>`）。

- **不带 `--queue`/`--session` 的旧命令只收广播**：发给你这个会话的**定向**注记会堆在 `.vibepin/sessions/<sid>.jsonl` 里，`GET /sessions` 的 `pending` 看得见，但**不会唤醒你**。人工取回：`npx vibepin sessions`（列 sid + pending + 最后活动）→ `npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl`。
- **每轮收尾顺手 `claim` 一次**，接住「没挂监听时」发来的注记（输出 `[]` = 没有）。
- 账本只增不减、不入库（`.vibepin/*` 已在 `.gitignore`，含 `batches/`）；`vibepin batches` 看全部批，`vibepin show --batch <批号> --json` 看该批账本原文，`vibepin show --batch <批号> --seq <n> --evidence` 看某条全量载荷。
- 确切命令、租约与判活口径、注记载荷字段表、定位顺序（`source` → `component` + `chain` → `container` → `selector`）、账本/ack/report 的完整口径，见技能 **`skill://vibepin-annotations`**（也落在 `{{PROJECT_DIR}}/.omp/skills/vibepin-annotations/SKILL.md`）；协议全文与迁移见 `{{VIBEPIN_DIR}}/docs/20260919-batch-ledger.md`。
