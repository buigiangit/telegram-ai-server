import express from "express";
import { Telegraf } from "telegraf";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const PORT = process.env.PORT || 3001;

const AI_MODEL =
  process.env.AI_MODEL || "gpt-4.1-mini";

if (!BOT_TOKEN) {
  throw new Error("Missing BOT_TOKEN");
}

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY");
}

const bot = new Telegraf(BOT_TOKEN);

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// ================= PROMPT =================

const SYSTEM_PROMPT = `
Bạn là AI phân tích crypto và thị trường cho cộng đồng trader.

Quy tắc:
- Trả lời ngắn gọn.
- Thực chiến.
- Không lan man.
- Dựa vào EMA20, EMA50, EMA200, RSI14.
- Dựa vào hỗ trợ và kháng cự.
- Chỉ chọn 1 hướng:
LONG hoặc SHORT hoặc CHỜ.
- Không được đưa LONG và SHORT cùng lúc.
- Không được nói chung chung.
- Không cam kết chắc chắn.

Format:

❇️ Nhận định:
👉 ...

🔵/🔴 Khuyến nghị:
👉 LONG / SHORT / CHỜ

👉 Entry:
👉 SL:
👉 TP1:
👉 TP2:

⚠️ Tham khảo, không phải lời khuyên đầu tư.
`;

// ================= BINANCE CACHE =================

let BINANCE_SYMBOL_CACHE = [];

let BINANCE_SYMBOL_CACHE_TIME = 0;

// ================= GET BINANCE SYMBOLS =================

async function getBinanceSymbols() {

  const res = await fetch(
    "https://api.binance.com/api/v3/exchangeInfo"
  );

  const data = await res.json();

  if (
    !data ||
    !Array.isArray(data.symbols)
  ) {
    throw new Error(
      "Không lấy được danh sách Binance"
    );
  }

  return data.symbols
    .filter((s) => s.status === "TRADING")
    .map((s) => s.symbol);
}

// ================= CACHE =================

async function getCachedBinanceSymbols() {

  const now = Date.now();

  // cache 6h
  if (
    BINANCE_SYMBOL_CACHE.length > 0 &&
    now - BINANCE_SYMBOL_CACHE_TIME <
      6 * 60 * 60 * 1000
  ) {
    return BINANCE_SYMBOL_CACHE;
  }

  BINANCE_SYMBOL_CACHE =
    await getBinanceSymbols();

  BINANCE_SYMBOL_CACHE_TIME = now;

  return BINANCE_SYMBOL_CACHE;
}

// ================= DETECT SYMBOL =================

async function detectSymbol(text) {

  if (!text) return null;

  const upper = text.toUpperCase();

  // ===== SPECIAL =====

  const specialMap = [
    {
      keywords: [
        "XAU",
        "GOLD",
        "VANG",
        "VÀNG",
      ],
      symbol: "XAUUSD",
    },

    {
      keywords: [
        "OIL",
        "DAU",
        "DẦU",
        "WTI",
        "USOIL",
      ],
      symbol: "USOIL",
    },
  ];

  for (const item of specialMap) {

    for (const key of item.keywords) {

      const regex = new RegExp(
        `\\b${key}\\b`,
        "i"
      );

      if (regex.test(upper)) {
        return item.symbol;
      }
    }
  }

  // ===== BINANCE =====

  const binanceSymbols =
    await getCachedBinanceSymbols();

  // full pair

  const fullPairMatch =
    upper.match(
      /\b([A-Z0-9]{2,20}USDT)\b/
    );

  if (fullPairMatch) {

    const pair = fullPairMatch[1];

    if (
      binanceSymbols.includes(pair)
    ) {
      return pair;
    }
  }

  // split words

  const words =
    upper.match(
      /\b[A-Z0-9]{2,15}\b/g
    ) || [];

  const ignoreWords = [
    "BOT",
    "LONG",
    "SHORT",
    "BUY",
    "SELL",
    "ENTRY",
    "TP",
    "TP1",
    "TP2",
    "SL",
    "STOP",
    "LOSS",
    "SAO",
    "ROI",
    "RỒI",
    "HOM",
    "HÔM",
    "NAY",
    "PHAN",
    "PHÂN",
    "TICH",
    "TÍCH",
    "CO",
    "CÓ",
    "DUOC",
    "ĐƯỢC",
    "KHONG",
    "KHÔNG",
  ];

  for (const word of words) {

    if (
      ignoreWords.includes(word)
    ) {
      continue;
    }

    const pair = `${word}USDT`;

    if (
      binanceSymbols.includes(pair)
    ) {
      return pair;
    }
  }

  return null;
}

// ================= GET BINANCE KLINES =================

async function getBinanceKlines(
  symbol = "BTCUSDT",
  interval = "1h",
  limit = 200
) {

  const url =
    `https://api.binance.com/api/v3/klines` +
    `?symbol=${symbol}` +
    `&interval=${interval}` +
    `&limit=${limit}`;

  const res = await fetch(url);

  const data = await res.json();

  if (!Array.isArray(data)) {
    throw new Error(
      `Không lấy được dữ liệu ${symbol}`
    );
  }

  return data.map((k) => ({
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
  }));
}

// ================= EMA =================

