#!/usr/bin/env node
// 一键安装 / 更新 / 卸载。
//
//   node install.mjs <SillyTavern 根目录>
//   node install.mjs <SillyTavern 根目录> --dry-run     只检查不落盘
//   node install.mjs <SillyTavern 根目录> --uninstall   还原本体并删除装进去的文件
//
// 补丁部分是幂等的：每一处先按内容特征判断是否已经打过，打过就跳过。
// 因此升级酒馆之后直接重跑即可，不会重复插入，也不会覆盖你手工改的别的东西。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    getChatCompletionsPatches,
    chatCompletionsPatchTarget,
} from './backend-monitor-minimal/shared/chat-completions-patch.js';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR_NAME = 'st-latency-profiler';
const PLUGIN_DIR_NAME = 'st-latency-monitor';
const TARGET_FILE = path.join(...chatCompletionsPatchTarget.split('/'));
// 固定名字而不是带时间戳：只在第一次安装时创建，保证它永远是最原始的那一份。
// 用时间戳会在反复重装后堆出几十个备份，反而找不到哪个是干净的。
const BACKUP_SUFFIX = '.st-latency-monitor.bak';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

let dryRun = false;
let hasFailure = false;

function ok(message) {
    console.log(`  ${GREEN}✓${RESET} ${message}`);
}

function skip(message) {
    console.log(`  ${DIM}·${RESET} ${DIM}${message}${RESET}`);
}

function warn(message) {
    console.log(`  ${YELLOW}!${RESET} ${message}`);
}

function fail(message) {
    hasFailure = true;
    console.log(`  ${RED}✗${RESET} ${message}`);
}

function die(message) {
    console.error(`\n${RED}安装中止${RESET}：${message}\n`);
    process.exit(1);
}

/** 复制清单：源相对仓库根，目标相对酒馆根。 */
const COPY_PLAN = [
    { from: 'index.js', to: `public/scripts/extensions/third-party/${EXTENSION_DIR_NAME}/index.js` },
    { from: 'style.css', to: `public/scripts/extensions/third-party/${EXTENSION_DIR_NAME}/style.css` },
    { from: 'manifest.json', to: `public/scripts/extensions/third-party/${EXTENSION_DIR_NAME}/manifest.json` },
    // 精简版攒在浏览器 IndexedDB 里的记录，升级后要能查看/导出/清除，靠的就是这个
    // 零依赖的存储层。不带上它，设置里"还剩 N 条旧记录"的提示永远不会出现。
    { from: 'lite/run-store.js', to: `public/scripts/extensions/third-party/${EXTENSION_DIR_NAME}/lite/run-store.js` },
    { from: 'backend-monitor-minimal/latency-monitor.js', to: 'src/latency-monitor.js' },
    { from: 'backend-monitor-minimal/luker-latency-monitor.js', to: 'src/luker-latency-monitor.js' },
    { from: 'backend-monitor-minimal/server-plugin/index.js', to: `plugins/${PLUGIN_DIR_NAME}/index.js` },
    { from: 'backend-monitor-minimal/server-plugin/package.json', to: `plugins/${PLUGIN_DIR_NAME}/package.json` },
    // settings-ui 和 shared 各要放两份：latency-monitor.js 在 src/ 下用 './settings-ui/'，
    // 而 server-plugin 在 plugins/<id>/ 下用 '../settings-ui/'，两者解析到不同的真实目录。
    { from: 'backend-monitor-minimal/settings-ui', to: 'src/settings-ui', dir: true },
    { from: 'backend-monitor-minimal/settings-ui', to: 'plugins/settings-ui', dir: true },
    { from: 'backend-monitor-minimal/shared', to: 'src/shared', dir: true },
    { from: 'backend-monitor-minimal/shared', to: 'plugins/shared', dir: true },
];

function resolveSillyTavernRoot(input) {
    if (!input) {
        die('请把 SillyTavern 根目录作为第一个参数传进来，例如：node install.mjs /root/SillyTavern');
    }

    const root = path.resolve(input);

    if (!fs.existsSync(root)) {
        die(`目录不存在：${root}`);
    }

    const marker = path.join(root, TARGET_FILE);
    if (!fs.existsSync(marker)) {
        die(`这里不像 SillyTavern 根目录，没找到 ${TARGET_FILE}：${root}`);
    }

    return root;
}

function copyRecursive(from, to) {
    const stat = fs.statSync(from);

    if (stat.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        for (const entry of fs.readdirSync(from)) {
            copyRecursive(path.join(from, entry), path.join(to, entry));
        }
        return;
    }

    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
}

function readManifestName(manifestPath) {
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))?.name ?? '';
    } catch {
        return '';
    }
}

