const LEGACY_KEYS = [
  "setup", "steamId", "steamApiKey", "updateInterval", "friendAllowlist", "borderRadius", "maxFriends", "sortFriends",
  "scale", "avatarSize", "density", "accent", "panelOpacity", "stateColors", "showTicker", "showLiveDot", "showSessionTimer",
  "dimOffline", "collapseOffline", "recentOffline", "showGameCapsule", "gameCapsuleSize", "animations", "magicBorder",
  "showGamePlaytime", "achievementProgress", "gameScore", "topGames"
];

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function deepMerge(base, extra) {
  const out = { ...base };
  Object.keys(extra).forEach(key => {
    out[key] = isPlainObject(out[key]) && isPlainObject(extra[key]) ? deepMerge(out[key], extra[key]) : extra[key];
  });
  return out;
}

function resolveConfig(userConfig, defaults = {}) {
  const raw = deepMerge(defaults, userConfig);
  const { account = {}, friends = {}, look = {}, header = {}, games = {} } = raw;
  const motion = look.motion || "calm";
  const offline = friends.offline || "collapse";
  const capsule = games.capsule || "off";
  const achievements = games.achievements || "off";
  const score = games.score || {};
  const top = isPlainObject(games.topGames) ? games.topGames : { enabled: games.topGames === true };
  const animated = motion !== "off";

  const resolved = {
    steamId: account.steamId ?? "",
    steamApiKey: account.steamApiKey ?? "",
    updateInterval: friends.interval,
    maxFriends: friends.max,
    sortFriends: friends.sort,
    friendAllowlist: friends.allowlist,
    collapseOffline: offline === "collapse",
    dimOffline: offline === "collapse" || offline === "dim",
    hideOffline: offline === "hide",
    recentOffline: friends.recentOffline,
    density: look.density,
    accent: look.accent,
    scale: look.scale,
    panelOpacity: look.opacity,
    borderRadius: look.radius,
    avatarSize: look.avatar,
    stateColors: look.colors,
    motion,
    animations: {
      enabled: animated,
      gamingPulse: animated,
      slideInOnline: animated,
      slideOutOffline: animated,
      slideInDuration: 400,
      slideOutDuration: 400,
      fadeInDuration: 300,
      fadeOutDuration: 300
    },
    magicBorder: { enabled: Boolean(look.glow), duration: 10, intensity: 1, blurBase: 4, blurPeak: 8, scalePeak: 1.12 },
    showTicker: header.ticker,
    showLiveDot: header.live,
    showGameCapsule: capsule !== "off",
    gameCapsuleSize: capsule === "large" ? "large" : "small",
    achievementProgress: { enabled: achievements !== "off", refreshMinutes: 10, style: achievements === "split" ? "split" : "bar" },
    showGamePlaytime: games.playtime,
    showSessionTimer: games.timer,
    gameScore: {
      enabled: Boolean(score.enabled),
      refreshDays: 7,
      minReviews: score.minReviews,
      showPercentSign: true,
      colors: score.colors,
      thresholds: score.thresholds
    },
    topGames: {
      enabled: Boolean(top.enabled),
      cycleInterval: top.cycle,
      rotateInterval: top.rotate,
      transitionSpeed: Math.round((top.rotate || 4000) / 10)
    }
  };

  LEGACY_KEYS.forEach(key => {
    if (raw[key] === undefined) return;
    const value = key === "topGames" && typeof raw[key] === "boolean" ? { enabled: raw[key] } : raw[key];
    resolved[key] = isPlainObject(resolved[key]) && isPlainObject(value) ? deepMerge(resolved[key], value) : value;
  });

  resolved.setup = raw.setup === true || (!resolved.steamId && !resolved.steamApiKey);
  return resolved;
}

const CAROUSEL_CLASSES = ["carousel-active", "carousel-flip-out", "carousel-flip-mid", "carousel-flip-in"];
const MAX_SLIDES = 4;

