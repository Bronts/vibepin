## 注记（vibepin）

<!-- vibepin:session-routing-v2 -->

本项目已接入 vibepin：页面注记（Alt+A 标注元素/区域 + 原话）落到 `.vibepin/inbox.jsonl`（**广播**：所有挂着的会话都收到）或 `.vibepin/sessions/<sid>.jsonl`（**定向**给某一个会话）。协议三步：

1. **开工挂监听**：先确认 daemon 在跑——端口以本项目 `.vibepin/config.json` 的 `port` 为准（`0` = 7331–7370 里第一个空闲，可能不是 7331），用启动横幅或 `curl -s http://127.0.0.1:<端口>/health` 核对，其 `inbox` **必须指向本仓库**（这是"注记没被投到别的项目"的唯一依据）；没有 daemon 就用**受管进程**起（`cwd = 本仓库`，它才会读到 `.vibepin/config.json`）。然后把下面这条作为**后台作业**挂上——等待发生在 shell 进程里（**空闲 0 token**），作业退出即唤醒本会话：

   ```bash
   node {{VIBEPIN_DIR}}/daemon/watch.js --inbox {{PROJECT_DIR}}/.vibepin/inbox.jsonl --queue {{PROJECT_DIR}}/.vibepin/sessions/<sid>.jsonl --session <sid> && node {{VIBEPIN_DIR}}/daemon/claim.js --inbox {{PROJECT_DIR}}/.vibepin/inbox.jsonl --queue {{PROJECT_DIR}}/.vibepin/sessions/<sid>.jsonl --session <sid>
   ```

   `<sid>` = 本会话的短 id，形如 `omp-2f9c1a`（正则 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`）；**定了就一直复用**，每轮 re-arm 用同一个，否则面板上会出现一堆孤儿会话、用户也没法定向。

2. **`watch → claim`**：作业输出就是本批注记（队列批在前、共享批在后、按 `id` 去重）；先 claim 再 re-arm，顺序不可颠倒。
3. **收到后**：改代码 → 验证 → **再挂一次**（同一个 `<sid>`）。

- **不带 `--queue`/`--session` 的旧命令只收广播**：发给你这个会话的**定向**注记会堆在 `.vibepin/sessions/<sid>.jsonl` 里，`GET /sessions` 的 `pending` 看得见，但**不会唤醒你**。人工取回：`npx vibepin sessions`（列 sid + pending + 最后活动）→ `npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl`。
- **每轮收尾顺手 `claim` 一次**，接住「没挂监听时」发来的注记（输出 `[]` = 没有）。
- 确切命令、租约与判活口径、注记载荷字段表、定位顺序（`source` → `component` + `chain` → `container` → `selector`）、以及「新增字段必须同时加进 daemon 落盘白名单」的坑，见技能 **`skill://vibepin-annotations`**（也落在 `{{PROJECT_DIR}}/.omp/skills/vibepin-annotations/SKILL.md`）；升级与未迁移后果见 `{{VIBEPIN_DIR}}/docs/20260918-session-routing-migration.md`。
