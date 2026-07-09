/**
 * Paper Trader — 回测验证引擎
 *
 * 每次检测到代币时记录初始价格，然后在 1h/6h/24h 后回查价格。
 * 数据存在 SQLite，供 report.js 生成 P&L 看板。
 *
 * 价格来源：Jupiter Price API（优先）→ DexScreener（兜底）
 */

const JUPITER_PRICE = "https://price.jup.ag/v6/price?ids=";
const { apiFetch } = require("./fetch");

class PaperTrader {
  constructor(store) {
    this.store = store;
  }

  /**
   * 记录新检测的代币，启动价格追踪
   */
  record(token, evalResult, passedFilter, category) {
    var mint = token.mint;
    var name = token.name || "";
    var symbol = token.symbol || "";
    var price = token.dexInfo?.priceUsd || 0;
    var score = (evalResult && evalResult.total) || 0;
    var action = (evalResult && evalResult.action) || "";

    // 写入 DB
    this.store.saveSnapshot(mint, name, symbol, price, score, action, passedFilter, category || "");

    // 如果没价格数据，重试几次等 DEX 信息出现
    if (!price || price <= 0) {
      this.#retryPrice(mint, 0); // 最多重试 3 次
      return;
    }

    // 启动定时回查
    this.#schedule(mint, "15m", 900000);
    this.#schedule(mint, "30m", 1800000);
    this.#schedule(mint, "1h", 3600000);
    this.#schedule(mint, "3h", 10800000);
    this.#schedule(mint, "6h", 21600000);
    this.#schedule(mint, "24h", 86400000);
  }

  /** 重试获取初始价格（因为新币刚创建时可能还没 DEX 数据） */
  #retryPrice(mint, attempt) {
    if (attempt >= 3) return; // 最多重试 3 次
    setTimeout(async () => {
      var price = await this.#fetchPrice(mint);
      if (price && price > 0) {
        this.store.updateSnapshotPrice(mint, "initial", price);
        // 拿到价格了，安排后续回查
        this.#schedule(mint, "15m", 900000);
        this.#schedule(mint, "30m", 1800000);
        this.#schedule(mint, "1h", 3600000);
        this.#schedule(mint, "3h", 10800000);
        this.#schedule(mint, "6h", 21600000);
        this.#schedule(mint, "24h", 86400000);
      } else {
        this.#retryPrice(mint, attempt + 1);
      }
    }, attempt === 0 ? 120000 : 300000); // 首次 2 分钟后，后续 5 分钟后
  }

  /** 安排价格回查 */
  #schedule(mint, label, delayMs) {
    // 检查数据库是否已经查过（重启后避免重复）
    if (this.store.isSnapshotChecked(mint, label)) return;

    setTimeout(async () => {
      var price = await this.#fetchPrice(mint);
      if (price) {
        this.store.updateSnapshotPrice(mint, label, price);
        console.log("   📊 " + label + " 回测完成");
      }
    }, delayMs);
  }

  /** 获取当前价格 */
  async #fetchPrice(mint) {
    // 1) Jupiter Price API
    try {
      var res = await apiFetch(JUPITER_PRICE + mint, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        var data = await res.json();
        var p = data.data?.[mint]?.price;
        if (p) return parseFloat(p);
      }
    } catch (e) {}

    // 2) Birdeye 备用
    try {
      var res = await apiFetch("https://public-api.birdeye.so/public/price?address=" + mint, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        var data = await res.json();
        if (data.success && data.data?.value) return parseFloat(data.data.value);
      }
    } catch (e) {}

    // 3) DexScreener 兜底
    try {
      var res = await apiFetch("https://api.dexscreener.com/latest/dex/search/?q=" + mint, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        var data = await res.json();
        var pair = (data.pairs || []).find(function(p) { return p.chainId === "solana"; });
        if (pair && pair.priceUsd) return parseFloat(pair.priceUsd);
      }
    } catch (e) {}

    return null;
  }
}

module.exports = { PaperTrader };
