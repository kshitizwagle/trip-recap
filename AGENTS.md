# AGENTS.md

This file defines implementation rules for humans and coding agents working in this repository.

## Product contract

Trip Recap is metadata-first. The normal workflow must not require users to manually enter coordinates, destinations, or route stops.

Observed facts come from uploaded media metadata. Roads between observations are inferred and must remain distinguishable from observed GPS data.

Missing GPS or timestamps must be represented explicitly. Do not invent metadata to make the pipeline look complete.

## MVP scope

Build the pipeline in this order:

1. metadata extraction
2. trip analysis
3. routing
4. timeline generation
5. browser preview
6. video rendering
7. hardening

Do not add AI, image recognition, automatic music selection, place-name generation, accounts, persistent galleries, or elaborate transition systems unless the milestone plan is explicitly changed.

## Architecture

Trip Recap is frontend-only: a static Next.js export with no server. Media is processed in the
browser and never uploaded. Keep domain boundaries separate under `src/lib/engine/`:

- `models.ts`: shared domain types
- `metadata/`: EXIF/QuickTime extraction and normalization
- `trip.ts`: validation, observations, segmentation, trip construction
- `routing.ts`: routing abstraction, OSRM, caching, observation progress
- `timeline.ts`: deterministic video timeline generation
- `places.ts`: Nominatim place names and search
- `analyze.ts`: orchestration that turns media into trip payloads
- `mp4.ts`: MP4 container writing

`src/lib/trip-api.ts` is the only module the UI calls; it wires the engine to browser
APIs. `src/lib/recap-export.ts` owns video rendering. Engine modules stay free of DOM
and React so they run under `node --test`. Do not add a server, serverless function or required
API key unless the milestone plan is explicitly changed.

## TypeScript rules

- Engine modules import each other with explicit `.ts` extensions so Node's type stripping can run the tests.
- Avoid TypeScript-only runtime syntax (parameter properties, enums, namespaces) in engine modules.
- Inject `fetch`, clocks and sleeps into network clients so tests stay deterministic.
- Keep caches of GPS-derived data in memory only.

## Metadata rules

Read metadata with the built-in parser in `engine/metadata/`, which must support JPEG, HEIC, PNG, WebP, MOV and MP4 consistently. Field names follow ExifTool's so provenance stays comparable.

Timestamp priority:

Photos:

1. `DateTimeOriginal`
2. `CreateDate`
3. `MediaCreateDate`

Videos:

1. `MediaCreateDate`
2. `TrackCreateDate`
3. `CreateDate`

Filesystem modification time is not a normal capture-time source.

Preserve metadata provenance such as `timestamp_source` so incorrect device metadata can be debugged.

GPS validation must reject impossible coordinate ranges and flag implausible travel speeds rather than silently deleting points.

## Trip analysis rules

- Sort by normalized capture time.
- Cluster nearby media instead of routing between every file.
- Default initial clustering thresholds may use roughly 150 m and 30 minutes, but keep them configurable.
- Trip segmentation should consider both time gaps and geographic discontinuity.
- Timestamp-only media can be associated with a time interval, but its location must remain inferred/unknown.

## Routing rules

- Route pairwise between consecutive observations.
- Use a `Router` abstraction instead of coupling trip code directly to OSRM.
- Initial profile is `driving`.
- Cache route responses in memory using rounded start/end coordinates plus profile.
- The browser calls the public OSRM demo by default; keep the base URL configurable for self-hosting.
- Preserve `inferred=True` on reconstructed route segments.

## Timeline rules

The timeline must be deterministic and separate from real-world timestamps.

Use nonlinear time compression so long travel gaps remain visible without dominating the video. Keep compression parameters configurable.

Browser preview and video rendering must consume the same timeline model.

## Rendering rules

MapLibre is the map renderer. Export renders frames in the browser, encodes H.264 with WebCodecs and writes the MP4 with `engine/mp4.ts`. Wait for map tiles before capturing each frame.

Target final output:

- 1080x1920
- 30 FPS
- H.264 video
- MP4 container (no audio track)

Export must show progress and be cancellable.

## Privacy rules

GPS metadata is sensitive.

Media never leaves the device. Do not persist source media or extracted GPS data (including in `localStorage` or IndexedDB) unless the user explicitly opts into persistence. Only coordinates needed for routing and place names may go to those services.

