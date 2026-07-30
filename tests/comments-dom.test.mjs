import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

import {
  dedupeParsedComments,
  parseCommentContainer,
} from '../collectors-builtin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function launchChromium() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    try {
      return await chromium.launch({ channel: 'chrome', headless: true });
    } catch {
      throw error;
    }
  }
}

test('DOM fixture parsing keeps numeric content and deduplicates exact comments', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    const fixture = fs.readFileSync(path.join(ROOT, 'tests/fixtures/bilibili-comments.html'), 'utf8');
    await page.setContent(fixture);
    const handles = await page.$$('[data-comment]');
    const parsed = [];
    for (const handle of handles) parsed.push(await handle.evaluate(parseCommentContainer));

    assert.deepEqual(parsed[0], {
      author: '小明',
      content: '666',
      publishTime: '2小时前',
      likes: '18',
    });
    assert.doesNotMatch(parsed[0].content, /ignored|color/);
    assert.equal(dedupeParsedComments(parsed).length, 2);
    assert.equal(dedupeParsedComments(parsed)[1].content, '666，但这一条结尾不同');
  } finally {
    await browser.close();
  }
});
