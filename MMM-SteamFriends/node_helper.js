const NodeHelper = require("node_helper");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const QRCode = require("qrcode");

const API = {
  FRIENDS_PER_REQUEST: 100,
  REQUEST_TIMEOUT: 10000,
  MAX_CONSECUTIVE_ERRORS: 5,
  FALLBACK_POLL_INTERVAL: 300000,
  SCORE_CONCURRENT_REQUESTS: 5,
  SCORE_REQUEST_TIMEOUT: 8000,
  PLAYTIME_CONCURRENT_REQUESTS: 3,
  PLAYTIME_REQUEST_TIMEOUT: 8000,
  RATE_LIMIT_BACKOFF_MS: 60000,
  ERROR_BACKOFF_INTERVAL_MS: 300000,
  MAX_CACHE_SIZE: 1000
};

// Validates that a gameId is a valid Steam app ID (numeric, 1-10 digits)
function isValidGameId(gameId) {
  return gameId && /^\d{1,10}$/.test(String(gameId));
}

// ScoresCache class for managing game review scores with file persistence
class ScoresCache {
  constructor(cachePath, ttlDays = 7) {
    this.cachePath = cachePath;
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
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
        console.log(`[MMM-SteamFriends] Loaded ${this.cache.size} cached game scores`);
      }
    } catch (error) {
      console.warn("[MMM-SteamFriends] Could not load score cache, starting fresh:", error.message);
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
      console.error("[MMM-SteamFriends] Could not save score cache:", error.message);
      this.consecutiveFailures++;

      if (this.consecutiveFailures >= this.MAX_FAILURES && global.moduleInstance) {
        global.moduleInstance.sendSocketNotification("CACHE_ERROR", {
          filename: this.cachePath,
          error: error.message,
          failures: this.consecutiveFailures
        });
      }

      try {
        if (fs.existsSync(tempPath)) {
          await fs.promises.unlink(tempPath);
        }
      } catch (e) {}
    }
  }

  async maybePersist() {
    if (this.dirty && Date.now() - this.lastPersist >= this.persistIntervalMs) {
      await this.save();
    }
  }

  get(gameId) {
    if (!isValidGameId(gameId)) return null;
    const key = String(gameId);
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Return even if stale (stale-while-revalidate pattern)
    return entry;
  }

  set(gameId, scoreData) {
    if (!isValidGameId(gameId)) return;
    const key = String(gameId);
    this.cache.set(key, {
      ...scoreData,
      cachedAt: Date.now()
    });
    this.dirty = true;

    if (this.cache.size > API.MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  isStale(entry) {
    if (!entry || !entry.cachedAt) return true;
    return Date.now() - entry.cachedAt > this.ttlMs;
  }

  isInvalid(entry) {
    return entry && entry.invalid === true;
  }
}

class PlaytimeCache {
  constructor(cachePath, ttlHours = 24) {
    this.cachePath = cachePath;
    this.ttlMs = ttlHours * 60 * 60 * 1000;
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
        console.log(`[MMM-SteamFriends] Loaded ${this.cache.size} cached playtimes`);
      }
    } catch (error) {
      console.warn("[MMM-SteamFriends] Could not load playtime cache:", error.message);
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
      console.error("[MMM-SteamFriends] Could not save playtime cache:", error.message);
      this.consecutiveFailures++;

      if (this.consecutiveFailures >= this.MAX_FAILURES && global.moduleInstance) {
        global.moduleInstance.sendSocketNotification("CACHE_ERROR", {
          filename: this.cachePath,
          error: error.message,
          failures: this.consecutiveFailures
        });
      }

      try {
        if (fs.existsSync(tempPath)) {
          await fs.promises.unlink(tempPath);
        }
      } catch (e) {}
    }
  }

  async maybePersist() {
    if (this.dirty && Date.now() - this.lastPersist >= this.persistIntervalMs) {
      await this.save();
    }
  }

  get(steamId) {
    const entry = this.cache.get(steamId);
    if (!entry) return null;
    return entry;
  }

  set(steamId, playtimeData) {
    this.cache.set(steamId, {
      ...playtimeData,
      cachedAt: Date.now()
    });
    this.dirty = true;

    if (this.cache.size > API.MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  isStale(entry) {
    if (!entry || !entry.cachedAt) return true;
    return Date.now() - entry.cachedAt > this.ttlMs;
  }
}

module.exports = NodeHelper.create({
  start() {
    global.moduleInstance = this;
    this.config = null;
    this.pollInterval = null;
    this.lastFriendsHash = null;
    this.errorCount = 0;
    this.maxErrors = API.MAX_CONSECUTIVE_ERRORS;
    this.fetchInProgress = false;
    this.scoresCache = null;
    this.scoreRateLimitBackoff = 0;
    this.playtimeCache = null;
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
  },

  validateConfig(config) {
    if (!config.setup) {
      if (!config.steamId || !/^\d{17}$/.test(config.steamId)) {
        throw new Error("Invalid steamId format. Must be 17-digit Steam ID.");
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

    return true;
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

      try {
        this.validateConfig(payload);
      } catch (error) {
        this.sendSocketNotification("CONFIG_ERROR", error.message);
        return;
      }

      this.config = payload;

      if (payload.setup && (!payload.steamApiKey || !payload.steamId)) {
        return;
      }

      if (payload.gameScore && payload.gameScore.enabled) {
        const cachePath = path.join(__dirname, ".game-scores-cache.json");
        const ttlDays = payload.gameScore.refreshDays || 7;
        this.scoresCache = new ScoresCache(cachePath, ttlDays);
        await this.scoresCache.load();
      }

      if (payload.sortFriends === "totalPlaytime") {
        const cachePath = path.join(__dirname, ".playtime-cache.json");
        this.playtimeCache = new PlaytimeCache(cachePath, 24);
        await this.playtimeCache.load();
      }

      await this.fetchFriends();
      this.schedulePoll();
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
    const timeSinceChange = Date.now() - this.pollState.lastChangeTime;

    if (timeSinceChange < 300000) {
      this.pollState.currentInterval = 30000;
    } else {
      this.pollState.currentInterval = 300000;
    }

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

      let friendIds = friendListRes.data.friendslist.friends.map(f => f.steamid);

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

        return res.data.response.players.map(p => ({
          id: p.steamid,
          name: p.personaname,
          avatar: this.getAvatarUrl(p),
          status: this.mapPersonaState(p.personastate),
          inGame: !!p.gameid,
          game: p.gameextrainfo || "",
          gameId: p.gameid || null,
          country: (p.loccountrycode || "xx").toLowerCase(),
          lastLogOff: p.lastlogoff
        }));
      });

      const batchResults = await Promise.all(batchPromises);
      const allFriends = batchResults.flat();

      if (this.config.sortFriends === "totalPlaytime" && this.playtimeCache) {
        await this.enrichWithPlaytime(allFriends, key);
      }

      allFriends.sort((a, b) => {
        const aInGame = a.inGame ? 1 : 0;
        const bInGame = b.inGame ? 1 : 0;
        if (aInGame !== bInGame) return bInGame - aInGame;

        const statusOrder = { "Online": 0, "Busy": 1, "Away": 2, "Snooze": 3, "Looking to trade": 4, "Looking to play": 5, "Offline": 6 };
        const aOrder = statusOrder[a.status] !== undefined ? statusOrder[a.status] : 99;
        const bOrder = statusOrder[b.status] !== undefined ? statusOrder[b.status] : 99;
        if (aOrder !== bOrder) return aOrder - bOrder;

        return this.sortByConfig(a, b);
      });

      if (this.config.gameScore && this.config.gameScore.enabled && this.scoresCache) {
        await this.enrichWithScores(allFriends);
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
            () => this.fetchFriends(),
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
      case "recentActivity":
        const aTime = a.lastLogOff || 0;
        const bTime = b.lastLogOff || 0;
        if (aTime !== bTime) return bTime - aTime;
        return a.name.localeCompare(b.name);

      case "totalPlaytime":
        const aPlaytime = a.totalPlaytime || 0;
        const bPlaytime = b.totalPlaytime || 0;
        if (aPlaytime !== bPlaytime) return bPlaytime - aPlaytime;
        return a.name.localeCompare(b.name);

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
    const inGameFriends = friends.filter(f => f.inGame && f.gameId);
    const uniqueGameIds = [...new Set(inGameFriends.map(f => f.gameId))];

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

        if (!this.scoresCache.isStale(cached)) {
          return;
        }

        if (cached.reviewCount > 1000) {
          const age = Date.now() - cached.cachedAt;
          if (age < 30 * 24 * 60 * 60 * 1000) {
            return;
          }
        }
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
        if (promise.status === 'fulfilled' && promise.value.result) {
          const { gameId, result } = promise.value;
          this.scoresCache.set(gameId, result);

          if (!result.invalid && result.score !== undefined) {
            const indices = gameIdsToFetch.get(gameId);
            for (const idx of indices) {
              friends[idx].gameScore = result.score;
            }
          }
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
        return { totalPlaytime: 0, private: true };
      }

      const totalMinutes = games.reduce((sum, game) => sum + (game.playtime_forever || 0), 0);

      return {
        totalPlaytime: totalMinutes,
        gameCount: games.length,
        private: false
      };
    } catch (error) {
      return { totalPlaytime: 0, private: true };
    }
  },

  async enrichWithPlaytime(friends, apiKey) {
    if (!this.playtimeCache) return;

    const friendsToFetch = [];

    friends.forEach((friend, index) => {
      const cached = this.playtimeCache.get(friend.id);

      if (cached) {
        friend.totalPlaytime = cached.totalPlaytime || 0;
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
      const results = await Promise.all(
        batch.map(async ({ index, steamId }) => {
          const result = await this.fetchPlaytime(steamId, apiKey);
          return { index, steamId, result };
        })
      );

      for (const { index, steamId, result } of results) {
        this.playtimeCache.set(steamId, result);
        friends[index].totalPlaytime = result.totalPlaytime || 0;
      }
    }

    await this.playtimeCache.maybePersist();
  }
});
