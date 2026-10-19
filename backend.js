const fs = require("fs");
const path = require("path");

const isValidGameId = (id) => !!id && /^\d{1,10}$/.test(String(id));

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const MAX_ENTRIES = 1000;
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;
const MAX_FAILURES = 3;

class PersistentCache {
  constructor({ file, ttlMs, label, onError = null }) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.label = label;
    this.onError = onError;
    this.entries = new Map();
    this.dirty = false;
    this.lastPersist = Date.now();
    this.failures = 0;
  }

  async load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(await fs.promises.readFile(this.file, "utf8"));
      for (const [key, value] of Object.entries(parsed)) this.entries.set(key, value);
      console.log(`[MMM-SteamFriends] Loaded ${this.entries.size} cached ${this.label}`);
    } catch (error) {
      console.warn(`[MMM-SteamFriends] Could not load ${this.label} cache, starting fresh:`, error.message);
      this.entries = new Map();
    }
  }

  get(key) {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key, value) {
    this.entries.set(key, { ...value, cachedAt: Date.now() });
    this.dirty = true;
    if (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value);
  }

  isStale(entry) {
    return !entry?.cachedAt || Date.now() - entry.cachedAt > this.ttlMs;
  }

  clear() {
    this.entries.clear();
  }

  async maybePersist() {
    if (this.dirty && Date.now() - this.lastPersist >= PERSIST_INTERVAL_MS) await this.save();
  }

  async save() {
    if (!this.dirty) return;
    const tempFile = this.file + ".tmp";
    try {
      await fs.promises.writeFile(tempFile, JSON.stringify(Object.fromEntries(this.entries)), "utf8");
      await fs.promises.rename(tempFile, this.file);
      this.dirty = false;
      this.lastPersist = Date.now();
      this.failures = 0;
    } catch (error) {
      console.error(`[MMM-SteamFriends] Could not save ${this.label} cache:`, error.message);
      this.failures++;
      if (this.failures >= MAX_FAILURES && this.onError) {
        this.onError("CACHE_ERROR", { filename: this.file, error: error.message, failures: this.failures });
      }
      await fs.promises.unlink(tempFile).catch(() => {});
    }
  }
}

const TOP_GAMES_DEFAULTS = { enabled: true, cycleInterval: 30000, rotateInterval: 4000, transitionSpeed: 400 };

function validate(config) {
  if (config.setup) return;

  if (!config.steamId || !/^\d{17}$/.test(config.steamId)) {
    throw new Error("Invalid steamId format. Must be 17-digit Steam ID.");
  }
  if (config.steamApiKey && !/^[0-9A-Fa-f]{32}$/.test(config.steamApiKey.trim())) {
    throw new Error("Invalid steamApiKey format. Must be a 32-character hex string.");
  }
  if (config.updateInterval < 10000) {
    throw new Error("updateInterval must be >= 10000ms to avoid API abuse");
  }
  if (config.maxFriends && (config.maxFriends < 1 || config.maxFriends > 250)) {
    throw new Error("maxFriends must be between 1 and 250");
  }
  if (config.gameScore?.enabled) {
    const { high, mid, low } = config.gameScore.thresholds || {};
    if (high && mid && low && !(high > mid && mid > low)) {
      throw new Error("gameScore thresholds must be: high > mid > low");
    }
  }
  if (config.density && !["compact", "normal", "roomy"].includes(config.density)) {
    throw new Error(`Invalid density "${config.density}". Must be "compact", "normal", or "roomy".`);
  }
  if (config.panelOpacity !== undefined && !(config.panelOpacity >= 0.3 && config.panelOpacity <= 1)) {
    throw new Error("panelOpacity must be between 0.3 and 1");
  }
  if (config.recentOffline !== undefined && !(Number.isInteger(config.recentOffline) && config.recentOffline >= 0)) {
    throw new Error("recentOffline must be a whole number >= 0");
  }
  if (config.avatarSize && !["small", "medium", "full"].includes(config.avatarSize)) {
    throw new Error(`Invalid avatarSize "${config.avatarSize}". Must be "small", "medium", or "full".`);
  }
}

function normalize(raw) {
  const config = { ...raw };
  if (config.topGames === true) config.topGames = { ...TOP_GAMES_DEFAULTS };
  return config;
}

const API = "https://api.steampowered.com";
const STORE = "https://store.steampowered.com";
const DETAIL_TIMEOUT = 8000;

