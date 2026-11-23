export {};
/**
 * 邀请码处理模块 - 读取 share.txt 并通过 ReportArkClick 申请好友
 * 注意：此功能仅在微信环境下有效
 *
 * 原理：
 * 1. 首次登录时，游戏会在 LoginRequest 中携带 sharer_id 和 sharer_open_id
 * 2. 已登录状态下点击分享链接，游戏会发送 ReportArkClickRequest
 * 3. 服务器收到后会自动向分享者发送好友申请
 *
 * 我们使用 ReportArkClickRequest 来模拟已登录状态下的分享链接点击
 *
 * 加友引擎（新增）：
 * - 邀请码按账号隔离存放于 data/share/<accountId>.txt，不再抢同一个 share.txt
 * - 支持运行中随时通过 Worker API `runInviteLinks` 触发，不必重启账号
 * - 内部分批执行 + 进度上报，避免 200+ 链接一次性阻塞独占自动化锁
 * - 记录执行前后好友数，用来判断这批上报是否真的产生了好友
 */

const { CONFIG } = require('../config/config');
const { getShareFilePath } = require('../config/runtime-paths');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, log, logWarn, sleep } = require('../utils/utils');
const { readTextFile, writeTextFileAtomic } = require('./json-db');

interface ParsedShareLink {
    uid: string | null;
    openid: string | null;
    shareSource: string | null;
    docId: string | null;
}

interface InviteProgress {
    accountId: string;
    total: number;
    done: number;
    success: number;
    failed: number;
    startedAt: number;
    finishedAt: number;
    running: boolean;
    lastError: string;
    /** 失败明细，便于事后定位是限流还是对方失效 */
    failedUids: Array<{ uid: string; reason: string }>;
    /** 执行前后的好友数，用来判断这批上报到底有没有真的产生好友 */
    friendCountBefore?: number;
    friendCountAfter?: number;
}

// 每个账号最近一次加友进度，供 Admin 面板轮询
const progressByAccount: Map<string, InviteProgress> = new Map();

/**
 * 解析分享链接，提取 uid 和 openid
 * 格式: ?uid=xxx&openid=xxx&share_source=xxx&doc_id=xxx
 */
function parseShareLink(link: string): ParsedShareLink {
    const result: ParsedShareLink = { uid: null, openid: null, shareSource: null, docId: null };

    // 移除开头的 ? 如果有
    const queryStr: string = link.startsWith('?') ? link.slice(1) : link;

    // 解析参数
    const params = new URLSearchParams(queryStr);
    result.uid = params.get('uid');
    result.openid = params.get('openid');
    result.shareSource = params.get('share_source');
    result.docId = params.get('doc_id');

    return result;
}

/**
 * 从文本内容解析邀请码（去重），供「上传即处理」与文件读取共用
 */
function parseInviteText(content: string): ParsedShareLink[] {
    const lines: string[] = String(content || '').split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0 && line.includes('openid='));

    const invites: ParsedShareLink[] = [];
    const seenUids: Set<string> = new Set();  // 用于去重

    for (const line of lines) {
        const parsed: ParsedShareLink = parseShareLink(line);
        if (parsed.openid && parsed.uid) {
            // 按 uid 去重，同一个用户只处理一次
            if (!seenUids.has(parsed.uid)) {
                seenUids.add(parsed.uid);
                invites.push(parsed);
            }
        }
    }

    return invites;
}

/**
 * 读取 share.txt 文件并去重
 */
function readShareFile(accountId?: string): ParsedShareLink[] {
    const shareFilePath: string = getShareFilePath(accountId);

    try {
        const content: string = readTextFile(shareFilePath, '');
        return parseInviteText(content);
    } catch (e: any) {
        logWarn('邀请', `读取 share.txt 失败: ${e.message}`);
        return [];
    }
}

/**
 * 发送 ReportArkClick 请求
 * 模拟已登录状态下点击分享链接，触发服务器向分享者发送好友申请
 */
