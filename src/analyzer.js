/**
 * Token 风险分析
 *
 * 数据源：
 * - rugcheck.xyz: 安全评分 + 风险项
 * - Solana RPC:    Holder 分布分析
 * - DevTracker:    开发者历史
 *
 * 输出：四项评分 + 叙事段落
 */
const { rpcCall } = require("./rpc");

class Analyzer {
  constructor() {
    this.apiBase = "https://api.rugcheck.xyz/v1";
    this.lastCall = 0;
    this.minInterval = 1200;
  }

  // ─── 主入口 ────────────────────────────────────────

  async getReport(mint) {
    if (!mint) return null;

    const [rug, holder] = await Promise.all([
      this.#rugcheck(mint),
      this.#analyzeHolders(mint).catch(() => null),
    ]);

    const base = rug || this.#emptyRug();
    const holders = holder || { totalHolders: 0, top10Pct: 0, risk: "未知", level: "unknown" };

    return {
      ...base,
      holders,
    };
  }

  // ─── 四项评分计算（索引.js 调用） ─────────────────

  /**
   * 根据原始数据计算四项评分
   * @param {object} report   getReport 返回值
   * @param {object} devInfo  devTracker.record() 返回值
   * @returns {{ total, rugRisk, codeQuality, innovation, launchQ, summary, highlights, warnings }}
   */
  evaluate(report, devInfo, dexInfo) {
    if (!report) return this.#emptyEval();

    const holders = report.holders || {};
    const four = this.#calcScores(report, holders, devInfo);
    const honeypot = this.#checkHoneypot(report, dexInfo);
    const growth = this.#calcGrowth(dexInfo, holders);
    const narrative = this.#buildNarrative(report, four, holders, devInfo, honeypot);

    return {
      total: four.rugRisk.score + four.codeQuality.score + four.innovation.score + four.launchQ.score,
      rugRisk: four.rugRisk,
      codeQuality: four.codeQuality,
      innovation: four.innovation,
      launchQ: four.launchQ,
      growth: growth,
      honeypot: honeypot,
      summary: narrative.summary,
      highlights: narrative.highlights,
      warnings: narrative.warnings,
      action: narrative.action,
    };
  }

  // ─── 四项评分计算 ──────────────────────────────────

  #calcScores(report, holders, dev) {
    // 1) 跑路风险 ──────────────────────────────────────
    let rug = 10;
    const dangerCount = report.dangers?.length || 0;
    const warnCount = report.warnings?.length || 0;
    if (report.mintAuthority) rug -= 2;     // 还能增发
    if (report.freezeAuthority) rug -= 1;   // 还能冻
    rug -= dangerCount * 2;                 // 每个高危风险扣 2
    rug -= warnCount * 1;                    // 每个中风险扣 1
    if (report.rugged) rug = 1;            // 已 rug
    if (dev && dev.ruggedCount > 0) rug -= 1;
    rug = Math.max(1, Math.min(10, rug));

    // 2) 代码靠谱 ──────────────────────────────────────
    let code = 10;
    const totalRisks = report.risks?.length || 0;
    code -= totalRisks * 1;
    if (report.mintAuthority) code -= 1;
    if (!report.summary || report.summary === "暂无数据") code -= 3;
    if (report.rugged) code = 1;
    code = Math.max(1, Math.min(10, code));

    // 3) 玩法新鲜 ──────────────────────────────────────
    let innovation = 6;  // 默认中等
    if (holders.totalHolders > 100) innovation += 1;
    else if (holders.totalHolders < 10) innovation -= 1;
    if (report.liquidity > 100000) innovation += 1;
    innovation = Math.max(1, Math.min(10, innovation));

