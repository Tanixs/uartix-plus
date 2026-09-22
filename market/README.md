# 插件市场：怎么上架一支插件

> 这里是**货架的源码**：作者交的元数据 + 包源文件。生成器把它们编译成 `public/market/index.json`，
> 应用每次打开市场页**实时读那份索引**（不内置快照兜底——过期答案不是降级，是错误）。
> 参照物：市场 App 是 `dsh-market/dsh-market`，清单是 `awesome-dsh-plugin`（一插件一文件、人工 PR、CI 生成索引）。
> **我们抄的是这套机制，不是它的包格式**——dsh 的插件是 npm 上的 JS 模块，我们的插件是 `uartix-plugin` 声明式包。

## 现在能走到哪一步（先说清，别按将来的功能读这份文档）

| | 状态 |
| --- | --- |
| 浏览货架、看详情、收藏 | **已可用**（设置 → 插件管理 → 「浏览市场」）|
| 点一下就把包装进本机 | **还没接通**（下一批做；所以市场页上没有安装按钮）。现在要装：把 `market/pkg/**` 编译出来的那个 `.uartix.json` 拷出来，走 设置 → 插件管理 → 导入 |
| 截图预览 | **还没接通**（详情页只说作者给没给图）|
| 改索引地址 / 镜像前缀 | 设置页里**还没有这两行**（`settingsStore` 字段已就位，UI 在后续批次）；现在固定用应用自带的示例货架 |

## 交两样东西，跑一条命令

1. **包源**，二选一：
   - `market/pkg/<名字>.uartix.json` —— 成品包，字节原样上架（**设置 → 插件管理 → 导出** 出来的就是这个形状，多数时候你不用手写）；
   - `market/pkg/<名字>/manifest.json` ＋旁挂真实文件 —— 适合要写 HTML/CSS 的小部件与面板：
     产物里把内联字段改成 `<字段>File` 指向同目录的文件，生成器负责读进来。

   ```json
   {
     "artifacts": {
       "rig.json": { "kind": "widget", "format": "html", "htmlFile": "rig.html" }
     }
   }
   ```
   `rig.html` 就是普通 HTML（可以换行、可以写 `"`），编译后上架包里是 `"html": "<div>…</div>"`。
   **投稿文件是严格 JSON：不能带注释**（本仓库文档里的注释只是说明，别照抄）。
2. **元数据**：`market/entries/<名字>.json` —— 只写货架要显示的东西，**不写哈希和字节数**。字段见下面《元数据字段》。

```sh
npm run market:gen      # 编译源包 → 算 sha256 与字节数 → 对账 → 写 public/market/index.json
npm run test -- market  # 货架内容测试：包过生产校验器 / 索引与包一致 / 解析零丢弃 / 无孤儿源
```

## 元数据字段（`market/entries/*.json`）

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` `name` `author` `category` | 是 | `id` 小写点分；`category` 必须是 `market/categories.json` 里的键 |
| `description` | 是 | `{ zh, en? }`，`zh` 必填、`en` 可选（缺了就只显一种，界面不替你补）|
| `version` `minAppVersion` `updated` | 是 | 前两个必须与包里一致；`updated` 为 `YYYY-MM-DD` |
| `packageFile` | 是 | `"<名字>.uartix.json"` 或 `"<名字>/"`（目录源）|
| `publicUrl` | 是 | 同源地址**末段必须等于实际产物名**：目录源 `rig/` ⇒ `/market/pkg/rig.uartix.json`（不一致就构建失败，别留到装机 404）|
| `capabilities` | 是 | 与包里逐字一致；多一项少一项都构建失败 |
| `screenshots` | 否 | 最多 8 张；同源文件必须真实存在 |
| `homepage` / `discussion` / `changelogUrl` | 否 | 只收 https 且域在白名单内（`raw.githubusercontent.com`、`github.com`）|

## 会被直接拒掉的六种情形（都是故意的）

| 情形 | 为什么 |
| --- | --- |
| 元数据写 1 KB、包实际 90 KB（或反之）| 哈希与字节数由生成器算，作者说了不算——否则"货架写的"和"给你的"可以不是同一件东西 |
| 元数据声明 `ui.widget`、包里其实还带 `serial.send` | **提权必须在货架上就露出来**：能力逐项比对，不一致就构建失败 |
| `publicUrl` 与编译产物名不一致 | 索引不会红，**用户点安装才 404**（N1 就是这么漏的），所以这里先失败 |
| `<目录>/manifest.json` 与同名 `.uartix.json` 并存 | 两份都在，"上架的是哪一份"没人说得清 ⇒ 先删一份 |
| 旁挂文件写 `../x.html` 或绝对路径 | 那就等于允许投稿人把仓库里任意文件灌进上架包。**只许包目录内相对路径**（与 `..` 越界同族红线）|
| 旁挂文件不存在 / 截图文件不存在 | 宁可构建失败，也不上架一个装不开或显示坏图的条目 |

（大小没到货架上限也会被契约判掉：包 4 MiB、单图 4 MiB、索引 2 MiB。超限是"这不是货架该给的东西"。）

## 三条你装进来后会看到的行为（不是 bug）

- **默认停用**：带 `logic.run` / `agent.tool` / `serial.send` / `win.control` / `workspace.preset` 这几类能力的包**不属于自动放行集**，要在插件库里手动打开一次才生效。这是 P99a-B 定的红线，市场不例外。
- **一次点击**（安装链接通之后）：确认框一次把来源、字节、哈希前 12 位、要用的能力（中文名）说清；点"安装"就装，不逐条再问。
- **市场不是背书**：索引里有 `verified` 也只表示"这条来自当前索引、过了生成器"，**不代表内容安全**。装自己信得过的来源。

## 想把自己的库接进来

设置项还没做进界面（见上面那张状态表）。字段已经就位：`settings.marketIndexUrl`（默认 `/market/index.json`）
与 `settings.marketMirrorPrefix`（默认空，只在直连失败后才试，且它自己的域也要过白名单）。
