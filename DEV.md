# 开发

## 从源码跑

profile 里用 `link:` 指向这个目录，改完文件就生效一半。

- Host 那半（`lib/`）改完要重载插件：`plugin_manager` 关一次再开，或者改 profile 补丁里的 entry config 触发。
- Client 那半（`client.js`）要重启一次 DSH：模块清单在启动时缓存，新加的 `dsh.client` 不会被热加载看见。

## 发布

打包成 tgz 装进 profile。装的是包，改代码要重新打包重装；`dist/` 不进仓库。

## 调试

`DAFEIYU_DIAG` 指定诊断日志路径，默认写在临时目录下的 `dafeiyu-memory-diag.log`。

## 提交前

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
