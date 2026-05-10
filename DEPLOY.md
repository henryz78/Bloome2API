# DEPLOY.md — 部署流程

> 这是一页纸主流程。排障、环境坑和热更新见 `DEPLOY_NOTES.md`。

---

## 0. 前置检查

确认 Bun 可用，并准备两个 key：

```bash
bun --version
bun install

echo $RESON_LLM_API_KEY
export BLOOME_API_KEY="$RESON_LLM_API_KEY"
export CLIENT_API_KEY="<用户给的客户端密码>"
```

如果 Bun 不可用，或遇到 `unzip` / Node 版本 / 权限问题，看 `DEPLOY_NOTES.md` 第 1 节。

---

## 1. 本地启动

部署公网前必须先本地 smoke test。

```bash
bun start
```

---

## 2. 验收模板

把 `BASE_URL` 换成本地或公网地址即可复用。

本地：

```bash
export BASE_URL="http://localhost:3000/api/public/v1"
```

公网：

```bash
export BASE_URL="https://<域名>.edgespark.app/api/public/v1"
```

验收：

```bash
curl "$BASE_URL/health"

curl -H "Authorization: Bearer $CLIENT_API_KEY" "$BASE_URL/models"

curl -i "$BASE_URL/models"

curl -X POST "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $CLIENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"Say hi"}],"max_tokens":20}'
```

通过标准：

- `health` 里 `bloomeApiKey` 和 `clientApiKey` 都是 `true`
- 带 key 的 `models` 返回 200
- 不带 key 的 `models` 返回 401
- `chat/completions` 返回正常 JSON，且有 `choices`

如果返回 `Model alias not found`，让用户先在 Bloome 里切一次 `kimi-k2.6` 再重试。

---

## 3. 创建 EdgeSpark 项目

优先 fresh alias：

```bash
export ALIAS="gateway-$(date +%Y%m%d)"
bloome edgespark project create --alias "$ALIAS"
```

如果当前环境只有 `bloome-cli` wrapper，用等价命令：

```bash
bloome-cli edgespark project create --alias "$ALIAS"
```

---

## 4. Pull Smoke Test

先确认 EdgeSpark scaffold 和认证可用：

```bash
bloome secret call EDGESPARK_API_KEY__<ALIAS>__<SUFFIX> -- bash -c '
  export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__<ALIAS>__<SUFFIX>";
  export EDGESPARK_PROJECT_ENVIRONMENT=production;
  PROJECT_DIR="${EDGESPARK_PROJECT_DIR:-}";
  if [ -z "$PROJECT_DIR" ]; then
    for candidate in "edgespark/<alias>" "../edgespark/<alias>"; do
      if [ -f "$candidate/edgespark.toml" ]; then PROJECT_DIR="$candidate"; break; fi;
    done;
  fi;
  cd "${PROJECT_DIR:-edgespark/<alias>}" && edgespark pull
'
```

如果认证或路径失败，看 `DEPLOY_NOTES.md` 第 2 节。

---

## 5. 部署

```bash
bloome secret call EDGESPARK_API_KEY__<ALIAS>__<SUFFIX> -- bash -c '
  export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__<ALIAS>__<SUFFIX>";
  export EDGESPARK_PROJECT_ENVIRONMENT=production;
  ./scripts/deploy-edgespark.sh <alias>
'
```

脚本会自动同步 `src/index.ts`、注入 EdgeSpark vars、安装 server 依赖并执行 `edgespark deploy`。

---

## 6. 公网验收

```bash
bloome edgespark project verify "$ALIAS"
export BASE_URL="https://<域名>.edgespark.app/api/public/v1"
```

然后重新执行第 2 节的验收模板。

---

## 7. 汇报给用户

成功时只给可复制配置：

**Bloome2API 部署成功**

Base URL
```text
https://<域名>.edgespark.app/api/public/v1
```

API Key
```text
<CLIENT_API_KEY>
```

失败时说明卡在哪一步：本地 smoke、create、pull、deploy、verify、health、models 或 chat。
