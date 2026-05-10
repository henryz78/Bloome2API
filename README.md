# Bloome2API

一个把 Bloome 内置 LLM 代理转换成 OpenAI 兼容接口的网关。

## 快速开始（本地）

本地运行需要 Bun；部署到 EdgeSpark 公网前也建议先按 `DEPLOY.md` 跑本地 smoke test，确认代理和上游 key 可用。

```bash
bun install
export BLOOME_API_KEY="你的 Bloome Key"
export CLIENT_API_KEY="你自定义的 Key"
bun start
```

本地默认地址：

- Base URL: `http://localhost:3000`
- API 前缀: `/api/public/v1`
- Health: `GET /api/public/v1/health`
- Models: `GET /api/public/v1/models`
- Chat: `POST /api/public/v1/chat/completions`

## EdgeSpark 部署后的接口

部署成功后，客户端一般使用：

- Base URL: `https://xxx.edgespark.app`
- API 前缀: `/api/public/v1`
- Health: `GET /api/public/v1/health`
- Models: `GET /api/public/v1/models`
- Chat: `POST /api/public/v1/chat/completions`

## 部署说明

看根目录：

- `DEPLOY.md`
- `DEPLOY_NOTES.md`

## 仓库结构

```text
Bloome2API/
├── src/
│   └── index.ts
├── scripts/
│   └── deploy-edgespark.sh
├── docs/
│   ├── MODELS.md
│   └── THINKING.md
├── DEPLOY.md
├── README.md
└── package.json
```

## 各文件作用

### 根目录里真正重要的

- `src/index.ts`
  - 核心网关逻辑
- `scripts/deploy-edgespark.sh`
  - 公网 EdgeSpark 部署默认入口：自动识别 EdgeSpark 脚手架位置，同步源码、patch scaffold、设置运行时变量并完成部署
- `DEPLOY.md`
  - 干净的从零部署主流程
- `DEPLOY_NOTES.md`
  - 环境坑、认证坑、安全禁忌、排障和热更新备忘

### `docs/` 里的参考资料

- `docs/MODELS.md`
  - 模型白名单、真实上游映射、协议入口记录
- `docs/THINKING.md`
  - `-thinking` alias、reasoning_content、thinking 兼容说明

## 额外说明

### 1. 工具调用支持

Claude / MiniMax / Gemini 已支持 OpenAI 风格的 `tools` / `tool_calls`，包括普通响应和流式响应。旧版 `functions` / `function_call` 不支持，请使用新版 `tools`。

### 2. Prompt Cache 支持

Claude / MiniMax 会透传 Anthropic 风格的 `cache_control`：

- 客户端在 `tools`、`messages[].content[]` 或 `system` 消息上显式传 `cache_control` 时，代理会原样转成 Anthropic block
- 客户端传 `ttl` 时不改写，例如 `{ "type": "ephemeral", "ttl": "5m" }`
- 如果请求没有显式 `cache_control`，代理会在静态前缀末尾自动补一个 `5m` 断点，优先系统提示，其次工具定义
- 如果不想自动补断点，请在请求体里传 `prompt_cache: false`

GPT 走上游自动 prompt cache：

- 代理不会缓存回答
- 代理会保留上游返回的 `usage.prompt_tokens_details.cached_tokens`
- 对 `gpt-*` 请求，如果有 system / tools / response_format 且客户端没有传 `prompt_cache_key`，代理会自动生成一个稳定的 `prompt_cache_key`，帮助上游提高同类前缀的命中率
- 如果不想自动生成 key，同样传 `prompt_cache: false`

这个是 prompt caching，不是完整回答缓存；不会把某次回答直接复用给下一次请求。

### 3. 真正的源码源头
永远是：

- `src/index.ts`

不是：

- `edgespark/<alias>/server/src/index.ts`

后者只是部署时生成的运行副本。

### 4. 如果旧 alias 坏了
只要出现：

- `verify 404`
- `invalid bearer token`
- `unhealthy`

直接换 fresh alias，不要在旧 alias 上硬修。

### 5. 如果要查模型和 thinking 细节
去 `docs/` 看。
