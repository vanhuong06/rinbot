import express from "express";
import { createServer as createViteServer } from "vite";
import { Telegraf } from "telegraf";
import axios from "axios";
import https from "https";
import cron from "node-cron";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Optimize axios with keep-alive
const httpsAgent = new https.Agent({ keepAlive: true });
const axiosInstance = axios.create({ httpsAgent });

const db = new Database("bot_data.db");

// Simple Memory Logging
let logBuffer: string[] = [];
const MAX_LOGS = 20;
const lastAzeemMessageIds = new Map<string, number>();
let lastScanTime: string = "Chưa chạy";
let lastAzeemReportTime: string = "Chưa chạy";

function log(message: string, userId?: string) {
  const timestamp = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const formatted = `[${timestamp}] ${message}`;
  console.log(formatted);
  
  // Always add to global buffer for admin/console visibility
  logBuffer.push(formatted);
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.shift();
  }

  // If userId is provided, save to persistent database logs
  if (userId) {
    try {
      db.prepare("INSERT INTO logs (user_id, message) VALUES (?, ?)").run(userId, message);
      // Keep only last 50 logs per user to save space
      db.prepare("DELETE FROM logs WHERE user_id = ? AND id NOT IN (SELECT id FROM logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 50)").run(userId, userId);
    } catch (e) {
      console.error("Failed to save log to DB", e);
    }
  }
}

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    user_id TEXT,
    product_id TEXT,
    url TEXT,
    product_name TEXT,
    status TEXT DEFAULT 'monitoring',
    last_checked DATETIME,
    auto_buy INTEGER DEFAULT 0,
    auto_buy_amount INTEGER DEFAULT 1,
    buy_limit INTEGER DEFAULT 0,
    bought_count INTEGER DEFAULT 0,
    last_amount INTEGER DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    chat_id TEXT,
    username TEXT,
    password TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migration: Add missing columns if they don't exist
try {
  const monitorInfo = db.prepare("PRAGMA table_info(monitors)").all();
  const monitorCols = monitorInfo.map((col: any) => col.name);
  
  if (!monitorCols.includes('user_id')) {
    db.exec("ALTER TABLE monitors ADD COLUMN user_id TEXT");
    // Backfill user_id with chat_id for existing data
    db.exec("UPDATE monitors SET user_id = chat_id WHERE user_id IS NULL");
    console.log("Migration: Added user_id column to monitors");
  }
  if (!monitorCols.includes('product_id')) {
    db.exec("ALTER TABLE monitors ADD COLUMN product_id TEXT");
    console.log("Migration: Added product_id column");
  }
  if (!monitorCols.includes('url')) {
    db.exec("ALTER TABLE monitors ADD COLUMN url TEXT");
    console.log("Migration: Added url column");
  }
  if (!monitorCols.includes('product_name')) {
    db.exec("ALTER TABLE monitors ADD COLUMN product_name TEXT");
    console.log("Migration: Added product_name column");
  }
  if (!monitorCols.includes('auto_buy')) {
    db.exec("ALTER TABLE monitors ADD COLUMN auto_buy INTEGER DEFAULT 0");
    console.log("Migration: Added auto_buy column");
  }
  if (!monitorCols.includes('auto_buy_amount')) {
    db.exec("ALTER TABLE monitors ADD COLUMN auto_buy_amount INTEGER DEFAULT 1");
    console.log("Migration: Added auto_buy_amount column");
  }
  if (!monitorCols.includes('last_amount')) {
    db.exec("ALTER TABLE monitors ADD COLUMN last_amount INTEGER DEFAULT 0");
    console.log("Migration: Added last_amount column");
  }
  if (!monitorCols.includes('buy_limit')) {
    db.exec("ALTER TABLE monitors ADD COLUMN buy_limit INTEGER DEFAULT 0");
    console.log("Migration: Added buy_limit column");
  }
  if (!monitorCols.includes('bought_count')) {
    db.exec("ALTER TABLE monitors ADD COLUMN bought_count INTEGER DEFAULT 0");
    console.log("Migration: Added bought_count column");
  }
  if (!monitorCols.includes('schedule_time')) {
    db.exec("ALTER TABLE monitors ADD COLUMN schedule_time TEXT");
    console.log("Migration: Added schedule_time column");
  }
  if (!monitorCols.includes('schedule_amount')) {
    db.exec("ALTER TABLE monitors ADD COLUMN schedule_amount INTEGER");
    console.log("Migration: Added schedule_amount column");
  }
  if (!monitorCols.includes('schedule_limit')) {
    db.exec("ALTER TABLE monitors ADD COLUMN schedule_limit INTEGER");
    console.log("Migration: Added schedule_limit column");
  }

  const userInfo = db.prepare("PRAGMA table_info(users)").all();
  const userCols = userInfo.map((col: any) => col.name);
  if (!userCols.includes('user_id')) {
    // This is a bit tricky because user_id is the new primary key.
    // For simplicity, we'll add it and try to migrate.
    db.exec("ALTER TABLE users ADD COLUMN user_id TEXT");
    db.exec("UPDATE users SET user_id = chat_id WHERE user_id IS NULL");
    console.log("Migration: Added user_id column to users");
  }
} catch (e) {
  console.error("Migration Error:", e);
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Global axios config with timeout
axios.defaults.timeout = 10000;

app.use(express.json());

// API routes
app.get("/api/health", (req, res) => {
  console.log("GET /api/health");
  res.json({ status: "ok", bot_running: !!BOT_TOKEN });
});

app.get("/api/stats", (req, res) => {
  console.log("GET /api/stats");
  try {
    const stats = db.prepare("SELECT count(*) as count, status FROM monitors GROUP BY status").all();
    res.json(stats);
  } catch (error) {
    console.error("Stats API Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/api/external-list", async (req, res) => {
  console.log("GET /api/external-list");
  const { username, password } = req.query;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }
  try {
    const data = await getCachedAPI(String(username), String(password));
    res.json(data);
  } catch (error) {
    console.error("External List API Error:", error);
    res.status(500).json({ error: "Failed to fetch external API" });
  }
});

// Bot Setup
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.warn("TELEGRAM_BOT_TOKEN is not set in environment variables.");
}

const bot = new Telegraf(BOT_TOKEN || "DUMMY_TOKEN");

// Rate Limiter Middleware
const userLastAction = new Map<string, number>();
const RATE_LIMIT_MS = 1500; // 1.5 seconds

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id?.toString();
  if (userId) {
    const now = Date.now();
    const lastAction = userLastAction.get(userId) || 0;
    
    if (now - lastAction < RATE_LIMIT_MS) {
      // Only warn if they haven't been warned in the last 1 second to avoid spam
      if (now - lastAction > RATE_LIMIT_MS - 1000) {
        try {
          if (ctx.callbackQuery) {
            await ctx.answerCbQuery("⏳ Vui lòng thao tác chậm lại!", { show_alert: true });
          } else {
            await ctx.reply("⏳ Bạn đang thao tác quá nhanh. Vui lòng chờ 1.5s giữa các lệnh.");
          }
        } catch(e) {}
      }
      return; // Stop processing this request
    }
    userLastAction.set(userId, now);
  }
  return next();
});

// Simple API Cache
let apiCache: { [key: string]: { data: any, timestamp: number } } = {};
const CACHE_TTL = 1500; // 1.5 seconds for faster stock detection
const pendingRequests = new Map<string, Promise<any>>();

// Tối ưu RAM: Tự động dọn dẹp cache hết hạn mỗi phút
setInterval(() => {
  const now = Date.now();
  let deletedCount = 0;
  for (const key in apiCache) {
    if (now - apiCache[key].timestamp > CACHE_TTL) {
      delete apiCache[key];
      deletedCount++;
    }
  }
  if (deletedCount > 0) {
    console.log(`[Memory GC] Đã dọn dẹp ${deletedCount} mục cache API cũ.`);
  }
}, 60000);

