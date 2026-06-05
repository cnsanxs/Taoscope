# Taoscope

[English](README.md) · **中文**

为 **TDengine 3.x** 打造的、键盘友好的桌面管理工具。

底层 Tauri 2（Rust 壳）+ React 18 —— 一个体积小巧的原生二进制，通过 REST API 直连 TDengine，提供你期望从现代 SQL 工作台得到的所有效率界面，并针对时序场景做了专门优化（super table、child table、tag 等）。

> [!IMPORTANT]
> **安装包尚未签名 —— 首次安装时各系统都会弹安全告警。** 别慌，绕过一次以后再也不会拦你。
>
> - **macOS** —— 把 app 拖到 `/Applications` 后，在 Terminal 跑一次：`xattr -dr com.apple.quarantine /Applications/Taoscope.app`（不做这一步，macOS Sonoma+ 会直接拒绝打开并提示 *"Taoscope.app 已损坏"*）。详见下方的 [macOS Gatekeeper](#macos-gatekeeper)。
> - **Windows** —— SmartScreen 蓝屏对话框：点 **更多信息（More info）** → **仍要运行（Run anyway）**。
> - **Linux** —— `.AppImage` 文件 `chmod +x` 后直接跑；或者 `sudo dpkg -i` / `sudo rpm -i` 安装包。
>
> 之后应用内的自动更新不会再触发任何这类告警。

<p align="center">
  <img src="docs/images/ui.png" alt="Taoscope 主窗口" width="900">
</p>

<p align="center">
  <img src="docs/images/ui-chart.png" alt="Taoscope 折线图视图" width="900">
</p>

## 功能

### 连接与资源

- **多连接工作区** —— 并列管理多个 TDengine 集群；在线/离线状态提示;每个连接行显示紧凑的 `WS` / `HTTP` 徽章,传输方式一眼可见;每个连接独立刷新。支持 **HTTP REST 或原生 WebSocket** 传输、**Basic 或 token** 认证、可选 TLS(含跳过证书校验的逃生口)。瞬时 ws 断连(服务端 idle timeout、taosAdapter 重启、短暂网络抖动)会自动恢复:重连进行中徽章变琥珀色 + 旋转,下一笔查询成功后回到默认。
- **可视化表设计器** —— 在树上右键即可新建数据库 / 超级表 / 普通表 / 子表，编辑列与 tag，或删除对象；表单下方实时预览将执行的 SQL，确认后再运行。
- **树形资源面板** —— Connection → Database → STable / Table → 内联展开 **Columns & tags** 与 **Child tables**，每个节点都有统一的 `⋯` / 右键操作菜单。删除连接会级联清除其下控制台与保存状态。展开状态跨重启保留。
- **双击子表**即可打开（或复用）该数据库的控制台，自动把 `SELECT * FROM <子表>;` 追加到编辑器并执行 —— 一眼扫数据零键盘操作。
- **schema 缓存** —— 每次输入触发补全也不会反复打后端。

### SQL 控制台

- **每个 workspace 多控制台** —— 各自绑定连接 + 默认库，内联重命名，重启不丢。
- **CodeMirror 编辑器** —— TDengine 定制方言（精简关键字集，没有 MySQL 那一堆冗余），语法高亮、行号，13 px 等宽 UI 字体。
- **Schema-aware 自动补全** —— 解析当前语句的 `FROM` 子句，**只**给出那张表的列 + tag；无法识别时静默退回到关键字。
- **运行模式** —— 选区 / 光标处语句 / 整个 scratch，统一 `⌘↵`。
- **光标处智能执行** —— 单行语句首次 `⌘↵` 直接执行；多行语句首次按下时**先高亮完整语句**（识别字符串与注释，`'…'` 或 `-- …` 里的 `;` 不再误切）并提示 toast，**再按一次** `⌘↵` 才真正执行。按 `Esc` 可取消高亮，继续编辑也会自动失效；手动选区仍是一段式执行。
- **读 + 写 + DDL** —— `SELECT`、`INSERT`、`CREATE` / `ALTER` / `DROP`、`DELETE`、`SHOW`、`DESCRIBE` 都能跑；写/DDL 语句返回「影响 N 行」，`DROP` / `DELETE` 执行前二次确认。
- **EXPLAIN** 光标处语句；**取消**长查询；**per-connection 超时**。
- **格式化、注释切换、复制行向下、历史导航** —— 快捷键与 JetBrains / VS Code 一致。
- **行数封顶** —— 防止 `SELECT *` 意外拉百万行；一键"显示全部"放开（仅对 `SELECT` 注入上限，其它语句原样执行）。

### 查询结果

- **表格 / 折线图切换** —— 同一份结果集既可用虚拟化网格浏览，也可一键切换为折线图渲染，**共用同一份内存数据**，不会额外往后端打一次。切换入口在左侧浮动胶囊，水平方向与上方编辑器的行号槽对齐成一根连续轨道。
- **虚拟化网格**（TanStack Table + Virtual）—— 几百万行也能丝滑滚动；右键菜单（复制值 / 复制行 TSV / 复制行 JSON / 复制列名）合并到行级别，滚动开销极低。
- **可排序 / 可调宽列**，按列复制名/值，**CSV** + **JSON** 导出。
- **行内过滤**，跨全部列。
- **时区选择器**位于 Consoles 面板标题栏 —— TIMESTAMP 列渲染、CSV / JSON 导出、复制到剪贴板都跟随所选时区（默认 `跟随系统`，可切 `UTC` / `+08:00 上海` / `+09:00 东京` / `+05:30 加尔各答` / 自定义 `±HH:mm`）。排序仍按 epoch 时间顺序，不受显示时区影响。**1.3.x 行为变化**：旧版本时间戳硬编码为 UTC，新版本默认为系统本地时区 —— 想恢复旧行为请在选择器中切到 `UTC`。
- **智能折线图** —— X 轴自动锁到主时间戳；Y 候选按类型（FLOAT/DOUBLE 优先）、数值变化幅度、非空率、字段名暗示（`temp|humid|volt|count|...` 加分，`id|seq|idx` 减分）综合打分，默认勾选「最像业务指标」的那一列。设置弹窗里可叠加多选画多线。
- **字符串数字也认**：TDengine BIGINT 通常以字符串形式返回，分析器对每个 cell 做防御式数字强转，遇到杂质（非数字字符串）就放弃整列，绝不抛错。
- **双 Y 轴自动启用**：当被选中的 Y 系列量级差 >10×（例如温度曲线 + BIGINT 计数器）时自动拆成左右两根 Y 轴，小量级指标不会被大量级压扁成一条直线。
- **光标锚定时间缩放**：滚轮 / 触控板缩放以光标 x 位置为锚点，灵敏度针对 **Mac 触控板**做了下调（echarts 默认在多事件滑动下手感过猛）。底部 dataZoom 滑块始终可用。
- **空态保留表头** —— 0 行结果也能看到列结构。
- **每个控制台独立历史**（最近 50 条），落盘到本地 SQLite。

### 应用外壳

- **自绘 TitleBar**：macOS 原生红绿灯；Win/Linux 下提供最小化 / 最大化 / 关闭。
- **紧凑暗色主题**：Linear / Vercel 风格调色板，TDengine 绿（`#06A77D`）作为主色；固定 `color-scheme`，原生控件在浅色 / 深色系统下渲染一致。
- **English / 中文** 界面切换。
- **右键菜单全局统一字号密度**。

### 自动更新

- **应用内升级**：`tauri-plugin-updater` + GitHub Releases。启动时静默检查；状态栏右下角检测到新版会变绿色 `v1.x.y · install`。
- **ed25519 签名** —— 客户端用绑定的公钥拒绝任何被篡改的更新包。
- 发布操作手册见 [docs/RELEASE.md](docs/RELEASE.md)。

## 安装使用

每个发版的预编译包都在 [Releases 页面](https://github.com/cnsanxs/Taoscope/releases/latest)。

| 平台 | 文件 | 首次安装 |
| --- | --- | --- |
| **macOS Apple Silicon** | `Taoscope_*_aarch64.dmg` | 见下方 [macOS Gatekeeper](#macos-gatekeeper) |
| **macOS Intel** | `Taoscope_*_x64.dmg` | 见下方 [macOS Gatekeeper](#macos-gatekeeper) |
| **Windows** | `Taoscope_*_x64-setup.exe` | SmartScreen → "更多信息" → "仍要运行" |
| **Linux .deb** | `Taoscope_*_amd64.deb` | `sudo dpkg -i Taoscope_*.deb` |
| **Linux .rpm** | `Taoscope_*.x86_64.rpm` | `sudo rpm -i Taoscope_*.rpm` |
| **Linux 通用** | `Taoscope_*_amd64.AppImage` | `chmod +x` 后直接运行 |

装好之后，后续所有版本都由应用内 updater 接管，不需要再来 Releases 页面下载。

### macOS Gatekeeper

目前 macOS 包暂未配置 Apple Developer ID 代码签名。在 **macOS 14（Sonoma）及之后**，系统会以 **"Taoscope.app 已损坏，无法打开"** 直接拒绝未签名应用 —— 以前"右键 → 打开"那个绕过办法**在新系统上已经失效**。

把 app 拖进 `/Applications` 之后，在终端跑一次：

```bash
xattr -dr com.apple.quarantine /Applications/Taoscope.app
```

这条命令从 app 包里递归剥掉 Gatekeeper 检查的 `com.apple.quarantine` 扩展属性。之后双击正常启动，并且通过 updater 升级的新版**不会再触发**这个警告。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 壳 | [Tauri 2](https://tauri.app)（Rust） |
| 前端 | React 18 + Vite + TypeScript（strict） |
| UI | [shadcn/ui](https://ui.shadcn.com) + Tailwind + Radix |
| 编辑器 | CodeMirror 6 + `@codemirror/lang-sql`（自定义 TDengine 方言） |
| 表格 | TanStack Table + TanStack Virtual |
| 状态 | Zustand |
| 存储 | SQLite（rusqlite）—— workspace + 连接记录 |
| 网络 | reqwest 走 TDengine REST `/rest/sql/<db>`，或 `taos` crate 走 WebSocket |
| 包管理 | pnpm |

## 前置要求

- **Node** ≥ 20
- **pnpm** ≥ 9（`npm install -g pnpm`）
- **Rust** stable，通过 [rustup](https://rustup.rs)
- **macOS**：Xcode Command Line Tools（`xcode-select --install`）
- **Linux**：`libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev`

跑 `pnpm tauri info` 检查环境。

## 本地开发

```bash
pnpm install
pnpm tauri dev          # 推荐：Tauri 完整壳（Rust + React）
pnpm dev                # 仅前端 + 模拟数据源，不连真实 TDengine
```

`pnpm dev` 调 UI 最快，走的是 mock 数据源。`pnpm tauri dev` 是测试真实查询、updater、TitleBar 的时候用。

### 常用脚本

| 命令 | 用途 |
| --- | --- |
| `pnpm tauri dev`   | 原生窗口 + Vite dev server |
| `pnpm dev`         | 纯 Vite + mock 数据源，跑在 `http://localhost:1420` |
| `pnpm build`       | `tsc` 类型检查 + Vite 生产构建 |
| `pnpm tauri build` | 构建可分发桌面包 |
| `pnpm typecheck`   | `tsc --noEmit` |
| `pnpm lint`        | ESLint 扫 `src/` |
| `pnpm format`      | Prettier 格式化 |
| `pnpm bump <kind>` | 同步升 `package.json` + `Cargo.toml` + `tauri.conf.json` 三处版本号，刷新 `Cargo.lock`，提交并打 tag `v<x.y.z>` |

## 发布

推一个形如 `v1.0.1` 的 tag → [`.github/workflows/release.yml`](.github/workflows/release.yml) 自动多平台构建 + 签名 + 把草稿 Release 推到 GitHub，并附带应用内 updater 用的 `latest.json`。完整流程（签名密钥生成、Secrets 配置、每次发版 checklist）见 [docs/RELEASE.md](docs/RELEASE.md)。

简版回顾：

```bash
pnpm bump patch                      # 1.0.0 → 1.0.1，自动 commit + tag
git push --follow-tags origin main   # main + 新 tag 一次推完 → CI 起跑
```

## 项目结构

```
.
├── src/
│   ├── components/
│   │   ├── console/       # 编辑器、结果网格、自动补全、历史、运行逻辑
│   │   ├── layout/        # TitleBar、ResourcesPanel、StatusBar
│   │   ├── keyboard/      # 全局快捷键
│   │   └── ui/            # shadcn 原语
│   ├── datasource/        # DataSource 接口 + Tauri 实现 + mock
│   ├── lib/               # cn()、updater store……
│   ├── store/             # zustand store
│   └── App.tsx
├── src-tauri/
│   ├── src/
│   │   ├── commands.rs    # Tauri 命令边界
│   │   ├── datasource/    # SQLite store + http_client（REST）+ ws_client（WebSocket）+ 共享 sql_builder
│   │   └── lib.rs
│   └── tauri.conf.json
├── scripts/bump-version.mjs
├── .github/workflows/     # release.yml
└── docs/RELEASE.md
```

## 状态

- **1.2.x**：读 + 写/DDL 执行、可视化表设计器、WebSocket 传输、token 认证、TLS、查询取消/超时、EXPLAIN、中英文界面均已就位。连接记录（含密钥）存放在本地 SQLite workspace 文件——早期的 OS keychain 保险箱试用后已回退（dev 模式签名摩擦）；编辑对话框留空密码表示「保留原值」，密钥不回传 UI。
- **代码签名证书暂未配置** —— macOS / Windows 首次启动的一次性绕过步骤见上方[安装使用](#安装使用)章节。应用内 updater 处理后续所有版本的就地升级，不会再触发同样的提示。

长尾增强候选（TLS、查询取消、WS 协议等）见 [FEATURES.md](FEATURES.md)。
