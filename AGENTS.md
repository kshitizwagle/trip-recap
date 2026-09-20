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

Keep domain boundaries separate:

- `app/models/`: shared Pydantic/domain models
- `app/metadata/`: EXIF/QuickTime extraction and normalization
- `app/trip/`: validation, observations, segmentation, trip construction
- `app/routing/`: routing abstraction, OSRM, caching, geometry
- `app/timeline/`: deterministic video timeline generation
- `app/api/`: HTTP endpoints only
- `app/renderer/`: browser/video rendering concerns

HTTP handlers should remain thin. Business logic belongs in services/modules, not route functions.

## Python rules

- Target Python 3.12+ unless hosting constraints require otherwise.
- Use type hints on public functions and models.
- Prefer Pydantic models for serialized domain data.
- Prefer `pathlib.Path` over string path manipulation.
- Prefer `httpx` for HTTP clients.
- Keep I/O async where it provides real benefit.
- Do not hide blocking subprocess calls inside async code. Use a thread/process boundary when needed.
- Avoid global mutable application state.

## Metadata rules

Use ExifTool as the primary metadata reader because the app must support JPEG, HEIC, MOV, and MP4 metadata consistently.

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
- Cache route responses using rounded start/end coordinates plus profile.
- Public OSRM is acceptable for development only.
- Preserve `inferred=True` on reconstructed route segments.

## Timeline rules

The timeline must be deterministic and separate from real-world timestamps.

Use nonlinear time compression so long travel gaps remain visible without dominating the video. Keep compression parameters configurable.

Browser preview and video rendering must consume the same timeline model.

## Rendering rules

MapLibre is the preferred map renderer. FFmpeg is the preferred final composition/encoding tool.

Target final output:

- 1080x1920
- 30 FPS
- H.264 video
- AAC audio when audio exists
- MP4 container

Do not make final video generation a synchronous HTTP request once rendering becomes non-trivial.

## Privacy rules

GPS metadata is sensitive.

Default behavior for hosted use should be temporary processing only. Do not persist source media or extracted GPS data beyond what is needed for the requested output unless the user explicitly opts into persistence.

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
