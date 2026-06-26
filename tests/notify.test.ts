import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
	buildNotificationMessage,
	type NotifyContext,
	shouldNotify,
} from "../src/notify.ts";
import type { NotifyConfig } from "../src/config.ts";
import type { RelayRunResult, RelayStatus } from "../src/relay.ts";

function makeResult(
	status: RelayStatus,
	overrides: Partial<RelayRunResult> = {},
): RelayRunResult {
	return {
		startedAt: "2026-06-26T10:00:00.000Z",
		finishedAt: "2026-06-26T10:00:03.000Z",
		durationMs: 3000,
		filesFound: 0,
		filesAlreadyTransferred: 0,
		transfers: [],
		status,
		success: status === "ok" || status === "idle",
		...overrides,
	};
}

const baseConfig: NotifyConfig = {
	to: "ops@example.com",
	from: "relay@host",
	on: "always",
	subjectPrefix: "[file-relay]",
	attachLog: false,
	smtp: { host: "smtp.example.com", port: 587 },
};

const okCtx: NotifyContext = {
	result: makeResult("ok", {
		transfers: [
			// deno-lint-ignore no-explicit-any
			{ success: true } as any,
			// deno-lint-ignore no-explicit-any
			{ success: true } as any,
		],
	}),
	logText: "Starting relay run\n[INFO] done",
	host: "prod-1",
};

Deno.test("notify - shouldNotify always returns true for any status", () => {
	for (
		const s of [
			"ok",
			"idle",
			"partial",
			"failed",
			"preflight-failed",
			"aborted",
		] as RelayStatus[]
	) {
		assert(shouldNotify("always", { result: makeResult(s), logText: "" }));
	}
	// also for a fatal error
	assert(
		shouldNotify("always", {
			result: null,
			error: new Error("boom"),
			logText: "",
		}),
	);
});

Deno.test("notify - shouldNotify failure only fires on abnormal runs", () => {
	assertEquals(
		shouldNotify("failure", { result: makeResult("ok"), logText: "" }),
		false,
	);
	assertEquals(
		shouldNotify("failure", { result: makeResult("idle"), logText: "" }),
		false,
	);
	for (
		const s of [
			"partial",
			"failed",
			"preflight-failed",
			"aborted",
		] as RelayStatus[]
	) {
		assertEquals(
			shouldNotify("failure", { result: makeResult(s), logText: "" }),
			true,
			`expected failure trigger for status "${s}"`,
		);
	}
});

Deno.test("notify - shouldNotify failure fires on a fatal error", () => {
	assert(
		shouldNotify("failure", {
			result: null,
			error: new Error("boom"),
			logText: "",
		}),
	);
});

Deno.test("notify - shouldNotify failure treats a missing result as failure", () => {
	assert(shouldNotify("failure", { result: null, logText: "" }));
});

Deno.test("notify - buildNotificationMessage success subject + body", () => {
	const msg = buildNotificationMessage(baseConfig, okCtx);
	assertEquals(msg.to, "ops@example.com");
	assertEquals(msg.from, "relay@host");
	assertStringIncludes(msg.subject, "[file-relay]");
	assertStringIncludes(msg.subject, "OK");
	assertStringIncludes(msg.subject, "prod-1");
	assertStringIncludes(msg.subject, "2 transferred");
	// body carries the captured output + a summary header
	assertStringIncludes(msg.text ?? "", "Status:  OK");
	assertStringIncludes(msg.text ?? "", "Host:    prod-1");
	assertStringIncludes(msg.text ?? "", "Starting relay run");
});

Deno.test("notify - buildNotificationMessage error subject uses ERROR + message", () => {
	const msg = buildNotificationMessage(baseConfig, {
		result: null,
		error: new Error("disk gone"),
		logText: "boom trace",
		host: "prod-9",
	});
	assertStringIncludes(msg.subject, "ERROR");
	assertStringIncludes(msg.subject, "disk gone");
	assertStringIncludes(msg.text ?? "", "boom trace");
});

Deno.test("notify - buildNotificationMessage failure counts succeeded/failed", () => {
	const msg = buildNotificationMessage(baseConfig, {
		result: makeResult("partial", {
			filesAlreadyTransferred: 5,
			transfers: [
				// deno-lint-ignore no-explicit-any
				{ success: true } as any,
				// deno-lint-ignore no-explicit-any
				{ success: false } as any,
			],
		}),
		logText: "",
		host: "h",
	});
	assertStringIncludes(msg.subject, "PARTIAL");
	assertStringIncludes(msg.subject, "1 transferred");
	assertStringIncludes(msg.subject, "1 failed");
	assertStringIncludes(msg.subject, "5 skipped");
});

Deno.test("notify - buildNotificationMessage passes through cc/bcc/replyTo", () => {
	const msg = buildNotificationMessage({
		...baseConfig,
		replyTo: "me@host",
		cc: ["a@host", "b@host"],
		bcc: "c@host",
	}, okCtx);
	assertEquals(msg.replyTo, "me@host");
	assertEquals(msg.cc, ["a@host", "b@host"]);
	assertEquals(msg.bcc, "c@host");
});

Deno.test("notify - buildNotificationMessage attachLog adds a .log attachment", () => {
	const msg = buildNotificationMessage(
		{ ...baseConfig, attachLog: true },
		okCtx,
	);
	assertEquals(msg.attachments?.length, 1);
	assertEquals(msg.attachments?.[0].filename, "file-relay.log");
	assertStringIncludes(
		String(msg.attachments?.[0].content ?? ""),
		"Starting relay run",
	);
});

Deno.test("notify - buildNotificationMessage with empty log omits the divider", () => {
	const msg = buildNotificationMessage(baseConfig, {
		result: makeResult("idle"),
		logText: "   ",
		host: "h",
	});
	assert(!(msg.text ?? "").includes("-".repeat(60)));
	// no attachment when there is no captured output, even if attachLog is on
	const msg2 = buildNotificationMessage(
		{ ...baseConfig, attachLog: true },
		{ result: makeResult("idle"), logText: "   ", host: "h" },
	);
	assertEquals(msg2.attachments, undefined);
});
