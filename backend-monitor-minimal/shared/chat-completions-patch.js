// 本体补丁的唯一定义处。
//
// install.mjs 用它来打补丁，服务插件用它的 detect 字段来自检"补丁装全了没有"。
// 之所以合并成一份，是因为这两边一旦各写各的就会慢慢漂移——文档里长期漏掉
// stream_options 那一处、导致流式记录没有 token 数，就是这么来的。
//
// anchor 必须在未打补丁的原文件里唯一出现。install.mjs 会强制校验这一点，
// 匹配到多处时宁可报错也不猜位置。

export const chatCompletionsPatchTarget = 'src/endpoints/backends/chat-completions.js';

export const chatCompletionsPatches = [
    {
        id: 'import',
        label: '引入 createGenerationMonitor',
        impact: '整个监控不工作',
        detect: `from '../../latency-monitor.js'`,
        anchor: `import { getVertexAIAuth, getProjectIdFromServiceAccount } from '../google.js';`,
        build: (anchor) => `${anchor}\nimport { createGenerationMonitor } from '../../latency-monitor.js';`,
    },
    {
        id: 'declare',
        label: '在 /generate 开头声明 monitor',
        impact: '整个监控不工作',
        detect: `let monitor = null;`,
        anchor: `router.post('/generate', async function (request, response) {\n    try {`,
        build: () => `router.post('/generate', async function (request, response) {\n    let monitor = null;\n\n    try {`,
    },
    {
        id: 'create',
        label: '创建 monitor 并标记预处理完成',
        impact: '不会产生任何记录',
        detect: `createGenerationMonitor(request)`,
        anchor: `        if (request.body.json_schema?.value) {\n            request.body.json_schema.value = flattenSchema(request.body.json_schema.value, request.body.chat_completion_source);\n        }`,
        build: (anchor) => `${anchor}

        const monitorableSources = [
            CHAT_COMPLETION_SOURCES.OPENAI,
            CHAT_COMPLETION_SOURCES.OPENROUTER,
            CHAT_COMPLETION_SOURCES.CUSTOM,
            CHAT_COMPLETION_SOURCES.PERPLEXITY,
            CHAT_COMPLETION_SOURCES.GROQ,
            CHAT_COMPLETION_SOURCES.FIREWORKS,
            CHAT_COMPLETION_SOURCES.NANOGPT,
            CHAT_COMPLETION_SOURCES.POLLINATIONS,
            CHAT_COMPLETION_SOURCES.MOONSHOT,
            CHAT_COMPLETION_SOURCES.COMETAPI,
            CHAT_COMPLETION_SOURCES.ZAI,
            CHAT_COMPLETION_SOURCES.SILICONFLOW,
            CHAT_COMPLETION_SOURCES.WORKERS_AI,
        ];

        if (monitorableSources.includes(request.body.chat_completion_source)) {
            monitor = createGenerationMonitor(request);
            monitor.mark('preprocess_completed');
        }`,
    },
    {
        id: 'usage',
        label: '向上游索取流式 usage',
        impact: '流式生成没有 token 数和成本估算',
        detect: `include_usage: true`,
        anchor: `            'n': request.body.n,\n            ...bodyParams,\n        };\n\n        if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM) {\n            excludeKeysByYaml(requestBody, request.body.custom_exclude_body);\n        }`,
        build: () => `            'n': request.body.n,
            ...bodyParams,
        };

        if (request.body.stream && [
            CHAT_COMPLETION_SOURCES.OPENAI,
            CHAT_COMPLETION_SOURCES.CUSTOM,
        ].includes(request.body.chat_completion_source)) {
            requestBody.stream_options = {
                ...(requestBody.stream_options ?? {}),
                include_usage: true,
            };
        }

        if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            excludeKeysByYaml(requestBody, request.body.custom_exclude_body);
        }`,
    },
    {
        id: 'fetch',
        label: '给上游请求前后打点',
        impact: '分不出酒馆自身耗时和上游耗时',
        detect: `monitor?.mark('upstream_request_started')`,
        anchor: `        console.debug('Chat Completion request:', requestBody);\n\n        const fetchResponse = await fetch(endpointUrl, config);`,
        build: () => `        console.debug('Chat Completion request:', requestBody);

        monitor?.mark('upstream_request_started');
        const fetchResponse = await fetch(endpointUrl, config);
        monitor?.setHttpStatus(fetchResponse.status);
        monitor?.mark('upstream_headers_received');`,
    },
    {
        id: 'stream',
        label: '流式分支收尾',
        impact: '流式生成不落盘',
        detect: `monitor?.attachStream(`,
        anchor: `        if (request.body.stream) {\n            console.info('Streaming request in progress');\n            return await forwardFetchResponse(fetchResponse, response);\n        }`,
        build: () => `        if (request.body.stream) {
            console.info('Streaming request in progress');
            monitor?.attachStream(fetchResponse);
            const result = await forwardFetchResponse(fetchResponse, response);
            await monitor?.finalize({ outcome: 'stream' });
            return result;
        }`,
    },
    {
        id: 'json',
        label: '非流式分支收尾',
        impact: '非流式生成不落盘',
        detect: `monitor?.captureJson(`,
        anchor: `            console.debug('Chat Completion response:', json);\n            return response.send(json);`,
        build: () => `            console.debug('Chat Completion response:', json);
            monitor?.captureJson(json);
            await monitor?.finalize({ outcome: 'json' });
            return response.send(json);`,
    },
    {
        id: 'error',
        label: '上游报错分支收尾',
        impact: '上游返回错误时不落盘',
        detect: `outcome: 'error_response'`,
        anchor: `            console.error('Chat completion request error: ', message, responseText);`,
        build: (anchor) => `${anchor}
            monitor?.captureText(responseText);
            monitor?.captureError(new Error(message));
            await monitor?.finalize({ outcome: 'error_response' });`,
    },
    {
        id: 'exception',
        label: '异常兜底收尾',
        impact: '连接中断等异常不落盘',
        detect: `outcome: 'exception'`,
        anchor: `    } catch (error) {\n        console.error('Generation failed', error);`,
        build: () => `    } catch (error) {
        monitor?.captureError(error);
        await monitor?.finalize({ outcome: 'exception' });
        console.error('Generation failed', error);`,
    },
];

