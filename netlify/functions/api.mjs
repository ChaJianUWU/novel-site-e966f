// Netlify Functions（v2）入口：把请求原样交给 site-core.js，存储换成 Netlify Blobs。
// 这样整站不需要任何常开的机器，Netlify 托管运行，电脑关机照样能开。
import { getStore } from '@netlify/blobs'
import { createHash } from 'node:crypto'
import worker from '../../site-core.js'
import seed from '../../seed/kv.json'

const STORE_NAME = 'novel-site'

// 首次运行时把仓库里的 seed/kv.json 灌进云端存储，之后云端就是唯一的数据源。
// 这样部署完不需要任何手工配置，小说和编辑口令都原样保留。
let seedDone = false
async function ensureSeed(store) {
  if (seedDone) return
  try {
    const has = await store.get('index', { type: 'text' })
    if (has) { seedDone = true; return }
    for (const [k, v] of Object.entries(seed)) {
      await store.set(k, typeof v === 'string' ? v : JSON.stringify(v))
    }
    seedDone = true
  } catch {
    // 存储暂时不可用时静默跳过，下个请求再试
  }
}

function makeKV(store) {
  return {
    async get(key, type) {
      const value = await store.get(key, { type: 'text' })
      if (value === null || value === undefined) return null
      if (type === 'json') {
        try {
          return JSON.parse(value)
        } catch {
          return null
        }
      }
      return value
    },
    async put(key, value) {
      await store.set(key, String(value))
    },
    async delete(key) {
      await store.delete(key)
    },
    async list(options) {
      const prefix = (options && options.prefix) || ''
      const keys = []
      let cursor
      do {
        const page = await store.list({ prefix, cursor })
        for (const blob of page.blobs || []) keys.push({ name: blob.key })
        cursor = page.cursor
      } while (cursor)
      return { keys, list_complete: true }
    },
  }
}

// ---------------- 管理员口令（存在云端，不需要付费的环境变量功能） ----------------
// 只存 salt + SHA-256 摘要，公开仓库/公开存储里看不到明文。
// 认领成功后把明文和摘要对上，再把明文交给 site-core 做原有校验，逻辑不变。
const ADMIN_REC = '_admin'
let adminCache = null // null=未读, false=还没认领, {salt,hash}=已认领

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

async function adminRecord(store) {
  if (adminCache !== null) return adminCache
  try {
    const raw = await store.get(ADMIN_REC, { type: 'text' })
    adminCache = raw ? JSON.parse(raw) : false
  } catch {
    adminCache = false
  }
  return adminCache
}

async function resolveAdminKey(store, request) {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY
  const rec = await adminRecord(store)
  if (!rec || !rec.hash) return ''
  let plain = (request.headers.get('x-admin-key') || '').trim()
  if (!plain) {
    try {
      const body = JSON.parse(await request.clone().text())
      plain = String((body && (body.adminKey || body.key)) || '').trim()
    } catch {
      // 没有 body 或不是 JSON，忽略
    }
  }
  if (!plain) return ''
  const digest = sha256(String(rec.salt || '') + plain)
  return digest === rec.hash ? plain : ''
}

function jsonOut(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export default async function handler(request) {
  const store = getStore({ name: STORE_NAME, consistency: 'strong' })
  await ensureSeed(store)

  // 管理员口令的认领与状态查询，由这一层直接处理
  const url = new URL(request.url)
  if (url.pathname === '/api/admin/claim') {
    const usingEnv = !!process.env.ADMIN_KEY
    const rec = await adminRecord(store)
    if (request.method === 'GET') {
      return jsonOut({ claimed: !!(rec && rec.hash), source: usingEnv ? 'env' : 'store' })
    }
    if (usingEnv) return jsonOut({ error: '已在环境变量里配置了管理员密钥，不需要认领' }, 400)
    let body = {}
    try {
      body = JSON.parse(await request.text())
    } catch {
      return jsonOut({ error: '要 JSON' }, 400)
    }
    const key = String(body.key || '').trim()
    if (key.length < 8) return jsonOut({ error: '管理员口令至少 8 位' }, 400)
    // 已认领后要换口令：必须先在 from 里给出当前口令，防止被别人半路改掉
    if (rec && rec.hash) {
      const cur = String(body.from || '').trim()
      if (!cur || sha256(String(rec.salt || '') + cur) !== rec.hash) {
        return jsonOut({ error: '已经认领过了，要更换得先在 from 里提供当前口令' }, 403)
      }
    }
    const salt = createHash('sha256').update(String(Date.now()) + String(Math.random())).digest('hex').slice(0, 32)
    const next = { salt, hash: sha256(salt + key), at: Date.now() }
    await store.set(ADMIN_REC, JSON.stringify(next))
    adminCache = next
    return jsonOut({ ok: true })
  }

  const env = {
    SITE_DB: makeKV(store),
    SYNC_KEY: process.env.SYNC_KEY || '',
    ADMIN_KEY: await resolveAdminKey(store, request),
    SITE_TITLE: process.env.SITE_TITLE || '小说站',
  }
  return worker.fetch(request, env)
}
