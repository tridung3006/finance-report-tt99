const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { Pool, types: pgTypes } = require("pg");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  createMissingSnapshots,
  getSnapshotStatus,
  rebuildSnapshots,
  startSnapshotScheduler,
} = require("./snapshots.cjs");
const {
  BALANCE_TABLE,
  CASH_VIEW,
  PAYABLE_VIEW,
  PROFIT_VIEW,
  fullMonthRange,
  latestSnapshotDate,
} = require("./report-aggregates.cjs");
const { hashPassword, normalizeUsername, verifyPassword } = require("./users.cjs");
const { buildB09FromTemplate } = require("./b09-template.cjs");
const { applyHistoricalB02Prior, queryHistoricalB02Prior } = require("./b02-history.cjs");

dotenv.config();

// PostgreSQL DATE has no timezone. Keep it as YYYY-MM-DD instead of letting
// node-postgres turn local midnight into a UTC timestamp on JSON export.
pgTypes.setTypeParser(1082, (value) => value);

const app = express();
const port = Number(process.env.API_PORT || 3021);
const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 4,
  idleTimeoutMillis: 20_000,
  connectionTimeoutMillis: 10_000,
});

app.disable("x-powered-by");
const allowedOrigins = new Set([
  "http://localhost:3020",
  "http://127.0.0.1:3020",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    try {
      const parsed = new URL(origin);
      const normalized = `${parsed.protocol}//${parsed.host}`;
      if (allowedOrigins.has(normalized)) return callback(null, true);
    } catch (_error) {
      // Fall through to reject malformed origins.
    }
    return callback(new Error("Not allowed by CORS"));
  },
}));
app.use(express.json({ limit: "2mb" }));

const sessionSecret = process.env.SESSION_SECRET || "";
const sessionTtlMs = Math.max(1, Number(process.env.SESSION_TTL_HOURS || 8)) * 60 * 60 * 1000;
const authCookieName = "bctc_session";
const sessions = new Map();
const loginAttempts = new Map();

function parseCookies(header) {
  return String(header || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const index = item.indexOf("=");
      if (index === -1) return cookies;
      cookies[decodeURIComponent(item.slice(0, index))] = decodeURIComponent(item.slice(index + 1));
      return cookies;
    }, {});
}

function cookie(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  parts.push("HttpOnly", "SameSite=Strict", "Path=/");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function tokenDigest(token) {
  return crypto.createHmac("sha256", sessionSecret).update(token).digest("base64url");
}

function pruneSessions() {
  const now = Date.now();
  for (const [key, value] of sessions.entries()) {
    if (value.expiresAt <= now) sessions.delete(key);
  }
}

function sessionUser(session) {
  return { username: session.username, role: session.role, isAdmin: session.role === "admin" };
}

function createSession(user) {
  pruneSessions();
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(tokenDigest(token), {
    userId: String(user.id),
    username: user.username,
    role: user.role,
    passwordChangedAt: new Date(user.password_changed_at).toISOString(),
    expiresAt: Date.now() + sessionTtlMs,
  });
  return token;
}

async function readSession(req) {
  if (!sessionSecret) return null;
  const token = parseCookies(req.headers.cookie)[authCookieName];
  if (!token) return null;
  const key = tokenDigest(token);
  const session = sessions.get(key);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(key);
    return null;
  }
  const result = await pool.query(
    `select id::text, username, role, password_changed_at
       from public.app_users
      where id = $1::bigint and is_active = true`,
    [session.userId],
  );
  const user = result.rows[0];
  if (!user || new Date(user.password_changed_at).toISOString() !== session.passwordChangedAt) {
    sessions.delete(key);
    return null;
  }
  session.username = user.username;
  session.role = user.role;
  session.expiresAt = Date.now() + sessionTtlMs;
  return session;
}

function registerLoginFailure(req) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const item = loginAttempts.get(ip) || { count: 0, resetAt: now + windowMs };
  if (item.resetAt <= now) {
    item.count = 0;
    item.resetAt = now + windowMs;
  }
  item.count += 1;
  loginAttempts.set(ip, item);
  return item;
}

function isLoginBlocked(req) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const item = loginAttempts.get(ip);
  if (!item || item.resetAt <= Date.now()) return false;
  return item.count >= 10;
}

function clearLoginFailures(req) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  loginAttempts.delete(ip);
}

const dummyPasswordHash = hashPassword("not-a-real-account-password");

