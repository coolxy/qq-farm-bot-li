export interface AccountRuntime {
  running?: boolean
  runtimeState?: 'logging_in' | 'relogin_waiting' | 'running' | 'offline' | 'stopping' | 'stopped'
  reloginAt?: number | null
}

export function isAccountActive(account: AccountRuntime) {
  return !!account.running || account.runtimeState === 'logging_in' || account.runtimeState === 'relogin_waiting'
}

/**
 * 是否可以安全纳入「一键清理已停止账号」。
 *
 * 不能复用 `isAccountActive`：那个函数的语义是「现在有没有在跑」，答 false
 * 的里面还包含 `offline`——掉线待人工补码的账号。二者被混为一谈的后果是
 * 真实事故：QQ 号 1919991430 在 2026-11-20 08:44:39 因 WS 400 掉线、
 * 没有免扫码凭证进入 `offline`，随后被「一键清理」当作已停止账号删掉，
 * accounts.json 记录与 account-configs/5.json 一起消失，不可恢复。
 *
 * 掉线不等于用户主动停用：账号还在配置里、还等用户补 Code、后台保活也可能
 * 把它拉起来。所以只有「用户明确停用（stopped）」和「本次进程没碰过且没在跑」
 * 才允许被批量清理。`offline` / `relogin_waiting` / `logging_in` 一律排除。
 */
export function isAccountSafeToPurge(account: AccountRuntime) {
  if (account.runtimeState === 'offline')
    return false
  if (account.runtimeState === 'stopped')
    return true
  if (account.runtimeState)
    return false
  return !account.running
}

export function getAccountRuntimeStatus(account: AccountRuntime, now: number) {
  switch (account.runtimeState) {
    case 'logging_in':
      return { text: '登录中', color: 'bg-blue-500', busy: true }
    case 'relogin_waiting': {
      const deadline = Number(account.reloginAt)
      const seconds = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0
      return { text: seconds > 0 ? `掉线重登，剩余 ${seconds} 秒` : '掉线重登，即将登录', color: 'bg-amber-500', busy: false }
    }
    case 'running':
      return { text: '运行中', color: 'bg-green-500', busy: false }
    case 'offline':
      return { text: '已掉线', color: 'bg-red-500', busy: false }
    case 'stopping':
      return { text: '停止中', color: 'bg-gray-400', busy: true }
    case 'stopped':
      return { text: '已停止', color: 'bg-gray-300', busy: false }
    default:
      return { text: account.running ? '运行中' : '已停止', color: account.running ? 'bg-green-500' : 'bg-gray-300', busy: false }
  }
}
