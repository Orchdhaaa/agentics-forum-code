// Social room + Group room API for agentics.forum (moved from agent.viralitycoin.world 2026-11-01).
// Lounge reads are public. Crews are private: no public listing,
// crew reads require membership, and joining is only via invite
// link/code. Writes require an ACTIVE BAW session (via /api/pair)
// plus an on-chain .ai Agent ID (SPACE ID registry handleOf).
// Identity is always the session's verified address; handles resolve
// server-side through BSC RPC, never from client input.
// Storage: JSON file in the backend dir (not web-served), writes serialized.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const photos = require("./photos");
const referrals = require("./referrals");
const bluetick = require("./blue-tick");

const DATA_FILE = process.env.SOCIAL_DATA || path.join(__dirname, "social.json");
const RPC_URL = process.env.BSC_RPC || "https://bsc-dataseed.binance.org";
const REGISTRY = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";
const REGISTRY_ABI = ["function handleOf(address) view returns (string)"];
// Text/photo limits are per-author (Blue Tick raises them); see blue-tick.js.
const MAX_NAME = 40;
const MAX_DESC = 200;
const COOLDOWN_MS = 5000;
const MODERATOR_ADDRESS = (process.env.MODERATOR_ADDRESS || "").toLowerCase();
const MAX_REASON = 200;
function isModerator(address) {
  return !!MODERATOR_ADDRESS && !!address && address.toLowerCase() === MODERATOR_ADDRESS;
}

