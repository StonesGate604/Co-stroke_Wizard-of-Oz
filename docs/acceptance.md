# 验收记录

日期：2026-10-31。用户已将本次范围调整为代码与前端交付，云端后端延后。

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
| Firestore 多连接事务/监听/新客户端恢复 | 已提供可选模拟器测试，本次未运行 |

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

## 尚未验收

- Firestore 模拟器/实际数据库、不同 Cloud Run 实例之间的实际传输。
- Cloud Run 连接到期、滚动更新/实例重启恢复。
- 两台电脑通过不同公网连接的真实协作。

这些项目需要之后部署独立后端再执行，见部署说明。已实现相关代码和操作步骤，不能将本地快照测试视为云端验收。
