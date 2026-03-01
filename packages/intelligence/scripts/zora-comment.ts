/**
 * Zora Comment Automation
 *
 * Posts a comment on a Zora coin page using browser automation.
 * Requires: OpenClaw browser with "openclaw" profile, logged into Zora.
 *
 * Usage (CLI):
 *   npx tsx zora-comment.ts --coin <address> --comment "your comment here"
 *   npx tsx zora-comment.ts --url <full-zora-url> --comment "your comment"
 *
 * Usage (as module):
 *   import { postZoraComment } from './zora-comment.js';
 *   await postZoraComment({ coinAddress: '0x...', comment: 'hello' });
 *
 * HOW IT WORKS (for future reference / skill codification):
 * 1. Navigate to the coin page: https://zora.co/coin/base:<address>
 * 2. Wait for page load
 * 3. Find the comment textarea: document.querySelector('[placeholder*="comment"]')
 * 4. Click it to focus
 * 5. Type the comment text
 * 6. Find the submit button: it's a sibling of the textarea's parent's parent
 *    - textarea.parentElement.parentElement.nextElementSibling (or querySelector('button') on it)
 *    - The button has no aria-label, it's an arrow icon SVG button
 * 7. Click submit
 * 8. Wait ~2s for the comment to appear
 *
 * KNOWN QUIRKS:
 * - The submit button has no accessible name (no aria-label, no text)
 * - It's positioned as a sibling to the textarea wrapper, not inside it
 * - Cookie consent banner may overlay — accept it first if present
 * - Comments appear as "Creator" badge when posted from the coin creator's account
 * - Textarea is a plain <textarea> with placeholder "Add a comment..."
 */

// This script is designed to be called by the OpenClaw agent, not run standalone.
// The agent uses the browser tool directly. This file serves as DOCUMENTATION
// and provides helper functions for programmatic use.

export interface ZoraCommentOptions {
  coinAddress: string;
  comment: string;
  chain?: string; // default: "base"
}

/**
 * Browser automation steps to post a Zora comment.
 * Returns the steps as instructions for the OpenClaw agent's browser tool.
 */
export function getCommentSteps(opts: ZoraCommentOptions): string {
  const chain = opts.chain || "base";
  const url = `https://zora.co/coin/${chain}:${opts.coinAddress}`;

  return `
## Zora Comment Procedure

### Target
URL: ${url}
Comment: "${opts.comment}"

### Steps

1. **Navigate** to ${url} using browser navigate action (profile: openclaw)

2. **Accept cookies** if the consent banner is visible:
   - Look for button "Accept" in the disclosure/cookie banner
   - Click it to dismiss

3. **Find comment input**: Use browser snapshot (refs=aria) and locate:
   - textbox with placeholder "Add a comment..." 
   - Note its ref ID

4. **Click** the comment textbox ref to focus it

5. **Type** the comment text into the textbox ref

6. **Submit** the comment:
   - Use evaluate to find and click the submit button:
   \`\`\`
   () => {
     const textarea = document.querySelector('[placeholder*="comment"]');
     if (!textarea) return 'no textarea';
     const btn = textarea.parentElement?.parentElement?.nextElementSibling;
     if (btn && btn.tagName === 'BUTTON') { btn.click(); return 'clicked'; }
     const container = textarea.parentElement?.parentElement;
     const sibBtn = container?.nextElementSibling?.querySelector('button');
     if (sibBtn) { sibBtn.click(); return 'clicked nested'; }
     // Fallback: walk up more levels
     let el = textarea;
     for (let i = 0; i < 6; i++) {
       el = el.parentElement;
       if (!el) break;
       const sib = el.nextElementSibling;
       if (sib) {
         const b = sib.tagName === 'BUTTON' ? sib : sib.querySelector('button');
         if (b) { b.click(); return 'clicked at level ' + i; }
       }
     }
     return 'submit button not found';
   }
   \`\`\`

7. **Verify**: Wait 2 seconds, then screenshot to confirm comment appears

### Error Recovery
- If "Log in" modal appears, the session has expired — need re-authentication
- If textarea not found, page may not have loaded — retry navigate
- If submit returns "not found", take a screenshot and inspect manually
`;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let coinAddress = "";
  let comment = "";
  let url = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--coin" && args[i + 1]) coinAddress = args[++i];
    else if (args[i] === "--comment" && args[i + 1]) comment = args[++i];
    else if (args[i] === "--url" && args[i + 1]) url = args[++i];
  }

  if (url && !coinAddress) {
    // Extract address from URL like /coin/base:0x...
    const match = url.match(/coin\/(\w+):(0x[a-fA-F0-9]+)/);
    if (match) coinAddress = match[2];
  }

  if (!coinAddress || !comment) {
    console.error("Usage: zora-comment.ts --coin <address> --comment 'text'");
    console.error("   or: zora-comment.ts --url <zora-url> --comment 'text'");
    process.exit(1);
  }

  console.log(getCommentSteps({ coinAddress, comment }));
}
