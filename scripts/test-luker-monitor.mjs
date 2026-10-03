import assert from 'node:assert/strict';
import test from 'node:test';
import { monitorLukerDispatch } from '../backend-monitor-minimal/luker-latency-monitor.js';

function harness(stream = true) {
    const calls = [], chunks = [];
    const run = { output_bytes: 0 };
    let finalized = 0;
    const monitor = {
        run,
        mark: name => calls.push(name),
        setHttpStatus: status => { run.http_status = status; },
        captureError: error => { run.error = error.message; },
        captureJson: payload => { run.payload = payload; },
        attachStream: ({ body }) => {
            body.on('data', c => chunks.push(c));
            body.on('end', () => calls.push('stream-end'));
            body.on('close', () => calls.push('stream-close'));
        },
        finalize: async extra => { finalized++; Object.assign(run, extra); },
    };
    const controller = new AbortController();
    const events = [];
    const ctx = {
        signal: controller.signal,
        fetch: async () => ({ status: 200 }),
        emit: Object.fromEntries(['head', 'chunk', 'end', 'error', 'trailer'].map(name => [name, (...args) => events.push([name, ...args])])),
    };
    return { monitor, run, calls, chunks, ctx, events, controller,
        wrap: fn => monitorLukerDispatch({ body: { stream } }, fn, () => monitor),
        get finalized() { return finalized; } };
}

test('stream observes once at dispatch, preserving payload, return and WS ownership', async () => {
    const h = harness();
    const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    assert.equal(await h.wrap(async ctx => {
        await ctx.fetch('/upstream', { method: 'POST' });
        ctx.emit.head({ status: 200 });
        ctx.emit.chunk(bytes);
        ctx.emit.end();
        ctx.emit.end(); // transport terminal-lock, never another monitor finalize
        return 42;
    })(h.ctx), 42);
    assert.equal(h.finalized, 1);
    assert.equal(h.chunks.length, 1);
    assert.equal(h.chunks[0].toString(), bytes.toString());
    assert.equal(h.events[1][1], bytes);
    assert.equal(h.run.outcome, 'stream');
    assert.equal(h.calls.filter(x => x === 'stream-end').length, 1);
    // Reconnect replays transport events without re-entering dispatch.
    h.ctx.emit.chunk(bytes);
    h.ctx.emit.end();
    assert.equal(h.finalized, 1);
    assert.equal(h.chunks.length, 1);
});

test('nonstream assembles split UTF-8 JSON before capturing metadata', async () => {
    const h = harness(false);
    const payload = { choices: [{ message: { content: '你好' } }], usage: { total_tokens: 8 } };
    const bytes = Buffer.from(JSON.stringify(payload));
    await h.wrap(async ctx => {
        await ctx.fetch('/upstream', { method: 'POST' });
        ctx.emit.head({ status: 200 });
        for (const byte of bytes) ctx.emit.chunk(Uint8Array.of(byte));
        ctx.emit.end();
    })(h.ctx);
    assert.deepEqual(h.run.payload, payload);
    assert.equal(h.run.output_bytes, bytes.length);
    assert.equal(h.finalized, 1);
});

test('upstream error and emitted terminal failure finalize without storing error payload', async () => {
    const h = harness();
    await h.wrap(async ctx => {
        ctx.emit.head({ status: 429 });
        ctx.emit.error(new Error('secret prompt and api key'));
    })(h.ctx);
    assert.equal(h.run.http_status, 429);
    assert.equal(h.run.outcome, 'exception');
    assert.doesNotMatch(h.run.error, /secret/);
    assert.equal(h.finalized, 1);
});

test('abort preserves original rejection and marks stopped exactly once', async () => {
    const h = harness();
    const error = new DOMException('secret cancellation', 'AbortError');
    await assert.rejects(h.wrap(async () => { h.controller.abort(); throw error; })(h.ctx), e => e === error);
    assert.equal(h.run.client_stopped, true);
    assert.equal(h.run.outcome, 'exception');
    assert.equal(h.finalized, 1);
});

test('monitor setup/finalization failures do not break generation', async () => {
    const ctx = {};
    const dispatch = async value => value;
    assert.equal(await monitorLukerDispatch({}, dispatch, () => { throw Error(); })(ctx), ctx);
    const h = harness();
    h.monitor.finalize = async () => { throw Error('disk full'); };
    assert.equal(await h.wrap(async () => 'done')(h.ctx), 'done');
});

