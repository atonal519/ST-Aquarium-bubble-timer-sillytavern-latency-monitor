import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { createGenerationMonitor } from './latency-monitor.js';

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
                            monitor.captureError(new Error(`Luker upstream HTTP ${Number(args[0].status)}`));
                        }
                    } else if (name === 'chunk') {
                        const chunk = typeof args[0] === 'string' ? Buffer.from(args[0]) : Buffer.from(args[0] ?? []);
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
                            // Upstream error text can echo prompts or credentials. Keep only category.
                            monitor.captureError(new Error('Luker generation failed'));
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
            observe(() => monitor.captureError(new Error('Luker generation failed')));
            throw error;
        } finally {
            observe(() => {
                // Some dispatches leave end to the runner; a resolved dispatch is complete.
                if (!terminal) {
                    completed = !failed;
                    if (stream) body.emit(completed ? 'end' : 'close');
                    else if (completed) monitor.mark('stream_completed');
                }
                if (ctx.signal?.aborted) monitor.captureError(new Error('AbortError: generation cancelled'));
                else if (timedOut) monitor.captureError(new Error('Luker generation timeout'));
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