class TopGamesCarousel {
  constructor({ settings, capsuleUrl }) {
    this.enabled = Boolean(settings?.enabled);
    this.cycleInterval = settings?.cycleInterval ?? 30000;
    this.rotateInterval = settings?.rotateInterval ?? 4000;
    this.transitionSpeed = settings?.transitionSpeed ?? 400;
    this.capsuleUrl = capsuleUrl;
    this.states = new Map();
    this.timers = new Set();
    this.clock = null;
  }

  static waitTicks(cycleInterval, rotateInterval) {
    return Math.max(1, Math.round(cycleInterval / rotateInterval));
  }

  static alignTicks(reference, waitTicks) {
    if (!reference) return waitTicks;
    if (reference.slideIndex === 0) return reference.ticksRemaining;
    return reference.slides.length - reference.slideIndex + waitTicks;
  }

  static buildSlides(friend) {
    const current = String(friend.gameId);
    const others = friend.topGames
      .filter(g => String(g.gameId) !== current)
      .map(g => ({ id: String(g.gameId), name: g.name }));
    return [{ id: current, name: friend.game }, ...others].slice(0, MAX_SLIDES);
  }

  get waitTicks() {
    return TopGamesCarousel.waitTicks(this.cycleInterval, this.rotateInterval);
  }

  has(friendId) {
    return this.states.has(friendId);
  }

  sync(friend, row) {
    if (!this.enabled || !friend.inGame || !friend.topGames?.length) {
      this.stop(friend.id);
      return;
    }
    const existing = this.states.get(friend.id);
    if (existing && existing.gameId === String(friend.gameId) && existing.wrapper.isConnected) return;
    const wrapper = row.querySelector(".game-wrapper");
    if (wrapper) this.start(friend, wrapper);
  }

  start(friend, wrapper) {
    this.stop(friend.id);
    const slides = TopGamesCarousel.buildSlides(friend);
    if (slides.length < 2) return;

    const reference = this.states.values().next().value;
    wrapper.classList.add("carousel-active");
    const state = {
      gameId: slides[0].id,
      slides,
      slideIndex: 0,
      ticksRemaining: TopGamesCarousel.alignTicks(reference, this.waitTicks),
      wrapper,
      pendingFlip: null
    };
    this.states.set(friend.id, state);
    this.preloadNext(state);
    if (!this.clock) this.clock = setInterval(() => this.tick(), this.rotateInterval);
  }

  stop(friendId) {
    const state = this.states.get(friendId);
    if (!state) return;
    clearTimeout(state.pendingFlip);
    state.wrapper.classList.remove(...CAROUSEL_CLASSES);
    this.states.delete(friendId);
    if (this.states.size === 0) this.stopClock();
  }

  reset() {
    this.states.forEach(state => {
      clearTimeout(state.pendingFlip);
      state.wrapper.classList.remove(...CAROUSEL_CLASSES);
    });
    this.states.clear();
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.stopClock();
  }

  stopClock() {
    clearInterval(this.clock);
    this.clock = null;
  }

  tick() {
    this.states.forEach(state => {
      if (state.ticksRemaining > 0) {
        state.ticksRemaining--;
        return;
      }
      state.slideIndex = (state.slideIndex + 1) % state.slides.length;
      this.flip(state);
      this.preloadNext(state);
      if (state.slideIndex === 0) state.ticksRemaining = this.waitTicks;
    });
  }

  preloadNext(state) {
    const url = this.capsuleUrl(state.slides[(state.slideIndex + 1) % state.slides.length].id);
    if (url) new Image().src = url;
  }

  flip(state) {
    const img = state.wrapper.querySelector(".game-capsule");
    const slide = state.slides[state.slideIndex];
    const url = this.capsuleUrl(slide.id);
    if (!img || !url) return;

    const half = Math.round(this.transitionSpeed / 2);
    img.classList.remove("carousel-flip-in");
    img.classList.add("carousel-flip-out");

    clearTimeout(state.pendingFlip);
    state.pendingFlip = setTimeout(() => {
      img.src = url;
      img.alt = img.title = slide.name ?? "";
      state.wrapper.classList.toggle("carousel-top-game", state.slideIndex !== 0);

      img.classList.remove("carousel-flip-out");
      img.classList.add("carousel-flip-mid");
      void img.offsetWidth;
      img.classList.remove("carousel-flip-mid");
      img.classList.add("carousel-flip-in");

      const timer = setTimeout(() => {
        this.timers.delete(timer);
        img.classList.remove("carousel-flip-in");
      }, half);
      this.timers.add(timer);
    }, half);
  }
}

