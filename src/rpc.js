/**
 * RPC 调用模块
 *
 * 通过 --use-env-proxy 走代理访问 Solana RPC。
 * 45 秒超时——中国代理访问慢，但不会永久挂起。
 */

/**
 * 调用 Solana RPC
 * @param {string} method - RPC 方法名
 * @param {Array} params - 参数数组
 * @returns {Promise<any|null>} 成功后返回 result，失败返回 null
 */
async function rpcCall(method, params) {
  try {
    var url = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    var res = await fetch(url, {
      signal: AbortSignal.timeout(45000),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: method, params: params,
      }),
    });
    if (!res.ok) return null;
    var data = await res.json();
    if (data.error) return null;
    return data.result;
  } catch (e) {
    return null;
  }
}

module.exports = { rpcCall };
