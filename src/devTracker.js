/**
 * 开发者钱包行为追踪
 *
 * 内存存储，重启重置。
 * 记录每个部署者创建的代币、rug 历史、卖出行为。
 */
const RPC_URL = "https://api.mainnet-beta.solana.com";
const RUGCHECK_API = "https://api.rugcheck.xyz/v1";

class DevTracker {
  constructor() {
    /** Map<wallet, { tokensCreated, firstSeen, tokenMints, ruggedCount, lastSellCheck }> */
    this.db = new Map();
  }

  /**
   * 记录新代币的部署者
   */
  async record(creator, mint) {
    if (!creator || creator.length < 30) {
      return { tokensCreated: 0, firstSeen: null, risk: "unknown", isSelling: false };
    }

    var record = this.db.get(creator);

    if (record) {
      record.tokenMints.push(mint);
      record.tokensCreated++;
    } else {
      record = {
        tokensCreated: 1,
        firstSeen: Date.now(),
        tokenMints: [mint],
        ruggedCount: 0,
        checked: false,
        lastSellCheck: 0,
      };
      this.db.set(creator, record);
      this.#backfill(creator, record);
    }

    // 检查是否正在砸盘
    var isSelling = await this.#checkSelling(creator, record);

    return {
      tokensCreated: record.tokensCreated,
      firstSeen: record.firstSeen,
      ruggedCount: record.ruggedCount,
      risk: this.#riskLabel(record),
      isSelling: isSelling,
    };
  }

  /** 异步回溯部署者的历史代币 */
  async #backfill(creator, record) {
    if (record.checked) return;
    record.checked = true;

    try {
      var sigsRes = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getSignaturesForAddress",
          params: [creator, { limit: 20 }],
        }),
      });
      var sigs = (await sigsRes.json()).result || [];
      var seenMints = new Set(record.tokenMints);

      for (var i = 0; i < sigs.length; i++) {
        try {
          var txRes = await fetch(RPC_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0", id: 1, method: "getTransaction",
              params: [sigs[i].signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
            }),
          });
          var tx = (await txRes.json()).result;
          if (!tx || !tx.meta) continue;

          var post = tx.meta.postTokenBalances || [];
          var pre = tx.meta.preTokenBalances || [];
          var preMints = new Set((pre || []).map(function(b) { return b.mint; }));

          for (var j = 0; j < post.length; j++) {
            var b = post[j];
            if (b.mint && !preMints.has(b.mint) && !seenMints.has(b.mint)) {
              seenMints.add(b.mint);
              await this.#checkRug(b.mint, record);
              await new Promise(function(r) { setTimeout(r, 600); });
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  /**
   * 检查部署者是否在卖出
   * 看最近 Pump.fun 交易中是否包含 Sell 指令
   */
  async #checkSelling(creator, record) {
    // 每 30 秒内只查一次
    if (Date.now() - record.lastSellCheck < 30000) return false;
    record.lastSellCheck = Date.now();

    try {
      var sigsRes = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getSignaturesForAddress",
          params: [creator, { limit: 5 }],
        }),
      });
      var sigs = (await sigsRes.json()).result || [];

      for (var i = 0; i < sigs.length; i++) {
        var txRes = await fetch(RPC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "getTransaction",
            params: [sigs[i].signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
          }),
        });
        var tx = (await txRes.json()).result;
        if (!tx || !tx.meta) continue;

        var logs = tx.meta.logMessages || [];
        // 检测 Sell 指令
        var isSell = logs.some(function(l) {
          return l.indexOf("Instruction: Sell") >= 0 ||
                 l.indexOf("sell") >= 0;
        });
        if (isSell) return true;
      }
    } catch (e) {}

    return false;
  }

  async #checkRug(mint, record) {
    try {
      var res = await fetch(RUGCHECK_API + "/tokens/" + mint + "/report/summary");
      if (res.status === 404) return;
      if (!res.ok) return;
      var data = await res.json();
      if (data.rugged || data.result === "Danger") {
        record.ruggedCount++;
      }
    } catch (e) {}
  }

  #riskLabel(record) {
    if (record.tokensCreated >= 3 && record.ruggedCount >= 2) return "危险（多次rug）";
    if (record.ruggedCount > 0) return "有rug历史（" + record.ruggedCount + "次）";
    if (record.tokensCreated >= 5) return "频繁发币";
    if (record.tokensCreated >= 2) return "有经验";
    return "首次发币";
  }
}

module.exports = { DevTracker };
