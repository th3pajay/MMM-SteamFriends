const NodeHelper = require("node_helper");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { networkInterfaces } = require("os");
const LOCAL_VERSION = require("./package.json").version;
const { SteamClient, Enrichment, Sessions, toFriend, compareFriends, nextInterval, validate, normalize, chunk } = require("./backend");

const FRIENDS_PER_REQUEST = 100;
const REQUEST_TIMEOUT = 10000;
const MAX_CONSECUTIVE_ERRORS = 5;

module.exports = NodeHelper.create({
  start() {
    this.config = null;
    this.steam = null;
    this.allowlist = null;
    this.setupActive = false;
    this.setupRouteRegistered = false;
    this.pollTimer = null;
    this.lastPayload = null;
    this.lastChangeTime = Date.now();
    this.lastOk = 0;
    this.sessions = new Sessions();
    this.errorCount = 0;
    this.fetchInProgress = false;
    this.refreshing = false;
    this.friends = [];
    this.suspended = false;
    this.enrichment = new Enrichment({
      dir: __dirname,
      notify: (event, data) => this.sendSocketNotification(event, data)
    });
    this.api = axios.create({
      timeout: REQUEST_TIMEOUT,
      headers: { "Accept-Encoding": "gzip", "User-Agent": "MMM-SteamFriends/1.0" },
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 10 }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10 })
    });
  },

  async stop() {
    this.cancelPoll();
    await this.enrichment.stop();
  },

  cancelPoll() {
    if (!this.pollTimer) return false;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    return true;
  },

  async generateQRCode(url) {
    try {
      return await require("qrcode").toDataURL(url, { width: 200, margin: 1, color: { dark: "#000000", light: "#FFFFFF" } });
    } catch (error) {
      console.error("[MMM-SteamFriends] QR generation failed:", error);
      return null;
    }
  },

  async socketNotificationReceived(notification, payload) {
    switch (notification) {
      case "INIT":
        return this.init(payload);
      case "SUSPEND":
        this.suspended = true;
        if (this.cancelPoll()) console.log("[MMM-SteamFriends] Polling suspended");
        return;
      case "RESUME":
        this.suspended = false;
        if (!this.pollTimer && this.config) {
          await this.fetchFriends();
          this.schedulePoll();
          console.log("[MMM-SteamFriends] Polling resumed");
        }
        return;
      case "GENERATE_QR":
        this.sendSocketNotification("QR_GENERATED", {
          id: payload.id,
          dataUrl: await this.generateQRCode(payload.url)
        });
    }
  },

  async init(payload) {
    this.cancelPoll();

    const saved = await this.loadCredentials();
    const merged = normalize({ ...payload, ...saved });

    try {
      validate(merged);
    } catch (error) {
      this.sendSocketNotification("CONFIG_ERROR", error.message);
      return;
    }

    this.config = merged;
    this.steam = null;
    this.allowlist = merged.friendAllowlist?.length ? new Set(merged.friendAllowlist) : null;

    if (merged.setup && (!merged.steamApiKey || !merged.steamId)) {
      this.setupActive = true;
      if (!this.setupRouteRegistered) {
        this.registerSetupRoutes();
        this.setupRouteRegistered = true;
      }
      this.sendSocketNotification("SETUP_URL", this.detectSetupUrl());
      return;
    }

    if (merged.setup && saved.steamApiKey) {
      this.sendSocketNotification("SETUP_COMPLETE", { steamId: merged.steamId, steamApiKey: merged.steamApiKey });
    }

    await this.enrichment.start(merged);
    await this.fetchFriends();
    this.schedulePoll();
    this.checkForUpdate();
  },

  schedulePoll() {
    const interval = nextInterval({
      base: this.config.updateInterval || 60000,
      errorCount: this.errorCount,
      sinceChange: Date.now() - this.lastChangeTime
    });
    this.cancelPoll();
    this.sendSocketNotification("POLL_STATUS", { lastOk: this.lastOk, nextIn: interval, ok: this.errorCount === 0 });
    this.pollTimer = setTimeout(() => {
      this.fetchFriends()
        .catch(e => console.error("[MMM-SteamFriends]", e.message))
        .then(() => { if (!this.suspended) this.schedulePoll(); });
    }, interval);
  },

  getSteam() {
    const key = this.config.steamApiKey || process.env.STEAM_API_KEY;
    if (!key) throw new Error("Steam API key not configured. Set STEAM_API_KEY environment variable.");
    if (this.steam?.key !== key) this.steam = new SteamClient(this.api, key);
    return this.steam;
  },

  async fetchFriends() {
    if (this.fetchInProgress) {
      console.log("[MMM-SteamFriends] Fetch already in progress, skipping");
      return;
    }
    this.fetchInProgress = true;

    try {
      const steam = this.getSteam();
      const allIds = await steam.friendIds(this.config.steamId);
      const ids = this.allowlist ? allIds?.filter(id => this.allowlist.has(id)) : allIds;
      if (!ids?.length) {
        if (ids) console.log("[MMM-SteamFriends] No friends found");
        this.markOk();
        return this.publish([]);
      }

      const results = await Promise.allSettled(chunk(ids, FRIENDS_PER_REQUEST).map(batch => steam.players(batch)));
      const failed = results.filter(r => r.status === "rejected").length;
      if (failed) throw new Error(`${failed}/${results.length} player requests failed`);
      this.markOk();

      const friends = results.flatMap(r => r.value.map(p => toFriend(p, this.config.avatarSize)));
      this.sessions.apply(friends);
      const pending = this.enrichment.apply(friends);
      this.publish(friends);
      if (pending.length && !this.refreshing) this.refreshEnrichment(pending, steam);
    } catch (error) {
      this.errorCount++;
      console.error(`[MMM-SteamFriends] Fetch error (${this.errorCount}/${MAX_CONSECUTIVE_ERRORS}):`, error.message);
      this.sendSocketNotification("ERROR", {
        context: "fetchFriends",
        message: error.message,
        timestamp: Date.now()
      });
    } finally {
      this.fetchInProgress = false;
    }
  },

  markOk() {
    this.errorCount = 0;
    this.lastOk = Date.now();
  },

  publish(friends) {
    this.friends = friends;
    friends.sort(compareFriends(this.config.sortFriends));
    const payload = JSON.stringify(friends);
    if (payload === this.lastPayload) return;
    this.lastChangeTime = Date.now();
    this.lastPayload = payload;
    this.sendSocketNotification("FRIENDS_UPDATE", friends);
  },

  async refreshEnrichment(pending, steam) {
    this.refreshing = true;
    try {
      if (!(await this.enrichment.refresh(pending, steam))) return;
      this.enrichment.apply(this.friends);
      this.publish(this.friends);
    } catch (error) {
      console.error("[MMM-SteamFriends] Enrichment error:", error.message);
    } finally {
      this.refreshing = false;
    }
  },

  detectSetupUrl() {
    const nets = networkInterfaces();
    const isLan = (n) => n.family === "IPv4" && !n.internal;
    const preferred = ["eth0", "wlan0", "en0", "en1", "Ethernet", "Wi-Fi"]
      .map(name => nets[name]?.find(isLan))
      .find(Boolean);
    const addr = preferred ?? Object.values(nets).flat().find(isLan);
    return `http://${addr?.address ?? "localhost"}:8080/MMM-SteamFriends/setup`;
  },

  async loadCredentials() {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(this.path, "credentials.json"), "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") console.error("[MMM-SteamFriends] Failed to read credentials.json:", e.message);
      return {};
    }
  },

  async saveCredentials(steamId, steamApiKey) {
    await fs.promises.writeFile(path.join(this.path, "credentials.json"), JSON.stringify({ steamId, steamApiKey }), "utf8");
  },

  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
      req.on("error", reject);
    });
  },

  registerSetupRoutes() {
    this.expressApp.get("/MMM-SteamFriends/setup", (req, res) => {
      if (!this.setupActive) return res.status(404).send("Setup is not active.");
      res.sendFile(path.join(this.path, "setup.html"));
    });

    this.expressApp.post("/MMM-SteamFriends/setup", async (req, res) => {
      if (!this.setupActive) return res.status(404).send("Setup is not active.");

      let body;
      try {
        body = await this.readJsonBody(req);
      } catch (e) {
        return res.json({ ok: false, error: "Could not parse request body." });
      }

      const steamId = body.steamId;
      const steamApiKey = body.steamApiKey?.trim();

      if (!steamId || !/^\d{17}$/.test(steamId)) {
        return res.json({ ok: false, error: "SteamID must be a 17-digit number." });
      }
      if (!steamApiKey || steamApiKey.length < 10) {
        return res.json({ ok: false, error: "API key looks too short." });
      }

      try {
        const players = await new SteamClient(this.api, steamApiKey).players([steamId]);
        if (players.length === 0) {
          return res.json({ ok: false, error: "Steam did not return a profile. Check your SteamID." });
        }
      } catch (e) {
        const error = e.response?.status === 403
          ? "API key rejected by Steam. Double-check it."
          : `Steam API error: ${e.message}`;
        return res.json({ ok: false, error });
      }

      this.setupActive = false;
      await this.saveCredentials(steamId, steamApiKey);
      this.config.steamId = steamId;
      this.config.steamApiKey = steamApiKey;

      await this.enrichment.start(this.config);
      this.sendSocketNotification("SETUP_COMPLETE", { steamId, steamApiKey });
      res.json({ ok: true });
      await this.fetchFriends();
      this.schedulePoll();
    });
  },

  async checkForUpdate() {
    try {
      const res = await this.api.get(
        "https://raw.githubusercontent.com/th3pajay/MMM-SteamFriends/main/package.json",
        { timeout: 5000 }
      );
      const remote = res.data?.version;
      if (remote && this.isNewerVersion(remote, LOCAL_VERSION)) {
        this.sendSocketNotification("UPDATE_AVAILABLE", remote);
      }
    } catch {}
  },

  isNewerVersion(remote, local) {
    const r = remote.split(".").map(Number);
    const l = local.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((r[i] || 0) !== (l[i] || 0)) return (r[i] || 0) > (l[i] || 0);
    }
    return false;
  }
});