app.post("/api/auth/login", async (req, res, next) => {
  if (!sessionSecret) {
    res.status(500).json({ ok: false, message: "Authentication is not configured" });
    return;
  }
  if (isLoginBlocked(req)) {
    res.status(429).json({ ok: false, message: "Too many failed login attempts. Try again later." });
    return;
  }
  try {
    const { username, password } = req.body || {};
    const normalizedUsername = normalizeUsername(username);
    const result = await pool.query(
      `select id::text, username, password_hash, role, is_active, password_changed_at,
              locked_until is not null and locked_until > now() as is_locked
         from public.app_users
        where username = $1`,
      [normalizedUsername],
    );
    const user = result.rows[0];
    const passwordMatches = verifyPassword(password, user?.password_hash || dummyPasswordHash);
    if (!user || !user.is_active || user.is_locked || !passwordMatches) {
      if (user && user.is_active && !user.is_locked) {
        await pool.query(
          `update public.app_users
              set failed_login_attempts = failed_login_attempts + 1,
                  locked_until = case when failed_login_attempts + 1 >= 10 then now() + interval '15 minutes' else locked_until end,
                  updated_at = now()
            where id = $1::bigint`,
          [user.id],
        );
      }
      registerLoginFailure(req);
      res.status(401).json({ ok: false, message: "Invalid username or password" });
      return;
    }
    await pool.query(
      `update public.app_users
          set failed_login_attempts = 0, locked_until = null, last_login_at = now(), updated_at = now()
        where id = $1::bigint`,
      [user.id],
    );
    clearLoginFailures(req);
    const token = createSession(user);
    res.setHeader("Set-Cookie", cookie(authCookieName, token, {
      maxAge: Math.floor(sessionTtlMs / 1000),
      secure: String(process.env.AUTH_COOKIE_SECURE || "false").toLowerCase() === "true",
    }));
    res.json({ ok: true, user: sessionUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", (req, res) => {
  const token = parseCookies(req.headers.cookie)[authCookieName];
  if (token && sessionSecret) sessions.delete(tokenDigest(token));
  res.setHeader("Set-Cookie", cookie(authCookieName, "", { maxAge: 0, secure: String(process.env.AUTH_COOKIE_SECURE || "false").toLowerCase() === "true" }));
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res, next) => {
  try {
    const session = await readSession(req);
    if (!session) {
      res.status(401).json({ ok: false, user: null });
      return;
    }
    res.json({ ok: true, user: sessionUser(session) });
  } catch (error) {
    next(error);
  }
});

app.use("/api", async (req, res, next) => {
  try {
    const session = await readSession(req);
    if (!session) {
      res.status(401).json({ ok: false, message: "Authentication required" });
      return;
    }
    req.user = session;
    next();
  } catch (error) {
    next(error);
  }
});

app.use("/api/admin", (req, res, next) => {
  if (req.user?.role !== "admin") {
    res.status(403).json({ ok: false, message: "Administrator permission required" });
    return;
  }
  next();
});

function validateNewPassword(password) {
  const value = String(password || "");
  if (value.length < 12 || value.length > 128) {
    const error = new Error("Password must be between 12 and 128 characters");
    error.status = 400;
    throw error;
  }
  return value;
}

function invalidateUserSessions(userId) {
  for (const [key, session] of sessions.entries()) {
    if (String(session.userId) === String(userId)) sessions.delete(key);
  }
}

const requiredColumns = [
  "id",
  "journal_id",
  "journal_num",
  "source_num",
  "journal_name",
  "posting_date",
  "status",
  "account_code",
  "account_name",
  "account_type",
  "root_account_code",
  "root_account_name",
  "debit",
  "credit",
  "balance",
  "account_analytic",
  "department",
];

const formulaVersion = "tt99-server-aggregation-v10-standard-monthly-snapshots";
const cashPrefixes = ["111", "112", "113"];
const excludedVirtualAccountNames = ["More Account 111/112", "More Account 131"];
const aggregateControlTable = "public.monthly_report_aggregate_controls";
const reportTimeZone = process.env.SNAPSHOT_TIME_ZONE || "Asia/Ho_Chi_Minh";

function notVirtualAccountSql(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return `coalesce(${prefix}account_name, '') not in ('${excludedVirtualAccountNames.join("', '")}')`;
}

const b01Lines = [
  ["100", "A - TÀI SẢN NGẮN HẠN", 0, "110+120+130+140+150+160", null, "debit", true],
  ["110", "I. Tiền và các khoản tương đương tiền", 1, "111+112", null, "debit", true],
  ["111", "1. Tiền", 2, null, ["111", "112", "113"], "debit"],
  ["112", "2. Các khoản tương đương tiền", 2, null, [], "debit", false, 1, true],
  ["120", "II. Đầu tư tài chính ngắn hạn", 1, "121+122+123+124+125+126", null, "debit", true],
  ["121", "1. Chứng khoán kinh doanh", 2, null, ["121"], "debit"],
  ["122", "2. Dự phòng giảm giá chứng khoán kinh doanh (*)", 2, null, ["2291"], "credit", false, -1],
  ["123", "3. Đầu tư nắm giữ đến ngày đáo hạn ngắn hạn", 2, null, ["128"], "debit", false, 1, true],
  ["124", "4. Dự phòng đầu tư nắm giữ đến ngày đáo hạn ngắn hạn (*)", 2, null, ["2291"], "credit", false, -1, true],
  ["125", "5. Đầu tư ngắn hạn khác", 2, null, ["1288"], "debit", false, 1, true],
  ["126", "6. Dự phòng tổn thất các khoản đầu tư ngắn hạn khác (*)", 2, null, ["2292"], "credit", false, -1, true],
  ["130", "III. Các khoản phải thu ngắn hạn", 1, "131+132+133+134+135+136+137", null, "debit", true],
  ["131", "1. Phải thu ngắn hạn của khách hàng", 2, null, ["131"], "debit"],
  ["132", "2. Trả trước cho người bán ngắn hạn", 2, null, ["331"], "debit", false, 1, true],
  ["133", "3. Phải thu nội bộ ngắn hạn", 2, null, ["136"], "debit", false, 1, true],
  ["134", "4. Phải thu theo tiến độ hợp đồng xây dựng", 2, null, ["337"], "debit"],
  ["135", "5. Phải thu ngắn hạn khác", 2, null, ["138", "141", "244", "334", "338"], "debit", false, 1, true],
  ["136", "6. Dự phòng phải thu ngắn hạn khó đòi (*)", 2, null, ["2293"], "credit", false, -1],
  ["137", "7. Tài sản thiếu chờ xử lý", 2, null, ["1381"], "debit"],
  ["140", "IV. Hàng tồn kho", 1, "141+142", null, "debit", true],
  ["141", "1. Hàng tồn kho", 2, null, ["151", "152", "153", "154", "155", "156", "157"], "debit"],
  ["142", "2. Dự phòng giảm giá hàng tồn kho (*)", 2, null, ["2294"], "credit", false, -1],
  ["150", "V. Tài sản sinh học ngắn hạn", 1, "151+152+153", null, "debit", true],
  ["151", "1. Súc vật nuôi lấy sản phẩm một lần ngắn hạn", 2, null, ["215"], "debit", false, 1, true],
  ["152", "2. Cây trồng theo mùa vụ hoặc lấy sản phẩm một lần ngắn hạn", 2, null, ["215"], "debit", false, 1, true],
  ["153", "3. Dự phòng tổn thất tài sản sinh học ngắn hạn (*)", 2, null, ["229"], "credit", false, -1, true],
  ["160", "VI. Tài sản ngắn hạn khác", 1, "161+162+163+164+165", null, "debit", true],
  ["161", "1. Chi phí chờ phân bổ ngắn hạn", 2, null, ["242"], "debit", false, 1, true],
  ["162", "2. Thuế GTGT được khấu trừ", 2, null, ["133"], "debit"],
  ["163", "3. Thuế và các khoản khác phải thu Nhà nước", 2, null, ["333"], "debit", false, 1, true],
  ["164", "4. Giao dịch mua bán lại trái phiếu Chính phủ", 2, null, ["171"], "debit"],
  ["165", "5. Tài sản ngắn hạn khác", 2, null, ["2288"], "debit", false, 1, true],
  ["200", "B - TÀI SẢN DÀI HẠN", 0, "210+220+230+240+250+260+270", null, "debit", true],
  ["210", "I. Các khoản phải thu dài hạn", 1, "211+212+213+214+215+216", null, "debit", true],
  ["211", "1. Phải thu dài hạn của khách hàng", 2, null, ["131"], "debit", false, 1, true],
  ["212", "2. Trả trước cho người bán dài hạn", 2, null, ["331"], "debit", false, 1, true],
  ["213", "3. Vốn kinh doanh ở đơn vị trực thuộc", 2, null, ["1361"], "debit", false, 1, true],
  ["214", "4. Phải thu nội bộ dài hạn", 2, null, ["1362", "1363", "1368"], "debit", false, 1, true],
  ["215", "5. Phải thu dài hạn khác", 2, null, ["1388", "334", "338", "141", "244"], "debit", false, 1, true],
  ["216", "6. Dự phòng phải thu dài hạn khó đòi (*)", 2, null, ["2293"], "credit", false, -1, true],
  ["220", "II. Tài sản cố định", 1, "221+224+227", null, "debit", true],
  ["221", "1. Tài sản cố định hữu hình", 2, "222+223", null, "debit", true],
  ["222", "- Nguyên giá", 3, null, ["211"], "debit"],
  ["223", "- Giá trị hao mòn lũy kế (*)", 3, null, ["2141"], "credit", false, -1],
  ["224", "2. Tài sản cố định thuê tài chính", 2, "225+226", null, "debit", true],
  ["225", "- Nguyên giá", 3, null, ["212"], "debit"],
  ["226", "- Giá trị hao mòn lũy kế (*)", 3, null, ["2142"], "credit", false, -1],
  ["227", "3. Tài sản cố định vô hình", 2, "228+229", null, "debit", true],
  ["228", "- Nguyên giá", 3, null, ["213"], "debit"],
  ["229", "- Giá trị hao mòn lũy kế (*)", 3, null, ["2143"], "credit", false, -1],
  ["230", "III. Tài sản sinh học dài hạn", 1, "231+236+237+238", null, "debit", true],
  ["231", "1. Súc vật nuôi cho sản phẩm định kỳ", 2, "232+233", null, "debit", true],
  ["232", "a) Súc vật nuôi cho sản phẩm định kỳ chưa đến giai đoạn trưởng thành", 3, null, ["21511"], "debit", false, 1, true],
  ["233", "b) Súc vật nuôi cho sản phẩm định kỳ đến giai đoạn trưởng thành", 3, "234+235", null, "debit", true],
  ["234", "- Nguyên giá", 4, null, ["21512"], "debit", false, 1, true],
  ["235", "- Giá trị khấu hao lũy kế (*)", 4, null, ["214"], "credit", false, -1, true],
  ["236", "2. Súc vật nuôi lấy sản phẩm một lần dài hạn", 2, null, ["215"], "debit", false, 1, true],
  ["237", "3. Cây trồng theo mùa vụ hoặc lấy sản phẩm một lần dài hạn", 2, null, ["215"], "debit", false, 1, true],
  ["238", "4. Dự phòng tổn thất tài sản sinh học dài hạn (*)", 2, null, ["229"], "credit", false, -1, true],
  ["240", "IV. Bất động sản đầu tư", 1, "241+242", null, "debit", true],
  ["241", "- Nguyên giá", 2, null, ["217"], "debit"],
  ["242", "- Giá trị hao mòn lũy kế (*)", 2, null, ["2147"], "credit", false, -1],
  ["250", "V. Tài sản dở dang dài hạn", 1, "251+252", null, "debit", true],
  ["251", "1. Chi phí sản xuất, kinh doanh dở dang dài hạn", 2, null, ["154"], "debit", false, 1, true],
  ["252", "2. Chi phí xây dựng cơ bản dở dang", 2, null, ["241"], "debit"],
  ["260", "VI. Đầu tư tài chính dài hạn", 1, "261+262+263+264+265+266", null, "debit", true],
  ["261", "1. Đầu tư vào công ty con", 2, null, ["221"], "debit"],
  ["262", "2. Đầu tư vào công ty liên doanh, liên kết", 2, null, ["222"], "debit"],
  ["263", "3. Đầu tư góp vốn vào đơn vị khác", 2, null, ["228"], "debit"],
  ["264", "4. Dự phòng tổn thất đầu tư vào đơn vị khác dài hạn (*)", 2, null, ["2292"], "credit", false, -1],
  ["265", "5. Đầu tư nắm giữ đến ngày đáo hạn dài hạn", 2, null, ["128"], "debit", false, 1, true],
  ["266", "6. Dự phòng đầu tư nắm giữ đến ngày đáo hạn dài hạn (*)", 2, null, ["2292"], "credit", false, -1, true],
  ["270", "VII. Tài sản dài hạn khác", 1, "271+272+273+274", null, "debit", true],
  ["271", "1. Chi phí chờ phân bổ dài hạn", 2, null, ["242"], "debit", false, 1, true],
  ["272", "2. Tài sản thuế thu nhập hoãn lại", 2, null, ["243"], "debit"],
  ["273", "3. Thiết bị, vật tư, phụ tùng thay thế dài hạn", 2, null, ["153"], "debit", false, 1, true],
  ["274", "4. Tài sản dài hạn khác", 2, null, ["244", "2288"], "debit", false, 1, true],
  ["280", "TỔNG CỘNG TÀI SẢN (280 = 100 + 200)", 0, "100+200", null, "debit", true],
  ["300", "C - NỢ PHẢI TRẢ", 0, "310+330", null, "credit", true],
  ["310", "I. Nợ ngắn hạn", 1, "311+312+313+314+315+316+317+318+319+320+321+322+323+324+325", null, "credit", true],
  ["311", "1. Phải trả người bán ngắn hạn", 2, null, ["331"], "credit", false, 1, true],
  ["312", "2. Người mua trả tiền trước ngắn hạn", 2, null, ["131"], "credit", false, 1, true],
  ["313", "3. Phải trả cổ tức, lợi nhuận", 2, null, ["338"], "credit", false, 1, true],
  ["314", "4. Thuế và các khoản phải nộp Nhà nước ngắn hạn", 2, null, ["333"], "credit", false, 1, true],
  ["315", "5. Phải trả người lao động", 2, null, ["334"], "credit"],
  ["316", "6. Chi phí phải trả ngắn hạn", 2, null, ["335"], "credit", false, 1, true],
  ["317", "7. Phải trả nội bộ ngắn hạn", 2, null, ["336"], "credit", false, 1, true],
  ["318", "8. Phải trả theo tiến độ hợp đồng xây dựng ngắn hạn", 2, null, ["337"], "credit"],
  ["319", "9. Doanh thu chờ phân bổ ngắn hạn", 2, null, ["3387"], "credit", false, 1, true],
  ["320", "10. Phải trả ngắn hạn khác", 2, null, ["338"], "credit", false, 1, true],
  ["321", "11. Vay và nợ thuê tài chính ngắn hạn", 2, null, ["341", "343"], "credit", false, 1, true],
  ["322", "12. Dự phòng phải trả ngắn hạn", 2, null, ["352"], "credit"],
  ["323", "13. Quỹ khen thưởng, phúc lợi", 2, null, ["353"], "credit"],
  ["324", "14. Quỹ bình ổn giá", 2, null, ["357"], "credit"],
  ["325", "15. Giao dịch mua bán lại trái phiếu Chính phủ", 2, null, ["171"], "credit"],
  ["330", "II. Nợ dài hạn", 1, "331+332+333+334+335+336+337+338+339+340+341+342+343+344", null, "credit", true],
  ["331", "1. Phải trả người bán dài hạn", 2, null, ["331"], "credit", false, 1, true],
  ["332", "2. Người mua trả tiền trước dài hạn", 2, null, ["131"], "credit", false, 1, true],
  ["333", "3. Thuế và các khoản phải nộp Nhà nước dài hạn", 2, null, ["333"], "credit", false, 1, true],
  ["334", "4. Chi phí phải trả dài hạn", 2, null, ["335"], "credit", false, 1, true],
  ["335", "5. Phải trả nội bộ về vốn kinh doanh", 2, null, ["3361"], "credit", false, 1, true],
  ["336", "6. Phải trả nội bộ dài hạn", 2, null, ["336"], "credit", false, 1, true],
  ["337", "7. Doanh thu chờ phân bổ dài hạn", 2, null, ["3387"], "credit", false, 1, true],
  ["338", "8. Phải trả dài hạn khác", 2, null, ["338"], "credit", false, 1, true],
  ["339", "9. Vay và nợ thuê tài chính dài hạn", 2, null, ["341", "343"], "credit", false, 1, true],
  ["340", "10. Trái phiếu chuyển đổi", 2, null, ["3432"], "credit", false, 1, true],
  ["341", "11. Cổ phiếu ưu đãi", 2, null, [], "credit", false, 1, true, [], true, true],
  ["342", "12. Thuế thu nhập hoãn lại phải trả", 2, null, ["347"], "credit"],
  ["343", "13. Dự phòng phải trả dài hạn", 2, null, ["352"], "credit", false, 1, true],
  ["344", "14. Quỹ phát triển khoa học và công nghệ", 2, null, ["356"], "credit"],
  ["400", "D - VỐN CHỦ SỞ HỮU", 0, "411+412+413+414+415+416+417+418+419+420", null, "credit", true],
  ["411", "1. Vốn góp của chủ sở hữu", 1, null, ["411"], "credit", false, 1, true],
  ["412", "2. Thặng dư vốn", 1, null, ["4112"], "credit", false, 1, true],
  ["413", "3. Quyền chọn chuyển đổi trái phiếu", 1, null, ["4113"], "credit", false, 1, true],
  ["414", "4. Vốn khác của chủ sở hữu", 1, null, ["4118"], "credit", false, 1, true],
  ["415", "5. Cổ phiếu mua lại của chính mình (*)", 1, null, ["419"], "debit", false, -1],
  ["416", "6. Chênh lệch đánh giá lại tài sản", 1, null, ["412"], "credit"],
  ["417", "7. Chênh lệch tỷ giá hối đoái", 1, null, ["413"], "credit"],
  ["418", "8. Quỹ đầu tư phát triển", 1, null, ["414"], "credit"],
  ["419", "9. Quỹ khác thuộc vốn chủ sở hữu", 1, null, ["418"], "credit"],
  ["420", "10. Lợi nhuận sau thuế chưa phân phối", 1, null, ["421"], "credit"],
  ["440", "TỔNG CỘNG NGUỒN VỐN (440 = 300 + 400)", 0, "300+400", null, "credit", true],
];

// Tuple indexes: 4 prefixes, 8 requiresManualMapping, 9 excluded prefixes,
// 10 manualOnly, 11 nullWhenManual. Ambiguous maturity/nature lines must not
// reuse the same balance in several statutory captions; statutory values that
// require information outside journal stay null instead of becoming zero.
const b01Overrides = {
  "123": [["1281"], false], "124": [[], true, [], true], "125": [["1288"], false], "126": [[], true, [], true],
  "132": [["331"], false], "135": [["138", "141", "2441", "334", "338"], false, ["1381"]],
  "133": [["136"], false, ["1361"]], "165": [[], true, [], true],
  "151": [[], true, [], true], "152": [[], true, [], true], "153": [[], true, [], true],
  "161": [["2421"], false], "211": [[], true, [], true], "212": [[], true, [], true],
  "214": [[], true, [], true], "215": [["2442"], false], "216": [[], true, [], true], "235": [[], true, [], true],
  "236": [[], true, [], true], "237": [[], true, [], true], "238": [[], true, [], true],
  "251": [[], true, [], true], "265": [[], true, [], true], "266": [[], true, [], true], "271": [["2422"], false],
  "273": [[], true, [], true], "274": [[], true, [], true], "311": [["331"], false], "312": [["131"], false],
  "313": [["332"], false], "317": [["336"], false, ["3361"]],
  "320": [["138", "141", "2441", "338", "3441"], false, ["1381", "3387"]], "321": [["3411"], false],
  "331": [[], true, [], true], "332": [[], true, [], true], "333": [[], true, [], true], "334": [[], true, [], true],
  "336": [[], true, [], true], "337": [[], true, [], true],
  "338": [["3442"], false], "339": [["3412", "3431"], false], "340": [["3432"], false],
  "343": [[], true, [], true],
};
for (const line of b01Lines) {
  const override = b01Overrides[line[0]];
  if (!override) continue;
  line[4] = override[0];
  line[8] = override[1];
  line[9] = override[2] || [];
  line[10] = Boolean(override[3]);
}
const retainedEarningsIndex = b01Lines.findIndex((line) => line[0] === "420");
const retainedEarningsLabel = b01Lines[retainedEarningsIndex][1];
b01Lines.splice(
  retainedEarningsIndex,
  1,
  ["420", retainedEarningsLabel, 1, "420a+420b", null, "credit", true],
  ["420a", "- LNST chưa phân phối lũy kế đến cuối kỳ trước", 2, null, ["4211"], "credit"],
  ["420b", "- LNST chưa phân phối kỳ này", 2, null, ["4212"], "credit"],
);
const ownerCapitalIndex = b01Lines.findIndex((line) => line[0] === "411");
const ownerCapitalLabel = b01Lines[ownerCapitalIndex][1];
b01Lines.splice(
  ownerCapitalIndex,
  1,
  ["411", ownerCapitalLabel, 1, "411a+411b", null, "credit", true],
  ["411a", "- Cổ phiếu phổ thông có quyền biểu quyết", 2, null, ["41111"], "credit"],
  ["411b", "- Cổ phiếu ưu đãi", 2, null, ["41112"], "credit"],
);

const b02Lines = [
  ["01", "1. Doanh thu bán hàng và cung cấp dịch vụ", 0, null, ["511"], "credit", false, 1, false, ["5117"]],
  ["02", "2. Các khoản giảm trừ doanh thu", 0, null, ["521"], "debit"],
  ["10", "3. Doanh thu thuần về bán hàng và cung cấp dịch vụ (10 = 01 - 02)", 0, "01-02", null, "credit", true],
  ["11", "4. Giá vốn hàng bán", 0, null, ["632"], "debit", false, 1, false, ["6327"]],
  ["20", "5. Lợi nhuận gộp về bán hàng và cung cấp dịch vụ (20 = 10 - 11)", 0, "10-11", null, "credit", true],
  ["21", "6. Lãi/lỗ của hoạt động bán, thanh lý bất động sản đầu tư", 0, null, ["5117", "6327"], "credit", false, 1, true],
  ["22", "7. Doanh thu hoạt động tài chính", 0, null, ["515"], "credit"],
  ["23", "8. Chi phí tài chính", 0, null, ["635"], "debit"],
  ["24", "Trong đó: Chi phí đi vay", 1, null, ["635411", "635412", "635413"], "debit", false, 1, true],
  ["25", "9. Chi phí bán hàng", 0, null, ["641"], "debit"],
  ["26", "10. Chi phí quản lý doanh nghiệp", 0, null, ["642"], "debit"],
  ["30", "11. Lợi nhuận thuần từ hoạt động kinh doanh", 0, "20+21+22-23-25-26", null, "credit", true],
  ["31", "12. Thu nhập khác", 0, null, ["711"], "credit"],
  ["32", "13. Chi phí khác", 0, null, ["811"], "debit"],
  ["40", "14. Lợi nhuận khác (40 = 31 - 32)", 0, "31-32", null, "credit", true],
  ["50", "15. Tổng lợi nhuận kế toán trước thuế (50 = 30 + 40)", 0, "30+40", null, "credit", true],
  ["51", "16. Chi phí thuế TNDN hiện hành", 0, null, ["8211"], "debit"],
  ["52", "17. Chi phí thuế TNDN hoãn lại", 0, null, ["8212"], "debit"],
  ["60", "18. Lợi nhuận sau thuế thu nhập doanh nghiệp (60 = 50 - 51 - 52)", 0, "50-51-52", null, "credit", true],
  ["70", "19. Lãi cơ bản trên cổ phiếu (*)", 0, null, [], "credit", false, 1, true, [], true, true],
  ["71", "20. Lãi suy giảm trên cổ phiếu (*)", 0, null, [], "credit", false, 1, true, [], true, true],
];

const b03Lines = [
  ["", "I. Lưu chuyển tiền từ hoạt động kinh doanh", 0, null, true],
  ["01", "1. Tiền thu từ bán hàng, cung cấp dịch vụ và doanh thu khác", 1],
  ["02", "2. Tiền chi trả cho người cung cấp hàng hóa và dịch vụ", 1],
  ["03", "3. Tiền chi trả cho người lao động", 1],
  ["04", "4. Chi phí đi vay đã trả", 1],
  ["05", "5. Thuế thu nhập doanh nghiệp đã nộp", 1],
  ["06", "6. Tiền thu khác từ hoạt động kinh doanh", 1],
  ["07", "7. Tiền chi khác cho hoạt động kinh doanh", 1],
  ["20", "Lưu chuyển tiền thuần từ hoạt động kinh doanh", 0, "01+02+03+04+05+06+07", true],
  ["", "II. Lưu chuyển tiền từ hoạt động đầu tư", 0, null, true],
  ["21", "1. Tiền chi để mua sắm, xây dựng TSCĐ và các tài sản dài hạn khác", 1],
  ["22", "2. Tiền thu từ thanh lý, nhượng bán TSCĐ và các tài sản dài hạn khác", 1],
  ["23", "3. Tiền chi cho vay, mua các công cụ nợ của đơn vị khác", 1],
  ["24", "4. Tiền thu hồi cho vay, bán lại các công cụ nợ của đơn vị khác", 1],
  ["25", "5. Tiền chi đầu tư góp vốn vào đơn vị khác", 1],
  ["26", "6. Tiền thu hồi đầu tư góp vốn vào đơn vị khác", 1],
  ["27", "7. Tiền thu lãi cho vay, cổ tức và lợi nhuận được chia", 1],
  ["30", "Lưu chuyển tiền thuần từ hoạt động đầu tư", 0, "21+22+23+24+25+26+27", true],
  ["", "III. Lưu chuyển tiền từ hoạt động tài chính", 0, null, true],
  ["31", "1. Tiền thu từ phát hành cổ phiếu, nhận vốn góp của chủ sở hữu", 1],
  ["32", "2. Tiền trả lại vốn góp cho các chủ sở hữu, mua lại cổ phiếu đã phát hành", 1],
  ["33", "3. Tiền thu từ đi vay", 1],
  ["34", "4. Tiền trả nợ gốc vay", 1],
  ["35", "5. Tiền trả nợ gốc thuê tài chính", 1],
  ["36", "6. Cổ tức, lợi nhuận đã trả cho chủ sở hữu", 1],
  ["40", "Lưu chuyển tiền thuần từ hoạt động tài chính", 0, "31+32+33+34+35+36", true],
  ["50", "Lưu chuyển tiền thuần trong kỳ (50 = 20+30+40)", 0, "20+30+40", true],
  ["60", "Tiền và tương đương tiền đầu kỳ", 0, null, true],
  ["61", "Ảnh hưởng của thay đổi tỷ giá hối đoái quy đổi ngoại tệ", 0],
  ["70", "Tiền và tương đương tiền cuối kỳ (70 = 50+60+61)", 0, "50+60+61", true],
];

const legacyCashFlowRules = [
  { code: "01", direction: "in", prefixes: ["511", "33311", "131", "121"], text: ["khách hàng", "invoice", "bán hàng", "doanh thu"] },
  { code: "02", direction: "out", prefixes: ["121", "133", "151", "152", "153", "154", "155", "156", "157", "331", "621", "622", "627", "632", "641", "642"], text: ["nhà cung cấp", "mua hàng", "giá vốn", "dịch vụ", "chi phí quản lý"] },
  { code: "03", direction: "out", prefixes: ["334", "3382", "3383", "3384", "3385", "3386"], text: ["lương", "nhân viên", "salary", "payroll"] },
  { code: "04", direction: "out", prefixes: ["335", "635"], text: ["lãi vay", "interest"] },
  { code: "05", direction: "out", prefixes: ["3334", "821"], text: ["thuế tndn"] },
  { code: "21", direction: "out", prefixes: ["211", "212", "213", "217", "241"], text: ["tài sản cố định", "tscđ", "xây dựng"] },
  { code: "22", direction: "in", prefixes: ["211", "212", "213", "217", "711"], text: ["thanh lý", "nhượng bán"] },
  { code: "23", direction: "out", prefixes: ["128", "228"], text: ["cho vay", "mua công cụ nợ"] },
  { code: "24", direction: "in", prefixes: ["128", "228"], text: ["thu hồi cho vay", "bán công cụ nợ"] },
  { code: "25", direction: "out", prefixes: ["221", "222", "228"], text: ["góp vốn", "đầu tư"] },
  { code: "26", direction: "in", prefixes: ["221", "222", "228"], text: ["thu hồi đầu tư"] },
  { code: "27", direction: "in", prefixes: ["515", "138"], text: ["lãi cho vay", "cổ tức", "lợi nhuận được chia"] },
  { code: "31", direction: "in", prefixes: ["411"], text: ["góp vốn", "phát hành cổ phiếu"] },
  { code: "32", direction: "out", prefixes: ["411", "419"], text: ["trả lại vốn", "mua lại cổ phiếu"] },
  { code: "33", direction: "in", prefixes: ["341"], text: ["vay", "giải ngân"] },
  { code: "34", direction: "out", prefixes: ["341"], text: ["trả nợ vay", "gốc vay"] },
  { code: "35", direction: "out", prefixes: ["3412", "315"], text: ["thuê tài chính"] },
  { code: "36", direction: "out", prefixes: ["421"], text: ["cổ tức", "lợi nhuận đã trả"] },
  { code: "06", direction: "in", prefixes: ["141"], text: ["thu khác"] },
  { code: "07", direction: "out", prefixes: ["338"], text: ["chi khác"] },
  { code: "01", direction: "out", prefixes: ["131"], text: [] },
  { code: "06", direction: "out", prefixes: ["141"], text: [] },
  { code: "07", direction: "in", prefixes: ["338"], text: [] },
];

const cashFlowRules = [
  { code: "06", direction: "in", prefixes: ["344111"], text: ["nhan ky quy", "nhan ky cuoc"] },
  { code: "02", direction: "in", prefixes: ["641712"], text: ["hoan chi phi ban hang", "hoan chi phi dich vu"] },
  { code: "01", direction: "in", prefixes: ["511", "33311", "131", "121"], text: ["khach hang", "customer", "invoice", "ban hang", "doanh thu"] },
  { code: "02", direction: "in", prefixes: ["331"], text: ["hoan tien nha cung cap", "hoan ung nha cung cap"] },
  { code: "06", direction: "in", prefixes: ["138", "244", "338", "711", "141"], text: ["thu khac"] },
  { code: "33", direction: "in", prefixes: ["341"], text: ["vay", "giai ngan"] },
  { code: "27", direction: "in", prefixes: ["515111"], text: ["lai cho vay", "lai tien gui co ky han", "co tuc", "loi nhuan duoc chia"] },
  { code: "22", direction: "in", prefixes: ["211", "212", "213", "217"], text: ["thanh ly", "nhuong ban"] },
  { code: "24", direction: "in", prefixes: ["128", "228"], text: ["thu hoi cho vay", "ban cong cu no"] },
  { code: "26", direction: "in", prefixes: ["221", "222", "228"], text: ["thu hoi dau tu"] },
  { code: "31", direction: "in", prefixes: ["411"], text: ["gop von", "phat hanh co phieu"] },
  { code: "02", direction: "out", prefixes: ["121", "133", "151", "152", "153", "154", "155", "156", "157", "331", "621", "622", "627", "632", "641", "642"], text: ["nha cung cap", "mua hang", "gia von", "dich vu", "chi phi quan ly"] },
  { code: "07", direction: "out", prefixes: ["344111"], text: ["tra lai ky quy", "tra lai ky cuoc"] },
  { code: "03", direction: "out", prefixes: ["334", "3382", "3383", "3384", "3385", "3386"], text: ["luong", "nhan vien", "salary", "payroll"] },
  { code: "04", direction: "out", prefixes: ["635"], text: ["lai vay", "interest"] },
  { code: "05", direction: "out", prefixes: ["3334", "821"], text: ["thue tndn"] },
  { code: "07", direction: "out", prefixes: ["333"], excludePrefixes: ["3334"], text: ["thue", "phi", "le phi"] },
  { code: "07", direction: "out", prefixes: ["138", "244", "338"], text: ["chi khac"] },
  { code: "21", direction: "out", prefixes: ["211", "212", "213", "217", "241"], text: ["tai san co dinh", "tscd", "xay dung"] },
  { code: "01", direction: "out", prefixes: ["131"], text: [] },
  { code: "23", direction: "out", prefixes: ["128", "228"], text: ["cho vay", "mua cong cu no"] },
  { code: "25", direction: "out", prefixes: ["221", "222", "228"], text: ["gop von", "dau tu"] },
  { code: "32", direction: "out", prefixes: ["411", "419"], text: ["tra lai von", "mua lai co phieu"] },
  { code: "34", direction: "out", prefixes: ["341"], text: ["tra no vay", "goc vay"] },
  { code: "35", direction: "out", prefixes: ["3412", "315"], text: ["thue tai chinh"] },
  { code: "36", direction: "out", prefixes: ["421"], text: ["co tuc", "loi nhuan da tra"] },
  { code: "06", direction: "out", prefixes: ["141"], text: [] },
];

function oneYearBack(dateText) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

function yearStart(dateText) {
  return `${String(dateText).slice(0, 4)}-01-01`;
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function b01OpeningBalanceDate(endDate) {
  const reportYearStart = yearStart(endDate);
  return addDays(reportYearStart, -1);
}

function periodOpeningBalanceDate(startDate) {
  return addDays(startDate, -1);
}

function validateDate(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
    const error = new Error(`${field} must be YYYY-MM-DD`);
    error.status = 400;
    throw error;
  }
}

function normalizeCode(value) {
  return String(value || "").replace(/^0+/, "");
}

function normalizeText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

function codeMatches(code, prefixes = []) {
  const normalized = normalizeCode(code);
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

function ruleMatchesAccounts(rule, accounts) {
  if (!rule.prefixes.length) return false;
  return accounts.some((account) => {
    const included = rule.prefixes.some((prefix) => account.startsWith(prefix));
    const excluded = (rule.excludePrefixes || []).some((prefix) => account.startsWith(prefix));
    return included && !excluded;
  });
}

function oneSidedBalance(accountRows, normalSide) {
  return accountRows.reduce((total, row) => {
    const value = normalSide === "credit" ? Number(row.credit || 0) - Number(row.debit || 0) : Number(row.debit || 0) - Number(row.credit || 0);
    return total + Math.max(0, value);
  }, 0);
}

const grossBalanceCodes = new Set(["131", "132", "135", "163", "311", "312", "314", "315", "320"]);

function netBalance(accountRows, normalSide) {
  return accountRows.reduce((total, row) => {
    if (normalSide === "credit") return total + Number(row.credit || 0) - Number(row.debit || 0);
    return total + Number(row.debit || 0) - Number(row.credit || 0);
  }, 0);
}

function periodActivity(accountRows, side) {
  return accountRows.reduce((total, row) => {
    if (side === "credit") return total + Number(row.credit || 0) - Number(row.debit || 0);
    return total + Number(row.debit || 0) - Number(row.credit || 0);
  }, 0);
}

function evalExpression(expression, values) {
  return String(expression || "")
    .replace(/\s/g, "")
    .split(/(?=[+-])/)
    .reduce((total, token) => {
      const sign = token.startsWith("-") ? -1 : 1;
      const code = token.replace(/^[+-]/, "");
      return total + sign * Number(values.get(code) || 0);
    }, 0);
}

function expressionCodes(expression) {
  return String(expression || "")
    .replace(/\s/g, "")
    .split(/[-+]/)
    .map((code) => code.trim())
    .filter(Boolean);
}

function collectLinePrefixes(lines, code, seen = new Set()) {
  if (!code || seen.has(code)) return [];
  seen.add(code);
  const line = lines.find((item) => item[0] === code);
  if (!line) return [];
  const expression = line[3];
  const prefixes = line[4];
  if (Array.isArray(prefixes) && prefixes.length) return prefixes;
  return Array.from(new Set(expressionCodes(expression).flatMap((childCode) => collectLinePrefixes(lines, childCode, seen))));
}

function collectLineExcludedPrefixes(lines, code, seen = new Set()) {
  if (!code || seen.has(code)) return [];
  seen.add(code);
  const line = lines.find((item) => item[0] === code);
  if (!line) return [];
  const expression = line[3];
  const excludedPrefixes = line[9];
  const direct = Array.isArray(excludedPrefixes) ? excludedPrefixes : [];
  if (!expression) return direct;
  return Array.from(new Set([
    ...direct,
    ...expressionCodes(expression).flatMap((childCode) => collectLineExcludedPrefixes(lines, childCode, seen)),
  ]));
}

function collectB03Codes(code, seen = new Set()) {
  if (!code || seen.has(code)) return [];
  seen.add(code);
  const line = b03Lines.find((item) => item[0] === code);
  if (!line) return [];
  const expression = line[3];
  if (!expression) return [code];
  return Array.from(new Set(expressionCodes(expression).flatMap((childCode) => collectB03Codes(childCode, seen))));
}

function buildLineReport(lines, currentAgg, priorAgg, mode) {
  const currentValues = new Map();
  const priorValues = new Map();
  const currentSources = new Map();
  const allCurrent = currentAgg || [];
  const allPrior = priorAgg || [];

  for (const [code, _label, _level, expression, prefixes, side, _bold, sign = 1, requiresManualMapping, excludedPrefixes = [], manualOnly = false, nullWhenManual = false] of lines) {
    if (!code || expression || !prefixes) continue;
    const matchesLine = (row) => {
      const accountCode = row.account_code || row.root_account_code;
      return codeMatches(accountCode, prefixes) && !codeMatches(accountCode, excludedPrefixes);
    };
    const currentRows = manualOnly ? [] : allCurrent.filter(matchesLine);
    const priorRows = manualOnly ? [] : allPrior.filter(matchesLine);
    const calc = mode === "balance" ? (grossBalanceCodes.has(code) ? oneSidedBalance : netBalance) : periodActivity;
    if (!(manualOnly && nullWhenManual)) {
      currentValues.set(code, manualOnly ? 0 : calc(currentRows, side) * sign);
      priorValues.set(code, manualOnly ? 0 : calc(priorRows, side) * sign);
    }
    currentSources.set(code, prefixes);
  }

  for (let pass = 0; pass < 4; pass += 1) {
    for (const [code, _label, _level, expression] of lines) {
      if (!code || !expression) continue;
      currentValues.set(code, evalExpression(expression, currentValues));
      priorValues.set(code, evalExpression(expression, priorValues));
    }
  }

  return lines.map(([code, label, level, expression, prefixes, _side, bold, _sign, requiresManualMapping]) => ({
    label,
    code,
    current: code ? currentValues.get(code) ?? null : null,
    prior: code ? priorValues.get(code) ?? null : null,
    level,
    bold: Boolean(bold),
    formula: expression || (prefixes ? `${mode}: ${prefixes.join(", ")}` : ""),
    sourceRef: "TT99/2025/TT-BTC Phụ lục IV",
    requiresManualMapping: Boolean(requiresManualMapping),
    sourceAccounts: currentSources.get(code) || prefixes || [],
    sources: [],
  }));
}

function reportValue(rows, code, side = "current") {
  const row = rows.find((item) => item.code === code);
  return Number(row?.[side] || 0);
}

function classifyCashMovement(movement) {
  const direction = Number(movement.amount || 0) >= 0 ? "in" : "out";
  const accounts = Array.isArray(movement.opposite_accounts) ? movement.opposite_accounts.map(normalizeCode) : [];
  const text = normalizeText(`${movement.source_num || ""} ${movement.journal_name || ""} ${movement.account_name || ""}`);
  if (!accounts.length && Number(movement.cash_peer_count || 0) > 0) {
    return { code: "__internal_cash_transfer", reason: "Chuyển tiền nội bộ giữa 111/112/113 - loại khỏi B03" };
  }

  const isFxRevaluation = ["danh gia lai", "chenh lech ty gia", "revaluation", "exchange difference"].some((needle) => text.includes(needle));
  if (isFxRevaluation && accounts.some((account) => codeMatches(account, ["413", "515", "635"]))) {
    return { code: "61", reason: "Ảnh hưởng đánh giá lại tiền và tương đương tiền bằng ngoại tệ" };
  }

  const scoredMatches = cashFlowRules
    .filter((rule) => rule.direction === direction && ruleMatchesAccounts(rule, accounts))
    .map((rule) => ({ rule, score: Math.max(...rule.prefixes.filter((prefix) => accounts.some((account) => account.startsWith(prefix))).map((prefix) => prefix.length)) }));
  const maxSpecificity = scoredMatches.length ? Math.max(...scoredMatches.map((item) => item.score)) : 0;
  const accountMatches = scoredMatches.filter((item) => item.score === maxSpecificity).map((item) => item.rule);
  const accountCodes = Array.from(new Set(accountMatches.map((rule) => rule.code)));
  if (accountCodes.length === 1) return { code: accountCodes[0], reason: `Đối ứng: ${accounts.join(", ")}` };
  if (accountCodes.length > 1) return { code: "", reason: `Nhiều mã B03 có thể áp dụng (${accountCodes.join(", ")}): ${accounts.join(", ")}` };

  const textMatches = cashFlowRules.filter((rule) => rule.direction === direction && rule.text.some((needle) => text.includes(needle)));
  const textCodes = Array.from(new Set(textMatches.map((rule) => rule.code)));
  if (textCodes.length === 1) return { code: textCodes[0], reason: "Phân loại theo nội dung chứng từ" };
  if (textCodes.length > 1) return { code: "", reason: `Nội dung khớp nhiều mã B03: ${textCodes.join(", ")}` };
  return { code: "", reason: accounts.length ? `Chưa có rule cho đối ứng: ${accounts.join(", ")}` : "Không có tài khoản đối ứng" };
}

function buildB03(currentMovements, priorMovements, currentOpeningCash, priorOpeningCash) {
  const currentTotals = new Map();
  const priorTotals = new Map();
  const sourceAccounts = new Map();

  for (const movement of currentMovements) {
    if (!movement.matched_code) continue;
    currentTotals.set(movement.matched_code, (currentTotals.get(movement.matched_code) || 0) + Number(movement.amount || 0));
    sourceAccounts.set(movement.matched_code, Array.from(new Set([...(sourceAccounts.get(movement.matched_code) || []), ...(movement.opposite_accounts || [])])));
  }
  for (const movement of priorMovements) {
    if (!movement.matched_code) continue;
    priorTotals.set(movement.matched_code, (priorTotals.get(movement.matched_code) || 0) + Number(movement.amount || 0));
  }
  if (!currentTotals.has("61")) currentTotals.set("61", 0);
  if (!priorTotals.has("61")) priorTotals.set("61", 0);
  currentTotals.set("60", Number(currentOpeningCash || 0));
  priorTotals.set("60", Number(priorOpeningCash || 0));

  for (let pass = 0; pass < 4; pass += 1) {
    for (const [code, _label, _level, expression] of b03Lines) {
      if (!code || !expression) continue;
      currentTotals.set(code, evalExpression(expression, currentTotals));
      priorTotals.set(code, evalExpression(expression, priorTotals));
    }
  }

  return b03Lines.map(([code, label, level, expression, bold]) => ({
    label,
    code,
    current: code ? currentTotals.get(code) ?? null : null,
    prior: code ? priorTotals.get(code) ?? null : null,
    level,
    bold: Boolean(bold),
    formula: expression || "SQL aggregate cash 111/112/113 by opposite accounts in same journal_id",
    sourceRef: "TT99/2025/TT-BTC Phụ lục IV - Mẫu B03-DN trực tiếp",
    sourceAccounts: sourceAccounts.get(code) || [],
    sources: [],
  }));
}

function buildLegacyB09(B01, B02, B03) {
  const manual = "Cần người lập bổ sung chi tiết theo sổ phụ, hợp đồng và hồ sơ ngoài journal";
  const values = (report, codes) => ["current", "prior"].map((side) => {
    const sourceValues = codes.map((code) => report.find((row) => row.code === code)?.[side] ?? null);
    return sourceValues.every((value) => value == null) ? null : sourceValues.reduce((total, value) => total + Number(value || 0), 0);
  });
  const disclosureRow = (number, label, report, codes, note = manual) => {
    const [current, prior] = report && codes.length ? values(report, codes) : [null, null];
    const source = report && codes.length ? `${report === B01 ? "B01" : report === B02 ? "B02" : "B03"}.${codes.join("+")}` : "Chưa nhập";
    return [`${number}. ${label}`, current, prior, `${source}; ${note}`];
  };
  const sections = [
    {
      title: "I. Đặc điểm hoạt động của doanh nghiệp",
      paragraphs: [
        "1. Hình thức sở hữu vốn - Cần bổ sung.",
        "2. Lĩnh vực kinh doanh - Cần bổ sung.",
        "3. Ngành nghề kinh doanh - Cần bổ sung.",
        "4. Chu kỳ sản xuất, kinh doanh thông thường - Cần bổ sung.",
        "5. Đặc điểm hoạt động trong năm tài chính có ảnh hưởng đến Báo cáo tài chính - Cần bổ sung.",
        "6. Cấu trúc doanh nghiệp: công ty con, công ty liên doanh/liên kết và đơn vị trực thuộc - Cần bổ sung.",
        "7. Số lượng người lao động cuối niên độ hoặc bình quân trong niên độ - Cần bổ sung.",
        "8. Tuyên bố về khả năng so sánh thông tin và giải trình nếu không so sánh được - Cần bổ sung.",
        "9. Các thông tin khác theo pháp luật doanh nghiệp, chứng khoán và pháp luật liên quan - Cần bổ sung.",
      ],
    },
    {
      title: "II. Kỳ kế toán, đơn vị tiền tệ sử dụng trong kế toán",
      paragraphs: [
        "1. Kỳ kế toán năm: cần xác nhận ngày bắt đầu và ngày kết thúc.",
        "2. Đơn vị tiền tệ sử dụng trong kế toán; nếu thay đổi phải giải trình lý do và ảnh hưởng - Cần bổ sung.",
      ],
    },
    {
      title: "III. Chuẩn mực và Chế độ kế toán áp dụng",
      paragraphs: [
        "1. Chế độ kế toán áp dụng: Thông tư 99/2025/TT-BTC - Người lập phải xác nhận.",
        "2. Tuyên bố tuân thủ Chuẩn mực kế toán Việt Nam và Chế độ kế toán doanh nghiệp; các ngoại lệ (nếu có) phải được giải trình.",
      ],
    },
    {
      title: "IV. Các chính sách kế toán, ước tính kế toán và quy định pháp luật có liên quan",
      paragraphs: [
        "1. Chuyển đổi Báo cáo tài chính lập bằng ngoại tệ sang Đồng Việt Nam.",
        "2. Các loại tỷ giá hối đoái áp dụng trong kế toán.",
        "3. Xác định lãi suất thực tế dùng để chiết khấu dòng tiền.",
        "4. Ghi nhận tiền và các khoản tương đương tiền.",
        "5. Kế toán các khoản đầu tư tài chính.",
        "6. Kế toán nợ phải thu.",
        "7. Kế toán hàng tồn kho.",
        "8. Kế toán và khấu hao TSCĐ hữu hình, TSCĐ vô hình, TSCĐ thuê tài chính và bất động sản đầu tư.",
        "9. Kế toán tài sản sinh học.",
        "10. Kế toán hợp đồng hợp tác kinh doanh.",
        "11. Kế toán chi phí chờ phân bổ.",
        "12. Kế toán phải trả người bán.",
        "13. Kế toán phải trả cổ tức, lợi nhuận.",
        "14. Ghi nhận chi phí phải trả.",
        "15. Ghi nhận doanh thu chờ phân bổ.",
        "16. Kế toán dự phòng phải trả.",
        "17. Kế toán thuế TNDN hoãn lại.",
        "18. Ghi nhận vay và nợ thuê tài chính.",
        "19. Ghi nhận và vốn hóa chi phí đi vay.",
        "20. Ghi nhận trái phiếu chuyển đổi.",
        "21. Ghi nhận vốn chủ sở hữu, cổ phiếu mua lại, cổ tức và phân phối lợi nhuận.",
        "22. Ghi nhận doanh thu bán hàng, cung cấp dịch vụ, doanh thu xây dựng và thu nhập khác.",
        "23. Kế toán các khoản giảm trừ doanh thu.",
        "24. Kế toán giá vốn hàng bán.",
        "25. Kế toán chi phí tài chính.",
        "26. Kế toán chi phí bán hàng và chi phí quản lý doanh nghiệp.",
        "27. Kế toán bán, thanh lý TSCĐ và bất động sản đầu tư.",
        "28. Ghi nhận chi phí thuế TNDN hiện hành và hoãn lại.",
        "29. Các nguyên tắc và phương pháp kế toán khác.",
        "Toàn bộ nội dung phần IV là chính sách do doanh nghiệp lựa chọn và phải được người lập nhập, phê duyệt; ứng dụng không suy diễn từ số phát sinh journal.",
      ],
    },
    {
      title: "V. Thông tin bổ sung cho các khoản mục trình bày trong Báo cáo tình hình tài chính",
      table: {
        columns: ["Khoản mục theo B09-DN", "Cuối năm", "Đầu năm", "Nguồn và mức hoàn thiện"],
        rows: [
          disclosureRow(1, "Tiền và các khoản tương đương tiền", B01, ["110"]),
          disclosureRow(2, "Các khoản đầu tư tài chính", B01, ["120", "260"]),
          disclosureRow(3, "Phải thu của khách hàng", B01, ["131", "211"]),
          disclosureRow(4, "Phải thu khác", B01, ["135", "215"]),
          disclosureRow(5, "Tài sản thiếu chờ xử lý", B01, ["137"]),
          disclosureRow(6, "Nợ xấu", B01, ["136", "216"]),
          disclosureRow(7, "Hàng tồn kho", B01, ["140"]),
          disclosureRow(8, "Tài sản dở dang dài hạn", B01, ["250"]),
          disclosureRow(9, "Tăng, giảm tài sản cố định hữu hình", B01, ["221"]),
          disclosureRow(10, "Tăng, giảm tài sản cố định vô hình", B01, ["227"]),
          disclosureRow(11, "Tăng, giảm tài sản cố định thuê tài chính", B01, ["224"]),
          disclosureRow(12, "Tài sản sinh học", B01, ["150", "230"]),
          disclosureRow(13, "Tăng, giảm bất động sản đầu tư", B01, ["240"]),
          disclosureRow(14, "Chi phí chờ phân bổ", B01, ["161", "271"]),
          disclosureRow(15, "Tài sản khác", B01, ["165", "274"]),
          disclosureRow(16, "Vay và nợ thuê tài chính", B01, ["321", "339"]),
          disclosureRow(17, "Phải trả người bán", B01, ["311", "331"]),
          disclosureRow(18, "Phải trả về cổ tức, lợi nhuận", B01, ["313"]),
          disclosureRow(19, "Thuế và các khoản phải nộp Nhà nước", B01, ["314", "333"]),
          disclosureRow(20, "Chi phí phải trả", B01, ["316", "334"]),
          disclosureRow(21, "Phải trả khác", B01, ["320", "338"]),
          disclosureRow(22, "Doanh thu chờ phân bổ", B01, ["319", "337"]),
          disclosureRow(23, "Trái phiếu phát hành", B01, ["340"]),
          disclosureRow(24, "Cổ phiếu ưu đãi phân loại là nợ phải trả", B01, ["341"]),
          disclosureRow(25, "Dự phòng phải trả", B01, ["322", "343"]),
          disclosureRow(26, "Tài sản thuế TNDN hoãn lại và thuế TNDN hoãn lại phải trả", B01, ["272", "342"]),
          disclosureRow(27, "Vốn chủ sở hữu", B01, ["400"]),
          disclosureRow(28, "Chênh lệch đánh giá lại tài sản", B01, ["416"]),
          disclosureRow(29, "Chênh lệch tỷ giá", B01, ["417"]),
          disclosureRow(30, "Các khoản mục ngoài Báo cáo tình hình tài chính", null, []),
          disclosureRow(31, "Tài sản đang nắm giữ của bên khác bị giới hạn sử dụng và nghĩa vụ phải thanh toán theo hợp đồng/pháp luật", null, []),
          disclosureRow(32, "Các thông tin khác cần thuyết minh, giải trình thêm", null, []),
        ],
      },
      paragraphs: ["Các tổng số lấy từ B01 chỉ là điểm đối chiếu. B09-DN còn yêu cầu bảng tăng/giảm, thời hạn, đối tượng, nguyên giá, hao mòn, dự phòng, tài sản bảo đảm và các chi tiết khác mà journal hiện không chứa đủ."],
    },
    {
      title: "VII. Thông tin bổ sung cho các khoản mục trình bày trong Báo cáo kết quả hoạt động kinh doanh",
      table: {
        columns: ["Khoản mục theo B09-DN", "Năm nay", "Năm trước", "Nguồn và mức hoàn thiện"],
        rows: [
          disclosureRow(1, "Tổng doanh thu bán hàng và cung cấp dịch vụ", B02, ["01"]),
          disclosureRow(2, "Các khoản giảm trừ doanh thu", B02, ["02"]),
          disclosureRow(3, "Giá vốn hàng bán", B02, ["11"]),
          disclosureRow(4, "Lãi/lỗ hoạt động bán, thanh lý bất động sản đầu tư", B02, ["21"]),
          disclosureRow(5, "Doanh thu hoạt động tài chính", B02, ["22"]),
          disclosureRow(6, "Chi phí tài chính", B02, ["23"]),
          disclosureRow(7, "Thu nhập khác", B02, ["31"]),
          disclosureRow(8, "Chi phí khác", B02, ["32"]),
          disclosureRow(9, "Chi phí bán hàng và chi phí quản lý doanh nghiệp", B02, ["25", "26"]),
          disclosureRow(10, "Chi phí sản xuất, kinh doanh theo yếu tố", null, []),
          disclosureRow(11, "Chi phí thuế thu nhập doanh nghiệp", B02, ["51", "52"]),
        ],
      },
      paragraphs: ["Phải bổ sung chi tiết theo tính chất giao dịch, bên liên quan và các khoản chiếm tỷ trọng trọng yếu. Chi phí theo yếu tố phải được lập riêng và đối chiếu tổng chi phí trên B02."],
    },
    {
      title: "VIII. Thông tin bổ sung cho các khoản mục trình bày trong Báo cáo lưu chuyển tiền tệ",
      table: {
        columns: ["Khoản mục theo B09-DN", "Năm nay", "Năm trước", "Nguồn và mức hoàn thiện"],
        rows: [
          disclosureRow(1, "Tiền doanh nghiệp nắm giữ nhưng không được sử dụng", null, []),
          disclosureRow(2, "Giao dịch không bằng tiền ảnh hưởng đến Báo cáo lưu chuyển tiền tệ trong tương lai", null, []),
          disclosureRow(3, "Số tiền đi vay thực thu trong kỳ", B03, ["33"]),
          disclosureRow(4, "Số tiền đã thực trả gốc vay trong kỳ", B03, ["34", "35"]),
          disclosureRow(5, "Mua và thanh lý công ty con trong kỳ báo cáo", null, []),
        ],
      },
      paragraphs: ["Số từ B03 là tổng tiền; B09-DN yêu cầu tách theo hình thức vay, trái phiếu, cổ phiếu ưu đãi, REPO và chi tiết giao dịch mua/thanh lý công ty con."],
    },
    {
      title: "IX. Những thông tin khác",
      paragraphs: [
        "1. Nợ tiềm tàng, các khoản cam kết và thông tin tài chính khác - Cần bổ sung.",
        "2. Sự kiện phát sinh sau ngày kết thúc kỳ kế toán năm - Cần bổ sung.",
        "3. Thông tin về các bên liên quan ngoài các phần đã thuyết minh - Cần bổ sung.",
        "4. Tài sản, doanh thu và kết quả kinh doanh theo bộ phận/lĩnh vực/khu vực địa lý - Cần bổ sung.",
        "5. Thông tin so sánh và các thay đổi đối với số liệu niên độ trước - Cần bổ sung.",
        "6. Đánh giá giả định hoạt động liên tục, sự kiện hoặc điều kiện gây nghi ngờ đáng kể và kế hoạch của Ban Giám đốc - Cần bổ sung.",
        "7. Các giả định và ước tính quan trọng: bản chất, số tiền bị ảnh hưởng, khả năng xảy ra và biện pháp hạn chế - Cần bổ sung.",
        "8. Các biện pháp/giải pháp khác - Cần bổ sung.",
      ],
    },
    {
      title: "X. Nội dung sửa đổi, bổ sung biểu mẫu, tên và nội dung các chỉ tiêu so với mẫu Bộ Tài chính",
      paragraphs: [
        "Tên các chỉ tiêu có sửa đổi, bổ sung hoặc thay đổi - Cần bổ sung nếu có.",
        "Nội dung các chỉ tiêu có sửa đổi, bổ sung hoặc thay đổi - Cần bổ sung nếu có.",
        "Lý do thay đổi - Cần bổ sung nếu có.",
      ],
    },
  ];

  const detailedRows = {
    V: [
      ["Tiền mặt", "Tiền gửi không kỳ hạn", "Tiền đang chuyển", "Các khoản tương đương tiền", "Cộng"],
      ["Chứng khoán kinh doanh - cổ phiếu", "Chứng khoán kinh doanh - trái phiếu", "Đầu tư nắm giữ đến ngày đáo hạn ngắn hạn", "Đầu tư nắm giữ đến ngày đáo hạn dài hạn", "Đầu tư vào công ty con", "Đầu tư vào công ty liên doanh, liên kết", "Đầu tư vào đơn vị khác", "Dự phòng tổn thất đầu tư", "Cộng"],
      ["Phải thu khách hàng ngắn hạn", "Phải thu khách hàng dài hạn", "Phải thu khách hàng là bên liên quan", "Dự phòng phải thu khó đòi", "Cộng"],
      ["Phải thu về cổ tức, lợi nhuận", "Phải thu người lao động", "Ký cược, ký quỹ", "Cho mượn tài sản phi tiền tệ", "Các khoản chi hộ", "Phải thu từ hợp đồng BCC đồng kiểm soát", "Phải thu khác", "Cộng"],
      ["Tiền thiếu chờ xử lý", "Hàng tồn kho thiếu chờ xử lý", "TSCĐ thiếu chờ xử lý", "Tài sản khác thiếu chờ xử lý", "Cộng"],
      ["Nợ phải thu/cho vay quá hạn hoặc khó thu hồi", "Giá trị có thể thu hồi", "Dự phòng đã trích lập", "Cộng"],
      ["Hàng mua đang đi đường", "Nguyên liệu, vật liệu", "Công cụ, dụng cụ", "Chi phí sản xuất kinh doanh dở dang", "Sản phẩm", "Hàng hóa", "Hàng gửi đi bán", "Nguyên liệu, vật tư tại kho bảo thuế", "Dự phòng giảm giá hàng tồn kho", "Cộng"],
      ["Chi phí sản xuất, kinh doanh dở dang dài hạn", "Mua sắm XDCB dở dang", "Xây dựng cơ bản dở dang", "Sửa chữa, bảo dưỡng định kỳ", "Nâng cấp, cải tạo TSCĐ", "Cộng"],
      ["Nguyên giá - số dư đầu năm", "Mua trong năm", "Đầu tư XDCB hoàn thành", "Tăng khác", "Chuyển sang BĐSĐT", "Thanh lý, nhượng bán", "Giảm khác", "Nguyên giá - số dư cuối năm", "Hao mòn lũy kế - số dư đầu năm", "Khấu hao trong năm", "Hao mòn tăng/giảm khác", "Hao mòn lũy kế - số dư cuối năm", "Giá trị còn lại đầu năm", "Giá trị còn lại cuối năm"],
      ["Nguyên giá - số dư đầu năm", "Mua trong năm", "Tạo ra từ nội bộ doanh nghiệp", "Tăng do hợp nhất kinh doanh", "Tăng khác", "Thanh lý, nhượng bán", "Giảm khác", "Nguyên giá - số dư cuối năm", "Hao mòn lũy kế - số dư đầu năm", "Khấu hao trong năm", "Hao mòn tăng/giảm khác", "Hao mòn lũy kế - số dư cuối năm", "Giá trị còn lại đầu năm", "Giá trị còn lại cuối năm"],
      ["Nguyên giá - số dư đầu năm", "Thuê tài chính trong năm", "Mua lại TSCĐ thuê tài chính", "Tăng khác", "Trả lại TSCĐ thuê tài chính", "Giảm khác", "Nguyên giá - số dư cuối năm", "Hao mòn lũy kế - số dư đầu năm", "Khấu hao trong năm", "Hao mòn tăng/giảm khác", "Hao mòn lũy kế - số dư cuối năm", "Giá trị còn lại đầu năm", "Giá trị còn lại cuối năm"],
      ["Súc vật nuôi lấy sản phẩm một lần ngắn hạn", "Súc vật nuôi lấy sản phẩm một lần dài hạn", "Cây trồng theo mùa vụ/lấy sản phẩm một lần ngắn hạn", "Cây trồng theo mùa vụ/lấy sản phẩm một lần dài hạn", "Súc vật cho sản phẩm định kỳ chưa trưởng thành", "Súc vật cho sản phẩm định kỳ đã trưởng thành", "Dự phòng tổn thất", "Cộng"],
      ["BĐSĐT cho thuê - nguyên giá", "BĐSĐT cho thuê - hao mòn lũy kế", "BĐSĐT cho thuê - giá trị còn lại", "BĐSĐT nắm giữ chờ tăng giá - nguyên giá", "BĐSĐT nắm giữ chờ tăng giá - giá trị còn lại", "Cộng"],
      ["Chi phí chờ phân bổ ngắn hạn", "Chi phí chờ phân bổ dài hạn", "Cộng"],
      ["Tài sản khác ngắn hạn", "Tài sản khác dài hạn", "Cộng"],
      ["Vay ngắn hạn", "Vay dài hạn", "Vay từ bên liên quan", "Nợ thuê tài chính đến 1 năm", "Nợ thuê tài chính trên 1 đến 5 năm", "Nợ thuê tài chính trên 5 năm", "Vay và nợ thuê tài chính quá hạn", "Cộng"],
      ["Phải trả người bán ngắn hạn", "Phải trả người bán dài hạn", "Nợ quá hạn chưa thanh toán", "Phải trả người bán là bên liên quan", "Cộng"],
      ["Cổ tức, lợi nhuận phải trả đầu năm", "Phát sinh phải trả trong năm", "Đã thanh toán trong năm", "Cổ tức, lợi nhuận phải trả cuối năm"],
      ["Thuế GTGT", "Thuế tiêu thụ đặc biệt", "Thuế xuất nhập khẩu", "Thuế TNDN", "Thuế TNCN", "Thuế tài nguyên", "Thuế nhà đất, tiền thuê đất", "Thuế bảo vệ môi trường và các loại thuế khác", "Phí, lệ phí và các khoản phải nộp khác", "Cộng"],
      ["Trích trước chi phí phải trả ngắn hạn", "Trích trước chi phí phải trả dài hạn", "Chi phí lãi vay phải trả", "Chi phí sửa chữa/bảo hành phải trả", "Chi phí phải trả khác", "Cộng"],
      ["Kinh phí công đoàn", "Bảo hiểm xã hội, y tế, thất nghiệp", "Nhận ký quỹ, ký cược", "Phải trả nội bộ", "Phải trả theo hợp đồng BCC", "Phải trả khác", "Cộng"],
      ["Doanh thu chờ phân bổ ngắn hạn", "Doanh thu chờ phân bổ dài hạn", "Cộng"],
      ["Trái phiếu thường - mệnh giá", "Chiết khấu/phụ trội trái phiếu", "Chi phí phát hành", "Trái phiếu chuyển đổi - phần nợ", "Trái phiếu chuyển đổi - quyền chọn", "Trái phiếu đáo hạn/chuyển đổi trong kỳ", "Cộng"],
      ["Mệnh giá cổ phiếu ưu đãi", "Đối tượng được phát hành", "Điều khoản bắt buộc mua lại/trả cổ tức cố định", "Giá trị đã mua lại trong kỳ", "Thông tin khác"],
      ["Dự phòng phải trả ngắn hạn đầu năm", "Dự phòng tăng trong năm", "Dự phòng giảm trong năm", "Dự phòng phải trả ngắn hạn cuối năm", "Dự phòng phải trả dài hạn đầu năm", "Dự phòng tăng trong năm", "Dự phòng giảm trong năm", "Dự phòng phải trả dài hạn cuối năm"],
      ["Tài sản thuế TNDN hoãn lại do chênh lệch tạm thời", "Tài sản thuế TNDN hoãn lại do lỗ/ưu đãi chưa sử dụng", "Số bù trừ", "Thuế TNDN hoãn lại phải trả", "Cộng"],
      ["Vốn góp của chủ sở hữu", "Thặng dư vốn", "Quyền chọn chuyển đổi trái phiếu", "Vốn khác", "Cổ phiếu mua lại", "Chênh lệch đánh giá lại tài sản", "Chênh lệch tỷ giá", "Các quỹ", "Lợi nhuận sau thuế chưa phân phối", "Cộng"],
      ["Lý do và tài sản được đánh giá lại", "Chênh lệch tăng", "Chênh lệch giảm", "Số dư cuối năm"],
      ["Chênh lệch tỷ giá do chuyển đổi BCTC ngoại tệ sang VND", "Chênh lệch tỷ giá do nguyên nhân khác", "Cộng"],
      ["Tài sản thuê ngoài đến 1 năm", "Tài sản thuê ngoài trên 1 đến 5 năm", "Tài sản thuê ngoài trên 5 năm", "Tài sản nhận giữ hộ/ký gửi/gia công/ủy thác", "Ngoại tệ các loại", "Vàng tiền tệ", "Nợ khó đòi đã xử lý", "Thông tin ngoài BCTHTC khác"],
      ["Tài sản của bên khác doanh nghiệp đang nắm giữ bị hạn chế sử dụng", "Nghĩa vụ phải thanh toán theo hợp đồng/pháp luật", "Thời hạn và điều kiện hạn chế", "Giá trị liên quan"],
      ["Khoản mục cần giải trình thêm", "Bản chất", "Giá trị", "Ảnh hưởng đến Báo cáo tài chính"],
    ],
    VII: [
      ["Doanh thu bán hàng", "Doanh thu cung cấp dịch vụ", "Doanh thu hợp đồng xây dựng", "Doanh thu bán căn hộ du lịch/văn phòng lưu trú", "Doanh thu khác", "Cộng"],
      ["Chiết khấu thương mại", "Giảm giá hàng bán", "Hàng bán bị trả lại", "Cộng"],
      ["Giá vốn sản phẩm, hàng hóa", "Giá vốn dịch vụ", "Hàng tồn kho mất mát/hao hụt", "Chi phí sản xuất vượt mức bình thường", "Dự phòng giảm giá hàng tồn kho/tài sản sinh học", "Khoản ghi giảm giá vốn", "Cộng"],
      ["Doanh thu bán, thanh lý BĐSĐT", "Giá trị còn lại của BĐSĐT", "Chi phí nhượng bán, thanh lý", "Lãi/lỗ"],
      ["Lãi tiền gửi, tiền cho vay", "Lãi bán, thanh lý đầu tư tài chính", "Cổ tức, lợi nhuận được chia", "Lãi chênh lệch tỷ giá", "Lãi bán hàng trả chậm, trả góp", "Chiết khấu thanh toán được hưởng", "Doanh thu tài chính khác", "Cộng"],
      ["Chi phí đi vay", "Lỗ bán, thanh lý đầu tư tài chính", "Lỗ chênh lệch tỷ giá", "Lãi mua hàng trả chậm, trả góp", "Chiết khấu thanh toán phải trả", "Dự phòng tổn thất đầu tư", "Chi phí phát hành không thành công", "Chi phí tài chính khác", "Khoản ghi giảm chi phí tài chính", "Cộng"],
      ["Thanh lý, nhượng bán TSCĐ", "Lãi đánh giá lại tài sản góp vốn", "Tiền phạt thu được", "Thuế được giảm", "Hỗ trợ/tài trợ/biếu tặng", "Thu nhập khác", "Cộng"],
      ["Giá trị còn lại và chi phí thanh lý TSCĐ", "Lỗ đánh giá lại tài sản góp vốn", "Các khoản bị phạt", "Chi phí khác", "Cộng"],
      ["Chi phí quản lý doanh nghiệp", "Chi phí QLDN trọng yếu từ 10%", "Chi phí QLDN khác", "Chi phí bán hàng", "Chi phí bán hàng trọng yếu từ 10%", "Chi phí bán hàng khác", "Khoản ghi giảm chi phí", "Cộng"],
      ["Chi phí nguyên liệu, vật liệu", "Chi phí nhân công", "Chi phí khấu hao TSCĐ", "Chi phí dịch vụ mua ngoài", "Chi phí khác bằng tiền", "Cộng"],
      ["Chi phí thuế TNDN hiện hành", "Chi phí/thu nhập thuế TNDN hoãn lại", "Thuế TNDN bổ sung theo thuế tối thiểu toàn cầu", "Điều chỉnh chi phí thuế năm trước", "Cộng"],
    ],
    VIII: [
      ["Tiền bị hạn chế sử dụng do pháp luật/ràng buộc", "Lý do hạn chế", "Thời hạn hạn chế"],
      ["Mua tài sản bằng nhận nợ/thuê tài chính", "Chuyển nợ thành vốn chủ sở hữu", "Giao dịch đầu tư/tài chính không dùng tiền khác", "Ảnh hưởng luồng tiền tương lai"],
      ["Vay theo khế ước thông thường", "Vay dưới hình thức phát hành trái phiếu", "Vay dưới hình thức cổ phiếu ưu đãi phân loại là nợ", "Vay theo giao dịch mua bán lại trái phiếu Chính phủ", "Cộng"],
      ["Trả nợ gốc vay theo khế ước", "Trả gốc trái phiếu", "Mua lại cổ phiếu ưu đãi phân loại là nợ", "Trả nợ gốc thuê tài chính", "Cộng"],
      ["Tiền và tương đương tiền trong công ty con mua/thanh lý", "Tài sản và nợ phải trả khác", "Giá phí mua/giá trị thanh lý", "Phần thanh toán bằng tiền", "Luồng tiền thuần"],
    ],
  };

  const enrichSection = (prefix, rows) => {
    const section = sections.find((item) => item.title.startsWith(`${prefix}.`));
    if (!section || !section.table) return;
    const periodColumns = prefix === "V" ? ["Cuối năm", "Đầu năm"] : ["Năm nay", "Năm trước"];
    section.tables = section.table.rows.map((summaryRow, index) => ({
      title: String(summaryRow[0]),
      columns: ["Chi tiết bắt buộc theo B09-DN", ...periodColumns, "Nguồn/Trạng thái"],
      rows: [
        ...rows[index].map((label) => [label, null, null, "Chưa nhập"]),
        ["Tổng đối chiếu với báo cáo chính", summaryRow[1], summaryRow[2], summaryRow[3]],
      ],
    }));
    delete section.table;
  };
  enrichSection("V", detailedRows.V);
  enrichSection("VII", detailedRows.VII);
  enrichSection("VIII", detailedRows.VIII);
  return sections;
}

function buildB09(B01, B02, B03) {
  return buildB09FromTemplate({ B01, B02, B03 });
}

function expressionTerms(expression) {
  return String(expression || "")
    .replace(/\s/g, "")
    .split(/(?=[+-])/)
    .filter(Boolean)
    .map((token) => ({ code: token.replace(/^[+-]/, ""), coefficient: token.startsWith("-") ? -1 : 1 }));
}

function collectLineLeaves(lines, code, coefficient = 1, path = new Set()) {
  if (!code || path.has(code)) return [];
  const line = lines.find((item) => item[0] === code);
  if (!line) return [];
  if (!line[3]) return [{ line, coefficient }];
  const nextPath = new Set(path).add(code);
  return expressionTerms(line[3]).flatMap((term) => collectLineLeaves(lines, term.code, coefficient * term.coefficient, nextPath));
}

function buildAggregateDrilldown(lines, aggregateRows, code, mode, report, postingDate) {
  const rows = [];
  for (const { line, coefficient } of collectLineLeaves(lines, code)) {
    const [leafCode, label, _level, _expression, prefixes = [], side, _bold, sign = 1, _manual, excludedPrefixes = [], manualOnly = false] = line;
    if (manualOnly || !prefixes.length) continue;
    for (const source of aggregateRows) {
      const accountCode = source.account_code || source.root_account_code;
      if (!codeMatches(accountCode, prefixes) || codeMatches(accountCode, excludedPrefixes)) continue;
      let baseAmount;
      if (mode === "balance") {
        baseAmount = side === "credit"
          ? Number(source.credit || 0) - Number(source.debit || 0)
          : Number(source.debit || 0) - Number(source.credit || 0);
        if (grossBalanceCodes.has(leafCode)) baseAmount = Math.max(0, baseAmount);
      } else {
        baseAmount = side === "credit"
          ? Number(source.credit || 0) - Number(source.debit || 0)
          : Number(source.debit || 0) - Number(source.credit || 0);
      }
      const amount = baseAmount * sign * coefficient;
      if (Math.abs(amount) <= 0.000001) continue;
      rows.push({
        journalId: `${report}.${leafCode}`,
        journalNum: `${report}.${leafCode}`,
        postingDate,
        accountCode: accountCode || "",
        accountName: source.account_name || source.root_account_name || "",
        amount,
        oppositeAccounts: source.account_analytic ? [String(source.account_analytic)] : [],
        sourceNum: `Aggregate ${mode}`,
        matchedCode: leafCode,
        reason: `${coefficient < 0 ? "Trừ" : "Cộng"} theo đúng predicate ${report}.${leafCode}: ${label}`,
      });
    }
  }
  return rows;
}

function summarizeDrilldown(rows, reportedAmount) {
  const drilldownAmount = rows.reduce((total, row) => total + Number(row.amount || 0), 0);
  const difference = reportedAmount == null ? null : drilldownAmount - Number(reportedAmount);
  return {
    drilldownAmount,
    reportedAmount,
    difference,
    reconciled: difference == null ? rows.length === 0 : Math.abs(difference) <= 1,
  };
}

async function assertJournalSchema(client) {
  const result = await client.query(
    `select column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name = 'journal'`,
  );
  const existing = new Set(result.rows.map((row) => row.column_name));
  const missing = requiredColumns.filter((column) => !existing.has(column));
  if (missing.length) {
    const error = new Error(`journal table is missing required columns: ${missing.join(", ")}`);
    error.status = 500;
    throw error;
  }
}

function mapRow(row, periodRole) {
  return {
    id: `${periodRole}-${row.id}`,
    bucket: periodRole === "prior" || periodRole === "priorBalance" ? "prior" : "current",
    periodRole,
    fileName: "postgres:journal",
    rowNumber: Number(row.id),
    dbId: Number(row.id),
    journalId: row.journal_id == null ? "" : String(row.journal_id),
    entryGroupKey: row.journal_id == null
      ? `${row.journal_num || ""}|${dateOnly(row.posting_date)}|${row.source_num || ""}`
      : `journal:${row.journal_id}`,
    postingDate: dateOnly(row.posting_date),
    status: row.status || "",
    accountCode: row.account_code || "",
    accountName: row.account_name || "",
    accountType: row.account_type || "",
    rootAccountCode: row.root_account_code || "",
    rootAccountName: row.root_account_name || "",
    journalName: row.journal_name || "",
    journalNum: row.journal_num || "",
    sourceNum: row.source_num || "",
    department: row.department || "",
    accountAnalytic: row.account_analytic || "",
    debit: Number(row.debit || 0),
    credit: Number(row.credit || 0),
    balance: Number(row.balance || 0),
    oppositeAccounts: [],
    raw: {},
  };
}

async function queryRows(client, startDate, endDate, periodRole) {
  const result = await client.query(
    `with cash_journals as (
       select distinct journal_id
      from journal
      where status = 'Posted'
        and ${notVirtualAccountSql()}
          and posting_date >= $1::date
          and posting_date <= $2::date
          and regexp_replace(coalesce(account_code, root_account_code, ''), '^0+', '') ~ '^(111|112|113)'
      )
      select id, journal_id, journal_num, source_num, journal_name, posting_date, status,
            account_code, account_name, account_type, root_account_code, root_account_name,
            debit, credit, balance, account_analytic, department
       from journal j
      where j.status = 'Posted'
        and ${notVirtualAccountSql("j")}
        and posting_date >= $1::date
        and posting_date <= $2::date
        and (
          regexp_replace(coalesce(j.account_code, j.root_account_code, ''), '^0+', '') ~ '^[5-9]'
          or j.journal_id in (select journal_id from cash_journals)
        )
      order by posting_date, journal_id, id`,
    [startDate, endDate],
  );
  return result.rows.map((row) => mapRow(row, periodRole));
}

async function queryAsOfRows(client, endDate, periodRole) {
  const result = await client.query(
    `select min(id) as id,
            null::integer as journal_id,
            'BALANCE-' || coalesce(account_code, root_account_code, 'NO_ACCOUNT') as journal_num,
            'Aggregated balance as of ' || $1::text as source_num,
            'Balance' as journal_name,
            $1::date as posting_date,
            'Posted' as status,
            account_code,
            max(account_name) as account_name,
            max(account_type) as account_type,
            root_account_code,
            max(root_account_name) as root_account_name,
            sum(coalesce(debit, 0)) as debit,
            sum(coalesce(credit, 0)) as credit,
            sum(coalesce(balance, 0)) as balance,
            account_analytic,
            null::varchar as department
       from journal
      where status = 'Posted'
        and ${notVirtualAccountSql()}
        and posting_date <= $1::date
      group by account_code, root_account_code, account_analytic
      order by account_code, root_account_code, account_analytic`,
    [endDate],
  );
  return result.rows.map((row) => mapRow(row, periodRole));
}

async function queryBalanceAggregatesRaw(client, endDate) {
  const result = await client.query(
    `select coalesce(account_code, root_account_code, 'NO_ACCOUNT') as account_code,
            max(account_name) as account_name,
            root_account_code,
            max(root_account_name) as root_account_name,
            sum(coalesce(debit, 0)) as debit,
            sum(coalesce(credit, 0)) as credit,
            account_analytic,
            count(*)::int as row_count
       from journal
      where status = 'Posted'
        and ${notVirtualAccountSql()}
        and posting_date <= $1::date
      group by account_code, root_account_code, account_analytic`,
    [endDate],
  );
  return result.rows;
}

async function queryBalanceAggregates(client, endDate) {
  let snapshotDate;
  try {
    snapshotDate = await latestSnapshotDate(client, endDate);
  } catch (error) {
    if (error.code === "42P01") return queryBalanceAggregatesRaw(client, endDate);
    throw error;
  }
  if (!snapshotDate) return queryBalanceAggregatesRaw(client, endDate);
  const result = await client.query(
    `with snapshot as (
       select account_code, max(account_name) as account_name, root_account_code,
              max(root_account_name) as root_account_name, account_analytic,
              sum(cumulative_debit) as debit, sum(cumulative_credit) as credit,
              sum(source_row_count)::bigint as row_count
         from ${BALANCE_TABLE} balance_snapshot
         join ${aggregateControlTable} control
           on control.snapshot_date = balance_snapshot.snapshot_date
          and control.batch_id = balance_snapshot.batch_id
        where balance_snapshot.snapshot_date = $1::date
        group by account_code, root_account_code, account_analytic
     ), tail as (
       select coalesce(account_code, root_account_code, 'NO_ACCOUNT') as account_code,
              max(account_name) as account_name, coalesce(root_account_code, '') as root_account_code,
              max(root_account_name) as root_account_name, coalesce(account_analytic, '') as account_analytic,
              sum(coalesce(debit, 0)) as debit, sum(coalesce(credit, 0)) as credit,
              count(*)::bigint as row_count
         from journal
        where status = 'Posted' and ${notVirtualAccountSql()}
          and posting_date > $1::date and posting_date <= $2::date
        group by coalesce(account_code, root_account_code, 'NO_ACCOUNT'),
                 coalesce(root_account_code, ''), coalesce(account_analytic, '')
     ), keys as (
       select account_code, root_account_code, account_analytic from snapshot
       union
       select account_code, root_account_code, account_analytic from tail
     )
     select keys.account_code,
            coalesce(tail.account_name, snapshot.account_name, '') as account_name,
            keys.root_account_code,
            coalesce(tail.root_account_name, snapshot.root_account_name, '') as root_account_name,
            coalesce(snapshot.debit, 0) + coalesce(tail.debit, 0) as debit,
            coalesce(snapshot.credit, 0) + coalesce(tail.credit, 0) as credit,
            keys.account_analytic,
            coalesce(snapshot.row_count, 0) + coalesce(tail.row_count, 0) as row_count
       from keys
       left join snapshot using (account_code, root_account_code, account_analytic)
       left join tail using (account_code, root_account_code, account_analytic)`,
    [snapshotDate, endDate],
  );
  return result.rows;
}

async function hasCompleteMonthlyCoverage(client, startDate, endDate) {
  const range = fullMonthRange(startDate, endDate);
  if (!range || range.first !== startDate || range.last !== endDate) return false;
  const result = await client.query(
    `select count(control.snapshot_date)::int as found
       from generate_series($1::date, $2::date, interval '1 month') month
       left join ${aggregateControlTable} control
         on control.snapshot_date = (month + interval '1 month - 1 day')::date`,
    [startDate, endDate],
  );
  const expected = (() => {
    let count = 0;
    const cursor = new Date(`${startDate}T00:00:00Z`);
    const limit = new Date(`${endDate}T00:00:00Z`);
    while (cursor <= limit) { count += 1; cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
    return count;
  })();
  return Number(result.rows[0]?.found || 0) === expected;
}

async function queryPeriodAggregates(client, startDate, endDate) {
  try {
    if (await hasCompleteMonthlyCoverage(client, startDate, endDate)) {
      const aggregate = await client.query(
        `select account_code, max(account_name) as account_name,
                root_account_code, max(root_account_name) as root_account_name,
                sum(debit) as debit, sum(credit) as credit, sum(source_row_count)::bigint as row_count
           from ${PROFIT_VIEW}
          where month_end between $1::date and $2::date
          group by account_code, root_account_code`,
        [startDate, endDate],
      );
      return aggregate.rows;
    }
  } catch (error) {
    if (error.code !== "42P01") throw error;
  }
  const result = await client.query(
    `select coalesce(account_code, root_account_code, 'NO_ACCOUNT') as account_code,
            max(account_name) as account_name,
            root_account_code,
            max(root_account_name) as root_account_name,
            sum(coalesce(debit, 0)) as debit,
            sum(coalesce(credit, 0)) as credit,
            count(*)::int as row_count
       from journal
      where status = 'Posted'
        and ${notVirtualAccountSql()}
        and posting_date >= $1::date
        and posting_date <= $2::date
        and regexp_replace(coalesce(account_code, root_account_code, ''), '^0+', '') ~ '^[5-9]'
        and not exists (
          select 1
            from journal closing_line
           where closing_line.journal_id = journal.journal_id
             and closing_line.status = 'Posted'
             and regexp_replace(coalesce(closing_line.account_code, closing_line.root_account_code, ''), '^0+', '') ~ '^911'
        )
      group by account_code, root_account_code`,
    [startDate, endDate],
  );
  return result.rows;
}

async function queryProfitTransferredTo421(client, startDate, endDate) {
  const result = await client.query(
    `select coalesce(sum(coalesce(j.credit, 0) - coalesce(j.debit, 0)), 0) as amount
       from journal j
      where j.status = 'Posted'
        and ${notVirtualAccountSql("j")}
        and j.posting_date >= $1::date
        and j.posting_date <= $2::date
        and regexp_replace(coalesce(j.account_code, j.root_account_code, ''), '^0+', '') ~ '^4212'
        and exists (
          select 1
            from journal closing_line
           where closing_line.journal_id = j.journal_id
             and closing_line.status = 'Posted'
             and regexp_replace(coalesce(closing_line.account_code, closing_line.root_account_code, ''), '^0+', '') ~ '^911'
        )`,
    [startDate, endDate],
  );
  return Number(result.rows[0]?.amount || 0);
}

async function queryCashMovements(client, startDate, endDate) {
  let result = null;
  try {
    if (await hasCompleteMonthlyCoverage(client, startDate, endDate)) {
      result = await client.query(
        `select source_id as id, journal_id, journal_num, source_num, journal_name,
                posting_date, account_code, account_name, root_account_code, amount,
                opposite_accounts, opposite_rows, 0::bigint as cash_peer_count,
                source_num as opposite_source, cash_line_count
           from ${CASH_VIEW}
          where month_end between $1::date and $2::date
          order by posting_date, journal_id, source_id`,
        [startDate, endDate],
      );
    }
  } catch (error) {
    if (error.code !== "42P01") throw error;
  }
  if (!result) result = await client.query(
    `with cash as (
       select j.id, j.journal_id, j.journal_num, j.source_num, j.journal_name, j.posting_date,
              j.account_code, j.account_name, j.root_account_code,
              coalesce(j.debit, 0) - coalesce(j.credit, 0) as amount
         from journal j
        where j.status = 'Posted'
          and ${notVirtualAccountSql("j")}
          and j.posting_date >= $1::date
          and j.posting_date <= $2::date
          and regexp_replace(coalesce(j.account_code, j.root_account_code, ''), '^0+', '') ~ '^(111|112|113)'
      )
      select c.*,
             coalesce(array_remove(array_agg(distinct regexp_replace(coalesce(o.account_code, o.root_account_code, ''), '^0+', '')), ''), '{}') as opposite_accounts,
             coalesce(
               jsonb_agg(distinct jsonb_build_object(
                 'account', regexp_replace(coalesce(o.account_code, o.root_account_code, ''), '^0+', ''),
                 'account_name', coalesce(o.account_name, ''),
                 'account_analytic', coalesce(o.account_analytic, ''),
                 'debit', coalesce(o.debit, 0),
                 'credit', coalesce(o.credit, 0)
               )) filter (where o.id is not null),
               '[]'::jsonb
             ) as opposite_rows,
             count(distinct cp.id) as cash_peer_count,
             coalesce(max(o.source_num), c.source_num) as opposite_source
        from cash c
        left join cash cp
          on cp.journal_id = c.journal_id
         and cp.id <> c.id
        left join journal o
          on o.journal_id = c.journal_id
         and o.id <> c.id
         and o.status = 'Posted'
         and ${notVirtualAccountSql("o")}
         and not (regexp_replace(coalesce(o.account_code, o.root_account_code, ''), '^0+', '') ~ '^(111|112|113)')
       group by c.id, c.journal_id, c.journal_num, c.source_num, c.journal_name, c.posting_date, c.account_code, c.account_name, c.root_account_code, c.amount`,
    [startDate, endDate],
  );
  const accruedNatureResult = await client.query(
    `select coalesce(accrual.account_analytic, '') as account_analytic,
            array_agg(distinct regexp_replace(coalesce(counterpart.account_code, counterpart.root_account_code, ''), '^0+', ''))
              filter (where counterpart.id is not null) as counterpart_accounts
       from journal accrual
       join journal counterpart
         on counterpart.journal_id = accrual.journal_id
        and counterpart.id <> accrual.id
      where accrual.status = 'Posted'
        and accrual.posting_date <= $1::date
        and regexp_replace(coalesce(accrual.account_code, accrual.root_account_code, ''), '^0+', '') ~ '^335'
        and coalesce(accrual.credit, 0) > 0
        and regexp_replace(coalesce(counterpart.account_code, counterpart.root_account_code, ''), '^0+', '') ~ '^(6|8)'
      group by coalesce(accrual.account_analytic, '')`,
    [endDate],
  );
  const accruedNatureByAnalytic = new Map(accruedNatureResult.rows.map((row) => {
    const accounts = (row.counterpart_accounts || []).map(normalizeCode).filter(Boolean);
    const allInterest = accounts.length > 0 && accounts.every((account) => account.startsWith("635"));
    const noInterest = accounts.length > 0 && accounts.every((account) => !account.startsWith("635"));
    return [String(row.account_analytic || "").trim(), allInterest ? "04" : (noInterest ? "02" : "")];
  }));
  const groupedCashRows = new Map();
  for (const sourceRow of result.rows) {
    const row = { ...sourceRow, posting_date: dateOnly(sourceRow.posting_date) };
    const key = row.journal_id == null ? `${row.journal_num || ""}|${row.posting_date}|${row.source_num || ""}` : `journal:${row.journal_id}`;
    const existing = groupedCashRows.get(key);
    if (existing) {
      existing.amount = Number(existing.amount || 0) + Number(row.amount || 0);
      existing.cash_line_count += 1;
      existing.cash_accounts = Array.from(new Set([...(existing.cash_accounts || []), normalizeCode(row.account_code || row.root_account_code)]));
    } else {
      groupedCashRows.set(key, {
        ...row,
        amount: Number(row.amount || 0),
        cash_line_count: 1,
        cash_accounts: [normalizeCode(row.account_code || row.root_account_code)],
      });
    }
  }

  return Array.from(groupedCashRows.values()).flatMap((row) => {
    if (Math.abs(Number(row.amount || 0)) <= 1) {
      return [{ ...row, matched_code: "__internal_cash_transfer", reason: "Tổng biến động tiền trong bút toán bằng 0 - chuyển tiền nội bộ" }];
    }
    const oppositeRows = Array.isArray(row.opposite_rows) ? row.opposite_rows : [];
    const direction = Number(row.amount || 0) >= 0 ? "in" : "out";
    const weightedRows = oppositeRows
      .map((opposite) => ({
        ...opposite,
        nature_code: normalizeCode(opposite.account).startsWith("335")
          ? (accruedNatureByAnalytic.get(String(opposite.account_analytic || "").trim()) || "")
          : "",
        weight: direction === "in"
          ? Math.max(0, Number(opposite.credit || 0) - Number(opposite.debit || 0))
          : Math.max(0, Number(opposite.debit || 0) - Number(opposite.credit || 0)),
      }))
      .filter((opposite) => opposite.account && opposite.weight > 0);
    if (weightedRows.length > 1) {
      const parts = weightedRows.map((opposite) => {
        const part = {
          ...row,
          amount: direction === "in" ? opposite.weight : -opposite.weight,
          opposite_accounts: [opposite.account],
          account_name: `${row.account_name || ""} ${opposite.account_name || ""}`,
        };
        const classified = opposite.nature_code
          ? { code: opposite.nature_code, reason: opposite.nature_code === "04" ? "Đối chiếu khoản trích trước với chi phí đi vay 635" : "Đối chiếu khoản trích trước với chi phí hàng hóa, dịch vụ" }
          : classifyCashMovement(part);
        return { ...part, matched_code: classified.code, reason: `${classified.reason}; phân bổ theo dòng đối ứng` };
      });
      const allocated = parts.reduce((total, part) => total + Math.abs(Number(part.amount || 0)), 0);
      if (parts.every((part) => part.matched_code) && Math.abs(allocated - Math.abs(Number(row.amount || 0))) <= 1) return parts;
    }
    if (weightedRows.length === 1 && weightedRows[0].nature_code) {
      const natureCode = weightedRows[0].nature_code;
      return [{
        ...row,
        matched_code: natureCode,
        reason: natureCode === "04" ? "Đối chiếu khoản trích trước với chi phí đi vay 635" : "Đối chiếu khoản trích trước với chi phí hàng hóa, dịch vụ",
      }];
    }
    const classified = classifyCashMovement(row);
    return [{ ...row, matched_code: classified.code, reason: classified.reason }];
  });
}

async function countRows(client, startDate, endDate) {
  const result = await client.query(
    `select count(*)::int as count
       from journal
      where status = 'Posted'
        and ${notVirtualAccountSql()}
        and posting_date >= $1::date
        and posting_date <= $2::date
        `,
    [startDate, endDate],
  );
  return Number(result.rows[0]?.count || 0);
}

function mapRawJournalRow(row, extra = {}) {
  return {
    id: row.id,
    journalId: row.journal_id,
    journalNum: row.journal_num,
    sourceNum: row.source_num,
    journalName: row.journal_name,
    postingDate: dateOnly(row.posting_date),
    status: row.status,
    accountCode: row.account_code,
    accountName: row.account_name,
    accountType: row.account_type,
    rootAccountCode: row.root_account_code,
    rootAccountName: row.root_account_name,
    debit: Number(row.debit || 0),
    credit: Number(row.credit || 0),
    balance: Number(row.balance || 0),
    accountAnalytic: row.account_analytic,
    department: row.department,
    ...extra,
  };
}

async function queryRawJournalByPrefixes(client, params) {
  const { prefixes, excludedPrefixes = [], fromDate, toDate, page, pageSize } = params;
  if (!prefixes.length) return { rows: [], total: 0, page, pageSize };
  const offset = (page - 1) * pageSize;
  const values = [fromDate, toDate, prefixes.map(normalizeCode), pageSize, offset];
  const extraFilters = [];
  if (excludedPrefixes.length) {
    values.push(excludedPrefixes.map(normalizeCode));
    extraFilters.push(`and not exists (
      select 1
        from unnest($${values.length}::text[]) as excluded_prefix
       where regexp_replace(coalesce(account_code, root_account_code, ''), '^0+', '') like excluded_prefix || '%'
    )`);
  }
  const result = await client.query(
    `select id, journal_id, journal_num, source_num, journal_name, posting_date, status,
            account_code, account_name, account_type, root_account_code, root_account_name,
            debit, credit, balance, account_analytic, department,
            count(*) over()::int as total_count
       from journal
      where status = 'Posted'
        and ${notVirtualAccountSql()}
        and posting_date >= $1::date
        and posting_date <= $2::date
        ${extraFilters.join("\n")}
        and exists (
          select 1
            from unnest($3::text[]) as prefix
           where regexp_replace(coalesce(account_code, root_account_code, ''), '^0+', '') like prefix || '%'
        )
      order by posting_date, journal_id, id
      limit $4 offset $5`,
    values,
  );
  return {
    rows: result.rows.map((row) => mapRawJournalRow(row)),
    total: Number(result.rows[0]?.total_count || 0),
    page,
    pageSize,
  };
}

async function queryRawCashMovements(client, params) {
  const { startDate, endDate, codes, page, pageSize } = params;
  const movements = await queryCashMovements(client, startDate, endDate);
  const filtered = movements.filter((movement) => codes.includes(movement.matched_code));
  const start = (page - 1) * pageSize;
  return {
    rows: filtered.slice(start, start + pageSize).map((movement) => ({
      id: movement.id,
      journalId: movement.journal_id,
      journalNum: movement.journal_num,
      sourceNum: movement.source_num,
      journalName: movement.journal_name,
      postingDate: dateOnly(movement.posting_date),
      accountCode: movement.account_code,
      accountName: movement.account_name,
      rootAccountCode: movement.root_account_code,
      amount: Number(movement.amount || 0),
      oppositeAccounts: movement.opposite_accounts || [],
      matchedCode: movement.matched_code,
      reason: movement.reason,
    })),
    total: filtered.length,
    page,
    pageSize,
  };
}

async function queryReportRawSource(client, params) {
  const { report, code, startDate, endDate, side = "current", page, pageSize } = params;
  const isPrior = side === "prior";
  if (report === "B01") {
    const currentYearStartDate = yearStart(endDate);
    const openingBalanceDate = b01OpeningBalanceDate(endDate);
    const toDate = isPrior ? openingBalanceDate : endDate;
    const prefixes = collectLinePrefixes(b01Lines, code);
    return {
      ...(await queryRawJournalByPrefixes(client, { prefixes, fromDate: "1900-01-01", toDate, page, pageSize })),
      meta: { report, code, side, sourceMode: "balance", fromDate: "1900-01-01", toDate, prefixes },
    };
  }
  if (report === "B02") {
    const fromDate = isPrior ? oneYearBack(startDate) : startDate;
    const toDate = isPrior ? oneYearBack(endDate) : endDate;
    const prefixes = collectLinePrefixes(b02Lines, code);
    const excludedPrefixes = collectLineExcludedPrefixes(b02Lines, code);
    return {
      ...(await queryRawJournalByPrefixes(client, { prefixes, excludedPrefixes, fromDate, toDate, page, pageSize })),
      meta: { report, code, side, sourceMode: "period", fromDate, toDate, prefixes, excludedPrefixes },
    };
  }
  if (report === "B03") {
    const fromDate = isPrior ? oneYearBack(startDate) : startDate;
    const toDate = isPrior ? oneYearBack(endDate) : endDate;
    const codes = collectB03Codes(code);
    return {
      ...(await queryRawCashMovements(client, { startDate: fromDate, endDate: toDate, codes, page, pageSize })),
      meta: { report, code, side, sourceMode: "cash-movement", fromDate, toDate, matchedCodes: codes },
    };
  }
  const error = new Error("raw source export is supported for B01, B02 and B03");
  error.status = 400;
  throw error;
}

function summarizeUnclassified(movements) {
  const groups = new Map();
  for (const movement of movements.filter((item) => !item.matched_code)) {
    const key = movement.reason || "Unclassified";
    const entry = groups.get(key) || { reason: key, count: 0, total: 0 };
    entry.count += 1;
    entry.total += Number(movement.amount || 0);
    groups.set(key, entry);
  }
  return Array.from(groups.values());
}

function normalizeAccountPrefix(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.replace(/^0+/, "");
}

function splitDebitCredit(value) {
  const number = Number(value || 0);
  return {
    debit: number > 0 ? number : 0,
    credit: number < 0 ? Math.abs(number) : 0,
  };
}

function dateOnly(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: reportTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(parsed);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] || String(value);
}

function daysBetween(fromDate, toDate) {
  const start = new Date(`${dateOnly(fromDate)}T00:00:00Z`).getTime();
  const end = new Date(`${dateOnly(toDate)}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((end - start) / 86400000));
}

function agingBucket(ageDays) {
  if (ageDays <= 30) return "age0To30";
  if (ageDays <= 60) return "age31To60";
  if (ageDays <= 90) return "age61To90";
  if (ageDays <= 120) return "age91To120";
  return "ageOver120";
}

function emptyAgingTotals() {
  return { age0To30: 0, age31To60: 0, age61To90: 0, age91To120: 0, ageOver120: 0 };
}

function buildPayableAgingFromRows(rows, endDate) {
  const groups = new Map();
  const sorted = [...rows].sort((a, b) => {
    const dateCompare = dateOnly(a.posting_date).localeCompare(dateOnly(b.posting_date));
    if (dateCompare) return dateCompare;
    return Number(a.id || 0) - Number(b.id || 0);
  });

  for (const row of sorted) {
    const analytic = String(row.account_analytic || "").trim() || "(Chưa có đối tượng)";
    const accountAnalyticKey = row.account_analytic_key || "";
    const group = groups.get(analytic) || { accountAnalytic: analytic, accountAnalyticKey, lots: [], rowCount: 0 };
    group.rowCount += 1;

    const credit = Number(row.credit || 0);
    const debit = Number(row.debit || 0);
    if (credit > 0) {
      group.lots.push({
        id: row.id,
        journalId: row.journal_id,
        journalNum: row.journal_num,
        sourceNum: row.source_num,
        journalName: row.journal_name,
        postingDate: dateOnly(row.posting_date),
        status: row.status,
        accountCode: normalizeAccountPrefix(row.account_code || row.root_account_code),
        accountName: row.account_name || "",
        rootAccountCode: normalizeAccountPrefix(row.root_account_code || row.account_code),
        rootAccountName: row.root_account_name || "",
        debit: 0,
        credit,
        balance: Number(row.balance || 0),
        accountAnalytic: analytic,
        department: row.department || "",
        originalAmount: credit,
        remainingAmount: credit,
      });
    }
    if (debit > 0) {
      let remainingPayment = debit;
      for (const lot of group.lots) {
        if (remainingPayment <= 0) break;
        if (lot.remainingAmount <= 0) continue;
        const applied = Math.min(lot.remainingAmount, remainingPayment);
        lot.remainingAmount -= applied;
        remainingPayment -= applied;
      }
    }
    groups.set(analytic, group);
  }

  const outputRows = [];
  let totalDebt = 0;
  const totals = emptyAgingTotals();

  for (const group of groups.values()) {
    const row = {
      accountAnalytic: group.accountAnalytic,
      accountAnalyticKey: group.accountAnalyticKey,
      totalDebt: 0,
      debt: 0,
      ...emptyAgingTotals(),
      rowCount: group.rowCount,
    };
    for (const lot of group.lots) {
      const remaining = Math.round((lot.remainingAmount + Number.EPSILON) * 100) / 100;
      if (remaining <= 0) continue;
      const bucket = agingBucket(daysBetween(lot.postingDate, endDate));
      row[bucket] += remaining;
      row.totalDebt += remaining;
      row.debt += remaining;
    }
    if (row.totalDebt > 0) {
      totalDebt += row.totalDebt;
      for (const key of Object.keys(totals)) totals[key] += row[key];
      outputRows.push(row);
    }
  }

  outputRows.sort((a, b) => b.totalDebt - a.totalDebt || a.accountAnalytic.localeCompare(b.accountAnalytic));
  return { rows: outputRows, totals: { totalDebt, debt: totalDebt, ...totals } };
}

async function queryPayableAging(client, params) {
  const { endDate, analytic = "" } = params;
  const analyticText = String(analytic || "").trim();
  let snapshotDate = null;
  try {
    const control = await client.query(
      `select max(snapshot_date)::text as snapshot_date
         from ${aggregateControlTable}
        where snapshot_date <= $1::date`,
      [endDate],
    );
    snapshotDate = control.rows[0]?.snapshot_date || null;
  } catch (error) {
    if (error.code !== "42P01") throw error;
  }
  const values = snapshotDate ? [snapshotDate, endDate] : [endDate];
  let analyticFilter = "";
  if (analyticText) {
    values.push(`%${analyticText}%`);
    analyticFilter = `and coalesce(account_analytic, '') ilike $${values.length}`;
  }
  const result = snapshotDate ? await client.query(
    `select source_id as id, journal_id, journal_num, source_num, journal_name, posting_date, 'Posted'::text as status,
            account_code, account_name, null::text as account_type, root_account_code, root_account_name,
            0::numeric as debit, remaining_credit as credit, remaining_credit as balance,
            account_analytic, account_analytic_key, department
       from ${PAYABLE_VIEW}
      where snapshot_date = $1::date ${analyticFilter}
     union all
     select id, journal_id, journal_num, source_num, journal_name, posting_date, status,
            account_code, account_name, account_type, root_account_code, root_account_name,
            debit, credit, balance, account_analytic, md5(trim(coalesce(account_analytic, ''))) as account_analytic_key, department
      from journal
     where status = 'Posted'
        and ${notVirtualAccountSql()}
        and posting_date > $1::date and posting_date <= $2::date
        and regexp_replace(coalesce(root_account_code, account_code, ''), '^0+', '') = '331'
        ${analyticFilter}
      order by account_analytic, posting_date, id`,
    values,
  ) : await client.query(
    `select id, journal_id, journal_num, source_num, journal_name, posting_date, status,
            account_code, account_name, account_type, root_account_code, root_account_name,
            debit, credit, balance, account_analytic, md5(trim(coalesce(account_analytic, ''))) as account_analytic_key, department
       from journal
      where status = 'Posted' and ${notVirtualAccountSql()}
        and posting_date <= $1::date
        and regexp_replace(coalesce(root_account_code, account_code, ''), '^0+', '') = '331'
        ${analyticFilter}
      order by coalesce(account_analytic, ''), posting_date, id`,
    values,
  );
  const built = buildPayableAgingFromRows(result.rows, endDate);
  return {
    period: { endDate, basis: "all_time_to_end_date" },
    filters: { accountPrefix: "331", analytic: analyticText },
    rows: built.rows,
    totals: built.totals,
    controls: {
      journalRows: result.rows.length,
      totalCreditBalance331: built.totals.totalDebt,
      snapshotDate,
    },
  };
}

async function queryPayableAgingRawSource(client, params) {
  const { endDate, accountAnalytic = "", accountAnalyticKey = "", bucket = "", page, pageSize } = params;
  const targetAnalytic = String(accountAnalytic || "").trim();
  const values = [endDate];
  let analyticClause = "and trim(coalesce(account_analytic, '')) = ''";
  const keyText = String(accountAnalyticKey || "").trim();
  if (keyText) {
    values.push(keyText);
    analyticClause = "and md5(trim(coalesce(account_analytic, ''))) = $2";
  } else if (targetAnalytic && targetAnalytic !== "(Chưa có đối tượng)") {
    values.push(`%${targetAnalytic}%`);
    analyticClause = "and trim(coalesce(account_analytic, '')) ilike $2";
  }
  const result = await client.query(
    `select id, journal_id, journal_num, source_num, journal_name, posting_date, status,
            account_code, account_name, account_type, root_account_code, root_account_name,
            debit, credit, balance, account_analytic, md5(trim(coalesce(account_analytic, ''))) as account_analytic_key, department
      from journal
     where status = 'Posted'
        and ${notVirtualAccountSql()}
        and posting_date <= $1::date
        and regexp_replace(coalesce(root_account_code, account_code, ''), '^0+', '') = '331'
        ${analyticClause}
      order by posting_date, id`,
    values,
  );
  const sortedLots = [];
  const built = buildPayableAgingFromRows(result.rows, endDate);
  const sourceGroup = result.rows;
  if (built.rows.length) {
    const group = new Map();
    for (const row of sourceGroup) {
      if (Number(row.credit || 0) <= 0) continue;
      group.set(String(row.id), row);
    }
    const internal = [];
    const replay = new Map();
    for (const row of sourceGroup) {
      const credit = Number(row.credit || 0);
      const debit = Number(row.debit || 0);
      if (credit > 0) internal.push({ id: String(row.id), remaining: credit });
      if (debit > 0) {
        let payment = debit;
        for (const lot of internal) {
          if (payment <= 0) break;
          const applied = Math.min(lot.remaining, payment);
          lot.remaining -= applied;
          payment -= applied;
        }
      }
    }
    for (const lot of internal) replay.set(lot.id, lot.remaining);
    for (const [id, remaining] of replay.entries()) {
      if (remaining <= 0) continue;
      const raw = group.get(id);
      if (!raw) continue;
      const ageDays = daysBetween(raw.posting_date, endDate);
      const rawBucket = agingBucket(ageDays);
      if (bucket && rawBucket !== bucket) continue;
      sortedLots.push({
        ...mapRawJournalRow(raw, { amount: remaining, reason: `AP aging ${rawBucket}; age ${ageDays} days; remaining ${remaining}` }),
        amount: remaining,
        reason: `AP aging ${rawBucket}; age ${ageDays} days; original credit ${Number(raw.credit || 0)}; remaining ${remaining}`,
      });
    }
  }
  sortedLots.sort((a, b) => String(a.postingDate || "").localeCompare(String(b.postingDate || "")));
  const offset = (page - 1) * pageSize;
  return {
    rows: sortedLots.slice(offset, offset + pageSize),
    total: sortedLots.length,
    page,
    pageSize,
    meta: {
      report: "AP Aging",
      code: bucket || "all",
      accountAnalytic: targetAnalytic,
      accountAnalyticKey: keyText,
      sourceMode: "ap-aging-fifo",
      fromDate: "all-time",
      toDate: endDate,
      accountPrefix: "331",
    },
  };
}

async function queryTrialBalance(client, params) {
  const { startDate, endDate, accountPrefix = "", analytic = "", groupByAnalytic = false } = params;
  const openingDate = periodOpeningBalanceDate(startDate);
  const normalizedPrefix = normalizeAccountPrefix(accountPrefix);
  const analyticText = String(analytic || "").trim();
  const needsAnalyticDimension = Boolean(groupByAnalytic || analyticText);
  const openingRows = await queryBalanceAggregates(client, openingDate);
  let periodRows;
  if (await hasCompleteMonthlyCoverage(client, startDate, endDate)) {
    const dimensionSelect = needsAnalyticDimension ? "account_analytic" : "''::text as account_analytic";
    const dimensionGroup = needsAnalyticDimension ? ", account_analytic" : "";
    const result = await client.query(
      `with monthly as (
         select balance_snapshot.snapshot_date, balance_snapshot.account_code,
                balance_snapshot.account_name, balance_snapshot.root_account_code,
                balance_snapshot.root_account_name, balance_snapshot.account_analytic,
                balance_snapshot.period_debit, balance_snapshot.period_credit,
                balance_snapshot.source_row_count - coalesce(
                  lag(balance_snapshot.source_row_count) over (
                    partition by balance_snapshot.account_code, balance_snapshot.root_account_code,
                                 balance_snapshot.account_analytic
                    order by balance_snapshot.snapshot_date
                  ), 0
                ) as period_row_count
           from ${BALANCE_TABLE} balance_snapshot
           join ${aggregateControlTable} control
             on control.snapshot_date = balance_snapshot.snapshot_date
            and control.batch_id = balance_snapshot.batch_id
          where balance_snapshot.snapshot_date <= $2::date
       )
       select regexp_replace(account_code, '^0+', '') as account_code,
              max(account_name) as account_name,
              regexp_replace(coalesce(root_account_code, account_code), '^0+', '') as root_account_code,
              max(root_account_name) as root_account_name,
              ${dimensionSelect}, sum(period_debit) as debit, sum(period_credit) as credit,
              sum(period_row_count)::bigint as row_count
         from monthly
        where snapshot_date between $1::date and $2::date
        group by regexp_replace(account_code, '^0+', ''),
                 regexp_replace(coalesce(root_account_code, account_code), '^0+', '')${dimensionGroup}`,
      [startDate, endDate],
    );
    periodRows = result.rows;
  } else {
    const result = await client.query(
      `select regexp_replace(coalesce(account_code, root_account_code, 'NO_ACCOUNT'), '^0+', '') as account_code,
              max(account_name) as account_name,
              regexp_replace(coalesce(root_account_code, account_code, 'NO_ROOT'), '^0+', '') as root_account_code,
              max(root_account_name) as root_account_name,
              ${needsAnalyticDimension ? "coalesce(account_analytic, '')" : "''::text"} as account_analytic,
              sum(coalesce(debit, 0)) as debit, sum(coalesce(credit, 0)) as credit,
              count(*)::bigint as row_count
         from journal
        where status = 'Posted' and ${notVirtualAccountSql()}
          and posting_date between $1::date and $2::date
        group by regexp_replace(coalesce(account_code, root_account_code, 'NO_ACCOUNT'), '^0+', ''),
                 regexp_replace(coalesce(root_account_code, account_code, 'NO_ROOT'), '^0+', '')
                 ${needsAnalyticDimension ? ", coalesce(account_analytic, '')" : ""}`,
    [startDate, endDate],
    );
    periodRows = result.rows;
  }

  const grouped = new Map();
  const mergeRow = (row, kind) => {
    const accountCode = normalizeAccountPrefix(row.account_code || row.root_account_code) || "NO_ACCOUNT";
    const rootAccountCode = normalizeAccountPrefix(row.root_account_code || row.account_code) || "NO_ROOT";
    const sourceAnalytic = String(row.account_analytic || "");
    const rowAnalytic = groupByAnalytic ? sourceAnalytic : "";
    if (normalizedPrefix && !accountCode.startsWith(normalizedPrefix)) return;
    if (analyticText && !sourceAnalytic.toLowerCase().includes(analyticText.toLowerCase())) return;
    const key = `${accountCode}|${rootAccountCode}|${rowAnalytic}`;
    const item = grouped.get(key) || {
      account_code: accountCode, account_name: row.account_name || "",
      root_account_code: rootAccountCode, root_account_name: row.root_account_name || "",
      account_analytic: rowAnalytic, opening_balance: 0, period_debit: 0, period_credit: 0, row_count: 0,
    };
    if (kind === "opening") item.opening_balance += Number(row.debit || 0) - Number(row.credit || 0);
    else { item.period_debit += Number(row.debit || 0); item.period_credit += Number(row.credit || 0); }
    item.row_count += Number(row.row_count || 0);
    if (row.account_name) item.account_name = row.account_name;
    if (row.root_account_name) item.root_account_name = row.root_account_name;
    grouped.set(key, item);
  };
  openingRows.forEach((row) => mergeRow(row, "opening"));
  periodRows.forEach((row) => mergeRow(row, "period"));
  const resultRows = Array.from(grouped.values()).map((row) => ({
    ...row,
    closing_balance: row.opening_balance + row.period_debit - row.period_credit,
  })).filter((row) => Math.abs(row.opening_balance) > 0 || Math.abs(row.period_debit) > 0 || Math.abs(row.period_credit) > 0 || Math.abs(row.closing_balance) > 0)
    .sort((a, b) => `${a.root_account_code}|${a.account_code}|${a.account_analytic}`.localeCompare(`${b.root_account_code}|${b.account_code}|${b.account_analytic}`));

  let totalOpeningDebit = 0;
  let totalOpeningCredit = 0;
  let totalDebit = 0;
  let totalCredit = 0;
  let totalClosingDebit = 0;
  let totalClosingCredit = 0;
  const rows = resultRows.map((row) => {
    const opening = splitDebitCredit(row.opening_balance);
    const closing = splitDebitCredit(row.closing_balance);
    totalOpeningDebit += opening.debit;
    totalOpeningCredit += opening.credit;
    totalDebit += Number(row.period_debit || 0);
    totalCredit += Number(row.period_credit || 0);
    totalClosingDebit += closing.debit;
    totalClosingCredit += closing.credit;
    return {
      rootAccountCode: row.root_account_code,
      rootAccountName: row.root_account_name || "",
      accountCode: row.account_code,
      accountName: row.account_name || "",
      accountAnalytic: row.account_analytic || "",
      openingDebit: opening.debit,
      openingCredit: opening.credit,
      periodDebit: Number(row.period_debit || 0),
      periodCredit: Number(row.period_credit || 0),
      closingDebit: closing.debit,
      closingCredit: closing.credit,
      rowCount: Number(row.row_count || 0),
    };
  });

  return {
    period: { startDate, endDate, openingDate },
    filters: { accountPrefix: normalizedPrefix, analytic: analyticText, groupByAnalytic: Boolean(groupByAnalytic) },
    rows,
    totals: {
      openingDebit: totalOpeningDebit,
      openingCredit: totalOpeningCredit,
      periodDebit: totalDebit,
      periodCredit: totalCredit,
      closingDebit: totalClosingDebit,
      closingCredit: totalClosingCredit,
    },
  };
}

async function queryTrialBalanceRawSource(client, params) {
  const { startDate, endDate, accountCode, accountAnalytic = "", analyticFilter = "", page, pageSize } = params;
  const openingDate = periodOpeningBalanceDate(startDate);
  const normalizedAccount = normalizeAccountPrefix(accountCode);
  if (!normalizedAccount) return { rows: [], total: 0, page, pageSize, meta: { startDate, endDate, openingDate } };
  const offset = (page - 1) * pageSize;
  const values = [startDate, endDate, normalizedAccount];
  const selectedAnalytic = String(accountAnalytic || "").trim();
  const reportAnalyticFilter = String(analyticFilter || "").trim();
  let analyticClause = "";
  let analyticPredicate = "all";
  if (selectedAnalytic) {
    values.push(selectedAnalytic);
    analyticClause = `and trim(coalesce(account_analytic, '')) = $4`;
    analyticPredicate = "exact-selected-row";
  } else if (reportAnalyticFilter) {
    values.push(`%${reportAnalyticFilter}%`);
    analyticClause = `and trim(coalesce(account_analytic, '')) ilike $4`;
    analyticPredicate = "contains-report-filter";
  }
  const result = await client.query(
    `select id, journal_id, journal_num, source_num, journal_name, posting_date, status,
            account_code, account_name, account_type, root_account_code, root_account_name,
            debit, credit, balance, account_analytic, department,
            case
              when posting_date < $1::date then 'opening'
              when posting_date >= $1::date and posting_date <= $2::date then 'period'
              else 'other'
            end as source_bucket,
            count(*) over()::int as total_count
      from journal
     where status = 'Posted'
        and ${notVirtualAccountSql()}
        and posting_date <= $2::date
        and regexp_replace(coalesce(account_code, root_account_code, ''), '^0+', '') = $3
        ${analyticClause}
      order by posting_date, journal_id, id
      limit $${values.length + 1} offset $${values.length + 2}`,
    [...values, pageSize, offset],
  );
  return {
    rows: result.rows.map((row) => mapRawJournalRow(row, { sourceBucket: row.source_bucket })),
    total: Number(result.rows[0]?.total_count || 0),
    page,
    pageSize,
    meta: {
      report: "TrialBalance",
      code: normalizedAccount,
      accountAnalytic: selectedAnalytic,
      analyticFilter: reportAnalyticFilter,
      analyticPredicate,
      sourceMode: "trial-balance",
      startDate,
      endDate,
      openingDate,
      fromDate: "1900-01-01",
      toDate: endDate,
    },
  };
}

function buildValidations(B01, B03, currentCount, unclassifiedSummary, context = {}) {
  const validations = [];
  const totalAssets = reportValue(B01, "280");
  const totalCapital = reportValue(B01, "440");
  if (Math.abs(totalAssets - totalCapital) > 1) {
    validations.push({
      severity: "error",
      title: "B01 chưa cân",
      detail: `Tổng tài sản ${totalAssets.toLocaleString("vi-VN")} khác tổng nguồn vốn ${totalCapital.toLocaleString("vi-VN")}.`,
    });
  }
  const b03EndCash = reportValue(B03, "70");
  const b01EndCash = reportValue(B01, "110");
  if (Math.abs(b03EndCash - b01EndCash) > 1) {
    validations.push({
      severity: "warning",
      title: "B03 không khớp B01 tiền",
      detail: `B03 mã 70 ${b03EndCash.toLocaleString("vi-VN")} khác B01 mã 110 ${b01EndCash.toLocaleString("vi-VN")}. Kiểm tra dòng tiền chưa phân loại, tương đương tiền và ảnh hưởng tỷ giá.`,
    });
  }
  if (unclassifiedSummary.length) {
    validations.push({
      severity: "warning",
      title: "Dòng tiền cần phân loại",
      detail: `${unclassifiedSummary.reduce((sum, row) => sum + row.count, 0)} dòng tiền chưa match rule B03.`,
    });
  }
  if (Math.abs(Number(context.unallocatedProductionCosts || 0)) > 1) {
    validations.push({
      severity: "warning",
      title: "Chi phí sản xuất chưa phân bổ/kết chuyển",
      detail: `Các tài khoản 621/622/627 còn số dư ròng ${Number(context.unallocatedProductionCosts).toLocaleString("vi-VN")}. B01 chỉ phản ánh số dư thực tế của tài khoản 421 và có thể chưa cân; B02 chỉ được coi là hoàn tất sau khi kế toán rà soát phân bổ giá thành.`,
    });
  }
  if (Number(context.interestReceiptReviewCount || 0) > 0) {
    validations.push({
      severity: "warning",
      title: "Rà soát lãi tiền gửi B03",
      detail: `${Number(context.interestReceiptReviewCount).toLocaleString("vi-VN")} khoản thu đối ứng 515111 đang được phân loại vào B03 mã 27 theo quy tắc doanh nghiệp. Cần chuyển lãi tiền gửi không kỳ hạn sang mã 01 nếu có.`,
    });
  }
  if (context.b02PriorHistory?.applicable) {
    validations.push({
      severity: "info",
      title: "Nguồn số năm trước B02",
      detail: `B02 cột Năm trước lấy từ ${context.b02PriorHistory.monthCount} báo cáo tháng lịch sử của đúng kỳ ${context.priorStartDate} - ${context.priorEndDate}; không cộng thêm journal kỳ trước. Mã 21, 70 và 71 giữ trạng thái chưa nhập vì mẫu TT200 không đủ dữ liệu chuyển đổi đáng tin cậy.`,
    });
  } else if (context.b02PriorHistory?.reason === "incomplete") {
    validations.push({
      severity: "warning",
      title: "Dữ liệu lịch sử B02 chưa đủ kỳ",
      detail: `Bảng lịch sử không đủ toàn bộ tháng/chỉ tiêu cho kỳ ${context.priorStartDate} - ${context.priorEndDate}; ứng dụng giữ nguồn journal hiện tại thay vì trộn hai nguồn.`,
    });
  } else if (context.b02PriorHistory?.reason === "partial-month-range") {
    validations.push({
      severity: "warning",
      title: "B02 kỳ trước không tròn tháng",
      detail: `Nguồn B02 lịch sử chỉ có số liệu theo tháng, không thể suy ra chính xác kỳ lẻ ${context.priorStartDate} - ${context.priorEndDate}; ứng dụng giữ nguồn journal hiện tại thay vì phân bổ ước tính.`,
    });
  }
  validations.push({
    severity: "info",
    title: "B09-DN có nội dung chưa nhập",
    detail: "Ứng dụng giữ nguyên 53 bảng nội dung của mẫu B09-DN. Các ô không thể xác định đáng tin cậy từ journal được để trống/chưa nhập và phải được người lập bổ sung, phê duyệt trước khi phát hành.",
  });
  if (!context.openingBalanceAccounts) {
    validations.push({
      severity: "warning",
      title: "Thiếu dữ liệu số đầu năm B01",
      detail: `Không tìm thấy số dư đến hết ngày ${context.openingBalanceDate || "đầu năm"}. Cột Số đầu năm có thể bằng 0 nếu database không có bút toán đầu năm hoặc dữ liệu năm trước.`,
    });
  }
  validations.push({
    severity: "info",
    title: "Nguồn dữ liệu",
    detail: `Backend đã aggregate từ ${currentCount.toLocaleString("vi-VN")} dòng journal kỳ hiện tại; frontend không tải raw journal.`,
  });
  return validations;
}

async function generateCompactReports(client, startDate, endDate) {
  const priorStartDate = oneYearBack(startDate);
  const priorEndDate = oneYearBack(endDate);
  const currentYearStartDate = yearStart(endDate);
  const openingBalanceDate = b01OpeningBalanceDate(endDate);
  const currentB03OpeningDate = periodOpeningBalanceDate(startDate);
  const priorB03OpeningDate = periodOpeningBalanceDate(priorStartDate);
  const priorYearStartDate = yearStart(priorEndDate);
  // A pg Client supports one active query at a time. Keep these reads
  // sequential so report generation remains compatible with pg 9+.
  const currentBalanceAgg = await queryBalanceAggregates(client, endDate);
  const priorBalanceAgg = await queryBalanceAggregates(client, openingBalanceDate);
  const currentPeriodAgg = await queryPeriodAggregates(client, startDate, endDate);
  const priorPeriodAgg = await queryPeriodAggregates(client, priorStartDate, priorEndDate);
  const b02PriorHistory = await queryHistoricalB02Prior(client, priorStartDate, priorEndDate);
  const currentProfitTransferred = await queryProfitTransferredTo421(client, currentYearStartDate, endDate);
  const priorProfitTransferred = await queryProfitTransferredTo421(client, priorYearStartDate, priorEndDate);
  const currentCashMovements = await queryCashMovements(client, startDate, endDate);
  const priorCashMovements = await queryCashMovements(client, priorStartDate, priorEndDate);
  const currentCount = await countRows(client, startDate, endDate);
  const priorCount = await countRows(client, priorStartDate, priorEndDate);
  const currentB03OpeningAgg = await queryBalanceAggregates(client, currentB03OpeningDate);
  const priorB03OpeningAgg = await queryBalanceAggregates(client, priorB03OpeningDate);

  const B01 = buildLineReport(b01Lines, currentBalanceAgg, priorBalanceAgg, "balance");
  const B02 = applyHistoricalB02Prior(
    buildLineReport(b02Lines, currentPeriodAgg, priorPeriodAgg, "period"),
    b02PriorHistory,
  );
  const B03OpeningBalances = buildLineReport(b01Lines, currentB03OpeningAgg, priorB03OpeningAgg, "balance");
  const B03 = buildB03(
    currentCashMovements,
    priorCashMovements,
    reportValue(B03OpeningBalances, "110"),
    reportValue(B03OpeningBalances, "110", "prior"),
  );
  const B09 = buildB09(B01, B02, B03);
  const unclassifiedSummary = summarizeUnclassified(currentCashMovements);
  const unallocatedProductionCosts = currentBalanceAgg
    .filter((row) => codeMatches(row.account_code || row.root_account_code, ["621", "622", "627"]))
    .reduce((total, row) => total + Number(row.debit || 0) - Number(row.credit || 0), 0);
  const interestReceiptReviewCount = currentCashMovements.filter((movement) =>
    movement.matched_code === "27" && (movement.opposite_accounts || []).some((account) => normalizeCode(account).startsWith("515111")),
  ).length;
  return {
    formulaVersion,
    period: { startDate, endDate, priorStartDate, priorEndDate, openingBalanceDate, currentYearStartDate, currentB03OpeningDate, priorB03OpeningDate },
    reports: { B01, B02, B03, B09 },
    validations: buildValidations(B01, B03, currentCount, unclassifiedSummary, {
      openingBalanceAccounts: priorBalanceAgg.length,
      openingBalanceDate,
      currentYearStartDate,
      unallocatedProductionCosts,
      interestReceiptReviewCount,
      b02PriorHistory,
      priorStartDate,
      priorEndDate,
    }),
    counts: {
      currentRows: currentCount,
      priorRows: priorCount,
      balanceAccounts: currentBalanceAgg.length,
      openingBalanceAccounts: priorBalanceAgg.length,
      priorBalanceAccounts: priorBalanceAgg.length,
      periodAccounts: currentPeriodAgg.length,
      priorPeriodAccounts: priorPeriodAgg.length,
      profitTransferredTo421: Math.round(currentProfitTransferred),
      priorProfitTransferredTo421: Math.round(priorProfitTransferred),
      cashMovements: currentCashMovements.length,
      priorCashMovements: priorCashMovements.length,
    },
    manualMapping: [...B01, ...B02, ...B03].filter((row) => row.requiresManualMapping).map((row) => ({ reportCode: row.code, label: row.label })),
    unclassifiedSummary,
  };
}

app.get("/api/health", async (_req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("select 1");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

app.get("/api/admin/users", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `select id::text, username, role, is_active as "isActive",
              failed_login_attempts as "failedLoginAttempts", locked_until as "lockedUntil",
              password_changed_at as "passwordChangedAt", last_login_at as "lastLoginAt",
              created_at as "createdAt"
         from public.app_users
        order by case when role = 'admin' then 0 else 1 end, username`,
    );
    res.json({ ok: true, users: result.rows });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/users", async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = validateNewPassword(req.body?.password);
    const role = req.body?.role === "admin" ? "admin" : "user";
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
      res.status(400).json({ ok: false, message: "Username must be 3-64 lowercase letters, numbers, dot, underscore or dash" });
      return;
    }
    const result = await pool.query(
      `insert into public.app_users (username, password_hash, role)
       values ($1, $2, $3)
       returning id::text, username, role, is_active as "isActive", created_at as "createdAt"`,
      [username, hashPassword(password), role],
    );
    res.status(201).json({ ok: true, user: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      res.status(409).json({ ok: false, message: "Username already exists" });
      return;
    }
    next(error);
  }
});

app.patch("/api/admin/users/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id || "");
    if (!/^\d+$/.test(id)) {
      res.status(400).json({ ok: false, message: "Invalid user id" });
      return;
    }
    const targetResult = await pool.query(
      `select id::text, role, is_active from public.app_users where id = $1::bigint`,
      [id],
    );
    const target = targetResult.rows[0];
    if (!target) {
      res.status(404).json({ ok: false, message: "User not found" });
      return;
    }
    const role = req.body?.role === undefined ? target.role : req.body.role;
    const isActive = req.body?.isActive === undefined ? target.is_active : req.body.isActive;
    if (!['admin', 'user'].includes(role) || typeof isActive !== "boolean") {
      res.status(400).json({ ok: false, message: "Invalid role or active state" });
      return;
    }
    if (id === String(req.user.userId) && (role !== "admin" || !isActive)) {
      res.status(409).json({ ok: false, message: "You cannot demote or disable your own admin account" });
      return;
    }
    if (target.role === "admin" && target.is_active && (role !== "admin" || !isActive)) {
      const count = await pool.query(
        `select count(*)::int as count from public.app_users where role = 'admin' and is_active = true and id <> $1::bigint`,
        [id],
      );
      if (!Number(count.rows[0]?.count || 0)) {
        res.status(409).json({ ok: false, message: "At least one active admin account is required" });
        return;
      }
    }
    const result = await pool.query(
      `update public.app_users
          set role = $2, is_active = $3, updated_at = now()
        where id = $1::bigint
        returning id::text, username, role, is_active as "isActive"`,
      [id, role, isActive],
    );
    if (!isActive || role !== target.role) invalidateUserSessions(id);
    res.json({ ok: true, user: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/users/:id/reset-password", async (req, res, next) => {
  try {
    const id = String(req.params.id || "");
    if (!/^\d+$/.test(id)) {
      res.status(400).json({ ok: false, message: "Invalid user id" });
      return;
    }
    const newPassword = validateNewPassword(req.body?.newPassword);
    const adminResult = await pool.query(
      `select password_hash from public.app_users where id = $1::bigint and role = 'admin' and is_active = true`,
      [req.user.userId],
    );
    if (!verifyPassword(req.body?.currentPassword, adminResult.rows[0]?.password_hash)) {
      res.status(401).json({ ok: false, message: "Current admin password is incorrect" });
      return;
    }
    const result = await pool.query(
      `update public.app_users
          set password_hash = $2, password_changed_at = now(), failed_login_attempts = 0,
              locked_until = null, updated_at = now()
        where id = $1::bigint
        returning id::text, username`,
      [id, hashPassword(newPassword)],
    );
    if (!result.rowCount) {
      res.status(404).json({ ok: false, message: "User not found" });
      return;
    }
    invalidateUserSessions(id);
    const changedSelf = id === String(req.user.userId);
    if (changedSelf) {
      res.setHeader("Set-Cookie", cookie(authCookieName, "", {
        maxAge: 0,
        secure: String(process.env.AUTH_COOKIE_SECURE || "false").toLowerCase() === "true",
      }));
    }
    res.json({ ok: true, username: result.rows[0].username, logoutRequired: changedSelf });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/snapshots", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      scheduler: {
        enabled: String(process.env.SNAPSHOT_SCHEDULER_ENABLED || "true").toLowerCase() !== "false",
        timeZone: process.env.SNAPSHOT_TIME_ZONE || "Asia/Ho_Chi_Minh",
        scheduleHour: Number(process.env.SNAPSHOT_SCHEDULE_HOUR || 3),
      },
      ...(await getSnapshotStatus(pool, {
        migrationMonth: process.env.SNAPSHOT_MIGRATION_MONTH || "2025-12",
        timeZone: process.env.SNAPSHOT_TIME_ZONE || "Asia/Ho_Chi_Minh",
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/snapshots/create-missing", async (_req, res, next) => {
  try {
    res.json(await createMissingSnapshots(pool, {
      migrationMonth: process.env.SNAPSHOT_MIGRATION_MONTH || "2025-12",
      timeZone: process.env.SNAPSHOT_TIME_ZONE || "Asia/Ho_Chi_Minh",
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/snapshots/rebuild", async (req, res, next) => {
  try {
    const result = await rebuildSnapshots(pool, {
      fromMonth: req.body?.fromMonth,
      migrationMonth: process.env.SNAPSHOT_MIGRATION_MONTH || "2025-12",
      timeZone: process.env.SNAPSHOT_TIME_ZONE || "Asia/Ho_Chi_Minh",
    });
    res.json({ ...result, status: await getSnapshotStatus(pool, {
      migrationMonth: process.env.SNAPSHOT_MIGRATION_MONTH || "2025-12",
      timeZone: process.env.SNAPSHOT_TIME_ZONE || "Asia/Ho_Chi_Minh",
    }) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/fonts/arial.ttf", (_req, res) => {
  const fontPath = path.join(process.env.SystemRoot || "C:\\Windows", "Fonts", "arial.ttf");
  if (!fs.existsSync(fontPath)) {
    res.status(404).json({ ok: false, message: "arial.ttf not found on this machine" });
    return;
  }
  res.type("font/ttf").send(fs.readFileSync(fontPath));
});

async function handleGenerate(req, res, next) {
  const { startDate, endDate } = req.body || {};
  try {
    validateDate(startDate, "startDate");
    validateDate(endDate, "endDate");
    if (startDate > endDate) {
      const error = new Error("startDate must be before or equal to endDate");
      error.status = 400;
      throw error;
    }

    const priorStartDate = oneYearBack(startDate);
    const priorEndDate = oneYearBack(endDate);
    const client = await pool.connect();
    try {
      await assertJournalSchema(client);
      res.json(await generateCompactReports(client, startDate, endDate));
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
}

app.post("/api/reports/generate", handleGenerate);
app.post("/api/reports/query", handleGenerate);

app.post("/api/reports/trial-balance", async (req, res, next) => {
  const { startDate, endDate, accountPrefix, analytic, groupByAnalytic } = req.body || {};
  try {
    validateDate(startDate, "startDate");
    validateDate(endDate, "endDate");
    if (startDate > endDate) {
      const error = new Error("startDate must be before or equal to endDate");
      error.status = 400;
      throw error;
    }
    const client = await pool.connect();
    try {
      await assertJournalSchema(client);
      res.json(await queryTrialBalance(client, { startDate, endDate, accountPrefix, analytic, groupByAnalytic }));
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.post("/api/reports/trial-balance/raw-source", async (req, res, next) => {
  const { startDate, endDate, accountCode, accountAnalytic, analyticFilter, groupByAnalytic } = req.body || {};
  const page = Math.max(1, Number(req.body?.page || 1));
  const pageSize = Math.min(1000, Math.max(50, Number(req.body?.pageSize || 500)));
  try {
    validateDate(startDate, "startDate");
    validateDate(endDate, "endDate");
    const client = await pool.connect();
    try {
      await assertJournalSchema(client);
      res.json(await queryTrialBalanceRawSource(client, { startDate, endDate, accountCode, accountAnalytic, analyticFilter, groupByAnalytic, page, pageSize }));
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.post("/api/reports/payable-aging", async (req, res, next) => {
  const { endDate, analytic } = req.body || {};
  try {
    validateDate(endDate, "endDate");
    const client = await pool.connect();
    try {
      await assertJournalSchema(client);
      res.json(await queryPayableAging(client, { endDate, analytic }));
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.post("/api/reports/payable-aging/raw-source", async (req, res, next) => {
  const { endDate, accountAnalytic, accountAnalyticKey, bucket } = req.body || {};
  const page = Math.max(1, Number(req.body?.page || 1));
  const pageSize = Math.min(1000, Math.max(50, Number(req.body?.pageSize || 500)));
  try {
    validateDate(endDate, "endDate");
    const client = await pool.connect();
    try {
      await assertJournalSchema(client);
      res.json(await queryPayableAgingRawSource(client, { endDate, accountAnalytic, accountAnalyticKey, bucket, page, pageSize }));
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.get("/api/reports/drilldown", async (req, res, next) => {
  const { report, code, startDate, endDate } = req.query || {};
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(500, Math.max(25, Number(req.query.pageSize || 100)));
  try {
    validateDate(startDate, "startDate");
    validateDate(endDate, "endDate");
    const client = await pool.connect();
    try {
      await assertJournalSchema(client);
      let rows = [];
      let reportedAmount = null;
      if (report === "B01" && code) {
        const aggregates = await queryBalanceAggregates(client, endDate);
        const reportRows = buildLineReport(b01Lines, aggregates, [], "balance");
        reportedAmount = reportRows.find((row) => row.code === code)?.current ?? null;
        rows = buildAggregateDrilldown(b01Lines, aggregates, code, "balance", "B01", endDate);
      } else if (report === "B02" && code) {
        const aggregates = await queryPeriodAggregates(client, startDate, endDate);
        const reportRows = buildLineReport(b02Lines, aggregates, [], "period");
        reportedAmount = reportRows.find((row) => row.code === code)?.current ?? null;
        rows = buildAggregateDrilldown(b02Lines, aggregates, code, "period", "B02", endDate);
      } else if (report === "B03") {
        const movements = await queryCashMovements(client, startDate, endDate);
        if (!code) {
          rows = movements.filter((movement) => !movement.matched_code).map((movement) => ({
            journalId: movement.journal_id,
            journalNum: movement.journal_num,
            postingDate: dateOnly(movement.posting_date),
            accountCode: movement.account_code,
            accountName: movement.account_name,
            amount: Number(movement.amount || 0),
            oppositeAccounts: movement.opposite_accounts || [],
            sourceNum: movement.source_num,
            matchedCode: movement.matched_code,
            reason: movement.reason,
          }));
        } else {
          const openingDate = periodOpeningBalanceDate(startDate);
          const openingAggregates = await queryBalanceAggregates(client, openingDate);
          const openingB01 = buildLineReport(b01Lines, openingAggregates, [], "balance");
          const openingCash = openingB01.find((row) => row.code === "110")?.current ?? 0;
          const b03Report = buildB03(movements, [], openingCash, 0);
          reportedAmount = b03Report.find((row) => row.code === code)?.current ?? null;
          for (const { line, coefficient } of collectLineLeaves(b03Lines, code)) {
            const leafCode = line[0];
            if (leafCode === "60") {
              if (Math.abs(Number(openingCash || 0)) > 0.000001) rows.push({
                journalId: "B03.60",
                journalNum: "B03.60",
                postingDate: openingDate,
                accountCode: "110",
                accountName: "Tiền và các khoản tương đương tiền đầu kỳ",
                amount: Number(openingCash || 0) * coefficient,
                oppositeAccounts: [],
                sourceNum: "B01.110 số đầu kỳ",
                matchedCode: "60",
                reason: "Cộng số đầu kỳ theo đúng predicate B03.60",
              });
              continue;
            }
            rows.push(...movements.filter((movement) => movement.matched_code === leafCode).map((movement) => ({
              journalId: movement.journal_id,
              journalNum: movement.journal_num,
              postingDate: dateOnly(movement.posting_date),
              accountCode: movement.account_code,
              accountName: movement.account_name,
              amount: Number(movement.amount || 0) * coefficient,
              oppositeAccounts: movement.opposite_accounts || [],
              sourceNum: movement.source_num,
              matchedCode: leafCode,
              reason: `${coefficient < 0 ? "Trừ" : "Cộng"} theo đúng predicate B03.${leafCode}: ${movement.reason || ""}`,
            })));
          }
        }
      }
      const reconciliation = summarizeDrilldown(rows, reportedAmount);
      const total = rows.length;
      const start = (page - 1) * pageSize;
      res.json({ rows: rows.slice(start, start + pageSize), total, page, pageSize, reconciliation });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.get("/api/reports/raw-source", async (req, res, next) => {
  const { report, code, startDate, endDate, side } = req.query || {};
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(1000, Math.max(50, Number(req.query.pageSize || 500)));
  try {
    validateDate(startDate, "startDate");
    validateDate(endDate, "endDate");
    if (!["B01", "B02", "B03"].includes(String(report || ""))) {
      const error = new Error("report must be B01, B02 or B03");
      error.status = 400;
      throw error;
    }
    if (!String(code || "").trim()) {
      const error = new Error("code is required");
      error.status = 400;
      throw error;
    }
    const client = await pool.connect();
    try {
      await assertJournalSchema(client);
      res.json(await queryReportRawSource(client, { report, code, startDate, endDate, side, page, pageSize }));
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    ok: false,
    message: error.message || "Unexpected server error",
  });
});

if (require.main === module) {
  app.listen(port, "127.0.0.1", () => {
    console.log(`BCTC TT99 API listening on http://127.0.0.1:${port}`);
    startSnapshotScheduler(pool, {
      enabled: String(process.env.SNAPSHOT_SCHEDULER_ENABLED || "true").toLowerCase() !== "false",
      migrationMonth: process.env.SNAPSHOT_MIGRATION_MONTH || "2025-12",
      timeZone: process.env.SNAPSHOT_TIME_ZONE || "Asia/Ho_Chi_Minh",
      scheduleHour: Number(process.env.SNAPSHOT_SCHEDULE_HOUR || 3),
    });
  });
}

module.exports = {
  app,
  b01Lines,
  b02Lines,
  b03Lines,
  buildB09,
  buildB03,
  buildPayableAgingFromRows,
  buildLineReport,
  dateOnly,
  generateCompactReports,
  periodOpeningBalanceDate,
  queryBalanceAggregates,
  queryCashMovements,
  queryPayableAging,
  queryPeriodAggregates,
  queryTrialBalance,
  queryTrialBalanceRawSource,
};
