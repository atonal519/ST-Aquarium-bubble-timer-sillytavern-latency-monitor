import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import { generateAbnormalOptimizationSuggestions } from './settings-ui/service/abnormal-optimization-suggestion-service.js';
import { readMonitorSettings } from './settings-ui/service/monitor-settings-store.js';
import { inferPermissionLevelFromHost } from './settings-ui/service/monitor-settings-validator.js';
import {
    buildPromptMarkerSnapshot,
    findMatchingLearnedPluginRuleForRequest,
} from './shared/plugin-rule-service.js';
import {
    buildAbnormalBillingDetail,
    buildAbnormalDetail,
    buildResponseCompletionReasonFromPayload,
    buildResponseUsageFromPayload,
    detectAbnormalType,
    detectFailedStage,
    extractResponseText,
    findSseEventBoundary,
    hasRecordedOutput,
    isClientAbortError,
    isPromptLikelyOverweight,
    processSseUsageEvent,
    safeStringifyLength,
    shouldReplaceCapturedUsage,
    summarizePrompt,
} from './shared/run-analysis.js';
const LOG_DIR = path.join(process.cwd(), 'data', 'default-user', 'latency-monitor');
const LOG_FILE = path.join(LOG_DIR, 'runs.jsonl');
// 这里只往尾巴上追加，绝不整份重写。runs.jsonl 的轮转、清空、改单条都在服务插件那侧，
// 由它自己的串行锁排队——本文件和服务插件是两个互不相通的模块实例，共用不到那把锁，
// 在这里再开一个整份写者就会和它们互相覆盖。
// 服务插件和本文件是两个互不相通的模块实例，只能靠 LOG_DIR 下的文件传话。
// 这里只读不写，写入与过期清理都由服务插件那侧负责，避免两个写者互相覆盖。
const CLIENT_STOP_SIGNALS_FILE = path.join(LOG_DIR, 'client-stop-signals.json');
const REQUEST_PURPOSE_VALUES = new Set(['chat_main_reply', 'non_chat_generation', 'plugin_internal_request']);
const KNOWN_PLUGIN_LABELS = new Map([
    ['st-baibai-inkwell', '柏宝砚'],
    ['st-baibai-book', '柏宝书'],
    ['baibai_book', '柏宝书'],
    ['schedule-planner', '构画'],
    ['st-sevendayscal', '构画'],
    ['st-seven-days-cal', '构画'],
]);
const KNOWN_INJECTION_SOURCE_LABELS = new Map([
    ...KNOWN_PLUGIN_LABELS.entries(),
    ['abstract-external-phone', 'Abstract外置手机'],
    ['abstract_external_phone', 'Abstract外置手机'],
    ['abstract-phone', 'Abstract外置手机'],
    ['abstract_phone', 'Abstract外置手机'],
]);
const PLUGIN_FINGERPRINT_RULES = [
    {
        pluginId: 'st-baibai-book',
        pluginLabel: '柏宝书',
        markerPatterns: [
            /<bbs_start\b/i,
            /<\/bbs_end>/i,
            /【完整时间锚点格式(?:\(系统强制\)|（系统强制）)】/,
            /【时间锚点要求(?:\(系统强制\)|（系统强制）)】/,
            /本段开始时的故事内时间/,
            /本段结束时的故事内时间/,
            /YYYY\/M\/D HH:mm/i,
            /baibai_book/i,
        ],
        minHits: 2,
    },
    {
        pluginId: 'st-baibai-inkwell',
        pluginLabel: '柏宝砚',
        markerPatterns: [
            /<horae[\s\S]*?>/i,
            /\[柏宝砚\]/,
            /世界书激活失败，继续执行不带世界书的改写/,
            /世界书 EJS 渲染失败，使用宏展开后的文本/,
        ],
        minHits: 1,
    },
    {
        pluginId: 'schedule-planner',
        pluginLabel: '构画',
        markerPatterns: [
            /<outline_widget>/i,
            /<line_widget(?:\s|>)/i,
            /<schedule_widget(?:\s|>)/i,
            /<almanac_widget>/i,
            /【当前的点·按序号】/,
            /【当前的线·按序号】/,
            /【本世界观·重要日期（历）】/,
            /Beat:\s*[^|\n]+\|[^|\n]+\|[^|\n]+\|[^|\n]+\|[^\n]+/,
            /Subtext:\s*/,
            /Think:\s*/,
            /Item:\s*[^|\n]+\|(?:festival|birthday|anniversary|custom)\|/,
            /Line:\s*[^|\n]+\|[^|\n]+\|[^|\n]+\|[^|\n]+\|[^|\n]+\|(?:player|world)\|(?:true|false)/i,
        ],
        minHits: 2,
    },
];