async function getCachedAPI(username: string, password: string) {
  const cacheKey = `${username}:${password}`;
  if (apiCache[cacheKey] && (Date.now() - apiCache[cacheKey].timestamp < CACHE_TTL)) {
    return apiCache[cacheKey].data;
  }
  
  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey);
  }
  
  const fetchPromise = (async () => {
    try {
      const response = await axiosInstance.get(`https://shop.saidiait.top/api/ListResource.php?username=${username}&password=${password}`);
      apiCache[cacheKey] = {
        data: response.data,
        timestamp: Date.now()
      };
      return response.data;
    } catch (error) {
      console.error("API Fetch Error:", error);
      // Return stale cache if available on error
      if (apiCache[cacheKey]) return apiCache[cacheKey].data;
      throw error;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();
  
  pendingRequests.set(cacheKey, fetchPromise);
  return fetchPromise;
}

async function getBalance(username: string, password: string) {
  try {
    const response = await axiosInstance.get(`https://shop.saidiait.top/api/GetBalance.php?username=${username}&password=${password}`);
    // The API returns a plain string like "116.565đ"
    return response.data;
  } catch (error) {
    console.error("Get Balance Error:", error);
    return null;
  }
}

// Helper to find product in categories
function findProductInCategories(categories: any[], productId: string) {
  for (const cat of categories) {
    if (String(cat.id) === String(productId)) {
      return {
        id: String(cat.id),
        name: cat.name || `Category ${cat.id}`,
        url: `https://shop.saidiait.top/category/${cat.id}`,
        price: "N/A",
        amount: "0",
        raw: cat
      };
    }
    const products = cat.accounts || [];
    const product = products.find((p: any) => String(p.id) === String(productId));
    if (product) {
      return {
        id: String(product.id),
        name: product.name || `Sản phẩm ${product.id}`,
        url: `https://shop.saidiait.top/product/${product.id}`,
        price: product.price || "N/A",
        amount: product.amount || "0",
        raw: product
      };
    }
  }
  return null;
}

// Bot Commands
bot.start((ctx) => {
  ctx.reply(
    "Chào mừng bạn đến với Shopping Monitor Bot!\n\n" +
    "Các lệnh hỗ trợ:\n" +
    "/login <user> <pass> - Đăng nhập tài khoản shop\n" +
    "/logout - Đăng xuất và xóa thông tin tài khoản\n" +
    "/check <id> - Kiểm tra nhanh số lượng (Mặc định ID 78)\n" +
    "/azeem - Kiểm tra nhanh kho Azeem (21, 78, 108)\n" +
    "/auto_setup - Thêm các ID Azeem (21, 78, 108) vào danh sách\n" +
    "/get <id> - Xem chi tiết JSON của sản phẩm\n" +
    "/monitor <id> - Thêm sản phẩm vào danh sách kiểm tra\n" +
    "/buy <id> <amount> - Mua tài khoản (Ví dụ: /buy 21 1)\n" +
    "/list - Danh sách sản phẩm đang theo dõi\n" +
    "/scan - Chạy kiểm tra toàn bộ danh sách (và tự động mua nếu bật)\n" +
    "/stop <id> - Dừng theo dõi sản phẩm\n" +
    "/autobuy <id> <1|0> <amount> - Bật/Tắt tự động mua hàng với số lượng\n" +
    "/schedule <id> <time> <amount> [limit] - Hẹn giờ bật auto-buy (VD: /schedule 21 15:30 10 50)\n" +
    "/logs - Xem nhật ký hoạt động\n" +
    "/clear_logs - Xóa nhật ký hoạt động\n" +
    "/status - Kiểm tra trạng thái hoạt động của Bot\n" +
    "/sysinfo - Xem báo cáo RAM và bộ nhớ đệm\n" +
    "/balance - Kiểm tra số dư tài khoản\n" +
    "/menu - Hiển thị menu điều khiển nhanh"
  );
});

bot.command("menu", (ctx) => {
  ctx.reply("🎛 **Menu Điều Khiển Bot**", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📋 Danh sách theo dõi", callback_data: "cmd_list" },
          { text: "💰 Kiểm tra số dư", callback_data: "cmd_balance" }
        ],
        [
          { text: "📦 Kho Azeem", callback_data: "cmd_azeem" },
          { text: "📊 Trạng thái Bot", callback_data: "cmd_status" }
        ],
        [
          { text: "🛒 Lệnh Auto-buy đang bật", callback_data: "cmd_active_autobuy" },
          { text: "🛑 Tắt tất cả Auto-buy", callback_data: "cmd_stop_autobuy" }
        ],
        [
          { text: "⏰ Đặt hẹn giờ", callback_data: "cmd_schedule_guide" },
          { text: "🔕 Tắt tất cả hẹn giờ", callback_data: "cmd_stop_schedule" }
        ],
        [
          { text: "⚙️ Auto Setup (Azeem)", callback_data: "cmd_auto_setup" },
          { text: "🔍 Quét ngay (Scan)", callback_data: "cmd_scan" }
        ],
        [
          { text: "📖 Hướng dẫn lệnh", callback_data: "cmd_help_guide" },
          { text: "🚪 Đăng xuất", callback_data: "cmd_logout" }
        ]
      ]
    }
  });
});

