/**
 * smoke.mjs — 不啟動瀏覽器的最小檢查
 *
 * 驗證：插件能被載入、export 正確、七個工具都註冊了、schema 是合法 JSON Schema 物件、
 * 而且每個工具都有 execute。會載入 playwright-core（但不 launch 瀏覽器）。
 *
 *   node test/smoke.mjs
 */
import { name, inject, apply } from '../index.js';

const registered = [];
const ctx = {
  tools: { register: (t) => { registered.push(t); return () => {}; } },
  effect: () => {}, // 不要觸發 dispose，避免 close() 真的去收瀏覽器
};

await apply(ctx);

const expected = [
  'threads_status',
  'threads_notifications',
  'threads_reply',
  'threads_peek',
  'threads_feed',
  'threads_comment',
  'threads_post',
];

const fail = [];
if (name !== 'threads-browser') fail.push(`plugin name should be "threads-browser", got "${name}"`);
if (!Array.isArray(inject) || !inject.includes('tools')) fail.push('inject should include "tools"');
if (registered.length !== expected.length) fail.push(`registered ${registered.length} tools, expected ${expected.length}`);

for (const tool of registered) {
  if (typeof tool.name !== 'string') fail.push('a tool is missing name');
  if (typeof tool.description !== 'string' || !tool.description) fail.push(`${tool.name}: missing description`);
  if (typeof tool.execute !== 'function') fail.push(`${tool.name}: missing execute`);
  if (tool.parameters?.type !== 'object') fail.push(`${tool.name}: parameters must be a JSON Schema object`);
  if (tool.output?.schema?.type !== 'object') fail.push(`${tool.name}: output schema must be a JSON Schema object`);
  if (typeof tool.output?.render !== 'function') fail.push(`${tool.name}: output.render must be a function`);
}

for (const want of expected) {
  if (!registered.some((t) => t.name === want)) fail.push(`missing tool: ${want}`);
}

if (fail.length) {
  console.error('FAIL');
  for (const f of fail) console.error(' - ' + f);
  process.exit(1);
}

console.log(`OK — ${registered.length} tools registered: ${registered.map((t) => t.name).join(', ')}`);
