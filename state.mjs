import fs from 'node:fs';
import path from 'node:path';

/** 狀態目錄：預設 ~/.dsh/threads-browser，可用 THREADS_STATE_DIR 覆寫（測試或隔離環境用）。 */
function stateDir() {
  if (process.env.THREADS_STATE_DIR) return process.env.THREADS_STATE_DIR;
  return path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'threads-browser');
}

const stateFile = () => path.join(stateDir(), 'state.json');

const EMPTY = () => ({ replies: [], seen: {}, quota: { date: '', count: 0 } });

export function statePath() { return stateFile(); }

export function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return { ...EMPTY(), ...raw, seen: { ...(raw.seen || {}) }, quota: { ...EMPTY().quota, ...(raw.quota || {}) } };
  } catch { return EMPTY(); }
}

export function saveState(state) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

export function today() {
  return new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
}

export function quotaLeft(state, limit = 60) {
  const q = state.quota;
  if (q.date !== today()) return limit;
  return Math.max(0, limit - q.count);
}

export function bumpQuota(state) {
  const t = today();
  if (state.quota.date !== t) state.quota = { date: t, count: 0 };
  state.quota.count += 1;
}

/** 同一帳號一天只回一次：回傳今天是否已回過該 user。 */
export function repliedToday(state, user) {
  const t = today();
  return state.replies.some((r) => r.user === user && r.at?.startsWith(t));
}

/** 「某條留言處理過」快取：key 用 replyUrl（每條留言唯一），跨天也記得，但不會擋掉同一個人的新留言。 */
export function markSeen(state, key, user) {
  if (!key) return;
  state.seen[key] = { at: new Date().toISOString(), user: user || null };
  const keys = Object.keys(state.seen);
  if (keys.length > 1200) {
    // Object.keys 對非整數 key 會保留插入順序，砍掉開頭（最舊）即可。
    // 原本用 timestamp 排序會在同一毫秒連續寫入時排不穩，砍錯筆。
    const next = {};
    for (const k of keys.slice(-900)) next[k] = state.seen[k];
    state.seen = next;
  }
}

export function isSeen(state, key) {
  return !!state.seen[key];
}

export function recordReply(state, user, text, itemId) {
  state.replies.push({ user, text, itemId: itemId ?? null, at: new Date().toISOString() });
  if (state.replies.length > 500) state.replies = state.replies.slice(-500);
}
