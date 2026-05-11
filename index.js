require("dotenv").config();

const { Monitor } = require("./src/monitor");
const { Analyzer } = require("./src/analyzer");
const { Notifier } = require("./src/notifier");
const { DevTracker } = require("./src/devTracker");
const { Narrator } = require("./src/narrator");

async function main() {
  console.log("╔══════════════════════════════════╗");
  console.log("║   Solana 新币监控机器人 v2       ║");
  console.log("║   ⚡ WebSocket 实时监听          ║");
  console.log("║   📊 rugcheck + Holder + Dev     ║");
  console.log("║   💬 钉钉推送                    ║");
  console.log("╚══════════════════════════════════╝\n");

  // 初始化各模块
  const monitor = new Monitor();
  const analyzer = new Analyzer();
  const notifier = new Notifier(process.env.DINGTALK_TOKEN);
  const devTracker = new DevTracker();
  const narrator = new Narrator();

  if (narrator.enabled) {
    console.log("🤖 AI 叙事: 已启用（Claude）");
  } else {
    console.log("🤖 AI 叙事: 未启用（使用模板）");
  }

  if (!process.env.DINGTALK_TOKEN) {
    console.warn("⚠️  .env 中 DINGTALK_TOKEN 未配置\n");
  }

  // 推送阈值：总分 >= MIN_SCORE 才推送（默认 26，满分 40）
  const MIN_SCORE = parseInt(process.env.MIN_SCORE || "26", 10);

  /**
   * 新币处理管线：分析 → Holder → Dev 追踪 → 推送
   */
  async function processToken(token) {
    console.log(`\n📌 ${token.name} (${token.symbol})`);
    console.log(`   ${token.mint}`);
    if (token.creator) console.log(`   👤 ${token.creator.slice(0, 8)}...`);

    // 1) 安全分析（rugcheck + holder）
    const report = await analyzer.getReport(token.mint);
    const s = report?.safeScore ?? 0;
    console.log(`   安全分: ${s}/100`);
    if (report?.holders?.totalHolders) {
      console.log(`   Holder: ${report.holders.totalHolders}个, Top10: ${report.holders.top10Pct}%`);
    }

    // 2) 开发者追踪
    let devInfo = null;
    if (token.creator) {
      devInfo = await devTracker.record(token.creator, token.mint);
      token.devInfo = devInfo;
      console.log(`   部署者: ${devInfo.risk} (${devInfo.tokensCreated}个代币)`);
    }

    // 3) 四项评分 + 叙事生成
    const evalResult = analyzer.evaluate(report, devInfo);
    console.log(`   总分: ${evalResult.total}/40 · ${evalResult.action}`);

    // 4) AI 叙事增强
    const aiNarrative = await narrator.generate(token, report, evalResult, report?.holders, devInfo);
    if (aiNarrative) {
      console.log("   🤖 AI 叙事生成成功");
      // 用 AI 内容覆盖模板
      if (aiNarrative.summary) evalResult.summary = aiNarrative.summary;
      if (aiNarrative.highlights && aiNarrative.highlights.length > 0) evalResult.highlights = aiNarrative.highlights;
      if (aiNarrative.warnings && aiNarrative.warnings.length > 0) evalResult.warnings = aiNarrative.warnings;
      if (aiNarrative.action) evalResult.action = aiNarrative.action;
      if (aiNarrative.rugDetail) evalResult.rugRisk.detail = aiNarrative.rugDetail;
      if (aiNarrative.codeDetail) evalResult.codeQuality.detail = aiNarrative.codeDetail;
      if (aiNarrative.innovDetail) evalResult.innovation.detail = aiNarrative.innovDetail;
      if (aiNarrative.launchDetail) evalResult.launchQ.detail = aiNarrative.launchDetail;
    }

    // 5) 多层金狗过滤 ──────────────────────────────
    var failReasons = [];

    // 5a) 总分阈值
    if (evalResult.total < MIN_SCORE) {
      failReasons.push("总分 " + evalResult.total + "/40 低于阈值 " + MIN_SCORE);
    }

    // 5b) Honeypot 高风险 → 跳过（避免貔貅）
    var hp = evalResult.honeypot;
    if (hp && hp.risk === "high") {
      failReasons.push("Honeypot 高风险，可能无法卖出");
    }

    // 5c) Mint 权限未撤销 → 跳过（能增发就是定时炸弹）
    if (report && report.mintAuthority) {
      failReasons.push("Mint 权限未撤销，团队可无限增发");
    }

    // 5d) 开发者有 rug 历史 → 跳过
    if (devInfo && devInfo.ruggedCount > 0) {
      failReasons.push("部署者有 Rug 历史记录");
    }

    // 5e) Holder 极度集中（>90%）→ 跳过
    var holders = report && report.holders;
    if (holders && holders.top10Pct > 90) {
      failReasons.push("筹码极度集中（Top10 占 " + holders.top10Pct + "%）");
    }

    if (failReasons.length > 0) {
      console.log("   ⏭ 金狗过滤未通过:");
      failReasons.forEach(function(r) { console.log("      - " + r); });
      return;
    }

    console.log("   🐕 金狗检测通过! 推送中...");

    // 6) 推送钉钉
    try {
      await notifier.push(token, report, evalResult);
      console.log(`   ✅ 已推送`);
    } catch (e) {
      console.error(`   ❌ 推送失败: ${e.message}`);
    }
  }

  // 注册 WebSocket 回调
  monitor.setNewTokenCallback(processToken);

  // 启动 WebSocket 监听
  monitor.start();
  console.log("⚡ WebSocket 监听已启动");

  console.log(`🌐 代理: ${process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "直连"}`);
  console.log("📡 DexScreener 兜底每 30 秒扫描一次\n");
  console.log("等待新币...\n");
}

main();
