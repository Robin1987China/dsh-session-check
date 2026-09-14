# dsh-session-check

[English](README.md) | 中文

**只读**诊断工具：告诉你哪些已存储的 DeepSeek Harness 会话会被格式迁移拒绝，以及**被哪一道闸门拒绝**。

作者 [@Robin1987China](https://github.com/Robin1987China)

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
