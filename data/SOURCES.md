# Regression Corpus Sources

These prose inputs are checked in so the demo can run without fetching source
material at runtime. Generated `*-auto.json` and `*-concepts.json` files are
derived from the adjacent `.txt` files.

## `ada-lovelace-wikipedia.txt`

- Source: "Ada Lovelace", Wikipedia, <https://en.wikipedia.org/wiki/Ada_Lovelace>
- Extract: lead through the "Work" section, omitting later commemoration,
  popular-culture, references, and external-link sections to keep the corpus
  under 5,000 words.
- License: Wikipedia text is available under Creative Commons
  Attribution-ShareAlike; see Wikimedia API content-reuse guidance:
  <https://www.mediawiki.org/wiki/Wikimedia_APIs/Content_reuse>
- Retrieved: 2026-05-19

## `fair-guiding-principles-excerpt.txt`

- Source: Wilkinson, M. D. et al. "The FAIR Guiding Principles for scientific
  data management and stewardship", Scientific Data 3, 160018 (2016),
  <https://www.nature.com/articles/sdata201618>
- Extract: article body through the final discussion, omitting Box 3's list of
  community initiatives to keep the corpus under 5,000 words.
- License: Creative Commons Attribution 4.0 International.
- Retrieved: 2026-05-19
