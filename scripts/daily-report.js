#!/usr/bin/env node
/**
 * Solana Monitor v3 — 每日钉钉日报
 * 每晚 23:00 由 Windows 任务计划程序自动执行
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "..", "data", "scan.db");
const DINGTALK_URL = "https://oapi.dingtalk.com/robot/send?access_token=" + (process.env.DINGTALK_TOKEN || "");

async function main() {
  var token = process.env.DINGTALK_TOKEN;
  if (!token) { console.log("⚠️  DINGTALK_TOKEN 未配置"); return; }

  var db = new Database(DB_PATH);

  var total = db.prepare("SELECT COUNT(*) as c FROM snapshots").get().c;
  var todayCount = db.prepare("SELECT COUNT(*) as c FROM snapshots WHERE date(detected_at) = date('now')").get().c;
  var passed = db.prepare("SELECT COUNT(*) as c FROM snapshots WHERE passed_filter = 1").get().c;
  var avgScore = db.prepare("SELECT ROUND(AVG(score), 1) as a FROM snapshots").get().a || 0;

  var dist = db.prepare(`
    SELECT
      SUM(CASE WHEN score >= 30 THEN 1 ELSE 0 END) as high,
      SUM(CASE WHEN score BETWEEN 26 AND 29 THEN 1 ELSE 0 END) as mid,
      SUM(CASE WHEN score < 26 THEN 1 ELSE 0 END) as low
    FROM snapshots
  `).get();

  var recent = db.prepare(`
    SELECT symbol, name, score, action, passed_filter FROM snapshots
    WHERE date(detected_at) = date('now')
    ORDER BY score DESC LIMIT 5
  `).all();

  var actionDist = db.prepare(`
    SELECT action, COUNT(*) as c FROM snapshots
    WHERE date(detected_at) = date('now')
    GROUP BY action ORDER BY c DESC
  `).all();

  // ─── 构建钉钉消息 ──────────────────────────────
  var msg = "### 📊 Solana Monitor v3 — 每日新币日报\n\n";
  msg += "> 新币检测统计 · " + new Date().toLocaleString("zh-CN", { hour12: false }) + "\n\n";
  msg += "---\n\n";

  msg += "**📈 今日检测概览**\n\n";
  msg += "- 今日新币: **" + todayCount + "** 个\n";
  msg += "- 累计检测: **" + total + "** 个\n";
  msg += "- 金狗通过: **" + passed + "** 个 (" + (total > 0 ? (passed / total * 100).toFixed(1) : "0") + "%)\n";
  msg += "- 平均评分: **" + avgScore + "** /40\n\n";

  msg += "**📊 评分分布**\n\n";
  msg += "- ≥30分 (优质): " + (dist.high || 0) + " 个\n";
  msg += "- 26-29分 (观望): " + (dist.mid || 0) + " 个\n";
  msg += "- <26分 (过滤): " + (dist.low || 0) + " 个\n\n";

  if (actionDist.length > 0) {
    msg += "**🎯 操作分布**\n\n";
    for (var i = 0; i < actionDist.length; i++) {
      msg += "- " + actionDist[i].action + ": " + actionDist[i].c + "\n";
    }
    msg += "\n";
  }

  if (recent.length > 0) {
    msg += "**🏆 今日高分 TOP 5**\n\n";
    for (var i = 0; i < recent.length; i++) {
      var r = recent[i];
      var label = r.symbol || r.name || "?";
      var tag = r.passed_filter ? "🐕" : "⏭";
      msg += (i + 1) + ". **" + label + "**  " + r.score + "/40 " + tag + " " + (r.action || "") + "\n";
    }
    msg += "\n";
  }

  msg += "**⚙️ 系统状态**\n\n";
  msg += "- 数据源: PumpPortal WebSocket + Helius RPC\n";
  msg += "- 风控: 包发送检测 + 链上模拟卖出 + Rug Alert\n";
  msg += "- 价格追踪: 已开启（1h/6h/24h 回查）\n\n";

  msg += "---\n";
  msg += "*`node report.js` 查看完整看板 | 每晚 23:00 自动推送*";

  // ─── 推送 ──────────────────────────────────────
  try {
    var res = await fetch(DINGTALK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { title: "Solana Monitor 新币日报", text: msg },
      }),
    });
    var body = await res.json();
    if (body.errcode === 0) {
      console.log("✅ 日报推送成功");
    } else {
      console.log("❌ 推送失败:", body.errmsg);
    }
  } catch (e) {
    console.log("❌ 推送异常:", e.message);
  }

  db.close();
}

main();
