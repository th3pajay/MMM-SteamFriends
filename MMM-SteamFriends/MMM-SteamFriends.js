// Animation duration constants (milliseconds)
const ANIMATION_DURATIONS = {
  SLIDE_OUT: 400,
  FADE_OUT: 300,
  SLIDE_IN: 400,
  STATUS_CHANGE: 500,
  GAME_CHANGE: 500,
  GAMING_PULSE_DELAY: 500
};

Module.register("MMM-SteamFriends", {
  defaults: {
    setup: false,
    steamId: "",
    steamApiKey: "",
    updateInterval: 60000,
    friendAllowlist: [],
    borderRadius: "16px",
    maxFriends: 50,
    sortFriends: "alphabetic",
    scale: 0.7,
    avatarSize: "medium",
    showGameCapsule: false,
    gameCapsuleSize: "small",
    animations: {
      enabled: true,
      gamingPulse: true,
      slideInOnline: true,
      slideOutOffline: true
    },
    magicBorder: {
      enabled: false,
      duration: 10,
      intensity: 1.0,
      blurBase: 4,
      blurPeak: 8,
      scalePeak: 1.12
    },
    gameScore: {
      enabled: false,
      refreshDays: 7,
      minReviews: 50,
      showPercentSign: true,
      colors: {
        high: "#57cbde",
        mid: "#a3a3a3",
        low: "#842c2c"
      },
      thresholds: {
        high: 80,
        mid: 50
      }
    }
  },

  start() {
    this.friends = [];
    this.friendsMap = new Map();
    this.previousStates = new Map();
    this.cachedStatusCounts = null;
    this.lastFriendsHash = null;
    this.pendingTimeouts = [];
    this.sendSocketNotification("INIT", this.config);
  },

  getStyles() {
    return [
      "steam.css",
      "flags/flags.css"
    ];
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "FRIENDS_UPDATE") {
      const previousFriends = new Map(this.friends.map(f => [f.id, f]));
      this.friends = payload;
      this.updateFriendsList(previousFriends);
    }
    if (notification === "ERROR") {
      console.warn("[MMM-SteamFriends] Error:", payload.message);
    }
    if (notification === "CACHE_ERROR") {
      console.warn(`[MMM-SteamFriends] Cache persistence failing: ${payload.filename}`);
    }
    if (notification === "CONFIG_ERROR") {
      console.error(`[MMM-SteamFriends] Configuration error: ${payload}`);
    }
    if (notification === "QR_GENERATED") {
      const img = document.getElementById(`qr-${payload.id}`);
      if (img && payload.dataUrl) {
        img.src = payload.dataUrl;
      }
    }
  },

  suspend() {
    if (this.pendingTimeouts) {
      this.pendingTimeouts.forEach(id => clearTimeout(id));
      this.pendingTimeouts = [];
    }
    this.sendSocketNotification("SUSPEND");
  },

  resume() {
    this.sendSocketNotification("RESUME");
  },

  getStatusCounts() {
    const currentHash = this.friends.map(f => `${f.id}:${f.status}:${f.inGame}`).join('|');

    if (this.lastFriendsHash === currentHash && this.cachedStatusCounts) {
      return this.cachedStatusCounts;
    }

    const counts = {
      ingame: 0,
      online: 0,
      offline: 0
    };

    this.friends.forEach(f => {
      if (f.inGame) {
        counts.ingame++;
      } else if (f.status === "Offline") {
        counts.offline++;
      } else {
        counts.online++;
      }
    });

    this.cachedStatusCounts = counts;
    this.lastFriendsHash = currentHash;

    return counts;
  },

  updateFriendsList(previousFriends) {
    const tbody = document.querySelector(".steam-table tbody");
    if (!tbody) {
      this.updateDom();
      return;
    }

    const header = document.querySelector(".steam-header");
    if (header) {
      this.updateHeader();
    }

    const currentIds = new Set(this.friends.slice(0, this.config.maxFriends).map(f => f.id));
    const previousIds = new Set(previousFriends.keys());

    previousIds.forEach(id => {
      if (!currentIds.has(id)) {
        const row = this.friendsMap.get(id);
        if (row) {
          const prevFriend = previousFriends.get(id);
          const wasOnline = prevFriend && (prevFriend.status === "Online" || prevFriend.inGame);

          if (this.config.animations.enabled && this.config.animations.slideOutOffline && wasOnline) {
            row.classList.add('slide-out');
            const timeoutId = setTimeout(() => {
              if (row.parentNode) {
                row.remove();
              }
            }, ANIMATION_DURATIONS.SLIDE_OUT);
            this.pendingTimeouts.push(timeoutId);
          } else {
            row.classList.add('fade-out');
            const timeoutId = setTimeout(() => {
              if (row.parentNode) {
                row.remove();
              }
            }, ANIMATION_DURATIONS.FADE_OUT);
            this.pendingTimeouts.push(timeoutId);
          }
          this.friendsMap.delete(id);
          this.previousStates.delete(id);
        }
      }
    });

    const friendsToShow = this.friends.slice(0, this.config.maxFriends);
    friendsToShow.forEach((friend, index) => {
      const existingRow = this.friendsMap.get(friend.id);
      const previousFriend = previousFriends.get(friend.id);

      if (existingRow) {
        this.updateFriendRow(existingRow, friend, previousFriend);

        const currentIndex = Array.from(tbody.children).indexOf(existingRow);
        if (currentIndex !== index) {
          tbody.insertBefore(existingRow, tbody.children[index] || null);
        }
      } else {
        const newRow = this.createFriendRow(friend);
        const isNewlyOnline = !previousFriend && (friend.status === "Online" || friend.inGame);

        if (this.config.animations.enabled && this.config.animations.slideInOnline && isNewlyOnline) {
          newRow.classList.add('slide-in');
        } else {
          newRow.classList.add('fade-in');
        }

        tbody.insertBefore(newRow, tbody.children[index] || null);
        this.friendsMap.set(friend.id, newRow);
        this.previousStates.set(friend.id, {
          status: friend.status,
          inGame: friend.inGame
        });
      }
    });
  },

  updateFriendRow(row, newFriend, oldFriend) {
    if (!row || !oldFriend) return;

    const updates = [];

    if (newFriend.name !== oldFriend.name) {
      const nameCell = row.querySelector('.name');
      if (nameCell) {
        updates.push(() => nameCell.textContent = newFriend.name);
      }
    }

    if (newFriend.country !== oldFriend.country) {
      const flagSpan = row.querySelector('.country .flag');
      if (flagSpan) {
        updates.push(() => {
          flagSpan.className = `flag flag-${this.sanitizeCountryCode(newFriend.country)}`;
          flagSpan.title = newFriend.country.toUpperCase();
        });
      }
    }

    if (newFriend.status !== oldFriend.status) {
      const statusDot = row.querySelector('.status-indicator');
      if (statusDot) {
        updates.push(() => {
          statusDot.className = `status-indicator ${this.getStatusClass(newFriend)}`;
        });
      }

      if (this.config.animations.enabled) {
        row.classList.add('status-change');
        const timeoutId = setTimeout(() => row.classList.remove('status-change'), ANIMATION_DURATIONS.STATUS_CHANGE);
        this.pendingTimeouts.push(timeoutId);
      }
    }

    const gameChanged = newFriend.game !== oldFriend.game || newFriend.gameId !== oldFriend.gameId;
    const scoreChanged = newFriend.gameScore !== oldFriend.gameScore;

    if (gameChanged || scoreChanged) {
      const gameCell = row.querySelector('.game');
      if (gameCell) {
        updates.push(() => {
          gameCell.innerHTML = "";
          gameCell.classList.remove("game-capsule-cell");
          gameCell.appendChild(this.createGameCell(newFriend));
        });

        if (newFriend.game && this.config.animations.enabled) {
          gameCell.classList.add('game-change');
          const timeoutId = setTimeout(() => gameCell.classList.remove('game-change'), ANIMATION_DURATIONS.GAME_CHANGE);
          this.pendingTimeouts.push(timeoutId);
        }
      }
    }

    if (newFriend.inGame !== oldFriend.inGame) {
      if (newFriend.inGame) {
        row.classList.add('ingame');
        if (this.config.animations.enabled && this.config.animations.gamingPulse) {
          row.classList.add('gaming-pulse');
        }
      } else {
        row.classList.remove('ingame', 'gaming-pulse');
      }
    }

    if (updates.length > 0) {
      requestAnimationFrame(() => {
        updates.forEach(fn => fn());
      });
    }

    this.previousStates.set(newFriend.id, {
      status: newFriend.status,
      inGame: newFriend.inGame
    });
  },

  getStatusClass(friend) {
    if (friend.inGame) return 'ingame';
    if (friend.status === 'Online') return 'online';
    if (friend.status === 'Away') return 'away';
    if (friend.status === 'Busy') return 'busy';
    if (friend.status === 'Snooze') return 'snooze';
    return 'offline';
  },

  createGameCell(friend) {
    const gameWrapper = document.createElement("div");
    gameWrapper.className = "game-wrapper";

    if (!friend.game) {
      const textSpan = document.createElement("span");
      textSpan.className = "game-text";
      textSpan.textContent = "";
      gameWrapper.appendChild(textSpan);
      return gameWrapper;
    }

    if (this.config.showGameCapsule && friend.gameId) {
      const capsuleUrl = this.getGameCapsuleUrl(friend.gameId);
      if (capsuleUrl) {
        const img = document.createElement("img");
        img.src = capsuleUrl;
        img.alt = friend.game;
        img.title = friend.game;
        img.className = "game-capsule";
        if (this.config.gameCapsuleSize === "large") {
          img.classList.add("game-capsule-large");
        }
        img.loading = "lazy";
        img.onerror = () => {
          img.remove();
          const textSpan = document.createElement("span");
          textSpan.className = "game-text";
          textSpan.textContent = friend.game || "";
          gameWrapper.insertBefore(textSpan, gameWrapper.firstChild);
        };
        gameWrapper.appendChild(img);
      } else {
        const textSpan = document.createElement("span");
        textSpan.className = "game-text";
        textSpan.textContent = friend.game;
        gameWrapper.appendChild(textSpan);
      }
    } else {
      const textSpan = document.createElement("span");
      textSpan.className = "game-text";
      textSpan.textContent = friend.game;
      gameWrapper.appendChild(textSpan);
    }

    if (this.config.gameScore.enabled && friend.gameScore !== undefined) {
      const scoreBadge = this.createScoreBadge(friend.gameScore);
      gameWrapper.appendChild(scoreBadge);
    }

    return gameWrapper;
  },

  createFriendRow(friend) {
    const tr = document.createElement("tr");
    tr.className = `row ${friend.inGame ? "ingame" : ""}`;
    if (friend.inGame && this.config.animations.enabled && this.config.animations.gamingPulse) {
      tr.classList.add('gaming-pulse');
    }
    tr.dataset.friendId = friend.id;

    const statusTd = document.createElement("td");
    statusTd.className = "status-cell";
    const statusDot = document.createElement("span");
    statusDot.className = `status-indicator ${this.getStatusClass(friend)}`;
    statusTd.appendChild(statusDot);

    const avatarTd = document.createElement("td");
    avatarTd.className = "avatar";
    const avatarImg = document.createElement("img");
    avatarImg.src = this.sanitizeAvatarUrl(friend.avatar);
    avatarImg.alt = friend.name;
    avatarTd.appendChild(avatarImg);

    const flagTd = document.createElement("td");
    flagTd.className = "country";

    if (friend.country && friend.country !== "xx") {
      const flagSpan = document.createElement("span");
      flagSpan.className = `flag flag-${this.sanitizeCountryCode(friend.country)}`;
      flagSpan.title = friend.country.toUpperCase();
      flagTd.appendChild(flagSpan);
    }

    const nameTd = document.createElement("td");
    nameTd.className = "name";
    nameTd.textContent = friend.name;

    const gameTd = document.createElement("td");
    gameTd.className = "game";
    const gameWrapper = this.createGameCell(friend);

    if (this.config.showGameCapsule && friend.gameId && this.getGameCapsuleUrl(friend.gameId)) {
      gameTd.classList.add("game-capsule-cell");
    }

    gameTd.appendChild(gameWrapper);

    tr.appendChild(statusTd);
    tr.appendChild(avatarTd);
    tr.appendChild(flagTd);
    tr.appendChild(nameTd);
    tr.appendChild(gameTd);

    return tr;
  },

  sanitizeAvatarUrl(url) {
    const allowedDomains = [
      'avatars.steamstatic.com',
      'steamcdn-a.akamaihd.net',
      'avatars.akamai.steamstatic.com'
    ];

    try {
      const urlObj = new URL(url);
      if (allowedDomains.some(domain =>
        urlObj.hostname === domain || urlObj.hostname.endsWith('.' + domain)
      )) {
        return url;
      }
    } catch (e) {
      Log.error("[MMM-SteamFriends] Invalid avatar URL:", url, e);
    }

    return '';
  },

  sanitizeCountryCode(code) {
    if (!code) return 'xx';
    if (code.toLowerCase() === 'uk') return 'gb';
    return /^[a-z]{2}$/i.test(code) ? code.toLowerCase() : 'xx';
  },

  getGameCapsuleUrl(gameId) {
    if (!gameId || !/^\d+$/.test(String(gameId))) {
      return null;
    }

    const filename = this.config.gameCapsuleSize === "large"
      ? "header.jpg"
      : "capsule_231x87.jpg";

    return `https://cdn.akamai.steamstatic.com/steam/apps/${gameId}/${filename}`;
  },

  getScoreClass(score) {
    const thresholds = this.config.gameScore.thresholds;
    if (score >= thresholds.high) return "score-high";
    if (score >= thresholds.mid) return "score-mid";
    return "score-low";
  },

  createScoreBadge(score) {
    const badge = document.createElement("span");
    badge.className = `game-score-badge ${this.getScoreClass(score)}`;

    const text = this.config.gameScore.showPercentSign
      ? `${score}%`
      : `${score}`;
    badge.textContent = text;

    // Apply custom colors if configured
    const colors = this.config.gameScore.colors;
    const thresholds = this.config.gameScore.thresholds;
    if (score >= thresholds.high) {
      badge.style.color = colors.high;
    } else if (score >= thresholds.mid) {
      badge.style.color = colors.mid;
    } else {
      badge.style.color = colors.low;
    }

    return badge;
  },

  updateHeader() {
    const counts = this.getStatusCounts();
    const ingameCount = document.querySelector('.ingame-count');
    const onlineCount = document.querySelector('.online-count');
    const offlineCount = document.querySelector('.offline-count');

    if (ingameCount) ingameCount.textContent = counts.ingame;
    if (onlineCount) onlineCount.textContent = counts.online;
    if (offlineCount) offlineCount.textContent = counts.offline;
  },

  getDom() {
    const root = document.createElement("div");
    root.className = "steam-root";
    root.style.transform = `scale(${this.config.scale})`;
    root.style.transformOrigin = "top center";

    if (this.config.setup && (!this.config.steamApiKey || !this.config.steamId)) {
      const setup = document.createElement("div");
      setup.className = "steam-setup";

      const title = document.createElement("div");
      title.className = "setup-title";
      title.textContent = "Steam Friends Setup";

      const qrContainer = document.createElement("div");
      qrContainer.className = "setup-qr-container";

      const apiKeySection = document.createElement("div");
      apiKeySection.className = "setup-qr-section";

      const apiKeyLabel = document.createElement("div");
      apiKeyLabel.className = "setup-qr-label";
      apiKeyLabel.textContent = "Steam Web API Key";

      const apiKeyQr = document.createElement("img");
      apiKeyQr.className = "setup-qr-image";
      apiKeyQr.id = "qr-webapi";
      apiKeyQr.alt = "Steam API Key QR Code";

      apiKeySection.appendChild(apiKeyLabel);
      apiKeySection.appendChild(apiKeyQr);

      const steamIdSection = document.createElement("div");
      steamIdSection.className = "setup-qr-section";

      const steamIdLabel = document.createElement("div");
      steamIdLabel.className = "setup-qr-label";
      steamIdLabel.textContent = "SteamID Lookup";

      const steamIdQr = document.createElement("img");
      steamIdQr.className = "setup-qr-image";
      steamIdQr.id = "qr-friends";
      steamIdQr.alt = "SteamID Lookup QR Code";

      this.sendSocketNotification("GENERATE_QR", {
        id: 'webapi',
        url: "https://steamcommunity.com/dev/apikey"
      });

      this.sendSocketNotification("GENERATE_QR", {
        id: 'friends',
        url: "https://steamid.io"
      });

      steamIdSection.appendChild(steamIdLabel);
      steamIdSection.appendChild(steamIdQr);

      qrContainer.appendChild(apiKeySection);
      qrContainer.appendChild(steamIdSection);

      const instructions = document.createElement("div");
      instructions.className = "setup-instructions";

      const instruction1 = document.createElement("div");
      instruction1.textContent = "1. Open on phone";

      const instruction2 = document.createElement("div");
      instruction2.textContent = "2. Copy values into config.js";

      const instruction3 = document.createElement("div");
      instruction3.textContent = "3. Set setup:false after completion";

      instructions.appendChild(instruction1);
      instructions.appendChild(instruction2);
      instructions.appendChild(instruction3);

      setup.appendChild(title);
      setup.appendChild(qrContainer);
      setup.appendChild(instructions);
      root.appendChild(setup);
      return root;
    }

    const header = document.createElement("div");
    header.className = "steam-header";

    const titleSection = document.createElement("div");
    titleSection.className = "steam-header-title";

    const icon = document.createElement("span");
    icon.className = "steam-icon";
    icon.textContent = "🎮";

    const title = document.createElement("span");
    title.textContent = "STEAM FRIENDS";

    titleSection.appendChild(icon);
    titleSection.appendChild(title);

    const stats = document.createElement("div");
    stats.className = "steam-stats";

    const counts = this.getStatusCounts();

    const ingameStat = document.createElement("div");
    ingameStat.className = "stat-item";
    ingameStat.innerHTML = `<span class="stat-icon">🎮</span><span class="ingame-count">${counts.ingame}</span>`;

    const onlineStat = document.createElement("div");
    onlineStat.className = "stat-item";
    const onlineDot = document.createElement("span");
    onlineDot.className = "stat-dot online";
    const onlineCount = document.createElement("span");
    onlineCount.className = "online-count";
    onlineCount.textContent = counts.online;
    onlineStat.appendChild(onlineDot);
    onlineStat.appendChild(onlineCount);

    const offlineStat = document.createElement("div");
    offlineStat.className = "stat-item";
    const offlineDot = document.createElement("span");
    offlineDot.className = "stat-dot offline";
    const offlineCount = document.createElement("span");
    offlineCount.className = "offline-count";
    offlineCount.textContent = counts.offline;
    offlineStat.appendChild(offlineDot);
    offlineStat.appendChild(offlineCount);

    stats.appendChild(ingameStat);
    stats.appendChild(onlineStat);
    stats.appendChild(offlineStat);

    header.appendChild(titleSection);
    header.appendChild(stats);
    root.appendChild(header);

    const table = document.createElement("table");
    table.className = "steam-table";
    table.style.borderRadius = this.config.borderRadius;

    if (this.config.magicBorder.enabled) {
      table.classList.add('magic-border');
      table.style.setProperty('--magic-duration', `${this.config.magicBorder.duration}s`);
      table.style.setProperty('--magic-intensity', this.config.magicBorder.intensity);
      table.style.setProperty('--magic-blur-base', `${this.config.magicBorder.blurBase}px`);
      table.style.setProperty('--magic-blur-peak', `${this.config.magicBorder.blurPeak}px`);
      table.style.setProperty('--magic-scale-peak', this.config.magicBorder.scalePeak);
    }

    const tbody = document.createElement("tbody");

    const friendsToShow = this.friends.slice(0, this.config.maxFriends);

    friendsToShow.forEach(f => {
      const row = this.createFriendRow(f);
      this.friendsMap.set(f.id, row);
      this.previousStates.set(f.id, {
        status: f.status,
        inGame: f.inGame
      });
      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    root.appendChild(table);
    return root;
  }
});
