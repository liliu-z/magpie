// src/commands/review/interactive.ts
import chalk from 'chalk'
import ora from 'ora'
import { createInterface } from 'readline'
import { marked } from 'marked'
import type { Message } from '../../providers/types.js'
import type { Reviewer, MergedIssue, DebateResult } from '../../orchestrator/types.js'
import type { ReviewTarget, ReviewerSessionState } from './types.js'
import { fixMarkdown, formatIssueForGitHub } from './utils.js'

// Interactive reviewer selection
export async function selectReviewers(availableIds: string[], rl?: ReturnType<typeof createInterface>): Promise<string[]> {
  // Use provided rl or create a temporary one
  const useExternalRl = !!rl
  if (!rl) {
    rl = createInterface({
      input: process.stdin,
      output: process.stdout
    })
  }

  // Ensure stdin is flowing (ora spinner may have paused it)
  if (process.stdin.isPaused?.()) {
    process.stdin.resume()
  }

  console.log(chalk.cyan('\nAvailable reviewers:'))
  console.log(chalk.dim('  [0] All reviewers'))
  availableIds.forEach((id, i) => {
    console.log(chalk.dim(`  [${i + 1}] ${id}`))
  })

  return new Promise((resolve) => {
    rl!.question(chalk.yellow('\nSelect reviewers (e.g., 1,2 or 0 for all): '), (answer) => {
      // Only close if we created it ourselves
      if (!useExternalRl) {
        rl!.close()
      }
      const input = answer.trim()

      if (input === '0' || input.toLowerCase() === 'all' || input === '') {
        resolve(availableIds)
        return
      }

      const indices = input.split(',').map(s => parseInt(s.trim(), 10) - 1)
      const selected = indices
        .filter(i => i >= 0 && i < availableIds.length)
        .map(i => availableIds[i])

      if (selected.length === 0) {
        console.log(chalk.yellow('No valid selection, using all reviewers'))
        resolve(availableIds)
      } else {
        resolve(selected)
      }
    })
  })
}

// Interactive follow-up Q&A after review conclusion
export async function interactiveFollowUpQA(
  rl: ReturnType<typeof createInterface>,
  reviewers: Reviewer[],
  result: DebateResult,
  spinnerRef: { spinner: ReturnType<typeof ora> | null; interval: ReturnType<typeof setInterval> | null }
): Promise<void> {
  // Build context from the review
  const reviewContext = `
Previous Review Summary:
${result.analysis}

Key Discussion Points:
${result.messages.slice(-reviewers.length).map(m => `[${m.reviewerId}]: ${m.content.slice(0, 500)}...`).join('\n\n')}

Final Conclusion:
${result.finalConclusion}
`.trim()

  console.log(chalk.cyan(`\n💬 You can ask follow-up questions about this review.`))
  console.log(chalk.dim(`   Format: @reviewer_id question (e.g., @claude Can you explain the security issue?)
   Or just type a question to ask all reviewers.${reviewers.map(r => `\n   Available: @${r.id}`).join('')}`))

  while (true) {
    // Ensure stdin is flowing (ora spinner may have paused it)
    if (process.stdin.isPaused?.()) process.stdin.resume()
    const answer = await new Promise<string>((resolve) => {
      rl.question(chalk.yellow('\n❓ Follow-up (or Enter to end): '), resolve)
    })

    if (!answer.trim()) {
      break
    }

    // Parse @target format or ask all
    const match = answer.match(/^@(\S+)\s+(.+)$/s)
    let targetReviewers: Reviewer[]
    let question: string

    if (match) {
      const targetId = match[1].replace(/^@/, '')
      const targetReviewer = reviewers.find(r => r.id.toLowerCase() === targetId.toLowerCase())
      if (!targetReviewer) {
        console.log(chalk.red(`   Unknown reviewer: ${targetId}`))
        continue
      }
      targetReviewers = [targetReviewer]
      question = match[2]
    } else {
      targetReviewers = reviewers
      question = answer
    }

    const prompt = `Based on the previous code review:

${reviewContext}

Please answer this follow-up question:
${question}

Provide a focused, helpful response.`

    // Ask each target reviewer
    for (const reviewer of targetReviewers) {
      console.log(chalk.cyan.bold(`\n┌─ ${reviewer.id} `))
      console.log(chalk.cyan(`│`))

      if (spinnerRef.spinner) spinnerRef.spinner.stop()
      spinnerRef.spinner = ora({ text: `${reviewer.id} is thinking...`, discardStdin: false }).start()

      let response = ''
      try {
        for await (const chunk of reviewer.provider.chatStream(
          [{ role: 'user', content: prompt }],
          reviewer.systemPrompt
        )) {
          if (spinnerRef.spinner) {
            spinnerRef.spinner.stop()
            spinnerRef.spinner = null
          }
          response += chunk
          process.stdout.write(chunk)
        }
        console.log()
      } catch (error) {
        if (spinnerRef.spinner) spinnerRef.spinner.stop()
        console.log(chalk.red(`   Error: ${error instanceof Error ? error.message : 'Unknown error'}`))
      }
    }
  }
}

