# Co-stroke_Wizard of Oz

基于 [StonesGate604/co-Stroke](https://github.com/StonesGate604/co-Stroke) 的独立 Wizard of Oz 双人实时协作绘画原型。正式项目名 **Co-stroke_Wizard of Oz**；仓库名 `Co-stroke_Wizard-of-Oz`。

Participant 使用原有绘画页面；Wizard 在另一浏览器中模拟 AI。**不调用真实模型，也不需要 Python、PyTorch 或模型权重。**

## 当前交付范围

- 独立仓库与 GitHub Pages 前端；原仓库、原 Pages 和 `co-stroke-model` 云服务保持不变。
- 同步画笔、橡皮、作者标记、原时间轴、回放、暂停、回退、Undo、Clear、示例加载和 JSON 导出。
- Participant 点击 **AI Continue**，Wizard 显示明确请求提示并可手绘多笔；点击 **Finish AI turn** 归还绘画权。
- Wizard 笔画由服务器强制标为 `ai`，粉色显示；Participant 页面不含 Wizard 控件。
- 自动重连、刷新恢复、角色占用检查、版本冲突拒绝、操作去重与持久化后确认。
- 已独立部署 GitHub Pages、Cloud Run 和 Firestore。公网双客户端自动测试已通过；实际测试记录见 `docs/acceptance.md`。

## 本地运行

需要 Node.js 22 或更新版本，推荐 24。

```powershell
npm.cmd ci --ignore-scripts
npm.cmd test
npm.cmd start
```

打开 `http://127.0.0.1:8788/public/`，点击 **Create session**。分别打开 Participant 与 Wizard 链接。也可在另一个终端运行 `npm.cmd run session` 生成链接。

本地服务使用 `.woz-data/` 原子快照，刷新和进程重启后保留已确认操作。该目录含角色令牌的哈希与画布，已排除在 Git 中。**仅允许一个本地服务进程使用同一数据目录。**

## 双人操作

1. Participant 绘画；Wizard 实时看到预览与落笔。
2. Participant 点击 **AI Continue**，等待 AI 响应；此时自身画笔暂停。
3. Wizard 看见请求提示，使用原画笔或橡皮响应，可画多笔；Participant 看到 AI 贡献。
4. Wizard 点击 **Finish AI turn**。Participant 可以继续绘画或再次请求。
5. Participant 可取消请求，或操作共享时间轴。历史操作自动取消未完成请求，拒绝迟到的 Wizard 笔画。
6. 回退后续画会截断未来历史；Undo 删除当前可见笔画及其后的未来。Reset 只回到第 0 步，不清空记录。Clear 清空记录。
7. Participant 控制共享回放和时间轴，Wizard 跟随。导出保留当前可见位置和完整现存笔画序列。

每个会话最多一个 Participant 和一个 Wizard。角色链接本身就是访问凭据：分别发送各自链接，不要公开 Wizard 链接。刷新原标签页会恢复身份；换浏览器需关闭原页面并等待最多 45 秒释放角色。

## 同步与恢复

服务器维护唯一权威版本。客户端一次提交一个操作，带唯一 ID 和基准版本；写入成功后确认。重连后先接收权威快照，再核对未确认操作。已保存操作不重复执行；过期操作明确拒绝，避免覆盖另一端的新历史。被拒绝的完整笔画可通过 **Save unsent stroke** 下载。

断线期间停止编辑；未提交的半笔不会进入历史。落笔前收到历史变化时取消半笔。已提交但未确认的操作保存在当前标签页的 `sessionStorage`，刷新后继续核对。最后一份被拒绝草稿也保留在该标签页中。

Cloud Run 模式强制使用独立 Firestore 数据库：事务保存会话、操作回执与角色租约，实时监听把更新分发给各实例。笔画预览单独覆盖保存、3 秒过期，不是历史。回放记录服务器起始时刻和步骤；重连后按同一时钟恢复。既不依赖单实例内存，也不依赖 Cloud Run 临时磁盘。

为保持简单，每会话上限 500 笔、每笔 2048 点、完整记录 700 KB；超限操作拒绝并提示导出。预览限 256 点、最多约 7 次/秒。Cloud Run 的 Firestore 预览写入也会计费。

## 部署与验证

见 [部署说明](docs/deployment.md)、[原架构与隔离检查](docs/architecture-audit.md)、[验收记录](docs/acceptance.md)。

```powershell
npm.cmd test
npm.cmd run build
```

Pages 构建输出 `.pages-build/`，只含公开前端资源。后端使用仓库根目录 Dockerfile。云部署脚本固定使用独立的 `co-stroke-woz` 服务和数据库，不会更新 `co-stroke-model`。

## 代码位置

| 目录 | 用途 |
| --- | --- |
| `public/`、`src/` | 复用的界面、绘画、笔画格式、时间轴与新同步客户端 |
| `server/session.js` | 角色、共享线性历史、回放、AI 回合、冲突与容量规则 |
| `server/store.js` | 本地快照和 Firestore 事务/监听适配 |
| `server/index.js` | HTTP、WebSocket、访问校验、会话与角色租约 |
| `tests/woz*.test.js` | 本原型自动测试 |
| `scripts/build-woz.js` | Pages 静态构建 |
| `scripts/deploy-woz.ps1` | 延后执行的独立 Cloud Run 部署 |

继承的 AI 训练脚本与旧模型测试不参与本原型运行或部署。原项目说明保存在 `docs/UPSTREAM-README*.md`，原部署文档保存在 `docs/UPSTREAM-deployment.md`；它们不是 WoZ 操作指南。上游未提供 LICENSE，本项目未擅自添加授权声明。
