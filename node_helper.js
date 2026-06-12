const NodeHelper = require("node_helper");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { networkInterfaces } = require("os");
const QRCode = require("qrcode");
const LOCAL_VERSION = require('./package.json').version;

const API = {
  FRIENDS_PER_REQUEST: 100,
  REQUEST_TIMEOUT: 10000,
  MAX_CONSECUTIVE_ERRORS: 5,
  FALLBACK_POLL_INTERVAL: 300000,
  SCORE_CONCURRENT_REQUESTS: 5,
  SCORE_REQUEST_TIMEOUT: 8000,
  PLAYTIME_CONCURRENT_REQUESTS: 3,
  PLAYTIME_REQUEST_TIMEOUT: 8000,
  ACHIEVEMENT_CONCURRENT_REQUESTS: 3,
  ACHIEVEMENT_REQUEST_TIMEOUT: 8000,
  RATE_LIMIT_BACKOFF_MS: 60000,
  ERROR_BACKOFF_INTERVAL_MS: 300000,
  MAX_CACHE_SIZE: 1000
};

const PLATFORM_FLAGS = {
  WEB: 256,
  MOBILE: 512,
  BIG_PICTURE: 2048,
  CLIENT: 1024,
  STEAM_DECK: 8192
};

function isValidGameId(gameId) {
  return gameId && /^\d{1,10}$/.test(String(gameId));
}

class PersistentCache {
  constructor(cachePath, ttlMs, label, onError = null) {
    this.cachePath = cachePath;
    this.ttlMs = ttlMs;
    this.label = label;
    this.onError = onError;
    this.cache = new Map();
    this.dirty = false;
    this.lastPersist = Date.now();
    this.persistIntervalMs = 5 * 60 * 1000;
    this.consecutiveFailures = 0;
    this.MAX_FAILURES = 3;
  }

  async load() {
    try {
      if (fs.existsSync(this.cachePath)) {
        const data = await fs.promises.readFile(this.cachePath, "utf8");
        const parsed = JSON.parse(data);
        for (const [key, value] of Object.entries(parsed)) {
          this.cache.set(key, value);
        }
        console.log(`[MMM-SteamFriends] Loaded ${this.cache.size} cached ${this.label}`);
      }
    } catch (error) {
      console.warn(`[MMM-SteamFriends] Could not load ${this.label} cache, starting fresh:`, error.message);
      this.cache = new Map();
    }
  }

  async save() {
    if (!this.dirty) return;

    const tempPath = this.cachePath + ".tmp";
    try {
      const data = Object.fromEntries(this.cache);
      await fs.promises.writeFile(tempPath, JSON.stringify(data), "utf8");
      await fs.promises.rename(tempPath, this.cachePath);
      this.dirty = false;
      this.lastPersist = Date.now();
      this.consecutiveFailures = 0;
    } catch (error) {
      console.error(`[MMM-SteamFriends] Could not save ${this.label} cache:`, error.message);
      this.consecutiveFailures++;

      if (this.consecutiveFailures >= this.MAX_FAILURES && this.onError) {
        this.onError("CACHE_ERROR", {
          filename: this.cachePath,
          error: error.message,
          failures: this.consecutiveFailures
        });
      }

      try {
        if (fs.existsSync(tempPath)) {
          await fs.promises.unlink(tempPath);
        }
      } catch (e) {
        console.warn('[MMM-SteamFriends] Failed to clean up temp file:', e.message);
      }
    }
  }

  async maybePersist() {
    if (this.dirty && Date.now() - this.lastPersist >= this.persistIntervalMs) {
      await this.save();
    }
  }

  isStale(entry) {
    if (!entry || !entry.cachedAt) return true;
    return Date.now() - entry.cachedAt > this.ttlMs;
  }

  _evictIfNeeded() {
    if (this.cache.size > API.MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }
}

class ScoresCache extends PersistentCache {
  constructor(cachePath, ttlDays = 7, onError = null) {
    super(cachePath, ttlDays * 24 * 60 * 60 * 1000, 'game scores', onError);
  }

  get(gameId) {
    if (!isValidGameId(gameId)) return null;
    return this.cache.get(String(gameId));
  }

