# Changelog

## 1.0.2 - 2026-09-13

### Fixes

- backfill-shots 打开小红书存量笔记改走「回主页点卡片」，让 XHS 带新 xsec_token 打开，修复旧链接 token 过期后补图永不收敛（找不到博主/卡片时退回裸链）
- 飞书读路径校验 data 与 record_id_list 等长，不等长即中止，防截图错位挂错记录（storage 与 backfill-shots 同步加固）
- dry-run 模式 written 计 0，stats 不再把未写入量虚报成「已入库」
- 过滤后无匹配博主时明确告警并以非零退出码结束，不再静默空跑报「无新增」
- 关闭存量 Chrome 前校验 profileDir 特异性，防误配短路径误杀无关进程
- 声明增强采集脚本信任边界等同登录态，加载时打印 sha256 供审计

## 1.0.1 - 2026-07-31

### Fixes

- Enforce the effective per-run collection limit consistently, including backfill mode.
- Validate invalid limit values and report the actual limit that stopped collection.
- Add deterministic regression coverage and CI for the runtime safety valve.
