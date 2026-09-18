//! Accent folding helpers for accent-insensitive text search.
//!
//! [`fold_accents`] collapses every Unicode diacritic onto its base
//! letter (e.g. `José` → `Jose`, `Müller` → `Muller`, `ñ` → `n`).
//! The same folding runs on search input before binding and is
//! mirrored inside SQLite as the `unaccent(...)` scalar function
//! registered in [`super::connection`]. Together they let
//! `LIKE '%jose%'` match `José`, `Jose`, `JOSÉ`, etc.

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

/// Folds every combining mark in `s` away.
///
/// Implementation: Unicode canonical decomposition (`NFD`) splits a
/// composed character like `é` (U+00E9) into `e` (U+0065) plus a
/// combining acute accent (`U+0301`). We then drop every character
/// classified as a combining mark (`Mn` general category), keeping
/// the base letter. Precomposed pairs and pre-decomposed sequences
/// converge to the same folded result, so the search is stable
/// regardless of how the source text was encoded.
pub(crate) fn fold_accents(s: &str) -> String {
    s.nfd().filter(|c| !is_combining_mark(*c)).collect()
}

#[cfg(test)]
mod tests {
    use super::fold_accents;

    #[test]
    fn folds_spanish_accents() {
        assert_eq!(fold_accents("José García López"), "Jose Garcia Lopez");
    }

    #[test]
    fn folds_german_umlauts_and_eszett() {
        assert_eq!(fold_accents("Müller"), "Muller");
        // Pre-decomposed: e + combining diaeresis
        assert_eq!(fold_accents("naïve"), "naive");
    }

    #[test]
    fn folds_uppercase_accents() {
        assert_eq!(fold_accents("ÁÉÍÓÚÑáéíóúñ"), "AEIOUNaeioun");
    }

    #[test]
    fn leaves_ascii_punctuation_alone() {
        assert_eq!(fold_accents("Plain text 123!?"), "Plain text 123!?");
    }

    #[test]
    fn handles_empty_string() {
        assert_eq!(fold_accents(""), "");
    }
}
