/**
 * Force Export status composition — DOM-free.
 *
 * Lifted out of popup.js's showExportResult() so the text/class logic can
 * be unit-tested without a document. popup.js imports composeExportResult()
 * and only does the DOM work (textContent, className, show/hide timer).
 */

// Composes the Force Export status line from background.js's
// forceFinalize response (spec D5/D6: `{ success, delivery, flush }`).
const FLUSH_STOP_HINTS = {
  offline: ' (backend unreachable)',
  rate_limited: ' (rate limited, retrying in a minute)',
  batch_cap: ' (more will flush shortly)',
  auth: ' (rejected: check API key)'
};

/**
 * @param {{ success: boolean, delivery: string, flush: object|null|undefined }} result
 * @returns {{ text: string, cls: string }}
 */
export function composeExportResult({ success, delivery, flush }) {
  const exported = (delivery === 'delivered' ? 1 : 0) + (flush?.delivered ?? 0);
  const buffered = flush?.remaining ?? 0;

  let text;
  let cls;
  if (!success) {
    text = 'Export failed';
    if (flush?.lastError) text += `: ${flush.lastError}`;
    cls = 'export-failed';
  } else if (exported === 0 && buffered === 0) {
    text = 'Nothing to export';
    cls = 'export-ok';
  } else {
    text = `Exported ${exported}, ${buffered} buffered`;
    const hint = FLUSH_STOP_HINTS[flush?.stop];
    if (hint) {
      text += hint;
    } else if (buffered > 0 && flush?.stop == null && flush?.lastError) {
      text += `: ${flush.lastError}`;
    }
    cls = buffered > 0 ? 'export-warn' : 'export-ok';
  }

  return { text, cls };
}
