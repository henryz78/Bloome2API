# Bloome2API

一个便携的 OpenAI 兼容 API 网关，把 Bloome 的内置 LLM 代理转成标准 OpenAI 格式，供任何支持 OpenAI API 的客户端使用。

## 能做什么

- 在 Rikkahub / OpenWebUI / Cursor / LobeChat / NextChat 等客户端里用 Bloome 的模型
- 自动处理 Claude 的格式转换（OpenAI ↔ Anthropic）
- 自动处理 Gemini 的格式转换（OpenAI ↔ Google GenerateContent）
- 自动修复 GPT-5.x 等模型的参数不兼容
- 清洗上游响应中的非标准字段
- 统一用一个 OpenAI 风格入口访问多种不同协议的上游模型

## 支持哪些模型

当前代理里支持的模型、真实上游返回模型名、协议入口、是否存在 alias 重定向，已经单独整理到：

- [`MODELS.md`](./MODELS.md)
- [`THINKING.md`](./THINKING.md)

如果你想确认某个模型到底是不是“真那个模型”，先看 `MODELS.md`。

## 模型激活机制

Bloome 的 LLM 代理有一个激活机制：

1. 你先在 Bloome 客户端里切换到某个模型一次
2. 该模型 alias 才会在上游变成可访问状态
3. 然后再把它加入本项目的 `MODELS` 数组中

也就是说：

- **客户端里看得到** ≠ **代理里立刻能调用到**
- 最稳妥的流程是：先切换、再探测、最后写入白名单

详细部署和维护流程见：

- [`DEPLOY.md`](./DEPLOY.md)

## 快速开始

```bash
# 安装依赖
bun install

# 设置上游 Bloome API Key
export BLOOME_API_KEY="你的 Bloome Key"

# 可选：设置客户端访问这个代理时使用的 API Key
export CLIENT_API_KEY="你自定义的 Key"

# 启动（默认 3000 端口）
bun start
```

## 客户端配置

| 设置项 | 值 |
|---|---|
| Base URL | `http://localhost:3000` |
| API Key | `CLIENT_API_KEY` 的值；如果你没设，可填任意值 |
| 模型 | 参考 `MODELS.md` 中已验证通过的 model id |

## API 端点

### OpenAI 兼容入口

- `POST /v1/chat/completions`
- `GET /v1/models`

### EdgeSpark 部署后的公开入口

如果你部署在 EdgeSpark，默认公开前缀会变成：

- `GET /api/public/v1/health`
- `GET /api/public/v1/models`
- `POST /api/public/v1/chat/completions`

## 项目文件说明

| 文件 | 用途 |
|---|---|
| `src/index.ts` | 后端主逻辑 |
| `MODELS.md` | 已验证模型与上游真实映射表 |
| `THINKING.md` | thinking / reasoning 模式设计、`-thinking` alias 规则与协议兼容策略 |
| `DEPLOY.md` | 部署、回滚、模型探测维护说明 |

## 维护建议

如果后面又新增模型，不要直接凭名字猜。

建议固定按下面流程：

1. 先在 Bloome 客户端里切到那个模型
2. 分别用 OpenAI / Anthropic / Gemini 三种入口做真实探测
3. 记录它的：
   - 可用 alias
   - 实际协议入口
   - 上游真实返回模型名
   - 是否发生重定向
4. 更新 `MODELS.md`
5. 再更新代码里的 `MODELS` 数组

这样后面排查问题会轻松很多。
