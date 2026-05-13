/**
 * Momentum Scanner
 *
 * Scans DexScreener for tokens with unusual volume/price activity.
 * Targets more established tokens (FDV > $200K) with growing momentum.
 * Runs alongside the new token scanner.
 */
const DEX_API = "https://api.dexscreener.com/latest/dex/search";

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
      var res = await fetch("https://api.dexscreener.com/token-boosts/latest/v1");
      if (!res.ok) return;
      var data = await res.json();
      if (!Array.isArray(data)) return;

      for (var i = 0; i < data.length; i++) {
        var b = data[i];
        if (b.chainId !== "solana") continue;
        var addr = b.tokenAddress;
        if (!addr || this.seenMomentum.has(addr)) continue;

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

        var token = this._buildToken(pair, addr, signals);
        if (this.onMomentumToken) this.onMomentumToken(token);
      }
    } catch (e) {
      if (e && e.message) console.warn("  动量扫描失败:", e.message);
    }
  }

  async _fetchPair(addr) {
    try {
      var res = await fetch(DEX_API + "/?q=" + addr);
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

  _buildToken(pair, addr, signals) {
    return {
      mint: addr,
      name: (pair.baseToken && pair.baseToken.name) || addr.slice(0, 8),
      symbol: (pair.baseToken && pair.baseToken.symbol) || "?",
      creator: "",
      source: "momentum",
      socials: { twitter: "", telegram: "", website: "" },
      description: "Momentum scan: " + signals.join("; "),
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