## Testing rules

Every milestone should add focused tests for its domain logic.

Prefer deterministic unit tests and mocked routing responses over live network tests.

Important fixture classes eventually include:

- iPhone HEIC photo
- iPhone MOV video
- Android JPEG
- Android MP4
- media without GPS
- media without capture time
- edited media with changed metadata

## Git rules

- Commit at each milestone boundary.
- Keep commits scoped to the milestone.
- Update `TODO.md` and `MILESTONE.md` when milestone status changes.
- Do not mix visual polish into metadata/routing commits.
- Do not commit uploaded user media, extracted private GPS fixtures, secrets, or generated videos.

## Definition of done

A milestone is complete only when its core implementation is present, its important behavior is testable, and serialized output remains explicit about observed versus inferred data.

<!-- ASTRYX:START -->
Astryx v0.6.2 · 164 components
CLI: run every command as `npx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — discover, don't guess. Before writing UI:
1. `astryx build "<idea>"` — START HERE: returns a kit (closest [page] + [block]s + [component]s). No args = full playbook.
2. `astryx template <name> [--skeleton]` — scaffold the [page]/[block]s it named, or study their layout. Templates are reference code.
3. `astryx component <Name>` — props + examples for every component you use.

RULES:
- No <div> — components do all layout/spacing, page frame included.
- Frame first: read `astryx docs layout` before writing any page or screen — page frame, region widths, breakpoint behavior.
- Dense data = rows (Table, List/Item), never Card-wrapped list items; Card is for standalone widgets. Status = StatusDot/Token; Badge = counts only.
- Custom styling: component props first; else style/className with tokens — var(--color-*|--spacing-*|--radius-*). No raw hex/px. (No StyleX/Tailwind compiler here — don't use xstyle/utility classes.)
- Tokens for every value (`astryx docs tokens`). Brand/accent belongs in the theme (`astryx theme list` / `theme add <slug>`, or `astryx theme template` for a custom one) — never override --color-* in :root.
- SELF-CHECK before you finish: re-read the file and replace any raw <div>/<span> layout, imported .css/@apply, or hardcoded value (#hex, 16px) with the component or a token (var(--color-*|--spacing-*|…)). If unsure a component/prop exists, run `astryx component <Name>` / `astryx search "<thing>"`; don't hand-roll CSS.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   164 components by category
  template --list    page + block recipes
  docs <topic>       browser-support, cli-integrations, color, elevation, getting-started, icons, illustrations, internationalization, layout, migration, motion, principles, shape, spacing, styling-libraries, styling, theme, tokens, typography, working-with-ai
  swizzle <Name>     eject component source for deep customization
  upgrade --apply    run after any Astryx or integration dependency bump
<!-- ASTRYX:END -->

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**This project has a knowledge graph. Start with the code-review-graph
MCP tools to narrow scope, then read the source.** The graph is cheaper than scanning files and
gives you structural context (callers, dependents, test coverage) that file search cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes_tool` or `query_graph_tool` instead of Grep
- **Understanding impact**: `get_impact_radius_tool` instead of manually tracing imports
- **Code review**: `detect_changes_tool` + `get_review_context_tool` instead of reading entire files
- **Finding relationships**: `query_graph_tool` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview_tool` + `list_communities_tool`

### Verify in the source

- Narrow scope with the graph, then read the source. Do not change code from graph output alone.
- For any non-trivial change, read the implementation and the relevant tests before concluding.
- Verify the exact source when touching behavior, database logic, migrations, retries, fallbacks,
  recovery, or compatibility code.
- When the graph and the source disagree, the source wins. The graph may be stale or may not
  model that relationship.
- An empty graph result can mean "not indexed" or "not statically visible", not "does not exist".

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes_tool` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context_tool` | Need source snippets for review — token-efficient |
| `get_impact_radius_tool` | Understanding blast radius of a change |
| `get_affected_flows_tool` | Finding which execution paths are impacted |
| `query_graph_tool` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes_tool` | Finding functions/classes by name or keyword |
| `get_architecture_overview_tool` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes_tool` for code review.
3. Use `get_affected_flows_tool` to understand impact.
4. Use `query_graph_tool` pattern="tests_for" to check coverage.
<!-- /code-review-graph MCP tools -->

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