// Post-review discussion: chat with any role (reviewer/analyzer/summarizer) before comment posting
export async function interactivePostReviewDiscussion(
  rl: ReturnType<typeof createInterface>,
  allRoles: Reviewer[],
  debateResult: DebateResult,
  target: ReviewTarget,
  issues: MergedIssue[],
  spinnerRef: { spinner: ReturnType<typeof ora> | null; interval: ReturnType<typeof setInterval> | null },
  reviewerSessions: Map<string, ReviewerSessionState>,
  language?: string,
): Promise<void> {
  // Ensure stdin is flowing (ora spinner may have paused it)
  if (process.stdin.isPaused?.()) process.stdin.resume()
  const enter = await new Promise<string>(resolve => {
    rl.question(chalk.yellow('\n  Enter discussion phase? (y/n): '), resolve)
  })
  if (enter.trim().toLowerCase() !== 'y') return

  while (true) {
    // Display numbered list of all roles
    console.log(chalk.cyan('\n  Available roles:'))
    allRoles.forEach((role, i) => {
      console.log(chalk.dim(`    [${i + 1}] ${role.id}`))
    })

    const pick = await new Promise<string>(resolve => {
      rl.question(chalk.yellow('\n  Pick a role by number (or Enter to exit discussion): '), resolve)
    })

    if (!pick.trim()) break

    const idx = parseInt(pick.trim(), 10) - 1
    if (idx < 0 || idx >= allRoles.length) {
      console.log(chalk.red('  Invalid selection.'))
      continue
    }

    const selectedRole = allRoles[idx]
    console.log(chalk.dim(`  Chatting with ${selectedRole.id}. (Empty line to end, /skip to exit discussion phase)`))

    // Get or create session for selected role
    const session = getOrCreateSession(selectedRole, reviewerSessions, debateResult, target, issues, language)

    while (true) {
      if (process.stdin.isPaused?.()) process.stdin.resume()

      const question = await new Promise<string>(resolve => {
        rl.question(chalk.yellow(`  You → ${selectedRole.id}: `), resolve)
      })

      if (!question.trim()) break
      if (question.trim() === '/skip') return  // Exit entire discussion phase

      session.conversationHistory.push({ role: 'user', content: question })

      let response = ''
      if (spinnerRef.spinner) spinnerRef.spinner.stop()
      const chatSpinner = ora({ text: `${selectedRole.id} is thinking...`, discardStdin: false }).start()

      try {
        for await (const chunk of selectedRole.provider.chatStream(
          session.conversationHistory,
          selectedRole.systemPrompt
        )) {
          response += chunk
        }
      } finally {
        chatSpinner.stop()
        if (process.stdin.isPaused?.()) process.stdin.resume()
      }

      console.log(chalk.cyan(`\n  ${selectedRole.id}:`))
      console.log(marked(fixMarkdown(response)))

      session.conversationHistory.push({ role: 'assistant', content: response })
    }
  }
}

