# MMM-SteamFriends

MagicMirror module to display Steam friends list with online and in-game status.

![MagicMirror](https://img.shields.io/badge/MagicMirror-v2.33.0-blue)
![Steam](https://img.shields.io/badge/Steam-Friends-green)
![Module](https://img.shields.io/badge/Module-Display-orange)
![Version](https://img.shields.io/badge/Version-1.2.0-green)
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

2. Get your Steam API Key here: https://steamcommunity.com/dev/apikey
3. Find your SteamID64 here: https://steamid.io/

4. Add to config/config.js:

```json
{
  module: "MMM-SteamFriends",
  position: "top_center",
  config: {
    steamId: "76561198XXXXXXXXX",
    steamApiKey: "",
    updateInterval: 60000,
    maxFriends: 5,
    sortFriends: "alphabetic",  // "alphabetic", "recentActivity", or "totalPlaytime"
    friendAllowlist: [],
    borderRadius: "16px",
    scale: 0.7,
    setup: false,
    showGameCapsule: false,
    gameCapsuleSize: "small",
    animations: {
      enabled: true,
      gamingPulse: true,
      slideInOnline: true,
      slideOutOffline: true
    },
    magicBorder: {
      enabled: false,       // Enable/disable the effect
      duration: 7,          // Animation duration in seconds
      intensity: 1.0,       // Overall intensity multiplier (0.5 - 2.0)
      blurBase: 6,          // Blur radius during calm phase (px)
      blurPeak: 18,         // Blur radius at peak glow (px)
      scalePeak: 1.18       // Border scale at peak (1.0 - 1.5)
    },
    gameScore: {
      enabled: false,       // Enable/disable game score badges (opt-in, requires additional API calls)
      refreshDays: 7,       // How often to refresh cached scores (days)
      minReviews: 50,       // Minimum reviews required to show score
      showPercentSign: true,// Show "85%" vs "85"
      colors: {
        high: "#57cbde",    // Color for scores >= 80
        mid: "#a3a3a3",     // Color for scores 50-79
        low: "#842c2c"      // Color for scores < 50
      },
      thresholds: {
        high: 80,           // Score >= this is "high"
        mid: 50             // Score >= this is "mid", below is "low"
      }
    }
  }
}
```

## V1.2.0 updates
* Header, in-game, online, offline count fix
* Optional game logos instead of text
* Optional Steam game rating ( (positive reviews / total reviews)*100 ) 
* Friend list sorting

## Usage & Notes
* API Key: Fill in your Steam ID and API key in the config section.
* Customization: Optional: adjust maxFriends, updateInterval, and position.
* Compatibility: Works on MagicMirror v2+ with MIT license.