# Portable images and native Pi Durable

The existing root `generateImage(params, options)` and `/extension` remain desktop APIs.
They retain Node settings/auth discovery, all existing providers, filesystem security,
non-overwriting files, and optional sprites. No version or application migration is implied.

`/core` is the shared execution engine used by that desktop adapter and `/durable`.
Neither new entry imports the desktop entry. Common declarations do not import sprites.
`/durable` requires the optional `@earendil-works/pi-durable` peer **1.1.0** plus TypeBox;
install these in the host application, not in a browser. The native API is experimental.

`/durable` is a settings-only native factory: `createImageExtension(settings, options)`
accepts ordinary serializable settings at initialization and uses the existing Node
provider and file handling internally. There are no admission, quota, authorization,
credential-store, or load/store host callbacks. The desktop entry keeps its Pi settings
discovery; the durable factory takes settings as plain arguments instead.
Desktop-only users do not need the Durable runtime. Production dependency resolution
and the host's native SDK lock remain the host's responsibility.

## Two runtimes: Node native factory vs optional portable `/core`

This package serves two different Durable consumers. They share validation,
accounting, and safety helpers, but their transports, settings, and policy
surface are separate. Do not mix their contracts.

**Node native factory (`/durable`, recommended for Node hosts).**
`createImageExtension(settings, options)` takes plain serializable settings plus an
optional working directory and search settings. It calls the same Node services as
the desktop entry: provider adapters over fetch, reference loading from session
files or public URLs, downloads through the package's safe fetch, and files
written under settings-governed directories. `image_generate` uses the configured
`default` route with ordered `fallback` entries for safely classified failures;
`image_compare` fans out over the configured `compare` list; `image_search` and
`image_search_compare` use the independent `pi-image-search` settings;
`sprite_generate` is registered only when `spriteGeneration.enabled` is true and
runs the existing sprite pipeline. The factory defines no auth, quota, ledger, or
reservation policy: credentials and endpoints come only from the supplied settings,
and each service call performs its own dispatch with no automatic paid retry. A
configured fallback entry is a separate attempt on another route, never a replay of
the same call. Cancellation flows from the Durable abort signal; it never promises
a provider refund and never rolls back already-saved outputs.

**Optional portable `/core` (for hosts that bring their own transport).** Hosts that
cannot use the Node services — for example a Workers host with a Cloudflare AI
binding — can drive `generateImageCore` directly with their own `ImageHost`
(loaders, binding transport, storage) and their own policy around it. The example
below sketches that contract; the variables are application-owned, not hidden
package globals.

```ts
import {
  catalogImageRoute, prepareImageRequest, canonicalizePreparedRequest,
  generateImageCore, ImageCoreError,
} from '@abhishek944/pi-image-gen/core';

const route = catalogImageRoute('openai/gpt-image-2.5-flare', trustedGatewayId);
const request = prepareImageRequest(modelArguments, frozenResponseDefaults, route);
const identityToHash = canonicalizePreparedRequest(request);
// A host with its own policy applies it against this exact identity BEFORE calling
// the engine, then supplies its own ImageHost (loaders, binding, storage).
const result = await generateImageCore(request, hostSuppliedImageHost);
```

Flare and Sunburst use the genuine Cloudflare catalog IDs. This is not a subscription
login, new queue, separate execution service, or batch endpoint.
The catalog schema has one output and no `n` knob; independent native calls remain parallel.
The package sends `skipCache: true`, `collectLog: false`, `retries.maxAttempts: 1`,
`returnRawResponse: true` and the bounded signal. The host binding transport must forward
these options to `AI.run`; raw JSON responses are stream-bounded before parsing.
A binding that instead returns an already-parsed object owns that prior allocation.

Preparation copies/freezes args, trusted route and provenance. Supported explicit controls
win; omissions use the supplied frozen response defaults. Original identifiers retain
full URL and order. Canonical serialization excludes provider keys/headers, but contains
private prompt/original identifiers: hash it, do not log or persist it as extra plaintext.
No arbitrary endpoint, Gateway, provider, local path or credential is a model argument.
The Node native tools expose the full creative control set (prompt, references, size,
quality, seed, format, and route-appropriate knobs); server-side validation remains the
single enforcement point. The generic core still supports the desktop controls through
its provider host.

