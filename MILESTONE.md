# Deployment isolation

Implemented: separate `frontend/` static Next.js package and `backend/` FastAPI
package, backend-only container, configurable API/CORS/render URLs, and updated CI.
The current UI and domain pipeline are retained. Tests use public-place examples
and synthetic coordinates around New York.

Local checks: Python tests, frontend tests, TypeScript checking, static production
build, and Compose configuration. Live Cloudflare Pages/home-server end-to-end
validation remains pending deployment; see `docs/deployment.md`.