class SteamClient {
  constructor(http, key) {
    this.http = http;
    this.key = key;
  }

  async friendIds(steamId) {
    const res = await this.http.get(`${API}/ISteamUser/GetFriendList/v0001/`, {
      params: { key: this.key, steamid: steamId, relationship: "friend" }
    });
    const friends = res.data?.friendslist?.friends;
    return Array.isArray(friends) ? friends.map(f => f.steamid) : null;
  }

  async players(steamIds) {
    const res = await this.http.get(`${API}/ISteamUser/GetPlayerSummaries/v0002/`, {
      params: { key: this.key, steamids: steamIds.join(",") }
    });
    const players = res.data?.response?.players;
    return Array.isArray(players) ? players : [];
  }

  async ownedGames(steamId, { withInfo = false } = {}) {
    const res = await this.http.get(`${API}/IPlayerService/GetOwnedGames/v0001/`, {
      params: {
        key: this.key,
        steamid: steamId,
        include_played_free_games: 1,
        ...(withInfo && { include_appinfo: 1 }),
        format: "json"
      },
      timeout: DETAIL_TIMEOUT
    });
    return res.data?.response;
  }

  async achievements(steamId, gameId) {
    const res = await this.http.get(`${API}/ISteamUserStats/GetPlayerAchievements/v1/`, {
      params: { key: this.key, steamid: steamId, appid: gameId },
      timeout: DETAIL_TIMEOUT
    });
    return res.data?.playerstats?.achievements;
  }

  async reviews(gameId) {
    const res = await this.http.get(`${STORE}/appreviews/${gameId}`, {
      params: { json: 1, language: "all", purchase_type: "all", num_per_page: 0 },
      timeout: DETAIL_TIMEOUT
    });
    return res.data;
  }
}

const PLATFORM_FLAGS = {
  WEB: 256,
  MOBILE: 512,
  BIG_PICTURE: 2048,
  CLIENT: 1024,
  STEAM_DECK: 8192
};

const PERSONA_STATES = ["Offline", "Online", "Busy", "Away", "Snooze", "Looking to trade", "Looking to play"];

const STATUS_ORDER = Object.fromEntries(
  ["Online", "Busy", "Away", "Snooze", "Looking to trade", "Looking to play", "Offline"].map((s, i) => [s, i])
);

function detectPlatform(flags, inGame) {
  if (!inGame) return null;
  if (flags & PLATFORM_FLAGS.WEB) return "web";
  if (flags & PLATFORM_FLAGS.MOBILE) return "mobile";
  if (flags & PLATFORM_FLAGS.BIG_PICTURE) return null;
  if (flags & PLATFORM_FLAGS.CLIENT) return (flags & PLATFORM_FLAGS.STEAM_DECK) ? "deck" : "pc";
  return "pc";
}

function toFriend(player, avatarSize) {
  const avatar = avatarSize === "small" ? player.avatar
    : avatarSize === "full" ? player.avatarfull
    : player.avatarmedium;
  return {
    id: player.steamid,
    name: player.personaname,
    avatar,
    status: PERSONA_STATES[player.personastate] || "Offline",
    inGame: !!player.gameid,
    game: player.gameextrainfo || "",
    gameId: player.gameid || null,
    country: (player.loccountrycode || "xx").toLowerCase(),
    lastLogOff: player.lastlogoff,
    platform: detectPlatform(player.personastateflags || 0, !!player.gameid)
  };
}

function compareFriends(method) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const tieBreak = method === "recentActivity" ? (a, b) => (b.lastLogOff || 0) - (a.lastLogOff || 0) || byName(a, b)
    : method === "totalPlaytime" ? (a, b) => (b.totalPlaytime || 0) - (a.totalPlaytime || 0) || byName(a, b)
    : byName;
  return (a, b) =>
    (b.inGame ? 1 : 0) - (a.inGame ? 1 : 0) ||
    (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99) ||
    tieBreak(a, b);
}

const FALLBACK_INTERVAL = 300000;
const MIN_ACTIVE_INTERVAL = 10000;
const IDLE_AFTER_FACTOR = 5;

function nextInterval({ base, errorCount, sinceChange }) {
  if (errorCount > 0) return Math.min(FALLBACK_INTERVAL, base * 2 ** (errorCount - 1));
  if (sinceChange < base * IDLE_AFTER_FACTOR) return Math.max(MIN_ACTIVE_INTERVAL, Math.floor(base * 0.5));
  return Math.min(FALLBACK_INTERVAL, base * IDLE_AFTER_FACTOR);
}

