# dsh-routines

DSH 的定时 Agent —— 按 cron 跑一个 prompt，把摘要送到你已经在的地方。

`dsh-routines` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件 bundle。**routine（例程）** 是一个「命名 prompt + 调度 + 投递」，以纯 YAML 文件存放 —— 可人工 diff、可 git 提交。调度器把每个到期例程通过 headless runner 作为**独立的一次性会话**启动（完整会话日志 = 免费审计，之后可用 dsh-replay 回放），然后投递摘要：最后一条 assistant 消息较短时直接用它，否则对会话日志做一次性摘要调用。

```
┌──────────────────────┐   每日 02:00   ┌──────────────────────────────┐
│  dsh --profile ops   │ ─────────────▶ │ dsh --profile headless        │
│  调度器 tick          │   独立会话，cwd  │  "跑测试套件，……"             │
│  读取 .dsh/routines  │   = 例程 cwd，   │  审批策略: never              │
│  /*.yaml             │   审批: never)   └──────────────┬───────────────┘
└──────────────────────┘                                │ 运行记录: 状态、
       │ 摘要 + 运行记录                                  │ 摘要、会话 id、
       ▼                                                │ 被拒绝的权限
  .dsh/routines/runs/<runId>.json  (+ .md)  ──►  file 投递（始终开启）
  ctx.chatnode（可选）              ──►  chatnode 投递（软依赖）
```

## 旗舰示例 —— 夜间测试分诊

凌晨 2 点跑测试套件、诊断最高优先级失败、在项目里留下摘要的例程；装了会话节点后，摘要还会发到微信，你回复即可批准后续操作（v0.2；v0.1 投递到文件，装了节点也可投递 chatnode）。

```yaml
# ~/work/projectx/.dsh/routines/nightly-tests.yaml
name: nightly-tests
schedule: "0 2 * * *"        # 5 段 cron；也支持 "@daily"、"every 4h"
timezone: Asia/Shanghai       # 显式指定，不静默使用宿主机时区
prompt: |
  Run the test suite. If anything fails, diagnose the top failure
  and draft a fix on a branch. Summarize in <10 lines.
cwd: ~/work/projectx
profile: headless              # 本次运行使用的 DSH profile / 插件集
overlap: skip                  # skip | queue | cancel-previous
timeoutMin: 45
deliver:
  - type: file                 # 始终开启：摘要写入 .dsh/routines/runs/
  - type: chatnode             # 可选：任意已安装的会话节点（wechat…）
```

```console
$ dsh --profile ops routines list
nightly-tests          active   0 2 * * *           tz=Asia/Shanghai next=2026-08-15T02:00:00.000Z
```

第二天早上，摘要已在等待：

```console
$ dsh --profile ops routines logs nightly-tests --limit 3
[completed] 2026-08-14T18:00:01.000Z 41213 ms session=session-2f7d…
  tests: 3 failed of 412; top failure: flaky wait in auth.spec.ts — drafted fix on branch fix/auth-wait
```

## 安装

```console
# 1. 创建承载调度器 + CLI 的 profile（安装本 bundle）。
#    发布到 npm 后用 npm 形式；也可以直接从本仓库安装：
dsh plugin --profile ops add @dsh-routines/bundle          # npm（发布后）
dsh plugin --profile ops add github:Jesse-njx/dsh-routines  # 或：直接从 GitHub

# 2. 保持进程存活，调度才会触发（守护模式；Ctrl-C 停止）。
dsh --profile ops
```

例程运行默认启动 `headless` profile（DSH 自带）——**无需额外配置**。需要其他插件集的例程设置 `profile: <name>`；该 profile 必须支持一次性运行（包含 headless bundle，或同样安装本 bundle —— 运行 overlay 无论如何都会禁用嵌套的调度器）。

### 调度宿主

调度器在安装了本 bundle 的 profile 内 tick，所以也可以把 bundle 加进你的 `web` profile，web 应用运行期间例程就会触发：

```console
dsh plugin --profile web add @dsh-routines/bundle
```

保持进程存活即可触发调度；`dsh --profile ops`（无内参）即守护模式（CLI 保持安静，调度器掌管进程生命周期）。

## 例程文件

例程位于两个被监听的目录（改动热重载；非法文件会被报告，不会让 store 崩溃）：