// Handle callback queries from menu
bot.on("callback_query", async (ctx) => {
  const data = (ctx.callbackQuery as any).data;
  if (!data || !data.startsWith("cmd_")) return;
  
  const cmd = data.replace("cmd_", "");
  
  // Acknowledge the callback query
  await ctx.answerCbQuery();
  
  // Execute the corresponding command logic
  const fakeMessage = { text: `/${cmd}` };
  const fakeCtx = { ...ctx, message: fakeMessage };
  
  // We can't easily call the command handlers directly, so we'll just simulate the logic or tell the user to type it
  // For simple commands, we can just reply with instructions or duplicate the logic
  
  if (cmd === "list") {
    const userId = ctx.from.id.toString();
    const rows = db.prepare("SELECT * FROM monitors WHERE user_id = ?").all(userId);
    if (rows.length === 0) return ctx.reply("Bạn chưa theo dõi sản phẩm nào.");

    let message = "📋 Danh sách sản phẩm đang theo dõi:\n\n";
    rows.forEach((row: any) => {
      const autoBuyStatus = row.auto_buy ? "✅ Bật" : "❌ Tắt";
      const limitInfo = row.buy_limit > 0 ? `, Giới hạn: ${row.bought_count}/${row.buy_limit}` : "";
      const scheduleInfo = row.schedule_time ? `\n⏰ Hẹn giờ: Bật lúc ${row.schedule_time} (SL: ${row.schedule_amount}, GH: ${row.schedule_limit === 0 ? "Không" : row.schedule_limit})` : "";
      
      message += `🔹 Monitor ID: ${row.id}\n`;
      message += `📦 Sản phẩm: ${row.product_name}\n`;
      message += `🆔 Product ID: ${row.product_id}\n`;
      message += `📊 Trạng thái: ${row.status}\n`;
      message += `🛒 Auto-buy: ${autoBuyStatus} (SL: ${row.auto_buy_amount || 1}${limitInfo})${scheduleInfo}\n`;
      message += `🔗 URL: ${row.url}\n\n`;
    });
    ctx.reply(message);
  } else if (cmd === "active_autobuy") {
    const userId = ctx.from.id.toString();
    const rows = db.prepare("SELECT * FROM monitors WHERE user_id = ? AND auto_buy = 1").all(userId);
    if (rows.length === 0) return ctx.reply("Hiện tại KHÔNG CÓ lệnh Auto-buy nào đang bật.");

    let message = "🛒 **Danh sách lệnh Auto-buy ĐANG BẬT:**\n\n";
    rows.forEach((row: any) => {
      const limitInfo = row.buy_limit > 0 ? ` (Đã mua: ${row.bought_count}/${row.buy_limit})` : " (Không giới hạn)";
      message += `🔹 Monitor ID: ${row.id} | Product ID: ${row.product_id}\n`;
      message += `📦 Sản phẩm: ${row.product_name}\n`;
      message += `⚡ Số lượng mỗi lần: ${row.auto_buy_amount || 1}${limitInfo}\n\n`;
    });
    ctx.reply(message);
  } else if (cmd === "stop_autobuy") {
    const userId = ctx.from.id.toString();
    const result = db.prepare("UPDATE monitors SET auto_buy = 0 WHERE user_id = ? AND auto_buy = 1").run(userId);
    if (result.changes > 0) {
      ctx.reply(`🛑 Đã tắt thành công ${result.changes} lệnh Auto-buy đang chạy.`);
      log(`Tắt tất cả lệnh Auto-buy qua menu`, userId);
    } else {
      ctx.reply("ℹ️ Hiện tại không có lệnh Auto-buy nào đang bật.");
    }
  } else if (cmd === "stop_schedule") {
    const userId = ctx.from.id.toString();
    const result = db.prepare("UPDATE monitors SET schedule_time = NULL, schedule_amount = 0, schedule_limit = 0 WHERE user_id = ? AND schedule_time IS NOT NULL").run(userId);
    if (result.changes > 0) {
      ctx.reply(`🔕 Đã huỷ thành công ${result.changes} lịch hẹn giờ Auto-buy.`);
      log(`Huỷ tất cả lịch hẹn giờ qua menu`, userId);
    } else {
      ctx.reply("ℹ️ Hiện tại không có lịch hẹn giờ nào đang được đặt.");
    }
  } else if (cmd === "auto_setup") {
    const targetIds = ["21", "78", "108"];
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat?.id?.toString() || userId;
    const user = getUser(userId);
    
    if (!user) return ctx.reply("⚠️ Bạn chưa đăng nhập. Vui lòng đăng nhập trước khi thiết lập tự động: /login <user> <pass>");

    ctx.reply(`🛠 Đang thiết lập theo dõi tự động cho các ID: ${targetIds.join(", ")}...`);

    try {
      const data = await getCachedAPI(user.username, user.password);
      const categories = data.categories || [];

      for (const id of targetIds) {
        const product = findProductInCategories(categories, id);
        if (product) {
          try {
            const existing = db.prepare("SELECT * FROM monitors WHERE user_id = ? AND product_id = ?").get(userId, id);
            if (!existing) {
              const currentAmount = parseInt(product.amount) || 0;
              db.prepare("INSERT INTO monitors (chat_id, user_id, product_id, url, product_name, last_amount) VALUES (?, ?, ?, ?, ?, ?)")
                .run(chatId, userId, product.id, product.url, product.name, currentAmount);
              ctx.reply(`✅ Đã thêm theo dõi: ${product.name} (ID: ${id}) - Hiện có: ${currentAmount}`);
            } else {
              ctx.reply(`ℹ️ ID ${id} đã có trong danh sách theo dõi.`);
            }
          } catch (e) {
            console.error(e);
            ctx.reply(`❌ Lỗi khi thêm ID ${id}`);
          }
        } else {
          ctx.reply(`❌ Không tìm thấy sản phẩm ID ${id} trên API.`);
        }
      }
      ctx.reply("✨ Hoàn tất! Bot sẽ thông báo ngay khi số lượng (amount) thay đổi.");
      log(`Chạy lệnh Auto Setup qua menu`, userId);
    } catch (error) {
      ctx.reply("❌ Lỗi kết nối API.");
    }
  } else if (cmd === "balance") {
    const userId = ctx.from.id.toString();
    const user = getUser(userId);
    if (!user) return ctx.reply("⚠️ Bạn chưa đăng nhập. Vui lòng đăng nhập trước: /login <user> <pass>");

    ctx.reply("💰 Đang kiểm tra số dư...");
    try {
      const balanceData = await getBalance(user.username, user.password);
      ctx.reply(`💰 Số dư hiện tại của bạn: ${balanceData}`);
    } catch (error) {
      ctx.reply("❌ Lỗi khi lấy số dư.");
    }
  } else if (cmd === "azeem") {
    const userId = ctx.from.id.toString();
    const user = getUser(userId);
    if (!user) return ctx.reply("⚠️ Bạn chưa đăng nhập. Vui lòng đăng nhập trước: /login <user> <pass>");

    ctx.reply("🔍 Đang kiểm tra trạng thái kho Azeem hiện tại...");
    try {
      const data = await getCachedAPI(user.username, user.password);
      const categories = data.categories || [];
      const targetIds = ["21", "108"];
      
      let report = "📋 **TRẠNG THÁI KHO AZEEM HIỆN TẠI:**\n\n";
      for (const id of targetIds) {
        const product = findProductInCategories(categories, id);
        const name = product ? product.name : `ID ${id}`;
        const amount = product ? parseInt(product.amount) || 0 : 0;
        const price = product ? product.price : "N/A";
        report += `🔹 **${name}** (ID: ${id})\n   📦 Số lượng: **${amount}**\n   💰 Giá: ${price}\n\n`;
      }
      report += `_Kiểm tra lúc: ${new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}_`;
      
      ctx.reply(report, { parse_mode: 'Markdown' });
      log("Đã kiểm tra thủ công kho Azeem qua menu", userId);
    } catch (error) {
      ctx.reply("❌ Lỗi khi lấy dữ liệu kho Azeem.");
    }
  } else if (cmd === "status") {
    const monitors = db.prepare("SELECT COUNT(*) as count FROM monitors").get() as { count: number };
    const users = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
    
    ctx.reply(
      `🤖 **Trạng thái Bot:**\n\n` +
      `👥 Số người dùng: ${users.count}\n` +
      `📦 Số sản phẩm đang theo dõi: ${monitors.count}\n` +
      `⏱ Lần quét gần nhất: ${lastScanTime}\n` +
      `⏱ Lần báo cáo Azeem gần nhất: ${lastAzeemReportTime}\n` +
      `🟢 Bot đang hoạt động bình thường.`
    );
  } else if (cmd === "schedule_guide") {
    ctx.reply(
      "⏰ **Hướng dẫn Đặt Hẹn Giờ Auto-buy**\n\n" +
      "Bạn có thể lên lịch để bot tự động bật Auto-buy vào một thời điểm cụ thể trong ngày (giờ Việt Nam).\n\n" +
      "**Cú pháp:**\n" +
      "`/schedule <id> <HH:mm> <số lượng mỗi lần> [tổng giới hạn mua]`\n\n" +
      "**Ví dụ:**\n" +
      "🔹 `/schedule 21 15:30 10 50`\n" +
      "_(Hẹn đúng 15:30 chiều sẽ tự động bật Auto-buy cho ID 21, mỗi lần mua 10 con, dừng khi mua đủ 50 con)_\n\n" +
      "🔹 `/schedule 78 08:00 5`\n" +
      "_(Hẹn 08:00 sáng tự động bật Auto-buy cho ID 78, mỗi lần mua 5 con, không giới hạn tổng số)_\n\n" +
      "💡 *Lưu ý:* Khi đến giờ, bot sẽ tự động bật Auto-buy và gửi thông báo cho bạn.",
      { parse_mode: "Markdown" }
    );
  } else if (cmd === "help_guide") {
    ctx.reply(
      "📖 **Hướng dẫn chi tiết các lệnh:**\n\n" +
      "🔑 **Tài khoản:**\n" +
      "`/login <user> <pass>` - Đăng nhập tài khoản shop\n" +
      "`/logout` - Đăng xuất tài khoản\n" +
      "`/balance` - Kiểm tra số dư hiện tại\n\n" +
      "📦 **Sản phẩm & Theo dõi:**\n" +
      "`/get <id>` - Xem chi tiết JSON của một sản phẩm\n" +
      "`/monitor <id>` - Thêm sản phẩm vào danh sách theo dõi\n" +
      "`/list` - Xem danh sách các sản phẩm đang theo dõi\n" +
      "`/stop <id>` - Dừng theo dõi một sản phẩm\n" +
      "`/scan` - Quét thủ công toàn bộ danh sách\n\n" +
      "🛒 **Mua hàng & Tự động:**\n" +
      "`/buy <id> <số_lượng>` - Mua ngay lập tức (VD: `/buy 21 1`)\n" +
      "`/autobuy <id> <1|0> <số_lượng> [giới_hạn]` - Bật(1)/Tắt(0) tự động mua (VD: `/autobuy 21 1 5 30`)\n" +
      "`/schedule <id> <HH:mm> <số_lượng> [giới_hạn]` - Hẹn giờ bật auto-buy\n\n" +
      "⚡ **Tiện ích Azeem:**\n" +
      "`/azeem` - Kiểm tra nhanh kho Azeem (ID 21, 108)\n" +
      "`/auto_setup` - Tự động thêm các ID Azeem vào danh sách theo dõi\n\n" +
      "⚙️ **Hệ thống:**\n" +
      "`/menu` - Mở menu điều khiển\n" +
      "`/status` - Xem trạng thái hoạt động của bot\n" +
      "`/logs` - Xem nhật ký hoạt động\n" +
      "`/clear_logs` - Xóa nhật ký hoạt động",
      { parse_mode: "Markdown" }
    );
  } else if (cmd === "logout") {
    const userId = ctx.from.id.toString();
    try {
      const result = db.prepare("DELETE FROM users WHERE user_id = ?").run(userId);
      if (result.changes > 0) {
        ctx.reply("✅ Đã đăng xuất và xóa thông tin tài khoản của bạn khỏi hệ thống.");
      } else {
        ctx.reply("ℹ️ Bạn chưa đăng nhập tài khoản nào.");
      }
    } catch (e) {
      console.error(e);
      ctx.reply("❌ Lỗi khi thực hiện đăng xuất.");
    }
  } else if (cmd === "scan") {
    ctx.reply("Vui lòng gõ lệnh /scan để chạy quét toàn bộ.");
  }
});

bot.command("login", async (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  const username = parts[1];
  const password = parts[2];
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat.id.toString();

  if (!username || !password) {
    return ctx.reply("Sử dụng: /login <username> <password>");
  }

  ctx.reply("🔐 Đang xác thực tài khoản...");

  try {
    const balanceData = await getBalance(username, password);
    
    if (balanceData && (String(balanceData).includes("đ") || !isNaN(parseFloat(String(balanceData).replace(/[^\d.-]/g, ''))))) {
      db.prepare("INSERT OR REPLACE INTO users (user_id, chat_id, username, password) VALUES (?, ?, ?, ?)")
        .run(userId, chatId, username, password);
      ctx.reply(`✅ Đăng nhập thành công!\n💰 Số dư hiện tại: ${balanceData}\nBot sẽ sử dụng tài khoản này cho các yêu cầu của bạn.`);
    } else {
      ctx.reply("❌ Đăng nhập thất bại: Tài khoản hoặc mật khẩu không chính xác.");
    }
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Lỗi khi xác thực tài khoản. Vui lòng thử lại sau.");
  }
});

bot.command("logout", (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const result = db.prepare("DELETE FROM users WHERE user_id = ?").run(userId);
    if (result.changes > 0) {
      ctx.reply("✅ Đã đăng xuất và xóa thông tin tài khoản của bạn khỏi hệ thống.");
    } else {
      ctx.reply("ℹ️ Bạn chưa đăng nhập tài khoản nào.");
    }
  } catch (e) {
    console.error(e);
    ctx.reply("❌ Lỗi khi thực hiện đăng xuất.");
  }
});

