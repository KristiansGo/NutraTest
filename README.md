# NutraTest

NutraTest is a small self‑hosted tool for recording and replaying browser
interactions using [Puppeteer](https://pptr.dev/). It exposes a simple web
interface where you can create tests, run them on demand or schedule them to run
periodically.

## Features

- Record click events and debounced form inputs (checkboxes and radios record instantly)
- Replay recorded tests with screenshots and optional device emulation
- Queue and schedule tests to run automatically
- View test status and manage recorded sessions from the browser

## Installation

1. Install [Node.js](https://nodejs.org/) (version 18 or later is recommended).
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the server:
   ```bash
   npm start
   ```
   The application listens on port `3000` by default. Set the `PORT` environment
   variable to use a different port.
   If Puppeteer cannot locate Chrome, set `CHROME_PATH` to the full path of your
   Chrome executable.

## Usage

Open your browser to `http://localhost:3000` and follow the on‑screen
instructions to create a new test. When recording starts, a separate browser
window is launched and all navigation, clicks and inputs are stored in `/sessions/<testName>.json`. Inputs in text fields are recorded after 300ms of inactivity, while checkboxes and radio buttons are saved immediately.

Recorded tests can be replayed from the main page or scheduled to run at regular
intervals from `/schedule`. Screenshots and logs produced during replay are
stored in the `screenshots` directory.

## Click fallback configuration

When replaying a session, `findAndClick` attempts several strategies to locate
elements. Each strategy can be toggled using CLI flags or environment
variables. This allows you to fine‑tune how aggressively the replayer searches
for elements.

| Strategy               | CLI flag             | Environment variable                |
| ---------------------- | -------------------- | ----------------------------------- |
| Search by `id`         | `--id` / `--no-id`   | `FIND_AND_CLICK_BY_ID`               |
| Search by selector     | `--selector` / `--no-selector` | `FIND_AND_CLICK_BY_SELECTOR`    |
| Search by `name`       | `--name` / `--no-name` | `FIND_AND_CLICK_BY_NAME`            |
| Exact text match       | `--exact-text` / `--no-exact-text` | `FIND_AND_CLICK_BY_EXACT_TEXT` |
| Partial text match     | `--partial-text` / `--no-partial-text` | `FIND_AND_CLICK_BY_PARTIAL_TEXT` |

Set an environment variable to `false` (e.g. `FIND_AND_CLICK_BY_NAME=false`) or
use the corresponding `--no-` flag to disable that step. Omitting these options
keeps all fallbacks enabled, preserving the default behaviour.

## Directory overview

- `index.js` – Express server and HTTP API
- `recorder.js` – CLI recorder for manual sessions
- `replay.js` – Replays a recorded session and posts results
- `scheduler.js` – Handles queued and scheduled test runs
- `public/` – Front‑end assets
- `sessions/` – Stored session files
- `screenshots/` – Images and logs from test runs