const AVATAR_HOSTS = ["avatars.steamstatic.com", "steamcdn-a.akamaihd.net", "avatars.akamai.steamstatic.com"];
const PLATFORM_ICONS = { pc: "pc.svg", web: "web.svg", mobile: "steam.svg", deck: "deck.svg" };
const STATUS_CLASSES = { Online: "online", Away: "away", Busy: "busy", Snooze: "snooze" };
const TIMINGS = { SLIDE_OUT: 400, FADE_OUT: 300, SWEEP: 1400, REORDER: 440 };
const NEW_BADGE_MS = 60000;
const EASE = "cubic-bezier(.2,.7,.2,1)";

const isOffline = (friend) => !friend.inGame && friend.status === "Offline";
const isFresh = (friend, now) => Boolean(friend.started && friend.since && now - friend.since < NEW_BADGE_MS);

function gameCapsuleUrl(gameId, size) {
  if (!gameId || !/^\d+$/.test(String(gameId))) return null;
  const file = size === "large" ? "header.jpg" : "capsule_231x87.jpg";
  return `https://cdn.akamai.steamstatic.com/steam/apps/${gameId}/${file}`;
}

function sanitizeAvatarUrl(url) {
  try {
    const host = new URL(url).hostname;
    if (AVATAR_HOSTS.some(allowed => host === allowed || host.endsWith("." + allowed))) return url;
  } catch (e) {
    Log.error("[MMM-SteamFriends] Invalid avatar URL:", url, e);
  }
  return "";
}

function sanitizeCountryCode(code) {
  if (!code) return "xx";
  if (code.toLowerCase() === "uk") return "gb";
  return /^[a-z]{2}$/i.test(code) ? code.toLowerCase() : "xx";
}

