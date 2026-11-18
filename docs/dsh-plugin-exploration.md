# LoopPrism 作为 DeepSeek Harness (dsh) 插件：可行性与原型

分支：`claude/explore-dsh-plugin-26334e`（只做了本地提交，没有 push，没有向 awesome-dsh-plugin 提 PR，没有 npm publish，没有改仓库 topics）。
调研日期：2026-11-11。凡是没有亲手跑通的地方都标了「未验证」。

## 结论

**能满足收录要求，前提是做一个真插件，不能只靠现有的 `npm/`。** 原型已经在 `plugins/dsh-loopprism/` 里，并且在真实的 `dsh`（`@deepseek-ai/dsh@0.2.2-rc.1`）里跑通：manifest 与 bundle patch 能合成进 profile，插件能加载，9 个 `loopprism_*` 工具出现在发给模型的工具列表里，模型调用其中一个后真的读到了本机的费用数据，`session_start` / `prompt` / `tool` / `tool_failure` / `stop` 五类事件都送到了（模拟的）LoopPrism ingest 接口。

还缺的事（都是需要你来做的动作，我没有动）：

1. 把分支合进 `main` 并 push（条目要指向 GitHub 上真实存在的 `plugins/dsh-loopprism`）。
2. 给 GitHub 仓库加 `dsh-plugin` topic。
3. 建议先 `npm publish` 一个 `dsh-loopprism`（`npm view dsh-loopprism` 目前 404，名字可用），否则用户只能走 git 子目录安装，而这条路径我没法验证（见下）。
4. 用真实的 `dsh plugin add` 走一遍安装（本机没有 pnpm，我是手动把包放进 profile 的 `node_modules`）。
5. 之后再向上游 awesome-dsh-plugin 提 PR，一个文件，内容见文末草案。

## 1. dsh 插件接口（调研结果）

