const NodeHelper = require("node_helper");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// API and polling configuration constants
const API = {
  FRIENDS_PER_REQUEST: 100,
  REQUEST_TIMEOUT: 10000,
  MAX_CONSECUTIVE_ERRORS: 5,
  FALLBACK_POLL_INTERVAL: 300000,
  SCORE_CONCURRENT_REQUESTS: 5,
  SCORE_REQUEST_TIMEOUT: 8000,
  PLAYTIME_CONCURRENT_REQUESTS: 3,
  PLAYTIME_REQUEST_TIMEOUT: 8000
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
    this.persistIntervalMs = 5 * 60 * 1000; // 5 minutes
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
      await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
      await fs.promises.rename(tempPath, this.cachePath);
      this.dirty = false;
      this.lastPersist = Date.now();
    } catch (error) {
      console.error("[MMM-SteamFriends] Could not save score cache:", error.message);
      // Clean up temp file if it exists
      try {
        if (fs.existsSync(tempPath)) {
          await fs.promises.unlink(tempPath);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
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
      await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
      await fs.promises.rename(tempPath, this.cachePath);
      this.dirty = false;
      this.lastPersist = Date.now();
    } catch (error) {
      console.error("[MMM-SteamFriends] Could not save playtime cache:", error.message);
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
  }

  isStale(entry) {
    if (!entry || !entry.cachedAt) return true;
    return Date.now() - entry.cachedAt > this.ttlMs;
  }
}

module.exports = NodeHelper.create({
  start() {
    this.config = null;
    this.pollInterval = null;
    this.lastFriendsHash = null;
    this.errorCount = 0;
    this.maxErrors = API.MAX_CONSECUTIVE_ERRORS;
    this.fetchInProgress = false;
    this.scoresCache = null;
    this.scoreRateLimitBackoff = 0;
    this.playtimeCache = null;
  },

  async stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log("[MMM-SteamFriends] Polling stopped");
    }
    if (this.scoresCache) {
      await this.scoresCache.save();
    }
    if (this.playtimeCache) {
      await this.playtimeCache.save();
    }
  },

  async socketNotificationReceived(notification, config) {
    if (notification === "INIT") {
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }

      this.config = config;

      if (config.setup && (!config.steamApiKey || !config.steamId)) {
        return;
      }

      if (config.gameScore && config.gameScore.enabled) {
        const cachePath = path.join(__dirname, ".game-scores-cache.json");
        const ttlDays = config.gameScore.refreshDays || 7;
        this.scoresCache = new ScoresCache(cachePath, ttlDays);
        await this.scoresCache.load();
      }

      if (config.sortFriends === "totalPlaytime") {
        const cachePath = path.join(__dirname, ".playtime-cache.json");
        this.playtimeCache = new PlaytimeCache(cachePath, 24);
        await this.playtimeCache.load();
      }

      await this.fetchFriends();

      this.pollInterval = setInterval(
        () => this.fetchFriends(),
        config.updateInterval
      );
    }

    if (notification === "SUSPEND") {
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
        console.log("[MMM-SteamFriends] Polling suspended");
      }
    }

    if (notification === "RESUME") {
      if (!this.pollInterval && this.config) {
        await this.fetchFriends();
        this.pollInterval = setInterval(
          () => this.fetchFriends(),
          this.config.updateInterval
        );
        console.log("[MMM-SteamFriends] Polling resumed");
      }
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
      const friendListRes = await axios.get(friendListUrl, {
        timeout: API.REQUEST_TIMEOUT,
        headers: { 'Accept-Encoding': 'gzip' }
      });

      let friendIds = friendListRes.data.friendslist.friends.map(f => f.steamid);

      if (this.config.friendAllowlist && this.config.friendAllowlist.length > 0) {
        friendIds = friendIds.filter(id => this.config.friendAllowlist.includes(id));
      }

      if (friendIds.length === 0) {
        console.log("[MMM-SteamFriends] No friends found");
        this.sendSocketNotification("FRIENDS_UPDATE", []);
        return;
      }

      const batches = this.chunkArray(friendIds, API.FRIENDS_PER_REQUEST);
      const allFriends = [];

      for (const batch of batches) {
        const summariesUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${key}&steamids=${batch.join(',')}`;
        const res = await axios.get(summariesUrl, {
          timeout: API.REQUEST_TIMEOUT,
          headers: { 'Accept-Encoding': 'gzip' }
        });

        const friends = res.data.response.players.map(p => ({
          id: p.steamid,
          name: p.personaname,
          avatar: p.avatarfull,
          status: this.mapPersonaState(p.personastate),
          inGame: !!p.gameid,
          game: p.gameextrainfo || "",
          gameId: p.gameid || null,
          country: (p.loccountrycode || "xx").toLowerCase(),
          lastLogOff: p.lastlogoff
        }));

        allFriends.push(...friends);
      }

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

      // Enrich with game scores if enabled (non-blocking)
      if (this.config.gameScore && this.config.gameScore.enabled && this.scoresCache) {
        await this.enrichWithScores(allFriends);
      }

      const currentHash = this.hashData(allFriends);
      if (currentHash !== this.lastFriendsHash) {
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
          clearInterval(this.pollInterval);
          this.pollInterval = setInterval(
            () => this.fetchFriends(),
            API.FALLBACK_POLL_INTERVAL
          );
        }
      }

      this.sendSocketNotification("FETCH_ERROR", {
        message: error.message,
        count: this.errorCount
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

  // Fetch game review score from Steam API
  async fetchGameScore(gameId) {
    if (!isValidGameId(gameId)) {
      return null;
    }

    // Check for rate limit backoff
    if (this.scoreRateLimitBackoff > Date.now()) {
      return null;
    }

    try {
      const url = `https://store.steampowered.com/appreviews/${gameId}?json=1&language=all&purchase_type=all&num_per_page=0`;
      const response = await axios.get(url, {
        timeout: API.SCORE_REQUEST_TIMEOUT,
        headers: { 'Accept-Encoding': 'gzip' }
      });

      // Validate response structure
      if (!response.data || typeof response.data !== 'object') {
        return null;
      }

      const { query_summary } = response.data;

      // Handle 404/invalid app - cache as invalid
      if (response.data.success === false || !query_summary) {
        return { invalid: true };
      }

      const { total_positive, total_negative, total_reviews } = query_summary;

      // Check minimum reviews threshold
      const minReviews = this.config.gameScore.minReviews || 50;
      if (!total_reviews || total_reviews < minReviews) {
        return null;
      }

      // Calculate percentage (protect against division by zero)
      const total = total_positive + total_negative;
      if (total === 0) {
        return null;
      }

      const score = Math.round((total_positive / total) * 100);

      return {
        score,
        totalReviews: total_reviews,
        lastUpdated: Date.now()
      };

    } catch (error) {
      // Handle rate limiting (429)
      if (error.response && error.response.status === 429) {
        console.warn("[MMM-SteamFriends] Steam review API rate limited, backing off");
        this.scoreRateLimitBackoff = Date.now() + 60000; // 1 minute backoff
        return null;
      }

      // Handle 404 - cache as invalid
      if (error.response && error.response.status === 404) {
        return { invalid: true };
      }

      // Other errors - don't cache, return null
      return null;
    }
  },

  // Enrich friends with game scores using batched concurrent requests
  async enrichWithScores(friends) {
    // Collect unique gameIds that need fetching
    const gameIdsToFetch = new Map(); // gameId -> array of friend indices

    friends.forEach((friend, index) => {
      if (!friend.gameId || !isValidGameId(friend.gameId)) {
        return;
      }

      const cached = this.scoresCache.get(friend.gameId);

      // Use cached value if available (stale-while-revalidate)
      if (cached) {
        if (!this.scoresCache.isInvalid(cached) && cached.score !== undefined) {
          friend.gameScore = cached.score;
        }

        // If not stale, skip fetching
        if (!this.scoresCache.isStale(cached)) {
          return;
        }
      }

      // Queue for background refresh
      if (!gameIdsToFetch.has(friend.gameId)) {
        gameIdsToFetch.set(friend.gameId, []);
      }
      gameIdsToFetch.get(friend.gameId).push(index);
    });

    // Nothing to fetch
    if (gameIdsToFetch.size === 0) {
      await this.scoresCache.maybePersist();
      return;
    }

    // Batch fetch with concurrency limit
    const gameIds = Array.from(gameIdsToFetch.keys());
    const batches = this.chunkArray(gameIds, API.SCORE_CONCURRENT_REQUESTS);

    for (const batch of batches) {
      const results = await Promise.all(
        batch.map(async (gameId) => {
          const result = await this.fetchGameScore(gameId);
          return { gameId, result };
        })
      );

      // Process results
      for (const { gameId, result } of results) {
        if (result !== null) {
          this.scoresCache.set(gameId, result);

          // Update friends with this gameId
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
      const response = await axios.get(url, {
        timeout: API.PLAYTIME_REQUEST_TIMEOUT,
        headers: { 'Accept-Encoding': 'gzip' }
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
