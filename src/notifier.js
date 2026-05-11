/**
 * 钉钉机器人推送
 * API: POST https://oapi.dingtalk.com/robot/send?access_token=xxx
 * 自定义关键词: "新币"
 */
class Notifier {
  constructor(token) {
    this.token = token || "";
    this.url = "https://oapi.dingtalk.com/robot/send?access_token=" + token;
  }

  async push(token, report) {
    if (!this.token) {
      console.log("  跳过推送：未配置 DINGTALK_TOKEN");
      return;
    }

    const content = this._buildMsg(token, report);

    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: {
          title: "新币提醒",
          text: content,
        },
      }),
    });

    const body = await res.json();
    if (body.errcode !== 0) {
      throw new Error("钉钉 " + body.errcode + ": " + body.errmsg);
    }
  }

  _buildMsg(token, report) {
    var name = token.name || "Unknown";
    var sym = token.symbol || "?";
    var mint = token.mint || "";
    var short = mint.slice(0, 6) + "..." + mint.slice(-4);
    var s = (report && report.safeScore) || 0;
    var holders = report && report.holders;

    var emoji = s >= 80 ? "🟢" : s >= 60 ? "🟡" : s >= 40 ? "🟠" : "🔴";

    // 钉钉 markdown 需要第一行包含关键词 "新币"
    var msg = "### 🟡 新币提醒 · 安全分 " + emoji + " " + s + "/100\n\n";
    msg += "> " + ((report && report.summary) || "暂无数据") + "\n\n";
    msg += "**📛 " + name + " (" + sym + ")**\n";
    msg += "- 地址: `" + short + "`\n";
    msg += "- [Solscan](https://solscan.io/token/" + mint + ")\n";
    if (token.creator) {
      msg += "- 部署者: `" + token.creator.slice(0, 6) + "..." + token.creator.slice(-4) + "`\n";
    }
    msg += "\n";

    // 安全检查
    msg += "**🛡️ 权限检查**\n";
    msg += "- Mint: " + (report && report.mintAuthority ? "❌ 未撤销" : "✅ 已撤销") + "\n";
    msg += "- Freeze: " + (report && report.freezeAuthority ? "❌ 未撤销" : "✅ 已撤销") + "\n";
    if (report && report.liquidity) {
      msg += "- 流动性: $" + Math.round(report.liquidity).toLocaleString() + "\n";
    }
    msg += "\n";

    // 风险项
    var all = [];
    if (report && report.dangers) {
      report.dangers.forEach(function(r) { all.push("❌ " + r.name); });
    }
    if (report && report.warnings) {
      report.warnings.forEach(function(r) { all.push("⚠️ " + r.name); });
    }
    if (report && report.infos) {
      report.infos.forEach(function(r) { all.push("ℹ️ " + r.name); });
    }
    var riskCount = (report && report.risks && report.risks.length) || 0;
    msg += "**🔍 检测项（" + riskCount + "）**\n";
    if (all.length > 0) {
      msg += all.slice(0, 5).join("\n") + "\n";
      if (all.length > 5) {
        msg += "...还有 " + (all.length - 5) + " 项\n";
      }
    } else {
      msg += "未发现明显风险\n";
    }
    msg += "\n";

    // Holder 分布
    if (holders && holders.totalHolders > 0) {
      var hEmoji = "🟢";
      if (holders.level === "critical") hEmoji = "🔴";
      else if (holders.level === "high") hEmoji = "🟠";
      else if (holders.level === "medium") hEmoji = "🟡";
      msg += "**👥 Holder 分布 " + hEmoji + "**\n";
      msg += "- 总 Holder: " + holders.totalHolders.toLocaleString() + "\n";
      msg += "- Top 10 占比: " + holders.top10Pct + "%\n";
      msg += "- 集中度: **" + holders.risk + "**\n";
      if (holders.top10 && holders.top10.length > 0) {
        var top3 = holders.top10.slice(0, 3);
        msg += "- Top 3: " + top3.map(function(h) { return h.pct + "%"; }).join(" / ") + "\n";
      }
      msg += "\n";
    }

    // 部署者信息
    if (token.devInfo) {
      var dev = token.devInfo;
      var dEmoji = "🟢";
      if (dev.risk.indexOf("危险") >= 0) dEmoji = "🔴";
      else if (dev.risk.indexOf("rug") >= 0) dEmoji = "🟠";
      else if (dev.risk.indexOf("频繁") >= 0) dEmoji = "🟡";
      msg += "**👤 部署者评估 " + dEmoji + "**\n";
      msg += "- 已发代币: " + dev.tokensCreated + " 个\n";
      if (dev.ruggedCount > 0) {
        msg += "- 历史标记: ⚠️ " + dev.ruggedCount + " 个有风险\n";
      }
      msg += "- 评价: **" + dev.risk + "**\n";
      msg += "\n";
    }

    // 评分条
    var bar = "";
    for (var i = 0; i < Math.round(s / 10); i++) bar += "█";
    for (var i = 0; i < 10 - Math.round(s / 10); i++) bar += "░";
    msg += "**📊 综合评分**\n";
    msg += "`" + bar + "` " + s + "/100\n";
    if (report && report.result) {
      msg += "RugCheck: **" + report.result + "**\n";
    }
    if (report && report.rawScore) {
      msg += "原始风险分: " + report.rawScore + "\n";
    }

    // 分项评分
    var parts = [];
    if (s > 0) parts.push("安全 " + s + "/100");
    if (holders && holders.top10Pct > 0) {
      var hScore = Math.max(0, Math.round(100 - holders.top10Pct));
      parts.push("Holder " + hScore + "/100");
    }
    if (parts.length > 0) msg += parts.join(" · ") + "\n";
    msg += "\n";

    // 社交
    var links = [];
    if (token.socials && token.socials.twitter) links.push("[Twitter](" + token.socials.twitter + ")");
    if (token.socials && token.socials.telegram) links.push("[Telegram](" + token.socials.telegram + ")");
    if (token.socials && token.socials.website) links.push("[Website](" + token.socials.website + ")");
    if (links.length > 0) msg += "**🔗 链接**\n" + links.join(" · ") + "\n\n";

    msg += "---\n*仅供参考，非投资建议*";
    return msg;
  }
}

module.exports = { Notifier };