function getUser(userId: string) {
  return db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as any;
}

async function getProductAmount(userId: string, productId: string): Promise<number | null> {
  try {
    const user = getUser(userId);
    if (!user) return null;
    const data = await getCachedAPI(user.username, user.password);
    const categories = data.categories || [];
    const product = findProductInCategories(categories, productId);
    return product ? parseInt(product.amount || "0") : null;
  } catch (error) {
    console.error("getProductAmount Error:", error);
    return null;
  }
}

bot.command("logs", (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userLogs = db.prepare("SELECT * FROM logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 20").all(userId);
    
    if (userLogs.length === 0) {
      return ctx.reply("Bạn chưa có nhật ký hoạt động nào.");
    }

    let message = "📋 **Nhật ký hoạt động của bạn:**\n\n";
    userLogs.reverse().forEach((l: any) => {
      const time = new Date(l.timestamp).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      message += `\`[${time}]\` ${l.message}\n`;
    });
    
    ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error("Error fetching logs", e);
    ctx.reply("❌ Lỗi khi lấy nhật ký.");
  }
});

bot.command("clear_logs", (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    db.prepare("DELETE FROM logs WHERE user_id = ?").run(userId);
    ctx.reply("✅ Đã xóa toàn bộ nhật ký hoạt động của bạn.");
  } catch (e) {
    ctx.reply("❌ Lỗi khi xóa nhật ký.");
  }
});

bot.command("status", (ctx) => {
  const monitorCount = db.prepare("SELECT count(*) as count FROM monitors").get() as any;
  const autoBuyCount = db.prepare("SELECT count(*) as count FROM monitors WHERE auto_buy = 1").get() as any;
  const currentTime = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  const statusMsg = `🤖 **Trạng thái hệ thống Shopping Monitor:**\n\n` +
    `🕒 Giờ hệ thống (VN): \`${currentTime}\`\n` +
    `📊 Tổng số sản phẩm đang theo dõi: \`${monitorCount.count}\`\n` +
    `🛒 Số sản phẩm bật Auto-buy: \`${autoBuyCount.count}\`\n\n` +
    `🔄 **Tiến trình chạy ngầm:**\n` +
    `🔹 Quét kho & Auto-buy (10s): \`${lastScanTime}\`\n` +
    `🔹 Báo cáo Azeem (30s): \`${lastAzeemReportTime}\`\n\n` +
    `✅ Bot đang hoạt động bình thường. (Xem thêm: /sysinfo)`;

  ctx.reply(statusMsg, { parse_mode: 'Markdown' });
});

bot.command("sysinfo", (ctx) => {
  const memUsage = process.memoryUsage();
  const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

  const sysInfoMsg = `🖥 **Báo cáo Hệ thống & RAM:**\n\n` +
    `🔹 RSS (Tổng RAM cấp phát): \`${formatBytes(memUsage.rss)}\`\n` +
    `🔹 Heap Total (Vùng nhớ V8): \`${formatBytes(memUsage.heapTotal)}\`\n` +
    `🔹 Heap Used (RAM đang dùng): \`${formatBytes(memUsage.heapUsed)}\`\n` +
    `🔹 External (C++ objects): \`${formatBytes(memUsage.external)}\`\n\n` +
    `📦 **Bộ nhớ đệm (Cache):**\n` +
    `🔹 API Cache: \`${Object.keys(apiCache).length} mục\`\n` +
    `🔹 Azeem Cache: \`${lastAzeemAmounts.size} mục\`\n\n` +
    `_Mẹo: Hệ thống đã được tối ưu tự động dọn dẹp cache mỗi phút để giải phóng RAM._`;

  ctx.reply(sysInfoMsg, { parse_mode: 'Markdown' });
});

bot.command("balance", async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = getUser(userId);
  if (!user) return ctx.reply("⚠️ Bạn chưa đăng nhập. Vui lòng đăng nhập trước khi kiểm tra số dư: /login <user> <pass>");

  ctx.reply("💰 Đang kiểm tra số dư...");
  const balanceData = await getBalance(user.username, user.password);
  if (balanceData) {
    const balance = typeof balanceData === 'string' ? balanceData : (balanceData.money || balanceData.balance || "0");
    ctx.reply(`💰 **Số dư tài khoản:** ${balance}`, { parse_mode: 'Markdown' });
  } else {
    ctx.reply("❌ Không thể lấy thông tin số dư.");
  }
});

bot.command("check", async (ctx) => {
  const productId = ctx.message.text.split(/\s+/)[1] || "78";
  const userId = ctx.from.id.toString();
  log(`Kiểm tra số lượng ID ${productId}`, userId);
  ctx.reply(`🔍 Đang kiểm tra số lượng cho ID: ${productId}...`);
  
  const amount = await getProductAmount(userId, productId);
  
  if (amount !== null) {
    ctx.reply(`📦 ID ${productId} hiện đang có: ${amount} sản phẩm.`);
  } else {
    ctx.reply(`❌ Không tìm thấy thông tin sản phẩm hoặc bạn chưa đăng nhập.`);
  }
});

bot.command("azeem", async (ctx) => {
  const targetIds = ["21", "78", "108"];
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat.id.toString();
  const user = getUser(userId);
  if (!user) return ctx.reply("⚠️ Bạn chưa đăng nhập. Vui lòng đăng nhập trước khi kiểm tra kho Azeem: /login <user> <pass>");
  
  try {
    const data = await getCachedAPI(user.username, user.password);
    const categories = data.categories || [];
    
    let report = "📋 **Trạng thái kho Azeem:**\n\n";
    for (const id of targetIds) {
      const product = findProductInCategories(categories, id);
      const name = product ? product.name : `ID ${id}`;
      const amount = product ? product.amount : "N/A";
      const price = product ? product.price : "N/A";
      report += `🔹 **${name}** (ID: ${id})\n   📦 Số lượng: **${amount}**\n   💰 Giá: ${price}\n\n`;
    }
    report += `_Cập nhật lúc: ${new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}_`;

    const oldMsgId = lastAzeemMessageIds.get(chatId);
    if (oldMsgId) {
      try { await ctx.deleteMessage(oldMsgId); } catch (e) { /* ignore */ }
    }

    const newMsg = await ctx.reply(report, { parse_mode: 'Markdown' });
    lastAzeemMessageIds.set(chatId, newMsg.message_id);
  } catch (error) {
    ctx.reply("❌ Lỗi khi lấy dữ liệu từ API.");
  }
});

bot.command("auto_setup", async (ctx) => {
  const targetIds = ["21", "78", "108"];
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat.id.toString();
  const user = getUser(userId);
  if (!user) return ctx.reply("⚠️ Bạn chưa đăng nhập. Vui lòng đăng nhập trước khi thiết lập tự động: /login <user> <pass>");

  ctx.reply(`🛠 Đang thiết lập theo dõi tự động cho các ID: ${targetIds.join(", ")}...`);

  try {
    const data = await getCachedAPI(user.username, user.password);
    const categories = data.categories || [];

    for (const id of targetIds) {
      const product = findProductInCategories(categories, id);
      if (product) {
        try {
          const existing = db.prepare("SELECT * FROM monitors WHERE user_id = ? AND product_id = ?").get(userId, id);
          if (!existing) {
            const currentAmount = parseInt(product.amount) || 0;
            db.prepare("INSERT INTO monitors (chat_id, user_id, product_id, url, product_name, last_amount) VALUES (?, ?, ?, ?, ?, ?)")
              .run(chatId, userId, product.id, product.url, product.name, currentAmount);
            ctx.reply(`✅ Đã thêm theo dõi: ${product.name} (ID: ${id}) - Hiện có: ${currentAmount}`);
          } else {
            ctx.reply(`ℹ️ ID ${id} đã có trong danh sách theo dõi.`);
          }
        } catch (e) {
          console.error(e);
          ctx.reply(`❌ Lỗi khi thêm ID ${id}`);
        }
      } else {
        ctx.reply(`❌ Không tìm thấy sản phẩm ID ${id} trên API.`);
      }
    }
    ctx.reply("✨ Hoàn tất! Bot sẽ thông báo ngay khi số lượng (amount) thay đổi.");
  } catch (error) {
    ctx.reply("❌ Lỗi kết nối API.");
  }
});

