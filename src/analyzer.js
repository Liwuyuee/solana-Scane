/**
 * Token 风险分析
 *
 * 数据源：
 * - rugcheck.xyz: 安全评分 + 风险项
 * - Solana RPC:    Holder 分布分析（新增）
 */
const RPC_URL = "https://api.mainnet-beta.solana.com";

class Analyzer {
  constructor() {
    this.apiBase = "https://api.rugcheck.xyz/v1";
    this.lastCall = 0;
    this.minInterval = 1200;
  }

  /**
   * 综合分析：rugcheck + holder
   */
  async getReport(mint) {
    if (!mint) return null;

    // 并行发起 rugcheck 和 holder 分析
    const [rug, holder] = await Promise.all([
      this.#rugcheck(mint),
      this.#analyzeHolders(mint).catch(() => null),
    ]);

    return {
      ...(rug || this.#emptyRug()),
      holders: holder || { total: 0, top10Pct: 0, risk: "unknown" },
    };
  }

  /** rugcheck.xyz 安全评分 */
  async #rugcheck(mint) {
    // 限速
    const now = Date.now();
    const wait = this.minInterval - (now - this.lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCall = Date.now();

    try {
      const res = await fetch(`${this.apiBase}/tokens/${mint}/report/summary`);
      if (res.status === 404) return this.#emptyRug();
      if (res.status === 429) return this.#emptyRug();
      if (!res.ok) return null;

      const data = await res.json();
      return this.#parseRug(data);
    } catch (err) {
      console.warn(`  RugCheck 失败: ${err.message}`);
      return null;
    }
  }

  /**
   * Holder 分布分析
   * 查链上 Token 账户，算 Top 10 集中度
   */
  async #analyzeHolders(mint) {
    // 1) 总供应量
    const supplyRes = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getTokenSupply",
        params: [mint],
      }),
    });
    const supplyData = await supplyRes.json();
    const totalSupply = supplyData.result?.value?.uiAmount || 0;
    const decimals = supplyData.result?.value?.decimals || 0;

    // 2) 查 Token 账户（带分页，最多取 20 个）
    const accountsRes = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getProgramAccounts",
        params: [
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          {
            encoding: "jsonParsed",
            filters: [
              { dataSize: 165 },
              { memcmp: { offset: 0, bytes: mint } },
            ],
          },
        ],
      }),
    });
    const accountsData = await accountsRes.json();
    const accounts = accountsData.result || [];

    // 过滤出有余额的账户，排序
    const withBalance = accounts
      .map((a) => ({
        address: a.pubkey,
        amount: a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0,
      }))
      .filter((a) => a.amount > 0)
      .sort((a, b) => b.amount - a.amount);

    const totalHolders = withBalance.length;
    const top10 = withBalance.slice(0, 10);
    const top10Amount = top10.reduce((sum, a) => sum + a.amount, 0);
    const top10Pct = totalSupply > 0 ? (top10Amount / totalSupply) * 100 : 0;

    // 集中度评估
    let risk = "safe";
    let level = "low";
    if (top10Pct > 90) { risk = "极度集中"; level = "critical"; }
    else if (top10Pct > 70) { risk = "高度集中"; level = "high"; }
    else if (top10Pct > 50) { risk = "偏高"; level = "medium"; }
    else if (top10Pct > 30) { risk = "中等"; level = "low"; }
    else { risk = "分散"; level = "safe"; }

    return {
      totalHolders,
      totalSupply,
      top10Pct: Math.round(top10Pct * 10) / 10,
      top10: top10.map((a) => ({
        address: a.address,
        pct: totalSupply > 0 ? Math.round((a.amount / totalSupply) * 1000) / 10 : 0,
      })),
      risk,
      level,
    };
  }

  // ─── 解析工具 ───────────────────────────────────────

  #parseRug(data) {
    const risks = (data.risks || []).map((r) => ({
      name: r.name || "",
      level: r.level || "info",
    }));
    const rawScore = data.score || 0;
    const safeScore = this.normalizeScore(rawScore);

    return {
      rawScore,
      safeScore,
      result: data.result || "Unknown",
      rugged: !!data.rugged,
      risks,
      dangers: risks.filter((r) => r.level === "danger"),
      warnings: risks.filter((r) => r.level === "warning"),
      infos: risks.filter((r) => r.level === "info"),
      summary:
        safeScore >= 80 ? "相对安全" :
        safeScore >= 60 ? "存在一定风险" :
        safeScore >= 40 ? "风险偏高，建议观望" :
        safeScore >= 20 ? "高风险" : "极度危险",
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

  normalizeScore(raw) {
    if (raw == null) return 0;
    return Math.max(0, Math.min(100, Math.round(100 - raw / 300)));
  }
}

module.exports = { Analyzer };
