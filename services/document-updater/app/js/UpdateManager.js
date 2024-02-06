// @ts-check

const { callbackifyAll } = require('@overleaf/promise-utils')
const LockManager = require('./LockManager')
const RedisManager = require('./RedisManager')
const RealTimeRedisManager = require('./RealTimeRedisManager')
const ShareJsUpdateManager = require('./ShareJsUpdateManager')
const HistoryManager = require('./HistoryManager')
const _ = require('lodash')
const logger = require('@overleaf/logger')
const Metrics = require('./Metrics')
const Errors = require('./Errors')
const DocumentManager = require('./DocumentManager')
const RangesManager = require('./RangesManager')
const SnapshotManager = require('./SnapshotManager')
const Profiler = require('./Profiler')

const UpdateManager = {
  async processOutstandingUpdates(projectId, docId) {
    const timer = new Metrics.Timer('updateManager.processOutstandingUpdates')
    try {
      await UpdateManager.fetchAndApplyUpdates(projectId, docId)
      timer.done({ status: 'success' })
    } catch (err) {
      timer.done({ status: 'error' })
      throw err
    }
  },

  async processOutstandingUpdatesWithLock(projectId, docId) {
    const profile = new Profiler('processOutstandingUpdatesWithLock', {
      project_id: projectId,
      doc_id: docId,
    })

    const lockValue = await LockManager.promises.tryLock(docId)
    if (lockValue == null) {
      return
    }
    profile.log('tryLock')

    try {
      await UpdateManager.processOutstandingUpdates(projectId, docId)
      profile.log('processOutstandingUpdates')
    } finally {
      await LockManager.promises.releaseLock(docId, lockValue)
      profile.log('releaseLock').end()
    }

    await UpdateManager.continueProcessingUpdatesWithLock(projectId, docId)
  },

  async continueProcessingUpdatesWithLock(projectId, docId) {
    const length = await RealTimeRedisManager.promises.getUpdatesLength(docId)
    if (length > 0) {
      await UpdateManager.processOutstandingUpdatesWithLock(projectId, docId)
    }
  },

  async fetchAndApplyUpdates(projectId, docId) {
    const profile = new Profiler('fetchAndApplyUpdates', {
      project_id: projectId,
      doc_id: docId,
    })

    const updates = await RealTimeRedisManager.promises.getPendingUpdatesForDoc(
      docId
    )
    logger.debug(
      { projectId, docId, count: updates.length },
      'processing updates'
    )
    if (updates.length === 0) {
      return
    }
    profile.log('getPendingUpdatesForDoc')

    for (const update of updates) {
      await UpdateManager.applyUpdate(projectId, docId, update)
      profile.log('applyUpdate')
    }
    profile.log('async done').end()
  },

  async applyUpdate(projectId, docId, update) {
    const profile = new Profiler('applyUpdate', {
      project_id: projectId,
      doc_id: docId,
    })

    UpdateManager._sanitizeUpdate(update)
    profile.log('sanitizeUpdate', { sync: true })

    try {
      let { lines, version, ranges, pathname, projectHistoryId } =
        await DocumentManager.promises.getDoc(projectId, docId)
      profile.log('getDoc')

      if (lines == null || version == null) {
        throw new Errors.NotFoundError(`document not found: ${docId}`)
      }

      const previousVersion = version
      const incomingUpdateVersion = update.v
      let updatedDocLines, appliedOps
      ;({ updatedDocLines, version, appliedOps } =
        await ShareJsUpdateManager.promises.applyUpdate(
          projectId,
          docId,
          update,
          lines,
          version
        ))
      profile.log('sharejs.applyUpdate', {
        // only synchronous when the update applies directly to the
        // doc version, otherwise getPreviousDocOps is called.
        sync: incomingUpdateVersion === previousVersion,
      })

      const { newRanges, rangesWereCollapsed } =
        await RangesManager.promises.applyUpdate(
          projectId,
          docId,
          ranges,
          appliedOps,
          updatedDocLines
        )
      profile.log('RangesManager.applyUpdate', { sync: true })

      UpdateManager._addProjectHistoryMetadataToOps(
        appliedOps,
        pathname,
        projectHistoryId,
        lines
      )

      const projectOpsLength = await RedisManager.promises.updateDocument(
        projectId,
        docId,
        updatedDocLines,
        version,
        appliedOps,
        newRanges,
        update.meta
      )
      profile.log('RedisManager.updateDocument')

      HistoryManager.recordAndFlushHistoryOps(
        projectId,
        appliedOps,
        projectOpsLength
      )
      profile.log('recordAndFlushHistoryOps')

      if (rangesWereCollapsed) {
        Metrics.inc('doc-snapshot')
        logger.debug(
          {
            projectId,
            docId,
            previousVersion,
            lines,
            ranges,
            update,
          },
          'update collapsed some ranges, snapshotting previous content'
        )

        // Do this last, since it's a mongo call, and so potentially longest running
        // If it overruns the lock, it's ok, since all of our redis work is done
        await SnapshotManager.promises.recordSnapshot(
          projectId,
          docId,
          previousVersion,
          pathname,
          lines,
          ranges
        )
      }
    } catch (error) {
      RealTimeRedisManager.sendData({
        project_id: projectId,
        doc_id: docId,
        error: error instanceof Error ? error.message : error,
      })
      profile.log('sendData')
      throw error
    } finally {
      profile.end()
    }
  },

  // lockUpdatesAndDo can't be promisified yet because it expects a
  // callback-style function
  async lockUpdatesAndDo(method, projectId, docId, ...args) {
    const profile = new Profiler('lockUpdatesAndDo', {
      project_id: projectId,
      doc_id: docId,
    })

    const lockValue = await LockManager.promises.getLock(docId)
    profile.log('getLock')

    let responseArgs
    try {
      await UpdateManager.processOutstandingUpdates(projectId, docId)
      profile.log('processOutstandingUpdates')

      // TODO: method is still a callback-style function. Change this when promisifying DocumentManager
      responseArgs = await new Promise((resolve, reject) => {
        method(projectId, docId, ...args, (error, ...responseArgs) => {
          if (error) {
            reject(error)
          } else {
            resolve(responseArgs)
          }
        })
      })
      profile.log('method')
    } finally {
      await LockManager.promises.releaseLock(docId, lockValue)
      profile.log('releaseLock').end()
    }

    // We held the lock for a while so updates might have queued up
    UpdateManager.continueProcessingUpdatesWithLock(projectId, docId).catch(
      err => {
        // The processing may fail for invalid user updates.
        // This can be very noisy, put them on level DEBUG
        //  and record a metric.
        Metrics.inc('background-processing-updates-error')
        logger.debug(
          { err, projectId, docId },
          'error processing updates in background'
        )
      }
    )

    return responseArgs
  },

  _sanitizeUpdate(update) {
    // In Javascript, characters are 16-bits wide. It does not understand surrogates as characters.
    //
    // From Wikipedia (http://en.wikipedia.org/wiki/Plane_(Unicode)#Basic_Multilingual_Plane):
    // "The High Surrogates (U+D800–U+DBFF) and Low Surrogate (U+DC00–U+DFFF) codes are reserved
    // for encoding non-BMP characters in UTF-16 by using a pair of 16-bit codes: one High Surrogate
    // and one Low Surrogate. A single surrogate code point will never be assigned a character.""
    //
    // The main offender seems to be \uD835 as a stand alone character, which would be the first
    // 16-bit character of a blackboard bold character (http://www.fileformat.info/info/unicode/char/1d400/index.htm).
    // Something must be going on client side that is screwing up the encoding and splitting the
    // two 16-bit characters so that \uD835 is standalone.
    for (const op of update.op || []) {
      if (op.i != null) {
        // Replace high and low surrogate characters with 'replacement character' (\uFFFD)
        op.i = op.i.replace(/[\uD800-\uDFFF]/g, '\uFFFD')
      }
    }
    return update
  },

  _addProjectHistoryMetadataToOps(updates, pathname, projectHistoryId, lines) {
    let docLength = _.reduce(lines, (chars, line) => chars + line.length, 0)
    docLength += lines.length - 1 // count newline characters
    updates.forEach(function (update) {
      update.projectHistoryId = projectHistoryId
      if (!update.meta) {
        update.meta = {}
      }
      update.meta.pathname = pathname
      update.meta.doc_length = docLength
      // Each update may contain multiple ops, i.e.
      // [{
      // 	ops: [{i: "foo", p: 4}, {d: "bar", p:8}]
      // }, {
      // 	ops: [{d: "baz", p: 40}, {i: "qux", p:8}]
      // }]
      // We want to include the doc_length at the start of each update,
      // before it's ops are applied. However, we need to track any
      // changes to it for the next update.
      for (const op of update.op) {
        if (op.i != null) {
          docLength += op.i.length
        }
        if (op.d != null) {
          docLength -= op.d.length
        }
      }
    })
  },
}

const CallbackifiedUpdateManager = callbackifyAll(UpdateManager)

module.exports = CallbackifiedUpdateManager
module.exports.promises = UpdateManager

module.exports.lockUpdatesAndDo = function lockUpdatesAndDo(
  method,
  projectId,
  docId,
  ...rest
) {
  const adjustedLength = Math.max(rest.length, 1)
  const args = rest.slice(0, adjustedLength - 1)
  const callback = rest[adjustedLength - 1]

  // TODO: During the transition to promises, UpdateManager.lockUpdatesAndDo
  // returns the potentially multiple arguments that must be provided to the
  // callback in an array.
  UpdateManager.lockUpdatesAndDo(method, projectId, docId, ...args)
    .then(responseArgs => {
      callback(null, ...responseArgs)
    })
    .catch(err => {
      callback(err)
    })
}
