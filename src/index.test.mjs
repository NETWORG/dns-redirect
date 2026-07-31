import assert from "node:assert/strict";
import test from "node:test";

import { createRedirectTarget, parseRedirectDefinition } from "./index.ts";

test("parseRedirectDefinition keeps the DNS TTL floor for standard redirects", () => {
	const redirect = parseRedirectDefinition([
		{
			data: "\"REDIRECT::https://example.com\"",
			TTL: 120,
		},
	]);

	assert.deepEqual(redirect, {
		location: "https://example.com",
		ttl: 3600,
		keepPath: false,
	});
});

test("parseRedirectDefinition supports SL::REDIRECT::KEEP_PATH records", () => {
	const redirect = parseRedirectDefinition([
		{
			data: "\"SL::REDIRECT::KEEP_PATH::https://example.com/base\"",
			TTL: 7200,
		},
	]);

	assert.deepEqual(redirect, {
		location: "https://example.com/base",
		ttl: 7200,
		keepPath: true,
	});
});

test("parseRedirectDefinition ignores unrelated TXT records", () => {
	const redirect = parseRedirectDefinition([
		{
			data: "\"v=spf1 include:_spf.example.com ~all\"",
			TTL: 300,
		},
	]);

	assert.equal(redirect, null);
});

test("createRedirectTarget appends the request path only for KEEP_PATH redirects", () => {
	const keepPathRedirect = createRedirectTarget(
		{
			location: "https://example.com/base",
			ttl: 7200,
			keepPath: true,
		},
		"/docs/getting-started",
	);
	const staticRedirect = createRedirectTarget(
		{
			location: "https://example.com/fixed",
			ttl: 7200,
			keepPath: false,
		},
		"/ignored",
	);

	assert.equal(keepPathRedirect.location, "https://example.com/base/docs/getting-started");
	assert.equal(staticRedirect.location, "https://example.com/fixed");
});
