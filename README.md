# Bloome2API

一个把 Bloome 内置 LLM 代理转换成 OpenAI 兼容接口的网关。

## 你现在最该用哪个入口

如果你的场景是：

- 把仓库交给 AI / Agent
- 让它自己从零部署到 EdgeSpark
- 尽量少人工干预

那**优先用这两个文件**：

- `scripts/zero-deploy.sh`
- `DEPLOY_AGENT.md`

也就是：

```bash
BLOOME_API_KEY="..." CLIENT_API_KEY="..." ./scripts/zero-deploy.sh
```

或者指定 fresh alias：

```bash
BLOOME_API_KEY="..." CLIENT_API_KEY="..." ./scripts/zero-deploy.sh gateway-20260509
```

---

## 快速开始（本地）

```bash
bun install
export BLOOME_API_KEY="你的 Bloome Key"
export CLIENT_API_KEY="你自定义的 Key"
bun start
```

本地默认地址：

- Base URL: `http://localhost:3000`
- Models: `GET /v1/models`
- Chat: `POST /v1/chat/completions`

## EdgeSpark 部署后的接口

部署成功后，客户端一般使用：

- Base URL: `https://xxx.edgespark.app`
- API 前缀: `/api/public/v1`
- Health: `GET /api/public/v1/health`
- Models: `GET /api/public/v1/models`
- Chat: `POST /api/public/v1/chat/completions`

---

## 仓库结构

```text
Bloome2API/
├── src/
│   └── index.ts
├── scripts/
│   ├── zero-deploy.sh
│   ├── deploy-edgespark.sh
│   └── verify-gemini-thinking.js
├── docs/
│   ├── DEPLOY.md
│   ├── MODELS.md
│   └── THINKING.md
├── DEPLOY_AGENT.md
├── README.md
└── package.json
```

## 各文件作用

### 根目录里真正重要的

- `src/index.ts`
  - 核心网关逻辑
- `scripts/zero-deploy.sh`
  - 给 Agent 用的一键从零部署入口
- `scripts/deploy-edgespark.sh`
  - 把源码同步进 EdgeSpark scaffold 并完成部署
- `DEPLOY_AGENT.md`
  - 给 AI / Agent 的超短执行说明

### `docs/` 里的参考资料

- `docs/DEPLOY.md`
  - 更完整的部署 / 热更新 / 运维说明
- `docs/MODELS.md`
  - 模型白名单、真实上游映射、协议入口记录
- `docs/THINKING.md`
  - `-thinking` alias、reasoning_content、thinking 兼容说明

---

## 推荐用法

### 用人手动部署
看：

- `docs/DEPLOY.md`

### 用 AI / Agent 自动部署
看：

- `DEPLOY_AGENT.md`
- `scripts/zero-deploy.sh`

这个仓库现在默认更偏向第二种。

---

## 额外说明

### 1. 真正的源码源头
永远是：

- `src/index.ts`

不是：

- `edgespark/<alias>/server/src/index.ts`

后者只是部署时生成的运行副本。

### 2. 如果旧 alias 坏了
只要出现：

- `verify 404`
- `invalid bearer token`
- `unhealthy`

直接换 fresh alias，不要在旧 alias 上硬修。

### 3. 如果要查模型和 thinking 细节
去 `docs/` 看，不要先翻主 README。