let data = {
  messages: [],
  groups: [],
  memberships: [],
  nextGroupId: 1,
  nextMsgId: 1,
  handles: {},
  likes: [],
  follows: [],
  comments: [],
  reposts: [],
  reports: [],
  nextCommentId: 1,
  legacyIds: {},
};
try {
  if (fs.existsSync(DATA_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    data = { ...data, ...loaded };
  }
} catch (e) {
  /* start fresh */
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// Post IDs are random 16-digit numbers (X-style), never sequential, so
// post URLs are not enumerable. Under 2^53, safe for JSON numbers.
function genMsgId() {
  let id;
  do {
    id = 1000000000000000 + Math.floor(Math.random() * 8000000000000000);
  } while (data.messages.some((m) => m.id === id));
  return id;
}
function genCode() {
  const buf = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_CHARS[buf[i] % CODE_CHARS.length];
  return s;
}
function genUniqueCode() {
  let c;
  do {
    c = genCode();
  } while (data.groups.some((g) => g.inviteCode === c));
  return c;
}
function ensureCodes() {
  let changed = false;
  for (const g of data.groups) {
    if (!g.inviteCode) {
      g.inviteCode = genUniqueCode();
      changed = true;
    }
  }
  if (changed) save();
}
ensureCodes();

let writeQueue = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(data);
  writeQueue = writeQueue
    .then(() => fs.promises.writeFile(DATA_FILE + ".tmp", snapshot))
    .then(() => fs.promises.rename(DATA_FILE + ".tmp", DATA_FILE))
    .catch(() => {});
  return writeQueue;
}

const lastPostAt = new Map(); // address -> timestamp
let provider = null;
function rpc() {
  if (!provider) provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  return provider;
}
async function resolveHandle(address) {
  if (data.handles[address]) return data.handles[address];
  try {
    const reg = new ethers.Contract(REGISTRY, REGISTRY_ABI, rpc());
    const handle = await reg.handleOf(address);
    if (handle) {
      data.handles[address] = handle;
      save();
      return handle;
    }
  } catch (e) {
    /* RPC hiccup: treat as no handle this time */
  }
  return null;
}

// sessions: the pairing backend's Map (sessionId -> session)
const { activeSession } = require("./session-check");

function authedSession(sessions, sessionId) {
  // Enforces ACTIVE + address + not past expireAt (see session-check.js).
  return activeSession(sessions, sessionId);
}

function likeCountOf(id) {
  return data.likes.filter((l) => l.messageId === id).length;
}
function commentCountOf(id) {
  return data.comments.filter((c) => c.postId === id).length;
}
function repostCountOf(id) {
  return data.reposts.filter((r) => r.messageId === id).length;
}
// Idempotent follow: adds the record only when it is not already there.
// Never toggles: an auto-follow must not re-follow a user who unfollowed.
function ensureFollow(follower, following) {
  const fl = follower.toLowerCase();
  const fo = following.toLowerCase();
  if (
    data.follows.some(
      (f) =>
        f.follower.toLowerCase() === fl && f.following.toLowerCase() === fo
    )
  )
    return false;
  data.follows.push({ follower, following });
  return true;
}
function publicMsg(m) {
  return {
    id: m.id,
    address: m.address,
    handle: m.handle,
    verified: bluetick.isVerifiedAddress(m.address),
    text: m.text,
    image: m.image || null,
    images: m.images || (m.image ? [m.image] : []),
    editedAt: m.editedAt || null,
    ts: m.ts,
    likeCount: likeCountOf(m.id),
    commentCount: commentCountOf(m.id),
    repostCount: repostCountOf(m.id),
  };
}
function publicComment(c) {
  return {
    id: c.id,
    postId: c.postId,
    address: c.address,
    handle: c.handle,
    verified: bluetick.isVerifiedAddress(c.address),
    text: c.text,
    ts: c.ts,
  };
}
// Resolve a message id, including legacy pre-migration ids.
function findMessage(id) {
  let m = data.messages.find((x) => x.id === id);
  if (m) return m;
  const nid = data.legacyIds && data.legacyIds[id];
  if (nid) return data.messages.find((x) => x.id === nid) || null;
  return null;
}

// Delete a Lounge post and everything attached to it: comments, likes,
// reposts, open reports, and its photo file + record when it has one.
// Group messages are never deleted through this path.
async function deletePostCascade(msg) {
  data.messages = data.messages.filter((m) => m.id !== msg.id);
  data.comments = data.comments.filter((c) => c.postId !== msg.id);
  data.likes = data.likes.filter((l) => l.messageId !== msg.id);
  data.reposts = data.reposts.filter((r) => r.messageId !== msg.id);
  data.reports = data.reports.filter((r) => r.postId !== msg.id);
  const imgs =
    msg.images && msg.images.length ? msg.images : msg.image ? [msg.image] : [];
  for (const im of imgs) {
    if (im && im.photoId) await photos.removePhoto(im.photoId);
  }
}

module.exports = function registerSocial(app, sessions) {
  // One-time migration: legacy sequential message ids (< 1e15) become
  // random 16-digit post ids (Twitter-style). Old ids stay resolvable
  // via data.legacyIds, so old links load and canonicalize to the new
  // id. Persisted synchronously before serving, so a crash cannot
  // leave served ids unpersisted; later boots are a no-op.
  if (!data.legacyIds) data.legacyIds = {};
  let migrated = false;
  for (const m of data.messages) {
    if (m.id < 1000000000000000) {
      const oldId = m.id;
      const newId = genMsgId();
      data.legacyIds[oldId] = newId;
      for (const l of data.likes) if (l.messageId === oldId) l.messageId = newId;
      for (const r of data.reposts) if (r.messageId === oldId) r.messageId = newId;
      for (const c of data.comments) if (c.postId === oldId) c.postId = newId;
      m.id = newId;
      migrated = true;
    }
  }
  if (migrated) {
    try {
      fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(data));
      fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
    } catch (e) { /* next boot retries; in-memory data is already migrated */ }
  }
  app.get("/api/social/messages", (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const list = data.messages.filter((m) => m.room === "social").slice(-limit);
    res.json({ messages: list.map(publicMsg) });
  });

  // Mixed Lounge feed: all public posts, plus repost items from accounts
  // the viewer follows (and their own reposts). Unpaired viewers get posts
  // only. Repost items render with a "handle reposted" header and, for
  // quote reposts, the quoter's text above the embedded original.
  app.post("/api/social/feed", (req, res) => {
    const { session } = activeSession(
      sessions,
      req.body && req.body.sessionId
    );
    const viewer = session ? session.address : null;
    const following = new Set();
    if (viewer) {
      data.follows.forEach((f) => {
        if (f.follower === viewer) following.add(f.following.toLowerCase());
      });
    }
    const items = data.messages
      .filter((m) => m.room === "social")
      .slice(-50)
      .map((m) => ({ kind: "post", ...publicMsg(m) }));
    if (viewer) {
      const vl = viewer.toLowerCase();
      data.reposts.forEach((r) => {
        const rl = r.address.toLowerCase();
        if (rl !== vl && !following.has(rl)) return;
        const orig = data.messages.find((m) => m.id === r.messageId);
        if (!orig || orig.room !== "social") return;
        items.push({
          kind: "repost",
          reposterAddress: r.address,
          reposterHandle: r.handle || data.handles[r.address] || null,
          reposterVerified: bluetick.isVerifiedAddress(r.address),
          quote: r.text || null,
          ts: r.ts,
          message: publicMsg(orig),
        });
      });
    }
    items.sort((a, b) => b.ts - a.ts);
    res.json({ items: items.slice(0, 50) });
  });

  app.get("/api/social/messages/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const m = findMessage(id);
    if (!m || m.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    res.json(publicMsg(m));
  });

  app.get("/api/social/messages/:id/comments", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const m = findMessage(id);
    if (!m || m.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    const list = data.comments.filter((c) => c.postId === m.id);
    res.json({ comments: list.map(publicComment) });
  });

  app.post("/api/social/messages", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const text =
      typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "invalid_text" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (text.length > await bluetick.maxTextForAddress(session.address))
      return res.status(400).json({ error: "invalid_text" });
    // Photos: photoIds (array) or legacy photoId (single string).
    // Blue Tick raises the per-post limit (5 vs 2).
    let photoIds = [];
    if (Array.isArray(req.body.photoIds)) {
      photoIds = req.body.photoIds
        .filter((x) => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean);
    } else if (
      typeof req.body.photoId === "string" &&
      req.body.photoId.trim()
    ) {
      photoIds = [req.body.photoId.trim()];
    }
    photoIds = [...new Set(photoIds)];
    if (photoIds.length > await bluetick.maxPhotosForAddress(session.address))
      return res.status(400).json({ error: "too_many_photos" });
    const photoObjs = [];
    for (const pid of photoIds) {
      const p = photos.getPhoto(pid);
      if (!p) return res.status(400).json({ error: "invalid_photo" });
      if (p.owner !== session.address)
        return res.status(403).json({ error: "not_photo_owner" });
      if (p.usedBy) return res.status(409).json({ error: "photo_used" });
      photoObjs.push(p);
    }
    const now = Date.now();
    if (now - (lastPostAt.get(session.address) || 0) < COOLDOWN_MS) {
      return res.status(429).json({ error: "too_fast" });
    }
    lastPostAt.set(session.address, now);
    const images = photoObjs.map((p) => ({
      photoId: p.id,
      url: p.url,
      width: p.width,
      height: p.height,
    }));
    const msg = {
      id: genMsgId(),
      room: "social",
      groupId: null,
      address: session.address,
      handle,
      text,
      image: images[0] || null,
      images,
      ts: now,
    };
    data.messages.push(msg);
    for (const p of photoObjs) await photos.markUsed(p.id, msg.id);
    await save();
    res.json({ message: publicMsg(msg) });
  });

  // ---- Moderation (Lounge posts only) ----
  // Delete own post, report any post, moderator deletes any post and
  // reviews open reports. The moderator is a single address configured
  // on the server via MODERATOR_ADDRESS (never client input).
  app.post("/api/social/messages/:id/delete", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const msgId = parseInt(req.params.id, 10);
    const msg = data.messages.find((m) => m.id === msgId);
    if (!msg || msg.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (msg.address.toLowerCase() !== session.address.toLowerCase())
      return res.status(403).json({ error: "not_author" });
    await deletePostCascade(msg);
    await save();
    res.json({ ok: true, deleted: msgId });
  });

  // Edit own Lounge post (Blue Tick feature): author only, must be
  // currently verified. No edit history in v1; the post carries an
  // editedAt timestamp the frontend renders as an "Edited" label.
  app.post("/api/social/messages/:id/edit", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const msgId = parseInt(req.params.id, 10);
    const msg = data.messages.find((m) => m.id === msgId);
    if (!msg || msg.room !== "social")
      return res.status(404).json({ error: "not_found" });
    if (msg.address.toLowerCase() !== session.address.toLowerCase())
      return res.status(403).json({ error: "not_author" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (!(await bluetick.verifyAddress(session.address)).verified)
      return res.status(403).json({ error: "not_verified" });
    const text =
      typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "invalid_text" });
    if (text.length > bluetick.MAX_TEXT_VERIFIED)
      return res.status(400).json({ error: "text_too_long" });
    msg.text = text;
    msg.editedAt = Date.now();
    await save();
    res.json({ message: publicMsg(msg) });
  });

  app.post("/api/social/messages/:id/report", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const msgId = parseInt(req.params.id, 10);
    const msg = data.messages.find((m) => m.id === msgId);
    if (!msg || msg.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const reason =
      typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    if (reason.length > MAX_REASON)
      return res.status(400).json({ error: "invalid_reason" });
    if (
      data.reports.some(
        (r) => r.postId === msgId && r.reporter === session.address
      )
    )
      return res.status(409).json({ error: "already_reported" });
    const report = {
      id: crypto.randomBytes(8).toString("hex"),
      postId: msgId,
      reporter: session.address,
      reporterHandle: handle,
      reason,
      ts: Date.now(),
    };
    data.reports.push(report);
    await save();
    res.json({ ok: true, report });
  });

  app.post("/api/social/reports", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (!isModerator(session.address))
      return res.status(403).json({ error: "not_moderator" });
    const list = [];
    for (const r of data.reports) {
      const post = data.messages.find((m) => m.id === r.postId);
      if (!post || post.room !== "social") continue;
      list.push({
        id: r.id,
        postId: r.postId,
        postText: post.text,
        postImage: post.image ? post.image.url : null,
        postAuthor: post.address,
        postHandle: post.handle,
        reporter: r.reporter,
        reporterHandle: r.reporterHandle,
        reason: r.reason,
        ts: r.ts,
      });
    }
    res.json({ reports: list });
  });

  app.post("/api/social/reports/:id/resolve", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (!isModerator(session.address))
      return res.status(403).json({ error: "not_moderator" });
    const idx = data.reports.findIndex((r) => r.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: "report_not_found" });
    data.reports.splice(idx, 1);
    await save();
    res.json({ ok: true });
  });

  app.post("/api/social/messages/:id/moderate-delete", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const msgId = parseInt(req.params.id, 10);
    const msg = data.messages.find((m) => m.id === msgId);
    if (!msg || msg.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (!isModerator(session.address))
      return res.status(403).json({ error: "not_moderator" });
    await deletePostCascade(msg);
    await save();
    res.json({ ok: true, deleted: msgId });
  });

  // ---- Referrals ----
  // The referrer comes from the ?ref= link (resolved on-chain by the
  // frontend); the backend records it once (first-applied wins) and
  // creates the auto-follow immediately. The bonus (+1 paid allocation)
  // is NOT counted here: it accrues only on the invitee's first paid
  // mint, which is enforced at mint time once contracts deploy.
  app.post("/api/social/referral", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const referrer =
      typeof req.body.referrer === "string" ? req.body.referrer.trim() : "";
    if (!ethers.utils.isAddress(referrer))
      return res.status(400).json({ error: "invalid_referrer" });
    if (referrer.toLowerCase() === session.address.toLowerCase())
      return res.status(400).json({ error: "self_referral" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const referrerHandle = await resolveHandle(referrer);
    if (!referrerHandle)
      return res.status(403).json({ error: "referrer_agent_id_required" });
    const { record, created } = await referrals.recordReferral(
      session.address,
      referrer
    );
    let followed = false;
    if (created) followed = ensureFollow(session.address, referrer);
    await save();
    res.json({
      ok: true,
      referrer: record.referrer,
      alreadyRecorded: !created,
      followed,
    });
  });

  app.post("/api/social/referral/mine", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const rec = referrals.getReferral(session.address);
    res.json({
      referrer: rec ? rec.referrer : null,
      successfulCount: referrals.countSuccessful(session.address),
    });
  });

  app.post("/api/social/groups", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const name =
      typeof req.body.name === "string" ? req.body.name.trim() : "";
    const description =
      typeof req.body.description === "string"
        ? req.body.description.trim()
        : "";
    if (!name || name.length > MAX_NAME || description.length > MAX_DESC) {
      return res.status(400).json({ error: "invalid_group" });
    }
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const group = {
      id: data.nextGroupId++,
      name,
      description,
      creator: session.address,
      createdAt: Date.now(),
      inviteCode: genUniqueCode(),
    };
    data.groups.push(group);
    data.memberships.push({ groupId: group.id, address: session.address });
    await save();
    res.json({ group: { ...group, memberCount: 1 } });
  });

  app.post("/api/social/groups/:id/read", (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const groupId = parseInt(req.params.id, 10);
    if (!data.groups.some((g) => g.id === groupId))
      return res.status(404).json({ error: "group_not_found" });
    if (
      !data.memberships.some(
        (m) => m.groupId === groupId && m.address === session.address
      )
    ) {
      return res.status(403).json({ error: "not_member" });
    }
    const limit = Math.min(100, Math.max(1, parseInt(req.body.limit, 10) || 50));
    const list = data.messages
      .filter((m) => m.groupId === groupId)
      .slice(-limit);
    res.json({ messages: list.map(publicMsg) });
  });

  app.post("/api/social/groups/:id/messages", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const groupId = parseInt(req.params.id, 10);
    const group = data.groups.find((g) => g.id === groupId);
    if (!group) return res.status(404).json({ error: "group_not_found" });
    const text =
      typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "invalid_text" });
    if (
      !data.memberships.some(
        (m) => m.groupId === groupId && m.address === session.address
      )
    ) {
      return res.status(403).json({ error: "not_member" });
    }
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (text.length > await bluetick.maxTextForAddress(session.address))
      return res.status(400).json({ error: "invalid_text" });
    const now = Date.now();
    if (now - (lastPostAt.get(session.address) || 0) < COOLDOWN_MS) {
      return res.status(429).json({ error: "too_fast" });
    }
    lastPostAt.set(session.address, now);
    const msg = {
      id: genMsgId(),
      room: "group",
      groupId,
      address: session.address,
      handle,
      text,
      ts: now,
    };
    data.messages.push(msg);
    await save();
    res.json({ message: publicMsg(msg) });
  });

  app.post("/api/social/messages/:id/like", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const msgId = parseInt(req.params.id, 10);
    const msg = data.messages.find((m) => m.id === msgId);
    if (!msg) return res.status(404).json({ error: "message_not_found" });
    if (
      msg.room === "group" &&
      !data.memberships.some(
        (m) => m.groupId === msg.groupId && m.address === session.address
      )
    ) {
      return res.status(403).json({ error: "not_member" });
    }
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const idx = data.likes.findIndex(
      (l) => l.messageId === msgId && l.address === session.address
    );
    let liked;
    if (idx >= 0) {
      data.likes.splice(idx, 1);
      liked = false;
    } else {
      data.likes.push({ messageId: msgId, address: session.address });
      liked = true;
    }
    await save();
    res.json({ liked, likeCount: likeCountOf(msgId) });
  });

  app.post("/api/social/liked", (req, res) => {
    const { session: s } = activeSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (!s || !s.address) return res.json({ likedIds: [] });
    const ids = Array.isArray(req.body.ids)
      ? req.body.ids
          .map((x) => parseInt(x, 10))
          .filter((x) => !isNaN(x))
          .slice(0, 100)
      : [];
    const likedIds = data.likes
      .filter((l) => l.address === s.address && ids.includes(l.messageId))
      .map((l) => l.messageId);
    res.json({ likedIds });
  });

  app.post("/api/social/follow", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const target =
      typeof req.body.target === "string" ? req.body.target.trim() : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(target))
      return res.status(400).json({ error: "invalid_target" });
    if (target.toLowerCase() === session.address.toLowerCase())
      return res.status(400).json({ error: "cannot_follow_self" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const idx = data.follows.findIndex(
      (f) =>
        f.follower === session.address &&
        f.following.toLowerCase() === target.toLowerCase()
    );
    let following;
    if (idx >= 0) {
      data.follows.splice(idx, 1);
      following = false;
    } else {
      data.follows.push({ follower: session.address, following: target });
      following = true;
    }
    await save();
    res.json({
      following,
      followersCount: data.follows.filter(
        (f) => f.following.toLowerCase() === target.toLowerCase()
      ).length,
    });
  });

  app.post("/api/social/profile", async (req, res) => {
    const addr =
      typeof req.body.address === "string" ? req.body.address.trim() : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
      return res.status(400).json({ error: "invalid_address" });
    const lower = addr.toLowerCase();
    const handle = data.handles[addr] || (await resolveHandle(addr));
    const { session: viewer } = activeSession(sessions, req.body.sessionId);
    const viewerAddr = viewer && viewer.address ? viewer.address : null;
    const likesReceived = data.messages
      .filter((m) => m.address.toLowerCase() === lower && m.room === "social")
      .reduce((sum, m) => sum + likeCountOf(m.id), 0);
    res.json({
      address: addr,
      handle: handle || null,
      verified: bluetick.isVerifiedAddress(addr),
      followingCount: data.follows.filter(
        (f) => f.follower.toLowerCase() === lower
      ).length,
      followersCount: data.follows.filter(
        (f) => f.following.toLowerCase() === lower
      ).length,
      likesReceived,
      postsCount: data.messages.filter(
        (m) => m.address.toLowerCase() === lower && m.room === "social"
      ).length,
      following: viewerAddr
        ? data.follows.some(
            (f) =>
              f.follower === viewerAddr &&
              f.following.toLowerCase() === lower
          )
        : false,
    });
  });

  app.get("/api/social/profile/:address/posts", (req, res) => {
    const addr = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
      return res.status(400).json({ error: "invalid_address" });
    const lower = addr.toLowerCase();
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const list = data.messages
      .filter((m) => m.address.toLowerCase() === lower && m.room === "social")
      .slice(-limit)
      .reverse();
    res.json({ messages: list.map(publicMsg) });
  });

  app.post("/api/social/my-groups", (req, res) => {
    const auth = authedSession(sessions, req.body && req.body.sessionId);
    if (auth.error) return res.status(auth.code).json({ error: auth.error });
    const addr = auth.session.address;
    const mine = data.groups.filter(
      (g) =>
        g.creator === addr ||
        data.memberships.some(
          (m) => m.groupId === g.id && m.address === addr
        )
    );
    const mapped = mine.map((g) => {
      const msgs = data.messages.filter((m) => m.groupId === g.id);
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      return {
        id: g.id,
        name: g.name,
        description: g.description,
        creator: g.creator,
        createdAt: g.createdAt,
        inviteCode: g.inviteCode || null,
        memberCount: data.memberships.filter((m) => m.groupId === g.id)
          .length,
        lastMessage: last
          ? {
              text: last.text,
              ts: last.ts,
              handle: last.handle,
              address: last.address,
            }
          : null,
      };
    });
    mapped.sort(
      (a, b) =>
        (b.lastMessage ? b.lastMessage.ts : b.createdAt) -
        (a.lastMessage ? a.lastMessage.ts : a.createdAt)
    );
    res.json({ groups: mapped });
  });

  // Crew member list: members only. Used by the crew info panel.
  // Returns every member (creator first is NOT guaranteed; the frontend
  // shows the role badge from the creator address).
  app.post("/api/social/groups/:id/members", (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const groupId = parseInt(req.params.id, 10);
    const group = data.groups.find((g) => g.id === groupId);
    if (!group) return res.status(404).json({ error: "group_not_found" });
    if (
      !data.memberships.some(
        (m) => m.groupId === groupId && m.address === session.address
      )
    ) {
      return res.status(403).json({ error: "not_member" });
    }
    const members = data.memberships
      .filter((m) => m.groupId === groupId)
      .map((m) => ({
        address: m.address,
        handle: data.handles[m.address] || null,
        verified: bluetick.isVerifiedAddress(m.address),
        role: m.address === group.creator ? "Owner" : "Member",
      }));
    res.json({ members });
  });

  app.post("/api/social/groups/join-by-code", async (req, res) => {
    const auth = authedSession(sessions, req.body && req.body.sessionId);
    if (auth.error) return res.status(auth.code).json({ error: auth.error });
    const session = auth.session;
    const raw =
      typeof req.body.code === "string" ? req.body.code.trim() : "";
    const m = raw.match(/code=([A-Za-z0-9]+)/i);
    const code = (m ? m[1] : raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const group = data.groups.find(
      (g) => g.inviteCode && g.inviteCode.toUpperCase() === code
    );
    if (!group) return res.status(404).json({ error: "crew_not_found" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (
      !data.memberships.some(
        (m) => m.groupId === group.id && m.address === session.address
      )
    ) {
      data.memberships.push({ groupId: group.id, address: session.address });
      await save();
    }
    res.json({
      group: {
        id: group.id,
        name: group.name,
        description: group.description,
        inviteCode: group.inviteCode,
        memberCount: data.memberships.filter((m) => m.groupId === group.id)
          .length,
      },
    });
  });

  app.post("/api/social/comments", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const postId = parseInt(req.body.postId, 10);
    const post = data.messages.find((m) => m.id === postId);
    if (!post || post.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    const text =
      typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "invalid_text" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (text.length > await bluetick.maxTextForAddress(session.address))
      return res.status(400).json({ error: "invalid_text" });
    const now = Date.now();
    if (now - (lastPostAt.get(session.address) || 0) < COOLDOWN_MS) {
      return res.status(429).json({ error: "too_fast" });
    }
    lastPostAt.set(session.address, now);
    const comment = {
      id: data.nextCommentId++,
      postId,
      address: session.address,
      handle,
      text,
      ts: now,
    };
    data.comments.push(comment);
    await save();
    res.json({ comment: publicComment(comment) });
  });

  app.get("/api/social/comments", (req, res) => {
    const postId = parseInt(req.query.postId, 10);
    if (isNaN(postId)) return res.status(400).json({ error: "invalid_post" });
    const list = data.comments
      .filter((c) => c.postId === postId)
      .slice(-50);
    res.json({ comments: list.map(publicComment) });
  });

  app.post("/api/social/repost", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const messageId = parseInt(req.body.messageId, 10);
    const msg = data.messages.find((m) => m.id === messageId);
    if (!msg || msg.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    const idx = data.reposts.findIndex(
      (r) => r.messageId === messageId && r.address === session.address
    );
    let reposted;
    if (idx >= 0) {
      data.reposts.splice(idx, 1);
      reposted = false;
    } else {
      data.reposts.push({
        messageId,
        address: session.address,
        ts: Date.now(),
        handle,
      });
      reposted = true;
    }
    await save();
    res.json({ reposted, repostCount: repostCountOf(messageId) });
  });

  // Quote repost: a repost carrying the quoter's own text. One record per
  // user per post: quoting an existing plain repost upgrades it (and moves
  // it to the quote time); quoting again updates the text. Same 5s
  // cooldown as posts and comments, since a quote is a feed-visible item.
  app.post("/api/social/messages/:id/quote", async (req, res) => {
    const { session, error, code } = authedSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (error) return res.status(code).json({ error });
    const messageId = parseInt(req.params.id, 10);
    const msg = data.messages.find((m) => m.id === messageId);
    if (!msg || msg.room !== "social")
      return res.status(404).json({ error: "post_not_found" });
    const text =
      typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "invalid_text" });
    const handle = await resolveHandle(session.address);
    if (!handle) return res.status(403).json({ error: "agent_id_required" });
    if (text.length > await bluetick.maxTextForAddress(session.address))
      return res.status(400).json({ error: "invalid_text" });
    const now = Date.now();
    if (now - (lastPostAt.get(session.address) || 0) < COOLDOWN_MS) {
      return res.status(429).json({ error: "too_fast" });
    }
    lastPostAt.set(session.address, now);
    const rec = data.reposts.find(
      (r) => r.messageId === messageId && r.address === session.address
    );
    if (rec) {
      rec.text = text;
      rec.ts = now;
      rec.handle = handle;
    } else {
      data.reposts.push({
        messageId,
        address: session.address,
        ts: now,
        text,
        handle,
      });
    }
    await save();
    res.json({ quoted: true, repostCount: repostCountOf(messageId) });
  });

  app.post("/api/social/reposted", (req, res) => {
    const { session: s } = activeSession(
      sessions,
      req.body && req.body.sessionId
    );
    if (!s || !s.address) return res.json({ repostedIds: [] });
    const ids = Array.isArray(req.body.ids)
      ? req.body.ids
          .map((x) => parseInt(x, 10))
          .filter((x) => !isNaN(x))
          .slice(0, 100)
      : [];
    const repostedIds = data.reposts
      .filter((r) => r.address === s.address && ids.includes(r.messageId))
      .map((r) => r.messageId);
    res.json({ repostedIds });
  });

  app.get("/api/social/profile/:address/comments", (req, res) => {
    const addr = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
      return res.status(400).json({ error: "invalid_address" });
    const lower = addr.toLowerCase();
    const list = data.comments
      .filter((c) => c.address.toLowerCase() === lower)
      .slice(-50)
      .reverse()
      .map((c) => {
        const post = data.messages.find((m) => m.id === c.postId);
        return {
          ...publicComment(c),
          post: post
            ? {
                id: post.id,
                address: post.address,
                handle: post.handle,
                verified: bluetick.isVerifiedAddress(post.address),
                text: post.text,
              }
            : null,
        };
      });
    res.json({ comments: list });
  });

  app.get("/api/social/profile/:address/reposts", (req, res) => {
    const addr = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
      return res.status(400).json({ error: "invalid_address" });
    const lower = addr.toLowerCase();
    const list = data.reposts
      .filter((r) => r.address.toLowerCase() === lower)
      .sort((a, b) => b.ts - a.ts)
      .map((r) => {
        const m = data.messages.find((x) => x.id === r.messageId);
        if (!m || m.room !== "social") return null;
        return { message: publicMsg(m), quote: r.text || null, ts: r.ts };
      })
      .filter(Boolean)
      .slice(0, 50);
    res.json({ reposts: list });
  });

  app.get("/api/social/profile/:address/likes", (req, res) => {
    const addr = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
      return res.status(400).json({ error: "invalid_address" });
    const lower = addr.toLowerCase();
    const likedIds = new Set(
      data.likes
        .filter((l) => l.address.toLowerCase() === lower)
        .map((l) => l.messageId)
    );
    const list = data.messages
      .filter((m) => likedIds.has(m.id) && m.room === "social")
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 50);
    res.json({ messages: list.map(publicMsg) });
  });

  // ---- Collection: on-chain holdings via public BSC RPC ----
  // No free no-key indexer covers BSC holdings (BscScan and Etherscan
  // V2 need a key, Blockscout BSC is unreachable), so v1 reads native
  // BNB plus balanceOf for a tracked, on-chain-verified token list,
  // and Agent ID NFTs via the registry balanceOf. Only nonzero
  // balances are returned; trackedOnly flags the partial coverage.
  const BSC_RPCS = [
    RPC_URL,
    "https://bsc-dataseed1.bnbchain.org",
    "https://bsc-dataseed2.bnbchain.org",
    "https://bsc-dataseed3.bnbchain.org",
    "https://bsc-dataseed4.bnbchain.org",
  ];
  async function bscRpc(method, params) {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 });
    for (const url of BSC_RPCS) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(5000),
        });
        const j = await r.json();
        if (j && j.result && j.result !== "0x") return j.result;
      } catch (e) { /* next mirror */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  }
  function fmtUnits(raw, decimals) {
    try {
      const v = BigInt(raw);
      const base = 10n ** BigInt(decimals);
      const whole = v / base;
      const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 6);
      return frac ? whole.toString() + "." + frac : whole.toString();
    } catch (e) { return null; }
  }
  const BALANCE_OF = "0x70a08231";
  const TRACKED_TOKENS = [
    { address: "0xbb4CdB9CBd4b0a98055Ae8aE4B7D3bC41a9e3b2e1", name: "Wrapped BNB", symbol: "WBNB", decimals: 18 },
    { address: "0x55d398326f99059fF775485246999027B3197955", name: "Tether USD", symbol: "USDT", decimals: 18 },
    { address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", name: "BUSD Token", symbol: "BUSD", decimals: 18 },
    { address: "0x8e6442663A4F8C50b6132c68d42A30E7DFE4Ae15", name: "JAGENT", symbol: "JAGENT", decimals: 18 },
    { address: "0x0810c5eb5d86d1B8D408F75Bd1f5ABeFb6d79999", name: "Initial Agent Offering", symbol: "IAO", decimals: 18 },
    { address: "0x15e47c22df42D94Fa2f0aD078Fec5Bea6453d5cF", name: "NIULAI", symbol: "NIULAI", decimals: 18 },
    { address: "0x0c876f2f7c44cde660ab77bd2022537a305e0220", name: "FIST Agent", symbol: "FAGENT", decimals: 18 },
  ];
  app.get("/api/social/profile/:address/tokens", async (req, res) => {
    const addr = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
      return res.status(400).json({ error: "invalid_address" });
    const tokens = [];
    let anyOk = false;
    const bnbRaw = await bscRpc("eth_getBalance", [addr, "latest"]);
    if (bnbRaw) {
      anyOk = true;
      const bal = fmtUnits(bnbRaw, 18);
      if (bal && bal !== "0") tokens.push({ symbol: "BNB", name: "BNB", balance: bal, contract: null });
    }
    const pad = addr.slice(2).toLowerCase().padStart(64, "0");
    for (const t of TRACKED_TOKENS) {
      const raw = await bscRpc("eth_call", [{ to: t.address, data: BALANCE_OF + pad }, "latest"]);
      if (!raw) continue;
      anyOk = true;
      const bal = fmtUnits(raw, t.decimals);
      if (bal && bal !== "0") tokens.push({ symbol: t.symbol, name: t.name, balance: bal, contract: t.address });
    }
    if (!anyOk) return res.status(502).json({ error: "collection_unavailable" });
    res.json({ tokens, trackedOnly: true });
  });
  app.get("/api/social/profile/:address/nfts", async (req, res) => {
    const addr = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
      return res.status(400).json({ error: "invalid_address" });
    const pad = addr.slice(2).toLowerCase().padStart(64, "0");
    const raw = await bscRpc("eth_call", [{ to: REGISTRY, data: BALANCE_OF + pad }, "latest"]);
    if (!raw) return res.status(502).json({ error: "collection_unavailable" });
    const count = Number(BigInt(raw));
    if (!count) return res.json({ nfts: [], more: 0 });
    let handle = null;
    for (const [k, v] of Object.entries(data.handles)) {
      if (k.toLowerCase() === addr.toLowerCase()) { handle = v; break; }
    }
    let tokenId = null;
    if (handle) {
      try { tokenId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(handle)); } catch (e) {}
    }
    const nfts = handle
      ? [{ name: handle + ".ai", tokenId, image: null }]
      : [{ name: "Agent ID NFT", tokenId: null, image: null }];
    res.json({ nfts, more: Math.max(0, count - 1) });
  });
};
// resolveHandle is also used by profiles.js: the handle is resolved
// on-chain from the session address (Agent ID registry), so the
// session address alone proves handle ownership.
module.exports.resolveHandle = resolveHandle;
