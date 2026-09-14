# dsh-session-check

[English](README.md) | 中文

**只读**诊断工具：告诉你哪些已存储的 DeepSeek Harness 会话会被格式迁移拒绝，以及**被哪一道闸门拒绝**。另带第二个命令 `dsh-projcache`，用于回收会话投影缓存占用的空间。

作者 [@Robin1987China](https://github.com/Robin1987China)

两个命令，两个承诺：

| 命令 | 承诺 |
|---|---|
| `dsh-session-check scan` | **只读**：哪些会话会被格式迁移拒绝，各自卡在哪道闸门 |
| `dsh-projcache survey` | **只读**：投影缓存里存了什么，有多少可回收 |
| `dsh-projcache apply` | 写入——所有护栏通过后才写，且逐文件留备份 |

## 本工具诊断的症状

**中文：** 升级后老会话打不开 · 侧栏列得出来但点开就失败 · 升级后历史像没了 · `SessionFormatUnsupportedMigrationError` · `source v0 artifact remains unchanged` · 会话格式迁移失败

**English:** a session will not open after upgrading · the sidebar lists it but clicking fails · `SessionFormatUnsupportedMigrationError` · `uses unsupported descriptor version`

## 它做什么

读取指定目录下每一个 `session.jsonl.zstd`，解析后报告它踩中了哪些迁移闸门。

**它不写任何文件。** 没有修复子命令——改写会话日志是破坏性操作，而一个**不可能损坏你历史**的诊断工具，才是你能放心先跑的那个。

## 它不做什么

- **不**修复、**不**迁移、**不**移动任何文件
- **不**保证会话可读——它只报告自己知道的闸门。扫描干净是**必要条件，不是充分条件**
- **不是**官方工具

## 用法

```sh
npx dsh-session-check scan ~/.dsh/sessions
```

输出示例：

```text
sessions scanned   : 32
loader would refuse: 20
packed chunk runs  : 8562 (not session events)
format versions    : {"0":32}

gates hit, by session count:
   20  stale-descriptor
```

## 投影缓存（`dsh-projcache`）

上面的 `scan` 看的是会话日志；`dsh-projcache` 看的是另一半持久化数据：`<DSH_HOME>/storages/session_projcache/sessions/`，每个会话一个格式化过的 JSON 文档。

**它对应的症状：** harness 进程用久了内存越来越大 · 会话删了但 `storages/` 还在涨 · 某条会话首条消息巨大，于是每次启动都要为它付费

```sh
dsh-projcache survey    # 只报告，不写任何文件
dsh-projcache apply     # 回收确定无主的记录 + 裁剪超长行
```

它只做两件事：

1. **回收日志已消失的记录。** 记录只能通过「由存活或已存储的会话 header 构造出的身份」被读到；日志一旦没了，任何调用方都再也构造不出那个身份——这条记录只是占着字节，并且每次启动都被解析一遍。只有当日志在你传入的 sessions 根目录里**确定不存在**时才删除，且先写备份。
2. **裁剪超长的 `titleInput` 前缀。** 这一行把会话首条合格用户消息**整条**存了下来，而它唯一的读者只要 5 个词 / 40 字节（你装配里的 `fallbackMaxWords` / `fallbackMaxBytes`）。工具把文本替换成一个 UTF-8 安全的前缀（默认 4096 字节）——永远保留前缀而不是后缀，且不切断码点。

### 它不做什么

- **不加 `apply` 就绝不写入。** `survey` 逐字节只读，测试套件对此有断言。
- **无法逐字节复现的文档，它拒绝写。** 存储格式是 `JSON.stringify({version, record}, null, 2) + '\n'`；只要某个记录不能这样往返一致，就说明工具对后端格式的模型已经过期，直接停手。这也是为什么非 JSON 后端会被拒绝而不是被猜着改。
- **sessions 根不存在、或里面一条日志都没有时，它拒绝写入。** `--force` 也**覆盖不了**这一条，所以写错路径不可能删掉你的整个存储。
- **裁剪会改变 fallback 标题时，它跳过该记录。** 工具会用原文本和裁剪后文本各算一次 fallback 标题，不等就跳过。
- **它不是永久修复。** 任何一次从日志的完整重放——记录被删、domain 版本号抬升、`titleInput` 的 `stateVersion` 变化——都会把那一行按原尺寸重建。再跑一次 `apply` 即可，或用开机体检留意。真正的修复必须在采集处裁剪，那属于上游。

请**在 harness 停止时**运行：进程运行期间，这个存储是内存里的一张活表。

### 参数

| 参数 | 默认 | 含义 |
|---|---|---|
| `--store DIR` | `$DSH_HOME/storages` | 存储后端根目录 |
| `--sessions DIR` | `$DSH_HOME/sessions` | 用来判定「无主」的 sessions 根目录 |
| `--clamp-bytes N` | `4096` | 存储的 `titleInput` 前缀预算 |
| `--fallback-words N` | `5` | 你装配里的 `fallbackMaxWords`，用于不变量校验 |
| `--fallback-bytes N` | `40` | 你装配里的 `fallbackMaxBytes`，用于不变量校验 |
| `--max-orphan-fraction F` | `0.5` | 无主记录占比超过此值则拒绝回收 |
| `--force` | 关 | **仅**覆盖占比护栏 |
| `--json` | 关 | 机器可读输出 |

每个被改动的文件旁边都会留下 `<id>.json.bak.<stamp>`。loader 只读 `*.json`，所以备份不会被加载，直到你自己删掉。

以上全部证据——裁剪能扛过 harness 自己的回写、回收、记录缺失的最坏情况、以及护栏矩阵——都在 [`docs/verification.md`](docs/verification.md)，含原始 JSON 报告。

## 开机体检（`dsh-session-check/diag`）

一个只读的 Cordis 插件：当投影缓存里可回收的字节超过阈值（默认 1 MiB）时，在启动时打印一行。

```text
projection cache: 8.0 MB reclaimable — 2 of 2 records store a titleInput text (largest 8388608 chars,
8.0 MB total), while the fallback title reads only the first 4096 bytes. Reclaim offline with:
npx -y -p dsh-session-check dsh-projcache survey  (then `apply`)
```

挂载方式（bundle 行）：

```yaml
- insert:
    - id: projcache-diag
      name: 'dsh-session-check/diag'
```

`dsh-community-fixes` 这个 bundle 已经挂了它。它之所以放在这个 CLI 包里，是因为「报告」和「回收」应该共用一份实现。

它只用 `KvTable.entries()` 读内存里的表，从不写入；测量有截止时间（默认 50 ms），超时会写 `(partial scan: …)`，而不是把半次扫描当成总数报出来。

### 为什么它写 stderr，而不是只写 `ctx.logger`

因为在出厂装配里 `ctx.logger` 根本看不见。Cordis 内置的 `LoggerService` 只装了一个 exporter——一个内存环形缓冲（`@deepseek-ai/cordis`，`LoggerService` 构造函数）——而没有任何已发布包注册 console sink。在 0.1.5-rc.1 上实测：这一行插件里的 `logger.warn` 在 `dsh web` 运行时 stdout / stderr 都没有任何输出，而同一次回调里的 `process.stderr.write` 有。这里仍然保留 logger 调用，是为了让真的接了 sink 的部署也能收到。

这一点与本事无关地值得知道：**只通过 `ctx.logger` 报告问题的插件，在标准安装里等于没报告给任何人。**

## 三道闸门

每道闸门对应迁移链里的一个校验器，都从**已安装的包**里读出来。输出里的 `file:line` 是契约的一部分：升级后请先重读它，再信任闸门。

| 闸门 | 检测什么 | 对应的官方校验器 |
|---|---|---|
| `retired-source-kind` | 消息来源的 kind 已不在接受集合里 | `dsh-session-format-v2-to-v3/lib/index.js:123` |
| `stale-descriptor` | `subagent/descriptor` 的 version 不是 3 | `dsh-session-format-v0-to-v1/lib/index.js:1586` |
| `incomplete-inserted` | 插入的收件箱消息缺 id/role/content/source | `dsh-session-format-v0-to-v1/lib/index.js:283 与 :715` |

## 为什么闸门比看起来更窄

有两种看起来显然正确的实现其实是错的，都是**拿官方校验器反证**才发现的：

1. **`session/title` 也带 `data.source.kind`**，但它记录的是标题**怎么生成的**（fallback 还是模型），`assertSource` 根本看不到它。深度遍历所有 `source` 对象会报出**不可能发生的违规**。
2. **一份日志里有两种行。** 会话事件带数字 `seq`；分片压缩记录带 `seq0` 和 `time0`，走另一条解码路径（`decodePackedRun`）。把分片记录喂给事件校验器，会**凭空造出一个失败**。

在一个 32 份日志的真实语料上，这两处任一写错，就会把 **20** 个真正被拦的会话报成 **30** 个——等于告诉用户“你的历史坏了”，而它其实没坏。

## 拿官方校验器交叉验证

扫描器只做预测，最终由 harness 判定。想在你机器上确认两者一致，把带数字 `seq` 的事件喂给官方校验器：

```js
import { assertReleasedEventPayload } from '@deepseek-ai/dsh-session-format-v0-to-v1'

for (const event of events) assertReleasedEventPayload(event, 0)
```

被拦的日志必须在**扫描器指名的那个事件**上抛出；干净的日志必须**全部通过**。

## 和 `dsh-session-doctor` 的区别

两个工具都扫描已存储的会话，但覆盖的是**不同的失败类**。这个区别是**可测量的**，不是主观判断。

| | dsh-session-check（本工具） | dsh-session-doctor |
|---|---|---|
| 失败类 | **格式迁移闸门** —— `SessionFormatUnsupportedMigrationError` | 消息形状损坏 —— `SessionPersistenceCorruptionError` |
| 典型触发 | **从旧版本升级上来** | 某个插件写出了畸形的工具结果 |
| 报告什么 | `unsupported descriptor version`、`unknown historical event type`、`cannot safely transform unclassified message source` | `must contain one tool-result block` |
| 是否写文件 | **不写** | 会修复，带逐文件备份 |

在同一个 32 份日志的真实语料上：`dsh-session-doctor@0.2.1 scan` 报 `scanned=32 clean=32 corrupt=0`，而本工具报 **20 个被拦** —— 全部落在 `stale-descriptor` 闸门上。**两者都没错**：它们查的是不同的东西，一份会话完全可能过了一个、挂在另一个上。

如果你的症状是「history unavailable … must contain one tool-result block」，那你要的不是这个工具。

## 依赖

- Node `>=22.19`
- `zstd` CLI（在 PATH 上）
- 已安装的 harness 包（用于闸门常量与交叉验证）

## 开发

```sh
npm test
```

测试跑在合成事件上，**不需要真实会话日志**。

## 许可证

MIT