## Native settings-only factory

```ts
import { createImageExtension } from '@abhishek944/pi-image-gen/durable';

const images = createImageExtension(
  {
    version: 2,
    default: { provider: 'openai-api', model: 'gpt-image-2.5-flare' },
    fallback: [{ provider: 'gemini-api', model: 'nano-banana' }],
    compare: [
      { provider: 'gemini-api', model: 'nano-banana' },
      { provider: 'openai-api', model: 'gpt-image-2' },
    ],
    outputDir: '.pi/images',
  },
  {
    searchSettings: {
      default: { provider: 'serper' },
      fallback: [{ provider: 'brave' }],
      compare: [{ provider: 'serper' }, { provider: 'openverse' }],
    },
    cwd: '/path/to/session',
  },
);
registry.install(images);
```

Settings are normalized and frozen at factory time; later mutation of the passed
objects is not observed. Per-call inputs are creative arguments only (prompt, query,
references, filename); settings select credentials, endpoints, and output directories,
so they are never model arguments. Each service call performs its own dispatch with
no automatic paid retry: a repeat paid attempt always needs a new explicit user
request, and configured fallback/compare entries are separate attempts, not replays.
The factory defines no auth, quota, ledger, reservation, or release policy beyond
what the supplied settings already contain. Native calls retain confirmed saved
outputs on failure through a serializable internal option (`retainPartialOutputs`)
rather than the desktop default partial-batch cleanup; failed results report the
retained receipts and outcome flags instead of deleting them.

The export uses native `defineTool`/`defineExtension`, not a desktop-shaped shim.
It registers `image_generate`, `image_compare`, `image_search`, and
`image_search_compare`, plus `sprite_generate` only when
`spriteGeneration.enabled` is true — each `replay: 'unsafe'` and
`executionMode: 'parallel'` — and forwards `context.abortSignal` into the service
call. Working directories resolve from the explicit option, then the Durable
runtime environment `cwd`, then the conversation agent `cwd`, then the process cwd.
Progress is observational and cannot authorize billing. No global tool serialization,
app fan-out, image-count product limit, or per-call permission is introduced. Results
return absolute saved-file paths with Markdown lines and one request metadata record,
never base64, original bytes, credentials, or transient provider URLs.

Native `image_generate` and `image_compare` exclude per-call `outputDir` and local
`resize` (a model argument never chooses a local path); `sprite_generate` reuses the
existing desktop schema verbatim, whose `outputDir` stays contained under the session
working directory by the pipeline's own validation, and search offers an opt-in
exact-size PNG derivative alongside untouched downloads. This factory wires the
provider-route transport only: the existing Node adapters over fetch. Subscription
routes (`codex-subscription`, `meta-subscription`) resolve credentials through Pi
login on desktop and fail closed here; only credential-complete API-key and custom
routes execute end to end.

## I/O, originals and resource ownership

This section describes the portable `/core` host contract. The Node native factory
internalizes the Node host (session-file and safe-fetch loaders, settings-governed
directory storage) and inherits these behaviors without exposing them as options.

`ImageHost` supplies actual original loading, output download policy, catalog binding
transport and idempotent storage. Storage receives original output bytes plus index,
bounded signal, actual batch total and validated descriptor. Commit a private durable
receipt before returning it. Keep edited outputs as new assets with exact original links.
An authenticated original loader must validate owner/chat/immutable identity BEFORE reading;
a provider-output loader must not inherit application cookies or authorization headers.
Reject unsafe/redirected private destinations according to the host's output policy.

The portable core itself performs no resizing or recompression: MIME signatures/bytes
and supported profile formats are checked as received. The Node libraries may derive
opt-in local copies outside the core — search offers an exact-size PNG derivative and
the desktop generation path an equivalent — while provider originals stay untouched.
Desktop ceilings remain 20 MiB per image, 128 MiB aggregate originals and 16
references; these are safety bounds, **not Cloudflare memory guarantees**. The host must
choose stricter `limits.referenceBytes` (aggregate), `imageBytes` (per image), and
`responseBytes` (catalog JSON envelope), preflight metadata and stream-bound its loaders
before allocation. Provider adapters retain their existing HTTP/body policies.
Native `AI.run` receives transient original bytes encoded in order, not public originals.
Base64/JSON copies and concurrent calls consume additional memory. The host must budget
that aggregate; static compilation does not establish Workers heap safety.
No model can relax these limits. Oversized originals fail rather than silently shrinking.

