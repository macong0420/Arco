# Arco

面向 macOS 的 Chromium 桌面浏览器，参考 [Zigzag](https://github.com/macong0420/zigzag) 的 Arc 风格界面重新实现。使用 Electron 45.2.3，每个网页运行在独立的原生 `WebContentsView` 中；侧栏不是网页 iframe 容器。

**这是可运行的首版，尚未实现 Zigzag 全部功能的 1:1 对等。** 下方列出已经实现的功能与主要差异。

## 启动与打包

要求：Apple Silicon Mac、macOS 15.4 或更新版本、Node.js 22+，以及 Xcode Command Line Tools（`swiftc`、`codesign`、`iconutil`）。本次在 Apple Silicon/macOS 27 环境验证。

```sh
git clone https://github.com/macong0420/Arco.git
cd Arco
npm ci
npm start
```

```sh
npm test           # URL、存储、导入、浏览器书签读取、书签合并、密码加密同步
npm run test:e2e   # 真实 Electron 应用，使用临时配置和本地测试网站
npm run pack      # 编译系统认证辅助程序、生成独立图标、打包并本地签名
open dist/mac-arm64/Arco.app
```

源码仓库不包含预构建安装包。执行 `npm run pack` 生成应用后，先正常退出正在运行的旧版 Arco，再打开新构建，即可继续使用原有书签和会话。

产物为 `dist/mac-arm64/Arco.app`。这是本机 ad-hoc 签名，不是 Developer ID 签名或 Apple 公证版。向其他 Mac 分发前，需要自己的 Developer ID、稳定签名及公证流程。工程没有配置发布服务或自动更新服务器。

## 已实现

- Arc 风格彩色窗口、默认 240px 可调整侧栏、30px 标签行、默认三列的常驻网站网格（直接添加或拖入标签、跨空间共享）、嵌套书签文件夹、Spaces、浅色/深色外观及自定义空间颜色。
- 首次启动欢迎引导（复刻 Zigzag）：欢迎页 → 迁移浏览器书签、密码与 Cookie → 从 Chrome 选择迁移扩展 → 选常用网站做常驻磁贴 → 拦截器开关 → 外观与快捷键，完成或关闭即不再打扰；设置 → 关于可重新查看。
- Chromium 网页、地址/搜索命令栏、前进/后退/刷新、标签关闭/恢复、静音、标签排序和移到空间；固定书签的打开、编辑、排序、移动和删除。
- 真实双网页分屏、分屏比例调整、Shift 点击链接 Peek、全部标签页视图、页内查找、历史、下载进度和文件操作；带窗口尺寸的 `window.open` 创建独立窗口；无尺寸、先开空白页再跳转以及 iframe 发起的新标签页通过 Electron `createWindow` 接管原生子 WebContents，保留 `window.opener`、回传消息与自行关闭的能力。
- 密码保存确认、精确来源的显式填充、强密码生成、CSV 导入/导出；显示、复制和填充通过系统认证解锁。
- 书签导入：直接读取本机 Chrome、Edge、Brave、Vivaldi、Opera、Dia、Firefox、Safari、Arc 的书签文件（Chrome 开启账号书签同步时读 `AccountBookmarks`；Safari 与 Chromium 系数据需授予完全磁盘访问权限），也可导入 HTML、Chromium Bookmarks JSON、Arc StorableSidebar JSON 文件；HTML 导出保留空间与文件夹路径。
- 阅读视图（Mozilla Readability）、打印、保存 PDF、网页可视区域截图、Chromium 自带 PDF 查看和开发者工具。
- 每个无痕窗口使用独立内存会话；不写浏览历史、标签会话或密码，也不复用后来新开的无痕窗口的 Cookie。
- 扩展：从 Chrome 应用商店按链接或扩展 ID 安装（走 Google 官方更新接口下载 crx、本机解包后加载），商店页面顶部会注入 Arco 自己的安装栏，地址栏右侧也有安装按钮；工具栏的扩展入口显示图标、版本与启用状态，可停用、启用或移除（停用只卸载，文件仍在）；通过 [electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell) 补齐 Electron 缺失的扩展 API：工具栏图标列表、`chrome.action`/`onClicked`、`chrome.tabs`、`chrome.windows`、`chrome.contextMenus`、`chrome.notifications` 等。点图标即按扩展自己的逻辑执行——声明了 `default_popup` 的弹出它自己的界面，没声明的触发它的 `onClicked`（例如 JSON-handle 会自己 `chrome.windows.create` 开窗口）。仍可加载本地解压扩展。首次引导和设置 → 扩展可按 Chrome 个人资料选择迁移：复制扩展文件到 Arco、实际加载并保存，保留启用或停用状态；逐项报告失败，已有扩展跳过。不会迁移扩展内部设置、API Key 或账号，也不持续跟随 Chrome 更新。

常驻区始终显示“＋ 添加”，可填写名称和网址，也可把标签或固定书签拖到常驻区。常驻磁贴使用实际网站图标，点按会优先切换到当前空间里已打开的同一网页。悬停或键盘聚焦磁贴后，可以使用移除按钮。

右键标签、书签和文件夹可管理静音、固定、重命名和移动。拖动标签可排序或移到空间；拖动到网页可分屏。书签可拖到文件夹、其他书签或空间。快捷键包括 `⌘T`、`⌘L`、`⌘W`、`⇧⌘T`、`⌘F`、`⌘1…9`、`Ctrl+Tab`、`⌘,`。

## 从其他浏览器迁移密码与 Cookie

首次欢迎引导的「把浏览器数据带过来」，以及 **设置 → 书签与导入**，现在提供迁移入口。书签沿用原有导入按钮；Chrome、Edge、Brave、Vivaldi、Opera、Dia 的每个本机个人资料可以分别勾选密码与 Cookie，再点击「迁移所选数据」。这是用户主动发起的本机迁移，不会持续跟随源浏览器同步。

- 系统确认后要求 Touch ID 或系统认证。读取加密数据时，通过 macOS 钥匙串请求相应浏览器的 Safe Storage 密钥；必须由用户批准系统访问提示。受保护的数据文件还可能需要在系统设置中给 Arco 完全磁盘访问权限。
- 使用 SQLite 备份读取包括已提交 WAL 数据在内的快照，不修改源数据库。当前支持 macOS Chromium 的 `v10` 加密，Cookie 数据库版本 24 及之后会校验域名摘要；其他加密格式报告失败，可改用原浏览器导出密码 CSV。
- 密码一次性合并并加密写入现有保险库；按网站来源和用户名去重，保留 Arco 已有密码。导入与其他密码写入排队执行，写入失败保留原保险库。
- Cookie 写入普通浏览会话并刷新到磁盘，保留域名范围、路径、过期时间、Secure、HttpOnly 和 SameSite。已有 Cookie 与过期记录跳过；分区 Cookie 暂不迁移。结果列出导入、跳过、失败数量和原因。
- Cookie 迁移不包含 localStorage、IndexedDB、设备密钥或通行密钥。部分网站仍会要求重新登录，不能保证所有网站的登录状态都能迁移。无痕窗口不能执行密码或 Cookie 迁移。

**Safari / Apple「密码」/ iCloud 钥匙串：** 在 Apple「密码」App 中选择「文件 → 导出所有密码」，或从 Safari 的密码管理中导出 CSV，再通过同页的「选择密码 CSV 导入」。支持 Apple 和 Chrome 的密码 CSV 列名，保留密码首尾空格，已有记录跳过；导入要求系统认证。CSV 是明文文件，请在导入后妥善删除。此构建不直接枚举整个 iCloud 密码库，不迁移 Safari Cookie 或通行密钥。

验证使用临时浏览器资料和测试密钥，覆盖解密、Cookie 域名校验、权限拒绝、SQLite WAL、并发写入、重复导入，以及真实 Electron 中的入口和 Cookie 重启保留；未读取开发者的真实浏览器密码或 Cookie。真实钥匙串授权及各网站登录状态仍需要用户在本机验收。

## 书签与密码同步

在 **设置 → 同步** 选择一个已经由 iCloud Drive、网盘或其他文件服务同步的文件夹。Arco 负责数据合并，文件服务负责传输；点击同步按钮读取已到达本机的其他设备数据。请等文件服务完成传输后，再在另一台设备同步。

### 书签和 Spaces

点击“立即同步书签”。`Arco-Library/` 下每台设备写自己的快照，包含书签、文件夹、共享收藏和空间信息。记录使用更新时间、确定性的冲突规则及删除标记进行合并，设备之间不会直接覆盖同一个快照。

书签文件中的网址和标题是**明文**。本机路径、扩展安装位置、浏览历史、网页 Cookie 和密码不写入书签快照。损坏的远端文件会停止同步，保留原文件和当前本地书库。

### 密码

在同步页输入至少 12 个字符的独立同步口令，点击“创建或解锁并同步”。所有连接同一保险库的 Mac 使用相同口令。首次连接其他设备前，先等待 `Arco-Passwords.json` 和设备快照目录传输完成。

- 使用标准库 scrypt（N=16384, r=8, p=1）和 AES-256-GCM 加密整个密码库，包括网站、用户名和删除标记；每次写入使用新随机 IV。
- `Arco-Passwords.json` 保存加密的保险库引导信息；`Arco-Password-Devices/` 保存每台设备独立的加密快照。
- 同步口令不写入磁盘；派生密钥只保留在内存，解锁 15 分钟后过期，也可以主动锁定。
- 错误口令、认证标签不匹配、损坏文件或保险库变更都会停止操作，保留原有文件。
- 导入同步密码或读取本机密码明文仍需要系统认证。

**请保管同步口令。没有找回或重置口令功能。** 不要删除设备快照或其中的删除标记，否则离线设备的旧数据可能再次出现。首次创建保险库请在一台 Mac 完成后，再连接其他 Mac；云盘自身产生的冲突副本需要保留并人工检查。

这是 Arco 的**加密文件夹同步**，与 Google Chrome 账号同步、原生 iCloud Keychain 同步是不同的功能。已验证同一测试文件夹中的独立设备实例交换与合并；没有两台实际 Mac 的 iCloud 传输验收记录。

## 本机密码保护

`~/Library/Application Support/Arco/Vault.json` 使用 Electron `safeStorage` 加密，密钥由 macOS 钥匙串保护。密码原文、同步口令不会存入书签、设置文件或日志。用户密码的首尾空格会完整保留。

系统认证通过随应用打包的 Swift/LocalAuthentication 辅助程序完成；该程序只处理认证，不接收或返回任何密码。Touch ID 或系统认证取消、失败或不可用时，密码明文操作失败关闭。一次成功认证保持 60 秒。

网页没有 Node 或浏览器界面的调用权限。密码捕获只接受已管理网页的主框架及实际来源；自动填充必须由用户发起，匹配完整协议、主机和端口，并跳过隐藏字段。非本机普通 HTTP 站点禁止保存和填充。

导出的密码 CSV 是明文，需要用户确认与系统认证；请自行妥善保管并安全删除。

本地 ad-hoc 应用重新签名后，macOS 可能再次询问是否允许访问 `Arco Safe Storage` 钥匙串条目；密码操作会等待这个系统提示。此权限应由使用者本人确认，应用不会绕过系统认证。

## 当前验收状态

已通过 42 项基础、同步、浏览器迁移与扩展包测试、17 项端到端检查，包括无尺寸、空白页跳转、iframe 登录标签的 opener 回传与自动关闭、首启引导走完六页且重启后不再弹出、从 Chrome 迁移扩展后实际注入网页（删除源扩展目录并重启后仍生效，保留停用状态，失败逐项报告，移除后可重新迁移）、从商店链接安装扩展并拒绝非商店链接、点扩展图标触发它自己的 `onClicked` 并由扩展自己开窗口、认证等待期间切换标签、无痕窗口隔离、关闭后恢复标签、损坏文件保护和同一进程重新打开窗口时的恢复失败保护。打包应用的真实网页、书签、命令栏和认证辅助程序也有独立检查。

这是开发预览版，最终独立安全复审尚未完成。本机加密密码库及重启读取已有验证；重新签名后的钥匙串访问需要使用者本人授权，Touch ID 的实际批准流程和两台 Mac 之间的 iCloud 文件传输仍需人工验收。

## 与 Zigzag 的差异

| 项目 | Arco 当前状态 |
| --- | --- |
| 界面实现 | 用 HTML/CSS 复刻布局与交互，使用 Electron 原生网页视图；没有沿用 Swift/AppKit 视图代码，不是像素级 1:1 复刻 |
| 浏览内核 | Chromium；体积、内存和更新责任与原版 WebKit 不同 |
| 书签同步 | 新增加密之外的明文书签文件夹同步；原版没有书签/Spaces 跨设备同步 |
| 密码同步 | 加密文件夹同步；当前本地构建没有原生 iCloud Keychain 同步权限 |
| 扩展 | 可从商店按链接/ID 安装（商店自带的“添加至 Chrome”按钮在 Electron 中无效，改用注入的安装栏或地址栏安装按钮），安装前显示扩展请求的权限；通过兼容层支持工具栏图标、`chrome.action`、`chrome.tabs`、`chrome.windows`、右键菜单等；不校验 crx 签名；`chrome.runtime.connectNative`/`sendNativeMessage` 被拒绝（不启动本机原生应用）；`chrome.permissions.request` 一律拒绝；无 Chrome 账号同步、无扩展自动更新、无通用 1Password 桌面原生桥接 |
| 拦截规则 | 仅内置 16 个常见跟踪服务域名后缀，非主文档请求；不是原版约 13 万条 EasyList 内容规则 |
| Arc 导入 | 读取经典容器及 sidebarSyncState/firebaseSyncState 中的空间、固定页、文件夹、收藏和颜色；不导入登录 Cookie 或 SQLite 历史 |
| 其他浏览器导入 | 书签支持 Chrome、Edge、Brave、Vivaldi、Opera、Dia、Firefox、Safari、Arc；Chrome 等 Chromium 系支持用户授权后的本机密码与 Cookie 迁移（macOS v10 加密），已有记录跳过；Safari / Apple「密码」通过 CSV 导入密码，Safari Cookie、通行密钥、浏览历史和持续同步未实现。Chrome 扩展仍可单独迁移 |
| Passkeys | Electron 45.2.3 提供 `app.configureWebAuthn()`，当前 Arco 尚未配置平台认证器。隔离实测：未配置时平台请求持续等待；开启 `platformPasskeys` 后，当前签名/关联域条件下请求以 `ASAuthorizationError 1004` 失败。该原生接入要求应用标识、签名与配置文件，以及依赖方域名的 webcredentials/AASA 关联；仅加 feature 开关或给 App 重签名不能保证 Google 通行密钥可用。尚未完成真实 Google 通行密钥登录验收，可在 Google 页面选择其他验证方式 |
| 翻译、画中画、网页通知深度集成 | 没有保证与原版对等，需分别补充实现和站点验证 |
| DRM、Google 登录和 Chrome Sync | 不附带 Google 私有服务、Chrome 账号同步或 Widevine 授权；网站兼容性需实测 |
| 截图、标签休眠、固定分屏 | 当前截图为可视区域；尚无全页截图、标签休眠或固定分屏恢复 |
| 自动更新、发布 | 未配置更新源、Developer ID 签名、公证或发布；仅生成本机应用 |

## 本地数据和开发验证

普通数据位于 `~/Library/Application Support/Arco`。Library、Session、History 和 Vault 分别保存书签/空间、标签会话、历史和加密密码。JSON 写入使用临时文件加原子重命名；无法读取的数据先保留副本，无法备份时停止写入。

`ARCO_USER_DATA_DIR=/absolute/path npm start` 可以使用独立配置目录。开发测试还可在**未打包版本**同时设置 `ARCO_TEST_MODE=1` 和独立数据目录，使用内存密码库及测试专用检查接口；打包版本忽略该测试开关。`test:e2e` 会自动建立和清理临时目录。

`artifacts/` 中的自动测试图片由界面壳层和实际 Chromium 视图捕获后合成，用于检查布局，不是原项目宣传图或静态网页示意。

上游参考快照：`macong0420/zigzag` 的 `bf1423a2755ab8c539577e4bb53b45a89e808090`。

## 许可

Apache-2.0，保留 Zigzag 作者 Zigao Wang 的归属说明，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。Arco 使用自己的名称和图标，没有复制 Zigzag 商标图标或 wordmark；与 Arc、Zigzag、The Browser Company 均无隶属关系。Readability 的许可见 `resources/Readability-LICENSE.md`。Electron/Chromium 的许可随打包运行时分发。
