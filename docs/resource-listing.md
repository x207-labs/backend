# Listing of a metered resource (BE-050, pipeline P5, class D)

A resource that is paid per unit of use (CPU, GPU, storage, a feed, a relay, a home device) is an x402 endpoint. Class D does not go through a grant, so the units here are not the `UNITS` of the contract (`call`, `minute`, `day`, `once`); the new units live in the listing and in the voucher, and the contract is not changed.

## What a listing says
For these asset types the listing is class D and its `detail` is JSON text: `{"unit": "<unit>", "unit_price": "<credit>", "endpoint": "https://…"}`. Other keys (a name, a note) are not checked.

| Item | Rule |
| --- | --- |
| asset types | the twelve kinds of P5, with the names of the registry D10: `compute:cpu-idle` (#31), `compute:gpu-hours` (#32), `storage:capacity` (#33), `cdn:static-cache` (#34), `model:inference` (#35), `model:fine-tuning` (#36), `oracle:data-feed` (#44), `iot:sensor-data` (#45), `gas:relayer` (#47), `queue:priority-slot` (#49), `network:proxy-bandwidth` (#55), `compute:home-device` (#90). A test compares the table with `scripts/lib/asset-catalog.mjs`. |
| `offer.asset_class` | `D` |
| `unit` | `call`, `minute`, `day`, `GB`, `job` or `request`, exactly as written |
| `unit_price` | decimal string above 0, not above u128: credit (smallest unit) for one unit |
| `endpoint` | `https` only; at most 512 ASCII characters; no user name or password; no fragment; a host name, not an IP address, and not `localhost`, `*.local`, `*.internal` or a name without a dot; no query parameter that carries a credential (`api_key`, `key`, `token`, `access_token`, `secret`, `password`, `auth`, `signature`, …) |

A refusal is `400 scope_invalid` with the reason in `message`. Asset types outside the twelve keep their own rules.

## Statistics per unit
`GET /x207/circles/{circle}/marketplace/resources/stats[?unit=<unit>]` → `{circle, units[], total, knownUnits[]}`; each entry of `units` is `{unit, openListings, assetTypes[], minUnitPrice, medianUnitPrice, maxUnitPrice}`, computed when asked from the open, not expired listings of the twelve kinds whose `detail` passes the rules above. Prices are strings (u128). With no listing the answer is `units: []`. An unknown `unit` is `400 invalid_request`.

## Limits
- The backend does not call the endpoint: it does not know that it answers, that it takes `x402`, or that its price matches `unit_price`. The buyer finds that out by paying one unit, which is the most it can lose per event (pipeline P5, step L8).
- The checks on the address are about its form. A host name can still resolve to a private address; whoever calls the endpoint must resolve and check it again.
- `#55` (proxy and bandwidth) is subject to local law, and `#90` (a device at home) leaves electricity and security to its owner; both are warnings of the template in the SDK, not a refusal here.
- The units `GB` and `job` need a price that depends on the request: that is SD-062 in the SDK; the listing only states the price of one unit.
