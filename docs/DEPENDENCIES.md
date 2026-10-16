# Dependency assessment (developer's own assessment; NOT owner acceptance)

Environment of this run: Node 22.22.0, npm 10.9.4, Java 21. QA's earlier run: Node 24.19.0, npm 12.2.0, Temurin 21.0.12. Supported: **Node >= 24.12** for the rules suite (`@firebase/rules-unit-testing` 6.0.0); the app build and unit suite also ran on Node 22.22 in this environment. Lockfiles (`package-lock.json`, `tests/package-lock.json`) are committed; `npm ci` from a clean checkout succeeded in both folders (225 and the tests packages), `npm run build` and `npm test` (268 passed) ran after it.

## App (6 advisories: 4 high, 2 moderate), shipped to browsers/hosting
| Package | Issue | Reachable? | Offered "fix" | Assessment |
|---|---|---|---|---|
| @grpc/grpc-js (via firebase 12) | auth-context certificate handling; error messages sent by *server* method handlers | These are Node gRPC **server** concerns. The browser SDK uses its web transport and does not run a gRPC server. | firebase 9.14.0 | **Do not apply.** It is a major DOWNGRADE that would lose current Firestore features. Wait for a firebase 12.x patch. |
| exceljs -> uuid | missing buffer bounds check when a caller passes `buf` to v3/v5/v6 | Only if exceljs calls those with a buffer; exceljs uses v4 ids | exceljs 3.4.0 | **Do not apply** (a downgrade by several majors). Low practical risk. |

## Test tooling (25 advisories: 3 critical, 12 high, 10 moderate), developer machines only, never shipped
Critical `tar` (via firebase-tools) and `tinypool`/`vitest` apply to tooling that runs on trusted local files; they would matter only if the machine processed untrusted archives or mocks. Suggested fixes are majors (firebase-tools 15.x, vitest 5.x) or downgrades (`@firebase/rules-unit-testing` 2.0.7, `firebase` 9.14.0). **No `npm audit fix --force` was run.** Upgrading vitest/firebase-tools is recommended as a separate, tested change after release; the test suite must be re-run in full when that is done.

## SDK instance compatibility
The app uses firebase ^12.17.1; the tests use firebase ^13. The rules tests route both `firebase/firestore` and rules-unit-testing to ONE CommonJS copy (`tests/helpers/*-cjs.mjs`) so the app code and fixtures share an SDK instance. This changes no security expectation.

## Owner decision needed
Accept (or not) the residual advisories above. Nothing here has been accepted on the owner's behalf.