bot.command("buy", async (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  const productId = parts[1];
  const amount = parts[2] || "1";
  const userId = ctx.from.id.toString();
  const user = getUser(userId);
  if (!user) return ctx.reply("⚠️ Bạn chưa đăng nhập. Vui lòng đăng nhập trước khi mua hàng: /login <user> <pass>");

  if (!productId) return ctx.reply("Sử dụng: /buy <id> <amount>\nVí dụ: /buy 21 1");

  log(`Yêu cầu mua ID ${productId} số lượng ${amount}`, userId);
  ctx.reply(`🛒 Đang thực hiện lệnh mua sản phẩm ID: ${productId} với số lượng: ${amount}...`);

  try {
    const response = await axios.get(`https://shop.saidiait.top/api/BResource.php?username=${user.username}&password=${user.password}&id=${productId}&amount=${amount}`);
    
    const data = response.data;
    let jsonStr = JSON.stringify(data, null, 2);
    
    if (jsonStr.length > 4000) {
      jsonStr = jsonStr.substring(0, 3900) + "\n\n... (Dữ liệu quá dài) ...";
    }

    if (data.status === "success") {
      log(`Mua thành công ID ${productId} (SL: ${amount})`, userId);
      await ctx.reply(`✅ Mua hàng thành công!`);

      try {
        let fileContent = "";
        const processAccount = (acc: string) => {
          const parts = acc.split('|');
          if (parts.length >= 2) {
            return `${parts[0].trim()}|${parts[1].trim()}`;
          }
          return acc.trim();
        };

        if (data.data && Array.isArray(data.data.lists)) {
          fileContent = data.data.lists.map((a: any) => {
            if (a && typeof a === 'object' && a.account) return processAccount(String(a.account));
            return JSON.stringify(a);
          }).join("\n");
        } else if (Array.isArray(data.data)) {
          fileContent = data.data.map((a: any) => {
            if (typeof a === 'string') return processAccount(a);
            if (a && typeof a === 'object' && a.account) return processAccount(String(a.account));
            return JSON.stringify(a);
          }).join("\n");
        } else if (typeof data.data === "string") {
          fileContent = data.data.split('\n').filter((line: string) => line.trim() !== '').map(processAccount).join("\n");
        } else {
          fileContent = jsonStr;
        }
        
        const fileBuffer = Buffer.from(fileContent, 'utf-8');
        
        let fileName = `accounts_${productId}_${Date.now()}.txt`;
        if (data.data && data.data.name && data.data.amount && data.data.trans_id) {
          const safeName = String(data.data.name).replace(/[^a-zA-Z0-9]/g, '');
          fileName = `${safeName}_${data.data.amount}_${data.data.trans_id}.txt`;
        }

        await ctx.replyWithDocument({
          source: fileBuffer,
          filename: fileName
        });
      } catch (fileErr) {
        console.error("Failed to send document:", fileErr);
      }
    } else {
      let errorMsg = data.message || "Lỗi không xác định từ API";
      if (errorMsg.toLowerCase().includes("số dư") || errorMsg.toLowerCase().includes("không đủ tiền") || errorMsg.toLowerCase().includes("balance")) {
        errorMsg = "Số dư không đủ";
      }
      log(`Mua thất bại ID ${productId}: ${errorMsg}`, userId);
      ctx.reply(`❌ Mua hàng thất bại: ${errorMsg}\n\n<pre>${jsonStr}</pre>`, { parse_mode: 'HTML' });
    }
  } catch (error: any) {
    console.error("Buy API Error:", error.response?.data || error.message);
    const detail = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    ctx.reply(`❌ Lỗi kết nối API mua hàng: ${detail}`);
  }
});

bot.command("get", async (ctx) => {
  const productId = ctx.message.text.split(/\s+/)[1];
  const userId = ctx.from.id.toString();
  const user = getUser(userId);
  if (!user) return ctx.reply("⚠️ Bạn chưa đăng nhập. Vui lòng đăng nhập trước khi lấy dữ liệu: /login <user> <pass>");

  if (!productId) return ctx.reply("Sử dụng: /get <product_id>");

  ctx.reply(`🔍 Đang lấy dữ liệu chi tiết cho ID: ${productId}...`);
  
  try {
    const data = await getCachedAPI(user.username, user.password);
    const categories = data.categories || [];
    
    let foundProduct = null;
    for (const cat of categories) {
      const product = (cat.accounts || []).find((p: any) => String(p.id) === String(productId));
      if (product) {
        foundProduct = product;
        break;
      }
    }

    if (foundProduct) {
      const jsonStr = JSON.stringify(foundProduct, null, 2);
      ctx.reply(`✅ Dữ liệu API cho ID ${productId}:\n\n<pre>${jsonStr}</pre>`, { parse_mode: 'HTML' });
    } else {
      ctx.reply(`❌ Không tìm thấy sản phẩm ID ${productId} trong bất kỳ Category nào.`);
    }
  } catch (error) {
    ctx.reply("❌ Lỗi khi truy vấn API.");
  }
});

bot.command("monitor", async (ctx) => {
  const productId = ctx.message.text.split(/\s+/)[1];
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat.id.toString();
  const user = getUser(userId);
  if (!user) return ctx.reply("⚠️ Bạn chưa đăng nhập. Vui lòng đăng nhập trước khi thêm theo dõi: /login <user> <pass>");

  if (!productId) return ctx.reply("Vui lòng nhập ID sản phẩm: /monitor <product_id>\nVí dụ: /monitor 101");

  log(`Thêm theo dõi ID ${productId}`, userId);
  ctx.reply(`🔍 Đang kiểm tra thông tin sản phẩm ID: ${productId}...`);

  try {
    const data = await getCachedAPI(user.username, user.password);
    const categories = data.categories || [];
    const product = findProductInCategories(categories, productId);
    
    if (!product) {
      return ctx.reply("❌ Không tìm thấy sản phẩm với ID này trên hệ thống.");
    }

    // Check if already monitoring
    const existing = db.prepare("SELECT * FROM monitors WHERE user_id = ? AND product_id = ?").get(userId, product.id);
    if (existing) {
      return ctx.reply(`ℹ️ Sản phẩm ${product.name} (ID: ${product.id}) đã có trong danh sách theo dõi của bạn.`);
    }

    const currentAmount = parseInt(product.amount) || 0;
    const stmt = db.prepare("INSERT INTO monitors (chat_id, user_id, product_id, url, product_name, last_amount) VALUES (?, ?, ?, ?, ?, ?)");
    const info = stmt.run(chatId, userId, product.id, product.url, product.name, currentAmount);

    ctx.reply(
      `✅ Đã thêm vào danh sách theo dõi!\n\n` +
      `📦 Sản phẩm: ${product.name}\n` +
      `💰 Giá: ${product.price}\n` +
      `🔢 Số lượng hiện tại: ${currentAmount}\n` +
      `🆔 Monitor ID: ${info.lastInsertRowid}\n` +
      `🔗 URL: ${product.url}`
    );
  } catch (e: any) {
    console.error("Monitor Command Error:", e);
    ctx.reply(`❌ Có lỗi xảy ra khi lưu thông tin: ${e.message}`);
  }
});

bot.command("list", (ctx) => {
  const userId = ctx.from.id.toString();
  const rows = db.prepare("SELECT * FROM monitors WHERE user_id = ?").all(userId);
  if (rows.length === 0) return ctx.reply("Bạn chưa theo dõi sản phẩm nào.");

  let message = "📋 Danh sách sản phẩm đang theo dõi:\n\n";
  rows.forEach((row: any) => {
    const autoBuyStatus = row.auto_buy ? "✅ Bật" : "❌ Tắt";
    const limitInfo = row.buy_limit > 0 ? `, Giới hạn: ${row.bought_count}/${row.buy_limit}` : "";
    const scheduleInfo = row.schedule_time ? `\n⏰ Hẹn giờ: Bật lúc ${row.schedule_time} (SL: ${row.schedule_amount}, GH: ${row.schedule_limit === 0 ? "Không" : row.schedule_limit})` : "";
    
    message += `🔹 Monitor ID: ${row.id}\n`;
    message += `📦 Sản phẩm: ${row.product_name}\n`;
    message += `🆔 Product ID: ${row.product_id}\n`;
    message += `📊 Trạng thái: ${row.status}\n`;
    message += `🛒 Auto-buy: ${autoBuyStatus} (SL: ${row.auto_buy_amount || 1}${limitInfo})${scheduleInfo}\n`;
    message += `🔗 URL: ${row.url}\n\n`;
  });
  ctx.reply(message);
});

const userProcessLocks = new Set<string>();

