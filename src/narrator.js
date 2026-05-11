/**
 * AI 叙事分析（可选）
 *
 * 如果配置了 ANTHROPIC_API_KEY，用 Claude 生成：
 * - 总结段落
 * - 亮点列表
 * - 风险列表
 * - 每项评分的详细解释
 *
 * 如果没配置，返回 null，走模板生成。
 */
const Anthropic = require("@anthropic-ai/sdk");

class Narrator {
  constructor() {
    var key = process.env.ANTHROPIC_API_KEY || "";
    this.enabled = !!key;
    if (this.enabled) {
      this.client = new Anthropic({ apiKey: key });
    }
  }

  /**
   * 用 AI 生成叙事分析
   * @param {object} token   代币信息
   * @param {object} report  rugcheck 报告
   * @param {object} scores  四项评分 { rugRisk, codeQuality, innovation, launchQ }
   * @param {object} holders Holder 分析数据
   * @param {object} devInfo 开发者信息
   * @returns {object|null} { summary, highlights, warnings, action, rugDetail, codeDetail, innovDetail, launchDetail } 或 null
   */
  async generate(token, report, scores, holders, devInfo) {
    if (!this.enabled) return null;

    try {
      var prompt = this.#buildPrompt(token, report, scores, holders, devInfo);
      var response = await this.client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: "你是一个 Solana 链上代币分析专家。你收到一个刚被发现的新代币的分析数据，需要根据数据生成中文分析报告。分析要专业、客观、简洁。",
        messages: [{ role: "user", content: prompt }],
      });

      var result = this.#parseResponse(response);
      return result;
    } catch (err) {
      console.warn("  AI 叙事生成失败: " + err.message);
      return null;
    }
  }

  // ─── 构建 Prompt ───────────────────────────────────

  #buildPrompt(token, report, scores, holders, devInfo) {
    var s = scores || {};
    var rug = s.rugRisk || {};
    var code = s.codeQuality || {};
    var innov = s.innovation || {};
    var launch = s.launchQ || {};
    var h = holders || {};
    var dev = devInfo || {};
    var r = report || {};

    var lines = [];
    lines.push("请根据以下代币分析数据，生成中文分析报告。");

    lines.push("\n## 基本信息");
    lines.push("- 名称: " + (token.name || "?") + " (" + (token.symbol || "?") + ")");
    lines.push("- Mint 地址: " + (token.mint || "?"));
    if (token.creator) lines.push("- 部署者: " + token.creator);
    if (r.mintAuthority) lines.push("- Mint 权限: 未撤销（有增发风险）");
    else lines.push("- Mint 权限: 已撤销（安全）");
    if (r.freezeAuthority) lines.push("- Freeze 权限: 未撤销（有冻结风险）");
    else lines.push("- Freeze 权限: 已撤销（安全）");
    if (r.liquidity) lines.push("- 流动性: $" + Math.round(r.liquidity).toLocaleString());

    lines.push("\n## 安全性（RugCheck）");
    var risks = r.risks || [];
    if (risks.length > 0) {
      lines.push("检测到 " + risks.length + " 项风险：");
      risks.slice(0, 8).forEach(function(ri) {
        lines.push("- [" + ri.level + "] " + (ri.name || ""));
      });
    } else {
      lines.push("未检测到明显风险项");
    }

    lines.push("\n## 四项评分");
    lines.push("- 跑路风险: " + (rug.score || 0) + "/10 （越高越安全）");
    lines.push("- 代码靠谱: " + (code.score || 0) + "/10");
    lines.push("- 玩法新鲜: " + (innov.score || 0) + "/10");
    lines.push("- 启动质量: " + (launch.score || 0) + "/10");

    lines.push("\n## 持有者分布");
    lines.push("- 总 Holder: " + (h.totalHolders || 0));
    lines.push("- Top 10 占比: " + (h.top10Pct || 0) + "%");
    lines.push("- 集中度: " + (h.risk || "未知"));

    if (dev.tokensCreated > 0) {
      lines.push("\n## 部署者信息");
      lines.push("- 发币数量: " + dev.tokensCreated + " 个");
      if (dev.ruggedCount > 0) lines.push("- Rug 记录: " + dev.ruggedCount + " 次");
      lines.push("- 评价: " + (dev.risk || "未知"));
    }

    lines.push("\n## 要求");
    lines.push("请生成以下内容（用中文）：");
    lines.push("");
    lines.push("1. 一个简短的总结段落（1-3句话，点评这个币的总体情况、亮点和风险，给出是否值得关注的意见）");
    lines.push("2. 3-5 个亮点点（每点一句话）");
    lines.push("3. 3-5 个风险点（每点一句话）");
    lines.push("4. 一个操作建议词（从以下选：'建议回避'、'比较警惕'、'再观望观望'、'可以看看'、'金狗推荐'）");
    lines.push("5. 跑路风险得分的详细解释（1-2句话，说明为什么给这个分）");
    lines.push("6. 代码靠谱得分的详细解释");
    lines.push("7. 玩法新鲜得分的详细解释");
    lines.push("8. 启动质量得分的详细解释");
    lines.push("");
    lines.push("请以 JSON 格式输出，格式如下：");
    lines.push('{');
    lines.push('  "summary": "总结段落",');
    lines.push('  "highlights": ["亮点1", "亮点2", ...],');
    lines.push('  "warnings": ["风险1", "风险2", ...],');
    lines.push('  "action": "建议回避|比较警惕|再观望观望|可以看看|金狗推荐",');
    lines.push('  "rugDetail": "解释",');
    lines.push('  "codeDetail": "解释",');
    lines.push('  "innovDetail": "解释",');
    lines.push('  "launchDetail": "解释"');
    lines.push('}');

    return lines.join("\n");
  }

  // ─── 解析响应 ──────────────────────────────────────

  #parseResponse(response) {
    var text = "";
    for (var i = 0; i < response.content.length; i++) {
      var block = response.content[i];
      if (block.type === "text") {
        text += block.text;
      }
    }

    // 提取 JSON
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("  AI 返回格式异常，使用模板");
      return null;
    }

    try {
      var data = JSON.parse(jsonMatch[0]);
      return {
        summary: data.summary || "",
        highlights: Array.isArray(data.highlights) ? data.highlights : [],
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
        action: data.action || "",
        rugDetail: data.rugDetail || "",
        codeDetail: data.codeDetail || "",
        innovDetail: data.innovDetail || "",
        launchDetail: data.launchDetail || "",
      };
    } catch (e) {
      console.warn("  AI JSON 解析失败: " + e.message);
      return null;
    }
  }
}

module.exports = { Narrator };