来源：官方仓库 `deepseek-ai/deepseek-harness` 的 `docs/cordis-primer.md`、`docs/cordis-tutorial/01-first-plugin.md`、`.agents/notes/**`（profile bundles、hook bridges、plugin command registration、plugin entry exports 等设计笔记），以及 npm 上的 `@deepseek-ai/dsh-hooks-claude-code`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh` 包和已收录的 `Chhlafiu4312/dsh-mcp-bridge`（包名 `dsh-mcp-connect`）源码。

| 问题 | 结论 | 状态 |
|---|---|---|
| 插件是什么 | dsh 建在 Cordis（`@deepseek-ai/cordis`）之上。插件是一个模块：函数插件导出 `name`、`inject`、`Config`、`apply(ctx, config)`；也接受 `{ inject, apply }` 对象或 `Service` 子类 | 已读文档与官方包源码；函数插件已实跑 |
| 入口形态 | 官方 hooks 桥接包用「具名导出，不要 default 导出」（设计笔记引用 postmortem 0001：default 导出会丢掉 `inject`）。插件入口只允许导出 `name`/`inject`/`Config`/`apply`，别的逻辑放在别的模块（官方有 CI 门禁） | 已读；本原型照此做 |
| 怎么被装进 profile | npm 包在 `package.json` 声明 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`；patch 是 YAML 数组，`- insert: [{id, name}]` 往插件树里加一行，`name` 是包名；用户层 `cordis.patch.yml` 可按 `id` 覆盖 `config` | 已实跑（`dsh lp --dump-config` 里出现 `# == dsh-loopprism` 与 `loopprism` 行） |
| 不写 `Config` 能收到配置吗 | 能。行上的 `config:` 原样作为 `apply` 第二个参数传入（实跑：`sendPrompts: false`、`tools: false` 生效） | 已实跑 |
| 注册 MCP 服务 | dsh 没有「在插件里声明 MCP 服务」的接口。MCP 是官方 `dsh-mcp-client`/`dsh-mcp-manager` 插件，通过自己的配置连接服务器。**插件能做的是直接注册 dsh 工具**：`ctx.tools.register(defineTool({...}))`，参数是 DSL（`type/description/enum/items/required`），`execute(args, exec)` 里能拿到 `exec.agent` | 工具注册已实跑；「向官方 mcp-client 注入服务器」没试，也没看到公开接口 |
| 注册命令 | 有 `@deepseek-ai/dsh-commands` 注册表，但官方笔记写明只有 TUI 消费；ACP/headless/SDK 都不暴露。DSH Desktop 是 web/Electron，所以「打开仪表盘」命令用不上，我改成了一个 `loopprism_open_dashboard` 工具 | 已读笔记；未实跑 |
| 挂 hooks | 「原生 hook」就是订阅类型化的拦截点：`agent/created`、`agent/pre-step`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping`、`subagent/start`、`subagent/end`。`dsh-hooks-claude-code` 只是把 Claude Code 的 shell hooks 翻译到这些点上。原生插件没有序列化边界，直接拿 `ctx` | 已实跑其中四个；`tools/pre-execute`、`subagent/*` 没用 |
| 依赖怎么声明 | 官方 `@deepseek-ai/*` 用 `peerDependencies`；兼容检查优先看 `engines.dsh`，没有才看 `@deepseek-ai/dsh*` 的 peer。带预发布版本的范围要写显式分支（当前是 `0.2.2-rc.1`） | 已读；peer 范围是否被安装器接受**未验证** |
| 运行环境 | `@deepseek-ai/dsh` 要求 Node >=24.9。本机只有 22.23，`dsh` 仍能启动并跑完（只在 22.23 上测过） | 已实跑（22.23）；DSH Desktop 自带运行时版本**未验证** |

## 2. 原型做了什么

`plugins/dsh-loopprism/`（包名 `dsh-loopprism`，MIT，依赖已发布的 `loopprism@^0.2.0`）：

- `package.json`：`dsh.bundle.patch`、`type: module`、`peerDependencies: @deepseek-ai/dsh-tools`。
- `cordis.patch.yml`：`- insert: [{id: loopprism, name: dsh-loopprism}]`。
- `plugin.js`：只导出 `name`（`loopprism`）、`inject`（`tools`、`agents`）、`apply`。`@deepseek-ai/dsh-tools` 用动态 import，解析不到时只跳过工具并记一条警告，实时上报不受影响。
- `lib/index.js`：
  - **实时上报**：订阅 `agent/created`、`agent/pre-step`、`tools/post-execute`、`agent/turn-stopping`，把事件拼成 Claude Code 形状的 payload，交给 `loopprism` 包里已有的 `buildEvent`，再 `POST /api/ingest/events`。只观察：每个监听器都原样 `next()`；发送走串行队列，不阻塞 agent；LoopPrism 不可达时暂停 10 秒（内存版的 `hook.js` 退避）。
  - **评审工具**：遍历 `loopprism/core/mcp.js` 导出的 `TOOLS`，每个注册成 `loopprism_<name>`，`execute` 直接调同一个 `Inspector`，`cwd` 缺省取 agent 会话的目录（让 `session: "current"` 指向当前 dsh 会话）。不起 MCP 子进程。
  - 配置：`url`、`live`、`sendPrompts`、`tools`，全部可选。
- `test/plugin.test.mjs`：8 个单测（`cd plugins/dsh-loopprism && node --test`），用假的 Cordis 上下文，LoopPrism 代码取自本仓库 `npm/`。
- `e2e/mock-server.mjs`：手动端到端用的模拟服务（同时扮演 LoopPrism ingest 和 DeepSeek Messages API）。

没有碰 `npm/`、`src/`、`desktop/`、`pyproject.toml`，也没有动现有的发布流程。

### 端到端验证（真实 dsh，Windows，Node 22.23）

做法：在临时目录 `npm i @deepseek-ai/dsh@next`；`DSH_HOME` 指向临时目录；`dsh lp --from-default-profile headless` 建 profile；把插件、`loopprism@0.2.0`（`npm pack` 解出来的）手动放进 profile 的 `node_modules`，并把 `@deepseek-ai` 目录联过去；`package.json` 里把 `dsh-loopprism` 加进 `dsh.profile.bundles`；`DEEPSEEK_BASE_URL` 与 `LOOPPRISM_URL` 都指向 `e2e/mock-server.mjs`，`DEEPSEEK_API_KEY` 是假值；运行 `dsh lp "what did my agents cost"`。没有外网请求。

捕获到的顺序：

```
INGEST session_start
INGEST prompt
MODEL  tools=33 (其中 loopprism_* 9 个)
INGEST tool  loopprism_cost_overview   (tool_response 4021 字符，是本机真实的费用 JSON)
MODEL  tools=33, 带 tool_result
INGEST stop
```

另外：`config: {sendPrompts: false}` 时 ingest 里没有提示词原文；`tools: false` 时工具消失，模型硬调用时会得到一条 `tool_failure` 事件（顺带验证了失败路径）。

### 顺手发现的问题

- 已发布的 `loopprism@0.2.0` 的 `plugin/scripts/hook.js` 比仓库 `main` 旧：没有 `shouldBackOff`/`HttpError`，`send(event, url)` 超时固定 1 秒（仓库里 `22ef627` 之后才有）。第一版原型用了这些导出，在真实 dsh 里报 `shouldBackOff is not a function`。现在只依赖 `buildEvent`、`core/mcp.js` 的 `TOOLS` 和 `core/api.js` 的 `Inspector`，发送与退避在插件里自己实现。
- 插件因此耦合了 `loopprism` 的内部模块路径。建议：npm 包每次发版时跑一个检查（或在 `npm/test` 里加一条），确认这三个导出还在，并让插件只依赖同一个次版本（`^0.2.0` 在 0.x 下等价于 `~0.2.0`）。
- 如果同时用 `lpa install dsh --live`（写 `dsh-hooks.json`，再手动装 `dsh-hooks-claude-code`）和本插件，每一步会被报两次。插件 README 写了「二选一」。`lpa install dsh` 目前没改，后续可以让它提示改用插件。

## 3. 放哪里

| 方案 | 评价 |
|---|---|
| **`plugins/dsh-loopprism/` 子包（选用）** | CI 明确会找 `plugins/` 下的清单；新增一个目录，不影响 Python、Electron、`npm/`。条目 URL 指向子目录。 |
| 仓库根加 `package.json` | 根目录是 Python 项目，加一个 Node 清单会让根目录像 Node 项目，污染工具链（IDE、依赖扫描、发布），且条目会占用整个仓库名。不选。 |
| 直接给 `npm/package.json` 加 `dsh.bundle` | `npm/` 不在 contributing 写的扫描目录里（不过 `check-submission.mjs` 的注释说会遍历整棵树，二者不一致，我没跑 CI 验证）；还会让已发布的 CLI 包同时是 Cordis 插件，入口是 CJS，且发布流程要改。不选。 |

注意：用子包后，上游条目文件名不是 `atlasmarkz__LoopPrism.yml`，而是 `atlasmarkz__LoopPrism--plugins-dsh-loopprism.yml`（规则：`owner__repo--<子目录里的 / 换成 ->`），`url` 指向子目录，`name` 写 `atlasmarkz/LoopPrism#dsh-loopprism`。`check-submission.mjs` 对「条目指向仓库根、而根没有 `dsh.bundle`」会明确判失败，所以不能写根 URL。

## 4. 收录要求逐项核对

| 要求 | 现状 |
|---|---|
| `package.json` 有 `dsh.bundle.patch` 且旁边有 `cordis.patch.yml` | 满足（`plugins/dsh-loopprism/`），仅在分支上 |
| CI 能在 `plugins/` 下找到清单 | 满足（按 contributing 的文字；CI 本身没跑过） |
| 条目指向子目录、文件名与之匹配 | 草案见下；文件名以 `node scripts/generate-readme.mjs` 报的为准（未跑） |
| 真实可用的代码，不是壳 | 满足：加载、注册工具、上报事件都实跑过 |
| 仓库创建满 1 天 | 满足（2026-06-15 创建） |
| 持续维护 | 满足（最近 push 2026-11-10） |
| `dsh-plugin` topic | **缺**，需要你加（我没动） |
| 描述属实，与代码一致 | 草案已逐句对过代码，见下 |
| 不是纯聚合包 | 不是：有自己的监听器和工具注册 |
| 依赖指向原作者 | 唯一依赖是自家的 `loopprism` |
| 源码无可疑之处 | 数据只发往 LoopPrism URL（默认 `127.0.0.1:8080`）；会读本机会话文件；`open_dashboard` 会在后台起本地服务。README 的「What leaves the process」已写明。扫描器（`dsh-trust-check`）大概会报网络、文件读取、子进程这几类能力，这是披露不是否决 |
| 是否已被现有条目覆盖 | 没有 LoopPrism 条目。同类（`usage` 类用量面板、`cc-monitor` 等）读的是 DSH 的数据或自建服务，不读 LoopPrism，也没有 agent 可调用的评审工具 |
| 一个 PR 最多 3 条 | 1 条 |

## 5. 描述怎么写才与代码一致

可以说的（都对得上代码）：

- 上报的是 session start、prompt、tool result（成功/失败）、stop 这五类，发往本机 LoopPrism；
- 注册的是 `lpa mcp` 同一份工具，名字 `loopprism_<tool>`；
- 工具跑在 dsh 进程里，不是 MCP 服务器。

不要说的：

- 「9 个工具」这类数字（数字来自 `loopprism` 的 `TOOLS`，升级会变；要写就要核对）；
- 「子代理」（`session_agents` 的实现针对 Claude Code，对 dsh 会话的效果**未验证**）；
- 「费用/上下文对 dsh 会话都准确」（dsh 适配器的覆盖度我没逐项核对；`stop` 事件对 dsh 不带 token 用量，因为 `usage.js` 没有 dsh 分支，仪表盘靠读会话文件取用量）；
- 「实时」以外的承诺（如 token 实时统计）。

## 6. 分类建议

`usage`（该分类里已有很多费用/用量类条目，维护者不会因分类打回，贴切即可）。备选 `tools`。

## 7. 条目草案（只写在这里，没有放进任何仓库）

文件名：`data/plugins/atlasmarkz__LoopPrism--plugins-dsh-loopprism.yml`

```yaml
url: https://github.com/atlasmarkz/LoopPrism/tree/main/plugins/dsh-loopprism
name: atlasmarkz/LoopPrism#dsh-loopprism
category: usage
description:
  en: Sends DeepSeek Harness session start, prompt, tool result and stop events to the local LoopPrism app, and registers LoopPrism's session-review tools (the ones lpa mcp serves) as loopprism_* tools for the agent.
  zh: 把 DeepSeek Harness 的会话开始、提示词、工具结果与停止事件发送到本机 LoopPrism 应用，并把 LoopPrism 的会话评审工具（即 lpa mcp 提供的那些）注册为 loopprism_* 工具供 agent 调用。
# icon: 可选，需要 GitHub 托管的位图（png/jpg/webp），仓库里目前没有 180px 的图标，不写则回退到作者头像
# tarball: 不需要；若不发 npm，需要把 dsh-loopprism-<版本>.tgz 附到 GitHub Release
```

英文描述里没有冒号加空格，不需要加引号；如果以后加了，要整体加引号。

## 8. 未验证 / 风险清单

- `dsh plugin --profile <p> add dsh-loopprism` 与 `add github:atlasmarkz/LoopPrism#path:/plugins/dsh-loopprism`（pnpm 子目录语法来自 awesome-dsh-plugin 的测试，不是我跑出来的）都没跑过：本机无 pnpm，包也还没发布、没 push。pnpm 装好后，`loopprism` 依赖与 `@deepseek-ai/dsh-tools` 能否从插件目录解析到，只在手动布置的 `node_modules` 下验证过。
- 安装器是否接受 `peerDependencies: {"@deepseek-ai/dsh-tools": ">=0.2.2-rc.1 <0.3.0-0"}`；也可以改用 `engines.dsh`。
- DSH Desktop（Electron）里加载：自带 Node 版本是否满足 `node:sqlite`（`loopprism` 的 Inspector 需要），插件管理页面、热重载（HMR）、卸载时监听器与工具是否干净撤销——都没测。`ctx.effect` 的释放路径只有单测级别的覆盖。
- 只在 Windows、headless profile 上测过；没测 web/tui profile，也没有真实的 DeepSeek 模型调用（模型端是模拟的，格式取自官方 `/v1/messages` 流式事件）。
- 工具参数的 DSL 只带了已知可用的关键字（`type/description/enum/items/required`）；`minimum/maximum/default` 被丢弃，LoopPrism 自己校验。
- `loopprism_open_dashboard` 没有实跑。
- 工具结果在模型端的展示用的是通用卡片；没做 `presentCall/presentResult`。
- 子代理事件（`subagent/start`、`subagent/end`）和 token 用量没有上报，是可以做的下一步。
- 上游 CI（`check-submission.mjs`、`awesome-lint`）没有在 fork 上跑过。

## 9. 复现

```sh
# 单测
cd plugins/dsh-loopprism && node --test

# 端到端（需要 Node 22+，会下载 ~650 个包）
mkdir /tmp/dshrun && cd /tmp/dshrun && npm init -y && npm i @deepseek-ai/dsh@next
export DSH_HOME=$PWD/home
./node_modules/.bin/dsh lp --from-default-profile headless --dump-config >/dev/null
# 把 plugins/dsh-loopprism 复制到 $DSH_HOME/profiles/lp/node_modules/dsh-loopprism，
# 把 loopprism@0.2.0 解压到同目录下的 loopprism，把 node_modules/@deepseek-ai 链接到该 profile，
# 并在 profiles/lp/package.json 的 dependencies 与 dsh.profile.bundles 里加上 dsh-loopprism。
node <repo>/plugins/dsh-loopprism/e2e/mock-server.mjs capture.jsonl &
DEEPSEEK_API_KEY=sk-mock DEEPSEEK_BASE_URL=http://127.0.0.1:18080 LOOPPRISM_URL=http://127.0.0.1:18080 \
  ./node_modules/.bin/dsh lp "what did my agents cost"
```
