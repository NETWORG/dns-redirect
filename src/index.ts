/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const MINIMUM_TTL = 3600;
const HTTPS_REDIRECT_TTL = 31536000;
const NOT_FOUND_TTL = 60;
const REDIRECT_STALE_WHILE_REVALIDATE = 300;
const HSTS_HEADER = "max-age=31536000; includeSubDomains; preload";
const PURGE_PATH = "/internal/cache/purge";
const PURGE_TOKEN_HEADER = "X-Purge-Token";

interface CachePolicy {
	maxAge: number;
	staleWhileRevalidate?: number;
	immutable?: boolean;
}

interface DnsTxtRecord {
	data: string;
	TTL: number;
}

interface DnsJsonResponse {
	Answer?: DnsTxtRecord[];
}

interface RedirectTarget {
	location: string;
	ttl: number;
}

export interface Env {
	PURGE_TOKEN: string;
	// Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
	// MY_KV_NAMESPACE: KVNamespace;
	//
	// Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
	// MY_DURABLE_OBJECT: DurableObjectNamespace;
	//
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	// MY_BUCKET: R2Bucket;
	//
	// Example binding to a Service. Learn more at https://developers.cloudflare.com/workers/runtime-apis/service-bindings/
	// MY_SERVICE: Fetcher;
	//
	// Example binding to a Queue. Learn more at https://developers.cloudflare.com/queues/javascript-apis/
	// MY_QUEUE: Queue;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === PURGE_PATH) {
			return handleCachePurge(request, env, ctx);
		}

		// Redirect HTTP to HTTPS
		if (url.protocol === "http:" && url.port === "") {
			url.protocol = "https:";
			return new Response(null, {
				status: 301,
				headers: createHeaders(
					{
						"Location": url.toString(),
					},
					{
						maxAge: HTTPS_REDIRECT_TTL,
						immutable: true,
					},
				),
			});
		}

		const host = url.host;
		const redirect = await getRedirectUrl(host, url.pathname) ?? await getRedirectUrl(`redirect.${host}`, url.pathname);
		if (!redirect) {
			return new Response(`<!DOCTYPE html>
      <body>
        <h1>Redirect not found</h1>
        <p>No redirect record has been found for domain \`${host}\`. Please ensure proper configuration as per <a href="https://dev.azure.com/thenetworg/Wiki/_wiki/wikis/Wiki.wiki/2047/DNS-Redirector">docs</a>. If you are a customer, contact <a href="https://support.networg.com">support</a>.</p>
      </body>`, {
				status: 404,
				statusText: "Not Found",
				headers: createHeaders(
					{
						"Content-Type": "text/html; charset=UTF-8",
					},
					{
						maxAge: NOT_FOUND_TTL,
					},
				),
			});
		}

		return new Response(null, {
			status: 302,
			headers: createHeaders(
				{
					"Location": redirect.location,
				},
				{
					maxAge: redirect.ttl,
					staleWhileRevalidate: REDIRECT_STALE_WHILE_REVALIDATE,
				},
			),
		});
	},
};

async function handleCachePurge(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const requestUrl = new URL(request.url);

	if (request.method !== "POST") {
		return jsonResponse(
			{
				error: "Method Not Allowed",
			},
			405,
			{
				"Allow": "POST",
			},
		);
	}

	if (requestUrl.protocol !== "https:") {
		return jsonResponse(
			{
				error: "HTTPS Required",
			},
			400,
		);
	}

	if (!env.PURGE_TOKEN) {
		return jsonResponse(
			{
				error: "Purge token is not configured",
			},
			503,
		);
	}

	if (!ctx.cache) {
		return jsonResponse(
			{
				error: "Worker cache is not available",
			},
			503,
		);
	}

	const providedToken = request.headers.get(PURGE_TOKEN_HEADER);
	if (!providedToken || providedToken !== env.PURGE_TOKEN) {
		return jsonResponse(
			{
				error: "Unauthorized",
			},
			401,
		);
	}

	await ctx.cache.purge({ purgeEverything: true });

	return jsonResponse({
		ok: true,
		purged: "everything",
	});
}

function createHeaders(headers: HeadersInit, cachePolicy?: CachePolicy): Headers {
	const responseHeaders = new Headers(headers);
	responseHeaders.set("Source", "cf-worker");
	responseHeaders.set("Strict-Transport-Security", HSTS_HEADER);

	if (cachePolicy) {
		responseHeaders.set("Cache-Control", buildCacheControl(cachePolicy));
		responseHeaders.set("Expires", new Date(Date.now() + (cachePolicy.maxAge * 1000)).toUTCString());
	}

	return responseHeaders;
}

function createNoStoreHeaders(headers?: HeadersInit): Headers {
	const responseHeaders = createHeaders(headers ?? {});
	responseHeaders.set("Cache-Control", "no-store");
	responseHeaders.set("Expires", "0");
	responseHeaders.set("Pragma", "no-cache");

	return responseHeaders;
}

function buildCacheControl(cachePolicy: CachePolicy): string {
	const directives = ["public", `max-age=${cachePolicy.maxAge}`];

	if (cachePolicy.staleWhileRevalidate) {
		directives.push(`stale-while-revalidate=${cachePolicy.staleWhileRevalidate}`);
	}

	if (cachePolicy.immutable) {
		directives.push("immutable");
	}

	return directives.join(", ");
}

function jsonResponse(body: object, status = 200, headers?: HeadersInit): Response {
	const responseHeaders = createNoStoreHeaders(headers);
	responseHeaders.set("Content-Type", "application/json; charset=UTF-8");

	return new Response(JSON.stringify(body), {
		status,
		headers: responseHeaders,
	});
}

async function getDnsTxt(domain: string): Promise<DnsTxtRecord[]> {
	const result = await fetch(`https://cloudflare-dns.com/dns-query?name=${domain}&type=TXT`, {
		method: "GET",
		headers: {
			"Accept": "application/dns-json",
		},
	});
	if (!result.ok) {
		throw new Error(`Request failed with ${result.status}: ${await result.text()}`);
	}
	const body = await result.json<DnsJsonResponse>();

	return body.Answer ?? [];
}

async function getRedirectUrl(domain: string, path: string): Promise<RedirectTarget | null> {
	const txtRecords = await getDnsTxt(domain);
	if (txtRecords.length === 0) {
		return null;
	}

	for (const record of txtRecords) {
		// TXT records start and end with double quotes (")
		let data = record.data.slice(1, -1);
		if (data.startsWith("REDIRECT::") || data.startsWith("SL::REDIRECT::")) {
			data = data.replace("SL::REDIRECT::", "").replace("REDIRECT::", "");
			if (data.startsWith("KEEP_PATH::")) {
				data = data.replace("KEEP_PATH::", "") + path;
			}
			return {
				location: data,
				ttl: record.TTL < MINIMUM_TTL ? MINIMUM_TTL : record.TTL,
			};
		}
	}

	return null;
}
