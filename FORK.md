# Project lineage

CF-Server-Monitor Speed is maintained independently by leon4z.

- Upstream source: https://github.com/huilang-me/CF-Server-Monitor
- Upstream baseline: `1be24f0eabdcc2d06c215c45258382b02e438b49`
- Personal fork base for v0.1.0: `82477f446a9f15ad62c80bb369e93a612c703826` from `leon4z/CF-Server-Monitor:personal`
- Independent repository: https://github.com/leon4z/cf-server-monitor-speed

## Changes

1. Self-host the original JetBrains Mono v24 font subsets with their original
   weights and Unicode ranges. Vite produces content-hashed local assets;
   `/files/jetbrains-mono-OFL.txt` includes the copyright and SIL OFL. Existing
   `font-display: swap` and the default font stack are retained.
2. `/api/config` reads cached update metadata without contacting GitHub.
   Authenticated update checks use `/api/version` after the application mounts.
   Update notices remain reactive; GitHub failure cannot prevent startup.
   The admin view uses the same optional endpoint instead of its direct-GitHub
   fallback; login, initialization, site switching and refresh do not await it.
   Concurrent checks for one site share a request, and late responses from an
   older site cannot overwrite the active site version.
   This endpoint retains authentication, Turnstile and CORS enforcement and
   does not grant administrative access to the read-only App password.
3. Preload the homepage code and likely locale alongside startup configuration.
   Code preloading does not mount a page, request server data, persist preferences,
   or bypass authentication. The returned site settings and saved preferences
   still determine the actual language and theme before mounting.
4. For an existing session on a single-site homepage, request the initial
   server data alongside configuration. Both endpoints keep their existing
   server-side authentication and Turnstile checks. Speculative responses never
   redirect or change session/challenge state, and are used once only after
   startup configuration permits viewing the page. Failed speculation retries
   through the normal request. Speculation never sends a one-time challenge
   token; it may reuse an existing verified credential so it cannot consume a
   fresh token before the authoritative configuration check. Multi-site,
   admin and logged-out startup retain
   their ordinary request flow.
5. Remove the fixed one-second startup-overlay delay. The homepage releases the
   overlay after its initial data or error state has rendered; other routes
   release it once the router is ready. Optional version checks remain detached.
   Multi-site startup releases it on the first rendered progress result, without
   waiting for a stalled peer. Dashboard list reads have a 15-second timeout;
   an already timed-out speculative read does not start a second timeout.
   History queries retain their original behavior. Failed initial lazy routing
   also releases the startup overlay.
6. Single-site homepage reads opt into `/api/servers?realtime=deferred`, keeping
   inventory, persisted metrics, traffic counters and latency history without
   waiting for the realtime coordinator. The default API and detail route retain
   their existing behavior. An authorized `snapshot=1` WebSocket sends the
   latest permitted state immediately; its visible IDs come from the Worker,
   never a client-supplied allowlist, and remain restricted on resubscription.
   Existing sessions may establish this connection during config loading, but
   messages stay buffered until startup access is accepted and inventory arrives.
   Denied startup closes early connections; configured lifetime limits are
   applied to the same connection from its original open time on adoption.
7. Latest bootstrap state survives Durable Object hibernation in its existing
   storage: one IP-masked sample per host, five-minute validity and a 64 KiB cap.
   Writes are serialized and timestamp ordered; failures preserve normal report
   handling, and missing cached hosts wait for real reports. This is separate
   from D1 metric history and does not change probe intervals or traffic billing.
   The frontend orders REST, snapshot and live samples by sample/report time,
   retains newer queued samples, keeps inventory metadata authoritative, and
   allows genuinely newer monthly resets to reduce counters.

The existing WebSocket unit test disables Vite's application config so it
cannot install a developer certificate as a side effect of running tests.

8. Production HTML includes a small inline startup entry without Vue. On a
   single-site homepage it preloads the dashboard modules and starts bounded
   config/inventory reads while the main module downloads. Requests reuse the
   normal HTTP headers, remain side-effect-free until config adoption, never
   consume a fresh one-time challenge, and are accepted once only if route,
   API bases and credentials still match. Admin/multi-site paths retain normal
   startup; an unavailable bootstrap falls back to the main application.
9. Config reads site and appearance settings concurrently. Their legacy-row
   lookup is shared only within that logical settings read; existing cache
   lifetimes, permission checks, defaults and save behavior stay unchanged.
   There is no schema migration, persistent cache or settings backfill.
10. The inline entry also starts the existing realtime transport for signed-in
    single-site homepages. Transport code is shared without importing Vue;
    `api.js` keeps its existing exports. Main startup adopts that one controller
    instead of opening another socket, and messages remain buffered until access
    and inventory are accepted. Changed startup identities/routes, denied access
    and unclaimed controllers close the connection (15-second adoption bound).
    Later lifetime configuration uses the existing socket and open timestamp.
    Server handshake, authentication, DO snapshots and metric ordering stay intact.

## Verification

```sh
npm ci
npm run test:all
npm run build:frontend
```

The new regression test holds both GitHub requests pending while requesting
`/api/config`, then verifies that the background request still updates the
cache and cannot be used anonymously or with a read-only App password.
The locale test checks that speculative loading changes no saved preference
or language-change event and does not override the final site language.

Browser smoke checks use a loopback-only static server, synthetic API data,
and blocked external HTTP requests. They cover authenticated, public and
private-denied access; hold the optional version response until after all four
cards appear; verify the later update notice; and verify that homepage/locale
chunks begin loading before a delayed configuration response completes.
No real monitoring credentials or host inventory are used in these checks.

Startup checks also cover successful prefetch reuse, failed 401/403 speculation
without session loss, denied configuration with an otherwise successful data
response, slow data, logged-out access, request failures and expired sessions.
Performance comparisons should measure usable cards with the overlay removed,
not merely card elements underneath a full-screen loading overlay.

## Deployment and maintenance

See the [deployment instructions](README.md#快速部署) and [v0.1.0 notes](RELEASE-v0.1.0.md).
The dashboard checks stable GitHub Releases in the independent repository. The Go Agent and theme catalog remain upstream dependencies.
Authorised deployment credentials belong in each operator’s environment. The verification workflow runs tests, builds, and bundles a dry-run Worker.

To take a change from upstream, fetch the upstream repository and review the commits before merging or cherry-picking them. Run the checks above and verify the release paths and licenses before tagging a new version.
