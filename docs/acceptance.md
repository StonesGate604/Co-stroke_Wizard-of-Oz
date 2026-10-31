# 验收记录

日期：2026-10-31（America/New_York）。用户先暂缓后端，随后授权使用 CLI 部署；独立 Cloud Run 与 Firestore 已上线，并完成以下云端验证。

## 自动检查

`npm test`：9 项通过，1 项 Firestore 模拟器测试跳过，无失败。

| 检查 | 结果 |
| --- | --- |
| 两条真实 WebSocket：人类笔画与临时预览同步 | 通过 |
| 请求 AI、Wizard 响应、服务器强制 AI 作者与粉色 | 通过 |
| 操作回执去重、冲突拒绝、回退截断未来 | 通过 |
| 取消请求/修改历史后拒绝迟到的 Wizard 笔画 | 通过 |
| 共享播放时钟、暂停位置 | 通过 |
| 角色令牌、重复角色占用、租约过期 | 通过 |
| 未确认操作跨客户端刷新恢复，回执防重复 | 通过 |
| 服务器对象重启恢复本地快照 | 通过 |
| 子进程被强制终止后重启，已确认笔画仍保留 | 通过 |
| CORS、管理认证、服务端/状态文件不可经静态路由读取 | 通过 |
| 非法坐标和非法消息 | 通过 |
| Firestore 模拟器 | 本次未启动；由实际独立 Firestore 数据库上的云端测试补充验证 |

`npm run build`：通过，生成静态资源与保留 fragment 的根入口。

`git diff --check`：通过。PowerShell 部署脚本语法解析：通过，未执行部署。

`npm audit`：0 个已知漏洞。Firestore 包间接依赖中的 glob/minimatch 通过 overrides 固定到修复版本；这些辅助工具仍需要在未来升级依赖时重新验证。图标库固定版本并随前端托管，不再加载远程脚本。

可选 Firestore 模拟器测试要求先在本地启动 Google 官方 Firestore emulator，然后设置 `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` 后运行 `npm test`。测试项目硬编码为 `co-stroke-woz-emulator`，普通测试不访问实际云项目。

## 本地浏览器验证

Chrome，两个独立页面：

- Participant 手绘，Wizard 同步出现人类笔画和时间轴。
- AI Continue 后 Wizard 出现请求框、页面标题通知和 Finish AI turn。
- Wizard 手绘响应，Participant 作者栏为 `ai`，时间轴出现 AI 图标。
- 多笔 AI 回合后结束，Participant 可继续绘画。
- 选择第 1 步，两端变为 `1 / 2`；Participant 续画后原 AI 未来被新的 human 笔画替换。
- Wizard 刷新后恢复 `2 / 2` 和正确作者。
- Load 示例同步为 `simple-house` 与 3 笔历史；Wizard 添加 4 笔窗户后，Participant 刷新恢复全部 7 笔及 AI 标记。
- Play 共享回放从第 0 步开始，两端跟随同一时间基准。

实际截图另随交付保存在输出目录 `woz-participant.jpg`。

## 实际云端验证

- 后端：`https://co-stroke-woz-3u67uf7ieq-uc.a.run.app`。
- 独立数据库：`projects/connect-491721/databases/co-stroke-woz`，Firestore Native / `us-central1`。
- `scripts/smoke-cloud.js` 创建专用临时测试会话，经公网 HTTPS / WebSocket 验证管理认证、Origin 限制、Firestore 预览、人类笔画、AI 请求/响应/结束、作者强制、重复去重、冲突拒绝、回退截断、Undo、Clear 与刷新接管。
- 首次启用 Firestore 和 IAM 期间遇到 API/权限传播延迟，等待生效后同一功能测试通过。部署脚本补充了 API 等待和 IAM 并发写入重试。
- 保存了 2 笔画布、步骤和未结束 AI 请求；新版本/新实例启动后完整恢复，版本号与内容一致。
- 将独立服务临时设为 60 秒超时，使用前端实际 `SessionClient` 等待断开。客户端自动重连后，画布、步骤、请求均未丢失；完成后恢复 3600 秒。
- 用临时版本入口将两个角色强制分别连接 `co-stroke-woz-00002-puh` 与 `co-stroke-woz-00003-cis`，实例标识分别为 `402830ddb169ff25` 与 `dc318b6c1fc85fae`。跨实例预览、笔画、回合结束、播放和暂停同步通过，证明不依赖单实例内存。
- 在已发布的 GitHub Pages 上打开两个 Chrome 页面，经 HTTPS/WSS 连接正式 Cloud Run：示例加载、AI 请求提示、Wizard 手绘、AI 作者/时间轴标记、结束回合与 Participant 刷新恢复均通过。最终临时测试会话显示 `8 / 8`，作者 `ai`；另行创建的交付会话保持空白，不与测试数据混用。
- 临时版本入口在测试后移除；正式服务最大实例数配置为 1、最小为 0、并发 20、超时 3600 秒。
- 原模型服务仍为 `co-stroke-model-00001-8km`，超时 120 秒；原仓库 `master` 仍为原检查提交。

## 仍需使用者现场验证

没有两台实体电脑或两个独立网络可供本次自动测试。公网地址、双客户端、跨实例及浏览器交互验证不能替代之后两台电脑的实际用户测试。研究者和 Participant 分别打开交付的角色链接即可执行该项验证。
