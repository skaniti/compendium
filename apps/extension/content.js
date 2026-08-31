/**
 * Content Script — Page Text Extraction
 *
 * Extracts clean article text from the current page using Mozilla's Readability.js.
 * Falls back to document.body.innerText if Readability fails or the page isn't article-like.
 *
 * Runs at document_idle (after DOM is ready). Does NOT extract automatically —
 * waits for a message from the background script requesting extraction.
 * This keeps the content script inert unless a capture is active.
 */

/**
 * Extract clean article text from the current page.
 * @returns {{ text: string, title: string, source: 'readability'|'innerText'|'failed', charCount: number }}
 */
function extractPageContent() {
  // Skip non-HTML pages (PDFs, images, etc.)
  if (!document.body || !document.querySelector('html')) {
    return { text: '', title: document.title || '', source: 'failed', charCount: 0 };
  }

  let text = '';
  let source = 'failed';

  // Attempt 1: Readability.js (produces clean article text)
  try {
    if (typeof Readability !== 'undefined') {
      // Clone the document so Readability's mutations don't affect the live page
      const docClone = document.cloneNode(true);
      const reader = new Readability(docClone, {
        charThreshold: 50, // Minimum chars to consider content valid
      });
      const article = reader.parse();

      if (article && article.textContent && article.textContent.trim().length > 50) {
        text = article.textContent.trim();
        source = 'readability';
      }
    }
  } catch (e) {
    console.warn('[Compendium Content] Readability failed:', e.message);
  }

  // Attempt 2: Fallback to innerText (includes nav/footer but better than nothing)
  if (!text) {
    try {
      // Try to get just the main content area first
      const main = document.querySelector('main, article, [role="main"], #content, .content');
      if (main && main.innerText.trim().length > 50) {
        text = main.innerText.trim();
        source = 'innerText';
      } else if (document.body.innerText.trim().length > 50) {
        text = document.body.innerText.trim();
        source = 'innerText';
      }
    } catch (e) {
      console.warn('[Compendium Content] innerText fallback failed:', e.message);
    }
  }

  return {
    text,
    title: document.title || '',
    source,
    charCount: text.length,
  };
}

/**
 * Listen for extraction requests from the background script.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'extractContent') {
    const result = extractPageContent();
    sendResponse(result);
  }
});
