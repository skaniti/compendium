-- Migration 013: Add is_learning classification column to page_content
--
-- Supports Plan 07 — Learning Classification Gate.
-- NULL = not yet classified, TRUE = learning page, FALSE = not learning.
-- Partial index accelerates the clustering query (only needs learning pages).

ALTER TABLE page_content ADD COLUMN is_learning BOOLEAN;

CREATE INDEX idx_page_content_is_learning
    ON page_content(is_learning)
    WHERE is_learning = TRUE;
