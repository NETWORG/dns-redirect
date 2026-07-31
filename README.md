DNS redirector based on TXT records. More information in our internal [wiki](https://dev.azure.com/thenetworg/Wiki/_wiki/wikis/Wiki.wiki/2047/DNS-Redirector).

## Redirect resolution cache

Resolved redirect definitions are cached inside the Worker based on the DNS hostname being queried. Positive cache entries use the TXT record TTL (with the existing minimum TTL floor), and "not found" lookups are cached briefly to reduce repeated DNS-over-HTTPS misses.

## Cache purge endpoint

The worker exposes `POST /internal/cache/purge` to clear the Worker cache, including cached redirect-resolution entries.

Configure the shared secret before using it:

```bash
npx wrangler secret put PURGE_TOKEN
```

Then call the endpoint with the same token in the `X-Purge-Token` header.