# DEPLOY_AGENT.md

给 AI / Agent 的最短执行说明。

## 目标

从零把这个仓库部署到 EdgeSpark，并输出一个可直接给客户端使用的公网 API 地址。

成功标准：

1. `bloome-cli edgespark project verify <alias>` 返回成功
2. `GET <baseUrl>/api/public/v1/health` 返回 `bloomeApiKey:true` 和 `clientApiKey:true`
3. `GET <baseUrl>/api/public/v1/models`：
   - 带 key → 200
   - 不带 key → 401
4. 最终明确输出：
   - alias
   - base URL
   - API 前缀
   - CLIENT_API_KEY

## 默认做法

优先直接运行：

```bash
BLOOME_API_KEY="..." CLIENT_API_KEY="..." ./scripts/zero-deploy.sh
```

也可以显式指定 fresh alias：

```bash
BLOOME_API_KEY="..." CLIENT_API_KEY="..." ./scripts/zero-deploy.sh gateway-20260509
```

## 你必须遵守的规则

1. **优先 fresh alias**
   - 不要默认复用旧 alias
   - 旧 alias 只要出现 `verify 404` / `invalid bearer token` / `unhealthy`，直接废弃

2. **先 smoke test，再 deploy**
   - `create` 后先跑 `edgespark pull`
   - 如果 `pull` 失败，不要继续怀疑业务代码，优先判断 binding/token 问题

3. **不要把 key 写进仓库文件**
   - 不要写入 `edgespark.toml`
   - 只通过环境变量和 `edgespark var set` 设置

4. **不要在 `secret call` 里假设别的环境变量自动存在**
   - `secret call` 只注入你指定的 secret
   - 不要指望 `$RESON_LLM_API_KEY` 自动可用

5. **不要截断 `BLOOME_API_KEY`**
   - 传完整值
   - 不要用 `head` 截取

6. **改 vars 后要重新 deploy**
   - `edgespark var set` 不会自动热加载到线上运行时

7. **不要手动改 `EDGESPARK_BASE_URL`**
   - 正常情况下只设置 `EDGESPARK_PROJECT_ENVIRONMENT=production`

## 失败时怎么分叉

### 情况 A：`project create` 成功，但 `pull` 失败
优先判断：
- binding/token 有问题
- alias 脏了

处理：
- 不要继续 deploy
- 直接换一个 fresh alias 重试

### 情况 B：`pull` 成功，但 deploy typecheck 失败
优先看：
- `edgespark/<alias>/server/src/defs/runtime.ts`
- `VarKey` 是否已包含：
  - `BLOOME_API_KEY`
  - `CLIENT_API_KEY`

正常情况下，`scripts/deploy-edgespark.sh` 会自动 patch。

### 情况 C：health 正常，但 chat 返回 `Server not configured`
优先看：
- `BLOOME_API_KEY` 是否真传进运行时
- 是否在 `var set` 后漏了重新 deploy

## 输出格式

部署完成后，明确输出：

- 公网地址：`https://xxx.edgespark.app`
- API 前缀：`https://xxx.edgespark.app/api/public/v1`
- API Key：`CLIENT_API_KEY`
- 验证结果：
  - verify
  - health
  - models with key
  - models without key

不要只说“部署成功了”。要给可直接使用的最终配置。
