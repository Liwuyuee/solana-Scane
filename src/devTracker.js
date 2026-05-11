/**
 * 开发者钱包行为追踪
 *
 * 内存存储，重启重置。
 * 记录每个部署者创建的代币，并通过 rugcheck 回溯历史代币风险。
 */
const RPC_URL = "https://api.mainnet-beta.solana.com";
const RUGCHECK_API = "https://api.rugcheck.xyz/v1";

class DevTracker {
  constructor() {
    /** Map<wallet, { tokensCreated, firstSeen, tokenMints, ruggedCount }> */
    this.db = new Map();
  }

  /**
   * 记录新代币的部署者
   * @param {string} creator  钱包地址
   * @param {string} mint     代币地址
   * @returns {Promise<object>} 该部署者的历史评估
   */
  async record(creator, mint) {
    if (!creator || creator.length < 30) {
      return { tokensCreated: 0, firstSeen: null, risk: "unknown" };
    }

    let record = this.db.get(creator);

    if (record) {
      // 已知部署者 → 记录新代币
      record.tokenMints.push(mint);
      record.tokensCreated++;
    } else {
      // 新部署者 → 创建记录 + 异步回溯历史
      record = {
        tokensCreated: 1,
        firstSeen: Date.now(),
        tokenMints: [mint],
        ruggedCount: 0,
        checked: false,
      };
      this.db.set(creator, record);

      // 后台查历史
      this.#backfill(creator, record);
    }

    return {
      tokensCreated: record.tokensCreated,
      firstSeen: record.firstSeen,
      ruggedCount: record.ruggedCount,
      risk: this.#riskLabel(record),
    };
  }

  /**
   * 异步回溯部署者的历史代币
   */
  async #backfill(creator, record) {
    if (record.checked) return;
    record.checked = true;

    try {
      // 找该地址最近对 Pump.fun 程序的调用（找出历史创建的代币）
      const sigsRes = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getSignaturesForAddress",
          params: [creator, { limit: 20 }],
        }),
      });
      const sigs = (await sigsRes.json()).result || [];

      // 取每条交易找新代币
      const seenMints = new Set(record.tokenMints);

      for (const sigInfo of sigs) {
        try {
          const txRes = await fetch(RPC_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0", id: 1, method: "getTransaction",
              params: [sigInfo.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
            }),
          });
          const tx = (await txRes.json()).result;
          if (!tx?.meta) continue;

          const post = tx.meta.postTokenBalances || [];
          const pre = tx.meta.preTokenBalances || [];
          const preMints = new Set(pre.map((b) => b.mint));

          for (const b of post) {
            if (b.mint && !preMints.has(b.mint) && !seenMints.has(b.mint)) {
              seenMints.add(b.mint);
              // 用 rugcheck 快速检查
              await this.#checkRug(b.mint, record);
              // 限速
              await new Promise((r) => setTimeout(r, 600));
            }
          }
        } catch {}
      }
    } catch {}
  }

  /** 检查单个代币是否被 rugcheck 标记 */
  async #checkRug(mint, record) {
    try {
      const res = await fetch(`${RUGCHECK_API}/tokens/${mint}/report/summary`);
      if (res.status === 404) return;
      if (!res.ok) return;

      const data = await res.json();
      if (data.rugged || data.result === "Danger") {
        record.ruggedCount++;
      }
    } catch {}
  }

  #riskLabel(record) {
    if (record.tokensCreated >= 3 && record.ruggedCount >= 2) return "危险（多次rug）";
    if (record.ruggedCount > 0) return `有rug历史（${record.ruggedCount}次）`;
    if (record.tokensCreated >= 5) return "频繁发币";
    if (record.tokensCreated >= 2) return "有经验";
    return "首次发币";
  }
}

module.exports = { DevTracker };
