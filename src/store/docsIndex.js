import { paths, canonicalPath } from './paths.js';
import { readJson, writeJsonAtomic, withLock } from './io.js';

export const getActiveReview = (docPath) => readJson(paths.docsIndex(), {})[canonicalPath(docPath)] ?? null;

export const setActiveReview = (docPath, reviewId) =>
  withLock(paths.docsIndex(), () => {
    const all = readJson(paths.docsIndex(), {});
    all[canonicalPath(docPath)] = reviewId;
    writeJsonAtomic(paths.docsIndex(), all);
  });

/** Drop the index entry; with `onlyIfId`, only when it still points at that review. */
export const clearActiveReview = (docPath, onlyIfId) =>
  withLock(paths.docsIndex(), () => {
    const all = readJson(paths.docsIndex(), {});
    const key = canonicalPath(docPath);
    if (onlyIfId && all[key] !== onlyIfId) return;
    delete all[key];
    writeJsonAtomic(paths.docsIndex(), all);
  });
