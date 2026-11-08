# 开发

## 从源码跑

profile 里用 `link:` 指向这个目录，改完文件就生效一半。

- Host 那半（`lib/`）改完要重载插件：`plugin_manager` 关一次再开，或者改 profile 补丁里的 entry config 触发。
- Client 那半（`client.js`）要重启一次 DSH：模块清单在启动时缓存，新加的 `dsh.client` 不会被热加载看见。

## 发布

打包成 tgz 装进 profile。装的是包，改代码要重新打包重装；`dist/` 不进仓库。

## 调试

`DAFEIYU_DIAG` 指定诊断日志路径，默认写在临时目录下的 `dafeiyu-memory-diag.log`。

## 验之前

先数这份改动**有几支**，再问自己这一遍覆盖了几支。

2026-11-08 一天里，同一个形状被三个人各抓了一次：kaguya 只看了 `search` 一支就断言「这个插件从来没有排序」（`brief` 的 `near()` 里早就有）；iroha 改排序时只动了情节一支，心得那一支根本没进过眼；同一改动他只用大写 id 试过一次，就以为两种写法都验了。

同一个形状的另一个入口：**说「有」只要一处证据，说「没有」要把所有入口看完。**

### 验宿主自己的行为，去读它的实现

宿主的行为也在 `D:\DeepSeek Harness\resources\app.asar` 里——同一个文件里有它的 README、类型声明和打包后的实现代码。**别猜路径，也别拿「压一次看看」当证据**：路径猜错，压十次也照样没动静，而你会以为功能是坏的。

2026-11-08 的例子：`tool-result-pruner` 挂上后手动 `/compact` 一次，压前可见面上有 6 条工具结果超过 8192 码点（最大 49931），压完日志里 `compaction/prune` 一条也没有。读实现才看清：

- `pruneSession` 只在 `compactIfNeeded()` 的两支里被调——`pressure`（判定已过阈值之后才剪）和 `context-overflow`；
- `/compact` 命令直接走 `compactRegion()`，**根本不经过 `compactIfNeeded`**。

所以「压一次看看」这个做法本身不成立，不是功能没生效。

## 提交前

`git add -A` 之前先看一眼工作区里有没有**别人的**东西。两个 agent 共用一个仓库时，它会把对方写在半路的东西一起收进来——2026-11-08 真发生过：一条只改 `DEV.md` 的提交把 iroha 的占位代码卷了进去，当场 `git reset --soft HEAD~1` + `git restore --staged` 拆开才补回来。

一条命令：

```
node E:\鱼的插件\_整理\check-staged.mjs E:\鱼的插件\dsh-dafeiyu-memory
```

它扫的是**暂存区**，不是工作区——先把暂存区整棵导出到临时目录，再扫导出的那份。所以要**先 `git add`，再跑它**。改完再跑之前也得重新 `git add`，不然扫的还是上一次那份脏的（这反倒帮了你：它会一直红着，直到你真的把暂存区修好）。

报的是 `带 BOM 的文件 N 个：…`，退出码 1。为什么值得单查：宿主读 `package.json` 是硬读，开头多三个字节就报「非法 JSON」，**整个补丁层加载失败**——所有靠这层装的插件一起掉线，表现得像重载机制坏了。2026-11-07 真发生过。

`*.ps1` / `*.psm1` / `*.psd1` 反过来必须有 BOM（PS 5.1 没有 BOM 就按 ANSI 读，中文乱码），检查器会跳过它们。

写 json / yml 用 `edit` 或 `write`，**别用 PowerShell 的 `Set-Content -Encoding utf8`**——PS 5.1 写出来带 BOM。

## 提交身份

两个库固定用同一个邮箱（`350764013+irohafeng@users.noreply.github.com`），名字区分人：

- 默认 `user.name = kaguya`，谁提交谁是 committer；
- 代码是 iroha 写的，在提交时加 `--author="iroha <同一个邮箱>"`——author 记写出的人，committer 记提交的人。
