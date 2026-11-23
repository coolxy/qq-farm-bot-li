import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * Friend-related routes: friends list, friend lands, friend ops,
 * friend-blacklist, friend-known-gids, interact-records.
 */

const store = require('../../models/store');

const {
    getAccId,
    handleApiError,
    isGatewayProtocolError,
    isSoftRuntimeError,
    buildKnownFriendGidSettings,
} = require('./middleware');

function mountFriendRoutes(app: Application, ctx: AdminContext): void {

    // API: 好友列表
    app.get('/api/friends', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        const forceSync = req.query.forceSync === 'true';

        try {
            const data = await ctx.provider.getFriends(id, forceSync);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 仅读取 Worker 内存中的好友列表缓存，不触发任何游戏协议请求。
    app.get('/api/friends/cache', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const data = await ctx.provider.getFriendsCache(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 清除好友列表缓存
    app.post('/api/friends/clear-cache', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            await ctx.provider.clearFriendsCache(id);
            res.json({ ok: true });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 加友引擎：上传分享链接并立即执行（仅微信账号）
    // body: { links: string } 或 { links: string[], replace?: boolean }
    app.post('/api/friends/invite-links', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        const raw = req.body && req.body.links;
        const text = Array.isArray(raw) ? raw.join('\n') : String(raw || '');
        if (!text.trim()) return res.status(400).json({ ok: false, error: 'links 不能为空' });

        try {
            const data = await ctx.provider.runInviteLinks(id, text);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 加友引擎进度轮询
    app.get('/api/friends/invite-progress', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const data = await ctx.provider.getInviteProgress(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 好友申请列表（用于确认加友引擎是否真的送达）
    app.get('/api/friends/applications', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const data = await ctx.provider.getFriendApplications(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 同意好友申请（body: { gids: number[] }）
    app.post('/api/friends/applications/accept', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const gids = Array.isArray(req.body?.gids) ? req.body.gids : [];
        if (!gids.length) return res.status(400).json({ ok: false, error: 'gids 不能为空' });
        try {
            const data = await ctx.provider.acceptFriendApplications(id, gids);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 生成本账号的分享链接（加好友正向路径：对方点我的链接 -> 我收到申请 -> 自动同意）
    app.get('/api/friends/share-key', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        const cfgId = Number.parseInt(String(req.query.shareCfgId || '0'), 10) || 0;
        try {
            const data = await ctx.provider.getShareKey(id, cfgId);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 邀请关系列表（判断加友上报是否真的产生了邀请/好友）
    app.get('/api/friends/invite-info', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const data = await ctx.provider.getInviteInfo(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 访客
    app.get('/api/interact-records', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const data = await ctx.provider.getInteractRecords(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 好友农田详情
    app.get('/api/friend/:gid/lands', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        try {
            const data = await ctx.provider.getFriendLands(id, req.params.gid);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 背包中当前可用于好友土地的特殊互动道具。
    app.get('/api/friend-interaction-items', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.getFriendInteractionItems(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 在同一次好友访问会话内，按地块编号顺序使用特殊互动道具。
    app.post('/api/friend/:gid/interaction-items/use-batch', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.useFriendInteractionItemBatch(
                id,
                req.params.gid,
                req.body?.itemId,
                req.body?.landIds,
            );
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 对指定好友农场使用不需要地块目标的特殊互动道具（例如青蛙使坏瓶）。
    app.post('/api/friend/:gid/interaction-items/use-farm', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.useFriendFarmInteractionItem(id, req.params.gid, req.body?.itemId);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 对指定好友执行单次操作（偷菜/浇水/除草/捣乱）
    app.post('/api/friend/:gid/op', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const opType = String((req.body || {}).opType || '');
            const data = await ctx.provider.doFriendOp(id, req.params.gid, opType);
            if (data && data.ok === false) {
                return res.json({
                    ok: false,
                    error: data.errorMessage || data.message || data.error || '好友操作失败',
                    ...(data.errorMessage ? { errorMessage: data.errorMessage } : {}),
                    ...(data.errorCode ? { errorCode: data.errorCode } : {}),
                });
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 游戏内删除好友
    app.post('/api/friend/:gid/delete', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const gid = Number(req.params.gid);
            if (!Number.isFinite(gid) || gid <= 0) {
                return res.status(400).json({ ok: false, error: '无效的好友 GID' });
            }
            const data = await ctx.provider.delFriend(id, gid);
            if (store.addFriendToBlacklist) {
                store.addFriendToBlacklist(id, gid);
            }
            if (store.getKnownFriendGids && store.setKnownFriendGids) {
                const current = store.getKnownFriendGids(id) || [];
                const next = current.filter((item: any) => Number(item) !== gid);
                if (next.length !== current.length) {
                    store.setKnownFriendGids(id, next);
                }
            }
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            res.json({ ok: true, message: '删除好友成功', data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 好友黑名单
    app.get('/api/friend-blacklist', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        const gids = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];

        // 尝试获取好友列表以附加昵称和头像
        let friendsList: any[] = [];
        try {
            if (ctx.provider && typeof ctx.provider.getFriends === 'function') {
                friendsList = await ctx.provider.getFriends(id) || [];
            }
        } catch (error: any) {
            if (isGatewayProtocolError(error) || isSoftRuntimeError(error)) return handleApiError(res, error);
            // 非协议错误不影响黑名单本地数据展示
        }

        // 构建好友信息映射
        const friendMap = new Map<number, { name: string; avatarUrl: string }>();
        for (const f of friendsList) {
            const gid = Number(f && f.gid);
            if (gid > 0) {
                friendMap.set(gid, {
                    name: f.name || f.remark || '',
                    avatarUrl: f.avatarUrl || f.avatar_url || '',
                });
            }
        }

        // 构建带好友信息的黑名单
        const list = gids.map((gid: any) => {
            const info = friendMap.get(Number(gid)) || { name: '', avatarUrl: '' };
            return {
                gid: Number(gid),
                name: info.name || '',
                avatarUrl: info.avatarUrl || '',
            };
        });

        res.json({ ok: true, data: list });
    });

    app.post('/api/friend-blacklist/toggle', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        const gid = Number((req.body || {}).gid);
        if (!gid) return res.status(400).json({ ok: false, error: 'Missing gid' });
        const current = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];
        let next: number[];
        if (current.includes(gid)) {
            next = current.filter((g: number) => g !== gid);
        } else {
            next = [...current, gid];
        }
        const savedGids = store.setFriendBlacklist ? store.setFriendBlacklist(id, next) : next;

        // 同步配置到 worker 进程
        if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
            ctx.provider.broadcastConfig(id);
        }

        // 尝试获取好友列表以附加昵称和头像
        let friendsList: any[] = [];
        try {
            if (ctx.provider && typeof ctx.provider.getFriends === 'function') {
                friendsList = await ctx.provider.getFriends(id) || [];
            }
        } catch (error: any) {
            if (isGatewayProtocolError(error) || isSoftRuntimeError(error)) return handleApiError(res, error);
            // 非协议错误不影响黑名单本地数据展示
        }

        // 构建好友信息映射
        const friendMap = new Map<number, { name: string; avatarUrl: string }>();
        for (const f of friendsList) {
            const fGid = Number(f && f.gid);
            if (fGid > 0) {
                friendMap.set(fGid, {
                    name: f.name || f.remark || '',
                    avatarUrl: f.avatarUrl || f.avatar_url || '',
                });
            }
        }

        // 构建带好友信息的黑名单
        const saved = savedGids.map((g: any) => {
            const info = friendMap.get(Number(g)) || { name: '', avatarUrl: '' };
            return {
                gid: Number(g),
                name: info.name || '',
                avatarUrl: info.avatarUrl || '',
            };
        });

        res.json({ ok: true, data: saved });
    });

    // ============ 好友GID管理 API ============

    // 获取已知好友GID设置
    app.get('/api/friend-known-gids', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 保存已知好友GID设置
    app.post('/api/friend-known-gids', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            if (body.knownFriendGids !== undefined && store.setKnownFriendGids) {
                store.setKnownFriendGids(id, body.knownFriendGids);
            }
            if (body.knownFriendGidSyncCooldownSec !== undefined && store.setKnownFriendGidSyncCooldownSec) {
                store.setKnownFriendGidSyncCooldownSec(id, body.knownFriendGidSyncCooldownSec);
            }
            if (body.friendsListCacheTtlSec !== undefined && store.setFriendsListCacheTtlSec) {
                store.setFriendsListCacheTtlSec(id, body.friendsListCacheTtlSec);
            }
            // 同步配置到 worker 进程
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 移除单个好友GID
    app.post('/api/friend-known-gids/remove', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        const gid = Number((req.body || {}).gid);
        if (!Number.isFinite(gid) || gid <= 0) {
            return res.status(400).json({ ok: false, error: 'GID 无效' });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const next = Array.isArray(current) ? current.filter((item: any) => Number(item) !== gid) : [];
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            // 同步配置到 worker 进程
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 批量添加好友GID
    app.post('/api/friend-known-gids/batch-add', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        const gids = (req.body || {}).gids;
        if (!Array.isArray(gids) || gids.length === 0) {
            return res.status(400).json({ ok: false, error: 'GID 列表无效' });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const currentSet = new Set(current.map(Number));
            let addedCount = 0;
            for (const gid of gids) {
                const num = Number(gid);
                if (!Number.isFinite(num) || num <= 0) continue;
                if (!currentSet.has(num)) {
                    currentSet.add(num);
                    addedCount++;
                }
            }
            const next = Array.from(currentSet);
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            // 同步配置到 worker 进程
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            return res.json({
                ok: true,
                data: buildKnownFriendGidSettings(id),
                addedCount,
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 批量删除未同步的好友GID
    app.post('/api/friend-known-gids/batch-remove', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        const gids = (req.body || {}).gids;
        if (!Array.isArray(gids) || gids.length === 0) {
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id), removedCount: 0 });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const removeSet = new Set(gids.map(Number).filter((n: number) => Number.isFinite(n) && n > 0));
            const next = current.filter((gid: any) => !removeSet.has(Number(gid)));
            const removedCount = current.length - next.length;

            if (removedCount > 0 && store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }

            return res.json({
                ok: true,
                data: buildKnownFriendGidSettings(id),
                removedCount,
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });
}

module.exports = { mountFriendRoutes };
