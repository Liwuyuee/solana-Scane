/**
 * AI 叙事分析
 *
 * 支持:
 * - Anthropic Claude（默认，需 ANTHROPIC_API_KEY）
 * - DeepSeek / 任何 OpenAI 兼容 API（需设置 AI_PROVIDER=openai + DEEPSEEK_API_KEY）
 *
 * 没配 key 时返回 null，走模板生成。
 */

const DEEPSEEK_BASE = "https://api.deepseek.com";

class Narrator {
  constructor() {
    var anthropicKey = process.env.ANTHROPIC_API_KEY || "";
    var deepseekKey = process.env.DEEPSEEK_API_KEY || "";
    var provider = process.env.AI_PROVIDER || (deepseekKey ? "openai" : anthropicKey ? "anthropic" : "none");

    this.enabled = provider !== "none";
    this.provider = provider;

    if (provider === "anthropic" && anthropicKey) {
      var Anthropic = require("@anthropic-ai/sdk");
      this.client = new Anthropic({ apiKey: anthropicKey });
      this.model = process.env.AI_MODEL || "claude-sonnet-4-20250514";
    } else if (provider === "openai" && deepseekKey) {
      var OpenAI = require("openai");
      this.client = new OpenAI({
        apiKey: deepseekKey,
        baseURL: process.env.AI_BASE_URL || DEEPSEEK_BASE,
      });
      this.model = process.env.AI_MODEL || "deepseek-chat";
    }
  }

  async generate(token, report, scores, holders, devInfo) {
    if (!this.enabled || !this.client) return null;

    var prompt = this.#buildPrompt(token, report, scores, holders, devInfo);

    try {
      if (this.provider === "anthropic") {
        return await this.#callClaude(prompt);
      } else {
        return await this.#callOpenAI(prompt);
      }
    } catch (err) {
      console.warn("  AI 叙事生成失败: " + err.message);
      return null;
    }
  }

  async #callClaude(prompt) {
    var res = await this.client.messages.create({
      model: this.model,
      max_tokens: 800,
      temperature: 0.7,
      messages: [{ role: "user", content: prompt }],
    });
    var text = res.content[0].text;
    return this.#parseResponse(text);
  }

  async #callOpenAI(prompt) {
    var res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 800,
      temperature: 0.7,
      messages: [{ role: "user", content: prompt }],
    });
    var text = res.choices[0].message.content;
    return this.#parseResponse(text);
  }

  #buildPrompt(token, report, scores, holders, dev) {
    var h = holders || {};
    var d = dev || {};

    return `你是一个专业的 Solana 链上分析师，用中文分析这个代币。

代币信息:
- 名称: ${token.name || "?"}
- 符号: ${token.symbol || "?"}
- Mint: ${token.mint || "?"}
- 创建者: ${token.creator ? token.creator.slice(0, 8) + "..." : "未知"}
- 来源: ${token.source || "?"}

安全评分 (RugCheck): ${report.safeScore || 0}/100
Mint 权限: ${report.mintAuthority ? "❌ 未撤销" : "✅ 已撤销"}
Freeze 权限: ${report.freezeAuthority ? "❌ 未撤销" : "✅ 已撤销"}
风险项: ${(report.risks || []).length} 项

四项评分:
- 跑路风险: ${scores.rugRisk.score}/10 - ${scores.rugRisk.detail || ""}
- 代码靠谱: ${scores.codeQuality.score}/10 - ${scores.codeQuality.detail || ""}
- 玩法新鲜: ${scores.innovation.score}/10 - ${scores.innovation.detail || ""}
- 启动质量: ${scores.launchQ.score}/10 - ${scores.launchQ.detail || ""}

Holder 分析:
- 总持有者: ${h.totalHolders || 0}
- Top10 占比: ${h.top10Pct || 0}%

开发者信息:
- 创建代币数: ${d.tokensCreated || 0}
- Rug 次数: ${d.ruggedCount || 0}
- 风险评级: ${d.risk || "未知"}

涨幅潜力: ${scores.growth.score || 0}/10 (${scores.growth.stars || 0}/5 星)

请返回 JSON 格式（不要 markdown 包裹）:
{
  "summary": "一句话总结（30字以内），含买入/观望/回避建议",
  "highlights": ["亮点1", "亮点2", "亮点3"],
  "warnings": ["风险1", "风险2", "风险3"],
  "action": "金狗推荐 / 可以看看 / 再观望观望 / 建议回避",
  "rugDetail": "跑路风险详细分析（50字以内）",
  "codeDetail": "代码质量分析（50字以内）",
  "innovDetail": "玩法创新分析（50字以内）",
  "launchDetail": "启动质量分析（50字以内）"
}`;
  }

  #parseResponse(text) {
    try {
      // 去掉可能的 markdown 包裹
      var cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
      return JSON.parse(cleaned);
    } catch (e) {
      console.warn("  AI JSON 解析失败: " + e.message);
      return null;
    }
  }
}

module.exports = { Narrator };