function normalizeOptionalText(value, maxLength = 120) {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    return trimmed.slice(0, maxLength);
}

function getKnownPluginLabel(pluginId) {
    const normalizedPluginId = normalizeOptionalText(pluginId);
    if (!normalizedPluginId) {
        return null;
    }

    return KNOWN_PLUGIN_LABELS.get(normalizedPluginId.toLowerCase()) ?? null;
}

function normalizeRequestPlugin(value) {
    return normalizeOptionalText(value);
}

function normalizeRequestPluginLabel(pluginId, value) {
    return normalizeOptionalText(value) ?? getKnownPluginLabel(pluginId);
}

function getKnownInjectionSourceLabel(sourceId) {
    const normalizedSourceId = normalizeOptionalText(sourceId);
    if (!normalizedSourceId) {
        return null;
    }

    return KNOWN_INJECTION_SOURCE_LABELS.get(normalizedSourceId.toLowerCase()) ?? null;
}

function normalizeRequestInjectionSource(value) {
    return normalizeOptionalText(value);
}

function normalizeRequestInjectionSourceLabel(sourceId, value) {
    return normalizeOptionalText(value) ?? getKnownInjectionSourceLabel(sourceId);
}

function normalizeRequestChatKey(value) {
    return normalizeOptionalText(value, 200);
}

function normalizeRequestChatId(value) {
    return normalizeOptionalText(value, 200);
}

function normalizeRequestChatIdHash(value) {
    return normalizeOptionalText(value, 200);
}

function normalizeRequestChatName(value) {
    return normalizeOptionalText(value, 200);
}

// 前端为每次生成生成的唯一标识。因为 run 只在请求结束后才落盘，
// 前端无法从列表里认出"正在跑"的那次，只能靠这个 id 把异常记录和当前生成对上。
function normalizeRequestClientGenerationId(value) {
    return normalizeOptionalText(value, 100);
}

// 生成类型对应酒馆 Generate(type, ...) 的取值，只有前端能从 GENERATION_STARTED 事件拿到。
// 白名单之外一律丢弃，避免调用方塞进任意字符串。
const GENERATION_TYPE_VALUES = new Set(['normal', 'regenerate', 'swipe', 'continue', 'impersonate', 'quiet']);

function normalizeRequestGenerationType(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return GENERATION_TYPE_VALUES.has(normalized) ? normalized : '';
}

// 楼层由前端在发起生成时随请求体带上来，代理侧自己推不出来。0 是合法楼层，负数和非整数一律丢弃。
function normalizeRequestFloor(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000000) {
        return null;
    }

    return parsed;
}

function resolveExplicitInjectionSource(requestBody) {
    const sourceId = normalizeRequestInjectionSource(
        requestBody?.request_injection_source
        ?? requestBody?.injection_source
        ?? requestBody?.extension_prompt_source
        ?? requestBody?.prompt_injection_source
    );
    const sourceLabel = normalizeRequestInjectionSourceLabel(
        sourceId,
        requestBody?.request_injection_source_label
        ?? requestBody?.injection_source_label
        ?? requestBody?.extension_prompt_source_label
        ?? requestBody?.prompt_injection_source_label
    );

    return {
        sourceId,
        sourceLabel,
    };
}

function collectMessageTexts(messages) {
    if (!Array.isArray(messages)) {
        return [];
    }

    const texts = [];

    function visit(value) {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed) {
                texts.push(trimmed);
            }
            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                visit(item);
            }
            return;
        }

        if (!value || typeof value !== 'object') {
            return;
        }

        if (typeof value.text === 'string') {
            visit(value.text);
        }

        if (typeof value.content === 'string' || Array.isArray(value.content)) {
            visit(value.content);
        }
    }

    for (const message of messages) {
        visit(message?.content);
    }

    return texts;
}

