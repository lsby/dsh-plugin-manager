# DSH 插件管理器

一个**独立网页应用**，用于图形化管理 DSH 的插件，并支持**一键重启 / 停止 / 启动** `dsh web` 进程。

零第三方依赖，仅用 Node 内置模块；只监听 `127.0.0.1`。

## 功能

- 列出所有 profile，以及每个 profile 的：
  - **Bundle 层**（`dsh.profile.bundles`，标注「内置」还是「用户安装」）
  - **已安装依赖**（`dependencies`，标注是否同时是 bundle 层、是否被 `cordis.patch.yml` 引用、版本号、安装 spec）
- **安装插件** —— 等价于 `dsh plugin --profile <name> add <spec>`
- **移除插件** —— 等价于 `dsh plugin --profile <name> remove <name>`
- **更新插件** —— 通过 API 支持 `update`（UI 暂未放按钮，可扩展）
- **调整 Bundle 层顺序** —— 上移/下移按钮直接重排 `dsh.profile.bundles`（越靠前越先应用）
- **临时禁用 / 启用插件** —— 向 profile 的 `cordis.patch.yml` 追加
  `{ id, name, disabled: true }` 补丁（仅对生效插件树中有条目 id 的插件可用，如
  `dsh-theme-pink` 的 `theme-pink`）；可一键还原，状态记录在 profile 目录的
  `.dsh-plugin-manager.json` 中
- **一键重启 / 启动 DSH** —— 终止运行中的 `dsh web` 进程，并用**原命令 + 原工作目录**重新拉起
- **一键停止 DSH** —— 只终止 `dsh web`，不重新拉起（之后点「启动 DSH」可恢复）
- **一键打开 DSH 界面** —— 顶栏按钮直接在新标签页打开检测到的 Web 地址（`DSH_WEB_URL` > 进程 `--port` > 默认 3080）
- 操作日志实时流式输出（pnpm 的 stdout/stderr 原样显示）

## 运行

**双击快速启动**：
- **macOS**：直接在 Finder 中双击 `start.command`（会自动打开终端、识别 Node/nvm 环境并在默认浏览器打开界面）
- **Windows**：双击 `start.bat`

**命令行启动**：
```bash
# 在工作目录（dsh-插件管理）内：
node server.js
# 或
npm start
```

默认端口 **3929**，浏览器打开 http://127.0.0.1:3929 。

可选参数：

```bash
node server.js --port 8081     # 指定端口
PORT=8081 node server.js       # 或通过环境变量
```

## 工作方式

| 操作 | 实际执行的命令 / 机制 |
|---|---|
| 安装插件 | `dsh plugin --profile <name> add <spec>` |
| 移除插件 | `dsh plugin --profile <name> remove <name>` |
| 调整顺序 | 直接重写 `package.json` 的 `dsh.profile.bundles` 数组 |
| 临时禁用 | 向 `cordis.patch.yml` 追加 `{ id, name, disabled: true }`（补丁层最后应用，优先生效）；条目 id 通过 `dsh --profile <name> --dump-config` 自动发现 |
| 重启 DSH | 终止 `dsh web` 进程，再用捕获到的原命令 + 原 cwd 重新 `spawn`（detached） |
| 停止 DSH | 终止 `dsh web` 进程，不重新拉起 |

插件状态直接读取 `$DSH_HOME/profiles/<name>/package.json`（`dependencies` 与 `dsh.profile.bundles`），
不解析、不修改 DSH 内部配置，增删完全委托给 `dsh plugin`（pnpm 转发 + bundle 自动 reconcile）。

## 说明与限制

- **重启会短暂中断 DSH**：管理器是独立进程，不受影响；重启后页面会自动轮询直到 `dsh web` 恢复。
- **进程发现**：通过 `ps` 匹配命令行中的 `dsh web` / `--profile web` / `bin.js web`；
  工作目录通过 `lsof` 读取，读不到时回退到管理器自身 cwd。
- **本地路径插件**：`dsh plugin add` 会把相对路径锚定到调用目录，因此请使用**绝对路径**
  （`link:/绝对路径` 或 `file:/绝对路径`），避免锚定到管理器目录。
- **git 插件**：若安装时 pnpm 提示需要 `allowBuilds`，请按日志提示在 profile 的
  `pnpm-workspace.yaml` 里放行后重试。
- 仅监听 `127.0.0.1`，请勿绑定公网地址（无鉴权，可在本机执行任意 pnpm 命令）。

## 项目结构

- `server.js` —— Node 服务 + API（`/api/state`、`/api/plugins`、`/api/reorder`、`/api/disable`、`/api/enable`、`/api/restart`、`/api/stop`）
- `public/index.html` —— 图形界面（单文件，无构建）
- `start.command` / `start.bat` —— 双击快速启动脚本
- `package.json` —— `npm start` 入口
