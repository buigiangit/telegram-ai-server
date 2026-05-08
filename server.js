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
const AI_MODEL = process.env.AI_MODEL || "gpt-4.1-mini";

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

const bot = new Telegraf(BOT_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

let BOT_ENABLED = true;

const USER_COOLDOWN_MS = 15 * 1000;
const userCooldown = new Map();

let BINANCE_SYMBOL_CACHE = [];
let BINANCE_SYMBOL_CACHE_TIME = 0;

// ================= PROMPT =================

const SYSTEM_PROMPT = `
Bạn là AI phân tích crypto cho cộng đồng trader.

Quy tắc:
- Trả lời ngắn gọn, thực chiến.
- Chỉ chọn 1 hướng: LONG hoặc SHORT hoặc CHỜ.
- Không được đưa cả LONG và SHORT cùng lúc.
- Không lan man.
- Không giải thích dài dòng.
- Nếu mode là DEFAULT thì KHÔNG ghi dòng mode.
- Nếu mode là SCALP hoặc SWING thì phải hiện mode.
- SCALP: ưu tiên M15/H1, entry sát, TP ngắn.
- SWING: ưu tiên H4/D1, entry rộng hơn, TP xa hơn.
- Funding dương cao: thị trường nghiêng về LONG đông, cẩn thận long squeeze.
- Funding âm sâu: thị trường nghiêng về SHORT đông, cẩn thận short squeeze.
- Giá tăng + OI tăng: dòng tiền futures ủng hộ xu hướng tăng.
- Giá tăng + OI giảm: có thể chỉ là short cover, pump yếu.
- Giá giảm + OI tăng: phe short mở thêm, áp lực giảm mạnh hơn.
- Giá giảm + OI giảm: có thể là đóng vị thế, xu hướng yếu dần.
- Nếu chọn CHỜ thì:
  + Không ghi Entry/SL/TP
  + Chỉ ghi lý do chờ.
- Nếu chọn LONG hoặc SHORT:
  + Bắt buộc có Entry, SL, TP1, TP2.
- Không cam kết chắc chắn.
- Không dùng markdown kiểu ###.
- Không dùng code block.

FORMAT CHUẨN:

Nếu mode là SCALP hoặc SWING:

❇️ Mode: SCALP hoặc SWING

❇️ Nhận định:
👉 Viết 1 đoạn ngắn gọn, chuyên nghiệp. Có nhắc Funding/OI nếu dữ liệu có ý nghĩa.

❗️Khuyến nghị:
🔵 Long
hoặc
🔴 Short
hoặc
🟡 Chờ

Nếu là LONG hoặc SHORT thì thêm:

👉 Entry:
👉 SL:
👉 TP1:
👉 TP2:

Nếu mode là DEFAULT thì KHÔNG hiện mục Mode.

Dòng cuối luôn là:

⚠️ Tham khảo, không phải lời khuyên đầu tư.
`;

// ================= MODE =================

function detectTradeMode(text) {
  const lower = String(text || "").toLowerCase();

  if (
    lower.includes("scalp") ||
    lower.includes("scalping") ||
    lower.includes("lướt") ||
    lower.includes("luot") ||
    lower.includes("đánh nhanh") ||
    lower.includes("danh nhanh")
  ) {
    return "SCALP";
  }

  if (
    lower.includes("swing") ||
    lower.includes("trung hạn") ||
    lower.includes("trung han") ||
    lower.includes("giữ lệnh") ||
    lower.includes("giu lenh")
  ) {
    return "SWING";
  }

  return "DEFAULT";
}

function getModeConfig(mode) {
  if (mode === "SCALP") {
    return {
      mode: "SCALP",
      intervals: [
        { interval: "15m", label: "M15" },
        { interval: "1h", label: "H1" },
      ],
      rule: `
MODE SCALP:
- Ưu tiên xu hướng H1.
- Dùng M15 để chọn Entry.
- Entry phải sát vùng hỗ trợ/kháng cự gần.
- TP ngắn hơn, SL chặt hơn.
- Funding/OI dùng để tránh vào lệnh ngược đám đông quá nóng.
- Nếu giá đang giữa range, ưu tiên CHỜ.
`,
    };
  }

  if (mode === "SWING") {
    return {
      mode: "SWING",
      intervals: [
        { interval: "4h", label: "H4" },
        { interval: "1d", label: "D1" },
      ],
      rule: `
MODE SWING:
- Ưu tiên xu hướng D1.
- Dùng H4 để chọn Entry.
- Entry có thể rộng hơn.
- TP xa hơn, SL rộng hơn.
- Funding/OI dùng để xác nhận dòng tiền futures.
- Bỏ nhiễu ngắn hạn M15/H1.
`,
    };
  }

  return {
    mode: "DEFAULT",
    intervals: [
      { interval: "1h", label: "H1" },
      { interval: "4h", label: "H4" },
      { interval: "1d", label: "D1" },
    ],
    rule: `
MODE DEFAULT:
- Ưu tiên xu hướng D1 và H4.
- Dùng H1 để chọn vùng Entry.
- Funding/OI dùng để đánh giá tâm lý futures.
`,
  };
}

// ================= ADMIN =================

function isAdmin(ctx) {
  const adminIds = (process.env.ADMIN_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  if (adminIds.length === 0) return true;
  return adminIds.includes(String(ctx.from?.id));
}

// ================= SYMBOL =================

async function getBinanceSymbols() {
  const res = await fetch("https://api.binance.com/api/v3/exchangeInfo");
  const data = await res.json();

  if (!data || !Array.isArray(data.symbols)) {
    throw new Error("Không lấy được danh sách Binance");
  }

  return data.symbols
    .filter((s) => s.status === "TRADING")
    .map((s) => s.symbol);
}

async function getCachedBinanceSymbols() {
  const now = Date.now();

  if (
    BINANCE_SYMBOL_CACHE.length > 0 &&
    now - BINANCE_SYMBOL_CACHE_TIME < 6 * 60 * 60 * 1000
  ) {
    return BINANCE_SYMBOL_CACHE;
  }

  BINANCE_SYMBOL_CACHE = await getBinanceSymbols();
  BINANCE_SYMBOL_CACHE_TIME = now;
  return BINANCE_SYMBOL_CACHE;
}

async function detectSymbol(text) {
  if (!text) return null;

  const upper = text.toUpperCase();

  const specialMap = [
    {
      keywords: ["XAU", "GOLD", "VANG", "VÀNG"],
      symbol: "XAUUSD",
    },
    {
      keywords: ["OIL", "DAU", "DẦU", "WTI", "USOIL"],
      symbol: "USOIL",
    },
  ];

  for (const item of specialMap) {
    for (const key of item.keywords) {
      const regex = new RegExp(`\\b${key}\\b`, "i");
      if (regex.test(upper)) return item.symbol;
    }
  }

  const binanceSymbols = await getCachedBinanceSymbols();

  const fullPairMatch = upper.match(/\b([A-Z0-9]{2,20}USDT)\b/);
  if (fullPairMatch) {
    const pair = fullPairMatch[1];
    if (binanceSymbols.includes(pair)) return pair;
  }

  const words = upper.match(/\b[A-Z0-9]{2,15}\b/g) || [];

  const ignoreWords = [
    "BOT",
    "AI",
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
    "GIUP",
    "GIÚP",
    "XEM",
    "SCALP",
    "SCALPING",
    "SWING",
  ];

  for (const word of words) {
    if (ignoreWords.includes(word)) continue;

    const pair = `${word}USDT`;

    if (binanceSymbols.includes(pair)) return pair;
  }

  return null;
}

// ================= MARKET DATA =================

async function getBinanceKlines(symbol, interval = "1h", limit = 250) {
  const url =
    `https://api.binance.com/api/v3/klines` +
    `?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!Array.isArray(data)) {
    throw new Error(`Không lấy được dữ liệu ${symbol}`);
  }

  return data.map((k) => ({
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

async function getFundingRate(symbol) {
  try {
    const url =
      `https://fapi.binance.com/fapi/v1/fundingRate` +
      `?symbol=${symbol}&limit=1`;

    const res = await fetch(url);
    const data = await res.json();

    if (!Array.isArray(data) || !data.length) return null;

    return Number(data[0].fundingRate);
  } catch (error) {
    console.error("FUNDING_ERROR:", error);
    return null;
  }
}

async function getOpenInterest(symbol) {
  try {
    const url =
      `https://fapi.binance.com/fapi/v1/openInterest` +
      `?symbol=${symbol}`;

    const res = await fetch(url);
    const data = await res.json();

    if (!data || data.openInterest === undefined) return null;

    return Number(data.openInterest);
  } catch (error) {
    console.error("OI_ERROR:", error);
    return null;
  }
}

async function getOpenInterestStats(symbol) {
  try {
    const url =
      `https://fapi.binance.com/futures/data/openInterestHist` +
      `?symbol=${symbol}&period=1h&limit=2`;

    const res = await fetch(url);
    const data = await res.json();

    if (!Array.isArray(data) || data.length < 2) {
      return {
        oiChangePct1h: null,
      };
    }

    const prev = Number(data[0].sumOpenInterest);
    const now = Number(data[1].sumOpenInterest);

    if (!prev || !now) {
      return {
        oiChangePct1h: null,
      };
    }

    return {
      oiChangePct1h: ((now - prev) / prev) * 100,
    };
  } catch (error) {
    console.error("OI_HIST_ERROR:", error);
    return {
      oiChangePct1h: null,
    };
  }
}

async function getGoldPrice() {
  const res = await fetch("https://api.gold-api.com/price/XAU");
  const data = await res.json();

  if (!data || !data.price) {
    throw new Error("Không lấy được giá vàng");
  }

  return Number(data.price);
}

// ================= INDICATORS =================

function ema(values, period) {
  if (!values || values.length < period) return null;

  const k = 2 / (period + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {
  if (!values || values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  if (losses === 0) return 100;

  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function macd(values) {
  if (!values || values.length < 35) {
    return {
      macdLine: null,
      signalLine: null,
      histogram: null,
    };
  }

  const ema12 = [];
  const ema26 = [];

  for (let i = 26; i <= values.length; i++) {
    ema12.push(ema(values.slice(0, i), 12));
    ema26.push(ema(values.slice(0, i), 26));
  }

  const macdLineArr = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ema(macdLineArr, 9);
  const macdLine = macdLineArr[macdLineArr.length - 1];
  const histogram = macdLine - signalLine;

  return { macdLine, signalLine, histogram };
}

function findSupportResistance(candles) {
  const recent = candles.slice(-80);

  return {
    support: Math.min(...recent.map((c) => c.low)),
    resistance: Math.max(...recent.map((c) => c.high)),
  };
}

function avgVolume(candles, period = 20) {
  const recent = candles.slice(-period);
  const sum = recent.reduce((acc, c) => acc + c.volume, 0);
  return sum / recent.length;
}

function analyzeTimeframe(candles, label) {
  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1];

  const ema20 = ema(closes.slice(-80), 20);
  const ema50 = ema(closes.slice(-120), 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const macdData = macd(closes);
  const { support, resistance } = findSupportResistance(candles);
  const avgVol20 = avgVolume(candles, 20);

  return {
    tf: label,
    price: last.close,
    ema20,
    ema50,
    ema200,
    rsi14,
    macdLine: macdData.macdLine,
    macdSignal: macdData.signalLine,
    macdHist: macdData.histogram,
    volume: last.volume,
    avgVol20,
    support,
    resistance,
  };
}

// ================= CONTEXT =================

async function getMarketContext(symbol, mode = "DEFAULT") {
  const modeConfig = getModeConfig(mode);

  if (symbol === "XAUUSD") {
    const price = await getGoldPrice();

    return {
      symbol: "XAUUSD",
      mode: modeConfig.mode,
      modeRule: modeConfig.rule,
      note: "XAU dùng giá tham khảo, chưa có Funding/OI.",
      fundingRate: null,
      openInterest: null,
      oiChangePct1h: null,
      frames: [
        {
          tf: modeConfig.mode === "SCALP" ? "M15/H1 proxy" : "H1 proxy",
          price,
          ema20: null,
          ema50: null,
          ema200: null,
          rsi14: null,
          macdLine: null,
          macdSignal: null,
          macdHist: null,
          volume: null,
          avgVol20: null,
          support: price - 20,
          resistance: price + 20,
        },
      ],
    };
  }

  if (symbol === "USOIL") {
    throw new Error("Dầu chưa có nguồn dữ liệu ổn định trong bản này.");
  }

  const [fundingRate, openInterest, oiStats, ...candleResults] =
    await Promise.all([
      getFundingRate(symbol),
      getOpenInterest(symbol),
      getOpenInterestStats(symbol),
      ...modeConfig.intervals.map((item) =>
        getBinanceKlines(symbol, item.interval, 250).then((candles) => ({
          label: item.label,
          candles,
        }))
      ),
    ]);

  return {
    symbol,
    mode: modeConfig.mode,
    modeRule: modeConfig.rule,
    note: "",
    fundingRate,
    openInterest,
    oiChangePct1h: oiStats?.oiChangePct1h ?? null,
    frames: candleResults.map((item) =>
      analyzeTimeframe(item.candles, item.label)
    ),
  };
}

// ================= FORMAT =================

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "N/A";

  const num = Number(n);

  if (num >= 1000) return num.toFixed(2);
  if (num >= 1) return num.toFixed(4);
  return num.toFixed(8);
}

function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "N/A";
  return `${Number(n).toFixed(4)}%`;
}

function frameText(f) {
  return `
[${f.tf}]
- Giá: ${fmt(f.price)}
- EMA20: ${fmt(f.ema20)}
- EMA50: ${fmt(f.ema50)}
- EMA200: ${fmt(f.ema200)}
- RSI14: ${fmt(f.rsi14)}
- MACD: ${fmt(f.macdLine)}
- MACD Signal: ${fmt(f.macdSignal)}
- MACD Hist: ${fmt(f.macdHist)}
- Volume: ${fmt(f.volume)}
- AvgVol20: ${fmt(f.avgVol20)}
- Support: ${fmt(f.support)}
- Resistance: ${fmt(f.resistance)}
`;
}

// ================= OPENAI =================

async function askChatGPT(userMessage, symbol, mode) {
  const data = await getMarketContext(symbol, mode);

  const marketContext = `
DỮ LIỆU MARKET:
Symbol: ${data.symbol}
Mode: ${data.mode}
Ghi chú: ${data.note || "Không có"}

Funding Rate: ${fmtPct(data.fundingRate == null ? null : data.fundingRate * 100)}
Open Interest: ${fmt(data.openInterest)}
OI Change 1H: ${fmtPct(data.oiChangePct1h)}

${data.modeRule}

${data.frames.map(frameText).join("\n")}

Yêu cầu:
- Bắt buộc format đúng mẫu.
- Nếu Mode DEFAULT thì không hiện mục Mode.
- Nếu Mode SCALP hoặc SWING thì hiện Mode.
- Phải dùng Funding Rate và Open Interest để đánh giá tâm lý futures nếu dữ liệu khác N/A.
- Nếu Funding dương cao và OI tăng nóng thì hạn chế FOMO LONG.
- Nếu Funding âm sâu và OI tăng nóng thì cẩn thận SHORT squeeze.
- Nếu LONG/SHORT phải có Entry, SL, TP1, TP2.
- Nếu CHỜ thì không ghi Entry/SL/TP.
- Trả lời đẹp, dễ đọc như bài phân tích trader chuyên nghiệp.
`;

  const response = await openai.responses.create({
    model: AI_MODEL,
    instructions: SYSTEM_PROMPT,
    input: `
User hỏi:
${userMessage}

${marketContext}
`,
    max_output_tokens: 500,
  });

  return response.output_text || "Bot chưa phân tích được.";
}

// ================= COMMANDS =================

bot.start(async (ctx) => {
  await ctx.reply("AI Market Bot Online ✅");
});

bot.command("ping", async (ctx) => {
  await ctx.reply("pong ✅");
});

bot.command("on", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Bạn không có quyền dùng lệnh này.");

  BOT_ENABLED = true;
  await ctx.reply("Bot đã bật ✅");
});

bot.command("off", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Bạn không có quyền dùng lệnh này.");

  BOT_ENABLED = false;
  await ctx.reply("Bot đã tắt trả lời phân tích ⛔");
});

bot.command("status", async (ctx) => {
  await ctx.reply(
    `Bot status: ${BOT_ENABLED ? "ON ✅" : "OFF ⛔"}\n` +
      `Cooldown: ${USER_COOLDOWN_MS / 1000}s/user\n` +
      `Model: ${AI_MODEL}`
  );
});

// ================= MAIN =================

bot.on("text", async (ctx) => {
  try {
    const text = ctx.message.text;

    if (!text) return;
    if (text.startsWith("/")) return;

    if (!BOT_ENABLED) return;

    const lower = text.toLowerCase();

    if (!lower.includes("bot")) return;

    const userId = String(ctx.from?.id || "unknown");
    const now = Date.now();
    const lastTime = userCooldown.get(userId) || 0;

    if (now - lastTime < USER_COOLDOWN_MS) {
      const wait = Math.ceil((USER_COOLDOWN_MS - (now - lastTime)) / 1000);
      return ctx.reply(`Chờ ${wait}s nữa rồi hỏi tiếp nhé.`);
    }

    userCooldown.set(userId, now);

    const symbol = await detectSymbol(text);
    if (!symbol) return;

    const mode = detectTradeMode(text);

    await ctx.sendChatAction("typing");

    const answer = await askChatGPT(text, symbol, mode);

    await ctx.reply(answer, {
      reply_to_message_id: ctx.message.message_id,
    });
  } catch (error) {
    console.error("BOT_ERROR:", error);
    await ctx.reply("Bot lỗi tạm thời.");
  }
});

// ================= EXPRESS =================

app.get("/", (_req, res) => {
  res.send("AI Market Bot Running");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    bot: BOT_ENABLED ? "ON" : "OFF",
  });
});

// ================= START =================

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

bot
  .launch()
  .then(() => {
    console.log("Telegram AI Market Bot launched");
  })
  .catch((err) => {
    console.error("BOT_LAUNCH_ERROR:", err);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
