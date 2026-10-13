# Animer

一个面向浏览器的番剧目录与播放器。前端使用 Vue 3、TypeScript、Vite 和 hls.js；后端为 Cloudflare Pages Functions（Hono），使用 D1 和 KV 保存公共源配置及缓存。

## 功能与边界

- Bangumi 目录搜索、番剧详情和新番日历
- 多播放源与线路选择，同集失败重试及可读的加载状态
- 浏览器本地观看记录、续播与播放偏好
- 0.5–2 倍速、前后 10 秒跳转、空格/K 播放暂停和方向键控制；在输入框或按钮上操作不会误触播放器快捷键
- 默认关闭的自动下一集：开启后播放结束显示 5 秒可取消倒计时；导航、手动选集或错误会取消
- 每部番剧独立的手动 OP 跳过时长，范围 0–300 秒、默认 85 秒；不进行片头自动识别
- 同集跨源续播、从头播放、最近 12 条观看记录及清除入口
- 弹幕只读展示；开关、透明度、字号、显示区域、模式及关键词屏蔽保存在本地
- 独立 `/admin` 管理页，管理接口由服务端校验 GitHub 登录会话及管理员身份

本项目不提供视频内容，不保证第三方源始终可用。浏览器/Workers 无法直接复用 Animeko 的原生 BitTorrent、mpv/VLC、离线缓存或 WebView 网络嗅探能力。遇到源站访问限制时应停用或更换合法可用的源，不提供验证码或访问控制绕过功能。

## 数据存在哪里

- 观看记录、最近观看、播放及弹幕偏好使用当前站点的 `localStorage`；番剧详情的临时缓存使用内存和 `sessionStorage`。这些记录不通过应用 API 上传到服务器，也不会像 Cookie 一样随每次 HTTP 请求发送。
- 记录仅属于当前浏览器/站点；清除站点数据会清除记录，无跨设备同步。隐私模式、配额或禁用存储可能使记录无法持久保存。
- D1/KV 主要保存公共目录、公共源配置、源健康信息和共享缓存。公开弹幕接口只读，不开放匿名投稿。
- 管理员使用 GitHub 登录，服务器以数字用户 ID 白名单验证身份；1 小时的 HttpOnly/Secure 登录会话 Cookie 与观看记录分开。GitHub 访问令牌不持久保存。Cloudflare、源站及目录服务仍可能处理正常请求日志；“本地记录”不等于网络请求匿名。
- 不应把个人 Cookie、访问令牌或其他登录凭据写入公共源配置、订阅规则或仓库。
- 管理接口不再接受源 Cookie/UA 凭据修改，历史源记录中的个人 Cookie/UA 不会被转发。旧数据库中的值不会自动删除；部署者需另行审查和清理。

## 本地运行

建议 Node.js 22.12+ 或 24，以及 npm。首次安装：

```sh
npm ci
npm run dev
```

开发脚本尝试应用本地 D1 迁移，然后启动：

- Vite：`http://localhost:5173`
- Pages Functions/本地 D1/KV：`http://localhost:8788`

前端 `/api/*` 请求反代到本地后端。D1/KV 模拟数据位于 `.wrangler/state`，不要提交。若迁移失败，检查日志后单独运行 `npm run db:local`；不要把页面能打开当作数据库已经初始化。

可分开运行 `npm run dev:api` 与 `npm run dev:web`。开发脚本支持 `API_PORT`、`WEB_PORT`、`DB_NAME` 和 `SKIP_DB_MIGRATE=1`；修改 API 端口时也需确认 Vite 代理目标一致。

管理端默认拒绝未认证请求，本地环境也没有公开的认证绕过开关。未配置 GitHub OAuth 时，目录页面可运行，但管理页面无法同步或更改源。需要播放测试数据时，可用本地 D1 工具导入自己有权使用的测试配置；不要为了调试把生产管理接口改为匿名开放。

## 检查与测试

```sh
npm run check
```

- `check` 依次运行前端类型检查、Workers 类型检查、全部测试、后端转译检查、生产构建和法律声明复制。可分别运行 `type-check`、`type-check:worker`、`test`、`check:api`、`build` 定位失败。
- `type-check` 检查前端 TypeScript/Vue；`type-check:worker` 使用 Workers 类型环境检查 `functions/` 和 `server/`。`check:api` 的转译检查不能代替类型检查。
- 单元/组件测试覆盖本地状态、播放选择、取消与请求竞争、弹幕及访问控制等逻辑；不证明所有第三方源在当前网络环境可播放。
- `build` 输出 `dist/`，并包含许可证和第三方声明；`npm run preview` 仅预览静态构建，不启动 Pages Functions。
- `npm run test:pipeline [番剧名]` 与 `npm run report` 用于人工排查播放链路；探针需要可用的后端、合法测试源，并应遵守访问频率限制。管理操作不能靠该探针绕过认证。

临时报告、日志和截图放在忽略的 `log/` 目录；可复用脚本放在 `scripts/`。

## 部署与管理

详见 [部署说明](docs/deploy-summary.md)。基本配置：

1. 创建 Cloudflare Pages 项目，构建命令 `npm ci && npm run build`，输出目录 `dist`。
   构建时设置 `VITE_SOURCE_URL` 为该部署版本的公开源码地址，页脚才会显示源码入口；发布前确认链接无需登录即可访问。
2. 配置 D1 绑定 `DB` 和 KV 绑定 `CACHE`。使用自己账户的资源，不复用其他部署的资源标识。
3. 审查迁移后执行 `npm run db:remote`；这是远程数据库写操作，执行前确认目标账户、数据库及备份。
4. 配置 GitHub OAuth 应用、管理员白名单和环境变量，再开放管理操作；前端隐藏入口不能代替后端校验。
5. 验证公开目录/播放、拒绝匿名管理请求、管理员成功操作和浏览器本地记录。

SPA 使用 history 路由。Pages 项目未设置顶层 `404.html` 时通常提供 SPA 回退；如增加自定义 404 或重写规则，必须重新验证 `/watch/:id`、`/calendar` 和 `/admin` 的直链/刷新。

Git 集成部署会在推送所配置的生产分支后自动发布，务必先检查最终构建与迁移。GitHub OAuth 未配置完成时，管理功能保持锁定；部署成功不代表管理员登录已经验收。

## 许可证与来源

Copyright (C) 2026 Animer contributors.

本项目代码按 **GNU Affero General Public License version 3 only（AGPL-3.0-only）** 提供，详见 [LICENSE.txt](LICENSE.txt)。软件不提供担保。依赖和外部素材保留各自许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

产品体验参考 [Animeko](https://github.com/open-ani/animeko)，新增网页功能以 Vue/TypeScript 独立实现。Animeko 由 OpenAni 及贡献者维护，采用 AGPLv3；Animer 不是其官方版本或关联服务。

外部订阅服务及视频内容不因本项目采用 AGPL 而获得授权。本仓库不附带第三方订阅规则全集；部署者应确认其配置的源、封面、元数据和内容的使用权限。

发布修改版时应保留适用的版权/许可声明、标明修改，并按 AGPL 要求提供对应源码。对外运行本项目的修改版前，应在界面提供可访问的、与部署版本对应的源码入口；仅指向不可访问的私有仓库不足以提供源码。许可证原文优先于此处的简要说明。
