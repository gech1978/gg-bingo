require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const http = require("http");
const path = require("path");
const { Pool } = require("pg");
const { Server } = require("socket.io");
const { Telegraf, Markup } = require("telegraf");

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL;
const ALLOW_DEV_AUTH = process.env.ALLOW_DEV_AUTH === "true";
const REAL_MONEY_ENABLED = process.env.REAL_MONEY_ENABLED === "true";

// Hard safety guard: this starter deliberately contains no payment or cash-out code.
if (REAL_MONEY_ENABLED) {
  console.error("REAL_MONEY_ENABLED must remain false in this starter.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: true } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});
pool.on("error", err => console.error("Unexpected PostgreSQL pool error:", err.message));

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected", mode: "virtual-demo-only", realMoneyEnabled: false });
  } catch {
    res.status(503).json({ ok: false, database: "unavailable", realMoneyEnabled: false });
  }
});

function verifyTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  if (!receivedHash || !Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > maxAgeSeconds) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const a = Buffer.from(expected, "hex"), b = Buffer.from(receivedHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const u = JSON.parse(params.get("user") || "null");
    if (!u?.id) return null;
    return { telegramId: String(u.id), name: [u.first_name, u.last_name].filter(Boolean).join(" ") || "Player" };
  } catch { return null; }
}

function randomCard() {
  const cols = [];
  for (let c = 0; c < 5; c++) {
    const start = c * 15 + 1;
    const values = Array.from({ length: 15 }, (_, i) => i + start);
    // Fisher-Yates using crypto-safe random index.
    for (let i = values.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [values[i], values[j]] = [values[j], values[i]];
    }
    cols.push(values.slice(0, 5).sort((a, b) => a - b));
  }
  const card = Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => cols[c][r]));
  card[2][2] = 0;
  return card;
}
function shuffle75() {
  const nums = Array.from({ length: 75 }, (_, i) => i + 1);
  for (let i = nums.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  return nums;
}
function hasBingo(card, calledSet) {
  const marked = (r,c) => card[r][c] === 0 || calledSet.has(card[r][c]);
  for (let i=0;i<5;i++) {
    if ([0,1,2,3,4].every(c => marked(i,c))) return true;
    if ([0,1,2,3,4].every(r => marked(r,i))) return true;
  }
  if ([0,1,2,3,4].every(i => marked(i,i))) return true;
  return [0,1,2,3,4].every(i => marked(i,4-i));
}

async function ensureUser(telegramId, name) {
  const { rows } = await pool.query(
    `INSERT INTO app_users(telegram_user_id, display_name)
     VALUES ($1,$2)
     ON CONFLICT (telegram_user_id) DO UPDATE SET display_name=EXCLUDED.display_name, updated_at=now()
     RETURNING id, telegram_user_id, display_name, status`,
    [telegramId, name]
  );
  if (rows[0].status !== "active") throw new Error("This account is not allowed to join games.");
  return rows[0];
}
async function ensureRoom(roomId, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let result = await client.query("SELECT * FROM rooms WHERE id=$1 FOR UPDATE", [roomId]);
    if (!result.rowCount) {
      await client.query(
        "INSERT INTO rooms(id,title,created_by) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",
        [roomId, `Room ${roomId}`, userId]
      );
      result = await client.query("SELECT * FROM rooms WHERE id=$1 FOR UPDATE", [roomId]);
    }
    await client.query("COMMIT");
    return result.rows[0];
  } catch (e) {
    await client.query("ROLLBACK"); throw e;
  } finally { client.release(); }
}
async function currentRound(client, roomId) {
  let result = await client.query(
    "SELECT * FROM rounds WHERE room_id=$1 AND status IN ('waiting','playing') ORDER BY round_number DESC LIMIT 1 FOR UPDATE",
    [roomId]
  );
  if (result.rowCount) return result.rows[0];
  const max = await client.query("SELECT COALESCE(MAX(round_number),0)+1 AS n FROM rounds WHERE room_id=$1", [roomId]);
  result = await client.query(
    "INSERT INTO rounds(room_id,round_number,status) VALUES($1,$2,'waiting') RETURNING *",
    [roomId, Number(max.rows[0].n)]
  );
  return result.rows[0];
}
async function roomSnapshot(roomId) {
  const { rows: roomRows } = await pool.query("SELECT id,status,capacity FROM rooms WHERE id=$1", [roomId]);
  if (!roomRows.length) return null;
  const room = roomRows[0];
  const { rows: roundRows } = await pool.query(
    "SELECT id,round_number,status,started_at,finished_at FROM rounds WHERE room_id=$1 ORDER BY round_number DESC LIMIT 1",
    [roomId]
  );
  const round = roundRows[0] || null;
  if (!round) return { id: room.id, status: room.status, roundId: null, roundNumber: 0, called: [], players: [], winners: [] };
  const [called, players, winners] = await Promise.all([
    pool.query("SELECT number FROM called_numbers WHERE round_id=$1 ORDER BY draw_index", [round.id]),
    pool.query(
      `SELECT u.telegram_user_id AS id,u.display_name AS name
       FROM round_players rp JOIN app_users u ON u.id=rp.user_id WHERE rp.round_id=$1 ORDER BY rp.joined_at`,
      [round.id]
    ),
    pool.query(
      `SELECT u.telegram_user_id AS id,u.display_name AS name,rw.win_order,rw.simulated_share
       FROM round_winners rw JOIN app_users u ON u.id=rw.user_id WHERE rw.round_id=$1 ORDER BY rw.win_order`,
      [round.id]
    )
  ]);
  return {
    id: room.id, status: round.status, roundId: round.id, roundNumber: round.round_number,
    called: called.rows.map(r => r.number), players: players.rows,
    winners: winners.rows.map(w => ({ id: w.id, name: w.name, order: w.win_order, simulatedShare: Number(w.simulated_share) }))
  };
}
async function broadcastRoom(roomId) {
  const snapshot = await roomSnapshot(roomId);
  if (snapshot) io.to(roomId).emit("room:update", snapshot);
}
async function audit(client, roomId, roundId, userId, type, details = {}) {
  await client.query(
    "INSERT INTO game_audit_events(room_id,round_id,actor_user_id,event_type,details) VALUES($1,$2,$3,$4,$5::jsonb)",
    [roomId, roundId, userId || null, type, JSON.stringify(details)]
  );
}

