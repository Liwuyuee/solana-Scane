#!/usr/bin/env node
/**
 * Web 面板 — 本地监控仪表盘
 *
 * 在浏览器中打开 http://localhost:3456 查看实时统计。
 *
 * 用法: node dashboard.js
 */

const http = require("http");
const path = require("path");
const Database = require("better-sqlite3");
const DB_PATH = path.join(__dirname, "data", "scan.db");

function getStats() {
  try {
    var db = new Database(DB_PATH);
    var total = db.prepare("SELECT COUNT(*) as c FROM snapshots").get().c;
    var today = db.prepare("SELECT COUNT(*) as c FROM snapshots WHERE date(detected_at) = date('now')").get().c;
    var passed = db.prepare("SELECT COUNT(*) as c FROM snapshots WHERE passed_filter = 1").get().c;
    var avgScore = db.prepare("SELECT ROUND(AVG(score),1) as a FROM snapshots").get().a || 0;

    var dist = db.prepare(`
      SELECT
        SUM(CASE WHEN score >= 30 THEN 1 ELSE 0 END) as high,
        SUM(CASE WHEN score BETWEEN 26 AND 29 THEN 1 ELSE 0 END) as mid,
        SUM(CASE WHEN score < 26 THEN 1 ELSE 0 END) as low
      FROM snapshots
    `).get();

    var catStats = db.prepare("SELECT category, COUNT(*) as c FROM snapshots WHERE category != '' GROUP BY category ORDER BY c DESC").all();

    var recent = db.prepare("SELECT name, symbol, score, action, passed_filter, detected_at FROM snapshots ORDER BY detected_at DESC LIMIT 20").all();

    var walletFile = path.join(__dirname, "data", "extra-wallets.json");
    var extraWallets = [];
    try { extraWallets = JSON.parse(require("fs").readFileSync(walletFile, "utf8")); } catch(e) {}

    db.close();
    return { total, today, passed, avgScore, dist, catStats, recent, walletCount: 17 + extraWallets.length };
  } catch(e) {
    return { error: e.message };
  }
}

var server = http.createServer(function(req, res) {
  if (req.url === "/api/stats") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(getStats()));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Solana Monitor v3 - 仪表盘</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; padding: 20px; }
  h1 { font-size: 24px; margin-bottom: 20px; color: #58a6ff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .card .num { font-size: 28px; font-weight: 700; color: #58a6ff; }
  .card .label { font-size: 12px; color: #8b949e; margin-top: 4px; }
  .bar { display: flex; height: 20px; border-radius: 4px; overflow: hidden; margin: 8px 0; }
  .bar-seg { display: flex; align-items: center; justify-content: center; font-size: 11px; color: #fff; }
  .bar-high { background: #2ea043; }
  .bar-mid { background: #d29922; }
  .bar-low { background: #da3633; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 600; }
  .tag { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; background: #21262d; color: #c9d1d9; }
  .gold { color: #d29922; font-weight: 700; }
  .skip { color: #8b949e; }
  .refresh { color: #8b949e; font-size: 12px; margin-bottom: 16px; }
  .cat-bar { margin: 4px 0; display: flex; align-items: center; gap: 8px; }
  .cat-bar .fill { height: 16px; border-radius: 3px; background: #1f6feb; }
  .cat-label { width: 100px; text-align: right; }
</style>
</head>
<body>
<h1>📊 Solana Monitor v3</h1>
<div id="app">
  <div class="refresh" id="refresh">加载中...</div>
  <div class="grid" id="cards"></div>
  <h2>📈 评分分布</h2>
  <div class="bar" id="distBar"></div>
  <div id="distLabels" style="font-size:12px;color:#8b949e;margin-bottom:20px;display:flex;justify-content:space-between"></div>
  <h2>📂 分类统计</h2>
  <div id="catStats" style="margin-bottom:20px"></div>
  <h2>🕐 最新检测（20 条）</h2>
  <table><thead><tr><th>名称</th><th>评分</th><th>操作</th><th>状态</th><th>时间</th></tr></thead><tbody id="recent"></tbody></table>
</div>
<script>
async function load() {
  var r = await fetch('/api/stats');
  var d = await r.json();
  if (d.error) { document.getElementById('refresh').textContent = '错误: ' + d.error; return; }

  document.getElementById('refresh').textContent = '🔄 自动刷新 · 共 ' + d.total + ' 条记录 · 聪明钱 ' + d.walletCount + ' 个 · ' + new Date().toLocaleString('zh-CN');

  document.getElementById('cards').innerHTML = [
    { n: d.total, l: '累计检测' },
    { n: d.today, l: '今日新增' },
    { n: d.passed, l: '金狗通过' },
    { n: d.avgScore + '/40', l: '平均评分' },
    { n: d.walletCount, l: '聪明钱包' },
  ].map(function(c) { return '<div class=\"card\"><div class=\"num\">' + c.n + '</div><div class=\"label\">' + c.l + '</div></div>'; }).join('');

  var total = d.dist.high + d.dist.mid + d.dist.low || 1;
  document.getElementById('distBar').innerHTML = [
    { pct: d.dist.high / total * 100, label: '≥30分 ' + d.dist.high, cls: 'bar-high' },
    { pct: d.dist.mid / total * 100, label: '26-29分 ' + d.dist.mid, cls: 'bar-mid' },
    { pct: d.dist.low / total * 100, label: '<26分 ' + d.dist.low, cls: 'bar-low' },
  ].map(function(s) { return '<div class=\"bar-seg ' + s.cls + '\" style=\"width:' + s.pct + '%\">' + (s.pct > 8 ? s.label : '') + '</div>'; }).join('');

  document.getElementById('distLabels').innerHTML = [
    '<span>✅ ≥30分: ' + d.dist.high + '</span>',
    '<span>🟡 26-29分: ' + d.dist.mid + '</span>',
    '<span>🔴 <26分: ' + d.dist.low + '</span>',
  ].join('');

  document.getElementById('catStats').innerHTML = d.catStats.map(function(c) {
    var pct = (c.c / total * 100).toFixed(1);
    return '<div class=\"cat-bar\"><span class=\"cat-label\">' + c.category + '</span><div class=\"fill\" style=\"width:' + pct * 2 + 'px\"></div><span>' + c.c + ' (' + pct + '%)</span></div>';
  }).join('') || '<div style=\"color:#8b949e\">暂无数据</div>';

  document.getElementById('recent').innerHTML = d.recent.map(function(r) {
    var name = r.symbol || r.name || '?';
    var status = r.passed_filter ? '<span class=\"gold\">🐕 金狗</span>' : '<span class=\"skip\">⏭ 过滤</span>';
    return '<tr><td>' + name + '</td><td>' + r.score + '/40</td><td>' + (r.action || '-') + '</td><td>' + status + '</td><td>' + (r.detected_at || '').slice(0,16) + '</td></tr>';
  }).join('');
}
load();
setInterval(load, 10000);
</script>
</body>
</html>
  `);
});

var PORT = 3456;
server.listen(PORT, "0.0.0.0", function() {
  console.log("📊 Web 面板已启动: http://localhost:" + PORT);
  console.log("   按 Ctrl+C 停止");
});
