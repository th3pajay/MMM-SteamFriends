# MMM-SteamFriends

MagicMirror module to display Steam friends list with online and in-game status.

![MagicMirror](https://img.shields.io/badge/MagicMirror-v2.33.0-blue)
![Steam](https://img.shields.io/badge/Steam-Friends-green)
![Module](https://img.shields.io/badge/Module-Display-orange)
![Version](https://img.shields.io/badge/Version-1.0.0-yellow)
![License](https://img.shields.io/badge/License-MIT-lightgrey)

## Installation

1. Clone into MagicMirror modules folder:
```git clone https://github.com/th3pajay/MMM-SteamFriends.git```

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
    friendAllowlist: [],
    borderRadius: "16px",
    scale: 0.7,
    setup: false,
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
    }
  }
}
```

## Usage & Notes
* API Key: Fill in your Steam ID and API key in the config section.
  * https://steamcommunity.com/dev/apikey
  * https://steamcommunity.com/dev/apikey
* Customization: Optional: adjust maxFriends, updateInterval, and position.
* Compatibility: Works on MagicMirror v2+ with MIT license.