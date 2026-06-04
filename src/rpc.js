/**
 * RPC 调用模块
 *
 * 优先走 Helius（直连快），失败后自动切公共 RPC（走代理慢但兜底）。
 * 每节点 15 秒超时，快速失败不阻塞。
 */

async function rpcCall(method, params) {
  var endpoints = [
    process.env.RPC_URL,                              // Helius 直连（首选）
    "https://api.mainnet-beta.solana.com",            // 公共 RPC（兜底）
  ].filter(Boolean);  // 去掉空的

  for (var i = 0; i < endpoints.length; i++) {
    try {
      var res = await fetch(endpoints[i], {
        signal: AbortSignal.timeout(15000),
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: method, params: params,
        }),
      });
      if (!res.ok) continue;
      var data = await res.json();
      if (data.error) continue;
      return data.result;
    } catch (e) {
      continue; // 这个端点失败，试下一个
    }
  }
  return null; // 全部失败
}

module.exports = { rpcCall };