function inferPluginFromRequest(requestBody) {
    const explicitPluginId = normalizeRequestPlugin(requestBody?.request_plugin);
    const explicitPluginLabel = normalizeRequestPluginLabel(explicitPluginId, requestBody?.request_plugin_label);
    if (explicitPluginId || explicitPluginLabel) {
        return {
            pluginId: explicitPluginId,
            pluginLabel: explicitPluginLabel,
            matchMode: explicitPluginId ? 'explicit' : 'explicit_label_only',
            matchScore: 0,
        };
    }

    const learnedRuleMatch = findMatchingLearnedPluginRuleForRequest(requestBody);
    if (learnedRuleMatch?.pluginId || learnedRuleMatch?.pluginLabel) {
        return {
            pluginId: learnedRuleMatch.pluginId,
            pluginLabel: learnedRuleMatch.pluginLabel,
            matchMode: learnedRuleMatch.matchMode,
            matchScore: learnedRuleMatch.matchScore,
        };
    }

    const joinedText = collectMessageTexts(requestBody?.messages).join('\n');
    if (!joinedText) {
        return {
            pluginId: null,
            pluginLabel: null,
            matchMode: 'none',
            matchScore: 0,
        };
    }

    for (const rule of PLUGIN_FINGERPRINT_RULES) {
        let hits = 0;
        for (const pattern of rule.markerPatterns) {
            if (pattern.test(joinedText)) {
                hits += 1;
            }
        }

        if (hits >= rule.minHits) {
            return {
                pluginId: rule.pluginId,
                pluginLabel: rule.pluginLabel,
                matchMode: 'fingerprint',
                matchScore: hits,
            };
        }
    }

    return {
        pluginId: null,
        pluginLabel: null,
        matchMode: 'none',
        matchScore: 0,
    };
}

function nowMs() {
    return Date.now();
}


let lastMonitorSettingsErrorMessage = '';

// 设置读不出来时排障建议和计价会静默退回默认值，外部完全看不出来，所以这里必须留声音。
// 同一个原因只播报一次，恢复正常后重置，避免每条异常记录都刷一行。
async function readMonitorSettingsWithFallback() {
    try {
        const settings = await readMonitorSettings();
        lastMonitorSettingsErrorMessage = '';
        return settings;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastMonitorSettingsErrorMessage) {
            lastMonitorSettingsErrorMessage = message;
            console.error(`[latency-monitor] 读取监控设置失败，排障建议与计价已退回默认值：${message}`);
        }

        return null;
    }
}


// 只在这次确实是断连、且带着生成 id 时才去读文件，正常生成不会产生额外 I/O。
// 信号迟到时这次会退化成"意外断连"，宁可多报一次断连，也不要把真故障说成用户主动停止。
async function hasClientStopSignal(clientGenerationId) {
    if (typeof clientGenerationId !== 'string' || !clientGenerationId.length) {
        return false;
    }

    try {
        const content = await fs.readFile(CLIENT_STOP_SIGNALS_FILE, 'utf8');
        const parsed = JSON.parse(content);
        return Boolean(parsed && typeof parsed === 'object' && parsed[clientGenerationId]);
    } catch {
        return false;
    }
}

async function appendRun(run) {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(LOG_FILE, `${JSON.stringify(run)}\n`, 'utf8');
}


function normalizeRequestPurpose(value) {
    return REQUEST_PURPOSE_VALUES.has(value) ? value : 'chat_main_reply';
}

function resolveRequestPurpose(requestBody, inferredPlugin) {
    const explicitPurpose = normalizeRequestPurpose(requestBody?.request_purpose);
    if (REQUEST_PURPOSE_VALUES.has(requestBody?.request_purpose)) {
        return explicitPurpose;
    }

    if (inferredPlugin?.pluginId || inferredPlugin?.pluginLabel) {
        return 'non_chat_generation';
    }

    return explicitPurpose;
}

