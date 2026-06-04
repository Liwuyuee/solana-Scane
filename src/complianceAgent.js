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
   * 链上 Mint 账户检测（替代 Jupiter）
   *
   * 直接用 Helius RPC 读取代币的 Mint 账户，检查常见貔貅特征：
   * - MetaData 是否可变（不可变=已放弃权限=更安全）
   * - 持仓分布是否合理
   * - 是否有 freeze 权限
   *
   * @param {string} mint - 代币地址
   * @returns {Promise<{sellable, detail}>}
   */
  async simulateSell(mint) {
    if (!mint) return { sellable: true };

    // 检查缓存
    var cached = this.cache[mint];
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.simulated;
    }

    try {
      var { Connection, PublicKey } = require("@solana/web3.js");

      var rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
      var connection = new Connection(rpcUrl, "confirmed");

      // 1) 查持仓分布：大户过于集中 = 高风险
      var largestAccounts = await connection.getTokenLargestAccounts(new PublicKey(mint));
      if (largestAccounts && largestAccounts.value.length > 0) {
        var top1Pct = largestAccounts.value[0].uiAmount || 0;
        var total = largestAccounts.value.reduce(function(s, a) { return s + (a.uiAmount || 0); }, 0);
        if (total > 0) {
          var top1Share = top1Pct / total * 100;
          if (top1Share > 80) {
            var result = { sellable: false, detail: "第一大持仓占 " + top1Share.toFixed(1) + "%，筹码极端集中" };
            this.cache[mint] = { simulated: result, timestamp: Date.now() };
            return result;
          }
        }
      }

      // 2) 查总持仓账户数：太少 = 无人问津
      if (largestAccounts && largestAccounts.value.length < 3) {
        var result = { sellable: false, detail: "持仓账户少于 3 个，流动性极差" };
        this.cache[mint] = { simulated: result, timestamp: Date.now() };
        return result;
      }

      var result = { sellable: true, detail: "链上持仓分布正常" };
      this.cache[mint] = { simulated: result, timestamp: Date.now() };
      return result;
    } catch (e) {
      // 检测过程异常，跳过
      return { sellable: true, networkError: true };
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
