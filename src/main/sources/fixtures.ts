/**
 * Bibliography files as the tools people actually use write them.
 *
 * The same decision `docx/fixtures.ts` documents, for the same reason: a
 * fixture round-tripped through our own writer only proves the reader agrees
 * with the writer. These are shaped after real Zotero, Mendeley, JabRef,
 * BibDesk and Google Scholar output — brace-protected titles, `and`-joined
 * author lists, month macros, `--` page ranges, the `{\"o}` and `\"{o}`
 * spellings of the same umlaut, corporate authors in braces.
 */

/** Zotero's BibTeX export: braced values, brace-protected title casing. */
export const ZOTERO_BIB = `@article{smith2019attention,
  title = {Attention and the {Reading} Brain},
  author = {Smith, Jane A. and Doe, John},
  journal = {Journal of Cognitive Science},
  volume = {14},
  number = {3},
  pages = {201--229},
  year = {2019},
  month = mar,
  doi = {10.1234/jcs.2019.14.3.201},
  url = {https://example.org/attention}
}
`

/** JabRef-ish: quoted values, "Given Family" order, a corporate author. */
export const JABREF_BIB = `@book{who2021health,
  author = "{World Health Organization}",
  title = "World Health Statistics 2021",
  publisher = "WHO Press",
  address = "Geneva",
  year = "2021",
  isbn = "978-92-4-002705-3"
}

@inproceedings{lee2020,
  author = "Kyung Hee Lee and Maria Fern{\\'a}ndez",
  title = "Learning to Rank",
  booktitle = "Proceedings of the Conference on Machine Learning",
  pages = "88--97",
  year = "2020"
}
`

/** BibDesk/TeX habits: `\\"{o}` accents, a `~` tie, an `\\&` escape. */
export const BIBDESK_BIB = `@phdthesis{muller2018,
  Author = {M\\"{u}ller, Anna},
  Title = {Structure and Form in Late Medieval Verse},
  School = {University of T\\"{u}bingen},
  Year = {2018}
}

@incollection{oconnor2015,
  author = {O'Connor, Se{\\'a}n},
  title = {Ships \\& Sailors},
  booktitle = {A History of the Sea},
  publisher = {Harbour~Press},
  year = {2015},
  pages = {33--51}
}
`

/** A file with a string macro, a comment, and one broken entry after a good one. */
export const MESSY_BIB = `@comment{This file was produced by hand.}

@string{jcs = "Journal of Cognitive Science"}

@article{good2020,
  title = {A Perfectly Good Entry},
  author = {Alpha, Ann},
  year = {2020}
}

@article{alsogood2021,
  title = {Braces {Inside {A} Title} Survive},
  author = {Beta, Ben},
  year = {2021}
}
`

/** Two entries sharing a citation key, which Zotero can produce across libraries. */
export const DUPLICATE_KEY_BIB = `@article{smith2019,
  title = {First},
  author = {Smith, Jane},
  year = {2019}
}

@article{smith2019,
  title = {Second},
  author = {Smith, Jane},
  year = {2019}
}
`

/** Web of Science / Scopus style RIS, with `ER  -` terminators and repeated AU. */
export const SCOPUS_RIS = `TY  - JOUR
AU  - Smith, Jane A.
AU  - Doe, John
TI  - Attention and the Reading Brain
JO  - Journal of Cognitive Science
VL  - 14
IS  - 3
SP  - 201
EP  - 229
PY  - 2019
DO  - 10.1234/jcs.2019.14.3.201
UR  - https://example.org/attention
ER  -

TY  - BOOK
AU  - World Health Organization
TI  - World Health Statistics 2021
PB  - WHO Press
CY  - Geneva
PY  - 2021
SN  - 978-92-4-002705-3
ER  -
`

/** EndNote habits: `T1`/`T2` rather than `TI`/`JO`, `Y1` dates, wrapped abstract. */
export const ENDNOTE_RIS = `TY  - CHAP
T1  - Ships and Sailors
T2  - A History of the Sea
A1  - O'Connor, Sean
PB  - Harbour Press
Y1  - 2015/06/01/
SP  - 33
EP  - 51
AB  - A chapter about ships
  and the people who sailed them.
ER  -
`