async function sendReportArkClick(sharerId: string | null, sharerOpenId: string | null, shareSource: string | null): Promise<any> {
    const body: Uint8Array = types.ReportArkClickRequest.encode(types.ReportArkClickRequest.create({
        sharer_id: toLong(sharerId),
        sharer_open_id: sharerOpenId,
        share_cfg_id: toLong(shareSource || 0),
        scene_id: '1256',  // 模拟微信场景
    })).finish();

    const { body: replyBody } = await sendMsgAsync('gamepb.userpb.UserService', 'ReportArkClick', body);
    return types.ReportArkClickReply.decode(replyBody);
}

// 请求间隔时间（毫秒）
const INVITE_REQUEST_DELAY: number = 2000;

/**
 * 读取当前账号好友数，仅用于加友前后的效果对比。
 * 失败返回 undefined，不阻断主流程。
 */
async function snapshotFriendCount(): Promise<number | undefined> {
    try {
        const friend: any = require('./friend');
        const reply: any = await friend.getFriendsList(false, 'normal');
        const list: any[] = Array.isArray(reply) ? reply
            : (reply?.game_friends || reply?.friends || reply?.list || []);
        if (!Array.isArray(list)) return undefined;
        return list.length;
    } catch {
        return undefined;
    }
}

/**
 * 核心执行器：把 invites 逐条发送，边发边更新进度
 * 调用方负责提供 invites 与进度对象
 */
async function runInvites(
    invites: ParsedShareLink[],
    progress: InviteProgress,
    options: { clearAfter?: boolean; accountId?: string } = {},
): Promise<InviteProgress> {
    const total: number = invites.length;

    for (let i = 0; i < total; i++) {
        const invite: ParsedShareLink = invites[i];
        try {
            await sendReportArkClick(invite.uid, invite.openid, invite.shareSource);
            progress.success++;
            if ((progress.success % 20 === 0) || i === total - 1) {
                log('邀请', `[${i + 1}/${total}] 已发送申请 ${progress.success} 条，uid=${invite.uid}`);
            }
        } catch (e: any) {
            progress.failed++;
            const reason = String(e?.message || e).slice(0, 200);
            progress.lastError = reason;
            // 只留最近 50 条明细，避免 200+ 全失败时把内存撑起来
            if (progress.failedUids.length < 50) {
                progress.failedUids.push({ uid: String(invite.uid || ''), reason });
            }
            logWarn('邀请', `[${i + 1}/${total}] 向 uid=${invite.uid} 发送申请失败: ${e.message}`);
        }
        progress.done = i + 1;

        // 每个请求之间延迟，避免请求过快被限流
        if (i < total - 1) {
            await sleep(INVITE_REQUEST_DELAY);
        }
    }

    progress.running = false;
    progress.finishedAt = Date.now();

    // 措辞必须克制：ReportArkClickReply 是空消息，服务端回 200 只代表「点击已上报」，
    // 不代表对方一定收到好友申请。写「已上报」而不是「已添加」，避免把假象当成果。
    log('邀请', `处理完成: 已上报 ${progress.success} 条, 请求失败 ${progress.failed} 条`);
    if (progress.success > 0) {
        logWarn('邀请',
            '注意：已上报 ≠ 已加为好友。该接口仅上报分享点击，服务端是否据此发送好友申请由游戏判定；'
            + '请在「好友申请」页确认是否真的收到申请。');
    }

    // 处理完成后清空文件（仅当是本账号自己的文件）
    if (options.clearAfter !== false) {
        clearShareFile(options.accountId);
    }
    return progress;
}

/**
 * 处理邀请码列表（登录后自动调用一次）
 * 仅在微信环境下执行
 */
async function processInviteCodes(): Promise<void> {
    // 检查是否为微信环境
    if (CONFIG.platform !== 'wx') {
        log('邀请', '当前为 QQ 环境，跳过邀请码处理（仅微信支持）');
        return;
    }

    const accountId: string = String(process.env.FARM_ACCOUNT_ID || '').trim();
    const invites: ParsedShareLink[] = readShareFile(accountId || undefined);
    if (invites.length === 0) {
        return;
    }

    log('邀请', `读取到 ${invites.length} 个邀请码（已去重），开始逐个处理...`);

    const progress: InviteProgress = {
        accountId,
        total: invites.length,
        done: 0,
        success: 0,
        failed: 0,
        startedAt: Date.now(),
        finishedAt: 0,
        running: true,
        lastError: '',
        failedUids: [],
    };
    progressByAccount.set(accountId || 'default', progress);

    await runInvites(invites, progress, { clearAfter: true, accountId: accountId || undefined });
}

