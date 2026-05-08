# MMM-SteamFriends

MagicMirror module to display Steam friends list with online and in-game status.

![MagicMirror](https://img.shields.io/badge/MagicMirror-v2.33.0-blue)
![Steam](https://img.shields.io/badge/Steam-Friends-green)
![Module](https://img.shields.io/badge/Module-Display-orange)
![Version](https://img.shields.io/badge/Version-1.4.5-green)
![License](https://img.shields.io/badge/License-MIT-lightgrey)

<p align="center">
<img src="Media/MMM-SteamFriends.png?raw=true" alt="In-use" width="256"/>
</p>

## Installation

1. Clone into MagicMirror modules folder:
```
cd ~/MagicMirror/modules
git clone https://github.com/th3pajay/MMM-SteamFriends.git temp_steam
mv temp_steam/MMM-SteamFriends .
rm -rf temp_steam
cd MMM-SteamFriends
npm install
```

2. Add the module to `config/config.js` with `setup: true` (see config below).
3. Start MagicMirror — the mirror will display a QR code.
4. Scan the QR code (or open the URL on any device on your network).
5. Enter your Steam API key and SteamID64 in the form — the mirror updates automatically.
6. Set `setup: false` in your config so normal mode starts on next restart.

> **Manual setup alternative:** Get your API key at https://steamcommunity.com/dev/apikey and your SteamID64 at https://steamid.io/, then paste both directly into config and keep `setup: false`.

4. Add to config/config.js:

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
## V1.4.5 refactor
-Core (node_helper.js):
* Use config.updateInterval with adaptive scaling (10s–300s)
* Extract PersistentCache base class, dedupe Scores/PlaytimeCache
* Promise.allSettled in enrichWithPlaytime, skip rejected entries
* Log warning on non-401/403 fetchPlaytime errors
* Named PLATFORM_FLAGS constants replace magic bitflags
* LoadCredentials/saveCredentials converted to async/fs.promises
* Remove global.moduleInstance; add onError callback to all caches
* Add {} block scoping to case clauses in sortByConfig()
* ValidateConfig() checks API key format /^[0-9A-Fa-f]{32}$/

-Frontend (MMM-SteamFriends.js):
* Extract appendPlatformIcon() helper, dedupe friend row blocks
* Skip empty <span class="game-text"> when !friend.game

-Styles (steam.css):
* Delete dead .score-high/.score-mid/.score-low color rules
* Move statusGlow animation to :not(.offline) only
* Delete unused .steam-empty and .steam-empty-icon blocks

-Setup (setup.html):
* API key input type="password" with Show/Hide toggle

-Deps (package.json + lockfile):
* npm audit fix → 0 axios CVEs

-Docs:
* Corrected "LRU" to "FIFO" cache eviction

## V1.4.3 updates
* Fallback polling, fail to poll should not be final
* Batch summaries should be more now flexible, not sometimes discard all details
* API response if empty or unexpected should not cause crashes

## V1.4.2 updates
* GameCapsule badges, for gameScore and gamePlayTime, now should be drawn on the corners not placed horizontally
* In-game friends now have a new icon if they are playing on 'pc', 'web', 'mobile' or 'deck'

## V1.4.0 updates
* Playtime badge added (off by default, change in config)

## Usage & Notes
* API Key: Fill in your Steam ID and API key in the config section.
* Customization: Optional: adjust maxFriends, updateInterval, and position.
* Compatibility: Works on MagicMirror v2+ with MIT license.