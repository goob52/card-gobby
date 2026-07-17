# Card Goblin Online

Browser-based two-player Card Goblin with room codes, server-controlled game state, sound effects, meld/block actions, and opponent cursor tracking.

## Upload this project to GitHub

1. Create a new empty GitHub repository.
2. Extract this ZIP.
3. Upload **the contents of this folder** to the repository root. Do not upload the unopened ZIP.
4. Commit the files.

The repository root should contain:

```text
public/
package.json
server.js
render.yaml
README.md
.gitignore
```

## Host it online through Render

GitHub Pages cannot run this project because multiplayer requires Node.js and Socket.IO.

1. Sign in to Render and choose **New > Blueprint**.
2. Connect the GitHub repository.
3. Select the included `render.yaml` file.
4. Deploy it.
5. Open the Render URL after deployment completes.

Render will use:

- Build command: `npm install`
- Start command: `npm start`
- Port: supplied automatically through `process.env.PORT`

## Run locally

Install Node.js 18 or newer, then run:

```bash
npm install
npm start
```

Open `http://localhost:3000` in a browser.

## Multiplayer notes

- Player 1 creates a room.
- Player 2 opens the same deployed address and joins with the room code.
- Active games live in server memory and reset when the server restarts.
