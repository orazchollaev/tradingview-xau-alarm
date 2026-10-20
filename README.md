# XAU Alarm

A lightweight Tampermonkey userscript for monitoring XAU/USD prices on TradingView.

XAU Alarm adds a draggable, resizable floating panel to TradingView with customizable price targets, audio alerts, and persistent settings.

## Features

- **Live price monitoring** — Reads the displayed XAU/USD price from TradingView.
- **Custom price target** — Set and change your own alarm level.
- **Audio alerts** — Plays a distinctive sound when the target is reached.
- **Draggable panel** — Move the floating window anywhere on the page.
- **Resizable window** — Adjust the panel size to fit your workspace.
- **Minimize and hide** — Collapse or hide the panel while monitoring continues.
- **Persistent settings** — Saves the target price, panel position, and dimensions.
- **Reset control** — Reset the triggered alarm state without deleting your target.
- **Price formatting** — Handles common decimal and thousands separators.
- **Lightweight** — No external price API, backend, or API key required.

## Requirements

- Google Chrome or another browser compatible with Tampermonkey.
- The [Tampermonkey browser extension](https://www.tampermonkey.net/).
- A TradingView page displaying an XAU/USD price.

## Installation

### Step 1: Install Tampermonkey

1. Visit the [official Tampermonkey website](https://www.tampermonkey.net/).
2. Select your browser.
3. Install the extension from your browser's official extension store.
4. Make sure Tampermonkey is enabled.

### Step 2: Install XAU Alarm

**Option A: Install from GitHub**

1. Open this repository on GitHub.
2. Open the `tradingview-xau-alarm.user.js` file.
3. Click the **Raw** button.
4. If Tampermonkey opens an installation page, review the script and click **Install**.
5. If the installation page does not appear, follow Option B.

**Option B: Install manually**

1. Click the Tampermonkey extension icon.
2. Select **Create a new script**.
3. Delete the default example code.
4. Open `tradingview-xau-alarm.user.js` from this repository.
5. Copy the entire JavaScript file.
6. Paste the code into the Tampermonkey editor.
7. Press `Ctrl + S` to save the script.

### Step 3: Open TradingView

1. Visit [TradingView](https://www.tradingview.com/).
2. Open a chart displaying the XAU/USD price.
3. Refresh the page if the panel does not appear.
4. Enter your desired alarm target when prompted.

### Step 4: Enable Audio

1. Find the XAU Alarm floating panel.
2. Click **Enable sound and test**.
3. Confirm that the test sound plays.
4. Keep the TradingView tab open while monitoring prices.

Your alarm is now ready.

## Usage

### Set a Price Target

Enter your desired XAU/USD target when prompted.

Use **Change target** to enter a new price. Your target is saved and restored when the userscript starts again.

### Audio Alerts

The alarm triggers when the displayed price crosses the target upward.

If the current price is already at or above the target when sound is enabled, the alarm triggers immediately.

A user interaction is required to enable audio playback because of browser autoplay restrictions.

### Window Controls

- **Drag:** Move the panel by dragging its title bar.
- **Resize:** Drag the bottom-right corner of the window.
- **Minimize:** Collapse the panel while keeping monitoring active.
- **Hide:** Hide the panel and use the floating dock to reopen it.
- **Reset:** Clear the triggered alarm state and prepare for a new upward crossing.

### Persistent Settings

The userscript stores the following settings through Tampermonkey:

- Alarm target price
- Panel position
- Panel width and height

These settings can be restored when the userscript runs again.

## How It Works

XAU Alarm reads the visible price element using the following CSS selector: `[data-qa-id="value"]`.

It checks the displayed value periodically and compares it with the configured target.

The userscript uses Tampermonkey's storage API for persistent settings and the browser's Web Audio API for alarm sounds.

No separate price API, external backend, or API key is required.

## Limitations

- Monitoring depends on TradingView's page structure and displayed price element.
- TradingView may change its page structure, requiring an update to the price selector.
- The script reads displayed page values and cannot guarantee detection of every market tick.
- The TradingView tab must remain open for monitoring to continue.
- The computer must remain awake.
- Browser audio restrictions require an initial user interaction.
- If the price element becomes unavailable, price monitoring may be interrupted.
- Hiding the panel does not stop monitoring, but closing the TradingView tab does.
- The userscript does not execute trades or provide financial advice.

## Troubleshooting

### The Panel Does Not Appear

- Make sure Tampermonkey is enabled.
- Check that the XAU Alarm userscript is enabled.
- Refresh the TradingView page.
- Verify that the current page matches the script's supported URL pattern.

### The Current Price Is Not Displayed

TradingView may have changed its page structure, or the selected chart may not expose the expected price element.

The userscript currently looks for the `[data-qa-id="value"]` selector. This selector may need to be updated if TradingView changes its interface.

### No Sound Plays

- Click the sound button to enable audio.
- Check your browser and system volume.
- Make sure the tab is not muted.
- Click the sound button again if the browser suspended audio playback.

### The Alarm Did Not Trigger

Verify that the target price is correct and that the displayed XAU/USD price crossed it upward while the script was running.

For important price levels, use TradingView's built-in alerts as a backup.

## Privacy

XAU Alarm does not require a separate account, external API key, or backend server.

Its saved settings are managed by Tampermonkey. The userscript reads the visible price displayed on the TradingView page.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Disclaimer

This project is provided "as is", without warranty of any kind.

It is an independent community project and is not affiliated with or endorsed by TradingView.

This userscript is for informational purposes only. It does not provide financial advice, guarantee price accuracy, or execute trades.

Always verify important price alerts with your broker or TradingView's built-in alert system.