function ema(values, period) {

  if (
    !values ||
    values.length < period
  ) {
    return null;
  }

  const k = 2 / (period + 1);

  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result =
      values[i] * k +
      result * (1 - k);
  }

  return result;
}

// ================= RSI =================

function rsi(values, period = 14) {

  if (
    !values ||
    values.length <= period
  ) {
    return null;
  }

  let gains = 0;

  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {

    const diff =
      values[i] - values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }

  if (losses === 0) {
    return 100;
  }

  const rs = gains / losses;

  return 100 - 100 / (1 + rs);
}

// ================= SUPPORT / RESISTANCE =================

function findSupportResistance(candles) {

  const recent = candles.slice(-50);

  return {
    support: Math.min(
      ...recent.map((c) => c.low)
    ),

    resistance: Math.max(
      ...recent.map((c) => c.high)
    ),
  };
}

// ================= GOLD =================

async function getGoldPrice() {

  const res = await fetch(
    "https://api.gold-api.com/price/XAU"
  );

  const data = await res.json();

  if (!data || !data.price) {
    throw new Error(
      "Không lấy được giá vàng"
    );
  }

  return Number(data.price);
}

// ================= MARKET CONTEXT =================

async function getMarketContext(symbol) {

  // ===== GOLD =====

  if (symbol === "XAUUSD") {

    const price =
      await getGoldPrice();

    return {
      symbol: "XAUUSD",
      timeframe: "H1",
      price,
      ema20: null,
      ema50: null,
      ema200: null,
      rsi14: null,
      support: price - 20,
      resistance: price + 20,
    };
  }

  // ===== BINANCE =====

  const candles =
    await getBinanceKlines(
      symbol,
      "1h",
      200
    );

  const closes =
    candles.map((c) => c.close);

  const last =
    candles[candles.length - 1];

  const ema20 = ema(
    closes.slice(-80),
    20
  );

  const ema50 = ema(
    closes.slice(-120),
    50
  );

  const ema200 = ema(
    closes,
    200
  );

  const rsi14 = rsi(
    closes,
    14
  );

  const {
    support,
    resistance,
  } =
    findSupportResistance(
      candles
    );

  return {
    symbol,
    timeframe: "H1",
    price: last.close,
    ema20,
    ema50,
    ema200,
    rsi14,
    support,
    resistance,
  };
}

// ================= FORMAT =================

function fmt(n) {

  if (
    n === null ||
    n === undefined ||
    Number.isNaN(Number(n))
  ) {
    return "N/A";
  }

  const num = Number(n);

  if (num >= 1000) {
    return num.toFixed(2);
  }

  if (num >= 1) {
    return num.toFixed(4);
  }

  return num.toFixed(8);
}

// ================= OPENAI =================

async function askChatGPT(
  userMessage,
  symbol
) {

  const data =
    await getMarketContext(
      symbol
    );

  const marketContext = `
DỮ LIỆU:

- Symbol: ${data.symbol}
- Giá: ${fmt(data.price)}
- EMA20: ${fmt(data.ema20)}
- EMA50: ${fmt(data.ema50)}
- EMA200: ${fmt(data.ema200)}
- RSI14: ${fmt(data.rsi14)}
- Support: ${fmt(data.support)}
- Resistance: ${fmt(data.resistance)}

Yêu cầu:
- Chỉ chọn 1 hướng:
LONG hoặc SHORT hoặc CHỜ.
- Không được đưa cả 2.
- Trả lời ngắn gọn.
`;

  const response =
    await openai.responses.create({
      model: AI_MODEL,

      instructions:
        SYSTEM_PROMPT,

      input: `
User:
${userMessage}

${marketContext}
`,

      max_output_tokens: 350,
    });

  return (
    response.output_text ||
    "Bot chưa phân tích được."
  );
}

// ================= COMMAND =================

bot.start(async (ctx) => {
  await ctx.reply(
    "AI Market Bot Online ✅"
  );
});

bot.command(
  "ping",
  async (ctx) => {
    await ctx.reply("pong ✅");
  }
);

// ================= MAIN =================

bot.on(
  "text",
  async (ctx) => {

    try {

      const text =
        ctx.message.text;

      if (!text) return;

      // bỏ command

      if (
        text.startsWith("/")
      ) {
        return;
      }

      const lower =
        text.toLowerCase();

      // phải có chữ bot

      if (
        !lower.includes("bot")
      ) {
        return;
      }

      // detect symbol

      const symbol =
        await detectSymbol(
          text
        );

      // không có coin

      if (!symbol) {
        return;
      }

      await ctx.sendChatAction(
        "typing"
      );

      const answer =
        await askChatGPT(
          text,
          symbol
        );

      await ctx.reply(
        answer,
        {
          reply_to_message_id:
            ctx.message.message_id,
        }
      );

    } catch (error) {

      console.error(
        "BOT_ERROR:",
        error
      );

      await ctx.reply(
        "Bot lỗi tạm thời."
      );
    }
  }
);

// ================= EXPRESS =================

app.get(
  "/",
  (_req, res) => {
    res.send(
      "AI Market Bot Running"
    );
  }
);

app.get(
  "/health",
  (_req, res) => {
    res.json({
      ok: true,
    });
  }
);

// ================= START =================

app.listen(PORT, () => {

  console.log(
    `Server running on port ${PORT}`
  );
});

bot.launch();

console.log(
  "Telegram AI Market Bot launched"
);

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);