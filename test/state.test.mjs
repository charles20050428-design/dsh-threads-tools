/**
 * state.test.mjs — 狀態層的單元測試（不碰真實的 ~/.dsh，全部在暫存目錄跑）
 *
 *   node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-state-'));
process.env.THREADS_STATE_DIR = dir;

const {
  statePath, loadState, saveState, today, quotaLeft, bumpQuota, repliedToday, markSeen, isSeen, recordReply,
} = await import('../state.mjs');

const day = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('sv-SE');
};

test('statePath follows THREADS_STATE_DIR', () => {
  assert.equal(statePath(), path.join(dir, 'state.json'));
});

test('loadState returns defaults when the file is missing', () => {
  assert.deepEqual(loadState(), { replies: [], seen: {}, quota: { date: '', count: 0 } });
});

test('saveState then loadState round-trips', () => {
  const s = { replies: [{ user: 'bob', text: 'hi', itemId: null, at: '2026-11-04T00:00:00.000Z' }], seen: {}, quota: { date: day(), count: 3 } };
  saveState(s);
  const back = loadState();
  assert.deepEqual(back.replies, s.replies);
  assert.deepEqual(back.quota, s.quota);
});

test('quotaLeft is full on a new day, counts down today, floors at zero', () => {
  assert.equal(quotaLeft({ quota: { date: '', count: 0 } }), 60);
  assert.equal(quotaLeft({ quota: { date: day(-1), count: 55 } }), 60, 'yesterday does not count');
  assert.equal(quotaLeft({ quota: { date: day(), count: 10 } }), 50);
  assert.equal(quotaLeft({ quota: { date: day(), count: 99 } }), 0);
  assert.equal(quotaLeft({ quota: { date: day(), count: 10 } }, 5), 0, 'custom limit is respected');
});

test('bumpQuota resets on a new day', () => {
  const s = { quota: { date: day(-1), count: 40 } };
  bumpQuota(s);
  assert.deepEqual(s.quota, { date: day(), count: 1 });
  bumpQuota(s);
  assert.equal(s.quota.count, 2);
});

test('repliedToday only matches today, per account', () => {
  const at = (d) => d + 'T12:00:00.000Z';
  const s = { replies: [
    { user: 'bob', at: at(day()) },
    { user: 'carol', at: at(day(-1)) },
  ] };
  assert.equal(repliedToday(s, 'bob'), true);
  assert.equal(repliedToday(s, 'carol'), false, 'yesterday does not block');
  assert.equal(repliedToday(s, 'dave'), false);
});

test('markSeen / isSeen ignore empty keys', () => {
  const s = { seen: {} };
  markSeen(s, '/@a/post/1', 'a');
  assert.equal(isSeen(s, '/@a/post/1'), true);
  assert.equal(isSeen(s, '/@a/post/2'), false);
  markSeen(s, '', 'a');
  assert.deepEqual(Object.keys(s.seen), ['/@a/post/1']);
});

test('markSeen trims the cache once it passes 1200, keeping the newest', () => {
  const s = { seen: {} };
  for (let i = 0; i < 1201; i++) markSeen(s, '/@a/post/' + i, 'a');
  assert.equal(Object.keys(s.seen).length, 900, 'trimmed to 900 at the 1201st entry');
  assert.equal(isSeen(s, '/@a/post/1200'), true, 'newest kept');
  assert.equal(isSeen(s, '/@a/post/0'), false, 'oldest dropped');

  for (let i = 1201; i < 1300; i++) markSeen(s, '/@a/post/' + i, 'a');
  assert.ok(Object.keys(s.seen).length <= 1200, 'never grows past the cap');
});

test('recordReply keeps at most 500 entries', () => {
  const s = { replies: [] };
  for (let i = 0; i < 520; i++) recordReply(s, 'user' + i, 'text');
  assert.equal(s.replies.length, 500);
  assert.equal(s.replies.at(-1).user, 'user519');
});

test('today() is YYYY-MM-DD', () => {
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});
