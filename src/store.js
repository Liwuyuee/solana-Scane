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
    this.#init();
  }

  // ─── 建表 ───────────────────────────────────────────

  #init() {
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
    `);
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

  close() {
    this.db.close();
  }
}

module.exports = { Store };
