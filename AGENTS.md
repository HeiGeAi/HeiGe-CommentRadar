# AGENTS.md · HeiGe-CommentRadar

给 AI Agent（Codex / OpenClaw / Cursor / Cline 等）的操作指引。这个项目是一个纯 CLI 的多平台评论采集工具，所有能力都是 `./run.sh` 的参数，没有隐藏状态。

## 它做什么

盯一批博主（小红书 / 抖音 / B站），发现新内容就抓热门评论 top10，每条评论配一张元素级截图，沉淀进本地文件或飞书多维表格，当选题素材库。

## 环境准备

```bash
npm install                          # 装 playwright（走系统 Chrome）
cp config.example.json config.json   # 本地配置（.gitignore 已排除，不会误提交）
```

要求：Node 18+，本机装有 Google Chrome。

## 帮用户上手（推荐顺序）

1. `./run.sh --limit-new=1`：用示例配置里的 B站博主跑通第一条，让用户看到 `.runtime/data/comments.csv` 里的结果。B站游客模式免登录。
2. 编辑 `config.json` 的 `creators`，换成用户想盯的博主。
3. 要盯小红书 / 抖音：`./run.sh --login-setup --platform=xiaohongshu`（参数必须带等号），会弹专用 Chrome 让用户扫码，登录态存本地。
4. 要数据进飞书：`npm i -g @larksuite/cli && lark-cli auth login`，然后 `node init-feishu-base.mjs` 一键建库。

## 命令表

| 目的 | 命令 |
|---|---|
| 正式采集 | `./run.sh` |
| 小步验证（入库 N 条收工） | `./run.sh --limit-new=1` |
| 扫码登录某平台 | `./run.sh --login-setup --platform=douyin` |
| 复核登录态 | `./run.sh --login-check` |
| 只跑某平台 | `./run.sh --only-platform=bilibili` |
| 历史回填 | `./run.sh --backfill --year=2026 --creator-match=某博主` |
| 关截图 | `./run.sh --no-screenshots` |
| 排障（不写数据） | `./run.sh --fast-test --limit-creators=1 --dry-run` |
| 建飞书库 | `node init-feishu-base.mjs` |
| 飞书存量补图 | `node backfill-shots.mjs --dry-run` |

## 数据在哪

- 本地模式：`.runtime/data/videos.csv`、`comments.csv`、`runs.csv`（同时有 `.jsonl` 版），截图原图在 `.runtime/screenshots/<日期>/`
- 飞书模式：绑定的多维表格四张表 + 表内截图附件

## 代码结构（要改动时看这里）

```text
run-monitor.mjs        主引擎：平台适配表、去重、增量入库、截图编排、回填模式
collectors-builtin.mjs 内置 DOM 采集器（默认，零依赖）：三平台内容列表 + 评论解析
storage.mjs            存储层双后端：local(JSONL+CSV) / feishu(lark-cli 多维表格)
shot-utils.mjs         评论元素截图共用逻辑（引擎和补图脚本共用）
init-feishu-base.mjs   一键建飞书四表
backfill-shots.mjs     飞书存量记录补截图
config.example.json    配置模板
```

## 纪律

- 慢节奏是刻意设计（页面间隔分钟级随机），别为了快改小 `runtime.delays`，账号安全优先
- `--fast-test` / `--dry-run` 只用于排障，别用于正式采集
- 只访问公开页面、只看登录后本来能看到的内容，无接口逆向
- 平台会改版，内置采集器的选择器可能要跟进更新，改在 `collectors-builtin.mjs` 和 `shot-utils.mjs`