| 目录 | 作用域 |
| --- | --- |
| `<cwd>/.dsh/routines/*.yaml` | 项目例程（同名覆盖全局） |
| `~/.dsh/routines/*.yaml` | 全局例程 |

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `name` | —（必填） | `[a-z0-9][a-z0-9-]*`，≤ 64 字符 |
| `schedule` | —（必填） | `0 2 * * *`、`@daily`、`@hourly`、`@weekly`、`@monthly`、`@yearly`、`every 4h`、`every 30m` |
| `timezone` | `UTC` | 调度计算的 IANA 时区（绝不使用宿主机时区） |
| `prompt` | —（必填） | headless 运行要执行的任务 |
| `cwd` | 操作者 cwd | 运行的 working directory；摘要也落在其下 |
| `profile` | `headless` | 运行启动的 DSH profile |
| `overlap` | `skip` | `skip`（绝不在同一仓库叠加两个 agent）、`queue`（当前结束后运行）、`cancel-previous` |
| `timeoutMin` | `45` | 硬超时；卡死的凌晨 2 点 agent 不能占用仓库到早上 9 点 |
| `deliver` | `[{type: file}]` | 摘要投递渠道 |

cron 字段支持 `*`、步进后缀（`*/15`）、区间（`9-17`）、列表（`0,30`）、`?`、月份/星期名称。当月内日期与星期同时受限时，任一天匹配即命中（Vixie cron 语义）。

调度器记账（暂停集合、上次运行锚点）存放在 `<cwd>/.dsh/routines/state.json`。

## CLI

`dsh --profile ops routines <command>`

| 命令 | 说明 |
| --- | --- |
| `list` | 例程列表：调度、暂停状态、下次运行 |
| `run <name>` | 手动触发（立即运行；打印摘要后退出） |
| `pause <name>` / `resume <name>` | 停止 / 恢复定时运行 |
| `logs <name> [--limit n]` | 最近运行记录：状态、耗时、摘要、会话 id |

运行记录是 `<routine.cwd>/.dsh/routines/runs/<runId>.json`，旁边还有人类可读的 `<runId>.md` 摘要。`run` 也是在信任调度前测试例程的手动触发方式。

## 安全默认值

定时 agent 无人值守运行，因此每个运行子进程都会被 patch 为：

- **一切需要提示的都自动拒绝** —— 运行 overlay 把审批策略强制为 `never`（sandbox 模式保持 profile 继承值，通常为 `workspace-write`）。被拒绝的请求会被收集进运行记录（`denied`）并体现在摘要里。
- **绝不调度嵌套运行** —— 运行 overlay 会在运行 profile 内禁用调度器行。
- **绝不让调度器崩溃** —— 投递失败、摘要失败、spawn 失败都记录在运行记录上，不抛出。

错过的运行（笔记本休眠）：唤醒后最多补跑一次，绝不重放积压。

## 投递

- **file**（始终开启）：`<routine.cwd>/.dsh/routines/runs/` 下的运行记录 + 摘要 markdown。
- **chatnode**（可选）：装了 `ctx.chatnode` 服务（`{ send(input: { text, title? }): Promise<void> }`）时把摘要发过去；没有则记录为 `not-installed`，运行照常完成。未来的 `@dsh-cowork/chatnode-wechat` 暴露该服务后会自动点亮。

## 架构

一个 bundle，三个插件（+ 一个运行驱动），均可作为子路径安装：

| 模块 | 职责 |
| --- | --- |
| `@dsh-routines/bundle/store` | 监听 `.dsh/routines/*.yaml`（项目 + 全局）、校验、热重载、管理持久化状态 |
| `@dsh-routines/bundle/scheduler` | 在 `ctx.jobs` 上注册到期例程（kind `routine`）；负责 overlap、错过运行、超时语义 |
| `@dsh-routines/bundle/cli` | `dsh routines ...` 命令行 |
| `@dsh-routines/bundle/run` | 子进程侧驱动，通过生成的 `--patch` overlay 注入每次一次性运行；写运行记录与摘要 |

运行启动 `dsh --profile <routine.profile> --patch <生成的 overlay> -- "<prompt>"`，工作目录为例程 cwd。overlay 禁用内置 headless runner、在同一 task 服务上挂载 `run` 驱动、并强制无人值守审批策略 —— 既保留完整的 headless 体验（全新持久化会话、provider 选择），又写出只有 dsh-routines 知道怎么读的审计记录。

## 开发

```console
pnpm install
pnpm build      # tsc -> lib/
pnpm test       # node --test（46 个测试：cron、调度矩阵、store、run、cli、e2e）
```

e2e 测试会在临时 `DSH_HOME` 里用脚本化 mock LLM adapter（离线、无需凭证）启动真实的 `dsh` 子进程，完整走通 store → 调度器 → jobs → 子进程 → 运行驱动 → 摘要 → 记录。

## 非目标

云端执行（仅本机；错过运行策略如实处理休眠笔记本）、例程市场、亚分钟级调度。

## License

MIT
