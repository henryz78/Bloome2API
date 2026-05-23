# Bloome2API

一个把 **Bloome 内置 LLM 能力** 包装成 **OpenAI 兼容 API** 的轻量网关。

适合这些场景：
- 让支持 OpenAI API 的客户端直接接入 Bloome
- 用统一接口调用 Claude / GPT / Gemini / Kimi / GLM / DeepSeek / MiniMax
- 在 EdgeSpark 上快速部署一个自己的 API 网关

---

## 特性

- OpenAI Chat Completions 兼容接口
- OpenAI Responses API 最小无状态兼容层
- Anthropic Messages API 兼容接口
- 内置多模型路由与协议转换
- 支持 `tools` / `tool_calls`
- 支持 `-thinking` / `reasoning_content` 兼容
- 支持 CORS
- 返回 `x-request-id`
- 提供深度 `health` 检查

---

## 接口

默认前缀：`/api/public/v1`

- `GET /health`
- `GET /models`
- `POST /chat/completions`
- `POST /responses`
- `POST /responses/compact`
- `POST /responses/input_tokens`
- `POST /messages`
- `POST /messages/count_tokens`

说明：

- `/responses` 是无状态兼容层，不持久化 `response_id` / conversation；继续对话需要客户端传完整上下文。
- `/responses/compact` 返回的 compaction item 可被本项目后续请求识别，但不是 OpenAI 官方平台加密格式。
- `/responses/input_tokens` 当前仅对 Anthropic 兼容模型转发真实上游 token count；其他协议族会返回 `not_supported_error`。
- `/messages` 和 `/messages/count_tokens` 保持 Anthropic 原生请求/响应结构，适合 Anthropic SDK 兼容接入。

---

## 本地运行

```bash
bun install
export BLOOME_API_KEY="你的 Bloome Key"
export CLIENT_API_KEY="你给客户端的 Key"
bun start
```

本地默认地址：

```text
http://localhost:3000/api/public/v1
```

---

## 调用示例

```bash
curl -X POST http://localhost:3000/api/public/v1/chat/completions \
  -H "Authorization: Bearer $CLIENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kimi-k2.6",
    "messages": [
      {"role": "user", "content": "Say hi"}
    ]
  }'
```

---

## 部署

- 主流程看 `DEPLOY.md`
- 排障和热更新看 `DEPLOY_NOTES.md`

---

## 说明

- 核心源码入口：`src/index.ts`
- 模型映射说明：`docs/MODELS.md`
- thinking / reasoning 说明：`docs/THINKING.md`

---

## 一句话总结

> Bloome2API 是一个把 Bloome 模型能力转换成 OpenAI 兼容接口的轻量网关。
