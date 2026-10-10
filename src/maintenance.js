/** Read-only diagnostics and restoration of existing changes. Never applies cleaning. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { TARGETS, detectAsar, manifestPath, readManifest, sha16, RAW } from './host-clean.js'
import { BEGIN, END, BLOCK_BODY } from './profile-clean.js'

const messageOf = (error) => error instanceof Error ? error.message : String(error)
const validProfile = (dir) => typeof dir === 'string' && fs.existsSync(path.join(dir, 'package.json'))

/** Never guess desktop when a different runtime profile is selected. */
export function currentProfile(override = '') {
  if (override) return validProfile(override) ? path.resolve(override) : null
  if (process.env.DSH_PROFILE_DIR) {
    return validProfile(process.env.DSH_PROFILE_DIR) ? path.resolve(process.env.DSH_PROFILE_DIR) : null
  }
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const root = path.join(home, 'profiles')
  if (process.env.DSH_PROFILE) {
    const selected = path.resolve(root, process.env.DSH_PROFILE)
    if (path.dirname(selected) !== path.resolve(root)) return null
    return validProfile(selected) ? selected : null
  }
  if (!fs.existsSync(root)) return null
  const dirs = fs.readdirSync(root).map((name) => path.join(root, name)).filter(validProfile)
  return dirs.length === 1 ? dirs[0] : null
}

function readExact(fd, length, offset) {
  const buf = Buffer.alloc(length)
  let n = 0
  while (n < length) {
    const count = fs.readSync(fd, buf, n, length - n, offset + n)
    if (count === 0) throw new Error('Unexpected end of archive')
    n += count
  }
  return buf
}

/** Standalone read path with pickle alignment, bounds checks, and guaranteed close. */
function withArchive(file, mode, fn) {
  const fd = RAW.openSync(file, mode)
  try {
    const size = fs.fstatSync(fd).size
    const head = readExact(fd, 16, 0)
    const jsonSize = head.readUInt32LE(12)
    const dataStart = 8 + head.readUInt32LE(4)
    if (head.readUInt32LE(0) !== 4 || jsonSize > dataStart - 16 || dataStart > size) {
      throw new Error('Invalid ASAR header')
    }
    const header = JSON.parse(readExact(fd, jsonSize, 16).toString('utf8'))
    const entries = new Map()
    function walk(node, prefix = '') {
      for (const [name, entry] of Object.entries(node.files || {})) {
        const filePath = `${prefix}/${name}`
        if (entry.files) walk(entry, filePath)
        else entries.set(filePath, entry)
      }
    }
    walk(header)
    const read = (filePath) => {
      const entry = entries.get(filePath)
      if (!entry) throw new Error(`Missing archive entry: ${filePath}`)
      const offset = Number(entry.offset)
      if (entry.unpacked || entry.link || !Number.isSafeInteger(entry.size) || entry.size < 0
        || !Number.isSafeInteger(offset) || offset < 0 || dataStart + offset + entry.size > size) {
        throw new Error(`Unsupported or invalid archive entry: ${filePath}`)
      }
      return { entry, offset: dataStart + offset, buf: readExact(fd, entry.size, dataStart + offset) }
    }
    return fn({ fd, size, read })
  } finally {
    fs.closeSync(fd)
  }
}

function validateManifest(file, manifest) {
  if (!manifest || !Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    throw new Error('Restore manifest missing, invalid or empty')
  }
  if (!manifest.asarPath || RAW.realpathSync(file) !== RAW.realpathSync(manifest.asarPath)) {
    throw new Error('Restore manifest belongs to a different archive')
  }
  if (manifest.asarSize !== RAW.statSync(file).size) throw new Error('Archive size differs from restore manifest')
  const ids = new Set()
  for (const rec of manifest.targets) {
    const target = TARGETS.find((t) => t.id === rec.id && t.file === rec.file)
    if (!target || ids.has(rec.id)) throw new Error('Unknown or duplicate restore target')
    ids.add(rec.id)
    if (!Number.isSafeInteger(rec.relOffset) || rec.relOffset < 0
      || !Number.isSafeInteger(rec.bytes) || rec.bytes <= 0) throw new Error('Invalid restore span')
    for (const [encoded, hash] of [[rec.originalBase64, rec.originalSha16], [rec.newBase64, rec.newSha16]]) {
      if (typeof encoded !== 'string') throw new Error('Restore bytes missing')
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.length !== rec.bytes || sha16(bytes) !== hash) throw new Error('Restore bytes failed checksum')
    }
  }
}