function formatPlaytime(minutes) {
  const hours = Math.round(minutes / 60);
  if (hours < 1000) return `${hours}h`;
  const k = hours / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}kh`;
}

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatAgo(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

function statusClass(friend) {
  return friend.inGame ? "ingame" : STATUS_CLASSES[friend.status] || "offline";
}

function subText(friend, now, showTimer) {
  if (friend.inGame) return showTimer && friend.since ? `Playing · ${formatDuration(now - friend.since)}` : "Playing";
  if (isOffline(friend)) return friend.lastLogOff ? `Last seen ${formatAgo(now / 1000 - friend.lastLogOff)} ago` : "Offline";
  return friend.status;
}

function gameCellKey(friend) {
  return JSON.stringify([
    friend.game, friend.gameId, friend.gameScore, friend.gamePlaytime,
    friend.achievementPct, friend.platform, friend.inGame
  ]);
}

function visibleFriends(allFriends, { collapseOffline, recentOffline, maxFriends, hideOffline }, expanded) {
  const friends = hideOffline ? allFriends.filter(f => !isOffline(f)) : allFriends;
  const offline = friends.filter(isOffline);
  const collapsible = collapseOffline && offline.length > recentOffline;
  let list = friends;
  if (collapsible && !expanded) {
    const recent = new Set([...offline].sort((a, b) => (b.lastLogOff || 0) - (a.lastLogOff || 0)).slice(0, recentOffline));
    list = friends.filter(f => !isOffline(f) || recent.has(f));
  }
  const shown = list.slice(0, maxFriends);
  const hidden = collapsible && !expanded ? offline.length - shown.filter(isOffline).length : 0;
  return { shown, hidden, collapsible };
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

class FriendRows {
  constructor({ config, carousel, iconUrl, later }) {
    this.config = config;
    this.carousel = carousel;
    this.iconUrl = iconUrl;
    this.later = later;
    this.rows = new Map();
    this.leaving = new Set();
    this.order = [];
    this.expanded = false;
    this.summary = null;
    this.tbody = null;
    this.friends = [];
  }

  mount(tbody, friends) {
    this.rows.clear();
    this.summary = null;
    this.tbody = tbody;
    this.friends = friends;
    const { shown, hidden, collapsible } = visibleFriends(friends, this.config, this.expanded);
    this.order = shown.map(f => f.id);
    shown.forEach(friend => {
      const row = this.buildRow(friend);
      this.rows.set(friend.id, { row, friend, cellKey: gameCellKey(friend) });
      tbody.appendChild(row);
      this.carousel.sync(friend, row);
    });
    this.syncSummary(hidden, collapsible);
  }

  reconcile(tbody, friends, previousIds) {
    const anim = this.config.animations;
    this.tbody = tbody;
    this.friends = friends;
    const { shown, hidden, collapsible } = visibleFriends(friends, this.config, this.expanded);
    const shownIds = new Set(shown.map(f => f.id));
    const order = shown.map(f => f.id);
    const reordered = order.length !== this.order.length || order.some((id, i) => id !== this.order[i]);
    const before = anim.enabled && reordered ? this.measure() : null;
    this.order = order;

    for (const [id, { row, friend }] of this.rows) {
      if (shownIds.has(id)) continue;
      const slide = anim.enabled && anim.slideOutOffline && (friend.status === "Online" || friend.inGame);
      row.classList.add(slide ? "slide-out" : "fade-out");
      this.leaving.add(row);
      this.later(() => {
        row.remove();
        this.leaving.delete(row);
      }, slide
        ? anim.slideOutDuration ?? TIMINGS.SLIDE_OUT
        : anim.fadeOutDuration ?? TIMINGS.FADE_OUT);
      this.carousel.stop(id);
      this.rows.delete(id);
    }

    shown.forEach((friend, index) => {
      let entry = this.rows.get(friend.id);
      const created = !entry;

      if (created) {
        const row = this.buildRow(friend);
        const arrived = !previousIds.has(friend.id) && (friend.status === "Online" || friend.inGame);
        row.classList.add(anim.enabled && anim.slideInOnline && arrived ? "slide-in" : "fade-in");
        entry = { row, friend, cellKey: gameCellKey(friend) };
        this.rows.set(friend.id, entry);
      } else {
        this.patch(entry, friend);
      }

      if (tbody.children[index] !== entry.row) tbody.insertBefore(entry.row, tbody.children[index] || null);
      if (created) this.carousel.sync(friend, entry.row);
    });

    shown.forEach(friend => {
      if (!this.carousel.has(friend.id)) this.carousel.sync(friend, this.rows.get(friend.id).row);
    });

    this.syncSummary(hidden, collapsible);
    if (before) this.flip(before);
  }

  measure() {
    const tops = new Map();
    this.rows.forEach(({ row }, id) => tops.set(id, row.getBoundingClientRect().top));
    return tops;
  }

  flip(before) {
    const moves = [];
    before.forEach((top, id) => {
      const row = this.rows.get(id)?.row;
      const delta = row && top - row.getBoundingClientRect().top;
      if (Math.abs(delta) >= 1) moves.push([row, delta]);
    });
    moves.forEach(([row, delta]) => row.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
      { duration: TIMINGS.REORDER, easing: EASE }
    ));
  }

  settle() {
    this.leaving.forEach(row => row.remove());
    this.leaving.clear();
    this.rows.forEach(({ row }) => row.classList.remove("sweep"));
  }

  syncSummary(hidden, collapsible) {
    if (!hidden && !(this.expanded && collapsible)) {
      this.summary?.remove();
      this.summary = null;
      return;
    }
    if (!this.summary) {
      const cell = el("td", { colSpan: 5 });
      this.summary = el("tr", { className: "more-row" }, [cell]);
      this.summary.onclick = () => {
        this.expanded = !this.expanded;
        this.reconcile(this.tbody, this.friends, new Set(this.friends.map(f => f.id)));
      };
    }
    this.summary.firstChild.textContent = this.expanded ? "Show fewer" : `+${hidden} more offline`;
    this.tbody.appendChild(this.summary);
  }

  refreshTimes() {
    const now = Date.now();
    this.rows.forEach(({ row, friend }) => {
      this.setSub(row, friend, now);
      this.setBadge(row, friend, now);
    });
  }

  setSub(row, friend, now) {
    const sub = row.querySelector(".sub");
    const text = subText(friend, now, this.config.showSessionTimer);
    if (sub && sub.textContent !== text) sub.textContent = text;
  }

  setBadge(row, friend, now) {
    const tag = row.querySelector(".tag-new");
    if (tag) tag.hidden = !isFresh(friend, now);
  }

  sweep(row) {
    if (!this.config.animations.enabled) return;
    row.classList.add("sweep");
    this.later(() => row.classList.remove("sweep"), TIMINGS.SWEEP);
  }

  patch(entry, friend) {
    const { row, friend: old } = entry;
    const anim = this.config.animations;
    const cellKey = gameCellKey(friend);
    const now = Date.now();
    entry.friend = friend;

    const nameLink = row.querySelector(".name-link");
    if (nameLink && friend.name !== old.name) nameLink.textContent = friend.name;

    const flag = row.querySelector(".country .flag");
    if (flag && friend.country !== old.country) {
      flag.className = `flag flag-${sanitizeCountryCode(friend.country)}`;
      flag.title = (friend.country || "").toUpperCase();
    }

    if (friend.status !== old.status) {
      const dot = row.querySelector(".status-indicator");
      if (dot) dot.className = `status-indicator ${statusClass(friend)}`;
      this.sweep(row);
    }

    const cell = row.querySelector(".game");
    if (cell && cellKey !== entry.cellKey) {
      entry.cellKey = cellKey;
      this.fillGameCell(cell, friend);
      this.carousel.sync(friend, row);
      if (friend.game) this.sweep(row);
    }

    if (friend.inGame !== old.inGame) {
      row.classList.toggle("ingame", friend.inGame);
      row.classList.toggle("gaming-pulse", Boolean(friend.inGame && anim.enabled && anim.gamingPulse));
    }
    row.classList.toggle("dim", Boolean(isOffline(friend) && this.config.dimOffline));

    this.setSub(row, friend, now);
    this.setBadge(row, friend, now);
  }

  buildRow(friend) {
    const anim = this.config.animations;
    const now = Date.now();
    const tr = el("tr", { className: `row ${friend.inGame ? "ingame" : ""}` });
    if (friend.inGame && anim.enabled && anim.gamingPulse) tr.classList.add("gaming-pulse");
    if (isOffline(friend) && this.config.dimOffline) tr.classList.add("dim");
    tr.dataset.friendId = friend.id;
    tr.addEventListener("animationend", (event) => {
      if (event.target === tr && /^(fade|slide)In$/.test(event.animationName)) tr.classList.remove("fade-in", "slide-in");
    });

    const flagCell = el("td", { className: "country" });
    if (friend.country && friend.country !== "xx") {
      flagCell.appendChild(el("span", {
        className: `flag flag-${sanitizeCountryCode(friend.country)}`,
        title: friend.country.toUpperCase()
      }));
    }

    const nameLink = el("a", {
      className: "name-link",
      href: `https://steamcommunity.com/profiles/${friend.id}`,
      target: "_blank",
      rel: "noopener noreferrer",
      textContent: friend.name
    });
    const badge = el("span", { className: "tag tag-new", textContent: "NEW" });
    const sub = el("div", { className: "sub" });
    const gameCell = el("td", { className: "game" });
    this.fillGameCell(gameCell, friend);

    tr.append(
      el("td", { className: "status-cell" }, [el("span", { className: `status-indicator ${statusClass(friend)}` })]),
      el("td", { className: "avatar" }, [el("img", { src: sanitizeAvatarUrl(friend.avatar), alt: friend.name })]),
      flagCell,
      el("td", { className: "name" }, [el("div", { className: "name-line" }, [nameLink, badge]), sub]),
      gameCell
    );
    this.setSub(tr, friend, now);
    this.setBadge(tr, friend, now);
    return tr;
  }

  fillGameCell(cell, friend) {
    cell.replaceChildren();
    const hasCapsule = this.config.showGameCapsule && friend.gameId && this.capsuleUrl(friend.gameId);
    cell.classList.toggle("game-capsule-cell", Boolean(hasCapsule));

    if (friend.inGame) {
      const src = friend.platform && PLATFORM_ICONS[friend.platform];
      cell.appendChild(src ? el("img", { className: "platform-icon", src: this.iconUrl(src) }) : el("span", { className: "platform-icon" }));
    }

    cell.appendChild(this.buildGameWrapper(friend));
  }

  capsuleUrl(gameId) {
    return gameCapsuleUrl(gameId, this.config.gameCapsuleSize);
  }

  buildGameWrapper(friend) {
    const wrapper = el("div", { className: "game-wrapper" });
    if (!friend.game) return wrapper;

    const storeUrl = friend.gameId && /^\d+$/.test(String(friend.gameId))
      ? `https://store.steampowered.com/app/${friend.gameId}`
      : null;
    const target = storeUrl
      ? el("a", { className: "game-link", href: storeUrl, target: "_blank", rel: "noopener noreferrer" })
      : wrapper;

    if (this.config.showGameCapsule && friend.gameId) {
      const url = this.capsuleUrl(friend.gameId);
      target.appendChild(url ? this.buildCapsule(friend, url, target) : this.buildCapsuleText(friend.game));
    } else {
      target.appendChild(el("span", { className: "game-text", textContent: friend.game }));
    }

    if (storeUrl) wrapper.appendChild(target);
    if (this.config.gameScore.enabled && friend.gameScore !== undefined) {
      wrapper.appendChild(this.buildScoreBadge(friend.gameScore));
    }
    if (this.config.showGamePlaytime && friend.gamePlaytime !== undefined) {
      wrapper.appendChild(el("span", { className: "game-playtime-badge", textContent: formatPlaytime(friend.gamePlaytime) }));
    }
    return wrapper;
  }

  buildCapsule(friend, url, target) {
    const img = el("img", {
      src: url,
      alt: friend.game,
      title: friend.game,
      className: "game-capsule"
    });
    if (this.config.gameCapsuleSize === "large") img.classList.add("game-capsule-large");
    img.onerror = () => {
      img.remove();
      target.insertBefore(this.buildCapsuleText(friend.game), target.firstChild);
    };

    const pct = friend.achievementPct;
    const progress = this.config.achievementProgress;
    if (!progress?.enabled || pct === undefined) {
      return el("div", { className: "capsule-wrap" }, [img]);
    }

    const layers = [img];
    if (progress.style === "split") {
      const grey = el("img", { src: url, className: "capsule-grey-layer" });
      grey.setAttribute("aria-hidden", "true");
      grey.style.clipPath = `inset(0 0 0 ${pct}%)`;
      const divider = el("div", { className: "achievement-divider" });
      divider.style.left = `${pct}%`;
      layers.push(grey, divider);
    } else {
      const fill = el("b");
      fill.style.transform = `scaleX(${pct / 100})`;
      layers.push(el("i", { className: "ach-bar" }, [fill]));
    }
    if (pct === 100) layers.push(el("span", { className: "capsule-trophy", textContent: "🏆" }));
    return el("div", { className: "capsule-wrap" }, [el("div", { className: "capsule-frame" }, layers)]);
  }

  buildCapsuleText(name) {
    const wrap = el("span", { className: "game-text game-text-capsule" }, [
      el("span", { className: "game-text-scroll", textContent: name || "" })
    ]);
    if (this.config.gameCapsuleSize === "large") wrap.classList.add("game-text-capsule-lg");
    return wrap;
  }

  buildScoreBadge(score) {
    const { colors, thresholds, showPercentSign } = this.config.gameScore;
    const tier = score >= thresholds.high ? "high" : score >= thresholds.mid ? "mid" : "low";
    const badge = el("span", {
      className: `game-score-badge score-${tier}`,
      textContent: showPercentSign ? `${score}%` : `${score}`
    });
    badge.style.color = colors[tier];
    return badge;
  }
}

