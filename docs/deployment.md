# 独立部署说明

截至 2026-10-31：用户在先交付前端后，授权通过 CLI 继续。独立 Cloud Run 服务和 Firestore 已部署。以下步骤可用于复现或后续更新。

- 前端：`https://stonesgate604.github.io/Co-stroke_Wizard-of-Oz/`
- 后端：`https://co-stroke-woz-3u67uf7ieq-uc.a.run.app`
- 项目/区域：`connect-491721` / `us-central1`
- 数据库/服务：`co-stroke-woz`
- 创建会话的管理员密钥只保存在部署机器的忽略文件 `.woz-admin.secret`。

## GitHub Pages

独立仓库：`https://github.com/StonesGate604/Co-stroke_Wizard-of-Oz`。

1. 仓库 Settings → Pages → Source 设为 **GitHub Actions**。
2. 推送 `main`；工作流先执行 `npm ci --ignore-scripts`、`npm test` 和 `npm run build`。
3. 成功后访问 `https://stonesgate604.github.io/Co-stroke_Wizard-of-Oz/`。

不要在原 `co-Stroke` 仓库设置 Pages 或添加新的部署工作流。构建目录仅复制 `public/`、`src/`、`schemas/`、`data/examples/`，不复制会话状态、服务端、密钥、Python 模型或权重。根入口保留 URL fragment 再跳转至 `public/`。

`public/config.js` 的 `syncServerUrl` 已指向独立后端。入口显示会话设置表单，研究者使用管理员密钥创建一对角色链接；收到角色链接的用户直接进入画布。

## 后端部署前检查

需要已启用结算的 Google Cloud 项目、Google Cloud CLI 和 Node.js。先检查当前账号与项目，并记录原服务版本，避免误用项目默认值：

```powershell
gcloud auth list
gcloud projects describe connect-491721
gcloud run services describe co-stroke-model --project=connect-491721 --region=us-central1 --format='value(status.latestReadyRevisionName)'
```

检查时原服务就绪版本为 `co-stroke-model-00001-8km`，超时 120 秒。后续部署只使用新服务 `co-stroke-woz`，不更新此原服务。

创建资源需要 Cloud Run 管理、构建/Artifact Registry、数据库创建、服务账号创建、绑定 IAM、启用 API 等权限。当前账号通过官方权限接口确认了部分创建/更新权限，见 `architecture-audit.md`；Cloud Build 的服务账号、配额、组织策略与结算需在实际部署时再次核对。若 source build 报权限不足，只为错误中指明的构建身份补充必要角色，不改原模型服务运行账号。

## 首次执行独立部署

仓库根目录，PowerShell 7：

```powershell
./scripts/deploy-woz.ps1 -ProjectId connect-491721 -FrontendOrigin https://stonesgate604.github.io
```

脚本将创建独立的 `co-stroke-woz` Cloud Run 服务和 Firestore Native 命名数据库，数据库开启删除保护。运行账号 `co-stroke-woz-runtime` 仅为该数据库获得条件化的 `roles/datastore.user`。

随机管理员密钥保存在忽略文件 `.woz-admin.secret`；通过临时环境文件设置到新 Cloud Run，临时文件随后删除。管理员密钥不进入代码、Pages 或日志输出。脚本默认拒绝更新已存在的同名服务；确认该服务属于本原型后，后续才使用 `-Update`。命名数据库的创建位置不可随意迁移；选择其他区域时需同步检查已有数据库位置。

配置为 `--timeout=3600 --concurrency=20 --max-instances=1 --min-instances=0 --no-use-http2`。最大实例数 1 用于控制原型成本，**不是一致性或持久性方案**；滚动更新仍可能重叠实例，Firestore 事务和监听负责跨实例同步。客户端每 10 秒维护租约，连接丢失会指数退避重连，35 秒无响应则主动重连。