class Sessions {
  constructor() {
    this.byId = new Map();
    this.seeded = false;
  }

  apply(friends, now = Date.now()) {
    const playing = new Set();
    for (const friend of friends) {
      if (!friend.inGame) continue;
      playing.add(friend.id);
      let session = this.byId.get(friend.id);
      if (!session || session.gameId !== String(friend.gameId)) {
        session = { gameId: String(friend.gameId), since: now, started: this.seeded };
        this.byId.set(friend.id, session);
      }
      friend.since = session.since;
      friend.started = session.started;
    }
    for (const id of this.byId.keys()) if (!playing.has(id)) this.byId.delete(id);
    this.seeded = true;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 60000;
const HIGH_CONFIDENCE_REVIEWS = 1000;
const HIGH_CONFIDENCE_TTL_MS = 30 * DAY_MS;

const isAuthError = (error) => [401, 403].includes(error.response?.status);

const quiet = (label, fallback) => (error) => {
  if (!isAuthError(error)) console.warn(`[MMM-SteamFriends] ${label}:`, error.message);
  return fallback;
};

const sharedOwnedGames = (steam, withInfo) => {
  const pending = new Map();
  const view = Object.create(steam);
  view.ownedGames = (steamId) => {
    if (!pending.has(steamId)) pending.set(steamId, steam.ownedGames(steamId, { withInfo }));
    return pending.get(steamId);
  };
  return view;
};

function scoresSource(config) {
  let backoffUntil = 0;
  const minReviews = config.gameScore?.minReviews || 50;

  return {
    label: "game scores",
    file: ".game-scores-cache.json",
    enabled: Boolean(config.gameScore?.enabled),
    ttlMs: (config.gameScore?.refreshDays || 7) * DAY_MS,
    concurrency: 5,
    key: (f) => (isValidGameId(f.gameId) ? String(f.gameId) : null),
    fresh: (entry, cache) =>
      !cache.isStale(entry) ||
      (entry.reviewCount > HIGH_CONFIDENCE_REVIEWS && Date.now() - entry.cachedAt < HIGH_CONFIDENCE_TTL_MS),
    apply: (f, entry) => {
      if (!entry.invalid && entry.score !== undefined) f.gameScore = entry.score;
    },
    async fetch(steam, f) {
      if (Date.now() < backoffUntil) return undefined;
      try {
        const data = await steam.reviews(f.gameId);
        if (!data || typeof data !== "object") return undefined;
        const summary = data.query_summary;
        if (data.success === false || !summary) return { invalid: true };

        const { total_positive, total_negative, total_reviews } = summary;
        const total = total_positive + total_negative;
        if (!total_reviews || total_reviews < minReviews || total === 0) return { unrated: true };

        return {
          score: Math.round((total_positive / total) * 100),
          totalReviews: total_reviews,
          reviewCount: total_reviews,
          lastUpdated: Date.now()
        };
      } catch (error) {
        if (error.response?.status === 429) {
          console.warn("[MMM-SteamFriends] Steam review API rate limited, backing off");
          backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
          return undefined;
        }
        return error.response?.status === 404 ? { invalid: true } : undefined;
      }
    }
  };
}

function playtimeSource(config) {
  const empty = { totalPlaytime: 0, private: true, games: {} };

  return {
    label: "playtimes",
    file: ".playtime-cache.json",
    enabled: config.sortFriends === "totalPlaytime" || Boolean(config.showGamePlaytime),
    ttlMs: DAY_MS,
    concurrency: 3,
    key: (f) => (config.sortFriends === "totalPlaytime" || f.inGame ? f.id : null),
    apply: (f, entry) => {
      f.totalPlaytime = entry.totalPlaytime || 0;
      if (f.inGame && f.gameId) f.gamePlaytime = entry.games?.[String(f.gameId)] ?? (entry.private ? undefined : 0);
    },
    async fetch(steam, f) {
      try {
        const games = (await steam.ownedGames(f.id))?.games || [];
        if (games.length === 0) return empty;
        return {
          totalPlaytime: games.reduce((sum, g) => sum + (g.playtime_forever || 0), 0),
          private: false,
          games: Object.fromEntries(games.filter(g => g.playtime_forever > 0).map(g => [g.appid, g.playtime_forever]))
        };
      } catch (error) {
        quiet(`fetchPlaytime error for ${f.id}`)(error);
        return isAuthError(error) ? empty : undefined;
      }
    }
  };
}

function achievementsSource(config) {
  return {
    label: "achievements",
    file: ".achievement-cache.json",
    enabled: Boolean(config.achievementProgress?.enabled && config.showGameCapsule),
    ttlMs: (config.achievementProgress?.refreshMinutes || 10) * 60 * 1000,
    concurrency: 3,
    key: (f) => (f.inGame && isValidGameId(f.gameId) ? `${f.id}:${f.gameId}` : null),
    apply: (f, entry) => {
      if (entry.pct !== null) f.achievementPct = entry.pct;
    },
    async fetch(steam, f) {
      try {
        const list = await steam.achievements(f.id, f.gameId);
        if (!list?.length) return { pct: null };
        return { pct: Math.round((list.filter(a => a.achieved === 1).length / list.length) * 100) };
      } catch (error) {
        return quiet(`achievement fetch ${f.id}/${f.gameId}`, { pct: null })(error);
      }
    }
  };
}

function topGamesSource(config) {
  return {
    label: "top games",
    file: ".top-games-cache.json",
    appInfo: true,
    enabled: Boolean(config.topGames?.enabled && config.showGameCapsule),
    ttlMs: 12 * 60 * 60 * 1000,
    concurrency: 3,
    key: (f) => (f.inGame ? f.id : null),
    apply: (f, entry) => {
      f.topGames = entry.games || [];
    },
    async fetch(steam, f) {
      try {
        const games = (await steam.ownedGames(f.id))?.games;
        if (!Array.isArray(games)) return { games: [] };
        return {
          games: games
            .filter(g => (g.playtime_forever || 0) > 0)
            .sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0))
            .slice(0, 4)
            .map(g => ({ gameId: String(g.appid), name: g.name || "" }))
        };
      } catch (error) {
        return quiet(`fetchTopGames for ${f.id}`, { games: [] })(error);
      }
    }
  };
}

