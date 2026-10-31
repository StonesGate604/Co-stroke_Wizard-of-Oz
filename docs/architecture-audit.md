# 原架构与隔离检查

检查日期：2026-10-31（America/New_York）。

## 原仓库

- URL：`https://github.com/StonesGate604/co-Stroke`
- 默认分支：`master`
- 检查的提交：`f17cc2162eeb4f18ea4c471ff38048b94fc816fe`
- 原生 HTML/CSS/ES modules；无前端打包器。
- `DrawingInputController` 记录归一化坐标、时间和压力。
- `stroke-format.js` 使用 `co-stroke.json` v0.1、独立 author/style/timing/points/metadata。
- `TimelinePlayer` 和 `TimelineView` 已提供渲染、步进、回放和拖拽定位；原 app 在回退续画时截断未来。
- 原 AI 路径：`ai-adapter.js` → 独立 Python 推理服务器；WoZ 的 app 不导入该适配器。
- 原 `.github/workflows/pages.yml` 监听 `master`，用 GitHub Actions 发布静态资源。
- 原仓库 `public/config.js` 的模型地址为空；仓库内无 Dockerfile、Cloud Run 清单或 Google 部署工作流。

## 实际云服务（只读检查）

Google Cloud 项目 `connect-491721`（Myserver）有现有服务：

| 配置 | 检查值 |
| --- | --- |
| 服务名 | `co-stroke-model` |
| 区域 | `us-central1` |
| URL | `https://co-stroke-model-3u67uf7ieq-uc.a.run.app` |
| 就绪版本 | `co-stroke-model-00001-8km` |
| 请求超时 | 120 秒 |
| 执行环境 | gen2 |

GitHub 连接返回原仓库 admin/push 权限。Google Cloud 官方 `testIamPermissions` 接口确认当前账号具备 `run.services.create`、`run.services.update`、`datastore.databases.create`、`iam.serviceAccounts.create`、`resourcemanager.projects.setIamPolicy`、`serviceusage.services.enable`。这不是对尚未创建资源、构建配额、组织策略或结算可用性的保证。

用户随后明确要求暂不部署云端。未创建或修改 Cloud Run、Firestore、IAM、API 开关或计费资源。

## 隔离措施

- 从原提交建立独立 Git 副本，保留来源历史。
- 新 origin：`https://github.com/StonesGate604/Co-stroke_Wizard-of-Oz.git`，分支 `main`。
- 原仓库只保留为 `upstream-readonly`，push URL 设置为 `DISABLED`。
- 新 Pages workflow 只发布新仓库。
- 独立前端配置 `syncServerUrl`；不使用原模型服务。
- 后端部署脚本固定新服务、新运行账号、新命名数据库，并拒绝默认更新已有同名服务。
- 不复用原 Cloud Run 运行账号、容器、流量或状态。
- 原仓库及原服务只做读取，没有提交、推送、配置修改或新版本部署。

## WoZ 取舍

保留现有线性截断历史；Participant 负责时间轴，Wizard 跟随，减少双人同时拖拽造成的冲突。AI 回合期间只有 Wizard 可画，Participant 可取消或修改历史。服务器仍对每次写入执行版本检查，迟到写入不会静默覆盖。

浏览器保留原 TimelinePlayer 渲染和 TimelineView 交互。共享播放以持久化的起点和服务器时间驱动原播放器 `seek`；不在每个客户端分别启动原本地定时器，避免两端漂移。
