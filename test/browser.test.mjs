/**
 * browser.test.mjs — 純函式層的測試（不會開瀏覽器，載入模組而已）
 *
 * 這些函式負責把 Threads 卡片上那段「用戶名 時間 · 作者 內容 …」的髒字串
 * 剝成真正的留言內容，UI 一改版就從這裡壞，所以值得鎖住行為。
 *
 *   node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.THREADS_ME = 'alice';
const { stripPrefix, recentUrl, isMe } = await import('../browser.mjs');

test('isMe matches only the configured handle', () => {
  assert.equal(isMe('alice'), true);
  assert.equal(isMe('bob'), false);
  assert.equal(isMe(undefined), false);
  assert.equal(isMe(''), false);
});

test('stripPrefix drops the author name', () => {
  assert.equal(stripPrefix('alice 3小時 這是一則留言', 'alice'), '這是一則留言');
});

test('stripPrefix drops relative timestamps', () => {
  assert.equal(stripPrefix('bob 5分鐘 你好', 'bob'), '你好');
  assert.equal(stripPrefix('bob 剛剛 純文字', 'bob'), '純文字');
  assert.equal(stripPrefix('bob 2天 · 作者 內容在這', 'bob'), '內容在這');
});

test('stripPrefix drops UI noise (翻譯 / 查看動態 / 熱門)', () => {
  assert.equal(stripPrefix('bob 5分鐘 翻譯 你好', 'bob'), '你好');
  assert.equal(stripPrefix('alice 1/2 查看動態 熱門 讚', 'alice'), '讚');
});

test('stripPrefix keeps the body when there is nothing to strip', () => {
  assert.equal(stripPrefix('只 有 內 容', 'alice'), '只 有 內 容');
});

test('stripPrefix survives empty / nullish input', () => {
  assert.equal(stripPrefix('', 'alice'), '');
  assert.equal(stripPrefix(null, 'alice'), '');
  assert.equal(stripPrefix(undefined), '');
});

test('stripPrefix collapses whitespace', () => {
  assert.equal(stripPrefix('alice   3小時\n\n很多   空白', 'alice'), '很多 空白');
});

test('recentUrl forces the recent sort and drops existing query', () => {
  assert.equal(recentUrl('/@a/post/123'), '/@a/post/123?sort_order=recent&filter_type=all');
  assert.equal(recentUrl('/@a/post/123?x=1'), '/@a/post/123?sort_order=recent&filter_type=all');
  assert.equal(recentUrl('https://www.threads.com/@a/post/123'), 'https://www.threads.com/@a/post/123?sort_order=recent&filter_type=all');
});
