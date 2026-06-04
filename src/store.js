/**
 * SQLite 持久化存储
 *
 * 保存发现的代币、评分、开发者历史。
 * 重启后数据不丢失。
 */
const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "scan.db");

class Store {
  constructor() {
    // 确保 data 目录存在
    var fs = require("fs");
    var dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this._init();
  }

  // ─── 建表 ───────────────────────────────────────────

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        mint TEXT PRIMARY KEY,
        name TEXT,
        symbol TEXT,
        creator TEXT,
        source TEXT,
        total_score INTEGER DEFAULT 0,
        rug_risk INTEGER DEFAULT 0,
        code_quality INTEGER DEFAULT 0,
        innovation INTEGER DEFAULT 0,
        launch_quality INTEGER DEFAULT 0,
        honeypot_risk TEXT DEFAULT 'unknown',
        summary TEXT,
        action TEXT,
        holders INTEGER DEFAULT 0,
        top10_pct REAL DEFAULT 0,
        liquidity REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS devs (
        wallet TEXT PRIMARY KEY,
        tokens_created INTEGER DEFAULT 0,
        rugged_count INTEGER DEFAULT 0,
        first_seen TEXT DEFAULT (datetime('now')),
        last_seen TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_tokens_score ON tokens(total_score DESC);
      CREATE INDEX IF NOT EXISTS idx_tokens_created ON tokens(created_at DESC);

      CREATE TABLE IF NOT EXISTS snapshots (
        mint TEXT PRIMARY KEY,
        name TEXT,
        symbol TEXT,
        detected_at TEXT DEFAULT (datetime('now')),
        price_initial REAL DEFAULT 0,
        price_1h REAL DEFAULT 0,
        price_6h REAL DEFAULT 0,
        price_24h REAL DEFAULT 0,
        score INTEGER DEFAULT 0,
        action TEXT,
        passed_filter INTEGER DEFAULT 0,
        checked_1h INTEGER DEFAULT 0,
        checked_6h INTEGER DEFAULT 0,
        checked_24h INTEGER DEFAULT 0,
        category TEXT DEFAULT ''
      );
    `);

    // 兼容旧数据库：snapshots 表加 category 列（如果不存在）
    try {
      this.db.exec("ALTER TABLE snapshots ADD COLUMN category TEXT DEFAULT ''");
    } catch (e) {}
  }

  // ─── 代币 ───────────────────────────────────────────

  /** 保存或更新代币记录 */
  saveToken(token, evalResult, holders) {
    var stmt = this.db.prepare(`
      INSERT INTO tokens (mint, name, symbol, creator, source, total_score, rug_risk, code_quality, innovation, launch_quality, honeypot_risk, summary, action, holders, top10_pct, liquidity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mint) DO UPDATE SET
        name=excluded.name, symbol=excluded.symbol,
        total_score=excluded.total_score, action=excluded.action,
        holders=excluded.holders, top10_pct=excluded.top10_pct
    `);

    var total = (evalResult && evalResult.total) || 0;
    var rug = (evalResult && evalResult.rugRisk && evalResult.rugRisk.score) || 0;
    var code = (evalResult && evalResult.codeQuality && evalResult.codeQuality.score) || 0;
    var innov = (evalResult && evalResult.innovation && evalResult.innovation.score) || 0;
    var launch = (evalResult && evalResult.launchQ && evalResult.launchQ.score) || 0;
    var hp = (evalResult && evalResult.honeypot && evalResult.honeypot.risk) || "unknown";
    var action = (evalResult && evalResult.action) || "";
    var summary = (evalResult && evalResult.summary) || "";

    stmt.run(
      token.mint, token.name, token.symbol, token.creator || "", token.source || "",
      total, rug, code, innov, launch, hp, summary, action,
      (holders && holders.totalHolders) || 0,
      (holders && holders.top10Pct) || 0,
      (holders && holders.liquidity) || 0
    );
  }

  /** 查最近 N 条记录 */
  getRecent(limit) {
    limit = limit || 20;
    return this.db.prepare("SELECT * FROM tokens ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  /** 获取所有已扫过的 mint 地址，用于启动时加载避免重复推送 */
  getExistingMints() {
    var rows = this.db.prepare("SELECT mint FROM tokens").all();
    return rows.map(function(r) { return r.mint; });
  }

  /** 查某个代币 */
  getToken(mint) {
    return this.db.prepare("SELECT * FROM tokens WHERE mint = ?").get(mint);
  }

  // ─── 开发者 ─────────────────────────────────────────

  /** 保存或更新开发者记录 */
  saveDev(wallet, tokensCreated, ruggedCount) {
    var stmt = this.db.prepare(`
      INSERT INTO devs (wallet, tokens_created, rugged_count, last_seen)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(wallet) DO UPDATE SET
        tokens_created=excluded.tokens_created,
        rugged_count=excluded.rugged_count,
        last_seen=datetime('now')
    `);
    stmt.run(wallet, tokensCreated || 0, ruggedCount || 0);
  }

  /** 查开发者历史 */
  getDev(wallet) {
    return this.db.prepare("SELECT * FROM devs WHERE wallet = ?").get(wallet);
  }

  // ─── 统计 ───────────────────────────────────────────

  /** 今日扫描统计 */
  getTodayStats() {
    var row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN total_score >= 26 THEN 1 ELSE 0 END) as gold_dogs,
        AVG(total_score) as avg_score,
        MAX(total_score) as max_score
      FROM tokens
      WHERE date(created_at) = date('now')
    `).get();
    return row || { total: 0, gold_dogs: 0, avg_score: 0, max_score: 0 };
  }

  /** 所有时间统计 */
  getAllStats() {
    return this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN total_score >= 26 THEN 1 ELSE 0 END) as gold_dogs,
        ROUND(AVG(total_score), 1) as avg_score
      FROM tokens
    `).get();
  }

  // ─── 回测快照 ─────────────────────────────────────────

  /** 创建初始快照 */
  saveSnapshot(mint, name, symbol, priceInitial, score, action, passed, category) {
    this.db.prepare(`
      INSERT INTO snapshots (mint, name, symbol, price_initial, price_1h, price_6h, price_24h, score, action, passed_filter, checked_1h, checked_6h, checked_24h, category)
      VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, 0, 0, 0, ?)
      ON CONFLICT(mint) DO NOTHING
    `).run(mint, name || "", symbol || "", priceInitial || 0, score || 0, action || "", passed ? 1 : 0, category || "");
  }

  /** 获取分类统计 */
  getCategoryStats() {
    return this.db.prepare(`
      SELECT category, COUNT(*) as c FROM snapshots WHERE category != '' GROUP BY category ORDER BY c DESC
    `).all();
  }

  /** 获取某个分类的出现次数 */
  getCategoryCount(category) {
    if (!category) return 0;
    var row = this.db.prepare("SELECT COUNT(*) as c FROM snapshots WHERE category = ?").get(category);
    return row ? row.c : 0;
  }

  /** 更新某个时间点的价格 + 标记已检查 */
  updateSnapshotPrice(mint, field, price) {
    var sql = (field === "initial") ? "UPDATE snapshots SET price_initial = ? WHERE mint = ?" :
              (field === "1h") ? "UPDATE snapshots SET price_1h = ?, checked_1h = 1 WHERE mint = ?" :
              (field === "6h") ? "UPDATE snapshots SET price_6h = ?, checked_6h = 1 WHERE mint = ?" :
              (field === "24h") ? "UPDATE snapshots SET price_24h = ?, checked_24h = 1 WHERE mint = ?" : null;
    if (!sql) return;
    this.db.prepare(sql).run(price || 0, mint);
  }

  /** 检查某个时间点是否已记录 */
  isSnapshotChecked(mint, field) {
    var col = (field === "1h") ? "checked_1h" :
              (field === "6h") ? "checked_6h" :
              (field === "24h") ? "checked_24h" : null;
    if (!col) return false;
    var row = this.db.prepare(`SELECT ${col} FROM snapshots WHERE mint = ?`).get(mint);
    return row ? !!row[col] : false;
  }

  /** 获取所有快照用于报告 */
  getAllSnapshots() {
    return this.db.prepare("SELECT * FROM snapshots ORDER BY detected_at DESC").all();
  }

  /** 按分数段统计胜率 */
  getWinRates() {
    var rows = this.db.prepare(`
      SELECT
        CASE
          WHEN score >= 34 THEN '34-40'
          WHEN score >= 30 THEN '30-33'
          WHEN score >= 26 THEN '26-29'
          ELSE '<26'
        END as score_range,
        COUNT(*) as total,
        SUM(CASE WHEN price_24h > price_initial * 1.05 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN price_24h < price_initial * 0.95 THEN 1 ELSE 0 END) as losses,
        ROUND(AVG(CASE WHEN price_24h > 0 THEN (price_24h - price_initial) / price_initial * 100 ELSE NULL END), 1) as avg_return
      FROM snapshots
      WHERE price_initial > 0 AND checked_24h = 1
      GROUP BY score_range
      ORDER BY MIN(score) DESC
    `).all();
    return rows;
  }

  /** 最佳/最差表现 TOP N */
  getTopPerformers(limit, desc) {
    var order = desc ? "DESC" : "ASC";
    return this.db.prepare(`
      SELECT mint, name, symbol, score, action, detected_at, price_initial, price_24h,
        ROUND((price_24h - price_initial) / price_initial * 100, 1) as return_pct
      FROM snapshots
      WHERE price_initial > 0 AND checked_24h = 1 AND price_24h > 0
      ORDER BY return_pct ${order}
      LIMIT ?
    `).all(limit || 5);
  }

  /** 汇总统计 */
  getPnLSummary() {
    var row = this.db.prepare(`
      SELECT
        COUNT(*) as total_tracked,
        SUM(CASE WHEN checked_24h = 1 AND price_initial > 0 THEN 1 ELSE 0 END) as settled,
        ROUND(AVG(CASE WHEN checked_24h = 1 AND price_initial > 0 THEN (price_24h - price_initial) / price_initial * 100 ELSE NULL END), 1) as avg_return_24h,
        SUM(CASE WHEN checked_24h = 1 AND price_24h > price_initial * 1.05 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN checked_24h = 1 AND price_24h < price_initial * 0.95 THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN passed_filter = 1 AND checked_24h = 1 AND price_24h > price_initial * 1.05 THEN 1 ELSE 0 END) as gold_wins,
        SUM(CASE WHEN passed_filter = 1 AND checked_24h = 1 THEN 1 ELSE 0 END) as gold_total
      FROM snapshots
    `).get();
    return row || { total_tracked: 0, settled: 0, avg_return_24h: 0, wins: 0, losses: 0, gold_wins: 0, gold_total: 0 };
  }

  close() {
    this.db.close();
  }
}

module.exports = { Store };