const activeTimers = new Map();
function stopTimer(roundId) {
  const timer = activeTimers.get(roundId);
  if (timer) clearInterval(timer);
  activeTimers.delete(roundId);
}
async function drawNext(roomId, roundId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM rounds WHERE id=$1 AND room_id=$2 FOR UPDATE", [roundId, roomId]);
    if (!rows.length || rows[0].status !== "playing") {
      await client.query("COMMIT"); stopTimer(roundId); return;
    }
    const count = await client.query("SELECT COUNT(*)::int AS n FROM called_numbers WHERE round_id=$1", [roundId]);
    if (count.rows[0].n >= 75) {
      await client.query("UPDATE rounds SET status='finished',finished_at=now() WHERE id=$1", [roundId]);
      await client.query("UPDATE rooms SET status='finished',updated_at=now() WHERE id=$1", [roomId]);
      await audit(client, roomId, roundId, null, "round_finished_no_winner");
      await client.query("COMMIT"); stopTimer(roundId); await broadcastRoom(roomId); return;
    }
    const already = await client.query("SELECT number FROM called_numbers WHERE round_id=$1", [roundId]);
    const used = new Set(already.rows.map(r => r.number));
    const remaining = Array.from({length:75},(_,i)=>i+1).filter(n=>!used.has(n));
    const number = remaining[crypto.randomInt(remaining.length)];
    const index = count.rows[0].n + 1;
    await client.query("INSERT INTO called_numbers(round_id,draw_index,number) VALUES($1,$2,$3)", [roundId,index,number]);
    await audit(client, roomId, roundId, null, "number_called", { index, number });
    await client.query("COMMIT");
    io.to(roomId).emit("number:called", number);
    await broadcastRoom(roomId);
  } catch (e) {
    await client.query("ROLLBACK").catch(()=>{});
    console.error("draw error:", e.message);
  } finally { client.release(); }
}
function startDrawTimer(roomId, roundId) {
  if (activeTimers.has(roundId)) return;
  const timer = setInterval(() => drawNext(roomId, roundId), 3500);
  activeTimers.set(roundId, timer);
}

io.use(async (socket, next) => {
  try {
    const verified = verifyTelegramInitData(socket.handshake.auth?.initData, BOT_TOKEN);
    let identity = verified;
    if (!identity && ALLOW_DEV_AUTH) {
      identity = {
        telegramId: String(socket.handshake.auth?.devId || `demo-${crypto.randomUUID()}`),
        name: String(socket.handshake.auth?.devName || "Demo Player").slice(0,40)
      };
    }
    if (!identity) return next(new Error("Open this game from Telegram to verify your account."));
    socket.user = await ensureUser(identity.telegramId, identity.name);
    next();
  } catch (e) { next(new Error(e.message || "Authentication failed")); }
});

