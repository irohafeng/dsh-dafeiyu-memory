// 库的写锁：同一时刻只让一个会话改库文件。
//
// 为什么要有它：改库的动作都是「读整份 → 改 → 写回整份」（touch、fade、flush、
// 给人补理解），而 add 是往后面追加一行。两个会话撞在一起时，写回整份的那一下
// 会把别人刚追加的一行吃掉——谁也收不到错误，就是那条记忆没了。
//
// 做法是独占创建 store.lock：谁先建成谁拿锁，里面写 pid 和时间。
// 拿不到就等一会儿再试；等到超时还没拿到，交给调用方决定怎么办
//（add 会转成待补，不报错；其它动作回一句「库正忙」）。
//
// 读不加锁：写回是「先写临时文件、再整体替换」，读到的要么是旧的整份、要么是
// 新的整份，永远读不到写了一半的文件。
import { openSync, writeSync, closeSync, unlinkSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const STEP_MS = 20 // 每次重试之间的等待
const STALE_MS = 15000 // 锁文件超过这么久没动静，当作上一个进程崩了

// 同步睡一会儿。记忆工具的调用本来就是同步改文件的，这里不能等异步。
const cell = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms) {
  try {
    Atomics.wait(cell, 0, 0, ms)
  } catch {
    /* 极少数环境不让 Atomics.wait，那就空转，反正只有几十毫秒 */
  }
}

// 同一个进程里可能嵌套（add 里要顺手把「陌生人」建出来），自己已经拿到的锁直接复用。
const held = new Map()

function createLockFile(file) {
  try {
    const fd = openSync(file, 'wx')
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
    closeSync(fd)
    return true
  } catch (e) {
    if (e && e.code === 'EEXIST') return false
    throw e
  }
}

/** 上一个进程没来得及放锁就走了：过了保鲜期就把它撬掉。 */
function dropIfStale(file) {
  try {
    const s = statSync(file)
    if (Date.now() - s.mtimeMs < STALE_MS) return false
    unlinkSync(file)
    return true
  } catch {
    return false // 已经不在了，下一轮就能拿到
  }
}

function release(file) {
  const depth = held.get(file) || 0
  if (depth > 1) {
    held.set(file, depth - 1)
    return
  }
  held.delete(file)
  try {
    unlinkSync(file)
  } catch {
    /* 本来就没锁文件，不算错 */
  }
}

/**
 * 拿锁。拿到返回 { ok: true, release }；等不到返回 { ok: false }。
 * timeoutMs 给得很短是因为真正写一次只有几毫秒，等这么久还拿不到，
 * 基本就是有别的进程卡住了，再等也没意义。
 */
export function acquireLock(dir, timeoutMs = 1000) {
  const file = join(dir, 'store.lock')
  const depth = held.get(file) || 0
  if (depth > 0) {
    held.set(file, depth + 1)
    return { ok: true, file, release: () => release(file) }
  }
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return { ok: false, file }
  }
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    if (createLockFile(file)) {
      held.set(file, 1)
      return { ok: true, file, release: () => release(file) }
    }
    if (dropIfStale(file)) continue
    if (Date.now() >= deadline) return { ok: false, file }
    sleepSync(STEP_MS)
  }
}

/**
 * 在锁里做一件事。拿不到锁时走 onTimeout（给个不吓人的结果），
 * 没给 onTimeout 就回一句「库正忙」。
 * 目录建不出来（盘拔了之类）时不加锁，让它照原样去试、照原样报错。
 */
export function withLock(dir, fn, onTimeout) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return fn()
  }
  const lock = acquireLock(dir)
  if (!lock.ok) {
    return onTimeout ? onTimeout() : { ok: false, busy: true, text: '库这会儿正忙，稍等一下再试。' }
  }
  try {
    return fn()
  } finally {
    lock.release()
  }
}
