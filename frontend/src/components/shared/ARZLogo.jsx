/**
 * ARZLogo — the ARZ Technologies brand mark.
 *
 * This used to be drawn with CSS (two overlapping text "A"s). It is now a real
 * image file at frontend/public/ARZ_logo.png, which is both simpler and more
 * faithful to the brand guidelines — the artwork has a three-plate offset "A"
 * (black key, cyan left, pink right) that CSS text could not reproduce.
 *
 * Anything in the `public/` folder is copied to the site root as-is at build
 * time, so "/ARZ_logo.png" is the correct path in every environment (dev
 * server, production build, and the packaged Windows desktop app alike).
 *
 * The PNG is 626×300 with a transparent background, so it sits cleanly on the
 * glass sidebar, the login card and white receipt paper without a visible box.
 * Because the lettering is DARK, it needs a light background — there is no
 * light-on-dark version of the artwork.
 *
 * ── Props ────────────────────────────────────────────────────────────────
 *   size  'sm' | 'md' | 'lg'   (default 'md')
 *           sm → 52px tall, sidebar footer
 *           md → 52px tall, login card
 *           lg → 28px tall, printed thermal receipt
 *
 * Only the HEIGHT is set; width is left as 'auto' so the image keeps its own
 * proportions and can never look stretched.
 */
export default function ARZLogo({ size = 'md' }) {
  /*
   * Rendered height in pixels for each size.
   *
   * Note 'lg' (28px) is deliberately SMALLER than 'md' (52px). The names refer
   * to where the logo is used, not to a strict size ladder: 'lg' is the
   * receipt, and 80mm thermal paper is only about 72mm of printable width, so
   * anything taller crowds the footer.
   *
   * 'md' was raised 44 → 52px so the brand mark reads clearly on the login
   * card, which is the first screen anyone sees.
   *
   * 'sm' was raised 28 → 32 → 40 → 52px for the same reason: the artwork is
   * 626×300, so at 28px tall the three-plate "A" and the wordmark beside it
   * rendered under 60px wide and read as a smudge rather than a logo.  At 52px
   * it is ~108px wide — half the 220px sidebar, and the practical ceiling: the
   * sidebar footer does not shrink (flexShrink: 0), so every pixel added here
   * comes straight out of the nav's breathing room above it.  See the note on
   * the <nav> in Layout.jsx.
   */
  const heights = { sm: 52, md: 52, lg: 28 };

  // Fall back to 'md' if an unknown size string is ever passed in, so a typo
  // renders a sensible logo rather than an image with no height.
  const height = heights[size] || heights.md;

  return (
    <img
      src="/ARZ_logo.png"
      alt="ARZ Technologies"
      style={{
        height,
        width: 'auto',
        objectFit: 'contain',
        display: 'block',
      }}
    />
  );
}
