import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { createGenerationMonitor } from './latency-monitor.js';

// Best-effort redaction for diagnostics, not a guarantee for arbitrary secret formats.
const SECRET_FIELD = /^(?:authorization|proxy[-_]authorization|(?:x[-_])?api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret)$/i;
const MAX_ERROR_LENGTH = 2048;

function rememberCredentials(value, secrets, depth = 0, budget = { remaining: 128 }) {
    if (!value || typeof value !== 'object' || depth > 3) return;
    const entries = Array.isArray(value) && value.every(item => Array.isArray(item) && item.length === 2)
        ? value : typeof value.entries === 'function' ? value.entries() : Object.entries(value);
    for (const [key, entry] of entries) {
        if (--budget.remaining < 0 || secrets.size >= 128) return;
        if (SECRET_FIELD.test(key) && typeof entry === 'string' && entry.length >= 4 && entry.length <= 4096) {
            secrets.add(entry);
            const token = entry.replace(/^(?:Bearer|Basic)\s+/i, '');
            if (token.length >= 4) secrets.add(token);
        } else if (!['messages', 'prompt', 'content'].includes(key) && entry && typeof entry === 'object') {
            rememberCredentials(entry, secrets, depth + 1, budget);
        }
    }
}

function redactDiagnostic(error, secrets) {
    try { rememberCredentials(error, secrets); } catch { /* Best effort. */ }
    const seen = new Set();
    let remainingNodes = 64;
    let remainingChars = 32768;
    function describe(value, depth = 0) {
        if (value == null || depth > 4 || --remainingNodes < 0) return '';
        if (typeof value === 'string') {
            if (value.length > remainingChars) return '[oversized error omitted]';
            remainingChars -= value.length;
            return value;
        }
        if (typeof value !== 'object') return String(value);
        if (seen.has(value)) return '[circular error]';
        seen.add(value);
        // No stack, request config, headers or arbitrary data/body snapshots.
        return ['name', 'message', 'code', 'type', 'status', 'statusCode', 'error', 'cause', 'errors']
            .filter(key => value[key] != null)
            .map(key => `${key}: ${Array.isArray(value[key])
                ? value[key].slice(0, 4).map(item => describe(item, depth + 1)).join('; ')
                : describe(value[key], depth + 1)}`).join('; ');
    }
    let text = describe(error) || 'Luker generation failed';
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
        text = text.split(secret).join('[REDACTED]');
        text = text.split(encodeURIComponent(secret)).join('[REDACTED]');
    }
    text = text
        .replace(/\b(?:Bearer|Basic)\s+[^\s"',;<>]+/gi, '[REDACTED]')
        .replace(/((?:["']?)(?:authorization|proxy[-_]authorization|(?:x[-_])?api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&,;}]+)/gi, '$1[REDACTED]')
        .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
        .replace(/([?&]key=)[^&#\s"']*/gi, '$1[REDACTED]')
        .replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, '[REDACTED]');
    return text.slice(0, MAX_ERROR_LENGTH);
}

// Observe the provider dispatch, not the HTTP acknowledgement ({}) or WS replay.
// The runner owns cancellation, reconnects and persistence; none are changed here.
export function monitorLukerDispatch(request, dispatch, createMonitor = createGenerationMonitor) {
    let monitor;
    try {
        monitor = createMonitor(request);
    } catch {
        return dispatch;
    }
    let invoked = false;
    return async function monitoredDispatch(ctx) {
        if (invoked) return dispatch(ctx);
        invoked = true;
        const stream = Boolean(request.body?.stream);
        const body = new EventEmitter();
        const decoder = new StringDecoder('utf8');
        let jsonText = '';
        let jsonBytes = 0;
        let terminal = false;
        let failed = false;
        let completed = false;
        let timedOut = false;
        let diagnostic = null;
        let httpErrorText = '';
        let httpErrorBytes = 0;
        let httpErrorStatus = null;
        const errorDecoder = new StringDecoder('utf8');
        const secrets = new Set();
        observeCredentials(request?.headers);
        observeCredentials(request?.body);
        function observeCredentials(value) {
            try { rememberCredentials(value, secrets); } catch { /* Unusual headers must not break dispatch. */ }
        }
        function captureDiagnostic(error) {
            diagnostic = redactDiagnostic(error, secrets);
        }
        // A malformed/error response must not make monitoring retain an unbounded body.
        const maxJsonBytes = 8 * 1024 * 1024;
        const observe = (fn) => { try { fn(); } catch { /* Never fail generation for telemetry. */ } };
        if (stream) observe(() => monitor.attachStream({ body }));

        const emitted = { ...ctx.emit };
        for (const name of ['head', 'chunk', 'end', 'error']) {
            emitted[name] = function (...args) {
                // Preserve the transport's return value, receiver and terminal behavior.
                const result = ctx.emit[name].apply(ctx.emit, args);
                if (!terminal) observe(() => {
                    if (name === 'head') {
                        monitor.setHttpStatus(args[0]?.status);
                        monitor.mark('upstream_headers_received');
                        if (Number(args[0]?.status) >= 400) {
                            failed = true;
                            httpErrorStatus = Number(args[0].status);
                            captureDiagnostic(`Luker upstream HTTP ${Number(args[0].status)}`);
                        }
                    } else if (name === 'chunk') {
                        const chunk = typeof args[0] === 'string' ? Buffer.from(args[0]) : Buffer.from(args[0] ?? []);
                        if (httpErrorStatus) {
                            httpErrorBytes += chunk.byteLength;
                            if (httpErrorBytes <= 32768) httpErrorText += errorDecoder.write(chunk);
                            else httpErrorText = '';
                        }
                        if (stream) body.emit('data', chunk);
                        else {
                            monitor.mark('first_chunk_received');
                            monitor.run.output_bytes += chunk.byteLength;
                            jsonBytes += chunk.byteLength;
                            if (jsonBytes <= maxJsonBytes) jsonText += decoder.write(chunk);
                            else {
                                jsonText = '';
                                // Unknown, not zero: do not diagnose a large reply as empty.
                                monitor.run.output_chars = null;
                            }
                        }
                    } else {
                        terminal = true;
                        completed = name === 'end';
                        if (name === 'error') {
                            failed = true;
                            timedOut = args[0]?.name === 'TimeoutError' || args[0]?.code === 'ETIMEDOUT';
                            captureDiagnostic(args[0]);
                        }
                        if (stream) body.emit(completed ? 'end' : 'close');
                        else if (completed) monitor.mark('stream_completed');
                    }
                });
                return result;
            };
        }

        const observedContext = {
            ...ctx,
            emit: emitted,
            async fetch(...args) {
                observeCredentials(args[0]?.headers);
                observeCredentials(args[1]?.headers);
                try {
                    const url = new URL(typeof args[0] === 'string' ? args[0] : args[0]?.url);
                    observeCredentials(Object.fromEntries(url.searchParams));
                    observeCredentials({ api_key: url.searchParams.get('key') });
                    observeCredentials({ password: decodeURIComponent(url.password) });
                } catch { /* Relative URLs have no upstream credentials to collect. */ }
                // Provider metadata GETs (e.g. OpenRouter model lookup) are preprocessing.
                const isGenerationFetch = String(args[1]?.method ?? args[0]?.method ?? 'GET').toUpperCase() === 'POST';
                if (isGenerationFetch) observe(() => {
                    monitor.mark('preprocess_completed');
                    monitor.mark('upstream_request_started');
                });
                const response = await ctx.fetch.apply(ctx, args);
                if (isGenerationFetch) observe(() => {
                    monitor.setHttpStatus(response.status);
                    monitor.mark('upstream_headers_received');
                });
                return response;
            },
        };
        try {
            return await dispatch(observedContext);
        } catch (error) {
            failed = true;
            timedOut = error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT';
            observe(() => captureDiagnostic(error));
            throw error;
        } finally {
            observe(() => {
                // Some dispatches leave end to the runner; a resolved dispatch is complete.
                if (!terminal) {
                    completed = !failed;
                    if (stream) body.emit(completed ? 'end' : 'close');
                    else if (completed) monitor.mark('stream_completed');
                }
                if (httpErrorText && httpErrorBytes <= 32768) {
                    try {
                        const payload = JSON.parse(httpErrorText + errorDecoder.end());
                        captureDiagnostic({ status: httpErrorStatus, error: payload.error ?? payload });
                    } catch { /* Non-JSON body may be an HTML proxy page, not a safe diagnostic. */ }
                }
                // Stream close observation can overwrite errors; restore useful redacted detail last.
                if (ctx.signal?.aborted) diagnostic = `AbortError: generation cancelled; ${diagnostic ?? ''}`;
                else if (timedOut) diagnostic = `Luker generation timeout; ${diagnostic ?? ''}`;
                if (diagnostic) monitor.captureError(new Error(redactDiagnostic(diagnostic, secrets)));
                if (!stream && !failed && jsonBytes <= maxJsonBytes && jsonText) {
                    monitor.captureJson(JSON.parse(jsonText + decoder.end()));
                }
            });
            try {
                // Do not delay the runner's job completion / WS trailer on disk I/O.
                void Promise.resolve(monitor.finalize({
                    outcome: failed ? 'exception' : stream ? 'stream' : 'json',
                    client_stopped: Boolean(ctx.signal?.aborted),
                })).catch(() => {});
            } catch { /* A failed append must not change the dispatch result. */ }
        }
    };
}
