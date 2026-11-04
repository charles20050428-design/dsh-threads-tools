import { createThreadsController, ME } from './browser.mjs';
import { loadState, saveState, repliedToday, recordReply, bumpQuota, quotaLeft, isSeen, markSeen } from './state.mjs';

export const name = 'threads-browser';
export const inject = ['tools'];

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string' },
    result: { type: 'object', additionalProperties: true },
  },
  required: ['tool', 'result'],
};

function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value.result, null, 2) }];
}

const empty = () => ({ type: 'object', properties: {}, additionalProperties: false });

export async function apply(ctx) {
  const controller = createThreadsController();
  const state = loadState();

  const tools = [
    {
      name: 'threads_status',
      description: '讀取 Threads 工具狀態：是否已登入、專用瀏覽器視窗、今日回覆額度。開始任何 Threads 操作前先呼叫。',
      parameters: empty(),
      run: async () => {
        const st = await controller.status();
        return { ...st, quota: { date: state.quota.date, used: state.quota.count, left: quotaLeft(state) } };
      },
    },
    {
      name: 'threads_notifications',
      description: '讀取「動態 → 回覆」：別人回覆我的留言，最新在最上面。預設只回「還沒回過」的（已回的靠 state 快取過濾，省上下文）。回傳 [{user, time, text, replyUrl, replied}]。limit 預設 10、最多 100；scroll 往下滾幾次（預設 2、最多 8）。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '回傳幾則，預設 10、最多 100' },
          scroll: { type: 'integer', description: '往下滾幾次載入更多，預設 2、最多 8' },
          includeReplied: { type: 'boolean', description: 'true 就連已回的一起列出（預設 false，只給未回的）' },
        },
        additionalProperties: false,
      },
      run: async ({ limit = 10, scroll = 2, includeReplied = false } = {}) => {
        const st = await controller.status();
        if (!st.loggedIn) return { loggedIn: false, hint: '請在 Threads 專用 Edge 視窗登入後重試' };
        const list = await controller.listActivityReplies(Math.max(1, Math.min(Number(limit) || 10, 100)), scroll);
        const all = list.map((c) => ({
          user: c.user,
          time: c.time,
          text: c.text.slice(0, 80),
          replyUrl: c.replyUrl,
          replied: c.repliedIcon === true || repliedToday(state, c.user),
        }));
        const replies = includeReplied ? all : all.filter((r) => !r.replied);
        return { loggedIn: true, replies, counts: { total: all.length, unanswered: all.filter((r) => !r.replied).length } };
      },
    },
    {
      name: 'threads_reply',
      description: '回覆一則 Threads 留言（可純文字或貼圖）。user 是對方帳號（不含 @）；text 是文字內容；imagePath 是圖片絕對路徑（給圖就貼圖，text 可空）；replyUrl 可從 threads_notifications 帶入。同一帳號一天只回一次。',
      parameters: {
        type: 'object',
        properties: {
          user: { type: 'string', description: '對方帳號，不含 @' },
          text: { type: 'string', description: '回覆文字（貼圖時可空）' },
          imagePath: { type: 'string', description: '可選：圖片絕對路徑，例如 C:/.../sticker.png' },
          replyUrl: { type: 'string', description: '可選：threads_notifications 回傳的 replyUrl' },
        },
        required: ['user'],
        additionalProperties: false,
      },
      run: async ({ user, text, replyUrl, imagePath }) => {
        if (!user) throw new Error('user 必填');
        if (!text && !imagePath) throw new Error('text 和 imagePath 至少要給一個');
        if (repliedToday(state, user)) return { ok: false, error: `今天已回覆過 @${user}，同一人一天只回一次` };
        if (quotaLeft(state) <= 0) return { ok: false, error: '今日回覆額度用完' };
        const r = await controller.replyToActivity(user, text ?? '', replyUrl, imagePath);
        if (r.ok) {
          recordReply(state, user, text ?? '[圖片]', null);
          markSeen(state, r.replyUrl, user);
          bumpQuota(state);
          saveState(state);
        } else if (r.alreadyReplied) {
          markSeen(state, r.replyUrl, user);
          saveState(state);
        }
        return { ...r, user, left: quotaLeft(state) };
      },
    },
    {
      name: 'threads_peek',
      description: '只讀不發：打開一則留言頁，回傳可見文字、有沒有「尚無回覆」、以及大張圖片 URL（純圖片留言用，把 URL 拿去看圖再決定怎麼回）。',
      parameters: {
        type: 'object',
        properties: { replyUrl: { type: 'string', description: 'threads_notifications 回傳的 replyUrl' } },
        required: ['replyUrl'],
        additionalProperties: false,
      },
      run: async ({ replyUrl }) => {
        if (!replyUrl) throw new Error('replyUrl 必填');
        return await controller.peek(replyUrl);
      },
    },
    {
      name: 'threads_post',
      description: '發一篇新串文（Threads 貼文）。text 是內容；imagePath 可選附圖。會點「新串文」、填字（可附圖）、按「發佈」。發文前可以先跟用戶確認內容。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '貼文內容' },
          imagePath: { type: 'string', description: '可選：圖片絕對路徑' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      run: async ({ text, imagePath }) => {
        if ((!text || !text.trim()) && !imagePath) throw new Error('text 和 imagePath 至少要給一個');
        return await controller.post(text ?? '', imagePath);
      },
    },
    {
      name: 'threads_feed',
      description: '讀 Threads 首頁推薦流（別人的貼文），回傳 [{user, text, postUrl}]。用來學網路用語、看什麼在紅。只讀，按讚或回覆要另外做。limit 預設 12、最多 40；scroll 往下滾幾次（預設 2、最多 8）。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '回傳幾則，預設 12、最多 40' },
          scroll: { type: 'integer', description: '往下滾幾次，預設 2、最多 8' },
        },
        additionalProperties: false,
      },
      run: async ({ limit = 12, scroll = 2 } = {}) => {
        const list = await controller.feed(Math.max(1, Math.min(Number(limit) || 12, 40)), scroll);
        return { count: list.length, posts: list };
      },
    },
    {
      name: 'threads_comment',
      description: '在別人的帖子下留言（主動評論）。postUrl 來自 threads_feed；text 是內容；imagePath 可選附圖。挑有趣/熱門的再留，別刷成機器人。',
      parameters: {
        type: 'object',
        properties: {
          postUrl: { type: 'string', description: '帖文路徑，例如 /@someone/post/xxx' },
          text: { type: 'string', description: '留言內容（附圖時可空）' },
          imagePath: { type: 'string', description: '可選：圖片絕對路徑' },
        },
        required: ['postUrl'],
        additionalProperties: false,
      },
      run: async ({ postUrl, text, imagePath }) => {
        if (!postUrl) throw new Error('postUrl 必填');
        if ((!text || !text.trim()) && !imagePath) throw new Error('text 和 imagePath 至少要給一個');
        if (quotaLeft(state) <= 0) return { ok: false, error: '今日回覆額度用完' };
        const r = await controller.comment(postUrl, text ?? '', imagePath);
        if (r.ok) { bumpQuota(state); saveState(state); }
        return { ...r, left: quotaLeft(state) };
      },
    },
  ];

  const disposers = [];
  for (const tool of tools) {
    disposers.push(ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      timeoutMs: 180000,
      output: { schema: OUTPUT_SCHEMA, render: renderValue },
      async execute(args = {}, exec = {}) {
        exec.signal?.throwIfAborted();
        try {
          const result = await tool.run(args);
          return { tool: tool.name, result: result && typeof result === 'object' ? result : { value: result } };
        } catch (error) {
          return { tool: tool.name, result: { ok: false, error: error instanceof Error ? error.message : String(error) } };
        }
      },
    }));
  }

  ctx.effect(() => async () => {
    for (const dispose of disposers.reverse()) { try { dispose?.(); } catch {} }
    await controller.close();
  });
}

export default { name, inject, apply };