export function createGenerationMonitor(request) {
    const startedAtMs = nowMs();
    const requestHost = request?.headers?.['x-forwarded-host']
        ?? request?.headers?.host
        ?? request?.hostname
        ?? '';
    const promptSnapshot = buildPromptMarkerSnapshot({
        messages: request?.body?.messages,
        promptTrace: request?.body?.prompt_trace,
    });
    const inferredPlugin = inferPluginFromRequest(request?.body);
    const explicitInjectionSource = resolveExplicitInjectionSource(request?.body);
    const run = {
        id: crypto.randomUUID(),
        started_at_iso: new Date(startedAtMs).toISOString(),
        started_at_ms: startedAtMs,
        entry_origin: 'main_interface_generation',
        request_purpose: resolveRequestPurpose(request.body, inferredPlugin),
        request_plugin: inferredPlugin.pluginId,
        request_plugin_label: inferredPlugin.pluginLabel,
        request_plugin_match_mode: inferredPlugin.matchMode,
        request_plugin_match_score: inferredPlugin.matchScore,
        request_injection_source: explicitInjectionSource.sourceId,
        request_injection_source_label: explicitInjectionSource.sourceLabel,
        request_chat_key: normalizeRequestChatKey(request.body?.request_chat_key),
        request_chat_id: normalizeRequestChatId(request.body?.request_chat_id),
        request_chat_id_hash: normalizeRequestChatIdHash(request.body?.request_chat_id_hash),
        request_chat_name: normalizeRequestChatName(request.body?.request_chat_name),
        request_floor: normalizeRequestFloor(request.body?.request_floor),
        request_generation_type: normalizeRequestGenerationType(request.body?.request_generation_type),
        request_client_generation_id: normalizeRequestClientGenerationId(request.body?.request_client_generation_id),
        permission_level: inferPermissionLevelFromHost(requestHost, 'cloud_full'),
        stream: Boolean(request.body?.stream),
        source: request.body?.chat_completion_source ?? null,
        model: request.body?.model ?? null,
        user_handle: request.user?.profile?.handle ?? null,
        max_tokens: request.body?.max_tokens ?? null,
        max_completion_tokens: request.body?.max_completion_tokens ?? null,
        message_count: Array.isArray(request.body?.messages) ? request.body.messages.length : null,
        prompt_chars: Array.isArray(request.body?.messages)
            ? safeStringifyLength(request.body.messages)
            : typeof request.body?.messages === 'string'
              ? request.body.messages.length
              : null,
        prompt_markers: promptSnapshot.promptMarkers,
        prompt_trace_keys: promptSnapshot.promptTraceKeys,
        prompt_breakdown: summarizePrompt(request.body?.messages),
        prompt_trace: Array.isArray(request.body?.prompt_trace) ? request.body.prompt_trace : null,
        phases: {},
        metrics: {},
        http_status: null,
        response_usage: null,
        response_finish_reason: null,
        output_bytes: 0,
        // 从 0 起步而不是 null：null 的含义是"这个版本没记正文长度"，判定会退回去看字节数。
        // 一次真的什么正文都没出的生成，结论就是 0，不能和"没记"混为一谈。
        output_chars: 0,
        error: null,
        client_stopped: false,
    };

    let finalized = false;
    let settleStreamParsing = null;
    let streamParsingPromise = Promise.resolve();

    function mark(name) {
        if (!run.phases[name]) {
            run.phases[name] = nowMs();
        }
    }

    function setHttpStatus(status) {
        run.http_status = status;
    }

    function captureJson(json) {
        // 原来记的是整份 JSON 序列化后的长度，也就是连信封一起算。那个数永远大于 0，
        // 正文为空时照样"有输出"，空回复因此完全查不出来。这里只数真正的正文。
        run.output_chars = extractResponseText(json).length;
        const usage = buildResponseUsageFromPayload(json);
        const completionReason = buildResponseCompletionReasonFromPayload(json);
        if (shouldReplaceCapturedUsage(run.response_usage, usage)) {
            run.response_usage = usage;
        }
        if (completionReason) {
            run.response_finish_reason = completionReason;
        }
    }

    // 上游报错分支调这个，传进来的是错误响应体，不是模型正文。原来把它的长度写进
    // output_chars，于是每条报错记录都"有输出"，被判成"部分输出后失败"，而实际上
    // 一个字正文都没出。函数保留是因为酒馆源码里的补丁在调它，改签名就得重新打补丁。
    function captureText() {}

    function captureError(error) {
        run.error = error instanceof Error ? error.message : String(error);
    }

    function attachStream(fetchResponse) {
        const body = fetchResponse?.body;
        if (!body || typeof body.on !== 'function') {
            return;
        }

        streamParsingPromise = new Promise((resolve) => {
            settleStreamParsing = resolve;
        });

        const decoder = new StringDecoder('utf8');
        let sseBuffer = '';
        let streamSettled = false;

        function flushSseBuffer(flushRemainder = false) {
            while (true) {
                const boundary = findSseEventBoundary(sseBuffer);
                if (!boundary) {
                    break;
                }

                const eventBlock = sseBuffer.slice(0, boundary.index);
                sseBuffer = sseBuffer.slice(boundary.index + boundary.length);
                processSseUsageEvent(run, eventBlock);
            }

            if (flushRemainder && sseBuffer.trim()) {
                processSseUsageEvent(run, sseBuffer);
                sseBuffer = '';
            }
        }

        function settleStream({ markCompleted = false, markErrored = false, error = null } = {}) {
            if (streamSettled) {
                return;
            }

            streamSettled = true;
            sseBuffer += decoder.end();
            flushSseBuffer(true);

            if (markCompleted) {
                mark('stream_completed');
            }

            if (markErrored) {
                mark('stream_error');
            }

            if (error) {
                captureError(error);
            }

            settleStreamParsing?.();
        }

        body.on('data', (chunk) => {
            mark('first_chunk_received');
            run.output_bytes += Buffer.byteLength(chunk);
            sseBuffer += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
            flushSseBuffer();
        });

        body.on('end', () => {
            settleStream({ markCompleted: true });
        });

        body.on('error', (error) => {
            settleStream({ markErrored: true, error });
        });

        body.on('aborted', () => {
            settleStream({
                markErrored: true,
                error: new Error('Upstream stream was aborted before completion.'),
            });
        });

        body.on('close', () => {
            if (run.phases.stream_completed || run.phases.stream_error) {
                settleStream();
                return;
            }

            settleStream({
                markErrored: true,
                error: new Error('Upstream stream closed before completion.'),
            });
        });
    }

    async function finalize(extra = {}) {
        if (finalized) {
            return;
        }

        finalized = true;
        if (run.stream) {
            await streamParsingPromise;
        }
        const finishedAtMs = nowMs();
        run.finished_at_iso = new Date(finishedAtMs).toISOString();
        run.finished_at_ms = finishedAtMs;

        Object.assign(run, extra);

        const phases = run.phases;
        run.metrics.total_ms = finishedAtMs - startedAtMs;

        if (phases.preprocess_completed) {
            run.metrics.preprocess_ms = phases.preprocess_completed - startedAtMs;
        }

        if (phases.upstream_request_started && phases.upstream_headers_received) {
            run.metrics.upstream_headers_ms = phases.upstream_headers_received - phases.upstream_request_started;
        }

        if (phases.upstream_request_started && phases.first_chunk_received) {
            run.metrics.ttft_ms = phases.first_chunk_received - phases.upstream_request_started;
        }

        if (phases.first_chunk_received && phases.stream_completed) {
            run.metrics.stream_ms = phases.stream_completed - phases.first_chunk_received;
        }

        if (!run.stream && phases.upstream_request_started) {
            run.metrics.nonstream_response_ms = finishedAtMs - phases.upstream_request_started;
        }

        // Luker provides an explicit job AbortSignal; keep that authoritative signal.
        if (!run.client_stopped && isClientAbortError(String(run.error ?? '').toLowerCase())) {
            run.client_stopped = await hasClientStopSignal(run.request_client_generation_id);
        }

        // 设置由这里读、传进去算：buildAbnormalDetail 本身不碰 I/O，前端形态才能复用同一份逻辑。
        const settings = await readMonitorSettingsWithFallback();
        run.abnormal_detail = buildAbnormalDetail(run, settings);

        // 读不出设置时按"开着"处理：采集是这个插件的全部意义，
        // 因为读配置失败就静默停掉，用户只会看到记录莫名其妙断了一段。
        if (settings?.runtime?.recording_enabled !== false) {
            await appendRun(run);
        }
    }

    return {
        run,
        mark,
        setHttpStatus,
        captureJson,
        captureText,
        captureError,
        attachStream,
        finalize,
    };
}
