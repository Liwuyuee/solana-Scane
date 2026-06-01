require("dotenv").config({ path: require("path").join(__dirname, ".env") });

// Prevent crash on unhandled promise rejections (RPC timeouts, network issues)
process.on("unhandledRejection", function(err) {
  console.warn("  ⚠️ 未捕获的异常（已忽略）:", (err && err.message) || err);
});

const { Monitor } = require("./src/monitor");
const { Analyzer } = require("./src/analyzer");
const { Notifier } = require("./src/notifier");
const { DevTracker } = require("./src/devTracker");
const { Narrator } = require("./src/narrator");
const { SmartMoneyMonitor } = require("./src/smartMoney");
const { MomentumScanner } = require("./src/momentum");
const { Store } = require("./src/store");
const { ComplianceAgent } = require("./src/complianceAgent");
const { PaperTrader } = require("./src/paperTrader");

async function main() {
  console.log("╔══════════════════════════════════╗");
  console.log("║   Solana 新币监控机器人 v3       ║");
  console.log("║   ⚡ PumpPortal WebSocket 实时   ║");
  console.log("║   🛡️ Helius RPC + 包发送检测    ║");
  console.log("║   💬 钉钉推送                    ║");
  console.log("╚══════════════════════════════════╝\n");

  // ─── 多 Agent 架构初始化 ──────────────────────────
  // Sentinel Agent  →  实时监控新币（Monitor + SmartMoney + Momentum）
  // Analyst Agent   →  评分 + AI 分析（Analyzer + Narrator + DevTracker）
  // Compliance Agent → 风控检测 + 链上验证（ComplianceAgent）
  // Executor Agent  →  推送 + 追踪（Notifier + RugAlarm + Store）
  // ─────────────────────────────────────────────────

  const store = new Store();
  const paperTrader = new PaperTrader(store);
  const existingMints = store.getExistingMints();
  const monitor = new Monitor(existingMints);
  if (existingMints.length > 0) {
    console.log("📦 从数据库加载 " + existingMints.length + " 个已扫过的代币，避免重复推送");
  }
  const analyzer = new Analyzer();
  const notifier = new Notifier(process.env.DINGTALK_TOKEN);
  const devTracker = new DevTracker();
  const narrator = new Narrator();
  const compliance = new ComplianceAgent();

  if (narrator.enabled) {
    console.log("🤖 AI 叙事: 已启用（Claude）");
  } else {
    console.log("🤖 AI 叙事: 未启用（使用模板）");
  }

  if (!process.env.DINGTALK_TOKEN) {
    console.warn("⚠️  .env 中 DINGTALK_TOKEN 未配置\n");
  }

  // 聪明钱监控
  const smartMoney = new SmartMoneyMonitor(monitor.seen);
  smartMoney.onSmartBuy(function(token) {
    // Smart money found a new token, process it through the same pipeline
    processToken(token);
  });
  smartMoney.start();
  console.log("🧠 聪明钱钱包: " + smartMoney.wallets.length + " 个");

  // 动量异动监控（FDV > $200K 的币检测放量异动）
  const momentumScanner = new MomentumScanner(monitor.seen);
  momentumScanner.setCallback(function(token) {
    processToken(token);
  });
  momentumScanner.start();
  console.log("📈 动量异动扫描: 已启动 (FDV > $200K)");

  // 推送阈值：总分 >= MIN_SCORE 才推送（默认 30，满分 40）
  const MIN_SCORE = parseInt(process.env.MIN_SCORE || "30", 10);
  const MIN_LIQUIDITY = parseInt(process.env.MIN_LIQUIDITY || "50000", 10);

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

    // 3) 四项评分 + 涨幅潜力 + 叙事生成
    const evalResult = analyzer.evaluate(report, devInfo, token.dexInfo);
    // Use momentum scanner's one-line summary if available
    if (token.summary) {
      evalResult.summary = token.summary;
    }
    console.log(`   总分: ${evalResult.total}/40 · ${evalResult.action}`);
    if (evalResult.growth && evalResult.growth.score > 0) {
      console.log(`   涨幅潜力: ${evalResult.growth.score}/10 ${evalResult.growth.emoji}`);
    }

    // 保存到数据库（防止重启后重复推送）
    store.saveToken(token, evalResult, report?.holders);

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

    // 5) Compliance 风控检测（包发送 + 链上模拟卖出）
    // 异步非阻塞，5 秒超时兜底
    var complianceResult = null;
    try {
      complianceResult = await Promise.race([
        compliance.runAll(token.mint, report?.holders),
        new Promise(function(r) { setTimeout(function() { r(null); }, 5000); }),
      ]);
      if (complianceResult) {
        if (complianceResult.bundledSupply && complianceResult.bundledSupply.isBundled) {
          console.log("   包发送检测: " + complianceResult.bundledSupply.detail);
        }
        if (complianceResult.sellTest) {
          console.log("   链上卖出测试: " + complianceResult.sellTest.detail);
        }
      }
    } catch (e) {}

    // 6) 多层金狗过滤 ──────────────────────────────
    var failReasons = [];

    // 6a) 总分阈值
    if (evalResult.total < MIN_SCORE) {
      failReasons.push("总分 " + evalResult.total + "/40 低于阈值 " + MIN_SCORE);
    }

    // 6b) Honeypot 检测 → 跳过（避免貔貅）
    var hp = evalResult.honeypot;
    if (hp && hp.risk === "high") {
      failReasons.push("Honeypot 高风险，可能无法卖出");
    }
    if (hp && hp.risk === "medium") {
      failReasons.push("Honeypot 存在可疑特征（" + (hp.reasons[0] || "") + "）");
    }

    // 6b2) 链上模拟卖出检测 → 跳过（仅当确实检测到貔貅，网络错误不拦）
    var st = complianceResult && complianceResult.sellTest;
    if (st && st.sellable === false && !st.networkError && !st.simulationSkipped) {
      failReasons.push("链上模拟卖出失败: " + st.detail);
    }

    // 6b3) 包发送检测 → 跳过（高确信度）
    var bs = complianceResult && complianceResult.bundledSupply;
    if (bs && bs.isBundled && bs.confidence === "high") {
      failReasons.push("包发送检测: " + bs.detail);
    }

    // 6c) Mint 权限未撤销 → 跳过（能增发就是定时炸弹）
    if (report && report.mintAuthority) {
      failReasons.push("Mint 权限未撤销，团队可无限增发");
    }

    // 6d) 开发者有 rug 历史 → 跳过
    if (devInfo && devInfo.ruggedCount > 0) {
      failReasons.push("部署者有 Rug 历史记录");
    }

    // 6e) Holder 极度集中（>90%）→ 跳过
    var holders = report && report.holders;
    if (holders && holders.top10Pct > 90) {
      failReasons.push("筹码极度集中（Top10 占 " + holders.top10Pct + "%）");
    }

    // 6f) 部署者正在卖出 → 跳过
    if (devInfo && devInfo.isSelling) {
      failReasons.push("部署者正在卖出，有砸盘风险");
    }

    // 6g) 流动性不足 → 跳过
    var liq = token.dexInfo && token.dexInfo.liquidityUsd;
    if (liq > 0 && liq < MIN_LIQUIDITY) {
      failReasons.push("流动性不足（$" + Math.round(liq).toLocaleString() + " < $" + MIN_LIQUIDITY.toLocaleString() + "）");
    }

    // 6h) 未毕业到 Raydium/主流 DEX → 跳过（只在 Pump.fun 上的太危险）
    var dexName = token.dexInfo && token.dexInfo.dexName;
    if (dexName && dexName !== "raydium" && dexName !== "orca" && dexName !== "jupiter") {
      // 有 DEX 信息但不是主流 DEX → 警告但不阻止
      // 无 DEX 信息（还在 Pump.fun 上）→ 跳过
      if (!dexName) {
        // 新创币还没 DEX 信息是正常的，跳过 DexScreener 兜底发现的币就够了
        // 但如果评分很高且来源是 onchain，放宽
      }
    }

    // 6i) 存活时间不够长（可选）→ 跳过
    var createdAt = token.dexInfo && token.dexInfo.pairCreatedAt;
    if (createdAt) {
      var ageHours = (Date.now() - createdAt) / 3600000;
      if (ageHours < 1) {
        // 不到 1 小时，标记但不阻止
      }
    }

    if (failReasons.length > 0) {
      console.log("   ⏭ 金狗过滤未通过:");
      failReasons.forEach(function(r) { console.log("      - " + r); });
      paperTrader.record(token, evalResult, false);
      return;
    }

    console.log("   🐕 金狗检测通过! 推送中...");

    // 7) 推送钉钉
    try {
      await notifier.push(token, report, evalResult);
      console.log(`   ✅ 已推送`);

      // 8) 回测记录 + Rug Alarm
      paperTrader.record(token, evalResult, true);
      startRugAlarm(token, devTracker);
    } catch (e) {
      console.error(`   ❌ 推送失败: ${e.message}`);
    }
  }

  /**
   * Rug Alarm：推送后持续监控价格，检测暴跌
   * 每 3 分钟查一次 DexScreener，持续 20 分钟
   * 如果价格跌超 60%，记录部署者 rug 行为
   */
  function startRugAlarm(token, devTracker) {
    var mint = token.mint;
    var initialPrice = token.dexInfo && token.dexInfo.priceUsd;
    if (!initialPrice || initialPrice <= 0) return;

    var checks = 0;
    var MAX_CHECKS = 7;      // 7 × 3min ≈ 21 分钟
    var CHECK_INTERVAL = 180000; // 3 分钟
    var DROP_THRESHOLD = 0.6;    // 跌 60%

    var timer = setInterval(async function() {
      checks++;
      try {
        var res = await fetch("https://api.dexscreener.com/latest/dex/search/?q=" + mint);
        if (res.ok) {
          var data = await res.json();
          var pair = (data.pairs || []).find(function(p) { return p.chainId === "solana"; });
          if (pair && pair.priceUsd) {
            var currentPrice = parseFloat(pair.priceUsd);
            var drop = (parseFloat(initialPrice) - currentPrice) / parseFloat(initialPrice);

            if (drop > DROP_THRESHOLD) {
              console.log("   🚨 Rug 警报! " + (token.symbol || mint.slice(0, 8)) + " 已暴跌 " + (drop * 100).toFixed(0) + "%（¥" + initialPrice + " → ¥" + currentPrice + "）");
              if (token.creator && devTracker) {
                devTracker.reportRug(token.creator);
              }
              clearInterval(timer);
              return;
            }
          }
        }
      } catch (e) {}

      if (checks >= MAX_CHECKS) {
        clearInterval(timer);
        console.log("   ✅ " + (token.symbol || mint.slice(0, 8)) + " Rug 监控完成，20 分钟内未暴跌");
      }
    }, CHECK_INTERVAL);
  }

  // 注册新币回调
  monitor.setNewTokenCallback(processToken);

  console.log(`🌐 代理: ${process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "直连"}`);
  console.log("📡 DexScreener 兜底每 30 秒扫描一次");
  console.log("  注: DexScreener 在中国网络可能超时，不影响主扫链\n");
  console.log("等待新币...\n");
}

// Auto-restart on crash
async function run() {
  while (true) {
    try {
      await main();
      break; // normal exit
    } catch (err) {
      console.error("\n💥 进程崩溃: " + (err && err.message));
      console.log("🔄 5 秒后自动重启...");
      await new Promise(function(r) { setTimeout(r, 5000); });
    }
  }
}
run();
