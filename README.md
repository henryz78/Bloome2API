# Bloome2API

一个便携的 OpenAI 兼容 API 网关，把 Bloome 的内置 LLM 代理转成标准 OpenAI 格式，供任何支持 OpenAI API 的客户端使用。

## 能做什么

- 在 Rikkahub / OpenWebUI / Cursor / LobeChat 等客户端里用 Bloome 的模型
- 自动处理 Claude 的格式转换（OpenAI ↔ Anthropic）
- 自动修复 GPT-5.x 的参数不兼容
- 清洗上游响应的非标准字段

## 支持哪些模型

**不在代码里写死。** Bloome 的 LLM 代理有一个激活机制：你在 Bloome 设置里切到某个模型一次，那个模型的 alias 才能通过代理访问。

所以流程是：
1. 去 Bloome 设置，切到你想用的模型
2. curl 测试确认代理能认
3. 把 alias 加到 `src/index.ts` 的 `MODELS` 数组里

详细步骤见 `DEPLOY.md`。

## 快速开始

```bash
# 安装
bun install

# 设 API Key（从你的 Bloome 环境变量获取）
export BLOOME_API_KEY="你的Key"

# 启动（默认 3000 端口）
bun start
```

## 客户端配置

| 设置项 | 值 |
|--------|-----|
| Base URL | `http://localhost:3000` |
| API Key | 任意值 |
| 模型 | 你验证过的那些 |

## 文件说明

| 文件 | 用途 |
|------|------|
| `src/index.ts` | 后端全部代码 |
| `DEPLOY.md` | Agent 部署操作手册（发给 AI Agent 用的） |