const STEAM_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z"/></svg>';
const TICKER_INTERVAL = 4500;
const LIVE_INTERVAL = 10000;
const STALE_AFTER_FACTOR = 2;
const STALE_GRACE_MS = 15000;
const ROLL_MS = 380;
const ROLL_EASE = "cubic-bezier(.2,.7,.2,1)";

function countFriends(friends) {
  const counts = { ingame: 0, online: 0, offline: 0 };
  friends.forEach(f => {
    if (f.inGame) counts.ingame++;
    else if (f.status === "Offline") counts.offline++;
    else counts.online++;
  });
  return counts;
}

function tickerItems(friends) {
  const games = new Map();
  friends.filter(f => f.inGame && f.game).forEach(f => games.set(f.game, (games.get(f.game) || 0) + 1));
  const items = [...games].map(([game, n]) => `${game} · ${n} ${n > 1 ? "friends" : "friend"}`);
  return items.length ? items : ["Nobody is playing right now"];
}

function connectionState(status, now) {
  if (!status) return null;
  if (!status.ok) return "error";
  return now - status.lastOk > status.nextIn * STALE_AFTER_FACTOR + STALE_GRACE_MS ? "stale" : "live";
}

function liveText(conn, status, now) {
  if (conn === "error") return "API error · retrying";
  const age = Math.max(0, now - status.lastOk);
  const text = age < 60000 ? `${Math.max(1, Math.round(age / 1000))}s` : `${Math.round(age / 60000)}m`;
  return conn === "stale" ? `Stale · ${text}` : `Live · ${text}`;
}

