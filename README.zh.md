# @dsh-pm/registry

`dsh pm` 的发现引擎 —— 将三个相互独立的来源合并成一个去重、排序且**可离线降级**的插件注册表：

1. **awesome-list** —— [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
   README，按分类标题解析条目（配置项 `awesomeUrl`）。
2. **GitHub topic** —— 通过 `gh` CLI 搜索带 `dsh-plugin` 话题的仓库，并有
   `api.github.com` 的 https 兜底。
3. **npm keyword** —— `npm search --json <keyword>`（配置项 `npmKeyword`，默认
   `dsh`），并有 registry `/-/v1/search` 的 https 兜底。

同一项目的 GitHub 命中与 npm 命中会合并为一条同时携带 `repoUrl` 与 `npmName`
的 `RegistryEntry`；先按规范化后的仓库 URL 去重，再按裸名称去重。每个来源都能
独立降级 —— 一个失效的来源只会少贡献（或改用本地缓存的）条目并产生一条警告，
**绝不会抛出异常**。离线时，客户端返回各来源上次成功抓取时写入的本地缓存。

本包实现 [`@dsh-pm/core`](https://github.com/Jesse-njx/dsh-plugin-manager-core)
中冻结的 `RegistryClient` 契约（规范 §5.1），并精确导出 §5.2 规定的接口：
`createRegistryClient` 与一次性 `search` 便捷函数。

## 安装

`dsh-plugin-manager` monorepo 的工作区包，通过 `@dsh-pm/core`（workspace 依赖）
消费。将其接入 DSH 的产品是插件管理器 CLI：

```sh
dsh plugin add github:Jesse-njx/dsh-plugin-manager
```

## 用法

```ts
import { createRegistryClient, search } from '@dsh-pm/registry'
import type { PmConfig } from '@dsh-pm/core'

const cfg: PmConfig['registry'] = {
  awesomeUrl: 'https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.md',
  npmKeyword: 'dsh',
}

const client = createRegistryClient(cfg)

// 过滤并排序：stars 降序，再按名称升序。
const hits = await client.search('memory')

// 精确查找：支持名称、npmName、owner/repo、github:owner/repo 或 https URL。
const entry = await client.resolve('Jesse-njx/dsh-memory')

// 更新检查版本：优先 npm dist-tag `latest`，否则返回 GitHub 默认分支 HEAD 的 commit sha。
const version = await client.latestVersion(entry ?? hits[0]!)

// 最近一次运行的警告（冻结接口之外的有文档扩展）：
console.log(client.lastWarnings) // 例如 ["github: 'gh' CLI not found; results from https search"]

// 一次性便捷调用（规范 §5.2）：
const all = await search('', cfg)
```

### 返回结构

`search`/`resolve` 返回 `@dsh-pm/core` 中的 `RegistryEntry`：

```ts
{
  name: string            // 规范裸名称
  repoUrl?: string        // 规范化的 https 仓库 URL（去重键 #1）
  npmName?: string        // 已发布到 npm 的包名
  description: string
  category: string        // awesome-list 标题，未知则为 ''
  stars?: number          // 已知的 GitHub stars
  updatedAt?: string      // 最近一次仓库推送的 ISO 8601 时间
  source: ('github' | 'npm')[]  // 贡献了哪些发现来源
}
```

## 三个数据来源

| 来源 | 首选 | 兜底 | 贡献字段 |
|---|---|---|---|
| awesome | `fetch(awesomeUrl)` | 本地缓存 | name, repoUrl, description, category |
| github | `gh api search/repositories?q=topic:dsh-plugin` | https `api.github.com` 搜索 | name, repoUrl, stars, updatedAt, description |
| npm | `npm search --json --searchlimit=100 <keyword>` | https `registry.npmjs.org/-/v1/search` | name→npmName, repoUrl, description |

- **去重** —— 先按规范化仓库 URL（`git+https://…`、`git@github.com:…`、
  末尾 `.git` 均归并为 `https://github.com/owner/repo`），再按裸名称。仅裸名称
  相同的不同仓库保持独立。合并时元数据取并集，`source` 累积不同的贡献来源。
- **排序** —— `stars ?? 0` 降序，名称升序作为并列时的次序。
- **警告** —— 每个失效来源至多一条（`awesome: …`、`github: …`、`npm: …`），
  例如 `github: 'gh api' failed (exit 1); results from https search`。无法解析
  的 awesome 行汇总为一条 `awesome: skipped N row(s)` 警告 —— 解析器绝不抛异常。

## 离线行为

每个来源依次尝试：首选路径 → https 兜底 → 本地缓存 → 退化为零条目并产生一条
警告。缓存为 JSON 文件，原子写入（临时文件 + rename），存放于：

- 设置了 `$DSH_PM_CACHE_DIR` 则用它，否则
- `$XDG_CACHE_HOME/dsh-pm`，否则
- `~/.cache/dsh-pm`

缓存写入是尽力而为：写入失败会被静默吞掉，绝不致命。默认的 npm runner 还会使用
自己的可写缓存（`<cacheDir>/npm-cache`），避免全局 `~/.npm` 缓存损坏拖垮 npm
首选路径。

## 开发

```sh
pnpm install            # 在 monorepo 根目录执行（需 packages/core 已存在）
pnpm --filter @dsh-pm/registry test        # node --test，43 个测试
pnpm --filter @dsh-pm/registry typecheck
pnpm --filter @dsh-pm/registry build       # tsc → lib/
```

除 `test/live.test.ts`（离线时自动跳过，沿用套件约定的网络守卫）外，测试不触网。
合并/去重矩阵、解析器黄金样例（fixture README 已提交在 `test/fixtures/`）以及所有
降级路径都基于注入的 fake 运行（`test/helpers.ts`）。

> **`dev/core/` 仅为构建期占位。** `registry` 只以 `import type` 从
> `@dsh-pm/core`（workspace 依赖）导入类型 —— 运行期会被擦除。由于构建本包时
> Session 1 的 `core` 尚未落地，这里把规范 §5.1 的冻结契约逐字转写进
> `dev/core/index.d.ts`，仅通过 `tsconfig.json` 的 `paths` 映射引用，绝不编译进
> `lib/`，运行期也绝不导入。真正的 `core` 链接后即可删除 `dev/` —— 协调者可将
> 该占位与落地的类型做 diff，检查是否有漂移。

## License

MIT —— 见 [LICENSE](./LICENSE)。
