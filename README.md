# HeiGe-CommentRadar

<div align="center">

![Version](https://img.shields.io/badge/version-1.0.0-7c3aed.svg)
![Agents](https://img.shields.io/badge/agents-universal-orange.svg)
![Platforms](https://img.shields.io/badge/platforms-小红书%20·%20抖音%20·%20B站-e11d48.svg)
![License](https://img.shields.io/badge/license-PolyForm%20NC-64748b.svg)

**评论雷达 · 把博主评论区变成你的选题素材库 | Turn creator comment sections into your content idea vault**

盯一批博主，谁更新了就抓热门评论和截图，攒成一张可以翻的素材表

[这是什么](#这是什么-what-is-this) • [下载即用](#快速开始-quick-start) • [三层玩法](#三层玩法-progressive-setup) • [多 Agent 支持](#多-agent-支持-works-with-any-agent) • [许可证](#许可证-license)

</div>

---

## 这是什么 What is this

做内容的人都知道：**选题的金矿在评论区**。用户在热门评论里说的话，就是下一篇爆款的标题、痛点和钩子。问题是逛评论区太费时间，看完就忘，好评论找不回来。

CommentRadar 帮你把这件事自动化：

1. 你在配置里列一批想盯的博主（小红书 / 抖音 / B站）
2. 它定期打开博主主页，发现新内容（视频 / 笔记 / 图文）就抓评论区
3. 按点赞把热门评论排序取前 10 条入库，**每条评论配一张该评论的元素级截图**（含作者名、时间、点赞、子回复，直接可以当文章配图）
4. 全部沉淀进本地表格（CSV 用 Excel 直接开）或飞书多维表格，越攒越厚

### 它能做什么

- ✅ 监控三平台博主更新：小红书（视频+图文笔记）、抖音、B站
- ✅ 抓每条新内容的热门评论 top10，按点赞排序，自动生成「可转化选题」
- ✅ 三类截图各归其位：内容截图（笔记本体）、评论截图（逐条评论卡片，一一对应）、博主主页截图（一人一张）
- ✅ 截图按 2 倍物理像素渲染，清晰度直接达到发文配图标准
- ✅ 去重幂等：抓过的内容自动跳过，中断了重跑就续上
- ✅ 慢节奏拟人化采集（页面间隔分钟级随机），把账号安全放在速度前面
- ✅ 历史回填：一条命令把某博主某年的全部内容和评论补齐

### 适合谁

- 自媒体作者和内容团队：从对标账号评论区挖选题、挖用户原话
- 运营和产品：持续监听目标人群在聊什么、骂什么、求什么
- Agent 玩家：全 CLI 设计，Claude Code / Codex / OpenClaw 直接指挥它干活

## 为什么不一样 Why it's different

| 维度 | 常见做法 | CommentRadar |
|---|---|---|
| 拿数据的方式 | 调接口、逆向、爬虫框架 | 真浏览器打开真页面，只看你本来就能看到的内容 |
| 评论留档 | 复制文字，出处丢失 | 每条评论一张元素级截图，作者/时间/子回复全在图里 |
| 账号安全 | 拼速度，容易触发风控 | 拟人化慢节奏，间隔分钟级随机，宁慢勿封 |
| 上手门槛 | 先配数据库、先申请 key | 下载即用：本地 CSV 开箱，绑定飞书是可选升级 |
| 中断恢复 | 重跑重复入库 | 唯一键去重，断点续跑，天生幂等 |
| 给谁用 | 人看代码 | 人和 AI Agent 都能直接开工（SKILL.md / AGENTS.md 内置） |

## 快速开始 Quick Start

前置：Node.js 18+，本机装有 Google Chrome。

```bash
git clone https://github.com/HeiGeAi/HeiGe-CommentRadar.git
cd HeiGe-CommentRadar
npm install
cp config.example.json config.json
./run.sh
```

就这五步。示例配置自带一个 B站博主（游客模式免登录），跑完去 `.runtime/data/` 看结果：

```text
.runtime/data/videos.csv     视频更新表（Excel/Numbers 直接打开）
.runtime/data/comments.csv   热门评论表，含每条评论的截图路径
.runtime/data/runs.csv       运行日志
.runtime/screenshots/<日期>/  全部截图原图
```

然后把 `config.json` 里 `creators` 换成你自己想盯的博主就是你的雷达了。

## 三层玩法 Progressive setup

**L0 下载即用（零登录零绑定）**：上面五步就是。B站游客模式全功能；数据落本地 JSONL + CSV。

**L1 扫码登录（解锁小红书 / 抖音）**：这两个平台看评论需要登录（平台规则），扫你自己的号即可，登录态只存在本地专用 Chrome profile 里：

```bash
./run.sh --login-setup --platform=xiaohongshu   # 弹出专用 Chrome，扫码
./run.sh --login-setup --platform=douyin        # 注意参数带等号
./run.sh --login-check                          # 复核登录态
```

**L2 绑定飞书（完全体）**：数据进多维表格，截图变成表内附件点开即看，手机上也能翻：

```bash
npm install -g @larksuite/cli && lark-cli auth login   # 官方 CLI，登录你的飞书
node init-feishu-base.mjs                              # 一键建库四张表，自动写回 config
./run.sh                                               # 之后数据直接进飞书
node backfill-shots.mjs --dry-run                      # 存量记录补截图（可选）
```

每一层都是完整可用的，绑定只是让它表现更好。飞书模式下如果想要博主主页截图自动归档，需要先在「博主清单」表手动填好各博主行（博主名 + 平台），采集时会给缺图的博主补主页截图。本地模式不需要这步，自动管理。

## 常用命令

```bash
./run.sh                                          # 正式采集（慢节奏）
./run.sh --limit-new=1                            # 小步验证：入库 1 条就收工
./run.sh --only-platform=bilibili                 # 只跑某平台
./run.sh --backfill --year=2026 --creator-match=某博主   # 历史回填
./run.sh --no-screenshots                         # 关截图
./run.sh --fast-test --limit-creators=1 --dry-run # 排障（不写数据）
```

采集节奏、每轮上限、评论条数都在 `config.json` 的 `runtime` 里，默认值偏保守，建议别调快。

## 多 Agent 支持 Works with any agent

CommentRadar 是纯 CLI，任何能执行命令的 AI Agent 都能直接指挥它。仓库内置两份 Agent 说明书：`SKILL.md`（Claude Code 技能格式）和 `AGENTS.md`（通用 Agent 操作指引）。

**Claude Code（主推）**：

```bash
git clone https://github.com/HeiGeAi/HeiGe-CommentRadar.git ~/.claude/skills/HeiGe-CommentRadar
cd ~/.claude/skills/HeiGe-CommentRadar && npm install && cp config.example.json config.json
```

装完对 Claude 说「帮我盯这几个博主的评论区」，它会读 SKILL.md 自己上手。

<details>
<summary><b>Codex</b></summary>

```bash
git clone https://github.com/HeiGeAi/HeiGe-CommentRadar.git
cd HeiGe-CommentRadar && npm install && cp config.example.json config.json
```

Codex 会自动读仓库根目录的 `AGENTS.md` 拿到全部操作指引。直接说「用 CommentRadar 抓一下某某博主的评论」。

</details>

<details>
<summary><b>OpenClaw</b></summary>

```bash
git clone https://github.com/HeiGeAi/HeiGe-CommentRadar.git
cd HeiGe-CommentRadar && npm install && cp config.example.json config.json
```

把 `AGENTS.md` 的内容加进你的 workspace 说明（或直接让它读这个文件），OpenClaw 即可按里面的命令表驱动采集。

</details>

<details>
<summary><b>Cursor / Cline / 其它</b></summary>

clone + `npm install` + 复制 config 之后，让 Agent 读 `AGENTS.md`。所有能力都是 `./run.sh` 的参数，没有隐藏状态。

</details>

## 截图映射（一一对应铁律）

```text
内容截图 → 视频更新表：每条内容只挂这篇笔记本体一张图
评论截图 → 热门评论表：每条评论挂「该条评论」的元素级截图，按 内容+作者名 双向核验定位，
          核不上宁可不截，绝不挂错人的评论
主页截图 → 博主清单：一博主一张，缺图才补
```

## 使用边界 Fair use

- 它只用真浏览器访问公开页面，只看你登录后本来就能看到的内容，无接口逆向、无付费墙绕过
- 采集数据请自用（选题研究、竞品分析），转载他人内容请遵守平台规则和著作权法
- 默认慢节奏是刻意设计，请勿改成高频抓取
- 各平台页面结构会改版，内置采集器的选择器可能需要跟进更新，欢迎提 issue

## English

**CommentRadar** watches a list of creators on Xiaohongshu (RED), Douyin, and Bilibili. When someone posts new content, it opens the page in a real Chrome browser, grabs the top-liked comments, and takes pixel-perfect element screenshots of each comment (author, timestamp, likes, replies included). Everything lands in local CSV/JSONL files out of the box, or in a Feishu (Lark) Base if you connect one.

Why people use it: comment sections are where your next viral post is hiding. This tool turns them into a searchable, screenshot-backed idea vault.

**Quick start**: `git clone` → `npm install` → `cp config.example.json config.json` → `./run.sh`. The sample config ships with a Bilibili creator that works without any login. Xiaohongshu and Douyin require scanning a QR code with your own account (`./run.sh --login-setup`). Feishu binding is optional (`node init-feishu-base.mjs`).

Agent-friendly by design: `SKILL.md` for Claude Code, `AGENTS.md` for Codex / OpenClaw / any CLI-capable agent.

## 致谢 | Credits

由 [@HeiGeAi](https://github.com/HeiGeAi) 打造。源自一个真实需求：每天从对标博主的评论区里挖选题，手动逛了半年之后决定让 AI 来。

## 许可证 | License

[PolyForm Noncommercial 1.0.0](LICENSE)

- ✅ 个人使用、学习、研究免费
- ✅ 修改、分发，保留署名即可
- ❌ 未经授权的商业使用
- 💼 商用请先联系授权：[@HeiGeAi](https://github.com/HeiGeAi)

Free for noncommercial use. For commercial licensing, contact [@HeiGeAi](https://github.com/HeiGeAi).
