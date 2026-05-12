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
const RPC_URL = "https://api.mainnet-beta.solana.com";
const POLL_INTERVAL = 10000;
const RAYDIUM_INTERVAL = 15000;

class Monitor {
  constructor(existingMints) {
    this.seen = new Set(existingMints || []);  // 从数据库加载已扫 mint
    this.seenPumpSigs = new Set();
    this.seenRaydiumSigs = new Set();
    this.onNewToken = null;

    this.#startPumpfunPolling();
    this.#startRaydiumPolling();
    this._startDexFallback();
  }

  /** 注册新代币回调 */
  setNewTokenCallback(fn) {
    this.onNewToken = fn;
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
    var res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getSignaturesForAddress",
        params: [PUMPFUN, { limit: 10 }],
      }),
    });
    if (!res.ok) return;
    var data = await res.json();
    var sigs = data.result || [];
    if (sigs.length === 0) return;

    // 从最新到最旧处理，记录最新的作为断点
    var newestSig = sigs[0].signature;

    // 跳过已经见过的
    var newSigs = [];
    for (var i = 0; i < sigs.length; i++) {
      var s = sigs[i].signature;
      if (!this.seenSigs.has(s)) {
        this.seenSigs.add(s);
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
    var res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getSignaturesForAddress",
        params: [RAYDIUM_AMM, { limit: 10 }],
      }),
    });
    if (!res.ok) return;
    var data = await res.json();
    var sigs = data.result || [];
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
      var res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getTransaction",
          params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
        }),
      });
      tx = (await res.json()).result;
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
      var res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getTransaction",
          params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
        }),
      });
      tx = (await res.json()).result;
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
      var res = await fetch("https://api.dexscreener.com/latest/dex/search/?q=" + mint);
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
        var res = await fetch("https://api.dexscreener.com/token-boosts/latest/v1");
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
            var r = await fetch("https://api.dexscreener.com/latest/dex/search/?q=" + addr);
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
        if (e && e.message) console.warn("  DexScreener 失败:", e.message);
      }
      setTimeout(poll, 30000);
    }
    poll();
  }
}

module.exports = { Monitor };
