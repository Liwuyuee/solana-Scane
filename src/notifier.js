/**
 * 钉钉机器人推送 — 截图风格
 * 四项评分 + 详细分析段落
 * 关键词: "新币"
 */
class Notifier {
  constructor(token) {
    this.token = token || "";
    this.url = "https://oapi.dingtalk.com/robot/send?access_token=" + token;
  }

  /**
   * @param {object} token   代币信息 { mint, name, symbol, creator, socials }
   * @param {object} report  analyzer.getReport 返回值（raw）
   * @param {object} evalRes analyzer.evaluate 返回值（四项评分 + 叙事）
   */
  async push(token, report, evalRes) {
    if (!this.token) {
      console.log("  跳过：未配置 DINGTALK_TOKEN");
      return;
    }

    var content = this._buildMsg(token, report, evalRes);

    var res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { title: "新币提醒", text: content },
      }),
    });

    var body = await res.json();
    if (body.errcode !== 0) {
      throw new Error("钉钉 " + body.errcode + ": " + body.errmsg);
    }
  }

  _buildMsg(token, report, ev) {
    var name = token.name || "Unknown";
    var sym = token.symbol || "?";
    var mint = token.mint || "";
    var short = mint.slice(0, 6) + "..." + mint.slice(-4);
    var creator = token.creator || "";
    var shortCreator = creator ? creator.slice(0, 6) + "..." + creator.slice(-4) : "?";
    var holders = report && report.holders;

    // 四项评分
    var total = (ev && ev.total) || 0;
    var action = (ev && ev.action) || "等待数据";
    var summary = (ev && ev.summary) || "暂无数据";
    var highlights = (ev && ev.highlights) || [];
    var warnings = (ev && ev.warnings) || [];
    var rug = (ev && ev.rugRisk) || {};
    var code = (ev && ev.codeQuality) || {};
    var innov = (ev && ev.innovation) || {};
    var launch = (ev && ev.launchQ) || {};

    // 总分颜色
    var totalEmoji = total >= 32 ? "🟢" : total >= 24 ? "🟡" : total >= 16 ? "🟠" : "🔴";

    var msg = "";
    msg += "### " + totalEmoji + " 新币 · " + action + " · " + total + "/40\n\n";
    msg += "💬 " + summary + "\n\n";

    // ─── 项目信息 ──────────────────────────────────
    msg += "**📛 项目名: " + name + " ✓ 已验证**";
    // Smart money badge
    if (token.smartCount && token.smartCount > 0) {
      msg += " 🧠 聪明钱 x" + token.smartCount;
    }
    msg += "\n";
    msg += "  · [Solscan](https://solscan.io/token/" + mint + ") · [创建记录](https://solscan.io/tx/" + (token.createTx || "") + ")\n\n";

    // ─── 配对代币 ──────────────────────────────────
    msg += "**🪙 配对代币**\n";
    msg += "• SOL (native)\n";
    msg += "• " + sym + " (" + name + ")\n";
    msg += "  `" + short + "` · [token](https://solscan.io/token/" + mint + ") · [chart](https://dexscreener.com/solana/" + mint + ")\n\n";

    // ─── 创建者分析 ────────────────────────────────
    var hasAuth = report && (report.mintAuthority || report.freezeAuthority);
    msg += "**🧭 是谁建的池子**\n";
    if (!hasAuth && creator) {
      msg += "• ✅ 没找到管理员权限（合约可能已锁死）\n";
      msg += "• 部署者: `" + shortCreator + "`\n";
    } else if (hasAuth) {
      msg += "• ⚠️ 存在管理员权限\n";
      if (report.mintAuthority) msg += "• Mint: `" + report.mintAuthority.slice(0, 6) + "..." + report.mintAuthority.slice(-4) + "`\n";
      if (report.freezeAuthority) msg += "• Freeze: `" + report.freezeAuthority.slice(0, 6) + "..." + report.freezeAuthority.slice(-4) + "`\n";
      if (creator) msg += "• 部署者: `" + shortCreator + "`\n";
    } else {
      msg += "• 部署者: `" + shortCreator + "`\n";
    }
    msg += "\n";

    // ─── 项目链接 ──────────────────────────────────
    var links = [];
    if (token.socials && token.socials.website) links.push("🌐 " + token.socials.website);
    if (token.socials && token.socials.twitter) links.push("🐦 " + token.socials.twitter);
    if (token.socials && token.socials.telegram) links.push("💬 " + token.socials.telegram);
    links.push("🔍 [Solscan](https://solscan.io/token/" + mint + ")");
    if (links.length > 1) {
      msg += "**🔗 项目链接**\n";
      for (var i = 0; i < links.length; i++) {
        msg += links[i] + "\n";
      }
      msg += "\n";
    }

    // ─── 四项评分 ──────────────────────────────────
    msg += "**📊 四项评分（满分 10 分）**\n";
    msg += rug.emoji + " **" + rug.label + " " + rug.score + "/10**";
    if (rug.detail) msg += " — " + rug.detail;
    msg += "\n";
    msg += code.emoji + " **" + code.label + " " + code.score + "/10**";
    if (code.detail) msg += " — " + code.detail;
    msg += "\n";
    msg += innov.emoji + " **" + innov.label + " " + innov.score + "/10**";
    if (innov.detail) msg += " — " + innov.detail;
    msg += "\n";
    msg += launch.emoji + " **" + launch.label + " " + launch.score + "/10**";
    if (launch.detail) msg += " — " + launch.detail;
    msg += "\n";

    // ─── 涨幅潜力 ─────────────────────────────────
    var growth = ev && ev.growth;
    if (growth && growth.score > 0) {
      msg += growth.emoji + " **" + growth.label + " " + growth.score + "/10**";
      if (growth.detail) msg += " — " + growth.detail;
      msg += "\n";

      // 信号明细
      if (growth.signals && growth.signals.length > 0) {
        for (var g = 0; g < growth.signals.length; g++) {
          msg += "  · " + growth.signals[g] + "\n";
        }
      }
    }
    msg += "\n";

    // ─── Holder 信息 ──────────────────────────────
    if (holders && holders.totalHolders > 0) {
      var hEmoji = holders.level === "critical" ? "🔴" : holders.level === "high" ? "🟠" : holders.level === "medium" ? "🟡" : "🟢";
      msg += hEmoji + " 持有者分布: " + holders.totalHolders + " 人 · Top 10 占 " + holders.top10Pct + "% · " + holders.risk + "\n\n";
    }

    // ─── Honeypot 检测 ────────────────────────────
    var hp = ev && ev.honeypot;
    if (hp && hp.risk !== "unknown") {
      var hpEmoji = hp.risk === "low" ? "✅" : hp.risk === "medium" ? "⚠️" : "🚫";
      msg += hpEmoji + " Honeypot 检测: **" + (hp.risk === "low" ? "安全，可正常买卖" : hp.risk === "medium" ? "存在可疑特征" : "高风险，可能无法卖出") + "**\n";
      if (hp.reasons && hp.reasons.length > 0) {
        msg += "  " + hp.reasons.join("\n  ") + "\n";
      }
      msg += "\n";
    }

    // ─── 亮点 ─────────────────────────────────────
    if (highlights.length > 0) {
      msg += "**✨ 亮点**\n";
      for (var i = 0; i < highlights.length; i++) {
        msg += (i + 1) + "）" + highlights[i];
        if (i < highlights.length - 1) msg += "；";
      }
      msg += "\n\n";
    }

    // ─── 风险 ─────────────────────────────────────
    if (warnings.length > 0) {
      msg += "**⚠️ 需要注意**\n";
      for (var i = 0; i < warnings.length; i++) {
        msg += (i + 1) + "）" + warnings[i];
        if (i < warnings.length - 1) msg += "；";
      }
      msg += "\n\n";
    }

    // ─── 交易建议 ─────────────────────────────────
    var total = (ev && ev.total) || 0;
    if (total >= 30) {
      msg += "**💡 交易参考**\n";
      msg += "- 建议仓位: 轻仓（总资金 1-3%）\n";
      msg += "- 买入方式: 分 2-3 笔，等价格稳定再补\n";
      if (report && report.mintAuthority) {
        msg += "- 止损: -20% 无条件止损\n";
      } else {
        msg += "- 止损: -30% 止损，或流动性撤池立即卖\n";
      }
      msg += "- 止盈: +50% 出本金，+100% 出利润\n";
      msg += "- 卖出条件: 监控到部署者卖出立即清仓\n";
      msg += "\n";
    }

    // 市场信息
    if (token.dexInfo) {
      var di = token.dexInfo;
      msg += "**📈 市场数据**\n";
      if (di.dexName) msg += "- DEX: " + di.dexName + "\n";
      if (di.liquidityUsd) msg += "- 流动性: $" + Math.round(di.liquidityUsd).toLocaleString() + "\n";
      if (di.fdv) msg += "- FDV: $" + Math.round(di.fdv).toLocaleString() + "\n";
      if (di.priceUsd) msg += "- 价格: $" + Number(di.priceUsd).toFixed(8) + "\n";
      if (di.url) msg += "- [Chart](" + di.url + ")\n";
      msg += "\n";
    }

    msg += "---\n*本评分仅供参考，非投资建议。土狗有归零风险，请自行判断。*";
    return msg;
  }
}

module.exports = { Notifier };