  set(gameId, scoreData) {
    if (!isValidGameId(gameId)) return;
    this.cache.set(String(gameId), { ...scoreData, cachedAt: Date.now() });
    this.dirty = true;
    this._evictIfNeeded();
  }

  isInvalid(entry) {
    return entry && entry.invalid === true;
  }
}

class PlaytimeCache extends PersistentCache {
  constructor(cachePath, ttlHours = 24, onError = null) {
    super(cachePath, ttlHours * 60 * 60 * 1000, 'playtimes', onError);
  }

  get(steamId) {
    return this.cache.get(steamId);
  }

  set(steamId, playtimeData) {
    this.cache.set(steamId, { ...playtimeData, cachedAt: Date.now() });
    this.dirty = true;
    this._evictIfNeeded();
  }
}

class AchievementCache extends PersistentCache {
  constructor(cachePath, ttlMinutes = 10, onError = null) {
    super(cachePath, ttlMinutes * 60 * 1000, 'achievements', onError);
  }
  get(steamId, gameId) { return this.cache.get(`${steamId}:${gameId}`); }
  set(steamId, gameId, data) {
    this.cache.set(`${steamId}:${gameId}`, { ...data, cachedAt: Date.now() });
    this.dirty = true;
    this._evictIfNeeded();
  }
}

module.exports = NodeHelper.create({
  start() {
    this.config = null;
    this.setupActive = false;
    this.setupRouteRegistered = false;
    this.pollInterval = null;
    this.lastFriendsHash = null;
    this.errorCount = 0;
    this.maxErrors = API.MAX_CONSECUTIVE_ERRORS;
    this.fetchInProgress = false;
    this.scoresCache = null;
    this.scoreRateLimitBackoff = 0;
    this.playtimeCache = null;
    this.achievementCache = null;
    this.pollState = {
      baseInterval: 60000,
      currentInterval: 60000,
      lastChangeTime: Date.now(),
      changeCount: 0
    };

    this.api = axios.create({
      timeout: API.REQUEST_TIMEOUT,
      headers: {
        'Accept-Encoding': 'gzip',
        'User-Agent': 'MMM-SteamFriends/1.0'
      },
      httpAgent: new http.Agent({
        keepAlive: true,
        maxSockets: 10
      }),
      httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 10
      })
    });
  },

