require("dotenv").config();

const { Monitor } = require("./src/monitor");
const { Analyzer } = require("./src/analyzer");
const { Notifier } = require("./src/notifier");
const { DevTracker } = require("./src/devTracker");

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

  if (!process.env.DINGTALK_TOKEN) {
    console.warn("⚠️  .env 中 DINGTALK_TOKEN 未配置\n");
  }

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

    // Holder 分析结果
    if (report?.holders?.totalHolders) {
      console.log(`   Holder: ${report.holders.totalHolders}个, Top10: ${report.holders.top10Pct}%`);
    }

    // 2) 开发者追踪
    if (token.creator) {
      const devInfo = await devTracker.record(token.creator, token.mint);
      token.devInfo = devInfo;
      console.log(`   部署者: ${devInfo.risk} (${devInfo.tokensCreated}个代币)`);
    }

    // 3) 推送企业微信
    try {
      await notifier.push(token, report);
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
