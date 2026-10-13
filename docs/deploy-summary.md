# Cloudflare Pages 部署说明

本文描述部署流程，不记录任何个人账号、资源 ID、访问令牌或某个线上环境的历史验收结果。

## 1. 构建与存储

- 构建命令：`npm ci && npm run build`
- 输出目录：`dist`
- Node.js：22.12+ 或 24
- D1 绑定名：`DB`
- KV 绑定名：`CACHE`
- 构建变量 `VITE_SOURCE_URL`：与部署版本对应的公开源码 HTTPS 地址，默认 [lin945/animer-public](https://github.com/lin945/animer-public)；fork 或修改版应覆盖为自己的源码地址。这是公开配置，不是密钥

公开仓库只包含 `wrangler.example.toml`，其中资源 ID 全是占位值。本地先复制为已被 Git 忽略的 `wrangler.toml`。在自己的 Cloudflare 账户创建资源，并在 Pages 控制台保留/配置实际 D1、KV 绑定；没有提交的 Wrangler 配置不会自动替你创建或迁移这些绑定。不要把本地占位 ID 发布为生产配置。数据库和命名空间 ID 本身不是访问令牌，但仍应使用自己的资源。

`npm run db:local` 应用本地迁移。`npm run db:remote` 修改远程数据库，运行前先确认 Wrangler 账户及目标库，按需要备份。旧版本可能包含个人观看记录/收藏或源凭据字段；升级前应审查并清理不再需要的私有数据，不能因为新界面不再写入就假定旧数据消失。

## 2. GitHub 管理员登录

默认管理员登录方式是直接使用 GitHub OAuth，无需 Cloudflare Access 或 Zero Trust。管理入口为 `/admin`；后端使用 GitHub **数字用户 ID** 白名单，登录成功不等于获得管理权限，也不依赖可改名的用户名或公开邮箱。

### 创建专用 OAuth 应用

在 [GitHub OAuth Apps 设置](https://github.com/settings/developers)创建一个仅用于此站点登录的 OAuth App：

- Homepage URL：站点的规范 HTTPS origin，例如 `https://example.com`
- Authorization callback URL：`https://example.com/api/auth/github/callback`
- 使用精确匹配的回调地址，不开启通配回调
- 不复用已获仓库、组织或其他扩大权限的 OAuth 应用

以实际部署 origin 替换示例域名，并保持 OAuth 回调、`APP_ORIGIN` 和用户打开的站点域名一致。本项目的生产站点如使用 `https://anime.bilibili.asia`，对应回调为 `https://anime.bilibili.asia/api/auth/github/callback`。

登录请求显式使用空 scope，只获取识别账户所需的公开身份，不申请仓库、组织、邮箱或刷新令牌权限。后端还会拒绝带额外授权 scope 的令牌。若专用应用曾被授予额外权限，应在 GitHub 撤销该授权后重新登录，不应放宽后端检查。OAuth 创建和授权需由账户所有者确认。

### Cloudflare 配置

在 Pages 项目的运行时环境配置以下变量，生产与预览环境分开设置：

| 名称 | 类型 | 值 |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | 普通变量 | GitHub OAuth App 的 Client ID |
| `GITHUB_CLIENT_SECRET` | Secret | 该 OAuth App 的 Client Secret |
| `SESSION_SECRET` | Secret | 用安全随机方式生成的高强度会话签名密钥；代码要求 UTF-8 长度至少 32 字节 |
| `APP_ORIGIN` | 普通变量 | 规范 HTTPS origin，不含路径或尾部斜杠，例如 `https://example.com` |
| `ADMIN_GITHUB_ID` | 普通变量 | 唯一允许管理的 GitHub 数字用户 ID，不是用户名 |

Client Secret 和会话签名密钥由部署者通过 Cloudflare 的安全 Secrets 输入框填写。不要放进聊天、源码、`VITE_*` 前端变量、截图、命令行历史或公开日志。Client ID、管理员公开数字 ID、站点 origin 不是登录密钥。配置变更后重新部署并验收，不要把“已填写变量”当作登录成功。

### 登录、会话与退出

- `GET /api/auth/github/login`：开始 GitHub 登录
- `GET /api/auth/github/callback`：验证回调并创建站点会话
- `GET /api/auth/status`：查询是否已配置登录及身份提供商，不表示当前用户已登录
- `GET /api/admin/session`：验证管理员会话
- `POST /api/auth/logout`：退出当前浏览器会话；要求同源 Origin、`X-Admin-Request: 1`、JSON 正文 `{}`

OAuth 使用随机 state 与 PKCE S256。流程 Cookie `__Host-animer_oauth` 有效 10 分钟；管理员 Cookie `__Host-animer_admin` 有效 1 小时。两者均为签名 Cookie，设置 `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`，不设置 Domain。Cookie 仅代表登录身份，不包含观看记录。

GitHub access token 只用于当前回调读取账户身份，之后不保存在 D1、KV 或浏览器。站点会话使用独立签名及用途校验；后端每次请求重新检查签名、到期时间、origin 与管理员数字 ID。退出清除当前浏览器 Cookie；如需使所有已签发会话立即失效，应安全轮换 `SESSION_SECRET`。在 GitHub 撤销 OAuth 授权与清除本站现有会话是两件事，已签发会话仍可能持续到过期或密钥轮换。

管理写请求还要求同源 Origin、`X-Admin-Request: 1`、JSON 正文，并限制正文大小。管理响应不允许共享缓存。旧管理接口别名同样校验登录身份，不能用来绕过 `/api/admin/*`。

### 本地与备用域名

管理员功能只接受 `APP_ORIGIN`。通过 `pages.dev`、预览域名或其他别名访问时不会沿用生产登录；如要测试完整登录，使用单独 OAuth 应用、单独强随机会话密钥和明确的 HTTPS 开发 origin。

缺少必要配置时保持管理端关闭。普通 HTTP 本地开发用于目录/播放与模拟测试，不提供默认密码、免鉴权开关或匿名回退。可通过本地 D1 工具准备有权使用的数据；完整登录需在匹配回调的 HTTPS 环境验收。

参考：[GitHub OAuth web flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。

## 3. 配置播放源

登录 `/admin` 后管理订阅、启停源和健康检查。订阅属于外部数据，必须确认使用权限。Cloudflare Workers 的抓取能力与原生客户端不同，不承诺绕过站点挑战、登录墙、地理限制或播放授权。

源 Cookie/UA 写入接口已禁用，旧记录中的个人凭据不再参与转发。现有值不会因代码升级自动删除；需要按部署者的数据保留策略另行清理。当前新增迁移只增加索引，不执行清空历史数据。

普通访问者只读公共目录及必要播放元数据，不拥有订阅同步、健康检查、源修改或私有诊断权限。浏览器观看记录和偏好保存在 localStorage，不上传个人观看数据库。

公共 JSON 缓存默认使用 KV 60 秒、浏览器 30 秒；管理员成功修改后切换缓存版本。KV 为最终一致，变化不承诺即时出现在所有地区。取流解析不共用该缓存，以免长期复用已过期的媒体地址。

### 媒体代理的签名授权

`/api/resolve` 返回 `streamUrl` 和可为空的 `proxyUrl`。客户端必须原样使用服务端给出的 `proxyUrl`，不能自行拼装 `/api/play`。代理票据绑定具体媒体 URL、源 ID、Referer 和有效期，使用从 `SESSION_SECRET` 经 HKDF 派生的独立密钥；票据默认 4 小时，HLS 子请求继承原到期时间，不会无限续期。

未安全配置签名密钥或请求来自非规范 origin 时，解析可保留安全的直连地址，但不签发代理地址；代理本身拒绝无有效票据请求。直连是否可播放仍取决于媒体格式、CORS 和源站限制。配置变更后应重新解析，而不是反复使用过期链接。

剧集页与解析页必须属于配置中允许的源站 origin；可信解析得到的 CDN 媒体可以使用不同 origin。代理拒绝主动 HTML/SVG/XML/JavaScript 内容，并加上 sandbox、nosniff 和同源资源策略；无类型或纯文本响应按惰性二进制处理。这些约束和重定向检查不是 DNS 层面 SSRF 隔离保证，不能作为任意网络代理使用。

## 4. 发布前核对

1. `npm run check`（包括 Wrangler Pages Functions 编译）通过；另行运行 `npm run test:e2e` 验证浏览器行为及生产静态安全头。
2. 数据库迁移已在预定目标验证；不记录真实个人凭据作为测试数据。
3. 匿名访问公开目录成功；匿名/伪造/过期身份的管理请求失败。
4. GitHub 管理员登录、订阅管理及操作后的公共缓存更新正常。
5. 两个番剧切换、快速选集、换源、暂停/恢复、刷新和浏览器后退不会串台或覆盖错误记录。
6. 移动端布局、弹幕和播放器控制可用；浏览器禁止自动播放时有可操作的播放入口。
7. 页面提供 AGPL 许可证、第三方声明和对应版本的可访问源码。`dist/LICENSE.txt`、`dist/THIRD_PARTY_NOTICES.md` 随构建输出。
8. 公开仓库前检查完整历史和资产来源。删掉最新版本的私密文件不会抹去历史提交；不要未经审查就切换可见性。

Cloudflare 构建通过、页面能打开、源解析成功、视频真正解码播放、GitHub 登录成功是不同的检查项，分别验收并记录结果。
