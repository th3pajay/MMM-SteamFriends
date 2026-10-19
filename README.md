# MMM-SteamFriends

MagicMirror module to display Steam friends list with online and in-game status.

![MagicMirror](https://img.shields.io/badge/MagicMirror-v2.33.0-blue)
![Steam](https://img.shields.io/badge/Steam-Friends-green)
![Module](https://img.shields.io/badge/Module-Display-orange)
![Version](https://img.shields.io/badge/Version-1.5.04-green)
![License](https://img.shields.io/badge/License-MIT-lightgrey)

<p align="center">
<img src="Media/MMM-SteamFriends.png?raw=true" alt="In-use" width="256"/>
</p>

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/th3pajay/MMM-SteamFriends.git
cd MMM-SteamFriends
npm install
```

Add to `config/config.js`:

```json
{
  module: "MMM-SteamFriends",
  position: "top_center",
  config: {
    account: {
      steamId: "76561198XXXXXXXXX",
      steamApiKey: ""                // Leave both empty to open the setup page at /MMM-SteamFriends/setup
    },

    friends: {
      interval: 60000,               // Poll interval in ms
      max: 5,                        // Max rows displayed (includes the "+N more offline" row)
      sort: "alphabetic",            // "alphabetic", "recentActivity", "totalPlaytime" (public profiles)
      allowlist: [],                 // Only show these Steam IDs (empty = show all)
      offline: "collapse",           // "collapse" (dimmed + summary row), "dim", "show", "hide"
      recentOffline: 3               // Offline friends kept visible while collapsed
    },

    look: {
      density: "normal",            // "compact", "normal", "roomy"
      accent: "cyan",               // "cyan", "green", "violet", "amber" or any hex color
      scale: 0.7,
      opacity: 0.92,                // Panel opacity, 0.3 - 1
      radius: "16px",
      avatar: "medium",             // "small" (32x32), "medium" (64x64), "full" (184x184)
      colors: {                     // Color per friend state
        ingame: "#00e676",
        online: "#38bdf8",
        away: "#ffb300",
        busy: "#ff6b35",
        offline: "#667085"
      },
      motion: "calm",               // "calm", "full" (adds slow breathing dots), "off"
      glow: false                   // Animated glow around the panel
    },

    header: {
      ticker: true,                 // Rotating "what is being played" line
      live: true                    // Live / stale / error indicator
    },

    games: {
      capsule: "off",               // "off", "small" (231x87), "large" (header.jpg): game art for in-game friends
      achievements: "off",          // "off", "bar", "split" (needs capsule, public profile)
      playtime: false,              // Hours played in the current game (public profile)
      timer: true,                  // "Playing · 1h 20m", counted from when the mirror first saw the game

      score: {                      // Steam review score badge (extra API calls)
        enabled: false,
        minReviews: 50,
        colors: { high: "#57cbde", mid: "#a3a3a3", low: "#842c2c" },
        thresholds: { high: 80, mid: 50 }
      },

      topGames: {                   // Carousel of the friend's most played games (needs capsule, public profile)
        enabled: false,
        cycle: 30000,               // ms the current game stays shown between flips
        rotate: 4000                // ms each top-game slide is shown
      }
    }
  }
}
```

Every option is optional; the example above lists all of them with their defaults. A minimal config only needs the account:

```json
config: { account: { steamId: "76561198XXXXXXXXX", steamApiKey: "" } }
```

Configs written for earlier versions (flat keys such as `maxFriends`, `showGameCapsule`, `animations`, `magicBorder`) keep working unchanged.


## Changelog
- **1.5.03** Header with labelled counters, proportion bar, now-playing ticker and live/stale/error dot; grouped, shorter config (old keys still work); session timer and NEW tag for in-game friends; achievement progress bar; offline friends dimmed with last seen and collapsed to a summary row; rows glide to new positions; calm event-driven motion; CSS-variable theming (accent, state colors, density, panel opacity); in-game friends' sessions, playtime and achievements refresh correctly; fewer Steam API calls
- **1.4.95** Better polling, no flickering friend list, long game titles scroll not overshoot module
- **1.4.92** Clickable friend, played game information cells
- **1.4.91** Polling, network drop, no country code UI fixes 
- **1.4.88** Added top3 games flipping on gamecapsule, only for currently playing friends
- **1.4.84** Achievement progress capsule split (color/grey proportional), trophy icon at 100%, 3D capsule depth, badge readability improvements, update notification arrow
- **1.4.76** Flattened project structure
- **1.4.75** Component positioning, glinting Steam icon
- **1.4.5**  Core/frontend/CSS refactor, async credentials, PersistentCache
- **1.4.3**  Fallback polling, batch resilience
- **1.4.2**  Platform icons, badge corner placement
- **1.4.0**  Playtime badge