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

export interface Env {
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
		
		// Redirect HTTP to HTTPS
		if (url.protocol === "http:" && url.port === "") {
			url.protocol = "https:";
			return new Response(null, {
				status: 301,
				headers: {
					"Location": url.toString(),
					"Source": "cf-worker",
          "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload"
				},
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
				headers: {
					"Content-Type": "text/html; charset=UTF-8"
				}
			});
		}

		return new Response(null, {
			status: 302,
			headers: {
				"Location": redirect.location,
				"Expires": new Date(Date.now() + (redirect.ttl * 1000)).toUTCString(),
				"Source": "cf-worker",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload"
			}
		});
	},
};

async function getDnsTxt(domain: string) {
	const result = await fetch(`https://cloudflare-dns.com/dns-query?name=${domain}&type=TXT`, {
		method: "GET",
		headers: {
			"Accept": "application/dns-json"
		}
	});
	if (!result.ok) {
		throw new Error(`Request failed with ${result.status}}: ` + await result.text());
	}
	const body = await result.json() as any;

	return body["Answer"] ?? [];
}

async function getRedirectUrl(domain: string, path: string) {
	const txtRecords = await getDnsTxt(domain);
	if (txtRecords.length === 0) {
		return null;
	}

	for (const record of txtRecords) {
		// TXT records start and end with double quotes (")
		let data = record.data.substr(1, record.data.length - 2);
		if (data.startsWith("REDIRECT::") || data.startsWith("SL::REDIRECT::")) {
			data = data.replace("SL::REDIRECT::", "").replace("REDIRECT::", "");
			if (data.startsWith("KEEP_PATH::")) {
				data = data.replace("KEEP_PATH::", "") + path;
			}
			return {
				location: data,
				ttl: record.TTL < MINIMUM_TTL ? MINIMUM_TTL : record.TTL
			};
		}
	}
}