Cloud Run WebSocket 受请求超时限制，最长 60 分钟；必须重连。会话亲和性不能保证始终连回同一实例。见 [Google Cloud WebSocket 文档](https://docs.cloud.google.com/run/docs/triggering/websockets)。本原型因此不依赖亲和性，并禁止在 Cloud Run 使用本地文件存储。

Firestore 的事务在冲突时重试，写入全部成功后才提交；实时监听用于各实例分发快照。见 [事务文档](https://docs.cloud.google.com/firestore/native/docs/manage-data/transactions)、[监听文档](https://docs.cloud.google.com/firestore/native/docs/query-data/listen)、[数据库级 IAM 条件](https://docs.cloud.google.com/firestore/native/docs/manage-databases)。

WebSocket 连接和 Firestore 读写会计费，预览亦产生写入。当前限单对角色、单实例、零最小实例；不提供免费运行保证。结束一轮实验后关闭浏览器连接。

## 接入前端并生成两台电脑的链接

部署输出独立 HTTPS 地址后：

1. `GET /health` 应返回 `service: co-stroke-woz`、`storage: firestore`。
2. 编辑 `public/config.js` 的 `syncServerUrl` 为新 URL，提交到新仓库的 `main`，等待 Pages 成功发布。
3. 打开 Pages。输入管理员密钥，点 **Create session**。分别复制 Participant 和 Wizard 链接发到两台电脑；只给各自角色的链接。
4. 管理密钥只用于创建会话；角色链接不含管理密钥。不要把管理密钥填入 `config.js`、查询参数或 GitHub Actions 公开变量。
5. 前端和后端的 Origin 必须匹配。Pages 的 Origin 是 `https://stonesgate604.github.io`，不含仓库路径。换自定义域名时更新新服务的 `ALLOWED_ORIGINS`。

也可在受控终端中通过环境变量设置 `ADMIN_TOKEN`、`WOZ_SERVER`、`WOZ_FRONTEND`，运行 `npm run session`。输出的角色链接是访问凭据，不要提交。

## 云端验收与复测

1. 两台不同电脑分别打开角色链接，验证人类笔画、AI 请求、Wizard 回应与结束回合同步。
2. 测试橡皮、示例加载、回退、Undo、清空、共享回放与 JSON 导出。
3. 一端断网再恢复；刷新两个页面；未确认操作只执行一次，画布/时间轴一致。
4. 请求期间 Participant 回退，迟到的 Wizard 操作应被拒绝。
5. 在独立服务上部署相同代码的新版本，确认已确认画布、请求与回放位置可恢复。不要在原模型服务上测试重启。
6. 验证超过连接时限后的重连；快速测试可临时把独立服务超时设为 60 秒，完成后恢复 3600。
7. 在测试环境临时允许 2 个实例并强制不同实例接入，验证 Firestore 事务/监听同步后再恢复 1。
8. 核对原服务就绪版本仍为部署前记录值；原 Pages 页面仍可访问。

验收完成情况见 `acceptance.md`。公网双客户端测试与不同实体电脑/不同网络的人工实验需要分别记录。

自动复测使用 `npm run test:cloud`。它只针对显式指定的 HTTPS 后端创建临时会话，凭据与恢复基线保存到忽略文件 `.woz-cloud-test.secret`。设置 `WOZ_PHASE=verify` 验证版本更新后的恢复；`WOZ_PHASE=timeout` 配合新建的短超时测试版本，验证前端 `SessionClient` 自动重连；`WOZ_PHASE=cross` 与 `WOZ_PEER_SERVER` 配合两个不同版本入口，验证跨实例同步。不要在实际参与者的会话上运行破坏性验证。

本次 Firestore 和运行账号首次启用后存在短暂生效延迟，期间创建会话返回 503；等待权限传播后测试全部通过。以后若遇到 503，可在独立服务的 Cloud Logging 中查看 `http-storage-error` / `ws-storage-error`，不要放宽数据库权限到整个项目作为临时绕过。

## 会话与数据保留

没有账号系统。128 条近期操作回执用于去重，完整画布快照用于恢复；这不是实验分析日志。每个角色一次只能有一个有效租约；刷新原标签页接管旧连接，关闭或崩溃后最多 45 秒过期。

会话不会自动清理；预览每个角色只覆盖一份，3 秒后不再渲染。实验结束可导出 JSON，并由项目管理员按会话 ID 删除独立数据库中的对应文档/预览，或使用新的会话链接。删除前检查目标数据库名。角色链接没有自动到期机制，删除会话后失效。
