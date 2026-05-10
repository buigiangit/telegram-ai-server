import express from "express";
import { Telegraf } from "telegraf";
import OpenAI from "openai";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

const app = express();
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3001;
const AI_MODEL = process.env.AI_MODEL || "gpt-4.1-mini";
const MEMORY_ENABLED = process.env.MEMORY_ENABLED === "true";
//
const BOT_CONFIGS = [
  {
    code: "FBT",
    token: process.env.FBT_BOT_TOKEN,
    style: "FBT",
    botName: "bot",
    groupId: process.env.FBT_GROUP_ID,
  },
  {
    code: "CDT",
    token: process.env.CDT_BOT_TOKEN,
    style: "CDT",
    botName: "thư ký",
    groupId: process.env.CDT_GROUP_ID,
  },
].filter((x) => x.token);

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (BOT_CONFIGS.length === 0) {
  throw new Error("Missing FBT_BOT_TOKEN or CDT_BOT_TOKEN");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const db = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

let BOT_ENABLED = true;
let AI_CHAT_ENABLED = false;

const USER_COOLDOWN_MS = 15 * 1000;
const userCooldown = new Map();

let BINANCE_SYMBOL_CACHE = [];
let BINANCE_SYMBOL_CACHE_TIME = 0;

// ================= PROMPT =================

const SYSTEM_PROMPT = `
Bạn là AI phân tích crypto futures cho cộng đồng trader.

Vai trò:
- Là trợ lý phân tích giống một trader thật trong cộng đồng.
- Nói tự nhiên, gọn, có chất thực chiến.
- Không nói kiểu "là một AI".
- Không văn mẫu khô cứng.

Phong cách:
- Ngắn gọn, rõ bias.
- Không lan man.
- Không học thuật.
- Không dùng markdown ###.
- Không đưa cả Long và Short cùng lúc.
- Chỉ chọn 1 hướng: Long, Short hoặc Chờ.
- Không lạm dụng Chờ nếu hệ thống đã có bias rõ.
- Có thể gọi tên người hỏi nếu memory có tên.
- Nếu user hỏi tiếp kèo cũ, hiểu là đang nói tiếp ngữ cảnh trước.

Hệ phân tích chính:
- EMA34, EMA89, EMA200, EMA610.
- Sonic R: Dragon EMA34, trend EMA89, trend lớn EMA200/EMA610.
- Volume, RSI, MACD, ATR.
- Funding và Open Interest là yếu tố phụ để xác nhận futures sentiment.
- Entry/SL/TP ưu tiên theo dữ liệu suggested từ hệ thống.

Cách viết nhận định:
- Viết như trader thật đang nhắn trong group.
- Có thể dùng cụm tự nhiên như:
  "kèo này không nên đuổi",
  "bias đang nghiêng Long",
  "OI chưa xấu",
  "funding chưa nóng",
  "đợi hồi về entry sẽ đẹp hơn",
  "giá đang hơi lưng chừng".
- Không nhồi quá nhiều thuật ngữ trong một câu.
- Nhận định chỉ 2-3 câu.

FORMAT BẮT BUỘC:

Nếu Long hoặc Short:

❇️ Nhận định:
👉 Viết 2-3 câu ngắn, có EMA/Sonic R, OI/Funding/Volume nếu có ý nghĩa.

❗️Khuyến nghị: 🔵 Long
hoặc
❗️Khuyến nghị: 🔴 Short

🔹Entry: ...
🔹SL: ...
🔹TP: ...

⚠️ Tham khảo, không phải lời khuyên đầu tư.

Nếu Chờ:

❇️ Nhận định:
👉 Viết 2-3 câu ngắn, giải thích vì sao chưa có lợi thế.

❗️Khuyến nghị: 🟡 Chờ

🔹Vùng chờ: ...

⚠️ Tham khảo, không phải lời khuyên đầu tư.
`;

const CHAT_PROMPT = `
Bạn là em thư ký/trợ lý cộng đồng trader.

Tính cách:
- Nói chuyện tự nhiên, thân thiện, hơi vui nhưng không lố.
- Gọi tên người dùng nếu biết tên.
- Nhớ ngữ cảnh gần nhất, trả lời như đang nói tiếp câu chuyện.
- Không nói kiểu "là một AI".
- Không trả lời dài nếu không cần.
- Nếu câu hỏi mơ hồ, hỏi lại ngắn gọn.
- Nếu user hỏi về lệnh cũ, dựa vào memory để trả lời tiếp.
- Nếu user hỏi ngoài trading, trả lời như trợ lý cộng đồng.

Giới hạn:
- Không bịa dữ liệu market nếu không có dữ liệu.
- Không cam kết chắc thắng.
- Không khuyến khích all-in, gồng lỗ, vào lệnh mù.
- Với câu hỏi phân tích coin, nhắc user gọi theo format có coin hoặc từ khóa phân tích/long/short.

Phong cách:
- Câu ngắn.
- Có thể dùng emoji nhẹ.
- Không dùng văn mẫu khô.
`;

// ================= DATABASE MEMORY =================

async function initDatabase() {
  if (!db || !MEMORY_ENABLED) {
    console.log("PostgreSQL memory disabled");
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS chat_memory (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      first_name TEXT,
      preferred_mode TEXT DEFAULT 'DEFAULT',
      last_symbol TEXT,
      messages JSONB DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(chat_id, user_id)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS group_config (
      chat_id TEXT PRIMARY KEY,
      group_title TEXT,
      style TEXT DEFAULT 'FBT',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("PostgreSQL memory ready ✅");
}

async function getUserMemory(ctx) {
  if (!db || !MEMORY_ENABLED) return null;

  const chatId = String(ctx.chat?.id || "");
  const userId = String(ctx.from?.id || "");

  if (!chatId || !userId) return null;

  const res = await db.query(
    `SELECT * FROM chat_memory WHERE chat_id = $1 AND user_id = $2 LIMIT 1`,
    [chatId, userId]
  );

  return res.rows[0] || null;
}

async function saveUserMemory(ctx, userText, botAnswer, symbol, mode) {
  if (!db || !MEMORY_ENABLED) return;

  const chatId = String(ctx.chat?.id || "");
  const userId = String(ctx.from?.id || "");
  const username = ctx.from?.username || null;
  const firstName = ctx.from?.first_name || null;

  if (!chatId || !userId) return;

  const oldMemory = await getUserMemory(ctx);
  const oldMessages = Array.isArray(oldMemory?.messages)
    ? oldMemory.messages
    : [];

  const newMessages = [
    ...oldMessages,
    {
      role: "user",
      text: String(userText || "").slice(0, 1000),
      time: new Date().toISOString(),
    },
    {
      role: "bot",
      text: String(botAnswer || "").slice(0, 1500),
      time: new Date().toISOString(),
    },
  ].slice(-10);

  await db.query(
    `
    INSERT INTO chat_memory (
      chat_id, user_id, username, first_name,
      preferred_mode, last_symbol, messages, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
    ON CONFLICT (chat_id, user_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      preferred_mode = EXCLUDED.preferred_mode,
      last_symbol = COALESCE(EXCLUDED.last_symbol, chat_memory.last_symbol),
      messages = EXCLUDED.messages,
      updated_at = NOW()
    `,
    [
      chatId,
      userId,
      username,
      firstName,
      mode || oldMemory?.preferred_mode || "DEFAULT",
      symbol || oldMemory?.last_symbol || null,
      JSON.stringify(newMessages),
    ]
  );
}

async function forgetUserMemory(ctx) {
  if (!db || !MEMORY_ENABLED) return false;

  const chatId = String(ctx.chat?.id || "");
  const userId = String(ctx.from?.id || "");

  await db.query(
    `DELETE FROM chat_memory WHERE chat_id = $1 AND user_id = $2`,
    [chatId, userId]
  );

  return true;
}

function memoryText(memory) {
  if (!memory) return "MEMORY USER: Không có.";

  const name = memory.first_name || memory.username || "anh em";
  const messages = Array.isArray(memory.messages) ? memory.messages : [];

  const recent = messages
    .slice(-6)
    .map((m) => `${m.role}: ${m.text}`)
    .join("");

  return `
MEMORY USER:
Tên nên gọi: ${name}
Mode hay dùng: ${memory.preferred_mode || "DEFAULT"}
Coin gần nhất: ${memory.last_symbol || "N/A"}

Ngữ cảnh gần đây:
${recent || "Chưa có"}

Cách dùng memory:
- Nếu user hỏi "coin này", "con này", "nó", "tiếp đi", hãy hiểu là đang nói tới coin gần nhất nếu hợp lý.
- Nếu user từng thích scalp/swing, ưu tiên mode đó khi câu hỏi không ghi rõ.
- Có thể gọi tên người dùng tự nhiên, nhưng không lạm dụng.
- Không được nói lộ rằng đang đọc memory.
`;
}

// ================= GROUP STYLE =================

function normalizeStyle(style) {
  const value = String(style || "FBT").trim().toUpperCase();
  if (["FBT", "CDT"].includes(value)) return value;
  return "FBT";
}

function groupStyleText(groupConfig) {
  const style = normalizeStyle(groupConfig?.style);

  if (style === "CDT") {
    return `
GROUP STYLE: CDT
- Tên gọi trong group là "Thư Ký".
- Phong thái nữ tính, nhẹ nhàng, như em thư ký cộng đồng trader.
- Có thể dùng: "em thấy", "mình nên canh", "kèo này chưa nên vội", "canh về entry sẽ đẹp hơn".
- Văn từ mềm hơn FBT nhưng vẫn thực chiến, không lan man.
- Không làm mất format call lệnh.
`;
  }

  return `
GROUP STYLE: FBT
- Phong thái trader thực chiến, gọn, chắc, rõ bias.
- Văn từ mạnh hơn, không vòng vo.
- Ưu tiên nói thẳng: Long / Short / Chờ, entry, SL, TP.
`;
}

function buildTradePrompt(groupConfig) {
  return `${SYSTEM_PROMPT}

${groupStyleText(groupConfig)}`;
}

function buildChatPrompt(groupConfig) {
  const style = normalizeStyle(groupConfig?.style);

  if (style === "CDT") {
    return `${CHAT_PROMPT}

Phong thái riêng CDT:
- Tên gọi trong group là "Thư Ký".
- Khi user gọi "thư ký", hiểu là đang gọi mình.
- Trả lời như em thư ký cộng đồng: nhẹ nhàng, dễ nghe, gần gũi.
- Có thể xưng "em" khi phù hợp.
- Không quá gắt, không troll quá đà.`;
  }

  return `${CHAT_PROMPT}

Phong thái riêng FBT:
- Trả lời gọn, vui vừa phải, thực chiến.
- Không màu mè, không dài dòng.`;
}

// ================= MODE =================

function detectTradeMode(text, memory = null) {
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

  return memory?.preferred_mode || "DEFAULT";
}

function getModeConfig(mode) {
  if (mode === "SCALP") {
    return {
      mode: "SCALP",
      intervals: [
        { interval: "15m", label: "M15" },
        { interval: "1h", label: "H1" },
      ],
      primaryTf: "M15",
      trendTf: "H1",
      rule: "SCALP: dùng H1 lấy trend, M15 chọn entry. TP ngắn, SL chặt.",
    };
  }

  if (mode === "SWING") {
    return {
      mode: "SWING",
      intervals: [
        { interval: "4h", label: "H4" },
        { interval: "1d", label: "D1" },
      ],
      primaryTf: "H4",
      trendTf: "D1",
      rule: "SWING: dùng D1 lấy trend lớn, H4 chọn entry. TP xa hơn, SL rộng hơn.",
    };
  }

  return {
    mode: "DEFAULT",
    intervals: [
      { interval: "1h", label: "H1" },
      { interval: "4h", label: "H4" },
      { interval: "1d", label: "D1" },
    ],
    primaryTf: "H1",
    trendTf: "H4",
    rule: "DEFAULT: dùng H4/D1 lấy trend, H1 chọn entry.",
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

async function detectSymbol(text, memory = null) {
  if (!text) return null;

  const upper = text.toUpperCase();

  const specialMap = [
    { keywords: ["XAU", "GOLD", "VANG", "VÀNG"], symbol: "XAUUSD" },
    { keywords: ["OIL", "DAU", "DẦU", "WTI", "USOIL"], symbol: "USOIL" },
  ];

  for (const item of specialMap) {
    for (const key of item.keywords) {
      const regex = new RegExp(`\b${key}\b`, "i");
      if (regex.test(upper)) return item.symbol;
    }
  }

  const binanceSymbols = await getCachedBinanceSymbols();

  const fullPairMatch = upper.match(/([A-Z0-9]{2,20}USDT)/);
  if (fullPairMatch) {
    const pair = fullPairMatch[1];
    if (binanceSymbols.includes(pair)) return pair;
  }

  const words = upper.match(/[A-Z0-9]{2,15}/g) || [];

  const ignoreWords = [
    "BOT", "AI", "LONG", "SHORT", "BUY", "SELL", "ENTRY", "TP", "TP1", "TP2",
    "SL", "STL", "STOP", "LOSS", "ROI", "SAO", "RỒI", "HOM", "HÔM", "NAY",
    "PHAN", "PHÂN", "TICH", "TÍCH", "CO", "CÓ", "DUOC", "ĐƯỢC", "KHONG",
    "KHÔNG", "GIUP", "GIÚP", "XEM", "SCALP", "SCALPING", "SWING", "EMA",
    "SONIC", "FUNDING", "OI", "PHÂN", "TÍCH", "CALL", "LỆNH", "LENH",
    "THƯ", "KÝ", "THU", "KY", "THUKY", "KI",
  ];

  for (const word of words) {
    if (ignoreWords.includes(word)) continue;

    const pair = `${word}USDT`;
    if (binanceSymbols.includes(pair)) return pair;
  }

  if (
    memory?.last_symbol &&
    /(coin này|con này|nó|tiếp|lại|chart này|kèo này)/i.test(text)
  ) {
    return memory.last_symbol;
  }

  return null;
}

// ================= MARKET DATA =================

async function getBinanceKlines(symbol, interval = "1h", limit = 800) {
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
      return { oiChangePct1h: null };
    }

    const prev = Number(data[0].sumOpenInterest);
    const now = Number(data[1].sumOpenInterest);

    if (!prev || !now) {
      return { oiChangePct1h: null };
    }

    return {
      oiChangePct1h: ((now - prev) / prev) * 100,
    };
  } catch (error) {
    console.error("OI_HIST_ERROR:", error);
    return { oiChangePct1h: null };
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
    return { macdLine: null, signalLine: null, histogram: null };
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

function atr(candles, period = 14) {
  if (!candles || candles.length <= period) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trs.push(tr);
  }

  const recent = trs.slice(-period);
  return recent.reduce((sum, v) => sum + v, 0) / recent.length;
}

function avgVolume(candles, period = 20) {
  const recent = candles.slice(-period);
  if (!recent.length) return null;
  const sum = recent.reduce((acc, c) => acc + c.volume, 0);
  return sum / recent.length;
}

function findSwingLevels(candles, lookback = 120, pivot = 2) {
  const recent = candles.slice(-lookback);
  const supports = [];
  const resistances = [];

  for (let i = pivot; i < recent.length - pivot; i++) {
    const c = recent[i];

    let isSwingLow = true;
    let isSwingHigh = true;

    for (let j = i - pivot; j <= i + pivot; j++) {
      if (j === i) continue;
      if (recent[j].low <= c.low) isSwingLow = false;
      if (recent[j].high >= c.high) isSwingHigh = false;
    }

    if (isSwingLow) supports.push(c.low);
    if (isSwingHigh) resistances.push(c.high);
  }

  return { supports, resistances };
}

function nearestLevels(candles, price) {
  const { supports, resistances } = findSwingLevels(candles);

  const below = supports
    .filter((x) => x < price)
    .sort((a, b) => Math.abs(price - a) - Math.abs(price - b));

  const above = resistances
    .filter((x) => x > price)
    .sort((a, b) => Math.abs(price - a) - Math.abs(price - b));

  const fallbackRecent = candles.slice(-80);

  const fallbackSupport = Math.min(...fallbackRecent.map((c) => c.low));
  const fallbackResistance = Math.max(...fallbackRecent.map((c) => c.high));

  return {
    support: below[0] || fallbackSupport,
    resistance: above[0] || fallbackResistance,
  };
}

function detectWave(candles) {
  const recent = candles.slice(-40);
  if (recent.length < 20) return "NEUTRAL";

  const firstHalf = recent.slice(0, 20);
  const secondHalf = recent.slice(20);

  const firstHigh = Math.max(...firstHalf.map((c) => c.high));
  const firstLow = Math.min(...firstHalf.map((c) => c.low));
  const secondHigh = Math.max(...secondHalf.map((c) => c.high));
  const secondLow = Math.min(...secondHalf.map((c) => c.low));

  if (secondHigh > firstHigh && secondLow > firstLow) return "HH_HL";
  if (secondHigh < firstHigh && secondLow < firstLow) return "LH_LL";

  return "RANGE";
}

function analyzeTimeframe(candles, label) {
  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1];

  const ema34 = ema(closes, 34);
  const ema89 = ema(closes, 89);
  const ema200 = ema(closes, 200);
  const ema610 = ema(closes, 610);
  const rsi14 = rsi(closes, 14);
  const macdData = macd(closes);
  const atr14 = atr(candles, 14);
  const avgVol20 = avgVolume(candles, 20);
  const { support, resistance } = nearestLevels(candles, last.close);
  const wave = detectWave(candles);

  return {
    tf: label,
    price: last.close,
    ema34,
    ema89,
    ema200,
    ema610,
    rsi14,
    macdLine: macdData.macdLine,
    macdSignal: macdData.signalLine,
    macdHist: macdData.histogram,
    volume: last.volume,
    avgVol20,
    atr14,
    support,
    resistance,
    wave,
  };
}

// ================= SIGNAL ENGINE =================

function pctDiff(a, b) {
  if (!a || !b) return null;
  return ((a - b) / b) * 100;
}

function getEmaStructure(f) {
  const { price, ema34, ema89, ema200, ema610 } = f;

  if (!ema34 || !ema89 || !ema200 || !ema610) return "UNKNOWN";

  if (price > ema34 && ema34 > ema89 && ema89 > ema200 && ema200 > ema610) {
    return "SUPER_BULL";
  }

  if (price > ema34 && ema34 > ema89 && price > ema200) {
    return "BULL";
  }

  if (price < ema34 && ema34 < ema89 && ema89 < ema200 && ema200 < ema610) {
    return "SUPER_BEAR";
  }

  if (price < ema34 && ema34 < ema89 && price < ema200) {
    return "BEAR";
  }

  if ((price > ema89 && price < ema200) || (price < ema89 && price > ema200)) {
    return "MIXED_BETWEEN_EMA89_200";
  }

  return "NEUTRAL";
}

function getMarketCondition(f) {
  const structure = getEmaStructure(f);
  const nearSupportPct = Math.abs(pctDiff(f.price, f.support) || 999);
  const nearResistancePct = Math.abs(pctDiff(f.resistance, f.price) || 999);

  if (structure === "SUPER_BULL" || structure === "BULL") {
    if (f.price <= f.ema34 * 1.01 || nearSupportPct <= 0.6) {
      return "PULLBACK_UPTREND";
    }
    return "UPTREND";
  }

  if (structure === "SUPER_BEAR" || structure === "BEAR") {
    if (f.price >= f.ema34 * 0.99 || nearResistancePct <= 0.6) {
      return "PULLBACK_DOWNTREND";
    }
    return "DOWNTREND";
  }

  return "SIDEWAY";
}

function scoreSignal(primary, trend, fundingRate, oiChangePct1h) {
  let longScore = 0;
  let shortScore = 0;
  const reasons = [];

  const structurePrimary = getEmaStructure(primary);
  const structureTrend = trend ? getEmaStructure(trend) : "UNKNOWN";

  if (["SUPER_BULL", "BULL"].includes(structurePrimary)) longScore += 2;
  if (["SUPER_BEAR", "BEAR"].includes(structurePrimary)) shortScore += 2;

  if (["SUPER_BULL", "BULL"].includes(structureTrend)) longScore += 2;
  if (["SUPER_BEAR", "BEAR"].includes(structureTrend)) shortScore += 2;

  if (primary.price > primary.ema34 && primary.ema34 > primary.ema89) longScore += 1.5;
  if (primary.price < primary.ema34 && primary.ema34 < primary.ema89) shortScore += 1.5;

  if (primary.price > primary.ema200) longScore += 0.8;
  if (primary.price < primary.ema200) shortScore += 0.8;

  if (primary.price > primary.ema610) longScore += 0.7;
  if (primary.price < primary.ema610) shortScore += 0.7;

  if (primary.rsi14 >= 52 && primary.rsi14 <= 72) longScore += 0.8;
  if (primary.rsi14 <= 48 && primary.rsi14 >= 28) shortScore += 0.8;

  if (primary.macdHist > 0) longScore += 0.7;
  if (primary.macdHist < 0) shortScore += 0.7;

  if (primary.volume > primary.avgVol20) {
    if (primary.price > primary.ema34) longScore += 0.5;
    if (primary.price < primary.ema34) shortScore += 0.5;
  }

  if (primary.wave === "HH_HL") longScore += 0.8;
  if (primary.wave === "LH_LL") shortScore += 0.8;

  if (oiChangePct1h !== null && oiChangePct1h !== undefined) {
    if (oiChangePct1h > 0.5 && primary.price > primary.ema34) longScore += 0.4;
    if (oiChangePct1h > 0.5 && primary.price < primary.ema34) shortScore += 0.4;
  }

  if (fundingRate !== null && fundingRate !== undefined) {
    const fundingPct = fundingRate * 100;

    if (fundingPct > 0.05) {
      longScore -= 0.4;
      reasons.push("Funding dương cao, cẩn thận long squeeze.");
    }

    if (fundingPct < -0.05) {
      shortScore -= 0.4;
      reasons.push("Funding âm sâu, cẩn thận short squeeze.");
    }
  }

  longScore = Math.max(0, Math.min(10, longScore));
  shortScore = Math.max(0, Math.min(10, shortScore));

  let bias = "CHỜ";

  if (longScore >= 5.5 && longScore - shortScore >= 1) bias = "LONG";
  if (shortScore >= 5.5 && shortScore - longScore >= 1) bias = "SHORT";

  return {
    longScore: Number(longScore.toFixed(1)),
    shortScore: Number(shortScore.toFixed(1)),
    bias,
    reasons,
  };
}

function buildTradePlan(primary, signal) {
  const price = primary.price;
  const atrValue = primary.atr14 || price * 0.006;

  const buffer = Math.max(atrValue * 0.15, price * 0.001);
  const minStop = Math.max(atrValue * 0.7, price * 0.003);

  if (signal.bias === "LONG") {
    const support = primary.support;
    const supportDistancePct = Math.abs(pctDiff(price, support) || 999);

    let entryLow;
    let entryHigh;

    if (support && support < price && supportDistancePct <= 1.2) {
      entryLow = support + buffer * 0.2;
      entryHigh = Math.min(price, support + buffer * 1.5);
    } else {
      entryLow = price - price * 0.0035;
      entryHigh = price - price * 0.001;
    }

    const entry = (entryLow + entryHigh) / 2;
    const sl = Math.min(support - buffer, entry - minStop);
    const risk = entry - sl;

    const tp1 = entry + risk * 1.2;
    const tp2 = entry + risk * 1.8;
    const rr = (tp2 - entry) / risk;

    return {
      side: "LONG",
      entryLow,
      entryHigh,
      sl,
      tp1,
      tp2,
      rr,
      riskLevel: rr >= 1.5 ? "Trung bình" : "Cao",
    };
  }

  if (signal.bias === "SHORT") {
    const resistance = primary.resistance;
    const resistanceDistancePct = Math.abs(pctDiff(resistance, price) || 999);

    let entryLow;
    let entryHigh;

    if (resistance && resistance > price && resistanceDistancePct <= 1.2) {
      entryHigh = resistance - buffer * 0.2;
      entryLow = Math.max(price, resistance - buffer * 1.5);
    } else {
      entryLow = price + price * 0.001;
      entryHigh = price + price * 0.0035;
    }

    const entry = (entryLow + entryHigh) / 2;
    const sl = Math.max(resistance + buffer, entry + minStop);
    const risk = sl - entry;

    const tp1 = entry - risk * 1.2;
    const tp2 = entry - risk * 1.8;
    const rr = (entry - tp2) / risk;

    return {
      side: "SHORT",
      entryLow,
      entryHigh,
      sl,
      tp1,
      tp2,
      rr,
      riskLevel: rr >= 1.5 ? "Trung bình" : "Cao",
    };
  }

  return {
    side: "CHỜ",
    waitZone: `Hỗ trợ ${fmt(primary.support)} / Kháng cự ${fmt(primary.resistance)}`,
    riskLevel: "Cao",
  };
}

function buildSignalEngine(data, modeConfig) {
  const primary =
    data.frames.find((f) => f.tf === modeConfig.primaryTf) || data.frames[0];

  const trend =
    data.frames.find((f) => f.tf === modeConfig.trendTf) ||
    data.frames[data.frames.length - 1];

  const signal = scoreSignal(
    primary,
    trend,
    data.fundingRate,
    data.oiChangePct1h
  );

  const marketCondition = getMarketCondition(primary);
  const emaStructure = getEmaStructure(primary);
  const plan = buildTradePlan(primary, signal);

  if (plan.side !== "CHỜ" && plan.rr && plan.rr < 1.15) {
    return {
      primaryTf: primary.tf,
      trendTf: trend?.tf || "N/A",
      emaStructure,
      marketCondition,
      longScore: signal.longScore,
      shortScore: signal.shortScore,
      bias: "CHỜ",
      reason: "RR chưa đẹp, không nên ép lệnh.",
      plan: {
        side: "CHỜ",
        waitZone: `Chờ quanh hỗ trợ ${fmt(primary.support)} hoặc kháng cự ${fmt(primary.resistance)}`,
        riskLevel: "Cao",
      },
    };
  }

  return {
    primaryTf: primary.tf,
    trendTf: trend?.tf || "N/A",
    emaStructure,
    marketCondition,
    longScore: signal.longScore,
    shortScore: signal.shortScore,
    bias: signal.bias,
    reason: signal.reasons.join(" ") || "Không có cảnh báo lớn.",
    plan,
  };
}

// ================= CONTEXT =================

async function getMarketContext(symbol, mode = "DEFAULT") {
  const modeConfig = getModeConfig(mode);

  if (symbol === "XAUUSD") {
    const price = await getGoldPrice();

    const frame = {
      tf: modeConfig.primaryTf,
      price,
      ema34: null,
      ema89: null,
      ema200: null,
      ema610: null,
      rsi14: null,
      macdLine: null,
      macdSignal: null,
      macdHist: null,
      volume: null,
      avgVol20: null,
      atr14: price * 0.006,
      support: price - 20,
      resistance: price + 20,
      wave: "NEUTRAL",
    };

    const data = {
      symbol: "XAUUSD",
      mode: modeConfig.mode,
      modeRule: modeConfig.rule,
      note: "XAU dùng giá tham khảo, chưa có Funding/OI.",
      fundingRate: null,
      openInterest: null,
      oiChangePct1h: null,
      frames: [frame],
    };

    return {
      ...data,
      engine: {
        primaryTf: frame.tf,
        trendTf: "N/A",
        emaStructure: "UNKNOWN",
        marketCondition: "UNKNOWN",
        longScore: 0,
        shortScore: 0,
        bias: "CHỜ",
        reason: "XAU chưa có đủ dữ liệu indicator trong bản này.",
        plan: {
          side: "CHỜ",
          waitZone: `${fmt(price - 20)} - ${fmt(price + 20)}`,
          riskLevel: "Cao",
        },
      },
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
        getBinanceKlines(symbol, item.interval, 800).then((candles) => ({
          label: item.label,
          candles,
        }))
      ),
    ]);

  const data = {
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

  return {
    ...data,
    engine: buildSignalEngine(data, modeConfig),
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
- EMA34: ${fmt(f.ema34)}
- EMA89: ${fmt(f.ema89)}
- EMA200: ${fmt(f.ema200)}
- EMA610: ${fmt(f.ema610)}
- RSI14: ${fmt(f.rsi14)}
- MACD Hist: ${fmt(f.macdHist)}
- Volume: ${fmt(f.volume)}
- AvgVol20: ${fmt(f.avgVol20)}
- ATR14: ${fmt(f.atr14)}
- Support gần nhất: ${fmt(f.support)}
- Resistance gần nhất: ${fmt(f.resistance)}
- Wave: ${f.wave}
`;
}

function engineText(engine) {
  const p = engine.plan;

  if (p.side === "CHỜ") {
    return `
PHÂN TÍCH HỆ THỐNG:
- Bias: CHỜ
- Primary TF: ${engine.primaryTf}
- Trend TF: ${engine.trendTf}
- EMA Structure: ${engine.emaStructure}
- Market Condition: ${engine.marketCondition}
- LongScore: ${engine.longScore}/10
- ShortScore: ${engine.shortScore}/10
- Risk: ${p.riskLevel}
- Vùng chờ: ${p.waitZone}
- Lý do: ${engine.reason}
`;
  }

  return `
PHÂN TÍCH HỆ THỐNG:
- Bias: ${engine.bias}
- Primary TF: ${engine.primaryTf}
- Trend TF: ${engine.trendTf}
- EMA Structure: ${engine.emaStructure}
- Market Condition: ${engine.marketCondition}
- LongScore: ${engine.longScore}/10
- ShortScore: ${engine.shortScore}/10
- Side: ${p.side}
- Entry: ${fmt(p.entryLow)} - ${fmt(p.entryHigh)}
- SL: ${fmt(p.sl)}
- TP1: ${fmt(p.tp1)}
- TP2: ${fmt(p.tp2)}
- RR TP2: ${fmt(p.rr)}
- Risk: ${p.riskLevel}
- Lý do/Cảnh báo: ${engine.reason}
`;
}

// ================= OPENAI =================

async function askChatGPT(userMessage, symbol, mode, memory, groupConfig) {
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

${data.frames.map(frameText).join("")}

${engineText(data.engine)}

Yêu cầu:
- Ưu tiên dùng PHÂN TÍCH HỆ THỐNG để ra khuyến nghị.
- Nhận định chỉ 2-3 câu.
- Nhận định phải có EMA/Sonic R và nếu phù hợp thì nhắc OI/Funding/Volume.
- Khuyến nghị dùng đúng format:
❗️Khuyến nghị: 🔵 Long hoặc 🔴 Short hoặc 🟡 Chờ
🔹Entry:
🔹SL:
🔹TP:
- TP gộp 1 dòng, ví dụ: TP: 70100 - 70800.
- Nếu Chờ thì không ghi Entry/SL/TP, chỉ ghi 🔹Vùng chờ.
- Không ghi LongScore/ShortScore ra ngoài trừ khi user hỏi.
`;

  const response = await openai.responses.create({
    model: AI_MODEL,
    instructions: buildTradePrompt(groupConfig),
    input: `
User hỏi:
${userMessage}

${memoryText(memory)}

${groupStyleText(groupConfig)}

${marketContext}
`,
    max_output_tokens: 420,
  });

  return response.output_text || "Bot chưa phân tích được.";
}

async function askChatOnly(text, memory, groupConfig) {
  const response = await openai.responses.create({
    model: AI_MODEL,
    instructions: buildChatPrompt(groupConfig),
    input: `
${memoryText(memory)}

User hỏi:
${text}
`,
    max_output_tokens: 120,
  });

  return response.output_text || "Bot chưa trả lời được.";
}

// ================= MULTI BOT =================

function isAllowedGroup(ctx, botConfig) {
  if (!botConfig.groupId) return true;
  return String(ctx.chat?.id) === String(botConfig.groupId);
}

function getBotCallNames(botConfig) {
  if (botConfig.style === "CDT") {
    return ["thư ký", "thu ky", "thuky", "thư kí", "thu ki", "bot"];
  }

  return ["bot"];
}

function isBotMentionedForConfig(text, botConfig) {
  const lower = String(text || "").toLowerCase();
  return getBotCallNames(botConfig).some((name) => lower.includes(name));
}

function getRuntimeGroupConfig(ctx, botConfig) {
  return {
    chat_id: String(ctx.chat?.id || ""),
    group_title: ctx.chat?.title || ctx.chat?.username || "Private Chat",
    style: botConfig.style,
  };
}

function setupBot(bot, botConfig) {
  bot.start(async (ctx) => {
    if (!isAllowedGroup(ctx, botConfig)) return;
    await ctx.reply(`${botConfig.botName} Online ✅`);
  });

  bot.command("ping", async (ctx) => {
    if (!isAllowedGroup(ctx, botConfig)) return;
    await ctx.reply("pong ✅");
  });

  bot.command("on", async (ctx) => {
    if (!isAllowedGroup(ctx, botConfig)) return;
    if (!isAdmin(ctx)) return ctx.reply("Bạn không có quyền dùng lệnh này.");

    BOT_ENABLED = true;
    await ctx.reply(`${botConfig.botName} đã bật ✅`);
  });

  bot.command("off", async (ctx) => {
    if (!isAllowedGroup(ctx, botConfig)) return;
    if (!isAdmin(ctx)) return ctx.reply("Bạn không có quyền dùng lệnh này.");

    BOT_ENABLED = false;
    await ctx.reply(`${botConfig.botName} đã tắt trả lời phân tích ⛔`);
  });

  bot.command("ai_on", async (ctx) => {
    if (!isAllowedGroup(ctx, botConfig)) return;
    if (!isAdmin(ctx)) return ctx.reply("Bạn không có quyền dùng lệnh này.");

    AI_CHAT_ENABLED = true;
    await ctx.reply("Đã bật chat AI ngoài market ✅");
  });

  bot.command("ai_off", async (ctx) => {
    if (!isAllowedGroup(ctx, botConfig)) return;
    if (!isAdmin(ctx)) return ctx.reply("Bạn không có quyền dùng lệnh này.");

    AI_CHAT_ENABLED = false;
    await ctx.reply("Đã tắt chat AI ngoài market ⛔");
  });

  bot.command("forgetme", async (ctx) => {
    if (!isAllowedGroup(ctx, botConfig)) return;

    const ok = await forgetUserMemory(ctx);
    if (!ok) return ctx.reply("Memory chưa được bật hoặc chưa có database.");

    await ctx.reply("Đã xoá memory của bạn trong group này ✅");
  });

  bot.command("status", async (ctx) => {
    if (!isAllowedGroup(ctx, botConfig)) return;

    await ctx.reply(
      `Bot: ${botConfig.code}
` +
        `Name: ${botConfig.botName}
` +
        `Style: ${botConfig.style}
` +
        `Group ID: ${ctx.chat?.id}
` +
        `Bot status: ${BOT_ENABLED ? "ON ✅" : "OFF ⛔"}
` +
        `AI chat ngoài market: ${AI_CHAT_ENABLED ? "ON ✅" : "OFF ⛔"}
` +
        `Memory: ${MEMORY_ENABLED && db ? "ON ✅" : "OFF ⛔"}
` +
        `Model: ${AI_MODEL}
` +
        `EMA: 34/89/200/610
` +
        `Signal Engine: ON ✅`
    );
  });

  bot.on("text", async (ctx) => {
    try {
      if (!isAllowedGroup(ctx, botConfig)) return;

      const text = ctx.message.text;

      if (!text) return;
      if (text.startsWith("/")) return;
      if (!BOT_ENABLED) return;

      if (!isBotMentionedForConfig(text, botConfig)) return;

      const userId = `${botConfig.code}:${String(ctx.from?.id || "unknown")}`;
      const now = Date.now();
      const lastTime = userCooldown.get(userId) || 0;

      if (now - lastTime < USER_COOLDOWN_MS) {
        const wait = Math.ceil((USER_COOLDOWN_MS - (now - lastTime)) / 1000);
        return ctx.reply(`Chờ ${wait}s nữa rồi hỏi tiếp nhé.`);
      }

      userCooldown.set(userId, now);

      const groupConfig = getRuntimeGroupConfig(ctx, botConfig);
      const memory = await getUserMemory(ctx);
      const symbol = await detectSymbol(text, memory);

      if (!symbol) {
        if (!AI_CHAT_ENABLED) return;

        await ctx.sendChatAction("typing");

        const answer = await askChatOnly(text, memory, groupConfig);

        await saveUserMemory(ctx, text, answer, null, "CHAT");

        return ctx.reply(answer, {
          reply_to_message_id: ctx.message.message_id,
        });
      }

      const mode = detectTradeMode(text, memory);

      await ctx.sendChatAction("typing");

      const answer = await askChatGPT(text, symbol, mode, memory, groupConfig);

      await saveUserMemory(ctx, text, answer, symbol, mode);

      await ctx.reply(answer, {
        reply_to_message_id: ctx.message.message_id,
      });
    } catch (error) {
      console.error(`${botConfig.code}_BOT_ERROR:`, error);
      await ctx.reply("⚠️ Bot đang bận hoặc market API timeout.");
    }
  });
}

// ================= EXPRESS =================

app.get("/", (_req, res) => {
  res.send("AI Multi Market Bot Running");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    bots: BOT_CONFIGS.map((x) => ({
      code: x.code,
      style: x.style,
      groupId: x.groupId || null,
      enabled: Boolean(x.token),
    })),
    bot: BOT_ENABLED ? "ON" : "OFF",
    ai_chat: AI_CHAT_ENABLED ? "ON" : "OFF",
    memory: MEMORY_ENABLED && db ? "ON" : "OFF",
    ema: "34/89/200/610",
    signal_engine: "ON",
  });
});

// ================= START =================

await initDatabase();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const tokenSet = new Set(BOT_CONFIGS.map((x) => x.token));

if (tokenSet.size !== BOT_CONFIGS.length) {
  throw new Error("FBT_BOT_TOKEN và CDT_BOT_TOKEN đang bị trùng nhau.");
}

const bots = BOT_CONFIGS.map((config) => {
  const instance = new Telegraf(config.token);
  setupBot(instance, config);
  return { instance, config };
});

for (const { instance, config } of bots) {
  try {
    await instance.telegram.deleteWebhook({ drop_pending_updates: true });
    await instance.launch({
      dropPendingUpdates: true,
      allowedUpdates: ["message"],
    });

    console.log(`${config.code} bot launched ✅`);
  } catch (err) {
    console.error(`${config.code}_BOT_LAUNCH_ERROR:`, err);
  }
}

process.once("SIGINT", () => {
  for (const { instance } of bots) {
    instance.stop("SIGINT");
  }
});

process.once("SIGTERM", () => {
  for (const { instance } of bots) {
    instance.stop("SIGTERM");
  }
});
