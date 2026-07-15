const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

dotenv.config();

const app = express();
const port = Number(process.env.API_PORT || 3021);

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

const authUsername = process.env.AUTH_USERNAME || "admin";
const authPasswordHash = process.env.AUTH_PASSWORD_HASH || "";
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

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyPassword(password) {
  const [scheme, digest, iterationsText, salt, expected] = String(authPasswordHash || "").split("$");
  if (scheme !== "pbkdf2" || digest !== "sha256" || !iterationsText || !salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(String(password || ""), salt, Number(iterationsText), 32, "sha256").toString("base64url");
  return timingSafeEqualText(actual, expected);
}

function pruneSessions() {
  const now = Date.now();
  for (const [key, value] of sessions.entries()) {
    if (value.expiresAt <= now) sessions.delete(key);
  }
}

function createSession(username) {
  pruneSessions();
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(tokenDigest(token), { username, expiresAt: Date.now() + sessionTtlMs });
  return token;
}

function readSession(req) {
  if (!sessionSecret) return null;
  const token = parseCookies(req.headers.cookie)[authCookieName];
  if (!token) return null;
  const key = tokenDigest(token);
  const session = sessions.get(key);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(key);
    return null;
  }
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

app.post("/api/auth/login", (req, res) => {
  if (!authPasswordHash || !sessionSecret) {
    res.status(500).json({ ok: false, message: "Authentication is not configured" });
    return;
  }
  if (isLoginBlocked(req)) {
    res.status(429).json({ ok: false, message: "Too many failed login attempts. Try again later." });
    return;
  }
  const { username, password } = req.body || {};
  if (String(username || "") !== authUsername || !verifyPassword(password)) {
    registerLoginFailure(req);
    res.status(401).json({ ok: false, message: "Invalid username or password" });
    return;
  }
  clearLoginFailures(req);
  const token = createSession(authUsername);
  res.setHeader("Set-Cookie", cookie(authCookieName, token, {
    maxAge: Math.floor(sessionTtlMs / 1000),
    secure: String(process.env.AUTH_COOKIE_SECURE || "false").toLowerCase() === "true",
  }));
  res.json({ ok: true, user: { username: authUsername } });
});

app.post("/api/auth/logout", (req, res) => {
  const token = parseCookies(req.headers.cookie)[authCookieName];
  if (token && sessionSecret) sessions.delete(tokenDigest(token));
  res.setHeader("Set-Cookie", cookie(authCookieName, "", { maxAge: 0, secure: String(process.env.AUTH_COOKIE_SECURE || "false").toLowerCase() === "true" }));
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const session = readSession(req);
  if (!session) {
    res.status(401).json({ ok: false, user: null });
    return;
  }
  res.json({ ok: true, user: { username: session.username } });
});

app.use("/api", (req, res, next) => {
  const session = readSession(req);
  if (!session) {
    res.status(401).json({ ok: false, message: "Authentication required" });
    return;
  }
  req.user = session;
  next();
});

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

const formulaVersion = "tt99-server-aggregation-v7-tt99-closing-aware";
const migrationOpeningDate = "2026-01-01";
const cashPrefixes = ["111", "112", "113"];
const excludedVirtualAccountNames = ["More Account 111/112", "More Account 131"];

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
  ["341", "11. Cổ phiếu ưu đãi", 2, null, ["41112"], "credit", false, 1, true],
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
// 10 manualOnly. Ambiguous maturity/nature lines must remain zero until the
// source contains enough detail; they must never reuse the same balance in
// several statutory captions.
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
  "343": [[], true, [], true], "411": [["411"], false, ["41112", "4112", "4113", "4118"]],
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
  ["420a", "- Lũy kế đến cuối kỳ trước", 2, null, ["4211"], "credit"],
  ["420b", "- Kỳ này", 2, null, ["4212"], "credit"],
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
  ["24", "Trong đó: Chi phí lãi vay", 1, null, ["635411", "635412", "635413"], "debit", false, 1, true],
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
  ["32", "2. Tiền trả lại vốn góp cho các chủ sở hữu, mua lại cổ phiếu", 1],
  ["33", "3. Tiền thu từ đi vay", 1],
  ["34", "4. Tiền trả nợ gốc vay", 1],
  ["35", "5. Tiền trả nợ gốc thuê tài chính", 1],
  ["36", "6. Cổ tức, lợi nhuận đã trả cho chủ sở hữu", 1],
  ["40", "Lưu chuyển tiền thuần từ hoạt động tài chính", 0, "31+32+33+34+35+36", true],
  ["50", "Lưu chuyển tiền thuần trong kỳ (50 = 20 + 30 + 40)", 0, "20+30+40", true],
  ["60", "Tiền và tương đương tiền đầu kỳ", 0, null, true],
  ["61", "Ảnh hưởng của thay đổi tỷ giá hối đoái quy đổi ngoại tệ", 0],
  ["70", "Tiền và tương đương tiền cuối kỳ (70 = 50 + 60 + 61)", 0, "50+60+61", true],
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
  return reportYearStart === migrationOpeningDate ? migrationOpeningDate : addDays(reportYearStart, -1);
}