test('runner fallback end and unrelated context fields are preserved', async () => {
    const h = harness();
    h.ctx.secrets = { marker: true };
    await h.wrap(async ctx => { assert.equal(ctx.secrets, h.ctx.secrets); ctx.emit.chunk('data: [DONE]\n\n'); })(h.ctx);
    assert.equal(h.finalized, 1);
    assert.ok(h.calls.includes('stream-end'));
});

test('pending telemetry write does not hold the runner open', async () => {
    const h = harness();
    h.monitor.finalize = () => new Promise(() => {});
    assert.equal(await h.wrap(async () => 'completed')(h.ctx), 'completed');
});

test('real monitor records SSE usage once without response body or secret error details', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const root = mkdtempSync(join(tmpdir(), 'aquarium-monitor-'));
    const moduleUrl = new URL('../backend-monitor-minimal/luker-latency-monitor.js', import.meta.url).href;
    try {
        execFileSync(process.execPath, ['--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            import fs from 'node:fs/promises';
            const { monitorLukerDispatch } = await import(${JSON.stringify(moduleUrl)});
            const emit = Object.fromEntries(['head','chunk','end','error'].map(x => [x, () => {}]));
            await monitorLukerDispatch({ body: { stream: true, messages: [], model: 'synthetic' } }, async ctx => {
                await ctx.fetch('/upstream', { method: 'POST' });
                ctx.emit.head({ status: 200 });
                ctx.emit.chunk('data: {"choices":[{"delta":{"content":"PRIVATE_OUTPUT"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\\n\\n');
                ctx.emit.end();
                ctx.emit.end();
            })({ emit, fetch: async () => ({status: 200}), signal: new AbortController().signal });
            // Observe the detached write without invoking any application or provider.
            let text;
            for (let attempt = 0; attempt < 100; attempt++) {
                try { text = await fs.readFile('data/default-user/latency-monitor/runs.jsonl', 'utf8'); if (text.trim()) break; } catch {}
                await new Promise(r => setTimeout(r, 10));
            }
            assert.ok(text);
            const lines = text.trim().split('\\n');
            assert.equal(lines.length, 1);
            const run = JSON.parse(lines[0]);
            assert.equal(run.response_usage.total_tokens, 6);
            assert.equal(run.output_chars, 14);
            assert.equal(run.outcome, 'stream');
            assert.equal(run.http_status, 200);
            assert.doesNotMatch(text, /PRIVATE_OUTPUT/);
            const controller = new AbortController();
            await assert.rejects(monitorLukerDispatch({ body: { stream: true, messages: [] } }, async () => {
                controller.abort();
                throw new DOMException('PRIVATE_ERROR', 'AbortError');
            })({ emit, signal: controller.signal }));
            let runs;
            for (let attempt = 0; attempt < 100; attempt++) {
                text = await fs.readFile('data/default-user/latency-monitor/runs.jsonl', 'utf8');
                runs = text.trim().split('\\n').map(line => JSON.parse(line));
                if (runs.length === 2) break;
                await new Promise(r => setTimeout(r, 10));
            }
            assert.equal(runs.length, 2);
            assert.equal(runs[1].client_stopped, true);
            assert.equal(runs[1].abnormal_detail.abnormal_type, 'client_stopped');
            assert.doesNotMatch(text, /PRIVATE_ERROR/);

        `], { cwd: root, stdio: 'pipe' });
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('metadata GET is preprocessing and emitted timeout keeps its category', async () => {
    const h = harness();
    await h.wrap(async ctx => {
        await ctx.fetch('/models');
        assert.equal(h.calls.length, 0);
        await ctx.fetch('/completion', { method: 'POST' });
        assert.ok(h.calls.includes('upstream_request_started'));
        ctx.emit.error(Object.assign(new Error('PRIVATE_TIMEOUT'), { code: 'ETIMEDOUT' }));
    })(h.ctx);
    assert.equal(h.run.error, 'Luker generation timeout');
});

test('oversized JSON retains byte count without claiming empty output', async () => {
    const h = harness(false);
    await h.wrap(async ctx => { ctx.emit.chunk(Buffer.alloc(8 * 1024 * 1024 + 1, 32)); ctx.emit.end(); })(h.ctx);
    assert.equal(h.run.output_chars, null);
    assert.equal(h.run.output_bytes, 8 * 1024 * 1024 + 1);
    assert.equal(h.run.payload, undefined);
});