    // 4) 启动质量 ──────────────────────────────────────
    let launch = 6;
    if (dev) {
      if (dev.tokensCreated >= 5) launch -= 2;  // 频繁发币
      else if (dev.tokensCreated >= 2) launch -= 1;
      else launch += 1;  // 首次发币可能更用心
      if (dev.ruggedCount > 0) launch -= 2;
    }
    if (report.liquidity > 50000) launch += 1;
    if (holders.totalHolders < 5) launch -= 1;
    launch = Math.max(1, Math.min(10, launch));

    return {
      rugRisk:  { score: rug,  label: "跑路风险", emoji: rug >= 7 ? "🟩" : rug >= 4 ? "🟨" : "🟥" },
      codeQuality: { score: code, label: "代码靠谱", emoji: code >= 7 ? "🟩" : code >= 4 ? "🟨" : "🟥" },
      innovation:  { score: innovation, label: "玩法新鲜", emoji: innovation >= 7 ? "🟩" : innovation >= 4 ? "🟨" : "🟥" },
      launchQ:     { score: launch, label: "启动质量", emoji: launch >= 7 ? "🟩" : launch >= 4 ? "🟨" : "🟥" },
    };
  }

  // ─── 涨幅潜力评估 ──────────────────────────────────

  #calcGrowth(dexInfo, holders) {
    var score = 5;
    var signals = [];

    if (!dexInfo) {
      return { score: 0, stars: 0, label: "涨幅潜力", emoji: "⬜", detail: "暂无可用的市场数据", signals: ["暂无交易数据"] };
    }

    // 1) FDV 市值空间
    var fdv = dexInfo.fdv || 0;
    if (fdv > 0) {
      if (fdv < 100000)        { score += 2; signals.push("FDV < $100K，上涨空间极大"); }
      else if (fdv < 500000)   { score += 1; signals.push("FDV < $500K，空间较大"); }
      else if (fdv <= 5000000) { signals.push("FDV $" + Math.round(fdv / 1000) + "K，市值适中"); }
      else if (fdv <= 50000000){ score -= 1; signals.push("FDV > $5M，上涨空间有限"); }
      else                     { score -= 2; signals.push("FDV > $50M，大盘币涨幅受限"); }
    }

    // 2) 成交量/流动性比
    var vol = dexInfo.volume24h || 0;
    var liq = dexInfo.liquidityUsd || 0;
    if (liq > 0 && vol > 0) {
      var ratio = vol / liq;
      if (ratio > 5)        { score += 2; signals.push("24h换手率 " + ratio.toFixed(1) + "x，非常活跃"); }
      else if (ratio > 2)   { score += 1; signals.push("24h换手率 " + ratio.toFixed(1) + "x，量能充足"); }
      else if (ratio > 0.5) { signals.push("24h成交量 $" + Math.round(vol).toLocaleString()); }
      else if (ratio < 0.1) { score -= 1; signals.push("交易量偏低，关注度不足"); }
      else                  { signals.push("24h成交量 $" + Math.round(vol).toLocaleString()); }
    }

    // 3) 成交量加速（1h vs 6h）
    var vol1h = dexInfo.volume1h || 0;
    var vol6h = dexInfo.volume6h || 0;
    if (vol1h > 0 && vol6h > vol1h) {
      var accel = vol1h / (vol6h / 6);
      if (accel > 2)       { score += 2; signals.push("近1h成交量加速 " + accel.toFixed(1) + "x，正在放量拉升"); }
      else if (accel > 1)  { score += 1; signals.push("近1h成交量 " + Math.round(vol1h).toLocaleString() + "，短时放量"); }
    } else if (vol1h > 50000) {
      score += 1; signals.push("近1h成交量 $" + Math.round(vol1h).toLocaleString() + "，有交易热度");
    }

    // 4) 买卖比 + 社区热度
    var txns = dexInfo.txns24h;
    if (txns) {
      var buys = txns.buys || 0;
      var sells = txns.sells || 0;
      var total = buys + sells;
      if (total > 0) {
        var buyRatio = buys / total;
        if (buyRatio > 0.7)       { score += 2; signals.push("买入占比 " + Math.round(buyRatio * 100) + "%，买方强势"); }
        else if (buyRatio > 0.55) { score += 1; signals.push("买入 " + Math.round(buyRatio * 100) + "% > 卖出，偏多"); }
        else if (buyRatio >= 0.3) { signals.push("买入 " + Math.round(buyRatio * 100) + "% / 卖出 " + Math.round((1 - buyRatio) * 100) + "%，买卖均衡"); }
        else                      { score -= 2; signals.push("卖出占比 " + Math.round((1 - buyRatio) * 100) + "%，抛压严重"); }
      }
      // 社区热度：24h 总交易笔数 > 500 = 活跃社区
      if (total > 1000)      { score += 2; signals.push("24h " + total + " 笔交易，社区极度活跃"); }
      else if (total > 500)  { score += 1; signals.push("24h " + total + " 笔交易，交易活跃"); }
      else if (total > 100)  { signals.push("24h " + total + " 笔交易，有一定热度"); }
    }

    // 5) Holder 基础
    if (holders && holders.totalHolders > 500)  { score += 2; signals.push("持有者 " + holders.totalHolders + " 人，社区基础好"); }
    else if (holders && holders.totalHolders > 100) { score += 1; signals.push("持有者 " + holders.totalHolders + " 人，有一定基础"); }

    // 6) 价格趋势
    var priceChg = dexInfo.priceChange24h || 0;
    if (priceChg > 50)       { score += 1; signals.push("24h 涨幅 " + Math.round(priceChg) + "%"); }
    else if (priceChg < -30) { score -= 1; signals.push("24h 跌幅 " + Math.round(Math.abs(priceChg)) + "%，近期偏弱"); }

    score = Math.max(1, Math.min(10, score));

    if (signals.length === 0) {
      if (score >= 7)      { signals.push("多个指标向好，有上涨潜力"); }
      else if (score >= 5) { signals.push("数据平稳，无明显爆发信号"); }
      else                 { signals.push("多项指标偏弱，需谨慎"); }
    }

    // 转星星：1-10分 → 1-5星
    var stars = Math.round(score / 2);
    if (stars < 1) stars = 1;
    if (stars > 5) stars = 5;

    return {
      score: score,
      stars: stars,
      label: "涨幅潜力",
      emoji: score >= 7 ? "🟩" : score >= 4 ? "🟨" : "🟥",
      detail: signals.slice(0, 3).join("；"),
      signals: signals.slice(0, 5),
    };
  }

  // ─── Honeypot 检测 ──────────────────────────────────

  /**
   * 扫描 rugcheck 风险项，识别 Honeypot 特征
   * 包括：高额交易税、黑名单、转账限制等
   */
  #checkHoneypot(report, dexInfo) {
    var reasons = [];
    var risk = "low";

    if (!report || !report.risks) {
      return { risk: "unknown", reasons: ["暂无数据，无法检测"] };
    }

    // 定义 Honeypot 关键词
    var honeypotKeywords = [
      { keyword: "tax",       label: "交易税过高" },
      { keyword: "fee",       label: "交易手续费异常" },
      { keyword: "blacklist", label: "存在黑名单功能" },
      { keyword: "freeze",    label: "存在冻结功能" },
      { keyword: "transfer",  label: "转账受限" },
      { keyword: "sell",      label: "卖出受限" },
      { keyword: "burn",      label: "销毁权限可疑" },
      { keyword: "reflection", label: "反射机制可能隐藏限制" },
    ];

    // 检查风险项名称和描述
    for (var i = 0; i < report.risks.length; i++) {
      var r = report.risks[i];
      var text = (r.name + " " + (r.description || "")).toLowerCase();
      for (var j = 0; j < honeypotKeywords.length; j++) {
        if (text.indexOf(honeypotKeywords[j].keyword) >= 0) {
          var msg = "Honeypot 特征: " + honeypotKeywords[j].label + "（" + r.name + "）";
          if (reasons.indexOf(msg) < 0) reasons.push(msg);
        }
      }
    }

    // freeze 权限也是 Honeypot 特征
    if (report.freezeAuthority) {
      reasons.push("Honeypot 特征: Freeze 权限未撤销，团队可冻结账户");
    }

    // DexScreener 买卖比检测：卖出占比极低 → 貔貅
    if (dexInfo && dexInfo.txns24h) {
      var tx = dexInfo.txns24h;
      var total = (tx.buys || 0) + (tx.sells || 0);
      if (total > 10) {
        var sellRatio = (tx.sells || 0) / total;
        if (sellRatio < 0.05) {
          reasons.push("卖出占比仅 " + Math.round(sellRatio * 100) + "%，疑似貔貅（只买不卖）");
        }
        if (tx.buys > 0 && tx.sells === 0) {
          reasons.push("24h 零笔卖出交易，极大概率是貔貅");
        }
      }
    }

    // 判断风险等级
    if (reasons.length >= 3) risk = "high";
    else if (reasons.length >= 1) risk = "medium";
    else risk = "low";

    return { risk: risk, reasons: reasons };
  }

  // ─── Jupiter 链上路由检测 ───────────────────────────

  /**
   * 查询 Jupiter 聚合器，验证代币是否存在有效交易路线
   * 如果 Jupiter 无法报价，说明该代币可能在所有 DEX 都无法卖出 → 貔貅
   * @param {string} mint 代币地址
   * @returns {Promise<{tradable: boolean, detail: string}>}
   */
  async checkJupiterRoute(mint) {
    try {
      var res = await fetch(
        "https://quote-api.jup.ag/v6/quote?inputMint=" + mint +
        "&outputMint=So11111111111111111111111111111111111111112" +
        "&amount=100000&slippageBps=100"
      );
      if (!res.ok) {
        return { tradable: false, detail: "Jupiter 无报价（HTTP " + res.status + "）" };
      }
      var data = await res.json();
      if (data.error) {
        return { tradable: false, detail: "Jupiter 无有效交易路线" };
      }
      return { tradable: true, detail: "Jupiter 可交易" };
    } catch (e) {
      return { tradable: false, detail: "Jupiter 查询失败" };
    }
  }

  /**
   * 使用 @solana/web3.js 链上模拟卖出交易
   * 构建一笔卖出交易的指令，通过 simulateTransaction 验证能否卖出
   * @param {string} mint 代币地址
   * @returns {Promise<{sellable: boolean, detail: string}>}
   */
  async simulateSell(mint) {
    try {
      // 1) 从 Jupiter 获取交易路线和序列化指令
      var quoteRes = await fetch(
        "https://quote-api.jup.ag/v6/quote?inputMint=" + mint +
        "&outputMint=So11111111111111111111111111111111111111112" +
        "&amount=100000&slippageBps=100"
      );
      if (!quoteRes.ok) return { sellable: false, detail: "Jupiter 无报价，无法模拟" };
      var quote = await quoteRes.json();
      if (quote.error) return { sellable: false, detail: "无交易路线" };

      // 2) 获取 swap 交易体
      var swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: "11111111111111111111111111111111", // dummy key
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
        }),
      });
      if (!swapRes.ok) return { sellable: false, detail: "Jupiter swap 接口异常" };
      var swapData = await swapRes.json();

      // 3) 使用 @solana/web3.js 模拟交易
      var solanaWeb3 = require("@solana/web3.js");
      var connection = new solanaWeb3.Connection("https://api.mainnet-beta.solana.com", "confirmed");
      var txBytes = Buffer.from(swapData.swapTransaction, "base64");
      var tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
      var simResult = await connection.simulateTransaction(tx, { replaceRecentBlockhash: true });

      if (simResult.value.err) {
        var errMsg = simResult.value.err.toString();
        return { sellable: false, detail: "链上模拟卖出失败: " + errMsg.slice(0, 80) };
      }

      return { sellable: true, detail: "链上模拟卖出成功，非貔貅" };
    } catch (e) {
      return { sellable: false, detail: "模拟卖出异常: " + (e.message || e).slice(0, 80) };
    }
  }

  // ─── 叙事生成 ──────────────────────────────────────

  #buildNarrative(report, four, holders, dev, honeypot) {
    const rug = four.rugRisk;
    const code = four.codeQuality;
    const innov = four.innovation;
    const launch = four.launchQ;
    const total = rug.score + code.score + innov.score + launch.score;

    // 总体评价
    let action, summary;
    if (total >= 32)          { action = "可以看看"; summary = "整体质量不错，无明显硬伤，可以关注后续交易量。"; }
    else if (total >= 24)     { action = "再观望观望"; summary = "有一定亮点，但也存在一些需要注意的问题，建议先观察真实交易量再决定。"; }
    else if (total >= 16)     { action = "比较警惕"; summary = "风险点较多或启动偏弱，除非有特别亮点否则不建议参与。"; }
    else                      { action = "建议回避"; summary = "多项指标不理想，风险较高，建议远离。"; }

    // 各分数解释
    this.#addDetail(rug,  "跑路风险", report, dev);
    this.#addDetail(code, "代码靠谱", report, dev);
    this.#addDetail(innov, "玩法新鲜", report, holders);
    this.#addDetail(launch, "启动质量", report, dev);

    // 亮点
    const highlights = [];
    if (rug.score >= 8) highlights.push("权限已撤销，团队无法 Rug");
    if (!report.mintAuthority) highlights.push("Mint 权限已放弃，不会无限增发");
    if (!report.freezeAuthority) highlights.push("Freeze 权限已放弃，资金不会被冻结");
    if (code.score >= 7) highlights.push("无高危风险项，代码质量良好");
    if (innov.score >= 7) highlights.push("存在一定创新或特色机制");
    if (holders.top10Pct > 0 && holders.top10Pct < 30) highlights.push("筹码分布相对分散");
    if (dev && dev.ruggedCount === 0 && dev.tokensCreated > 0) highlights.push("部署者有发币经验且无 rug 记录");
    if (report.liquidity > 100000) highlights.push(`流动性充足 ($${Math.round(report.liquidity).toLocaleString()})`);
    if (highlights.length === 0) highlights.push("暂未发现明显亮点");

    // Honeypot 安全 → 加亮点
    if (honeypot && honeypot.risk === "low") {
      highlights.push("未检测到 Honeypot 特征，可正常买卖");
    }

    // 风险
    const warnings = [];
    if (report.mintAuthority) warnings.push("Mint 权限未撤销，团队可以无限增发");
    if (report.freezeAuthority) warnings.push("Freeze 权限未撤销，代币可能被冻结");
    if (report.dangers?.length > 0) {
      report.dangers.forEach(function(r) { warnings.push(r.name); });
    }
    if (holders.top10Pct > 70) warnings.push("筹码高度集中（Top 10 持有 " + holders.top10Pct + "%），有大户砸盘风险");
    if (dev && dev.ruggedCount > 0) warnings.push("部署者有 rug 历史记录");
    if (dev && dev.tokensCreated >= 5) warnings.push("部署者频繁发币（" + dev.tokensCreated + "个），需警惕");
    if (holders.totalHolders < 10) warnings.push("持有者极少（" + holders.totalHolders + "个），流动性风险高");
    if (honeypot && honeypot.reasons.length > 0) {
      honeypot.reasons.forEach(function(r) { warnings.push(r); });
    }
    if (warnings.length === 0) warnings.push("暂未发现明显风险");

    return { action, summary, highlights, warnings };
  }

  /** 为单项评分填充详细解释 */
  #addDetail(item, label, report, extra) {
    if (item.detail) return;
    var s = item.score;
    var lines = [];

    if (label === "跑路风险") {
      if (s >= 8) {
        lines.push("Mint 和 Freeze 权限已撤销，合约不存在增发或冻结功能");
        if (extra && extra.ruggedCount === 0) lines.push("部署者无 Rug 历史");
        lines.push("项目方已放弃控制权，无法篡改合约或转移资金");
        item.detail = lines.join("；") + "。整体跑路风险极低。";
      } else if (s >= 5) {
        if (report.mintAuthority) lines.push("Mint 权限未撤销，团队理论上可以增发");
        else if (report.freezeAuthority) lines.push("Freeze 权限未撤销");
        if (extra && extra.ruggedCount > 0) lines.push("部署者有 Rug 记录");
        lines.push("存在一定退出风险，需密切关注项目方动态");
        item.detail = lines.join("；") + "。";
      } else {
        if (report.mintAuthority && report.freezeAuthority) lines.push("Mint 和 Freeze 权限均未撤销");
        else if (report.mintAuthority) lines.push("Mint 权限未撤销");
        lines.push("存在较高 Rug 风险");
        item.detail = "项目方仍掌控核心权限" + (lines.length ? "（" + lines.join("；") + "）" : "") + "，跑路风险较高。";
      }
    } else if (label === "代码靠谱") {
      if (s >= 7) {
        item.detail = "经 RugCheck 检测未发现高危漏洞，权限控制合理，代码实现较为规范。";
      } else if (s >= 4) {
        var riskList = (report.warnings || []).slice(0, 3).map(function(r) { return r.name; });
        item.detail = "存在 " + (report.risks?.length || 0) + " 项检测告警" +
          (riskList.length ? "（" + riskList.join("、") + "）" : "") +
          "，虽不致命但说明代码有优化空间。";
      } else {
        item.detail = "检测到多项风险项，代码质量存疑，建议谨慎对待。";
      }
    } else if (label === "玩法新鲜") {
      if (extra && extra.totalHolders > 100) {
        item.detail = "已有一定用户基础（" + extra.totalHolders + " 个持有者），市场认可度尚可，但具体机制未体现明显原创性。";
      } else if (extra && extra.totalHolders > 10) {
        item.detail = "持币人数适中（" + extra.totalHolders + " 人），属于常见代币模式，暂无突出创新点。";
      } else {
        item.detail = "持币人数较少（" + ((extra && extra.totalHolders) || "?") + " 人），属于早期阶段，玩法暂未体现差异化。";
      }
    } else if (label === "启动质量") {
      if (s >= 7) {
        item.detail = "部署者有发币经验" + (extra ? "（" + extra.tokensCreated + "个）" : "") + "，流动性充足，开局质量良好。";
      } else if (s >= 4) {
        if (extra && extra.tokensCreated >= 5) {
          item.detail = "部署者发币频繁（" + extra.tokensCreated + "个），可能存在批量发币行为，开局动力偏弱。";
        } else {
          item.detail = "流动性一般，项目方未展现足够投入力度，开局质量中等。";
        }
      } else {
        item.detail = "部署者历史记录不理想，流动性薄弱或启动数据存疑，开局质量偏低。";
      }
    }
  }

  // ─── Holder 分析 ────────────────────────────────────

  async #analyzeHolders(mint) {
    const [supplyData, accountsData] = await Promise.all([
      rpcCall("getTokenSupply", [mint]),
      rpcCall("getProgramAccounts", [
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        {
          encoding: "jsonParsed",
          filters: [
            { dataSize: 165 },
            { memcmp: { offset: 0, bytes: mint } },
          ],
        },
      ]),
    ]);
    const totalSupply = supplyData?.value?.uiAmount || 0;
    const accounts = accountsData || [];

    const withBalance = accounts
      .map(function(a) {
        return {
          address: a.pubkey,                                 // token account (ATA)
          owner: a.account?.data?.parsed?.info?.owner || "", // wallet address
          amount: (a.account?.data?.parsed?.info?.tokenAmount?.uiAmount) || 0,
        };
      })
      .filter(function(a) { return a.amount > 0; })
      .sort(function(a, b) { return b.amount - a.amount; });

    const totalHolders = withBalance.length;
    const top10 = withBalance.slice(0, 10);
    const top10Amount = top10.reduce(function(s, a) { return s + a.amount; }, 0);
    const top10Pct = totalSupply > 0 ? (top10Amount / totalSupply) * 100 : 0;

    let risk = "分散", level = "safe";
    if (top10Pct > 90)      { risk = "极度集中"; level = "critical"; }
    else if (top10Pct > 70) { risk = "高度集中"; level = "high"; }
    else if (top10Pct > 50) { risk = "偏高";     level = "medium"; }
    else if (top10Pct > 30) { risk = "中等";     level = "low"; }

    return {
      totalHolders,
      totalSupply,
      top10Pct: Math.round(top10Pct * 10) / 10,
      top10: top10.map(function(a) {
        return {
          address: a.address,
          owner: a.owner,
          pct: totalSupply > 0 ? Math.round((a.amount / totalSupply) * 1000) / 10 : 0,
        };
      }),
      risk: risk,
      level: level,
    };
  }

  // ─── RugCheck ───────────────────────────────────────

  async #rugcheck(mint) {
    const now = Date.now();
    var wait = this.minInterval - (now - this.lastCall);
    if (wait > 0) await new Promise(function(r) { setTimeout(r, wait); });
    this.lastCall = Date.now();

    try {
      var res = await fetch(this.apiBase + "/tokens/" + mint + "/report/summary", { signal: AbortSignal.timeout(30000) });
      if (res.status === 404) return this.#emptyRug();
      if (res.status === 429) return this.#emptyRug();
      if (!res.ok) return null;
      var data = await res.json();
      return this.#parseRug(data);
    } catch (err) {
      console.warn("  RugCheck 失败: " + err.message);
      return null;
    }
  }

  #parseRug(data) {
    const risks = (data.risks || []).map(function(r) {
      return { name: r.name || "", level: r.level || "info" };
    });
    const rawScore = data.score || 0;
    const safeScore = this.normalizeScore(rawScore);

    return {
      rawScore: rawScore,
      safeScore: safeScore,
      result: data.result || "Unknown",
      rugged: !!data.rugged,
      risks: risks,
      dangers: risks.filter(function(r) { return r.level === "danger"; }),
      warnings: risks.filter(function(r) { return r.level === "warning"; }),
      infos: risks.filter(function(r) { return r.level === "info"; }),
      summary: "",
      mintAuthority: data.mintAuthority || null,
      freezeAuthority: data.freezeAuthority || null,
      liquidity: data.totalMarketLiquidity || 0,
    };
  }

  #emptyRug() {
    return {
      rawScore: 0, safeScore: 0,
      result: "Unknown", rugged: false,
      risks: [], dangers: [], warnings: [], infos: [],
      summary: "暂无数据",
      mintAuthority: null, freezeAuthority: null, liquidity: 0,
    };
  }

  #emptyEval() {
    return {
      total: 0,
      rugRisk:  { score: 0, label: "跑路风险", emoji: "⬜", detail: "暂无数据" },
      codeQuality: { score: 0, label: "代码靠谱", emoji: "⬜", detail: "暂无数据" },
      innovation:  { score: 0, label: "玩法新鲜", emoji: "⬜", detail: "暂无数据" },
      launchQ:     { score: 0, label: "启动质量", emoji: "⬜", detail: "暂无数据" },
      summary: "暂无数据",
      highlights: [],
      warnings: ["暂无数据"],
      action: "等待数据",
    };
  }

  normalizeScore(raw) {
    if (raw == null) return 0;
    return Math.max(0, Math.min(100, Math.round(100 - raw / 300)));
  }
}

module.exports = { Analyzer };