export function buildInitialSessionContext(
  reviewer: Reviewer,
  debateResult: DebateResult,
  target: ReviewTarget,
  issues: MergedIssue[],
  language?: string,
): string {
  const parts: string[] = []

  // 1. Role explanation
  parts.push(`You are reviewer "${reviewer.id}" entering the post-review discussion phase. The human will discuss specific issues with you one by one. You have the full context of the PR and your original review below.`)

  // 2. PR diff (from target.prompt)
  parts.push(`## PR Diff & Review Prompt\n\n${target.prompt}`)

  // 3. Gathered context summary
  if (debateResult.context?.summary) {
    parts.push(`## Gathered Context\n\n${debateResult.context.summary}`)
  }

  // 4. This reviewer's debate messages and summary
  const reviewerMessages = debateResult.messages
    .filter(m => m.reviewerId === reviewer.id)
    .map(m => m.content)
  const reviewerSummary = debateResult.summaries
    .find(s => s.reviewerId === reviewer.id)?.summary || ''

  if (reviewerMessages.length > 0) {
    parts.push(`## Your Original Review Analysis\n\n${reviewerMessages.join('\n\n')}`)
  }
  if (reviewerSummary) {
    parts.push(`## Your Review Summary\n\n${reviewerSummary}`)
  }

  // 5. Overall analysis
  if (debateResult.analysis) {
    parts.push(`## Initial PR Analysis\n\n${debateResult.analysis}`)
  }

  // 6. All issues overview
  const issueList = issues.map((iss, idx) =>
    `${idx + 1}. [${iss.severity.toUpperCase()}] ${iss.title} @ ${iss.file}${iss.line ? ':' + iss.line : ''} (raised by: ${iss.raisedBy.join(', ')})`
  ).join('\n')
  parts.push(`## All Issues Found\n\n${issueList}`)

  // 7. Discussion behavior guidance
  const langRule = language ? `\n- You MUST respond in ${language}.` : ''
  parts.push(`## Discussion Guidelines\n\nWhen discussing issues:\n- Reference specific code from the diff when explaining problems\n- Be concise but thorough\n- If the human's points are valid, update your assessment\n- Be willing to change severity, revise descriptions, or withdraw issues entirely if convinced\n- Remember context from previous issue discussions in this session${langRule}`)

  return parts.join('\n\n---\n\n')
}

export function getOrCreateSession(
  reviewer: Reviewer,
  sessions: Map<string, ReviewerSessionState>,
  debateResult: DebateResult,
  target: ReviewTarget,
  issues: MergedIssue[],
  language?: string,
): ReviewerSessionState {
  const existing = sessions.get(reviewer.id)
  if (existing) return existing

  // Start provider session if supported
  if (reviewer.provider.startSession) {
    reviewer.provider.startSession(`discuss-${reviewer.id}`)
  }

  const initialContext = buildInitialSessionContext(reviewer, debateResult, target, issues, language)
  const session: ReviewerSessionState = {
    conversationHistory: [
      { role: 'user', content: initialContext },
      { role: 'assistant', content: 'Understood. I have the full PR context, gathered context, and my original review analysis. Ready to discuss specific issues.' },
    ],
    sessionStarted: !!reviewer.provider.startSession,
  }
  sessions.set(reviewer.id, session)
  return session
}