// Luker routes requests through a provider-independent dispatch pipeline. Keep
// this patch set separate: vanilla's fetch/stream anchors no longer exist there.
export const lukerChatCompletionsPatches = [
    {
        id: 'luker-import',
        label: '引入 monitorLukerDispatch',
        impact: 'Luker 调度监控不工作',
        detect: `import { monitorLukerDispatch } from '../../luker-latency-monitor.js';`,
        anchor: `import { runLukerDispatch } from '../../luker-dispatch/runner.js';`,
        build: (anchor) => `${anchor}\nimport { monitorLukerDispatch } from '../../luker-latency-monitor.js';`,
    },
    {
        id: 'luker-dispatch',
        label: '包装 Luker provider 调度',
        impact: 'Luker 生成不会产生记录',
        detect: `select: (b) => monitorLukerDispatch(req, selectChatCompletionDispatch(b)),`,
        anchor: `select: (b) => selectChatCompletionDispatch(b),`,
        build: () => `select: (b) => monitorLukerDispatch(req, selectChatCompletionDispatch(b)),`,
    },
];

export function getChatCompletionsPatches(source) {
    // Require the actual dispatcher import, rather than a comment mentioning Luker.
    const isLuker = /^import\s*\{\s*runLukerDispatch\s*\}\s*from\s*['"]\.\.\/\.\.\/luker-dispatch\/runner\.js['"];?/m.test(source);
    return isLuker ? lukerChatCompletionsPatches : chatCompletionsPatches;
}

/**
 * 按内容特征判断每一处补丁在不在。只读字符串，不解析语法，
 * 所以用户自己调整过缩进或改过 monitorableSources 名单也不会误判。
 * @param {string} source chat-completions.js 的全文
 */
export function inspectChatCompletionsPatches(source) {
    const text = typeof source === 'string' ? source : '';
    const results = getChatCompletionsPatches(text).map((patch) => ({
        id: patch.id,
        label: patch.label,
        impact: patch.impact,
        present: text.includes(patch.detect),
    }));

    const missing = results.filter((item) => !item.present);

    return {
        total: results.length,
        present_count: results.length - missing.length,
        missing,
        results,
        // 一处都没打和打了一半是两种完全不同的故障，给出的提示也不一样。
        state: missing.length === 0
            ? 'complete'
            : missing.length === results.length
              ? 'absent'
              : 'partial',
    };
}