// 在酒馆界面里贴 git 地址装的精简版，目录名取自仓库名
//（src/endpoints/extensions.js 用 path.basename(url) 决定），和这里的
// EXTENSION_DIR_NAME 不是一个。两个目录同时存在时酒馆会把扩展加载两遍：
// 两个面板、两次 window.fetch 劫持、重复记录。升级时必须清掉。
// 注意浏览器里的记录不在这些目录里（IndexedDB 按域名存），删目录不会丢数据。
function findDuplicateExtensionInstalls(stRoot) {
    const thirdParty = path.join(stRoot, 'public/scripts/extensions/third-party');
    if (!fs.existsSync(thirdParty)) {
        return [];
    }

    const manifestName = readManifestName(path.join(REPO_ROOT, 'manifest.json'));
    if (!manifestName) {
        return [];
    }

    return fs.readdirSync(thirdParty).filter((entry) => {
        if (entry === EXTENSION_DIR_NAME) {
            return false;
        }

        const dir = path.join(thirdParty, entry);
        return fs.statSync(dir).isDirectory()
            && readManifestName(path.join(dir, 'manifest.json')) === manifestName;
    });
}

function removeDuplicateExtensionInstalls(stRoot) {
    for (const entry of findDuplicateExtensionInstalls(stRoot)) {
        if (dryRun) {
            skip(`将删除重复安装 third-party/${entry}`);
            continue;
        }

        fs.rmSync(path.join(stRoot, 'public/scripts/extensions/third-party', entry), { recursive: true, force: true });
        warn(`已删除重复安装 third-party/${entry}（贴 git 地址装的那份，留着会被加载两遍；浏览器里的记录不受影响）`);
    }
}

function placeFiles(stRoot) {
    console.log('\n[1/3] 放置文件');

    removeDuplicateExtensionInstalls(stRoot);

    for (const item of COPY_PLAN) {
        const from = path.join(REPO_ROOT, item.from);
        const to = path.join(stRoot, item.to);

        if (!fs.existsSync(from)) {
            fail(`仓库里缺少 ${item.from}，请确认仓库是完整克隆的`);
            continue;
        }

        if (dryRun) {
            skip(`将写入 ${item.to}`);
            continue;
        }

        copyRecursive(from, to);
        ok(item.to);
    }
}

function preparePatches(stRoot) {
    console.log('\n[预检] 检查补丁兼容性');

    const target = path.join(stRoot, TARGET_FILE);
    const raw = fs.readFileSync(target, 'utf8');
    // Windows 上跑的酒馆可能是 CRLF，而补丁里的锚点一律用 LF。
    // 统一成 LF 来匹配和拼接，写回时再按原文件的行尾还原，免得把整个文件的行尾搅乱。
    const usesCrlf = raw.includes('\r\n');
    let source = usesCrlf ? raw.replace(/\r\n/g, '\n') : raw;
    let applied = 0;
    let alreadyThere = 0;

    for (const patch of getChatCompletionsPatches(source)) {
        if (source.includes(patch.detect)) {
            alreadyThere++;
            skip(`${patch.label}（已存在，跳过）`);
            continue;
        }

        const first = source.indexOf(patch.anchor);
        if (first === -1) {
            fail(`${patch.label}：找不到锚点代码。你的酒馆版本可能和补丁不匹配，需要手动定位（见 docs/installation.md）`);
            continue;
        }

        if (source.indexOf(patch.anchor, first + 1) !== -1) {
            fail(`${patch.label}：锚点代码出现了多次，无法确定该插在哪一处，已跳过`);
            continue;
        }

        source = source.slice(0, first) + patch.build(patch.anchor) + source.slice(first + patch.anchor.length);
        applied++;
        ok(patch.label);
    }

    if (hasFailure) {
        die('有补丁没能打上，本体文件未被修改。');
    }

    if (applied === 0) {
        console.log(`  ${DIM}全部 ${alreadyThere} 处补丁都已存在，本体无需改动${RESET}`);
    }

    // Parse without importing or executing the target. Do this before any file
    // placement or duplicate removal, including when all patches already exist.
    try {
        execFileSync(process.execPath, ['--input-type=module', '--check'], { input: source, stdio: 'pipe' });
    } catch (error) {
        die(`补丁预检语法检查失败，未修改任何文件。\n${error.stderr?.toString() ?? error.message}`);
    }
    return { target, source: usesCrlf ? source.replace(/\n/g, '\r\n') : source, applied };
}

function applyPatches({ target, source, applied }) {
    console.log('\n[2/3] 给本体打补丁');
    if (!applied || dryRun) {
        skip(dryRun ? 'dry-run，未写入' : '本体无需改动');
        return;
    }
    const backup = target + BACKUP_SUFFIX;
    if (!fs.existsSync(backup)) {
        fs.copyFileSync(target, backup);
        ok(`已备份原文件到 ${path.basename(backup)}`);
    }

    fs.writeFileSync(target, source, 'utf8');
    verifySyntax(target);
}