## Failures and cost

This section describes portable `/core` failure semantics, which the Node native
factory inherits: service errors surface as body-free messages, never foreign
bodies or credentials.

`ImageCoreError` exposes phase, `outcome.dispatched`, provider-result `uncertain`, `partial`,
stored receipts and per-request metadata. `storageUncertain` separately means a store was
invoked without a confirmed receipt, even if its promise rejected: a write may have committed
before losing its acknowledgement. This is not a still-pending-promise flag. Reconcile the
host ledger; a known provider result does not become unknown merely because storage failed. Core never deletes receipts.
Desktop separately retains its legacy local partial-file cleanup and numeric result shape.
An unhandled host error becomes a body-free native error result.

Each service call performs one dispatch, with no automatic paid POST retry or replay.
Native replay is unsafe. Configured fallback and comparison entries are separate
attempts on other routes, not retries of the same dispatch. Recover already-existing
private results by bounded reads; after a dispatched or uncertain failure, another
paid attempt requires a new explicit user request. Cancellation
cannot promise a provider refund or force a transport to honor AbortSignal. Keep outputs
already durable through Stop/archive/sibling failure. Any quota release or finalization
is the `/core` host's own policy; the Node native factory defines none.

Metadata keeps bounded meaningful nested usage and ONE cost answer per request, not per image.
Each returned cost candidate is validated before fallback. Provider cost wins with supported
source/unit provenance; identifiers are bounded, not arbitrary URLs/userinfo. Explicit provider
or gateway estimates are not used as provider charges or fallback prices. Safe accounting survives
unusable-image errors without retaining the response body. Legacy desktop numeric cost/usage
stay numeric; additive `reportedUsage`, `tokenUsage` and `costDetails` preserve rich accounting,
and an estimate is never inserted into the old scalar cost field.

Core normalizes known API counters into disjoint `tokenUsage` buckets (`input`, `output`,
`cacheRead`, `cacheWrite`). Cached input is not billed twice. Raw nested counters are preserved
separately in `reportedUsage`. Unknown counter semantics or missing input/output totals leave
normalized usage unavailable. Optional `ImageHost.calculateCost` must bind the official
`pi-ai.calculateCost` to the exact route's compatible Pi image-model catalog pricing:

```ts
calculateCost(tokens) {
  const usage = {
    ...tokens,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return calculatePiCost(compatiblePiModel, usage).total;
}
```

Here `calculatePiCost` is imported as `calculateCost` from `@earendil-works/pi-ai`, and
`compatiblePiModel` is host-resolved pricing for the exact route, not user-supplied rates or a
similarly named chat model. The host must verify its rates represent the complete request;
GPT Image's separate modality rates do not fit Pi's four-rate calculator. Desktop binds this
capability from modern Pi image-model registry lookups only when a trusted registry adapter
adds `costCompatibility: 'complete-four-bucket-token-pricing'` to the exact matching image
entry. That attestation means its Pi catalog rates cover the full request, including image
output, input modalities and caching; it must not be inferred from numeric validity, zero
rates or the mere presence of an image catalog entry. Stock Pi entries lack this assurance
and therefore do not enable desktop fallback by themselves. The settings-only native
factory passes no model registry, so estimated costs are unavailable there and cost stays
`unknown` unless the provider reports it. Without compatible pricing or sufficient usage, cost is `unknown`, never a fabricated
zero. Calculator failures do not lose committed outputs. Computed prices are labeled
`estimated`, `completeness: 'complete'`, with source `pi-ai.calculateCost`. No local price table,
image dimension/quality formula, or gateway-estimate fallback is used. The callback must not
make network requests or perform generation; it calculates against already-resolved pricing.
Do not relabel Partial as total, multiply request cost by image count or inject estimates
as native text-model token usage.

## Verification and release

Use package typecheck/build/check and inspect emitted imports/Worker bundles/declarations.
Real provider, cancellation/crash, authorization, persistence and aggregate-memory checks
remain separate host acceptance work. No static check proves them. Do not replay a paid
attempt to verify recovery. Publish this same package through the owner's normal release;
applications must consume the actual published version, not a local link or invented pin.
