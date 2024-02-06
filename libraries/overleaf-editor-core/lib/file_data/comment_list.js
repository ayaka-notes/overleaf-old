// @ts-check
const Comment = require('./comment')

/**
 * @typedef {import("../types").CommentRawData} CommentRawData
 * @typedef {import("./range")} Range
 */

class CommentList {
  /**
   * @param {Map<string, Comment>} comments
   */
  constructor(comments) {
    this.comments = comments
  }

  /**
   * @returns {CommentRawData[]}
   */
  getComments() {
    return Array.from(this.comments).map(([commentId, comment]) => {
      return {
        id: commentId,
        ...comment.toRaw(),
      }
    })
  }

  /**
   * @param {string} id
   * @returns {Comment | undefined}
   */
  getComment(id) {
    return this.comments.get(id)
  }

  /**
   * @param {string} id
   * @param {Comment} newComment
   */
  add(id, newComment) {
    const existingComment = this.getComment(id)
    if (existingComment) {
      for (const range of newComment.ranges) {
        existingComment.addRange(range)
      }
    } else {
      this.comments.set(id, newComment)
    }
  }

  /**
   * @param {string} id
   */
  delete(id) {
    return this.comments.delete(id)
  }

  /**
   * @param {CommentRawData[]} rawComments
   */
  static fromRaw(rawComments) {
    const comments = new Map()
    for (const rawComment of rawComments) {
      comments.set(rawComment.id, Comment.fromRaw(rawComment))
    }
    return new CommentList(comments)
  }

  /**
   * @param {Range} range
   * @param {{ commentIds: string[] }} opts
   */
  applyInsert(range, opts = { commentIds: [] }) {
    for (const [commentId, comment] of this.comments) {
      comment.applyInsert(
        range.pos,
        range.length,
        opts.commentIds.includes(commentId)
      )
    }
  }

  /**
   * @param {Range} range
   */
  applyDelete(range) {
    for (const [commentId, comment] of this.comments) {
      comment.applyDelete(range)
      if (comment.isEmpty()) {
        this.delete(commentId)
      }
    }
  }
}

module.exports = CommentList