async function processMonitors(monitors: any[]) {
  try {
    // Group monitors by user to minimize API calls
    const userMonitors = new Map<string, any[]>();
    for (const m of monitors) {
      if (!userMonitors.has(m.user_id)) userMonitors.set(m.user_id, []);
      userMonitors.get(m.user_id)!.push(m);
    }

    const promises = Array.from(userMonitors.entries()).map(async ([userId, items]) => {
      if (userProcessLocks.has(userId)) {
        return; // Skip if this user is already being processed
      }
      userProcessLocks.add(userId);
      
      try {
        const user = getUser(userId);
        if (!user) return;
        
        try {
          const data = await getCachedAPI(user.username, user.password);
          const categories = data.categories || [];

          for (const item of items) {
            try {
              // Fetch latest state from DB to prevent race conditions and stale data
              const currentItem = db.prepare("SELECT * FROM monitors WHERE id = ?").get(item.id) as any;
              if (!currentItem) continue;

              // Check schedule
              if (currentItem.schedule_time) {
                const nowStr = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false, hour: '2-digit', minute: '2-digit' });
                if (nowStr === currentItem.schedule_time) {
                  // Time matched! Enable auto-buy
                  db.prepare("UPDATE monitors SET auto_buy = 1, auto_buy_amount = ?, buy_limit = ?, bought_count = 0, schedule_time = NULL, status = 'monitoring' WHERE id = ?")
                    .run(currentItem.schedule_amount, currentItem.schedule_limit, currentItem.id);
                  
                  // Update currentItem object so it processes immediately
                  currentItem.auto_buy = 1;
                  currentItem.auto_buy_amount = currentItem.schedule_amount;
                  currentItem.buy_limit = currentItem.schedule_limit;
                  currentItem.schedule_time = null;
                  
                  log(`⏰ Tự động bật Auto-buy theo lịch hẹn cho ${currentItem.product_name}`, userId);
                  await bot.telegram.sendMessage(currentItem.chat_id, `⏰ **Đến giờ hẹn!** Đã tự động BẬT Auto-buy cho sản phẩm: ${currentItem.product_name}`);
                }
              }

              const product = findProductInCategories(categories, currentItem.product_id);
              if (!product) continue;

              const currentAmount = parseInt(product.amount) || 0;
              const lastAmount = currentItem.last_amount || 0;

              if (currentAmount === 0) {
                if (lastAmount > 0) {
                  await bot.telegram.sendMessage(currentItem.chat_id, `🚫 HẾT HÀNG! (ID: ${currentItem.product_id})\n📦 ${currentItem.product_name}`);
                  db.prepare("UPDATE monitors SET status = 'monitoring', last_amount = 0 WHERE id = ?").run(currentItem.id);
                } else {
                  db.prepare("UPDATE monitors SET last_checked = CURRENT_TIMESTAMP WHERE id = ?").run(currentItem.id);
                }
                continue;
              }

              // Notify if it just came in stock
              if (lastAmount === 0 || currentItem.status === 'monitoring') {
                const notifyMsg = `🚨 CÓ HÀNG! (Số lượng: ${currentAmount})\n\n` +
                  `📦 Sản phẩm: ${currentItem.product_name}\n` +
                  `🆔 ID: ${currentItem.product_id}\n` +
                  `🔗 URL: ${currentItem.url}`;
                await bot.telegram.sendMessage(currentItem.chat_id, notifyMsg);
              }

              if (currentItem.auto_buy) {
                let buyAmount = currentItem.auto_buy_amount || 1;
                const buyLimit = currentItem.buy_limit || 0;
                const currentBought = currentItem.bought_count || 0;

                if (buyLimit > 0) {
                  if (currentBought >= buyLimit) {
                    log(`Giới hạn mua đã đạt (${currentBought}/${buyLimit}). Tắt Auto-buy cho ${currentItem.product_name}`, userId);
                    db.prepare("UPDATE monitors SET auto_buy = 0, last_amount = ? WHERE id = ?").run(currentAmount, currentItem.id);
                    await bot.telegram.sendMessage(currentItem.chat_id, `✅ **Đã đạt giới hạn mua hàng** (${currentBought}/${buyLimit}). Đã tự động tắt Auto-buy cho sản phẩm: ${currentItem.product_name}`);
                    continue;
                  }
                  
                  const remaining = buyLimit - currentBought;
                  // Mua tối đa số lượng cần thiết để đạt giới hạn nhanh nhất
                  buyAmount = remaining;
                }

                if (buyAmount > currentAmount) {
                  buyAmount = currentAmount;
                }

                if (buyAmount > 0) {
                  log(`Phát hiện có hàng, đang Auto-buy: ${currentItem.product_name} (SL: ${buyAmount})`, userId);
                  
                  try {
                    const buyResponse = await axiosInstance.get(`https://shop.saidiait.top/api/BResource.php?username=${user.username}&password=${user.password}&id=${currentItem.product_id}&amount=${buyAmount}`);
                    
                    if (buyResponse.data.status === "success") {
                      const newBoughtCount = currentBought + buyAmount;
                      log(`Auto-buy THÀNH CÔNG: ${currentItem.product_name} (Tổng đã mua: ${newBoughtCount})`, userId);
                      
                      const jsonStr = JSON.stringify(buyResponse.data, null, 2);
                      let limitMsg = buyLimit > 0 ? `\n📊 Tiến độ: ${newBoughtCount}/${buyLimit}` : "";
                      
                      await bot.telegram.sendMessage(currentItem.chat_id, 
                        `✅ **Đặt hàng tự động thành công!**${limitMsg}\n\n` +
                        `📦 Sản phẩm: ${currentItem.product_name}`, 
                        { parse_mode: 'HTML' }
                      );

                      // Send as .txt file
                      try {
                        let fileContent = "";
                        const processAccount = (acc: string) => {
                          const parts = acc.split('|');
                          if (parts.length >= 2) {
                            return `${parts[0].trim()}|${parts[1].trim()}`;
                          }
                          return acc.trim();
                        };

                        if (buyResponse.data.data && Array.isArray(buyResponse.data.data.lists)) {
                          fileContent = buyResponse.data.data.lists.map((a: any) => {
                            if (a && typeof a === 'object' && a.account) return processAccount(String(a.account));
                            return JSON.stringify(a);
                          }).join("\n");
                        } else if (Array.isArray(buyResponse.data.data)) {
                          fileContent = buyResponse.data.data.map((a: any) => {
                            if (typeof a === 'string') return processAccount(a);
                            if (a && typeof a === 'object' && a.account) return processAccount(String(a.account));
                            return JSON.stringify(a);
                          }).join("\n");
                        } else if (typeof buyResponse.data.data === "string") {
                          fileContent = buyResponse.data.data.split('\n').filter((line: string) => line.trim() !== '').map(processAccount).join("\n");
                        } else {
                          fileContent = jsonStr;
                        }
                        
                        const fileBuffer = Buffer.from(fileContent, 'utf-8');
                        
                        let fileName = `accounts_${currentItem.product_id}_${Date.now()}.txt`;
                        if (buyResponse.data.data && buyResponse.data.data.name && buyResponse.data.data.amount && buyResponse.data.data.trans_id) {
                          const safeName = String(buyResponse.data.data.name).replace(/[^a-zA-Z0-9]/g, '');
                          fileName = `${safeName}_${buyResponse.data.data.amount}_${buyResponse.data.data.trans_id}.txt`;
                        }

                        await bot.telegram.sendDocument(currentItem.chat_id, {
                          source: fileBuffer,
                          filename: fileName
                        });
                      } catch (fileErr) {
                        console.error("Failed to send document:", fileErr);
                      }

                      db.prepare("UPDATE monitors SET status = 'purchased', last_amount = ?, bought_count = ? WHERE id = ?").run(currentAmount, newBoughtCount, currentItem.id);

                      if (buyLimit > 0 && newBoughtCount >= buyLimit) {
                        db.prepare("UPDATE monitors SET auto_buy = 0 WHERE id = ?").run(currentItem.id);
                        await bot.telegram.sendMessage(currentItem.chat_id, `🏁 **Đã đạt giới hạn mua hàng** (${newBoughtCount}/${buyLimit}). Đã tắt Auto-buy cho sản phẩm này.`);
                      }
                    } else {
                      let errorMsg = buyResponse.data.message || "Lỗi không xác định";
                      const isLowBalance = errorMsg.toLowerCase().includes("số dư") || errorMsg.toLowerCase().includes("không đủ tiền") || errorMsg.toLowerCase().includes("balance");
                      
                      if (isLowBalance) {
                        errorMsg = "Số dư không đủ";
                        db.prepare("UPDATE monitors SET auto_buy = 0 WHERE id = ?").run(currentItem.id);
                        log(`Tự động TẮT Auto-buy cho ${currentItem.product_name} do hết số dư.`, userId);
                        await bot.telegram.sendMessage(currentItem.chat_id, `⚠️ **Đã tự động TẮT Auto-buy** cho sản phẩm này vì số dư tài khoản không đủ.`);
                      } else {
                        db.prepare("UPDATE monitors SET last_amount = ? WHERE id = ?").run(currentAmount, currentItem.id);
                      }
                      
                      log(`Auto-buy THẤT BẠI: ${currentItem.product_name} - ${errorMsg}`, userId);
                      const rawDetail = JSON.stringify(buyResponse.data, null, 2);
                      await bot.telegram.sendMessage(currentItem.chat_id, 
                        `❌ **Đặt hàng tự động thất bại**\n` +
                        `📦 Sản phẩm: ${currentItem.product_name}\n` +
                        `⚠️ Lỗi: ${errorMsg}\n\n` +
                        `📄 **Chi tiết lỗi từ shop:**\n<pre>${rawDetail}</pre>`, 
                        { parse_mode: 'HTML' }
                      );
                    }
                  } catch (buyError: any) {
                    const errorDetail = buyError.response?.data ? JSON.stringify(buyError.response.data) : buyError.message;
                    log(`Auto-buy LỖI KẾT NỐI: ${currentItem.product_name} - ${errorDetail}`, userId);
                    db.prepare("UPDATE monitors SET last_amount = ? WHERE id = ?").run(currentAmount, currentItem.id);
                  }
                }
              } else {
                if (currentAmount !== lastAmount || currentItem.status === 'monitoring') {
                  log(`Phát hiện có hàng nhưng Auto-buy đang TẮT: ${currentItem.product_name}`, userId);
                  db.prepare("UPDATE monitors SET status = 'available', last_amount = ? WHERE id = ?").run(currentAmount, currentItem.id);
                } else {
                  db.prepare("UPDATE monitors SET last_checked = CURRENT_TIMESTAMP WHERE id = ?").run(currentItem.id);
                }
              }
            } catch (error) {
              console.error(`Error checking product ${item.product_id}:`, error);
            }
          }
        } catch (userApiError) {
          console.error(`API Error for user ${userId}:`, userApiError);
        }
      } finally {
        userProcessLocks.delete(userId);
      }
    });
    
    await Promise.all(promises);
  } catch (apiError) {
    console.error("Background Scan API Error:", apiError);
  }
}

