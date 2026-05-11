/**
 * Solana 新代币监控
 *
 * 主数据源: WebSocket 订阅 Pump.fun 程序日志（实时）
 * 兜底:     DexScreener token-boosts API（每 30 秒）
 *
 * 检测到新交易 → getTransaction 解析 → 对比 pre/postTokenBalances 找到新 Mint
 */

const WebSocket = require("ws");
const { HttpsProxyAgent } = require("https-proxy-agent");

const PUMPFUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const WS_URL = "wss://api.mainnet-beta.solana.com";
const RPC_URL = "https://api.mainnet-beta.solana.com";

class Monitor {
  constructor() {
    this.seen = new Set();       // 已发现的 mint
    this.seenSigs = new Set();   // 已处理过的签名
    this.ws = null;
    this.onNewToken = null;      // 外部注册的回调: (token) => {}

    // DexScreener 兜底
    this.#startDexFallback();
  }

  // ─── 公开方法 ───────────────────────────────────────

  /** 注册新代币回调 */
  setNewTokenCallback(fn) {
    this.onNewToken = fn;
  }

  /** 启动 WebSocket 监听 */
  start() {
    this.#connectWS();
  }

  // ─── WebSocket ──────────────────────────────────────

  #connectWS() {
    const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "";
    const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;

    this.ws = new WebSocket(WS_URL, { agent, handshakeTimeout: 15000 });

    this.ws.on("open", () => {
      console.log("🔌 WebSocket 已连接");
      // 订阅 Pump.fun 程序日志
      this.ws.send(JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "logsSubscribe",
        params: [{ mentions: [PUMPFUN] }, { commitment: "processed" }],
      }));
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // 订阅确认
        if (msg.id === 1 && msg.result) return;
        // 日志通知
        const val = msg.params?.result?.value;
        if (val?.signature) this.#onLog(val);
      } catch {}
    });

    this.ws.on("close", (code) => {
      console.log(`🔌 WebSocket 断开 (${code}), 3 秒后重连...`);
      setTimeout(() => this.#connectWS(), 3000);
    });

    this.ws.on("error", (err) => {
      console.error(`🔌 WebSocket 错误: ${err.message}`);
    });
  }

  /** 收到链上日志 → 解析交易 */
  async #onLog(log) {
    const sig = log.signature;
    if (this.seenSigs.has(sig)) return;
    this.seenSigs.add(sig);

    console.log(`📡 Pump.fun 新交易: ${sig.slice(0, 20)}...`);
    // 等 1.5 秒让交易最终确认
    await new Promise((r) => setTimeout(r, 1500));
    await this.#parseTx(sig);
  }

  /** 解析交易，提取新代币 */
  async #parseTx(sig) {
    let tx;
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getTransaction",
          params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
        }),
      });
      tx = (await res.json()).result;
    } catch (err) {
      console.warn(`  交易解析失败: ${err.message}`);
      return;
    }

    if (!tx?.meta) return;

    // 1) 检查是否为创建操作
    const logs = tx.meta.logMessages || [];
    const isCreate = logs.some(
      (l) => l.includes("Create") || l.includes("initialize") || l.includes("Instruction: 0")
    );
    if (!isCreate) return;

    // 2) 从 token balances 找新 mint
    const pre = tx.meta.preTokenBalances || [];
    const post = tx.meta.postTokenBalances || [];
    const preMints = new Set((pre || []).map((b) => b.mint));

    const newMints = [];
    for (const b of post) {
      if (b.mint && !preMints.has(b.mint)) newMints.push(b.mint);
    }

    for (const mint of newMints) {
      if (this.seen.has(mint)) continue;
      this.seen.add(mint);

      // 部署者 = fee payer
      const creator = tx.transaction?.message?.accountKeys?.[0]?.pubkey || "";

      console.log(`🎯 新代币: ${mint} (部署者: ${creator.slice(0, 8)}...)`);

      // 补全元信息
      const token = await this.#enrich(mint, creator, sig);
      if (this.onNewToken) this.onNewToken(token);
    }
  }

  // ─── 信息补全 ───────────────────────────────────────

  /** 查 DexScreener 拿 name/symbol */
  async #enrich(mint, creator, sig) {
    const token = {
      mint,
      name: mint.slice(0, 8),
      symbol: "?",
      creator,
      createTx: sig,
      source: "websocket",
      description: "",
      socials: { twitter: "", telegram: "", website: "" },
    };

    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/search/?q=${mint}`
      );
      if (res.ok) {
        const data = await res.json();
        const pair = data.pairs?.[0];
        if (pair?.baseToken) {
          token.name = pair.baseToken.name || token.name;
          token.symbol = pair.baseToken.symbol || token.symbol;
        }
      }
    } catch {}

    return token;
  }

  // ─── DexScreener 兜底（每 30 秒） ────────────────────

  #startDexFallback() {
    setInterval(async () => {
      try {
        const res = await fetch("https://api.dexscreener.com/token-boosts/latest/v1");
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data)) return;

        for (const b of data) {
          const addr = b.tokenAddress;
          if (!addr || this.seen.has(addr)) continue;
          this.seen.add(addr);

          console.log(`📌 DexScreener 发现: ${addr.slice(0, 10)}...`);
          const token = {
            mint: addr,
            name: addr.slice(0, 8),
            symbol: "?",
            creator: "",
            source: "dexscreener",
            description: (b.description || "").slice(0, 200),
            socials: { twitter: "", telegram: "", website: "" },
          };

          if (b.links) {
            for (const link of b.links) {
              const url = link.url || "";
              if (link.type === "twitter") token.socials.twitter = url;
              else if (link.type === "telegram") token.socials.telegram = url;
            }
          }

          // 补全名称
          try {
            const r = await fetch(
              `https://api.dexscreener.com/latest/dex/search/?q=${addr}`
            );
            if (r.ok) {
              const d = await r.json();
              const p = d.pairs?.[0];
              if (p?.baseToken) {
                token.name = p.baseToken.name || token.name;
                token.symbol = p.baseToken.symbol || token.symbol;
              }
            }
          } catch {}

          if (this.onNewToken) this.onNewToken(token);
        }
      } catch {}
    }, 30000);
  }
}

module.exports = { Monitor };
