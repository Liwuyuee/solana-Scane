/**
 * DingTalk push message formatter
 */
class Notifier {
  constructor(token) {
    this.token = token || "";
    this.url = "https://oapi.dingtalk.com/robot/send?access_token=" + token;
  }

  async push(token, report, evalRes) {
    if (!this.token) {
      console.log("  Skip: DINGTALK_TOKEN not set");
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
      throw new Error("DingTalk error " + body.errcode + ": " + body.errmsg);
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
    var total = (ev && ev.total) || 0;
    var action = (ev && ev.action) || "Waiting";
    var summary = (ev && ev.summary) || "";
    var highlights = (ev && ev.highlights) || [];
    var warnings = (ev && ev.warnings) || [];
    var rug = (ev && ev.rugRisk) || {};
    var code = (ev && ev.codeQuality) || {};
    var innov = (ev && ev.innovation) || {};
    var launch = (ev && ev.launchQ) || {};

    var totalEmoji = total >= 32 ? "🟢" : total >= 24 ? "🟡" : total >= 16 ? "🟠" : "🔴";

    var msg = "";
    // ─── Header ─────────────────────────────────────
    msg += "### " + totalEmoji + " 新币 · " + action + " · " + total + "/40\n\n";
    msg += "> " + summary + "\n\n";

    // ─── Token Info ────────────────────────────────
    msg += "**📛 " + name + " (" + sym + ")**";
    if (token.smartCount && token.smartCount > 0) {
      msg += "  🧠 x" + token.smartCount;
    }
    msg += "\n\n";
    msg += "> `" + mint + "`\n\n";
    msg += "🪙 SOL / " + sym + "\n\n";
    msg += "[Solscan](https://solscan.io/token/" + mint + ") · [Chart](https://dexscreener.com/solana/" + mint + ")";
    if (token.createTx) {
      msg += " · [Tx](https://solscan.io/tx/" + token.createTx + ")";
    }
    msg += "\n\n";

    // ─── Scores ────────────────────────────────────
    msg += "**📊 Scores (out of 10)**\n\n";
    msg += rug.emoji + " **" + rug.label + ":** " + rug.score + "/10";
    if (rug.detail) msg += "\n> " + rug.detail;
    msg += "\n\n";
    msg += code.emoji + " **" + code.label + ":** " + code.score + "/10";
    if (code.detail) msg += "\n> " + code.detail;
    msg += "\n\n";
    msg += innov.emoji + " **" + innov.label + ":** " + innov.score + "/10";
    if (innov.detail) msg += "\n> " + innov.detail;
    msg += "\n\n";
    msg += launch.emoji + " **" + launch.label + ":** " + launch.score + "/10";
    if (launch.detail) msg += "\n> " + launch.detail;
    msg += "\n\n";

    // ─── Security ──────────────────────────────────
    msg += "**🛡️ Security**\n\n";
    msg += "- Mint: " + (report && report.mintAuthority ? "❌ Not revoked" : "✅ Revoked") + "\n";
    msg += "- Freeze: " + (report && report.freezeAuthority ? "❌ Not revoked" : "✅ Revoked") + "\n";
    var hp = ev && ev.honeypot;
    if (hp && hp.risk !== "unknown") {
      msg += "- Honeypot: " + (hp.risk === "low" ? "✅ Safe" : hp.risk === "medium" ? "⚠️ Suspicious" : "🚫 High risk") + "\n";
    }
    if (holders && holders.totalHolders > 0) {
      msg += "- Holders: " + holders.totalHolders + " | Top10: " + holders.top10Pct + "% (" + holders.risk + ")\n";
    }
    msg += "\n";

    // ─── Creator ────────────────────────────────────
    msg += "**🧭 Creator**\n";
    msg += "- Wallet: `" + shortCreator + "`\n";
    var hasAuth = report && (report.mintAuthority || report.freezeAuthority);
    if (!hasAuth && creator) {
      msg += "- ✅ No admin keys found (contract may be locked)\n";
    } else if (hasAuth) {
      msg += "- ⚠️ Admin keys exist\n";
    }
    msg += "\n";

    // ─── Links ────────────────────────────────────
    var links = [];
    if (token.socials && token.socials.website) links.push("[Website](" + token.socials.website + ")");
    if (token.socials && token.socials.twitter) links.push("[Twitter](" + token.socials.twitter + ")");
    if (token.socials && token.socials.telegram) links.push("[Telegram](" + token.socials.telegram + ")");
    if (links.length > 0) {
      msg += "**🔗 Links**\n" + links.join(" | ") + "\n\n";
    }

    // ─── Highlights ────────────────────────────────
    if (highlights.length > 0) {
      msg += "**✨ Highlights**\n";
      for (var i = 0; i < highlights.length; i++) {
        msg += (i + 1) + ". " + highlights[i] + "\n";
      }
      msg += "\n";
    }

    // ─── Warnings ──────────────────────────────────
    if (warnings.length > 0) {
      msg += "**⚠️ Warnings**\n";
      for (var i = 0; i < warnings.length; i++) {
        msg += (i + 1) + ". " + warnings[i] + "\n";
      }
      msg += "\n";
    }

    // ─── Market Data ──────────────────────────────
    if (token.dexInfo) {
      var di = token.dexInfo;
      msg += "**📈 市场数据**\n\n";
      msg += "• DEX: " + (di.dexName || "?") + "\n";
      if (di.priceUsd) msg += "• 价格: $" + Number(di.priceUsd).toFixed(8) + "\n";
      if (di.fdv) msg += "• 市值: $" + Math.round(di.fdv).toLocaleString() + "\n";
      if (di.liquidityUsd) msg += "• 流动性: $" + Math.round(di.liquidityUsd).toLocaleString() + "\n";
      if (di.volume24h) msg += "• 24h量: $" + Math.round(di.volume24h).toLocaleString() + "\n";
      if (di.priceChange24h) msg += "• 24h涨跌: " + (di.priceChange24h > 0 ? "+" : "") + di.priceChange24h.toFixed(1) + "%\n";
      msg += "\n";
    }

    // ─── Star Rating ──────────────────────────────
    var growth = ev && ev.growth;
    if (growth && growth.stars > 0) {
      var stars = "";
      for (var x = 0; x < 5; x++) {
        stars += (x < growth.stars) ? "★" : "☆";
      }
      msg += "**🚀 涨幅潜力** " + stars + " " + growth.stars + "/5\n\n";
      if (growth.signals && growth.signals.length > 0) {
        for (var s = 0; s < growth.signals.length; s++) {
          msg += "• " + growth.signals[s] + "\n";
        }
      }
      msg += "\n";
    }

    // ─── Trading Guide (only for high score) ──────
    if (total >= 30) {
      msg += "**💡 交易参考**\n\n";
      msg += "• 仓位: 轻仓（1-3%）\n";
      msg += "• 入场: 分 2-3 笔\n";
      msg += "• 止损: -30%\n";
      msg += "• 止盈: +50% 出本，+100% 清仓\n";
      msg += "\n";
    }

    msg += "---\n*Not financial advice. DYOR.*";
    return msg;
  }
}

module.exports = { Notifier };
