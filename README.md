# Sidekick

A personal AI assistant in a Chrome side panel: it knows you (profile, resume, memories), helps with homework (math with code-checked answers), keeps track of deadlines, applies to jobs, and can operate web pages for you with your approval. Bring your own Anthropic or OpenAI API key.

Status: v0.9.6, Chrome MV3 extension in TypeScript, built with Vite.

## Try it
1. `npm install` and `npm run build`, then chrome://extensions → Developer mode → Load unpacked → choose `dist/`.
2. Click the Sidekick icon to open the side panel; add your API key in Settings.

## Develop
```
npm install
npx playwright install chromium
npm run build         # typecheck + build dist/ + checks (npm run dev: rebuild on change)
npm test              # jsdom suites
npm run test:unit     # Vitest unit tests
npm run test:chrome   # real Chromium with the built extension
npm run check         # lint, build and every suite
```

## Docs
- [Product plan](docs/PRODUCT_PLAN.md): what's done and what's next
- [Architecture](docs/ARCHITECTURE.md): how it works and where it's going
- [Lessons](docs/LESSONS.md): bugs that reached the user and the rules they produced
- [Security](docs/SECURITY.md): threat model and protections
- [User guide](docs/USER_GUIDE.md): features and settings
- [CLAUDE.md](CLAUDE.md): notes for Claude Code
