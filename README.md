# Bloome2API

一个把 Bloome 内置 LLM 代理转换成 OpenAI 兼容接口的网关。

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

## 部署说明

看根目录：

- `DEPLOY.md`

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
  - 把源码同步进 EdgeSpark scaffold 并完成部署
- `DEPLOY.md`
  - 部署 / 热更新 / 运维说明

### `docs/` 里的参考资料

- `docs/MODELS.md`
  - 模型白名单、真实上游映射、协议入口记录
- `docs/THINKING.md`
  - `-thinking` alias、reasoning_content、thinking 兼容说明

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
去 `docs/` 看。
