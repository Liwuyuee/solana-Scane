/**
 * 智能 fetch 模块
 *
 * 自动判断是否需要通过 Cloudflare Workers 转发。
 * 配置 WORKER_URL 后，被墙的 API 自动走 Worker 中转。
 *
 * 环境变量:
 *   WORKER_URL=https://xxx.xxx.workers.dev  （可选）
 */

// 这些域名在国内被墙，需要走 Workers 中转（如果配置了）
const BLOCKED_DOMAINS = [
  "api.dexscreener.com",
  "price.jup.ag",
  "quote-api.jup.ag",
  "api.rugcheck.xyz",
];

/**
 * 智能 fetch，自动处理被墙的 API
 * @param {string} url - 请求地址
 * @param {object} options - fetch 选项 (method, headers, body, signal 等)
 * @returns {Promise<Response>}
 */
async function apiFetch(url, options) {
  var workerUrl = process.env.WORKER_URL;

  // 如果配置了 Worker，并且目标域名被墙 → 走 Worker 中转
  if (workerUrl) {
    try {
      var u = new URL(url);
      var isBlocked = BLOCKED_DOMAINS.some(function(d) { return u.hostname.endsWith(d); });
      if (isBlocked) {
        var proxyUrl = workerUrl + "/?url=" + encodeURIComponent(url);
        // Worker 转发只需要 method 和 body（headers 由 Worker 自己加）
        var res = await fetch(proxyUrl, {
          method: options?.method || "GET",
          body: options?.body || undefined,
          signal: options?.signal || undefined,
        });
        return res;
      }
    } catch (e) {
      // Worker 中转失败，回退到直连
    }
  }

  // 没有 Worker 或不需要中转 → 正常 fetch
  return fetch(url, options || {});
}

module.exports = { apiFetch, BLOCKED_DOMAINS };
