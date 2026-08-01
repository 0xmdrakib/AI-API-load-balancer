# AI Load Balancer showcase

This is a static Vercel-ready showcase for the desktop app. It is deliberately isolated from the Electron application: it does not import the app, start a server, read local storage, or access provider keys.

## Vercel

Import the repository into Vercel and leave **Root Directory** blank. The root `vercel.json` points Vercel at `website/` as the static output directory and disables the Electron/Vite app build. Use the default static deployment settings, then attach `ailoadbalancer.rakibhq.xyz` as the custom domain after the DNS record is ready. If the Vercel UI requires a root directory, selecting `website` also works.

The release buttons use stable GitHub release URLs first, then refresh to the latest release asset URLs when GitHub's public API is available. If the API is unavailable, the buttons still work.
