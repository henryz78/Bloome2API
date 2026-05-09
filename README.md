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

其中 `THINKING.md` 记录了 `-thinking` 别名的设计与兼容规则。

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

---

# 仓库架构

这一段专门解释“这个仓库里哪些文件负责什么、从本地源码到 EdgeSpark 部署是怎么串起来的”。

## 一句话理解

这个仓库本质上分成两层：

1. **源码层**：`src/index.ts` 是唯一核心服务实现
2. **部署层**：`scripts/` + `DEPLOY.md` 负责把这份源码同步到 EdgeSpark scaffold 并部署上线

也就是说：

- 日常改逻辑，主要改 `src/index.ts`
- 日常改部署流程，主要改 `scripts/` 和 `DEPLOY.md`
- 日常查模型 / thinking 兼容信息，主要看 `MODELS.md` 和 `THINKING.md`

## 目录结构

```text
Bloome2API/
├── src/
│   └── index.ts                    # 核心网关逻辑：模型路由、协议转换、SSE 清洗、thinking 映射
├── scripts/
│   ├── deploy-edgespark.sh         # 把源码同步到 EdgeSpark scaffold、设置远程 vars、部署
│   └── verify-gemini-thinking.js   # 部署后校验 Gemini thinking 流式行为
├── README.md                       # 项目概览、快速开始、仓库架构说明
├── DEPLOY.md                       # 从 0 部署 / 热更新 / 模型探测 / 运维步骤
├── MODELS.md                       # 模型白名单、真实上游映射、协议入口记录
├── THINKING.md                     # -thinking alias 设计、reasoning_content 兼容说明
└── package.json                    # 本地运行与验证脚本
```

## 核心文件职责

### `src/index.ts`
这是整个项目最重要的文件，几乎所有网关行为都在这里。

它主要负责：

- 暴露 OpenAI 风格接口：
  - `GET /v1/models`
  - `POST /v1/chat/completions`
- 根据模型名判断上游协议：
  - Claude → Anthropic `/v1/messages`
  - Gemini → Google `generateContent` / `streamGenerateContent`
  - 其它模型 → 直接走 OpenAI 风格上游
- 把不同协议的输入输出统一成 OpenAI 风格
- 清洗 SSE 流，避免客户端因为空 chunk / 非标准 usage / 重复 `[DONE]` 出错
- 保留 `reasoning_content`，避免把 thinking 文本错误塞回 `content`

### `scripts/deploy-edgespark.sh`
这是把“本地源码”变成“EdgeSpark 可运行网关”的桥接脚本。

它负责：

1. 检查 EdgeSpark scaffold 是否存在
2. 远程设置 runtime vars：
   - `BLOOME_API_KEY`
   - `CLIENT_API_KEY`
3. 把 `src/index.ts` 复制到 `edgespark/<alias>/server/src/index.ts`
4. 注入 EdgeSpark 专用的：
   - `vars` import
   - runtime var 读取补丁
   - `installBloomeBridge(app)`
5. 执行 `edgespark pull`
6. 安装 server 依赖并 deploy

这个脚本的定位不是“本地开发脚本”，而是“**把源码落地到 EdgeSpark scaffold 的发布脚本**”。

### `scripts/verify-gemini-thinking.js`
这是一个部署后 smoke test，用来验证 Gemini thinking 流式链路没坏。

它重点检查：

- 模型列表中有 `gemini-3-flash-thinking`
- SSE 最终会正常 `[DONE]`
- `finish_reason` 只在最后一个 chunk 出现
- 最后一个 chunk 带 `usage`
- reasoning chunk 能正确落到 `reasoning_content`

这个脚本的意义是：把“手工验一遍 SSE”变成可以重复执行的校验。

## 本地运行架构

本地运行时，结构很简单：

```text
客户端
  ↓
Bloome2API (src/index.ts)
  ↓
Bloome LLM Proxy /stream.bloome.im
  ↓
不同真实模型提供方（Claude / Gemini / GPT / Kimi ...）
```

也就是说，本地模式下：

- 你直接跑 `bun start`
- `src/index.ts` 自己就是服务入口
- 只需要环境变量，不需要 EdgeSpark scaffold

## EdgeSpark 部署架构

部署到 EdgeSpark 时，多一层“scaffold / bridge”：

```text
本仓库 src/index.ts
  ↓
脚本同步到 edgespark/<alias>/server/src/index.ts
  ↓
注入 EdgeSpark runtime vars + Bloome bridge
  ↓
EdgeSpark deploy
  ↓
公网 API: /api/public/v1/*
```

这里要注意一件事：

### 这个仓库本身 **不是** EdgeSpark scaffold
也就是说：

- 本仓库保存的是“主源码 + 部署脚本 + 文档”
- `edgespark/<alias>/...` 是部署时生成 / 使用的运行目录
- 运行目录不应该反过来成为源码真源头

换句话说：

- **源码真源头** 是 `src/index.ts`
- **部署目标副本** 是 `edgespark/<alias>/server/src/index.ts`

## 请求流转逻辑

从请求路径的角度看，网关大致是这样分流的：

```text
POST /v1/chat/completions
  ├─ Claude 模型        → 转成 Anthropic Messages 请求
  ├─ Gemini 模型        → 转成 Google GenerateContent 请求
  └─ 其它模型           → 直接透传 OpenAI 风格请求
```

然后再把结果统一收敛成：

- OpenAI 非流式 JSON
- OpenAI 流式 SSE chunk

## 为什么仓库里把文档拆成 3 份

### `README.md`
负责回答：

- 这项目是干嘛的
- 怎么快速跑起来
- 仓库结构是什么

### `DEPLOY.md`
负责回答：

- Agent / 维护者具体怎么部署
- 怎么热更新
- 怎么探测新模型
- 怎么避免把密钥写进仓库

### `MODELS.md` / `THINKING.md`
负责回答：

- 模型 alias 到底映射到哪
- 哪些模型支持 thinking
- `reasoning_content` 行为应该怎么理解

这么拆是为了避免把：

- 项目概览
- 运维步骤
- 模型兼容事实

全塞进一个 README，最后谁都不好找。

---

## 项目文件说明

| 文件 | 用途 |
|---|---|
| `src/index.ts` | 后端主逻辑 |
| `scripts/deploy-edgespark.sh` | EdgeSpark 部署脚本 |
| `scripts/verify-gemini-thinking.js` | Gemini thinking 流式校验脚本 |
| `MODELS.md` | 已验证模型与上游真实映射表 |
| `THINKING.md` | thinking / reasoning 模式设计、`-thinking` alias 规则与协议兼容策略 |
| `DEPLOY.md` | 部署、热更新、模型探测维护说明 |
| `README.md` | 项目概览与仓库架构说明 |

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