function periodOpeningBalanceDate(startDate) {
  return startDate === migrationOpeningDate ? migrationOpeningDate : addDays(startDate, -1);
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

  for (const [code, _label, _level, expression, prefixes, side, _bold, sign = 1, requiresManualMapping, excludedPrefixes = [], manualOnly = false] of lines) {
    if (!code || expression || !prefixes) continue;
    const matchesLine = (row) => {
      const accountCode = row.account_code || row.root_account_code;
      return codeMatches(accountCode, prefixes) && !codeMatches(accountCode, excludedPrefixes);
    };
    const currentRows = manualOnly ? [] : allCurrent.filter(matchesLine);
    const priorRows = manualOnly ? [] : allPrior.filter(matchesLine);
    const calc = mode === "balance" ? (grossBalanceCodes.has(code) ? oneSidedBalance : netBalance) : periodActivity;
    currentValues.set(code, manualOnly ? 0 : calc(currentRows, side) * sign);
    priorValues.set(code, manualOnly ? 0 : calc(priorRows, side) * sign);
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

function addValue(rows, code, side, amount, formulaNote) {
  const row = rows.find((item) => item.code === code);
  if (!row || !Number.isFinite(amount) || Math.abs(amount) <= 1) return;
  row[side] = Number(row[side] || 0) + amount;
  row.formula = row.formula ? `${row.formula}; ${formulaNote}` : formulaNote;
}

function applyUnclosedProfitFromYtdB02ToB01(B01, ytdB02, currentAdjustment, priorAdjustment) {
  addValue(B01, "420b", "current", currentAdjustment, "Kết quả chưa kết chuyển = số dư Có trừ Nợ của các tài khoản tạm thời loại 5-9");
  addValue(B01, "420", "current", currentAdjustment, "420b bao gồm kết quả chưa kết chuyển");
  addValue(B01, "400", "current", currentAdjustment, "420 bao gồm lãi/lỗ chưa kết chuyển từ B02 lũy kế");
  addValue(B01, "440", "current", currentAdjustment, "400 bao gồm lãi/lỗ chưa kết chuyển từ B02 lũy kế");
  addValue(B01, "420b", "prior", priorAdjustment, "Kết quả chưa kết chuyển = số dư Có trừ Nợ của các tài khoản tạm thời loại 5-9");
  addValue(B01, "420", "prior", priorAdjustment, "420b bao gồm kết quả chưa kết chuyển");
  addValue(B01, "400", "prior", priorAdjustment, "420 bao gồm lãi/lỗ chưa kết chuyển từ B02 lũy kế");
  addValue(B01, "440", "prior", priorAdjustment, "400 bao gồm lãi/lỗ chưa kết chuyển từ B02 lũy kế");
  return {
    currentAdjustment,
    priorAdjustment,
    currentYtdProfit: reportValue(ytdB02, "60"),
    priorYtdProfit: reportValue(ytdB02, "60", "prior"),
  };
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

function buildB09(B01, B02, B03) {
  return [
    {
      title: "I. Đặc điểm hoạt động của doanh nghiệp",
      paragraphs: [
        "Thông tin định tính cần kế toán nhập và rà soát.",
        "Ứng dụng chỉ tự điền các khoản mục có thể truy vết từ sổ nhật ký.",
      ],
    },
    {
      title: "V. Thông tin bổ sung cho Báo cáo tình hình tài chính",
      table: {
        columns: ["Chỉ tiêu", "Cuối năm", "Đầu năm", "Ghi chú"],
        rows: [
          ["Tiền và các khoản tương đương tiền", reportValue(B01, "110"), reportValue(B01, "110", "prior"), "B01.110"],
          ["Phải thu ngắn hạn của khách hàng", reportValue(B01, "131"), reportValue(B01, "131", "prior"), "B01.131"],
          ["Hàng tồn kho", reportValue(B01, "141"), reportValue(B01, "141", "prior"), "B01.141"],
          ["Nợ phải trả", reportValue(B01, "300"), reportValue(B01, "300", "prior"), "B01.300"],
        ],
      },
    },
    {
      title: "VI. Thông tin bổ sung cho Báo cáo kết quả hoạt động kinh doanh",
      table: {
        columns: ["Chỉ tiêu", "Năm nay", "Năm trước", "Ghi chú"],
        rows: [
          ["Doanh thu thuần", reportValue(B02, "10"), reportValue(B02, "10", "prior"), "B02.10"],
          ["Giá vốn hàng bán", reportValue(B02, "11"), reportValue(B02, "11", "prior"), "B02.11"],
          ["Lợi nhuận sau thuế", reportValue(B02, "60"), reportValue(B02, "60", "prior"), "B02.60"],
        ],
      },
    },
    {
      title: "VII. Thông tin bổ sung cho Báo cáo lưu chuyển tiền tệ",
      table: {
        columns: ["Chỉ tiêu", "Năm nay", "Năm trước", "Ghi chú"],
        rows: [
          ["Lưu chuyển tiền thuần từ HĐKD", reportValue(B03, "20"), reportValue(B03, "20", "prior"), "B03.20"],
          ["Lưu chuyển tiền thuần từ HĐĐT", reportValue(B03, "30"), reportValue(B03, "30", "prior"), "B03.30"],
          ["Lưu chuyển tiền thuần từ HĐTC", reportValue(B03, "40"), reportValue(B03, "40", "prior"), "B03.40"],
        ],
      },
    },
  ];
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
      ? `${row.journal_num || ""}|${row.posting_date || ""}|${row.source_num || ""}`
      : `journal:${row.journal_id}`,
    postingDate: row.posting_date ? String(row.posting_date).slice(0, 10) : "",
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
          and posting_date <> $3::date
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
        and posting_date <> $3::date
        and (
          regexp_replace(coalesce(j.account_code, j.root_account_code, ''), '^0+', '') ~ '^[5-9]'
          or j.journal_id in (select journal_id from cash_journals)
        )
      order by posting_date, journal_id, id`,
    [startDate, endDate, migrationOpeningDate],
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

async function queryBalanceAggregates(client, endDate) {
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

async function queryUnclosedTemporaryResult(client, endDate) {
  const result = await client.query(
    `select coalesce(sum(coalesce(credit, 0) - coalesce(debit, 0)), 0) as amount
       from journal
      where status = 'Posted'
        and ${notVirtualAccountSql()}
        and posting_date <= $1::date
        and regexp_replace(coalesce(account_code, root_account_code, ''), '^0+', '') ~ '^[5-9]'`,
    [endDate],
  );
  return Number(result.rows[0]?.amount || 0);
}

async function queryPeriodAggregates(client, startDate, endDate) {
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
        and posting_date <> $3::date
        and regexp_replace(coalesce(account_code, root_account_code, ''), '^0+', '') ~ '^[5-9]'
        and not exists (
          select 1
            from journal closing_line
           where closing_line.journal_id = journal.journal_id
             and closing_line.status = 'Posted'
             and regexp_replace(coalesce(closing_line.account_code, closing_line.root_account_code, ''), '^0+', '') ~ '^911'
        )
      group by account_code, root_account_code`,
    [startDate, endDate, migrationOpeningDate],
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
        and j.posting_date <> $3::date
        and regexp_replace(coalesce(j.account_code, j.root_account_code, ''), '^0+', '') ~ '^4212'
        and exists (
          select 1
            from journal closing_line
           where closing_line.journal_id = j.journal_id
             and closing_line.status = 'Posted'
             and regexp_replace(coalesce(closing_line.account_code, closing_line.root_account_code, ''), '^0+', '') ~ '^911'
        )`,
    [startDate, endDate, migrationOpeningDate],
  );
  return Number(result.rows[0]?.amount || 0);
}

async function queryCashMovements(client, startDate, endDate) {
  const result = await client.query(
    `with cash as (
       select j.id, j.journal_id, j.journal_num, j.source_num, j.journal_name, j.posting_date,
              j.account_code, j.account_name, j.root_account_code,
              coalesce(j.debit, 0) - coalesce(j.credit, 0) as amount
         from journal j
        where j.status = 'Posted'
          and ${notVirtualAccountSql("j")}
          and j.posting_date >= $1::date
          and j.posting_date <= $2::date
          and j.posting_date <> $3::date
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
    [startDate, endDate, migrationOpeningDate],
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
  for (const row of result.rows) {
    const key = row.journal_id == null ? `${row.journal_num || ""}|${row.posting_date || ""}|${row.source_num || ""}` : `journal:${row.journal_id}`;
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
        and posting_date <> $3::date`,
    [startDate, endDate, migrationOpeningDate],
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
    postingDate: row.posting_date,
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
  const { prefixes, excludedPrefixes = [], fromDate, toDate, page, pageSize, excludeMigrationOpening = false } = params;
  if (!prefixes.length) return { rows: [], total: 0, page, pageSize };
  const offset = (page - 1) * pageSize;
  const values = [fromDate, toDate, prefixes.map(normalizeCode), pageSize, offset];
  const extraFilters = [];
  if (excludeMigrationOpening) {
    values.push(migrationOpeningDate);
    extraFilters.push(`and posting_date <> $${values.length}::date`);
  }
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
      postingDate: movement.posting_date,
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
      ...(await queryRawJournalByPrefixes(client, { prefixes, excludedPrefixes, fromDate, toDate, page, pageSize, excludeMigrationOpening: true })),
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
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
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
  const values = [endDate];
  let analyticFilter = "";
  if (analyticText) {
    values.push(`%${analyticText}%`);
    analyticFilter = `and coalesce(account_analytic, '') ilike $2`;
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
  const filters = [];
  const values = [openingDate, startDate, endDate, migrationOpeningDate];
  let idx = values.length;

  if (normalizedPrefix) {
    values.push(`${normalizedPrefix}%`);
    idx += 1;
    filters.push(`regexp_replace(coalesce(account_code, root_account_code, ''), '^0+', '') like $${idx}`);
  }
  if (analyticText) {
    values.push(`%${analyticText}%`);
    idx += 1;
    filters.push(`coalesce(account_analytic, '') ilike $${idx}`);
  }

  const whereClause = filters.length ? `and ${filters.join(" and ")}` : "";
  const dimensionSelect = groupByAnalytic ? "account_analytic," : "null::text as account_analytic,";
  const dimensionGroup = groupByAnalytic ? "account_analytic," : "";

  const result = await client.query(
    `with normalized as (
       select regexp_replace(coalesce(account_code, root_account_code, 'NO_ACCOUNT'), '^0+', '') as account_code,
              account_name,
              regexp_replace(coalesce(root_account_code, account_code, 'NO_ROOT'), '^0+', '') as root_account_code,
              root_account_name,
              coalesce(account_analytic, '') as account_analytic,
              posting_date,
              coalesce(debit, 0) as debit,
              coalesce(credit, 0) as credit,
              coalesce(balance, coalesce(debit, 0) - coalesce(credit, 0)) as balance
        from journal
       where status = 'Posted'
          and ${notVirtualAccountSql()}
          and posting_date <= $3::date
          ${whereClause}
      ),
      base as (
       select account_code,
              max(account_name) as account_name,
              root_account_code,
              max(root_account_name) as root_account_name,
              ${dimensionSelect}
              sum(case when posting_date <= $1::date then balance else 0 end) as opening_balance,
              sum(case when posting_date >= $2::date and posting_date <= $3::date and posting_date <> $4::date then debit else 0 end) as period_debit,
              sum(case when posting_date >= $2::date and posting_date <= $3::date and posting_date <> $4::date then credit else 0 end) as period_credit,
              sum(case when posting_date <= $3::date then balance else 0 end) as closing_balance,
              count(*)::int as row_count
         from normalized
        group by account_code, root_account_code, ${dimensionGroup} account_code
      )
      select *
        from base
       where abs(opening_balance) > 0
          or abs(period_debit) > 0
          or abs(period_credit) > 0
          or abs(closing_balance) > 0
       order by root_account_code, account_code, account_analytic nulls first, account_name`,
    values,
  );

  let totalOpeningDebit = 0;
  let totalOpeningCredit = 0;
  let totalDebit = 0;
  let totalCredit = 0;
  let totalClosingDebit = 0;
  let totalClosingCredit = 0;
  const rows = result.rows.map((row) => {
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
  const { startDate, endDate, accountCode, accountAnalytic = "", groupByAnalytic = false, page, pageSize } = params;
  const openingDate = periodOpeningBalanceDate(startDate);
  const normalizedAccount = normalizeAccountPrefix(accountCode);
  if (!normalizedAccount) return { rows: [], total: 0, page, pageSize, meta: { startDate, endDate, openingDate } };
  const offset = (page - 1) * pageSize;
  const values = [startDate, endDate, normalizedAccount, migrationOpeningDate];
  let analyticFilter = "";
  if (groupByAnalytic) {
    values.push(String(accountAnalytic || ""));
    analyticFilter = `and coalesce(account_analytic, '') = $5`;
  }
  const result = await client.query(
    `select id, journal_id, journal_num, source_num, journal_name, posting_date, status,
            account_code, account_name, account_type, root_account_code, root_account_name,
            debit, credit, balance, account_analytic, department,
            case
              when posting_date < $1::date or posting_date = $4::date then 'opening'
              when posting_date >= $1::date and posting_date <= $2::date and posting_date <> $4::date then 'period'
              else 'other'
            end as source_bucket,
            count(*) over()::int as total_count
      from journal
     where status = 'Posted'
        and ${notVirtualAccountSql()}
        and posting_date <= $2::date
        and regexp_replace(coalesce(account_code, root_account_code, ''), '^0+', '') = $3
        ${analyticFilter}
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
      accountAnalytic: groupByAnalytic ? accountAnalytic : "",
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
      detail: `Các tài khoản 621/622/627 còn số dư ròng ${Number(context.unallocatedProductionCosts).toLocaleString("vi-VN")}. B01 đã phản ánh vào kết quả chưa kết chuyển để giữ đúng phương trình kế toán; B02 chỉ được coi là hoàn tất sau khi kế toán rà soát phân bổ giá thành.`,
    });
  }
  if (Number(context.interestReceiptReviewCount || 0) > 0) {
    validations.push({
      severity: "warning",
      title: "Rà soát lãi tiền gửi B03",
      detail: `${Number(context.interestReceiptReviewCount).toLocaleString("vi-VN")} khoản thu đối ứng 515111 đang được phân loại vào B03 mã 27 theo quy tắc doanh nghiệp. Cần chuyển lãi tiền gửi không kỳ hạn sang mã 01 nếu có.`,
    });
  }
  validations.push({
    severity: "info",
    title: "B09 cần hoàn thiện thủ công",
    detail: "B09 hiện là bản thuyết minh hỗ trợ từ số liệu sổ cái; các chính sách kế toán, cam kết, bên liên quan, kỳ hạn và thuyết minh định tính phải được người lập báo cáo bổ sung trước khi phát hành.",
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
  const currentUnclosedResult = await queryUnclosedTemporaryResult(client, endDate);
  const priorUnclosedResult = await queryUnclosedTemporaryResult(client, openingBalanceDate);
  const currentPeriodAgg = await queryPeriodAggregates(client, startDate, endDate);
  const priorPeriodAgg = await queryPeriodAggregates(client, priorStartDate, priorEndDate);
  const currentYtdPeriodAgg = await queryPeriodAggregates(client, currentYearStartDate, endDate);
  const priorYtdPeriodAgg = await queryPeriodAggregates(client, priorYearStartDate, priorEndDate);
  const currentProfitTransferred = await queryProfitTransferredTo421(client, currentYearStartDate, endDate);
  const priorProfitTransferred = await queryProfitTransferredTo421(client, priorYearStartDate, priorEndDate);
  const currentCashMovements = await queryCashMovements(client, startDate, endDate);
  const priorCashMovements = await queryCashMovements(client, priorStartDate, priorEndDate);
  const currentCount = await countRows(client, startDate, endDate);
  const priorCount = await countRows(client, priorStartDate, priorEndDate);
  const currentB03OpeningAgg = await queryBalanceAggregates(client, currentB03OpeningDate);
  const priorB03OpeningAgg = await queryBalanceAggregates(client, priorB03OpeningDate);

  const B01 = buildLineReport(b01Lines, currentBalanceAgg, priorBalanceAgg, "balance");
  const B02 = buildLineReport(b02Lines, currentPeriodAgg, priorPeriodAgg, "period");
  const ytdB02 = buildLineReport(b02Lines, currentYtdPeriodAgg, priorYtdPeriodAgg, "period");
  const unclosedProfit = applyUnclosedProfitFromYtdB02ToB01(B01, ytdB02, currentUnclosedResult, priorUnclosedResult);
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
    }),
    counts: {
      currentRows: currentCount,
      priorRows: priorCount,
      balanceAccounts: currentBalanceAgg.length,
      openingBalanceAccounts: priorBalanceAgg.length,
      priorBalanceAccounts: priorBalanceAgg.length,
      periodAccounts: currentPeriodAgg.length,
      priorPeriodAccounts: priorPeriodAgg.length,
      ytdPeriodAccounts: currentYtdPeriodAgg.length,
      priorYtdPeriodAccounts: priorYtdPeriodAgg.length,
      unclosedProfitAdjustment: Math.round(unclosedProfit.currentAdjustment),
      priorUnclosedProfitAdjustment: Math.round(unclosedProfit.priorAdjustment),
      ytdB02Profit: Math.round(unclosedProfit.currentYtdProfit),
      priorYtdB02Profit: Math.round(unclosedProfit.priorYtdProfit),
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
  const { startDate, endDate, accountCode, accountAnalytic, groupByAnalytic } = req.body || {};
  const page = Math.max(1, Number(req.body?.page || 1));
  const pageSize = Math.min(1000, Math.max(50, Number(req.body?.pageSize || 500)));
  try {
    validateDate(startDate, "startDate");
    validateDate(endDate, "endDate");
    const client = await pool.connect();
    try {
      await assertJournalSchema(client);
      res.json(await queryTrialBalanceRawSource(client, { startDate, endDate, accountCode, accountAnalytic, groupByAnalytic, page, pageSize }));
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
      if (report === "B03") {
        const movements = await queryCashMovements(client, startDate, endDate);
        rows = movements
          .filter((movement) => (code ? movement.matched_code === code : !movement.matched_code))
          .map((movement) => ({
            journalId: movement.journal_id,
            journalNum: movement.journal_num,
            postingDate: movement.posting_date,
            accountCode: movement.account_code,
            accountName: movement.account_name,
            amount: Number(movement.amount || 0),
            oppositeAccounts: movement.opposite_accounts || [],
            sourceNum: movement.source_num,
            matchedCode: movement.matched_code,
            reason: movement.reason,
          }));
      }
      const total = rows.length;
      const start = (page - 1) * pageSize;
      res.json({ rows: rows.slice(start, start + pageSize), total, page, pageSize });
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
  });
}

module.exports = {
  app,
  buildB03,
  buildLineReport,
  generateCompactReports,
  periodOpeningBalanceDate,
};
