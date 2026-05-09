#!/usr/bin/env node

const baseUrl = process.env.BASE_URL;
const apiKey = process.env.CLIENT_API_KEY;

if (!baseUrl) throw new Error('Missing BASE_URL');
if (!apiKey) throw new Error('Missing CLIENT_API_KEY');

async function call(path, init = {}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    ...(init.headers || {}),
  };
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

function parseSse(text) {
  const events = text.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
  const chunks = [];
  let done = false;
  for (const ev of events) {
    if (!ev.startsWith('data: ')) continue;
    const payload = ev.slice(6);
    if (payload === '[DONE]') {
      done = true;
      continue;
    }
    chunks.push(JSON.parse(payload));
  }
  return { chunks, done };
}

async function main() {
  const modelRes = await call('/models');
  if (!modelRes.ok) throw new Error(`/models failed: ${modelRes.status}`);
  const modelJson = await modelRes.json();
  const ids = modelJson.data.map(m => m.id);
  if (!ids.includes('gemini-3-flash-thinking')) {
    throw new Error('gemini-3-flash-thinking missing from model list');
  }

  const streamBody = {
    model: 'gemini-3-flash-thinking',
    stream: true,
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: '请先进行详细思考，再给出最终答案。题目：小明有3个苹果，又买了2个，吃掉1个，还剩几个？'
      }
    ]
  };

  const streamRes = await call('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(streamBody),
  });
  if (!streamRes.ok) throw new Error(`/chat/completions stream failed: ${streamRes.status} ${await streamRes.text()}`);

  const text = await streamRes.text();
  const { chunks, done } = parseSse(text);
  const nonNullFinish = chunks.filter(c => c.choices?.[0]?.finish_reason != null);
  const prematureFinish = chunks.slice(0, -1).some(c => c.choices?.[0]?.finish_reason != null);
  const finalChunk = chunks[chunks.length - 1];
  const reasoningChunkCount = chunks.filter(c => typeof c.choices?.[0]?.delta?.reasoning_content === 'string' && c.choices[0].delta.reasoning_content.length > 0).length;
  const contentChunkCount = chunks.filter(c => typeof c.choices?.[0]?.delta?.content === 'string' && c.choices[0].delta.content.length > 0).length;

  const summary = {
    baseUrl,
    modelPresent: true,
    status: streamRes.status,
    chunkCount: chunks.length,
    done,
    nonNullFinishCount: nonNullFinish.length,
    finalFinish: finalChunk?.choices?.[0]?.finish_reason ?? null,
    reasoningChunkCount,
    contentChunkCount,
    hasUsageOnFinal: Boolean(finalChunk?.usage),
    prematureFinish,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!done) throw new Error('stream did not end with [DONE]');
  if (nonNullFinish.length !== 1) throw new Error('finish_reason should appear exactly once');
  if (prematureFinish) throw new Error('finish_reason appeared before final chunk');
  if (!finalChunk?.usage) throw new Error('final chunk missing usage');
}

main().catch(err => {
  console.error(err.stack || String(err));
  process.exit(1);
});
