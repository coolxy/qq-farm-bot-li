export {};
const fs = require('node:fs');
const path = require('node:path');
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

function getDataDir(): string {
    return path.join(getAppRootForWritable(), 'data');
}

function ensureDataDir(): string {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getDataFile(filename: string): string {
    return path.join(getDataDir(), filename);
}

function getShareFilePath(accountId?: string): string {
    const root = getAppRootForWritable();
    const accId = String(accountId || '').trim();
    // 按账号隔离：多个微信账号同时在线时，各自只消费自己的邀请码，
    // 避免 A 账号把 B 账号的 share.txt 抢走并在处理完后清空。
    if (accId) return path.join(root, 'data', 'share', `${accId}.txt`);
    // 兼容旧行为：未指定账号时沿用根目录 share.txt
    return path.join(root, 'share.txt');
}

module.exports = {
    isPackaged,
    getResourcePath,
    getDataDir,
    getDataFile,
    ensureDataDir,
    getShareFilePath,
};
