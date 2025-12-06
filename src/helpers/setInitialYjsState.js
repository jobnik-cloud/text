/**
 * SPDX-FileCopyrightText: 2023 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Node } from '@tiptap/pm/model'
import escapeHtml from 'escape-html'
import { prosemirrorToYXmlFragment } from 'y-prosemirror'
import { applyUpdate, Doc, encodeStateAsUpdate, XmlFragment } from 'yjs'
import { createPlainEditor, createRichEditor } from '../EditorFactory.js'
import markdownit from '../markdownit/index.js'

/**
 * Preserves consecutive newlines in markdown by post-processing the rendered HTML.
 * This function analyzes the original markdown to detect sequences of 3+ consecutive
 * newlines between block elements, then inserts empty paragraph elements in the HTML
 * to preserve this formatting.
 *
 * @param {string} markdown - The original markdown content
 * @param {string} html - The HTML rendered by markdown-it
 * @returns {string} HTML with preserved empty paragraphs for consecutive newlines
 */
const preserveConsecutiveNewlines = (markdown, html) => {
	// Parse markdown to tokens to identify block structure
	const tokens = markdownit.parse(markdown, {})
	const lines = markdown.split('\n')
	const blockNewlineCounts = []

	// Track which lines are inside code blocks
	const codeBlockLines = new Set()
	let inCodeBlock = false
	let codeBlockFence = ''

	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const line = lines[lineIdx]
		const codeBlockMatch = line.match(/^(```+|~~~+)/)
		if (codeBlockMatch) {
			if (!inCodeBlock) {
				inCodeBlock = true
				codeBlockFence = codeBlockMatch[0]
			} else if (line.startsWith(codeBlockFence)) {
				inCodeBlock = false
				codeBlockFence = ''
			}
		}
		if (inCodeBlock) {
			codeBlockLines.add(lineIdx)
		}
	}

	// Identify block-level tokens and count newlines after each block
	let blockIndex = 0
	for (let tokenIdx = 0; tokenIdx < tokens.length; tokenIdx++) {
		const token = tokens[tokenIdx]

		// Only process block-level opening tokens
		if (token.type !== 'heading_open' && token.type !== 'paragraph_open' && 
			token.type !== 'bullet_list_open' && token.type !== 'ordered_list_open' &&
			token.type !== 'blockquote_open') {
			continue
		}

		// Get the line range for this token (token.map is [start_line, end_line])
		if (!token.map || token.map.length < 2) {
			continue
		}

		const blockStartLine = token.map[0]
		const blockEndLine = token.map[1] - 1 // map[1] is exclusive, so subtract 1

		// Skip if this block is inside a code block
		if (codeBlockLines.has(blockStartLine)) {
			continue
		}

		// Count consecutive empty lines after this block
		let emptyLineCount = 0
		let nextLineIdx = blockEndLine + 1

		while (nextLineIdx < lines.length && 
			lines[nextLineIdx].trim().length === 0 && 
			!codeBlockLines.has(nextLineIdx)) {
			emptyLineCount++
			nextLineIdx++
		}

		// If we have 3+ consecutive newlines, preserve extras
		// (markdown-it preserves 1, so we need N-1 additional empty paragraphs)
		if (emptyLineCount >= 3) {
			blockNewlineCounts.push({
				blockIndex: blockIndex,
				extraNewlines: emptyLineCount - 1,
			})
		}

		blockIndex++
	}

	if (blockNewlineCounts.length === 0) {
		return html
	}

	// Insert empty paragraphs in the HTML after corresponding block closing tags
	// We'll match blocks by their order in the token stream
	const htmlParts = html.split(/(<\/(?:h[1-6]|p|ul|ol|blockquote|div)>)/)
	const modifiedParts = []
	let currentBlockIdx = 0

	for (let partIdx = 0; partIdx < htmlParts.length; partIdx++) {
		modifiedParts.push(htmlParts[partIdx])

		// Check if this part is a closing tag
		if (htmlParts[partIdx].match(/^<\/(?:h[1-6]|p|ul|ol|blockquote|div)>$/)) {
			// Check if we need to insert empty paragraphs here
			const preservation = blockNewlineCounts.find(p => p.blockIndex === currentBlockIdx)
			if (preservation) {
				// Insert empty paragraphs
				const emptyParagraphs = '<p></p>'.repeat(preservation.extraNewlines)
				modifiedParts.push(emptyParagraphs)
			}
			currentBlockIdx++
		}
	}

	return modifiedParts.join('')
}

export const setInitialYjsState = (ydoc, content, { isRichEditor }) => {
	let html = isRichEditor
		? markdownit.render(content) + '<p/>'
		: `<pre>${escapeHtml(content)}</pre>`

	// Preserve consecutive newlines for rich editor
	if (isRichEditor) {
		html = preserveConsecutiveNewlines(content, html)
	}

	const editor = isRichEditor ? createRichEditor() : createPlainEditor()
	editor.commands.setContent(html)

	const json = editor.getJSON()

	const node = Node.fromJSON(editor.schema, json)
	const getBaseDoc = (node) => {
		const baseDoc = new Doc()
		// In order to make the initial document state idempotent, we need to reset the clientID
		// While this is not recommended, we cannot avoid it here as we lack another mechanism
		// to generate the initial state on the server side
		// The only other option to avoid this could be to generate the initial state once and push
		// it to the server immediately, however this would require read only sessions to be able
		// to still push a state
		baseDoc.clientID = 0
		const type = /** @type {XmlFragment} */ (baseDoc.get('default', XmlFragment))
		if (!type.doc) {
			// This should not happen but is aligned with the upstream implementation
			// https://github.com/yjs/y-prosemirror/blob/8db24263770c2baaccb08e08ea9ef92dbcf8a9da/src/lib.js#L209
			return baseDoc
		}

		prosemirrorToYXmlFragment(node, type)
		return baseDoc
	}

	const baseUpdate = encodeStateAsUpdate(getBaseDoc(node))
	applyUpdate(ydoc, baseUpdate)
}
