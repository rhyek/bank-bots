/**
 * The register is a CSS grid, not a <table>. Virtualized rows are absolutely positioned, which
 * native table layout cannot express — and every column here is fixed or bounded, so the grid
 * gives identical alignment without a row model.
 */
export const REGISTER_GRID = {
  withAccount:
    'grid-cols-[minmax(110px,140px)_110px_minmax(140px,1fr)_minmax(160px,1fr)_minmax(180px,2fr)_120px_120px]',
  withoutAccount:
    'grid-cols-[110px_minmax(140px,1fr)_minmax(160px,1fr)_minmax(180px,2fr)_120px_120px]',
} as const;

/** Fixed row height, in px. The virtualizer needs this to estimate offsets. */
export const ROW_HEIGHT = 44;

/**
 * Sum of every column's minimum, applied to the wrapper inside the scroll container. Without it a
 * narrow viewport lets the header's background stop at the container edge while the columns keep
 * going, so the sticky header visibly detaches from the rows once you scroll right.
 */
export const REGISTER_MIN_WIDTH = {
  withAccount: 'min-w-[940px]',
  withoutAccount: 'min-w-[830px]',
} as const;

/**
 * Height of the sticky column header, in px. The header lives *inside* the scroll container (so it
 * scrolls horizontally in lockstep with the rows), which pushes the virtualized list down by
 * exactly this much — fed to the virtualizer as `scrollMargin` so item offsets stay exact.
 */
export const HEADER_HEIGHT = 40;
