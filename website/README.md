# AI Load Balancer showcase

This is a static Vercel-ready showcase for the desktop app. It is deliberately isolated from the Electron application: it does not import the app, start a server, read local storage, or access provider keys.

## Vercel

Create a Vercel project from this repository and set **Root Directory** to `website`. Use the default static deployment settings. Attach `ailoadbalancer.rakibhq.xyz` as the custom domain after the DNS record is ready.

The release buttons use stable GitHub release URLs first, then refresh to the latest release asset URLs when GitHub's public API is available. If the API is unavailable, the buttons still work.
