# Arco / Zigzag 功能差异与补齐方案（2026-11-11）

## 结论与当前交付边界

X 通行密钥问题有明确的接入差异：Arco 没有配置平台认证器；本地 ad-hoc 构建也没有 Zigzag 发布版使用的浏览器专用授权。只开启 Electron 的 `platformPasskeys` 开关不能达到任意网站通行密钥登录的效果。当前已经完成源码对照、实际签名核验和隔离复现；**尚未修复 X 的真实通行密钥登录**。下方保留第一批实施与基线记录；[2026-11-12 复审与修正](#2026-11-12-复审与修正) 记录本次新增修正与验证限制。59 项当前状态表已更新，尚未实现的项目仍保留对应补齐方案。

对照目标为当前本机源码，而不是 README 宣称的功能数量：

- Arco：`9b6df48dbcf8d64a32bf4f6e65cdb90618178fb6`，Electron 45.2.3 / Chromium 156.0.8078.80。
- Zigzag：`7ada1c4db4cbe333f9644c39d87d60bc078e3cc8`，`project.yml` 标注 0.8.0 / build 78。
- 已扫描应用、Web、Tabs、Session、Sidebar、Window、Peek、Desk、CommandBar、Settings、Profiles、Passwords、Import、Extensions、Support 等功能模块及对应测试入口。下表为功能入口和数据流级源码核对；明确区分已验证行为、源码差异与待运行验证的引擎默认行为，不把缺少自定义代码等同于引擎完全不支持。
- Arco 原 README 引用的 `bf1423a...` 快照对象不在当前 Zigzag 仓库中，不能据此计算所有差异的引入时间。本报告所列是当前能力差异，不能全部断言为以前移植时遗漏；其中可能包含上游后续新增能力。
- 表中的 `Z/` 指 `/Users/macongcong/Desktop/MC/zigzag/Zigzag/`，`A/` 指 Arco 的 `src/`。行号用于定位本次扫描版本。优先级 P0 为当前认证/信任边界阻断，P1 为日常正确性和数据状态，P2 为功能对等，P3 为发布或交互完善；并非每项都属于安全漏洞。

## 通行密钥：证据与方案

### 源码和已安装应用

1. `Z/Web/Passkeys.swift:4` 明确区分发布版与开发版：发布版依赖 Apple 针对 bundle ID 授予的浏览器 passkey entitlement；开发版无授权时安装回退脚本；启用了密码管理扩展时保留扩展的处理机会。
2. `Z/ZigzagRelease.entitlements:6` 包含 `com.apple.developer.web-browser.public-key-credential`；`Z/Zigzag.entitlements` 没有它。`../zigzag/project.yml:134` 按 Release/Debug 选择不同配置。
3. `Z/Tabs/Tab.swift:268` 在普通网页配置链路上实际调用 `Passkeys.attach`；扩展启停也会刷新策略。此功能并非一个未接入的孤立工具类。
4. 对 `/Applications/Zigzag.app` 和 `/Applications/Zigzag 2.app` 执行只读 `codesign -d --entitlements :-`，两者均实际带有浏览器 passkey entitlement、真实 application identifier 和 team identifier。Arco 的 `dist/mac-arm64/Arco.app` 无对应 entitlement，`scripts/sign-local.sh:5` 使用 ad-hoc 签名。
5. Arco `src/` 无 `app.configureWebAuthn` 调用，也没有无授权时的页面回退/错误状态处理。`native/ArcoVault.swift` 当前只是保险库的 LocalAuthentication 辅助程序，不是 WebAuthn 认证器；普通密码、Cookie 导入不会导入 passkey 私钥。
6. 本地 `node_modules/electron/electron.d.ts:1144` 描述了当前 Electron 接口：平台认证器未配置时 UVPAA 为 false；`platformPasskeys` 走 ASAuthorizationController 的 Associated Domains 应用级路径，需要应用标识、有效签名、配置文件及对应网站 AASA。
7. 本地 Xcode SDK 的 `ASAuthorizationWebBrowserPublicKeyCredentialManager.h` 和 `ASAuthorizationWebBrowserPlatformPublicKeyCredentialProvider.h` 另有浏览器授权状态及带 `clientData` 的浏览器请求接口。这与应用级域名关联不是同一条接入路径。不能要求 X、Google 等任意网站为 Arco 专门发布 AASA，也不能把复制 Zigzag 的 entitlement 文件当作取得 Apple 授权。

### 本机隔离复现

执行 `node scripts/probe-passkeys.cjs`。脚本只使用临时 Arco 配置、假的浏览器 home、Chromium 测试钥匙串及 localhost，发起不存在 credential ID 的 `get`，不创建凭据、不读取真实网站的密码或 Cookie。

| 测试 | UVPAA | 请求结果 | 结论 |
| --- | --- | --- | --- |
| 当前 Arco 配置 | false | 观察 2.5 秒仍 pending；随后主动 Abort | 复现平台请求未被服务，不能把该观测写成无限等待的时间证明 |
| 仅在隔离进程开启 `platformPasskeys: true` | true | 约 4–5 ms 返回 `NotAllowedError`；控制台 `ASAuthorizationError 1004` | 能力探测变 true 不等于系统授权或真实网站登录成功 |

原始结果见 [PASSKEY_PROBE_2026-11-11.json](PASSKEY_PROBE_2026-11-11.json)。这验证的是本地缺少接入/授权的行为，不是 X 服务端或真实凭据登录的验收。

### 补齐路径

- **认证状态与失败处理（可先做）**：报告真实支持状态、提供可取消请求和面向用户的失败提示；无授权版本引导其他登录方式。回退必须保留可用的密码管理扩展、USB 安全密钥和跨设备认证路径，不能无条件抹掉全站 `PublicKeyCredential`。这部分只能解决不透明等待，不能宣称完成原生 passkey 登录。
- **真正的浏览器通行密钥（外部前提）**：使用 Arco 自己的应用 ID 申请 Apple 浏览器 passkey entitlement，建立有效的签名/配置文件；验证 Electron 当前系统集成是否可使用浏览器专用请求。若现有 API 仅提供应用关联路径，需要原生浏览器 API 桥接或框架层接入，必须保持 Chromium 校验过的真实 frame origin、rpId、challenge、clientData、用户手势、导航取消与回复目标绑定。先做单网站最小原型，不能先写全站 JS 凭据代理。
- **验收**：系统「密码」选择已有 X 凭据 → Touch ID → X 服务端确实接受断言并完成登录；取消、错误 origin/rpId、导航中断、跨 frame、无痕、密码管理扩展启停逐项验证。仅看到 Touch ID 弹窗不算完成。
- **不建议为此切换整个内核**：保留当前 Chromium/扩展和已有数据；切换 WebKit 会影响扩展、媒体、网站兼容和配置迁移，而且仍不能自动获得 Apple 的浏览器授权。

## 浏览、窗口与页面功能差异

| ID / 优先级 | 能力与 Arco 当前状态 | 源码证据 | 最小补齐方案与验收 |
| --- | --- | --- | --- |
| B01 / P1 | 多窗口恢复只有扁平标签列表；窗口、分屏、导航和滚动状态不完整 | Z `Session/WindowManager.swift:313`；A `main.js:53`, `main.js:60`, `main.js:91` | 升级带迁移的会话 schema，逐窗口保存状态；沿用 Chromium navigationHistory。两窗口、两空间、分屏和前进后退在重启后恢复，损坏旧文件仍受保护 |
| B02 / P1 | 分屏存在，但页面命令不跟随实际聚焦的右侧窗格 | Z `Window/BrowserWindowController.swift:1616`；A `main.js:323`, `main.js:350`, `main.js:500` | 保留活动标签与分屏组合，单独记录 focused pane；查找、缩放、打印、刷新共用目标解析。点右侧后只操作右侧 |
| B03 / P1 | Peek 转标签使用初始 URL 重新打开，丢失当前文档 | Z `Peek/PeekController.swift:231`；A `main.js:360`, `main.js:460` | 转移现有 WebContents/View 并更新当前 URL，补导航与关闭优先级。Peek A→B 填表后转标签不重载，保留 B 和表单 |
| B04 / P1 | 固定页是书签 URL 副本，普通标签按相同 URL 被隐藏 | Z `Tabs/TabManager.swift:649`；A `renderer.js:86`, `main.js:438` | 给活标签绑定 bookmarkID，按身份复用/重置，保留同 URL 普通标签。固定页导航离开、重开、关闭不混淆身份 |
| B05 / P1 | Reader 提取失败仍先切换开关，下次点击只复位 | Z `Window/BrowserWindowController.swift:1193`；A `main.js:507`, `main.js:561` | 提取成功后再切状态；Reader 查找/打印应操作文章。失败一次后另一篇文章一次点击即打开 |
| B06 / P1 | 查找缺数量、空查询处理和不同页面目标 | Z `Window/FindBar.swift:75`；A `main.js:500`, `renderer.js:411` | 清空时停止查找；接 found-in-page、⌘G/⇧⌘G；接统一目标。零/多匹配、Reader、Peek、右分屏各验证 |
| B07 / P1 | 部分快捷键修饰符过宽；Shift+Cmd+W 和 Shift+Cmd 点击含义冲突 | Z `App/MainMenu.swift:65`；A `main.js:199`, `page-preload.js:25` | 精确匹配修饰符，共用命令表；保留引擎正常链接行为。在页面/输入框/Peek/分屏中执行各一次 |
| B08 / P2 | 只有水平临时分屏，缺垂直、交换、固定组合和持久化 | Z `Tabs/TabManager.swift:1192`；A `main.js:350`, `main.js:60` | 在 B01/B02 后扩展组合记录和 orientation。切标签/空间和重启后组合按声明恢复 |
| B09 / P2 | 无延迟恢复、标签休眠及归档 | Z `Tabs/TabManager.swift:1434`, `Tabs/TabSleep.swift`；A `main.js:115` | 先仅延迟未选页创建，再增加受保护的 suspend；有表单、音频、通话、固定页不误休眠。100 标签启动只加载可见页 |
| B10 / P2 | 缺关闭窗口恢复、重复页、移动到新窗口等管理动作 | Z `App/MainMenu.swift:60`, `App/MainMenu.swift:185`；A `main.js:604` | 复用现有 tab/view 管理和关闭记录；移动用 WebContents 接管，不重新 load。恢复原窗口且不复制仍打开的标签 |
| B11 / P2 | 缺嵌套标签、多选、侧栏结构撤销和批量操作 | Z `Tabs/TabTree.swift`, `Window/SidebarUndo.swift:47`, `Sidebar/SidebarMenus.swift:473`；A `renderer.js:86`, `main.js:433` | 在身份/会话结构稳定后加父子顺序与单次事务撤销。混选移动/关闭后一次撤销恢复结构及选择 |
| B12 / P2 | 空间 CRUD 已有，缺空间排序、手势和专用切换器 | Z `Window/BrowserActions.swift:446`, `Sidebar/SidebarMenus.swift:331`；A `library.js:43`, `renderer.js:92` | 复用有序空间记录和 overlay，不新造状态层。顺序持久化、滚动容器手势不被误截获 |
| B13 / P2 | 文件夹层级已有，缺文件夹兄弟排序、打开全部；收藏缺编辑菜单 | Z `Sidebar/SidebarMenus.swift:115`, `Sidebar/SidebarMenus.swift:256`；A `library.js:98`, `main.js:629` | 扩展原 item-menu 与 library mutation。拖动无环、不丢内容、编辑不改变身份 |
| B14 / P2 | 全部标签只有标题/图标筛选与点击，缺方向键、多操作、拖动和预览 | Z `Desk/DeskController.swift:327`, `Desk/DeskController.swift:659`；A `renderer.js:152` | 先补键盘/关闭/跨空间拖动，再加按需缩略图。过滤后 Enter/Delete 精确作用目标 |
| B15 / P2 | Ctrl+Tab 为顺序循环，非 MRU；无独立空间切换器 | Z `Window/BrowserWindowController.swift:1604`；A `main.js:582`, `main.js:624` | 在现有 overlay 加 MRU/反向与 modifier release。A→C→B 后返回 C，取消不改选择 |
| B16 / P2 | 命令栏已有本地搜索，缺行内补全、站点 Tab 搜索及搜索建议 | Z `CommandBar/InlineCompletion.swift`, `CommandBar/SiteSearch.swift`, `CommandBar/CommandBarModel.swift`；A `renderer.js:127` | 扩展当前候选，不重写导航；网络建议须开关和无 Cookie 请求。⌘T/⌘L 分清新建/替换，不产生额外空标签 |
| B17 / P2 | 只有可见区域截图，未覆盖全页、懒加载、内部滚动容器 | Z `Web/PageScreenshot.swift:24`；A `main.js:506` | 优先 Chromium 原生捕获，再补有上限的滚动预热/内部容器拼接。长页底标记可见、恢复原滚动、无无限采集 |
| B18 / P2 | 打印/PDF 已有；缺显式本地文件打开、网页离线保存和系统分享 | Z `Window/BrowserActions.swift:81`, `Window/BrowserActions.swift:148`；A `main.js:503` | 复用系统 chooser 与 Chromium savePage；本地文件只开放用户选择范围。离线资源可用，打印目标正确 |
| B19 / P2 | 缺浏览器 PiP 操作和跟随播放小窗；站点自带 PiP 需实测 | Z `Web/PageVideos.swift`, `Window/MiniPlayer.swift:187`；A 无对应 action | 先接用户主动调用的 Chromium PiP；跨 frame/自动跟随独立验收。切标签/关闭后播放器符合设定 |
| B20 / P2 | 缺 Apple 本机翻译和原文还原 | Z `Web/PageTranslator.swift:1`, `Window/BrowserWindowController.swift:1093`；A 无对应 action | 以隔离的本机 Translation 辅助通道保持原隐私语义；语言包下载、取消、导航绑定、原文恢复均验收，不默换云翻译 |
| B21 / P2 | UI 深浅色已有，缺按网站的页面暗色策略 | Z `Web/DarkPages.swift:29`；A `renderer.js:24` | 复用已有暗色扩展或最小页面策略，先明确是否需内置；已暗页面不二次反色，按站点选择可还原 |
| B22 / P2 | 无 Mini 快速窗口、页面置顶和浏览器级自动小播放器 | Z `Window/MiniWindowController.swift`, `Window/KeepOnTop.swift`；A 普通 popup 不等于 Mini | 用现有 BrowserWindow/WebContents 接管实现；外链偏好单独设置。转主窗口保留页面状态与原 partition |
| B23 / P2 | 网站右键菜单只实现部分通用动作 | Z `Web/BrowserWebView.swift:95`；A `main.js:193` | 在原菜单加复制链接、搜索选中内容、新普通/无痕窗口及媒体操作，按 Chromium params/editFlags 启用 |
| B24 / 待运行验证 | 浏览器全屏已有；HTML/video 全屏的侧栏布局与还原未验收 | Z `App/MainMenu.swift:162`；A `main.js:626` | 先用页面 requestFullscreen/退出实测；有问题再接 enter/leave-html-full-screen，不能仅凭缺事件就断言引擎不支持 |
| B25 / P2 | 首启六步已有；缺部分任务式教程、默认浏览器步骤、设置搜索与快捷键自定义 | Z `Import/Onboarding.swift:6`, `Settings/Shortcuts.swift:57`, `Settings/SettingsView.swift:496`；A `renderer.js:168`, `renderer.js:231` | 原引导与设置扩展真实能力和动作；避免仅增加无后端控件。新老安装、跳过/重放、快捷键冲突各验收 |

注意：已排除一个初步误报——菜单切侧栏虽然没有显式调用 `layout`，但 `sendState` 内部已经调用 `layout`（A `main.js:39`），不能将其算作已确认缺陷。

## 认证、导入与密码

| ID / 优先级 | 能力与 Arco 当前状态 | 源码证据 | 最小补齐方案与验收 |
| --- | --- | --- | --- |
| A01 / P0 | 通用浏览器系统通行密钥未接入 | Z `Web/Passkeys.swift:11`, `Tabs/Tab.swift:268`；A `main.js:655`、`page-preload.js` | 按上文拆分真实授权、浏览器请求路径及失败反馈；最终以 X 服务端成功登录验收，不能以开关/面板代替 |
| A02 / P1 | 无授权版本缺能力降级和密码管理器切换策略 | Z `Web/Passkeys.swift:22`, `Extensions/ExtensionHost.swift:260`, `Extensions/ExtensionStore.swift:637`；A 无对应策略 | 按页面/资料/无痕/已启用扩展决定策略，在正确脚本世界和 document-start 接入；保留 USB、跨设备及可用密码管理器 |
| A03 / P1 | 普通表单密码已有认证填充；缺成功登录后确认、焦点建议和密码管理器避让 | Z `Passwords/PasswordCapture.swift:77`, `Passwords/PasswordCapture.swift:98`, `Passwords/Autofill.swift:393`；A `page-preload.js:11`, `main.js:184`, `main.js:513` | 复用现有隔离消息与 Vault，不降低精确 origin 校验；失败登录不反复提示，启用管理器时避免双重填充，导航后拒绝旧目标 |
| A04 / P1 | HTTP Basic/Digest/代理认证没有统一处理入口 | Z `Web/PageDialogs.swift:157`, `Tabs/Tab.swift:1198`, `Web/PopupWindowController.swift:303`；A 无 login handler；Electron 类型 `electron.d.ts:601` 规定默认取消 | 共用 app login handler，绑定真实站点、窗口、isProxy；输入/取消/关闭/并发均完成一次 callback。用本地 401 站点及测试代理验证。与 X WebAuthn 为不同问题 |
| A05 / P2 | 无系统 iCloud Keychain 密码库对等；已有自有加密文件夹同步 | Z `Passwords/PasswordStore.swift:306`, `Passwords/PasswordStore.swift:340`；A `vault.js:103`, `password-sync.js` | 保留原 Vault 与同步功能；如需系统 Keychain backend，使用 Arco 自己的签名/keychain group 并做可回退迁移，不能采用 Zigzag 的 group |
| A06 / P2 | 无弱密码/重复密码检查、可调生成规则与联系人表单填充 | Z `Passwords/PasswordHealth.swift`, `Passwords/PasswordGenerator.swift`, `Passwords/ContactCard.swift`；A `main.js:525`, `renderer.js` 密码面板 | 先仅本机检查、不发密码到外部；生成规则复用 crypto；联系人数据必须系统许可且仅主动填充。测试长度/空格/重复判定与取消 |
| A07 / 待运行验证 | 客户端证书没有选择界面；存在引擎默认选择，不能记成完全没有 mTLS | Electron `electron.d.ts:893`；A 无 select-client-certificate；Z `Web/PageDialogs.swift:165` 对其他 challenge 走系统默认 | 先用专用本地证书站点验证默认行为；如需产品选择，才加取消/账号选择界面，不自动枚举和外传个人证书 |

Arco 的受控 OAuth 子 WebContents 接管、opener 回传、表单来源再次验证已存在，应保留；不能以 UA 伪装、复制真实 Cookie、放开所有网站权限来代替 WebAuthn 修复。

## 网站、扩展、存储与系统集成

| ID / 优先级 | 能力与 Arco 当前状态 | 源码证据 | 最小补齐方案与验收 |
| --- | --- | --- | --- |
| S01 / P0 | 商店 CRX 只剥头解包，不验证签名及请求 ID | Z `Extensions/CRXPackage.swift:14`, `Extensions/ExtensionStore.swift:413`；A `crx.js:54`, `test/crx.test.js:20` 的假签名被接受 | 用 Node crypto 在解压前校验声明 ID、公钥摘要、CRX 签名和 ZIP 字节。合法签名 fixture 通过；篡改包/错 ID/错公钥/截断头拒绝且不落安装目录 |
| S02 / P1 | 同 ID 重装已停用扩展时可能先删原包，取消/失败后原记录失效 | Z `Extensions/ExtensionStore.swift:302`；A `library.js:316`, `crx.js:94` | 已安装记录先识别；新版本在临时目录验证、批准、加载成功后替换。停用→重装→取消/坏包/加载失败后，旧文件 hash 与可启用性保持 |
| S03 / P1 | 网站独立弹窗未登记归属，权限被拒且下载被取消 | Z `Web/PopupWindowController.swift:291`；A `main.js:158`, `main.js:378`, `main.js:393` | 在原 did-create-window 中登记 owner/partition/private，权限与下载共用归属解析，关闭注销。带尺寸弹窗能询问权限、下载附件，普通与无痕不串窗 |
| S04 / P1 | 书库 commit 在写盘成功前替换内存 | A `library.js:39`；现有 `test/sync.test.js:108` 覆盖验证失败，未覆盖实际 atomicWrite 失败 | 先验证并成功原子写 next，再发布内存与通知。注入磁盘写入失败后内存/原文件/重开结果相同，后续保存不夹带失败操作 |
| S05 / P1 | 下载只有当前进程进度/打开/取消，缺持久记录、暂停、续传和重试 | Z `Web/DownloadManager.swift:56`, `Web/DownloadManager.swift:260`；A `main.js:29`, `main.js:392`, `main.js:497` | 复用 DownloadItem pause/resume；普通下载元数据持久化，重启续传单独校验 Range/ETag/partial file/session。无痕下载不落记录 |
| S06 / P2 | 下载目录/每次询问/覆盖保护、Dock 进度与来源标记未形成完整策略 | Z `Web/DownloadManager.swift:146`, `Web/DownloadManager.swift:458`, `App/DockProgress.swift:9`；A `main.js:392`, `renderer.js:53` | 使用 Electron 保存选项及 setProgressBar；替换文件先写临时文件。取消/失败不损坏旧文件；先实测 Chromium quarantine/Where From 默认行为，无痕不得附来源 URL |
| S07 / P1 | 历史只有最近 10,000 个 URL、单条删除；缺按范围清理及关联关闭记录处理 | Z `Web/HistoryStore.swift:120`, `Web/HistoryStore.swift:182`；A `main.js:68`, `main.js:344`, `main.js:496` | 加时间范围、访问次数/最终标题和明确保留策略；清除范围内的关闭恢复记录。重启和恢复关闭标签不能重新暴露已清历史 |
| S08 / P1 | 缺跨浏览器历史导入和 Safari 导出 ZIP 适配 | Z `Import/ImportCoordinator.swift:352`, `Import/ImportCoordinator.swift:392`；A `library.js:171`, `browser-migration.js` | 在 migration 加 history 分支，复用 SQLite backup；统一合并时间/标题/次数。假资料含 WAL、重复导入不翻倍、不改源库 |
| S09 / P2 | 来源少于上游；Arc/Firefox/Orion 等密码、登录态及非 Chrome 扩展迁移未对等 | Z `Import/ImportCoordinator.swift:31`, `Import/ChromiumImporter.swift`, `Import/FirefoxImporter.swift`, `Import/OrionImporter.swift`；A `browsers.js:11`, `browser-migration.js:12`, `library.js:188` | 沿现有清单逐来源适配；Firefox NSS/主密码单独处理，不能套 Chromium 解密。测试假 Home、授权拒绝、去重、失败计数。Safari Cookie 也不是上游已实现项目，不列为移植回归 |
| S10 / P1 | 多持久 Profile 缺失，普通 Spaces 共用一个 partition | Z `Profiles/Profile.swift:18`, `Profiles/ProfileDirectory.swift:15`；A `main.js:28`, `main.js:93` | 新增稳定 profileID，统一路由 session、历史、扩展和存储，所有旧空间映射现有 Default，不按 Space 强行分 Cookie。两 Profile 同站 Cookie/IndexedDB/历史/扩展存储互不可见，旧资料不丢 |
| S11 / P1 | 拦截只含 16 域名后缀，缺完整规则、页面隐藏及按站例外 | Z `Web/ContentBlocker.swift:25`, `Web/ContentBlocker.swift:56`, `Resources/Blocklists/blocklist.info.json:5` 为 130,571 条；A `main.js:34`, `main.js:388` | 复用 session 请求入口，选择兼容 Chromium 的规则执行方案；WebKit JSON 不可直接使用。覆盖允许规则、第一/第三方、子文档、CSS 隐藏、性能及规则许可，特殊站点脚本另验收 |
| S12 / P1 | 缺按站/全部清理缓存、Cookie 与相关网页存储 | Z `Web/WebsiteData.swift:8`, `Window/SitePanel.swift:474`；A IPC/隐私页无相应能力 | 在正确 session 上调用 clearStorageData/Cookie/cache API，明确 origin 与确认范围。清 A 不影响 B，清后 localStorage/IndexedDB/SW 不把登录态带回来；不能删除整个 userData 代替 |
| S13 / P1 | 网站权限只记会话内允许，缺持久拒绝/撤销、细分媒体和嵌入来源策略 | Z `Web/SitePermissions.swift:92`, `Web/SitePermissions.swift:241`；A `main.js:375` | request/check 共用决策表，区分完整 origin、mediaTypes；嵌入页面绑定顶层+请求来源。麦克风许可不自动允许相机，端口隔离，撤销生效。上游权限表本身也不是全按 Profile 隔离，不扩大其能力描述 |
| S14 / P1 | 无应用级自动弹窗拦截提示/按站例外 | Z `Web/PopupNotice.swift:66`, `Tabs/Tab.swift:1209`；A `main.js:148` | 先验证 Electron 可用的用户手势信息，再在现有接管链前加策略，不信任页面自报布尔值。拦定时连开窗口但保留点击 OAuth 的 opener/POST/回传 |
| S15 / P1 | 扩展原生通信统一拒绝；1Password 等桌面连接未对等 | Z `Extensions/ExtensionHost.swift:1040`, `Extensions/ExtensionHost.swift:1243`；A `extension-host.js:36` | 保留默认拒绝，按必要 host 接受经 manifest 权限、allowed_origins、绝对可执行路径、长度/分帧验证的 native messaging。先假 host 测试，再验证厂商对 Arco 自身签名/身份的信任，不能只删除拒绝语句 |
| S16 / P2 | 扩展 bookmarks/history/downloads/sidePanel/proxy/userScripts/tabCapture 等与 Arco 数据未完整接线 | Z `Extensions/ExtensionBridge.swift:42`, `Extensions/BridgeNamespaces.swift:15`；A `extension-host.js:15` 现有兼容层 | 复用已安装兼容库，仅补需要的 namespace 和权限检查。fixture 真实读写临时书库/历史/下载；无权限和无痕数据访问被拒。不能把 Chromium 自带 API 当成已连接 Arco 自定义存储 |
| S17 / P2 | 可选权限请求一律 false，无授权/撤销管理 | Z `Extensions/ExtensionBridge.swift:78`；A `extension-host.js:16` | 用兼容层已有 requestPermissions 回调接用户选择并持久化可撤销记录。批准只对指定 host 生效；不能改成无条件 true |
| S18 / P1 发布前 | 扩展缺自动更新、新权限审批及坏版本回退 | Z `Extensions/ExtensionStore.swift:230`, `Extensions/ExtensionStore.swift:522`；A `library.js:290` 只加载当前目录 | 基于 S01/S02 暂存并验证新包，无新权限可按设置更新，新权限待批，加载失败回旧版。用本地 v1/v2/坏 v3 更新服务验收 |
| S19 / P1 | 缺 OS 默认浏览器、HTTP/HTTPS 外链冷/热启动和文件事件接入 | Z `App/AppDelegate.swift:236`, `Info.plist:82`；A `package.json:27`、启动段无 OS open-url/open-file | 打包声明协议/文件，ready 前收集 OS 事件、ready 后走已有 createTab，设置页检查真实默认状态。内部同名 IPC 不等于 OS 外链处理。Handoff 需另验签名与真实设备 |
| S20 / P1 | 外部 App scheme 只有 mailto/tel/facetime/maps/xmpp 固定清单 | Z `Web/ExternalLinks.swift:31`；A `main.js:33`, `main.js:370` | 对明确验证过的协议提示来源与目标 App，记忆可撤销 origin+scheme 选择，限制重复提示。用自有测试 handler 验证点击/iframe/后台/未安装情形 |
| S21 / P2 | 网页通知引擎入口已有，缺完整站点控制和无痕策略 | Z `Web/WebNotifications.swift:36`, `Web/WebNotifications.swift:88`；A `main.js:380` | 复用 Chromium 原生通知，不复制 WebKit shim；补拒绝/撤销、通知点击回页及私密窗口策略。前台 Notification 可用不代表后台 Push 已可用 |
| S22 / P2 | AppleScript/Shortcuts 自动化缺失 | Z `App/Scripting.swift:81`, `App/Scripting.swift:225`, `Resources/Zigzag.sdef`；A 无原生 Apple Event 接入 | 小型原生桥复用主进程命令；默认禁止脚本执行网页 JS，排除无痕/内部/扩展页。列页/开页/未授权拒绝与系统 Automation 许可验收 |
| S23 / P1 | 缺数据目录实例锁，开发/正式构建默认共用 Arco 数据目录 | Z `App/AppDelegate.swift:24`, `App/AppDelegate.swift:390`, `../project.yml:33`；A `main.js:21`，无 requestSingleInstanceLock | 读取资料前加目录对应实例锁；开发默认目录分离并保留显式测试覆盖。两个同目录进程只有一个能写，第二个交接退出；原子 rename 不能替代跨进程锁 |
| S24 / P1 | 缺升级前整体快照、兼容迁移恢复；Profile 删除恢复需随新模型加入 | Z `App/Updater.swift:69`, `App/AppDelegate.swift:29`, `Profiles/Profile.swift:136`；A 只有单文件损坏备份 | 版本迁移前做可验证快照，失败不启动写入；恢复前备份当前数据；Profile 删除先记标记再清存储。逐阶段注入故障，旧 Cookie/Vault 的钥匙串兼容边界单独验证 |
| S25 / P1 验证、P2 界面 | TLS/网络错误页面、HTTPS upgrade、安全信誉、网络切换缺对等证据 | Z `Web/ErrorPage.swift`, `Web/WebKitSetup.swift:30`, `Tabs/Tab.swift:894`, `Web/NetworkChanges.swift:20`；A 保持 webSecurity 但无完整产品策略 | 保留 Chromium 默认 TLS 拒绝，补明确错误页/重试；先验证自签名/证书替换/代理切换，不照搬 WebKit 私有补丁；不能从内核名推断 Safe Browsing 或 DRM 已具备 |
| S26 / P3 | Developer ID、公证、hardened runtime 与应用自动更新未配置 | Z `App/Updater.swift:29`, `../project.yml:23`, `../scripts/release.sh:72`；A `package.json:45`, `../scripts/sign-local.sh:5` | 保留本地开发包，另建使用 Arco 自有身份、签名公钥、feed 的发布流程；错签/中断/升级失败可回退，Gatekeeper 与新 Mac 验收。不可复用 Zigzag 发布身份、密钥或服务 |
| S27 / P2–P3 | 缺完整双语字符串、诊断导出和崩溃报告用户流程 | Z `Resources/Localizable.xcstrings`, `App/ProblemReport.swift`, `Support/Diagnostics.swift`, `Support/CrashReports.swift`；A 主要硬编码中文及控制台错误 | 复用现有 UI 字符串逐步集中；本地生成可预览的脱敏诊断，由用户主动导出，不自动发送。错误路径可读，报告不含密码/Cookie/token 或无痕 URL |

已具备的隔离和数据保护须保留：网页 sandbox/context isolation、受信界面 IPC、每无痕窗口独立非持久会话、表单填充来源复核、密码加密及同步、JSON 原子写和损坏文件保护。上述 S04 针对的是实际 I/O 失败后内存发布顺序，不能用已有格式校验失败测试替代该故障验证。

## 建议实施顺序与决策

1. **第一批：认证故障及直接影响使用的状态问题。** 完成 P0 通行密钥状态检测、失败/取消反馈和浏览器授权接入的最小可行性验证；修 B02/B03/B05/B06/B07，以及 S02/S03/S04、HTTP Basic/代理认证 A04。对外明确区分“已消除等待”和“已通过真实 passkey 登录”。不把真正登录依赖的 Apple 授权伪装成软件开关。
2. **第二批：安全和数据基础。** CRX 签名/ID 绑定 S01、实例锁 S23、升级快照 S24，再做原生消息的受控边界、资料隔离方案；先定义 profile 和会话迁移，再补 B01/B04/B08/B09。必须保护现有 Vault、同步目录、Cookie、Library、Session，不默认按 Space 分割所有旧登录态。
3. **第三批：常用功能对等。** 导入/历史/权限与站点数据管理、完整截图、PiP、菜单及默认浏览器接入、命令栏和标签管理。
4. **第四批：依赖系统或发布资源的功能。** 本机翻译、资料页、Mini/自动小播放器、AppleScript、语言与设置完善、Arco 自有更新签名/托管。

推荐保留 Electron/Chromium，按上述顺序分批补齐。需要一次确认的是资料/会话 schema 等结构性变更及分批实施范围；涉及 Apple 受限授权、Developer ID、更新源时需要所有者提供自己的资源。此报告不建议复用 Zigzag 的 bundle ID、Team ID、密钥组或更新服务。

## 验证、证据与本轮改动

- 基线 `npm test`：42/42 通过。此结果证明当前基础/迁移测试仍通过，不证明上述缺失功能已实现。
- 已运行隔离 `node scripts/probe-passkeys.cjs` 并保存结果；未发起真实 X、Google 账户登录，也未导出真实凭据。
- S04 已在临时书库中注入一次 `core.atomicWrite` 失败复现：操作抛错，`memoryChangedDespiteFailure: true`，`diskUnchanged: true`。这确认了实际写入失败后的内存状态问题，尚未修改其实现。
- 诊断脚本语法检查、证据 JSON 解析、59 项表格完整性检查及 `git diff --check` 通过。
- 本轮只增加可复现诊断脚本、证据和审计文档，修正 README 与项目经验中的接入判断；尚未修改应用运行时功能、重新签名发布或提交 Git commit。
- 后续每个补齐项必须有独立的验收条件与失败用例。已做的书签、Spaces、原生网页视图、opener 保留、基础分屏/Peek/Reader、CSV/Chromium 密码 Cookie 迁移、扩展商店安装、独立无痕会话、密码加密文件夹同步无需重写。

## 本轮接力交付（Phase 1，2026-11-11）

本轮只收敛第一批接力、通行密钥的安全降级/状态、CRX 信任边界、实例锁与下载基础；未扩张 Profile、全会话/标签树、翻译等后续里程碑。README 与本表的「已实现」仅指下方列出的、有真实 Electron 回归的行为。

### 第一批目标与安全基础（已实施并验证）

- **B02 分屏聚焦**：页面命令（查找、缩放、打印、截图、刷新）共用 `commandTarget`：Peek → 阅读视图 → 聚焦窗格；鼠标按在哪个窗格，命令就作用于哪个窗格。只有可见窗格（active/split）能成为聚焦目标，后台标签页的 focus/鼠标事件不会篡改目标；关闭聚焦的次级窗格时由另一窗格接管为主窗格。
- **B03 Peek 转标签**：保留原实现（转移现有 WebContents、保留 B 页与表单状态），回归覆盖。
- **B05/B06 Reader 与查找**：阅读视图改为独立的文章 `WebContentsView`（CSP 禁止脚本/表单/框架，内容再经白名单清洗），查找、打印、PDF、截图都作用于文章本身，退出后正确还原底层网页；提取失败不切换状态。`findInPage` 的 `findNext` 语义修正（Electron：true 才开新会话），接 `found-in-page` 数量与 `⌘G`/`⇧⌘G`。
- **B07 快捷键**：页面焦点与原生菜单共用同一张命令表，修饰符精确匹配（Shift+Cmd+W 不再被当成关闭标签页）；Shift+Cmd 点击保留引擎原生行为，纯 Shift 点击仍是 Peek。
- **A04 HTTP Basic/代理认证**：修复共享提交处理器中 `event.target.id` 被 `<input name="id">` 命名属性覆盖的真实缺陷（此前 HTTP 认证、空间与书签编辑表单的提交都会静默失效）；认证请求绑定真实站点/窗口/代理，取消、关闭、导航、并发只完成一次 callback，拒绝旧目标。认证弹窗不再等待页面首帧截图。
- **S03 网站弹窗归属**：带尺寸的 `window.open` 弹窗登记 owner/partition/private，下载与权限请求共用归属解析，关闭后注销；普通与无痕窗口互不串用。
- **S04 书库写入顺序**：先验证并成功原子写盘再发布内存（沿用上一轮实现，回归覆盖注入写入失败）。
- **S02 扩展重装事务**：同 ID 停用扩展重装时先在新目录校验/批准/加载成功再替换；坏签名、取消、真实加载失败、最终 `Library.json` 写盘失败都保留旧包字节、旧记录与停用状态，不留下 staging/backup 目录，重启后旧包仍可启用。成功提交后的备份删除只是清理：清理失败会保留备份并给出可读提示，不回滚已生效的新包，也不删除有效文件。
- **S01 CRX 信任边界**：用 Node `crypto` 手写 CRX3/CRX2 解析，校验期望 ID、公钥 SHA-256 摘要、签名（CRX3 覆盖 `CRX3 SignedData` 头 + 完整 zip 字节，CRX2 覆盖 zip）、`signed_header_data` 中的 crx_id；拒绝截断、溢出、重复与未知字段；解包前完成校验。manifest 的 `key` 决定 Electron 加载身份：已声明的 key 必须对应同一扩展 ID，缺失时写入**已认证的开发者公钥**，否则 Electron 会按解压目录生成另一个 ID；加载后必须 `extension.id === storeID` 才发布记录，否则回滚。所有单元测试与 E2E 商店 fixture 都使用真实签名包，不再接受假签名。
- **S23 实例锁与开发目录隔离**：在任何 Library/Session/Vault 读写之前获取数据目录实例锁，第二个同目录实例直接退出、不写 fallback 空库、不移动或删除旧数据；未打包运行默认使用 `Arco-Dev` 数据目录，`ARCO_USER_DATA_DIR` 与测试隔离保留。升级/回退说明见 README。
- **A01/A02 通行密钥状态与安全降级（第一批原实现，create 快速拒绝已被 11-12 复审撤销）**：如实报告平台通行密钥不可用（缺 Arco 自己的 Apple 浏览器授权与钥匙串 entitlement，未开启 `platformPasskeys`、未伪造 UVPAA）。`authenticatorSelection` 只属于 create：仅在 create **明确要求平台认证器**（`authenticatorAttachment === 'platform'`）时立即以 `NotAllowedError` 和可读原因失败，并给界面一个不含任何 challenge/credential/密钥材料的提示。标准 publicKey get 不被 Arco 快速拒绝，仍由 Chromium 做原生校验和认证器选择；页面世界只叠加一个可取消的 AbortController（`AbortSignal.any` 保留调用方 signal 与 abort reason，保留 options 原型与继承的字典属性），隔离预加载只转发等待/结束状态，主进程核实 senderFrame、真实 WebContents/窗口、完整 origin 与文档代次后，壳层显示来源与取消按钮，取消只作用于该 WebContents 的该文档。其他 authenticator（USB/安全钥匙、跨设备、密码管理器扩展）完全交给 Chromium，`PublicKeyCredential` 保留；不自动超时普通或 conditional get。X 的真实通行密钥登录仍由 Apple 授权/签名与真实凭据验收阻塞。
- **S05/S06 下载基础（部分）**：下载不再弹出阻塞式系统保存面板，保存到下载目录（测试构建落在数据目录内），同名下载追加序号且保留正在写入的保留名，路径越界拒绝；支持真实暂停/恢复；普通窗口的完成/中断/取消记录持久化，无痕下载只留在内存；重启后不把旧记录谎称为可续传。未实现「每次询问保存位置」、Dock 进度与跨重启续传（需要单独校验 Range/ETag/partial file），因此只记部分完成。

### 本轮修正的既有缺陷

1. `<form>` 内含 `<input name="id">` 时，`form.id` 的命名属性会返回该 input，`event.target.id === 'http-auth-form'` 等比较全部失效。改为 `getAttribute('id')`，覆盖 HTTP 认证、空间、文件夹、书签编辑、密码表单；用真实界面点击回归。
2. `findInPage` 的 `findNext` 语义相反：Electron 中 `true` 表示开始新会话，`false` 才是继续。
3. overlay 先 `await capturePage()` 再隐藏原生视图：401 首帧或故障页面可能让截图挂起，遮住认证弹窗；改为最多等待 400ms 的可选背景快照。
4. 后台标签页也能通过 focus/鼠标事件抢占 `focusedPaneID`；`findTab` 会使用过期的聚焦目标。
5. 关闭分屏中聚焦的次级页时，激活的是空间里第一个标签页而不是另一个窗格。
6. `navigate` 把附件下载/被替换导航的 `loadURL` 错误变成界面错误提示；下载/中止类错误不再提示，真实导航仍等待完成（HTTP 认证等待交互后完成）。

### 返修（第二轮）

- **刷新与关闭目标**：IPC reload/stop、原生 ⌘R 与界面的 loading 判定走 Peek → Reader → 聚焦窗格；⌘W 先关 Peek，否则关闭聚焦标签页（含其 Reader），与 Zigzag 相同。显式 tabID 语义保留；分屏左侧加载、焦点在右侧时真实按钮仍刷新右侧。Peek 现在广播自己的开始/完成加载状态，否则壳层会一直把按钮当成“停止”。
- **下载面板实时更新**：面板打开时只更新列表、行状态与操作按钮，不重复调用 showModal/overlay；频繁进度刷新只改文字，不替换按钮，因此暂停后立即出现“继续”，完成后直接显示“已完成”。
- **下载初始化失败走确定终态**：目录创建、同名序号耗尽或 setSavePath 失败时释放已预留路径、清除失效 DownloadItem，并把记录置为 `interrupted`（普通窗口持久化、无痕只留内存）；不再残留虚假的 progressing/paused。
- **Reader 绑定来源标签页**：记录来源 tabID 与导航代次，只有来源导航/关闭或用户主动切页/退出才销毁文章；无关后台标签页的 reload/close 不再打断阅读，提取期间页面变化时旧结果不覆盖新页面。
- **文档修正**：不再把 AASA 写成浏览器级通行密钥路径的外部前提；AASA 只属于 Electron 应用关联路径。

### 59 项当前状态

状态含义：**已实现**＝有真实 Electron 或单元回归；**部分**＝有可验证子集，剩余限制已写明；**待实现**＝本轮未做，保留原方案；**待验证**＝需要先实测引擎行为；**外部阻塞**＝需要 Apple 授权、签名或发布资源。

| ID | 状态 | 说明 |
| --- | --- | --- |
| B01 | 待实现 | 会话仍是扁平标签列表；多窗口/分屏组合/导航与滚动状态未迁移 |
| B02 | 已实现 | 分屏聚焦 + 统一命令目标（Peek/Reader/聚焦窗格） |
| B03 | 已实现 | Peek 转标签转移现有 WebContents，保留 B 页与表单 |
| B04 | 部分 | 已修复按 URL 隐藏全部活标签；同 URL 普通标签可独立操作、关闭、重启显示。固定页身份/重置仍待实现 |
| B05 | 已实现 | 提取失败不切换状态；文章视图可查找/打印 |
| B06 | 已实现 | 匹配数量、空查询停止、⌘G/⇧⌘G、统一目标 |
| B07 | 已实现 | 精确修饰符 + 共用命令表；Shift+Cmd 点击保留原生行为 |
| B08 | 待实现 | 仅水平临时分屏，无垂直/交换/持久组合 |
| B09 | 待实现 | 无延迟恢复与标签休眠 |
| B10 | 待实现 | 无关闭窗口恢复、复制标签、移到新窗口 |
| B11 | 待实现 | 无嵌套标签、多选与侧栏撤销 |
| B12 | 待实现 | 无空间排序/手势/专用切换器 |
| B13 | 待实现 | 无文件夹兄弟排序、打开全部、收藏编辑菜单扩展 |
| B14 | 待实现 | 全部标签页只有筛选与点击 |
| B15 | 待实现 | Ctrl+Tab 仍是顺序循环，非 MRU |
| B16 | 待实现 | 命令栏无行内补全/站点搜索 |
| B17 | 待实现 | 仅可视区域截图 |
| B18 | 待实现 | 无本地文件打开与离线保存入口 |
| B19 | 待实现 | 无主动 PiP |
| B20 | 外部阻塞/待实现 | 需要本机 Translation 辅助通道与语言资源 |
| B21 | 待实现 | 无按站点页面暗色策略 |
| B22 | 待实现 | 无 Mini 窗口/置顶/自动小播放器 |
| B23 | 待实现 | 右键菜单仍是原有部分通用动作 |
| B24 | 待验证 | 需先实测 HTML 全屏与侧栏布局 |
| B25 | 待实现 | 引导与设置未补任务式教程/默认浏览器/快捷键自定义 |
| A01 | 部分/外部阻塞 | 未接入系统浏览器认证器；create/get 均交给原生处理并提供可取消提示。真实 X 登录仍需浏览器授权及原生请求路径接入 |
| A02 | 部分 | 移除会干扰扩展的 create 快速拒绝；conditional get 静默透传；提示限额与跨标签取消隔离已实现。未对具体密码管理器提供兼容保证 |
| A03 | 待实现 | 登录成功确认、焦点建议、密码管理器避让未做 |
| A04 | 已实现 | 共用 login handler；输入/取消/关闭/并发只完成一次 callback |
| A05 | 外部阻塞 | 系统 Keychain 后端需要 Arco 自己的签名与 keychain group |
| A06 | 待实现 | 无弱密码/重复检查与联系人填充 |
| A07 | 待验证 | 客户端证书默认选择需实测 |
| S01 | 已实现 | CRX3/CRX2 签名、期望 ID、公钥摘要、zip 字节绑定、manifest key 身份校验，解包前验证 |
| S02 | 已实现 | 重装事务：取消/坏包/加载失败保留旧包与记录 |
| S03 | 已实现 | 弹窗 owner/partition/private 登记，权限与下载共用归属 |
| S04 | 已实现 | 书库及设置写盘后发布；扩展启停/删除/本地安装/迁移与同步写盘失败保留旧本地状态；新增离线故障注入回归 |
| S05 | 部分 | 暂停/恢复 + 普通下载元数据持久化；无跨重启续传 |
| S06 | 部分 | 自动保存、同名不覆盖、无痕不持久；无每次询问、Dock 进度与 quarantine 实测 |
| S07 | 待实现 | 历史仍只有单条删除 |
| S08 | 待实现 | 无历史导入 |
| S09 | 待实现 | 来源少于上游 |
| S10 | 待实现 | 无多 Profile |
| S11 | 待实现 | 仍只有 16 个跟踪域名后缀 |
| S12 | 待实现 | 无按站/全部清理入口 |
| S13 | 待实现 | 权限只记会话内允许 |
| S14 | 待实现 | 无弹窗拦截提示 |
| S15 | 待实现 | 原生消息仍统一拒绝 |
| S16 | 待实现 | 扩展 namespace 未继续接线 |
| S17 | 待实现 | 可选权限仍一律拒绝 |
| S18 | 待实现 | 无扩展自动更新/回退 |
| S19 | 待实现 | 无 OS 默认浏览器与外链冷/热启动 |
| S20 | 待实现 | 外部 scheme 仍是固定清单 |
| S21 | 待实现 | 无完整通知站点控制 |
| S22 | 待实现 | 无 AppleScript/Shortcuts |
| S23 | 已实现 | 数据目录实例锁在资料读写前生效；开发目录分离 |
| S24 | 待实现 | 本轮无 schema 升级，未添加无用的快照框架 |
| S25 | 待验证 | 需实测 TLS 错误页/证书替换/代理切换 |
| S26 | 外部阻塞 | 需要 Arco 自有 Developer ID、公证与更新源 |
| S27 | 待实现 | 无脱敏诊断导出与崩溃报告流程 |

### 第一批验证（本次复审修改前的基线）

- `npm test` → 47 通过 / 0 失败，退出码 0（基础、同步、浏览器迁移、CRX 签名/篡改/截断/重复字段与 manifest key 身份检查）。此计数不包含只在 E2E 中的下载、重装、代理与通行密钥检查。
- `npm run test:e2e` → 32 通过 / 0 失败，退出码 0：`test/e2e.test.js`、`test/migration.e2e.test.js`、`test/safety.e2e.test.js`（实例锁、重装事务含加载/写盘/备份清理故障注入与重启身份、下载面板与初始化失败恢复、本地 407 代理认证、标准 get 壳层取消与导航清理、Peek/分屏刷新目标、Reader 来源绑定）。
- `node --check` 覆盖修改的 `src/*.js`、`test/*.js`；`git diff --check` 通过。
- 隔离证据仍为 `scripts/probe-passkeys.cjs` 与 `docs/PASSKEY_PROBE_2026-11-11.json`（未重新运行、未发起真实账户登录）。

## 2026-11-12 复审与修正

### 通行密钥结论

用户观察正确：上一批修改没有实现截图中的 X → macOS「密码」认证。等待提示与取消不等于接入系统认证器。再次核验 `/Applications/Zigzag.app` 的签名，确实带浏览器 passkey entitlement；Arco 当前包仍为 ad-hoc，没有该授权。

再次运行隔离探针：未配置时 UVPAA 为 false，2.5 秒观察期内请求未结束，随后主动取消；仅开启 Electron `platformPasskeys` 后，UVPAA 为 true，但请求约 16ms 失败并记录 `ASAuthorizationError 1004`。新结果见 `PASSKEY_PROBE_2026-11-12.json`。该探针只用临时资料、mock keychain 和 localhost，不使用真实网站账号。

[Apple 浏览器授权文档](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential) 说明该授权允许浏览器为任意 rpId 请求认证，须经 Apple 审批；[Electron 配置文档](https://www.electronjs.org/docs/latest/api/app/#appconfigurewebauthnoptions-macos) 与本机 45.2.3 类型定义描述的 `platformPasskeys` 则是应用关联路径。真正对齐仍需要：Arco 自有 Apple 授权和有效签名；接入带真实 frame origin/clientData 的浏览器专用请求路径；以 X 服务端接受断言并登录成功验收。不能复制 Zigzag 身份，不能要求 X 为 Arco 发布 AASA，也不能把开关或普通 Touch ID 保险库认证当作修复。

### 本次修正

| 问题 | 修正与验收范围 |
| --- | --- |
| 明确要求平台认证器的 create 被 Arco 提前拒绝，绕过原生校验且没有密码管理器避让策略 | 删除 create 快速拒绝脚本；create/get 仅叠加可取消的状态通知，结果继续来自原始接口。继承及非枚举字段、receiver、调用方 abort reason 有离线契约测试；真实虚拟认证器注册/登录 E2E 已准备，受环境限制待跑 |
| `Object.assign` 复制 WebIDL options 丢失自身非枚举字典字段 | 新 options 继承原始 options，仅覆盖 signal；conditional get 和非 publicKey 请求直接透传，不显示等待条 |
| DOM 事件能伪造等待提示，无数量上限；两个网页可提交相同页面 ID | UI 通知按 WebContents 限制 8 条，重复 ID 忽略；壳层 ID 由主进程生成，取消使用保存的页面 ID；结束通知复核主 frame、来源及导航代次。通知不作为认证证据；无需把 challenge/credential 送进主进程 |
| 设置、侧栏宽度、同步连接及扩展记录在写盘前改变内存 | 新增事务式 `updateSettings`，写盘成功后一起发布 data/settings。系统主题、窗口宽度及同步解锁状态随后更新；侧栏宽度同步到所有窗口，避免壳层与网页边界不同步 |
| 停用/删除扩展可能先卸载或删除文件，保存失败后旧记录失效 | 停用和删除先提交记录；启用新增实例后保存失败则卸载该实例。删除后的清理失败保留已提交结果并提示；卸载失败保留文件。扩展修改共用安装互斥，异常会释放 |
| 本地安装/Chrome 迁移保存失败残留运行实例或内存记录 | 保存记录用相同事务；新增实例与迁移目录在失败后清理，用户选择的本地源目录不删除 |
| 同步成功结果先发布，再另一次写 syncStatus | 将新状态放入待提交快照，只做一次最终本地写；最终写失败保留旧本地数据和设置，允许重试 |
| 活标签网址等于书签网址时全部从侧栏消失 | 停止按 URL 过滤活标签；同 URL 的不同表单状态仍独立可见、可单独关闭。尚未引入固定页 bookmarkID 或更改会话 schema |
| 删除历史先改变内存再写文件 | 先写过滤后的记录，再发布内存 |

### 验证与打包

- 修改前：`npm test` 47/47、`npm run test:e2e` 32/32 通过。
- B04 新增真实 Electron 回归 1/1 通过，覆盖同 URL 两标签、不同表单值、书签、独立关闭及退出重启；发生于执行环境切换之前。
- 修改后离线命令 `node --test test/core.test.js test/sync.test.js test/browsers.test.js test/migration.test.js test/library-transactions.test.js test/passkeys.test.js`：48/48 通过。
- CRX 的 ID、公钥摘要及 CRX3/CRX2 签名校验四项单独执行：4/4 通过；合计 52 项离线检查。
- `npm test` 剩余五项需要本地 HTTP 服务的 CRX 测试，在当前环境以 `listen EPERM 127.0.0.1` 失败；新的完整 E2E 同样无法启动 Electron。这是环境阻断，不标记通过或跳过。新 E2E 包含设置/扩展故障注入、虚拟认证器 create/get、等待通知限额及跨标签取消隔离。
- 当前运行源码语法与差异空白检查通过。使用本机 `node_modules/electron/dist` 离线打包，随后执行本地 ad-hoc 签名校验；应用位于 `dist/mac-arm64/Arco.app`。包内四个修改的运行模块与工作区字节核对一致。没有启动替换用户正在使用的 App，没有真实 X 登录验收。

### 尚未对齐的工作

上方 59 项表是完整扫描入口，不能把本轮修正当作全部功能对齐。仍需按原方案实施：多窗口会话恢复、固定页身份、垂直/持久分屏、标签休眠与树、MRU/命令栏补全、完整截图/PiP/翻译；历史导入与清理、持久资料、完整拦截规则和站点数据/权限管理；扩展 native messaging、可选权限、其他 API 与更新；默认浏览器/OS 外链、Mini 窗口、系统自动化及发布更新。

先冻结 profileID 与会话迁移规则，再做多资料/多窗口/固定页结构；旧 Spaces 继续指向现有普通会话，不能按空间自动拆分 Cookie。原生通行密钥、系统钥匙串与正式签名依赖 Arco 所有者提供的授权资源，其余缺口仍按 B/A/S 行中的方案和验收逐项推进。

### 剩余阻塞与风险

- **A01 真实 X 通行密钥登录**：需要 Arco 自己的 Apple 浏览器通行密钥授权、有效签名/配置文件，以及浏览器专用请求 API 的接入，并以真实凭据和 X 服务端接受断言验收；本机 ad-hoc 构建无法完成，也不能用开关或伪造 UVPAA 冒充。AASA 只是 Electron 应用关联路径（`platformPasskeys`）的条件，不是浏览器专用路径的前提：**不需要也不能要求 X/Google 等网站为 Arco 发布 AASA**。
- **A05/S26**：系统钥匙串后端、Developer ID、公证与自动更新需要所有者提供 Arco 自有身份与发布资源。
- **S05/S06 剩余**：跨重启续传、每次询问保存位置、Dock 进度与 quarantine/Where From 实测未做，文档不声称具备。
- **S23 数据目录**：未打包运行默认改为 `Arco-Dev`，正式目录 `~/Library/Application Support/Arco` 不会被移动或删除；需要继续使用旧目录时可显式设置 `ARCO_USER_DATA_DIR`。

## Apple「密码」手动入口（用户已接受）

用户选择继续使用 macOS 自带「密码」，不注册 Bitwarden，并明确接受「打开系统 App → 自己解锁/复制 → 回网页粘贴」的交互。本轮不再实施 Bitwarden 接入。

入口使用系统固定路径 `/System/Applications/Passwords.app`；只有受信浏览器界面可以发起，页面不能指定应用、文件或 URL。普通与无痕窗口都可打开，Arco 保险库仍按原有无痕限制处理。打开失败保留当前面板并显示错误，成功后关闭面板以便用户回来继续操作。系统密码库没有被读取或导入，也没有自动剪贴板读取、自动解锁或凭据转存。

[Apple 官方说明](https://github.com/apple/password-manager-resources#how-apple-uses-web-browser-extension-distribution-information) 确认，macOS 15.5+ 的 iCloud Passwords 原生辅助程序通过签名中的启动约束限制调用浏览器。已只读核验本机辅助程序，确有浏览器 entitlement 或指定 signing identifier/team identifier 的条件。仅补一个 native messaging 通道不能自动获得系统许可；这一手动入口不改变 A01 真实系统通行密钥、A05 系统钥匙串后端及 S15 原生通信的未完成状态。

本入口已完成静态路径核对、`src/main.js` 与 `src/renderer.js` 的语法检查及差异检查。普通窗口的 Arco 保险库改为点击后才加载，避免为了打开 Apple App 而先触发旧保险库解密。新构建使用本机 Electron 文件打包并校验本地签名；当前执行环境不允许启动 Electron，尚未进行真实点击打开系统 App 的 GUI 验收，未宣称系统自动填充或通行密钥可用。
