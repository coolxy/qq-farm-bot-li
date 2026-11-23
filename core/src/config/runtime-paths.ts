export {};
const fs = require('node:fs');
const path = require('node:path');
const { resolveRuntimePaths, resolveWebRootInfo } = require('@qq-farm-bot/session-contract');
const isPackaged: boolean = !!(process as any).pkg;

function getResourceRoot(): string {
    const parent = path.join(__dirname, '..');
    // 编译和打包后仍从 src 读取协议、配置和 WASM 等静态资源。
    if (path.basename(parent) === 'dist') return path.join(parent, '..', 'src');
    return parent;
}

function getResourcePath(...segments: string[]): string {
    return path.join(getResourceRoot(), ...segments);
}

function getAppRootForWritable(): string {
    return isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '../..');
}

function getRuntimePaths() {
    const appRoot = getAppRootForWritable();
    return resolveRuntimePaths({
        appRoot,
        isPackaged,
        defaultRuntimeDir: isPackaged ? path.join(appRoot, 'runtime') : path.resolve(appRoot, '../runtime'),
        defaultResourceRoot: getResourceRoot(),
        defaultWebRoot: path.resolve(__dirname, '../../../web/dist'),
    });
}

function getWebRootInfo() {
    return resolveWebRootInfo(getRuntimePaths().runtimeDir, path.resolve(__dirname, '../../../web/dist'));
}

function getDataDir(): string {
    return process.env.FARM_DATA_DIR ? path.resolve(process.env.FARM_DATA_DIR) : path.join(getAppRootForWritable(), 'data');
}

function ensureDataDir(): string {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getDataFile(filename: string): string {
    return path.join(getDataDir(), filename);
}

/**
 * 邀请码文件路径。
 *
 * 基础路径统一由 session-contract 决定（`FARM_SHARE_FILE` env → `<dataDir>/share.txt`
 * → `<appRoot>/share.txt`），这样在线更新体系里的 `tools/service-control.mjs` 能通过
 * 环境变量把后端指向它自己算出来的位置，不用在 core 里再复制一套判定逻辑。
 *
 * 在此之上叠加按账号隔离：多个微信账号同时在线时，各自只消费自己的邀请码文件，
 * 避免 A 账号把 B 账号的 share.txt 抢走并在处理完后清空。派生的目录固定取基础文件的
 * 同级 `share/` 子目录，所以默认就是 `<dataDir>/share/<accountId>.txt`。
 */
function getShareFilePath(accountId?: string): string {
    const baseFile: string = getRuntimePaths().shareFilePath;
    const accId = String(accountId || '').trim();
    if (!accId) return baseFile;
    // 账号 id 已经过上游校验（纯数字），这里再兜一次，防止路径穿越写出 data 目录。
    if (!/^[A-Za-z0-9_-]+$/.test(accId)) return baseFile;
    return path.join(path.dirname(baseFile), 'share', `${accId}.txt`);
}

module.exports = {
    isPackaged,
    getResourcePath,
    getRuntimePaths,
    getWebRootInfo,
    getDataDir,
    getDataFile,
    ensureDataDir,
    getShareFilePath,
};
