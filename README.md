DNS redirector based on TXT records. More information in our internal [wiki](https://dev.azure.com/thenetworg/Wiki/_wiki/wikis/Wiki.wiki/2047/DNS-Redirector).

## Cache purge endpoint

The worker exposes `POST /internal/cache/purge` to clear the Worker cache for the default entrypoint.

Configure the shared secret before using it:

```bash
npx wrangler secret put PURGE_TOKEN
```

Then call the endpoint with the same token in the `X-Purge-Token` header.