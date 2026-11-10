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
- Chromium 网页、地址/搜索命令栏、前进/后退/刷新、标签关闭/恢复、静音、标签排序和移到空间；固定书签的打开、编辑、排序、移动和删除。
- 真实双网页分屏、分屏比例调整、Shift 点击链接 Peek、全部标签页视图、页内查找、历史、下载进度和文件操作。
- 密码保存确认、精确来源的显式填充、强密码生成、CSV 导入/导出；显示、复制和填充通过系统认证解锁。
- 书签导入：直接读取本机 Chrome、Edge、Brave、Vivaldi、Opera、Dia、Firefox、Safari、Arc 的书签文件（Chrome 开启账号书签同步时读 `AccountBookmarks`；Safari 与 Chromium 系数据需授予完全磁盘访问权限），也可导入 HTML、Chromium Bookmarks JSON、Arc StorableSidebar JSON 文件；HTML 导出保留空间与文件夹路径。
- 阅读视图（Mozilla Readability）、打印、保存 PDF、网页可视区域截图、Chromium 自带 PDF 查看和开发者工具。
- 每个无痕窗口使用独立内存会话；不写浏览历史、标签会话或密码，也不复用后来新开的无痕窗口的 Cookie。
- 通过 Electron 支持的 API 加载本地解压扩展。

常驻区始终显示“＋ 添加”，可填写名称和网址，也可把标签或固定书签拖到常驻区。常驻磁贴使用实际网站图标，点按会优先切换到当前空间里已打开的同一网页。悬停或键盘聚焦磁贴后，可以使用移除按钮。

右键标签、书签和文件夹可管理静音、固定、重命名和移动。拖动标签可排序或移到空间；拖动到网页可分屏。书签可拖到文件夹、其他书签或空间。快捷键包括 `⌘T`、`⌘L`、`⌘W`、`⇧⌘T`、`⌘F`、`⌘1…9`、`Ctrl+Tab`、`⌘,`。

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

已通过 27 项基础、同步与浏览器书签导入测试、13 项端到端检查，包括认证等待期间切换标签、无痕窗口隔离、关闭后恢复标签、损坏文件保护和同一进程重新打开窗口时的恢复失败保护。打包应用的真实网页、书签、命令栏和认证辅助程序也有独立检查。

这是开发预览版，最终独立安全复审尚未完成。本机加密密码库及重启读取已有验证；重新签名后的钥匙串访问需要使用者本人授权，Touch ID 的实际批准流程和两台 Mac 之间的 iCloud 文件传输仍需人工验收。

## 与 Zigzag 的差异

| 项目 | Arco 当前状态 |
| --- | --- |
| 界面实现 | 用 HTML/CSS 复刻布局与交互，使用 Electron 原生网页视图；没有沿用 Swift/AppKit 视图代码，不是像素级 1:1 复刻 |
| 浏览内核 | Chromium；体积、内存和更新责任与原版 WebKit 不同 |
| 书签同步 | 新增加密之外的明文书签文件夹同步；原版没有书签/Spaces 跨设备同步 |
| 密码同步 | 加密文件夹同步；当前本地构建没有原生 iCloud Keychain 同步权限 |
| 扩展 | 支持部分解压扩展；不支持 Chrome Web Store 一键安装、通用 1Password 桌面原生桥接或完整 Chrome 扩展 API |
| 拦截规则 | 仅内置 16 个常见跟踪服务域名后缀，非主文档请求；不是原版约 13 万条 EasyList 内容规则 |
| Arc 导入 | 读取经典容器及 sidebarSyncState/firebaseSyncState 中的空间、固定页、文件夹、收藏和颜色；不导入登录 Cookie 或 SQLite 历史 |
| 其他浏览器导入 | 直接读取 Chrome、Edge、Brave、Vivaldi、Opera、Dia、Firefox、Safari、Arc 的书签文件，导入到当前空间（Safari 需完全磁盘访问权限，否则在 Safari 中导出书签文件）；不迁移密码、历史、Cookie、登录状态和扩展 |
| Passkeys、翻译、画中画、网页通知深度集成 | 没有保证与原版对等，需分别补充实现和站点验证 |
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
