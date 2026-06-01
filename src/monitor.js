/**
 * Solana 新代币监控
 *
 * 数据源:
 * - Pump.fun: 土狗发射场（10 秒轮询）
 * - Raydium:  主流 DEX，毕业币和直接发币（15 秒轮询）
 * - DexScreener: 兜底扫描（30 秒）
 */

const PUMPFUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const WSOL = "So11111111111111111111111111111111111111112";
const RAYDIUM_CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const POLL_INTERVAL = 10000;
const RAYDIUM_INTERVAL = 15000;
const { apiFetch } = require("./fetch");
const { rpcCall } = require("./rpc");

// WebSocket 走代理（中国网络需要）
var WS_CONNECT = null;
try {
  var proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "";
  if (proxyUrl) {
    var { HttpsProxyAgent } = require("https-proxy-agent");
    WS_CONNECT = function(url) {
      var WebSocket = require("ws");
      var agent = new HttpsProxyAgent(proxyUrl);
      return new WebSocket(url, { agent: agent });
    };
  }
} catch (e) {}
// 如果代理加载失败，用原生 WebSocket
if (!WS_CONNECT) {
  WS_CONNECT = function(url) { return new WebSocket(url); };
}

class Monitor {
  #ws = null;

  constructor(existingMints) {
    this.seen = new Set(existingMints || []);  // 从数据库加载已扫 mint
    this.seenPumpSigs = new Set();
    this.seenRaydiumSigs = new Set();
    this.onNewToken = null;

    this.#startPumpfunPolling();
    this.#startRaydiumPolling();
    this._startDexFallback();
    this.#connectPumpPortal();  // WebSocket 实时推送（比 HTTP 轮询快 10 倍）
  }

  /** 注册新代币回调 */
  setNewTokenCallback(fn) {
    this.onNewToken = fn;
  }

  // ─── PumpPortal WebSocket 实时推送 ────────────────────
  // 比 HTTP 轮询快 10 倍，延迟从 10s 降至 <1s
  // HTTP 轮询保留作为兜底

  #connectPumpPortal() {
    var self = this;
    var reconnectTimer = null;
    var keepAliveTimer = null;

    function connect() {
      try {
        self.#ws = WS_CONNECT("wss://pumpportal.fun/api/data");

        self.#ws.onopen = function() {
          console.log("  🔌 PumpPortal WebSocket 已连接");
          // 每 25 秒发一次 ping 保持连接活跃
          if (keepAliveTimer) clearInterval(keepAliveTimer);
          keepAliveTimer = setInterval(function() {
            if (self.#ws && self.#ws.readyState === 1) {
              try { self.#ws.ping(); } catch(e) {}
            }
          }, 25000);
        };

        self.#ws.onmessage = function(event) {
          try {
            var data = JSON.parse(event.data);
          // PumpPortal 推送的字段: mint, name, symbol, creator, description, twitter, telegram, website, uri, txHash
          var mint = data.mint || "";
          if (!mint) return;

          // 去重（seen 集合与 HTTP 轮询共享）
          if (this.seen.has(mint)) return;
          this.seen.add(mint);

          console.log("🎯 PumpPortal 实时: " + (data.name || mint.slice(0, 10)) + " (" + (data.symbol || "?") + ")");

          var token = {
            mint: mint,
            name: data.name || mint.slice(0, 8),
            symbol: data.symbol || "?",
            creator: data.creator || "",
            source: "pumpportal",
            description: data.description || "",
            socials: {
              twitter: data.twitter || "",
              telegram: data.telegram || "",
              website: data.website || "",
            },
            dexInfo: null,
          };

          // 异步补全 DexScreener 信息（不阻塞回调）
          this.#enrichExisting(token);

          if (this.onNewToken) this.onNewToken(token);
        } catch (e) {
          // 解析失败静默忽略
        }
      };

        self.#ws.onclose = function() {
          self.#ws = null;
          if (keepAliveTimer) clearInterval(keepAliveTimer);
          // 固定 3 秒重连，避免漏币
          console.log("  🔌 PumpPortal 断线，3 秒后重连...");
          reconnectTimer = setTimeout(connect, 3000);
        };

