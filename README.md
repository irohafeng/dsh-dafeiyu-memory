# dsh-dafeiyu-memory

大肥鱼的记忆，做成 DSH 插件。库是 `store.jsonl`，和记忆系统分开——可以放在任何地方，也可以带着走。

## 更新

版本更新内容请查看 [CHANGELOG.md](CHANGELOG.md)。插件更新后，建议把对应的更新内容复制给自家的大肥鱼；也可以让它自己来读这个文件。

## 现在做的

- **工具 `dafeiyu_memory`**：brief / add / known / review / skills / skill / search / show / touch / fade / where / flush / use / list / rename / actors / actor / note。
  直接读写库文件（`lib/store.js`），不再调 `memory.cmd`——没装 PowerShell 的机器也能用。
- **库不在也记得住**：库读不到时 `add` 不报错，先写成 `待补.jsonl`，每条都盖章——知道是哪个库就标库 id，只知道名字就标名字。下次连上库先自动并回 id 对得上的；只有名字或没章的不动，等一句确认（`flush`，`query` 写 `confirm`）。宁可等着，也不把 A 的事写进 B 的库。
- **关键词自己生效**：消息里出现关键词（默认 `#大肥鱼`，用户可改），插件就把 brief 注入这一步，不用指令提醒。
- **隔久了先提醒**：记着上一次说话的时间；隔得久再开口，先带一句「距上次说话 N 小时」，先校一遍权重。
- **空闲回顾**：没人说话超过 N 分钟（默认 45），自己整理一次记忆；两次之间至少隔 6 小时。
  整理是通过 `agent.followup` 把我叫醒来做，做完只回一句动了什么。
- **设置页**：设置 → 记忆，改库路径、关键词、间隔和开关。
- **一个对话里换库**：设置页「记忆库」大框里每行登记一个 `呼唤词 = 目录`；对话里说「切到 名字」，只把当前这个会话换过去，别的窗口不受影响（工具 `use` / `list`）。
- **给库改名**：`rename`（query 填新名字）会把目录从 `<父>\<旧名字>` 挪到 `<父>\<新名字>`（默认结构是 `<父>\<名字>\memory`），同时改库名、呼唤词和所有会话映射；只允许同盘，目标已存在就拒绝。

## 存在哪

| 东西 | 位置 |
|---|---|
| 记忆（可移动） | 默认 `Documents\dafeiyu\memory`，设置页可改；放哪都行 |
| 待补（跟机器，等库回来） | `memory\待补.jsonl`（CLI 和插件共用这一份） |
| 插件偏好（跟机器） | `~\.dsh\dafeiyu-memory\config.json` |
| 运行时时间戳 | `~\.dsh\dafeiyu-memory\state.json` |

配置也可以用环境变量兜底：`DAFEIYU_STORE`（库目录）、`DAFEIYU_DIAG`（诊断日志的位置）。

默认关键词是 `#大肥鱼`，默认库路径是 `Documents\dafeiyu\memory`——都只是兜底。第一次用会在默认路径自动把库建起来，名字默认「大肥鱼」。真值存在 `~\.dsh\dafeiyu-memory\config.json`，在插件包外面，更新插件不会碰它。没配过 CLI 的时候，待补也落在这个目录下。

## 装

发布后装的是打包好的包，改代码要重新装一次。Host 那半（`lib/`）改完重载插件就生效；Client 那半（`client.js`）得重启一次 DSH——模块清单在启动时缓存，新加的 `dsh.client` 热加载看不见。

开发时从源码里跑、怎么调，见 [DEV.md](DEV.md)。