/**
 * 运行中手动触发加友（Worker API 入口）
 * - linksText 提供时直接用它，否则读本账号的 share 文件
 * - 不重启账号，不影响挂机自动化
 */
async function runInviteLinks(linksText?: string): Promise<InviteProgress> {
    const accountId: string = String(process.env.FARM_ACCOUNT_ID || '').trim();

    if (CONFIG.platform !== 'wx') {
        throw new Error('仅微信账号支持通过分享链接加好友，当前账号不是微信平台');
    }

    // 防重入：runInviteLinks 动辄跑几分钟，重复点击会两批请求交织、抢同一个进度对象。
    // 这里直接拒绝而不是排队，让调用方知道「上一批还在跑」。
    const running = progressByAccount.get(accountId || 'default');
    if (running && running.running) {
        throw new Error(
            `上一批加友仍在进行中（${running.done}/${running.total}），请等待完成后再试`,
        );
    }

    const invites: ParsedShareLink[] = (linksText && String(linksText).trim())
        ? parseInviteText(String(linksText))
        : readShareFile(accountId || undefined);

    if (invites.length === 0) {
        throw new Error('没有可处理的邀请链接（内容为空或不含 openid/uid）');
    }

    const progress: InviteProgress = {
        accountId,
        total: invites.length,
        done: 0,
        success: 0,
        failed: 0,
        startedAt: Date.now(),
        finishedAt: 0,
        running: true,
        lastError: '',
        failedUids: [],
    };
    progressByAccount.set(accountId || 'default', progress);

    log('邀请', `手动加友开始，共 ${invites.length} 个目标（已去重），预计 ${Math.ceil(invites.length * INVITE_REQUEST_DELAY / 1000)} 秒`);

    // 记下执行前好友数，结束后对比——这是唯一能证明「到底有没有加到人」的硬指标
    progress.friendCountBefore = await snapshotFriendCount();

    await runInvites(invites, progress, { clearAfter: !linksText, accountId: accountId || undefined });

    progress.friendCountAfter = await snapshotFriendCount();
    if (typeof progress.friendCountBefore === 'number' && typeof progress.friendCountAfter === 'number') {
        const delta: number = progress.friendCountAfter - progress.friendCountBefore;
        if (delta > 0) {
            log('邀请', `好友数 ${progress.friendCountBefore} → ${progress.friendCountAfter}（+${delta}），本批已生效`);
        } else {
            logWarn('邀请',
                `好友数 ${progress.friendCountBefore} → ${progress.friendCountAfter}（${delta}），本批未产生新好友。`
                + '这通常意味着该接口只上报点击、不触发好友申请，需对方反向加本账号或由本账号手动同意其申请。');
        }
    }
    return progress;
}

/**
 * 读取当前账号最近一次加友进度
 */
function getInviteProgress(): InviteProgress | null {
    const accountId: string = String(process.env.FARM_ACCOUNT_ID || '').trim();
    return progressByAccount.get(accountId || 'default') || null;
}

/**
 * 清空已处理的邀请码文件
 */
function clearShareFile(accountId?: string): void {
    const shareFilePath: string = getShareFilePath(accountId);
    try {
        writeTextFileAtomic(shareFilePath, '');
        log('邀请', `已清空 ${accountId ? `账号 ${accountId} 的 ` : ''}share.txt`);
    } catch {
        // 静默失败
    }
}

module.exports = {
    parseShareLink,
    parseInviteText,
    readShareFile,
    sendReportArkClick,
    processInviteCodes,
    runInviteLinks,
    getInviteProgress,
    clearShareFile,
};