        self.#ws.onerror = function() {
          // onclose 会在 onerror 后触发
        };
      } catch (e) {
        // WebSocket 创建失败，3 秒后重试
        reconnectTimer = setTimeout(connect, 3000);
      }
    }

    connect();
  }

  /** 异步补全 WebSocket 收到的代币信息（不阻塞主流程） */
  async #enrichExisting(token) {
    try {
      var res = await // Use apiFetch for blocked domains
      apiFetch("https://api.dexscreener.com/latest/dex/search/?q=" + token.mint, { signal: AbortSignal.timeout(30000) });
      if (res.ok) {
        var data = await res.json();
        var pair = (data.pairs || []).find(function(p) { return p.chainId === "solana"; });
        if (pair && pair.baseToken) {
          token.name = pair.baseToken.name || token.name;
          token.symbol = pair.baseToken.symbol || token.symbol;
          token.dexInfo = {
            dexName: pair.dexId || "",
            pairAddress: pair.pairAddress || "",
            pairCreatedAt: pair.pairCreatedAt || 0,
            liquidityUsd: pair.liquidity?.usd || 0,
            fdv: pair.fdv || 0,
            priceUsd: pair.priceUsd || 0,
            priceChange24h: pair.priceChange?.h24 || 0,
            volume24h: pair.volume?.h24 || 0,
            volume6h: pair.volume?.h6 || 0,
            volume1h: pair.volume?.h1 || 0,
            txns24h: pair.txns?.h24 || { buys: 0, sells: 0 },
            url: pair.url || "",
          };
        }
      }
    } catch (e) {}
  }

  // ─── HTTP 轮询 Pump.fun 程序签名 ─────────────────

  #startPumpfunPolling() {
    var heartbeat = 0;
    var poll = () => {
      this.#pollSignatures()
        .catch((err) => {
          console.warn("  轮询失败:", err.message);
        })
        .finally(() => {
          heartbeat++;
          if (heartbeat % 12 === 0) {
            console.log("  💓 心跳检测 - 运行中 (" + new Date().toLocaleTimeString() + ")");
          }
          setTimeout(poll, POLL_INTERVAL);
        });
    };
    poll();
  }

  async #pollSignatures() {
    // 取最近 10 条签名
    var sigs = await rpcCall("getSignaturesForAddress", [PUMPFUN, { limit: 10 }]) || [];
    if (sigs.length === 0) return;

    // 从最新到最旧处理，记录最新的作为断点
    var newestSig = sigs[0].signature;

    // 跳过已经见过的
    var newSigs = [];
    for (var i = 0; i < sigs.length; i++) {
      var s = sigs[i].signature;
      if (!this.seenPumpSigs.has(s)) {
        this.seenPumpSigs.add(s);
        newSigs.push(s);
      }
    }

    // 处理新签名（只处理最新的 3 条，避免 API 限速）
    var toProcess = newSigs.slice(0, 3);
    for (var i = 0; i < toProcess.length; i++) {
      await this.#parseTx(toProcess[i]);
      // 限速：每条间隔 500ms
      if (i < toProcess.length - 1) {
        await new Promise(function(r) { setTimeout(r, 500); });
      }
    }
  }

  // ─── HTTP 轮询 Raydium AMM 签名 ──────────────────

  #startRaydiumPolling() {
    var heartbeat = 0;
    var poll = () => {
      this.#pollRaydium()
        .catch((err) => {
          // silent
        })
        .finally(() => {
          heartbeat++;
          if (heartbeat % 12 === 0) {
            console.log("  💓 心跳检测 - Raydium 扫描中 (" + new Date().toLocaleTimeString() + ")");
          }
          setTimeout(poll, RAYDIUM_INTERVAL);
        });
    };
    poll();
  }

  async #pollRaydium() {
    var sigs = await rpcCall("getSignaturesForAddress", [RAYDIUM_AMM, { limit: 10 }]) || [];
    if (sigs.length === 0) return;

    // Process new signatures
    var toProcess = [];
    for (var i = 0; i < sigs.length; i++) {
      var s = sigs[i].signature;
      if (!this.seenRaydiumSigs.has(s)) {
        this.seenRaydiumSigs.add(s);
        toProcess.push(s);
      }
    }

    // Process up to 3 new txs
    toProcess = toProcess.slice(0, 3);
    for (var i = 0; i < toProcess.length; i++) {
      await this.#parseRaydiumTx(toProcess[i]);
      if (i < toProcess.length - 1) {
        await new Promise(function(r) { setTimeout(r, 500); });
      }
    }
  }

  async #parseRaydiumTx(sig) {
    var tx;
    try {
      tx = await rpcCall("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    } catch (e) {
      return;
    }
    if (!tx || !tx.meta) return;

    // Raydium 新池 = initialize2 指令
    var logs = tx.meta.logMessages || [];
    var isNewPool = logs.some(function(l) {
      return l.indexOf("initialize2") >= 0 || l.indexOf("Initialize") >= 0;
    });
    if (!isNewPool) return;

    // 从 postTokenBalances 提取新 mint，排除 WSOL
    var pre = tx.meta.preTokenBalances || [];
    var post = tx.meta.postTokenBalances || [];
    var preMints = new Set((pre || []).map(function(b) { return b.mint; }));

    for (var i = 0; i < post.length; i++) {
      var b = post[i];
      if (!b.mint || b.mint === WSOL) continue;
      if (preMints.has(b.mint)) continue;
      if (this.seen.has(b.mint)) continue;
      this.seen.add(b.mint);

      var creator = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys)
        ? tx.transaction.message.accountKeys[0].pubkey : "";

      console.log("🎯 Raydium 新池: " + b.mint.slice(0, 10) + "...");
      var token = await this.#enrich(b.mint, creator, sig);
      if (this.onNewToken) this.onNewToken(token);
    }
  }

  /** 解析 Pump.fun 交易，提取新代币 */
  async #parseTx(sig) {
    var tx;
    try {
      tx = await rpcCall("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    } catch (err) {
      return;
    }

    if (!tx || !tx.meta) return;

    // 1) 检查是否为创建操作
    var logs = tx.meta.logMessages || [];
    var isCreate = logs.some(function(l) {
      return l.indexOf("Create") >= 0 || l.indexOf("initialize") >= 0 || l.indexOf("Instruction: 0") >= 0;
    });
    if (!isCreate) return;

    // 2) 从 token balances 找新 mint
    var pre = tx.meta.preTokenBalances || [];
    var post = tx.meta.postTokenBalances || [];
    var preMints = new Set((pre || []).map(function(b) { return b.mint; }));

    var newMints = [];
    for (var i = 0; i < post.length; i++) {
      var b = post[i];
      if (b.mint && !preMints.has(b.mint)) newMints.push(b.mint);
    }

    for (var i = 0; i < newMints.length; i++) {
      var mint = newMints[i];
      if (this.seen.has(mint)) continue;
      this.seen.add(mint);

      // 部署者 = fee payer
      var creator = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys)
        ? tx.transaction.message.accountKeys[0].pubkey : "";

      console.log("🎯 新代币: " + mint.slice(0, 10) + "... (部署者: " + creator.slice(0, 8) + "...)");

      // 补全元信息
      var token = await this.#enrich(mint, creator, sig);
      if (this.onNewToken) this.onNewToken(token);
    }
  }

  // ─── 信息补全 ───────────────────────────────────────

  /** 查 DexScreener 拿 name/symbol + 交易对信息 */
  async #enrich(mint, creator, sig) {
    var token = {
      mint: mint,
      name: mint.slice(0, 8),
      symbol: "?",
      creator: creator,
      createTx: sig,
      source: "onchain",
      description: "",
      socials: { twitter: "", telegram: "", website: "" },
      dexInfo: null,   // 交易对信息
    };

    try {
      var res = await // Use apiFetch for blocked domains
      apiFetch("https://api.dexscreener.com/latest/dex/search/?q=" + mint, { signal: AbortSignal.timeout(30000) });
      if (res.ok) {
        var data = await res.json();
        var pairs = data.pairs || [];

        // 找 Solana 链的交易对
        for (var i = 0; i < pairs.length; i++) {
          var p = pairs[i];
          if (p.chainId === "solana") {
            token.name = p.baseToken.name || token.name;
            token.symbol = p.baseToken.symbol || token.symbol;

            // 保存交易对信息（含交易量、价格变化）
            token.dexInfo = {
              dexName: p.dexId || "",
              pairAddress: p.pairAddress || "",
              pairCreatedAt: p.pairCreatedAt || 0,
              liquidityUsd: p.liquidity && p.liquidity.usd || 0,
              fdv: p.fdv || 0,
              priceUsd: p.priceUsd || 0,
              priceChange24h: p.priceChange && p.priceChange.h24 || 0,
              volume24h: p.volume && p.volume.h24 || 0,
              volume6h: p.volume && p.volume.h6 || 0,
              volume1h: p.volume && p.volume.h1 || 0,
              txns24h: p.txns && p.txns.h24 || { buys: 0, sells: 0 },
              url: p.url || "",
            };
            break;
          }
        }
      }
    } catch (e) {}

    return token;
  }

  // ─── DexScreener 兜底（每 30 秒） ────────────────────

  _startDexFallback() {
    var self = this;
    async function poll() {
      try {
        var res = await // Use apiFetch for blocked domains
      apiFetch("https://api.dexscreener.com/token-boosts/latest/v1", { signal: AbortSignal.timeout(30000) });
        if (!res.ok) return;
        var data = await res.json();
        if (!Array.isArray(data)) return;

        for (var i = 0; i < data.length; i++) {
          var b = data[i];
          if (b.chainId !== "solana") continue;
          var addr = b.tokenAddress;
          if (!addr) continue;
          if (!self.seen) return; // safety
          if (self.seen.has(addr)) continue;
          self.seen.add(addr);

          console.log("📌 DexScreener 发现: " + addr.slice(0, 10) + "...");
          var token = {
            mint: addr,
            name: addr.slice(0, 8),
            symbol: "?",
            creator: "",
            source: "dexscreener",
            description: (b.description || "").slice(0, 200),
            socials: { twitter: "", telegram: "", website: "" },
          };

          if (b.links) {
            for (var j = 0; j < b.links.length; j++) {
              var link = b.links[j];
              var url = link.url || "";
              if (link.type === "twitter") token.socials.twitter = url;
              else if (link.type === "telegram") token.socials.telegram = url;
              else if (!link.type && url) token.socials.website = url;
            }
          }

          // 补全名称
          try {
            var r = await // Use apiFetch for blocked domains
      apiFetch("https://api.dexscreener.com/latest/dex/search/?q=" + addr, { signal: AbortSignal.timeout(30000) });
            if (r.ok) {
              var d = await r.json();
              var p = d.pairs && d.pairs[0];
              if (p && p.baseToken) {
                token.name = p.baseToken.name || token.name;
                token.symbol = p.baseToken.symbol || token.symbol;
              }
            }
          } catch (e) {}

          if (self.onNewToken) self.onNewToken(token);
        }
      } catch (e) {
        // DexScreener 在中国访问不稳定，失败不影响主扫链
      }
      setTimeout(poll, 30000);
    }
    poll();
  }
}

module.exports = { Monitor };