function verifySyntax(target) {
    try {
        execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
        ok('语法检查通过');
    } catch (error) {
        const backup = target + BACKUP_SUFFIX;
        if (fs.existsSync(backup)) {
            fs.copyFileSync(backup, target);
            die(`打完补丁后语法检查失败，已自动还原备份。\n${error.stderr?.toString() ?? error.message}`);
        }
        die(`打完补丁后语法检查失败，且找不到备份。\n${error.stderr?.toString() ?? error.message}`);
    }
}

function enableServerPlugins(stRoot) {
    console.log('\n[3/3] 开启服务端插件');

    const configPath = path.join(stRoot, 'config.yaml');
    if (!fs.existsSync(configPath)) {
        warn('没找到 config.yaml，请自行确认 enableServerPlugins 已开启');
        return;
    }

    const content = fs.readFileSync(configPath, 'utf8');
    // 只认顶格的键，避免误改某个嵌套配置里的同名项。
    const line = /^enableServerPlugins:[ \t]*(.*)$/m;
    const matched = content.match(line);

    if (matched && matched[1].trim() === 'true') {
        skip('enableServerPlugins 已经是 true');
        return;
    }

    if (dryRun) {
        skip('将设置 enableServerPlugins: true');
        return;
    }

    const next = matched
        ? content.replace(line, 'enableServerPlugins: true')
        : `${content.replace(/\n*$/, '')}\nenableServerPlugins: true\n`;

    fs.writeFileSync(configPath, next, 'utf8');
    ok(matched ? 'enableServerPlugins 已改为 true' : '已追加 enableServerPlugins: true');
}

function uninstall(stRoot) {
    console.log('\n卸载');

    const target = path.join(stRoot, TARGET_FILE);
    const backup = target + BACKUP_SUFFIX;

    if (fs.existsSync(backup)) {
        if (!dryRun) {
            fs.copyFileSync(backup, target);
            fs.rmSync(backup);
        }
        ok('已从备份还原 chat-completions.js');
    } else {
        warn(`找不到备份 ${path.basename(backup)}，本体文件请自行还原（酒馆是 git 仓库的话可以 git checkout）`);
    }

    const targets = [
        `public/scripts/extensions/third-party/${EXTENSION_DIR_NAME}`,
        ...findDuplicateExtensionInstalls(stRoot).map((entry) => `public/scripts/extensions/third-party/${entry}`),
        'src/latency-monitor.js',
        'src/luker-latency-monitor.js',
        `plugins/${PLUGIN_DIR_NAME}`,
        'src/settings-ui',
        'plugins/settings-ui',
        'src/shared',
        'plugins/shared',
    ];

    for (const relative of targets) {
        const full = path.join(stRoot, relative);
        if (!fs.existsSync(full)) {
            continue;
        }
        if (!dryRun) {
            fs.rmSync(full, { recursive: true, force: true });
        }
        ok(`已删除 ${relative}`);
    }

    console.log(`\n${YELLOW}历史记录没有删${RESET}：data/*/latency-monitor/ 里的数据保留着，不需要就自己删。`);
}

function main() {
    const args = process.argv.slice(2);
    dryRun = args.includes('--dry-run');
    const wantUninstall = args.includes('--uninstall');
    const stRoot = resolveSillyTavernRoot(args.find((value) => !value.startsWith('--')));

    console.log(`SillyTavern 根目录：${stRoot}`);
    if (dryRun) {
        console.log(`${YELLOW}dry-run 模式，只检查不写入${RESET}`);
    }

    if (wantUninstall) {
        uninstall(stRoot);
        console.log('\n完成。重启酒馆后生效。\n');
        return;
    }

    // Validate everything we can before removing old installs or copying files.
    for (const item of COPY_PLAN) {
        if (!fs.existsSync(path.join(REPO_ROOT, item.from))) {
            die(`仓库里缺少 ${item.from}，未修改任何文件。`);
        }
    }
    const prepared = preparePatches(stRoot);
    placeFiles(stRoot);
    applyPatches(prepared);
    enableServerPlugins(stRoot);

    if (hasFailure) {
        die('有步骤没能完成，详见上面的报错。');
    }

    console.log(`\n${GREEN}安装完成${RESET}。接下来：`);
    console.log('  1. 重启 SillyTavern');
    console.log('  2. 启动日志里应能看到 "1 server plugin(s) are currently loaded."');
    console.log('  3. 浏览器里按 Ctrl + Shift + R 强制刷新\n');
}

main();
