const NodeHelper = require("node_helper");
const axios = require("axios");
const crypto = require("crypto");

// API and polling configuration constants
const API = {
  FRIENDS_PER_REQUEST: 100,
  REQUEST_TIMEOUT: 10000,  // 10 seconds
  MAX_CONSECUTIVE_ERRORS: 5,
  FALLBACK_POLL_INTERVAL: 300000  // 5 minutes
};

module.exports = NodeHelper.create({
  start() {
    this.config = null;
    this.pollInterval = null;
    this.lastFriendsHash = null;
    this.errorCount = 0;
    this.maxErrors = API.MAX_CONSECUTIVE_ERRORS;
    this.fetchInProgress = false;
  },

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log("[MMM-SteamFriends] Polling stopped");
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
          country: (p.loccountrycode || "xx").toLowerCase(),
          lastLogOff: p.lastlogoff
        }));

        allFriends.push(...friends);
      }

      allFriends.sort((a, b) => {
        if (a.inGame !== b.inGame) return b.inGame - a.inGame;
        if (a.status !== b.status) {
          const order = { "Online": 0, "Busy": 1, "Away": 2, "Snooze": 3, "Looking to trade": 4, "Looking to play": 5, "Offline": 6 };
          return (order[a.status] || 99) - (order[b.status] || 99);
        }
        return a.name.localeCompare(b.name);
      });

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
  }
});