function classify(buf, target, rec) {
  if (rec && Number.isSafeInteger(rec.relOffset) && rec.relOffset >= 0
    && Number.isSafeInteger(rec.bytes) && rec.bytes > 0 && rec.relOffset + rec.bytes <= buf.length) {
    const hash = sha16(buf.subarray(rec.relOffset, rec.relOffset + rec.bytes))
    if (hash === rec.originalSha16) return 'clean'
    if (hash === rec.newSha16) return 'patched'
    return 'drifted'
  }
  if (buf.includes(Buffer.from(target.replacement))) return 'patched'
  const at = buf.indexOf(Buffer.from(target.startAnchor))
  if (at < 0) return 'anchor-miss'
  const start = target.mode === 'after' ? at + Buffer.byteLength(target.startAnchor) : at
  return buf.subarray(start).toString('utf8').startsWith(target.expectPrefix) ? 'clean' : 'drifted'
}

export function inspectMaintenanceHost(asarPath = '', restoreFile = manifestPath()) {
  const file = detectAsar(asarPath)
  if (!file) return { ok: false, asarPath: null, reason: 'app.asar not found', rows: [], restorable: false }
  const manifest = readManifest(restoreFile)
  let manifestError = null
  try { validateManifest(file, manifest) } catch (error) { manifestError = messageOf(error) }
  try {
    const rows = withArchive(file, 'r', ({ read }) => TARGETS.map((target) => {
      try {
        const { buf } = read(target.file)
        const rec = manifestError ? null : manifest.targets.find((r) => r.id === target.id)
        return { id: target.id, state: classify(buf, target, rec) }
      } catch (error) {
        return { id: target.id, state: 'missing-file', detail: messageOf(error) }
      }
    }))
    const patched = rows.filter((r) => r.state === 'patched').length
    const clean = rows.filter((r) => r.state === 'clean').length
    const problem = rows.filter((r) => !['patched', 'clean'].includes(r.state))
    const uncovered = rows.some((r) => r.state === 'patched' && !manifest?.targets?.some((rec) => rec.id === r.id))
    return {
      ok: problem.length === 0, asarPath: file, rows, patched, clean, total: rows.length,
      restorable: !manifestError && !uncovered && problem.length === 0,
      reason: problem.length ? 'Archive contains unknown or changed spans' : null,
      restoreWarning: uncovered ? 'Restore record is incomplete' : manifestError,
    }
  } catch (error) {
    return { ok: false, asarPath: file, reason: messageOf(error), rows: [], restorable: false }
  }
}

/** Validate every span before restoring any byte; never recreates modified text. */
export function restoreHost(asarPath = '', restoreFile = manifestPath()) {
  const file = detectAsar(asarPath)
  if (!file) return { ok: false, changed: false, reason: 'app.asar not found' }
  let attemptedWrite = false
  try {
    const manifest = readManifest(restoreFile)
    validateManifest(file, manifest)
    const status = inspectMaintenanceHost(file, restoreFile)
    if (!status.restorable) throw new Error(status.reason || status.restoreWarning || 'Archive cannot be safely restored')
    const results = withArchive(file, 'r+', ({ fd, read }) => {
      const planned = manifest.targets.map((rec) => {
        const item = read(rec.file)
        if (rec.relOffset + rec.bytes > item.buf.length) throw new Error('Restore span exceeds archive entry')
        const current = item.buf.subarray(rec.relOffset, rec.relOffset + rec.bytes)
        const hash = sha16(current)
        if (hash !== rec.newSha16 && hash !== rec.originalSha16) throw new Error(`Changed span: ${rec.id}`)
        return { rec, offset: item.offset + rec.relOffset, already: hash === rec.originalSha16 }
      })
      const outcomes = []
      for (const item of planned) {
        if (!item.already) {
          attemptedWrite = true
          const original = Buffer.from(item.rec.originalBase64, 'base64')
          let n = 0
          while (n < original.length) {
            const count = fs.writeSync(fd, original, n, original.length - n, item.offset + n)
            if (count === 0) throw new Error('Restore write made no progress')
            n += count
          }
          if (sha16(readExact(fd, original.length, item.offset)) !== item.rec.originalSha16) {
            throw new Error(`Restore verification failed: ${item.rec.id}`)
          }
        }
        outcomes.push({ id: item.rec.id, action: item.already ? 'already' : 'reverted' })
      }
      fs.fsyncSync(fd)
      return outcomes
    })
    return { ok: true, changed: results.some((r) => r.action === 'reverted'), results }
  } catch (error) {
    // Only attempted writes need an uncertain disk/restart warning.
    return { ok: false, changed: attemptedWrite ? null : false, reason: messageOf(error) }
  }
}

