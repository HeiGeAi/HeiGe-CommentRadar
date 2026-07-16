/**
 * 计算本轮允许处理的新内容数。
 *
 * `--limit-new` 是更严格的临时上限，回填模式也必须尊重它。配置值为 0
 * 或缺省时表示不设上限。
 */
export function parseRunLimit(value, label) {
  const parsed = value === null || value === undefined || value === '' ? 0 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} 必须是 0 或正整数`);
  }
  return parsed;
}

export function effectiveVideoLimit({ configuredLimit, limitNew, backfill }) {
  const configValue = parseRunLimit(configuredLimit, 'config.runtime.maxVideosPerRun');
  const explicitValue = parseRunLimit(limitNew, '--limit-new');
  const baseLimit = backfill || configValue <= 0 ? Infinity : configValue;
  return explicitValue > 0 ? Math.min(baseLimit, explicitValue) : baseLimit;
}

export function videoLimitReachedMessage(limit) {
  return `已达到本轮最大新视频处理数：${limit}`;
}
