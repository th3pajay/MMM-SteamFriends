# MMM-SteamFriends

MagicMirror module to display Steam friends list with online and in-game status.

![MagicMirror](https://img.shields.io/badge/MagicMirror-v2.33.0-blue)
![Steam](https://img.shields.io/badge/Steam-Friends-green)
![Module](https://img.shields.io/badge/Module-Display-orange)
![Version](https://img.shields.io/badge/Version-1.4.76-green)
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
    steamId: "76561198XXXXXXXXX",
    steamApiKey: "",
    updateInterval: 60000,          // Poll interval in ms (default 60s)
    maxFriends: 5,                  // Max number of friends to display
    sortFriends: "alphabetic",      // "alphabetic", "recentActivity", "totalPlaytime" (requires public profiles)
    friendAllowlist: [],            // Only show these Steam IDs (empty = show all)
    borderRadius: "16px",
    scale: 0.7,
    avatarSize: "medium",           // "small" (32x32), "medium" (64x64), "full" (184x184)
    setup: false,                   // Set true for first-time setup (web form at /MMM-SteamFriends/setup)

    // Game capsule art
    showGameCapsule: false,         // Show game artwork instead of text when in-game
    gameCapsuleSize: "small",       // "small" (231x87) or "large" (header.jpg)
    showGamePlaytime: false,        // Show hours played in current game (bottom-right of capsule, requires public profiles)

    // Game score badge (top-right of capsule)
    gameScore: {
      enabled: false,               // Enable/disable game score badges (opt-in, requires additional API calls)
      refreshDays: 7,               // How often to refresh cached scores (days)
      minReviews: 50,               // Minimum reviews required to show score
      showPercentSign: true,        // Show "85%" vs "85"
      colors: {
        high: "#57cbde",            // Color for scores >= 80
        mid: "#a3a3a3",             // Color for scores 50-79
        low: "#842c2c"              // Color for scores < 50
      },
      thresholds: {
        high: 80,                   // Score >= this is "high"
        mid: 50                     // Score >= this is "mid", below is "low"
      }
    },

    animations: {
      enabled: true,
      gamingPulse: true,            // Pulse effect on in-game rows
      slideInOnline: true,          // Slide in when friend comes online
      slideOutOffline: true         // Slide out when friend goes offline
    },

    magicBorder: {
      enabled: false,               // Enable/disable the animated glow effect
      duration: 10,                 // Animation cycle duration in seconds
      intensity: 1.0,               // Overall intensity multiplier (0.5 - 2.0)
      blurBase: 4,                  // Blur radius during calm phase (px)
      blurPeak: 8,                  // Blur radius at peak glow (px)
      scalePeak: 1.12               // Border scale at peak (1.0 - 1.5)
    }
  }
}
```
## Changelog
- **1.4.76** Flattened project structure
- **1.4.75** Component positioning, glinting Steam icon
- **1.4.5**  Core/frontend/CSS refactor, async credentials, PersistentCache
- **1.4.3**  Fallback polling, batch resilience
- **1.4.2**  Platform icons, badge corner placement
- **1.4.0**  Playtime badge