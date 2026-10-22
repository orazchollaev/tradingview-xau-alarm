# XAU Alarm

A Tampermonkey userscript that watches the XAU/USD price shown on TradingView and alerts you when your levels are crossed.

## Features

- **Multiple levels** — Add as many price levels as you want.
- **Smart input** — `2350`, `2350 support` (with note), `+10` / `-10` (relative to current price), `-0.5%`.
- **Direction per level** — Cycle each level between both directions (↕), upward (↑) and downward (↓) crossings.
- **Repeat mode** — Toggle ↻ to make a level re-arm itself after firing.
- **Notes** — Double-click a level to add or edit a note.
- **Alerts** — Looping alarm sound, blinking tab title, desktop notification and optional phone push through [ntfy](https://ntfy.sh).
- **Scalp tools** — Position size calculator (balance, risk %, stop → lot size and TP at your R multiple), one-click Buy/Sell that tracks live P/L and auto-creates SL/TP alarms, daily realized P/L, candle-close countdown (click to switch M1/M5/M15/H1), trading session label, quick `±5` / `±10` level buttons. P/L assumes 1 lot = 100 oz.
- **Fast move alarm** — Alerts when price moves more than a set amount (default $5) within 60 seconds.
- **Directional sounds** — Rising tone for upward crosses, falling tone for downward ones.
- **Notifications that work** — Settings has a notification button showing permission state. If the site is blocked, alerts fall back to Tampermonkey notifications.
- **Remembers everything** — Panel position, hidden/minimized state, settings panel state, sound preference, volume, levels (with direction, repeat, note and fired state) and history survive refreshes.
- **Session range** — Shows session high/low and warns when the price stops updating.
- **History** — Last triggered alerts are stored (cleanable in settings).
- **Keep screen awake** — Optional screen wake lock.
- **Shortcuts** — `Alt+X` shows/hides the panel; also available from the Tampermonkey menu. Double-click the title bar to minimize.
- **No backend or API key** — Reads the price displayed on the page.

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension.
2. Open `tradingview-xau-alarm.user.js` on GitHub, click **Raw**, and install it (or paste it into a new Tampermonkey script).
3. Open a TradingView chart that displays XAU/USD.

## Usage

- Type a level and press **Enter** or **Ekle**.
- Press **Ses kapalı** once to enable sound (browsers require a click). If sound was enabled before, it re-enables automatically on your first click on the page after a refresh. Monitoring, notifications and phone push work even while sound is off.
- **Sıfırla** re-arms all levels from the current price. **Sustur** stops a ringing alarm.
- **Ayarlar** opens volume, ring count, wake lock, phone topic, test buttons and history clearing.
- For phone push, set a hard-to-guess ntfy topic under Ayarlar → Telefon and subscribe to it in the ntfy app.

## How it works

The script reads the element matching `[data-qa-id="value"]`, checks it every second and on every DOM change, and fires when the price crosses a level (confirmed on 2 consecutive checks). Sudden jumps above 3% are ignored unless they persist, which covers symbol changes.

## Limitations

- Depends on TradingView's page structure; the selector may need updating if it changes.
- The tab must stay open and the computer awake. Browsers may throttle background tabs.
- Cannot guarantee detection of every tick. Use TradingView's built-in alerts for important levels.

## Privacy

Settings are stored by Tampermonkey. The only network request is the optional ntfy push, sent to `ntfy.sh` with the topic you choose.

## License

MIT. See [LICENSE](LICENSE).

## Disclaimer

Provided "as is", without warranty. Not affiliated with or endorsed by TradingView. Not financial advice.
