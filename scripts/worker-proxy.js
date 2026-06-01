/**
 * Cloudflare Workers 转发代理
 *
 * 部署到 Cloudflare Workers（免费）:
 * 1. 去 https://cloudflare.com 注册免费账号
 * 2. 进入 Workers & Pages → 创建 Worker
 * 3. 把下面代码复制进去 → 部署
 * 4. 拿到 https://xxx.xxx.workers.dev 地址
 *
 * 作用: 把被墙的 API 请求通过 Cloudflare 转发出去
 */

// 允许转发的 API 列表（防止被滥用）
const ALLOWED = [
  "api.dexscreener.com",
  "price.jup.ag",
  "quote-api.jup.ag",
];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get("url");

    if (!target) {
      return new Response("用法: ?url=https://api.dexscreener.com/...", { status: 400 });
    }

    // 安全检查：只允许转发白名单域名
    const targetUrl = new URL(target);
    if (!ALLOWED.some(d => targetUrl.hostname.endsWith(d))) {
      return new Response("域名不在白名单中", { status: 403 });
    }

    try {
      const response = await fetch(target, {
        method: request.method,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json",
        },
      });

      return new Response(response.body, {
        status: response.status,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": response.headers.get("Content-Type") || "application/json",
        },
      });
    } catch (e) {
      return new Response("转发失败: " + e.message, { status: 502 });
    }
  },
};
