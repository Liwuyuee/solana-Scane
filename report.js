#!/usr/bin/env node
/**
 * Solana Monitor v3 — 统计看板
 *
 * 读取 SQLite 数据，生成检测统计和评分分析。
 *
 * 用法: node report.js
 * 钉钉日报: 每晚 23:00 自动推送
 */

const { Store } = require("./src/store");

function main() {
  var store = new Store();

  // ─── 基础统计 ─────────────────────────────────────
  var total = store.db.prepare("SELECT COUNT(*) as c FROM snapshots").get().c;
  var todayCount = store.db.prepare("SELECT COUNT(*) as c FROM snapshots WHERE date(detected_at) = date('now')").get().c;
  var passed = store.db.prepare("SELECT COUNT(*) as c FROM snapshots WHERE passed_filter = 1").get().c;
  var avgScore = store.db.prepare("SELECT ROUND(AVG(score), 1) as a FROM snapshots").get().a || 0;
  var maxScore = store.db.prepare("SELECT MAX(score) as m FROM snapshots").get().m || 0;

  // 分数段分布
  var dist = store.db.prepare(`
    SELECT
      SUM(CASE WHEN score >= 34 THEN 1 ELSE 0 END) as 's34',
      SUM(CASE WHEN score BETWEEN 30 AND 33 THEN 1 ELSE 0 END) as 's30',
      SUM(CASE WHEN score BETWEEN 26 AND 29 THEN 1 ELSE 0 END) as 's26',
      SUM(CASE WHEN score BETWEEN 20 AND 25 THEN 1 ELSE 0 END) as 's20',
      SUM(CASE WHEN score < 20 THEN 1 ELSE 0 END) as 's0'
    FROM snapshots
  `).get();

  // 过滤原因统计（从 snapshots 表）
  var actionDist = store.db.prepare(`
    SELECT action, COUNT(*) as c FROM snapshots GROUP BY action ORDER BY c DESC
  `).all();

  // ─── 输出 ──────────────────────────────────────────
  console.log("");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║     Solana Monitor v3 — 统计看板        ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("");

  console.log("📊 检测统计");
  console.log("  ────────────────────────────────────────");
  console.log("  累计检测:  " + pad(total, 6) + " 个代币");
  console.log("  今日新增:  " + pad(todayCount, 6) + " 个");
  console.log("  金狗通过:  " + pad(passed, 6) + " 个 (" + (total > 0 ? (passed / total * 100).toFixed(1) : "0") + "%)");
  console.log("  平均评分:  " + pad(avgScore, 6) + " /40");
  console.log("  最高评分:  " + pad(maxScore, 6) + " /40");
  console.log("");

  console.log("📈 评分分布");
  console.log("  ────────────────────────────────────────");
  console.log("  34-40 (金狗): " + pad(dist.s34 || 0, 4) + " 个" + bar(dist.s34, total));
  console.log("  30-33 (优质): " + pad(dist.s30 || 0, 4) + " 个" + bar(dist.s30, total));
  console.log("  26-29 (观望): " + pad(dist.s26 || 0, 4) + " 个" + bar(dist.s26, total));
  console.log("  20-25 (警惕): " + pad(dist.s20 || 0, 4) + " 个" + bar(dist.s20, total));
  console.log("  <20  (回避): " + pad(dist.s0 || 0, 4) + " 个" + bar(dist.s0, total));
  console.log("");

  console.log("🎯 操作分布 (近24h)");
  console.log("  ────────────────────────────────────────");
  for (var i = 0; i < actionDist.length; i++) {
    var a = actionDist[i];
    console.log("  " + pad(a.action || "无评分", 12) + ": " + pad(a.c, 5) + " 个" + bar(a.c, total));
  }
  console.log("");

  // ─── 最新检测 ────────────────────────────────────
  var recent = store.db.prepare(`
    SELECT name, symbol, score, action, passed_filter FROM snapshots ORDER BY detected_at DESC LIMIT 10
  `).all();

  console.log("🕐 最新 10 条检测");
  console.log("  ────────────────────────────────────────");
  for (var i = 0; i < recent.length; i++) {
    var r = recent[i];
    var label = r.symbol || r.name || "?";
    var status = r.passed_filter ? "🐕" : "⏭";
    console.log("  " + pad(label, 14) + " 评分 " + pad(r.score, 2) + "/40  " + status + " " + (r.action || ""));
  }
  console.log("");

  // ─── 价格补充说明 ──────────────────────────────────
  var hasPrice = store.db.prepare("SELECT COUNT(*) as c FROM snapshots WHERE price_initial > 0").get().c;
  if (hasPrice === 0) {
    console.log("📌 说明");
    console.log("  ────────────────────────────────────────");
    console.log("  价格数据不可用（DexScreener/Jupiter 在中国被墙）");
    console.log("  P&L、胜率、涨跌幅等功能需要价格源");
    console.log("  建议配置海外代理或使用 Helius DAS API");
    console.log("  评分系统和金狗过滤不受影响，正常运行中");
    console.log("");
  } else {
    console.log("💰 已有 " + hasPrice + " 条价格数据");
    console.log("  跑 node report-full.js 查看完整 P&L");
    console.log("");
  }

  store.close();
}

function pad(s, n) {
  s = String(s);
  while (s.length < n) s = " " + s;
  return s;
}

function bar(count, total) {
  if (!total || total === 0) return "";
  var pct = count / total;
  var len = Math.round(pct * 20);
  var bar = "";
  for (var i = 0; i < 20; i++) bar += i < len ? "█" : "░";
  return "  " + bar + " " + (pct * 100).toFixed(1) + "%";
}

main();
