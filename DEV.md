# 开发

## 从源码跑

profile 里用 `link:` 指向这个目录，改完文件就生效一半。

- Host 那半（`lib/`）改完要重载插件：`plugin_manager` 关一次再开，或者改 profile 补丁里的 entry config 触发。
- Client 那半（`client.js`）要重启一次 DSH：模块清单在启动时缓存，新加的 `dsh.client` 不会被热加载看见。

## 发布

打包成 tgz 装进 profile。装的是包，改代码要重新打包重装；`dist/` 不进仓库。

## 调试

`DAFEIYU_DIAG` 指定诊断日志路径，默认写在临时目录下的 `dafeiyu-memory-diag.log`。
