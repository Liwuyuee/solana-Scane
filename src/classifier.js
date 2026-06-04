/**
 * 代币分类器
 *
 * 根据代币名称、符号、描述自动分类：
 * meme / AI / DeFi / 工具 / 铭文 / 游戏 / 其他
 */

var CATEGORIES = [
  { name: "Meme",    keywords: ["meme", "dog", "cat", "pepe", "woof", "bonk", "shib", "floki", "samo", "wolf", "doge", "corgi", "inu", "chad", "based", "moon", "rocket"] },
  { name: "AI",      keywords: ["ai", "agent", "gpt", "grok", "chat", "bot", "intel", "brain", "deep", "learn", "smart", "auto", "compute", "neural"] },
  { name: "DeFi",    keywords: ["defi", "swap", "pool", "yield", "farm", "stake", "lend", "borrow", "liquid", "trade", "perps", "vault"] },
  { name: "工具/基建", keywords: ["tool", "infra", "protocol", "vm", "oracle", "bridge", "sdk", "api", "relay", "layer"] },
  { name: "铭文",     keywords: ["inscrip", "brc20", "ordi", "sats", "nft", "collection"] },
  { name: "游戏/元宇宙", keywords: ["game", "play", "meta", "guild", "arena", "raid", "quest", "rpg", "pixel", "sand"] },
  { name: "社交",     keywords: ["social", "chat", "message", "friend", "follow", "share", "post", "feed"] },
];

/** 对代币进行分类 */
function classify(token) {
  var text = (token.name + " " + token.symbol + " " + (token.description || "")).toLowerCase();

  for (var i = 0; i < CATEGORIES.length; i++) {
    var cat = CATEGORIES[i];
    for (var j = 0; j < cat.keywords.length; j++) {
      if (text.indexOf(cat.keywords[j]) >= 0) {
        return cat.name;
      }
    }
  }

  return "其他";
}

module.exports = { classify, CATEGORIES };