/** Exact full-line markers only; incomplete/duplicate/edited blocks are not removed. */
function profileSpan(text) {
  const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)].filter((m) => m[0].length)
  const starts = lines.filter((m) => m[0].replace(/[\r\n]+$/, '') === BEGIN)
  const ends = lines.filter((m) => m[0].replace(/[\r\n]+$/, '') === END)
  if (!starts.length && !ends.length) return { mode: 'absent', present: false }
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) {
    return { mode: 'unprovable', present: true, reason: 'Block markers are incomplete, repeated or out of order' }
  }
  const start = starts[0].index
  const bodyStart = start + starts[0][0].length
  const body = text.slice(bodyStart, ends[0].index).replace(/\r\n/g, '\n')
  if (body !== BLOCK_BODY) return { mode: 'edited', present: true, reason: 'Generated block has been edited; automatic removal refused' }
  return { mode: 'markers', present: true, start, stop: ends[0].index + ends[0][0].length }
}

export function inspectMaintenanceProfile(profileDir) {
  if (!profileDir) return { ok: false, present: false, profileDir: null, reason: 'Current profile could not be identified' }
  const file = path.join(profileDir, 'cordis.patch.yml')
  try {
    if (!fs.existsSync(file)) return { ok: true, profileDir, file, present: false, mode: 'no-file' }
    const span = profileSpan(fs.readFileSync(file, 'utf8'))
    return { ok: ['markers', 'absent'].includes(span.mode), profileDir, file, present: span.present, mode: span.mode, reason: span.reason }
  } catch (error) { return { ok: false, file, profileDir, reason: messageOf(error) } }
}

export function restoreProfile(profileDir) {
  if (!profileDir) return { ok: false, changed: false, reason: 'Current profile could not be identified' }
  const file = path.join(profileDir, 'cordis.patch.yml')
  try {
    if (!fs.existsSync(file)) return { ok: true, changed: false, action: 'missing', file }
    const original = fs.readFileSync(file, 'utf8')
    const span = profileSpan(original)
    if (span.mode === 'absent') return { ok: true, changed: false, action: 'no-block', file }
    if (span.mode !== 'markers') return { ok: false, changed: false, action: 'unprovable', file, reason: span.reason }
    const next = original.slice(0, span.start) + original.slice(span.stop)
    const backup = `${file}.armor-restore-${randomUUID()}.bak`
    const temp = `${file}.armor-restore-${randomUUID()}.tmp`
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
    fs.writeFileSync(temp, next, { encoding: 'utf8', flag: 'wx' })
    // Refuse to clobber an intervening edit. Leave temp and backup for diagnosis.
    if (fs.readFileSync(file, 'utf8') !== original) throw new Error('Profile changed during restoration')
    fs.renameSync(temp, file)
    return { ok: true, changed: true, action: 'reverted', file, backup }
  } catch (error) { return { ok: false, changed: null, file, reason: messageOf(error) } }
}

export function maintenanceStatus(asarPath = '', profilePath = '') {
  let profileDir = null
  let profileError = null
  try { profileDir = currentProfile(profilePath) } catch (error) { profileError = messageOf(error) }
  return {
    hostClean: inspectMaintenanceHost(asarPath),
    profileClean: profileError ? { ok: false, reason: profileError } : inspectMaintenanceProfile(profileDir),
  }
}
