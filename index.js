import { eventSource, event_types, stopGeneration } from "../../../../script.js";
// Namespace import so a missing export in an older SillyTavern build degrades instead of breaking module linking.
import * as sillyTavernScript from "../../../../script.js";

const MODULE_NAME = "st-latency-profiler";
const MODULE_DISPLAY_NAME = "鱼缸后端监控";
const BACKEND_BASE = "/api/plugins/st-latency-monitor";
const UI_STORAGE_KEY = `${MODULE_NAME}:ui`;
const UI_RETRY_MS = 3000;
const HISTORY_PAGE_SIZE = 20;
const HISTORY_PREVIEW_COUNT = 5;
const GENERATION_RECOVERY_WINDOW_MS = 15000;
const MINIMIZED_BUTTON_MARGIN = 18;
const MINIMIZED_BUTTON_SIZE = 34;
const MINIMIZED_BUTTON_DRAG_THRESHOLD = 4;
const MINIMIZED_BUTTON_TOUCH_FALLBACK_IDLE_MS = 3000;
// 兜底而已：正常情况靠 pointerup / pointercancel 收尾。超时提前触发最坏也只是多渲染一次，
// 退回改动之前的行为，不会比现在更糟，所以不用取一个很长的值。
const PANEL_SLIDER_INTERACTION_IDLE_MS = 8000;
const MAIN_API_MANUAL_STOP_GRACE_MS = 1500;
const MOBILE_OPEN_GUARD_MS = 360;
// 消息区规整只为这几样醒来。反过来列"要忽略什么"是行不通的：酒馆流式输出时逐块重写的
// 不止正文，还有 .mes_timer（script.js:3674）和推理块（reasoning.js:594），挨个拉黑等于
// 把它的内部实现抄进我们的判断条件，它一改我们就漏。
const CHAT_UI_STRUCTURE_SELECTOR = ".mes, .mes_block, .message, .avatar, .mesAvatar, .missing-avatar";
const CHAT_UI_ATTRIBUTE_SELECTOR = ".mes, .mes_block, .message, .avatar, .mesAvatar, .avatar img, .mesAvatar img, .avatar_holder, .mesAvatarWrapper";
const CHAT_UI_FULL_NORMALIZE_MIN_INTERVAL_MS = 200;
const WAITING_QUEUE_EDIT_LOCK_MS = 1500;
const PENDING_INJECTION_SOURCE_TTL_MS = 10000;
// 生成类型来自 GENERATION_STARTED 事件，而拓展自己发的生成请求不走酒馆的 Generate()，
// 拿不到这个事件。用消费一次 + TTL 双重兜底，避免上一次正文生成的类型串到拓展调用头上。
const PENDING_GENERATION_TYPE_TTL_MS = 10000;
const SYNTHETIC_ESCAPE_IGNORE_WINDOW_MS = 800;
const SEND_UI_UNLOCK_POLL_INTERVAL_MS = 50;
const SEND_UI_UNLOCK_SELF_RECOVERY_MS = 1000;
// SillyTavern's own post-abort swipe-back can hold swipeState for up to ~1s, so the risky
// swipe-state reset waits longer than the cheap send-button unlock to avoid racing it.
const SWIPE_STATE_RESET_GRACE_MS = 3000;
const DEFAULT_SWIPE_STATE_NONE = "none";
const DAILY_SUMMARY_DAY_OPTIONS = [7, 14, 30];
let stRequestHeadersFactoryPromise = null;
const THEME_MODE_SEQUENCE = ["dawn", "rose", "night", "follow_tavern"];
// client_stopped 刻意不在这里：那是用户自己按的停止，再弹"这次生成大概率不会正常返回"很荒唐。
const ACTIONABLE_ABNORMAL_TYPES = new Set([
    "client_disconnected",
    "failed_without_output",
    "failed_after_partial_output",
    "failed_generation",
    "request_timeout",
    "stream_interrupted",
    "suspected_incomplete_generation",
]);

const DEFAULT_SECTION_OPEN_STATES = {
    status: true,
    settings: false,
    summary: true,
    runs: true,
    history: true,
};

const DEFAULT_OUTPUT_CARD_FIELDS = {
    showInjectionDetails: false,
    showPricingDetails: false,
    showContextVolume: false,
    showPromptVolume: false,
    showExtensionDetails: false,
    maskChatTitle: false,
};

const PROMPT_VOLUME_TOP_MESSAGE_COUNT = 5;
const PROMPT_VOLUME_SINGLE_MESSAGE_DOMINANT_RATIO = 0.4;
const PROMPT_VOLUME_ROLE_DOMINANT_RATIO = 0.5;
const PROMPT_VOLUME_HISTORY_DOMINANT_RATIO = 0.6;
const PROMPT_VOLUME_HISTORY_MESSAGE_THRESHOLD = 20;
// 单条明细约 4.6KB，缓存要设上限，否则翻久了历史会一直涨。
const PROMPT_VOLUME_CACHE_LIMIT = 50;

const PROMPT_ROLE_LABELS = {
    system: "系统提示",
    user: "用户",
    assistant: "助手",
    tool: "工具",
    function: "函数",
    unknown: "未知角色",
};

const DEFAULT_SETTINGS_SUBSECTION_OPEN_STATES = {
    appearance_theme: false,
    appearance_minimized_color: false,
    appearance_main_api_alert: false,
};

const RUN_CHAT_MAP_REVISION = 2;
let pendingUiSettingsMigrationSave = false;

const DEFAULT_UI_SETTINGS = {
    autoRefreshSeconds: 15,
    abnormalOnly: false,
    cacheHitOnly: false,
    currentChatOnly: false,
    dailySummaryDays: 14,
    activeRequestPurpose: "chat_main_reply",
    activeMainView: "monitor",
    settingsCategory: "none",
    keepRunningAfterClose: true,
    themeMode: "follow_tavern",
    minimizedButtonColorMode: "follow_theme",
    minimizedButtonCustomColor: "#67d98f",
    minimizedButtonStrokeColor: "#ffffff",
    minimizedButtonBorderColor: "#c8ccd2",
    minimizedButtonBorderVisible: true,
    minimizedButtonOpacity: 1,
    minimizedButtonBackgroundMode: "mist",
    minimizedButtonPosition: null,
    mainApiErrorIndicatorEnabled: true,
    mainApiErrorClearOnRegenerate: true,
    runFloorMap: {},
    runChatMap: {},
    runChatMapRevision: RUN_CHAT_MAP_REVISION,
    sectionOpenStates: DEFAULT_SECTION_OPEN_STATES,
    pricingConfigByModel: {},
    pricingPanelOpenStates: {},
    pricingPeakValleyOpenStates: {},
    outputCardFields: DEFAULT_OUTPUT_CARD_FIELDS,
    callTimer: { running: false, startedAtMs: 0, stoppedAtMs: 0 },
    callTimerSessions: [],
    callTimerExpectedSources: [],
};

const PERMISSION_LABELS = {
    no_backend: "无后台权限",
    local_full: "本地部署完整权限",
    cloud_full: "云端部署完整权限",
};

const RUNTIME_MODE_LABELS = {
    auto: "自动选择",
    no_backend: "无后台权限",
    local_full: "本地部署完整权限",
    cloud_full: "云端部署完整权限",
};

const ENTRY_ORIGIN_LABELS = {
    main_interface_generation: "主界面生成记录",
    standalone_page: `${MODULE_DISPLAY_NAME} 独立页面`,
};

const SOURCE_LABELS = {
    custom: "自定义接口",
    openai: "OpenAI 接口",
    openrouter: "OpenRouter 接口",
    claude: "Claude 接口",
    gemini: "Gemini 接口",
    textgenerationwebui: "文本生成网页界面接口",
    koboldcpp: "KoboldCpp 接口",
    novelai: "NovelAI 接口",
};

const REQUEST_PURPOSE_LABELS = {
    chat_main_reply: "正文回复",
    non_chat_generation: "拓展调用",
    plugin_internal_request: "插件内部请求",
};

// 对应酒馆 Generate(type, ...) 的六种取值，由 GENERATION_STARTED 事件的第一个参数下发。
const GENERATION_TYPE_LABELS = {
    normal: "正常发送",
    regenerate: "重新生成",
    swipe: "滑动",
    continue: "续写",
    impersonate: "替我说",
    quiet: "后台静默",
};

// 区间统计：清点一段时间内一共发生了多少次调用、分别是谁发的。
//
// 窗口边界由用户手动划定，不做自动分轮。原因是拓展调用不走酒馆 Generate()，
// 收不到生成事件（见文件顶部关于生成事件的注释），调用经常发生在 GENERATION_ENDED
// 之后，自动分轮必须"延后关闭"，那个 TTL 设多少都是拍脑袋。手动计时反而没有猜测成分。
const CALL_TIMER_MAX_SESSIONS = 10;
// 和两种后端的单页上限一致：server-plugin 的 MAX_RUNS_PAGE_LIMIT 与 lite/local-api.js 同名常量。
const CALL_TIMER_RUNS_LIMIT = 2000;
// run 是请求结束才落盘的，按下停止时可能还有调用在飞，停表后按这两个间隔各补捞一次。
// 补捞只影响显示，不改窗口边界。
// 记录是生成结束才落盘的，而一次生成可能要两分钟以上（实测上游首字节等待中位数
// 就有 120 秒）。原来的 3 秒 / 10 秒是按"一次生成十几秒"定的，停表时记录还没写进
// 文件，补捞必然是空的。
const CALL_TIMER_REFETCH_DELAYS_MS = [15000, 60000, 180000];
// 计时期间的轮询：不轮询的话，页面显示的永远是按下"开始计时"那一刻的空快照。
const CALL_TIMER_POLL_INTERVAL_MS = 10000;
// 轮询不能拉满 2000 条——那一次约 2.5 MB。计时窗口内的记录数量有限，
// 最新 200 条足够覆盖，约 250 KB。
const CALL_TIMER_POLL_RUNS_LIMIT = 200;
const CALL_TIMER_EXPECTED_SOURCE_LIMIT = 50;
// 明细上限只是防呆：一次生成通常十几条，但窗口拉长后可能有上千条，全渲染会卡住面板。
const CALL_TIMER_DETAIL_LIMIT = 300;
const CALL_TIMER_SOURCE_QUIET = "后台静默（总结/向量等）";
const CALL_TIMER_SOURCE_UNKNOWN_PLUGIN = "未知拓展调用";
const CALL_TIMER_SOURCE_MAIN_REPLY = "正文回复";

const REQUEST_PLUGIN_MATCH_MODE_LABELS = {
    explicit: "调用方显式上报",
    explicit_label_only: "仅显式上报名称",
    fingerprint: "后端指纹识别",
    learned_rule: "等待区规则复用",
    explicit_purpose_only: "仅显式上报用途",
    fallback_unknown: "未知拓展兜底",
    manual_waiting_queue: "等待区手动标注",
    none: "未识别",
};

const KNOWN_PLUGIN_LABELS = {
    "st-baibai-inkwell": "柏宝砚",
    "st-baibai-book": "柏宝书",
    "baibai_book": "柏宝书",
    "schedule-planner": "构画",
    "st-sevendayscal": "构画",
    "st-seven-days-cal": "构画",
    // 认不出拓展时的占位 id。现在写的是连字符版（它再 slugify 一次还是自己），
    // 下划线版是这个改动之前落盘的老记录，一并留着。
    "unknown-plugin": "未知拓展调用",
    "unknown_plugin": "未知拓展调用",
};

const KNOWN_INJECTION_SOURCE_LABELS = {
    ...KNOWN_PLUGIN_LABELS,
    "abstract-external-phone": "Abstract外置手机",
    "abstract_external_phone": "Abstract外置手机",
    "abstract-phone": "Abstract外置手机",
    "abstract_phone": "Abstract外置手机",
};

const TRACE_SOURCE_LABELS = {
    extension_prompt: "扩展提示词",
    chat_injects: "聊天注入",
    memory_summary: "记忆摘要",
    smart_context: "智能上下文",
    chat_vectors: "聊天向量检索",
    data_bank_vectors: "资料库向量检索",
    world_info: "世界书",
    authors_note: "作者注释",
    instruct: "指令模式",
};

const ABNORMAL_TYPE_LABELS = {
    client_stopped: "你主动停止",
    client_disconnected: "连接中断",
    failed_without_output: "未输出即失败",
    failed_after_partial_output: "部分输出后失败",
    failed_generation: "完整生成失败",
    request_timeout: "请求超时",
    stream_interrupted: "流式中断",
    suspected_incomplete_generation: "疑似未完整生成",
    empty_response: "回复是空的",
};

const ABNORMAL_BILLING_STATUS_LABELS = {
    paid_incomplete: "已付费未完成",
    usage_unconfirmed: "费用未确认",
};

const FAILED_STAGE_LABELS = {
    preprocess: "预处理阶段",
    retrieval: "检索阶段",
    prompt_assembly: "提示词组装阶段",
    request_model: "请求模型阶段",
    before_first_output: "首个输出返回前",
    full_return: "完整返回阶段",
};
const COMPLETION_REASON_LABELS = {
    stop: "自然结束",
    stop_sequence: "命中停止词",
    end_turn: "自然结束",
    tool_calls: "工具调用",
    function_call: "函数调用",
    max_tokens: "达到最大输出",
    safety: "安全拦截",
    recitation: "引用拦截",
    content_filter: "内容过滤",
    blocklist: "命中拦截词",
    prohibited_content: "命中限制内容",
    spii: "敏感信息拦截",
    malformed_function_call: "函数调用异常",
    other: "其他结束原因",
    unspecified: "未说明结束原因",
};

const SUGGESTION_SCOPE_LABELS = {
    failed_generation_only: "仅生成失败/中断相关异常时显示",
    all_abnormal: "所有异常时显示",
};

const THEME_MODE_LABELS = {
    dawn: "主题：晨曦",
    rose: "主题：暮粉",
    night: "主题：夜",
    follow_tavern: "主题：跟随酒馆模式",
};

const SETTINGS_CATEGORY_LABELS = {
    none: "未展开",
    runtime: "运行与建议",
    output_card: "排障卡",
    pricing: "价格估算",
    appearance: "外观与主题",
};

const MINIMIZED_BUTTON_OPACITY_MIN = 0.1;

const MINIMIZED_BUTTON_COLOR_PRESETS = [
    { key: "mist_blue", label: "晨雾蓝", color: "#4F6A88" },
    { key: "night_cyan", label: "夜色青", color: "#76C6D9" },
    { key: "tavern_green", label: "酒馆绿", color: "#67D98F" },
    { key: "mint", label: "薄荷绿", color: "#86F0C2" },
    { key: "seafoam", label: "海沫青", color: "#52D1C7" },
    { key: "teal", label: "青湖蓝", color: "#36C4D6" },
    { key: "sky", label: "天青", color: "#4DB4FF" },
    { key: "ice", label: "冰蓝", color: "#8FD3FF" },
    { key: "electric", label: "电蓝", color: "#3FA7FF" },
    { key: "indigo", label: "靛蓝", color: "#6F8DFF" },
    { key: "violet", label: "紫罗兰", color: "#9B8CFF" },
    { key: "lavender", label: "薰衣草", color: "#B39DFF" },
    { key: "orchid", label: "兰紫", color: "#C087FF" },
    { key: "rose_purple", label: "玫紫", color: "#E48CFF" },
    { key: "rose", label: "樱粉", color: "#FF8FB1" },
    { key: "magenta", label: "玫红", color: "#FF6FAE" },
    { key: "watermelon", label: "西瓜红", color: "#FF6B84" },
    { key: "coral", label: "珊瑚橙", color: "#FF8A7A" },
    { key: "peach", label: "蜜桃橙", color: "#FFB26B" },
    { key: "amber", label: "琥珀金", color: "#FFC857" },
    { key: "gold", label: "金砂", color: "#F4C95D" },
    { key: "lime", label: "青柠", color: "#B7E36D" },
    { key: "leaf", label: "嫩叶绿", color: "#6EE7A8" },
    { key: "sage", label: "鼠尾草", color: "#7CC5B3" },
];

const MINIMIZED_BUTTON_COLOR_MODE_LABELS = {
    follow_theme: "跟随酒馆主题配色",
    custom: "自定义颜色",
};

const MINIMIZED_BUTTON_BACKGROUND_MODE_LABELS = {
    mist: "半透明灰底",
    transparent: "透明底",
};

const PRICING_CURRENCY_LABELS = {
    usd: "美元",
    cny: "人民币",
};

const PRICING_BASE_NUMBER_FIELDS = [
    "input_price_per_million",
    "cached_input_price_per_million",
    "output_price_per_million",
];

const PRICING_PEAK_VALLEY_NUMBER_FIELDS = [
    "peak_input_price_per_million",
    "peak_cached_input_price_per_million",
    "peak_output_price_per_million",
    "valley_input_price_per_million",
    "valley_cached_input_price_per_million",
    "valley_output_price_per_million",
];

const PRICING_NUMBER_FIELDS = [...PRICING_BASE_NUMBER_FIELDS, ...PRICING_PEAK_VALLEY_NUMBER_FIELDS];

const PRICING_TIME_FIELDS = [
    "peak_start_time",
    "peak_end_time",
];

const PRICING_BOOLEAN_FIELDS = [
    "peak_valley_enabled",
];

const state = {
    pageRoot: null,
    launcherRoot: null,
    uiReady: false,
    eventsBound: false,
    nativeMenuItemRegistered: false,
    uiSettings: loadUiSettings(),
    settings: null,
    status: null,
    runs: [],
    summary: null,
    dailySummary: null,
    isRefreshing: false,
    isSaving: false,
    backendReady: false,
    // 记录从哪来：full 走后端插件，lite 走浏览器本地采集。
    // unknown 表示还没探测完，此时不采集，避免和后端重复记一遍。
    recordSourceMode: "unknown",
    // 精简模式下正在进行的那条记录，停止按钮要靠它打"用户主动停止"的标记。
    liteActiveRun: null,
    // 从精简版升级到完整版之后，浏览器里那批旧记录不会自动消失，但面板改读后端就看不见了。
    // 这两个字段负责把它们摆到明面上，而不是让用户以为数据没了。
    legacyLiteRunCount: 0,
    legacyLiteViewing: false,
    apiStatus: "正在连接后台监控接口",
    apiError: "",
    refreshTimerId: null,
    uiRetryTimerId: null,
    extensionDisabled: false,
    initialDataLoaded: false,
    outgoingGenerationHookInstalled: false,
    generationSettingsHookInstalled: false,
    activeGenerationRequests: new Map(),
    sillyTavernGenerationActive: false,
    sillyTavernGenerationRecoveryUntil: 0,
    // 随请求体一起发给后端的本次生成标识。后端只在请求结束后才落盘 run，
    // 列表里永远看不到"正在跑"的那次，只能靠这个 id 判断一条异常记录是不是当前这次生成。
    currentGenerationClientId: "",
    // 一次手动终止过程中攒下的只读快照，动作走完后合成一条上报，随后清空。
    forceStopDiagnosticsSnapshots: [],
    sillyTavernSwipeConstants: undefined,
    pendingInjectionSource: null,
    // { type, reportedAt }：等待随下一个生成请求带下去的生成类型。
    pendingGenerationType: null,
    chatWindowContext: {
        chatKey: "",
        chatName: "",
        isHome: true,
        detectedAt: 0,
        visibleFloorLabels: [],
        latestFloorLabel: "",
    },
    nativeMenuObserver: null,
    nativeMenuObserverRoot: null,
    nativeMenuRepairScheduled: false,
    nativeMenuObserverSilenced: false,
    pageOpen: false,
    pageMinimized: false,
    pageOpenRequestAt: 0,
    pageOpenGuardUntil: 0,
    syntheticEscapeIgnoreUntil: 0,
    confirmDialog: null,
    pageScrollTop: 0,
    pagePosition: null,
    pageHeight: null,
    pageDrag: null,
    pageResize: null,
    bodyScrollLocked: false,
    bodyScrollLockTop: 0,
    viewportSyncQueued: false,
    minimizedButtonDrag: null,
    minimizedButtonDragRenderPending: false,
    minimizedButtonSuppressClickUntil: 0,
    minimizedButtonLongPressTimerId: null,
    minimizedButtonLongPressTriggered: false,
    minimizedButtonTouchFallback: null,
    minimizedButtonTouchFallbackTimerId: null,
    sliderInteractionPointerId: null,
    sliderInteractionRenderPending: false,
    sliderInteractionTimerId: null,
    chatUiObserver: null,
    chatUiNormalizeScheduled: false,
    chatUiNormalizeTimerId: null,
    chatUiLastFullNormalizeAtMs: 0,
    historyDialogOpen: false,
    historyDeleteMode: false,
    historyAbnormalOnly: false,
    historyPage: 1,
    historyTotal: 0,
    historyRuns: [],
    historyAllRuns: [],
    historyLoading: false,
    historyError: "",
    historyScrollTop: 0,
    filteredRuns: [],
    filteredRunsKey: "",
    filteredRunsPendingKey: "",
    filteredRunsLoading: false,
    // /runs 列表不再下发 prompt_breakdown，展开详情时才按 run 单独取回来。
    promptBreakdownByRunId: {},
    promptBreakdownLoadingRunIds: new Set(),
    waitingQueueEntries: [],
    waitingQueueLoading: false,
    waitingQueueError: "",
    waitingQueueDrafts: {},
    waitingQueueEditLockRunId: "",
    waitingQueueEditLockUntil: 0,
    waitingQueueRenderPending: false,
    colorWheelRenderPending: false,
    pluginRules: [],
    pluginRulesLoading: false,
    pluginRulesError: "",
    selectedHistoryRunIds: new Set(),
    expandedDailySummaryDateKeys: new Set(),
    expandedWaitingQueueRunIds: new Set(),
    expandedPluginRuleIds: new Set(),
    expandedRunIds: new Set(),
    expandedSuggestionRunIds: new Set(),
    minimizedButtonFlashActive: false,
    minimizedButtonFlashTimerId: null,
    mainApiErrorActive: false,
    recentManualStopAtMs: 0,
    minimizedButtonAlertPending: false,
    pendingGenerationIntervention: null,
    lastDismissedGenerationInterventionKey: "",
    lastSeenAbnormalRunId: "",
    abnormalAlertInitialized: false,
    settingsSubsectionOpenStates: { ...DEFAULT_SETTINGS_SUBSECTION_OPEN_STATES },
    callTimerRuns: [],
    callTimerLoading: false,
    callTimerError: "",
    callTimerTruncated: false,
    callTimerFetchedAtMs: 0,
    // 这一批记录是按多大的 limit 取回来的：轮询用小包，截断提示要照实报这个数。
    callTimerLoadedLimit: CALL_TIMER_RUNS_LIMIT,
    callTimerRefetchTimerIds: [],
    callTimerTickTimerId: null,
    callTimerPollTimerId: null,
    // 回看中的历史区间。只活在内存里：刷新后收起，本次计时不受它影响。
    callTimerHistorySessionId: "",
    // 两张卡片各自的"逐条明细"折叠状态，取值 "current" / "history"。
    callTimerExpandedDetailScopes: new Set(),
};

function loadUiSettings() {
    try {
        const raw = localStorage.getItem(UI_STORAGE_KEY);
        if (!raw) {
            return { ...DEFAULT_UI_SETTINGS };
        }

        const parsed = JSON.parse(raw);
        const parsedRunChatMapRevision = Number(parsed?.runChatMapRevision) || 0;
        const shouldResetRunChatMap = parsedRunChatMapRevision !== RUN_CHAT_MAP_REVISION;
        if (shouldResetRunChatMap) {
            pendingUiSettingsMigrationSave = true;
        }

        return {
            ...DEFAULT_UI_SETTINGS,
            ...parsed,
            dailySummaryDays: normalizeDailySummaryDays(parsed?.dailySummaryDays),
            activeRequestPurpose: normalizeRequestPurposeMode(parsed?.activeRequestPurpose),
            activeMainView: normalizeMainViewMode(parsed?.activeMainView),
            settingsCategory: normalizeSettingsCategory(parsed?.settingsCategory),
            themeMode: normalizeThemeMode(migrateLegacyThemeMode(parsed?.themeMode)),
            minimizedButtonColorMode: normalizeMinimizedButtonColorMode(parsed?.minimizedButtonColorMode),
            minimizedButtonCustomColor: normalizeMinimizedButtonCustomColor(parsed?.minimizedButtonCustomColor, parsed?.minimizedButtonColorMode),
            minimizedButtonStrokeColor: normalizeMinimizedButtonStrokeColor(parsed?.minimizedButtonStrokeColor),
            minimizedButtonBorderColor: normalizeMinimizedButtonBorderColor(parsed?.minimizedButtonBorderColor),
            minimizedButtonBorderVisible: normalizeMinimizedButtonBorderVisible(parsed?.minimizedButtonBorderVisible),
            minimizedButtonOpacity: normalizeMinimizedButtonOpacity(parsed?.minimizedButtonOpacity),
            minimizedButtonBackgroundMode: normalizeMinimizedButtonBackgroundMode(parsed?.minimizedButtonBackgroundMode),
            minimizedButtonPosition: normalizeMinimizedButtonPosition(parsed?.minimizedButtonPosition),
            mainApiErrorIndicatorEnabled: normalizeMainApiErrorIndicatorEnabled(parsed?.mainApiErrorIndicatorEnabled),
            mainApiErrorClearOnRegenerate: normalizeMainApiErrorClearOnRegenerate(parsed?.mainApiErrorClearOnRegenerate),
            runFloorMap: parsed?.runFloorMap && typeof parsed.runFloorMap === "object" ? parsed.runFloorMap : {},
            runChatMap: shouldResetRunChatMap ? {} : (parsed?.runChatMap && typeof parsed.runChatMap === "object" ? parsed.runChatMap : {}),
            runChatMapRevision: RUN_CHAT_MAP_REVISION,
            sectionOpenStates: normalizeSectionOpenStates(parsed?.sectionOpenStates),
            pricingConfigByModel: normalizePricingConfigMap(parsed?.pricingConfigByModel),
            pricingPanelOpenStates: parsed?.pricingPanelOpenStates && typeof parsed.pricingPanelOpenStates === "object" ? parsed.pricingPanelOpenStates : {},
            pricingPeakValleyOpenStates: parsed?.pricingPeakValleyOpenStates && typeof parsed.pricingPeakValleyOpenStates === "object" ? parsed.pricingPeakValleyOpenStates : {},
            outputCardFields: normalizeOutputCardFields(parsed?.outputCardFields),
            callTimer: normalizeCallTimer(parsed?.callTimer),
            callTimerSessions: normalizeCallTimerSessions(parsed?.callTimerSessions),
            callTimerExpectedSources: normalizeCallTimerExpectedSources(parsed?.callTimerExpectedSources),
        };
    } catch {
        return { ...DEFAULT_UI_SETTINGS };
    }
}

function normalizeOutputCardFields(value) {
    return {
        ...DEFAULT_OUTPUT_CARD_FIELDS,
        ...(value && typeof value === "object" ? value : {}),
    };
}

function normalizeSectionOpenStates(value) {
    return {
        ...DEFAULT_SECTION_OPEN_STATES,
        ...(value && typeof value === "object" ? value : {}),
    };
}

function normalizeRequestPurposeMode(value) {
    return value === "non_chat_generation" ? "non_chat_generation" : "chat_main_reply";
}

function getRunRequestPurpose(run) {
    return normalizeRequestPurposeMode(run?.request_purpose);
}

function filterRunsByRequestPurpose(runs, requestPurpose = getActiveRequestPurpose()) {
    if (!Array.isArray(runs)) {
        return [];
    }

    const normalizedPurpose = normalizeRequestPurposeMode(requestPurpose);
    return runs.filter((run) => getRunRequestPurpose(run) === normalizedPurpose);
}

function normalizeMainViewMode(value) {
    return value === "settings" || value === "status" || value === "waiting_queue" || value === "daily_summary" || value === "call_timer" ? value : "monitor";
}

function normalizeTimestampMs(value) {
    const parsed = Math.trunc(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function createCallTimerSessionId() {
    return `ct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCallTimer(value) {
    const startedAtMs = normalizeTimestampMs(value?.startedAtMs);
    // 没有开始时间就谈不上"在跑"：窗口下界会变成 0，把全部历史都算进这一次里。
    const running = value?.running === true && startedAtMs > 0;
    return {
        running,
        startedAtMs,
        stoppedAtMs: running ? 0 : normalizeTimestampMs(value?.stoppedAtMs),
    };
}

function normalizeCallTimerSessions(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    const sessions = [];
    for (const item of value) {
        const startedAtMs = normalizeTimestampMs(item?.startedAtMs);
        const stoppedAtMs = normalizeTimestampMs(item?.stoppedAtMs);
        if (!startedAtMs || !stoppedAtMs || stoppedAtMs < startedAtMs) {
            continue;
        }

        sessions.push({
            id: typeof item?.id === "string" && item.id.trim()
                ? item.id.trim().slice(0, 80)
                : createCallTimerSessionId(),
            startedAtMs,
            stoppedAtMs,
        });
    }

    return sessions.slice(0, CALL_TIMER_MAX_SESSIONS);
}

function normalizeCallTimerExpectedSources(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    const seen = new Set();
    const sources = [];
    for (const item of value) {
        const label = typeof item === "string" ? item.trim().slice(0, 120) : "";
        if (!label || seen.has(label)) {
            continue;
        }

        seen.add(label);
        sources.push(label);
    }

    return sources.slice(0, CALL_TIMER_EXPECTED_SOURCE_LIMIT);
}

function normalizeDailySummaryDays(value) {
    const parsed = Math.trunc(Number(value));
    return DAILY_SUMMARY_DAY_OPTIONS.includes(parsed) ? parsed : DEFAULT_UI_SETTINGS.dailySummaryDays;
}

function normalizeSettingsCategory(value) {
    return Object.prototype.hasOwnProperty.call(SETTINGS_CATEGORY_LABELS, value)
        ? value
        : DEFAULT_UI_SETTINGS.settingsCategory;
}

function getMinimizedButtonColorPreset(value) {
    return MINIMIZED_BUTTON_COLOR_PRESETS.find((item) => item.key === value) || null;
}

function normalizeHexColor(value, fallback) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
        return raw.toLowerCase();
    }

    return fallback;
}

function normalizeMinimizedButtonPosition(value) {
    if (!value || typeof value !== "object") {
        return null;
    }

    const left = Number(value.left);
    const top = Number(value.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
        return null;
    }

    return { left, top };
}

function migrateLegacyThemeMode(value) {
    if (value === "day" || value === "day_warm" || value === "day_cool" || value === "linen") {
        return "dawn";
    }

    if (value === "night") {
        return "night";
    }
    return value;
}

function normalizeThemeMode(value) {
    return THEME_MODE_SEQUENCE.includes(value) ? value : DEFAULT_UI_SETTINGS.themeMode;
}

function normalizeMinimizedButtonColorMode(value) {
    if (value === "custom" || value === "follow_theme") {
        return value;
    }

    return getMinimizedButtonColorPreset(value)
        ? "custom"
        : DEFAULT_UI_SETTINGS.minimizedButtonColorMode;
}

function normalizeMinimizedButtonCustomColor(value, legacyMode = "") {
    const legacyPresetColor = getMinimizedButtonColorPreset(legacyMode)?.color || "";
    return normalizeHexColor(value, normalizeHexColor(legacyPresetColor, DEFAULT_UI_SETTINGS.minimizedButtonCustomColor));
}

function normalizeMinimizedButtonStrokeColor(value) {
    return normalizeHexColor(value, DEFAULT_UI_SETTINGS.minimizedButtonStrokeColor);
}

function normalizeMinimizedButtonBorderColor(value) {
    return normalizeHexColor(value, DEFAULT_UI_SETTINGS.minimizedButtonBorderColor);
}

function normalizeMainApiErrorIndicatorEnabled(value) {
    return value === undefined || value === null
        ? DEFAULT_UI_SETTINGS.mainApiErrorIndicatorEnabled
        : Boolean(value);
}

function isMainApiErrorIndicatorEnabled() {
    return normalizeMainApiErrorIndicatorEnabled(state.uiSettings.mainApiErrorIndicatorEnabled);
}

function normalizeMainApiErrorClearOnRegenerate(value) {
    return value === undefined || value === null
        ? DEFAULT_UI_SETTINGS.mainApiErrorClearOnRegenerate
        : Boolean(value);
}

function isMainApiErrorClearOnRegenerateEnabled() {
    return normalizeMainApiErrorClearOnRegenerate(state.uiSettings.mainApiErrorClearOnRegenerate);
}

// 只有明确存成 false 才算关掉：老配置里没有这个键，此时该沿用"有外圈"的既有外观。
function normalizeMinimizedButtonBorderVisible(value) {
    return value === undefined || value === null
        ? DEFAULT_UI_SETTINGS.minimizedButtonBorderVisible
        : Boolean(value);
}

// 下限 10%：这颗星是唯一能唤回面板的入口，允许调到 0 就等于让用户把自己锁在外面。
function normalizeMinimizedButtonOpacity(value) {
    // null 和空串必须当"没设过"处理：Number() 会把它们变成 0，再夹到下限就成了 10%，
    // 等于设置一缺失图标就自己淡到几乎看不见。
    if (value === null || value === undefined || value === "") {
        return DEFAULT_UI_SETTINGS.minimizedButtonOpacity;
    }

    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
        return DEFAULT_UI_SETTINGS.minimizedButtonOpacity;
    }

    // 兼容按百分比存的旧值，也兼容直接传 0.1~1 的小数。
    const ratio = numeric > 1 ? numeric / 100 : numeric;
    if (!Number.isFinite(ratio)) {
        return DEFAULT_UI_SETTINGS.minimizedButtonOpacity;
    }

    return Math.min(1, Math.max(MINIMIZED_BUTTON_OPACITY_MIN, Math.round(ratio * 100) / 100));
}

function getMinimizedButtonOpacityPercent() {
    return Math.round(normalizeMinimizedButtonOpacity(state.uiSettings.minimizedButtonOpacity) * 100);
}

function normalizeMinimizedButtonBackgroundMode(value) {
    return Object.prototype.hasOwnProperty.call(MINIMIZED_BUTTON_BACKGROUND_MODE_LABELS, value)
        ? value
        : DEFAULT_UI_SETTINGS.minimizedButtonBackgroundMode;
}

function getThemeModeLabel(value) {
    return THEME_MODE_LABELS[normalizeThemeMode(value)] || THEME_MODE_LABELS.night;
}

function getSettingsCategoryLabel(value) {
    return SETTINGS_CATEGORY_LABELS[normalizeSettingsCategory(value)] || SETTINGS_CATEGORY_LABELS.runtime;
}

function getMinimizedButtonColorModeLabel(value) {
    return MINIMIZED_BUTTON_COLOR_MODE_LABELS[normalizeMinimizedButtonColorMode(value)] || MINIMIZED_BUTTON_COLOR_MODE_LABELS.follow_theme;
}

function getMinimizedButtonBackgroundModeLabel(value) {
    return MINIMIZED_BUTTON_BACKGROUND_MODE_LABELS[normalizeMinimizedButtonBackgroundMode(value)] || MINIMIZED_BUTTON_BACKGROUND_MODE_LABELS.mist;
}

function getMinimizedButtonConnectedColorValue() {
    const colorMode = normalizeMinimizedButtonColorMode(state.uiSettings.minimizedButtonColorMode);
    if (colorMode === "follow_theme") {
        return "var(--stlp-primary)";
    }

    return normalizeMinimizedButtonCustomColor(state.uiSettings.minimizedButtonCustomColor);
}

function getMinimizedButtonStrokeColorValue() {
    return normalizeMinimizedButtonStrokeColor(state.uiSettings.minimizedButtonStrokeColor);
}

function isMinimizedButtonBorderVisible() {
    return normalizeMinimizedButtonBorderVisible(state.uiSettings.minimizedButtonBorderVisible);
}

function getMinimizedButtonBorderColorValue() {
    return isMinimizedButtonBorderVisible()
        ? normalizeMinimizedButtonBorderColor(state.uiSettings.minimizedButtonBorderColor)
        : "transparent";
}

function getMinimizedButtonBackgroundValues() {
    return {
        background: "transparent",
        hoverBackground: "transparent",
        borderColor: getMinimizedButtonBorderColorValue(),
        shadow: "none",
    };
}

function clearMinimizedButtonFlashTimer() {
    if (!state.minimizedButtonFlashTimerId) {
        return;
    }

    window.clearTimeout(state.minimizedButtonFlashTimerId);
    state.minimizedButtonFlashTimerId = null;
}

function triggerMinimizedButtonFlash() {
    clearMinimizedButtonFlashTimer();
    state.minimizedButtonFlashActive = true;
    safeRenderPage();
    state.minimizedButtonFlashTimerId = window.setTimeout(() => {
        state.minimizedButtonFlashActive = false;
        state.minimizedButtonFlashTimerId = null;
        safeRenderPage();
    }, 1500);
}

// 变红/复原都只走这一个入口，成功和失败两条路必须对称，否则会留下清不掉的红。
// 判定只在客户端拦截点做，不查 /runs：这样"仅主 API"这个限定是免费的（能走到这里的请求
// 已经被 shouldTrackAbortableChatGenerationRequest 筛过），也没有轮询延迟。
function settleMainApiOutcome(success) {
    if (success) {
        clearMainApiError();
        return;
    }

    markMainApiError();
}

function markMainApiError() {
    // 用户自己点停止时 fetch 也会以失败收场，那不算 API 出错。这个时间窗是启发式的，
    // 和服务端那套 client_stopped 判定一样存在竞态，不追求 100% 精确——判错了最多这次颜色不准。
    if (Date.now() - state.recentManualStopAtMs < MAIN_API_MANUAL_STOP_GRACE_MS) {
        return;
    }

    if (state.mainApiErrorActive) {
        return;
    }

    state.mainApiErrorActive = true;
    if (!isMainApiErrorIndicatorEnabled()) {
        return;
    }

    // 最小化时闪一下顺便把渲染带上；面板开着的时候星星根本不在画面里，走横幅。
    if (state.pageMinimized) {
        triggerMinimizedButtonFlash();
        return;
    }

    safeRenderPage();
}

function clearMainApiError() {
    if (!state.mainApiErrorActive) {
        return;
    }

    state.mainApiErrorActive = false;
    safeRenderPage();
}

// 你再发起一次生成，就说明这条提醒已经看到了，没必要让红色挂到下一次成功为止。
// 这里是"先"复原：这次要是又出错，收尾时 markMainApiError 会重新点红。
//
// 判断写成"除了后台静默都算"而不是列白名单：类型由酒馆的 Generate(type) 直接下发
// （script.js:4240），将来多一种类型或者某条路径漏传，白名单会静默失效，反向判断不会。
function maybeClearMainApiErrorOnNewGeneration(generationType) {
    if (!isMainApiErrorClearOnRegenerateEnabled()) {
        return;
    }

    if (generationType === "quiet") {
        return;
    }

    clearMainApiError();
}

function isVisibleElement(element) {
    if (!(element instanceof HTMLElement)) {
        return false;
    }

    if (element.closest(".stlp-page-host")) {
        return false;
    }

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.pointerEvents !== "none";
}

function findVisibleElement(selectors) {
    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (isVisibleElement(element)) {
            return element;
        }
    }

    return null;
}

function findSillyTavernStopGenerationTrigger() {
    const directMatch = findVisibleElement([
        "#mes_stop",
        "#stop_generation",
        "#stopGenerate",
    ]);
    if (directMatch && !isMonitorRootElement(directMatch)) {
        return directMatch;
    }

    return null;
}

function hasRecentGenerationRecoveryWindow() {
    return Date.now() < Number(state.sillyTavernGenerationRecoveryUntil || 0);
}

function isSillyTavernGenerationInProgress() {
    return Boolean(
        document.body?.dataset?.generating === "true"
        || findSillyTavernStopGenerationTrigger()
        || hasAbortableGenerationRequest()
    );
}

function isSillyTavernGenerationLikelyActive() {
    return Boolean(
        state.sillyTavernGenerationActive
        || hasRecentGenerationRecoveryWindow()
        || isSillyTavernGenerationInProgress()
    );
}

function markSillyTavernGenerationStarted() {
    state.sillyTavernGenerationActive = true;
    state.sillyTavernGenerationRecoveryUntil = 0;
}

function markSillyTavernGenerationStopped() {
    state.sillyTavernGenerationActive = false;
    state.sillyTavernGenerationRecoveryUntil = Date.now() + GENERATION_RECOVERY_WINDOW_MS;
    state.currentGenerationClientId = "";
}

function markSillyTavernGenerationEnded() {
    state.sillyTavernGenerationActive = false;
    state.sillyTavernGenerationRecoveryUntil = 0;
    state.currentGenerationClientId = "";
}

// crypto.randomUUID 只在安全上下文可用，而酒馆常常是 http 直连，这里必须自带兜底。
function createClientGenerationId() {
    try {
        if (typeof crypto?.randomUUID === "function") {
            return crypto.randomUUID();
        }
    } catch {
        // 落到下面的兜底实现
    }

    return `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildGenerationInterventionKey(kind, suffix = "") {
    return `${kind}:${suffix || "default"}`;
}

function clearPendingGenerationIntervention({ rememberDismissed = false } = {}) {
    if (rememberDismissed && state.pendingGenerationIntervention?.key) {
        state.lastDismissedGenerationInterventionKey = state.pendingGenerationIntervention.key;
    }

    state.pendingGenerationIntervention = null;
}

function ensureMinimizedButtonVisibleForAlert() {
    if (state.pageOpen || state.uiSettings.keepRunningAfterClose === false) {
        return;
    }

    state.pageOpen = true;
    state.pageMinimized = true;
    state.confirmDialog = null;
    state.historyDialogOpen = false;
    syncBodyScrollLock();
    scheduleAutoRefresh();
}

function queueGenerationInterventionAlert({
    kind,
    title,
    text,
    keySuffix = "",
    runId = "",
} = {}) {
    const normalizedKind = typeof kind === "string" && kind.trim() ? kind.trim() : "generation";
    const key = buildGenerationInterventionKey(normalizedKind, keySuffix);
    if (state.pendingGenerationIntervention?.key === key || state.lastDismissedGenerationInterventionKey === key) {
        triggerMinimizedButtonFlash();
        return;
    }

    state.pendingGenerationIntervention = {
        key,
        kind: normalizedKind,
        title: title || "这次生成大概率不会正常返回",
        text: text || "后端监控已经识别到明确异常，这次大概率不会再正常生成。要现在尝试中止酒馆当前这次生成吗？",
        runId,
    };

    if (state.pageOpen && !state.pageMinimized) {
        openPendingGenerationInterventionDialog();
        return;
    }

    ensureMinimizedButtonVisibleForAlert();
    safeRenderPage();
}

function openPendingGenerationInterventionDialog() {
    const pending = state.pendingGenerationIntervention;
    if (!pending) {
        return;
    }

    state.confirmDialog = {
        type: "generation-intervention",
        title: pending.title,
        text: pending.text,
        runId: pending.runId || "",
    };
    safeRenderPage();
}

function isMonitorRootElement(element) {
    return element instanceof Element && Boolean(element.closest("#stlp_page"));
}

function shouldIgnoreSyntheticEscapeForMonitor(event) {
    return Boolean(
        event?.key === "Escape"
        && event.isTrusted === false
        && Date.now() < Number(state.syntheticEscapeIgnoreUntil || 0)
    );
}

function dispatchEscapeStopGeneration() {
    state.syntheticEscapeIgnoreUntil = Date.now() + SYNTHETIC_ESCAPE_IGNORE_WINDOW_MS;
    const eventInit = {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
    };
    const targets = [];
    if (document.activeElement && !isMonitorRootElement(document.activeElement)) {
        targets.push(document.activeElement);
    }
    targets.push(document);

    for (const target of new Set(targets.filter(Boolean))) {
        target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
        target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    }

    if (window.jQuery) {
        window.jQuery(document).trigger(window.jQuery.Event("keydown", eventInit));
        window.jQuery(document).trigger(window.jQuery.Event("keyup", eventInit));
    }
}

function getGenerationRequestAbortSignal(input, init) {
    if (init?.signal && typeof init.signal.aborted === "boolean") {
        return init.signal;
    }

    if (input instanceof Request && input.signal && typeof input.signal.aborted === "boolean") {
        return input.signal;
    }

    return null;
}

function registerActiveGenerationRequest() {
    const requestId = `generation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const forceAbortController = typeof AbortController === "function" ? new AbortController() : null;
    const entry = {
        requestId,
        startedAt: Date.now(),
        forceAbortController,
    };

    state.activeGenerationRequests.set(requestId, entry);
    if (state.pageOpen && state.pageMinimized) {
        safeRenderPage();
    }
    return entry;
}

function removeActiveGenerationRequest(requestId) {
    if (!requestId) {
        return;
    }

    if (state.activeGenerationRequests.delete(requestId) && state.pageOpen && state.pageMinimized) {
        safeRenderPage();
    }
}

function getAbortableGenerationRequestCount() {
    if (typeof AbortController !== "function") {
        return 0;
    }

    let count = 0;
    for (const entry of state.activeGenerationRequests.values()) {
        if (entry?.forceAbortController instanceof AbortController && !entry.forceAbortController.signal.aborted) {
            count += 1;
        }
    }

    return count;
}

function hasAbortableGenerationRequest() {
    return getAbortableGenerationRequestCount() > 0;
}

function clearMinimizedButtonLongPressTimer() {
    if (!state.minimizedButtonLongPressTimerId) {
        return;
    }

    clearTimeout(state.minimizedButtonLongPressTimerId);
    state.minimizedButtonLongPressTimerId = null;
}

function buildTrackedGenerationRequestSignal(input, init, entry) {
    if (typeof AbortController !== "function" || !(entry?.forceAbortController instanceof AbortController)) {
        return getGenerationRequestAbortSignal(input, init);
    }

    const combinedController = new AbortController();
    const abortCombined = (signal) => {
        if (combinedController.signal.aborted) {
            return;
        }

        combinedController.abort(signal?.reason);
    };

    const originalSignal = getGenerationRequestAbortSignal(input, init);
    if (originalSignal) {
        if (originalSignal.aborted) {
            abortCombined(originalSignal);
        } else {
            originalSignal.addEventListener("abort", () => abortCombined(originalSignal), { once: true });
        }
    }

    entry.forceAbortController.signal.addEventListener("abort", () => abortCombined(entry.forceAbortController.signal), { once: true });
    return combinedController.signal;
}

function buildTrackedGenerationRequestInit(input, init, patchedInit, entry) {
    const nextInit = patchedInit
        ? { ...patchedInit }
        : (init && typeof init === "object" ? { ...init } : {});
    const trackedSignal = buildTrackedGenerationRequestSignal(input, init, entry);
    if (trackedSignal) {
        nextInit.signal = trackedSignal;
    }

    return nextInit;
}

function monitorGenerationResponseLifecycle(response, requestId) {
    if (!(response instanceof Response) || typeof response.clone !== "function") {
        removeActiveGenerationRequest(requestId);
        // 连响应对象都不是就无从判断这次是不是善终，维持现有颜色不动。
        if (response instanceof Response) {
            settleMainApiOutcome(response.ok);
        }
        return;
    }

    let clonedResponse = null;
    try {
        clonedResponse = response.clone();
    } catch {
        removeActiveGenerationRequest(requestId);
        settleMainApiOutcome(response.ok);
        return;
    }

    if (!clonedResponse.body || typeof clonedResponse.body.getReader !== "function") {
        removeActiveGenerationRequest(requestId);
        settleMainApiOutcome(clonedResponse.ok);
        return;
    }

    const reader = clonedResponse.body.getReader();
    // 这个克隆流读到 done 才算这次请求真的善终。中途抛错就是"断流/生成不完整"那一类——
    // 服务端区分这两种异常用的也是同一个信号（stream_completed 为假），我们只要"红不红"，
    // 所以不复刻它的分类。
    let streamFailed = false;
    void (async () => {
        try {
            while (true) {
                const { done } = await reader.read();
                if (done) {
                    break;
                }
            }
        } catch {
            streamFailed = true;
        } finally {
            try {
                reader.releaseLock();
            } catch {
                // Ignore release failures during teardown.
            }
            removeActiveGenerationRequest(requestId);
            settleMainApiOutcome(!streamFailed && clonedResponse.ok);
        }
    })();
}

function abortTrackedGenerationRequests() {
    let abortedCount = 0;
    for (const entry of state.activeGenerationRequests.values()) {
        if (typeof AbortController !== "function" || !(entry?.forceAbortController instanceof AbortController) || entry.forceAbortController.signal.aborted) {
            continue;
        }

        entry.forceAbortController.abort("st-monitor-force-abort");
        abortedCount += 1;
    }

    return abortedCount;
}

function tryStopSillyTavernGeneration(options = {}) {
    const forceProbe = options?.forceProbe === true;
    const stopTrigger = findSillyTavernStopGenerationTrigger();
    let nativeCalled = false;
    // stopGeneration() returns true whenever SillyTavern's module-level abortController exists,
    // which is always. Only whether the call threw tells us anything.
    if (typeof stopGeneration === "function" && (forceProbe || state.sillyTavernGenerationActive || hasRecentGenerationRecoveryWindow() || stopTrigger instanceof HTMLElement)) {
        try {
            stopGeneration();
            nativeCalled = true;
        } catch {
            // Fall through to DOM/button and Escape based fallbacks.
        }
    }

    if (nativeCalled) {
        return "native";
    }

    if (stopTrigger instanceof HTMLElement) {
        stopTrigger.click();
        return "click";
    }

    dispatchEscapeStopGeneration();
    return "escape";
}

function getSillyTavernSwipeStateNone() {
    const constants = state.sillyTavernSwipeConstants;
    const noneState = constants?.SWIPE_STATE?.NONE;
    return typeof noneState === "string" && noneState ? noneState : DEFAULT_SWIPE_STATE_NONE;
}

async function loadSillyTavernSwipeConstants() {
    if (state.sillyTavernSwipeConstants !== undefined) {
        return state.sillyTavernSwipeConstants;
    }

    try {
        state.sillyTavernSwipeConstants = await import("../../../constants.js");
    } catch {
        state.sillyTavernSwipeConstants = null;
    }

    return state.sillyTavernSwipeConstants;
}

function readSillyTavernSwipeState() {
    return typeof sillyTavernScript?.swipeState === "string" ? sillyTavernScript.swipeState : "";
}

function isSillyTavernSwipeStateStuck() {
    const swipeState = readSillyTavernSwipeState();
    return Boolean(swipeState) && swipeState !== getSillyTavernSwipeStateNone();
}

function isSillyTavernSendUiLocked() {
    const bodyDataset = document.body?.dataset;
    return Boolean(
        bodyDataset?.generating === "true"
        || bodyDataset?.swiping === "true"
        || sillyTavernScript?.is_send_press === true
        || isSillyTavernSwipeStateStuck(),
    );
}

function waitForSillyTavernSendUiRecovery(timeoutMs) {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
            if (!isSillyTavernSendUiLocked()) {
                resolve(true);
                return;
            }

            if (Date.now() >= deadline) {
                resolve(false);
                return;
            }

            setTimeout(check, SEND_UI_UNLOCK_POLL_INTERVAL_MS);
        };

        check();
    });
}

function waitForSillyTavernSwipeStateRecovery(timeoutMs) {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
            if (!isSillyTavernSwipeStateStuck()) {
                resolve(true);
                return;
            }

            if (Date.now() >= deadline) {
                resolve(false);
                return;
            }

            setTimeout(check, SEND_UI_UNLOCK_POLL_INTERVAL_MS);
        };

        check();
    });
}

function forceReleaseSillyTavernSendButtons() {
    if (typeof sillyTavernScript?.activateSendButtons === "function") {
        try {
            sillyTavernScript.activateSendButtons();
            return true;
        } catch {
            // Fall through to the dataset-only downgrade below.
        }
    }

    // Downgrade path: the CSS lock can be lifted without SillyTavern's helper, but is_send_press
    // stays set, so the button becomes visible without becoming usable.
    if (document.body?.dataset?.generating) {
        delete document.body.dataset.generating;
    }

    return false;
}

function findSwipeStateResetTarget() {
    const chatMessages = Array.isArray(sillyTavernScript?.chat) ? sillyTavernScript.chat : null;
    if (!chatMessages || chatMessages.length === 0) {
        return null;
    }

    const mesId = chatMessages.length - 1;
    const message = chatMessages[mesId];
    if (!message || !Array.isArray(message.swipes) || message.swipes.length === 0) {
        return null;
    }

    const rawSwipeId = Number(message.swipe_id ?? 0);
    const swipeId = Number.isFinite(rawSwipeId)
        ? Math.min(Math.max(rawSwipeId, 0), message.swipes.length - 1)
        : 0;

    return { mesId, swipeId };
}

/**
 * SillyTavern only resets its private swipeState at the tail of endSwipe(), and exposes no setter.
 * Replaying an in-place swipe with a bypassing source is the only supported way back to NONE.
 */
async function resetSillyTavernSwipeState() {
    if (!isSillyTavernSwipeStateStuck()) {
        return true;
    }

    const constants = await loadSillyTavernSwipeConstants();
    const source = constants?.SWIPE_SOURCE?.BACK;
    const direction = constants?.SWIPE_DIRECTION?.RIGHT;
    const swipeFn = sillyTavernScript?.swipe;
    if (typeof swipeFn !== "function" || !source || !direction) {
        return false;
    }

    const target = findSwipeStateResetTarget();
    if (!target) {
        return false;
    }

    try {
        await swipeFn(null, direction, {
            source,
            repeated: false,
            forceMesId: target.mesId,
            forceSwipeId: target.swipeId,
            forceDuration: 0,
        });
    } catch {
        return false;
    }

    return !isSillyTavernSwipeStateStuck();
}

async function forceUnlockSillyTavernSendUi() {
    await loadSillyTavernSwipeConstants();

    if (await waitForSillyTavernSendUiRecovery(SEND_UI_UNLOCK_SELF_RECOVERY_MS)) {
        return {
            selfRecovered: true,
            sendButtonsRestored: true,
            swipeStateRecovered: true,
            needsPageReload: false,
        };
    }

    const sendButtonsRestored = forceReleaseSillyTavernSendButtons();
    if (document.body?.dataset?.swiping) {
        delete document.body.dataset.swiping;
    }

    const remainingGrace = Math.max(0, SWIPE_STATE_RESET_GRACE_MS - SEND_UI_UNLOCK_SELF_RECOVERY_MS);
    const swipeStateSettled = await waitForSillyTavernSwipeStateRecovery(remainingGrace);
    const swipeStateRecovered = swipeStateSettled || await resetSillyTavernSwipeState();

    return {
        selfRecovered: false,
        sendButtonsRestored,
        swipeStateRecovered,
        needsPageReload: !sendButtonsRestored || !swipeStateRecovered,
    };
}

function buildGenerationStopStatusText(stopResult, unlockResult, rescueMode) {
    const parts = [];
    if (stopResult.abortedRequestCount > 0) {
        parts.push(`已发送终止指令，并强制切断 ${stopResult.abortedRequestCount} 条监控接管请求`);
    } else if (rescueMode) {
        parts.push("已按死锁救援模式补发终止指令");
    } else {
        parts.push("已发送终止指令");
    }

    if (unlockResult.selfRecovered) {
        // 这条分支一个恢复动作都没做，依据只是四个锁标志都没读到值。
        // 标志没体现锁不等于界面真的可用，所以这里只能陈述依据，不能报成功。
        parts.push("没检测到酒馆的生成锁，因此没做强制恢复；发送键若仍然点不动，刷新页面");
        return parts.join("；");
    }

    if (!unlockResult.sendButtonsRestored) {
        parts.push("读不到酒馆的解锁接口，只能清掉界面锁，发送按钮可能仍然点不动，需要刷新页面");
        return parts.join("；");
    }

    parts.push(unlockResult.swipeStateRecovered
        ? "已强制恢复发送按钮"
        : "已强制恢复发送按钮，但滑动状态没能复位，左右滑动需要刷新页面才能恢复");
    return parts.join("；");
}

function readDiagnosticValue(reader) {
    try {
        const value = reader();
        return value === undefined ? null : value;
    } catch {
        return "<unreadable>";
    }
}

function readDiagnosticElementDisplay(selector) {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) {
        return "<missing>";
    }

    return window.getComputedStyle(element).display;
}

/**
 * 纯只读采集，不触碰任何终止/解锁状态。每一项单独兜错，读不到就记 "<unreadable>"，
 * 保证诊断本身永远不会把终止流程带崩。
 */
function captureForceStopDiagnosticsSnapshot(phase) {
    try {
        return {
            phase,
            at: new Date().toISOString(),
            // 只有 streamingProcessor 还活着，stopGeneration() 才能真正掐断流式请求；
            // 它一旦被置 null，那次调用就只剩下 abort 一个没人监听的模块级 controller。
            streaming_processor: readDiagnosticValue(() => {
                const processor = sillyTavernScript?.streamingProcessor;
                if (!processor) {
                    return null;
                }

                return {
                    is_finished: processor.isFinished ?? null,
                    is_stopped: processor.isStopped ?? null,
                    abort_signal_aborted: processor.abortController?.signal?.aborted ?? null,
                };
            }),
            // 监控自己的兜底句柄。克隆流一读完就会被撤销，这里看它在关键时刻还在不在。
            tracked_requests: readDiagnosticValue(() => ({
                total: state.activeGenerationRequests.size,
                abortable: getAbortableGenerationRequestCount(),
            })),
            // 强制解锁的判定依据：四个标志全为假时会直接判定"已自行恢复"并且不做任何动作。
            send_ui_lock: readDiagnosticValue(() => ({
                data_generating: document.body?.dataset?.generating ?? null,
                data_swiping: document.body?.dataset?.swiping ?? null,
                is_send_press: sillyTavernScript?.is_send_press ?? null,
                swipe_state: readSillyTavernSwipeState() || null,
                locked: isSillyTavernSendUiLocked(),
            })),
            // 用来对照上面的标志和按钮真实可见性是否脱节。
            buttons: readDiagnosticValue(() => ({
                mes_stop_display: readDiagnosticElementDisplay("#mes_stop"),
                send_but_display: readDiagnosticElementDisplay("#send_but"),
                stop_trigger_found: Boolean(findSillyTavernStopGenerationTrigger()),
            })),
            monitor_state: readDiagnosticValue(() => ({
                generation_active: state.sillyTavernGenerationActive,
                recovery_window_active: hasRecentGenerationRecoveryWindow(),
                current_generation_client_id: state.currentGenerationClientId || null,
            })),
            stop_generation_available: readDiagnosticValue(() => typeof stopGeneration === "function"),
        };
    } catch {
        return { phase, at: new Date().toISOString(), capture_failed: true };
    }
}

// 服务端看到的错误文本对"用户主动停止"和"连接意外断开"完全一样（都是 socket 关闭触发的 abort），
// 只能靠这个信号区分。必须赶在真正中止之前发出去，否则 run 已经落盘，信号就白发了。
function sendClientStopSignal() {
    // 精简模式下这条记录就在本进程里，直接打标记即可，不需要绕一圈发给后端。
    // 临时查看旧记录时不算，那种情况下真正在记录的仍然是后端。
    if (state.recordSourceMode === "lite" && !state.legacyLiteViewing) {
        if (state.liteActiveRun) {
            state.liteActiveRun.client_stopped = true;
        }
        return Promise.resolve();
    }

    const clientGenerationId = state.currentGenerationClientId;
    if (!clientGenerationId) {
        return Promise.resolve();
    }

    try {
        return fetchJson("/client-stop-signal", {
            method: "POST",
            body: JSON.stringify({ client_generation_id: clientGenerationId }),
        }).catch(() => {});
    } catch {
        return Promise.resolve();
    }
}

function sendForceStopDiagnostics(record) {
    if (!state.settings?.runtime?.collect_force_stop_diagnostics) {
        return;
    }

    // 旁路上报：诊断写不进去也不能影响终止结果，所以这里把所有失败都吞掉。
    try {
        void fetchJson("/force-stop-diagnostics", {
            method: "POST",
            body: JSON.stringify(record),
        }).catch(() => {});
    } catch {
        // 序列化失败等同步异常同样忽略。
    }
}

function tryStopGenerationWithMonitorFallback(options = {}) {
    const stopMethod = tryStopSillyTavernGeneration(options);
    const abortedRequestCount = abortTrackedGenerationRequests();
    const postAbortEscapeDispatched = abortedRequestCount > 0;

    if (postAbortEscapeDispatched) {
        dispatchEscapeStopGeneration();
    }

    return {
        stopMethod,
        abortedRequestCount,
        postAbortEscapeDispatched,
    };
}

async function executeGenerationStopAction() {
    const manualForceStopMode = state.confirmDialog?.type === "manual-force-stop-generation"
        ? state.confirmDialog.mode
        : "";
    const rescueMode = manualForceStopMode === "rescue";
    const diagnosticsSnapshots = Array.isArray(state.forceStopDiagnosticsSnapshots)
        ? [...state.forceStopDiagnosticsSnapshots]
        : [];
    diagnosticsSnapshots.push(captureForceStopDiagnosticsSnapshot("before-stop"));

    // 这条路径的顺序完全可控，等信号真的发出去再中止，落盘时一定能对上。
    await sendClientStopSignal();

    const stopResult = tryStopGenerationWithMonitorFallback({
        forceProbe: rescueMode,
    });
    diagnosticsSnapshots.push(captureForceStopDiagnosticsSnapshot("after-stop"));

    if (state.pendingGenerationIntervention) {
        clearPendingGenerationIntervention();
    }
    state.confirmDialog = null;
    state.apiError = "";
    state.apiStatus = "已发送终止指令，正在确认发送按钮是否恢复…";
    safeRenderPage();

    let unlockResult;
    try {
        unlockResult = await forceUnlockSillyTavernSendUi();
    } catch {
        unlockResult = {
            selfRecovered: false,
            sendButtonsRestored: false,
            swipeStateRecovered: false,
            needsPageReload: true,
        };
    }

    diagnosticsSnapshots.push(captureForceStopDiagnosticsSnapshot("after-unlock"));

    state.apiStatus = buildGenerationStopStatusText(stopResult, unlockResult, rescueMode);
    safeRenderPage();

    state.forceStopDiagnosticsSnapshots = [];
    sendForceStopDiagnostics({
        kind: "manual_force_stop",
        client_at: new Date().toISOString(),
        dialog_mode: manualForceStopMode || null,
        rescue_mode: rescueMode,
        stop_result: stopResult,
        unlock_result: unlockResult,
        status_text: state.apiStatus,
        snapshots: diagnosticsSnapshots,
    });
}

function openManualForceStopGenerationDialog() {
    state.forceStopDiagnosticsSnapshots = [captureForceStopDiagnosticsSnapshot("dialog-open")];
    state.confirmDialog = {
        type: "manual-force-stop-generation",
        mode: hasAbortableGenerationRequest() || isSillyTavernGenerationLikelyActive()
            ? "normal"
            : "rescue",
    };
    safeRenderPage();
}

function getLatestAbnormalRunId(runs) {
    const abnormalRun = sortRunsByStartedAtDesc(Array.isArray(runs) ? runs : []).find((run) => isAbnormalRun(run));
    return typeof abnormalRun?.id === "string" ? abnormalRun.id : "";
}

// 后端只在请求结束后才把 run 落盘，所以列表里出现的异常记录默认都属于"已经结束的某一次生成"。
// 光看"有新异常 + 现在正在生成"会把上一次的异常安到当前这次头上：
// 实测过一例，异常记录 16:30:22 就结束了，而当时正在跑的那次 16:31:37 才开始，两者毫无关系。
// 所以必须靠随请求体下发的生成 id 精确比对。
// 真正该弹的场景是：后端说这次生成已经异常结束，而酒馆 UI 还卡在生成中（停止键不消失）。
function isRunForCurrentGeneration(run) {
    const currentGenerationClientId = state.currentGenerationClientId;
    if (!currentGenerationClientId) {
        return false;
    }

    return run?.request_client_generation_id === currentGenerationClientId;
}

function updateMinimizedButtonAbnormalAlert(runs) {
    const sortedRuns = sortRunsByStartedAtDesc(Array.isArray(runs) ? runs : []);
    const latestAbnormalRun = sortedRuns.find((run) => isAbnormalRun(run)) ?? null;
    const latestAbnormalRunId = typeof latestAbnormalRun?.id === "string" ? latestAbnormalRun.id : "";
    if (!state.abnormalAlertInitialized) {
        state.abnormalAlertInitialized = true;
        state.lastSeenAbnormalRunId = latestAbnormalRunId;
        return;
    }

    if (!latestAbnormalRunId || latestAbnormalRunId === state.lastSeenAbnormalRunId) {
        return;
    }

    state.lastSeenAbnormalRunId = latestAbnormalRunId;
    const abnormalType = latestAbnormalRun?.abnormal_detail?.abnormal_type;
    if (ACTIONABLE_ABNORMAL_TYPES.has(abnormalType)
        && isSillyTavernGenerationInProgress()
        && isRunForCurrentGeneration(latestAbnormalRun)) {
        queueGenerationInterventionAlert({
            kind: "abnormal-generation",
            title: "这次生成大概率不会正常返回",
            text: "后端监控已经发现这次生成出现异常，基本不太可能再正常返回。要现在尝试中止酒馆当前这次生成吗？",
            keySuffix: latestAbnormalRunId,
            runId: latestAbnormalRunId,
        });
        return;
    }

    if (state.pageMinimized) {
        triggerMinimizedButtonFlash();
        return;
    }

    state.minimizedButtonAlertPending = true;
}

function getNextThemeMode(value) {
    const current = normalizeThemeMode(value);
    const currentIndex = THEME_MODE_SEQUENCE.indexOf(current);
    return THEME_MODE_SEQUENCE[(currentIndex + 1) % THEME_MODE_SEQUENCE.length];
}

function getHeaderIconSvg(icon, variant = "") {
    if (icon === "theme") {
        const themeMode = normalizeThemeMode(variant);
        if (themeMode === "dawn") {
            return `
                <svg class="stlp-icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <circle cx="12" cy="12" r="4.25" fill="none" stroke="currentColor" stroke-width="1.9"/>
                    <path d="M12 2.75v2.5M12 18.75v2.5M21.25 12h-2.5M5.25 12h-2.5M18.54 5.46l-1.77 1.77M7.23 16.77l-1.77 1.77M18.54 18.54l-1.77-1.77M7.23 7.23L5.46 5.46" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
                </svg>
            `;
        }

        if (themeMode === "rose") {
            return `
                <svg class="stlp-icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <circle cx="12" cy="12" r="2.15" fill="currentColor"/>
                    <circle cx="12" cy="6.75" r="2.8" fill="none" stroke="currentColor" stroke-width="1.6"/>
                    <circle cx="17.25" cy="12" r="2.8" fill="none" stroke="currentColor" stroke-width="1.6"/>
                    <circle cx="12" cy="17.25" r="2.8" fill="none" stroke="currentColor" stroke-width="1.6"/>
                    <circle cx="6.75" cy="12" r="2.8" fill="none" stroke="currentColor" stroke-width="1.6"/>
                </svg>
            `;
        }

        if (themeMode === "night") {
            return `
                <svg class="stlp-icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M13.9 4.55A7.5 7.5 0 1 0 19.45 15.7A6.15 6.15 0 1 1 13.9 4.55Z" fill="currentColor"/>
                </svg>
            `;
        }

        return `
            <svg class="stlp-icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <circle cx="12" cy="12" r="7.25" fill="none" stroke="currentColor" stroke-width="1.9"/>
            </svg>
        `;
    }

    if (icon === "minimize") {
        return `
            <svg class="stlp-icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M6 12.75h12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
            </svg>
        `;
    }

    if (icon === "close") {
        return `
            <svg class="stlp-icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
            </svg>
        `;
    }

    if (icon === "back") {
        return `
            <svg class="stlp-icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M14.5 6.5L9 12l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        `;
    }

    return "";
}

function getChevronIconSvg() {
    return `
        <svg class="stlp-icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6.75 9.5L12 14.75L17.25 9.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    `;
}

function getMinimizedMonitorIconSvg() {
    return `
        <svg class="stlp-minimized-icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 2.9L14.95 9.05L21.1 12L14.95 14.95L12 21.1L9.05 14.95L2.9 12L9.05 9.05Z" fill="currentColor" stroke="var(--stlp-minimized-stroke, #ffffff)" stroke-width="1.4" stroke-linejoin="round"/>
        </svg>
    `;
}

function getActiveRequestPurpose() {
    return normalizeRequestPurposeMode(state.uiSettings.activeRequestPurpose);
}

function restoreMonitorSectionLayout() {
    state.uiSettings.sectionOpenStates = normalizeSectionOpenStates(state.uiSettings.sectionOpenStates);
}

function isSettingsView() {
    return normalizeMainViewMode(state.uiSettings.activeMainView) === "settings";
}

function isStatusView() {
    return normalizeMainViewMode(state.uiSettings.activeMainView) === "status";
}

function isWaitingQueueView() {
    return normalizeMainViewMode(state.uiSettings.activeMainView) === "waiting_queue";
}

function isDailySummaryView() {
    return normalizeMainViewMode(state.uiSettings.activeMainView) === "daily_summary";
}

function isCallTimerView() {
    return normalizeMainViewMode(state.uiSettings.activeMainView) === "call_timer";
}

// 别再逐个枚举侧栏页面了：之前漏掉新加的 call_timer，导致在区间统计页上
// 点当前已选中的用途跳不回主监控页。
function isMonitorView() {
    return normalizeMainViewMode(state.uiSettings.activeMainView) === "monitor";
}

function isExtensionRequestView() {
    return getActiveRequestPurpose() === "non_chat_generation";
}

function getActiveRequestPurposeLabel() {
    return REQUEST_PURPOSE_LABELS[getActiveRequestPurpose()] || REQUEST_PURPOSE_LABELS.chat_main_reply;
}

function buildRequestPurposeBadgeHtml(purpose = getActiveRequestPurpose()) {
    const normalizedPurpose = normalizeRequestPurposeMode(purpose);
    const badgeClass = normalizedPurpose === "non_chat_generation"
        ? "stlp-purpose-badge stlp-purpose-badge-extension"
        : "stlp-purpose-badge stlp-purpose-badge-chat";
    return `<span class="${badgeClass}">${escapeHtml(getRequestPurposeLabel(normalizedPurpose))}</span>`;
}

function buildSectionTitleHtml(title, purpose = getActiveRequestPurpose()) {
    return `
        <span class="stlp-section-title-text">${escapeHtml(title)}</span>
        ${buildRequestPurposeBadgeHtml(purpose)}
    `;
}

function getBackendStatusIndicatorClass() {
    if (!state.backendReady) {
        return "stlp-status-disconnected";
    }

    // 精简模式一切正常，但它和"后端接通了"不是一回事，指示灯要能看出来。
    return state.recordSourceMode === "lite" ? "stlp-status-lite" : "stlp-status-connected";
}

// 圆点本来只有颜色这一个表达渠道，色弱用户和第一次见的人都无从判断它在说什么。
function getBackendStatusIndicatorLabel() {
    if (!state.backendReady) {
        return "连不上后端";
    }

    return state.recordSourceMode === "lite"
        ? "精简版：记录只存在这个浏览器里"
        : "完整版：已接通后端";
}

function getRequestPurposeLabel(value) {
    return REQUEST_PURPOSE_LABELS[value] || REQUEST_PURPOSE_LABELS.chat_main_reply;
}

function getRequestPluginMatchModeLabel(value) {
    return REQUEST_PLUGIN_MATCH_MODE_LABELS[value] || REQUEST_PLUGIN_MATCH_MODE_LABELS.none;
}

// 筛选必须显式传入。默认关闭可以保证主刷新和汇总接口始终拿到未筛选的全局口径，
// 否则勾一个筛选就会把 summary 的统计范围一起改掉。
function buildRunFilterQuery({ abnormalOnly = false, cacheHitOnly = false } = {}) {
    const params = new URLSearchParams();
    params.set("request_purpose", getActiveRequestPurpose());
    if (abnormalOnly) {
        params.set("abnormal_only", "1");
    }
    if (cacheHitOnly) {
        params.set("cache_hit", "1");
    }
    return params.toString();
}

function buildDailySummaryQuery() {
    const params = new URLSearchParams();
    const scopeInfo = getDailySummaryScopeInfo();
    if (scopeInfo.requestPurpose) {
        params.set("request_purpose", scopeInfo.requestPurpose);
    }
    if (scopeInfo.chatKey) {
        params.set("request_chat_key", scopeInfo.chatKey);
    }
    params.set("group_by", "day");
    params.set("days", String(normalizeDailySummaryDays(state.uiSettings.dailySummaryDays)));
    return params.toString();
}

function hasLegacyUnkeyedChatRuns(runs = state.runs) {
    return Array.isArray(runs) && runs.some((run) => (
        getRunRequestPurpose(run) === "chat_main_reply"
        && !getRunChatKey(run)
    ));
}

function canUsePreciseChatScopedDailySummary() {
    return Boolean(
        getTrackedCurrentChatKey()
        && getTrackedCurrentChatWindowName()
        && getActiveRequestPurpose() === "chat_main_reply",
    );
}

function getDailySummaryScopeInfo() {
    const currentChatKey = getTrackedCurrentChatKey();
    const currentChatName = getTrackedCurrentChatWindowName();
    if (canUsePreciseChatScopedDailySummary() && currentChatKey && currentChatName) {
        return {
            mode: "chat_view",
            label: currentChatName,
            requestPurpose: "chat_main_reply",
            chatKey: currentChatKey,
        };
    }

    return {
        mode: "global",
        label: "全部用途",
        requestPurpose: "",
        chatKey: "",
    };
}

async function setActiveRequestPurpose(nextPurpose) {
    const normalizedPurpose = normalizeRequestPurposeMode(nextPurpose);
    if (normalizedPurpose === getActiveRequestPurpose()) {
        if (!isMonitorView()) {
            state.uiSettings.activeMainView = "monitor";
            restoreMonitorSectionLayout();
            saveUiSettings();
            safeRenderPage();
        }
        return;
    }

    state.uiSettings.activeMainView = "monitor";
    state.uiSettings.activeRequestPurpose = normalizedPurpose;
    restoreMonitorSectionLayout();
    state.historyPage = 1;
    state.historyRuns = [];
    state.historyAllRuns = [];
    state.historyTotal = 0;
    state.historyError = "";
    saveUiSettings();
    await refreshBackendData();
}

function openMessageDialog(title, text, actions = [{ action: "dismiss-confirm-dialog", label: "知道了" }]) {
    state.confirmDialog = {
        type: "message",
        title,
        text,
        actions,
    };
    safeRenderPage();
}

function openSettingsSection() {
    if (isSettingsView()) {
        return;
    }

    state.settingsSubsectionOpenStates = { ...DEFAULT_SETTINGS_SUBSECTION_OPEN_STATES };
    state.uiSettings.activeMainView = "settings";
    saveUiSettings();
    safeRenderPage();
}

function openStatusSection() {
    if (isStatusView()) {
        return;
    }

    state.uiSettings.activeMainView = "status";
    saveUiSettings();
    safeRenderPage();
}

function openWaitingQueueSection() {
    state.uiSettings.activeMainView = "waiting_queue";
    saveUiSettings();
    safeRenderPage();
    void loadWaitingQueue({ silent: true });
    void loadPluginRules({ silent: true });
}

function openDailySummarySection() {
    if (isDailySummaryView()) {
        return;
    }

    state.uiSettings.activeMainView = "daily_summary";
    saveUiSettings();
    safeRenderPage();
    void refreshBackendData({ silent: true });
}

function openCallTimerSection() {
    if (isCallTimerView()) {
        return;
    }

    state.uiSettings.activeMainView = "call_timer";
    saveUiSettings();
    safeRenderPage();
    void loadCallTimerRuns({ silent: true });
}

function getCallTimerWindow() {
    const timer = normalizeCallTimer(state.uiSettings.callTimer);
    return {
        running: timer.running,
        startedAtMs: timer.startedAtMs,
        // 还在走表时上界取"此刻"，停了就用停表时刻。
        endMs: timer.running ? Date.now() : (timer.stoppedAtMs || timer.startedAtMs),
    };
}

function formatCallTimerDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (value) => String(value).padStart(2, "0");
    return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function clearCallTimerRefetchTimers() {
    for (const timerId of state.callTimerRefetchTimerIds) {
        clearTimeout(timerId);
    }
    state.callTimerRefetchTimerIds = [];
}

// run 是请求结束才落盘的，停表那一刻还在飞的调用尚未进库。
// 按 CALL_TIMER_REFETCH_DELAYS_MS 各补捞一次，只影响显示，不改窗口边界。
function scheduleCallTimerRefetch() {
    clearCallTimerRefetchTimers();
    state.callTimerRefetchTimerIds = CALL_TIMER_REFETCH_DELAYS_MS.map((delayMs) => setTimeout(() => {
        runSafely("补捞区间统计记录", () => {
            void loadCallTimerRuns({ silent: true });
        });
    }, delayMs));
}

function stopCallTimerTick() {
    if (state.callTimerTickTimerId !== null) {
        clearInterval(state.callTimerTickTimerId);
        state.callTimerTickTimerId = null;
    }
}

function stopCallTimerPoll() {
    if (state.callTimerPollTimerId !== null) {
        clearInterval(state.callTimerPollTimerId);
        state.callTimerPollTimerId = null;
    }
}

// 计时期间定时补数据。只在本页且正在走表时开，页面藏起来时跳过这一轮，
// 免得后台标签页一直空跑请求。
function syncCallTimerPoll() {
    if (!isCallTimerView() || !getCallTimerWindow().running) {
        stopCallTimerPoll();
        return;
    }

    if (state.callTimerPollTimerId !== null) {
        return;
    }

    state.callTimerPollTimerId = setInterval(() => {
        runSafely("轮询区间统计记录", () => {
            // 面板关掉后不会再重渲染，光看 isCallTimerView 会一直空转，
            // 所以跟走表读数一样以"节点还在不在"为准。
            if (!isCallTimerView()
                || !getCallTimerWindow().running
                || !state.pageRoot?.querySelector("[data-call-timer-elapsed]")) {
                stopCallTimerPoll();
                return;
            }

            if (document.hidden) {
                return;
            }

            void loadCallTimerRuns({ silent: true, limit: CALL_TIMER_POLL_RUNS_LIMIT });
        });
    }, CALL_TIMER_POLL_INTERVAL_MS);
}

// 走表期间只改那一处读数，不整页重渲染：重渲染会打断页面上的滚动和输入。
function syncCallTimerTick() {
    if (!isCallTimerView() || !getCallTimerWindow().running) {
        stopCallTimerTick();
        return;
    }

    if (state.callTimerTickTimerId !== null) {
        return;
    }

    state.callTimerTickTimerId = setInterval(() => {
        runSafely("刷新区间计时读数", () => {
            const element = state.pageRoot?.querySelector("[data-call-timer-elapsed]");
            if (!element) {
                stopCallTimerTick();
                return;
            }

            const timerWindow = getCallTimerWindow();
            element.textContent = formatCallTimerDuration(timerWindow.endMs - timerWindow.startedAtMs);
        });
    }, 1000);
}

function startCallTimer() {
    state.uiSettings.callTimer = { running: true, startedAtMs: Date.now(), stoppedAtMs: 0 };
    saveUiSettings();
    clearCallTimerRefetchTimers();
    safeRenderPage();
    void loadCallTimerRuns({ silent: true });
}

function stopCallTimer() {
    const timer = normalizeCallTimer(state.uiSettings.callTimer);
    if (!timer.running) {
        return;
    }

    const stoppedAtMs = Date.now();
    state.uiSettings.callTimer = { running: false, startedAtMs: timer.startedAtMs, stoppedAtMs };
    state.uiSettings.callTimerSessions = normalizeCallTimerSessions([
        { id: createCallTimerSessionId(), startedAtMs: timer.startedAtMs, stoppedAtMs },
        ...(Array.isArray(state.uiSettings.callTimerSessions) ? state.uiSettings.callTimerSessions : []),
    ]);
    saveUiSettings();
    safeRenderPage();
    void loadCallTimerRuns({ silent: true });
    scheduleCallTimerRefetch();
}

// 只丢掉当前这段窗口，历史区间列表和后端记录都不动。
// 走表途中点它等于放弃这一段：不会写进历史区间。
function clearCallTimerWindow() {
    state.uiSettings.callTimer = { running: false, startedAtMs: 0, stoppedAtMs: 0 };
    saveUiSettings();
    clearCallTimerRefetchTimers();
    stopCallTimerPoll();
    stopCallTimerTick();
    safeRenderPage();
}

// 回看历史区间只切这个 id，绝不去动 state.uiSettings.callTimer。
// 早先的写法是把窗口整个挪过去，正在走表时点一下就把这段计时抹了，而且
// 一个页面只能看一样东西。现在本次和历史是两个独立窗口，各渲染各的卡片。
function viewCallTimerSession(sessionId) {
    const session = normalizeCallTimerSessions(state.uiSettings.callTimerSessions)
        .find((item) => item.id === sessionId);
    if (!session) {
        return;
    }

    // 点已经展开的那一段等于收起。
    state.callTimerHistorySessionId = state.callTimerHistorySessionId === session.id ? "" : session.id;
    state.callTimerExpandedDetailScopes.delete("history");
    safeRenderPage();
}

// 取当前回看的那一段。段可能已被 CALL_TIMER_MAX_SESSIONS 挤掉，顺手清掉悬空 id。
function getCallTimerHistorySession() {
    if (!state.callTimerHistorySessionId) {
        return null;
    }

    const session = normalizeCallTimerSessions(state.uiSettings.callTimerSessions)
        .find((item) => item.id === state.callTimerHistorySessionId);
    if (!session) {
        state.callTimerHistorySessionId = "";
        return null;
    }

    return session;
}

// 把历史段包装成和 getCallTimerWindow() 同形状的窗口，好让取数逻辑不分彼此。
function getCallTimerSessionWindow(session) {
    return {
        running: false,
        startedAtMs: session.startedAtMs,
        endMs: session.stoppedAtMs || session.startedAtMs,
    };
}

function isCallTimerDetailExpanded(scope) {
    return state.callTimerExpandedDetailScopes.has(scope);
}

function toggleCallTimerDetail(scope) {
    if (scope !== "current" && scope !== "history") {
        return;
    }

    if (state.callTimerExpandedDetailScopes.has(scope)) {
        state.callTimerExpandedDetailScopes.delete(scope);
    } else {
        state.callTimerExpandedDetailScopes.add(scope);
    }

    safeRenderPage();
}

async function loadCallTimerRuns({ silent = false, limit = CALL_TIMER_RUNS_LIMIT } = {}) {
    if (state.callTimerLoading) {
        return;
    }

    state.callTimerLoading = true;
    if (!silent) {
        safeRenderPage();
    }

    try {
        // 不带 purpose 就是不筛选，一次拿到全部三种用途；offset=0 拿到的是最新的 N 条。
        const result = await fetchJson(`/runs?limit=${limit}&offset=0`);
        state.callTimerRuns = Array.isArray(result?.runs) ? result.runs : [];
        state.callTimerLoadedLimit = limit;
        state.callTimerTruncated = state.callTimerRuns.length >= limit;
        state.callTimerFetchedAtMs = Date.now();
        state.callTimerError = "";
    } catch (error) {
        state.callTimerError = error instanceof Error ? error.message : String(error);
    } finally {
        state.callTimerLoading = false;
        safeRenderPage();
    }
}

function getCallTimerRunsInWindow(timerWindow) {
    if (!timerWindow?.startedAtMs) {
        return [];
    }

    return state.callTimerRuns
        .filter((run) => {
            const startedAtMs = normalizeTimestampMs(run?.started_at_ms);
            return startedAtMs >= timerWindow.startedAtMs && startedAtMs <= timerWindow.endMs;
        })
        .sort((left, right) => normalizeTimestampMs(right?.started_at_ms) - normalizeTimestampMs(left?.started_at_ms));
}

// 只取到最新 N 条，若窗口起点比最老一条还早，这次统计就是不完整的。
// 这种情况必须说出来，静默少算比不算更糟。
function isCallTimerWindowTruncated(timerWindow) {
    if (!state.callTimerTruncated || !state.callTimerRuns.length || !timerWindow?.startedAtMs) {
        return false;
    }

    const oldestStartedAtMs = state.callTimerRuns.reduce((oldest, run) => {
        const startedAtMs = normalizeTimestampMs(run?.started_at_ms);
        return startedAtMs && (!oldest || startedAtMs < oldest) ? startedAtMs : oldest;
    }, 0);

    return Boolean(oldestStartedAtMs) && timerWindow.startedAtMs < oldestStartedAtMs;
}

function getCallTimerRunSourceLabel(run) {
    const pluginLabel = getRunPluginLabel(run);
    if (pluginLabel) {
        return pluginLabel;
    }

    // 内置的总结/向量等走酒馆管线，落在 quiet 生成类型上，它们不是"拓展自己发的调用"。
    if (normalizeGenerationType(run?.request_generation_type) === "quiet") {
        return CALL_TIMER_SOURCE_QUIET;
    }

    // 这里必须看原始值：normalizeRequestPurposeMode 只区分两种，
    // 会把 plugin_internal_request 一并压成 chat_main_reply，归组就错了。
    const rawPurpose = typeof run?.request_purpose === "string" ? run.request_purpose.trim() : "";
    if (rawPurpose === "non_chat_generation" || rawPurpose === "plugin_internal_request") {
        return CALL_TIMER_SOURCE_UNKNOWN_PLUGIN;
    }

    return CALL_TIMER_SOURCE_MAIN_REPLY;
}

function buildCallTimerGroups(runs) {
    const groups = new Map();
    for (const run of runs) {
        const label = getCallTimerRunSourceLabel(run);
        const group = groups.get(label) ?? { label, count: 0 };
        group.count += 1;
        groups.set(label, group);
    }

    return [...groups.values()].sort((left, right) => (
        right.count - left.count || left.label.localeCompare(right.label, "zh-Hans-CN")
    ));
}

// 期望名单不让用户手打：把这一次出现过的来源直接存下来当基线。
function saveCallTimerExpectedSources() {
    const groups = buildCallTimerGroups(getCallTimerRunsInWindow(getCallTimerWindow()));
    state.uiSettings.callTimerExpectedSources = normalizeCallTimerExpectedSources(
        groups.map((group) => group.label),
    );
    saveUiSettings();
    safeRenderPage();
}

function clearCallTimerExpectedSources() {
    state.uiSettings.callTimerExpectedSources = [];
    saveUiSettings();
    safeRenderPage();
}

function getCallTimerMissingSources(groups) {
    const expected = normalizeCallTimerExpectedSources(state.uiSettings.callTimerExpectedSources);
    if (!expected.length) {
        return [];
    }

    const present = new Set(groups.map((group) => group.label));
    return expected.filter((label) => !present.has(label));
}

function getWaitingQueueDraftValue(entry) {
    if (!entry?.run_id) {
        return "";
    }

    const draftValue = state.waitingQueueDrafts?.[entry.run_id];
    if (typeof draftValue === "string") {
        return draftValue;
    }

    return entry?.plugin_label || getRunPluginLabel(entry?.run) || "";
}

function getPluginRuleById(ruleId) {
    if (typeof ruleId !== "string" || !ruleId.trim()) {
        return null;
    }

    return state.pluginRules.find((rule) => rule?.id === ruleId.trim()) ?? null;
}

function isWaitingQueueEntryExpanded(runId) {
    return typeof runId === "string" && runId
        ? state.expandedWaitingQueueRunIds.has(runId)
        : false;
}

function isPluginRuleCardExpanded(ruleId) {
    return typeof ruleId === "string" && ruleId
        ? state.expandedPluginRuleIds.has(ruleId)
        : false;
}

function syncWaitingQueueExpandedState() {
    const validRunIds = new Set(
        state.waitingQueueEntries
            .map((entry) => {
                const runId = entry?.run_id || entry?.run?.id || "";
                return typeof runId === "string" ? runId.trim() : "";
            })
            .filter(Boolean),
    );

    state.expandedWaitingQueueRunIds = new Set(
        Array.from(state.expandedWaitingQueueRunIds).filter((runId) => validRunIds.has(runId)),
    );
}

function syncPluginRuleExpandedState() {
    const validRuleIds = new Set(
        state.pluginRules
            .map((rule) => (typeof rule?.id === "string" ? rule.id.trim() : ""))
            .filter(Boolean),
    );

    state.expandedPluginRuleIds = new Set(
        Array.from(state.expandedPluginRuleIds).filter((ruleId) => validRuleIds.has(ruleId)),
    );
}

function isSettingsSubsectionOpen(key) {
    return Boolean(state.settingsSubsectionOpenStates?.[key]);
}

function buildSettingsSubsectionHtml(key, title, summary, body) {
    const isOpen = isSettingsSubsectionOpen(key);
    return `
        <section class="stlp-settings-subsection ${isOpen ? "is-open" : ""}">
            <button class="stlp-settings-subsection-button" type="button" data-action="toggle-settings-subsection" data-settings-subsection="${escapeHtml(key)}" aria-expanded="${isOpen ? "true" : "false"}">
                <span class="stlp-settings-subsection-copy">
                    <span class="stlp-settings-subsection-title">${escapeHtml(title)}</span>
                    ${summary ? `<span class="stlp-settings-subsection-summary">${escapeHtml(summary)}</span>` : ""}
                </span>
                <span class="stlp-settings-subsection-chevron" aria-hidden="true">▾</span>
            </button>
            <div class="stlp-settings-subsection-body ${isOpen ? "" : "stlp-hidden"}">
                ${body}
            </div>
        </section>
    `;
}

function cycleThemeMode() {
    state.uiSettings.themeMode = getNextThemeMode(state.uiSettings.themeMode);
    saveUiSettings();
    safeRenderPage();
}

function minimizePage() {
    state.pageMinimized = true;
    state.confirmDialog = null;
    state.historyDialogOpen = false;
    state.minimizedButtonAlertPending = false;
    triggerMinimizedButtonFlash();
    safeRenderPage();
}

function restoreMinimizedPage() {
    // 把面板从星星恢复成打开状态，本身就算"这条提醒你看到了"，不要求那张失败卡片真滚到眼前。
    state.mainApiErrorActive = false;
    if (!state.pageOpen) {
        openMonitorPage();
        return;
    }

    state.pageMinimized = false;
    state.confirmDialog = null;
    if (state.pendingGenerationIntervention) {
        openPendingGenerationInterventionDialog();
        return;
    }
    safeRenderPage();
}

function saveUiSettings() {
    try {
        localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(state.uiSettings));
    } catch {
        // Ignore storage failures so the extension never blocks the page.
    }
}

function clampMinimizedButtonPosition(position, rect = {}, viewport = null) {
    const width = Number(rect.width) || MINIMIZED_BUTTON_SIZE;
    const height = Number(rect.height) || MINIMIZED_BUTTON_SIZE;
    // 视口尺寸允许调用方传进来：读 window.innerWidth/innerHeight 会强制浏览器把待处理的
    // 样式改动刷成布局，拖动时每帧读一次就是每帧一次全文档布局，安卓上这笔开销很可观。
    const viewportWidth = Number(viewport?.width) || window.innerWidth;
    const viewportHeight = Number(viewport?.height) || window.innerHeight;
    const maxLeft = Math.max(MINIMIZED_BUTTON_MARGIN, viewportWidth - MINIMIZED_BUTTON_MARGIN - width);
    const maxTop = Math.max(MINIMIZED_BUTTON_MARGIN, viewportHeight - MINIMIZED_BUTTON_MARGIN - height);

    // 这里不能用 `|| maxLeft` 兜底：坐标恰好是 0 时会走 falsy 分支被当成"没给值"，
    // 按钮从左边缘瞬间弹到右边缘。只有真的不是数字才该退回默认位置。
    const rawLeft = Number(position?.left);
    const rawTop = Number(position?.top);
    const left = Number.isFinite(rawLeft) ? rawLeft : maxLeft;
    const top = Number.isFinite(rawTop) ? rawTop : maxTop;

    return {
        left: Math.round(Math.max(MINIMIZED_BUTTON_MARGIN, Math.min(left, maxLeft))),
        top: Math.round(Math.max(MINIMIZED_BUTTON_MARGIN, Math.min(top, maxTop))),
    };
}

function buildMinimizedButtonStyle() {
    const colorValue = getMinimizedButtonConnectedColorValue();
    const strokeColorValue = getMinimizedButtonStrokeColorValue();
    const backgroundValues = getMinimizedButtonBackgroundValues();
    const opacityValue = normalizeMinimizedButtonOpacity(state.uiSettings.minimizedButtonOpacity);
    const baseStyle = `--stlp-minimized-connected:${colorValue};--stlp-minimized-stroke:${strokeColorValue};--stlp-minimized-bg:${backgroundValues.background};--stlp-minimized-bg-hover:${backgroundValues.hoverBackground};--stlp-minimized-border:${backgroundValues.borderColor};--stlp-minimized-shadow:${backgroundValues.shadow};--stlp-minimized-opacity:${opacityValue};`;

    const position = normalizeMinimizedButtonPosition(state.uiSettings.minimizedButtonPosition);
    if (!position) {
        return ` style="${baseStyle}"`;
    }

    const clampedPosition = clampMinimizedButtonPosition(position);
    state.uiSettings.minimizedButtonPosition = clampedPosition;
    return ` style="${baseStyle}left:${clampedPosition.left}px;top:${clampedPosition.top}px;right:auto;bottom:auto;"`;
}

function clearRefreshTimer() {
    if (!state.refreshTimerId) {
        return;
    }

    clearInterval(state.refreshTimerId);
    state.refreshTimerId = null;
}

function clearUiRetryTimer() {
    if (!state.uiRetryTimerId) {
        return;
    }

    clearInterval(state.uiRetryTimerId);
    state.uiRetryTimerId = null;
}

function disableExtension(reason) {
    if (state.extensionDisabled) {
        return;
    }

    state.extensionDisabled = true;
    clearRefreshTimer();
    clearUiRetryTimer();

    if (state.pageRoot instanceof HTMLElement) {
        state.pageRoot.remove();
    }

    if (state.launcherRoot instanceof HTMLElement) {
        state.launcherRoot.remove();
    }

    state.pageRoot = null;
    state.launcherRoot = null;
    state.uiReady = false;

    console.error(`[${MODULE_NAME}] 已停用独立页面入口：${reason}`);
}

function reportExtensionError(action, error, { disable = false } = {}) {
    const message = error instanceof Error ? error.message : String(error);
    if (disable) {
        disableExtension(`${action} 失败：${message}`);
        return;
    }

    console.error(`[${MODULE_NAME}] ${action} 失败：${message}`, error);
}

function runSafely(action, callback, fallbackValue = undefined, { disableOnError = false } = {}) {
    if (state.extensionDisabled) {
        return fallbackValue;
    }

    try {
        return callback();
    } catch (error) {
        reportExtensionError(action, error, { disable: disableOnError });
        return fallbackValue;
    }
}

function safeRenderPage() {
    // 拖动期间一律不重渲染：renderPage 整块重写 innerHTML，会把最小化按钮的节点换掉，
    // 而拖动起手时对旧节点调了 setPointerCapture，节点一消失浏览器就抛 pointercancel，
    // 手指还没抬起来拖动就断了。实测那个节点几秒内就会被换一次，触屏很容易撞上。
    // 挂起的渲染在 endMinimizedButtonDrag 里补。
    if (state.minimizedButtonDrag) {
        state.minimizedButtonDragRenderPending = true;
        return;
    }

    // 同一个坑的另一半：手指按在滑块上时，后台定时刷新照样会整块重写 innerHTML 把它换掉。
    // 滑块自己的 input 事件早就绕开了重渲染，但挡不住外部来源，所以按下期间一并挂起。
    if (state.sliderInteractionPointerId !== null) {
        state.sliderInteractionRenderPending = true;
        return;
    }

    runSafely("渲染独立页面", () => {
        renderPage();
    });
}

function isColorWheelInputTarget(target) {
    return target instanceof HTMLInputElement
        && target.type === "color"
        && target.classList.contains("stlp-color-wheel-input");
}

function isColorWheelInputActive() {
    return isColorWheelInputTarget(document.activeElement);
}

function deferColorWheelRenderUntilBlur() {
    state.colorWheelRenderPending = true;
}

function flushDeferredColorWheelRender() {
    if (!state.colorWheelRenderPending) {
        return;
    }

    if (isColorWheelInputActive()) {
        return;
    }

    state.colorWheelRenderPending = false;
    safeRenderPage();
}

function beginPanelSliderInteraction(pointerId) {
    state.sliderInteractionPointerId = pointerId;
    if (state.sliderInteractionTimerId) {
        clearTimeout(state.sliderInteractionTimerId);
    }

    state.sliderInteractionTimerId = window.setTimeout(() => {
        runSafely("滑块交互超时收尾", () => {
            endPanelSliderInteraction();
        });
    }, PANEL_SLIDER_INTERACTION_IDLE_MS);
}

function endPanelSliderInteraction() {
    if (state.sliderInteractionTimerId) {
        clearTimeout(state.sliderInteractionTimerId);
        state.sliderInteractionTimerId = null;
    }

    if (state.sliderInteractionPointerId === null) {
        return;
    }

    state.sliderInteractionPointerId = null;
    if (state.sliderInteractionRenderPending) {
        state.sliderInteractionRenderPending = false;
        safeRenderPage();
    }
}

function setWaitingQueueEditLock(runId, durationMs = WAITING_QUEUE_EDIT_LOCK_MS) {
    if (typeof runId !== "string" || !runId.trim()) {
        return;
    }

    state.waitingQueueEditLockRunId = runId.trim();
    state.waitingQueueEditLockUntil = Date.now() + Math.max(0, Number(durationMs) || 0);
}

function clearWaitingQueueEditLock(runId = "") {
    if (runId && state.waitingQueueEditLockRunId && state.waitingQueueEditLockRunId !== runId) {
        return;
    }

    state.waitingQueueEditLockRunId = "";
    state.waitingQueueEditLockUntil = 0;
}

function getWaitingQueueLockedRunId() {
    if (!isWaitingQueueView()) {
        clearWaitingQueueEditLock();
        return "";
    }

    if (!state.waitingQueueEditLockRunId) {
        return "";
    }

    if (Date.now() > state.waitingQueueEditLockUntil) {
        clearWaitingQueueEditLock();
        return "";
    }

    return state.waitingQueueEditLockRunId;
}

function deferWaitingQueueRenderUntilBlur() {
    if (isWaitingQueueView()) {
        state.waitingQueueRenderPending = true;
    }
}

function flushDeferredWaitingQueueRender() {
    if (!state.waitingQueueRenderPending) {
        return;
    }

    if (isWaitingQueueLabelInputActive()) {
        return;
    }

    state.waitingQueueRenderPending = false;
    safeRenderPage();
}

function captureWaitingQueueInputState() {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLInputElement) || !activeElement.dataset.waitingLabelRunId) {
        const lockedRunId = getWaitingQueueLockedRunId();
        if (!lockedRunId) {
            return null;
        }

        return {
            runId: lockedRunId,
            value: typeof state.waitingQueueDrafts?.[lockedRunId] === "string" ? state.waitingQueueDrafts[lockedRunId] : "",
            selectionStart: null,
            selectionEnd: null,
            isFocused: false,
        };
    }

    return {
        runId: activeElement.dataset.waitingLabelRunId,
        value: activeElement.value,
        selectionStart: activeElement.selectionStart,
        selectionEnd: activeElement.selectionEnd,
        isFocused: true,
    };
}

function isWaitingQueueLabelInputActive() {
    if (!isWaitingQueueView()) {
        return false;
    }

    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLInputElement && activeElement.dataset.waitingLabelRunId) {
        setWaitingQueueEditLock(activeElement.dataset.waitingLabelRunId);
        return true;
    }

    return Boolean(getWaitingQueueLockedRunId());
}

function restoreWaitingQueueInputState(snapshot) {
    if (!snapshot?.runId || !(state.pageRoot instanceof HTMLElement)) {
        return;
    }

    const nextInput = state.pageRoot.querySelector(`input[data-waiting-label-run-id="${snapshot.runId}"]`);
    if (!(nextInput instanceof HTMLInputElement)) {
        return;
    }

    if (typeof snapshot.value === "string" && nextInput.value !== snapshot.value) {
        nextInput.value = snapshot.value;
    }

    const isAlreadyActive = document.activeElement === nextInput;
    if (!isAlreadyActive) {
        try {
            nextInput.focus({ preventScroll: true });
        } catch {
            nextInput.focus();
        }
    }

    if (typeof snapshot.selectionStart === "number" && typeof snapshot.selectionEnd === "number") {
        const selectionAlreadyMatches = nextInput.selectionStart === snapshot.selectionStart
            && nextInput.selectionEnd === snapshot.selectionEnd;
        if (!selectionAlreadyMatches) {
            nextInput.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
        }
    }
}

function blurWaitingQueueInput() {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLInputElement) || !activeElement.dataset.waitingLabelRunId) {
        return;
    }

    activeElement.blur();
}

function captureWaitingQueueEntrySnapshot(snapshot) {
    if (!snapshot?.runId || !(state.pageRoot instanceof HTMLElement) || !isWaitingQueueView()) {
        return null;
    }

    const waitingQueueInput = state.pageRoot.querySelector(`input[data-waiting-label-run-id="${snapshot.runId}"]`);
    const waitingQueueEntryRoot = waitingQueueInput instanceof HTMLInputElement
        ? waitingQueueInput.closest(`[data-waiting-entry-run-id="${snapshot.runId}"]`)
        : null;
    if (!(waitingQueueEntryRoot instanceof HTMLElement)) {
        return null;
    }

    return {
        runId: snapshot.runId,
        root: waitingQueueEntryRoot,
    };
}

function restoreWaitingQueueEntrySnapshot(entrySnapshot, waitingQueueViewRoot) {
    if (!entrySnapshot?.runId || !(entrySnapshot.root instanceof HTMLElement) || !(waitingQueueViewRoot instanceof HTMLElement)) {
        return waitingQueueViewRoot;
    }

    const nextEntryRoot = waitingQueueViewRoot.querySelector(`[data-waiting-entry-run-id="${entrySnapshot.runId}"]`);
    if (!(nextEntryRoot instanceof HTMLElement)) {
        return waitingQueueViewRoot;
    }

    nextEntryRoot.replaceWith(entrySnapshot.root);
    return waitingQueueViewRoot;
}

function finishOpenMonitorPage() {
    togglePage(true);
    state.pageOpenGuardUntil = isMobileDrawerLayout() ? Date.now() + MOBILE_OPEN_GUARD_MS : 0;
    if (!state.initialDataLoaded) {
        state.initialDataLoaded = true;
        void refreshBackendData();
        return;
    }

    void refreshBackendData({ silent: true });
}

function isIosWebKit() {
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    const maxTouchPoints = Number(navigator.maxTouchPoints || 0);
    const isiOSDevice = /iPad|iPhone|iPod/.test(ua)
        || (platform === "MacIntel" && maxTouchPoints > 1);
    const isAppleWebKit = /AppleWebKit/i.test(ua)
        && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(ua);

    return isiOSDevice && isAppleWebKit;
}

function openMonitorPage() {
    const now = Date.now();
    if (now - state.pageOpenRequestAt < 400) {
        return;
    }

    state.pageOpenRequestAt = now;
    if (isMobileDrawerLayout()) {
        closeNativeMenu({ forceDirectHide: true });
        window.setTimeout(() => {
            runSafely("打开移动端独立页面", () => {
                finishOpenMonitorPage();
            });
        }, 0);
        return;
    }

    closeNativeMenu();
    window.setTimeout(() => {
        runSafely("打开独立页面", () => {
            finishOpenMonitorPage();
        });
    }, 0);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatSeconds(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "-";
    }

    const seconds = value / 1000;
    return `${Math.round(seconds * 100) / 100} 秒`;
}

function formatBoolean(value) {
    return value ? "是" : "否";
}

function formatPercent(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "-";
    }

    return `${Math.round(value * 100) / 100}%`;
}

function formatCount(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "-";
    }

    return Math.round(value).toLocaleString("zh-CN");
}

function formatDateKeyLabel(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return "-";
    }

    return value.slice(5).replace("-", "/");
}

function formatPlainValue(value) {
    if (value === null || value === undefined || value === "") {
        return "-";
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        return formatCount(value);
    }

    return String(value);
}

function formatTopValueList(items) {
    if (!Array.isArray(items) || !items.length) {
        return "-";
    }

    return items
        .map((item) => `${item?.label || item?.value || "-"} x${formatCount(Number(item?.count) || 0)}`)
        .join(" / ");
}

function shortenRunId(runId) {
    return typeof runId === "string" ? runId.slice(0, 8) : "-";
}

function getPermissionLabel(value) {
    return PERMISSION_LABELS[value] || value || "-";
}

function getRuntimeModeLabel(value) {
    return RUNTIME_MODE_LABELS[value] || value || "-";
}

function getSuggestionScopeLabel(value) {
    return SUGGESTION_SCOPE_LABELS[value] || value || "-";
}

function getEntryOriginLabel(value) {
    return ENTRY_ORIGIN_LABELS[value] || "主界面生成记录";
}

function getRunGenerationTypeLabel(run) {
    const normalized = normalizeGenerationType(run?.request_generation_type);
    return normalized ? GENERATION_TYPE_LABELS[normalized] : "";
}

function getSourceLabel(value) {
    if (typeof value !== "string" || !value.trim()) {
        return "未记录来源";
    }

    return SOURCE_LABELS[value] || value;
}

function normalizePricingCurrency(value) {
    return value === "cny" ? "cny" : "usd";
}

function getPricingCurrencyLabel(value = "usd") {
    return PRICING_CURRENCY_LABELS[value] || PRICING_CURRENCY_LABELS.usd;
}

function normalizeConfiguredPriceValue(value) {
    // 未填写和填了 0 是两回事。Number(null) 和 Number("") 都等于 0，不挡住就会把"没填"
    // 变成"填了 0"，后端 normalizeOptionalPricingNumber 一直是这么挡的，这里对齐。
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue >= 0 ? Math.round(numberValue * 1000000) / 1000000 : null;
}

function isPlainRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePeakValleyTimeValue(value) {
    if (typeof value !== "string") {
        return "";
    }

    const trimmedValue = value.trim();
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(trimmedValue) ? trimmedValue : "";
}

function convertPeakValleyTimeToMinutes(value) {
    const normalizedValue = normalizePeakValleyTimeValue(value);
    if (!normalizedValue) {
        return null;
    }

    const [hours, minutes] = normalizedValue.split(":").map(Number);
    return (hours * 60) + minutes;
}

function normalizePricingConfig(config) {
    const source = isPlainRecord(config) ? config : {};
    return {
        currency: normalizePricingCurrency(source.currency),
        input_price_per_million: normalizeConfiguredPriceValue(source.input_price_per_million),
        cached_input_price_per_million: normalizeConfiguredPriceValue(source.cached_input_price_per_million),
        output_price_per_million: normalizeConfiguredPriceValue(source.output_price_per_million),
        peak_valley_enabled: Boolean(source.peak_valley_enabled),
        peak_start_time: normalizePeakValleyTimeValue(source.peak_start_time),
        peak_end_time: normalizePeakValleyTimeValue(source.peak_end_time),
        peak_input_price_per_million: normalizeConfiguredPriceValue(source.peak_input_price_per_million),
        peak_cached_input_price_per_million: normalizeConfiguredPriceValue(source.peak_cached_input_price_per_million),
        peak_output_price_per_million: normalizeConfiguredPriceValue(source.peak_output_price_per_million),
        valley_input_price_per_million: normalizeConfiguredPriceValue(source.valley_input_price_per_million),
        valley_cached_input_price_per_million: normalizeConfiguredPriceValue(source.valley_cached_input_price_per_million),
        valley_output_price_per_million: normalizeConfiguredPriceValue(source.valley_output_price_per_million),
    };
}

function normalizePricingConfigMap(value) {
    if (!isPlainRecord(value)) {
        return {};
    }

    const nextMap = {};
    for (const [modelName, config] of Object.entries(value)) {
        const normalizedModelName = typeof modelName === "string" ? modelName.trim() : "";
        if (!normalizedModelName) {
            continue;
        }

        nextMap[normalizedModelName] = normalizePricingConfig(config);
    }

    return nextMap;
}

// 峰谷价只在开关打开时才会被读到——getRunPeakValleySelection 第一行就在开关关着时返回 null。
// 关着的时候这六个字段对计价毫无影响，自然也不该让一条只剩它们有值的配置算作"配过价"。
//
// 这不是假想的边界。老版本曾把空字段写成 0（成因见 normalizeConfiguredPriceValue 上的注释），
// 那批 0 冻在设置文件里，之后每次保存又被原样带上，用户在界面上怎么清都清不掉——输入框还把 0
// 显示成空，看着已经清干净了。不挡住的话这种配置会被判成已配置，于是既盖住了剥前缀回退，
// 自己又没有主价格可用，金额永远算不出来。
function hasConfiguredPriceValues(config) {
    const fieldNames = config?.peak_valley_enabled
        ? PRICING_NUMBER_FIELDS
        : PRICING_BASE_NUMBER_FIELDS;
    return fieldNames.some((fieldName) => normalizeConfiguredPriceValue(config?.[fieldName]) !== null);
}

function getRunPricingReferenceDate(run) {
    const startedAtMs = Number(run?.started_at_ms);
    if (Number.isFinite(startedAtMs) && startedAtMs > 0) {
        const startedAtDate = new Date(startedAtMs);
        return Number.isNaN(startedAtDate.getTime()) ? null : startedAtDate;
    }

    const startedAtIso = typeof run?.started_at_iso === "string" ? run.started_at_iso : "";
    if (!startedAtIso) {
        return null;
    }

    const startedAtDate = new Date(startedAtIso);
    return Number.isNaN(startedAtDate.getTime()) ? null : startedAtDate;
}

function getRunPeakValleySelection(run, config) {
    const normalizedConfig = normalizePricingConfig(config);
    if (!normalizedConfig.peak_valley_enabled) {
        return null;
    }

    const peakStartMinutes = convertPeakValleyTimeToMinutes(normalizedConfig.peak_start_time);
    const peakEndMinutes = convertPeakValleyTimeToMinutes(normalizedConfig.peak_end_time);
    if (peakStartMinutes === null || peakEndMinutes === null || peakStartMinutes === peakEndMinutes) {
        return {
            enabled: true,
            active: false,
            reason: "invalid_schedule",
        };
    }

    const referenceDate = getRunPricingReferenceDate(run);
    if (!(referenceDate instanceof Date)) {
        return {
            enabled: true,
            active: false,
            reason: "missing_run_time",
        };
    }

    const currentMinutes = (referenceDate.getHours() * 60) + referenceDate.getMinutes();
    const inPeakWindow = peakStartMinutes < peakEndMinutes
        ? currentMinutes >= peakStartMinutes && currentMinutes < peakEndMinutes
        : currentMinutes >= peakStartMinutes || currentMinutes < peakEndMinutes;
    const periodKey = inPeakWindow ? "peak" : "valley";

    return {
        enabled: true,
        active: true,
        periodKey,
        periodLabel: inPeakWindow ? "峰时" : "谷时",
        inputPrice: normalizeConfiguredPriceValue(normalizedConfig[`${periodKey}_input_price_per_million`]),
        cachedInputPrice: normalizeConfiguredPriceValue(normalizedConfig[`${periodKey}_cached_input_price_per_million`]),
        outputPrice: normalizeConfiguredPriceValue(normalizedConfig[`${periodKey}_output_price_per_million`]),
    };
}

function getLocalPricingMap() {
    return state.uiSettings?.pricingConfigByModel && typeof state.uiSettings.pricingConfigByModel === "object"
        ? state.uiSettings.pricingConfigByModel
        : {};
}

function getBackendPricingMap() {
    return state.settings?.pricing?.model_prices && typeof state.settings.pricing.model_prices === "object"
        ? state.settings.pricing.model_prices
        : {};
}

function getModelPricingMap() {
    return {
        ...getLocalPricingMap(),
        ...getBackendPricingMap(),
    };
}

// 后端那份才是权威：换设备、清浏览器数据之后只剩它，异常记录的费用估算也只读它。
// 本地填了价格而后端没有，说明当时那次保存没送达；面板把两份合起来显示，
// 不特意标出来就完全看不出区别。
function getLocalOnlyPricedModels() {
    // state.settings 还没拉回来时后端那份是空的，此时判断会把所有模型都误报成未同步。
    if (!isPlainRecord(state.settings)) {
        return [];
    }

    const localPricingMap = getLocalPricingMap();
    const backendPricingMap = getBackendPricingMap();

    return Object.keys(localPricingMap).filter((modelName) => (
        hasConfiguredPriceValues(localPricingMap[modelName])
        && !hasConfiguredPriceValues(backendPricingMap[modelName])
    ));
}

function getModelPriceConfig(modelName) {
    const normalizedModelName = typeof modelName === "string" ? modelName.trim() : "";
    if (!normalizedModelName) {
        return null;
    }

    const config = getModelPricingMap()[normalizedModelName];
    return config === undefined ? null : normalizePricingConfig(config);
}

function getModelPriceCurrency(modelName) {
    return normalizePricingCurrency(getModelPriceConfig(modelName)?.currency);
}

// 估算用的查找：精确匹配不上就从左往右逐段剥掉中转层前缀。
// 和 getModelPriceConfig 分开是故意的——设置里的编辑框只能显示这个模型自己配的值，
// 若也走回退，一改动就把沿用来的价格固化成它自己的配置，回退当场失效。
function resolveModelPricingEntry(modelName) {
    const normalizedModelName = typeof modelName === "string" ? modelName.trim() : "";
    if (!normalizedModelName) {
        return null;
    }

    const pricingMap = getModelPricingMap();
    const candidates = [normalizedModelName];
    let rest = normalizedModelName;
    let separatorIndex = rest.indexOf("/");
    while (separatorIndex >= 0) {
        rest = rest.slice(separatorIndex + 1);
        if (rest) {
            candidates.push(rest);
        }
        separatorIndex = rest.indexOf("/");
    }

    for (const candidate of candidates) {
        if (pricingMap[candidate] === undefined) {
            continue;
        }

        const normalizedConfig = normalizePricingConfig(pricingMap[candidate]);
        if (hasConfiguredPriceValues(normalizedConfig)) {
            return {
                modelName: candidate,
                config: normalizedConfig,
                isFallback: candidate !== normalizedModelName,
            };
        }
    }

    return null;
}

function getPricingPanelOpenStates() {
    const value = state.uiSettings?.pricingPanelOpenStates;
    return value && typeof value === "object" ? value : {};
}

function isPricingPanelOpen(modelName) {
    return Boolean(getPricingPanelOpenStates()[modelName]);
}

function getPricingPeakValleyOpenStates() {
    const value = state.uiSettings?.pricingPeakValleyOpenStates;
    return value && typeof value === "object" ? value : {};
}

function isPricingPeakValleyPanelOpen(modelName) {
    return Boolean(getPricingPeakValleyOpenStates()[modelName]);
}

function getOutputCardFields() {
    return normalizeOutputCardFields(state.uiSettings?.outputCardFields);
}

function getRunUsage(run) {
    const usage = run?.response_usage ?? {};
    const promptTokens = normalizeConfiguredPriceValue(usage.prompt_tokens);
    const completionTokens = normalizeConfiguredPriceValue(usage.completion_tokens);
    const totalTokens = normalizeConfiguredPriceValue(usage.total_tokens);
    const cachedTokens = normalizeConfiguredPriceValue(usage.cached_tokens);
    const cacheReadTokens = normalizeConfiguredPriceValue(usage.cache_read_tokens);
    const cacheWriteTokens = normalizeConfiguredPriceValue(usage.cache_write_tokens);
    const cacheHit = typeof usage.cache_hit === "boolean"
        ? usage.cache_hit
        : Boolean(
            (cachedTokens !== null && cachedTokens > 0)
            || (cacheReadTokens !== null && cacheReadTokens > 0)
            || (cacheWriteTokens !== null && cacheWriteTokens > 0),
        );
    return {
        promptTokens,
        completionTokens,
        totalTokens,
        cacheHit,
        cachedTokens,
        cacheReadTokens,
        cacheWriteTokens,
    };
}

function hasRunCacheHit(run) {
    return Boolean(getRunUsage(run).cacheHit);
}

function hasRunUsage(run) {
    const usage = getRunUsage(run);
    return usage.promptTokens !== null
        || usage.completionTokens !== null
        || usage.totalTokens !== null
        || usage.cachedTokens !== null
        || usage.cacheReadTokens !== null
        || usage.cacheWriteTokens !== null
        || typeof run?.response_usage?.cache_hit === "boolean";
}

function getRunCachedInputTokens(usage) {
    if (!usage || typeof usage !== "object") {
        return null;
    }

    if (usage.cachedTokens === null) {
        return usage.cacheReadTokens;
    }
    if (usage.cacheReadTokens === null) {
        return usage.cachedTokens;
    }

    return Math.max(usage.cachedTokens, usage.cacheReadTokens);
}

function formatPriceValue(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "-";
    }

    if (value === 0) {
        return "0";
    }

    const absValue = Math.abs(value);
    let fractionDigits = 6;
    if (absValue >= 100) {
        fractionDigits = 2;
    } else if (absValue >= 1) {
        fractionDigits = 4;
    }

    return value
        .toFixed(fractionDigits)
        .replace(/\.?0+$/, "");
}

function formatPriceWithCurrency(value, currency = "usd") {
    const formattedValue = formatPriceValue(value);
    if (formattedValue === "-") {
        return "-";
    }

    return `${formattedValue} ${getPricingCurrencyLabel(currency)}`;
}

function collectPricingModels() {
    const pricingMap = getModelPricingMap();
    const modelMap = new Map();
    const allRuns = [
        ...state.runs,
        ...state.historyRuns,
        ...state.historyAllRuns,
        ...state.filteredRuns,
    ];

    for (const run of allRuns) {
        const modelName = typeof run?.model === "string" ? run.model.trim() : "";
        if (!modelName) {
            continue;
        }

        const current = modelMap.get(modelName) ?? {
            model: modelName,
            run_count: 0,
            supports_usage: false,
            configured: false,
        };
        current.run_count += 1;
        current.supports_usage = current.supports_usage || hasRunUsage(run);
        modelMap.set(modelName, current);
    }

    for (const [modelName, config] of Object.entries(pricingMap)) {
        const normalizedModelName = typeof modelName === "string" ? modelName.trim() : "";
        if (!normalizedModelName) {
            continue;
        }

        const current = modelMap.get(normalizedModelName) ?? {
            model: normalizedModelName,
            run_count: 0,
            supports_usage: false,
            configured: false,
        };
        current.configured = true;
        current.supports_usage = current.supports_usage
            || hasConfiguredPriceValues(config);
        modelMap.set(normalizedModelName, current);
    }

    return Array.from(modelMap.values()).sort((left, right) => right.run_count - left.run_count || left.model.localeCompare(right.model));
}

// 从左往右逐段剥掉 `/` 前缀，得到这个名字可能的底模名，长的在前。
// 和 resolveModelPricingEntry 的候选生成是同一套规则，区别只是这里不含名字自己。
function getPricingBaseNameCandidates(modelName) {
    const candidates = [];
    let rest = typeof modelName === "string" ? modelName : "";
    let separatorIndex = rest.indexOf("/");
    while (separatorIndex >= 0) {
        rest = rest.slice(separatorIndex + 1);
        if (rest) {
            candidates.push(rest);
        }
        separatorIndex = rest.indexOf("/");
    }

    return candidates;
}

// 中转给同一个模型套不同路由前缀时（假流式/X、流式抗截断/X），设置页会把它们列成几条
// 互不相干的条目。计价那边早就会剥前缀回退了（resolveModelPricingEntry），可那个"沿用 X"
// 只在底模已经配好之后才显示——第一次配置的人看到的是三条都写着"价格待填"，没有任何
// 线索说它们是同一个模型，于是自然挑自己眼熟的带前缀那条去填，反而因为"显式配置优先"
// 把统一价格挡掉了。这个函数只负责把关系摆到明面上，不碰计价逻辑本身。
function groupPricingModelsByBaseName(models) {
    const list = Array.isArray(models) ? models : [];
    const modelInfoByName = new Map(list.map((modelInfo) => [modelInfo.model, modelInfo]));

    // 第一轮：归到列表里真实存在的底模。这里要求底模必须存在，不能简单地剥到最后一段：
    // 记录里就有 deepseek-ai/DeepSeek-V4-Flash 这种名字自带斜杠的，剥到底会得出谁都没用过的
    // DeepSeek-V4-Flash，等于把一条好好的条目拆坏。候选是从长到短给的，取第一个命中的，
    // 所以 Pro/deepseek-ai/DeepSeek-V3 会归到 deepseek-ai/DeepSeek-V3 而不是 DeepSeek-V3。
    const baseNameByModel = new Map();
    for (const modelInfo of list) {
        for (const candidate of getPricingBaseNameCandidates(modelInfo.model)) {
            if (modelInfoByName.has(candidate)) {
                baseNameByModel.set(modelInfo.model, candidate);
                break;
            }
        }
    }

    // 第二轮：两条以上变体共享同一个后缀、而这个后缀不在列表里时，把它合成一条组头。
    // 精简版只有本机浏览器的记录，很可能从没用过裸名字，没有这一步整个分组对它就是空转，
    // 而设置页又没有手动添加模型名的入口，用户根本无从把价格配到底模上。
    //
    // 卡死在"两条以上"是因为只有一条时分不清那个斜杠是中转加的路由前缀还是模型名自带的，
    // 凭一条就合成会造出谁都没用过的名字。两个不同前缀指向同一后缀，才算这个后缀是真模型名。
    const orphans = list.filter((modelInfo) => !baseNameByModel.has(modelInfo.model));
    const sharedSuffixOwners = new Map();
    for (const modelInfo of orphans) {
        for (const candidate of getPricingBaseNameCandidates(modelInfo.model)) {
            const owners = sharedSuffixOwners.get(candidate) ?? new Set();
            owners.add(modelInfo.model);
            sharedSuffixOwners.set(candidate, owners);
        }
    }
    for (const modelInfo of orphans) {
        for (const candidate of getPricingBaseNameCandidates(modelInfo.model)) {
            if ((sharedSuffixOwners.get(candidate)?.size ?? 0) >= 2) {
                baseNameByModel.set(modelInfo.model, candidate);
                break;
            }
        }
    }

    // 链条收敛：假流式/a/b → a/b → b 同时存在时，整条链都归到最终的 b，和计价那边
    // 逐段回退的行为一致。每一步名字都严格变短，绕不成环。
    const resolveRootName = (modelName) => {
        let current = modelName;
        while (baseNameByModel.has(current)) {
            current = baseNameByModel.get(current);
        }
        return current;
    };

    const groups = new Map();
    for (const modelInfo of list) {
        const rootName = resolveRootName(modelInfo.model);
        if (rootName === modelInfo.model) {
            continue;
        }

        let group = groups.get(rootName);
        if (!group) {
            group = {
                kind: "group",
                base: modelInfoByName.get(rootName) ?? {
                    model: rootName,
                    run_count: 0,
                    supports_usage: false,
                    configured: false,
                },
                baseSynthesized: !modelInfoByName.has(rootName),
                variants: [],
            };
            groups.set(rootName, group);
        }
        group.variants.push(modelInfo);
    }

    const entries = [];
    for (const modelInfo of list) {
        if (resolveRootName(modelInfo.model) !== modelInfo.model) {
            continue;
        }
        entries.push(groups.get(modelInfo.model) ?? { kind: "single", base: modelInfo });
    }
    // 合成出来的组头不在 list 里，上面那轮遍历不到，单独补进来。
    for (const group of groups.values()) {
        if (group.baseSynthesized) {
            entries.push(group);
        }
    }

    const getEntryWeight = (entry) => (entry.kind === "group"
        ? Math.max(entry.base.run_count, ...entry.variants.map((variant) => variant.run_count))
        : entry.base.run_count);

    for (const entry of entries) {
        if (entry.kind === "group") {
            entry.variants.sort((left, right) => right.run_count - left.run_count || left.model.localeCompare(right.model));
        }
    }

    return entries.sort((left, right) => (
        getEntryWeight(right) - getEntryWeight(left)
        || left.base.model.localeCompare(right.base.model)
    ));
}

function getRunEstimatedPrice(run) {
    const usage = getRunUsage(run);
    const pricingEntry = resolveModelPricingEntry(run?.model);
    if (!pricingEntry) {
        return null;
    }

    const config = pricingEntry.config;
    const currency = normalizePricingCurrency(config.currency);
    const baseInputPrice = normalizeConfiguredPriceValue(config.input_price_per_million);
    const baseCachedInputPrice = normalizeConfiguredPriceValue(config.cached_input_price_per_million);
    const baseOutputPrice = normalizeConfiguredPriceValue(config.output_price_per_million);
    const peakValleySelection = getRunPeakValleySelection(run, config);
    const inputPrice = peakValleySelection?.active
        ? (peakValleySelection.inputPrice ?? baseInputPrice)
        : baseInputPrice;
    const cachedInputPrice = peakValleySelection?.active
        ? (peakValleySelection.cachedInputPrice ?? baseCachedInputPrice)
        : baseCachedInputPrice;
    const outputPrice = peakValleySelection?.active
        ? (peakValleySelection.outputPrice ?? baseOutputPrice)
        : baseOutputPrice;
    const cachedInputTokens = getRunCachedInputTokens(usage);
    const boundedCachedInputTokens = usage.promptTokens !== null && cachedInputTokens !== null
        ? Math.min(usage.promptTokens, cachedInputTokens)
        : cachedInputTokens;
    const discountedCachedInputTokens = cachedInputPrice !== null
        ? (boundedCachedInputTokens ?? 0)
        : 0;
    const regularInputTokens = usage.promptTokens !== null
        ? Math.max(0, usage.promptTokens - discountedCachedInputTokens)
        : null;
    const regularInputCost = inputPrice !== null && usage.promptTokens !== null
        ? (regularInputTokens * inputPrice) / 1000000
        : null;
    const cachedInputCost = cachedInputPrice !== null && boundedCachedInputTokens !== null
        ? (boundedCachedInputTokens * cachedInputPrice) / 1000000
        : null;
    const inputCost = (
        regularInputCost !== null
        || cachedInputCost !== null
        || (usage.promptTokens !== null && inputPrice !== null)
    )
        ? (regularInputCost ?? 0) + (cachedInputCost ?? 0)
        : null;
    const outputCost = outputPrice !== null && usage.completionTokens !== null
        ? (usage.completionTokens * outputPrice) / 1000000
        : null;

    if (inputCost === null && outputCost === null) {
        return null;
    }

    const totalCost = (inputCost ?? 0) + (outputCost ?? 0);
    const noteParts = [];
    const pricingPeriodLabel = peakValleySelection?.active ? `${peakValleySelection.periodLabel}` : "";
    if (inputCost !== null) {
        noteParts.push(cachedInputCost !== null ? `${pricingPeriodLabel}输入价格（缓存部分已折算）` : `${pricingPeriodLabel}输入价格`);
    }
    if (outputCost !== null) {
        noteParts.push(`${pricingPeriodLabel}输出价格`);
    }
    if (boundedCachedInputTokens !== null && boundedCachedInputTokens > 0) {
        if (cachedInputPrice === null && inputPrice !== null) {
            noteParts.push(pricingPeriodLabel ? `${pricingPeriodLabel}缓存输入暂按普通输入价估算` : "缓存输入暂按普通输入价估算");
        }
    }
    if (peakValleySelection?.enabled && !peakValleySelection.active) {
        noteParts.push("峰谷时段未完整配置，暂按普通价格估算");
    } else if (peakValleySelection?.active) {
        const fallbackUsed = (
            (peakValleySelection.inputPrice === null && baseInputPrice !== null)
            || (peakValleySelection.cachedInputPrice === null && baseCachedInputPrice !== null)
            || (peakValleySelection.outputPrice === null && baseOutputPrice !== null)
        );
        if (fallbackUsed) {
            noteParts.push("未填写的峰谷价格已回退普通单价");
        }
    }

    const basePricingNote = noteParts.length >= 2
        ? `已按${noteParts.join("、")}估算`
        : (noteParts[0] ? `当前仅按${noteParts[0]}估算` : "当前按已配置价格估算");
    // 沿用别的名字算钱时必须说出来，否则套错档位（例如付费档用了普通档单价）根本看不出来。
    const pricingNote = pricingEntry.isFallback
        ? `${basePricingNote}。这个模型没有单独配价，沿用了 ${pricingEntry.modelName} 的价格`
        : basePricingNote;

    return {
        currency,
        totalCost,
        inputCost,
        regularInputCost,
        cachedInputCost,
        outputCost,
        cachedInputTokens: boundedCachedInputTokens,
        regularInputTokens,
        note: pricingNote,
    };
}

function getRunAbnormalBilling(run) {
    const abnormalDetail = run?.abnormal_detail;
    if (!abnormalDetail || typeof abnormalDetail !== "object") {
        return null;
    }

    const billingStatus = typeof abnormalDetail.billing_status === "string"
        ? abnormalDetail.billing_status
        : "";
    const estimatedPrice = abnormalDetail.estimated_price && typeof abnormalDetail.estimated_price === "object"
        ? abnormalDetail.estimated_price
        : null;
    const estimatedTotalCost = typeof estimatedPrice?.total_cost === "number" && Number.isFinite(estimatedPrice.total_cost)
        ? estimatedPrice.total_cost
        : null;
    const hasUsageEvidence = Boolean(abnormalDetail.has_usage_tokens);
    const hasEstimatedPrice = estimatedTotalCost !== null;
    const isPaidIncomplete = Boolean(abnormalDetail.is_paid_incomplete);
    const billingConfirmed = Boolean(billingStatus) || hasUsageEvidence || hasEstimatedPrice;

    return {
        status: billingStatus,
        label: ABNORMAL_BILLING_STATUS_LABELS[billingStatus]
            || (isPaidIncomplete ? "已付费未完成" : (billingConfirmed ? "已完成" : "费用未确认")),
        isPaidIncomplete,
        hasUsageTokens: hasUsageEvidence,
        usageTotalTokens: normalizeConfiguredPriceValue(abnormalDetail.usage_total_tokens),
        hasPricingConfig: Boolean(abnormalDetail.has_pricing_config),
        estimatedPriceText: estimatedTotalCost !== null
            ? formatPriceWithCurrency(estimatedTotalCost, estimatedPrice?.currency)
            : "-",
        note: typeof abnormalDetail.billing_note === "string" ? abnormalDetail.billing_note : "",
    };
}

function filterRunsByCacheHit(runs, cacheHitOnly = false) {
    const list = Array.isArray(runs) ? runs : [];
    if (!cacheHitOnly) {
        return list;
    }

    return list.filter(hasRunCacheHit);
}

function filterRunsByAbnormal(runs, abnormalOnly = false) {
    const list = Array.isArray(runs) ? runs : [];
    if (!abnormalOnly) {
        return list;
    }

    // 和后端 shared/run-query.js 的同名函数保持一致：被重发取代的尝试不算故障。
    return list.filter((run) => isAbnormalRun(run) && !isSupersededRetryRun(run));
}

function getActiveRunFilters() {
    return {
        abnormalOnly: Boolean(state.uiSettings.abnormalOnly),
        cacheHitOnly: Boolean(state.uiSettings.cacheHitOnly),
    };
}

function hasActiveRunFilters(filters = getActiveRunFilters()) {
    return Boolean(filters.abnormalOnly || filters.cacheHitOnly);
}

// 数据槽是否可用要连筛选组合一起比对，否则切换筛选后会短暂显示上一次筛选的结果。
function buildRunFilterKey(filters = getActiveRunFilters()) {
    return [
        getActiveRequestPurpose(),
        filters.abnormalOnly ? "abnormal" : "",
        filters.cacheHitOnly ? "cache-hit" : "",
    ].join("|");
}

function applyRunFilters(runs, filters = getActiveRunFilters()) {
    return filterRunsByCacheHit(
        filterRunsByAbnormal(filterRunsByRequestPurpose(runs), filters.abnormalOnly),
        filters.cacheHitOnly,
    );
}

function getRunFilterLabel(filters = getActiveRunFilters()) {
    const labels = [];
    if (filters.abnormalOnly) {
        labels.push("只看异常");
    }
    if (filters.cacheHitOnly) {
        labels.push("只看缓存命中");
    }
    return labels.join(" + ");
}

function normalizePluginKey(value) {
    return typeof value === "string" && value.trim()
        ? value.trim().toLowerCase()
        : "";
}

// 占位 id 有两种写法：连字符版是现在写入的，下划线版存在于旧记录里。
function isUnknownPluginKey(value) {
    const normalizedKey = normalizePluginKey(value);
    return normalizedKey === "unknown-plugin" || normalizedKey === "unknown_plugin";
}

function getKnownPluginLabel(value) {
    const normalizedKey = normalizePluginKey(value);
    return normalizedKey ? (KNOWN_PLUGIN_LABELS[normalizedKey] || "") : "";
}

function extractPromptTraceKeys(promptTrace) {
    if (!Array.isArray(promptTrace)) {
        return [];
    }

    const keys = [];

    for (const item of promptTrace) {
        if (typeof item === "string" && item.trim()) {
            keys.push(item.trim());
            continue;
        }

        if (!item || typeof item !== "object") {
            continue;
        }

        const candidate = [item.source, item.key, item.type, item.id]
            .find((value) => typeof value === "string" && value.trim());

        if (candidate) {
            keys.push(candidate.trim());
        }
    }

    return [...new Set(keys)];
}

function getPromptTraceSourceLabels(promptTrace) {
    return extractPromptTraceKeys(promptTrace)
        .filter((key) => TRACE_SOURCE_LABELS[key])
        .map((key) => TRACE_SOURCE_LABELS[key]);
}

function getPromptTraceDisplayItems(promptTrace) {
    return extractPromptTraceKeys(promptTrace).map((key) => ({
        key,
        label: TRACE_SOURCE_LABELS[key] || key,
        known: Boolean(TRACE_SOURCE_LABELS[key]),
    }));
}

function getRunPromptTraceItems(run) {
    return getPromptTraceDisplayItems(run?.prompt_trace);
}

function normalizeInjectionSourceKey(value) {
    return typeof value === "string" && value.trim()
        ? value.trim().toLowerCase()
        : "";
}

function getKnownInjectionSourceLabel(sourceId) {
    const normalizedSourceId = normalizeInjectionSourceKey(sourceId);
    return normalizedSourceId ? (KNOWN_INJECTION_SOURCE_LABELS[normalizedSourceId] || "") : "";
}

function getRunInjectionSourceId(run) {
    const sourceId = run?.request_injection_source || run?.injection_source || run?.extension_prompt_source || "";
    return typeof sourceId === "string" ? sourceId.trim() : "";
}

function getRunInjectionSourceLabel(run) {
    if (typeof run?.request_injection_source_label === "string" && run.request_injection_source_label.trim()) {
        return run.request_injection_source_label.trim();
    }

    if (typeof run?.injection_source_label === "string" && run.injection_source_label.trim()) {
        return run.injection_source_label.trim();
    }

    if (typeof run?.extension_prompt_source_label === "string" && run.extension_prompt_source_label.trim()) {
        return run.extension_prompt_source_label.trim();
    }

    return getKnownInjectionSourceLabel(getRunInjectionSourceId(run));
}

function hasRunInjectionTrace(run) {
    const traceKeys = extractPromptTraceKeys(run?.prompt_trace);
    return traceKeys.includes("chat_injects")
        || traceKeys.includes("extension_prompt")
        || Boolean(getRunInjectionSourceId(run))
        || Boolean(getRunInjectionSourceLabel(run));
}

function getFallbackInjectionSourceLabel(run, traceKey) {
    const explicitInjectionSourceLabel = getRunInjectionSourceLabel(run);
    if (explicitInjectionSourceLabel) {
        return explicitInjectionSourceLabel;
    }

    if (traceKey !== "extension_prompt") {
        return null;
    }

    const pluginLabel = getRunPluginLabel(run);
    if (pluginLabel) {
        return pluginLabel;
    }

    return null;
}

function getRunInjectionTraceLabels(run) {
    const labels = getRunPromptTraceItems(run)
        .filter((item) => item.key === "chat_injects" || item.key === "extension_prompt")
        .map((item) => getFallbackInjectionSourceLabel(run, item.key) || item.label);
    if (labels.length) {
        return labels;
    }

    const explicitInjectionSourceLabel = getRunInjectionSourceLabel(run);
    return explicitInjectionSourceLabel ? [explicitInjectionSourceLabel] : [];
}

function getRunSourceLabel(run) {
    const baseLabel = getSourceLabel(run?.source);
    const traceLabels = getPromptTraceSourceLabels(run?.prompt_trace).slice(0, 3);

    if (!traceLabels.length) {
        return baseLabel;
    }

    return `${baseLabel}（${traceLabels.join(" / ")}）`;
}

function getRunPluginLabel(run) {
    if (typeof run?.request_plugin_label === "string" && run.request_plugin_label.trim()) {
        return run.request_plugin_label.trim();
    }

    return getKnownPluginLabel(run?.request_plugin);
}

function isUnknownPluginRun(run) {
    const pluginKey = normalizePluginKey(run?.request_plugin);
    const matchMode = typeof run?.request_plugin_match_mode === "string" ? run.request_plugin_match_mode : "";
    return run?.request_purpose === "non_chat_generation"
        && (!pluginKey || isUnknownPluginKey(pluginKey) || matchMode === "fallback_unknown" || matchMode === "none");
}

function findRunById(runId) {
    if (typeof runId !== "string" || !runId.trim()) {
        return null;
    }

    const allRuns = [
        ...state.runs,
        ...state.historyRuns,
        ...state.historyAllRuns,
        ...state.filteredRuns,
        ...state.callTimerRuns,
        ...state.waitingQueueEntries.map((entry) => entry?.run).filter(Boolean),
    ];

    return allRuns.find((run) => run?.id === runId) ?? null;
}

// 展开态清理原来在三处各写各的判断，漏掉哪个数组，那一页的卡片就会被判成
// "已卸载"而自己合上——区间统计每 10 秒轮询一次，表现就是卡片不停跳掉。
// 统一成一个"到处找一遍"，宁可多留一会儿也不要误清。
function isRunLoadedAnywhere(runId) {
    return Boolean(findRunById(runId));
}

function getWaitingQueueEntry(runId) {
    return state.waitingQueueEntries.find((entry) => entry?.run_id === runId) ?? null;
}

function getAbnormalTypeLabel(value) {
    return ABNORMAL_TYPE_LABELS[value] || "正常完成";
}

function getFailedStageLabel(value) {
    return FAILED_STAGE_LABELS[value] || "-";
}

function getHttpStatusNumber(run) {
    const value = Number(run?.http_status);
    return Number.isFinite(value) ? value : null;
}

function isFailedHttpStatus(run) {
    const status = getHttpStatusNumber(run);
    return status !== null && status >= 400;
}

function getHttpStatusText(run) {
    const status = getHttpStatusNumber(run);
    return status === null ? "-" : String(status);
}

function getHttpStatusLabel(run) {
    const status = getHttpStatusNumber(run);
    return status === null ? "" : `状态码 ${status}`;
}

function getRunFailedStage(run) {
    return run?.abnormal_detail?.failed_stage || null;
}

function getRunCompletionReason(run) {
    const value = run?.abnormal_detail?.completion_reason ?? run?.response_finish_reason;
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getRunCompletionReasonLabel(run) {
    const value = getRunCompletionReason(run);
    if (!value) {
        return "-";
    }

    return COMPLETION_REASON_LABELS[value] || value;
}

// 和 shared/run-analysis.js 里的 hasRecordedOutput 必须同口径：
// 正文长度说了算，字节数只是老记录没有正文长度时的退路。
function hasRunRecordedOutput(run) {
    if (typeof run?.output_chars === "number" && Number.isFinite(run.output_chars)) {
        return run.output_chars > 0;
    }

    const outputBytes = Number(run?.output_bytes);
    return Number.isFinite(outputBytes) && outputBytes > 0;
}

function hasRunFirstOutputSignal(run) {
    return Boolean(run?.phases?.first_chunk_received)
        || (typeof run?.metrics?.ttft_ms === "number" && Number.isFinite(run.metrics.ttft_ms));
}

function isRunContextLikelyHeavy(run) {
    const promptChars = Number(run?.prompt_chars);
    const messageCount = Number(run?.message_count);
    return (Number.isFinite(promptChars) && promptChars >= 32000)
        || (Number.isFinite(messageCount) && messageCount >= 80);
}

function getRunContextPressureText(run) {
    const promptChars = Number(run?.prompt_chars);
    const messageCount = Number(run?.message_count);
    const charsHeavy = Number.isFinite(promptChars) && promptChars >= 32000;
    const messagesHeavy = Number.isFinite(messageCount) && messageCount >= 80;

    if (charsHeavy && messagesHeavy) {
        return "字符数和消息数都偏高";
    }

    if (charsHeavy) {
        return "请求体字符偏高";
    }

    if (messagesHeavy) {
        return "消息数偏高";
    }

    return "未见明显偏高";
}

function getRunFirstOutputEvidenceText(run) {
    if (run?.stream) {
        return hasRunFirstOutputSignal(run) ? "已拿到首输出" : "未拿到首输出";
    }

    return hasRunRecordedOutput(run) ? "已返回正文" : "未返回正文";
}

function getRunOutputEvidenceText(run) {
    return hasRunRecordedOutput(run) ? "已收到正文内容" : "未收到正文内容";
}

// 拿不到 token 的成因，对应 describeUsageCaptureMode 写在记录上的标记。
// response_body 故意不列：非流式的用量本来就在响应体里，拿不到是真异常，
// 给它配一句"正常解释"反而会盖住问题。
//
// injected 这一条要给出路，不能只陈述事实：它是三种里最常撞上的，而且真的有解。
// 酒馆自己从不索要用量（整个 src/ 和 public/ 里搜不到 include_usage），所以流式
// 全靠这个注入；非流式则直接从响应体里读，不依赖任何注入。服务器上的记录印证了
// 这个出路——同一个中转，假流式线路流式 0/27 拿到用量，非流式 338/338 全拿到。
//
// 这三种成因只属于精简版：注入本身就只在精简形态下做，见 isUsageInjectionCandidate。
const USAGE_UNAVAILABLE_NOTES = {
    // 原文案写的是"酒馆不向前端透传这个接入源的用量"，不准确：酒馆对所有接入源都用
    // forwardFetchResponse 原样转发上游的流。真正的原因是 custom_include_body 只在
    // 自定义源的分支里被合并（chat-completions.js:2304-2319、openai.js:37-40），
    // 别的接入源根本没有可注入的口子。
    source_no_passthrough: "只有「自定义」接入源能注入要用量的参数，改用自定义接口可解",
    skipped_user_params: "你填了附加参数，插件没敢注入，以免弄坏你的配置",
    injected: "中转收下了要用量的参数却不回用量，假流式线路常见；关掉流式多半能拿到",
};

// 精简版会把成因算在记录上——它真的注入过要用量的参数，所以能说清是三种里的哪一种。
// 完整版从不注入（isUsageInjectionCandidate 第一关就要求是精简形态），成因因此只有一种，
// 而且和接入源无关：没人向上游要过用量，能不能拿到全看这条线路自己回不回。
//
// 非流式一律不给解释：那时用量直接在响应体里，拿不到是真异常，配一句"正常解释"会盖住问题。
// 精简版的老记录没有 usage_capture 标记，但带着 record_source，不会被错当成完整版记录，
// 于是退回原来的措辞，不硬编解释。
function getUsageUnavailableNote(run) {
    if (run?.usage_capture) {
        return USAGE_UNAVAILABLE_NOTES[run.usage_capture] || "";
    }

    if (run?.record_source !== "frontend" && run?.stream) {
        return "完整版不向上游索要用量，拿不拿得到全看这条线路自己；非流式则直接从响应体里读";
    }

    return "";
}

function getRunUsageEvidenceText(run, abnormalBilling, usageAvailable) {
    if (abnormalBilling?.hasUsageTokens || usageAvailable) {
        return "已拿到 usage";
    }

    const unavailableNote = getUsageUnavailableNote(run);
    if (unavailableNote) {
        return `未拿到 usage：${unavailableNote}`;
    }

    return isAbnormalRun(run) ? "未拿到 usage" : "-";
}

function getRunFailureEvidenceSummary(run, abnormalType, failedStage, abnormalBilling, usageAvailable) {
    if (!abnormalType) {
        return "未见异常";
    }

    const hasUsageEvidence = Boolean(abnormalBilling?.hasUsageTokens || usageAvailable);
    const contextHeavy = isRunContextLikelyHeavy(run);
    const completionReasonLabel = getRunCompletionReasonLabel(run);
    const hasCompletionReason = completionReasonLabel !== "-";

    // 这两类的成因在酒馆源码里是确定的（socket 关闭直接触发 abort），不必用"更像"这种推测口吻。
    if (abnormalType === "client_stopped") {
        return "你自己中止了这次生成";
    }

    if (abnormalType === "client_disconnected") {
        return hasUsageEvidence ? "浏览器和酒馆之间断开了连接，且已发生计费" : "浏览器和酒馆之间断开了连接";
    }

    // 成因说不准，但事实是确定的：状态码正常、没有任何报错，正文却一个字都没有。
    // 所以这里用陈述句，不用"更像"，也不往下猜是谁的问题。
    if (abnormalType === "empty_response") {
        return hasUsageEvidence ? "接口正常返回，但没有任何正文，且已发生计费" : "接口正常返回，但没有任何正文";
    }

    if (abnormalType === "request_timeout") {
        return contextHeavy ? "更像请求超时，且上下文偏重" : "更像请求超时";
    }

    if (abnormalType === "stream_interrupted") {
        return hasUsageEvidence ? "更像回传中断，且已发生计费" : "更像回传中断";
    }

    if (abnormalType === "failed_without_output") {
        if (hasCompletionReason) {
            return `更像未出正文即结束（${completionReasonLabel}）`;
        }
        return failedStage === "before_first_output" ? "更像首输出前失败" : "更像未出正文即失败";
    }

    if (abnormalType === "failed_after_partial_output") {
        return hasUsageEvidence ? "更像出正文后中断，且已发生计费" : "更像出正文后中断";
    }

    if (abnormalType === "suspected_incomplete_generation") {
        return hasCompletionReason ? `更像生成提前结束（${completionReasonLabel}）` : "更像生成提前结束";
    }

    if (abnormalType === "failed_generation") {
        return failedStage ? `更像卡在${getFailedStageLabel(failedStage)}` : "更像完整生成失败";
    }

    return "异常原因待确认";
}

function maskOutputCardChatTitle(value) {
    if (typeof value !== "string" || !value.trim()) {
        return "";
    }

    return Array.from(value).map((char) => (/\s/.test(char) ? char : "□")).join("");
}

function getPromptRoleLabel(role) {
    const key = typeof role === "string" && role.trim() ? role.trim() : "unknown";
    return PROMPT_ROLE_LABELS[key] || key;
}

function getRunPromptBreakdown(run) {
    const runId = run?.id;
    if (run?.prompt_breakdown) {
        return run.prompt_breakdown;
    }
    return runId ? (state.promptBreakdownByRunId[runId] ?? null) : null;
}

function isPromptBreakdownLoading(runId) {
    return Boolean(runId) && state.promptBreakdownLoadingRunIds.has(runId);
}

function hasLoadedPromptBreakdown(runId) {
    return Boolean(runId) && Object.prototype.hasOwnProperty.call(state.promptBreakdownByRunId, runId);
}

function cachePromptBreakdown(runId, breakdown) {
    if (!runId) {
        return;
    }

    const cache = state.promptBreakdownByRunId;
    if (!Object.prototype.hasOwnProperty.call(cache, runId)) {
        const cachedIds = Object.keys(cache);
        if (cachedIds.length >= PROMPT_VOLUME_CACHE_LIMIT) {
            delete cache[cachedIds[0]];
        }
    }
    cache[runId] = breakdown ?? null;
}

// 后端不再落盘 top_messages / recent_messages，这里从 message_sizes 现算，结果与旧字段一致。
function buildPromptVolumeInsight(breakdown) {
    if (!breakdown || typeof breakdown !== "object") {
        return null;
    }

    const totalChars = Number(breakdown.total_chars) || 0;
    const totalMessages = Number(breakdown.total_messages) || 0;
    const messageSizes = Array.isArray(breakdown.message_sizes) ? breakdown.message_sizes : [];
    const rawRoleTotals = breakdown.role_totals && typeof breakdown.role_totals === "object"
        ? breakdown.role_totals
        : {};

    const roleRows = Object.entries(rawRoleTotals)
        .map(([role, stat]) => ({
            role,
            label: getPromptRoleLabel(role),
            count: Number(stat?.count) || 0,
            chars: Number(stat?.chars) || 0,
            share: totalChars ? ((Number(stat?.chars) || 0) / totalChars) * 100 : 0,
        }))
        .sort((left, right) => right.chars - left.chars);

    const topMessages = [...messageSizes]
        .sort((left, right) => (Number(right?.chars) || 0) - (Number(left?.chars) || 0))
        .slice(0, PROMPT_VOLUME_TOP_MESSAGE_COUNT)
        .map((message) => ({
            index: Number(message?.index) || 0,
            label: getPromptRoleLabel(message?.role),
            chars: Number(message?.chars) || 0,
            share: totalChars ? ((Number(message?.chars) || 0) / totalChars) * 100 : 0,
        }));

    const largestMessage = topMessages[0] ?? null;
    const dominantRole = roleRows[0] ?? null;
    const historyChars = roleRows
        .filter((row) => row.role === "user" || row.role === "assistant")
        .reduce((sum, row) => sum + row.chars, 0);
    const historyShare = totalChars ? (historyChars / totalChars) * 100 : 0;

    let conclusion;
    if (!totalChars) {
        conclusion = "这条记录没有拿到可用的提示词体积数据。";
    } else if (largestMessage && largestMessage.share >= PROMPT_VOLUME_SINGLE_MESSAGE_DOMINANT_RATIO * 100) {
        conclusion = `单条消息偏大：第 ${largestMessage.index + 1} 条（${largestMessage.label}）就占了提示词的 ${formatPercent(largestMessage.share)}，优先检查这一条。`;
    } else if (dominantRole?.role === "system" && dominantRole.share >= PROMPT_VOLUME_ROLE_DOMINANT_RATIO * 100) {
        conclusion = `系统提示词占大头：${formatPercent(dominantRole.share)} 的提示词体积来自系统提示，先精简预设和世界书。`;
    } else if (historyShare >= PROMPT_VOLUME_HISTORY_DOMINANT_RATIO * 100 && totalMessages >= PROMPT_VOLUME_HISTORY_MESSAGE_THRESHOLD) {
        conclusion = `历史对话累积偏长：${totalMessages} 条消息里的对话正文占 ${formatPercent(historyShare)}，考虑压缩上下文或开总结。`;
    } else {
        conclusion = `体积分布相对均衡，暂时没有明显的单点拖累（共 ${totalMessages} 条消息、${formatCount(totalChars)} 字符）。`;
    }

    const compositionText = roleRows.length
        ? roleRows.map((row) => `${row.label} ${formatCount(row.chars)} 字符（${formatPercent(row.share)}）`).join("，")
        : "-";

    return {
        totalChars,
        totalMessages,
        roleRows,
        topMessages,
        largestMessage,
        historyShare,
        conclusion,
        compositionText,
    };
}

function buildPromptVolumeRows(insight) {
    if (!insight) {
        return [];
    }

    // 这里是纯正文字符（collectContentStats 累加原始字符串长度），
    // 和排障卡的「请求体字符」不是一个数：后者是 JSON.stringify 的长度，含结构和转义，实测多 4% 左右。
    const rows = [
        { label: "消息总数", value: formatCount(insight.totalMessages) },
        { label: "正文字符", value: formatCount(insight.totalChars) },
    ];

    for (const row of insight.roleRows) {
        rows.push({
            label: row.label,
            value: `${formatCount(row.count)} 条 · ${formatCount(row.chars)} 字符（${formatPercent(row.share)}）`,
            full: true,
        });
    }

    if (insight.largestMessage) {
        rows.push({
            label: "最大单条",
            value: `第 ${insight.largestMessage.index + 1} 条 · ${insight.largestMessage.label} · ${formatCount(insight.largestMessage.chars)} 字符（${formatPercent(insight.largestMessage.share)}）`,
            full: true,
        });
    }

    return rows;
}

function renderPromptVolumeSection(run) {
    const runId = run?.id;
    const insight = buildPromptVolumeInsight(getRunPromptBreakdown(run));

    if (insight) {
        return renderHistoryDetailSection("提示词体积分布", buildPromptVolumeRows(insight), insight.conclusion);
    }

    if (isPromptBreakdownLoading(runId)) {
        return renderHistoryDetailSection("提示词体积分布", [], "正在读取这条记录的提示词体积明细...");
    }

    if (hasLoadedPromptBreakdown(runId)) {
        return renderHistoryDetailSection("提示词体积分布", [], "这条记录没有提示词体积明细，可能是更早版本写入的记录。");
    }

    return "";
}

function buildOutputCardSectionData(snapshot, fields) {
    return {
        coreRows: [
            { label: "开始", value: snapshot.startedAt },
            { label: "聊天窗", value: snapshot.chatName || "-" },
            { label: "楼层", value: snapshot.floorLabel || "-" },
            { label: "来源", value: snapshot.sourceLabel },
            { label: "状态码", value: snapshot.httpStatusText },
            { label: "记录", value: snapshot.shortRunIdText },
        ],
        evidenceRows: [
            { label: "首输出信号", value: snapshot.firstOutputEvidenceText },
            { label: "正文证据", value: snapshot.outputEvidenceText },
            { label: "usage信号", value: snapshot.usageEvidenceText },
            { label: "结束原因", value: snapshot.completionReasonText },
            { label: "上下文压力", value: snapshot.contextPressureText },
            { label: "判断结论", value: snapshot.failureEvidenceSummaryText, full: true },
        ],
        diagnosisRows: [
            { label: "异常", value: snapshot.abnormalTypeLabel },
            { label: "阶段", value: snapshot.failedStageLabel },
            { label: "流式", value: snapshot.streamText },
            { label: "部分输出", value: snapshot.hasPartialOutputText },
            { label: "总耗时", value: snapshot.totalMsText },
            { label: "预处理", value: snapshot.preprocessMsText },
            { label: "首个输出", value: snapshot.ttftMsText },
            { label: "消息数", value: snapshot.messageCountText },
            { label: "请求体字符", value: snapshot.promptCharsText },
            { label: "Prompt", value: snapshot.promptTokensText },
            { label: "Completion", value: snapshot.completionTokensText },
            { label: "Total", value: snapshot.totalTokensText },
        ],
        injectionRows: [
            { label: "注入痕迹", value: snapshot.injectionTraceText },
            { label: "拓展", value: snapshot.pluginLabel },
        ],
        injectionDetailRows: fields.showInjectionDetails ? [
            { label: "来源名称", value: snapshot.injectionSourceLabel },
            { label: "来源标识", value: snapshot.injectionSourceId },
            { label: "提示词来源", value: snapshot.traceLabelsText, full: true },
        ] : [],
        extensionRows: fields.showExtensionDetails ? [
            { label: "拓展标识", value: snapshot.pluginIdText, full: true },
            { label: "识别方式", value: snapshot.pluginMatchModeLabel },
            { label: "识别分数", value: snapshot.pluginMatchScoreText },
        ] : [],
        pricingRows: fields.showPricingDetails ? [
            { label: "计费状态", value: snapshot.billingStatusText },
            { label: "命中缓存", value: snapshot.cacheHitText },
            { label: "缓存 Tokens", value: snapshot.cachedTokensText },
            { label: "缓存读取", value: snapshot.cacheReadTokensText },
            { label: "预估价格", value: snapshot.estimatedPriceText },
        ] : [],
        promptVolumeRows: fields.showPromptVolume && snapshot.promptVolume
            ? buildPromptVolumeRows(snapshot.promptVolume)
            : [],
    };
}

const HISTORY_RUN_DETAIL_FIELDS = Object.freeze({
    showInjectionDetails: true,
    showPricingDetails: true,
    showContextVolume: true,
    showPromptVolume: true,
    showExtensionDetails: true,
    maskChatTitle: false,
});

function getOutputCardRowClass(row) {
    if (!row || typeof row.label !== "string") {
        return "";
    }

    if (row.label === "聊天窗") {
        return " stlp-output-card-row-chat";
    }

    if (row.label === "来源") {
        return " stlp-output-card-row-source";
    }

    return "";
}

function renderOutputCardRows(rows) {
    return (rows || [])
        .filter((row) => row && row.value !== "")
        .map((row) => `
            <div class="stlp-output-card-row${row.full ? " stlp-output-card-row-full" : ""}${getOutputCardRowClass(row)}">
                <div class="stlp-output-card-label">${escapeHtml(row.label)}</div>
                <div class="stlp-output-card-value">${escapeHtml(row.value)}</div>
            </div>
        `)
        .join("");
}

function renderOutputCardSection(title, rows, note = "", rowsClass = "") {
    const rowsHtml = renderOutputCardRows(rows);
    if (!rowsHtml && !note) {
        return "";
    }

    return `
        <section class="stlp-output-card-section">
            ${title ? `<div class="stlp-output-card-section-title">${escapeHtml(title)}</div>` : ""}
            ${rowsHtml ? `<div class="stlp-output-card-rows${rowsClass ? ` ${rowsClass}` : ""}">${rowsHtml}</div>` : ""}
            ${note ? `<div class="stlp-output-card-note">${escapeHtml(note)}</div>` : ""}
        </section>
    `;
}

// 快照里拿不到的值统一填成 "-"，所以判断某一行有没有实质内容不能只看真假。
function hasDetailValue(value) {
    if (typeof value !== "string") {
        return value !== null && value !== undefined;
    }
    const trimmed = value.trim();
    return Boolean(trimmed) && trimmed !== "-";
}

function renderHistoryDetailRows(rows) {
    return (rows || [])
        .filter((row) => row && row.value !== "")
        .map((row) => `
            <div class="stlp-history-detail-row${row.full ? " stlp-history-detail-row-full" : ""}">
                <div class="stlp-history-detail-label">${escapeHtml(row.label)}</div>
                <div class="stlp-history-detail-value">${escapeHtml(row.value)}</div>
            </div>
        `)
        .join("");
}

function renderHistoryDetailSection(title, rows, note = "", rowsClass = "") {
    const rowsHtml = renderHistoryDetailRows(rows);
    if (!rowsHtml && !note) {
        return "";
    }

    return `
        <section class="stlp-history-detail-section">
            ${title ? `<div class="stlp-history-detail-section-title">${escapeHtml(title)}</div>` : ""}
            ${rowsHtml ? `<div class="stlp-history-detail-rows${rowsClass ? ` ${rowsClass}` : ""}">${rowsHtml}</div>` : ""}
            ${note ? `<div class="stlp-history-detail-note">${escapeHtml(note)}</div>` : ""}
        </section>
    `;
}

function getOutputCardPrimaryTitle(run, chatName = "") {
    return getRunFloorLabel(run)
        || chatName
        || (typeof run?.model === "string" && run.model.trim())
        || "排障输出卡";
}

function getOutputCardSnapshot(run, fieldsOverride = null) {
    if (!run || typeof run !== "object") {
        return null;
    }

    const fields = fieldsOverride || getOutputCardFields();
    const abnormalDetail = run?.abnormal_detail ?? null;
    const abnormalBilling = getRunAbnormalBilling(run);
    const usage = getRunUsage(run);
    const usageAvailable = hasRunUsage(run);
    const estimatedPrice = getRunEstimatedPrice(run);
    const failedStage = getRunFailedStage(run);
    const abnormalType = abnormalDetail?.abnormal_type || null;
    const rawChatName = getRunDisplayChatName(run);
    const chatName = fields.maskChatTitle ? maskOutputCardChatTitle(rawChatName) : rawChatName;
    const traceItems = getRunPromptTraceItems(run);
    const traceLabelsText = traceItems.length ? traceItems.map((item) => item.label).join(" / ") : "-";
    const traceKeysText = traceItems.length ? traceItems.map((item) => item.key).join(" / ") : "-";
    const injectionSourceLabel = getRunInjectionSourceLabel(run);
    const injectionSourceId = getRunInjectionSourceId(run);
    const injectionTraceLabels = getRunInjectionTraceLabels(run);
    const injectionTraceText = injectionTraceLabels.length ? injectionTraceLabels.join(" / ") : "未发现";
    const pluginMatchScore = Number.isFinite(Number(run?.request_plugin_match_score))
        ? String(Number(run.request_plugin_match_score))
        : "-";

    const promptVolume = buildPromptVolumeInsight(getRunPromptBreakdown(run));

    return {
        promptVolume,
        promptVolumeConclusionText: promptVolume?.conclusion || "-",
        promptVolumeCompositionText: promptVolume?.compositionText || "-",
        title: getOutputCardPrimaryTitle(run, chatName),
        summaryLabel: isAbnormalRun(run) ? getAbnormalTypeLabel(abnormalType) : "正常完成",
        requestPurposeLabel: getRequestPurposeLabel(run?.request_purpose),
        sourceLabel: getRunSourceLabel(run),
        pluginLabel: getRunPluginLabel(run),
        pluginIdText: run?.request_plugin || "-",
        pluginMatchModeLabel: getRequestPluginMatchModeLabel(run?.request_plugin_match_mode),
        pluginMatchScoreText: pluginMatchScore,
        floorLabel: getRunFloorLabel(run),
        chatName,
        startedAt: formatStartedAtPlain(run?.started_at_iso),
        streamText: formatBoolean(Boolean(run?.stream)),
        httpStatusText: getHttpStatusText(run),
        abnormalTypeLabel: abnormalType ? getAbnormalTypeLabel(abnormalType) : "-",
        failedStageLabel: failedStage ? getFailedStageLabel(failedStage) : "-",
        hasPartialOutputText: abnormalDetail ? formatBoolean(Boolean(abnormalDetail.has_partial_output)) : "-",
        billingStatusText: abnormalBilling?.label || (usageAvailable || estimatedPrice ? "已完成" : "费用未确认"),
        firstOutputEvidenceText: getRunFirstOutputEvidenceText(run),
        outputEvidenceText: getRunOutputEvidenceText(run),
        usageEvidenceText: getRunUsageEvidenceText(run, abnormalBilling, usageAvailable),
        completionReasonText: getRunCompletionReasonLabel(run),
        contextPressureText: getRunContextPressureText(run),
        failureEvidenceSummaryText: getRunFailureEvidenceSummary(run, abnormalType, failedStage, abnormalBilling, usageAvailable),
        totalMsText: formatSeconds(run?.metrics?.total_ms),
        preprocessMsText: formatSeconds(run?.metrics?.preprocess_ms),
        upstreamHeadersMsText: formatSeconds(run?.metrics?.upstream_headers_ms),
        ttftMsText: formatSeconds(run?.metrics?.ttft_ms),
        streamMsText: formatSeconds(run?.metrics?.stream_ms),
        messageCountText: formatPlainValue(run?.message_count),
        promptCharsText: formatPlainValue(run?.prompt_chars),
        promptTokensText: formatPlainValue(usage.promptTokens),
        completionTokensText: formatPlainValue(usage.completionTokens),
        totalTokensText: formatPlainValue(usage.totalTokens),
        cacheHitText: usageAvailable ? formatBoolean(Boolean(usage.cacheHit)) : "-",
        cachedTokensText: formatPlainValue(usage.cachedTokens),
        cacheReadTokensText: formatPlainValue(usage.cacheReadTokens),
        injectionTraceText,
        injectionSourceLabel: injectionSourceLabel || "-",
        injectionSourceId: injectionSourceId || "-",
        traceLabelsText,
        traceKeysText,
        estimatedPriceText: estimatedPrice ? formatPriceWithCurrency(estimatedPrice.totalCost, estimatedPrice.currency) : "-",
        estimatedPriceNote: estimatedPrice
            ? estimatedPrice.note
            // 拿不到 token 时要替用户否掉"是不是我价格配错了"这个猜测——他配了价格、
            // 看到空的，第一反应必然是怀疑自己，而成因其实写在上面那行 usage 信号里。
            : (usageAvailable
                ? "未配置该模型价格，暂不显示金额估算"
                : "没拿到 token 数，价格无从计算——不是你的价格没配对，成因见上方 usage 信号"),
        runIdText: run?.id || "-",
        shortRunIdText: shortenRunId(run?.id) || "-",
        modelText: run?.model || "-",
    };
}

function buildOutputCardText(run) {
    const snapshot = getOutputCardSnapshot(run);
    const fields = getOutputCardFields();
    if (!snapshot) {
        return "";
    }

    return [
        `鱼缸后端监控排障卡`,
        `标题：${snapshot.title}`,
        `状态：${snapshot.summaryLabel}`,
        `用途：${snapshot.requestPurposeLabel}`,
        `模型：${snapshot.modelText}`,
        `来源：${snapshot.sourceLabel}`,
        `聊天窗：${snapshot.chatName}`,
        `楼层：${snapshot.floorLabel}`,
        `开始时间：${snapshot.startedAt}`,
        `记录编号：${snapshot.shortRunIdText}`,
        `状态码：${snapshot.httpStatusText}`,
        `流式生成：${snapshot.streamText}`,
        `异常类型：${snapshot.abnormalTypeLabel}`,
        `首输出信号：${snapshot.firstOutputEvidenceText}`,
        `正文证据：${snapshot.outputEvidenceText}`,
        `usage 信号：${snapshot.usageEvidenceText}`,
        `上下文压力：${snapshot.contextPressureText}`,
        `判断结论：${snapshot.failureEvidenceSummaryText}`,
        `卡住阶段：${snapshot.failedStageLabel}`,
        `总耗时：${snapshot.totalMsText}`,
        `预处理：${snapshot.preprocessMsText}`,
        `首个输出：${snapshot.ttftMsText}`,
        `Prompt Tokens：${snapshot.promptTokensText}`,
        `Completion Tokens：${snapshot.completionTokensText}`,
        `Total Tokens：${snapshot.totalTokensText}`,
        `注入痕迹：${snapshot.injectionTraceText}`,
        `拓展名称：${snapshot.pluginLabel}`,
        fields.showContextVolume ? `消息数：${snapshot.messageCountText}` : "",
        fields.showContextVolume ? `请求体字符数：${snapshot.promptCharsText}` : "",
        fields.showPromptVolume ? `提示词体积结论：${snapshot.promptVolumeConclusionText}` : "",
        fields.showPromptVolume ? `提示词体积构成：${snapshot.promptVolumeCompositionText}` : "",
        fields.showInjectionDetails ? `注入来源名称：${snapshot.injectionSourceLabel}` : "",
        fields.showInjectionDetails ? `注入来源标识：${snapshot.injectionSourceId}` : "",
        fields.showInjectionDetails ? `提示词来源：${snapshot.traceLabelsText}` : "",
        fields.showExtensionDetails ? `拓展标识：${snapshot.pluginIdText}` : "",
        fields.showExtensionDetails ? `识别方式：${snapshot.pluginMatchModeLabel}` : "",
        fields.showExtensionDetails ? `识别分数：${snapshot.pluginMatchScoreText}` : "",
        fields.showPricingDetails ? `计费状态：${snapshot.billingStatusText}` : "",
        fields.showPricingDetails ? `命中缓存：${snapshot.cacheHitText}` : "",
        fields.showPricingDetails ? `缓存 Tokens：${snapshot.cachedTokensText}` : "",
        fields.showPricingDetails ? `缓存读取 Tokens：${snapshot.cacheReadTokensText}` : "",
        fields.showPricingDetails ? `预估价格：${snapshot.estimatedPriceText}` : "",
        fields.showPricingDetails ? `估算说明：${snapshot.estimatedPriceNote}` : "",
    ].filter(Boolean).join("\n");
}

async function copyTextToClipboard(text) {
    const nextText = typeof text === "string" ? text : "";
    if (!nextText) {
        return false;
    }

    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(nextText);
            return true;
        }
    } catch {
        // Fall through to the textarea fallback.
    }

    const textarea = document.createElement("textarea");
    textarea.value = nextText;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
        const copied = document.execCommand("copy");
        document.body.removeChild(textarea);
        return copied;
    } catch {
        document.body.removeChild(textarea);
        return false;
    }
}

function openOutputCardDialog(runId, host = "page") {
    const run = findRunById(runId);
    if (!run) {
        openMessageDialog("排障输出卡", "没有找到这条记录，可能是当前列表已经刷新。");
        return;
    }

    state.confirmDialog = {
        type: "output-card",
        runId,
        host: host === "history" ? "history" : "page",
    };
    safeRenderPage();
}

function readCurrentChatWindowName() {
    const primarySelectors = [
        "#chat_header_char_name",
        "#rm_button_selected_ch .ch_name",
        "#rm_button_selected_ch .name_text",
        "#rm_button_selected_ch",
        ".chat_header .name_text",
    ];

    for (const selector of primarySelectors) {
        const node = document.querySelector(selector);
        if (!(node instanceof HTMLElement)) {
            continue;
        }

        const text = node.textContent?.replace(/\s+/g, " ").trim() || "";
        if (text) {
            return text;
        }
    }

    const fallbackSelectors = [
        ".character_name_block .ch_name",
        ".group_name",
    ];

    for (const selector of fallbackSelectors) {
        const texts = Array.from(document.querySelectorAll(selector))
            .map((node) => (node instanceof HTMLElement ? node.textContent?.replace(/\s+/g, " ").trim() || "" : ""))
            .filter(Boolean);

        if (texts.length === 1) {
            return texts[0];
        }
    }

    return "";
}

function getSillyTavernContext() {
    const candidates = [
        typeof getContext === "function" ? getContext : null,
        typeof window.getContext === "function" ? window.getContext : null,
        typeof window.SillyTavern?.getContext === "function" ? window.SillyTavern.getContext : null,
    ];

    for (const candidate of candidates) {
        if (typeof candidate !== "function") {
            continue;
        }

        try {
            const context = candidate();
            if (context && typeof context === "object") {
                return context;
            }
        } catch {
            continue;
        }
    }

    return null;
}

function normalizeChatIdentityPart(value) {
    return typeof value === "string" && value.trim()
        ? value.trim()
        : "";
}

function readCurrentChatIdentity() {
    const context = getSillyTavernContext();
    const chatIdHash = normalizeChatIdentityPart(context?.chatMetadata?.chat_id_hash != null ? String(context.chatMetadata.chat_id_hash) : "");
    const chatId = normalizeChatIdentityPart(context?.chatId != null ? String(context.chatId) : "");
    const chatName = readCurrentChatWindowName();
    const chatKey = chatIdHash
        ? `hash:${chatIdHash}`
        : (chatId ? `id:${chatId}` : "");

    return {
        chatKey,
        chatId,
        chatIdHash,
        chatName,
    };
}

// 楼层只存在于 ST 前端的聊天数组里，代理侧看不到，所以必须在发起生成的那一刻就地读取。
// 返回值是"这次生成产出的消息最终会落在哪个下标"，与 .mesIDDisplay 显示的 #N 同口径（0 基）。
function readCurrentGenerationFloor() {
    const chat = getSillyTavernContext()?.chat;
    if (!Array.isArray(chat) || !chat.length) {
        return null;
    }

    // 新回复追加在末尾；重roll/swipe 时末尾已经是待替换的 AI 消息，楼层要往回退一格。
    const lastMessage = chat[chat.length - 1];
    const isRegeneration = Boolean(lastMessage && typeof lastMessage === "object" && !lastMessage.is_user);
    return isRegeneration ? chat.length - 1 : chat.length;
}

function detectChatWindowContext() {
    const identity = readCurrentChatIdentity();
    const chatName = identity.chatName;
    const visibleFloorLabels = chatName ? readVisibleFloorLabels() : [];
    return {
        chatKey: identity.chatKey,
        chatName,
        isHome: !chatName,
        detectedAt: Date.now(),
        visibleFloorLabels,
        latestFloorLabel: visibleFloorLabels[0] || "",
    };
}

function refreshChatWindowContext() {
    const nextContext = detectChatWindowContext();
    state.chatWindowContext = nextContext;
    return nextContext;
}

function getTrackedCurrentChatWindowName() {
    return typeof state.chatWindowContext?.chatName === "string"
        ? state.chatWindowContext.chatName
        : "";
}

function getTrackedCurrentChatKey() {
    return typeof state.chatWindowContext?.chatKey === "string"
        ? state.chatWindowContext.chatKey
        : "";
}

function getTrackedVisibleFloorLabels() {
    return Array.isArray(state.chatWindowContext?.visibleFloorLabels)
        ? state.chatWindowContext.visibleFloorLabels.filter((value) => typeof value === "string" && value)
        : [];
}

function readVisibleFloorLabels() {
    const selector = ".mes .mesIDDisplay, .mes_block .mesIDDisplay, .mesIDDisplay";
    const nodes = Array.from(document.querySelectorAll(selector));
    const parsed = nodes
        .map((node) => {
            if (!(node instanceof HTMLElement)) {
                return null;
            }

            const text = node.textContent?.trim() || "";
            const matched = text.match(/#\d+/);
            if (!matched) {
                return null;
            }

            const messageRoot = node.closest(".mes, .mes_block, .message");
            const isUserMessage = Boolean(messageRoot?.matches?.(".is_user, .user_mes, [is_user='true'], [data-is-user='true']"));

            return {
                floorLabel: matched[0],
                isUserMessage,
            };
        })
        .filter(Boolean);

    const assistantFloors = parsed.filter((item) => !item.isUserMessage).map((item) => item.floorLabel);
    const fallbackFloors = parsed.map((item) => item.floorLabel);
    const floors = assistantFloors.length ? assistantFloors : fallbackFloors;

    return [...floors].reverse();
}

function getMessageAvatarReferenceKeys(root) {
    if (!(root instanceof HTMLElement)) {
        return [];
    }

    const isUser = root.getAttribute("is_user") === "true";
    const chatName = (root.getAttribute("ch_name") || "").trim();
    const roleKey = isUser ? "user" : "char";
    const keys = [`${roleKey}:${chatName}`, roleKey];
    return [...new Set(keys.filter(Boolean))];
}

// 写之前先确认真的有东西要清。无条件写会改动 style 属性，而 style 在观察列表里——
// 那就是这个函数自己把自己的下一轮重扫排上队。
function clearInlineHiddenState(node) {
    for (const property of ["display", "visibility", "opacity"]) {
        if (node.style.getPropertyValue(property)) {
            node.style.removeProperty(property);
        }
    }

    if (node.hasAttribute("hidden")) {
        node.removeAttribute("hidden");
    }
}

function normalizeChatMessageUi() {
    const messageRoots = document.querySelectorAll(".mes, .mes_block, .message");
    const avatarReferences = new Map();

    for (const root of messageRoots) {
        if (!(root instanceof HTMLElement)) {
            continue;
        }

        const avatarImage = root.querySelector(".avatar img, .mesAvatar img");
        if (!(avatarImage instanceof HTMLImageElement)) {
            continue;
        }

        const avatarSrc = avatarImage.currentSrc || avatarImage.getAttribute("src") || "";
        if (!avatarSrc) {
            continue;
        }

        for (const key of getMessageAvatarReferenceKeys(root)) {
            if (!avatarReferences.has(key)) {
                avatarReferences.set(key, avatarSrc);
            }
        }
    }

    for (const root of messageRoots) {
        if (!(root instanceof HTMLElement)) {
            continue;
        }

        const floorNode = root.querySelector(".mesIDDisplay");
        if (floorNode instanceof HTMLElement) {
            const floorMatch = (floorNode.textContent || "").match(/#\d+/);
            if (floorMatch && floorNode.textContent !== floorMatch[0]) {
                floorNode.textContent = floorMatch[0];
            }
        }

        // .mes_timer 和 .tokenCounterDisplay 不在这里处理：style.css 顶部已经把它们
        // display: none 掉了。别再加回逐帧擦文本的逻辑——酒馆每收到一块就往 .mes_timer 写一次，
        // 擦除本身又是一次被观察的变动，两边对着写能把全量重扫一直推下去。

        const avatarHost = root.querySelector(".avatar, .mesAvatar");
        const missingAvatar = avatarHost?.querySelector(".missing-avatar");
        if (avatarHost instanceof HTMLElement && missingAvatar instanceof HTMLElement) {
            const avatarSrc = getMessageAvatarReferenceKeys(root)
                .map((key) => avatarReferences.get(key) || "")
                .find(Boolean);

            if (avatarSrc) {
                avatarHost.innerHTML = "";
                const avatarImage = document.createElement("img");
                avatarImage.src = avatarSrc;
                avatarImage.alt = root.getAttribute("ch_name") || "avatar";
                avatarHost.appendChild(avatarImage);
            }
        }

        const avatarImages = root.querySelectorAll(".avatar img, .mesAvatar img");
        for (const avatarImage of avatarImages) {
            if (!(avatarImage instanceof HTMLImageElement)) {
                continue;
            }

            if (avatarImage.naturalWidth > 0) {
                const avatarContainers = [
                    avatarImage.parentElement,
                    avatarImage.closest(".avatar"),
                    avatarImage.closest(".mesAvatar"),
                    avatarImage.closest(".avatar_holder"),
                    avatarImage.closest(".mesAvatarWrapper"),
                ].filter((node) => node instanceof HTMLElement);

                clearInlineHiddenState(avatarImage);

                for (const container of avatarContainers) {
                    clearInlineHiddenState(container);
                }

                const placeholder = avatarImage.parentElement?.querySelector(".missing-avatar");
                if (placeholder instanceof HTMLElement) {
                    placeholder.remove();
                }
            }
        }
    }
}

function runFullChatMessageUiNormalization() {
    state.chatUiLastFullNormalizeAtMs = Date.now();
    runSafely("同步消息区楼层与头像显示", () => {
        normalizeChatMessageUi();
    });
}

function queueDeferredChatMessageUiNormalization(delayMs) {
    if (state.chatUiNormalizeTimerId !== null) {
        return;
    }

    state.chatUiNormalizeTimerId = window.setTimeout(() => {
        state.chatUiNormalizeTimerId = null;
        runFullChatMessageUiNormalization();
    }, Math.max(0, delayMs));
}

function scheduleChatMessageUiNormalization() {
    if (state.chatUiNormalizeScheduled) {
        return;
    }

    state.chatUiNormalizeScheduled = true;
    window.requestAnimationFrame(() => {
        state.chatUiNormalizeScheduled = false;
        const sinceLast = Date.now() - state.chatUiLastFullNormalizeAtMs;
        if (sinceLast < CHAT_UI_FULL_NORMALIZE_MIN_INTERVAL_MS) {
            // 白名单挡住的是已知的高频源，这条兜底防的是没预料到的那些。延后补一次，不能直接丢，
            // 否则被节流掉的那次结构变动就永远不会被规整。
            queueDeferredChatMessageUiNormalization(CHAT_UI_FULL_NORMALIZE_MIN_INTERVAL_MS - sinceLast);
            return;
        }

        runFullChatMessageUiNormalization();
    });
}

function isWatchedChatUiNode(node) {
    return node instanceof HTMLElement
        && (node.matches(CHAT_UI_STRUCTURE_SELECTOR) || Boolean(node.querySelector(CHAT_UI_STRUCTURE_SELECTOR)));
}

function chatMutationNeedsNormalization(mutation) {
    const target = mutation.target;
    const targetElement = target instanceof HTMLElement ? target : target?.parentElement;
    if (!(targetElement instanceof HTMLElement)) {
        return false;
    }

    if (mutation.type === "characterData") {
        // 需要我们改写文本的只有楼层号。正文和计时的文本每块都在变，放进来就等于没做过滤。
        return targetElement.classList.contains("mesIDDisplay");
    }

    if (mutation.type === "attributes") {
        return targetElement.matches(CHAT_UI_ATTRIBUTE_SELECTOR);
    }

    // 楼层号要一起认：往里写文本时如果原来就有文本节点，产生的是 childList 而不是 characterData，
    // 新增的又是文本节点，光看 addedNodes 会漏掉。
    if (targetElement.matches(".avatar, .mesAvatar, .mesIDDisplay")) {
        return true;
    }

    for (const node of mutation.addedNodes) {
        if (isWatchedChatUiNode(node)) {
            return true;
        }
    }

    return false;
}

function supportsMutationObserver() {
    return typeof MutationObserver === "function";
}

function isTrackedMutationObserverInstance(value) {
    return supportsMutationObserver() && value instanceof MutationObserver;
}

function startChatUiObserver() {
    if (isTrackedMutationObserverInstance(state.chatUiObserver)) {
        scheduleChatMessageUiNormalization();
        return;
    }

    if (!supportsMutationObserver()) {
        scheduleChatMessageUiNormalization();
        return;
    }

    const chatRoot = document.querySelector("#chat") || document.body;
    if (!(chatRoot instanceof HTMLElement)) {
        return;
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (chatMutationNeedsNormalization(mutation)) {
                scheduleChatMessageUiNormalization();
                return;
            }
        }
    });

    observer.observe(chatRoot, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["style", "class", "src", "hidden"],
    });

    state.chatUiObserver = observer;
    scheduleChatMessageUiNormalization();
}

function shouldReusePreviousFloorLabel(previousRun, currentRun) {
    const previousMessageCount = Number(previousRun?.message_count);
    const currentMessageCount = Number(currentRun?.message_count);

    return Number.isFinite(previousMessageCount)
        && Number.isFinite(currentMessageCount)
        && previousMessageCount === currentMessageCount;
}

function syncRunFloorMap() {
    if (!hasLegacyUnkeyedChatRuns(state.runs)) {
        return;
    }

    const visibleFloorLabels = readVisibleFloorLabels();
    if (!visibleFloorLabels.length) {
        return;
    }

    const currentChatName = getTrackedCurrentChatWindowName();
    if (!currentChatName) {
        return;
    }

    const visibleFloorLabelSet = new Set(visibleFloorLabels);
    const nextMap = { ...(state.uiSettings.runFloorMap || {}) };
    const targetRuns = sortRunsByStartedAtDesc(
        state.runs.filter((run) => {
            if (!run?.id) {
                return false;
            }

            if (getRunRequestPurpose(run) !== "chat_main_reply") {
                return false;
            }

            if (getRunChatKey(run)) {
                return false;
            }

            const mappedChatName = getRunChatName(run);
            if (mappedChatName && mappedChatName !== currentChatName) {
                return false;
            }

            const mappedFloorLabel = getRunFloorLabel(run);
            if (mappedFloorLabel && !visibleFloorLabelSet.has(mappedFloorLabel)) {
                return false;
            }

            return true;
        }),
    );

    if (!targetRuns.length) {
        return;
    }

    let changed = false;
    let floorIndex = 0;
    let previousRun = null;

    for (const run of targetRuns) {
        if (previousRun && !shouldReusePreviousFloorLabel(previousRun, run)) {
            floorIndex += 1;
        }

        const floorLabel = visibleFloorLabels[floorIndex];
        if (!floorLabel) {
            break;
        }

        if (nextMap[run.id] !== floorLabel) {
            nextMap[run.id] = floorLabel;
            changed = true;
        }

        previousRun = run;
    }

    if (!changed) {
        return;
    }

    state.uiSettings.runFloorMap = nextMap;
    saveUiSettings();
}

function syncRunChatMap() {
    if (!hasLegacyUnkeyedChatRuns(state.runs)) {
        return;
    }

    const context = refreshChatWindowContext();
    const currentChatName = context.chatName;
    if (!currentChatName) {
        return;
    }

    if (getActiveRequestPurpose() !== "chat_main_reply") {
        return;
    }

    const visibleFloorLabelSet = new Set(context.visibleFloorLabels || []);
    if (!visibleFloorLabelSet.size) {
        return;
    }

    const nextMap = { ...(state.uiSettings.runChatMap || {}) };
    let changed = false;

    for (const run of state.runs) {
        if (!run?.id) {
            continue;
        }

        if (getRunRequestPurpose(run) !== "chat_main_reply") {
            continue;
        }

        if (getRunChatKey(run)) {
            continue;
        }

        const floorLabel = getRunFloorLabel(run);
        if (!floorLabel || !visibleFloorLabelSet.has(floorLabel)) {
            continue;
        }

        if (nextMap[run.id] !== currentChatName) {
            nextMap[run.id] = currentChatName;
            changed = true;
        }
    }

    if (!changed) {
        return;
    }

    state.uiSettings.runChatMap = nextMap;
    saveUiSettings();
}

function getRunFloorLabel(run) {
    // 新记录在发起生成时就把楼层随请求体落盘了，直接读即可，不依赖本地映射表。
    // 旧记录没有这个字段，回落到早期靠 DOM 抓取攒下来的 runFloorMap。
    if (run?.request_floor != null) {
        const storedFloor = Number(run.request_floor);
        if (Number.isInteger(storedFloor) && storedFloor >= 0) {
            return `#${storedFloor}`;
        }
    }

    if (!run?.id) {
        return "";
    }

    return state.uiSettings.runFloorMap?.[run.id] || "";
}

function getRunChatName(run) {
    if (typeof run?.request_chat_name === "string" && run.request_chat_name.trim()) {
        return run.request_chat_name.trim();
    }

    if (!run?.id) {
        return "";
    }

    return state.uiSettings.runChatMap?.[run.id] || "";
}

function isRunInTrackedCurrentChat(run) {
    const currentChatKey = getTrackedCurrentChatKey();
    if (currentChatKey && getRunChatKey(run) === currentChatKey) {
        return true;
    }

    const currentChatName = getTrackedCurrentChatWindowName();
    return Boolean(currentChatName) && getRunChatName(run) === currentChatName;
}

function getRunChatKey(run) {
    return typeof run?.request_chat_key === "string" && run.request_chat_key.trim()
        ? run.request_chat_key.trim()
        : "";
}

function getRunDisplayChatName(run) {
    const mappedChatName = getRunChatName(run);
    if (mappedChatName) {
        return mappedChatName;
    }

    if (isRunInTrackedCurrentChat(run)) {
        return getTrackedCurrentChatWindowName() || "当前聊天窗";
    }

    return "";
}

function sortRunsByStartedAtDesc(runs) {
    return [...runs].sort((left, right) => {
        const leftValue = Number(left?.started_at_ms) || 0;
        const rightValue = Number(right?.started_at_ms) || 0;
        return rightValue - leftValue;
    });
}

function groupRunsByChatName(runs) {
    const grouped = new Map();

    for (const run of runs) {
        const chatName = getRunDisplayChatName(run) || "未绑定聊天窗";
        if (!grouped.has(chatName)) {
            grouped.set(chatName, []);
        }

        grouped.get(chatName).push(run);
    }

    const currentChatName = getTrackedCurrentChatWindowName();
    return Array.from(grouped.entries())
        .sort(([leftName], [rightName]) => {
            if (currentChatName) {
                if (leftName === currentChatName) return -1;
                if (rightName === currentChatName) return 1;
            }

            return leftName.localeCompare(rightName, "zh-CN");
        })
        .map(([chatName, groupRuns]) => ({
            chatName,
            runs: sortRunsByStartedAtDesc(groupRuns),
        }));
}

function formatDatePart(value) {
    return String(value);
}

function formatStartedAt(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '<span>-</span>';
    }

    const time = [
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
    ].map((item) => String(item).padStart(2, "0")).join(":");

    const day = [
        formatDatePart(date.getFullYear()),
        formatDatePart(date.getMonth() + 1),
        formatDatePart(date.getDate()),
    ].join("/");

    return `
        <span class="stlp-time-value">
            <span>${escapeHtml(time)}</span>
            <span>${escapeHtml(day)}</span>
        </span>
    `;
}

function formatStartedAtCompact(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "-";
    }

    const time = [
        date.getHours(),
        date.getMinutes(),
    ].map((item) => String(item).padStart(2, "0")).join(":");

    const day = [
        formatDatePart(date.getMonth() + 1),
        formatDatePart(date.getDate()),
    ].join("/");

    return `${time} ${day}`;
}


function formatStartedAtPlain(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "-";
    }

    const time = [
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
    ].map((item) => String(item).padStart(2, "0")).join(":");

    const day = [
        formatDatePart(date.getFullYear()),
        formatDatePart(date.getMonth() + 1),
        formatDatePart(date.getDate()),
    ].join("/");

    return `${day} ${time}`;
}

function buildStartedAtDisplayParts(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return {
            time: "-",
            day: "",
        };
    }

    return {
        time: [
            date.getHours(),
            date.getMinutes(),
            date.getSeconds(),
        ].map((item) => String(item).padStart(2, "0")).join(":"),
        day: [
            formatDatePart(date.getFullYear()),
            formatDatePart(date.getMonth() + 1),
            formatDatePart(date.getDate()),
        ].join("/"),
    };
}

function buildWaitingRuleTimeGroupHtml(parts, extraClass = "") {
    const className = ["stlp-waiting-rule-time-group", extraClass].filter(Boolean).join(" ");
    return `
        <div class="${className}">
            <span class="stlp-waiting-rule-time-prefix">更新于</span>
            <span class="stlp-waiting-rule-time-value">${escapeHtml(parts?.time || "-")}</span>
            ${parts?.day ? `<span class="stlp-waiting-rule-date-value">${escapeHtml(parts.day)}</span>` : ""}
        </div>
    `;
}

/* 断点必须跟着酒馆走：它在 ≤1000px 把 body 设成 position: fixed，配合 html 上的
   -webkit-transform: translateZ(0)（html 因此成为固定定位后代的包含块），html 会塌成 0 高。
   我们的宿主也是 position: fixed; inset: 0，跟着变 0 高后 overflow 把面板整个裁掉。
   所以这一段只能走抽屉布局，不能用桌面态。 */
function isDesktopLayout() {
    return window.matchMedia("(min-width: 1001px)").matches;
}

function isMobileDrawerLayout() {
    return isIosWebKit() || window.matchMedia("(max-width: 1000px)").matches;
}

function lockBodyScrollForMobileDrawer() {
    if (state.bodyScrollLocked) {
        return;
    }

    const scrollTop = window.scrollY || window.pageYOffset || 0;
    state.bodyScrollLocked = true;
    state.bodyScrollLockTop = scrollTop;

    document.documentElement.classList.add("stlp-page-host-open");
    document.body.classList.add("stlp-page-host-open");
    document.documentElement.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${Math.round(scrollTop)}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";
}

function unlockBodyScrollForMobileDrawer() {
    if (!state.bodyScrollLocked) {
        document.documentElement.classList.remove("stlp-page-host-open");
        document.body.classList.remove("stlp-page-host-open");
        return;
    }

    const scrollTop = Math.max(0, Math.round(Number(state.bodyScrollLockTop) || 0));
    state.bodyScrollLocked = false;

    document.documentElement.classList.remove("stlp-page-host-open");
    document.body.classList.remove("stlp-page-host-open");
    document.documentElement.style.removeProperty("overflow");
    document.body.style.removeProperty("position");
    document.body.style.removeProperty("top");
    document.body.style.removeProperty("left");
    document.body.style.removeProperty("right");
    document.body.style.removeProperty("width");
    document.body.style.removeProperty("overflow");
    window.scrollTo(0, scrollTop);
}

function syncBodyScrollLock() {
    if (state.pageOpen && !state.pageMinimized && isMobileDrawerLayout()) {
        lockBodyScrollForMobileDrawer();
        return;
    }

    unlockBodyScrollForMobileDrawer();
}

function shouldIgnoreMobileOpenGuard() {
    return isMobileDrawerLayout() && Date.now() < state.pageOpenGuardUntil;
}

function scheduleViewportSync() {
    if (state.viewportSyncQueued) {
        return;
    }

    state.viewportSyncQueued = true;
    window.requestAnimationFrame(() => {
        state.viewportSyncQueued = false;
        if (!state.pageOpen || !isMobileDrawerLayout()) {
            return;
        }

        syncMobileViewport();
    });
}

function scheduleMobileFieldIntoView(target) {
    if (!state.pageOpen || !isMobileDrawerLayout() || !(target instanceof HTMLElement)) {
        return;
    }

    const scrollTarget = target.closest(".stlp-pricing-field, .stlp-number, .stlp-select, .stlp-pricing-inline-row");
    if (!(scrollTarget instanceof HTMLElement)) {
        return;
    }

    window.setTimeout(() => {
        if (!state.pageOpen || !isMobileDrawerLayout()) {
            return;
        }

        scrollTarget.scrollIntoView({
            block: "center",
            inline: "nearest",
            behavior: "smooth",
        });
    }, 180);
}

function syncMobileViewport() {
    if (!state.pageOpen || !isMobileDrawerLayout() || !(state.pageRoot instanceof HTMLElement)) {
        return;
    }

    const dialogs = state.pageRoot.querySelectorAll(".stlp-page-dialog, .stlp-history-dialog");
    // 确认层要单独找：最小化时没有主面板，早退的话底部弹出框就永远贴着布局视口底边，
    // 而安卓 Chrome 的布局视口底部那一截常常在屏幕之外，按钮因此点不到。
    const confirmLayers = state.pageRoot.querySelectorAll(".stlp-confirm-layer");
    if (!dialogs.length && !confirmLayers.length) {
        return;
    }

    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;top:env(safe-area-inset-top,0px);bottom:env(safe-area-inset-bottom,0px)";
    document.body.appendChild(probe);
    const computedProbeStyle = window.getComputedStyle(probe);
    const safeTop = Number.parseFloat(computedProbeStyle.top) || 0;
    const safeBottom = Number.parseFloat(computedProbeStyle.bottom) || 0;
    probe.remove();

    const viewport = window.visualViewport;
    const viewportHeight = Math.max(320, Math.round(viewport?.height || window.innerHeight));
    const offsetTop = viewport ? Math.max(0, Math.round(viewport.offsetTop || 0)) : 0;
    const top = offsetTop + 20 + safeTop;
    const maxHeight = Math.max(260, viewportHeight - 40 - safeTop - safeBottom);

    dialogs.forEach((dialog) => {
        if (!(dialog instanceof HTMLElement)) {
            return;
        }

        dialog.style.top = `${top}px`;
        dialog.style.bottom = "auto";
        dialog.style.height = `${maxHeight}px`;
        dialog.style.maxHeight = `${maxHeight}px`;
    });

    // 确认层默认是 absolute + inset:0，铺满的是布局视口。把它压到可见视口的范围，
    // 里面 margin-top:auto 的底部弹出框就会贴到「看得见的」底边而不是布局视口底边。
    confirmLayers.forEach((layer) => {
        if (!(layer instanceof HTMLElement)) {
            return;
        }

        layer.style.top = `${offsetTop}px`;
        layer.style.bottom = "auto";
        layer.style.height = `${viewportHeight}px`;
    });
}

function clampPagePosition(position, dialogRect = {}) {
    const width = dialogRect.width || 320;
    const visibleHeight = Math.min(Math.max(dialogRect.height || 120, 120), 180);
    const maxLeft = Math.max(16, window.innerWidth - width - 16);
    const maxTop = Math.max(16, window.innerHeight - visibleHeight - 16);

    return {
        left: Math.max(16, Math.min(position.left, maxLeft)),
        top: Math.max(16, Math.min(position.top, maxTop)),
    };
}

function getDesktopDialogMaxHeight(top) {
    const clampedTop = Math.max(16, Math.round(Number(top) || 16));
    return `calc(100vh - ${clampedTop + 16}px)`;
}

function getDesktopDialogHeightBounds(top) {
    const clampedTop = Math.max(16, Math.round(Number(top) || 16));
    const viewportMaxHeight = Math.max(240, window.innerHeight - clampedTop - 16);
    const defaultHeight = Math.min(Math.round(window.innerHeight * 0.56), 620, viewportMaxHeight);
    const minHeight = Math.min(Math.max(300, Math.round(window.innerHeight * 0.38)), viewportMaxHeight);
    const maxHeight = Math.max(minHeight, Math.min(Math.round(defaultHeight * 1.5), viewportMaxHeight));
    return {
        defaultHeight,
        minHeight,
        maxHeight,
    };
}

function getClampedDesktopDialogHeight(height, top) {
    const bounds = getDesktopDialogHeightBounds(top);
    const targetHeight = Number.isFinite(height) ? height : bounds.defaultHeight;
    return Math.max(bounds.minHeight, Math.min(targetHeight, bounds.maxHeight));
}

function buildPageDialogStyle() {
    if (!isDesktopLayout()) {
        return "";
    }

    const basePosition = state.pagePosition ? clampPagePosition(state.pagePosition) : { top: 16, left: null };
    const height = getClampedDesktopDialogHeight(state.pageHeight, basePosition.top);
    state.pageHeight = height;

    if (basePosition.left === null) {
        return ` style="height:${Math.round(height)}px;max-height:${getDesktopDialogMaxHeight(basePosition.top)};"`;
    }

    return ` style="top:${Math.round(basePosition.top)}px;left:${Math.round(basePosition.left)}px;right:auto;bottom:auto;height:${Math.round(height)}px;max-height:${getDesktopDialogMaxHeight(basePosition.top)};"`;
}

function startMinimizedButtonDrag(event) {
    const button = state.pageRoot?.querySelector(".stlp-minimized-button");
    if (!(button instanceof HTMLElement)) {
        return;
    }

    detachMinimizedButtonTouchFallback();
    // 报警闪烁的关键帧里带 transform，而 CSS 动画优先级高于内联样式——它会把拖动的位移整条盖掉，
    // 星星原地抖到动画结束（拖动期间渲染是挂起的，那个 1.5 秒定时器还清不掉这个类）。
    // 手已经摸到星星上了，这条提醒的目的本来就达到了，直接收掉。
    clearMinimizedButtonFlashTimer();
    state.minimizedButtonFlashActive = false;
    button.classList.remove("is-alert-flashing");
    event.preventDefault();
    const rect = button.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    state.minimizedButtonDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        // 视口尺寸和按钮节点在起手时各取一次：拖动期间两者都不会变，
        // 移动处理因此不必再读 window、也不必再查 DOM。
        viewport,
        button,
        // 拖动期间的位移写在 transform 上，这两个值是它的原点。
        baseLeft: rect.left,
        baseTop: rect.top,
        moved: false,
    };
    state.minimizedButtonLongPressTriggered = false;
    state.uiSettings.minimizedButtonPosition = clampMinimizedButtonPosition({
        left: rect.left,
        top: rect.top,
    }, rect, viewport);

    clearMinimizedButtonLongPressTimer();
}

function handleMinimizedButtonDragMove(event) {
    if (!state.minimizedButtonDrag || event.pointerId !== state.minimizedButtonDrag.pointerId) {
        return;
    }

    event.preventDefault();
    moveMinimizedButtonDragTo(event.clientX, event.clientY);
}

function resolveMinimizedButtonDragNode(drag) {
    if (drag.button instanceof HTMLElement && drag.button.isConnected) {
        return drag.button;
    }

    // 拖动期间 safeRenderPage 是挂起的，节点本来不该被换掉。这里是兜底：真被换了就重新取，
    // 并把 transform 的原点重新量准，否则位移会从错误的起点算起。
    const button = state.pageRoot?.querySelector(".stlp-minimized-button");
    if (!(button instanceof HTMLElement)) {
        return null;
    }

    const rect = button.getBoundingClientRect();
    drag.button = button;
    drag.baseLeft = rect.left;
    drag.baseTop = rect.top;
    return button;
}

// 坐标从指针事件还是从触摸事件来都走这里：手势被接管后只剩 touchmove 能用（见
// handleMinimizedButtonDragCancel），两条通道必须算出完全一样的位置。
function moveMinimizedButtonDragTo(clientX, clientY) {
    const drag = state.minimizedButtonDrag;
    if (!drag || state.minimizedButtonLongPressTriggered) {
        return;
    }

    const button = resolveMinimizedButtonDragNode(drag);
    if (!button) {
        return;
    }

    const deltaX = clientX - drag.startX;
    const deltaY = clientY - drag.startY;
    if (Math.abs(deltaX) >= MINIMIZED_BUTTON_DRAG_THRESHOLD || Math.abs(deltaY) >= MINIMIZED_BUTTON_DRAG_THRESHOLD) {
        clearMinimizedButtonLongPressTimer();
        drag.moved = true;
        button.classList.add("is-dragging");
    } else if (!drag.moved) {
        return;
    }

    const position = clampMinimizedButtonPosition({
        left: clientX - drag.offsetX,
        top: clientY - drag.offsetY,
    }, {
        width: drag.width,
        height: drag.height,
    }, drag.viewport);

    state.uiSettings.minimizedButtonPosition = position;
    // 拖动期间只动 transform、不动 left/top：布局盒子留在原地，浏览器每帧不用重新布局整个文档。
    // 不用 translate3d、也不加 will-change——这个拓展有过前科：filter 把按钮提升到独立 GPU
    // 合成层之后，部分安卓机上星星直接不显示，最后靠 style.css 里那条 filter: none 修掉的。
    // scale 得自己带上：内联 transform 会把 .is-dragging 那条整体盖掉。
    button.style.transform = `translate(${position.left - drag.baseLeft}px, ${position.top - drag.baseTop}px) scale(0.98)`;
}

function startPageDrag(event) {
    if (!isDesktopLayout()) {
        return;
    }

    const dialog = state.pageRoot?.querySelector(".stlp-page-dialog");
    if (!(dialog instanceof HTMLElement)) {
        return;
    }

    event.preventDefault();
    const rect = dialog.getBoundingClientRect();
    state.pageDrag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
    };
    state.pagePosition = {
        left: rect.left,
        top: rect.top,
    };
    state.pageHeight = getClampedDesktopDialogHeight(rect.height, rect.top);
}

function handlePageDragMove(event) {
    if (!state.pageDrag || event.pointerId !== state.pageDrag.pointerId) {
        return;
    }

    const dialog = state.pageRoot?.querySelector(".stlp-page-dialog");
    if (!(dialog instanceof HTMLElement)) {
        return;
    }

    state.pagePosition = clampPagePosition({
        left: event.clientX - state.pageDrag.offsetX,
        top: event.clientY - state.pageDrag.offsetY,
    }, {
        width: state.pageDrag.width,
        height: state.pageDrag.height,
    });

    dialog.style.top = `${Math.round(state.pagePosition.top)}px`;
    dialog.style.left = `${Math.round(state.pagePosition.left)}px`;
    dialog.style.right = "auto";
    dialog.style.bottom = "auto";
    dialog.style.height = `${Math.round(getClampedDesktopDialogHeight(state.pageHeight || state.pageDrag.height, state.pagePosition.top))}px`;
    dialog.style.maxHeight = getDesktopDialogMaxHeight(state.pagePosition.top);
}

function startPageResize(event) {
    if (!isDesktopLayout()) {
        return;
    }

    const dialog = state.pageRoot?.querySelector(".stlp-page-dialog");
    if (!(dialog instanceof HTMLElement)) {
        return;
    }

    event.preventDefault();
    const rect = dialog.getBoundingClientRect();
    state.pagePosition = {
        left: rect.left,
        top: rect.top,
    };
    state.pageResize = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: rect.height,
        top: rect.top,
    };
    state.pageHeight = getClampedDesktopDialogHeight(rect.height, rect.top);
}

function handlePageResizeMove(event) {
    if (!state.pageResize || event.pointerId !== state.pageResize.pointerId) {
        return;
    }

    const dialog = state.pageRoot?.querySelector(".stlp-page-dialog");
    if (!(dialog instanceof HTMLElement)) {
        return;
    }

    const nextHeight = state.pageResize.startHeight + (event.clientY - state.pageResize.startY);
    const top = state.pagePosition?.top ?? state.pageResize.top;
    state.pageHeight = getClampedDesktopDialogHeight(nextHeight, top);
    dialog.style.height = `${Math.round(state.pageHeight)}px`;
    dialog.style.maxHeight = getDesktopDialogMaxHeight(top);
}

function endPageDrag(event) {
    if (!state.pageDrag || (event && event.pointerId !== state.pageDrag.pointerId)) {
        return;
    }

    state.pageDrag = null;
}

function endPageResize(event) {
    if (!state.pageResize || (event && event.pointerId !== state.pageResize.pointerId)) {
        return;
    }

    state.pageResize = null;
}

function endMinimizedButtonDrag(event) {
    if (!state.minimizedButtonDrag || (event && event.pointerId !== state.minimizedButtonDrag.pointerId)) {
        return;
    }

    finishMinimizedButtonDrag();
}

// 浏览器或系统把手势接管走时会发 pointercancel，之后一个 pointermove 都不再发，拖动就断在那里
// ——安卓用户反馈的"拖一小段就得重新拖"正是这个。但 touchmove 仍在派发（它就是驱动滚动的
// 那个事件），所以这里不结束拖动，改从触摸事件继续取坐标。具体是谁抢走手势还没定论，见
// design-android-drag-cancel.local.md；这条通道不依赖成因，抢手势的是谁都能兜住。
function handleMinimizedButtonDragCancel(event) {
    const drag = state.minimizedButtonDrag;
    if (!drag || (event && event.pointerId !== drag.pointerId)) {
        return;
    }

    if (event?.pointerType !== "mouse" && attachMinimizedButtonTouchFallback()) {
        return;
    }

    finishMinimizedButtonDrag();
}

function attachMinimizedButtonTouchFallback() {
    if (state.minimizedButtonTouchFallback) {
        return true;
    }

    if (!("ontouchstart" in window)) {
        return false;
    }

    const handleTouchMove = (event) => {
        runSafely("处理兜底拖动移动", () => {
            // 多指的情况不去分辨：能走到这条通道说明手势已经被别人接管，
            // 此时还有第二根手指按着的场景不值得为它加一套 identifier 跟踪。
            const touch = event.touches?.[0] || event.changedTouches?.[0];
            if (!touch) {
                return;
            }

            refreshMinimizedButtonTouchFallbackTimer();
            moveMinimizedButtonDragTo(touch.clientX, touch.clientY);
        });
    };
    const handleTouchEnd = () => {
        runSafely("处理兜底拖动结束", () => {
            finishMinimizedButtonDrag();
        });
    };

    state.minimizedButtonTouchFallback = { handleTouchMove, handleTouchEnd };
    // 只读坐标、不拦截：手势已经被接管，再 preventDefault 也抢不回来，passive 还能少阻塞一次主线程。
    document.addEventListener("touchmove", handleTouchMove, { passive: true });
    document.addEventListener("touchend", handleTouchEnd);
    document.addEventListener("touchcancel", handleTouchEnd);
    refreshMinimizedButtonTouchFallbackTimer();
    return true;
}

function refreshMinimizedButtonTouchFallbackTimer() {
    if (state.minimizedButtonTouchFallbackTimerId) {
        clearTimeout(state.minimizedButtonTouchFallbackTimerId);
    }

    // 兜底通道靠 touchend 收尾。万一连 touchend 也被吞掉，拖动状态会一直挂着，
    // 而 safeRenderPage 在拖动期间是挂起的——整个面板就停更了。所以留一道静默超时。
    state.minimizedButtonTouchFallbackTimerId = window.setTimeout(() => {
        runSafely("兜底拖动静默超时收尾", () => {
            finishMinimizedButtonDrag();
        });
    }, MINIMIZED_BUTTON_TOUCH_FALLBACK_IDLE_MS);
}

function detachMinimizedButtonTouchFallback() {
    if (state.minimizedButtonTouchFallbackTimerId) {
        clearTimeout(state.minimizedButtonTouchFallbackTimerId);
        state.minimizedButtonTouchFallbackTimerId = null;
    }

    const fallback = state.minimizedButtonTouchFallback;
    if (!fallback) {
        return;
    }

    document.removeEventListener("touchmove", fallback.handleTouchMove);
    document.removeEventListener("touchend", fallback.handleTouchEnd);
    document.removeEventListener("touchcancel", fallback.handleTouchEnd);
    state.minimizedButtonTouchFallback = null;
}

function finishMinimizedButtonDrag() {
    const drag = state.minimizedButtonDrag;
    if (!drag) {
        return;
    }

    clearMinimizedButtonLongPressTimer();
    detachMinimizedButtonTouchFallback();
    const button = drag.button instanceof HTMLElement && drag.button.isConnected
        ? drag.button
        : state.pageRoot?.querySelector(".stlp-minimized-button");
    if (button instanceof HTMLElement) {
        button.classList.remove("is-dragging");
        // transform 只是拖动期间的临时位移，抬手时结算成 left/top 再清掉。
        // 两步在同一个任务里做完，中间不会有一帧画在旧位置上。
        if (drag.moved && state.uiSettings.minimizedButtonPosition) {
            button.style.left = `${state.uiSettings.minimizedButtonPosition.left}px`;
            button.style.top = `${state.uiSettings.minimizedButtonPosition.top}px`;
            button.style.right = "auto";
            button.style.bottom = "auto";
        }
        button.style.transform = "";
    }

    if (drag.moved || state.minimizedButtonLongPressTriggered) {
        state.minimizedButtonSuppressClickUntil = Date.now() + 250;
    }
    if (drag.moved) {
        saveUiSettings();
    }
    state.minimizedButtonDrag = null;
    state.minimizedButtonLongPressTriggered = false;

    if (state.minimizedButtonDragRenderPending) {
        state.minimizedButtonDragRenderPending = false;
        safeRenderPage();
    }
}

function isAbnormalRun(run) {
    return Boolean(run?.abnormal_detail?.abnormal_type);
}

// 这个标记是 /runs 下发的，由 shared/run-query.js 的 markSupersededRetryRuns 算出来。
// 前端刻意不重算：完整安装的拓展目录里只有 index.js、style.css、manifest.json 和
// lite/run-store.js（见 install.mjs 的 COPY_PLAN），根本够不着 shared/，
// 而这里再抄一份判定，迟早会和那边分叉。
function isSupersededRetryRun(run) {
    return Boolean(run?.retry_superseded);
}

function buildSectionHtml(sectionKey, title, bodyHtml, { statusIndicatorClass = "", statusIndicatorPosition = "before", sectionClass = "", titleHtml = "" } = {}) {
    const open = Boolean(state.uiSettings.sectionOpenStates?.[sectionKey]);
    const indicatorHtml = statusIndicatorClass
        ? `<span class="stlp-status-indicator ${statusIndicatorClass}" aria-hidden="true"></span>`
        : "";
    const rawTitleContent = titleHtml || escapeHtml(title);
    const titleContent = statusIndicatorPosition === "after"
        ? `${rawTitleContent}${indicatorHtml}`
        : `${indicatorHtml}${rawTitleContent}`;

    return `
        <section class="stlp-section stlp-section-key-${escapeHtml(sectionKey)} ${sectionClass} ${open ? "is-open" : ""}">
            <button class="stlp-section-summary" type="button" data-action="toggle-section" data-section-key="${escapeHtml(sectionKey)}" aria-expanded="${open ? "true" : "false"}">
                <span class="stlp-section-title">${titleContent}</span>
                <span class="stlp-section-chevron" aria-hidden="true">▾</span>
            </button>
            <div class="stlp-section-body ${open ? "" : "stlp-hidden"}">
                ${bodyHtml}
            </div>
        </section>
    `;
}

function collapseRunDetails(runIds) {
    for (const runId of runIds) {
        if (!runId) {
            continue;
        }

        state.expandedRunIds.delete(runId);
        state.expandedSuggestionRunIds.delete(runId);
    }
}

function collapseCurrentRunsDetails() {
    collapseRunDetails(state.runs.map((run) => run?.id || ""));
}

function collapseHistoryRunsDetails() {
    collapseRunDetails(state.historyRuns.map((run) => run?.id || ""));
}

function getSelectedHistoryRunIds() {
    return Array.from(state.selectedHistoryRunIds).filter((runId) => typeof runId === "string" && runId.length);
}

function getSelectedHistoryRunCount() {
    return getSelectedHistoryRunIds().length;
}

function clearHistorySelection() {
    state.selectedHistoryRunIds = new Set();
}

function syncHistorySelectionToLoadedRuns() {
    const sourceRuns = state.historyAbnormalOnly ? state.historyAllRuns : state.historyRuns;
    const visibleRunIds = new Set(sourceRuns.map((run) => run?.id).filter(Boolean));
    if (!visibleRunIds.size) {
        return;
    }

    state.selectedHistoryRunIds = new Set(
        getSelectedHistoryRunIds().filter((runId) => (
            visibleRunIds.has(runId) || !sourceRuns.some((run) => run?.id === runId)
        )),
    );
}

function toggleHistoryRunSelection(runId, checked) {
    if (!runId) {
        return;
    }

    if (checked) {
        state.selectedHistoryRunIds.add(runId);
    } else {
        state.selectedHistoryRunIds.delete(runId);
    }
}

function toggleHistoryPageSelection(checked, runs = state.historyRuns) {
    for (const run of runs) {
        if (!run?.id) {
            continue;
        }

        toggleHistoryRunSelection(run.id, checked);
    }
}

function areAllHistoryRunsSelected(runs = state.historyRuns) {
    const visibleRunIds = runs.map((run) => run?.id).filter(Boolean);
    return visibleRunIds.length > 0 && visibleRunIds.every((runId) => state.selectedHistoryRunIds.has(runId));
}

// 贴 git 安装的用户没有后端插件，酒馆会对插件路径返回 404；而装了后端、只是酒馆挂了
// 的情况是网络异常或 5xx。这两者必须分开——前者是"本来就这么装的"，后者是故障。
async function detectRecordSourceMode() {
    // 手动覆盖：装了后端的机器永远探测成 full，没有这个开关就没法在真机上验精简形态，
    // 排查用户问题时也可以让对方临时切过去比对。localStorage 里写 lite 或 full 即可。
    try {
        const override = window.localStorage?.getItem(`${MODULE_NAME}:record-source-mode`);
        if (override === "lite" || override === "full") {
            return override;
        }
    } catch {
        // 读不到 localStorage 就照常探测。
    }

    try {
        const response = await fetch(`${BACKEND_BASE}/status`, { credentials: "same-origin" });

        // 插件各自挂在 /api/plugins/<id> 上，没有通配兜底，所以路由不存在就是没装后端。
        if (response.status === 404) {
            return "lite";
        }

        if (response.ok) {
            return "full";
        }

        // 401/403/5xx 既不能证明装了也不能证明没装——可能只是还没登录，或者酒馆正在出错。
        // 这里不下结论，留给下次再探，免得把一次性故障固化成形态判断。
        return "unknown";
    } catch {
        return "unknown";
    }
}

async function ensureRecordSourceMode() {
    if (state.recordSourceMode === "unknown") {
        state.recordSourceMode = await detectRecordSourceMode();
    }
    return state.recordSourceMode;
}

// 刻意用动态 import 而不是顶部静态 import：完整安装的用户目录里没有 lite/，
// 静态 import 会在模块加载阶段就失败，把整个扩展一起带崩。按需加载就只影响精简形态。
let liteModulesPromise = null;

function loadLiteModules() {
    if (!liteModulesPromise) {
        liteModulesPromise = Promise.all([
            import("./lite/local-api.js"),
            import("./lite/run-store.js"),
            import("./lite/run-recorder.js"),
        ]).then(([api, store, recorder]) => ({ api, store, recorder }));
    }

    return liteModulesPromise;
}

let liteRunStorePromise = null;

// 旧记录的查看/导出/清除只用得着存储层，而 run-store.js 是零依赖的，
// 所以完整安装只需要多带这一个文件。这里不能走 loadLiteModules()——
// 它会一次性 import 三个模块，缺任何一个都失败，结果就是完整形态下
// 永远数不到旧记录，设置里那条提示等于白写。
function loadLiteRunStore() {
    if (!liteRunStorePromise) {
        liteRunStorePromise = import("./lite/run-store.js");
    }

    return liteRunStorePromise;
}

// 升级到完整版之后，之前存在浏览器里的记录还在，只是面板不再读它们。
// 这里数一下有多少条，好在设置里明说，而不是让人以为数据凭空没了。
// 完整安装的用户目录里可能压根没有 lite/，import 失败就当作没有旧记录。
async function refreshLegacyLiteRunCount() {
    if (state.recordSourceMode !== "full") {
        return;
    }

    try {
        const store = await loadLiteRunStore();
        state.legacyLiteRunCount = await store.countRuns();
    } catch {
        state.legacyLiteRunCount = 0;
    }
}

async function exportLegacyLiteRuns() {
    try {
        const store = await loadLiteRunStore();
        const runs = await store.readAllRuns();
        const blob = new Blob([JSON.stringify(runs, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `st-latency-monitor-lite-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        state.apiStatus = `已导出 ${runs.length} 条旧的本地记录`;
    } catch (error) {
        state.apiStatus = "导出旧的本地记录失败";
        state.apiError = error instanceof Error ? error.message : String(error);
    }
    safeRenderPage();
}

async function clearLegacyLiteRuns() {
    if (!window.confirm(`确定要删除浏览器里这 ${state.legacyLiteRunCount} 条旧记录吗？删掉之后无法恢复，建议先导出。`)) {
        return;
    }

    try {
        const store = await loadLiteRunStore();
        const result = await store.clearRuns("all", []);
        state.legacyLiteRunCount = 0;
        state.apiStatus = `已删除 ${result.deletedCount} 条旧的本地记录`;
    } catch (error) {
        state.apiStatus = "删除旧的本地记录失败";
        state.apiError = error instanceof Error ? error.message : String(error);
    }
    safeRenderPage();
}

// 临时把面板切到读本地记录。不做数据合并——前端记的耗时含酒馆自身的处理时间，
// 和后端的口径不是一回事，混进同一份平均值里出来的数字谁也不代表。
function toggleLegacyLiteViewing(viewing) {
    state.legacyLiteViewing = viewing;
    state.recordSourceMode = viewing ? "lite" : "full";
    void refreshBackendData();
}

async function fetchJson(path, options) {
    if (state.recordSourceMode === "lite") {
        const { api } = await loadLiteModules();
        const localResult = await api.handleLocalRequest(path, options);
        // 返回 null 表示本地不接管这个路径，照常走网络。
        if (localResult !== null) {
            return localResult;
        }
    }

    const stRequestHeadersFactory = await getSillyTavernRequestHeadersFactory();
    const stRequestHeaders = typeof stRequestHeadersFactory === "function"
        ? stRequestHeadersFactory({ omitContentType: !options?.body })
        : {};
    const csrfToken = readCsrfToken() || stRequestHeaders["X-CSRF-Token"] || "";
    const response = await fetch(`${BACKEND_BASE}${path}`, {
        credentials: "same-origin",
        headers: {
            ...stRequestHeaders,
            ...(options?.body ? { "Content-Type": "application/json" } : {}),
            ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
            ...(options?.headers || {}),
        },
        ...options,
    });

    let payload = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response.ok) {
        const message = payload?.error || payload?.message || `${response.status} ${response.statusText}`;
        throw new Error(message);
    }

    return payload;
}

async function loadWaitingQueue({ silent = false } = {}) {
    if (state.waitingQueueLoading) {
        return;
    }

    if (silent && isWaitingQueueLabelInputActive()) {
        return;
    }

    state.waitingQueueLoading = true;
    if (!silent) {
        safeRenderPage();
    }

    try {
        const result = await fetchJson("/waiting-queue");
        state.waitingQueueEntries = Array.isArray(result?.entries) ? result.entries : [];
        state.waitingQueueError = "";
        syncWaitingQueueExpandedState();
    } catch (error) {
        state.waitingQueueError = error instanceof Error ? error.message : String(error);
    } finally {
        state.waitingQueueLoading = false;
        if (silent && isWaitingQueueLabelInputActive()) {
            deferWaitingQueueRenderUntilBlur();
            return;
        }
        safeRenderPage();
    }
}

async function loadPluginRules({ silent = false } = {}) {
    if (state.pluginRulesLoading) {
        return;
    }

    if (silent && isWaitingQueueLabelInputActive()) {
        return;
    }

    state.pluginRulesLoading = true;
    if (!silent) {
        safeRenderPage();
    }

    try {
        const result = await fetchJson("/plugin-rules");
        state.pluginRules = Array.isArray(result?.rules) ? result.rules : [];
        state.pluginRulesError = "";
        syncPluginRuleExpandedState();
    } catch (error) {
        state.pluginRulesError = error instanceof Error ? error.message : String(error);
    } finally {
        state.pluginRulesLoading = false;
        if (silent && isWaitingQueueLabelInputActive()) {
            deferWaitingQueueRenderUntilBlur();
            return;
        }
        safeRenderPage();
    }
}

async function moveRunToWaitingQueue(runId) {
    const run = findRunById(runId);
    if (!run) {
        throw new Error("找不到这条记录。");
    }

    await fetchJson("/waiting-queue", {
        method: "POST",
        body: JSON.stringify({ run_id: runId }),
    });
    await loadWaitingQueue({ silent: true });
    openMessageDialog("已移入等待区", "这条记录已经进入等待区。要不要现在过去继续标注拓展名称？", [
        { action: "go-to-waiting-queue", label: "前往等待区" },
        { action: "dismiss-confirm-dialog", label: "稍后再说" },
    ]);
    safeRenderPage();
}

async function submitWaitingQueueLabel(runId) {
    const rawLabel = state.waitingQueueDrafts?.[runId];
    const pluginLabel = typeof rawLabel === "string" ? rawLabel.trim() : "";
    if (!pluginLabel) {
        openMessageDialog("还没填拓展名称", "请先输入拓展名称，再确认标注。");
        return;
    }

    const result = await fetchJson(`/waiting-queue/${encodeURIComponent(runId)}/label`, {
        method: "POST",
        body: JSON.stringify({
            plugin_label: pluginLabel,
        }),
    });

    const updatedRun = result?.run ?? null;
    if (updatedRun?.id) {
        const replaceRun = (run) => (run?.id === updatedRun.id ? updatedRun : run);
        state.runs = state.runs.map(replaceRun);
        state.historyRuns = state.historyRuns.map(replaceRun);
        state.historyAllRuns = state.historyAllRuns.map(replaceRun);
        state.filteredRuns = state.filteredRuns.map(replaceRun);
    }

    const matchedRuns = Number.isFinite(Number(result?.matched_runs))
        ? Math.max(0, Number(result.matched_runs))
        : 0;
    const learnedRuleCreated = Boolean(result?.learned_rule_created);
    delete state.waitingQueueDrafts[runId];
    clearWaitingQueueEditLock(runId);
    await loadWaitingQueue({ silent: true });
    await refreshBackendData({ silent: true });
    openMessageDialog(
        "标注已保存",
        learnedRuleCreated
            ? `已将这条记录标注为“${pluginLabel}”，并自动归类 ${matchedRuns} 条同类记录。`
            : `已将这条记录标注为“${pluginLabel}”。这次还没提炼出可复用规则，所以暂时没有自动归类其他记录。`,
    );
    safeRenderPage();
}

async function removeRunFromWaitingQueue(runId) {
    await fetchJson(`/waiting-queue/${encodeURIComponent(runId)}`, {
        method: "DELETE",
    });
    delete state.waitingQueueDrafts[runId];
    clearWaitingQueueEditLock(runId);
    await loadWaitingQueue({ silent: true });
    safeRenderPage();
}

async function reapplyPluginRule(ruleId) {
    const result = await fetchJson(`/plugin-rules/${encodeURIComponent(ruleId)}/reapply`, {
        method: "POST",
    });
    const matchedRuns = Number.isFinite(Number(result?.matched_runs))
        ? Math.max(0, Number(result.matched_runs))
        : 0;
    await refreshBackendData({ silent: true });
    await loadPluginRules({ silent: true });
    openMessageDialog("规则已重新应用", `这条规则刚刚又回填了一次历史记录，本次自动归类 ${matchedRuns} 条。`);
    safeRenderPage();
}

async function setPluginRuleEnabled(ruleId, enabled) {
    const result = await fetchJson(`/plugin-rules/${encodeURIComponent(ruleId)}`, {
        method: "PATCH",
        body: JSON.stringify({
            enabled,
        }),
    });
    const pluginLabel = result?.rule?.plugin_label || "这条规则";
    await loadPluginRules({ silent: true });
    openMessageDialog(
        enabled ? "规则已启用" : "规则已停用",
        enabled
            ? `已恢复“${pluginLabel}”的自动归类。后续同类记录会继续使用这条规则。`
            : `已暂停“${pluginLabel}”的自动归类。后续同类记录不会再用这条规则自动归类。`,
    );
    safeRenderPage();
}

async function removePluginRule(ruleId) {
    const result = await fetchJson(`/plugin-rules/${encodeURIComponent(ruleId)}`, {
        method: "DELETE",
    });
    const pluginLabel = result?.rule?.plugin_label || "这条规则";
    await loadPluginRules({ silent: true });
    openMessageDialog("规则已删除", `已删除“${pluginLabel}”的规则复用配置。后续新记录将不再使用这条规则自动归类。`);
    safeRenderPage();
}

async function getSillyTavernRequestHeadersFactory() {
    if (stRequestHeadersFactoryPromise) {
        return stRequestHeadersFactoryPromise;
    }

    stRequestHeadersFactoryPromise = import("/script.js")
        .then((module) => (typeof module.getRequestHeaders === "function" ? module.getRequestHeaders : null))
        .catch(() => null);

    return stRequestHeadersFactoryPromise;
}

function normalizeReportedInjectionSource(payload) {
    if (typeof payload === "string" && payload.trim()) {
        return {
            source: payload.trim(),
            label: getKnownInjectionSourceLabel(payload.trim()) || "",
        };
    }

    if (!payload || typeof payload !== "object") {
        return null;
    }

    const source = typeof payload.source === "string" && payload.source.trim()
        ? payload.source.trim()
        : (typeof payload.request_injection_source === "string" && payload.request_injection_source.trim()
            ? payload.request_injection_source.trim()
            : "");
    const label = typeof payload.label === "string" && payload.label.trim()
        ? payload.label.trim()
        : (typeof payload.request_injection_source_label === "string" && payload.request_injection_source_label.trim()
            ? payload.request_injection_source_label.trim()
            : "");
    if (!source && !label) {
        return null;
    }

    return {
        source,
        label: label || getKnownInjectionSourceLabel(source),
    };
}

function reportPendingInjectionSource(payload) {
    const normalized = normalizeReportedInjectionSource(payload);
    if (!normalized) {
        return false;
    }

    state.pendingInjectionSource = {
        ...normalized,
        reportedAt: Date.now(),
    };
    return true;
}

function clearPendingInjectionSource() {
    state.pendingInjectionSource = null;
}

function getActivePendingInjectionSource() {
    const pending = state.pendingInjectionSource;
    const normalized = normalizeReportedInjectionSource(pending);
    if (!normalized) {
        clearPendingInjectionSource();
        return null;
    }

    const reportedAt = Number(pending?.reportedAt);
    if (!Number.isFinite(reportedAt) || reportedAt <= 0) {
        clearPendingInjectionSource();
        return null;
    }

    if (Date.now() - reportedAt > PENDING_INJECTION_SOURCE_TTL_MS) {
        clearPendingInjectionSource();
        return null;
    }

    return normalized;
}

function normalizeGenerationType(value) {
    const normalized = typeof value === "string" ? value.trim() : "";
    return Object.prototype.hasOwnProperty.call(GENERATION_TYPE_LABELS, normalized) ? normalized : "";
}

function clearPendingGenerationType() {
    state.pendingGenerationType = null;
}

function setPendingGenerationType(value) {
    const normalized = normalizeGenerationType(value);
    state.pendingGenerationType = normalized
        ? { type: normalized, reportedAt: Date.now() }
        : null;
}

function getActivePendingGenerationType() {
    const pending = state.pendingGenerationType;
    const normalized = normalizeGenerationType(pending?.type);
    if (!normalized) {
        clearPendingGenerationType();
        return "";
    }

    const reportedAt = Number(pending?.reportedAt);
    if (!Number.isFinite(reportedAt) || reportedAt <= 0 || Date.now() - reportedAt > PENDING_GENERATION_TYPE_TTL_MS) {
        clearPendingGenerationType();
        return "";
    }

    return normalized;
}

function isChatGenerationRequestTarget(input) {
    const rawUrl = typeof input === "string"
        ? input
        : (input instanceof Request
            ? input.url
            : (typeof input?.url === "string" ? input.url : ""));
    if (!rawUrl) {
        return false;
    }

    try {
        const resolvedUrl = new URL(rawUrl, window.location.origin);
        return resolvedUrl.pathname === "/api/backends/chat-completions/generate";
    } catch {
        return false;
    }
}

function injectTrackedRequestMetadata(requestBody) {
    if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
        return false;
    }

    const pendingInjectionSource = getActivePendingInjectionSource();
    const requestPurpose = typeof requestBody.request_purpose === "string"
        ? requestBody.request_purpose.trim()
        : "";
    const shouldAttachChatIdentity = requestPurpose !== "non_chat_generation" && requestPurpose !== "plugin_internal_request";
    const currentChatIdentity = shouldAttachChatIdentity ? readCurrentChatIdentity() : null;
    let changed = false;

    if (!requestBody.request_injection_source && pendingInjectionSource?.source) {
        requestBody.request_injection_source = pendingInjectionSource.source;
        changed = true;
    }

    if (!requestBody.request_injection_source_label && pendingInjectionSource?.label) {
        requestBody.request_injection_source_label = pendingInjectionSource.label;
        changed = true;
    }

    if (shouldAttachChatIdentity && currentChatIdentity) {
        if (!requestBody.request_chat_key && currentChatIdentity.chatKey) {
            requestBody.request_chat_key = currentChatIdentity.chatKey;
            changed = true;
        }

        if (!requestBody.request_chat_id && currentChatIdentity.chatId) {
            requestBody.request_chat_id = currentChatIdentity.chatId;
            changed = true;
        }

        if (!requestBody.request_chat_id_hash && currentChatIdentity.chatIdHash) {
            requestBody.request_chat_id_hash = currentChatIdentity.chatIdHash;
            changed = true;
        }

        if (!requestBody.request_chat_name && currentChatIdentity.chatName) {
            requestBody.request_chat_name = currentChatIdentity.chatName;
            changed = true;
        }

        // 楼层 0 是合法值，这里只能判断字段是否缺失，不能用真值判断。
        if (requestBody.request_floor == null) {
            const currentFloor = readCurrentGenerationFloor();
            if (currentFloor != null) {
                requestBody.request_floor = currentFloor;
                changed = true;
            }
        }

        // 同样是"消费一次"：第二次调用时字段已在请求体上，不会被重复取用。
        if (!requestBody.request_generation_type) {
            const generationType = getActivePendingGenerationType();
            if (generationType) {
                requestBody.request_generation_type = generationType;
                clearPendingGenerationType();
                changed = true;
            }
        }

        // 这个函数会被 CHAT_COMPLETION_SETTINGS_READY 和 fetch 补丁各调一次。
        // 只在字段缺失时才生成，保证 state 里记的 id 和真正发出去的请求体一致。
        if (requestBody.request_client_generation_id) {
            state.currentGenerationClientId = requestBody.request_client_generation_id;
        } else {
            const generationClientId = createClientGenerationId();
            requestBody.request_client_generation_id = generationClientId;
            state.currentGenerationClientId = generationClientId;
            changed = true;
        }
    }

    if (pendingInjectionSource) {
        clearPendingInjectionSource();
    }

    return changed;
}

function buildPatchedGenerationRequestInit(init) {
    if (!init || typeof init !== "object" || typeof init.body !== "string") {
        return null;
    }

    try {
        const requestBody = JSON.parse(init.body);
        if (!injectTrackedRequestMetadata(requestBody)) {
            return null;
        }

        return {
            ...init,
            body: JSON.stringify(requestBody),
        };
    } catch {
        return null;
    }
}

function parseGenerationRequestBody(init) {
    if (!init || typeof init !== "object" || typeof init.body !== "string") {
        return null;
    }

    try {
        const requestBody = JSON.parse(init.body);
        if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
            return null;
        }

        return requestBody;
    } catch {
        return null;
    }
}

// 精简模式没有后端补丁，流式请求的 token 用量只能靠给自定义接口注入
// stream_options.include_usage 拿到（chat-completions.js:2343 的 custom_include_body
// 是唯一透传口，openai 源没有对应入口，那种组合下拿不到用量）。
// 但第三方中转不保证认这个字段，所以按接口记住支不支持，别拿用户的正常生成反复试错。
//
// 状态有四种，区别在于"为什么拿不到"：
//   unknown     还没探过，注入并观察
//   supported   注入后真的收到了 usage
//   no_usage    接口收下了这个字段、请求也成功，但整条流里一个 usage 都没有
//   unsupported 注入会让请求失败，去掉重试才成功
// no_usage 和 unsupported 都停止注入，但成因不同，面板要分开说。
const USAGE_INJECTION_STORAGE_KEY = `${MODULE_NAME}:usage-injection`;
const USAGE_INJECTION_YAML = "stream_options:\n  include_usage: true\n";
// v1 的 supported 是拿"请求没报错"判出来的，会把吞掉 usage 的中转误标成支持，
// 而且一旦误标就永不复查。这种记录没有挽救价值，升级时整体丢弃重新探测。
const USAGE_INJECTION_STATE_VERSION = 2;

function readUsageInjectionSupportMap() {
    try {
        const raw = window.localStorage?.getItem(USAGE_INJECTION_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
        }
        if (parsed.version !== USAGE_INJECTION_STATE_VERSION) {
            return {};
        }

        const endpoints = parsed.endpoints;
        return endpoints && typeof endpoints === "object" && !Array.isArray(endpoints) ? endpoints : {};
    } catch {
        return {};
    }
}

function readUsageInjectionSupport(endpoint) {
    const value = readUsageInjectionSupportMap()[endpoint];
    return value === "supported" || value === "unsupported" || value === "no_usage" ? value : "unknown";
}

function writeUsageInjectionSupport(endpoint, support) {
    if (!endpoint) {
        return;
    }

    try {
        const map = readUsageInjectionSupportMap();
        map[endpoint] = support;
        window.localStorage?.setItem(USAGE_INJECTION_STORAGE_KEY, JSON.stringify({
            version: USAGE_INJECTION_STATE_VERSION,
            endpoints: map,
        }));
    } catch {
        // 存不下最多退回每次探测，不值得为此打断生成。
    }
}

function getUsageInjectionEndpoint(requestBody) {
    return typeof requestBody?.custom_url === "string" ? requestBody.custom_url.trim() : "";
}

// "这次请求本来就该注入吗"——只看请求本身，不看历史探测结论。
// 收尾判定要用它：那时 shouldInjectUsageOptions 可能已经因为刚写下的结论而翻成 false。
function isUsageInjectionCandidate(requestBody) {
    // 形态还没探测出来时不注入。为此等探测结果会把生成卡在一个网络请求后面，
    // 代价比漏掉首次生成的 token 数大得多。
    if (state.recordSourceMode !== "lite" || state.legacyLiteViewing) {
        return false;
    }

    if (requestBody?.chat_completion_source !== "custom" || requestBody?.stream !== true) {
        return false;
    }

    // 用户自己填过"附加参数"就完全不碰。mergeObjectWithYaml（util.js:821）在解析失败时
    // 是 catch 后静默丢弃整段的，拼坏了会把用户自己的配置一起弄没，且毫无报错。
    if (typeof requestBody?.custom_include_body === "string" && requestBody.custom_include_body.trim()) {
        return false;
    }

    return Boolean(getUsageInjectionEndpoint(requestBody));
}

function shouldInjectUsageOptions(requestBody) {
    if (!isUsageInjectionCandidate(requestBody)) {
        return false;
    }

    const support = readUsageInjectionSupport(getUsageInjectionEndpoint(requestBody));
    return support !== "unsupported" && support !== "no_usage";
}

// 精简模式拿 token 只有注入这一条路，走不通的成因有三种。分开记下来，
// 面板才能说清楚是接口不给、还是用户自己的配置挡住了——只显示"-"的话，
// 用户无从判断到底是谁的问题。
function describeUsageCaptureMode(requestBody) {
    if (requestBody?.stream !== true) {
        // 非流式的 usage 直接在响应体里，不依赖注入。
        return "response_body";
    }
    if (requestBody?.chat_completion_source !== "custom") {
        return "source_no_passthrough";
    }
    if (typeof requestBody?.custom_include_body === "string" && requestBody.custom_include_body.trim()) {
        return "skipped_user_params";
    }
    return "injected";
}

function buildUsageInjectedInit(init, requestBody) {
    return {
        ...init,
        body: JSON.stringify({ ...requestBody, custom_include_body: USAGE_INJECTION_YAML }),
    };
}

// 注入后报错不能直接归罪于注入——余额、密钥、限流都会报错。
// 只有"去掉注入重试一次就成功"才算实锤，这时才把接口标成不支持。
// 流式分支走的是 forwardFetchResponse（util.js:709），上游状态码会原样透传，
// 所以这里可以直接看 response.ok。
async function fetchWithUsageInjectionFallback(originalFetch, input, init, requestBody) {
    const endpoint = getUsageInjectionEndpoint(requestBody);
    const injectedInit = buildUsageInjectedInit(init, requestBody);

    const response = await originalFetch(input, injectedInit);
    // 请求成功只说明接口没被这个字段噎住，不说明它真会回 usage——很多中转（假流式尤甚）
    // 照单全收再一声不吭。所以 supported / no_usage 的结论留到流读完、
    // 能看见 run.response_usage 的时候再下，见 recordUsageInjectionOutcome。
    if (response.ok) {
        return response;
    }

    // 用户已经点了停止就别再补一枪。
    if (init?.signal?.aborted) {
        return response;
    }

    const retryResponse = await originalFetch(input, init);
    if (retryResponse.ok) {
        writeUsageInjectionSupport(endpoint, "unsupported");
    }

    return retryResponse;
}

// 注入到底管不管用，只有这一处判得准：流已经读完，run.response_usage 是不是空的一目了然。
// 放在发请求那一刻用 response.ok 判，会把"收下字段却不回 usage"的中转永久标成支持，
// 此后不再复查，用户永远看到"-"还不知道为什么。
function recordUsageInjectionOutcome(requestBody, run) {
    if (!isUsageInjectionCandidate(requestBody)) {
        return;
    }

    // 只有干净跑完的生成才作数。报错、被用户中止、非 200 本来就拿不到 usage，
    // 拿这种样本下结论会把好接口误判成不给用量。
    if (run?.error || run?.client_stopped || run?.http_status !== 200) {
        return;
    }

    writeUsageInjectionSupport(
        getUsageInjectionEndpoint(requestBody),
        hasRunUsage(run) ? "supported" : "no_usage",
    );
}

// 记录必须拿到最终那个响应，否则降级重试会被记成两条。
function performGenerationFetch(originalFetch, input, init) {
    const requestBody = parseGenerationRequestBody(init);
    if (requestBody && shouldInjectUsageOptions(requestBody)) {
        return fetchWithUsageInjectionFallback(originalFetch, input, init, requestBody);
    }

    return Promise.resolve(originalFetch(input, init));
}

function hasExplicitPluginRequestMetadata(requestBody) {
    return Boolean(
        (typeof requestBody?.request_plugin === "string" && requestBody.request_plugin.trim())
        || (typeof requestBody?.request_plugin_label === "string" && requestBody.request_plugin_label.trim()),
    );
}

function shouldTrackAbortableChatGenerationRequest(input, init, patchedInit) {
    if (!isChatGenerationRequestTarget(input)) {
        return false;
    }

    const requestBody = parseGenerationRequestBody(patchedInit ?? init);
    if (!requestBody) {
        return false;
    }

    const requestPurpose = typeof requestBody.request_purpose === "string"
        ? requestBody.request_purpose.trim()
        : "";
    if (requestPurpose === "non_chat_generation" || requestPurpose === "plugin_internal_request") {
        return false;
    }

    if (hasExplicitPluginRequestMetadata(requestBody)) {
        return false;
    }

    return true;
}

// 精简模式的采集入口：把这次生成从请求体一路记到流结束。
// 整段都是旁路——读的是 response.clone()，任何失败都只写一行警告，
// 绝不能影响酒馆自己那条链路，记录丢一条远比生成失败可接受。
function recordLiteGeneration(effectiveInit, responsePromise) {
    // 已经确定是完整形态就立刻返回，不给主链路增加任何无谓开销。
    // legacyLiteViewing 只是把面板临时切去读旧记录，装的仍然是后端形态，
    // 这时候再往浏览器里记一份就成了双写。
    if (state.recordSourceMode === "full" || state.legacyLiteViewing) {
        return;
    }

    // 后面可能要等形态探测，开始时间必须在这里取，否则等待时长会被算进这次生成的耗时。
    const startedAtMs = Date.now();

    // 必须在把响应交回调用方之前克隆。形态探测、动态导入和 IndexedDB 都可能
    // 等很久，届时原响应已被酒馆锁定/读完（Luker 的 WS 响应同样是原生 Response）。
    // 立即接住拒绝，避免初始化期间出现 unhandledrejection；不阻塞主生成链路。
    const capturedResponse = Promise.resolve(responsePromise).then((response) => {
        try {
            return { response: response.clone(), error: null, failed: false };
        } catch (error) {
            return { response: null, error, failed: true };
        }
    }, (error) => ({ response: null, error, failed: true }));
    let responseConsumed = false;

    void (async () => {
        let run = null;
        try {
            // 页面刚打开时探测未必回来了，这里等它。不等的话开头几秒的生成会被静默丢掉。
            if (await ensureRecordSourceMode() !== "lite") {
                return;
            }

            const requestBody = parseGenerationRequestBody(effectiveInit);
            if (!requestBody) {
                return;
            }

            const { api, store, recorder } = await loadLiteModules();
            // 规则是等待区打标学出来的，拿它给这次请求兜底认领拓展身份。
            // 读不出来（比如库刚建）不该拖累记录本身，所以失败就当没有规则。
            const learnedRules = await api.readLitePluginRules().catch(() => []);
            run = recorder.createLiteRun(requestBody, startedAtMs, learnedRules);
            // 拿不到 token 时面板要说明成因，而成因只有请求发出的那一刻才知道
            // （事后从记录里反推不出用户当时填没填附加参数）。
            run.usage_capture = describeUsageCaptureMode(requestBody);
            state.liteActiveRun = run;

            try {
                const captured = await capturedResponse;
                if (captured.failed) {
                    throw captured.error;
                }
                recorder.markLiteResponseHeaders(run, captured.response);
                responseConsumed = true;
                await recorder.consumeLiteResponse(run, captured.response);
            } catch (error) {
                recorder.markLiteRunError(run, error);
            }

            const liteSettings = await api.readLiteSettings();
            recorder.finalizeLiteRun(run, liteSettings);
            recordUsageInjectionOutcome(requestBody, run);

            // 和完整版同口径：读不出设置时按"开着"处理，不因为读配置失败就静默停掉采集。
            if (liteSettings?.runtime?.recording_enabled !== false) {
                await store.appendRun(run);
            }
        } catch (error) {
            console.warn(`[${MODULE_NAME}] 本地记录这次生成失败`, error);
        } finally {
            if (!responseConsumed) {
                // 探测为完整版或初始化失败时放弃旁路；不要等待 tee 的另一端结束。
                void capturedResponse.then(({ response }) => {
                    if (response?.body && !response.body.locked) {
                        void response.body.cancel().catch(() => {});
                    }
                }).catch(() => {});
            }
            if (run && state.liteActiveRun === run) {
                state.liteActiveRun = null;
            }
        }
    })();
}

function installOutgoingGenerationHook() {
    if (state.outgoingGenerationHookInstalled || typeof window.fetch !== "function") {
        return;
    }

    const originalFetch = window.fetch.bind(window);
    window.fetch = function patchedFetch(input, init) {
        if (isChatGenerationRequestTarget(input)) {
            const patchedInit = buildPatchedGenerationRequestInit(init);
            const effectiveInit = patchedInit ?? init;
            if (!shouldTrackAbortableChatGenerationRequest(input, effectiveInit, patchedInit)) {
                // 这类请求不进"可中止"跟踪，但它同样是一次真实生成，精简模式要记下来。
                const untrackedResponse = performGenerationFetch(originalFetch, input, effectiveInit);
                recordLiteGeneration(effectiveInit, untrackedResponse);
                return untrackedResponse;
            }
            const requestEntry = registerActiveGenerationRequest();
            const trackedInit = buildTrackedGenerationRequestInit(input, init, effectiveInit, requestEntry);

            try {
                const responsePromise = performGenerationFetch(originalFetch, input, trackedInit);
                recordLiteGeneration(effectiveInit, responsePromise);
                return responsePromise.then((response) => {
                    monitorGenerationResponseLifecycle(response, requestEntry.requestId);
                    return response;
                }, (error) => {
                    removeActiveGenerationRequest(requestEntry.requestId);
                    // 网络层直接失败：连响应都没拿到，不可能是善终。
                    settleMainApiOutcome(false);
                    throw error;
                });
            } catch (error) {
                removeActiveGenerationRequest(requestEntry.requestId);
                settleMainApiOutcome(false);
                throw error;
            }
        }

        return originalFetch(input, init);
    };

    window.STLatencyMonitorInjectionSource = {
        reportInjectionSource: reportPendingInjectionSource,
        clearInjectionSource: clearPendingInjectionSource,
        peekInjectionSource: getActivePendingInjectionSource,
    };
    state.outgoingGenerationHookInstalled = true;
}

function installGenerationSettingsHook() {
    if (state.generationSettingsHookInstalled || !eventSource || typeof eventSource.on !== "function") {
        return;
    }

    // 事件签名为 (type, options, dryRun)。dry run 不会真正发出请求，
    // 记下它的类型只会污染下一个真实请求，所以直接跳过。
    eventSource.on(event_types.GENERATION_STARTED, (generationType, _options, dryRun) => {
        if (!dryRun) {
            setPendingGenerationType(generationType);
            maybeClearMainApiErrorOnNewGeneration(generationType);
        }
        markSillyTavernGenerationStarted();
    });
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        // 酒馆只在 stopGeneration() 里发这个事件（script.js:5559），API 出错不会走到，
        // 所以这里和 #mes_stop 的点击一样算"用户自己停的"，那次 fetch 失败不该判成 API 出错。
        state.recentManualStopAtMs = Date.now();
        // markSillyTavernGenerationStopped 会清空生成 id，信号必须赶在它前面发。
        void sendClientStopSignal();
        markSillyTavernGenerationStopped();
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        markSillyTavernGenerationEnded();
    });
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, (generateData) => {
        injectTrackedRequestMetadata(generateData);
    });

    // GENERATION_STOPPED 事件到达时酒馆往往已经断开连接，run 可能抢先落盘。
    // 捕获阶段能跑在酒馆自己的点击处理之前，是唯一能保证顺序的位置，
    // 所以这个 DOM 监听和上面的事件监听是互补关系，不是重复。
    document.addEventListener("click", (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest("#mes_stop")) {
            // 记一笔时间：接下来那次 fetch 失败是用户自己停的，不该算成 API 出错。
            state.recentManualStopAtMs = Date.now();
            void sendClientStopSignal();
        }
    }, true);

    state.generationSettingsHookInstalled = true;
}

function readCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"], meta[name="csrf"], meta[name="X-CSRF-Token"]');
    if (meta instanceof HTMLMetaElement && meta.content.trim()) {
        return meta.content.trim();
    }

    const globalCandidates = [
        window.csrfToken,
        window.CSRF_TOKEN,
        window.csrf_token,
    ];

    for (const value of globalCandidates) {
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }

    const cookieMatch = document.cookie.match(/(?:^|;\s*)(?:csrfToken|csrf_token|X-CSRF-Token)=([^;]+)/i);
    if (cookieMatch?.[1]) {
        return decodeURIComponent(cookieMatch[1]);
    }

    return "";
}

async function refreshBackendData({ silent = false } = {}) {
    if (state.extensionDisabled || state.isRefreshing) {
        return;
    }

    if (silent && (isWaitingQueueLabelInputActive() || isColorWheelInputActive())) {
        return;
    }

    // 必须在发第一个请求之前定下形态，否则 fetchJson 不知道该走本地还是走网络。
    await ensureRecordSourceMode();

    state.isRefreshing = true;
    if (!silent) {
        state.apiStatus = "正在刷新后台监控数据";
        safeRenderPage();
    }

    try {
        refreshChatWindowContext();
        const requestFilterQuery = buildRunFilterQuery();
        const dailySummaryQuery = buildDailySummaryQuery();
        const dailySummaryScope = getDailySummaryScopeInfo();
        const [statusResult, settingsResult, runsResult, summaryResult, dailySummaryResult, waitingQueueResult, pluginRulesResult] = await Promise.all([
            fetchJson("/status"),
            fetchJson("/settings"),
            fetchJson(`/runs?limit=20&${requestFilterQuery}`),
            fetchJson(`/summary?limit=100&${requestFilterQuery}`),
            fetchJson(`/summary?${dailySummaryQuery}`),
            fetchJson("/waiting-queue"),
            fetchJson("/plugin-rules"),
        ]);

        state.status = statusResult;
        state.settings = settingsResult?.settings ?? null;
        state.runs = filterRunsByRequestPurpose(runsResult?.runs);
        updateMinimizedButtonAbnormalAlert(state.runs);
        if (Number.isFinite(Number(runsResult?.total))) {
            state.historyTotal = Math.max(0, Number(runsResult?.total));
        } else {
            state.historyTotal = Math.max(
                Number(statusResult?.stored_runs) || 0,
                state.runs.length,
            );
        }
        state.summary = summaryResult?.summary ?? null;
        state.dailySummary = dailySummaryResult?.daily_summary
            ? {
                ...dailySummaryResult.daily_summary,
                scope_mode: dailySummaryScope.mode,
                scope_label: dailySummaryScope.label,
            }
            : null;
        state.waitingQueueEntries = Array.isArray(waitingQueueResult?.entries) ? waitingQueueResult.entries : [];
        state.waitingQueueError = "";
        state.pluginRules = Array.isArray(pluginRulesResult?.rules) ? pluginRulesResult.rules : [];
        state.pluginRulesError = "";
        syncWaitingQueueExpandedState();
        syncPluginRuleExpandedState();
        const activeFilters = getActiveRunFilters();
        if (!hasActiveRunFilters(activeFilters)) {
            clearFilteredRuns();
        } else {
            const filterKey = buildRunFilterKey(activeFilters);
            const hasFilteredSnapshot = state.filteredRunsKey === filterKey;
            if (silent && hasFilteredSnapshot) {
                mergeIntoFilteredRuns(applyRunFilters(state.runs, activeFilters));
            } else {
                const { runs: filteredRuns, total: filteredTotal } = await fetchFilteredStoredRuns(activeFilters);
                if (buildRunFilterKey() === filterKey) {
                    state.filteredRuns = sortRunsByStartedAtDesc(filteredRuns);
                    state.filteredRunsKey = filterKey;
                    state.historyTotal = Math.max(state.historyTotal, filteredTotal);
                }
            }
        }
        state.expandedRunIds = new Set(
            Array.from(state.expandedRunIds).filter(isRunLoadedAnywhere),
        );
        state.expandedSuggestionRunIds = new Set(
            Array.from(state.expandedSuggestionRunIds).filter(isRunLoadedAnywhere),
        );
        state.backendReady = true;
        state.apiError = "";
        state.apiStatus = state.recordSourceMode === "lite"
            ? "精简模式：记录存在本机浏览器里"
            : "后端监控接口已连接";
    } catch (error) {
        state.backendReady = false;
        // 精简模式下走不通不是"后端不可用"——压根没有后端，说错了会让人白去查服务器。
        state.apiStatus = state.recordSourceMode === "lite"
            ? "本地记录读取失败"
            : "后端监控接口不可用";
        state.apiError = error instanceof Error ? error.message : String(error);
    } finally {
        refreshChatWindowContext();
        state.isRefreshing = false;
        if (silent && isWaitingQueueLabelInputActive()) {
            deferWaitingQueueRenderUntilBlur();
            return;
        }
        if (silent && isColorWheelInputActive()) {
            deferColorWheelRenderUntilBlur();
            return;
        }
        safeRenderPage();
    }
}

async function loadHistoryPage(page) {
    const nextPage = Math.max(1, Number(page) || 1);
    collapseHistoryRunsDetails();
    state.historyLoading = true;
    state.historyError = "";
    state.historyScrollTop = 0;
    safeRenderPage();

    try {
        const offset = (nextPage - 1) * HISTORY_PAGE_SIZE;
        const historyFilterQuery = buildRunFilterQuery({ cacheHitOnly: state.uiSettings.cacheHitOnly });
        const result = await fetchJson(`/runs?limit=${HISTORY_PAGE_SIZE}&offset=${offset}&${historyFilterQuery}`);
        state.historyPage = nextPage;
        state.historyRuns = filterRunsByRequestPurpose(result?.runs);
        state.historyTotal = Math.max(Number(result?.total) || 0, state.historyRuns.length);
        syncHistorySelectionToLoadedRuns();
        state.expandedRunIds = new Set(
            Array.from(state.expandedRunIds).filter(isRunLoadedAnywhere),
        );
        state.expandedSuggestionRunIds = new Set(
            Array.from(state.expandedSuggestionRunIds).filter(isRunLoadedAnywhere),
        );
    } catch (error) {
        state.historyError = error instanceof Error ? error.message : String(error);
        state.historyRuns = [];
    } finally {
        state.historyLoading = false;
        safeRenderPage();
    }
}

async function loadAllHistoryRuns() {
    collapseHistoryRunsDetails();
    state.historyLoading = true;
    state.historyError = "";
    state.historyScrollTop = 0;
    safeRenderPage();

    try {
        const historyFilterQuery = buildRunFilterQuery({
            abnormalOnly: state.historyAbnormalOnly,
            cacheHitOnly: state.uiSettings.cacheHitOnly,
        });
        const result = await fetchJson(`/runs?limit=${getStoredRunsFetchLimit()}&offset=0&${historyFilterQuery}`);
        state.historyAllRuns = filterRunsByRequestPurpose(result?.runs);
        state.historyTotal = Math.max(Number(result?.total) || 0, state.historyAllRuns.length, state.historyTotal);
        syncHistorySelectionToLoadedRuns();
        state.expandedRunIds = new Set(
            Array.from(state.expandedRunIds).filter(isRunLoadedAnywhere),
        );
        state.expandedSuggestionRunIds = new Set(
            Array.from(state.expandedSuggestionRunIds).filter(isRunLoadedAnywhere),
        );
    } catch (error) {
        state.historyError = error instanceof Error ? error.message : String(error);
        state.historyAllRuns = [];
    } finally {
        state.historyLoading = false;
        safeRenderPage();
    }
}

function getStoredRunsFetchLimit() {
    return Math.max(
        Number(state.historyTotal) || 0,
        Number(state.status?.stored_runs) || 0,
        HISTORY_PAGE_SIZE,
    );
}

// 服务端已经按筛选条件过滤过，这里再过一遍只是防御：
// 万一后端是旧版本、不认识某个筛选参数，前端仍然不会把不该显示的记录放出来。
async function fetchFilteredStoredRuns(filters = getActiveRunFilters()) {
    const result = await fetchJson(
        `/runs?limit=${getStoredRunsFetchLimit()}&offset=0&${buildRunFilterQuery(filters)}`,
    );
    const runs = applyRunFilters(result?.runs, filters);
    const total = Math.max(Number(result?.total) || 0, runs.length);
    return { runs, total };
}

function clearFilteredRuns() {
    state.filteredRuns = [];
    state.filteredRunsKey = "";
    state.filteredRunsPendingKey = "";
}

// 全量筛选结果可能有几 MB，不能每次自动刷新都整包重拉。
// 已经拿到全量结果之后，后续自动刷新只把最近 N 条里新出现的命中记录并进来。
function mergeIntoFilteredRuns(runs) {
    if (!runs.length) {
        return;
    }

    const runsById = new Map();
    for (const run of state.filteredRuns) {
        if (run?.id) {
            runsById.set(run.id, run);
        }
    }
    for (const run of runs) {
        if (run?.id) {
            runsById.set(run.id, run);
        }
    }
    state.filteredRuns = sortRunsByStartedAtDesc(Array.from(runsById.values()));
}

async function loadRunPromptBreakdown(runId) {
    if (!runId || hasLoadedPromptBreakdown(runId) || isPromptBreakdownLoading(runId)) {
        return;
    }

    state.promptBreakdownLoadingRunIds.add(runId);
    safeRenderPage();

    try {
        const result = await fetchJson(`/runs/${encodeURIComponent(runId)}`);
        cachePromptBreakdown(runId, result?.run?.prompt_breakdown ?? null);
    } catch {
        // 取不到明细不影响其它信息，标记成"已取过但没有"，避免展开一次就重试一次。
        cachePromptBreakdown(runId, null);
    } finally {
        state.promptBreakdownLoadingRunIds.delete(runId);
        safeRenderPage();
    }
}

async function loadFilteredRuns() {
    const filters = getActiveRunFilters();
    if (!hasActiveRunFilters(filters)) {
        clearFilteredRuns();
        safeRenderPage();
        return;
    }

    const filterKey = buildRunFilterKey(filters);
    if (state.filteredRunsLoading && state.filteredRunsPendingKey === filterKey) {
        return;
    }

    state.filteredRunsLoading = true;
    state.filteredRunsPendingKey = filterKey;
    safeRenderPage();

    try {
        const { runs, total } = await fetchFilteredStoredRuns(filters);
        // 请求期间用户可能又改了筛选，过期结果直接丢弃。
        if (buildRunFilterKey() !== filterKey) {
            return;
        }
        state.filteredRuns = sortRunsByStartedAtDesc(runs);
        state.filteredRunsKey = filterKey;
        state.historyTotal = Math.max(state.historyTotal, total);
    } catch (error) {
        state.apiError = error instanceof Error ? error.message : String(error);
    } finally {
        if (state.filteredRunsPendingKey === filterKey) {
            state.filteredRunsLoading = false;
        }
        safeRenderPage();
    }
}

async function refreshHistoryDialogData() {
    if (state.historyLoading) {
        return;
    }

    const currentPage = Math.max(1, state.historyPage || 1);
    await refreshBackendData({ silent: true });
    if (state.historyAbnormalOnly) {
        await loadAllHistoryRuns();
        return;
    }
    await loadHistoryPage(currentPage);
}

function openHistoryDialog() {
    collapseHistoryRunsDetails();
    state.historyDialogOpen = true;
    state.historyDeleteMode = false;
    state.historyAbnormalOnly = false;
    state.historyAllRuns = [];
    state.historyScrollTop = 0;
    clearHistorySelection();
    if (state.historyPage < 1) {
        state.historyPage = 1;
    }
    if (isMobileDrawerLayout()) {
        state.pageOpenGuardUntil = Date.now() + MOBILE_OPEN_GUARD_MS;
    }
    if (!state.historyRuns.length) {
        void loadHistoryPage(state.historyPage);
        return;
    }
    safeRenderPage();
}

function closeHistoryDialog() {
    if (!state.historyDialogOpen) {
        return;
    }

    collapseHistoryRunsDetails();
    clearHistorySelection();
    state.historyDeleteMode = false;
    state.historyAbnormalOnly = false;
    state.historyAllRuns = [];
    state.historyDialogOpen = false;
    state.historyScrollTop = 0;
    safeRenderPage();
}

function mergeMonitorSettingsObjects(baseValue, partialValue) {
    const safeBase = baseValue && typeof baseValue === "object" && !Array.isArray(baseValue) ? baseValue : {};
    const safePartial = partialValue && typeof partialValue === "object" && !Array.isArray(partialValue) ? partialValue : {};
    const nextValue = { ...safeBase };

    for (const [key, value] of Object.entries(safePartial)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
            nextValue[key] = mergeMonitorSettingsObjects(safeBase[key], value);
        } else {
            nextValue[key] = value;
        }
    }

    return nextValue;
}

function mergeMonitorSettingsState(partialSettings) {
    const currentSettings = state.settings && typeof state.settings === "object" ? state.settings : {};
    state.settings = mergeMonitorSettingsObjects(currentSettings, partialSettings);
}

function persistPricingModelConfig(modelName, config) {
    const normalizedModelName = typeof modelName === "string" ? modelName.trim() : "";
    if (!normalizedModelName) {
        return;
    }

    const normalizedConfig = normalizePricingConfig(config);
    state.uiSettings.pricingConfigByModel = {
        ...(state.uiSettings?.pricingConfigByModel && typeof state.uiSettings.pricingConfigByModel === "object"
            ? state.uiSettings.pricingConfigByModel
            : {}),
        [normalizedModelName]: normalizedConfig,
    };
    saveUiSettings();
    updateMonitorSettings({
        pricing: {
            model_prices: {
                [normalizedModelName]: normalizedConfig,
            },
        },
    }, { deferBusyRender: true, optimistic: true });
}

// 逐个补发会打出 N 个请求，中途失败还会留下改了一半的状态。
// 后端的 deepMerge 支持一次收多个模型，所以合成一条发。
async function syncLocalOnlyPricingToBackend() {
    if (state.isSaving) {
        return;
    }

    const modelNames = getLocalOnlyPricedModels();
    if (!modelNames.length) {
        return;
    }

    const localPricingMap = getLocalPricingMap();
    const modelPrices = {};
    for (const modelName of modelNames) {
        modelPrices[modelName] = normalizePricingConfig(localPricingMap[modelName]);
    }

    await updateMonitorSettings({ pricing: { model_prices: modelPrices } });
}

async function updateMonitorSettings(partialSettings, { deferBusyRender = false, optimistic = false } = {}) {
    if (state.extensionDisabled) {
        return;
    }

    if (optimistic) {
        mergeMonitorSettingsState(partialSettings);
    }

    state.isSaving = true;
    state.apiStatus = "正在保存设置";
    if (!deferBusyRender) {
        safeRenderPage();
    }

    try {
        const result = await fetchJson("/settings", {
            method: "POST",
            body: JSON.stringify(partialSettings),
        });

        state.settings = result?.settings ?? state.settings;
        state.apiStatus = "设置已更新";
        state.apiError = "";
        await refreshBackendData({ silent: true });
    } catch (error) {
        state.apiStatus = "设置保存失败";
        state.apiError = error instanceof Error ? error.message : String(error);
        safeRenderPage();
    } finally {
        state.isSaving = false;
        if (deferBusyRender && !state.isRefreshing) {
            safeRenderPage();
        }
    }
}

async function clearBackendRuns() {
    if (state.extensionDisabled || state.isRefreshing) {
        return;
    }

    state.confirmDialog = {
        type: "clear-backend",
    };
    safeRenderPage();
}

function getHistoryScopeLabel(scope = "all") {
    return scope === "normal_only" ? "删除正常生成记录" : "删除全部历史记录";
}

function getHistoryScopeConfirmText(scope = "all") {
    const selectedCount = getSelectedHistoryRunCount();
    if (scope === "normal_only") {
        return selectedCount > 0
            ? `确认只删除已勾选的 ${selectedCount} 条历史记录里的正常生成部分吗？未勾选和异常记录都会保留。`
            : "请先勾选要删除的历史记录。";
    }

    return selectedCount > 0
        ? `确认删除已勾选的 ${selectedCount} 条历史记录吗？未勾选部分会保留。`
        : "请先勾选要删除的历史记录。";
}

async function performClearBackendRuns() {
    state.confirmDialog = null;

    state.isRefreshing = true;
    state.apiStatus = "正在清空后台监控记录";
    safeRenderPage();

    try {
        await fetchJson("/runs", {
            method: "DELETE",
        });

        state.runs = [];
        state.summary = null;
        state.apiStatus = "后台监控记录已清空";
        state.apiError = "";
        state.isRefreshing = false;
        await refreshBackendData({ silent: true });
    } catch (error) {
        state.apiStatus = "清空后台监控记录失败";
        state.apiError = error instanceof Error ? error.message : String(error);
        safeRenderPage();
    } finally {
        state.isRefreshing = false;
    }
}

function clearHistoryRuns() {
    if (state.extensionDisabled || state.isRefreshing) {
        return;
    }

    state.confirmDialog = {
        type: "history-delete-menu",
    };
    safeRenderPage();
}

async function performClearHistoryRuns(scope = "all") {
    const scopeLabel = getHistoryScopeLabel(scope);
    const selectedRunIds = getSelectedHistoryRunIds();
    if (!selectedRunIds.length) {
        state.confirmDialog = null;
        state.apiStatus = `历史记录操作失败：${scopeLabel}`;
        state.apiError = "请先勾选要删除的历史记录。";
        safeRenderPage();
        return;
    }

    const currentHistoryPage = state.historyPage;
    state.confirmDialog = null;

    state.isRefreshing = true;
    state.apiStatus = `正在处理历史记录：${scopeLabel}（已勾选 ${selectedRunIds.length} 条）`;
    safeRenderPage();

    try {
        const result = await fetchJson(`/runs?scope=${scope}`, {
            method: "DELETE",
            body: JSON.stringify({
                run_ids: selectedRunIds,
            }),
        });

        collapseCurrentRunsDetails();
        collapseHistoryRunsDetails();
        clearHistorySelection();
        state.historyDeleteMode = false;
        state.isRefreshing = false;
        await refreshBackendData({ silent: true });
        if (state.historyDialogOpen) {
            const remainingCount = Math.max(0, Number(result?.remaining_count) || 0);
            const targetPage = Math.max(1, Math.min(currentHistoryPage, Math.ceil(remainingCount / HISTORY_PAGE_SIZE) || 1));
            await loadHistoryPage(targetPage);
        }
        state.apiStatus = `历史记录操作完成：${scopeLabel}，已删除 ${Number(result?.cleared_count) || 0} 条`;
        state.apiError = "";
    } catch (error) {
        state.apiStatus = `历史记录操作失败：${scopeLabel}`;
        state.apiError = error instanceof Error ? error.message : String(error);
        safeRenderPage();
    } finally {
        state.isRefreshing = false;
        safeRenderPage();
    }
}

function scheduleAutoRefresh() {
    clearRefreshTimer();

    if (state.extensionDisabled || !state.uiReady) {
        return;
    }

    if (!state.pageOpen && state.uiSettings.keepRunningAfterClose === false) {
        return;
    }

    const seconds = Math.max(5, Number(state.uiSettings.autoRefreshSeconds) || DEFAULT_UI_SETTINGS.autoRefreshSeconds);
    state.refreshTimerId = window.setInterval(() => {
        if (state.extensionDisabled || document.hidden) {
            return;
        }

        refreshBackendData({ silent: true });
    }, seconds * 1000);
}

function buildStatusContentHtml() {
    const permissionLevel = state.status?.permission_level || state.status?.effective_runtime_mode;
    const runtimeMode = state.status?.runtime_mode || state.settings?.runtime?.runtime_mode;
    const detectedPermissionLevel = state.status?.detected_permission_level || permissionLevel;
    const waitingQueuePendingCount = state.waitingQueueEntries.length;
    const pluginRuleCount = state.pluginRules.length;
    const generationStopSummary = hasAbortableGenerationRequest()
        ? "已接入，当前可强制终止"
        : "已接入，异常后可弹确认并尝试终止";
    const forceStopEntrySummary = "已启用（监控页按钮）";
    return `
        <div class="stlp-note">当前这里是 ${escapeHtml(getEntryOriginLabel("standalone_page"))}；下面展示的最近记录属于主界面真实生成链路，不是插件自身操作记录。</div>
        <div class="stlp-grid">
            <div><strong>当前区域</strong><span>${escapeHtml(getEntryOriginLabel("standalone_page"))}</span></div>
            <div><strong>接口状态</strong><span>${escapeHtml(state.apiStatus)}</span></div>
            <div><strong>错误信息</strong><span>${escapeHtml(state.apiError || "-")}</span></div>
            <div><strong>权限环境</strong><span>${escapeHtml(getPermissionLabel(permissionLevel))}</span></div>
            <div><strong>运行模式</strong><span>${escapeHtml(getRuntimeModeLabel(runtimeMode))}</span></div>
            <div><strong>自动判定结果</strong><span>${escapeHtml(getPermissionLabel(detectedPermissionLevel))}</span></div>
            <div><strong>当前监视视图</strong><span>${escapeHtml(getActiveRequestPurposeLabel())}</span></div>
            <div><strong>只处理当前楼层</strong><span>${escapeHtml(formatBoolean(Boolean(state.status?.current_floor_only)))}</span></div>
            <div><strong>禁止历史楼层扫描</strong><span>${escapeHtml(formatBoolean(Boolean(state.status?.history_scan_forbidden)))}</span></div>
            <div><strong>已存监控记录</strong><span>${escapeHtml(state.status?.stored_runs ?? "-")}</span></div>
            <div><strong>等待区待标注</strong><span>${escapeHtml(String(waitingQueuePendingCount))} 条</span></div>
            <div><strong>已存规则</strong><span>${escapeHtml(String(pluginRuleCount))} 条</span></div>
            <div><strong>异常终止生成链</strong><span>${escapeHtml(generationStopSummary)}</span></div>
            <div><strong>终止生成入口</strong><span>${escapeHtml(forceStopEntrySummary)}</span></div>
            <div><strong>自动刷新间隔</strong><span>${escapeHtml(`${state.uiSettings.autoRefreshSeconds} 秒`)}</span></div>
        </div>
    `;
}

function buildStatusViewHtml() {
    const statusIndicatorClass = getBackendStatusIndicatorClass();
    return `
        <section class="stlp-status-view">
            <div class="stlp-status-view-header">
                <div class="stlp-status-view-title-row">
                    <div class="stlp-status-view-title">后台监控状态</div>
                    <span class="stlp-status-indicator ${escapeHtml(statusIndicatorClass)}" aria-hidden="true"></span>
                </div>
            </div>
            <div class="stlp-status-view-body">
                ${buildStatusContentHtml()}
            </div>
        </section>
    `;
}

function buildWaitingQueueEntryHtml(entry) {
    const run = entry?.run;
    const runId = entry?.run_id || run?.id || "";
    const draftValue = getWaitingQueueDraftValue(entry);
    const createdAtHtml = formatStartedAt(entry?.created_at) || "<span>-</span>";
    const expanded = isWaitingQueueEntryExpanded(runId);

    if (!run) {
        return `
            <article class="stlp-waiting-card ${expanded ? "is-expanded" : ""}" data-waiting-entry-run-id="${escapeHtml(runId)}">
                <div class="stlp-waiting-card-header">
                    <div class="stlp-waiting-card-summary">
                        <div class="stlp-waiting-card-title">记录已不存在</div>
                        <div class="stlp-waiting-card-summary-meta">
                            <div class="stlp-waiting-card-meta">加入时间 ${createdAtHtml}</div>
                            <span class="stlp-badge stlp-waiting-card-status">记录缺失</span>
                        </div>
                    </div>
                    <button class="menu_button stlp-waiting-card-toggle ${expanded ? "is-expanded" : ""}" type="button" data-action="toggle-waiting-queue-entry" data-run-id="${escapeHtml(runId)}" aria-expanded="${expanded ? "true" : "false"}" aria-label="${expanded ? "收起等待区卡片" : "展开等待区卡片"}" title="${expanded ? "收起等待区卡片" : "展开等待区卡片"}">
                        ${getChevronIconSvg()}
                    </button>
                </div>
                ${expanded ? `
                <div class="stlp-waiting-card-body">
                    <div class="stlp-note">这条记录可能已被删除。你可以将它从等待区移除。</div>
                    <div class="stlp-waiting-card-actions">
                        <button class="menu_button stlp-inline-button" type="button" data-action="remove-from-waiting-queue" data-run-id="${escapeHtml(runId)}">移出等待区</button>
                    </div>
                </div>
                ` : ""}
            </article>
        `;
    }

    return `
        <article class="stlp-waiting-card ${expanded ? "is-expanded" : ""}" data-waiting-entry-run-id="${escapeHtml(runId)}">
            <div class="stlp-waiting-card-header">
                <div class="stlp-waiting-card-summary">
                    <div class="stlp-waiting-card-title">${escapeHtml(getRunSourceLabel(run))} · ${escapeHtml(run?.model || "未记录模型")}</div>
                    <div class="stlp-waiting-card-summary-meta">
                        <div class="stlp-waiting-card-meta">加入时间 ${createdAtHtml}</div>
                        <span class="stlp-badge stlp-waiting-card-status">待标注</span>
                    </div>
                </div>
                <button class="menu_button stlp-waiting-card-toggle ${expanded ? "is-expanded" : ""}" type="button" data-action="toggle-waiting-queue-entry" data-run-id="${escapeHtml(runId)}" aria-expanded="${expanded ? "true" : "false"}" aria-label="${expanded ? "收起等待区卡片" : "展开等待区卡片"}" title="${expanded ? "收起等待区卡片" : "展开等待区卡片"}">
                    ${getChevronIconSvg()}
                </button>
            </div>
            ${expanded ? `
            <div class="stlp-waiting-card-body">
                ${buildRunHtml(run, { showWaitingQueueAction: false, showOutputCardAction: false })}
                <div class="stlp-waiting-editor">
                    <label class="stlp-number stlp-waiting-label-field">
                        <span>拓展名称</span>
                        <input
                            type="text"
                            value="${escapeHtml(draftValue)}"
                            data-waiting-label-run-id="${escapeHtml(runId)}"
                            placeholder="例如：记忆书"
                        />
                    </label>
                    <div class="stlp-waiting-helper">确认后会修正当前记录；如果已经有同名规则，这条记录还会自动补成它的新样本。</div>
                    <div class="stlp-waiting-card-actions">
                        <button class="menu_button stlp-inline-button" type="button" data-action="submit-waiting-queue-label" data-run-id="${escapeHtml(runId)}">确认标注</button>
                        <button class="menu_button stlp-inline-button" type="button" data-action="remove-from-waiting-queue" data-run-id="${escapeHtml(runId)}">移出等待区</button>
                    </div>
                </div>
            </div>
            ` : ""}
        </article>
    `;
}

function buildPluginRuleCardHtml(rule) {
    const ruleId = rule?.id || "";
    const sourceLabel = getRunSourceLabel({ source: rule?.source }) || "未限定来源";
    const modelLabel = rule?.model || "未限定模型";
    const updatedAtParts = buildStartedAtDisplayParts(rule?.updated_at || rule?.created_at);
    const sampleCount = Number.isFinite(Number(rule?.sample_count)) ? Number(rule.sample_count) : 0;
    const matchedRuns = Number.isFinite(Number(rule?.matched_runs)) ? Number(rule.matched_runs) : 0;
    const activeRuns = Number.isFinite(Number(rule?.active_runs)) ? Number(rule.active_runs) : 0;
    const pendingRuns = Number.isFinite(Number(rule?.pending_runs)) ? Number(rule.pending_runs) : 0;
    const enabled = rule?.enabled !== false;
    const expanded = isPluginRuleCardExpanded(ruleId);

    return `
        <article class="stlp-waiting-card stlp-waiting-rule-card ${expanded ? "is-expanded" : ""}">
            <div class="stlp-waiting-card-header">
                <div class="stlp-waiting-card-summary stlp-waiting-rule-card-summary">
                    <div class="stlp-waiting-rule-card-headline">
                        <div class="stlp-waiting-card-title">${escapeHtml(rule?.plugin_label || "未命名规则")}</div>
                        ${buildWaitingRuleTimeGroupHtml(updatedAtParts, "stlp-waiting-rule-time-group-inline")}
                    </div>
                    <div class="stlp-waiting-rule-card-controls">
                        <div class="stlp-waiting-rule-card-control-group">
                            ${buildWaitingRuleTimeGroupHtml(updatedAtParts, "stlp-waiting-rule-time-group-secondary")}
                            <span class="stlp-badge stlp-waiting-card-status">${enabled ? "启用中" : "已停用"}</span>
                        </div>
                        <div class="stlp-waiting-rule-card-inline-actions">
                            <button class="menu_button stlp-waiting-rule-action-button stlp-waiting-rule-action-button-inline stlp-waiting-rule-action-button-primary ${enabled ? "is-disable-action" : "is-enable-action"}" type="button" data-action="${enabled ? "disable-plugin-rule" : "enable-plugin-rule"}" data-rule-id="${escapeHtml(ruleId)}">${enabled ? "停用规则" : "启用规则"}</button>
                            <button class="menu_button stlp-waiting-card-toggle ${expanded ? "is-expanded" : ""}" type="button" data-action="toggle-plugin-rule-card" data-rule-id="${escapeHtml(ruleId)}" aria-expanded="${expanded ? "true" : "false"}" aria-label="${expanded ? "收起规则卡片" : "展开规则卡片"}" title="${expanded ? "收起规则卡片" : "展开规则卡片"}">
                                ${getChevronIconSvg()}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            ${expanded ? `
            <div class="stlp-waiting-card-body">
                <div class="stlp-waiting-rule-meta">${escapeHtml(sourceLabel)} · ${escapeHtml(modelLabel)}</div>
                <div class="stlp-waiting-rule-stats">
                    <span class="stlp-badge">样本 ${escapeHtml(sampleCount)}</span>
                    <span class="stlp-badge">已命中 ${escapeHtml(matchedRuns)}</span>
                    <span class="stlp-badge">已生效 ${escapeHtml(activeRuns)}</span>
                    <span class="stlp-badge">${pendingRuns > 0 ? `待处理 ${escapeHtml(pendingRuns)}` : "已追平"}</span>
                </div>
                <div class="stlp-waiting-helper">继续在等待区把同类记录标成同一个拓展名时，系统会自动把新样本补进这条规则，不需要你手动改规则。</div>
                <div class="stlp-waiting-rule-danger-actions">
                    <button class="menu_button stlp-waiting-rule-action-button stlp-waiting-rule-action-button-secondary" type="button" data-action="reapply-plugin-rule" data-rule-id="${escapeHtml(ruleId)}">重新应用</button>
                    <button class="menu_button stlp-waiting-rule-action-button stlp-waiting-rule-action-button-secondary" type="button" data-action="request-remove-plugin-rule" data-rule-id="${escapeHtml(ruleId)}">删除规则</button>
                </div>
            </div>
            ` : ""}
        </article>
    `;
}

function buildPluginRuleGuideHtml() {
    return `
        <div class="stlp-waiting-rule-guide">
            <div class="stlp-waiting-rule-guide-row">
                <div class="stlp-waiting-rule-guide-label">规则控制</div>
                <div class="stlp-waiting-rule-guide-text">已经支持启用、停用和删除。</div>
            </div>
            <div class="stlp-waiting-rule-guide-row">
                <div class="stlp-waiting-rule-guide-label">补样本</div>
                <div class="stlp-waiting-rule-guide-text">不需要手改规则。继续在等待区用同一个拓展名标注同类记录时，系统会自动补样本。</div>
            </div>
        </div>
    `;
}

function buildWaitingQueueViewHtml() {
    if (state.waitingQueueLoading && !state.waitingQueueEntries.length && state.pluginRulesLoading && !state.pluginRules.length) {
        return `
            <section class="stlp-waiting-view">
                <div class="stlp-status-view-title">等待区</div>
                <div class="stlp-waiting-copy">正在加载等待区和规则复用数据。</div>
            </section>
        `;
    }

    const hasEntries = state.waitingQueueEntries.length > 0;
    const hasRules = state.pluginRules.length > 0;
    return `
        <section class="stlp-waiting-view">
            <div class="stlp-status-view-header">
                <div class="stlp-status-view-title-row">
                    <div class="stlp-status-view-title">等待区</div>
                </div>
            </div>
            <div class="stlp-waiting-view-body">
                <div class="stlp-waiting-copy">这里会收纳需要人工确认归属的拓展记录。它不是正文/拓展的切换键，而是临时等待区。你可以先从正文或拓展详情页将记录移入等待区，再在这里输入拓展名称完成标注。</div>
                ${state.waitingQueueError ? `<div class="stlp-waiting-copy">等待区加载失败：${escapeHtml(state.waitingQueueError)}</div>` : ""}
                ${hasEntries
                    ? `<div class="stlp-waiting-list">${state.waitingQueueEntries.map((entry) => buildWaitingQueueEntryHtml(entry)).join("")}</div>`
                    : `<div class="stlp-waiting-empty">当前没有需要标注的拓展记录。若发现有记录误入正文或拓展分区，请前往对应记录的详情页，将其移入等待区后再进行标注。</div>`}
                <section class="stlp-waiting-rule-section">
                    <div class="stlp-settings-subtitle">规则复用</div>
                    ${buildPluginRuleGuideHtml()}
                    ${state.pluginRulesError ? `<div class="stlp-waiting-copy">规则加载失败：${escapeHtml(state.pluginRulesError)}</div>` : ""}
                    ${hasRules
                        ? `<div class="stlp-waiting-list">${state.pluginRules.map((rule) => buildPluginRuleCardHtml(rule)).join("")}</div>`
                        : `<div class="stlp-waiting-empty">当前还没有可复用规则。等你在等待区完成一次手动标注后，这里就会出现对应规则。</div>`}
                </section>
            </div>
        </section>
    `;
}

// 把分组结果摊平成渲染单元：组头单独一行，卡片本身结构不变。
// 不做嵌套是有代价考量的——展开状态 pricingPanelOpenStates 和「仅存本机」都按模型名算，
// 平铺能一行不改地沿用，嵌套就得把这两套状态一起重构。
function buildPricingRenderUnits(pricingModels) {
    const units = [];
    for (const entry of groupPricingModelsByBaseName(pricingModels)) {
        if (entry.kind === "single") {
            units.push({ kind: "model", modelInfo: entry.base });
            continue;
        }

        const groupSize = entry.variants.length + 1;
        units.push({ kind: "group-head", entry });
        units.push({
            kind: "model",
            modelInfo: entry.base,
            inGroup: true,
            baseName: entry.base.model,
            synthesized: entry.baseSynthesized,
            groupSize,
        });
        for (const variant of entry.variants) {
            units.push({
                kind: "model",
                modelInfo: variant,
                inGroup: true,
                isVariant: true,
                baseName: entry.base.model,
                groupSize,
            });
        }
    }
    return units;
}

// 组头只写说明，不写底模名字。名字就印在紧挨着的第一张卡片上，
// 组头再挂一遍会连着出现两次同一个名字——合成出来的组头也一样，它同样有自己的卡片。
function buildPricingGroupHeadHtml(entry) {
    const groupSize = entry.variants.length + 1;
    const note = entry.baseSynthesized
        ? `下面 ${groupSize} 条是同一个模型。第一条的名字你没直接用过，是从其余几条的共同后缀推出来的，价格填在那儿整组都按它算`
        : `下面 ${groupSize} 条是同一个模型，价格配第一条就够`;

    return `
        <div class="stlp-pricing-group-head">
            <span class="stlp-pricing-model-note">${escapeHtml(note)}</span>
        </div>
    `;
}

// 组内提示。真实踩过的坑是：给带前缀的名字单独配了价，反而把统一价格挡掉了。
// 那个"显式配置优先"是 resolveModelPricingEntry 刻意的设计（硅基流动的 Pro/ 付费档
// 得靠它盖住便宜的普通档），改不得，所以只能在这里把话说清楚。
function describePricingGroupNote(unit) {
    if (!unit?.inGroup) {
        return "";
    }

    const baseName = unit.baseName;
    if (!unit.isVariant) {
        return unit.synthesized
            ? "这个名字你没直接用过，是从下面几条的共同后缀推出来的。价格填在这里，整组都按它算。"
            : "价格填在这一条上，同组带前缀的都会自动沿用。";
    }

    if (!hasConfiguredPriceValues(getModelPriceConfig(unit.modelInfo.model) ?? {})) {
        return `没有单独配价时，这条按 ${baseName} 的价格算。`;
    }

    return hasConfiguredPriceValues(getModelPriceConfig(baseName) ?? {})
        ? `这条用的是自己配的价格，不走 ${baseName}。如果不是有意给它单独定价，把下面的价格字段清空就会改用 ${baseName}。`
        : `同组只有这条配了价格，另外 ${unit.groupSize - 1} 条算不出金额。把价格填到 ${baseName} 上，整组就都有了。`;
}

// 关掉采集之后不挂这条，用户只会看到记录停在某一刻，然后来问插件是不是坏了。
function buildRecordingPausedBannerHtml() {
    if (state.settings?.runtime?.recording_enabled !== false) {
        return "";
    }

    return `
        <div class="stlp-recording-paused-banner" role="status">
            <span>记录已暂停，这期间的生成不会被记下。已有记录不受影响。</span>
            <button class="menu_button stlp-inline-button" type="button" data-action="resume-recording">恢复记录</button>
        </div>
    `;
}

// 面板开着的时候星星不在画面里，变色没人看得见，所以这条状态在面板里走横幅。
function buildMainApiErrorBannerHtml() {
    if (!state.mainApiErrorActive || !isMainApiErrorIndicatorEnabled()) {
        return "";
    }

    return `
        <div class="stlp-main-api-error-banner" role="status">
            <span>主 API 上一次请求没有正常完成，详情看排障卡。</span>
            <button class="menu_button stlp-inline-button" type="button" data-action="dismiss-main-api-error">知道了</button>
        </div>
    `;
}

function buildSettingsContentHtml() {
    const displaySettings = state.settings?.display ?? {};
    const runtimeSettings = state.settings?.runtime ?? {};
    const permissionLevel = state.status?.permission_level || state.status?.effective_runtime_mode || "no_backend";
    const disableEnhancedToggle = permissionLevel === "no_backend";
    // 精简版没有落盘的地方，这个开关开了也不会有记录，所以整项不显示。
    const supportsForceStopDiagnostics = permissionLevel !== "no_backend";
    const pricingModels = collectPricingModels();
    const pricingRenderUnits = buildPricingRenderUnits(pricingModels);
    const localOnlyPricedModels = new Set(getLocalOnlyPricedModels());
    const outputCardFields = getOutputCardFields();
    const settingsCategory = normalizeSettingsCategory(state.uiSettings.settingsCategory);
    const minimizedButtonColorMode = normalizeMinimizedButtonColorMode(state.uiSettings.minimizedButtonColorMode);
    const backendRecordActionsContent = `
            <div class="stlp-note">导出记录和清空后台已经从主监控页顶部移到这里，避免顶部操作区过挤。清空会删除当前后台监控记录，导出则保留现有数据。</div>
            <div class="stlp-settings-action-row">
                <button id="stlp_export_runs" class="menu_button stlp-settings-action-button" type="button">导出记录</button>
                <button id="stlp_clear_runs" class="menu_button stlp-settings-action-button stlp-settings-action-button-danger" type="button">清空后台</button>
            </div>
    `;
    const recordingEnabled = runtimeSettings.recording_enabled !== false;
    const runtimeContent = `
            <div class="stlp-controls">
                <label class="checkbox_label stlp-settings-toggle">
                    <input id="stlp_recording_enabled" type="checkbox" ${recordingEnabled ? "checked" : ""} ${state.isSaving ? "disabled" : ""} />
                    <span>记录本次及之后的生成</span>
                </label>
                <div class="stlp-note">关掉之后不再新增任何记录，已经记下的原样保留，照常查看、统计、导出、删除。记录只存在${state.recordSourceMode === "lite" ? "你这个浏览器里" : "你自己这台服务器上"}，不会发给任何第三方。注意：关掉的是记录，不是拦截——插件仍然会在生成请求上补 <code>stream_options.include_usage</code> 以便拿到 token 用量，这一点要等你刷新页面才会停。</div>
                <label class="checkbox_label stlp-settings-toggle">
                    <input id="stlp_show_abnormal_optimization_suggestions" type="checkbox" ${displaySettings.show_abnormal_optimization_suggestions ? "checked" : ""} ${state.isSaving ? "disabled" : ""} />
                    <span>显示异常优化建议</span>
                </label>
                <label class="checkbox_label stlp-settings-toggle">
                    <input id="stlp_show_permission_enhanced_suggestions" type="checkbox" ${displaySettings.show_permission_enhanced_suggestions ? "checked" : ""} ${(state.isSaving || disableEnhancedToggle) ? "disabled" : ""} />
                    <span>显示权限增强建议</span>
                </label>
                ${supportsForceStopDiagnostics ? `
                <label class="checkbox_label stlp-settings-toggle">
                    <input id="stlp_collect_force_stop_diagnostics" type="checkbox" ${runtimeSettings.collect_force_stop_diagnostics ? "checked" : ""} ${state.isSaving ? "disabled" : ""} />
                    <span>采集一键终止诊断</span>
                </label>
                <div class="stlp-note">排查用，默认关。开启后每次点「一键终止」会往 latency-monitor 目录写一条现场快照，供定位终止为什么没生效。这个文件只增不清，排查完记得关掉。</div>
                ` : ""}
                <label class="stlp-number">
                    <span>建议条数上限</span>
                    <input id="stlp_abnormal_optimization_suggestion_limit" type="number" min="2" max="4" step="1" value="${escapeHtml(displaySettings.abnormal_optimization_suggestion_limit ?? 3)}" ${state.isSaving ? "disabled" : ""} />
                </label>
                <label class="stlp-select">
                    <span>建议触发范围</span>
                    <select id="stlp_abnormal_optimization_suggestion_scope" ${state.isSaving ? "disabled" : ""}>
                        <option value="failed_generation_only" ${displaySettings.abnormal_optimization_suggestion_scope === "failed_generation_only" ? "selected" : ""}>仅生成失败/中断相关异常时显示</option>
                        <option value="all_abnormal" ${displaySettings.abnormal_optimization_suggestion_scope === "all_abnormal" ? "selected" : ""}>所有异常时显示</option>
                    </select>
                </label>
                <label class="stlp-number">
                    <span>自动刷新秒数</span>
                    <input id="stlp_auto_refresh_seconds" type="number" min="5" max="120" step="1" value="${escapeHtml(state.uiSettings.autoRefreshSeconds)}" />
                </label>
            </div>
            <div class="stlp-note">
                正常轮次保持安静，只有异常轮次才会显示“查看优化建议”。当前环境为 ${escapeHtml(getPermissionLabel(permissionLevel))}，建议触发范围为 ${escapeHtml(getSuggestionScopeLabel(displaySettings.abnormal_optimization_suggestion_scope))}。
            </div>
            ${buildSettingsSubsectionHtml("runtime_backend_actions", "后台记录", "导出记录 / 清空后台", backendRecordActionsContent)}
    `;

    const outputCardContent = `
            <div class="stlp-settings-subtitle">排障卡</div>
            <div class="stlp-note">排障卡默认只显示核心排障信息和注入概况，卡片较短，手机上通常一屏就能看完。需要更详细的内容时，用下面的开关按需添加。</div>
            <div class="stlp-controls">
                <label class="checkbox_label stlp-settings-toggle">
                    <input id="stlp_output_card_show_injection_details" type="checkbox" ${outputCardFields.showInjectionDetails ? "checked" : ""} />
                    <span>显示注入细项（来源标识 / 提示词来源）</span>
                </label>
                <label class="checkbox_label stlp-settings-toggle">
                    <input id="stlp_output_card_show_pricing_details" type="checkbox" ${outputCardFields.showPricingDetails ? "checked" : ""} />
                    <span>显示费用细项（价格估算 / 缓存相关）</span>
                </label>
                <label class="checkbox_label stlp-settings-toggle">
                    <input id="stlp_output_card_show_context_volume" type="checkbox" ${outputCardFields.showContextVolume ? "checked" : ""} />
                    <span>显示上下文体量（消息数 / 字符数）</span>
                </label>
                <label class="checkbox_label stlp-settings-toggle">
                    <input id="stlp_output_card_show_prompt_volume" type="checkbox" ${outputCardFields.showPromptVolume ? "checked" : ""} />
                    <span>显示提示词体积结论（谁占了大头 / 最大单条）</span>
                </label>
                <label class="checkbox_label stlp-settings-toggle">
                    <input id="stlp_output_card_show_extension_details" type="checkbox" ${outputCardFields.showExtensionDetails ? "checked" : ""} />
                    <span>显示扩展识别细节（标识 / 方式 / 分数）</span>
                </label>
            </div>
    `;

    const pricingContent = `
        <div class="stlp-pricing-section">
            <div class="stlp-settings-subtitle">模型价格估算</div>
            <div class="stlp-note">这里会列出后台已经抓到的模型。每个模型都可以单独选择美元或人民币，填写输入 / 缓存输入 / 输出每 100 万 Token 的价格；详情里的估算金额会跟着这个模型自己的单位显示。峰谷计费按本机时间判断，只需要配置峰时段，其余时间会自动按谷时段计算。</div>
            <div class="stlp-note">费用只按上游返回的 usage 计算。拿不到 usage 的记录不计费，也不会用字符数倒推，所以这里的金额只会偏低、不会偏高。实测这个缺口约 0.1%，但样本来自开发者自用的实例，你那里未必是这个数。</div>
            ${localOnlyPricedModels.size ? `
                <div class="stlp-pricing-sync-notice">
                    <div>有 ${localOnlyPricedModels.size} 个模型的价格只存在这台浏览器里，没有存到服务器。换设备打开会看不到，清掉浏览器数据就会丢失，异常记录的费用也算不出来。</div>
                    <button class="menu_button stlp-pricing-sync-button" type="button" data-action="sync-local-pricing" ${state.isSaving ? "disabled" : ""}>全部同步到服务器</button>
                </div>
            ` : ""}
            ${!pricingModels.length ? `
                <div class="stlp-note">当前还没抓到任何模型。等后台先记录几次生成后，这里会自动列出模型。</div>
            ` : `
                <div class="stlp-pricing-model-list">
                    ${pricingRenderUnits.map((unit) => {
                        if (unit.kind === "group-head") {
                            return buildPricingGroupHeadHtml(unit.entry);
                        }

                        const modelInfo = unit.modelInfo;
                        const modelName = modelInfo.model;
                        const config = getModelPriceConfig(modelName) ?? {};
                        const currency = normalizePricingCurrency(config.currency);
                        const currencyLabel = getPricingCurrencyLabel(currency);
                        const inputPrice = normalizeConfiguredPriceValue(config.input_price_per_million);
                        const cachedInputPrice = normalizeConfiguredPriceValue(config.cached_input_price_per_million);
                        const outputPrice = normalizeConfiguredPriceValue(config.output_price_per_million);
                        const peakValleyEnabled = Boolean(config.peak_valley_enabled);
                        const peakValleyPanelOpen = isPricingPeakValleyPanelOpen(modelName);
                        const peakStartTime = normalizePeakValleyTimeValue(config.peak_start_time);
                        const peakEndTime = normalizePeakValleyTimeValue(config.peak_end_time);
                        const peakInputPrice = normalizeConfiguredPriceValue(config.peak_input_price_per_million);
                        const peakCachedInputPrice = normalizeConfiguredPriceValue(config.peak_cached_input_price_per_million);
                        const peakOutputPrice = normalizeConfiguredPriceValue(config.peak_output_price_per_million);
                        const valleyInputPrice = normalizeConfiguredPriceValue(config.valley_input_price_per_million);
                        const valleyCachedInputPrice = normalizeConfiguredPriceValue(config.valley_cached_input_price_per_million);
                        const valleyOutputPrice = normalizeConfiguredPriceValue(config.valley_output_price_per_million);
                        const inputPriceValue = inputPrice === null || inputPrice === 0 ? "" : escapeHtml(inputPrice);
                        const cachedInputPriceValue = cachedInputPrice === null || cachedInputPrice === 0 ? "" : escapeHtml(cachedInputPrice);
                        const outputPriceValue = outputPrice === null || outputPrice === 0 ? "" : escapeHtml(outputPrice);
                        const peakInputPriceValue = peakInputPrice === null || peakInputPrice === 0 ? "" : escapeHtml(peakInputPrice);
                        const peakCachedInputPriceValue = peakCachedInputPrice === null || peakCachedInputPrice === 0 ? "" : escapeHtml(peakCachedInputPrice);
                        const peakOutputPriceValue = peakOutputPrice === null || peakOutputPrice === 0 ? "" : escapeHtml(peakOutputPrice);
                        const valleyInputPriceValue = valleyInputPrice === null || valleyInputPrice === 0 ? "" : escapeHtml(valleyInputPrice);
                        const valleyCachedInputPriceValue = valleyCachedInputPrice === null || valleyCachedInputPrice === 0 ? "" : escapeHtml(valleyCachedInputPrice);
                        const valleyOutputPriceValue = valleyOutputPrice === null || valleyOutputPrice === 0 ? "" : escapeHtml(valleyOutputPrice);
                        const allowPricingEdit = true;
                        const panelOpen = isPricingPanelOpen(modelName);
                        const usageStatusSummary = modelInfo.supports_usage
                            ? "已记录 usage"
                            : (modelInfo.configured ? "已保存价格" : "暂未记录 usage");
                        const runCountSummary = modelInfo.run_count ? `已抓取 ${modelInfo.run_count} 次` : "暂未抓到记录";
                        const configuredSummary = [
                            inputPrice !== null ? `输入 ${formatPriceValue(inputPrice)}` : "",
                            cachedInputPrice !== null ? `缓存输入 ${formatPriceValue(cachedInputPrice)}` : "",
                            outputPrice !== null ? `输出 ${formatPriceValue(outputPrice)}` : "",
                        ].filter(Boolean).join(" · ");
                        const peakValleySummary = peakValleyEnabled
                            ? `峰时 ${peakStartTime && peakEndTime ? `${peakStartTime} - ${peakEndTime}` : "待补时段"}`
                            : "峰谷未启用";
                        // 自己没配价但能靠剥前缀沿用到别人的，要写出来沿用的是谁，
                        // 免得看着像"待填"而其实一直在按别的单价算钱。
                        const inheritedPricingEntry = hasConfiguredPriceValues(config)
                            ? null
                            : resolveModelPricingEntry(modelName);
                        const inheritedCurrencyLabel = inheritedPricingEntry
                            ? getPricingCurrencyLabel(normalizePricingCurrency(inheritedPricingEntry.config.currency))
                            : "";
                        const compactSummary = configuredSummary
                            ? `${currencyLabel} · ${configuredSummary}`
                            : (inheritedPricingEntry
                                ? `${inheritedCurrencyLabel} · 沿用 ${inheritedPricingEntry.modelName}`
                                : `${currencyLabel} · 价格待填`);
                        const pricingLocalOnly = localOnlyPricedModels.has(modelName);
                        const groupNote = describePricingGroupNote(unit);
                        // 卡片收起时正文是藏着的，而"这条单独定价、把底模盖住了"恰恰最该在列表层面
                        // 就看见，所以折叠标题上也挂一个短标。措辞取中性的"单独定价"：付费档本来就
                        // 该这么配，是不是配错了只有用户自己清楚，判断依据写在正文那句话里。
                        const pricingShadowsBase = Boolean(unit.isVariant) && hasConfiguredPriceValues(config);

                        return `
                            <div class="stlp-pricing-model-card ${panelOpen ? "is-open" : ""} ${unit.inGroup ? "stlp-pricing-model-card-grouped" : ""} ${unit.isVariant ? "stlp-pricing-model-card-variant" : ""}">
                                <button class="stlp-pricing-model-summary" type="button" data-action="toggle-pricing-panel" data-pricing-model="${escapeHtml(modelName)}" aria-expanded="${panelOpen ? "true" : "false"}">
                                    <span class="stlp-pricing-model-summary-main">
                                        <span class="stlp-pricing-model-name">${escapeHtml(modelName)}</span>
                                        <span class="stlp-pricing-model-note">${escapeHtml(compactSummary)}${pricingLocalOnly ? ` · <span class="stlp-pricing-local-only">仅存本机</span>` : ""}${pricingShadowsBase ? ` · <span class="stlp-pricing-group-shadow">单独定价</span>` : ""}</span>
                                    </span>
                                    <span class="stlp-pricing-model-chevron" aria-hidden="true">▾</span>
                                </button>
                                <div class="stlp-pricing-model-body ${panelOpen ? "" : "stlp-hidden"}">
                                    ${groupNote ? `<div class="stlp-pricing-group-note">${escapeHtml(groupNote)}</div>` : ""}
                                    <div class="stlp-pricing-model-meta">
                                        <div class="stlp-pricing-model-note">价格状态：${escapeHtml(usageStatusSummary)}</div>
                                        <div class="stlp-pricing-model-note">抓取记录：${escapeHtml(runCountSummary)}</div>
                                        <div class="stlp-pricing-model-note">峰谷计费：${escapeHtml(peakValleySummary)}</div>
                                    </div>
                                    <div class="stlp-pricing-fields-stack">
                                        <div class="stlp-pricing-inline-row">
                                            <span class="stlp-pricing-inline-label">价格单位</span>
                                            <button class="menu_button stlp-pricing-currency-button" type="button" data-action="pricing-cycle-currency" data-pricing-model="${escapeHtml(modelName)}" ${(state.isSaving || !allowPricingEdit) ? "disabled" : ""}>${escapeHtml(currencyLabel)}</button>
                                        </div>
                                        <label class="stlp-number stlp-pricing-field stlp-pricing-field-vertical">
                                            <span>输入单价（${escapeHtml(currencyLabel)}）</span>
                                            <input type="number" min="0" step="0.1" inputmode="decimal" placeholder="${currencyLabel}，可选" value="${inputPriceValue}" data-pricing-model="${escapeHtml(modelName)}" data-pricing-field="input_price_per_million" ${(state.isSaving || !allowPricingEdit) ? "disabled" : ""} />
                                        </label>
                                        <label class="stlp-number stlp-pricing-field stlp-pricing-field-vertical">
                                            <span>缓存输入单价（${escapeHtml(currencyLabel)}）</span>
                                            <input type="number" min="0" step="0.1" inputmode="decimal" placeholder="${currencyLabel}，可选" value="${cachedInputPriceValue}" data-pricing-model="${escapeHtml(modelName)}" data-pricing-field="cached_input_price_per_million" ${(state.isSaving || !allowPricingEdit) ? "disabled" : ""} />
                                        </label>
                                        <label class="stlp-number stlp-pricing-field stlp-pricing-field-vertical">
                                            <span>输出单价（${escapeHtml(currencyLabel)}）</span>
                                            <input type="number" min="0" step="0.1" inputmode="decimal" placeholder="${currencyLabel}，可选" value="${outputPriceValue}" data-pricing-model="${escapeHtml(modelName)}" data-pricing-field="output_price_per_million" ${(state.isSaving || !allowPricingEdit) ? "disabled" : ""} />
                                        </label>
                                    </div>
                                    <div class="stlp-pricing-actions">
                                        <div class="stlp-pricing-model-note">如果这个模型存在缓存输入折扣，可以单独填写“缓存输入单价”；没填时，命中缓存的输入部分会继续按普通输入单价估算。</div>
                                    </div>
                                    <div class="stlp-pricing-peak-valley-card ${peakValleyPanelOpen ? "is-open" : ""}">
                                        <button class="stlp-pricing-peak-valley-summary" type="button" data-action="toggle-pricing-peak-valley-panel" data-pricing-model="${escapeHtml(modelName)}" aria-expanded="${peakValleyPanelOpen ? "true" : "false"}">
                                            <span class="stlp-pricing-peak-valley-summary-main">
                                                <span class="stlp-pricing-inline-label">峰谷计费</span>
                                                <span class="stlp-pricing-model-note">只配置峰时段，其余时间自动按谷时段。所有判断都按本机时间走。</span>
                                            </span>
                                            <span class="stlp-pricing-peak-valley-status ${peakValleyEnabled ? "is-enabled" : ""}">${peakValleyEnabled ? "已启用" : "未启用"}</span>
                                            <span class="stlp-pricing-model-chevron" aria-hidden="true">▾</span>
                                        </button>
                                        <div class="stlp-pricing-peak-valley-body ${peakValleyPanelOpen ? "" : "stlp-hidden"}">
                                            <label class="checkbox_label stlp-settings-toggle stlp-pricing-peak-valley-toggle">
                                                <input type="checkbox" data-pricing-model="${escapeHtml(modelName)}" data-pricing-field="peak_valley_enabled" ${peakValleyEnabled ? "checked" : ""} ${(state.isSaving || !allowPricingEdit) ? "disabled" : ""} />
                                                <span>启用峰谷计费</span>
                                            </label>
                                            <div class="stlp-pricing-model-note">只需要填写峰时段起止，未落在这个时间段的请求会自动按谷时段价格估算。峰谷价格如果有空项，会回退到上面的普通单价。</div>
                                            <div class="stlp-pricing-time-grid">
                                                <label class="stlp-number stlp-pricing-field stlp-pricing-field-vertical">
                                                    <span>峰时开始</span>
                                                    <input type="time" value="${escapeHtml(peakStartTime)}" data-pricing-model="${escapeHtml(modelName)}" data-pricing-field="peak_start_time" ${(state.isSaving || !allowPricingEdit) ? "disabled" : ""} />
                                                </label>
                                                <label class="stlp-number stlp-pricing-field stlp-pricing-field-vertical">
                                                    <span>峰时结束</span>
                                                    <input type="time" value="${escapeHtml(peakEndTime)}" data-pricing-model="${escapeHtml(modelName)}" data-pricing-field="peak_end_time" ${(state.isSaving || !allowPricingEdit) ? "disabled" : ""} />
                                                </label>
                                            </div>
                                            <div class="stlp-pricing-band-grid">
                                                <div class="stlp-pricing-band-column">
                                                    <div class="stlp-pricing-inline-label">峰时价格</div>
                                                    <label class="stlp-number stlp-pricing-field stlp-pricing-field-vertical">
                                                        <span>输入单价（${escapeHtml(currencyLabel)}）</span>
                                                        <input type="number" min="0" step="0.1" inputmode="decimal" placeholder="${currencyLabel}，可选" value="${peakInputPriceValue}" data-pricing-model="${escapeHtml(modelName)}" data-pricing-field="peak_input_price_per_million" ${(state.isSaving || !allowPricingEdit) ? "disabled" : ""} />
                                                    </label>
                                                    <label class="stlp-number stlp-pricing-field stlp-pricing-field-vertical">
                                                        <span>缓存输入单价（${escapeHtml(currencyLabel)}）</span>
                                                        <input type="number" min="0" step="0.1" inputmode="decimal" placeholder="${currencyLabel}，可选" value="${peakCachedInputPriceValue}" data-pricing-model="${escapeHtml(modelName)}" data-pricing-field="peak_cached_input_price_per_million" ${(state.isSaving || !allowPricingEdit) ? "disabled" : ""} />
                                                    </label>
                                                    <label class="stlp-number stlp-pricing-field stlp-pricing-field-vertical">
                                                        <span>输出单价（${escapeHtml(currencyLabel)}）</span>
                                                        <input type="number" min="0" step="0.1" inputmode="decimal" placeholder="${currencyLabel}，可选" value="${peakOutputPriceValue}" data-pricing-model="${escapeHtml(modelName)}" data-pricing-field="peak_output_price_per_million" ${(state.isSaving || !allowPricingEdit) ? "disabled" : ""} />
                                                    </label>
                                                </div>
                                                <div class="stlp-pricing-band-column">
                                                    <div class="stlp-pricing-inline-label">谷时价格</div>
                                                    <label class="stlp-number stlp-pricing-field stlp-pricing-field-vertical">
                                                        <span>输入单价（${escapeHtml(currencyLabel)}）</span>
                                                        <input type="number" min="0" step="0.1" inputmode="decimal" placeholder="${currencyLabel}，可选" value="${valleyInputPriceValue}" data-pricing-model="${escapeHtml(modelName)}" data-pricing-field="valley_input_price_per_million" ${(state.isSaving || !allowPricingEdit) ? "disabled" : ""} />
                                                    </label>
                                                    <label class="stlp-number stlp-pricing-field stlp-pricing-field-vertical">
                                                        <span>缓存输入单价（${escapeHtml(currencyLabel)}）</span>
                                                        <input type="number" min="0" step="0.1" inputmode="decimal" placeholder="${currencyLabel}，可选" value="${valleyCachedInputPriceValue}" data-pricing-model="${escapeHtml(modelName)}" data-pricing-field="valley_cached_input_price_per_million" ${(state.isSaving || !allowPricingEdit) ? "disabled" : ""} />
                                                    </label>
                                                    <label class="stlp-number stlp-pricing-field stlp-pricing-field-vertical">
                                                        <span>输出单价（${escapeHtml(currencyLabel)}）</span>
                                                        <input type="number" min="0" step="0.1" inputmode="decimal" placeholder="${currencyLabel}，可选" value="${valleyOutputPriceValue}" data-pricing-model="${escapeHtml(modelName)}" data-pricing-field="valley_output_price_per_million" ${(state.isSaving || !allowPricingEdit) ? "disabled" : ""} />
                                                    </label>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join("")}
                </div>
            `}
        </div>
    `;

    const minimizedButtonCustomColor = normalizeMinimizedButtonCustomColor(state.uiSettings.minimizedButtonCustomColor);
    const minimizedButtonStrokeColor = normalizeMinimizedButtonStrokeColor(state.uiSettings.minimizedButtonStrokeColor);
    const minimizedButtonBorderColor = normalizeMinimizedButtonBorderColor(state.uiSettings.minimizedButtonBorderColor);
    const minimizedButtonBorderVisible = isMinimizedButtonBorderVisible();
    const mainApiErrorIndicatorEnabled = isMainApiErrorIndicatorEnabled();
    const mainApiErrorClearOnRegenerate = isMainApiErrorClearOnRegenerateEnabled();
    const minimizedButtonOpacityPercent = getMinimizedButtonOpacityPercent();
    const isMinimizedButtonFollowingTheme = minimizedButtonColorMode === "follow_theme";
    const themeSummary = getThemeModeLabel(state.uiSettings.themeMode).replace("主题：", "");
    const minimizedIconSummary = `${isMinimizedButtonFollowingTheme ? "主色跟随酒馆" : `主色 ${minimizedButtonCustomColor.toUpperCase()}`} · 描边 ${minimizedButtonStrokeColor.toUpperCase()} · 外圈 ${minimizedButtonBorderVisible ? minimizedButtonBorderColor.toUpperCase() : "已隐藏"} · 不透明度 ${minimizedButtonOpacityPercent}%`;
    const themeSubsectionBody = `
            <div class="stlp-segmented-control" role="group" aria-label="面板主题">
                ${THEME_MODE_SEQUENCE.map((mode) => `
                    <button class="menu_button stlp-segmented-option ${normalizeThemeMode(state.uiSettings.themeMode) === mode ? "is-selected" : ""}" type="button" data-action="set-theme-mode" data-theme-mode="${escapeHtml(mode)}" aria-pressed="${normalizeThemeMode(state.uiSettings.themeMode) === mode ? "true" : "false"}">${escapeHtml(mode === "follow_tavern" ? "跟随酒馆" : getThemeModeLabel(mode).replace("主题：", ""))}</button>
                `).join("")}
            </div>
    `;
    const minimizedIconSubsectionBody = `
            <label class="checkbox_label stlp-settings-toggle">
                <input id="stlp_minimized_button_follow_theme_color" type="checkbox" ${isMinimizedButtonFollowingTheme ? "checked" : ""} />
                <span>最小化图标配色跟随酒馆主题</span>
            </label>
            <label class="stlp-color-wheel-field ${isMinimizedButtonFollowingTheme ? "is-disabled" : ""}">
                <span>星星主色</span>
                <div class="stlp-color-wheel-row">
                    <input id="stlp_minimized_button_custom_color" class="stlp-color-wheel-input" type="color" value="${escapeHtml(minimizedButtonCustomColor)}" ${isMinimizedButtonFollowingTheme ? "disabled" : ""} />
                    <span class="stlp-color-wheel-hint">点击打开色轮选择</span>
                    <span class="stlp-color-wheel-value">${escapeHtml(minimizedButtonCustomColor.toUpperCase())}</span>
                </div>
            </label>
            <label class="stlp-color-wheel-field">
                <span>星星描边</span>
                <div class="stlp-color-wheel-row">
                    <input id="stlp_minimized_button_stroke_color" class="stlp-color-wheel-input" type="color" value="${escapeHtml(minimizedButtonStrokeColor)}" />
                    <span class="stlp-color-wheel-hint">点击打开色轮选择描边颜色</span>
                    <span class="stlp-color-wheel-value">${escapeHtml(minimizedButtonStrokeColor.toUpperCase())}</span>
                </div>
            </label>
            <label class="checkbox_label stlp-settings-toggle">
                <input id="stlp_minimized_button_border_visible" type="checkbox" ${minimizedButtonBorderVisible ? "checked" : ""} />
                <span>显示图标外圈</span>
            </label>
            <label class="stlp-color-wheel-field ${minimizedButtonBorderVisible ? "" : "is-disabled"}">
                <span>外圈边框</span>
                <div class="stlp-color-wheel-row">
                    <input id="stlp_minimized_button_border_color" class="stlp-color-wheel-input" type="color" value="${escapeHtml(minimizedButtonBorderColor)}" ${minimizedButtonBorderVisible ? "" : "disabled"} />
                    <span class="stlp-color-wheel-hint">图标外面那一圈细边</span>
                    <span class="stlp-color-wheel-value">${escapeHtml(minimizedButtonBorderVisible ? minimizedButtonBorderColor.toUpperCase() : "已隐藏")}</span>
                </div>
            </label>
            <label class="stlp-slider-field">
                <span>整体不透明度</span>
                <div class="stlp-slider-row">
                    <input id="stlp_minimized_button_opacity" class="stlp-slider-input" type="range" min="${Math.round(MINIMIZED_BUTTON_OPACITY_MIN * 100)}" max="100" step="5" value="${minimizedButtonOpacityPercent}" />
                    <span class="stlp-slider-value" data-stlp-opacity-value>${minimizedButtonOpacityPercent}%</span>
                </div>
            </label>
            <div class="stlp-note">按钮背景本来就是透明的，能看见的只有星星、描边和外圈这三样，三者都能单独选色，外圈还可以整个关掉。不透明度最低 ${Math.round(MINIMIZED_BUTTON_OPACITY_MIN * 100)}%——它是唤回面板的唯一入口，留一点可见度才找得回来。后台连不上时图标会变红，这个红同样跟着不透明度走。</div>
    `;
    const mainApiAlertSummary = mainApiErrorIndicatorEnabled
        ? `已开启 · ${mainApiErrorClearOnRegenerate ? "重新生成时先复原" : "等下次成功才复原"}`
        : "已关闭";
    const mainApiAlertSubsectionBody = `
            <label class="checkbox_label stlp-settings-toggle">
                <input id="stlp_main_api_error_indicator_enabled" type="checkbox" ${mainApiErrorIndicatorEnabled ? "checked" : ""} />
                <span>主 API 出错时提醒</span>
            </label>
            <div class="stlp-note">开着的话：主 API 请求报错、超时或中途断流时，收起的星星会变红；面板正开着的时候星星看不见，改在顶部显示一条横幅。你自己点停止不算出错。星星点开面板、或者横幅上点"知道了"，都算确认过，提醒立刻消失；下一次请求正常完成也会自动复原。</div>
            <label class="checkbox_label stlp-settings-toggle ${mainApiErrorIndicatorEnabled ? "" : "is-disabled"}">
                <input id="stlp_main_api_error_clear_on_regenerate" type="checkbox" ${mainApiErrorClearOnRegenerate ? "checked" : ""} ${mainApiErrorIndicatorEnabled ? "" : "disabled"} />
                <span>重新生成时先复原颜色</span>
            </label>
            <div class="stlp-note">勾上之后，只要你再发起一次生成，星星立刻回到平时的颜色，不用等这次跑完——正常发送、重新生成、滑动、续写、替我说都算，只有后台静默的请求不算。叫"先"复原是因为它可能是暂时的：这次要是又出错，收尾时还会再变红。不勾就一直红到下一次真的成功为止。</div>
    `;
    const appearanceContent = `
            <div class="stlp-settings-subtitle">外观与主题</div>
            <div class="stlp-note">调整面板主题和最小化悬浮图标的外观。悬浮图标平时显示你选的颜色，后台连不上时会自动变红，方便一眼看出监控是不是还在正常工作。</div>
            ${buildSettingsSubsectionHtml("appearance_theme", "面板主题", themeSummary, themeSubsectionBody)}
            ${buildSettingsSubsectionHtml("appearance_minimized_color", "最小图标选色", minimizedIconSummary, minimizedIconSubsectionBody)}
            ${buildSettingsSubsectionHtml("appearance_main_api_alert", "主 API 出错提醒", mainApiAlertSummary, mainApiAlertSubsectionBody)}
    `;

    const categoryCards = [
        { key: "runtime", label: "运行与建议", body: runtimeContent },
        { key: "output_card", label: "排障卡", body: outputCardContent },
        { key: "pricing", label: "价格估算", body: pricingContent },
        { key: "appearance", label: "外观与主题", body: appearanceContent },
    ];

    return `
            ${buildLegacyLiteRunsNoticeHtml()}
            <div class="stlp-settings-view-note">设置项已经按功能归类，点开对应分区就能直接调整。</div>
            <div class="stlp-settings-category-list">
                ${categoryCards.map((item) => {
                    const active = settingsCategory === item.key;
                    return `
                        <section class="stlp-settings-category-card ${active ? "is-open" : ""}">
                            <button class="stlp-settings-category-button" type="button" data-action="set-settings-category" data-settings-category="${escapeHtml(item.key)}" aria-expanded="${active ? "true" : "false"}">
                                <span>${escapeHtml(item.label)}</span>
                                <span class="stlp-settings-category-chevron" aria-hidden="true">▾</span>
                            </button>
                            <div class="stlp-settings-category-body ${active ? "" : "stlp-hidden"}">
                                ${item.body}
                            </div>
                        </section>
                    `;
                }).join("")}
            </div>
    `;
}

// 升级到完整版之后，精简模式那批记录还躺在浏览器里但面板不再读它们。
// 不声不响地让它们消失最糟糕——用户只会觉得"数据丢了"。这里把它摆出来并给出去路。
function buildLegacyLiteRunsNoticeHtml() {
    if (state.legacyLiteViewing) {
        return `<div class="stlp-empty stlp-empty-alert">
            <strong>正在查看升级前的本地记录</strong>
            这些是精简模式时记在浏览器里的，耗时口径和后端不同（含酒馆自身的处理时间），所以没有并进统计。
            <div class="stlp-legacy-lite-actions">
                <button class="menu_button stlp-inline-button" type="button" data-action="legacy-lite-view-off">切回后端记录</button>
            </div>
        </div>`;
    }

    if (state.recordSourceMode !== "full" || state.legacyLiteRunCount <= 0) {
        return "";
    }

    return `<div class="stlp-empty stlp-empty-alert">
        <strong>浏览器里还留着 ${escapeHtml(String(state.legacyLiteRunCount))} 条旧记录</strong>
        这是你装后端之前、精简模式记下来的。它们的耗时口径和后端不一样，混进统计会让平均值失真，所以这里不会自动合并。
        <div class="stlp-legacy-lite-actions">
            <button class="menu_button stlp-inline-button" type="button" data-action="legacy-lite-view-on">单独查看</button>
            <button class="menu_button stlp-inline-button" type="button" data-action="legacy-lite-export">导出为 JSON</button>
            <button class="menu_button stlp-inline-button" type="button" data-action="legacy-lite-clear">清除</button>
        </div>
    </div>`;
}

function buildSettingsViewHtml() {
    return `
        <section class="stlp-section is-open stlp-settings-view">
            <div class="stlp-section-body">
                <div class="stlp-settings-view-title">设置</div>
                ${buildSettingsContentHtml()}
            </div>
        </section>
    `;
}

function buildDailyAbnormalListText(items) {
    if (!Array.isArray(items) || !items.length) {
        return "-";
    }

    return items
        .map((item) => `${getAbnormalTypeLabel(item?.value)} x${formatCount(Number(item?.count) || 0)}`)
        .join(" / ");
}

// 后端给的是"当前口径下最早有数据的那一天"，换算成从那天到今天跨了几个自然日。
// 口径与后端的天数窗口一致：N 天窗口覆盖 今天-(N-1) 到今天，共 N 个自然日。
function getDailySummaryScopeSpanDays(earliestDateKey) {
    if (typeof earliestDateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(earliestDateKey)) {
        return 0;
    }

    const earliest = new Date(`${earliestDateKey}T00:00:00`);
    if (Number.isNaN(earliest.getTime())) {
        return 0;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((today.getTime() - earliest.getTime()) / 86400000);
    return diffDays >= 0 ? diffDays + 1 : 0;
}

function isDailySummaryRowExpanded(dateKey) {
    return typeof dateKey === "string" && dateKey
        ? state.expandedDailySummaryDateKeys.has(dateKey)
        : false;
}

function buildCallTimerDetailRowHtml(run) {
    const generationTypeLabel = getRunGenerationTypeLabel(run);
    const purposeLabel = getRequestPurposeLabel(run?.request_purpose);
    const runId = run?.id || "";
    // 展开态和历史记录共用 state.expandedRunIds：同一条记录在哪一页展开都一致，
    // 也省得再维护一套清理逻辑。
    const expanded = state.expandedRunIds.has(runId);
    return `
        <div class="stlp-call-timer-row ${expanded ? "is-expanded" : ""}">
            <div class="stlp-call-timer-cell stlp-call-timer-cell-time">${escapeHtml(formatStartedAtCompact(run?.started_at_iso))}</div>
            <div class="stlp-call-timer-cell">${escapeHtml(generationTypeLabel ? `${purposeLabel} · ${generationTypeLabel}` : purposeLabel)}</div>
            <div class="stlp-call-timer-cell stlp-call-timer-cell-source">${escapeHtml(getCallTimerRunSourceLabel(run))}</div>
            <div class="stlp-call-timer-cell stlp-call-timer-cell-model">${escapeHtml(run?.model || "未记录模型")}</div>
            <div class="stlp-call-timer-cell stlp-call-timer-cell-duration">${escapeHtml(formatSeconds(run?.metrics?.total_ms))}</div>
            <div class="stlp-call-timer-cell stlp-call-timer-cell-expand">
                <button class="menu_button stlp-call-timer-expand-button ${expanded ? "is-expanded" : ""}" type="button" data-action="toggle-run" data-run-id="${escapeHtml(runId)}" aria-expanded="${expanded ? "true" : "false"}" aria-label="${expanded ? "收起这条详情" : "展开这条详情"}" title="${expanded ? "收起这条详情" : "展开这条详情"}">
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
            </div>
        </div>
        ${expanded ? `<div class="stlp-call-timer-detail-card">${buildRunHtml(run, { showSummary: false })}</div>` : ""}
    `;
}

// 本次和历史两张卡片显示的内容完全一样，只是窗口不同，所以共用这一份。
// scope 只用来把两边的"逐条明细"折叠状态分开，取值 "current" / "history"。
function buildCallTimerStatsHtml(timerWindow, scope) {
    const runs = getCallTimerRunsInWindow(timerWindow);
    const groups = buildCallTimerGroups(runs);
    const detailRuns = runs.slice(0, CALL_TIMER_DETAIL_LIMIT);
    const detailExpanded = isCallTimerDetailExpanded(scope);

    return `
        <div class="stlp-settings-subtitle">这段时间内共 ${runs.length} 次调用</div>
        ${groups.length
            ? `<div class="stlp-call-timer-groups">${groups.map((group) => `
                <div class="stlp-call-timer-group">
                    <span class="stlp-call-timer-group-label">${escapeHtml(group.label)}</span>
                    <span class="stlp-badge">${group.count} 次</span>
                </div>
            `).join("")}</div>
               ${state.recordSourceMode === "lite" ? `<div class="stlp-note">精简版没有后端指纹，拓展要先在等待区手动标注一次才认得出来，否则会归到"${escapeHtml(CALL_TIMER_SOURCE_UNKNOWN_PLUGIN)}"。</div>` : ""}`
            : `<div class="stlp-waiting-empty">这段时间内没有任何调用记录。</div>
               ${timerWindow.running ? `<div class="stlp-note">记录是在一次调用<strong>结束</strong>时才落盘的，所以生成还没跑完时这里是空的，属正常。页面每 ${Math.round(CALL_TIMER_POLL_INTERVAL_MS / 1000)} 秒自动补一次数据。</div>` : ""}`}

        ${detailRuns.length ? `
            <div class="stlp-call-timer-details">
                <button class="stlp-call-timer-detail-bar ${detailExpanded ? "is-expanded" : ""}" type="button" data-action="toggle-call-timer-details" data-call-timer-scope="${escapeHtml(scope)}" aria-expanded="${detailExpanded ? "true" : "false"}">
                    <span class="stlp-call-timer-detail-bar-label">逐条明细 · ${runs.length} 条</span>
                    <span class="stlp-call-timer-detail-bar-icon ${detailExpanded ? "is-expanded" : ""}">${getChevronIconSvg()}</span>
                </button>
                ${detailExpanded ? `
                    <div class="stlp-call-timer-table">
                        <div class="stlp-call-timer-row stlp-call-timer-row-head">
                            <div class="stlp-call-timer-cell stlp-call-timer-cell-time">时间</div>
                            <div class="stlp-call-timer-cell">类型</div>
                            <div class="stlp-call-timer-cell stlp-call-timer-cell-source">来源</div>
                            <div class="stlp-call-timer-cell stlp-call-timer-cell-model">模型</div>
                            <div class="stlp-call-timer-cell stlp-call-timer-cell-duration">耗时</div>
                            <div class="stlp-call-timer-cell stlp-call-timer-cell-expand"></div>
                        </div>
                        ${detailRuns.map((run) => buildCallTimerDetailRowHtml(run)).join("")}
                    </div>
                    ${runs.length > detailRuns.length ? `<div class="stlp-note">条数太多，只列出最近 ${CALL_TIMER_DETAIL_LIMIT} 条，上面的计数仍是全部 ${runs.length} 条。</div>` : ""}
                ` : ""}
            </div>
        ` : ""}
    `;
}

function buildCallTimerViewHtml() {
    const timerWindow = getCallTimerWindow();
    const hasWindow = Boolean(timerWindow.startedAtMs);
    const currentGroups = buildCallTimerGroups(getCallTimerRunsInWindow(timerWindow));
    const expectedSources = normalizeCallTimerExpectedSources(state.uiSettings.callTimerExpectedSources);
    const missingSources = getCallTimerMissingSources(currentGroups);
    const sessions = normalizeCallTimerSessions(state.uiSettings.callTimerSessions);
    const elapsedText = hasWindow ? formatCallTimerDuration(timerWindow.endMs - timerWindow.startedAtMs) : "0:00";
    const historySession = getCallTimerHistorySession();
    const historyWindow = historySession ? getCallTimerSessionWindow(historySession) : null;

    return `
        <section class="stlp-call-timer-view">
            <div class="stlp-status-view-header">
                <div class="stlp-status-view-title">区间统计</div>
                <div class="stlp-note">数一段时间内一共发生了多少次调用、分别是谁发的，用来确认记忆书这类拓展是不是都触发过一遍。</div>
            </div>

            <div class="stlp-call-timer-card">
                <div class="stlp-call-timer-card-title">本次区间</div>

                <div class="stlp-call-timer-control">
                    <div class="stlp-call-timer-readout">
                        <div class="stlp-call-timer-elapsed" data-call-timer-elapsed>${escapeHtml(elapsedText)}</div>
                        <div class="stlp-call-timer-range">${hasWindow
                            ? `${escapeHtml(formatStartedAtCompact(new Date(timerWindow.startedAtMs).toISOString()))} 起${timerWindow.running ? "，计时中" : `，到 ${escapeHtml(formatStartedAtCompact(new Date(timerWindow.endMs).toISOString()))}`}`
                            : "还没开始计时"}</div>
                    </div>
                    <div class="stlp-call-timer-buttons">
                        ${timerWindow.running
                            ? `<button class="menu_button stlp-inline-button" type="button" data-action="stop-call-timer">停止计时</button>`
                            : `<button class="menu_button stlp-inline-button" type="button" data-action="start-call-timer">开始计时</button>`}
                        <button class="menu_button stlp-inline-button" type="button" data-action="refresh-call-timer" ${state.callTimerLoading ? "disabled" : ""}>${state.callTimerLoading ? "刷新中" : "刷新"}</button>
                        ${hasWindow ? `<button class="menu_button stlp-inline-button" type="button" data-action="clear-call-timer" title="丢掉当前这段计时，历史区间和调用记录都不受影响">清理本次</button>` : ""}
                    </div>
                </div>

                ${state.callTimerError ? `<div class="stlp-waiting-copy">读取记录失败：${escapeHtml(state.callTimerError)}</div>` : ""}
                ${isCallTimerWindowTruncated(timerWindow) ? `<div class="stlp-call-timer-warning">只取到最近 ${state.callTimerLoadedLimit} 条记录，而计时起点比其中最早的一条还早，这次统计并不完整。点"刷新"可以拉取更多。</div>` : ""}

                ${hasWindow
                    ? buildCallTimerStatsHtml(timerWindow, "current")
                    : `<div class="stlp-waiting-empty">点"开始计时"划定一段时间，期间发生的调用都会被清点出来。</div>`}

                <div class="stlp-call-timer-section">
                    <div class="stlp-settings-subtitle">未触发清单</div>
                    ${expectedSources.length ? `
                        ${missingSources.length
                            ? `<div class="stlp-call-timer-missing">${missingSources.map((label) => `<span class="stlp-badge stlp-badge-abnormal">${escapeHtml(label)}</span>`).join("")}</div>
                               <div class="stlp-note">这些来源在期望名单里，但这段时间内没出现。</div>`
                            : `<div class="stlp-note">期望名单里的 ${expectedSources.length} 个来源这段时间内都出现过。</div>`}
                        <div class="stlp-waiting-card-actions">
                            <button class="menu_button stlp-inline-button" type="button" data-action="save-call-timer-expected">用本次结果覆盖名单</button>
                            <button class="menu_button stlp-inline-button" type="button" data-action="clear-call-timer-expected">清空名单</button>
                        </div>
                    ` : `
                        <div class="stlp-note">先跑一次"全都该触发"的完整区间，把结果存成期望名单；之后每次计时都会拿当前结果和名单比对，缺的列在这里。名单按来源名称精确比对。只比对本次，不看历史区间。</div>
                        <div class="stlp-waiting-card-actions">
                            <button class="menu_button stlp-inline-button" type="button" data-action="save-call-timer-expected" ${currentGroups.length ? "" : "disabled"}>把本次出现的来源存为期望名单</button>
                        </div>
                    `}
                </div>
            </div>

            ${sessions.length ? `
                <div class="stlp-call-timer-card">
                    <div class="stlp-call-timer-card-title">历史区间调用</div>
                    <div class="stlp-call-timer-sessions">
                        ${sessions.map((session) => {
                            const active = session.id === state.callTimerHistorySessionId;
                            return `
                            <button class="menu_button stlp-inline-button ${active ? "is-active" : ""}" type="button" data-action="view-call-timer-session" data-session-id="${escapeHtml(session.id)}" aria-pressed="${active ? "true" : "false"}">
                                ${escapeHtml(formatStartedAtCompact(new Date(session.startedAtMs).toISOString()))} · ${escapeHtml(formatCallTimerDuration(session.stoppedAtMs - session.startedAtMs))}
                            </button>
                        `;
                        }).join("")}
                    </div>
                    <div class="stlp-note">点一段就在下面单独展开它的调用内容，上面那张"本次区间"不受影响，两边可以对着看。最多留 ${CALL_TIMER_MAX_SESSIONS} 段。</div>

                    ${historySession ? `
                        <div class="stlp-call-timer-history-detail">
                            <div class="stlp-call-timer-history-detail-header">
                                <div class="stlp-call-timer-history-detail-range">${escapeHtml(formatStartedAtCompact(new Date(historySession.startedAtMs).toISOString()))} 起，到 ${escapeHtml(formatStartedAtCompact(new Date(historySession.stoppedAtMs).toISOString()))}，历时 ${escapeHtml(formatCallTimerDuration(historySession.stoppedAtMs - historySession.startedAtMs))}</div>
                                <button class="menu_button stlp-inline-button" type="button" data-action="view-call-timer-session" data-session-id="${escapeHtml(historySession.id)}">收起</button>
                            </div>
                            ${isCallTimerWindowTruncated(historyWindow) ? `<div class="stlp-call-timer-warning">只取到最近 ${state.callTimerLoadedLimit} 条记录，而这一段的起点比其中最早的一条还早，它的统计并不完整。点上面的"刷新"可以拉取更多。</div>` : ""}
                            ${buildCallTimerStatsHtml(historyWindow, "history")}
                        </div>
                    ` : ""}
                </div>
            ` : ""}

        </section>
    `;
}

function buildDailySummaryViewHtml() {
    const dailySummary = state.dailySummary;
    const rows = Array.isArray(dailySummary?.rows) ? dailySummary.rows : [];
    const summary = dailySummary?.summary ?? null;
    const activeDays = normalizeDailySummaryDays(state.uiSettings.dailySummaryDays);
    const scopeMode = normalizeSummaryText(dailySummary?.scope_mode) || "global";
    const scopeLabel = normalizeSummaryText(dailySummary?.scope_label) || "全部用途";
    const scopeTagLabel = scopeMode === "chat_view" ? "聊天聚合" : "总聚合";
    const aggregatePromptTokens = rows.reduce((total, row) => total + (Number(row?.prompt_tokens) || 0), 0);
    const aggregateCompletionTokens = rows.reduce((total, row) => total + (Number(row?.completion_tokens) || 0), 0);
    const aggregateTotalTokens = rows.reduce((total, row) => total + (Number(row?.total_tokens) || 0), 0);
    const aggregateAbnormalRuns = rows.reduce((total, row) => total + (Number(row?.abnormal_runs) || 0), 0);
    const aggregateTotalRuns = rows.reduce((total, row) => total + (Number(row?.total_runs) || 0), 0);
    const aggregateAbnormalRate = aggregateTotalRuns ? (aggregateAbnormalRuns / aggregateTotalRuns) * 100 : 0;
    const scopeEarliestDateKey = normalizeSummaryText(dailySummary?.scope_earliest_date_key) || "";
    const scopeTotalDays = Math.max(0, Number(dailySummary?.scope_total_days) || 0);
    const scopeSpanDays = getDailySummaryScopeSpanDays(scopeEarliestDateKey);
    // 聊天口径下 request_chat_key 是后加的字段，老记录没有，所以经常出现"选再多天也捞不到更多数据"。
    // 这不是坏了，但必须说出来，否则看起来就是点了没反应。
    const hasBeyondRangeOption = scopeSpanDays > 0
        && DAILY_SUMMARY_DAY_OPTIONS.some((days) => days > scopeSpanDays);
    const scopeRangeNote = hasBeyondRangeOption
        ? `该${scopeLabel}最早的记录是 ${formatDateKeyLabel(scopeEarliestDateKey)}，共 ${formatCount(scopeTotalDays)} 天有数据。超过 ${formatCount(scopeSpanDays)} 天的窗口已经覆盖全部记录，再往前放大不会有变化。`
        : "";

    return `
        <section class="stlp-section is-open stlp-daily-summary-view">
            <div class="stlp-section-body">
                <div class="stlp-settings-view-title">日聚合</div>
                <div class="stlp-daily-summary-scope">
                    <span class="stlp-daily-summary-scope-badge">${escapeHtml(scopeTagLabel)}</span>
                    <span class="stlp-daily-summary-scope-text">${escapeHtml(scopeLabel)}</span>
                </div>
                <div class="stlp-note">这里只看最近 ${escapeHtml(activeDays)} 天的${escapeHtml(scopeLabel)} Tokens、异常率和耗时走势，不做金额汇总。若某些流式记录 Usage 曾经落成 0，历史统计可能偏低。</div>
                <div class="stlp-daily-summary-filters">
                    ${DAILY_SUMMARY_DAY_OPTIONS.map((days) => {
                        const beyondRange = scopeSpanDays > 0 && days > scopeSpanDays;
                        const buttonTitle = beyondRange
                            ? `当前口径只有 ${formatCount(scopeSpanDays)} 天的记录，${days} 天与之结果相同`
                            : `按最近 ${days} 天聚合`;
                        return `
                        <button class="menu_button stlp-daily-summary-filter ${days === activeDays ? "is-active" : ""} ${beyondRange ? "is-beyond-range" : ""}" type="button" data-action="set-daily-summary-days" data-days="${days}" aria-pressed="${days === activeDays ? "true" : "false"}" title="${escapeHtml(buttonTitle)}">${days} 天</button>
                    `;
                    }).join("")}
                </div>
                ${scopeRangeNote ? `<div class="stlp-note stlp-daily-summary-range-note">${escapeHtml(scopeRangeNote)}</div>` : ""}
                ${summary ? `
                    <div class="stlp-grid">
                        <div><strong>总记录数</strong><span>${escapeHtml(formatCount(aggregateTotalRuns))}</span></div>
                        <div><strong>异常率</strong><span>${escapeHtml(formatPercent(aggregateAbnormalRate))}</span></div>
                        <div><strong>Total Tokens</strong><span>${escapeHtml(formatCount(aggregateTotalTokens))}</span></div>
                        <div><strong>Prompt / Completion</strong><span>${escapeHtml(`${formatCount(aggregatePromptTokens)} / ${formatCount(aggregateCompletionTokens)}`)}</span></div>
                        <div><strong>缓存命中率</strong><span>${escapeHtml(formatPercent(summary.cache_hit_rate))}</span></div>
                        <div><strong>平均总耗时</strong><span>${escapeHtml(formatSeconds(summary.avg_total_ms))}</span></div>
                        <div><strong>平均首个输出</strong><span>${escapeHtml(formatSeconds(summary.avg_ttft_ms))}</span></div>
                    </div>
                ` : ""}
                ${rows.length ? `
                    <div class="stlp-daily-summary-list">
                        ${rows.slice().reverse().map((row) => {
                            const dateKey = typeof row?.date_key === "string" ? row.date_key : "";
                            const expanded = isDailySummaryRowExpanded(dateKey);
                            return `
                            <article class="stlp-daily-summary-card ${expanded ? "is-expanded" : ""}">
                                <div class="stlp-daily-summary-card-header">
                                    <div class="stlp-daily-summary-card-summary">
                                        <div class="stlp-daily-summary-card-title">${escapeHtml(formatDateKeyLabel(row.date_key))}</div>
                                        <div class="stlp-daily-summary-card-meta">
                                            <span>${escapeHtml(formatCount(row.total_runs))} 条</span>
                                            <span>异常 ${escapeHtml(formatPercent(row.abnormal_rate))}</span>
                                        </div>
                                    </div>
                                    <button class="menu_button stlp-daily-summary-toggle ${expanded ? "is-expanded" : ""}" type="button" data-action="toggle-daily-summary-row" data-date-key="${escapeHtml(dateKey)}" aria-expanded="${expanded ? "true" : "false"}" aria-label="${expanded ? "收起当日详情" : "展开当日详情"}" title="${expanded ? "收起当日详情" : "展开当日详情"}">
                                        ${getChevronIconSvg()}
                                    </button>
                                </div>
                                ${expanded ? `
                                <div class="stlp-grid">
                                    <div><strong>P95 总耗时</strong><span>${escapeHtml(formatSeconds(row.p95_total_ms))}</span></div>
                                    <div><strong>Prompt</strong><span>${escapeHtml(formatCount(row.prompt_tokens))}</span></div>
                                    <div><strong>Completion</strong><span>${escapeHtml(formatCount(row.completion_tokens))}</span></div>
                                    <div><strong>Total</strong><span>${escapeHtml(formatCount(row.total_tokens))}</span></div>
                                    <div><strong>缓存命中率</strong><span>${escapeHtml(formatPercent(row.cache_hit_rate))}</span></div>
                                    <div><strong>平均总耗时</strong><span>${escapeHtml(formatSeconds(row.avg_total_ms))}</span></div>
                                    <div><strong>平均预处理</strong><span>${escapeHtml(formatSeconds(row.avg_preprocess_ms))}</span></div>
                                    <div><strong>平均上游响应头</strong><span>${escapeHtml(formatSeconds(row.avg_upstream_headers_ms))}</span></div>
                                    <div><strong>平均首个输出</strong><span>${escapeHtml(formatSeconds(row.avg_ttft_ms))}</span></div>
                                    <div><strong>平均流式输出</strong><span>${escapeHtml(formatSeconds(row.avg_stream_ms))}</span></div>
                                </div>
                                <div class="stlp-note">Top 模型：${escapeHtml(formatTopValueList(row.top_models))}</div>
                                <div class="stlp-note">Top 异常：${escapeHtml(buildDailyAbnormalListText(row.top_abnormal_types))}</div>
                                ` : ""}
                            </article>
                        `;
                        }).join("")}
                    </div>
                ` : `<div class="stlp-empty">当前筛选下，最近 ${escapeHtml(activeDays)} 天还没有可汇总的后台监控记录。</div>`}
            </div>
        </section>
    `;
}

function buildSummaryHtml() {
    const summaryBody = !state.summary
        ? '<div class="stlp-empty">当前还没有可汇总的后台监控记录。</div>'
        : (() => {
            // 汇总区固定用全局口径，不跟随上方的筛选勾选，避免统计范围被筛选悄悄改掉。
            const abnormalCount = filterRunsByRequestPurpose(state.runs)
                .filter((run) => isAbnormalRun(run) && !isSupersededRetryRun(run)).length;
            return `
            <div class="stlp-grid">
                <div><strong>记录数</strong><span>${escapeHtml(state.summary.total_runs ?? "-")}</span></div>
                <div><strong>异常记录</strong><span>${escapeHtml(abnormalCount)}</span></div>
                <div><strong>缓存命中记录</strong><span>${escapeHtml(state.summary.cache_hit_runs ?? "-")}</span></div>
                <div><strong>缓存命中率</strong><span>${escapeHtml(formatPercent(state.summary.cache_hit_rate))}</span></div>
                <div><strong>缓存 Tokens</strong><span>${escapeHtml(state.summary.cached_tokens ?? "-")}</span></div>
                <div><strong>缓存读取 Tokens</strong><span>${escapeHtml(state.summary.cache_read_tokens ?? "-")}</span></div>
                <div><strong>缓存写入 Tokens</strong><span>${escapeHtml(state.summary.cache_write_tokens ?? "-")}</span></div>
                <div><strong>平均总耗时</strong><span>${escapeHtml(formatSeconds(state.summary.avg_total_ms))}</span></div>
                <div><strong>平均预处理</strong><span>${escapeHtml(formatSeconds(state.summary.avg_preprocess_ms))}</span></div>
                <div><strong>平均上游响应头</strong><span>${escapeHtml(formatSeconds(state.summary.avg_upstream_headers_ms))}</span></div>
                <div><strong>平均首个输出返回</strong><span>${escapeHtml(formatSeconds(state.summary.avg_ttft_ms))}</span></div>
                <div><strong>平均流式输出</strong><span>${escapeHtml(formatSeconds(state.summary.avg_stream_ms))}</span></div>
            </div>
            `;
        })();

    return buildSectionHtml("summary", "最近汇总", summaryBody, {
        titleHtml: buildSectionTitleHtml("最近汇总"),
    });
}

// 监控主页所有记录列表的唯一数据入口。
// 没有筛选时用最近 N 条（state.runs）；一旦有筛选，就改用按筛选组合从全量历史拉回来的结果，
// 否则筛选只能作用在最近 N 条上，历史里符合条件的记录永远出不来。
function getMonitorRunsView() {
    const filters = getActiveRunFilters();
    const scopedRuns = filterRunsByRequestPurpose(state.runs);

    if (!hasActiveRunFilters(filters)) {
        return { runs: scopedRuns, filters, filtered: false, ready: true };
    }

    const ready = Boolean(state.filteredRunsKey) && state.filteredRunsKey === buildRunFilterKey(filters);
    // 全量结果回来之前，先用最近 N 条里的命中项顶上，保证勾选后立刻有反馈。
    const runs = ready
        ? applyRunFilters(state.filteredRuns, filters)
        : applyRunFilters(state.runs, filters);
    return { runs, filters, filtered: true, ready };
}

function getHistoryPreviewRuns() {
    return sortRunsByStartedAtDesc(getMonitorRunsView().runs).slice(0, HISTORY_PREVIEW_COUNT);
}

function getRunDateKey(run) {
    const timestamp = Number(run?.started_at_ms);
    const date = Number.isFinite(timestamp) && timestamp > 0
        ? new Date(timestamp)
        : new Date(run?.started_at_iso || "");
    if (Number.isNaN(date.getTime())) {
        return "";
    }

    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
    ].join("-");
}

function getLatestDateRuns(runs) {
    const sortedRuns = sortRunsByStartedAtDesc(runs);
    const latestDateKey = getRunDateKey(sortedRuns[0]);
    if (!latestDateKey) {
        return sortedRuns.slice(0, HISTORY_PREVIEW_COUNT);
    }

    return sortedRuns
        .filter((run) => getRunDateKey(run) === latestDateKey)
        .slice(0, HISTORY_PREVIEW_COUNT);
}

function normalizeSummaryText(value) {
    return typeof value === "string" && value.trim()
        ? value.trim()
        : "";
}

function getHistoryDialogSourceRuns() {
    return filterRunsByRequestPurpose(state.historyAbnormalOnly ? state.historyAllRuns : state.historyRuns);
}

function getHistoryDialogFilterLabel() {
    const labels = [];
    if (state.historyAbnormalOnly) {
        labels.push("只看异常记录");
    }
    if (state.uiSettings.cacheHitOnly) {
        labels.push("只看缓存命中");
    }
    return labels.join(" + ");
}

function getVisibleHistoryRuns() {
    return sortRunsByStartedAtDesc(filterRunsByAbnormal(
        filterRunsByCacheHit(getHistoryDialogSourceRuns(), state.uiSettings.cacheHitOnly),
        state.historyAbnormalOnly,
    ));
}

function getHistoryTotalPages() {
    const total = Math.max(0, Number(state.historyTotal) || 0);
    return Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
}

function buildHistoryPreviewItem(run) {
    const floorLabel = getRunFloorLabel(run);
    const sourceLabel = getRunSourceLabel(run);
    const summaryLabel = isAbnormalRun(run)
        ? getAbnormalTypeLabel(run?.abnormal_detail?.abnormal_type)
        : "正常完成";
    const httpStatusFailed = isFailedHttpStatus(run);

    return `
        <article class="stlp-history-preview-item">
            <div class="stlp-history-preview-main">
                <span class="stlp-badge">${escapeHtml(floorLabel || "未标楼层")}</span>
                <span>${escapeHtml(run?.model || "未记录模型")}</span>
                <span>${escapeHtml(summaryLabel)}</span>
                ${isSupersededRetryRun(run) ? `<span class="stlp-badge stlp-badge-superseded">重发前的尝试</span>` : ""}
                ${httpStatusFailed ? `<span class="stlp-badge stlp-badge-http-failed">${escapeHtml(getHttpStatusLabel(run))}</span>` : ""}
            </div>
            <div class="stlp-history-preview-meta">
                <span>来源 ${escapeHtml(sourceLabel)}</span>
                <span>总耗时 ${escapeHtml(formatSeconds(run?.metrics?.total_ms))}</span>
                <span>${escapeHtml((getRunDisplayChatName(run) || "未绑定聊天窗"))}</span>
            </div>
        </article>
    `;
}

function renderHistoryPreview() {
    const previewRuns = getHistoryPreviewRuns();
    if (!previewRuns.length) {
        if (hasActiveRunFilters()) {
            return `<div class="stlp-empty">没有符合「${escapeHtml(getRunFilterLabel())}」的历史记录。</div>`;
        }
        return '<div class="stlp-empty">当前还没有可查看的历史记录。发送几轮消息后，这里会先显示简短版历史。</div>';
    }

    return `
        <div class="stlp-history-preview-list">
            ${previewRuns.map((run) => buildHistoryPreviewItem(run)).join("")}
        </div>
        <div class="stlp-history-preview-footer">
            <button class="menu_button stlp-history-preview-button" type="button" data-action="open-history-dialog">全部历史详情</button>
        </div>
    `;
}

function buildHistorySectionHtml() {
    return buildSectionHtml("history", "历史记录", renderHistoryPreview(), {
        titleHtml: buildSectionTitleHtml("历史记录"),
    });
}

function renderHistoryDialogRuns() {
    const sourceRuns = getHistoryDialogSourceRuns();
    const visibleHistoryRuns = getVisibleHistoryRuns();

    if (state.historyLoading && !sourceRuns.length) {
        return '<div class="stlp-empty">正在加载历史记录...</div>';
    }

    if (state.historyError) {
        return `<div class="stlp-empty">${escapeHtml(state.historyError)}</div>`;
    }

    if (!sourceRuns.length) {
        return `<div class="stlp-empty">${state.historyAbnormalOnly ? "当前还没有可查看的异常历史记录。" : "当前页没有历史记录。"}</div>`;
    }

    if (!visibleHistoryRuns.length) {
        return `<div class="stlp-empty">当前范围内没有符合「${escapeHtml(getHistoryDialogFilterLabel())}」的记录。</div>`;
    }

    return `
        <div class="stlp-history-run-list">
            ${visibleHistoryRuns.map((run) => buildRunHtml(run, { compactSummary: true })).join("")}
        </div>
    `;
}

function buildHistoryDialogHtml() {
    if (!state.historyDialogOpen) {
        return "";
    }

    const mobileDrawer = isMobileDrawerLayout();
    const totalPages = getHistoryTotalPages();
    const currentPage = Math.max(1, Math.min(state.historyPage, totalPages));
    const previousDisabled = currentPage <= 1 || state.historyLoading;
    const nextDisabled = currentPage >= totalPages || state.historyLoading;
    const selectedCount = getSelectedHistoryRunCount();
    const visibleHistoryRuns = getVisibleHistoryRuns();
    const allSelected = areAllHistoryRunsSelected(visibleHistoryRuns);
    const deleteMode = state.historyDeleteMode;
    const footerMeta = state.historyAbnormalOnly
        ? `异常记录 ${visibleHistoryRuns.length} 条`
        : `第 ${escapeHtml(currentPage)} 页 / 共 ${escapeHtml(totalPages)} 页 · ${HISTORY_PAGE_SIZE} 条/页`;
    const historyCloseAction = "close-history-dialog";
    const historyCloseLabel = mobileDrawer ? "关闭历史页" : "收起历史页";
    const historyDialogClass = mobileDrawer ? "stlp-history-dialog stlp-mobile-sheet" : "stlp-history-dialog";

    return `
        <div class="stlp-history-layer">
            ${mobileDrawer ? "" : '<div class="stlp-history-backdrop" data-action="close-history-dialog"></div>'}
            <div class="${historyDialogClass}" role="dialog" aria-modal="true" aria-label="历史记录大页面">
                <div class="stlp-history-header">
                    <div class="stlp-history-header-start">
                        ${mobileDrawer ? `
                            <button class="menu_button stlp-header-icon-button stlp-history-back-button" type="button" data-action="close-history-dialog" title="返回主监控页" aria-label="返回主监控页">
                                ${getHeaderIconSvg("back")}
                            </button>
                        ` : ""}
                        <div class="stlp-history-header-copy">
                    <div class="stlp-history-title">
                        <span class="stlp-history-title-text">全部历史详情</span>
                        ${buildRequestPurposeBadgeHtml()}
                    </div>
                        </div>
                    </div>
                    <button class="menu_button stlp-close-button" type="button" data-action="${historyCloseAction}" title="${historyCloseLabel}" aria-label="${historyCloseLabel}">
                        ${getHeaderIconSvg("close")}
                    </button>
                </div>
                <div class="stlp-history-actions">
                    <button class="menu_button" type="button" data-action="refresh-history-dialog" ${state.historyLoading || state.isRefreshing ? "disabled" : ""}>刷新后台数据</button>
                    <button class="menu_button" type="button" data-action="toggle-history-abnormal-only" aria-pressed="${state.historyAbnormalOnly ? "true" : "false"}" ${state.historyLoading || !state.historyRuns.length ? "disabled" : ""}>${state.historyAbnormalOnly ? "显示全部记录" : "只看异常记录"}</button>
                    ${deleteMode
                        ? `
                            <div class="stlp-history-selection-meta">已勾选 ${escapeHtml(selectedCount)} 条</div>
                            <button class="menu_button" type="button" data-action="toggle-history-page-selection" data-select-mode="${allSelected ? "clear" : "all"}" ${state.historyLoading || !visibleHistoryRuns.length ? "disabled" : ""}>${allSelected ? "取消本页全选" : "本页全选"}</button>
                            <button class="menu_button" type="button" data-action="clear-history-selection" ${selectedCount <= 0 ? "disabled" : ""}>清空勾选</button>
                            <button class="menu_button" type="button" data-action="open-history-delete-dialog" ${(state.isRefreshing || selectedCount <= 0) ? "disabled" : ""}>删除已勾选记录</button>
                            <button class="menu_button" type="button" data-action="exit-history-delete-mode">取消删除</button>
                        `
                        : `
                            <button class="menu_button" type="button" data-action="enter-history-delete-mode" ${state.historyLoading || !state.historyRuns.length ? "disabled" : ""}>删除历史记录</button>
                        `}
                </div>
                <div class="stlp-history-scroll">
                    ${renderHistoryDialogRuns()}
                </div>
                <div class="stlp-history-footer">
                    <span class="stlp-history-meta">${footerMeta}</span>
                    <div class="stlp-history-footer-nav">
                        <button class="stlp-history-page-link" type="button" data-action="history-prev-page" ${(state.historyAbnormalOnly || previousDisabled) ? "disabled" : ""}>上一页</button>
                        <button class="stlp-history-page-link" type="button" data-action="history-next-page" ${(state.historyAbnormalOnly || nextDisabled) ? "disabled" : ""}>下一页</button>
                    </div>
                </div>
                ${state.confirmDialog?.type === "output-card" && state.confirmDialog.host === "history"
                    ? buildOutputCardDialogHtml({ withinHistory: true })
                    : ""}
            </div>
        </div>
    `;
}

// showSummary=false 用于外面已经有一行概要的场合（区间统计的明细表）：
// 只铺详情，不再画一遍徽章行，否则同一条信息会紧挨着重复两遍。
function buildRunHtml(run, { compactSummary = false, showWaitingQueueAction = true, showOutputCardAction = true, showSummary = true } = {}) {
    const abnormalDetail = run?.abnormal_detail;
    const abnormalBilling = getRunAbnormalBilling(run);
    const suggestions = abnormalDetail?.optimization_suggestions?.suggestions ?? [];
    const supersededRetry = isSupersededRetryRun(run);
    const summaryLabel = isAbnormalRun(run) ? getAbnormalTypeLabel(abnormalDetail.abnormal_type) : "正常完成";
    // 异常类型照常写出来，那是事实；但不涂成故障色——被重发取代的尝试不是故障，
    // 红色恰恰是"看着像出事了"的来源。
    const statusBadgeClass = isAbnormalRun(run) && !supersededRetry ? "stlp-badge stlp-badge-abnormal" : "stlp-badge";
    const pluginLabel = getRunPluginLabel(run);
    const generationTypeLabel = getRunGenerationTypeLabel(run);
    const failedStage = getRunFailedStage(run);
    const failedStageLabel = getFailedStageLabel(failedStage);
    const floorLabel = getRunFloorLabel(run);
    const chatName = getRunDisplayChatName(run);
    const waitingQueueEntry = getWaitingQueueEntry(run?.id);
    const runOpen = state.expandedRunIds.has(run?.id);
    const suggestionOpen = state.expandedSuggestionRunIds.has(run?.id);
    const httpStatusFailed = isFailedHttpStatus(run);
    const startedAtCompact = formatStartedAtCompact(run?.started_at_iso);
    const showDeleteToggle = compactSummary && state.historyDeleteMode;
    const selectedForDelete = showDeleteToggle && state.selectedHistoryRunIds.has(run?.id);
    const usage = getRunUsage(run);
    const usageAvailable = hasRunUsage(run);
    const injectionTraceLabels = getRunInjectionTraceLabels(run);
    const injectionTraceText = injectionTraceLabels.length ? injectionTraceLabels.join(" / ") : "聊天注入";
    const detailSnapshot = getOutputCardSnapshot(run, HISTORY_RUN_DETAIL_FIELDS);
    const detailSections = detailSnapshot ? (() => {
        const sections = buildOutputCardSectionData(detailSnapshot, HISTORY_RUN_DETAIL_FIELDS);
        sections.coreRows = [
            { label: "模型", value: detailSnapshot.modelText },
            { label: "开始", value: detailSnapshot.startedAt },
            { label: "聊天窗", value: detailSnapshot.chatName || "-" },
            { label: "楼层", value: detailSnapshot.floorLabel || "-" },
            { label: "用途", value: detailSnapshot.requestPurposeLabel },
            { label: "来源", value: detailSnapshot.sourceLabel, full: true },
            { label: "状态码", value: detailSnapshot.httpStatusText },
            { label: "记录", value: detailSnapshot.shortRunIdText, full: true },
        ];
        sections.diagnosisRows = [
            { label: "异常", value: detailSnapshot.abnormalTypeLabel },
            { label: "阶段", value: detailSnapshot.failedStageLabel },
            { label: "流式", value: detailSnapshot.streamText },
            { label: "部分输出", value: detailSnapshot.hasPartialOutputText },
            { label: "总耗时", value: detailSnapshot.totalMsText },
            { label: "预处理", value: detailSnapshot.preprocessMsText },
            { label: "响应头", value: detailSnapshot.upstreamHeadersMsText },
            { label: "首个输出", value: detailSnapshot.ttftMsText },
            { label: "流式输出", value: detailSnapshot.streamMsText },
            { label: "消息数", value: detailSnapshot.messageCountText },
            { label: "请求体字符", value: detailSnapshot.promptCharsText },
            { label: "Prompt", value: detailSnapshot.promptTokensText },
            { label: "Completion", value: detailSnapshot.completionTokensText },
            { label: "Total", value: detailSnapshot.totalTokensText },
        ];
        // 这两组字段面向的记录类型正好相反，揉在一节里会互相干扰：
        // 注入来源是脚本往正文提示词里塞东西时才有的标记（这类请求本身仍算正文回复），
        // 拓展识别只对拓展自己发的独立调用有意义。
        const injectionSourceRows = [
            { label: "来源名称", value: detailSnapshot.injectionSourceLabel },
            { label: "来源标识", value: detailSnapshot.injectionSourceId },
            { label: "提示词来源", value: detailSnapshot.traceLabelsText, full: true },
            { label: "来源键", value: detailSnapshot.traceKeysText, full: true },
        ];
        sections.injectionSourceRows = injectionSourceRows.some((row) => hasDetailValue(row.value))
            ? injectionSourceRows
            : [];

        // 拓展调用即使没认出来也要显示：那句"未识别"正是在提示该去等待区补标注。
        // 正文回复没有可认的拓展，显示"未识别"只会让人以为出了故障。
        const isPluginRun = run?.request_purpose === "non_chat_generation"
            || run?.request_purpose === "plugin_internal_request";
        sections.pluginMatchRows = isPluginRun || hasDetailValue(detailSnapshot.pluginIdText)
            ? [
                { label: "拓展标识", value: detailSnapshot.pluginIdText, full: true },
                { label: "识别方式", value: detailSnapshot.pluginMatchModeLabel },
                { label: "识别分数", value: detailSnapshot.pluginMatchScoreText },
            ]
            : [];
        return sections;
    })() : null;
    const estimatedPrice = getRunEstimatedPrice(run);
    const estimatedInputPriceText = estimatedPrice?.inputCost !== null && estimatedPrice?.inputCost !== undefined
        ? formatPriceWithCurrency(estimatedPrice.inputCost, estimatedPrice.currency)
        : "-";
    const estimatedRegularInputPriceText = estimatedPrice?.regularInputCost !== null && estimatedPrice?.regularInputCost !== undefined
        ? formatPriceWithCurrency(estimatedPrice.regularInputCost, estimatedPrice.currency)
        : "-";
    const estimatedCachedInputPriceText = estimatedPrice?.cachedInputCost !== null && estimatedPrice?.cachedInputCost !== undefined
        ? formatPriceWithCurrency(estimatedPrice.cachedInputCost, estimatedPrice.currency)
        : "-";
    const estimatedOutputPriceText = estimatedPrice?.outputCost !== null && estimatedPrice?.outputCost !== undefined
        ? formatPriceWithCurrency(estimatedPrice.outputCost, estimatedPrice.currency)
        : "-";
    const estimatedPriceNote = estimatedPrice
        ? `已估算：${estimatedPrice.note}。输入部分 ${estimatedInputPriceText}${estimatedPrice?.cachedInputCost !== null && estimatedPrice?.cachedInputCost !== undefined ? `（普通输入 ${estimatedRegularInputPriceText}，缓存输入 ${estimatedCachedInputPriceText}）` : ""}，输出部分 ${estimatedOutputPriceText}。`
        : "当前模型已经返回 usage，但你还没在设置里填这个模型的价格，所以暂时不计算金额。";
    const abnormalRows = abnormalDetail ? [
        { label: "已有部分输出", value: formatBoolean(Boolean(abnormalDetail.has_partial_output)) },
        { label: "计费状态", value: abnormalBilling?.label || "费用未确认" },
        { label: "已拿到 Usage", value: formatBoolean(Boolean(abnormalBilling?.hasUsageTokens)) },
        { label: "Usage Tokens", value: abnormalBilling?.usageTotalTokens ?? "-" },
        { label: "已配置价格", value: formatBoolean(Boolean(abnormalBilling?.hasPricingConfig)) },
        { label: "异常费用估算", value: abnormalBilling?.estimatedPriceText || "-" },
    ] : [];

    const compactSummaryText = [
        floorLabel || "未标楼层",
        startedAtCompact,
        run?.model || "未记录模型",
        summaryLabel,
        supersededRetry ? "重发前的尝试" : "",
        `总耗时 ${formatSeconds(run?.metrics?.total_ms)}`,
    ].filter(Boolean).join(" · ");
    const toggleRunButtonHtml = `
        <button class="menu_button stlp-inline-button" type="button" data-action="toggle-run" data-run-id="${escapeHtml(run?.id || "")}">
            ${runOpen ? "收起详情" : "展开详情"}
        </button>
    `;
    const compactOutputCardButtonHtml = showOutputCardAction ? `
        <button class="menu_button stlp-inline-button stlp-run-compact-output-button" type="button" data-action="open-output-card" data-run-id="${escapeHtml(run?.id || "")}">
            生成排障卡
        </button>
    ` : "";
    const runActionButtonsHtml = `
        <div class="stlp-run-compact-actions ${compactSummary ? "" : "stlp-run-summary-actions"}">
            ${compactOutputCardButtonHtml}
            ${toggleRunButtonHtml}
        </div>
    `;

    return `
        <article class="stlp-run ${isAbnormalRun(run) ? "stlp-run-abnormal" : ""} ${compactSummary ? "stlp-run-compact" : ""}" data-run-id="${escapeHtml(run?.id || "")}">
            ${showSummary ? `
            <div class="stlp-run-summary ${compactSummary ? `stlp-run-summary-compact ${showDeleteToggle ? "stlp-run-summary-with-select" : "stlp-run-summary-no-select"}` : ""}">
                ${compactSummary
                    ? `
                        ${showDeleteToggle
                            ? `
                                <label class="stlp-history-select-toggle" aria-label="选中这条历史记录">
                                    <input type="checkbox" data-history-select-run-id="${escapeHtml(run?.id || "")}" ${selectedForDelete ? "checked" : ""} />
                                </label>
                            `
                            : ""}
                        <div class="stlp-run-summary-text">${escapeHtml(compactSummaryText)}</div>
                    `
                    : `
                        ${pluginLabel ? `<span class="stlp-badge stlp-badge-plugin">${escapeHtml(pluginLabel)}</span>` : ""}
                        ${generationTypeLabel ? `<span class="stlp-badge">${escapeHtml(generationTypeLabel)}</span>` : ""}
                        ${floorLabel ? `<span class="stlp-badge">${escapeHtml(floorLabel)}</span>` : ""}
                        <span class="stlp-badge">${escapeHtml(startedAtCompact)}</span>
                        <span>${escapeHtml(run?.model || "未记录模型")}</span>
                        <span class="${statusBadgeClass}">${escapeHtml(summaryLabel)}</span>
                        ${supersededRetry ? `<span class="stlp-badge stlp-badge-superseded" title="这次生成的请求被重发过，这一条是被取代的那次尝试，不是故障">重发前的尝试</span>` : ""}
                        ${failedStage ? `<span class="stlp-badge stlp-badge-stage">卡在 ${escapeHtml(failedStageLabel)}</span>` : ""}
                        <span>总耗时 ${escapeHtml(formatSeconds(run?.metrics?.total_ms))}</span>
                    `}
            </div>
            ` : ""}
            ${runActionButtonsHtml}
            <div class="stlp-run-body ${runOpen ? "" : "stlp-hidden"}">
                <div class="stlp-run-detail-sections">
                    ${detailSections ? renderHistoryDetailSection("核心信息", detailSections.coreRows) : ""}
                    ${detailSections ? renderHistoryDetailSection("失败证据", detailSections.evidenceRows) : ""}
                    ${detailSections ? renderHistoryDetailSection("诊断与耗时", detailSections.diagnosisRows) : ""}
                    ${runOpen ? renderPromptVolumeSection(run) : ""}
                    ${detailSections ? renderHistoryDetailSection("注入概况", detailSections.injectionRows) : ""}
                    ${detailSections ? renderHistoryDetailSection("费用细项", detailSections.pricingRows, usageAvailable ? estimatedPriceNote : "") : ""}
                    ${detailSections ? renderHistoryDetailSection("注入来源", detailSections.injectionSourceRows) : ""}
                    ${detailSections ? renderHistoryDetailSection("拓展识别", detailSections.pluginMatchRows) : ""}
                    ${abnormalDetail ? renderHistoryDetailSection("异常详情", abnormalRows, abnormalBilling?.note || "") : ""}
                </div>
            ${showOutputCardAction && !compactSummary ? `
                <div class="stlp-suggestions">
                    <div class="stlp-note">整理这条记录的关键字段，方便直接截图发论坛咨询，或者复制成文本版发给 AI 提问。</div>
                </div>
            ` : ""}
            ${showWaitingQueueAction ? `
                <div class="stlp-suggestions">
                    <button class="menu_button stlp-inline-button" type="button" data-action="move-to-waiting-queue" data-run-id="${escapeHtml(run?.id || "")}" ${waitingQueueEntry ? "disabled" : ""}>
                        ${waitingQueueEntry ? "已在等待区" : "移入等待区"}
                    </button>
                    <div class="stlp-note">如果这条记录误入正文或拓展分区，可以先移入等待区，再由你手动补上拓展名称。</div>
                </div>
            ` : ""}
            ${abnormalDetail ? `
                <div class="stlp-abnormal">
                    <div class="stlp-stage-highlight">未成功生成卡在：${escapeHtml(failedStageLabel)}</div>
                    ${abnormalDetail.show_optimization_suggestions && suggestions.length ? `
                        <div class="stlp-suggestions">
                            <button class="menu_button stlp-inline-button" type="button" data-action="toggle-suggestions" data-run-id="${escapeHtml(run?.id || "")}">
                                ${suggestionOpen ? "收起优化建议" : escapeHtml(abnormalDetail.optimization_suggestions.button_label || "查看优化建议")}
                            </button>
                            <div class="stlp-suggestions-panel ${suggestionOpen ? "" : "stlp-hidden"}">
                            <div class="stlp-note">${escapeHtml(abnormalDetail.optimization_suggestions.section_title || "建议操作方向")}</div>
                            <ul class="stlp-suggestion-list">
                                ${suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
                            </ul>
                            </div>
                        </div>
                    ` : '<div class="stlp-muted">当前异常未生成可显示的优化建议。</div>'}
                </div>
            ` : ''}
            </div>
        </article>
    `;
}

// 只装前端、没给本体打补丁时，面板一切正常但永远没有记录，而且接口全返回 200。
// 这是这个项目最常见的安装事故，后端会在 /status 里自报补丁状态，这里把它说清楚。
function buildPatchInstallWarningHtml() {
    const state_ = state.status?.patch_state;

    if (state_ === 'absent') {
        return `<div class="stlp-empty stlp-empty-alert">
            <strong>后端补丁没有安装</strong>
            没有它，酒馆不会把任何生成数据交给监控，所以记录会一直是空的。
            在服务器上执行 <code>node install.mjs &lt;酒馆根目录&gt;</code> 后重启酒馆即可。
        </div>`;
    }

    if (state_ === 'partial') {
        const missing = Array.isArray(state.status?.patch_missing) ? state.status.patch_missing : [];
        const detail = missing
            .map((item) => `<li>${escapeHtml(item.label)}——${escapeHtml(item.impact)}</li>`)
            .join('');
        return `<div class="stlp-empty stlp-empty-alert">
            <strong>后端补丁只装了一部分</strong>
            ${escapeHtml(String(state.status?.patch_present_count ?? '?'))} / ${escapeHtml(String(state.status?.patch_total ?? '?'))} 处已就位，缺少的部分：
            <ul>${detail}</ul>
            重新执行 <code>node install.mjs &lt;酒馆根目录&gt;</code> 会只补缺的那几处。
        </div>`;
    }

    return '';
}

function renderRuns() {
    const currentChatName = getTrackedCurrentChatWindowName();
    const runsView = getMonitorRunsView();
    const filterLabel = escapeHtml(getRunFilterLabel(runsView.filters));

    const patchWarning = buildPatchInstallWarningHtml();

    if (!runsView.filtered && !runsView.runs.length) {
        // 补丁没装好时，"发送一轮消息就会有"是错的，别让人白等。
        return patchWarning
            || `<div class="stlp-empty">当前还没有后台监控记录。发送一轮消息后，这里会显示最近 ${HISTORY_PREVIEW_COUNT} 条生成详情。</div>`;
    }

    let matchedRuns = sortRunsByStartedAtDesc(runsView.runs);
    const chatScoped = Boolean(state.uiSettings.currentChatOnly && currentChatName);

    if (chatScoped) {
        matchedRuns = matchedRuns.filter((run) => isRunInTrackedCurrentChat(run));
    }

    const matchedCount = matchedRuns.length;
    const visibleRuns = matchedRuns.slice(0, HISTORY_PREVIEW_COUNT);

    if (runsView.filtered && !visibleRuns.length && state.filteredRunsLoading) {
        return `<div class="stlp-empty">正在从全部历史里查找「${filterLabel}」的记录...</div>`;
    }

    if (!visibleRuns.length) {
        if (runsView.filtered) {
            const scopeLabel = chatScoped ? "当前聊天的历史记录" : "全部历史记录";
            return `<div class="stlp-empty">${scopeLabel}里没有符合「${filterLabel}」的记录。取消勾选即可恢复显示全部记录。</div>`;
        }

        const fallbackRuns = getLatestDateRuns(filterRunsByRequestPurpose(state.runs));
        return `
            <div class="stlp-note">当前筛选没有命中，已保留最近日期的历史记录。</div>
            ${groupRunsByChatName(fallbackRuns)
                .map((group) => `
                    <section class="stlp-run-group">
                        <div class="stlp-run-group-title">
                            <span>${escapeHtml(group.chatName)}</span>
                            <span>${escapeHtml(`${group.runs.length} 条`)}</span>
                        </div>
                        <div class="stlp-run-group-list">
                            ${group.runs.map((run) => buildRunHtml(run)).join("")}
                        </div>
                    </section>
                `)
                .join("")}
        `;
    }

    const filterNote = runsView.filtered
        ? `<div class="stlp-note">已按「${filterLabel}」从全部历史中筛出 ${escapeHtml(matchedCount)} 条${runsView.ready ? "" : "（仍在同步全部历史）"}，下方最多显示 ${escapeHtml(HISTORY_PREVIEW_COUNT)} 条。上方汇总仍为全局统计。</div>`
        : "";

    // 补丁只装了一半时照样有记录，但记录本身是残缺的，所以这条提示要一直挂在列表上方。
    return patchWarning + filterNote + groupRunsByChatName(visibleRuns)
        .map((group) => `
            <section class="stlp-run-group">
                <div class="stlp-run-group-title">
                    <span>${escapeHtml(group.chatName)}</span>
                    <span>${escapeHtml(`${group.runs.length} 条`)}</span>
                </div>
                <div class="stlp-run-group-list">
                    ${group.runs.map((run) => buildRunHtml(run)).join("")}
                </div>
            </section>
        `)
        .join("");
}

function buildRunsSectionHtml() {
    return buildSectionHtml("runs", "最近记录", renderRuns(), {
        titleHtml: buildSectionTitleHtml("最近记录"),
    });
}

function buildOutputCardDialogHtml({ withinHistory = false } = {}) {
    if (state.confirmDialog?.type !== "output-card") {
        return "";
    }

    const run = findRunById(state.confirmDialog.runId);
    const snapshot = getOutputCardSnapshot(run);
    if (!snapshot) {
        return "";
    }

    const mobileDrawer = isMobileDrawerLayout();
    const fields = getOutputCardFields();
    const sections = buildOutputCardSectionData(snapshot, fields);
    const badgeHtml = [
        snapshot.cacheHitText === "是" ? '<span class="stlp-badge">命中缓存</span>' : "",
    ].filter(Boolean).join("");
    const maskChatTitleButtonLabel = fields.maskChatTitle ? "显示标题" : "隐藏标题";
    const layerClass = withinHistory
        ? "stlp-confirm-layer stlp-confirm-layer-output-card stlp-history-output-card-layer"
        : "stlp-confirm-layer stlp-confirm-layer-output-card";
    return `
        <div class="${layerClass}">
            <div class="stlp-confirm-backdrop" data-action="dismiss-confirm-dialog"></div>
            <div class="stlp-output-card-dialog ${mobileDrawer ? "stlp-output-card-sheet" : ""}" role="dialog" aria-modal="true" aria-label="排障输出卡">
                ${mobileDrawer ? '<div class="stlp-confirm-sheet-grab" aria-hidden="true"></div>' : ""}
                <div class="stlp-output-card-actions">
                    <div class="stlp-output-card-dialog-title">鱼缸后端监控排障卡 · ${escapeHtml(snapshot.requestPurposeLabel)}</div>
                    <button class="menu_button stlp-inline-button stlp-output-card-action-button" type="button" data-action="copy-output-card-text" data-run-id="${escapeHtml(run?.id || "")}">复制文本</button>
                    <button class="menu_button stlp-inline-button stlp-output-card-action-button" type="button" data-action="toggle-output-card-mask-chat-title" aria-pressed="${escapeHtml(String(fields.maskChatTitle))}">${escapeHtml(maskChatTitleButtonLabel)}</button>
                    <button class="menu_button stlp-inline-button stlp-output-card-action-button stlp-output-card-close-button" type="button" data-action="dismiss-confirm-dialog" aria-label="关闭排障卡">×</button>
                </div>
                <article class="stlp-output-card stlp-output-card-compact">
                    <div class="stlp-output-card-header">
                        <div class="stlp-output-card-title">${escapeHtml(snapshot.modelText)}</div>
                        ${badgeHtml ? `<div class="stlp-output-card-badges">${badgeHtml}</div>` : ""}
                        <div class="stlp-output-card-meta${isAbnormalRun(run) ? " is-abnormal" : ""}">${isAbnormalRun(run)
                            ? `<span class="stlp-badge stlp-badge-stage">${escapeHtml(snapshot.summaryLabel)}</span>`
                            : escapeHtml(snapshot.summaryLabel)}</div>
                    </div>
                    ${renderOutputCardSection("核心信息", sections.coreRows, "", "stlp-output-card-rows-two-column")}
                    ${renderOutputCardSection("失败证据", sections.evidenceRows, "", "stlp-output-card-rows-two-column")}
                    ${renderOutputCardSection("诊断与耗时", sections.diagnosisRows, "", "stlp-output-card-rows-two-column")}
                    ${renderOutputCardSection("提示词体积", sections.promptVolumeRows, fields.showPromptVolume && snapshot.promptVolume ? snapshot.promptVolumeConclusionText : "", "stlp-output-card-rows-two-column")}
                    ${renderOutputCardSection("注入概况", sections.injectionRows, "", "stlp-output-card-rows-two-column")}
                    ${renderOutputCardSection("注入细项", sections.injectionDetailRows, "", "stlp-output-card-rows-two-column")}
                    ${renderOutputCardSection("扩展识别", sections.extensionRows, "", "stlp-output-card-rows-two-column")}
                    ${renderOutputCardSection("费用细项", sections.pricingRows, fields.showPricingDetails ? snapshot.estimatedPriceNote : "", "stlp-output-card-rows-two-column")}
                </article>
            </div>
        </div>
    `;
}

function buildCloseConfirmHtml() {
    if (!state.confirmDialog) {
        return "";
    }

    if (state.confirmDialog.type === "output-card") {
        return "";
    }

    const mobileDrawer = isMobileDrawerLayout();
    let title = "";
    let text = "";
    let actions = [];

    if (state.confirmDialog.type === "close-page") {
        title = "关闭页面后是否继续在后台运行？";
        text = "选择“运行”为继续在后台运行，选择“不运行”为关闭页面并停止后台自动刷新。";
        actions = [
            { action: "confirm-close-keep-running", label: "运行" },
            { action: "confirm-close-stop", label: "不运行" },
        ];
    } else if (state.confirmDialog.type === "generation-intervention") {
        title = state.confirmDialog.title || "这次生成等得太久了";
        text = state.confirmDialog.text || "这次生成已经明显超出正常时长，基本不用继续等了。要现在尝试中止这次生成吗？";
        actions = [
            { action: "confirm-generation-intervention-yes", label: "是" },
            { action: "confirm-generation-intervention-no", label: "否" },
        ];
    } else if (state.confirmDialog.type === "manual-force-stop-generation") {
        title = "强行终止当前生成？";
        // "尽量"两个字不能去掉：终止不保证成功，实测有过指令发出去、生成仍然跑完的例子。
        text = state.confirmDialog.mode === "rescue"
            ? "现在没检测到正在进行的生成。如果你的发送键卡住点不动，可以继续试着恢复它。"
            : "停掉正在进行的这次生成，并尽量让发送按钮恢复可用。";
        actions = [
            { action: "confirm-manual-force-stop-yes", label: "是" },
            { action: "confirm-manual-force-stop-no", label: "否" },
        ];
    } else if (state.confirmDialog.type === "clear-backend") {
        title = "清空后台记录";
        text = "确认清空后台监控记录吗？这个操作会删除当前已保存的最近记录。";
        actions = [
            { action: "confirm-clear-backend-yes", label: "是" },
            { action: "confirm-clear-backend-no", label: "否" },
        ];
    } else if (state.confirmDialog.type === "history-delete-menu") {
        title = "删除历史记录";
        text = `当前已勾选 ${getSelectedHistoryRunCount()} 条，请选择要删除的范围。`;
        actions = [
            { action: "choose-clear-history-all", label: "删除勾选项里的全部记录" },
            { action: "choose-clear-history-normal", label: "删除勾选项里的正常记录" },
            { action: "cancel-history-delete", label: "取消" },
        ];
    } else if (state.confirmDialog.type === "history-delete-confirm") {
        const scope = state.confirmDialog.scope === "normal_only" ? "normal_only" : "all";
        title = getHistoryScopeLabel(scope);
        text = getHistoryScopeConfirmText(scope);
        actions = [
            { action: "confirm-clear-history-yes", label: "是", scope },
            { action: "confirm-clear-history-no", label: "否", scope },
        ];
    } else if (state.confirmDialog.type === "message") {
        title = state.confirmDialog.title || "";
        text = state.confirmDialog.text || "";
        actions = Array.isArray(state.confirmDialog.actions) && state.confirmDialog.actions.length
            ? state.confirmDialog.actions
            : [{ action: "dismiss-confirm-dialog", label: "知道了" }];
    }

    return `
        <div class="stlp-confirm-layer">
            <div class="stlp-confirm-backdrop" data-action="dismiss-confirm-dialog"></div>
            <div class="stlp-confirm-dialog ${mobileDrawer ? "stlp-confirm-sheet" : ""}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
                ${mobileDrawer ? '<div class="stlp-confirm-sheet-grab" aria-hidden="true"></div>' : ""}
                <div class="stlp-confirm-title">${escapeHtml(title)}</div>
                <div class="stlp-confirm-text">${escapeHtml(text)}</div>
                <div class="stlp-confirm-actions">
                    ${actions.map((item) => `
                        <button
                            class="menu_button"
                            type="button"
                            data-action="${escapeHtml(item.action)}"
                            ${item.scope ? `data-scope="${escapeHtml(item.scope)}"` : ""}
                        >${escapeHtml(item.label)}</button>
                    `).join("")}
                </div>
            </div>
        </div>
    `;
}

function buildPageHtml() {
    const currentThemeMode = normalizeThemeMode(state.uiSettings.themeMode);
    const mobileDrawer = isMobileDrawerLayout();
    const compactTouchLayout = mobileDrawer;
    const pageHeaderTitle = compactTouchLayout ? "" : ' title="按住移动页面"';
    const pageHeaderDragAction = compactTouchLayout ? "" : ' data-action="drag-page"';
    const pageBackdropAction = mobileDrawer ? "" : ' data-action="close-page"';
    const pageDialogClass = mobileDrawer
        ? "stlp-page-dialog stlp-mobile-sheet"
        : "stlp-page-dialog";
    if (!state.pageOpen) {
        return "";
    }

    if (state.pageMinimized) {
        return `
            <button
                class="menu_button stlp-minimized-button ${escapeHtml(getBackendStatusIndicatorClass())} ${state.minimizedButtonFlashActive ? "is-alert-flashing" : ""} ${state.mainApiErrorActive && isMainApiErrorIndicatorEnabled() ? "is-api-error" : ""}"
                type="button"
                data-action="restore-page"
                title="${escapeHtml(MODULE_DISPLAY_NAME)}"
                aria-label="恢复悬浮隐藏"
                data-action-drag="drag-minimized-page"
                ${buildMinimizedButtonStyle()}
            >
                ${getMinimizedMonitorIconSvg()}
            </button>
            ${buildCloseConfirmHtml()}
        `;
    }

    const statusViewActive = isStatusView();
    const settingsViewActive = isSettingsView();
    const waitingQueueViewActive = isWaitingQueueView();
    const dailySummaryViewActive = isDailySummaryView();
    const callTimerViewActive = isCallTimerView();
    const monitorViewActive = !statusViewActive && !settingsViewActive && !waitingQueueViewActive && !dailySummaryViewActive && !callTimerViewActive;
    const pageSubtitle = statusViewActive
        ? "监控状态"
        : (settingsViewActive ? "设置" : (waitingQueueViewActive ? "等待区" : (dailySummaryViewActive ? "日聚合" : (callTimerViewActive ? "区间统计" : "主监控页"))));

    return `
        <div class="stlp-page-backdrop"${pageBackdropAction}></div>
        <div class="${pageDialogClass}" role="dialog" aria-modal="true" aria-label="${escapeHtml(MODULE_DISPLAY_NAME)}"${buildPageDialogStyle()}>
            <div class="stlp-page-header"${pageHeaderDragAction}${pageHeaderTitle}>
                <div class="stlp-page-header-start">
                    <div class="stlp-page-header-copy">
                        <div class="stlp-page-title-row">
                            <div class="stlp-page-title">${escapeHtml(MODULE_DISPLAY_NAME)}</div>
                            <span class="stlp-status-indicator ${escapeHtml(getBackendStatusIndicatorClass())} stlp-page-title-status" role="img" title="${escapeHtml(getBackendStatusIndicatorLabel())}" aria-label="${escapeHtml(getBackendStatusIndicatorLabel())}"></span>
                        </div>
                        ${compactTouchLayout ? `<div class="stlp-page-subtitle">${escapeHtml(pageSubtitle)}</div>` : ""}
                    </div>
                </div>
                <div class="stlp-page-header-actions">
                    <button class="menu_button stlp-header-icon-button" type="button" data-action="cycle-theme-mode" title="${escapeHtml(getThemeModeLabel(currentThemeMode))}" aria-label="切换主题">
                        ${getHeaderIconSvg("theme", currentThemeMode)}
                    </button>
                    <button class="menu_button stlp-header-icon-button stlp-minimize-button" type="button" data-action="minimize-page" title="悬浮隐藏" aria-label="悬浮隐藏">
                        ${getHeaderIconSvg("minimize")}
                    </button>
                    <button class="menu_button stlp-close-button" type="button" data-action="close-page" title="关闭" aria-label="关闭">
                        ${getHeaderIconSvg("close")}
                    </button>
                </div>
            </div>
            ${buildRecordingPausedBannerHtml()}
            ${buildMainApiErrorBannerHtml()}
            <div class="stlp-page-body">
                <nav class="stlp-side-nav" aria-label="监控入口">
                    <button class="stlp-side-nav-item ${monitorViewActive && !isExtensionRequestView() ? "is-active" : ""}" type="button" data-nav-purpose="chat_main_reply" aria-pressed="${escapeHtml(String(monitorViewActive && !isExtensionRequestView()))}" title="正文回复" aria-label="正文回复">
                        <span class="stlp-side-nav-icon" aria-hidden="true">
                            <svg class="stlp-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h10l4 4v12H5z"/><path d="M15 4v4h4"/><path d="M8 12h8M8 16h6"/></svg>
                        </span>
                    </button>
                    <button class="stlp-side-nav-item ${monitorViewActive && isExtensionRequestView() ? "is-active" : ""}" type="button" data-nav-purpose="non_chat_generation" aria-pressed="${escapeHtml(String(monitorViewActive && isExtensionRequestView()))}" title="拓展调用" aria-label="拓展调用">
                        <span class="stlp-side-nav-icon" aria-hidden="true">
                            <svg class="stlp-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><path d="M14 16.5h6M17 13.5v6"/></svg>
                        </span>
                    </button>
                    <button class="stlp-side-nav-item ${statusViewActive ? "is-active" : ""}" type="button" data-nav-action="open-status" aria-pressed="${escapeHtml(String(statusViewActive))}" title="监控状态" aria-label="监控状态">
                        <span class="stlp-side-nav-icon" aria-hidden="true">
                            <svg class="stlp-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18h16"/><path d="M7 15l3-3 2 2 5-6"/><circle cx="17" cy="8" r="1.5"/></svg>
                        </span>
                    </button>
                    <button class="stlp-side-nav-item ${waitingQueueViewActive ? "is-active" : ""}" type="button" data-nav-action="open-waiting-queue" aria-pressed="${escapeHtml(String(waitingQueueViewActive))}" title="等待区" aria-label="等待区">
                        <span class="stlp-side-nav-icon" aria-hidden="true">
                            <svg class="stlp-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 7h12"/><path d="M6 12h12"/><path d="M6 17h7"/><path d="M18 17h.01"/></svg>
                        </span>
                    </button>
                    <button class="stlp-side-nav-item ${dailySummaryViewActive ? "is-active" : ""}" type="button" data-nav-action="open-daily-summary" aria-pressed="${escapeHtml(String(dailySummaryViewActive))}" title="日聚合" aria-label="日聚合">
                        <span class="stlp-side-nav-icon" aria-hidden="true">
                            <svg class="stlp-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M7 15v-4"/><path d="M12 15V8"/><path d="M17 15v-6"/></svg>
                        </span>
                    </button>
                    <button class="stlp-side-nav-item ${callTimerViewActive ? "is-active" : ""}" type="button" data-nav-action="open-call-timer" aria-pressed="${escapeHtml(String(callTimerViewActive))}" title="区间统计" aria-label="区间统计">
                        <span class="stlp-side-nav-icon" aria-hidden="true">
                            <svg class="stlp-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3h4"/><path d="M12 14V9.5"/><path d="M18.5 7.5l1-1"/><circle cx="12" cy="14" r="7"/></svg>
                        </span>
                    </button>
                    <button class="stlp-side-nav-item ${settingsViewActive ? "is-active" : ""}" type="button" data-nav-action="open-settings" aria-pressed="${escapeHtml(String(settingsViewActive))}" title="设置" aria-label="设置">
                        <span class="stlp-side-nav-icon" aria-hidden="true">
                            <svg class="stlp-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
                        </span>
                    </button>
                </nav>
                <div class="stlp-page-main">
                    ${monitorViewActive ? `<div class="stlp-page-toolbar">
                        <div class="stlp-toolbar-row stlp-toolbar-actions">
                            <button id="stlp_refresh_runs" class="menu_button stlp-toolbar-button" type="button">刷新后台</button>
                            <button id="stlp_request_force_stop_generation" class="menu_button stlp-toolbar-button stlp-toolbar-button-danger" type="button" data-action="request-force-stop-generation">终止生成</button>
                        </div>
                        <div class="stlp-toolbar-row stlp-toolbar-filters">
                            <label class="stlp-inline-checkbox stlp-toolbar-toggle" aria-pressed="${escapeHtml(String(state.uiSettings.abnormalOnly))}">
                                <input id="stlp_abnormal_only" type="checkbox" ${state.uiSettings.abnormalOnly ? "checked" : ""} />
                                <span>只看异常</span>
                            </label>
                            <label class="stlp-inline-checkbox stlp-toolbar-toggle" aria-pressed="${escapeHtml(String(state.uiSettings.cacheHitOnly))}">
                                <input id="stlp_cache_hit_only" type="checkbox" ${state.uiSettings.cacheHitOnly ? "checked" : ""} />
                                <span>只看缓存命中</span>
                            </label>
                            <label class="stlp-inline-checkbox stlp-toolbar-toggle" aria-pressed="${escapeHtml(String(state.uiSettings.currentChatOnly))}">
                                <input id="stlp_current_chat_only" type="checkbox" ${state.uiSettings.currentChatOnly ? "checked" : ""} />
                                <span>此聊天条目</span>
                            </label>
                        </div>
                    </div>` : ""}
                    <div class="stlp-page-scroll">
                        ${settingsViewActive
                            ? `<div id="stlp_settings_view"></div>`
                            : (statusViewActive
                                ? `<div id="stlp_status_view"></div>`
                                : (waitingQueueViewActive
                                    ? `<div id="stlp_waiting_queue_view"></div>`
                                    : (dailySummaryViewActive
                                        ? `<div id="stlp_daily_summary_view"></div>`
                                        : (callTimerViewActive
                                            ? `<div id="stlp_call_timer_view"></div>`
                                            : `<div id="stlp_monitor_sections" class="stlp-section-stack"></div>`))))}
                    </div>
                </div>
            </div>
            <div class="stlp-page-resizer" data-action="resize-page" aria-hidden="true"></div>
        </div>
        ${buildHistoryDialogHtml()}
        ${state.confirmDialog?.type === "output-card" && state.confirmDialog.host === "history" ? "" : buildOutputCardDialogHtml()}
        ${buildCloseConfirmHtml()}
    `;
}

function updateWaitingRuleCardLayouts(root) {
    if (!(root instanceof HTMLElement)) {
        return;
    }

    const cards = root.querySelectorAll(".stlp-waiting-rule-card");
    cards.forEach((card) => {
        if (!(card instanceof HTMLElement)) {
            return;
        }

        const headline = card.querySelector(".stlp-waiting-rule-card-headline");
        const title = card.querySelector(".stlp-waiting-rule-card-headline .stlp-waiting-card-title");
        const inlineTimeGroup = card.querySelector(".stlp-waiting-rule-time-group-inline");
        if (!(headline instanceof HTMLElement) || !(title instanceof HTMLElement) || !(inlineTimeGroup instanceof HTMLElement)) {
            card.classList.remove("is-time-secondary");
            return;
        }

        const headlineStyle = window.getComputedStyle(headline);
        const gapValue = headlineStyle.columnGap || headlineStyle.gap || "0";
        const gap = Number.parseFloat(gapValue) || 0;
        const requiredWidth = title.scrollWidth + inlineTimeGroup.offsetWidth + gap;
        const availableWidth = headline.clientWidth;
        card.classList.toggle("is-time-secondary", requiredWidth > (availableWidth + 1));
    });
}

function renderPage() {
    if (!(state.pageRoot instanceof HTMLElement)) {
        return;
    }

    const waitingQueueInputSnapshot = captureWaitingQueueInputState();
    const waitingQueueEntrySnapshot = captureWaitingQueueEntrySnapshot(waitingQueueInputSnapshot);
    if (waitingQueueInputSnapshot?.runId && typeof waitingQueueInputSnapshot.value === "string") {
        state.waitingQueueDrafts = {
            ...state.waitingQueueDrafts,
            [waitingQueueInputSnapshot.runId]: waitingQueueInputSnapshot.value,
        };
    }
    const existingScrollRoot = state.pageRoot.querySelector(".stlp-page-scroll");
    if (existingScrollRoot instanceof HTMLElement) {
        state.pageScrollTop = existingScrollRoot.scrollTop;
    }

    const existingHistoryScrollRoot = state.pageRoot.querySelector(".stlp-history-scroll");
    if (existingHistoryScrollRoot instanceof HTMLElement) {
        state.historyScrollTop = existingHistoryScrollRoot.scrollTop;
    }

    state.pageRoot.classList.toggle("stlp-page-open", state.pageOpen);
    state.pageRoot.classList.toggle("stlp-page-minimized", state.pageMinimized);
    state.pageRoot.classList.toggle("stlp-layout-mobile", isMobileDrawerLayout());
    state.pageRoot.classList.toggle("stlp-platform-ios", isIosWebKit());
    state.pageRoot.classList.remove(
        "stlp-theme-dawn",
        "stlp-theme-rose",
        "stlp-theme-night",
        "stlp-theme-follow-tavern",
    );
    state.pageRoot.classList.add(`stlp-theme-${normalizeThemeMode(state.uiSettings.themeMode).replace(/_/g, "-")}`);
    syncBodyScrollLock();
    state.pageRoot.innerHTML = buildPageHtml();

    const settingsViewRoot = state.pageRoot.querySelector("#stlp_settings_view");
    const statusViewRoot = state.pageRoot.querySelector("#stlp_status_view");
    let waitingQueueViewRoot = state.pageRoot.querySelector("#stlp_waiting_queue_view");
    const dailySummaryViewRoot = state.pageRoot.querySelector("#stlp_daily_summary_view");
    const callTimerViewRoot = state.pageRoot.querySelector("#stlp_call_timer_view");
    const monitorSectionsRoot = state.pageRoot.querySelector("#stlp_monitor_sections");
    const refreshButton = state.pageRoot.querySelector("#stlp_refresh_runs");
    const exportButton = state.pageRoot.querySelector("#stlp_export_runs");
    const clearButton = state.pageRoot.querySelector("#stlp_clear_runs");

    if (settingsViewRoot) {
        settingsViewRoot.innerHTML = buildSettingsViewHtml();
    }

    if (statusViewRoot) {
        statusViewRoot.innerHTML = buildStatusViewHtml();
    }

    if (waitingQueueViewRoot) {
        waitingQueueViewRoot.innerHTML = buildWaitingQueueViewHtml();
        if (waitingQueueEntrySnapshot?.runId) {
            waitingQueueViewRoot = restoreWaitingQueueEntrySnapshot(waitingQueueEntrySnapshot, waitingQueueViewRoot);
        }
    }

    if (dailySummaryViewRoot) {
        dailySummaryViewRoot.innerHTML = buildDailySummaryViewHtml();
    }

    if (callTimerViewRoot) {
        callTimerViewRoot.innerHTML = buildCallTimerViewHtml();
    }

    // 每次重渲染后都要重挂：上面的 innerHTML 把带 data-call-timer-elapsed 的节点换掉了。
    syncCallTimerTick();
    syncCallTimerPoll();

    if (monitorSectionsRoot) {
        syncRunFloorMap();
        syncRunChatMap();
        monitorSectionsRoot.innerHTML = [
            buildSummaryHtml(),
            buildRunsSectionHtml(),
            buildHistorySectionHtml(),
        ].join("");
    }

    if (refreshButton) {
        refreshButton.disabled = state.isRefreshing;
    }

    if (exportButton) {
        exportButton.disabled = !state.runs.length;
    }

    if (clearButton) {
        clearButton.disabled = !state.runs.length || state.isRefreshing;
    }

    bindRenderedPageActions();

    const nextScrollRoot = state.pageRoot.querySelector(".stlp-page-scroll");
    if (nextScrollRoot instanceof HTMLElement) {
        nextScrollRoot.scrollTop = state.pageScrollTop;
    }

    const nextHistoryScrollRoot = state.pageRoot.querySelector(".stlp-history-scroll");
    if (nextHistoryScrollRoot instanceof HTMLElement) {
        nextHistoryScrollRoot.scrollTop = state.historyScrollTop;
    }

    if (waitingQueueInputSnapshot && state.confirmDialog?.type !== "close-page") {
        restoreWaitingQueueInputState(waitingQueueInputSnapshot);
    }

    window.requestAnimationFrame(() => {
        updateWaitingRuleCardLayouts(state.pageRoot);
    });

    if (state.pageOpen && !state.pageMinimized) {
        window.requestAnimationFrame(() => {
            closeNativeMenu({ forceDirectHide: isIosWebKit() });
        });
    }

    if (state.pageOpen && isMobileDrawerLayout()) {
        scheduleViewportSync();
    }
}

function handlePanelChangeTarget(target) {
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) {
        return false;
    }

    if (target.dataset.waitingLabelRunId) {
        const runId = typeof target.dataset.waitingLabelRunId === "string" ? target.dataset.waitingLabelRunId.trim() : "";
        if (!runId) {
            return false;
        }

        state.waitingQueueDrafts = {
            ...state.waitingQueueDrafts,
            [runId]: target.value,
        };
        return true;
    }

    if (target.dataset.pricingModel && target.dataset.pricingField) {
        const modelName = typeof target.dataset.pricingModel === "string" ? target.dataset.pricingModel.trim() : "";
        const fieldName = target.dataset.pricingField;
        const supportedFields = new Set(["currency", ...PRICING_NUMBER_FIELDS, ...PRICING_TIME_FIELDS, ...PRICING_BOOLEAN_FIELDS]);
        if (!modelName || !supportedFields.has(fieldName)) {
            return false;
        }

        const currentMap = getModelPricingMap();
        const currentConfig = normalizePricingConfig(currentMap[modelName]);

        if (fieldName === "currency") {
            persistPricingModelConfig(modelName, {
                ...currentConfig,
                currency: normalizePricingCurrency(target.value),
            });
            return true;
        }

        if (PRICING_BOOLEAN_FIELDS.includes(fieldName)) {
            persistPricingModelConfig(modelName, {
                ...currentConfig,
                [fieldName]: Boolean(target.checked),
            });
            state.apiStatus = "价格设置已更新";
            state.apiError = "";
            return true;
        }

        if (PRICING_TIME_FIELDS.includes(fieldName)) {
            const rawTimeValue = target.value.trim();
            const nextTimeValue = rawTimeValue ? normalizePeakValleyTimeValue(rawTimeValue) : "";
            if (rawTimeValue && !nextTimeValue) {
                target.value = currentConfig[fieldName] || "";
                state.apiStatus = "价格保存失败";
                state.apiError = "峰时段时间必须是有效的 24 小时制时间。";
                safeRenderPage();
                return true;
            }

            const otherFieldName = fieldName === "peak_start_time" ? "peak_end_time" : "peak_start_time";
            const otherTimeValue = fieldName === "peak_start_time"
                ? normalizePeakValleyTimeValue(currentConfig.peak_end_time)
                : normalizePeakValleyTimeValue(currentConfig.peak_start_time);
            if (nextTimeValue && otherTimeValue && nextTimeValue === otherTimeValue) {
                target.value = currentConfig[fieldName] || "";
                state.apiStatus = "价格保存失败";
                state.apiError = "峰时开始和结束时间不能相同。";
                safeRenderPage();
                return true;
            }

            persistPricingModelConfig(modelName, {
                ...currentConfig,
                [fieldName]: nextTimeValue,
                [otherFieldName]: otherTimeValue,
            });
            state.apiStatus = "价格设置已更新";
            state.apiError = "";
            return true;
        }

        const rawValue = target.value.trim();
        const nextValue = rawValue ? normalizeConfiguredPriceValue(Number(rawValue)) : null;
        if (rawValue && nextValue === null) {
            const fallbackValue = normalizeConfiguredPriceValue(currentConfig[fieldName]);
            target.value = fallbackValue === null ? "" : String(fallbackValue);
            state.apiStatus = "价格保存失败";
            state.apiError = "价格必须是大于等于 0 的数字。";
            safeRenderPage();
            return true;
        }

        persistPricingModelConfig(modelName, {
            ...currentConfig,
            [fieldName]: nextValue,
        });
        target.value = nextValue === null ? "" : String(nextValue);
        state.apiStatus = "价格设置已更新";
        state.apiError = "";
        return true;
    }

    if (target.id === "stlp_show_abnormal_optimization_suggestions") {
        updateMonitorSettings({
            display: {
                show_abnormal_optimization_suggestions: Boolean(target.checked),
            },
        }, { deferBusyRender: true, optimistic: true });
        return true;
    }

    if (target.id === "stlp_show_permission_enhanced_suggestions") {
        updateMonitorSettings({
            display: {
                show_permission_enhanced_suggestions: Boolean(target.checked),
            },
        }, { deferBusyRender: true, optimistic: true });
        return true;
    }

    if (target.id === "stlp_recording_enabled") {
        updateMonitorSettings({
            runtime: {
                recording_enabled: Boolean(target.checked),
            },
        }, { deferBusyRender: true, optimistic: true });
        return true;
    }

    if (target.id === "stlp_collect_force_stop_diagnostics") {
        updateMonitorSettings({
            runtime: {
                collect_force_stop_diagnostics: Boolean(target.checked),
            },
        }, { deferBusyRender: true, optimistic: true });
        return true;
    }

    if (target.id === "stlp_abnormal_optimization_suggestion_scope") {
        updateMonitorSettings({
            display: {
                abnormal_optimization_suggestion_scope: target.value,
            },
        }, { deferBusyRender: true, optimistic: true });
        return true;
    }

    if (target.id === "stlp_abnormal_optimization_suggestion_limit") {
        const parsed = Number(target.value);
        const nextValue = Number.isInteger(parsed) ? Math.max(2, Math.min(4, parsed)) : 3;
        target.value = String(nextValue);
        updateMonitorSettings({
            display: {
                abnormal_optimization_suggestion_limit: nextValue,
            },
        }, { deferBusyRender: true, optimistic: true });
        return true;
    }

    if (target.id === "stlp_auto_refresh_seconds") {
        const parsed = Number(target.value);
        state.uiSettings.autoRefreshSeconds = Number.isFinite(parsed)
            ? Math.max(5, Math.min(120, parsed))
            : DEFAULT_UI_SETTINGS.autoRefreshSeconds;
        target.value = String(state.uiSettings.autoRefreshSeconds);
        saveUiSettings();
        scheduleAutoRefresh();
        safeRenderPage();
        return true;
    }

    if (target.id === "stlp_theme_mode") {
        state.uiSettings.themeMode = normalizeThemeMode(target.value);
        saveUiSettings();
        safeRenderPage();
        return true;
    }

    if (target.id === "stlp_minimized_button_follow_theme_color") {
        state.uiSettings.minimizedButtonColorMode = target.checked ? "follow_theme" : "custom";
        saveUiSettings();
        safeRenderPage();
        return true;
    }

    if (target.id === "stlp_minimized_button_custom_color") {
        state.uiSettings.minimizedButtonColorMode = "custom";
        state.uiSettings.minimizedButtonCustomColor = normalizeMinimizedButtonCustomColor(target.value);
        saveUiSettings();
        if (isColorWheelInputTarget(target)) {
            deferColorWheelRenderUntilBlur();
        } else {
            safeRenderPage();
        }
        return true;
    }

    if (target.id === "stlp_minimized_button_stroke_color") {
        state.uiSettings.minimizedButtonStrokeColor = normalizeMinimizedButtonStrokeColor(target.value);
        saveUiSettings();
        if (isColorWheelInputTarget(target)) {
            deferColorWheelRenderUntilBlur();
        } else {
            safeRenderPage();
        }
        return true;
    }

    if (target.id === "stlp_minimized_button_border_visible") {
        state.uiSettings.minimizedButtonBorderVisible = Boolean(target.checked);
        saveUiSettings();
        safeRenderPage();
        return true;
    }

    if (target.id === "stlp_main_api_error_indicator_enabled") {
        // 关掉只是不显示：mainApiErrorActive 照常维护，重新打开立刻能看到当前状态。
        state.uiSettings.mainApiErrorIndicatorEnabled = Boolean(target.checked);
        saveUiSettings();
        safeRenderPage();
        return true;
    }

    if (target.id === "stlp_main_api_error_clear_on_regenerate") {
        state.uiSettings.mainApiErrorClearOnRegenerate = Boolean(target.checked);
        saveUiSettings();
        safeRenderPage();
        return true;
    }

    if (target.id === "stlp_minimized_button_border_color") {
        state.uiSettings.minimizedButtonBorderColor = normalizeMinimizedButtonBorderColor(target.value);
        saveUiSettings();
        if (isColorWheelInputTarget(target)) {
            deferColorWheelRenderUntilBlur();
        } else {
            safeRenderPage();
        }
        return true;
    }

    if (target.id === "stlp_minimized_button_opacity") {
        state.uiSettings.minimizedButtonOpacity = normalizeMinimizedButtonOpacity(target.value);
        saveUiSettings();
        safeRenderPage();
        return true;
    }

    if (target.id === "stlp_abnormal_only" || target.id === "stlp_cache_hit_only") {
        if (target.id === "stlp_abnormal_only") {
            state.uiSettings.abnormalOnly = Boolean(target.checked);
        } else {
            state.uiSettings.cacheHitOnly = Boolean(target.checked);
        }
        saveUiSettings();
        // 先用手上已有的数据立刻重绘，再去后台补全量结果，避免勾选后界面先卡住一拍。
        safeRenderPage();
        void (async () => {
            await loadFilteredRuns();
            if (state.historyDialogOpen) {
                await refreshHistoryDialogData();
            }
        })();
        return true;
    }

    if (target.id === "stlp_current_chat_only") {
        state.uiSettings.currentChatOnly = Boolean(target.checked);
        saveUiSettings();
        safeRenderPage();
        void refreshBackendData({ silent: true });
        return true;
    }

    if (
        target.id === "stlp_output_card_show_injection_details"
        || target.id === "stlp_output_card_show_pricing_details"
        || target.id === "stlp_output_card_show_context_volume"
        || target.id === "stlp_output_card_show_prompt_volume"
        || target.id === "stlp_output_card_show_extension_details"
        || target.id === "stlp_output_card_mask_chat_title"
    ) {
        const currentFields = getOutputCardFields();
        state.uiSettings.outputCardFields = {
            ...currentFields,
            showInjectionDetails: target.id === "stlp_output_card_show_injection_details" ? Boolean(target.checked) : currentFields.showInjectionDetails,
            showPricingDetails: target.id === "stlp_output_card_show_pricing_details" ? Boolean(target.checked) : currentFields.showPricingDetails,
            showContextVolume: target.id === "stlp_output_card_show_context_volume" ? Boolean(target.checked) : currentFields.showContextVolume,
            showPromptVolume: target.id === "stlp_output_card_show_prompt_volume" ? Boolean(target.checked) : currentFields.showPromptVolume,
            showExtensionDetails: target.id === "stlp_output_card_show_extension_details" ? Boolean(target.checked) : currentFields.showExtensionDetails,
            maskChatTitle: target.id === "stlp_output_card_mask_chat_title" ? Boolean(target.checked) : currentFields.maskChatTitle,
        };
        saveUiSettings();
        if (state.uiSettings.outputCardFields.showPromptVolume && state.confirmDialog?.runId) {
            void loadRunPromptBreakdown(state.confirmDialog.runId);
        }
        safeRenderPage();
        return true;
    }

    if (target.dataset.historySelectRunId) {
        toggleHistoryRunSelection(target.dataset.historySelectRunId, Boolean(target.checked));
        safeRenderPage();
        return true;
    }

    return false;
}

function handlePanelAction(actionTarget, event) {
    if (!(actionTarget instanceof HTMLElement)) {
        return false;
    }

    const action = actionTarget.dataset.action;
    const runId = actionTarget.dataset.runId || "";
    const sectionKey = actionTarget.dataset.sectionKey || "";
    const insidePage = Boolean(actionTarget.closest("#stlp_page"));
    const insideHistoryDialog = Boolean(actionTarget.closest(".stlp-history-dialog"));

    if (action === "start-call-timer") {
        startCallTimer();
        return true;
    }

    if (action === "stop-call-timer") {
        stopCallTimer();
        return true;
    }

    if (action === "refresh-call-timer") {
        void loadCallTimerRuns();
        return true;
    }

    if (action === "clear-call-timer") {
        clearCallTimerWindow();
        return true;
    }

    if (action === "view-call-timer-session") {
        viewCallTimerSession(actionTarget.dataset.sessionId || "");
        return true;
    }

    if (action === "toggle-call-timer-details") {
        toggleCallTimerDetail(actionTarget.dataset.callTimerScope || "");
        return true;
    }

    if (action === "save-call-timer-expected") {
        saveCallTimerExpectedSources();
        return true;
    }

    if (action === "clear-call-timer-expected") {
        clearCallTimerExpectedSources();
        return true;
    }

    if (action === "legacy-lite-view-on" || action === "legacy-lite-view-off") {
        toggleLegacyLiteViewing(action === "legacy-lite-view-on");
        return true;
    }

    if (action === "legacy-lite-export") {
        void exportLegacyLiteRuns();
        return true;
    }

    if (action === "legacy-lite-clear") {
        void clearLegacyLiteRuns();
        return true;
    }

    if (action === "pricing-cycle-currency") {
        const modelName = typeof actionTarget?.dataset.pricingModel === "string"
            ? actionTarget.dataset.pricingModel.trim()
            : "";
        if (!modelName) {
            return true;
        }

        const currentConfig = getModelPriceConfig(modelName) ?? {};
        const nextCurrency = normalizePricingCurrency(currentConfig.currency) === "usd" ? "cny" : "usd";
        persistPricingModelConfig(modelName, {
            ...currentConfig,
            currency: nextCurrency,
        });
        return true;
    }

    if (action === "sync-local-pricing") {
        void syncLocalOnlyPricingToBackend();
        return true;
    }

    if (action === "toggle-pricing-panel") {
        const modelName = typeof actionTarget?.dataset.pricingModel === "string"
            ? actionTarget.dataset.pricingModel.trim()
            : "";
        if (!modelName) {
            return true;
        }

        state.uiSettings.pricingPanelOpenStates = {
            ...getPricingPanelOpenStates(),
            [modelName]: !isPricingPanelOpen(modelName),
        };
        saveUiSettings();
        safeRenderPage();
        return true;
    }

    if (action === "toggle-pricing-peak-valley-panel") {
        const modelName = typeof actionTarget?.dataset.pricingModel === "string"
            ? actionTarget.dataset.pricingModel.trim()
            : "";
        if (!modelName) {
            return true;
        }

        state.uiSettings.pricingPeakValleyOpenStates = {
            ...getPricingPeakValleyOpenStates(),
            [modelName]: !isPricingPeakValleyPanelOpen(modelName),
        };
        saveUiSettings();
        safeRenderPage();
        return true;
    }

    if (action === "open-page") {
        openMonitorPage();
        return true;
    }

    if (action === "close-page") {
        if (shouldIgnoreMobileOpenGuard()) {
            return true;
        }
        requestClosePage();
        return true;
    }

    if (action === "minimize-page") {
        minimizePage();
        return true;
    }

    if (action === "restore-page") {
        if (Date.now() < state.minimizedButtonSuppressClickUntil) {
            return true;
        }
        restoreMinimizedPage();
        return true;
    }

    if (action === "confirm-close-keep-running") {
        confirmClosePage(true);
        return true;
    }

    if (action === "confirm-close-stop") {
        confirmClosePage(false);
        return true;
    }

    if (action === "confirm-generation-intervention-yes") {
        void executeGenerationStopAction();
        return true;
    }

    if (action === "confirm-generation-intervention-no") {
        clearPendingGenerationIntervention({ rememberDismissed: true });
        state.confirmDialog = null;
        safeRenderPage();
        return true;
    }

    if (action === "request-force-stop-generation") {
        openManualForceStopGenerationDialog();
        return true;
    }

    if (action === "confirm-manual-force-stop-yes") {
        void executeGenerationStopAction();
        return true;
    }

    if (action === "confirm-manual-force-stop-no") {
        closeCloseConfirm();
        return true;
    }

    if (action === "cycle-theme-mode") {
        cycleThemeMode();
        return true;
    }

    if (action === "confirm-clear-backend-yes") {
        void performClearBackendRuns();
        return true;
    }

    if (action === "confirm-clear-backend-no") {
        closeCloseConfirm();
        return true;
    }

    if (action === "dismiss-confirm-dialog") {
        if (shouldIgnoreMobileOpenGuard()) {
            return true;
        }
        if (state.confirmDialog?.type === "generation-intervention") {
            clearPendingGenerationIntervention({ rememberDismissed: true });
        }
        closeCloseConfirm();
        return true;
    }

    if (action === "cancel-confirm-dialog") {
        cancelConfirmDialog();
        return true;
    }

    if (action === "open-history-dialog") {
        openHistoryDialog();
        return true;
    }

    if (action === "open-settings") {
        openSettingsSection();
        return true;
    }

    if (action === "open-output-card" && runId) {
        openOutputCardDialog(runId, insideHistoryDialog ? "history" : "page");
        if (getOutputCardFields().showPromptVolume) {
            void loadRunPromptBreakdown(runId);
        }
        return true;
    }

    if (action === "copy-output-card-text" && runId) {
        void (async () => {
            const run = findRunById(runId);
            const copied = await copyTextToClipboard(buildOutputCardText(run));
            if (!copied) {
                openMessageDialog("排障输出卡", "复制失败了，这次没拿到剪贴板权限。");
                return;
            }
            state.apiStatus = "排障输出卡文本已复制";
            state.apiError = "";
            safeRenderPage();
        })();
        return true;
    }

    if (action === "toggle-output-card-mask-chat-title") {
        const currentFields = getOutputCardFields();
        state.uiSettings.outputCardFields = {
            ...currentFields,
            maskChatTitle: !currentFields.maskChatTitle,
        };
        saveUiSettings();
        safeRenderPage();
        return true;
    }

    if (action === "set-daily-summary-days") {
        const nextDays = normalizeDailySummaryDays(actionTarget?.dataset.days);
        if (nextDays === state.uiSettings.dailySummaryDays) {
            return true;
        }
        state.uiSettings.dailySummaryDays = nextDays;
        saveUiSettings();
        // 先渲染再拉数据：refreshBackendData 撞上进行中的刷新会直接早退，
        // 不先渲染的话按钮高亮要等到下一个自动刷新周期才挪，看起来像点击没生效。
        safeRenderPage();
        void refreshBackendData({ silent: true });
        return true;
    }

    if (action === "set-settings-category") {
        const nextCategory = normalizeSettingsCategory(actionTarget?.dataset.settingsCategory);
        const willOpen = nextCategory !== state.uiSettings.settingsCategory;
        state.uiSettings.settingsCategory = willOpen ? nextCategory : "none";
        if (willOpen && nextCategory === "appearance") {
            state.settingsSubsectionOpenStates = { ...DEFAULT_SETTINGS_SUBSECTION_OPEN_STATES };
        }
        saveUiSettings();
        safeRenderPage();
        return true;
    }

    if (action === "toggle-settings-subsection") {
        const subsectionKey = typeof actionTarget?.dataset.settingsSubsection === "string"
            ? actionTarget.dataset.settingsSubsection.trim()
            : "";
        if (!subsectionKey) {
            return true;
        }

        state.settingsSubsectionOpenStates = {
            ...state.settingsSubsectionOpenStates,
            [subsectionKey]: !isSettingsSubsectionOpen(subsectionKey),
        };
        safeRenderPage();
        return true;
    }

    if (action === "set-theme-mode") {
        state.uiSettings.themeMode = normalizeThemeMode(actionTarget?.dataset.themeMode);
        saveUiSettings();
        safeRenderPage();
        return true;
    }

    if (action === "toggle-daily-summary-row") {
        const dateKey = typeof actionTarget?.dataset.dateKey === "string" ? actionTarget.dataset.dateKey.trim() : "";
        if (!dateKey) {
            return true;
        }

        if (state.expandedDailySummaryDateKeys.has(dateKey)) {
            state.expandedDailySummaryDateKeys.delete(dateKey);
        } else {
            state.expandedDailySummaryDateKeys.add(dateKey);
        }
        safeRenderPage();
        return true;
    }

    if (action === "toggle-waiting-queue-entry") {
        const waitingRunId = typeof actionTarget?.dataset.runId === "string" ? actionTarget.dataset.runId.trim() : "";
        if (!waitingRunId) {
            return true;
        }

        if (state.expandedWaitingQueueRunIds.has(waitingRunId)) {
            state.expandedWaitingQueueRunIds.delete(waitingRunId);
        } else {
            state.expandedWaitingQueueRunIds.add(waitingRunId);
        }
        safeRenderPage();
        return true;
    }

    if (action === "toggle-plugin-rule-card") {
        const ruleId = typeof actionTarget?.dataset.ruleId === "string" ? actionTarget.dataset.ruleId.trim() : "";
        if (!ruleId) {
            return true;
        }

        if (state.expandedPluginRuleIds.has(ruleId)) {
            state.expandedPluginRuleIds.delete(ruleId);
        } else {
            state.expandedPluginRuleIds.add(ruleId);
        }
        safeRenderPage();
        return true;
    }

    if (action === "move-to-waiting-queue" && runId) {
        void moveRunToWaitingQueue(runId).catch((error) => {
            openMessageDialog("等待区操作失败", error instanceof Error ? error.message : String(error));
        });
        return true;
    }

    if (action === "submit-waiting-queue-label" && runId) {
        void submitWaitingQueueLabel(runId).catch((error) => {
            openMessageDialog("等待区操作失败", error instanceof Error ? error.message : String(error));
        });
        return true;
    }

    if (action === "remove-from-waiting-queue" && runId) {
        void removeRunFromWaitingQueue(runId).catch((error) => {
            openMessageDialog("等待区操作失败", error instanceof Error ? error.message : String(error));
        });
        return true;
    }

    if (action === "enable-plugin-rule" || action === "disable-plugin-rule") {
        const ruleId = typeof actionTarget?.dataset.ruleId === "string" ? actionTarget.dataset.ruleId.trim() : "";
        if (!ruleId) {
            return true;
        }

        void setPluginRuleEnabled(ruleId, action === "enable-plugin-rule").catch((error) => {
            openMessageDialog("规则操作失败", error instanceof Error ? error.message : String(error));
        });
        return true;
    }

    if (action === "dismiss-main-api-error") {
        // 点过就算确认过，立刻清掉，不管下一次请求成不成功。
        state.mainApiErrorActive = false;
        safeRenderPage();
        return true;
    }

    if (action === "resume-recording") {
        updateMonitorSettings({
            runtime: {
                recording_enabled: true,
            },
        }, { deferBusyRender: true, optimistic: true });
        return true;
    }

    if (action === "reapply-plugin-rule") {
        const ruleId = typeof actionTarget?.dataset.ruleId === "string" ? actionTarget.dataset.ruleId.trim() : "";
        if (!ruleId) {
            return true;
        }

        void reapplyPluginRule(ruleId).catch((error) => {
            openMessageDialog("规则操作失败", error instanceof Error ? error.message : String(error));
        });
        return true;
    }

    if (action === "request-remove-plugin-rule") {
        const ruleId = typeof actionTarget?.dataset.ruleId === "string" ? actionTarget.dataset.ruleId.trim() : "";
        const rule = getPluginRuleById(ruleId);
        if (!ruleId || !rule) {
            return true;
        }

        state.confirmDialog = {
            type: "message",
            title: "删除规则复用",
            text: `确认删除“${rule.plugin_label}”这条规则吗？删除后，新记录将不再使用它自动归类。`,
            actions: [
                { action: "confirm-remove-plugin-rule", label: "删除" },
                { action: "dismiss-confirm-dialog", label: "取消" },
            ],
            ruleId,
        };
        safeRenderPage();
        return true;
    }

    if (action === "confirm-remove-plugin-rule") {
        const ruleId = typeof state.confirmDialog?.ruleId === "string" ? state.confirmDialog.ruleId.trim() : "";
        closeCloseConfirm();
        if (!ruleId) {
            return true;
        }

        void removePluginRule(ruleId).catch((error) => {
            openMessageDialog("规则删除失败", error instanceof Error ? error.message : String(error));
        });
        return true;
    }

    if (action === "go-to-waiting-queue") {
        closeCloseConfirm();
        openWaitingQueueSection();
        return true;
    }

    if (action === "close-history-dialog") {
        if (shouldIgnoreMobileOpenGuard()) {
            return true;
        }
        closeHistoryDialog();
        return true;
    }

    if (action === "enter-history-delete-mode") {
        state.historyDeleteMode = true;
        clearHistorySelection();
        safeRenderPage();
        return true;
    }

    if (action === "refresh-history-dialog") {
        void refreshHistoryDialogData();
        return true;
    }

    if (action === "toggle-history-abnormal-only") {
        state.historyAbnormalOnly = !state.historyAbnormalOnly;
        clearHistorySelection();
        if (state.historyAbnormalOnly) {
            void loadAllHistoryRuns();
            return true;
        }
        state.historyAllRuns = [];
        safeRenderPage();
        return true;
    }

    if (action === "exit-history-delete-mode") {
        state.historyDeleteMode = false;
        clearHistorySelection();
        safeRenderPage();
        return true;
    }

    if (action === "history-prev-page") {
        if (!state.historyLoading && state.historyPage > 1) {
            void loadHistoryPage(state.historyPage - 1);
        }
        return true;
    }

    if (action === "history-next-page") {
        if (!state.historyLoading && state.historyPage < getHistoryTotalPages()) {
            void loadHistoryPage(state.historyPage + 1);
        }
        return true;
    }

    if (action === "open-history-delete-dialog") {
        if (getSelectedHistoryRunCount() <= 0) {
            return true;
        }
        clearHistoryRuns();
        return true;
    }

    if (action === "choose-clear-history-all") {
        state.confirmDialog = {
            type: "history-delete-confirm",
            scope: "all",
        };
        safeRenderPage();
        return true;
    }

    if (action === "choose-clear-history-normal") {
        state.confirmDialog = {
            type: "history-delete-confirm",
            scope: "normal_only",
        };
        safeRenderPage();
        return true;
    }

    if (action === "cancel-history-delete") {
        closeCloseConfirm();
        return true;
    }

    if (action === "toggle-history-page-selection") {
        toggleHistoryPageSelection(actionTarget.dataset.selectMode !== "clear", getVisibleHistoryRuns());
        safeRenderPage();
        return true;
    }

    if (action === "clear-history-selection") {
        clearHistorySelection();
        safeRenderPage();
        return true;
    }

    if (action === "confirm-clear-history-yes") {
        void performClearHistoryRuns(actionTarget.dataset.scope || "all");
        return true;
    }

    if (action === "confirm-clear-history-no") {
        closeCloseConfirm();
        return true;
    }

    if (action === "toggle-section" && sectionKey) {
        state.uiSettings.sectionOpenStates = normalizeSectionOpenStates(state.uiSettings.sectionOpenStates);
        const nextOpen = !state.uiSettings.sectionOpenStates[sectionKey];
        state.uiSettings.sectionOpenStates[sectionKey] = nextOpen;
        if (!nextOpen) {
            if (sectionKey === "runs") {
                collapseCurrentRunsDetails();
            }
            if (sectionKey === "history") {
                collapseHistoryRunsDetails();
            }
        }
        saveUiSettings();
        safeRenderPage();
        return true;
    }

    if (action === "toggle-run" && runId) {
        if (state.expandedRunIds.has(runId)) {
            state.expandedRunIds.delete(runId);
            state.expandedSuggestionRunIds.delete(runId);
        } else {
            state.expandedRunIds.add(runId);
            void loadRunPromptBreakdown(runId);
        }
        safeRenderPage();
        return true;
    }

    if (action === "toggle-suggestions" && runId) {
        if (state.expandedSuggestionRunIds.has(runId)) {
            state.expandedSuggestionRunIds.delete(runId);
        } else {
            state.expandedSuggestionRunIds.add(runId);
            state.expandedRunIds.add(runId);
        }
        safeRenderPage();
        return true;
    }

    return false;
}

function handlePanelClickTarget(target, event) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    const actionTarget = target.closest("[data-action]");
    if (handlePanelAction(actionTarget, event)) {
        return true;
    }

    const purposeTarget = target.closest("[data-nav-purpose]");
    if (purposeTarget instanceof HTMLElement) {
        void setActiveRequestPurpose(purposeTarget.dataset.navPurpose);
        return true;
    }

    const navActionTarget = target.closest("[data-nav-action]");
    if (navActionTarget instanceof HTMLElement) {
        if (navActionTarget.dataset.navAction === "open-status") {
            openStatusSection();
            return true;
        }
        if (navActionTarget.dataset.navAction === "open-waiting-queue") {
            openWaitingQueueSection();
            return true;
        }
        if (navActionTarget.dataset.navAction === "open-daily-summary") {
            openDailySummarySection();
            return true;
        }
        if (navActionTarget.dataset.navAction === "open-call-timer") {
            openCallTimerSection();
            return true;
        }
        if (navActionTarget.dataset.navAction === "open-settings") {
            openSettingsSection();
            return true;
        }
    }

    if (target.id === "stlp_refresh_runs") {
        void refreshBackendData();
        return true;
    }

    if (target.id === "stlp_export_runs") {
        const payload = JSON.stringify(state.runs, null, 2);
        const blob = new Blob([payload], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `st-latency-monitor-runs-${Date.now()}.json`;
        link.click();
        URL.revokeObjectURL(url);
        return true;
    }

    if (target.id === "stlp_clear_runs") {
        clearBackendRuns();
        return true;
    }

    return false;
}

function bindRenderedPageActions() {
    if (!(state.pageRoot instanceof HTMLElement)) {
        return;
    }

    state.pageRoot.querySelectorAll("[data-action]").forEach((element) => {
        if (!(element instanceof HTMLElement)) {
            return;
        }

        element.addEventListener("click", (event) => {
            runSafely("处理面板直接点击绑定", () => {
                event.preventDefault();
                event.stopPropagation();
                handlePanelAction(element, event);
            });
        });
    });

    state.pageRoot.querySelectorAll("[data-nav-purpose]").forEach((element) => {
        if (!(element instanceof HTMLElement)) {
            return;
        }

        element.addEventListener("click", (event) => {
            runSafely("处理侧栏用途切换点击", () => {
                event.preventDefault();
                event.stopPropagation();
                void setActiveRequestPurpose(element.dataset.navPurpose);
            });
        });
    });

    state.pageRoot.querySelectorAll("[data-nav-action]").forEach((element) => {
        if (!(element instanceof HTMLElement)) {
            return;
        }

        element.addEventListener("click", (event) => {
            runSafely("处理侧栏动作点击", () => {
                event.preventDefault();
                event.stopPropagation();
                if (element.dataset.navAction === "open-status") {
                    openStatusSection();
                    return;
                }
                if (element.dataset.navAction === "open-waiting-queue") {
                    openWaitingQueueSection();
                    return;
                }
                if (element.dataset.navAction === "open-daily-summary") {
                    openDailySummarySection();
                    return;
                }
                if (element.dataset.navAction === "open-call-timer") {
                    openCallTimerSection();
                    return;
                }
                if (element.dataset.navAction === "open-settings") {
                    openSettingsSection();
                }
            });
        });
    });

    ["stlp_refresh_runs", "stlp_export_runs", "stlp_clear_runs"].forEach((id) => {
        const element = state.pageRoot?.querySelector(`#${id}`);
        if (!(element instanceof HTMLElement)) {
            return;
        }

        element.addEventListener("click", (event) => {
            runSafely("处理面板直接按钮绑定", () => {
                event.preventDefault();
                event.stopPropagation();
                handlePanelClickTarget(element, event);
            });
        });
    });
}

function bindPageRootEvents() {
    if (!(state.pageRoot instanceof HTMLElement) || state.pageRoot.dataset.stlpBound === "true") {
        return;
    }

    state.pageRoot.dataset.stlpBound = "true";

    state.pageRoot.addEventListener("change", (event) => {
        runSafely("处理面板根节点变更", () => {
            if (isMobileDrawerLayout()) {
                event.stopPropagation();
            }
            handlePanelChangeTarget(event.target);
        });
    });

    state.pageRoot.addEventListener("focusin", (event) => {
        runSafely("处理面板焦点进入", () => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLSelectElement)) {
                return;
            }

            if (target instanceof HTMLInputElement && target.dataset.waitingLabelRunId) {
                setWaitingQueueEditLock(target.dataset.waitingLabelRunId);
            }

            if (!isMobileDrawerLayout()) {
                return;
            }

            scheduleViewportSync();
            if (isColorWheelInputTarget(target)) {
                return;
            }
            if (target instanceof HTMLInputElement && target.dataset.waitingLabelRunId) {
                return;
            }
            scheduleMobileFieldIntoView(target);
        });
    });

    state.pageRoot.addEventListener("focusout", (event) => {
        runSafely("处理等待区焦点离开", () => {
            const target = event.target;
            if (isColorWheelInputTarget(target)) {
                window.setTimeout(() => {
                    runSafely("处理色轮延后刷新", () => {
                        flushDeferredColorWheelRender();
                    });
                }, 0);
                return;
            }

            if (!(target instanceof HTMLInputElement) || !target.dataset.waitingLabelRunId) {
                return;
            }

            const runId = target.dataset.waitingLabelRunId;
            setWaitingQueueEditLock(runId);
            window.setTimeout(() => {
                runSafely("处理等待区延后刷新", () => {
                    const activeElement = document.activeElement;
                    if (activeElement instanceof HTMLInputElement && activeElement.dataset.waitingLabelRunId) {
                        return;
                    }

                    clearWaitingQueueEditLock(runId);
                    flushDeferredWaitingQueueRender();
                });
            }, 0);
        });
    });

    state.pageRoot.addEventListener("pointerdown", (event) => {
        if (!isMobileDrawerLayout()) {
            return;
        }

        const target = event.target;
        if (target instanceof Element && target.closest('[data-action-drag="drag-minimized-page"]')) {
            return;
        }

        event.stopPropagation();
    });

    state.pageRoot.addEventListener("click", (event) => {
        runSafely("处理面板根节点点击", () => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) {
                return;
            }

             const clickedInsideDialog = target.closest(".stlp-confirm-dialog, .stlp-output-card-dialog");
             const clickedFunctionalTarget = target.closest('[data-action], button, input, select, textarea, a[href], label');
             if (state.confirmDialog && !clickedInsideDialog && !clickedFunctionalTarget) {
                 if (state.confirmDialog.type === "generation-intervention") {
                     clearPendingGenerationIntervention({ rememberDismissed: true });
                 }
                 closeCloseConfirm();
                 event.preventDefault();
                 event.stopPropagation();
                 return;
             }

            if (isMobileDrawerLayout()) {
                event.stopPropagation();
            }

            if (handlePanelClickTarget(target, event)) {
                event.preventDefault();
                event.stopPropagation();
            }
        });
    });
}

function bindUiEvents() {
    if (state.eventsBound) {
        return;
    }

    // 捕获阶段监听：中途有谁 stopPropagation 也不会漏掉收尾，否则面板会一直停更。
    document.addEventListener("pointerdown", (event) => {
        runSafely("记录滑块交互开始", () => {
            const target = event.target;
            if (!(target instanceof HTMLElement)
                || !target.matches(".stlp-slider-input")
                || !target.closest("#stlp_page")) {
                return;
            }

            beginPanelSliderInteraction(event.pointerId);
        });
    }, true);

    const handlePanelSliderInteractionEnd = (event) => {
        runSafely("记录滑块交互结束", () => {
            if (state.sliderInteractionPointerId === null
                || (event && event.pointerId !== state.sliderInteractionPointerId)) {
                return;
            }

            endPanelSliderInteraction();
        });
    };
    document.addEventListener("pointerup", handlePanelSliderInteractionEnd, true);
    document.addEventListener("pointercancel", handlePanelSliderInteractionEnd, true);

    document.addEventListener("input", (event) => {
        runSafely("处理等待区输入", () => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) {
                return;
            }

            if (!target.closest("#stlp_page")) {
                return;
            }

            if (target.id === "stlp_minimized_button_opacity") {
                // 拖动过程中只更新数字，不走整页重渲染——重渲染会换掉正在拖的这个滑块，
                // 手指还按着就断了。落值靠松手时的 change 事件。
                state.uiSettings.minimizedButtonOpacity = normalizeMinimizedButtonOpacity(target.value);
                saveUiSettings();
                const valueLabel = target.closest(".stlp-slider-row")?.querySelector("[data-stlp-opacity-value]");
                if (valueLabel) {
                    valueLabel.textContent = `${getMinimizedButtonOpacityPercent()}%`;
                }
                return;
            }

            if (target.dataset.waitingLabelRunId) {
                setWaitingQueueEditLock(target.dataset.waitingLabelRunId);
                handlePanelChangeTarget(target);
            }
        });
    });

    document.addEventListener("change", (event) => {
        runSafely("处理面板变更", () => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) {
                return;
            }

            if (target.closest("#stlp_page")) {
                if (isMobileDrawerLayout()) {
                    return;
                }
                handlePanelChangeTarget(target);
                return;
            }
        });
    });

    document.addEventListener("load", (event) => {
        runSafely("处理头像图片加载", () => {
            const target = event.target;
            if (!(target instanceof HTMLImageElement)) {
                return;
            }

            if (!target.closest(".avatar, .mesAvatar")) {
                return;
            }

            scheduleChatMessageUiNormalization();
        });
    }, true);

    document.addEventListener("pointerdown", (event) => {
        runSafely("记录调试交互命中", () => {
            if (!state.pageOpen) {
                return;
            }

            const target = event.target;
            if (!(target instanceof Element) || !target.closest("#stlp_page")) {
                return;
            }

        });
    }, true);

    document.addEventListener("click", (event) => {
        runSafely("处理面板点击", () => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) {
                return;
            }

            if (state.confirmDialog && target.closest("#stlp_page")) {
                const clickedInsideDialog = target.closest(".stlp-confirm-dialog, .stlp-output-card-dialog");
                const clickedFunctionalTarget = target.closest('[data-action], button, input, select, textarea, a[href], label');
                if (!clickedInsideDialog && !clickedFunctionalTarget) {
                    if (state.confirmDialog.type === "generation-intervention") {
                        clearPendingGenerationIntervention({ rememberDismissed: true });
                    }
                    closeCloseConfirm();
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
            }

            if (state.pageOpen && target.closest("#stlp_page")) {
                if (isMobileDrawerLayout()) {
                    return;
                }
                handlePanelClickTarget(target, event);
                return;
            }

            handlePanelClickTarget(target, event);
        });
    });

    document.addEventListener("keydown", (event) => {
        runSafely("处理快捷键", () => {
            if (!state.pageOpen || event.key !== "Escape" || shouldIgnoreSyntheticEscapeForMonitor(event)) {
                return;
            }

            if (state.pageMinimized) {
                return;
            }

            if (state.confirmDialog) {
                cancelConfirmDialog();
                return;
            }

            if (state.historyDialogOpen) {
                closeHistoryDialog();
                return;
            }

            requestClosePage();
        });
    });

    document.addEventListener("pointerdown", (event) => {
        runSafely("处理拖动起点", () => {
            const target = event.target;
            if (!(target instanceof Element)) {
                return;
            }

            const minimizedDragHandle = target.closest('[data-action-drag="drag-minimized-page"]');
            if (minimizedDragHandle instanceof HTMLElement) {
                startMinimizedButtonDrag(event);
                if (typeof minimizedDragHandle.setPointerCapture === "function") {
                    try {
                        minimizedDragHandle.setPointerCapture(event.pointerId);
                    } catch {
                        // Ignore pointer capture failures so the page stays usable.
                    }
                }
                return;
            }

            if (target.closest(".stlp-confirm-dialog")) {
                return;
            }

            if (target.closest(".stlp-history-dialog")) {
                return;
            }

            if (target.closest('[data-action="close-page"]')) {
                return;
            }

            if (target.closest(".stlp-page-header-actions")) {
                return;
            }

            const resizeHandle = target.closest('[data-action="resize-page"]');
            if (resizeHandle instanceof HTMLElement) {
                startPageResize(event);
                if (typeof resizeHandle.setPointerCapture === "function") {
                    try {
                        resizeHandle.setPointerCapture(event.pointerId);
                    } catch {
                        // Ignore pointer capture failures so the page stays usable.
                    }
                }
                return;
            }

            const dragHandle = target.closest('[data-action="drag-page"]');
            if (!(dragHandle instanceof HTMLElement)) {
                return;
            }

            startPageDrag(event);
            if (typeof dragHandle.setPointerCapture === "function") {
                try {
                    dragHandle.setPointerCapture(event.pointerId);
                } catch {
                    // Ignore pointer capture failures so the page stays usable.
                }
            }
        });
    });

    document.addEventListener("pointermove", (event) => {
        runSafely("处理拖动过程", () => {
            handleMinimizedButtonDragMove(event);
            handlePageDragMove(event);
            handlePageResizeMove(event);
        });
    });

    document.addEventListener("pointerup", (event) => {
        runSafely("处理拖动结束", () => {
            endMinimizedButtonDrag(event);
            endPageDrag(event);
            endPageResize(event);
        });
    });

    document.addEventListener("pointercancel", (event) => {
        runSafely("处理拖动取消", () => {
            handleMinimizedButtonDragCancel(event);
            endPageDrag(event);
            endPageResize(event);
        });
    });

    window.addEventListener("resize", () => {
        runSafely("处理页面尺寸变化", () => {
            if (!state.pageOpen) {
                return;
            }

            if (isMobileDrawerLayout()) {
                scheduleViewportSync();
                return;
            }

            const dialog = state.pageRoot?.querySelector(".stlp-page-dialog");
            const rect = dialog instanceof HTMLElement ? dialog.getBoundingClientRect() : {};
            if (state.pagePosition) {
                state.pagePosition = clampPagePosition(state.pagePosition, rect);
                state.pageHeight = getClampedDesktopDialogHeight(state.pageHeight, state.pagePosition.top);
            } else {
                state.pageHeight = getClampedDesktopDialogHeight(state.pageHeight, 16);
            }
            safeRenderPage();
        });
    });

    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", () => {
            runSafely("处理可视视口变化", () => {
                scheduleViewportSync();
            });
        });

        window.visualViewport.addEventListener("scroll", () => {
            runSafely("处理可视视口滚动", () => {
                scheduleViewportSync();
            });
        });
    }

    window.addEventListener("pagehide", () => {
        unlockBodyScrollForMobileDrawer();
    });

    state.eventsBound = true;
}

function togglePage(nextOpen) {
    state.pageOpen = Boolean(nextOpen);
    if (state.pageOpen) {
        state.pageMinimized = false;
        state.confirmDialog = null;
    } else {
        state.pageMinimized = false;
        state.confirmDialog = null;
        state.historyDialogOpen = false;
        if (!isIosWebKit()) {
            restoreNativeMenuState();
        }
    }
    syncBodyScrollLock();
    scheduleAutoRefresh();
    safeRenderPage();
}

function requestClosePage() {
    blurWaitingQueueInput();
    state.confirmDialog = {
        type: "close-page",
    };
    safeRenderPage();
}

function closeCloseConfirm() {
    if (!state.confirmDialog) {
        return;
    }

    state.confirmDialog = null;
    safeRenderPage();
}

function cancelConfirmDialog() {
    if (!state.confirmDialog) {
        return;
    }

    if (state.confirmDialog.type === "close-page") {
        confirmClosePage(false);
        return;
    }

    closeCloseConfirm();
}

function confirmClosePage(keepRunning) {
    state.uiSettings.keepRunningAfterClose = keepRunning;
    saveUiSettings();
    state.confirmDialog = null;
    togglePage(false);
}

function removeLegacyLauncher() {
    const existingLauncher = document.querySelector("#stlp_launcher_wrap");
    if (existingLauncher instanceof HTMLElement) {
        existingLauncher.remove();
    }

    state.launcherRoot = null;
}

function scheduleNativeMenuEntryRepair() {
    if (state.nativeMenuRepairScheduled) {
        return;
    }

    state.nativeMenuRepairScheduled = true;
    window.requestAnimationFrame(() => {
        state.nativeMenuRepairScheduled = false;
        runSafely("同步魔棒入口", () => {
            ensureLauncher();
        });
    });
}

function runWithNativeMenuObserverSilenced(callback) {
    state.nativeMenuObserverSilenced = true;
    try {
        return callback();
    } finally {
        window.setTimeout(() => {
            state.nativeMenuObserverSilenced = false;
        }, 0);
    }
}

function startNativeMenuObserver() {
    const menuRoot = document.querySelector("#extensionsMenu");
    if (!(menuRoot instanceof HTMLElement)) {
        if (isTrackedMutationObserverInstance(state.nativeMenuObserver)) {
            state.nativeMenuObserver.disconnect();
        }
        state.nativeMenuObserver = null;
        state.nativeMenuObserverRoot = null;
        return;
    }

    if (!supportsMutationObserver()) {
        state.nativeMenuObserver = null;
        state.nativeMenuObserverRoot = menuRoot;
        return;
    }

    if (state.nativeMenuObserverRoot === menuRoot && isTrackedMutationObserverInstance(state.nativeMenuObserver)) {
        return;
    }

    if (isTrackedMutationObserverInstance(state.nativeMenuObserver)) {
        state.nativeMenuObserver.disconnect();
    }

    const observer = new MutationObserver(() => {
        if (state.nativeMenuObserverSilenced) {
            return;
        }
        scheduleNativeMenuEntryRepair();
    });

    observer.observe(menuRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "aria-hidden"],
    });

    state.nativeMenuObserver = observer;
    state.nativeMenuObserverRoot = menuRoot;
}

function restoreNativeMenuState() {
    const menuRoot = document.querySelector("#extensionsMenu");
    const button = document.querySelector("#extensionsMenuButton");

    if (!(menuRoot instanceof HTMLElement)) {
        return;
    }

    if (menuRoot.dataset.stlpForceHidden !== "true") {
        return;
    }

    menuRoot.style.removeProperty("display");
    menuRoot.style.removeProperty("visibility");
    menuRoot.style.removeProperty("opacity");
    menuRoot.style.removeProperty("pointer-events");
    menuRoot.hidden = true;
    menuRoot.setAttribute("aria-hidden", "true");
    delete menuRoot.dataset.stlpForceHidden;

    if (button instanceof HTMLElement && button.dataset.stlpForceCollapsed === "true") {
        button.setAttribute("aria-expanded", "false");
        delete button.dataset.stlpForceCollapsed;
    }
}

function bindNativeMenuButtonGuard() {
    const button = document.querySelector("#extensionsMenuButton");
    if (!(button instanceof HTMLElement) || button.dataset.stlpRestoreBound === "true") {
        return;
    }

    button.dataset.stlpRestoreBound = "true";

    const restoreBeforeNativeOpen = () => {
        if (state.pageOpen && !state.pageMinimized) {
            return;
        }

        const menuRoot = document.querySelector("#extensionsMenu");
        if (!(menuRoot instanceof HTMLElement)) {
            return;
        }

        if (menuRoot.dataset.stlpForceHidden === "true" || button.dataset.stlpForceCollapsed === "true") {
            restoreNativeMenuState();
        }
    };

    button.addEventListener("pointerdown", restoreBeforeNativeOpen, true);
    button.addEventListener("click", restoreBeforeNativeOpen, true);
}

function closeNativeMenu({ forceDirectHide = false } = {}) {
    const menuRoot = document.querySelector("#extensionsMenu");
    const button = document.querySelector("#extensionsMenuButton");
    const menuVisible = menuRoot instanceof HTMLElement && (() => {
        const style = window.getComputedStyle(menuRoot);
        return style.display !== "none"
            && style.visibility !== "hidden"
            && style.opacity !== "0";
    })();
    const buttonExpanded = button instanceof HTMLElement && button.getAttribute("aria-expanded") === "true";
    if (!menuVisible && !buttonExpanded) {
        return;
    }

    if (!forceDirectHide && button instanceof HTMLElement) {
        button.click();
        return;
    }

    if (forceDirectHide && menuRoot instanceof HTMLElement) {
        menuRoot.style.display = "none";
        menuRoot.style.visibility = "hidden";
        menuRoot.style.opacity = "0";
        menuRoot.style.pointerEvents = "none";
        menuRoot.hidden = true;
        menuRoot.setAttribute("aria-hidden", "true");
        menuRoot.dataset.stlpForceHidden = "true";
    }

    if (button instanceof HTMLElement) {
        button.setAttribute("aria-expanded", "false");
        button.dataset.stlpForceCollapsed = "true";
    }
}

function bindNativeMenuEntry(entry) {
    if (!(entry instanceof HTMLElement)) {
        return;
    }

    const activateEntry = (event) => {
        event.preventDefault();
        event.stopPropagation();
        openMonitorPage();
    };

    if (entry.dataset.stlpBound !== "true") {
        entry.dataset.stlpBound = "true";
        entry.addEventListener("click", activateEntry);
        entry.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                activateEntry(event);
            }
        });
    }

    const innerEntry = entry.querySelector(".stlp-wand-entry-item");
    if (innerEntry instanceof HTMLElement && innerEntry.dataset.stlpBound !== "true") {
        innerEntry.dataset.stlpBound = "true";
        innerEntry.addEventListener("click", activateEntry);
        innerEntry.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                activateEntry(event);
            }
        });
    }
}

function getNativeMenuTemplateEntry(menuRoot) {
    if (!(menuRoot instanceof HTMLElement)) {
        return null;
    }

    const children = Array.from(menuRoot.children).filter((child) => (
        child instanceof HTMLElement && child.id !== "stlp_wand_entry"
    ));

    return children.find((child) => (
        !child.classList.contains("mc3-hidden")
        && getComputedStyle(child).display !== "none"
    )) ?? children[0] ?? null;
}

function buildMenuTemplateClasses(source, fallback) {
    if (!(source instanceof HTMLElement) || !source.className) {
        return fallback;
    }

    const sanitized = source.className
        .split(/\s+/)
        .map((name) => name.trim())
        .filter(Boolean)
        .filter((name) => (
            name !== "mc3-hidden"
            && name !== "stlp-wand-entry"
            && name !== "stlp-wand-entry-item"
        ));

    return sanitized.length ? sanitized.join(" ") : fallback;
}

function buildMenuTemplateIconClasses(source) {
    const fallback = "fa-solid fa-chart-column extensionsMenuExtensionButton";
    if (!(source instanceof HTMLElement) || !source.className) {
        return fallback;
    }

    const preserved = source.className
        .split(/\s+/)
        .map((name) => name.trim())
        .filter(Boolean)
        .filter((name) => !/^fa[srlbdk]?-/.test(name));

    return Array.from(new Set(["fa-solid", "fa-chart-column", ...preserved])).join(" ");
}

function buildMenuTemplateLabelClasses(source) {
    if (!(source instanceof HTMLElement) || !source.className) {
        return "stlp-wand-entry-label";
    }

    const sanitized = source.className
        .split(/\s+/)
        .map((name) => name.trim())
        .filter(Boolean)
        .filter((name) => name !== "stlp-wand-entry-label");

    return sanitized.length
        ? `${sanitized.join(" ")} stlp-wand-entry-label`
        : "stlp-wand-entry-label";
}

function createNativeMenuItemFromTemplate(templateItem) {
    const item = document.createElement("div");
    item.className = `${buildMenuTemplateClasses(templateItem, "list-group-item flex-container flexGap5 interactable")} stlp-wand-entry-item`;
    item.setAttribute("tabindex", "0");
    item.setAttribute("role", "listitem");
    item.hidden = false;
    item.removeAttribute("aria-hidden");

    const iconElement = document.createElement("div");
    iconElement.className = buildMenuTemplateIconClasses(
        templateItem instanceof HTMLElement ? templateItem.querySelector(".extensionsMenuExtensionButton") : null,
    );
    iconElement.setAttribute("aria-hidden", "true");

    const templateLabelElement = templateItem instanceof HTMLElement
        ? Array.from(templateItem.children).find((child) => (
            child instanceof HTMLElement && !child.classList.contains("extensionsMenuExtensionButton")
        )) || templateItem.querySelector("span")
        : null;
    const labelElement = document.createElement("span");
    labelElement.textContent = MODULE_DISPLAY_NAME;
    labelElement.className = buildMenuTemplateLabelClasses(
        templateLabelElement instanceof HTMLElement ? templateLabelElement : null,
    );

    item.replaceChildren(iconElement, labelElement);

    return item;
}

function resolveNativeMenuTemplateItem(templateEntry) {
    if (!(templateEntry instanceof HTMLElement)) {
        return null;
    }

    const nestedItem = templateEntry.querySelector(":scope > .list-group-item");
    if (nestedItem instanceof HTMLElement) {
        return nestedItem;
    }

    return templateEntry.classList.contains("list-group-item") ? templateEntry : null;
}

function buildNativeMenuEntryContent(templateItem) {
    const iconElement = document.createElement("div");
    iconElement.className = buildMenuTemplateIconClasses(
        templateItem instanceof HTMLElement ? templateItem.querySelector(".extensionsMenuExtensionButton") : null,
    );
    iconElement.setAttribute("aria-hidden", "true");

    const templateLabelElement = templateItem instanceof HTMLElement
        ? Array.from(templateItem.children).find((child) => (
            child instanceof HTMLElement && !child.classList.contains("extensionsMenuExtensionButton")
        )) || templateItem.querySelector("span")
        : null;
    const labelElement = document.createElement("span");
    labelElement.textContent = MODULE_DISPLAY_NAME;
    labelElement.className = buildMenuTemplateLabelClasses(
        templateLabelElement instanceof HTMLElement ? templateLabelElement : null,
    );

    return [iconElement, labelElement];
}

function syncNativeMenuEntryPresentation(entry, templateEntry) {
    if (!(entry instanceof HTMLElement)) {
        return;
    }

    const templateItem = resolveNativeMenuTemplateItem(templateEntry);
    const usesNestedMenuItem = templateItem instanceof HTMLElement && templateItem !== templateEntry;
    entry.className = `${buildMenuTemplateClasses(
        usesNestedMenuItem ? templateEntry : templateItem,
        usesNestedMenuItem ? "extension_container interactable" : "list-group-item flex-container flexGap5 interactable",
    )} stlp-wand-entry`;
    const order = entry.style.order || (templateEntry instanceof HTMLElement ? String(Array.from(templateEntry.parentElement?.children || []).length + 1) : "99");
    entry.setAttribute("tabindex", usesNestedMenuItem ? String(templateEntry?.tabIndex || 0) : String(templateItem?.tabIndex || templateEntry?.tabIndex || 0));
    entry.style.order = order;
    entry.style.removeProperty("display");
    entry.style.removeProperty("visibility");
    entry.style.removeProperty("opacity");
    entry.style.removeProperty("pointer-events");
    entry.hidden = false;
    entry.removeAttribute("aria-hidden");
    entry.title = MODULE_DISPLAY_NAME;
    entry.setAttribute("role", usesNestedMenuItem ? "none" : (templateItem?.getAttribute("role") || "listitem"));

    const contentNodes = buildNativeMenuEntryContent(templateItem);
    if (usesNestedMenuItem) {
        const nextItem = createNativeMenuItemFromTemplate(templateItem);
        if (nextItem instanceof HTMLElement) {
            entry.replaceChildren(nextItem);
        }
        return;
    }

    entry.replaceChildren(...contentNodes);
}

function ensureNativeMenuItem() {
    const menuRoot = document.querySelector("#extensionsMenu");
    if (!(menuRoot instanceof HTMLElement)) {
        state.nativeMenuItemRegistered = false;
        return false;
    }

    if (!isIosWebKit() && !state.pageOpen && !state.pageMinimized && menuRoot.dataset.stlpForceHidden === "true") {
        restoreNativeMenuState();
    }

    return runWithNativeMenuObserverSilenced(() => {
        const templateEntry = getNativeMenuTemplateEntry(menuRoot);
        const duplicatedEntries = Array.from(document.querySelectorAll("#stlp_wand_entry"));
        const menuEntries = duplicatedEntries.filter((entry) => entry instanceof HTMLElement && entry.parentElement === menuRoot);
        const existingEntry = menuEntries[0] instanceof HTMLElement ? menuEntries[0] : null;

        duplicatedEntries.forEach((entry) => {
            if (!(entry instanceof HTMLElement)) {
                return;
            }

            if (entry !== existingEntry) {
                entry.remove();
            }
        });

        if (existingEntry instanceof HTMLElement) {
            syncNativeMenuEntryPresentation(existingEntry, templateEntry);
            bindNativeMenuEntry(existingEntry);
            state.launcherRoot = existingEntry;
            state.nativeMenuItemRegistered = true;
            return true;
        }

        const entry = document.createElement(
            templateEntry instanceof HTMLElement ? templateEntry.tagName.toLowerCase() : "button",
        );
        entry.id = "stlp_wand_entry";
        if (entry instanceof HTMLButtonElement) {
            entry.type = "button";
        }
        entry.dataset.action = "open-page";
        syncNativeMenuEntryPresentation(entry, templateEntry);
        bindNativeMenuEntry(entry);
        menuRoot.appendChild(entry);
        state.nativeMenuItemRegistered = true;

        const button = document.querySelector("#extensionsMenuButton");
        if (button instanceof HTMLElement) {
            button.style.display = "flex";
        }

        bindNativeMenuButtonGuard();

        removeLegacyLauncher();
        state.launcherRoot = entry;
        return true;
    });
}

function ensureLauncher() {
    if (state.extensionDisabled) {
        return false;
    }

    return ensureNativeMenuItem();
}

function ensurePage() {
    if (state.extensionDisabled) {
        return false;
    }

    const legacyPanel = document.querySelector("#stlp_panel");
    if (legacyPanel instanceof HTMLElement) {
        legacyPanel.remove();
    }

    const existingPage = document.querySelector("#stlp_page");
    if (existingPage instanceof HTMLElement) {
        const shouldRenderExistingPage = state.pageRoot !== existingPage || !existingPage.hasChildNodes();
        if (existingPage.parentElement !== document.documentElement) {
            document.documentElement.appendChild(existingPage);
        }
        state.pageRoot = existingPage;
        bindPageRootEvents();
        if (shouldRenderExistingPage) {
            safeRenderPage();
        }
        return true;
    }

    const pageRoot = document.createElement("div");
    pageRoot.id = "stlp_page";
    pageRoot.className = "stlp-page-host";
    document.documentElement.appendChild(pageRoot);
    state.pageRoot = pageRoot;
    bindPageRootEvents();
    safeRenderPage();
    return true;
}

function ensureUi() {
    const launcherReady = ensureLauncher();
    const pageReady = ensurePage();
    startNativeMenuObserver();
    state.uiReady = Boolean(launcherReady && pageReady);
    scheduleAutoRefresh();
    return state.uiReady;
}

function startUiRetryLoop() {
    clearUiRetryTimer();

    if (state.extensionDisabled) {
        return;
    }

    state.uiRetryTimerId = window.setInterval(() => {
        runSafely("查找独立页面入口", () => {
            ensureUi();
        });
    }, UI_RETRY_MS);
}

function init() {
    runSafely("初始化扩展", () => {
        if (pendingUiSettingsMigrationSave) {
            saveUiSettings();
            pendingUiSettingsMigrationSave = false;
        }
        // 尽早开始探测形态：记录不应该等面板初始化完才开始，
        // 否则页面刚打开就发起的那次生成会被漏掉。
        void ensureRecordSourceMode().then(() => refreshLegacyLiteRunCount());
        installGenerationSettingsHook();
        installOutgoingGenerationHook();
        bindUiEvents();
        ensureUi();
        startChatUiObserver();
        startUiRetryLoop();
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
        init();
    });
} else {
    init();
}