function headerEl(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

class Header {
  constructor({ config }) {
    this.config = config;
    this.animate = Boolean(config.animations?.enabled);
    this.friends = [];
    this.status = null;
    this.icon = null;
    this.refs = {};
    this.timers = [];
    this.tickerIndex = 0;
    this.tickerSlot = 0;
    this.tickerText = "";
  }

  build({ updateAvailable }) {
    this.stop();
    this.tickerText = "";
    this.tickerSlot = 0;
    const root = headerEl("div", "steam-header");
    const top = headerEl("div", "steam-header-top");
    const title = headerEl("div", "steam-header-title");
    this.icon = headerEl("span", "steam-icon", STEAM_ICON);
    title.append(this.icon, headerEl("span", "", "STEAM FRIENDS"));
    if (updateAvailable) {
      const arrow = headerEl("a", "header-update-arrow", "⬆");
      arrow.href = "https://github.com/th3pajay/MMM-SteamFriends";
      arrow.target = "_blank";
      arrow.title = "Update available";
      title.appendChild(arrow);
    }
    top.appendChild(title);

    this.refs = {};
    if (this.config.showLiveDot) {
      this.refs.live = headerEl("div", "steam-live");
      this.refs.liveDot = headerEl("i", "steam-live-dot");
      this.refs.liveText = headerEl("span");
      this.refs.live.hidden = true;
      this.refs.live.append(this.refs.liveDot, this.refs.liveText);
      top.appendChild(this.refs.live);
    }

    const pills = headerEl("div", "steam-pills");
    [["ingame", "In game"], ["online", "Online"], ["offline", "Offline"]].forEach(([key, label]) => {
      const num = headerEl("b", "num");
      this.refs[key] = num;
      const pill = headerEl("div", "steam-pill");
      pill.dataset.k = key;
      pill.append(headerEl("i"), headerEl("small", "", label), num);
      pills.appendChild(pill);
    });

    this.refs.bar = headerEl("div", "steam-bar", "<i class=\"bar-online\"></i><i class=\"bar-ingame\"></i>");
    root.append(top, pills, this.refs.bar);

    if (this.config.showTicker) {
      this.refs.ticker = headerEl("div", "steam-ticker", "<span></span><span></span>");
      root.appendChild(this.refs.ticker);
    }

    this.update(this.friends);
    this.renderLive(false);
    this.start();
    return root;
  }

  start() {
    this.stopTimers();
    if (this.refs.ticker) this.timers.push(setInterval(() => { this.tickerIndex++; this.showTicker(false); }, TICKER_INTERVAL));
    if (this.refs.live) this.timers.push(setInterval(() => this.renderLive(false), LIVE_INTERVAL));
  }

  stopTimers() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  stop() {
    this.stopTimers();
  }

  update(friends) {
    this.friends = friends;
    if (!this.refs.ingame) return;
    const counts = countFriends(friends);
    const total = friends.length || 1;
    this.setNumber(this.refs.ingame, counts.ingame);
    this.setNumber(this.refs.online, counts.online);
    this.setNumber(this.refs.offline, counts.offline);
    const [online, ingame] = this.refs.bar.children;
    online.style.transform = `scaleX(${(friends.length - counts.offline) / total})`;
    ingame.style.transform = `scaleX(${counts.ingame / total})`;
    if (this.refs.ticker) this.showTicker(!this.tickerText);
  }

  setNumber(node, value) {
    const text = String(value);
    const previous = node.dataset.v;
    if (previous === text) return;
    node.dataset.v = text;
    if (previous === undefined || !this.animate) {
      node.textContent = text;
      return;
    }
    const dir = Number(text) > Number(previous) ? 1 : -1;
    const out = headerEl("span", "", previous);
    const incoming = headerEl("span", "", text);
    node.replaceChildren(out, incoming);
    out.animate(
      [{ transform: "none", opacity: 1 }, { transform: `translateY(${-dir * 100}%)`, opacity: 0 }],
      { duration: ROLL_MS, easing: ROLL_EASE, fill: "forwards" }
    );
    incoming.animate(
      [{ transform: `translateY(${dir * 100}%)`, opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: ROLL_MS, easing: ROLL_EASE, fill: "forwards" }
    ).onfinish = () => { if (node.dataset.v === text) node.textContent = text; };
  }

  showTicker(instant) {
    const items = tickerItems(this.friends);
    const text = items[this.tickerIndex % items.length];
    if (!instant && text === this.tickerText) return;
    this.tickerText = text;
    const spans = this.refs.ticker.children;
    const current = spans[this.tickerSlot];
    const next = spans[1 - this.tickerSlot];
    next.textContent = text;
    this.tickerSlot = 1 - this.tickerSlot;
    if (instant || !this.animate) {
      next.style.opacity = 1;
      current.style.opacity = 0;
      return;
    }
    next.animate(
      [{ opacity: 0, transform: "translateY(7px)" }, { opacity: 1, transform: "none" }],
      { duration: ROLL_MS + 40, easing: ROLL_EASE, fill: "forwards" }
    );
    current.animate(
      [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-7px)" }],
      { duration: ROLL_MS + 40, easing: ROLL_EASE, fill: "forwards" }
    );
  }

  setStatus(status) {
    const fresh = !this.status || status.lastOk !== this.status.lastOk;
    this.status = status;
    this.renderLive(fresh);
  }

  renderLive(ping) {
    if (!this.refs.live) return;
    const now = Date.now();
    const conn = connectionState(this.status, now);
    this.refs.live.hidden = !conn;
    if (!conn) return;
    this.refs.live.dataset.conn = conn;
    this.refs.liveText.textContent = liveText(conn, this.status, now);
    if (ping && this.animate && conn === "live") {
      this.refs.liveDot.classList.remove("ping");
      void this.refs.liveDot.offsetWidth;
      this.refs.liveDot.classList.add("ping");
    }
  }
}

if (typeof module !== "undefined") {
  module.exports = { resolveConfig, TopGamesCarousel, FriendRows, Header, gameCapsuleUrl, sanitizeCountryCode, formatPlaytime, formatDuration, formatAgo, statusClass, gameCellKey, subText, visibleFriends, isFresh, countFriends, tickerItems, connectionState, liveText };
}
