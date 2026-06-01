/**
 * Compliance Agent — 风控合规层
 *
 * 专注于安全检测和风险过滤，与 Analyzer 互补：
 * - Analyzer：评分 + 叙事（同步/轻量）
 * - ComplianceAgent：链上验证 + 深度检测（异步/较重）
 *
 * 职责：
 * 1. 包发送检测（Bundled Supply Detection）
 *    检测前 5 大持仓钱包是否来自同一资金来源 → 包发送
 * 2. 链上模拟卖出（On-chain Sell Simulation）
 *    通过 Jupiter + @solana/web3.js 模拟卖出交易，检测貔貅
 * 3. 风控汇总
 *    把检测结果汇总供金狗过滤使用
 */

const { apiFetch } = require("./fetch");
const { rpcCall } = require("./rpc");

class ComplianceAgent {
  constructor() {
    this.cache = {}; // mint -> { bundled, simulated, timestamp }
    this.cacheTTL = 300000; // 5 分钟缓存
  }

  /**
   * 包发送检测：检查前 N 大持仓钱包是否共享资金来源
   *
   * 方法：对每个持仓钱包查最近交易，看 fee payer 是否相同。
   * 如果多个持仓的 gas 费由同一钱包支付 → 包发送。
   *
   * @param {object} holders - holder 分析结果（含 top10[].owner）
   * @returns {Promise<{isBundled, confidence, detail, bundledCount, bundledSupplyPct}>}
   */
  async checkBundledSupply(holders) {
    if (!holders || !holders.top10 || holders.top10.length < 3) {
      return { isBundled: false, confidence: 0, detail: "数据不足，跳过检测" };
    }

    var top = holders.top10.slice(0, 5);
    var fundedByCreator = 0;     // 通过 creator 地址发起的交易数
    var fundingSource = {};      // wallet -> { count, totalPct }
    var checked = 0;

    // 对每个持仓钱包，获取其最近的交易，找出 fee payer
    var results = await Promise.all(top.map(async function(h) {
      if (!h.owner) return null;
      checked++;
      try {
        // 查该钱包最近的交易
        var sigs = await rpcCall("getSignaturesForAddress", [h.owner, { limit: 3 }]);
        if (!sigs || sigs.length === 0) return null;

        // 取最旧的一条（可能是首次买入/创建）
        var oldestSig = sigs[sigs.length - 1].signature;
        var tx = await rpcCall("getTransaction", [oldestSig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
        if (!tx || !tx.meta) return null;

        var accountKeys = tx.transaction?.message?.accountKeys || [];
        var feePayer = accountKeys[0]?.pubkey || "";

        return { owner: h.owner, funder: feePayer, pct: h.pct || 0 };
      } catch (e) {
        return null;
      }
    }));

    // 统计：按资金来源分组
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (!r || !r.funder) continue;
      if (!fundingSource[r.funder]) {
        fundingSource[r.funder] = { count: 0, totalPct: 0 };
      }
      fundingSource[r.funder].count++;
      fundingSource[r.funder].totalPct += r.pct;
    }

    // 查找是否有 3+ 个持仓同源
    for (var funder in fundingSource) {
      var info = fundingSource[funder];
      if (info.count >= 3) {
        return {
          isBundled: true,
          confidence: "high",
          funderAddress: funder,
          bundledCount: info.count,
          bundledSupplyPct: Math.round(info.totalPct * 10) / 10,
          detail: info.count + "个持仓钱包来源相同，占总供应 " + info.totalPct.toFixed(1) + "%，疑似包发送",
        };
      }
    }

    // 2 个同源也算"可疑"
    for (var funder in fundingSource) {
      var info = fundingSource[funder];
      if (info.count >= 2) {
        return {
          isBundled: true,
          confidence: "medium",
          funderAddress: funder,
          bundledCount: info.count,
          bundledSupplyPct: Math.round(info.totalPct * 10) / 10,
          detail: info.count + "个持仓钱包来源相同，占总供应 " + info.totalPct.toFixed(1) + "%，疑似跟投",
        };
      }
    }

    return { isBundled: false, confidence: "low", detail: "持仓来源分散，未发现包发送" };
  }

  /**
   * 链上模拟卖出检测
   * 使用 Jupiter 报价 + @solana/web3.js simulateTransaction
   *
   * @param {string} mint - 代币地址
   * @returns {Promise<{sellable, detail}>}
   */
  async simulateSell(mint) {
    if (!mint) return { sellable: false, detail: "无代币地址" };

    // 检查缓存
    var cached = this.cache[mint];
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.simulated;
    }

    try {
      // 1) Jupiter 报价（15 秒超时）
      var quoteRes = await apiFetch(
        "https://quote-api.jup.ag/v6/quote?inputMint=" + mint +
        "&outputMint=So11111111111111111111111111111111111111112" +
        "&amount=100000&slippageBps=100",
        { signal: AbortSignal.timeout(30000) }
      );
      if (!quoteRes.ok) {
        // HTTP 错误 = 网络问题，不是貔貅
        var result = { sellable: true, networkError: true, detail: "Jupiter 暂时不可用（HTTP " + quoteRes.status + "），跳过模拟" };
        this.cache[mint] = { simulated: result, timestamp: Date.now() };
        return result;
      }
      var quote = await quoteRes.json();
      if (quote.error) {
        // Jupiter 有响应但无路线 = 可能是真的貔貅
        var result = { sellable: false, detail: "Jupiter 无有效交易路线，可能是貔貅" };
        this.cache[mint] = { simulated: result, timestamp: Date.now() };
        return result;
      }

      // 2) 获取 swap 交易体
      var swapRes = await apiFetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: "11111111111111111111111111111111",
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!swapRes.ok) {
        return { sellable: false, detail: "Jupiter swap 接口异常" };
      }
      var swapData = await swapRes.json();

      // 3) 链上模拟
      var solanaWeb3 = require("@solana/web3.js");
      var connection = new solanaWeb3.Connection("https://api.mainnet-beta.solana.com", "confirmed");
      var txBytes = Buffer.from(swapData.swapTransaction, "base64");
      var tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
      var simResult = await connection.simulateTransaction(tx, { replaceRecentBlockhash: true });

      if (simResult.value.err) {
        var errStr = typeof simResult.value.err === "string"
          ? simResult.value.err
          : JSON.stringify(simResult.value.err);
        var result = { sellable: false, detail: "链上模拟卖出失败: " + errStr.slice(0, 100) };
        this.cache[mint] = { simulated: result, timestamp: Date.now() };
        return result;
      }

      var result = { sellable: true, detail: "链上模拟卖出成功，可正常交易" };
      this.cache[mint] = { simulated: result, timestamp: Date.now() };
      return result;
    } catch (e) {
      // 网络错误不判定为貔貅（避免误杀），返回"跳过"状态
      return { sellable: true, simulationSkipped: true, detail: "模拟卖出跳过（网络异常）" };
    }
  }

  /**
   * 运行所有风控检测（并行执行）
   * @param {string} mint - 代币地址
   * @param {object} holders - holder 分析结果
   * @returns {Promise<object>} 汇总的风控结果
   */
  async runAll(mint, holders) {
    var [bundled, sellTest] = await Promise.all([
      this.checkBundledSupply(holders),
      this.simulateSell(mint),
    ]);

    return {
      bundledSupply: bundled,
      sellTest: sellTest,
      // 综合风险：包发送 + 不能卖 = 高风险
      isRisky: bundled.isBundled || !sellTest.sellable,
    };
  }
}

module.exports = { ComplianceAgent };