  async stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log("[MMM-SteamFriends] Polling stopped");
    }
    if (this.scoresCache) {
      await this.scoresCache.save();
      this.scoresCache.cache.clear();
    }
    if (this.playtimeCache) {
      await this.playtimeCache.save();
      this.playtimeCache.cache.clear();
    }
    if (this.achievementCache) {
      await this.achievementCache.save();
      this.achievementCache.cache.clear();
    }
  },

  validateConfig(config) {
    if (!config.setup) {
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

      if (config.avatarSize && !['small', 'medium', 'full'].includes(config.avatarSize)) {
        throw new Error(`Invalid avatarSize "${config.avatarSize}". Must be "small", "medium", or "full".`);
      }
    }

  },

  async generateQRCode(url) {
    try {
      const dataUrl = await QRCode.toDataURL(url, {
        width: 200,
        margin: 1,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });
      return dataUrl;
    } catch (error) {
      console.error('[MMM-SteamFriends] QR generation failed:', error);
      return null;
    }
  },

  async socketNotificationReceived(notification, payload) {
    if (notification === "INIT") {
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }

      const saved = await this.loadCredentials();
      const merged = { ...payload, ...saved };

      try {
        this.validateConfig(merged);
      } catch (error) {
        this.sendSocketNotification("CONFIG_ERROR", error.message);
        return;
      }

      this.config = merged;

      if (merged.setup && (!merged.steamApiKey || !merged.steamId)) {
        this.setupActive = true;
        if (!this.setupRouteRegistered) {
          this.registerSetupRoutes();
          this.setupRouteRegistered = true;
        }
        this.sendSocketNotification("SETUP_URL", this.detectSetupUrl());
        return;
      }

      // Credentials were loaded from credentials.json — tell the frontend
      // to drop the setup screen (its own config still has setup:true + empty creds)
      if (merged.setup && merged.steamApiKey && merged.steamId && saved.steamApiKey) {
        this.sendSocketNotification("SETUP_COMPLETE", {
          steamId: merged.steamId,
          steamApiKey: merged.steamApiKey
        });
      }

      const notify = (evt, data) => this.sendSocketNotification(evt, data);

      if (payload.gameScore && payload.gameScore.enabled) {
        const cachePath = path.join(__dirname, ".game-scores-cache.json");
        const ttlDays = payload.gameScore.refreshDays || 7;
        this.scoresCache = new ScoresCache(cachePath, ttlDays, notify);
        await this.scoresCache.load();
      }

      if (payload.sortFriends === "totalPlaytime" || payload.showGamePlaytime) {
        const cachePath = path.join(__dirname, ".playtime-cache.json");
        this.playtimeCache = new PlaytimeCache(cachePath, 24, notify);
        await this.playtimeCache.load();
      }

      if (payload.achievementProgress?.enabled && payload.showGameCapsule) {
        const cachePath = path.join(__dirname, ".achievement-cache.json");
        this.achievementCache = new AchievementCache(cachePath, payload.achievementProgress.refreshMinutes || 10, notify);
        await this.achievementCache.load();
      }

      await this.fetchFriends();
      this.schedulePoll();
      this.checkForUpdate();
    }

    if (notification === "SUSPEND") {
      if (this.pollInterval) {
        clearTimeout(this.pollInterval);
        this.pollInterval = null;
        console.log("[MMM-SteamFriends] Polling suspended");
      }
    }

    if (notification === "RESUME") {
      if (!this.pollInterval && this.config) {
        await this.fetchFriends();
        this.schedulePoll();
        console.log("[MMM-SteamFriends] Polling resumed");
      }
    }

    if (notification === "GENERATE_QR") {
      const dataUrl = await this.generateQRCode(payload.url);
      this.sendSocketNotification("QR_GENERATED", {
        id: payload.id,
        dataUrl
      });
    }
  },

  schedulePoll() {
    const base = this.config.updateInterval || 60000;
    const timeSinceChange = Date.now() - this.pollState.lastChangeTime;
    const activeThreshold = base * 5;
    this.pollState.currentInterval = timeSinceChange < activeThreshold
      ? Math.max(10000, Math.floor(base * 0.5))
      : Math.min(300000, base * 5);

    clearTimeout(this.pollInterval);
    this.pollInterval = setTimeout(() => {
      this.fetchFriends().then(() => this.schedulePoll());
    }, this.pollState.currentInterval);
  },

  getAvatarUrl(player) {
    const size = this.config.avatarSize || 'medium';
    switch (size) {
      case 'small':
        return player.avatar;           // 32x32
      case 'full':
        return player.avatarfull;       // 184x184
      case 'medium':
      default:
        return player.avatarmedium;     // 64x64
    }
  },

  async fetchFriends() {
    if (this.fetchInProgress) {
      console.log("[MMM-SteamFriends] Fetch already in progress, skipping");
      return;
    }

    this.fetchInProgress = true;

    try {
      const key = this.config.steamApiKey || process.env.STEAM_API_KEY;
      if (!key) {
        throw new Error("Steam API key not configured. Set STEAM_API_KEY environment variable.");
      }

      const friendListUrl = `https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=${key}&steamid=${this.config.steamId}&relationship=friend`;
      const friendListRes = await this.api.get(friendListUrl);

      const friendsRaw = friendListRes.data?.friendslist?.friends;
      if (!Array.isArray(friendsRaw)) {
        this.sendSocketNotification("FRIENDS_UPDATE", []);
        return;
      }
      let friendIds = friendsRaw.map(f => f.steamid);

      if (this.config.friendAllowlist && this.config.friendAllowlist.length > 0) {
        if (!this.allowlistSet) {
          this.allowlistSet = new Set(this.config.friendAllowlist);
        }
        friendIds = friendIds.filter(id => this.allowlistSet.has(id));
      }

      if (friendIds.length === 0) {
        console.log("[MMM-SteamFriends] No friends found");
        this.sendSocketNotification("FRIENDS_UPDATE", []);
        return;
      }

      const batches = this.chunkArray(friendIds, API.FRIENDS_PER_REQUEST);
      const batchPromises = batches.map(async (batch) => {
        const summariesUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${key}&steamids=${batch.join(',')}`;
        const res = await this.api.get(summariesUrl);

        const players = res.data?.response?.players;
        if (!Array.isArray(players)) return [];
        return players.map(p => ({
          id: p.steamid,
          name: p.personaname,
          avatar: this.getAvatarUrl(p),
          status: this.mapPersonaState(p.personastate),
          inGame: !!p.gameid,
          game: p.gameextrainfo || "",
          gameId: p.gameid || null,
          country: (p.loccountrycode || "xx").toLowerCase(),
          lastLogOff: p.lastlogoff,
          platform: this.detectPlatform(p.personastateflags || 0, !!p.gameid)
        }));
      });

      const batchResults = await Promise.allSettled(batchPromises);
      const allFriends = batchResults
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value);

      if ((this.config.sortFriends === "totalPlaytime" || this.config.showGamePlaytime) && this.playtimeCache) {
        await this.enrichWithPlaytime(allFriends, key);
      }

      allFriends.sort((a, b) => {
        const aInGame = a.inGame ? 1 : 0;
        const bInGame = b.inGame ? 1 : 0;
        if (aInGame !== bInGame) return bInGame - aInGame;

        const statusOrder = { "Online": 0, "Busy": 1, "Away": 2, "Snooze": 3, "Looking to trade": 4, "Looking to play": 5, "Offline": 6 };
        const aOrder = statusOrder[a.status] ?? 99;
        const bOrder = statusOrder[b.status] ?? 99;
        if (aOrder !== bOrder) return aOrder - bOrder;

        return this.sortByConfig(a, b);
      });

      if (this.config.gameScore && this.config.gameScore.enabled && this.scoresCache) {
        await this.enrichWithScores(allFriends);
      }

      if (this.config.achievementProgress?.enabled && this.config.showGameCapsule && this.achievementCache) {
        await this.enrichWithAchievements(allFriends, key);
      }

      const currentHash = this.hashData(allFriends);
      if (currentHash !== this.lastFriendsHash) {
        this.pollState.changeCount++;
        this.pollState.lastChangeTime = Date.now();
        this.lastFriendsHash = currentHash;
        this.sendSocketNotification("FRIENDS_UPDATE", allFriends);
      }

      this.errorCount = 0;

    } catch (error) {
      this.errorCount++;
      console.error(`[MMM-SteamFriends] Fetch error (${this.errorCount}/${this.maxErrors}):`, error.message);

      if (this.errorCount >= this.maxErrors) {
        console.error("[MMM-SteamFriends] Max errors reached, increasing poll interval to 5 minutes");
        if (this.pollInterval) {
          clearTimeout(this.pollInterval);
          this.pollInterval = setTimeout(
            () => this.fetchFriends().then(() => this.schedulePoll()),
            API.FALLBACK_POLL_INTERVAL
          );
        }
      }

      this.sendSocketNotification("ERROR", {
        context: 'fetchFriends',
        message: error.message,
        timestamp: Date.now()
      });
    } finally {
      this.fetchInProgress = false;
    }
  },

  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  },

  hashData(data) {
    return crypto.createHash('md5')
      .update(JSON.stringify(data))
      .digest('hex');
  },

  detectSetupUrl() {
    const nets = networkInterfaces();
    // Prefer common physical interface names over virtual/bridge/docker interfaces
    for (const name of ['eth0', 'wlan0', 'en0', 'en1', 'Ethernet', 'Wi-Fi']) {
      const iface = nets[name];
      if (iface) {
        const addr = iface.find(n => n.family === 'IPv4' && !n.internal);
        if (addr) return `http://${addr.address}:8080/MMM-SteamFriends/setup`;
      }
    }
    const fallback = Object.values(nets).flat()
      .find(n => n.family === 'IPv4' && !n.internal);
    const ip = fallback?.address ?? 'localhost';
    return `http://${ip}:8080/MMM-SteamFriends/setup`;
  },

  async loadCredentials() {
    const credPath = path.join(this.path, 'credentials.json');
    try {
      const raw = await fs.promises.readFile(credPath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error('[MMM-SteamFriends] Failed to read credentials.json:', e.message);
      }
      return {};
    }
  },

  async saveCredentials(steamId, steamApiKey) {
    const credPath = path.join(this.path, 'credentials.json');
    await fs.promises.writeFile(credPath, JSON.stringify({ steamId, steamApiKey }), 'utf8');
  },

  registerSetupRoutes() {
    this.expressApp.get('/MMM-SteamFriends/setup', (req, res) => {
      if (!this.setupActive) return res.status(404).send('Setup is not active.');
      res.sendFile(path.join(this.path, 'setup.html'));
    });

    this.expressApp.post('/MMM-SteamFriends/setup', async (req, res) => {
      if (!this.setupActive) return res.status(404).send('Setup is not active.');

      let body = {};
      try {
        await new Promise((resolve, reject) => {
          let raw = '';
          req.on('data', chunk => { raw += chunk; });
          req.on('end', () => { try { body = JSON.parse(raw); resolve(); } catch (e) { reject(e); } });
          req.on('error', reject);
        });
      } catch (e) {
        return res.json({ ok: false, error: 'Could not parse request body.' });
      }

      const { steamId, steamApiKey } = body;

      if (!steamId || !/^\d{17}$/.test(steamId)) {
        return res.json({ ok: false, error: 'SteamID must be a 17-digit number.' });
      }
      if (!steamApiKey || steamApiKey.trim().length < 10) {
        return res.json({ ok: false, error: 'API key looks too short.' });
      }

      try {
        const testUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${steamApiKey.trim()}&steamids=${steamId}`;
        const result = await this.api.get(testUrl);
        const players = result.data?.response?.players;
        if (!Array.isArray(players) || players.length === 0) {
          return res.json({ ok: false, error: 'Steam did not return a profile. Check your SteamID.' });
        }
      } catch (e) {
        const status = e.response?.status;
        const msg = status === 403
          ? 'API key rejected by Steam. Double-check it.'
          : `Steam API error: ${e.message}`;
        return res.json({ ok: false, error: msg });
      }

      this.setupActive = false;
      await this.saveCredentials(steamId, steamApiKey.trim());
      this.config.steamId = steamId;
      this.config.steamApiKey = steamApiKey.trim();

      const notify = (evt, data) => this.sendSocketNotification(evt, data);
      if (this.config.gameScore?.enabled && !this.scoresCache) {
        const cachePath = path.join(__dirname, ".game-scores-cache.json");
        this.scoresCache = new ScoresCache(cachePath, this.config.gameScore.refreshDays || 7, notify);
        await this.scoresCache.load();
      }
      if ((this.config.sortFriends === "totalPlaytime" || this.config.showGamePlaytime) && !this.playtimeCache) {
        const cachePath = path.join(__dirname, ".playtime-cache.json");
        this.playtimeCache = new PlaytimeCache(cachePath, 24, notify);
        await this.playtimeCache.load();
      }

      this.sendSocketNotification("SETUP_COMPLETE", { steamId, steamApiKey: steamApiKey.trim() });
      res.json({ ok: true });
      await this.fetchFriends();
      this.schedulePoll();
    });
  },

  detectPlatform(flags, inGame) {
    if (!inGame) return null;
    if (flags & PLATFORM_FLAGS.WEB) return 'web';
    if (flags & PLATFORM_FLAGS.MOBILE) return 'mobile';
    if (flags & PLATFORM_FLAGS.BIG_PICTURE) return null;
    if (flags & PLATFORM_FLAGS.CLIENT) return (flags & PLATFORM_FLAGS.STEAM_DECK) ? 'deck' : 'pc';
    return 'pc';
  },

  mapPersonaState(state) {
    const states = {
      0: "Offline",
      1: "Online",
      2: "Busy",
      3: "Away",
      4: "Snooze",
      5: "Looking to trade",
      6: "Looking to play"
    };
    return states[state] || "Offline";
  },

  sortByConfig(a, b) {
    const sortMethod = this.config.sortFriends || "alphabetic";

    switch (sortMethod) {
      case "recentActivity": {
        const aTime = a.lastLogOff || 0;
        const bTime = b.lastLogOff || 0;
        if (aTime !== bTime) return bTime - aTime;
        return a.name.localeCompare(b.name);
      }

      case "totalPlaytime": {
        const aPlaytime = a.totalPlaytime || 0;
        const bPlaytime = b.totalPlaytime || 0;
        if (aPlaytime !== bPlaytime) return bPlaytime - aPlaytime;
        return a.name.localeCompare(b.name);
      }

      case "alphabetic":
      default:
        return a.name.localeCompare(b.name);
    }
  },

  async fetchGameScore(gameId) {
    if (!isValidGameId(gameId)) {
      return null;
    }

    if (this.scoreRateLimitBackoff > Date.now()) {
      return null;
    }

    try {
      const url = `https://store.steampowered.com/appreviews/${gameId}?json=1&language=all&purchase_type=all&num_per_page=0`;
      const response = await this.api.get(url, {
        timeout: API.SCORE_REQUEST_TIMEOUT
      });

      if (!response.data || typeof response.data !== 'object') {
        return null;
      }

      const { query_summary } = response.data;

      if (response.data.success === false || !query_summary) {
        return { invalid: true };
      }

      const { total_positive, total_negative, total_reviews } = query_summary;

      const minReviews = this.config.gameScore.minReviews || 50;
      if (!total_reviews || total_reviews < minReviews) {
        return null;
      }

      const total = total_positive + total_negative;
      if (total === 0) {
        return null;
      }

      const score = Math.round((total_positive / total) * 100);

      return {
        score,
        totalReviews: total_reviews,
        reviewCount: total_reviews,
        lastUpdated: Date.now()
      };

    } catch (error) {
      if (error.response && error.response.status === 429) {
        console.warn("[MMM-SteamFriends] Steam review API rate limited, backing off");
        this.scoreRateLimitBackoff = Date.now() + API.RATE_LIMIT_BACKOFF_MS;
        return null;
      }

      if (error.response && error.response.status === 404) {
        return { invalid: true };
      }

      return null;
    }
  },

  async enrichWithScores(friends) {
    const gameIdsToFetch = new Map();

    friends.forEach((friend, index) => {
      if (!friend.gameId || !isValidGameId(friend.gameId)) {
        return;
      }

      const cached = this.scoresCache.get(friend.gameId);

      if (cached) {
        if (!this.scoresCache.isInvalid(cached) && cached.score !== undefined) {
          friend.gameScore = cached.score;
        }

        if (!this.scoresCache.isStale(cached)) return;
        if (cached.reviewCount > 1000 && Date.now() - cached.cachedAt < 30 * 24 * 60 * 60 * 1000) return;
      }

      if (!gameIdsToFetch.has(friend.gameId)) {
        gameIdsToFetch.set(friend.gameId, []);
      }
      gameIdsToFetch.get(friend.gameId).push(index);
    });

    if (gameIdsToFetch.size === 0) {
      await this.scoresCache.maybePersist();
      return;
    }

    const gameIds = Array.from(gameIdsToFetch.keys());
    const batches = this.chunkArray(gameIds, API.SCORE_CONCURRENT_REQUESTS);

    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map(async (gameId) => {
          const result = await this.fetchGameScore(gameId);
          return { gameId, result };
        })
      );

      for (const promise of results) {
        if (promise.status !== 'fulfilled' || !promise.value.result) continue;
        const { gameId, result } = promise.value;
        this.scoresCache.set(gameId, result);
        if (!result.invalid && result.score !== undefined) {
          gameIdsToFetch.get(gameId).forEach(idx => { friends[idx].gameScore = result.score; });
        }
      }
    }

    await this.scoresCache.maybePersist();
  },

  async fetchPlaytime(steamId, apiKey) {
    try {
      const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${apiKey}&steamid=${steamId}&include_played_free_games=1&format=json`;
      const response = await this.api.get(url, {
        timeout: API.PLAYTIME_REQUEST_TIMEOUT
      });

      if (!response.data || !response.data.response) {
        return { totalPlaytime: 0, private: true };
      }

      const games = response.data.response.games || [];
      if (games.length === 0) {
        return { totalPlaytime: 0, private: true, games: {} };
      }

      const totalMinutes = games.reduce((sum, game) => sum + (game.playtime_forever || 0), 0);

      return {
        totalPlaytime: totalMinutes,
        gameCount: games.length,
        private: false,
        games: Object.fromEntries(games.map(g => [String(g.appid), g.playtime_forever || 0]))
      };
    } catch (error) {
      const status = error.response?.status;
      if (status !== 401 && status !== 403) {
        console.warn(`[MMM-SteamFriends] fetchPlaytime error for ${steamId}:`, error.message);
      }
      return { totalPlaytime: 0, private: true, games: {} };
    }
  },

  async enrichWithPlaytime(friends, apiKey) {
    if (!this.playtimeCache) return;

    const friendsToFetch = [];

    friends.forEach((friend, index) => {
      const cached = this.playtimeCache.get(friend.id);

      if (cached) {
        friend.totalPlaytime = cached.totalPlaytime || 0;
        if (friend.inGame && friend.gameId) {
          friend.gamePlaytime = cached.games?.[String(friend.gameId)];
        }
        if (!this.playtimeCache.isStale(cached)) {
          return;
        }
      }

      friendsToFetch.push({ index, steamId: friend.id });
    });

    if (friendsToFetch.length === 0) {
      await this.playtimeCache.maybePersist();
      return;
    }

    const batches = this.chunkArray(friendsToFetch, API.PLAYTIME_CONCURRENT_REQUESTS);

    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map(async ({ index, steamId }) => {
          const result = await this.fetchPlaytime(steamId, apiKey);
          return { index, steamId, result };
        })
      );

      for (const settled of results) {
        if (settled.status !== 'fulfilled') continue;
        const { index, steamId, result } = settled.value;
        this.playtimeCache.set(steamId, result);
        friends[index].totalPlaytime = result.totalPlaytime || 0;
        if (friends[index].inGame && friends[index].gameId) {
          friends[index].gamePlaytime = result.games?.[String(friends[index].gameId)];
        }
      }
    }

    await this.playtimeCache.maybePersist();
  },

  async fetchAchievementProgress(steamId, gameId, apiKey) {
    try {
      const res = await this.api.get(
        'https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/',
        { params: { key: apiKey, steamid: steamId, appid: gameId }, timeout: API.ACHIEVEMENT_REQUEST_TIMEOUT }
      );
      const achievements = res.data?.playerstats?.achievements;
      if (!achievements?.length) return null;
      const unlocked = achievements.filter(a => a.achieved === 1).length;
      return { pct: Math.round((unlocked / achievements.length) * 100) };
    } catch (e) {
      const s = e.response?.status;
      if (s !== 401 && s !== 403) console.warn(`[MMM-SteamFriends] achievement fetch ${steamId}/${gameId}:`, e.message);
      return null;
    }
  },

  async enrichWithAchievements(friends, apiKey) {
    if (!this.achievementCache) return;

    const toFetch = [];

    friends.forEach((friend, index) => {
      if (!friend.inGame || !isValidGameId(friend.gameId)) return;

      const cached = this.achievementCache.get(friend.id, friend.gameId);
      if (cached) {
        if (cached.pct !== null) friend.achievementPct = cached.pct;
        if (!this.achievementCache.isStale(cached)) return;
      }

      toFetch.push({ index, steamId: friend.id, gameId: friend.gameId });
    });

    if (toFetch.length === 0) {
      await this.achievementCache.maybePersist();
      return;
    }

    const batches = this.chunkArray(toFetch, API.ACHIEVEMENT_CONCURRENT_REQUESTS);

    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map(async ({ index, steamId, gameId }) => {
          const result = await this.fetchAchievementProgress(steamId, gameId, apiKey);
          return { index, steamId, gameId, result };
        })
      );

      for (const settled of results) {
        if (settled.status !== 'fulfilled') continue;
        const { index, steamId, gameId, result } = settled.value;
        this.achievementCache.set(steamId, gameId, result ?? { pct: null });
        if (result) friends[index].achievementPct = result.pct;
      }
    }

    await this.achievementCache.maybePersist();
  },

  async checkForUpdate() {
    try {
      const res = await this.api.get(
        'https://raw.githubusercontent.com/th3pajay/MMM-SteamFriends/main/package.json',
        { timeout: 5000 }
      );
      const remote = res.data?.version;
      if (remote && this.isNewerVersion(remote, LOCAL_VERSION)) {
        this.sendSocketNotification('UPDATE_AVAILABLE', remote);
      }
    } catch { /* silent — github unreachable */ }
  },

  isNewerVersion(remote, local) {
    const r = remote.split('.').map(Number);
    const l = local.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((r[i] || 0) > (l[i] || 0)) return true;
      if ((r[i] || 0) < (l[i] || 0)) return false;
    }
    return false;
  }
});
