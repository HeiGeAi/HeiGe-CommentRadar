---
name: HeiGe-CommentRadar
description: 采集小红书 / 抖音 / B站博主的最新内容和评论区，配截图沉淀成选题素材库（本地文件或飞书多维表格）。当用户想监控/追踪自媒体博主的内容更新和评论、抓小红书/抖音/B站评论区、搭评论选题素材库、做对标或竞品账号监控时使用。即使只说「帮我盯这几个博主」「抓一下这些账号的评论」「把评论存下来」，只要意图是采集自媒体内容评论并归档就触发。不用于发布内容、代运营、单纯搜一条笔记。
---

# HeiGe-CommentRadar 评论雷达

盯一批博主，谁更新了就抓热门评论和截图，攒成一张可以翻的选题素材表。三平台：小红书 / 抖音 / B站。

## 首次安装（对用户做这几步）

```bash
cd <本 skill 目录>
npm install                          # 装 playwright（走系统 Chrome，不下浏览器）
cp config.example.json config.json   # 本地配置，不进仓库
```

前置：Node 18+，本机装有 Google Chrome。

## 分层能力（按用户已绑定的东西循序渐进）

- **L0 下载即用**：不登录、不绑定，直接 `./run.sh`。B站游客模式全功能，数据落 `.runtime/data/`（JSONL + CSV）。示例配置自带一个 B站博主，第一条就能跑通给用户看效果。
- **L1 扫码登录**：小红书 / 抖音看评论要登录，扫用户自己的号。登录态只存本地 profile。
- **L2 绑定飞书**：数据进多维表格，截图变表内附件。

## 命令表

```bash
./run.sh                                  # 正式采集（慢节奏防风控）
./run.sh --limit-new=1                    # 小步验证：入库 1 条就收工（给用户看效果先用这个）
./run.sh --login-setup --platform=xiaohongshu   # 弹专用 Chrome 扫码（参数带等号）
./run.sh --login-setup --platform=douyin
./run.sh --login-check                    # 复核登录态
./run.sh --only-platform=bilibili         # 只跑某平台
./run.sh --backfill --year=2026 --creator-match=某博主   # 历史回填
./run.sh --no-screenshots                 # 关截图
node init-feishu-base.mjs                 # L2：一键建飞书四表，自动写回 config
node backfill-shots.mjs --dry-run         # L2：给飞书存量记录补截图
```

## 配置要点

`config.json` 里改 `creators` 数组填要盯的博主：`name` + `platform`（xiaohongshu/douyin/bilibili）+ `profileUrl`（浏览器地址栏复制的主页链接）。B站建议用空间投稿页 `https://space.bilibili.com/<uid>/video`。

`storage.mode`：`local`（默认，本地文件）或 `feishu`（跑过 init-feishu-base.mjs 会自动切）。`runtime` 里是采集节奏和上限，默认保守，别调快，账号安全优先。

飞书模式下博主主页截图要自动归档的话，得先在「博主清单」表手动填好各博主行（博主名 + 平台）；本地模式自动管理不用管。

## 截图归位铁律

内容截图→视频表；评论截图→评论表（每条评论一张元素级卡片，含作者/时间/子回复，按内容+作者名双向核验定位，核不上宁可不截）；主页截图→博主清单（一博主一张）。截图 2 倍物理像素，可直接当发文配图。

## 给用户交付时

跑完提醒用户去看 `.runtime/data/comments.csv`（Excel 直接开）或飞书表。截图原图在 `.runtime/screenshots/<日期>/`。别用 `--fast-test` / `--dry-run` 跑正式采集，那只用于排障。

采集是慢节奏（页面间隔分钟级），一轮十几个博主要跑一两小时，属正常，别催。
