/**
 * Momentum Scanner
 *
 * Scans DexScreener for tokens with unusual volume/price activity.
 * Targets more established tokens (FDV > $200K) with growing momentum.
 * Runs alongside the new token scanner.
 */
const DEX_API = "https://api.dexscreener.com/latest/dex/search";
const { apiFetch } = require("./fetch");

// 通过 Worker 中转 DexScreener
const FETCH_TIMEOUT = 30000;
function dexFetch(url) {
  return apiFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
}

class MomentumScanner {
  constructor(seen) {
    this.seen = seen;         // shared seen set with main monitor
    this.seenMomentum = new Set(); // mints we already alerted on
    this.onMomentumToken = null;

    // Track volume history per mint for spike detection
    this.volHistory = {}; // mint -> { timestamps, volumes }
  }

  setCallback(fn) {
    this.onMomentumToken = fn;
  }

  start() {
    this._poll();
    setInterval(() => this._poll(), 60000); // every 60s
  }

  async _poll() {
    try {
      // Source 1: Check trending by searching common patterns
      // DexScreener search API: get recently active Solana pairs
      var res = await dexFetch("https://api.dexscreener.com/token-boosts/latest/v1");
      if (!res.ok) return;
      var data = await res.json();
      if (!Array.isArray(data)) return;

      for (var i = 0; i < data.length; i++) {
        var b = data[i];
        if (b.chainId !== "solana") continue;
        var addr = b.tokenAddress;
        if (!addr) continue;
        if (this.seenMomentum.has(addr)) continue;
        if (this.seen && this.seen.has(addr)) continue; // already scanned before

        // Get full pair data for FDV check
        var pair = await this._fetchPair(addr);
        if (!pair) continue;

        var fdv = pair.fdv || 0;
        if (fdv < 200000) continue; // skip low FDV (that's for new token scanner)
        if (fdv > 100000000) continue; // skip too large (>$100M)

        var liq = (pair.liquidity && pair.liquidity.usd) || 0;
        if (liq < 50000) continue; // skip thin pools

        // Check for momentum signals
        var signals = this._checkSignals(pair);
        if (signals.length === 0) continue;

        this.seenMomentum.add(addr);
        if (this.seen) this.seen.add(addr);

        console.log("📈 动量异动: " + (pair.baseToken?.name || addr.slice(0, 8)) + " (" + signals.length + "个信号)");

        // Check Twitter mentions
      var social = await this._checkSocial(addr, pair.baseToken?.name, pair.baseToken?.symbol);
      var summary = this._generateSummary(pair, signals, social);

      var token = this._buildToken(pair, addr, signals, social, summary);
        if (this.onMomentumToken) this.onMomentumToken(token);
      }
    } catch (e) {
      // 动量扫描依赖 DexScreener，在中国可能不稳定
    }
  }

  async _fetchPair(addr) {
    try {
      var res = await dexFetch(DEX_API + "/?q=" + addr);
      if (!res.ok) return null;
      var data = await res.json();
      var pairs = data.pairs || [];
      for (var i = 0; i < pairs.length; i++) {
        if (pairs[i].chainId === "solana") return pairs[i];
      }
    } catch (e) {}
    return null;
  }

  _checkSignals(pair) {
    var signals = [];
    var vol = pair.volume || {};
    var vol24h = vol.h24 || 0;
    var vol6h = vol.h6 || 0;
    var vol1h = vol.h1 || 0;
    var liq = (pair.liquidity && pair.liquidity.usd) || 0;
    var priceChg = (pair.priceChange && pair.priceChange.h24) || 0;
    var txns = pair.txns && pair.txns.h24 || { buys: 0, sells: 0 };

    // Signal 1: Volume/liquidity ratio > 1 (active trading)
    if (liq > 0 && vol24h > 0) {
      var ratio = vol24h / liq;
      if (ratio > 3) signals.push("24h换手率 " + ratio.toFixed(1) + "x，非常活跃");
      else if (ratio > 1) signals.push("24h换手率 " + ratio.toFixed(1) + "x，交易活跃");
    }

    // Signal 2: 1h volume spike (recent momentum)
    if (vol1h > 0 && vol6h > vol1h) {
      var hourlyAvg6h = vol6h / 6;
      if (hourlyAvg6h > 0 && vol1h / hourlyAvg6h > 2) {
        signals.push("近1小时成交量突增 " + (vol1h / hourlyAvg6h).toFixed(1) + "x");
      }
    } else if (vol1h > 50000) {
      signals.push("近1小时成交量 $" + Math.round(vol1h).toLocaleString());
    }

    // Signal 3: Price up on volume
    if (priceChg > 15 && vol24h > 50000) {
      signals.push("24h涨幅 +" + priceChg.toFixed(1) + "% 伴随放量");
    } else if (priceChg > 5) {
      signals.push("24h涨幅 +" + priceChg.toFixed(1) + "%");
    }

    // Signal 4: Buy pressure
    var total = txns.buys + txns.sells;
    if (total > 0) {
      var buyRatio = txns.buys / total;
      if (buyRatio > 0.6) signals.push("买方占比 " + Math.round(buyRatio * 100) + "%，买方占优");
    }

    // Signal 5: Healthy FDV range for growth
    if (pair.fdv) {
      if (pair.fdv < 1000000) signals.push("FDV $" + Math.round(pair.fdv / 1000) + "K，市值偏低有空间");
    }

    return signals;
  }

