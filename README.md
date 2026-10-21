# workers-proxy

一个基于 Cloudflare Workers 的单文件反向代理。将所有请求转发到配置的源站（`TARGET_ORIGIN`），并在回传时把页面里的源站地址改写为代理地址，使用户通过 Worker 域名无缝访问上游站点。

## 特性

- **单文件、零构建**：入口只有一个 `worker.js`，`wrangler deploy` 直接部署源码。
- **请求头清理**：剥离 CF 专属头、`x-forwarded-*`、hop-by-hop 头，移除客户端 `Host`。
- **HTML 流式改写**：仅对未压缩的 HTML 响应做文本级地址替换（含 `http://`、`//`、`\/\/` 转义形态），流式处理不整页缓冲；GBK 等非 UTF-8 页面按原字符集解码、统一以 UTF-8 输出。
- **响应头改写**：`Location`、`Link`、`Refresh`、`CSP`、`Access-Control-Allow-Origin` 等头中的上游地址统一替换；`Set-Cookie` 去除 `Domain` 变为 host-only。
- **大文件友好**：响应体流式透传；上游超时（默认 25s，可用 `UPSTREAM_TIMEOUT_MS` 覆盖）只约束等待响应头阶段，拿到响应头后即解除，不会中断下载；206 / `Content-Range` 分段响应原样透传。
- **按需禁压缩**：只有可能返回 HTML 的请求才把 `Accept-Encoding` 改为 `identity`，静态资源保留压缩传输。

## 已知限制

- 不支持 WebSocket（`upgrade`/`connection` 被作为 hop-by-hop 头剥离）。
- 无鉴权，任何知道地址的人都可访问。
- 只支持单一上游，无路径级路由。

## 部署

```bash
# 交互式部署
npx wrangler deploy

# 非交互部署（需指定账户，避免多账户歧义）
CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx wrangler deploy
```

## 配置

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `TARGET_ORIGIN` | 上游源站地址（仅源地址，不能含路径、查询或片段） | 空，**必须配置** |
| `ENTRY_PATH` | 访问根路径时跳转到的站内路径，如 `/i/xxxx` | 空，不跳转 |
| `UPSTREAM_TIMEOUT_MS` | 等待上游响应头的超时毫秒数 | `25000` |

`TARGET_ORIGIN` 有两种配置方式，任选其一。

**方式一：部署时注入（推荐，地址不进入仓库）**

```bash
npx wrangler deploy --var TARGET_ORIGIN:https://example.com
```

也可以设在 Cloudflare Dashboard 的 **Settings → Variables and Secrets**。但部署参数和环境变量是同一个位置，两处都改容易搞混，建议只用一种。

**方式二：改代码里的常量**

```js
// worker.js 开头
const DEFAULT_TARGET_ORIGIN = "https://example.com";
```

适合在 Dashboard 里直接粘贴代码的场景，省去配环境变量的步骤。代价是这个地址会随仓库公开，公开前需要清空。

环境变量的优先级高于常量：只要部署时传了 `--var` 或设了同名变量，代码里的值就不会生效。

两者都没配置时，请求直接返回 500，而不是静默指向某个默认站点。

## 本地开发

```bash
npm install                                          # 安装 wrangler（已全局安装可跳过）
npx wrangler dev --var TARGET_ORIGIN:https://example.com
```

## 测试

```bash
npm test
```

使用 Node 内置 `node:test` 运行 `test/` 下的用例（需 Node 18+）。

## 项目结构

```
worker.js       # 反向代理全部逻辑（单文件）
wrangler.jsonc  # Worker 配置
test/           # node:test 测试用例
```
