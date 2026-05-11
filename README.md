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

### 2. Prompt Cache 兼容

网关已兼容 prompt cache 的请求参数和 usage 字段，但是否真正写入/命中缓存，取决于最终上游是否支持并透传这些能力。当前 Bloome 上游实测会正常响应，但缓存统计仍为 0，因此不要把这项能力理解成当前一定能省 token。

Claude / MiniMax 路径会透传 Anthropic 风格的 `cache_control`：

- 客户端在 `tools`、`messages[].content[]` 或 `system` 消息上显式传 `cache_control` 时，代理会原样转成 Anthropic block
- 客户端传 `ttl` 时不改写，例如 `{ "type": "ephemeral", "ttl": "5m" }`
- 如果请求没有显式 `cache_control`，代理会在静态前缀末尾自动补一个 `5m` 断点，优先系统提示，其次工具定义
- 如果不想自动补断点，请在请求体里传 `prompt_cache: false`

GPT 路径兼容上游自动 prompt cache：

- 代理不会缓存回答
- 代理会保留上游返回的 `usage.prompt_tokens_details.cached_tokens`
- 对 `gpt-*` 请求，如果有 system / tools / response_format 且客户端没有传 `prompt_cache_key`，代理会自动生成一个稳定的 `prompt_cache_key`，帮助上游提高同类前缀的命中率
- 如果不想自动生成 key，同样传 `prompt_cache: false`

这个是 prompt cache 兼容层，不是完整回答缓存；不会把某次回答直接复用给下一次请求。上游以后开始支持时，这些字段可以直接生效。

### 3. 真正的源码源头
永远是：

- `src/index.ts`

不是：

- `edgespark/<alias>/server/src/index.ts`

后者只是部署时生成的运行副本。

### 4. 输出 token 上限

不同上游协议的默认输出长度不一样：

- Claude / MiniMax 走 Anthropic 协议，必须传 `max_tokens`；网关会按模型补默认上限
- Claude 默认按模型补上限：Opus `32000`，Sonnet / Haiku `64000`
- MiniMax-M2.7 默认补 `131072`
- Gemini 走 Vertex 协议，网关默认补 `maxOutputTokens: 65536`，避免吃上游较低默认值
- Kimi / GPT / GLM / DeepSeek / Mimo 走 OpenAI 原生分支，用户不传时网关不主动限制

用户显式传 `max_tokens` 或 `max_completion_tokens` 时，永远优先使用用户传入的值。

如果部署时要调默认值：

- `ANTHROPIC_DEFAULT_MAX_TOKENS=16384`
- `GEMINI_DEFAULT_MAX_TOKENS=32768`

最终能否输出到这个长度仍取决于 Bloome 上游和具体模型 alias 是否允许。

### 5. 如果旧 alias 坏了
只要出现：

- `verify 404`
- `invalid bearer token`
- `unhealthy`

直接换 fresh alias，不要在旧 alias 上硬修。

### 6. 如果要查模型和 thinking 细节
去 `docs/` 看。