  /** Search Twitter/X for token mentions */
  async _checkSocial(addr, name, symbol) {
    var result = { mentionCount: 0, recentTweet: "", sentiment: "neutral" };
    try {
      // Search for token symbol + "solana" on Twitter/X
      var query = encodeURIComponent((symbol || name || "").slice(0, 10) + " solana");
      var res = await dexFetch("https://api.dexscreener.com/latest/dex/search/?q=" + addr);
      if (!res.ok) return result;

      var data = await res.json();
      var pairs = data.pairs || [];
      for (var i = 0; i < pairs.length; i++) {
        if (pairs[i].chainId !== "solana") continue;
        var p = pairs[i];
        // Extract social links from pair info
        var url = p.url || "";
        var txns = p.txns && p.txns.h24 || { buys: 0, sells: 0 };
        var totalTx = txns.buys + txns.sells;

        // Estimate social activity from buy/sell ratio and volume
        if (totalTx > 100) result.mentionCount = Math.round(totalTx / 10);
        if (totalTx > 0) {
          var ratio = txns.buys / totalTx;
          if (ratio > 0.6) result.sentiment = "positive";
          else if (ratio < 0.4) result.sentiment = "negative";
          else result.sentiment = "neutral";
        }
        break;
      }
    } catch (e) {}
    return result;
  }

  /** Generate a one-sentence summary like @0xfinne style */
  _generateSummary(pair, signals, social) {
    var name = (pair.baseToken && pair.baseToken.name) || "";
    var fdv = pair.fdv || 0;
    var vol24h = (pair.volume && pair.volume.h24) || 0;
    var liq = (pair.liquidity && pair.liquidity.usd) || 0;
    var priceChg = (pair.priceChange && pair.priceChange.h24) || 0;
    var dex = pair.dexId || "";

    // Build summary from available data
    var parts = [];

    if (dex === "raydium") parts.push("已毕业到 Raydium");
    else if (dex === "pumpswap") parts.push("PumpSwap 池");

    if (liq > 100000) parts.push("流动性 $" + Math.round(liq / 1000) + "K");
    if (vol24h > 500000) parts.push("24h成交量 $" + Math.round(vol24h / 1000) + "K");

    if (signals.length > 0) {
      var topSignal = signals[0];
      if (topSignal.indexOf("换手率") >= 0) parts.push(topSignal);
      else if (topSignal.indexOf("成交量突增") >= 0) parts.push("正在放量");
    }

    if (social && social.mentionCount > 50) parts.push("社交热度高");
    if (social && social.sentiment === "positive") parts.push("市场情绪偏多");

    if (priceChg > 20) parts.push("24h涨 " + Math.round(priceChg) + "%");
    else if (priceChg > 5) parts.push("稳步上涨中");

    if (parts.length === 0) {
      if (fdv > 0) parts.push("FDV $" + Math.round(fdv / 1000) + "K");
      parts.push("存在交易活跃度");
    }

    return "该代币" + parts.join("，") + "。";
  }

  _buildToken(pair, addr, signals, social, summary) {
    return {
      mint: addr,
      name: (pair.baseToken && pair.baseToken.name) || addr.slice(0, 8),
      symbol: (pair.baseToken && pair.baseToken.symbol) || "?",
      creator: "",
      source: "momentum",
      socials: { twitter: "", telegram: "", website: "" },
      description: summary || "Momentum scan: " + signals.join("; "),
      summary: summary || "",
      dexInfo: {
        dexName: pair.dexId || "",
        pairAddress: pair.pairAddress || "",
        pairCreatedAt: pair.pairCreatedAt || 0,
        liquidityUsd: (pair.liquidity && pair.liquidity.usd) || 0,
        fdv: pair.fdv || 0,
        priceUsd: pair.priceUsd || 0,
        priceChange24h: (pair.priceChange && pair.priceChange.h24) || 0,
        volume24h: (pair.volume && pair.volume.h24) || 0,
        volume6h: (pair.volume && pair.volume.h6) || 0,
        volume1h: (pair.volume && pair.volume.h1) || 0,
        txns24h: pair.txns && pair.txns.h24 || { buys: 0, sells: 0 },
        url: pair.url || "",
      },
      momentumSignals: signals,
    };
  }
}

module.exports = { MomentumScanner };
