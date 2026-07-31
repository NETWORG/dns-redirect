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
const REDIRECT_CACHE_NAMESPACE = "redirect-resolution-v1";
const REDIRECT_CACHE_HOST = "redirect-cache.internal";

interface CachePolicy {
	maxAge: number;
	staleWhileRevalidate?: number;
	immutable?: boolean;
	vary?: string[];
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

interface RedirectDefinition {
	location: string;
	ttl: number;
	keepPath: boolean;
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
						vary: ["Host"],
					},
				),
			});
		}

		const host = url.host;
		const redirect = await getRedirectUrl(host, url.pathname, ctx) ?? await getRedirectUrl(`redirect.${host}`, url.pathname, ctx);
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
						vary: ["Host"],
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
					vary: ["Host"],
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
		appendVaryHeaders(responseHeaders, cachePolicy.vary);
	}

	return responseHeaders;
}

function appendVaryHeaders(headers: Headers, varyValues?: string[]): void {
	if (!varyValues || varyValues.length === 0) {
		return;
	}

	const existingValues = headers
		.get("Vary")
		?.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0) ?? [];
	const nextValues = new Set([...existingValues, ...varyValues]);
	headers.set("Vary", Array.from(nextValues).join(", "));
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

async function getRedirectUrl(domain: string, path: string, ctx: ExecutionContext): Promise<RedirectTarget | null> {
	const redirectDefinition = await getRedirectDefinition(domain, ctx);
	if (!redirectDefinition) {
		return null;
	}

	return createRedirectTarget(redirectDefinition, path);
}

async function getRedirectDefinition(domain: string, ctx: ExecutionContext): Promise<RedirectDefinition | null> {
	const cachedRedirectDefinition = await getCachedRedirectDefinition(domain);
	if (cachedRedirectDefinition !== undefined) {
		return cachedRedirectDefinition;
	}

	const redirectDefinition = parseRedirectDefinition(await getDnsTxt(domain));
	const cacheTtl = redirectDefinition?.ttl ?? NOT_FOUND_TTL;
	ctx.waitUntil(cacheRedirectDefinition(domain, redirectDefinition, cacheTtl));

	return redirectDefinition;
}

async function getCachedRedirectDefinition(domain: string): Promise<RedirectDefinition | null | undefined> {
	const cachedResponse = await caches.default.match(createRedirectCacheKey(domain));
	if (!cachedResponse) {
		return undefined;
	}

	const cachedBody = await cachedResponse.json<CachedRedirectDefinition>();
	return cachedBody.redirect;
}

async function cacheRedirectDefinition(domain: string, redirectDefinition: RedirectDefinition | null, ttl: number): Promise<void> {
	const headers = createHeaders(
		{
			"Content-Type": "application/json; charset=UTF-8",
		},
		{
			maxAge: ttl,
		},
	);
	const response = new Response(JSON.stringify({ redirect: redirectDefinition } satisfies CachedRedirectDefinition), {
		headers,
	});

	await caches.default.put(createRedirectCacheKey(domain), response);
}

function createRedirectCacheKey(domain: string): Request {
	const normalizedDomain = encodeURIComponent(domain.toLowerCase());
	return new Request(`https://${REDIRECT_CACHE_HOST}/${REDIRECT_CACHE_NAMESPACE}/${normalizedDomain}`);
}

interface CachedRedirectDefinition {
	redirect: RedirectDefinition | null;
}

export function parseRedirectDefinition(txtRecords: DnsTxtRecord[]): RedirectDefinition | null {
	for (const record of txtRecords) {
		const data = normalizeTxtRecordData(record.data);
		if (!data.startsWith("REDIRECT::") && !data.startsWith("SL::REDIRECT::")) {
			continue;
		}

		let location = data.replace("SL::REDIRECT::", "").replace("REDIRECT::", "");
		let keepPath = false;
		if (location.startsWith("KEEP_PATH::")) {
			location = location.replace("KEEP_PATH::", "");
			keepPath = true;
		}

		return {
			location,
			ttl: Math.max(record.TTL, MINIMUM_TTL),
			keepPath,
		};
	}

	return null;
}

function normalizeTxtRecordData(data: string): string {
	return data.startsWith("\"") && data.endsWith("\"")
		? data.slice(1, -1)
		: data;
}

export function createRedirectTarget(redirectDefinition: RedirectDefinition, path: string): RedirectTarget {
	return {
		location: redirectDefinition.keepPath ? redirectDefinition.location + path : redirectDefinition.location,
		ttl: redirectDefinition.ttl,
	};
}
