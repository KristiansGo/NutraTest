# NutraTest

NutraTest is a small self‑hosted tool for recording and replaying browser
interactions using [Puppeteer](https://pptr.dev/). It exposes a simple web
interface where you can create tests, run them on demand or schedule them to run
periodically.

## Features

- Record click and form input events from any URL
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

## Usage

Open your browser to `http://localhost:3000` and follow the on‑screen
instructions to create a new test. When recording starts, a separate browser
window is launched and all navigation, clicks and inputs are stored in
`/sessions/<testName>.json`.

Recorded tests can be replayed from the main page or scheduled to run at regular
intervals from `/schedule`. Screenshots and logs produced during replay are
stored in the `screenshots` directory.

## Directory overview

- `index.js` – Express server and HTTP API
- `recorder.js` – CLI recorder for manual sessions
- `replay.js` – Replays a recorded session and posts results
- `scheduler.js` – Handles queued and scheduled test runs
- `public/` – Front‑end assets
- `sessions/` – Stored session files
- `screenshots/` – Images and logs from test runs

