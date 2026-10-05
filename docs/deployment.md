# GitHub Pages 与模型服务

浏览器绘画、渲染、时间线和 JSON 导出托管在 GitHub Pages。
Python/PyTorch 推理需要单独运行；Pages 不执行 `serve_stroke_model.py`。

```text
访客浏览器 ← GitHub Pages：HTML / CSS / JavaScript
    │
    └─ HTTPS POST /continue → 独立的 Python 模型服务
```

## 当前正式模型

[v0.4.1 Release](https://github.com/StonesGate604/co-Stroke/releases/tag/v0.4.1)
已经包含正式猫类别 `checkpoint.pt`（27,402,013 字节），与本地正式权重一致。
SHA-256：`a925caa81f00a342033cb7e8ed47164af4972ac11a9ce4c66108796ccc124c80`。
此权重是 epoch 12；当前代码还包含后续的采样和几何质量修正。
复现当前表现应使用当前分支代码搭配该 Release 权重，不只下载旧标签源码。
训练数据不需要部署到推理机器，也不放进 Pages 产物。

## 静态站点发布

GitHub 仓库 Settings → Pages → Source 选择 **GitHub Actions**。
`.github/workflows/pages.yml` 会在 `master` 的前端相关文件更新后自动发布。
站点预期地址为 `https://stonesgate604.github.io/co-Stroke/`。

本地生成与线上相同的静态文件：

```powershell
.\scripts\build_pages.ps1
.\.venv\Scripts\python.exe -m http.server 8000 --directory .pages-build
```

访问 `http://localhost:8000/`。构建仅复制 `public/`、`src/`、`schemas/` 和
`data/examples/`，不会复制模型权重、训练数据、虚拟环境或评估记录。

## 接入之后的 Google Cloud 模型服务

本次只发布前端，不创建或部署云端模型。模型机器准备好后：

1. 用当前推理代码和正式 Release 权重运行模型服务。
2. 为服务提供访客浏览器可以访问的 **HTTPS** 地址，并转发 `GET /health`、
   `POST /continue` 和跨域预检 `OPTIONS`。现有 Python 服务返回 CORS 响应头。
3. 编辑 `public/config.js`，将 `modelApiBaseUrl` 设置为该 HTTPS 基地址，例如
   `https://your-model.example`，然后提交；Pages 会自动更新。
   路径前缀也可以保留，例如 `https://your-model.example/api`。
   客户端会在该路径后追加 `/continue`。
4. 从发布后的页面测试真实续画。服务的 `/health` 应报告 v4.1 和 epoch-12。

可用查询参数临时测试地址，而不修改默认配置：
`https://stonesgate604.github.io/co-Stroke/?api=https%3A%2F%2Fyour-model.example`。
配置和查询参数都不是秘密存储位置，不要把服务密钥放进去。

未填写公开模型地址时，在线页面仍可绘画、加载示例、回放和导出，
AI Continue 按钮保持不可用，并显示模型未连接。
本地 `localhost` 或 `127.0.0.1` 页面自动连接 `http://127.0.0.1:8787`。
真实服务失败或超时时显示错误，不自动生成模拟笔画；失败不会删除画布。
请求期间画布被编辑、清空或切换时间线位置时，过期结果不会追加到新状态。

## 验证

```powershell
node --test tests/test_ai_adapter.mjs
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

前者检查连接配置、HTTPS、真实响应、失败与超时，后者检查现有模型管线。
这些检查不能替代生成质量评价；新增模型版本应另外完成质量验收。
