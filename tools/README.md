# tools

`screenshots.mjs` renders every screen in light, dark, and mobile using sample
issues, so design changes can be reviewed without spending API calls.

    npm start                      # in one terminal
    npx playwright install chromium   # once
    node tools/screenshots.mjs 3000 after

Images are written next to the script. It drives the page through `window.__seed`
and `window.__decide`, defined at the bottom of `public/index.html`.
