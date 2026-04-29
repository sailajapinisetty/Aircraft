# World Trip Sprint

Realtime multiplayer map game using Node.js, Express, and Socket.IO.

## Local Run

```bash
npm install
npm start
```

Open `http://localhost:3000`.

If people are on the same Wi-Fi, share `http://YOUR_LOCAL_IP:3000`.

## Render Deploy

1. Push this repo to GitHub.
2. In Render, create a new `Web Service` from the repo.
3. Render can use the included `render.yaml`, or set these manually:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. After deploy, share the Render URL with players.

## Railway Deploy

1. Create a new project from this GitHub repo in Railway.
2. Railway should detect Node automatically.
3. Confirm the start command is `npm start`.
4. After deploy, share the Railway URL with players.

## Multiplayer Behavior

- The first player to join becomes admin.
- Other players join the same shared round.
- Everyone sees the participant list.
- The admin sees all markings.
- Each non-admin player sees only their own markings.

## Notes

- GitHub Pages is not suitable for the live multiplayer version because it cannot run the Node.js server.
- The Firebase files in this repo are no longer used for the Socket.IO deployment path.