const userScanLocks = new Set<string>();

bot.command("scan", async (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (userScanLocks.has(userId)) {
    return ctx.reply("⏳ Hệ thống đang xử lý lệnh quét trước đó của bạn. Vui lòng chờ trong giây lát...");
  }
  
  const user = getUser(userId);
  if (!user) return ctx.reply("⚠️ Bạn chưa đăng nhập. Vui lòng đăng nhập trước khi scan: /login <user> <pass>");

  const monitors = db.prepare("SELECT * FROM monitors WHERE user_id = ?").all(userId);
  if (monitors.length === 0) return ctx.reply("Bạn chưa theo dõi sản phẩm nào để scan.");

  userScanLocks.add(userId);
  try {
    ctx.reply(`🔍 Đang quét ${monitors.length} sản phẩm trong danh sách của bạn...`);
    await processMonitors(monitors);
    ctx.reply("✨ Quét hoàn tất!");
  } finally {
    userScanLocks.delete(userId);
  }
});

bot.command("stop", (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  const id = parts[1];
  const userId = ctx.from.id.toString();
  if (!id) return ctx.reply("Vui lòng nhập ID: /stop <id>");

  const stmt = db.prepare("DELETE FROM monitors WHERE (id = ? OR product_id = ?) AND user_id = ?");
  const result = stmt.run(id, id, userId);

  if (result.changes > 0) {
    ctx.reply(`✅ Đã dừng theo dõi sản phẩm ID: ${id}`);
  } else {
    ctx.reply("❌ Không tìm thấy sản phẩm với ID này trong danh sách theo dõi của bạn. Hãy dùng /list để xem đúng ID.");
  }
});

bot.command("autobuy", async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = getUser(userId);
  if (!user) return ctx.reply("⚠️ Bạn chưa đăng nhập. Vui lòng đăng nhập trước khi bật Auto-buy: /login <user> <pass>");

  const parts = ctx.message.text.split(/\s+/);
  const id = parts[1];
  const val = parts[2];
  const amount = parts[3] || "1";
  const limit = parts[4] || "0";

  if (!id || !val) return ctx.reply("Sử dụng: /autobuy <id> <1|0> <số lượng mỗi lần> <tổng giới hạn mua>\nVí dụ: /autobuy 1 1 5 30 (Bật auto buy cho ID 1, mỗi lần mua 5 con, dừng khi mua đủ 30 con)");

  if (val === "1") {
    try {
      ctx.reply("🔍 Đang kiểm tra số dư và thông tin sản phẩm...");
      const monitor = db.prepare("SELECT * FROM monitors WHERE (id = ? OR product_id = ?) AND user_id = ?").get(id, id, userId) as any;
      if (!monitor) {
        return ctx.reply("❌ Không tìm thấy sản phẩm trong danh sách theo dõi của bạn. Vui lòng dùng /list để kiểm tra lại ID (Monitor ID hoặc Product ID).");
      }

      const data = await getCachedAPI(user.username, user.password);
      const categories = data.categories || [];
      const product = findProductInCategories(categories, monitor.product_id);

      if (!product) {
        return ctx.reply(`❌ Không tìm thấy thông tin sản phẩm ID ${monitor.product_id} trên shop để kiểm tra giá.`);
      }

      const balanceStr = await getBalance(user.username, user.password);
      if (!balanceStr) {
        return ctx.reply("❌ Không thể lấy số dư tài khoản của bạn. Vui lòng thử lại sau.");
      }

      const parseCurrency = (str: string) => {
        if (!str) return 0;
        return parseFloat(str.replace(/[^\d]/g, '')) || 0;
      };

      const price = parseCurrency(product.price);
      const balance = parseCurrency(balanceStr);
      const checkAmount = parseInt(limit) > 0 ? parseInt(limit) : parseInt(amount);
      const totalCost = price * checkAmount;

      if (balance < totalCost) {
        return ctx.reply(
          `❌ **Không đủ số dư để bật Auto-buy!**\n\n` +
          `🔹 Sản phẩm: ${product.name}\n` +
          `🔹 Giá mỗi sản phẩm: ${product.price}\n` +
          `🔹 Số lượng mua dự kiến: ${checkAmount}\n` +
          `🔹 Tổng tiền cần: ${totalCost.toLocaleString('vi-VN')}đ\n` +
          `💰 Số dư hiện tại: ${balanceStr}\n\n` +
          `⚠️ Vui lòng nạp thêm tiền trước khi bật Auto-buy.`
        );
      }
    } catch (error) {
      console.error("Autobuy Balance Check Error:", error);
      return ctx.reply("❌ Đã xảy ra lỗi khi kiểm tra số dư. Vui lòng thử lại sau.");
    }
  }

  // Try to update by Monitor ID first, then by Product ID
  // When enabling auto_buy (val === "1"), we reset status to 'monitoring' to trigger an immediate check in the next cycle
  // We also reset bought_count to 0 so it doesn't accumulate from previous runs
  const stmt = db.prepare("UPDATE monitors SET auto_buy = ?, auto_buy_amount = ?, buy_limit = ?, bought_count = CASE WHEN ? = 1 THEN 0 ELSE bought_count END, status = CASE WHEN ? = 1 THEN 'monitoring' ELSE status END WHERE (id = ? OR product_id = ?) AND user_id = ?");
  const result = stmt.run(parseInt(val), parseInt(amount), parseInt(limit), parseInt(val), parseInt(val), id, id, userId);

  if (result.changes > 0) {
    log(`Cập nhật Auto-buy cho ID ${id}: ${val === "1" ? "Bật" : "Tắt"} (SL: ${amount}, Giới hạn: ${limit === "0" ? "Không" : limit})`, userId);
    ctx.reply(
      `✅ **Đã cập nhật chế độ tự động mua cho ID: ${id}**\n` +
      `- Trạng thái: ${val === "1" ? "Bật" : "Tắt"}\n` +
      `- Số lượng mỗi lần: ${amount}\n` +
      `- Tổng giới hạn mua: ${limit === "0" ? "Không giới hạn" : limit + " con"}`
    );
  } else {
    ctx.reply("❌ Không tìm thấy sản phẩm trong danh sách theo dõi của bạn. Vui lòng dùng /list để kiểm tra lại ID (Monitor ID hoặc Product ID).");
  }
});