io.on("connection", socket => {
  socket.on("room:join", async ({ roomId } = {}) => {
    const id = String(roomId || "lobby").replace(/[^a-zA-Z0-9_-]/g, "").slice(0,24) || "lobby";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO rooms(id,title,created_by) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",
        [id, `Room ${id}`, socket.user.id]
      );
      const { rows: roomRows } = await client.query("SELECT * FROM rooms WHERE id=$1 FOR UPDATE", [id]);
      const room = roomRows[0];
      const round = await currentRound(client, id);
      if (round.status !== "waiting") {
        await client.query("ROLLBACK");
        socket.emit("app:error", "This room's round is already in progress. Join another room.");
        return;
      }
      const count = await client.query("SELECT COUNT(*)::int AS n FROM round_players WHERE round_id=$1", [round.id]);
      const existing = await client.query("SELECT card FROM round_players WHERE round_id=$1 AND user_id=$2", [round.id,socket.user.id]);
      if (!existing.rowCount && count.rows[0].n >= room.capacity) {
        await client.query("ROLLBACK"); socket.emit("app:error", "This room is full."); return;
      }
      const card = existing.rowCount ? existing.rows[0].card : randomCard();
      await client.query(
        "INSERT INTO round_players(round_id,user_id,card) VALUES($1,$2,$3::jsonb) ON CONFLICT(round_id,user_id) DO NOTHING",
        [round.id,socket.user.id,JSON.stringify(card)]
      );
      await audit(client,id,round.id,socket.user.id,"player_joined",{});
      await client.query("COMMIT");
      for (const old of socket.rooms) if (old !== socket.id) socket.leave(old);
      socket.join(id); socket.data.roomId=id; socket.data.roundId=round.id;
      socket.emit("card:deal", card);
      socket.emit("room:joined", id);
      await broadcastRoom(id);
    } catch (e) {
      await client.query("ROLLBACK").catch(()=>{});
      console.error("join error:",e.message); socket.emit("app:error","Could not join room.");
    } finally { client.release(); }
  });

  socket.on("game:start", async () => {
    const roomId=socket.data.roomId, roundId=socket.data.roundId;
    if (!roomId || !roundId) return socket.emit("app:error","Join a room first.");
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      const {rows}=await client.query("SELECT * FROM rounds WHERE id=$1 AND room_id=$2 FOR UPDATE",[roundId,roomId]);
      if (!rows.length || rows[0].status!=="waiting") {
        await client.query("ROLLBACK"); return socket.emit("app:error","This round has already started.");
      }
      const count=await client.query("SELECT COUNT(*)::int AS n FROM round_players WHERE round_id=$1",[roundId]);
      if (count.rows[0].n<1) { await client.query("ROLLBACK"); return socket.emit("app:error","At least one player is needed."); }
      await client.query("UPDATE rounds SET status='playing',started_at=now() WHERE id=$1",[roundId]);
      await client.query("UPDATE rooms SET status='playing',updated_at=now() WHERE id=$1",[roomId]);
      await audit(client,roomId,roundId,socket.user.id,"round_started",{});
      await client.query("COMMIT");
      await broadcastRoom(roomId); startDrawTimer(roomId,roundId);
    } catch(e) {
      await client.query("ROLLBACK").catch(()=>{}); console.error("start error:",e.message);
      socket.emit("app:error","Could not start round.");
    } finally { client.release(); }
  });

  socket.on("bingo:claim", async () => {
    const roomId=socket.data.roomId, roundId=socket.data.roundId;
    if (!roomId || !roundId) return socket.emit("app:error","Join a room first.");
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      const {rows}=await client.query("SELECT * FROM rounds WHERE id=$1 AND room_id=$2 FOR UPDATE",[roundId,roomId]);
      if (!rows.length || rows[0].status!=="playing") {
        await client.query("ROLLBACK"); return socket.emit("app:error","This round is not active.");
      }
      const player=await client.query("SELECT card FROM round_players WHERE round_id=$1 AND user_id=$2",[roundId,socket.user.id]);
      if (!player.rowCount) { await client.query("ROLLBACK"); return socket.emit("app:error","You are not in this round."); }
      const calls=await client.query("SELECT number FROM called_numbers WHERE round_id=$1 ORDER BY draw_index",[roundId]);
      const valid=hasBingo(player.rows[0].card,new Set(calls.rows.map(r=>r.number)));
      await client.query(
        "INSERT INTO bingo_claims(round_id,user_id,accepted,reason) VALUES($1,$2,$3,$4) ON CONFLICT(round_id,user_id) DO NOTHING",
        [roundId,socket.user.id,valid,valid?"valid":"no_complete_pattern"]
      );
      if (!valid) {
        await audit(client,roomId,roundId,socket.user.id,"bingo_claim_rejected",{});
        await client.query("COMMIT"); socket.emit("bingo:rejected","Not Bingo yet — keep playing!"); return;
      }
      const winnerCount=await client.query("SELECT COUNT(*)::int AS n FROM round_winners WHERE round_id=$1",[roundId]);
      await client.query(
        "INSERT INTO round_winners(round_id,user_id,win_order,simulated_share) VALUES($1,$2,$3,$4) ON CONFLICT(round_id,user_id) DO NOTHING",
        [roundId,socket.user.id,winnerCount.rows[0].n+1,0]
      );
      // This demo uses fictional points only. No money or withdrawable balance exists.
      await audit(client,roomId,roundId,socket.user.id,"valid_bingo_claim",{simulatedPoints:0});
      await client.query("COMMIT");
      socket.emit("bingo:accepted","Bingo verified! The round remains open for shared winners.");
      await broadcastRoom(roomId);
    } catch(e) {
      await client.query("ROLLBACK").catch(()=>{}); console.error("claim error:",e.message);
      socket.emit("app:error","Could not validate claim.");
    } finally { client.release(); }
  });

  socket.on("round:finish", async () => {
    // Demo moderator-free end-of-round control: any participant can finish after at least one valid winner.
    // In production, replace this with a scheduled server rule or authorized moderator action.
    const roomId=socket.data.roomId, roundId=socket.data.roundId;
    if (!roomId || !roundId) return;
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      const {rows}=await client.query("SELECT * FROM rounds WHERE id=$1 FOR UPDATE",[roundId]);
      if (!rows.length || rows[0].status!=="playing") { await client.query("ROLLBACK"); return; }
      const wins=await client.query("SELECT user_id FROM round_winners WHERE round_id=$1 ORDER BY win_order",[roundId]);
      if (!wins.rowCount) { await client.query("ROLLBACK"); return socket.emit("app:error","No verified Bingo claims yet."); }
      // Equal simulated allocation: 100 fictional points split to two decimal places.
      const share=Math.floor((100 / wins.rowCount)*100)/100;
      for (const w of wins.rows) {
        await client.query("UPDATE round_winners SET simulated_share=$3 WHERE round_id=$1 AND user_id=$2",[roundId,w.user_id,share]);
      }
      await client.query("UPDATE rounds SET status='finished',finished_at=now() WHERE id=$1",[roundId]);
      await client.query("UPDATE rooms SET status='finished',updated_at=now() WHERE id=$1",[roomId]);
      await audit(client,roomId,roundId,socket.user.id,"round_finished",{winnerCount:wins.rowCount,simulatedPool:100,simulatedShare:share});
      await client.query("COMMIT");
      stopTimer(roundId);
      const snapshot=await roomSnapshot(roomId);
      io.to(roomId).emit("game:finished",{winners:snapshot.winners,message:`Round finished: ${snapshot.winners.length} winner(s). Simulated points only.`});
      await broadcastRoom(roomId);
    } catch(e) {
      await client.query("ROLLBACK").catch(()=>{}); console.error("finish error:",e.message);
      socket.emit("app:error","Could not finish round.");
    } finally { client.release(); }
  });

  socket.on("disconnect", () => {
    // Player/card remain persisted so reconnects can resume the same round.
  });
});

if (BOT_TOKEN && MINI_APP_URL) {
  const bot = new Telegraf(BOT_TOKEN);
  bot.start(ctx => ctx.reply(
    "Welcome to Color Bingo! This is a virtual-play demo; no real-money payments or prizes are enabled.",
    Markup.inlineKeyboard([Markup.button.webApp("🎯 Play Bingo",MINI_APP_URL)])
  ));
  bot.command("play",ctx=>ctx.reply("Open Color Bingo:",Markup.inlineKeyboard([Markup.button.webApp("🎯 Play Bingo",MINI_APP_URL)])));
  bot.launch().then(()=>console.log("Telegram bot started")).catch(e=>console.error("Bot error:",e.message));
  process.once("SIGINT",()=>bot.stop("SIGINT"));
  process.once("SIGTERM",()=>bot.stop("SIGTERM"));
}

server.listen(PORT,()=>console.log(`Bingo server listening on ${PORT}; real-money features disabled`));
async function shutdown() {
  for (const id of activeTimers.keys()) stopTimer(id);
  await new Promise(resolve=>io.close(resolve));
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM",shutdown);
