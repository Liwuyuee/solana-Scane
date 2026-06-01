#!/usr/bin/env node
/**
 * Auto-Tune — 自动调参建议
 *
 * 读取已结算的回测数据，分析每个分数段的胜率，
 * 推荐最优的 MIN_SCORE 阈值。
 *
 * 用法: node scripts/auto-tune.js
 */

const path = require("path");
const Database = require("better-sqlite3");
const db = new Database(path.join(__dirname, "..", "data", "scan.db"));

console.log("");
console.log("╔══════════════════════════════════════════╗");
console.log("║     Solana Monitor — 自动调参建议       ║");
console.log("╚══════════════════════════════════════════╝");
console.log("");

// 获取已结算数据（有初始价格和 24h 价格）
var settled = db.prepare(`
  SELECT score, price_initial, price_24h, passed_filter
  FROM snapshots
  WHERE checked_24h = 1 AND price_initial > 0 AND price_24h > 0
  ORDER BY score DESC
`).all();

if (settled.length === 0) {
  console.log("📊 暂无已结算数据");
  console.log("   需要等 24h 价格回查完成，建议跑 3-7 天后查看");
  console.log("   当前记录数: " + db.prepare("SELECT COUNT(*) as c FROM snapshots").get().c + " 条");
  console.log("   已结算: 0 条");
  console.log("");
  console.log("   新检测的币会通过 Cloudflare Worker 获取价格，");
  console.log("   24h 后自动结算。等几天再跑这个脚本。");
  console.log("");
  db.close();
  return;
}

var total = settled.length;
var upCount = settled.filter(function(s) { return s.price_24h > s.price_initial * 1.05; }).length;
var downCount = settled.filter(function(s) { return s.price_24h < s.price_initial * 0.95; }).length;
var flatCount = total - upCount - downCount;
var overallWinRate = (upCount / total * 100).toFixed(1);

console.log("📊 总览");
console.log("  ────────────────────────────────────────");
console.log("  已结算: " + total + " 个代币");
console.log("  涨 >5%: " + upCount + " 个");
console.log("  跌 >5%: " + downCount + " 个");
console.log("  横盘:   " + flatCount + " 个");
console.log("  整体胜率: " + overallWinRate + "%");
console.log("");

// 按分数段计算胜率
console.log("📈 按分数段胜率(24h)");
console.log("  ────────────────────────────────────────");
console.log("  分数段     总数   涨   跌   胜率    建议");
console.log("  ────────────────────────────────────────");

var ranges = [
  { label: "34-40", min: 34, max: 40 },
  { label: "32-33", min: 32, max: 33 },
  { label: "30-31", min: 30, max: 31 },
  { label: "28-29", min: 28, max: 29 },
  { label: "26-27", min: 26, max: 27 },
  { label: "24-25", min: 24, max: 25 },
  { label: "22-23", min: 22, max: 23 },
  { label: "20-21", min: 20, max: 21 },
  { label: "<20",   min: 0,  max: 19 },
];

var bestThreshold = 40;
var bestWinRate = 0;

for (var i = 0; i < ranges.length; i++) {
  var r = ranges[i];
  var items = settled.filter(function(s) { return s.score >= r.min && s.score <= r.max; });
  var wins = items.filter(function(s) { return s.price_24h > s.price_initial * 1.05; }).length;
  var t = items.length;
  var wr = t > 0 ? (wins / t * 100).toFixed(1) : "-";
  var suggestion = "";

  if (t >= 5) {
    var wrNum = parseFloat(wr);
    if (wrNum >= 60) suggestion = "✅ 优质区间";
    else if (wrNum >= 40) suggestion = "🟡 可考虑";
    else suggestion = "🔴 建议过滤";

    // 找最优阈值
    if (wrNum >= bestWinRate && t >= 5) {
      bestWinRate = wrNum;
      bestThreshold = r.min;
    }
  } else {
    suggestion = "样本不足";
  }

  console.log(
    "  " + (r.label + "         ").slice(0, 10) +
    (t + "     ").slice(0, 5) +
    (wins + "     ").slice(0, 5) +
    ((items.length - wins - items.filter(function(s) { return s.price_24h < s.price_initial * 0.95; }).length) + "     ").slice(0, 5) +
    (wr + "%        ").slice(0, 8) +
    suggestion
  );
}
console.log("");

// 阈值敏感性分析
console.log("🎯 阈值敏感性分析");
console.log("  如果设不同的 MIN_SCORE:");
console.log("  ────────────────────────────────────────");
console.log("  阈值   金狗数   胜率   预期回报(每注$100)");
console.log("  ────────────────────────────────────────");

var thresholds = [34, 32, 30, 29, 28, 27, 26, 25, 24, 20];
for (var i = 0; i < thresholds.length; i++) {
  var t = thresholds[i];
  var passItems = settled.filter(function(s) { return s.score >= t; });
  var passWins = passItems.filter(function(s) { return s.price_24h > s.price_initial * 1.05; }).length;
  var passTotal = passItems.length;
  var passWr = passTotal > 0 ? (passWins / passTotal * 100).toFixed(1) : "-";

  // 预期回报：每注 $100，胜的赚 +30%，输的亏 -30%
  var expectedReturn = 0;
  if (passTotal > 0) {
    for (var j = 0; j < passItems.length; j++) {
      var s = passItems[j];
      var ret = (s.price_24h - s.price_initial) / s.price_initial;
      expectedReturn += 100 * ret;
    }
  }

  var isCurrent = Math.abs(t - 29) < 0.1 ? " ◀ 当前" : "";

  console.log(
    "  " + (t + "      ").slice(0, 5) +
    (passTotal + " 个     ").slice(0, 8) +
    (passWr + "%         ").slice(0, 10) +
    (expectedReturn > 0 ? "+" : "") + Math.round(expectedReturn) + " USD" +
    isCurrent
  );
}
console.log("");

// 推荐
var rec = db.prepare("SELECT value FROM ? WHERE key = 'min_score'").get();
var currentMinScore = 29; // default

console.log("💡 建议");
console.log("  ────────────────────────────────────────");
if (bestWinRate >= 50 && bestThreshold < 29) {
  console.log("  当前阈值 29，但 " + bestThreshold + " 分以上胜率 " + bestWinRate + "%");
  console.log("  建议将 MIN_SCORE 降至 " + bestThreshold + "，可捕获更多金狗");
  console.log("  在 .env 中修改 MIN_SCORE=" + bestThreshold);
} else if (bestWinRate >= 50 && bestThreshold >= 29) {
  console.log("  当前阈值 29 表现良好，胜率 " + bestWinRate + "%");
  console.log("  ✅ 保持当前配置");
} else if (bestWinRate < 50 && bestThreshold >= 34) {
  console.log("  只有 34+ 分的币胜率不错，当前 29 偏低了");
  console.log("  建议将 MIN_SCORE 升至 34，减少亏损");
  console.log("  在 .env 中修改 MIN_SCORE=34");
} else {
  console.log("  数据还在积累中，建议等更多结算数据后再看");
  console.log("  目前最佳阈值: " + bestThreshold + " 分 (胜率 " + bestWinRate + "%)");
}
console.log("  (数据量越大，建议越准确)");
console.log("");

db.close();