bot.command("schedule", async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = getUser(userId);
  if (!user) return ctx.reply("⚠️ Bạn chưa đăng nhập. Vui lòng đăng nhập trước khi hẹn giờ: /login <user> <pass>");

  const parts = ctx.message.text.split(/\s+/);
  const id = parts[1];
  const time = parts[2];
  const amount = parts[3] || "1";
  const limit = parts[4] || "0";

  if (!id || !time) return ctx.reply("Sử dụng: /schedule <id> <HH:mm> <số lượng mỗi lần> [tổng giới hạn mua]\nVí dụ: /schedule 21 15:30 10 50 (Hẹn 15:30 bật auto buy cho ID 21, mỗi lần mua 10 con, dừng khi mua đủ 50 con)");

  // Validate time format HH:mm
  if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
    return ctx.reply("❌ Định dạng giờ không hợp lệ. Vui lòng nhập theo định dạng HH:mm (VD: 08:30, 15:45)");
  }

  try {
    ctx.reply("🔍 Đang kiểm tra số dư và thông tin sản phẩm...");
    const monitor = db.prepare("SELECT * FROM monitors WHERE (id = ? OR product_id = ?) AND user_id = ?").get(id, id, userId) as any;
    if (!monitor) {
      return ctx.reply("❌ Không tìm thấy sản phẩm trong danh sách theo dõi của bạn. Vui lòng dùng /list để kiểm tra lại ID (Monitor ID hoặc Product ID).");
    }

    const data = await getCachedAPI(user.username, user.password);
    const categories = data.categories || [];
    const product = findProductInCategories(categories, monitor.product_id);

    if (!product) {
      return ctx.reply(`❌ Không tìm thấy thông tin sản phẩm ID ${monitor.product_id} trên shop để kiểm tra giá.`);
    }

    const balanceStr = await getBalance(user.username, user.password);
    if (!balanceStr) {
      return ctx.reply("❌ Không thể lấy số dư tài khoản của bạn. Vui lòng thử lại sau.");
    }

    const parseCurrency = (str: string) => {
      if (!str) return 0;
      return parseFloat(str.replace(/[^\d]/g, '')) || 0;
    };

    const price = parseCurrency(product.price);
    const balance = parseCurrency(balanceStr);
    const checkAmount = parseInt(limit) > 0 ? parseInt(limit) : parseInt(amount);
    const totalCost = price * checkAmount;

    if (balance < totalCost) {
      return ctx.reply(
        `❌ **Không đủ số dư để hẹn giờ Auto-buy!**\n\n` +
        `🔹 Sản phẩm: ${product.name}\n` +
        `🔹 Giá mỗi sản phẩm: ${product.price}\n` +
        `🔹 Số lượng mua dự kiến: ${checkAmount}\n` +
        `🔹 Tổng tiền cần: ${totalCost.toLocaleString('vi-VN')}đ\n` +
        `💰 Số dư hiện tại: ${balanceStr}\n\n` +
        `⚠️ Vui lòng nạp thêm tiền trước khi đặt lịch hẹn giờ.`
      );
    }
  } catch (error) {
    console.error("Schedule Balance Check Error:", error);
    return ctx.reply("❌ Đã xảy ra lỗi khi kiểm tra số dư. Vui lòng thử lại sau.");
  }

  const stmt = db.prepare("UPDATE monitors SET schedule_time = ?, schedule_amount = ?, schedule_limit = ? WHERE (id = ? OR product_id = ?) AND user_id = ?");
  const result = stmt.run(time, parseInt(amount), parseInt(limit), id, id, userId);

  if (result.changes > 0) {
    log(`Hẹn giờ Auto-buy cho ID ${id} lúc ${time} (SL: ${amount}, Giới hạn: ${limit === "0" ? "Không" : limit})`, userId);
    ctx.reply(
      `⏰ **Đã đặt lịch hẹn giờ Auto-buy cho ID: ${id}**\n` +
      `- Thời gian kích hoạt: ${time} (Giờ VN)\n` +
      `- Số lượng mỗi lần: ${amount}\n` +
      `- Tổng giới hạn mua: ${limit === "0" ? "Không giới hạn" : limit + " con"}\n\n` +
      `_Lưu ý: Khi đến giờ, bot sẽ tự động bật Auto-buy cho sản phẩm này._`
    );
  } else {
    ctx.reply("❌ Không tìm thấy sản phẩm trong danh sách theo dõi của bạn. Vui lòng dùng /list để kiểm tra lại ID (Monitor ID hoặc Product ID).");
  }
});

// Background Monitor for All Users - Every 2s
let isScanning = false;
cron.schedule("*/2 * * * * *", async () => {
  if (isScanning) {
    console.log("[General Monitor] Skip scan: previous scan still running (chống chéo)");
    return;
  }
  isScanning = true;
  try {
    lastScanTime = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const monitors = db.prepare("SELECT * FROM monitors").all();
    if (monitors.length > 0) {
      console.log(`[General Monitor] Running scan for ${monitors.length} items...`);
      await processMonitors(monitors);
    }
  } finally {
    isScanning = false;
  }
});

// Background Monitor for Azeem Status - Every 15s, deletes previous message
const lastAzeemAmounts = new Map<string, number>();
let isAzeemScanning = false;

cron.schedule("*/15 * * * * *", async () => {
  if (isAzeemScanning) return;
  isAzeemScanning = true;
  try {
    lastAzeemReportTime = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const targetIds = ["21", "108"];
    
    const users = db.prepare("SELECT DISTINCT user_id, chat_id FROM monitors").all();
    for (const u of users as any) {
      const userId = u.user_id;
      const chatId = u.chat_id;
      const user = getUser(userId);
      if (!user) continue;

      try {
        const data = await getCachedAPI(user.username, user.password);
        const categories = data.categories || [];
        
        let hasChanges = false;
        let report = "📋 **THÔNG BÁO BIẾN ĐỘNG KHO AZEEM:**\n\n";
        for (const id of targetIds) {
          const product = findProductInCategories(categories, id);
          const name = product ? product.name : `ID ${id}`;
          const amount = product ? parseInt(product.amount) || 0 : 0;
          const price = product ? product.price : "N/A";
          
          const cacheKey = `${userId}:${id}`;
          const lastAmount = lastAzeemAmounts.get(cacheKey);
          
          let changeText = "";
          if (lastAmount !== undefined && lastAmount !== amount) {
            hasChanges = true;
            const diff = amount - lastAmount;
            if (diff > 0) {
              changeText = ` (📈 Tăng ${diff})`;
            } else {
              changeText = ` (📉 Giảm ${Math.abs(diff)})`;
            }
          } else if (lastAmount === undefined && amount > 0) {
            hasChanges = true;
            changeText = ` (🆕 Mới xuất hiện)`;
          }
          
          lastAzeemAmounts.set(cacheKey, amount);
          
          report += `🔹 **${name}** (ID: ${id})\n   📦 Số lượng: **${amount}**${changeText}\n   💰 Giá: ${price}\n\n`;
        }
        report += `_Cập nhật tự động: ${new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}_`;
        
        console.log(`[Azeem Check] User ${userId} - Has Changes: ${hasChanges}`);

        if (hasChanges) {
          log(`Kho Azeem có sự thay đổi số lượng, đang gửi báo cáo...`, userId);
          // Delete old message
          const oldMsgId = lastAzeemMessageIds.get(chatId);
          if (oldMsgId) {
            try { await bot.telegram.deleteMessage(chatId, oldMsgId); } catch (e) { /* ignore */ }
          }

          try {
            const newMsg = await bot.telegram.sendMessage(chatId, report, { parse_mode: 'Markdown' });
            lastAzeemMessageIds.set(chatId, newMsg.message_id);
          } catch (sendError) {
            // Ignore
          }
        }
      } catch (error) {
        // Silent fail
      }
    }
  } finally {
    isAzeemScanning = false;
  }
});

bot.command("azeem", async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = getUser(userId);
  if (!user) return ctx.reply("⚠️ Bạn chưa đăng nhập. Vui lòng đăng nhập trước: /login <user> <pass>");

  ctx.reply("🔍 Đang kiểm tra trạng thái kho Azeem hiện tại...");
  try {
    const data = await getCachedAPI(user.username, user.password);
    const categories = data.categories || [];
    const targetIds = ["21", "108"];
    
    let report = "📋 **TRẠNG THÁI KHO AZEEM HIỆN TẠI:**\n\n";
    for (const id of targetIds) {
      const product = findProductInCategories(categories, id);
      const name = product ? product.name : `ID ${id}`;
      const amount = product ? parseInt(product.amount) || 0 : 0;
      const price = product ? product.price : "N/A";
      report += `🔹 **${name}** (ID: ${id})\n   📦 Số lượng: **${amount}**\n   💰 Giá: ${price}\n\n`;
    }
    report += `_Kiểm tra lúc: ${new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}_`;
    
    ctx.reply(report, { parse_mode: 'Markdown' });
    log("Đã kiểm tra thủ công kho Azeem qua lệnh /azeem", userId);
  } catch (error) {
    ctx.reply("❌ Lỗi khi lấy dữ liệu kho Azeem.");
  }
});

async function startServer() {
  // Launch bot if token is available
  if (BOT_TOKEN && BOT_TOKEN !== "DUMMY_TOKEN") {
    try {
      bot.telegram.setMyCommands([
        { command: 'menu', description: 'Hiển thị menu điều khiển' },
        { command: 'login', description: 'Đăng nhập tài khoản shop' },
        { command: 'logout', description: 'Đăng xuất tài khoản' },
        { command: 'list', description: 'Danh sách sản phẩm đang theo dõi' },
        { command: 'balance', description: 'Kiểm tra số dư tài khoản' },
        { command: 'azeem', description: 'Kiểm tra nhanh kho Azeem' },
        { command: 'status', description: 'Kiểm tra trạng thái hoạt động của Bot' },
        { command: 'logs', description: 'Xem nhật ký hoạt động' },
      ]).catch(err => console.error("Failed to set commands:", err));

      const launchBot = async (retries = 3) => {
        try {
          await bot.launch({ dropPendingUpdates: true });
          console.log("✅ Telegram bot is running (Polling)...");
        } catch (err: any) {
          if (err.response && err.response.error_code === 409 && retries > 0) {
            console.warn(`⚠️ Bot launch conflict (409). Retrying in 3 seconds... (${retries} retries left)`);
            setTimeout(() => launchBot(retries - 1), 3000);
          } else {
            console.error("❌ Failed to launch Telegram bot:", err);
          }
        }
      };
      launchBot();
    } catch (err) {
      console.error("❌ Unexpected error during bot launch:", err);
    }
  } else {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN is not set. Bot will not start.");
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    
    // Serve index.html for all other routes in production (SPA fallback)
    app.get("*", (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("❌ Failed to start server:", err);
});

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
