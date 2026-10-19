const ACCENTS = { cyan: "#00c8ff", green: "#00e676", violet: "#a78bfa", amber: "#ffb300" };
const CLOCK_INTERVAL = 30000;

Module.register("MMM-SteamFriends", {
  defaults: {
    account: {
      steamId: "",
      steamApiKey: ""
    },
    friends: {
      interval: 60000,
      max: 50,
      sort: "alphabetic",
      allowlist: [],
      offline: "collapse",
      recentOffline: 3
    },
    look: {
      density: "normal",
      accent: "cyan",
      scale: 0.7,
      opacity: 0.92,
      radius: "16px",
      avatar: "medium",
      colors: {
        ingame: "#00e676",
        online: "#38bdf8",
        away: "#ffb300",
        busy: "#ff6b35",
        offline: "#667085"
      },
      motion: "calm",
      glow: false
    },
    header: {
      ticker: true,
      live: true
    },
    games: {
      capsule: "off",
      achievements: "off",
      playtime: false,
      timer: true,
      score: {
        enabled: false,
        minReviews: 50,
        colors: { high: "#57cbde", mid: "#a3a3a3", low: "#842c2c" },
        thresholds: { high: 80, mid: 50 }
      },
      topGames: {
        enabled: false,
        cycle: 30000,
        rotate: 4000
      }
    }
  },

  start() {
    this.config = resolveConfig(this.config, this.defaults);
    this.friends = [];
    this.pendingTimeouts = [];
    this.carousel = new TopGamesCarousel({
      settings: this.config.topGames,
      capsuleUrl: (gameId) => gameCapsuleUrl(gameId, this.config.gameCapsuleSize)
    });
    this.rows = new FriendRows({
      config: this.config,
      carousel: this.carousel,
      iconUrl: (file) => this.file(`icons/${file}`),
      later: (fn, delay) => this.trackTimeout(fn, delay)
    });
    this.header = new Header({ config: this.config });
    this.steamIconEl = null;
    this.updateAvailable = false;
    this.scheduleGlintCycle();
    this.scheduleClock();
    this.sendSocketNotification("INIT", this.config);
  },

  getScripts() {
    return [this.file("client.js")];
  },

  getStyles() {
    return [
      "steam.css",
      "flags/flags.css"
    ];
  },

  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case "FRIENDS_UPDATE": {
        const previousIds = new Set(this.friends.map(f => f.id));
        this.friends = payload;
        this.updateFriendsList(previousIds);
        break;
      }
      case "POLL_STATUS":
        this.header.setStatus(payload);
        break;
      case "ERROR":
        console.warn("[MMM-SteamFriends] Error:", payload.message);
        break;
      case "CACHE_ERROR":
        console.warn(`[MMM-SteamFriends] Cache persistence failing: ${payload.filename}`);
        break;
      case "CONFIG_ERROR":
        console.error(`[MMM-SteamFriends] Configuration error: ${payload}`);
        break;
      case "QR_GENERATED": {
        const img = document.getElementById(`qr-${payload.id}`);
        if (img && payload.dataUrl) img.src = payload.dataUrl;
        break;
      }
      case "SETUP_URL":
        this.setupUrl = payload;
        this.updateDom();
        break;
      case "SETUP_COMPLETE":
        this.config.steamId = payload.steamId;
        this.config.steamApiKey = payload.steamApiKey;
        this.updateDom();
        break;
      case "UPDATE_AVAILABLE":
        this.updateAvailable = true;
        this.updateDom();
        break;
    }
  },

  suspend() {
    this.pendingTimeouts.forEach(id => clearTimeout(id));
    this.pendingTimeouts = [];
    this.rows.settle();
    this.steamIconEl?.classList.remove("glinting");
    this.carousel.reset();
    this.header.stop();
    this.sendSocketNotification("SUSPEND");
  },

  trackTimeout(fn, delay) {
    const id = setTimeout(() => {
      this.pendingTimeouts = this.pendingTimeouts.filter(t => t !== id);
      fn();
    }, delay);
    this.pendingTimeouts.push(id);
    return id;
  },

  resume() {
    this.scheduleGlintCycle();
    this.scheduleClock();
    this.header.start();
    this.sendSocketNotification("RESUME");
  },

  scheduleClock() {
    this.trackTimeout(() => {
      this.rows.refreshTimes();
      this.scheduleClock();
    }, CLOCK_INTERVAL);
  },

  updateFriendsList(previousIds) {
    const tbody = document.querySelector(".steam-table tbody");
    if (!tbody) {
      this.updateDom();
      return;
    }
    this.header.update(this.friends);
    this.rows.reconcile(tbody, this.friends, previousIds);
  },

  applyTheme(root) {
    const { accent, panelOpacity, stateColors, density } = this.config;
    root.style.setProperty("--accent", ACCENTS[accent] || (/^#[0-9a-f]{3,8}$/i.test(accent) ? accent : ACCENTS.cyan));
    root.style.setProperty("--op", panelOpacity);
    Object.entries(stateColors).forEach(([state, color]) => root.style.setProperty(`--c-${state}`, color));
    root.classList.add(`density-${density}`, `motion-${this.config.motion}`);
  },

  getSetupDom(root) {
    const setup = document.createElement("div");
    setup.className = "steam-setup";

    const title = document.createElement("div");
    title.className = "setup-title";
    title.textContent = "Steam Friends Setup";

    const qrImg = document.createElement("img");
    qrImg.className = "setup-qr-image";
    qrImg.id = "qr-setup";
    qrImg.alt = "Setup QR Code";

    if (this.setupUrl) {
      this.sendSocketNotification("GENERATE_QR", { id: "setup", url: this.setupUrl });
    }

    const urlText = document.createElement("div");
    urlText.className = "setup-url";
    urlText.textContent = this.setupUrl || "Loading…";

    const instructions = document.createElement("div");
    instructions.className = "setup-instructions";
    ["1. Scan QR or open URL on your phone",
     "2. Enter your Steam API key and SteamID",
     "3. The mirror updates automatically"].forEach(text => {
      const line = document.createElement("div");
      line.textContent = text;
      instructions.appendChild(line);
    });

    setup.append(title, qrImg, urlText, instructions);
    root.appendChild(setup);
    return root;
  },

  getDom() {
    const root = document.createElement("div");
    root.className = "steam-root";
    root.style.transform = `scale(${this.config.scale})`;
    root.style.transformOrigin = "top center";
    this.applyTheme(root);

    if (this.config.setup && (!this.config.steamApiKey || !this.config.steamId)) {
      return this.getSetupDom(root);
    }

    root.appendChild(this.header.build({ updateAvailable: this.updateAvailable }));
    this.steamIconEl = this.header.icon;

    const table = document.createElement("table");
    table.className = "steam-table";
    table.style.borderRadius = this.config.borderRadius;

    const anim = this.config.animations;
    table.style.setProperty("--slide-in-duration", `${anim.slideInDuration ?? 400}ms`);
    table.style.setProperty("--slide-out-duration", `${anim.slideOutDuration ?? 400}ms`);
    table.style.setProperty("--fade-in-duration", `${anim.fadeInDuration ?? 300}ms`);
    table.style.setProperty("--fade-out-duration", `${anim.fadeOutDuration ?? 300}ms`);

    if (this.config.topGames?.enabled) {
      table.style.setProperty("--carousel-transition-speed", `${this.config.topGames.transitionSpeed ?? 400}ms`);
    }

    if (this.config.magicBorder.enabled) {
      table.classList.add("magic-border");
      table.style.setProperty("--magic-duration", `${this.config.magicBorder.duration}s`);
      table.style.setProperty("--magic-intensity", this.config.magicBorder.intensity);
      table.style.setProperty("--magic-blur-base", `${this.config.magicBorder.blurBase}px`);
      table.style.setProperty("--magic-blur-peak", `${this.config.magicBorder.blurPeak}px`);
      table.style.setProperty("--magic-scale-peak", this.config.magicBorder.scalePeak);
    }

    this.carousel.reset();
    const tbody = document.createElement("tbody");
    this.rows.mount(tbody, this.friends);

    table.appendChild(tbody);
    root.appendChild(table);
    return root;
  },

  scheduleGlintCycle() {
    const mins = [];
    while (mins.length < 3) {
      const m = Math.floor(Math.random() * 60);
      if (!mins.includes(m)) mins.push(m);
    }
    mins.forEach(m => {
      this.trackTimeout(() => this.triggerIconGlint(), m * 60000);
    });
    this.trackTimeout(() => this.scheduleGlintCycle(), 3600000);
  },

  triggerIconGlint() {
    if (!this.steamIconEl) return;
    this.steamIconEl.classList.add("glinting");
    this.trackTimeout(() => this.steamIconEl?.classList.remove("glinting"), 700);
  }
});