class Enrichment {
  constructor({ dir, notify }) {
    this.dir = dir;
    this.notify = notify;
    this.active = [];
  }

  async start(config) {
    await this.stop();
    const sources = [scoresSource, playtimeSource, achievementsSource, topGamesSource].map(build => build(config));
    for (const source of sources.filter(s => s.enabled)) {
      const cache = new PersistentCache({
        file: path.join(this.dir, source.file),
        ttlMs: source.ttlMs,
        label: source.label,
        onError: this.notify
      });
      await cache.load();
      this.active.push({ source, cache });
    }
  }

  async stop() {
    for (const { cache } of this.active) {
      await cache.save().catch(() => {});
      cache.clear();
    }
    this.active = [];
  }

  apply(friends) {
    const pending = [];
    for (const { source, cache } of this.active) {
      const jobs = new Map();
      for (const friend of friends) {
        const key = source.key(friend);
        if (!key) continue;

        const entry = cache.get(key);
        if (entry) {
          source.apply(friend, entry);
          if (source.fresh ? source.fresh(entry, cache) : !cache.isStale(entry)) continue;
        }
        if (!jobs.has(key)) jobs.set(key, friend);
      }
      if (jobs.size) pending.push({ source, cache, jobs });
    }
    return pending;
  }

  async refresh(pending, steam) {
    const shared = sharedOwnedGames(steam, this.active.some(a => a.source.appInfo));
    const counts = await Promise.all(pending.map(job => this.fetchJobs(job, shared)));
    return counts.some(Boolean);
  }

  async fetchJobs({ source, cache, jobs }, steam) {
    let updated = 0;
    for (const batch of chunk([...jobs], source.concurrency)) {
      const results = await Promise.allSettled(
        batch.map(async ([key, friend]) => ({ key, entry: await source.fetch(steam, friend) }))
      );
      for (const result of results) {
        if (result.status !== "fulfilled" || result.value.entry === undefined) continue;
        cache.set(result.value.key, result.value.entry);
        updated++;
      }
    }
    await cache.maybePersist();
    return updated;
  }
}

module.exports = { SteamClient, Enrichment, PersistentCache, Sessions, toFriend, compareFriends, detectPlatform, nextInterval, validate, normalize, isValidGameId, chunk };
