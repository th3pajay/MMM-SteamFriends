const ANIMATION_DURATIONS = {
  SLIDE_OUT: 400,
  FADE_OUT: 300,
  SLIDE_IN: 400,
  STATUS_CHANGE: 500,
  GAME_CHANGE: 500
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
      slideOutOffline: true,
      slideInDuration: 400,
      slideOutDuration: 400,
      fadeInDuration: 300,
      fadeOutDuration: 300
    },
    magicBorder: {
      enabled: false,
      duration: 10,
      intensity: 1.0,
      blurBase: 4,
      blurPeak: 8,
      scalePeak: 1.12
    },
    showGamePlaytime: false,
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
    },
    topGames: {
      enabled: false,
      cycleInterval: 30000,
      rotateInterval: 4000,
      transitionSpeed: 400
    }
  },

  start() {
    this.friends = [];
    this.friendsMap = new Map();
    this.previousStates = new Map();
    this.cachedStatusCounts = null;
    this._statusVersion = 0;
    this._statusCacheVersion = -1;
    this.pendingTimeouts = [];
    this.carouselTimers = new Map();
    this.masterClock = null;
    if (this.config.topGames === true) {
      this.config.topGames = { enabled: true, cycleInterval: 30000, rotateInterval: 4000, transitionSpeed: 400 };
    }
    this.steamIconEl = null;
    this.updateAvailable = false;
    this.scheduleGlintCycle();
    this.sendSocketNotification("INIT", this.config);
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
        const previousFriends = new Map(this.friends.map(f => [f.id, f]));
        this.friends = payload;
        this._statusVersion++;
        this.updateFriendsList(previousFriends);
        break;
      }
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
    this.carouselTimers.forEach(state => {
      clearTimeout(state.pendingFade);
      state.gameWrapper?.classList.remove('carousel-active', 'carousel-flip-out', 'carousel-flip-mid', 'carousel-flip-in');
    });
    this.carouselTimers.clear();
    this.stopMasterClock();
    this.sendSocketNotification("SUSPEND");
  },

  resume() {
    this.sendSocketNotification("RESUME");
  },

  getStatusCounts() {
    if (this._statusVersion === this._statusCacheVersion && this.cachedStatusCounts) {
      return this.cachedStatusCounts;
    }
    const counts = { ingame: 0, online: 0, offline: 0 };
    this.friends.forEach(f => {
      if (f.inGame) counts.ingame++;
      else if (f.status === "Offline") counts.offline++;
      else counts.online++;
    });
    this.cachedStatusCounts = counts;
    this._statusCacheVersion = this._statusVersion;
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
            }, this.config.animations.slideOutDuration ?? ANIMATION_DURATIONS.SLIDE_OUT);
            this.pendingTimeouts.push(timeoutId);
          } else {
            row.classList.add('fade-out');
            const timeoutId = setTimeout(() => {
              if (row.parentNode) {
                row.remove();
              }
            }, this.config.animations.fadeOutDuration ?? ANIMATION_DURATIONS.FADE_OUT);
            this.pendingTimeouts.push(timeoutId);
          }
          this.stopCarousel(id);
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

        if (tbody.children[index] !== existingRow) {
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
        this.syncCarousel(friend, newRow);
      }
    });

    // Restart carousels for existing rows missing one (e.g. after resume)
    friendsToShow.forEach(friend => {
      if (!this.carouselTimers.has(friend.id)) {
        const row = this.friendsMap.get(friend.id);
        if (row) this.syncCarousel(friend, row);
      }
    });
  },

  updateFriendRow(row, newFriend, oldFriend) {
    if (!row || !oldFriend) return;

    const updates = [];

    if (newFriend.name !== oldFriend.name) {
      const nameLink = row.querySelector('.name-link');
      if (nameLink) {
        updates.push(() => nameLink.textContent = newFriend.name);
      }
    }

    if (newFriend.country !== oldFriend.country) {
      const flagSpan = row.querySelector('.country .flag');
      if (flagSpan) {
        updates.push(() => {
          flagSpan.className = `flag flag-${this.sanitizeCountryCode(newFriend.country)}`;
          flagSpan.title = (newFriend.country || "").toUpperCase();
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
          if (this.config.showGameCapsule && newFriend.gameId && this.getGameCapsuleUrl(newFriend.gameId)) {
            gameCell.classList.add("game-capsule-cell");
          }
          this.appendPlatformIcon(gameCell, newFriend);
          gameCell.appendChild(this.createGameCell(newFriend));
          this.syncCarousel(newFriend, row);
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

  appendPlatformIcon(container, friend) {
    if (!friend.inGame || !friend.platform) return;
    const src = this.getPlatformIconSrc(friend.platform);
    if (src) {
      const icon = document.createElement('img');
      icon.className = 'platform-icon';
      icon.src = src;
      container.appendChild(icon);
    }
  },

  createGameCell(friend) {
    const gameWrapper = document.createElement("div");
    gameWrapper.className = "game-wrapper";

    if (!friend.game) {
      return gameWrapper;
    }

    const storeUrl = friend.gameId && /^\d+$/.test(String(friend.gameId))
      ? `https://store.steampowered.com/app/${friend.gameId}`
      : null;
    const gameTarget = storeUrl
      ? Object.assign(document.createElement("a"), {
          className: "game-link",
          href: storeUrl,
          target: "_blank",
          rel: "noopener noreferrer"
        })
      : gameWrapper;

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
          gameTarget.insertBefore(textSpan, gameTarget.firstChild);
        };
        const capsuleWrap = document.createElement('div');
        capsuleWrap.className = 'capsule-wrap';
        if (this.config.achievementProgress?.enabled && friend.achievementPct !== undefined) {
          const frame = document.createElement('div');
          frame.className = 'capsule-frame';
          frame.appendChild(img);
          const greyImg = document.createElement('img');
          greyImg.src = capsuleUrl;
          greyImg.className = 'capsule-grey-layer';
          greyImg.setAttribute('aria-hidden', 'true');
          greyImg.style.clipPath = `inset(0 0 0 ${friend.achievementPct}%)`;
          frame.appendChild(greyImg);
          const divider = document.createElement('div');
          divider.className = 'achievement-divider';
          divider.style.left = `${friend.achievementPct}%`;
          frame.appendChild(divider);
          if (friend.achievementPct === 100) {
            const trophy = document.createElement('span');
            trophy.className = 'capsule-trophy';
            trophy.textContent = '🏆';
            frame.appendChild(trophy);
          }
          capsuleWrap.appendChild(frame);
        } else {
          capsuleWrap.appendChild(img);
        }
        gameTarget.appendChild(capsuleWrap);
      } else {
        const textSpan = document.createElement("span");
        textSpan.className = "game-text";
        textSpan.textContent = friend.game;
        gameTarget.appendChild(textSpan);
      }
    } else {
      const textSpan = document.createElement("span");
      textSpan.className = "game-text";
      textSpan.textContent = friend.game;
      gameTarget.appendChild(textSpan);
    }

    if (storeUrl) {
      gameWrapper.appendChild(gameTarget);
    }

    if (this.config.gameScore.enabled && friend.gameScore !== undefined) {
      const scoreBadge = this.createScoreBadge(friend.gameScore);
      gameWrapper.appendChild(scoreBadge);
    }

    if (this.config.showGamePlaytime && friend.gamePlaytime !== undefined) {
      gameWrapper.appendChild(this.createPlaytimeBadge(friend.gamePlaytime));
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
    const nameLink = document.createElement("a");
    nameLink.className = "name-link";
    nameLink.href = `https://steamcommunity.com/profiles/${friend.id}`;
    nameLink.target = "_blank";
    nameLink.rel = "noopener noreferrer";
    nameLink.textContent = friend.name;
    nameTd.appendChild(nameLink);

    const gameTd = document.createElement("td");
    gameTd.className = "game";
    const gameWrapper = this.createGameCell(friend);

    if (this.config.showGameCapsule && friend.gameId && this.getGameCapsuleUrl(friend.gameId)) {
      gameTd.classList.add("game-capsule-cell");
    }

    this.appendPlatformIcon(gameTd, friend);
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

  getPlatformIconSrc(platform) {
    const map = { pc: 'pc.svg', web: 'web.svg', mobile: 'steam.svg', deck: 'deck.svg' };
    return map[platform] ? this.file(`icons/${map[platform]}`) : null;
  },

  stopCarousel(friendId) {
    const state = this.carouselTimers.get(friendId);
    if (!state) return;
    clearTimeout(state.pendingFade);
    state.gameWrapper?.classList.remove('carousel-active', 'carousel-flip-out', 'carousel-flip-mid', 'carousel-flip-in');
    this.carouselTimers.delete(friendId);
    if (this.carouselTimers.size === 0) this.stopMasterClock();
  },

  startMasterClock() {
    if (this.masterClock) return;
    const rotateInterval = this.config.topGames?.rotateInterval ?? 4000;
    this.masterClock = setInterval(() => this.tickAllCarousels(), rotateInterval);
  },

  stopMasterClock() {
    clearInterval(this.masterClock);
    this.masterClock = null;
  },

  getCycleWaitTicks() {
    const cfg = this.config.topGames;
    const cycleInterval = cfg?.cycleInterval ?? 30000;
    const rotateInterval = cfg?.rotateInterval ?? 4000;
    return Math.max(1, Math.round(cycleInterval / rotateInterval));
  },

  tickAllCarousels() {
    this.carouselTimers.forEach(state => {
      if (state.ticksRemaining > 0) {
        state.ticksRemaining--;
        return;
      }
      state.slideIndex = (state.slideIndex + 1) % state.slides.length;
      this.flipToSlide(state);
      if (state.slideIndex === 0) {
        state.ticksRemaining = this.getCycleWaitTicks();
      }
    });
  },

  flipToSlide(state) {
    const transitionSpeed = this.config.topGames?.transitionSpeed ?? 400;
    const halfSpeed = Math.round(transitionSpeed / 2);
    const img = state.gameWrapper.querySelector('.game-capsule');
    if (!img) return;
    const nextUrl = this.getGameCapsuleUrl(state.slides[state.slideIndex]);
    if (!nextUrl) return;
    const isCurrentGame = state.slideIndex === 0;

    img.classList.remove('carousel-flip-in');
    img.classList.add('carousel-flip-out');

    clearTimeout(state.pendingFade);
    state.pendingFade = setTimeout(() => {
      img.src = nextUrl;
      img.alt = isCurrentGame ? state.friend.game : (state.friend.topGames[state.slideIndex - 1]?.name ?? '');
      img.title = img.alt;
      const greyLayer = state.gameWrapper.querySelector('.capsule-grey-layer');
      const divider = state.gameWrapper.querySelector('.achievement-divider');
      const trophy = state.gameWrapper.querySelector('.capsule-trophy');
      if (greyLayer) greyLayer.style.opacity = isCurrentGame ? '' : '0';
      if (divider) divider.style.opacity = isCurrentGame ? '' : '0';
      if (trophy) trophy.style.opacity = isCurrentGame ? '' : '0';
      state.gameWrapper.classList.toggle('carousel-top-game', !isCurrentGame);

      img.classList.remove('carousel-flip-out');
      img.classList.add('carousel-flip-mid');
      void img.offsetWidth;
      img.classList.remove('carousel-flip-mid');
      img.classList.add('carousel-flip-in');

      const t = setTimeout(() => img.classList.remove('carousel-flip-in'), halfSpeed);
      this.pendingTimeouts.push(t);
    }, halfSpeed);
  },

  syncCarousel(friend, row) {
    if (!this.config.topGames?.enabled || !friend.inGame || !friend.topGames?.length) {
      this.stopCarousel(friend.id);
      return;
    }
    const existing = this.carouselTimers.get(friend.id);
    if (existing && existing.gameId === String(friend.gameId)) return;
    const gameWrapper = row.querySelector('.game-wrapper');
    if (gameWrapper) this.startTopGamesCarousel(friend, gameWrapper);
  },

  startTopGamesCarousel(friend, gameWrapper) {
    this.stopCarousel(friend.id);
    const currentGameId = String(friend.gameId);
    const slides = [
      currentGameId,
      ...friend.topGames.map(g => String(g.gameId)).filter(id => id !== currentGameId)
    ].slice(0, 4);
    if (slides.length < 2) return;

    const waitTicks = this.getCycleWaitTicks();
    let ticksRemaining = waitTicks;
    const existingState = this.carouselTimers.values().next().value;
    if (existingState) {
      if (existingState.slideIndex === 0) {
        ticksRemaining = existingState.ticksRemaining;
      } else {
        ticksRemaining = (existingState.slides.length - existingState.slideIndex) + waitTicks;
      }
    }

    gameWrapper.classList.add('carousel-active');
    this.carouselTimers.set(friend.id, {
      gameId: currentGameId,
      slides,
      slideIndex: 0,
      ticksRemaining,
      gameWrapper,
      friend,
      pendingFade: null
    });
    this.startMasterClock();
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

    const { colors, thresholds } = this.config.gameScore;
    badge.style.color = score >= thresholds.high ? colors.high
      : score >= thresholds.mid ? colors.mid : colors.low;

    return badge;
  },

  formatPlaytime(minutes) {
    const hours = Math.round(minutes / 60);
    if (hours < 1000) return `${hours}h`;
    const k = hours / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}kh`;
  },

  createPlaytimeBadge(minutes) {
    const badge = document.createElement("span");
    badge.className = "game-playtime-badge";
    badge.textContent = this.formatPlaytime(minutes);
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

      const qrImg = document.createElement("img");
      qrImg.className = "setup-qr-image";
      qrImg.id = "qr-setup";
      qrImg.alt = "Setup QR Code";

      if (this.setupUrl) {
        this.sendSocketNotification("GENERATE_QR", { id: 'setup', url: this.setupUrl });
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

      setup.appendChild(title);
      setup.appendChild(qrImg);
      setup.appendChild(urlText);
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
    this.steamIconEl = icon;
    icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z"/></svg>';

    const title = document.createElement("span");
    title.textContent = "STEAM FRIENDS";

    titleSection.appendChild(icon);
    titleSection.appendChild(title);

    if (this.updateAvailable) {
      const arrow = document.createElement('a');
      arrow.className = 'header-update-arrow';
      arrow.href = 'https://github.com/th3pajay/MMM-SteamFriends';
      arrow.target = '_blank';
      arrow.title = 'Update available';
      arrow.textContent = '⬆';
      titleSection.appendChild(arrow);
    }

    const stats = document.createElement("div");
    stats.className = "steam-stats";

    const counts = this.getStatusCounts();

    const ingameStat = document.createElement("div");
    ingameStat.className = "stat-item";
    ingameStat.innerHTML = `<span class="stat-icon">🎮</span><span class="ingame-count">${counts.ingame}</span>`;

    const onlineStat = document.createElement("div");
    onlineStat.className = "stat-item";
    onlineStat.innerHTML = `<span class="stat-dot online"></span><span class="online-count">${counts.online}</span>`;

    const offlineStat = document.createElement("div");
    offlineStat.className = "stat-item";
    offlineStat.innerHTML = `<span class="stat-dot offline"></span><span class="offline-count">${counts.offline}</span>`;

    stats.appendChild(ingameStat);
    stats.appendChild(onlineStat);
    stats.appendChild(offlineStat);

    header.appendChild(titleSection);
    header.appendChild(stats);
    root.appendChild(header);

    const table = document.createElement("table");
    table.className = "steam-table";
    table.style.borderRadius = this.config.borderRadius;

    const anim = this.config.animations;
    table.style.setProperty('--slide-in-duration', `${anim.slideInDuration ?? 400}ms`);
    table.style.setProperty('--slide-out-duration', `${anim.slideOutDuration ?? 400}ms`);
    table.style.setProperty('--fade-in-duration', `${anim.fadeInDuration ?? 300}ms`);
    table.style.setProperty('--fade-out-duration', `${anim.fadeOutDuration ?? 300}ms`);

    if (this.config.topGames?.enabled) {
      table.style.setProperty('--carousel-transition-speed', `${this.config.topGames.transitionSpeed ?? 400}ms`);
    }

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
  },

  scheduleGlintCycle() {
    const mins = [];
    while (mins.length < 3) {
      const m = Math.floor(Math.random() * 60);
      if (!mins.includes(m)) mins.push(m);
    }
    mins.forEach(m => {
      const t = setTimeout(() => this.triggerIconGlint(), m * 60000);
      this.pendingTimeouts.push(t);
    });
    const t = setTimeout(() => this.scheduleGlintCycle(), 3600000);
    this.pendingTimeouts.push(t);
  },

  triggerIconGlint() {
    if (!this.steamIconEl) return;
    this.steamIconEl.classList.add("glinting");
    const t = setTimeout(() => this.steamIconEl?.classList.remove("glinting"), 700);
    this.pendingTimeouts.push(t);
  }
});