export async function interactiveCommentReview(
  rl: ReturnType<typeof createInterface>,
  issues: MergedIssue[],
  allRoles: Reviewer[],
  prNumber: string,
  spinnerRef: { spinner: ReturnType<typeof ora> | null; interval: ReturnType<typeof setInterval> | null },
  debateResult: DebateResult,
  target: ReviewTarget,
  interruptState?: { interrupted: boolean },
  reviewerSessions?: Map<string, ReviewerSessionState>,
  language?: string,
): Promise<void> {
  // Guard against unhandled promise rejections from async generator cleanup
  // (e.g., provider stream teardown) crashing the entire process
  const rejectHandler = (reason: unknown) => {
    console.error(chalk.red(`\n  Async error (non-fatal): ${reason}`))
  }
  process.on('unhandledRejection', rejectHandler)

  const approved: { issue: MergedIssue; comment: string }[] = []
  const stats = { posted: 0, edited: 0, discussed: 0, skipped: 0 }
  const sessions = reviewerSessions ?? new Map<string, ReviewerSessionState>()

  const showProgress = (current: number) => {
    const done = stats.posted + stats.edited + stats.discussed + stats.skipped
    const parts = []
    if (stats.posted > 0) parts.push(chalk.green(`${stats.posted} posted`))
    if (stats.edited > 0) parts.push(chalk.yellow(`${stats.edited} edited`))
    if (stats.discussed > 0) parts.push(chalk.cyan(`${stats.discussed} discussed`))
    if (stats.skipped > 0) parts.push(chalk.dim(`${stats.skipped} skipped`))
    const progress = parts.length > 0 ? parts.join(', ') : 'none yet'
    return chalk.dim(`  [${done}/${issues.length} done: ${progress}]`)
  }

  function cleanupSessions() {
    for (const [reviewerId, session] of sessions) {
      if (session.sessionStarted) {
        const role = allRoles.find(r => r.id === reviewerId)
        if (role?.provider.endSession) {
          role.provider.endSession()
        }
      }
    }
    sessions.clear()
    process.removeListener('unhandledRejection', rejectHandler)
  }

  console.log(chalk.cyan('\n📝 Post-processing: Review each issue before posting to GitHub'))
  console.log(chalk.dim('   [p] Post as-is  [e] Edit  [d] Discuss with reviewer  [s] Skip  [q] Stop\n'))

  // Ensure stdin is flowing (ora spinner may have paused it)
  if (process.stdin.isPaused?.()) process.stdin.resume()

  // Ask for comment style instructions up front
  const commentStylePrompt = await new Promise<string>(resolve => {
    rl.question(chalk.yellow('  Comment style instructions (or Enter for default): '), resolve)
  })
  if (commentStylePrompt.trim()) {
    console.log(chalk.dim(`  Style: ${commentStylePrompt.trim()}`))
  }

  try {

  for (let i = 0; i < issues.length; i++) {
    if (interruptState?.interrupted) {
      console.log(chalk.dim('\n  Interrupted by Ctrl+C.'))
      break
    }
    const issue = issues[i]
    const severityColors: Record<string, (s: string) => string> = {
      critical: chalk.red.bold, high: chalk.red, medium: chalk.yellow, low: chalk.blue, nitpick: chalk.dim
    }
    const color = severityColors[issue.severity] || chalk.white
    const location = issue.line ? `${issue.file}:${issue.line}` : issue.file

    console.log(chalk.bold(`\n${'─'.repeat(50)}`))
    console.log(color(`  ${i + 1}/${issues.length} [${issue.severity.toUpperCase()}] ${issue.title}`))
    console.log(chalk.dim(`  ${location}  [${issue.raisedBy.join(', ')}]`))
    if (i > 0) console.log(showProgress(i))
    console.log()
    // Render description as markdown for rich display (code blocks, formatting)
    console.log(marked(fixMarkdown(issue.description)))
    if (issue.suggestedFix) {
      console.log(chalk.green(`  Fix: ${issue.suggestedFix}`))
    }

    const action = await new Promise<string>(resolve => {
      rl.question(chalk.yellow(`\n  Action [p/e/d/s/q]: `), resolve)
    })

    const choice = action.trim().toLowerCase()

    if (choice === 'q') {
      console.log(chalk.dim('  Stopping post-processing.'))
      break
    }

    if (choice === 's' || choice === '') {
      stats.skipped++
      console.log(chalk.dim('  Skipped.'))
      continue
    }

    if (choice === 'p') {
      const comment = formatIssueForGitHub(issue)
      approved.push({ issue, comment })
      stats.posted++
      console.log(chalk.green('  ✓ Will post.'))
      continue
    }

    if (choice === 'e') {
      const edited = await new Promise<string>(resolve => {
        rl.question(chalk.yellow('  Enter comment text: '), resolve)
      })
      if (edited.trim()) {
        approved.push({ issue, comment: edited.trim() })
        stats.edited++
        console.log(chalk.green('  ✓ Will post (edited).'))
      } else {
        stats.skipped++
      }
      continue
    }

    if (choice === 'd') {
      // Discuss with any available role
      let targetReviewer: Reviewer | undefined

      // Show all roles with the default (first raisedBy reviewer) highlighted
      const defaultId = issue.raisedBy[0]
      console.log(chalk.dim('  Available roles:'))
      allRoles.forEach((role, idx) => {
        const isDefault = role.id === defaultId
        const label = isDefault ? chalk.cyan(`${role.id} (default)`) : role.id
        console.log(chalk.dim(`    [${idx + 1}] ${label}`))
      })

      const pickAnswer = await new Promise<string>(resolve => {
        rl.question(chalk.yellow(`  Pick by number (Enter for ${defaultId}): `), resolve)
      })

      if (pickAnswer.trim()) {
        const idx = parseInt(pickAnswer.trim(), 10) - 1
        if (idx >= 0 && idx < allRoles.length) {
          targetReviewer = allRoles[idx]
        } else {
          // Try matching by name
          targetReviewer = allRoles.find(r => r.id === pickAnswer.trim())
        }
      }

      // Fallback to default raisedBy or first role
      if (!targetReviewer) {
        targetReviewer = allRoles.find(r => r.id === defaultId) || allRoles[0]
      }

      if (targetReviewer) {
        try {
        console.log(chalk.dim(`  Discussing with ${targetReviewer.id}. (Empty line to end discussion, /skip to abandon issue)`))

        // Get or create persistent session for this reviewer
        const session = getOrCreateSession(targetReviewer, sessions, debateResult, target, issues, language)
        let discussionHappened = false
        let issueAbandoned = false

        // Auto-explain: ask the reviewer to detail the issue before user interaction
        {
          const issueDetail = `[${issue.severity.toUpperCase()}] ${issue.title} at ${issue.file}${issue.line ? ':' + issue.line : ''}\n${issue.description}${issue.suggestedFix ? '\nSuggested fix: ' + issue.suggestedFix : ''}`
          const explainPrompt = `Now let's discuss issue: ${issueDetail}\n\nBefore the human asks questions, first explain this issue in detail:\n1. Where exactly is the problem? (quote the relevant code from the diff)\n2. Why is this a problem? (what could go wrong)\n3. How should it be fixed? (concrete suggestion with code)\n\nBe concise but thorough.`
          session.conversationHistory.push({ role: 'user', content: explainPrompt })

          let explainResponse = ''
          if (spinnerRef.spinner) spinnerRef.spinner.stop()
          const explainSpinner = ora({ text: `${targetReviewer.id} is explaining...`, discardStdin: false }).start()

          for await (const chunk of targetReviewer.provider.chatStream(
            session.conversationHistory,
            targetReviewer.systemPrompt
          )) {
            explainResponse += chunk
          }
          explainSpinner.stop()
          if (process.stdin.isPaused?.()) process.stdin.resume()

          console.log(chalk.cyan(`\n  ${targetReviewer.id}:`))
          console.log(marked(fixMarkdown(explainResponse)))
          session.conversationHistory.push({ role: 'assistant', content: explainResponse })
          discussionHappened = true
        }

        while (true) {
          // Ensure stdin is flowing before each question (ora/spinner may have paused it)
          if (process.stdin.isPaused?.()) {
            process.stdin.resume()
          }
          const question = await new Promise<string>((resolve) => {
            if ((rl as unknown as { closed?: boolean }).closed) {
              resolve('')
              return
            }
            const hint = 'Enter to end, /skip to abandon'
            let hintVisible = true
            const clearHint = () => {
              if (hintVisible) {
                hintVisible = false
                process.stdout.write('\x1b[K') // clear hint to end of line
              }
              process.stdin.removeListener('data', clearHint)
            }
            rl.question(chalk.yellow(`  You → ${targetReviewer!.id}: `), (answer) => {
              clearHint()
              resolve(answer)
            })
            // Show dim placeholder that clears on first keypress
            process.stdout.write(chalk.dim(hint))
            process.stdout.write(`\x1b[${hint.length}D`)
            process.stdin.on('data', clearHint)
          })
          if (!question.trim()) break
          if (question.trim() === '/skip' || question.trim() === '/drop') {
            issueAbandoned = true
            break
          }

          session.conversationHistory.push({ role: 'user', content: question })

          let response = ''
          if (spinnerRef.spinner) spinnerRef.spinner.stop()
          const discussSpinner = ora({ text: `${targetReviewer.id} is thinking...`, discardStdin: false }).start()

          for await (const chunk of targetReviewer.provider.chatStream(
            session.conversationHistory,
            targetReviewer.systemPrompt
          )) {
            response += chunk
          }
          discussSpinner.stop()
          // Safety: restore stdin after spinner stop in case discardStdin was active
          if (process.stdin.isPaused?.()) {
            process.stdin.resume()
          }
          console.log(chalk.cyan(`\n  ${targetReviewer.id}:`))
          console.log(marked(fixMarkdown(response)))

          session.conversationHistory.push({ role: 'assistant', content: response })
        }

        if (issueAbandoned) {
          stats.skipped++
          console.log(chalk.dim('  Issue abandoned.'))
          // fall through to continue (handled by outer if/continue)
        } else if (discussionHappened) {
          // Generate (and optionally regenerate) the final comment
          const styleClause = commentStylePrompt.trim() ? `\nComment style requirements: ${commentStylePrompt.trim()}` : ''
          let generatePrompt = `Based on our discussion, generate the final GitHub review comment for this issue.${styleClause}\n- If we agreed to drop/withdraw this issue, respond with exactly: SKIP\n- Otherwise, output ONLY the comment text in markdown format, including updated severity, description, and suggested fix if applicable.\n- End with: _Found by: ${issue.raisedBy.join(', ')} via Magpie_\nOutput nothing else.`
          let commentResolved = false

          while (!commentResolved) {
            console.log(chalk.dim('\n  Generating final comment based on discussion...'))
            session.conversationHistory.push({ role: 'user', content: generatePrompt })

            let finalComment = ''
            const genSpinner = ora({ text: `${targetReviewer.id} generating comment...`, discardStdin: false }).start()
            for await (const chunk of targetReviewer.provider.chatStream(
              session.conversationHistory,
              targetReviewer.systemPrompt
            )) {
              finalComment += chunk
            }
            genSpinner.stop()
            if (process.stdin.isPaused?.()) process.stdin.resume()
            console.log(chalk.dim('\n  Generated comment:'))
            console.log(marked(fixMarkdown(finalComment)))
            session.conversationHistory.push({ role: 'assistant', content: finalComment })

            finalComment = finalComment.trim()

            if (finalComment.toUpperCase() === 'SKIP') {
              stats.discussed++
              console.log(chalk.dim('  Issue withdrawn after discussion.'))
              commentResolved = true
            } else if (finalComment) {
              const postAction = await new Promise<string>(resolve => {
                rl.question(chalk.yellow('  [p] Post generated / [o] Post original / [e] Edit / [r] Regenerate / [s] Skip: '), resolve)
              })
              const act = postAction.trim().toLowerCase()
              if (act === 'p') {
                approved.push({ issue, comment: finalComment })
                stats.discussed++
                console.log(chalk.green('  ✓ Will post (revised).'))
                commentResolved = true
              } else if (act === 'o') {
                approved.push({ issue, comment: formatIssueForGitHub(issue) })
                stats.discussed++
                console.log(chalk.green('  ✓ Will post (original).'))
                commentResolved = true
              } else if (act === 'e') {
                const edited = await new Promise<string>(resolve => {
                  rl.question(chalk.yellow('  Enter comment text: '), resolve)
                })
                if (edited.trim()) {
                  approved.push({ issue, comment: edited.trim() })
                  stats.discussed++
                  console.log(chalk.green('  ✓ Will post (edited).'))
                } else {
                  stats.skipped++
                }
                commentResolved = true
              } else if (act === 'r') {
                const regenPrompt = await new Promise<string>(resolve => {
                  rl.question(chalk.yellow('  Regenerate instructions: '), resolve)
                })
                if (regenPrompt.trim()) {
                  generatePrompt = `The human wants you to regenerate the comment with these instructions: ${regenPrompt.trim()}${styleClause}\n\nRegenerate the GitHub review comment for this issue.\n- If you now believe this issue should be dropped, respond with exactly: SKIP\n- Otherwise, output ONLY the comment text in markdown format.\n- End with: _Found by: ${issue.raisedBy.join(', ')} via Magpie_\nOutput nothing else.`
                } else {
                  generatePrompt = `Regenerate the GitHub review comment for this issue with a different approach.${styleClause}\n- Output ONLY the comment text in markdown format.\n- End with: _Found by: ${issue.raisedBy.join(', ')} via Magpie_\nOutput nothing else.`
                }
                // Loop continues — will regenerate
              } else {
                stats.skipped++
                console.log(chalk.dim('  Skipped.'))
                commentResolved = true
              }
            } else {
              // Generation failed, fall back to original
              const postAction = await new Promise<string>(resolve => {
                rl.question(chalk.yellow('  [p] Post original / [e] Edit / [r] Regenerate / [s] Skip: '), resolve)
              })
              const act = postAction.trim().toLowerCase()
              if (act === 'p') {
                approved.push({ issue, comment: formatIssueForGitHub(issue) })
                stats.discussed++
                console.log(chalk.green('  ✓ Will post.'))
                commentResolved = true
              } else if (act === 'e') {
                const edited = await new Promise<string>(resolve => {
                  rl.question(chalk.yellow('  Enter comment text: '), resolve)
                })
                if (edited.trim()) {
                  approved.push({ issue, comment: edited.trim() })
                  stats.discussed++
                  console.log(chalk.green('  ✓ Will post (edited).'))
                } else {
                  stats.skipped++
                }
                commentResolved = true
              } else if (act === 'r') {
                const regenPrompt = await new Promise<string>(resolve => {
                  rl.question(chalk.yellow('  Regenerate instructions: '), resolve)
                })
                if (regenPrompt.trim()) {
                  generatePrompt = `The human wants you to regenerate the comment with these instructions: ${regenPrompt.trim()}${styleClause}\n\nRegenerate the GitHub review comment for this issue.\n- Output ONLY the comment text in markdown format.\n- End with: _Found by: ${issue.raisedBy.join(', ')} via Magpie_\nOutput nothing else.`
                } else {
                  generatePrompt = `Regenerate the GitHub review comment for this issue with a different approach.${styleClause}\n- Output ONLY the comment text in markdown format.\n- End with: _Found by: ${issue.raisedBy.join(', ')} via Magpie_\nOutput nothing else.`
                }
                // Loop continues — will regenerate
              } else {
                stats.skipped++
                console.log(chalk.dim('  Skipped.'))
                commentResolved = true
              }
            }
          }
        } else {
          // No discussion happened (user pressed Enter immediately)
          const postAction = await new Promise<string>(resolve => {
            rl.question(chalk.yellow('  [p] Post / [e] Edit / [s] Skip: '), resolve)
          })
          if (postAction.trim().toLowerCase() === 'p') {
            approved.push({ issue, comment: formatIssueForGitHub(issue) })
            stats.discussed++
            console.log(chalk.green('  ✓ Will post.'))
          } else if (postAction.trim().toLowerCase() === 'e') {
            const edited = await new Promise<string>(resolve => {
              rl.question(chalk.yellow('  Enter comment text: '), resolve)
            })
            if (edited.trim()) {
              approved.push({ issue, comment: edited.trim() })
              stats.discussed++
              console.log(chalk.green('  ✓ Will post (edited).'))
            } else {
              stats.skipped++
            }
          } else {
            stats.skipped++
            console.log(chalk.dim('  Skipped.'))
          }
        }
        } catch (err) {
          console.log(chalk.red(`\n  Discussion error: ${err instanceof Error ? err.message : err}`))
          console.log(chalk.dim('  Skipping this issue, moving to next...'))
        }
      }
      continue
    }
  }

  // Batch post
  if (approved.length === 0) {
    console.log(chalk.dim('\nNo comments to post.'))
    return
  }

  console.log(chalk.cyan.bold(`\n${'═'.repeat(50)}`))
  console.log(chalk.cyan.bold(`  Ready to post ${approved.length} comments to PR #${prNumber}`))
  console.log(chalk.cyan.bold(`${'═'.repeat(50)}`))

  for (const { issue, comment } of approved) {
    const location = issue.line ? `${issue.file}:${issue.line}` : issue.file
    console.log(chalk.dim(`  - [${issue.severity.toUpperCase()}] ${issue.title} @ ${location}`))
  }

  const confirm = await new Promise<string>(resolve => {
    rl.question(chalk.yellow('\n  Post all comments? (y/n): '), resolve)
  })

  if (confirm.trim().toLowerCase() === 'y') {
    try {
      const { classifyComments, postReview, getPRHeadSha } = await import('../../github/commenter.js')
      const headSha = getPRHeadSha(prNumber, target.repo)

      const inputs = approved.map(({ issue, comment }) => ({
        path: issue.file,
        line: issue.line,
        body: comment,
      }))

      // Classify comments against the PR diff
      const classified = classifyComments(prNumber, inputs, target.repo)
      const inlineOnes = classified.filter(c => c.mode === 'inline')
      const fallbackOnes = classified.filter(c => c.mode !== 'inline')

      let toPost = classified

      // If any comments would fallback, ask user
      if (fallbackOnes.length > 0) {
        console.log(chalk.yellow(`\n  ⚠ ${fallbackOnes.length} comment(s) not on diff lines:`))
        for (const fb of fallbackOnes) {
          const loc = fb.input.line ? `${fb.input.path}:${fb.input.line}` : fb.input.path
          const label = fb.mode === 'file' ? 'file-level' : 'global (file not in diff)'
          console.log(chalk.yellow(`    - ${loc} → ${label}`))
        }

        const action = await new Promise<string>(resolve => {
          rl.question(chalk.yellow(`\n  [p] Post all (inline + fallback) / [i] Inline only / [r] Retry all as inline / [s] Skip: `), resolve)
        })

        const act = action.trim().toLowerCase()
        if (act === 'i') {
          toPost = inlineOnes
          if (inlineOnes.length === 0) {
            console.log(chalk.dim('  No inline comments to post.'))
            return
          }
        } else if (act === 'r') {
          // Force all to inline mode — let the API try and fail/succeed
          toPost = classified.map(c => ({ ...c, mode: 'inline' as const }))
        } else if (act === 's' || act !== 'p') {
          console.log(chalk.dim('  Cancelled.'))
          return
        }
      }

      const result = postReview(prNumber, toPost, headSha, target.repo)

      const modeLabels = { inline: 'inline', file: 'file-level', global: 'comment', failed: 'FAILED', skipped: 'duplicate' } as const
      for (const d of result.details) {
        const location = d.line ? `${d.path}:${d.line}` : d.path
        if (d.mode === 'skipped') {
          console.log(chalk.dim(`  ○ ${location} (duplicate, skipped)`))
        } else if (d.success) {
          console.log(chalk.green(`  ✓ ${location} (${modeLabels[d.mode]})`))
        } else {
          console.log(chalk.red(`  ✗ ${location}`))
        }
      }

      const parts = []
      if (result.inline > 0) parts.push(`${result.inline} inline`)
      if (result.fileLevel > 0) parts.push(`${result.fileLevel} file-level`)
      if (result.global > 0) parts.push(`${result.global} global`)
      if (result.skipped > 0) parts.push(`${result.skipped} skipped`)
      console.log(chalk.green(`\n  Done: ${result.posted} posted (${parts.join(', ')})${result.failed > 0 ? chalk.red(`, ${result.failed} failed`) : ''}`))
    } catch (error) {
      console.error(chalk.red(`\n  Failed to post: ${error instanceof Error ? error.message : error}`))
    }
  } else {
    console.log(chalk.dim('  Cancelled.'))
  }

  } finally {
    cleanupSessions()
  }
}
